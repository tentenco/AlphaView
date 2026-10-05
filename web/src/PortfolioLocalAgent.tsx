import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { AgentHistory, AgentRunSummary } from './portfolio-agent-model'
import {
  newPaperKey,
  type PaperAccount,
  type PaperPreview,
  type PaperProposal,
} from './paper-model'
import {
  defaultLocalAgentDraft,
  localAgentActive,
  localAgentDraftKey,
  readLocalAgentAttempt,
  storeLocalAgentAttempt,
  validLocalAgentDraft,
  type LocalAgentCatalog,
  type LocalAgentDraft,
  type LocalAgentFact,
  type LocalAgentHistory,
  type LocalAgentIntegrity,
  type LocalAgentIssue,
  type LocalAgentPaperPreview,
  type LocalAgentPaperProposal,
  type LocalAgentRun,
  type LocalAgentRunSummary,
  type LocalAgentStatus,
} from './local-agent-model'
import { useSessionState } from './session-state'
import { api, dateTime, money, num } from './ui'
import { LocalAgentReview } from './LocalAgentReview'
import './local-agent.css'

type Translate = (zh: string, en: string) => string
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value)}%`)
type Props = {
  account: PaperAccount
  locale: Locale
  onProposal: (proposal: PaperProposal) => void
}
const statusLabel = (status: LocalAgentStatus, t: Translate) =>
  ({
    queued: t('已排入', 'Queued'),
    running: t('分析中', 'Running'),
    completed: t('分析完成', 'Completed'),
    blocked: t('輸出受阻', 'Blocked'),
    failed: t('執行失敗', 'Failed'),
    cancelled: t('已取消', 'Cancelled'),
    stale: t('來源已過期', 'Stale'),
    interrupted: t('程序中斷', 'Interrupted'),
  })[status]
function issueLabel(issue: LocalAgentIssue, t: Translate) {
  const english: Record<string, string> = {
    invalid_model_schema: 'The model response did not match the required structured output.',
    role_set_invalid: 'The output must contain each of the three role perspectives exactly once.',
    symbol_set_invalid:
      'Decisions must cover exactly the original selected symbols, without additions or duplicates.',
    invalid_citation: 'An evidence citation is unknown or duplicated.',
    unsupported_finding: 'A role finding is not supported by its cited evidence.',
    unsupported_decision:
      'An allocation decision lacks supporting evidence for that symbol and its limits.',
    analysis_cannot_reallocate: 'Review mode cannot change the original allocation.',
    model_abstained: 'The model abstained from proposing an allocation.',
    all_targets_zero: 'An all-zero model allocation cannot create a liquidation proposal.',
    process_interrupted:
      'The local process was interrupted. This analysis was not restarted automatically.',
    launch_failed: 'The local analysis could not be started.',
    model_changed: 'The installed model changed during this analysis.',
    nonlocal_response: 'The response model or source did not match the verified local model.',
    incomplete_response:
      'The model output was incomplete, exceeded a limit or attempted an unsupported tool call.',
    local_runtime_error:
      'The local runtime was unavailable or timed out. Check the local model service before retrying.',
    analysis_failed: 'The analysis failed; no validated allocation is available.',
  }
  return t(issue.message, english[issue.code] || issue.code)
}
function errorLabel(value: string, t: Translate) {
  return t(
    value,
    /[\u3400-\u9fff]/.test(value)
      ? 'The request could not complete. Refresh the local models, analysis and paper account, then retry.'
      : value,
  )
}

export function PortfolioLocalAgent(props: Props) {
  return <LocalAgentAccount key={props.account.id} {...props} />
}

function LocalAgentAccount({ account, locale, onProposal }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(
    localAgentDraftKey(account.id),
    defaultLocalAgentDraft,
    validLocalAgentDraft,
  )
  const [catalog, setCatalog] = useState<LocalAgentCatalog | null>(null)
  const [sources, setSources] = useState<AgentRunSummary[]>([])
  const [history, setHistory] = useState<LocalAgentRunSummary[]>([])
  const [run, setRun] = useState<LocalAgentRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [busy, setBusy] = useState<
    'start' | 'detail' | 'cancel' | 'preview' | 'save' | 'verify' | null
  >(null)
  const [bridge, setBridge] = useState<{ key: string; preview: PaperPreview } | null>(null)
  const [saved, setSaved] = useState<{ key: string; proposal: PaperProposal } | null>(null)
  const [integrity, setIntegrity] = useState<{ key: string; receipt: LocalAgentIntegrity } | null>(
    null,
  )
  const operation = useRef<AbortController | null>(null)
  const launchAttempt = useRef(readLocalAgentAttempt(account.id))
  const bridgeAttempt = useRef({ key: '', idempotencyKey: '' })
  const bridgeKey = JSON.stringify([run?.id, run?.input_revision, account.id, account.version])
  const integrityKey = JSON.stringify([
    run?.id,
    run?.input_revision,
    run?.result?.output_digest,
    run?.status,
    run?.current,
    account.id,
    account.version,
  ])
  const receipt = integrity?.key === integrityKey ? integrity.receipt : null
  const canBridge =
    !!run &&
    run.status === 'completed' &&
    run.current &&
    run.proposal_ready &&
    !!run.result?.validation.valid &&
    !run.cancel_requested &&
    (!receipt || receipt.proposal_eligible) &&
    !pollError
  const preview = canBridge && bridge?.key === bridgeKey ? bridge.preview : null
  const savedProposal = saved?.key === bridgeKey ? saved.proposal : null
  const active = !!run && localAgentActive(run.status)

  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    Promise.allSettled([
      api<LocalAgentCatalog>('/api/local-agent/models', { signal: controller.signal }),
      api<AgentHistory>('/api/portfolio-agent/runs?limit=100', { signal: controller.signal }),
      api<LocalAgentHistory>('/api/local-agent/runs?limit=20', { signal: controller.signal }),
    ]).then(([models, rules, runs]) => {
      if (controller.signal.aborted) return
      const errors: string[] = []
      if (models.status === 'fulfilled') setCatalog(models.value)
      else {
        setCatalog(null)
        errors.push(String(models.reason instanceof Error ? models.reason.message : models.reason))
      }
      if (rules.status === 'fulfilled') setSources(rules.value.runs)
      else {
        setSources([])
        errors.push(String(rules.reason instanceof Error ? rules.reason.message : rules.reason))
      }
      if (runs.status === 'fulfilled') {
        setHistory(runs.value.runs)
        setRun((current) => {
          if (!current) return current
          const summary = runs.value.runs.find((row) => row.id === current?.id)
          if (
            !summary &&
            (current.as_of !== runs.value.as_of ||
              current.input_revision !== runs.value.input_revision ||
              current.engine_version !== runs.value.engine_version)
          ) {
            return {
              ...current,
              current: false,
              proposal_ready: false,
              status:
                current.status === 'completed' || current.status === 'blocked'
                  ? 'stale'
                  : current.status,
              stale_reasons: ['source_run_stale_or_unavailable'],
            }
          }
          return summary
            ? {
                ...current,
                ...summary,
                cancel_requested: current.cancel_requested || summary.cancel_requested,
              }
            : current
        })
      } else errors.push(String(runs.reason instanceof Error ? runs.reason.message : runs.reason))
      setLoadErrors(errors)
      setLoading(false)
    })
    return () => controller.abort()
  }, [refresh, account.version])

  useEffect(() => {
    if (!run || !active) return
    const id = run.id
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 2000)
        return
      }
      try {
        const data = await api<LocalAgentRun>(`/api/local-agent/runs/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        setRun((current) =>
          current?.id === id
            ? { ...data, cancel_requested: current.cancel_requested || data.cancel_requested }
            : current,
        )
        setHistory((rows) => [data, ...rows.filter((row) => row.id !== data.id)].slice(0, 20))
        setPollError('')
        if (!localAgentActive(data.status)) return
      } catch (err) {
        if (controller.signal.aborted) return
        setPollError(err instanceof Error ? err.message : String(err))
      }
      timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [run?.id, active])

  async function perform(
    action: NonNullable<typeof busy>,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  function showRun(data: LocalAgentRun) {
    setRun(data)
    setIntegrity(null)
    setPollError('')
    setBridge(null)
    setSaved(null)
    setHistory((rows) => [data, ...rows.filter((row) => row.id !== data.id)].slice(0, 20))
  }
  function start(event: FormEvent) {
    event.preventDefault()
    const source = sources.find((row) => row.id === draft.sourceRunId)
    if (
      !catalog?.available ||
      !catalog.models.some((model) => model.name === draft.model) ||
      !source?.current ||
      source.status !== 'proposed' ||
      source.target_weights.length > catalog.max_selected
    )
      return
    const body = { source_run_id: draft.sourceRunId, model: draft.model, mode: draft.mode }
    const input = JSON.stringify(body)
    if (launchAttempt.current?.input !== input)
      launchAttempt.current = { input, idempotencyKey: newPaperKey() }
    storeLocalAgentAttempt(account.id, launchAttempt.current)
    const key = launchAttempt.current.idempotencyKey
    void perform('start', async (signal) => {
      const data = await api<LocalAgentRun>('/api/local-agent/runs', {
        method: 'POST',
        signal,
        body: JSON.stringify({ ...body, idempotency_key: key }),
      })
      if (signal.aborted) return
      launchAttempt.current = null
      storeLocalAgentAttempt(account.id, null)
      showRun(data)
    })
  }
  function openRun(id: string) {
    void perform('detail', async (signal) => {
      const data = await api<LocalAgentRun>(`/api/local-agent/runs/${encodeURIComponent(id)}`, {
        signal,
      })
      if (!signal.aborted) showRun(data)
    })
  }
  function cancel() {
    if (!run || !active || run.cancel_requested) return
    const id = run.id
    void perform('cancel', async (signal) => {
      const data = await api<LocalAgentRun>(
        `/api/local-agent/runs/${encodeURIComponent(id)}/cancel`,
        { method: 'POST', signal },
      )
      if (!signal.aborted) setRun((current) => (current?.id === id ? data : current))
    })
  }
  function verifyEvidence() {
    if (!run || active) return
    const selected = run
    void perform('verify', async (signal) => {
      const data = await api<LocalAgentIntegrity>(
        `/api/local-agent/runs/${encodeURIComponent(selected.id)}/integrity`,
        { signal },
      )
      if (signal.aborted) return
      if (
        data.analysis_id !== selected.id ||
        data.source_run_id !== selected.source_run_id ||
        data.as_of !== selected.as_of ||
        data.input_revision !== selected.input_revision ||
        data.engine_version !== 'alphaview-local-agent-integrity-v1'
      ) {
        throw new Error(
          t(
            '證據驗證回覆與目前分析不符，請重新載入分析。',
            'The verification response does not match this analysis. Reload the analysis.',
          ),
        )
      }
      setIntegrity({ key: integrityKey, receipt: data })
    })
  }
  function paperBridge(save: boolean) {
    if (!run || !canBridge || (save && (!preview?.executable || savedProposal))) return
    if (bridgeAttempt.current.key !== bridgeKey)
      bridgeAttempt.current = { key: bridgeKey, idempotencyKey: newPaperKey() }
    void perform(save ? 'save' : 'preview', async (signal) => {
      const data = await api<LocalAgentPaperPreview | LocalAgentPaperProposal>(
        `/api/local-agent/runs/${encodeURIComponent(run.id)}/${save ? 'paper-proposal' : 'paper-preview'}`,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            account_id: account.id,
            expected_account_version: account.version,
            ...(save ? { idempotency_key: bridgeAttempt.current.idempotencyKey } : {}),
          }),
        },
      )
      if (signal.aborted) return
      if ('paper_proposal' in data) {
        setSaved({ key: bridgeKey, proposal: data.paper_proposal })
        onProposal(data.paper_proposal)
      } else setBridge({ key: bridgeKey, preview: data.paper_preview })
    })
  }

  return (
    <div className="local-agent">
      <LocalAgentSetup
        draft={draft}
        onChange={setDraft}
        sources={sources.filter(
          (source) => source.target_weights.length <= (catalog?.max_selected ?? 10),
        )}
        models={catalog?.models.map((model) => model.name) || []}
        available={!!catalog?.available}
        loading={loading}
        starting={!!busy}
        onRefresh={() => setRefresh((value) => value + 1)}
        onStart={start}
        t={t}
      />
      <p className="local-agent-meta">
        {t('每次分析支援最多', 'Each analysis supports up to')} {catalog?.max_selected ?? 10}{' '}
        {t(
          '個原規則入選標的。只列出最近 100 次工作流中的可用來源。',
          'original selected symbols. Sources are limited to eligible runs among the latest 100 rule workflows.',
        )}
      </p>
      {catalog?.reason && <p className="notice">{errorLabel(catalog.reason, t)}</p>}
      {loadErrors.map((message, index) => (
        <p className="error-message" role="alert" key={index}>
          {errorLabel(message, t)}
        </p>
      ))}
      {error && (
        <p className="error-message" role="alert">
          {errorLabel(error, t)}
        </p>
      )}
      <section className="agent-panel" aria-label={t('本機分析歷史', 'Local analysis history')}>
        <div className="local-agent-section-header">
          <h2>{t('已保存分析', 'Saved analyses')}</h2>
          <button
            className="button"
            type="button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('重新整理歷史', 'Refresh history')}
          </button>
        </div>
        {!history.length ? (
          <p>
            {loading
              ? t('讀取中…', 'Loading…')
              : t('尚無本機模型分析。', 'No local model analysis yet.')}
          </p>
        ) : (
          <div className="table-scroll local-agent-history">
            <table>
              <thead>
                <tr>
                  {[
                    t('分析', 'Analysis'),
                    t('狀態', 'Status'),
                    t('模型', 'Model'),
                    t('模式', 'Mode'),
                    t('來源日期', 'Source session'),
                  ].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button
                        type="button"
                        className="button"
                        disabled={!!busy}
                        onClick={() => openRun(row.id)}
                        aria-pressed={run?.id === row.id}
                      >
                        {dateTime(row.created_at)} · {row.id.slice(0, 12)}
                      </button>
                    </td>
                    <td>
                      {statusLabel(row.status, t)}
                      {row.cancel_requested && localAgentActive(row.status)
                        ? ` · ${t('取消待完成', 'Cancellation pending')}`
                        : ''}
                    </td>
                    <td>{row.model.name}</td>
                    <td>
                      {row.request.mode === 'analysis'
                        ? t('分析原配置', 'Review original')
                        : t('保守調整', 'Conservative')}
                    </td>
                    <td>{row.as_of}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {run && (
        <>
          <LocalAnalysisDetails key={run.id} run={run} t={t} />
          <SavedEvidenceVerification
            receipt={receipt}
            busy={busy === 'verify'}
            disabled={!!busy || active}
            onVerify={verifyEvidence}
            t={t}
          />
          <LocalAgentReview account={account} run={run} enabled={!busy && !active} t={t} />
          <section className="agent-panel" aria-label={t('本機分析操作', 'Local analysis actions')}>
            {pollError && (
              <p className="notice" role="status">
                {t(
                  '進度暫時無法更新，會繼續重試；尚未確認分析已結束。',
                  'Progress could not be refreshed. Retrying; completion has not been confirmed.',
                )}{' '}
                {errorLabel(pollError, t)}
              </p>
            )}
            {active && (
              <>
                <p>
                  {run.cancel_requested
                    ? t(
                        '取消已送出。本機推論回應或逾時後才會丟棄結果；目前尚未完成取消。',
                        'Cancellation was requested. The result will be discarded when local inference returns or times out; cancellation is not yet complete.',
                      )
                    : t(
                        '分析紀錄保存在本機；此頁會定期讀取進度。',
                        'The analysis is saved locally; this page periodically reads its progress.',
                      )}
                </p>
                <button
                  className="button"
                  type="button"
                  disabled={!!busy || run.cancel_requested}
                  onClick={cancel}
                >
                  {t('取消這次分析', 'Cancel this analysis')}
                </button>
              </>
            )}
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => openRun(run.id)}
              >
                {t('更新分析狀態', 'Refresh analysis status')}
              </button>
              <button
                type="button"
                className="button"
                disabled={!!busy || !canBridge}
                onClick={() => paperBridge(false)}
              >
                {busy === 'preview'
                  ? t('預覽中…', 'Previewing…')
                  : t('預覽紙上配置', 'Preview paper allocation')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!!busy || !preview?.executable || !!savedProposal}
                onClick={() => paperBridge(true)}
              >
                {busy === 'save'
                  ? t('保存中…', 'Saving…')
                  : t('保存紙上提案', 'Save paper proposal')}
              </button>
            </div>
            {!canBridge && (
              <p>
                {t(
                  '只有當期有效、輸出驗證通過且有非零配置的已完成分析，才能進入紙上預覽。',
                  'Only a completed, current analysis with validated nonzero targets can enter paper preview.',
                )}
              </p>
            )}
            {bridge && !preview && (
              <p className="notice">
                {t(
                  '帳戶或分析狀態已變更，請重新預覽。',
                  'The account or analysis state changed. Preview again.',
                )}
              </p>
            )}
            {preview && <LocalPaperPreview preview={preview} t={t} />}
            {savedProposal && (
              <p className="notice" role="status">
                {t('紙上提案已保存，尚未執行。', 'Paper proposal saved; not executed.')}{' '}
                {savedProposal.id}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function paperReason(code: string, message: string, t: Translate) {
  const english: Record<string, string> = {
    kill_switch: 'Paper simulation is paused for this account.',
    quote_unavailable: 'A current valid USD reference price is unavailable.',
    max_position_weight: 'A target exceeds the account position limit.',
    post_policy_max_position_weight:
      'A resulting position exceeds the limit after costs and rounding.',
    min_cash_weight: 'Projected cash falls below the account minimum.',
    max_turnover: 'The proposed trades exceed the account turnover limit.',
    insufficient_cash: 'The proposed trades and costs exceed available cash.',
    nonpositive_equity: 'Positive paper equity is required.',
    holding_limit: 'The proposed portfolio exceeds the supported position count.',
  }
  return t(message, english[code] || code)
}

function factValue(fact: LocalAgentFact, t: Translate) {
  if (typeof fact.value === 'number') {
    if (fact.kind === 'quote') return money(fact.value)
    if (fact.kind === 'coverage' || fact.kind === 'slot') return percent(fact.value)
    return num(fact.value)
  }
  if (typeof fact.value === 'object') {
    if (fact.kind === 'consensus')
      return `${t('符合 / 啟用', 'Matched / enabled')}: ${fact.value.matched}/${fact.value.enabled}`
    if (fact.kind === 'position_limit')
      return `${t('最大權重 / 上限', 'Largest / limit')}: ${percent(fact.value.largest)} / ${percent(fact.value.limit)}`
    if (fact.kind === 'cash_buffer')
      return `${t('保留 / 最低', 'Reserved / minimum')}: ${percent(fact.value.reserved)} / ${percent(fact.value.minimum)}`
    return JSON.stringify(fact.value)
  }
  return fact.id === 'limitation:forecast'
    ? t('規則訊號沒有提供未來報酬預測。', 'The rule signals contain no future return forecast.')
    : fact.value
}

function Evidence({ facts, t }: { facts: LocalAgentFact[]; t: Translate }) {
  return (
    <details className="agent-method">
      <summary>
        {t('核對引用證據', 'Inspect cited evidence')} ({facts.length})
      </summary>
      <ul>
        {facts.map((fact) => (
          <li key={fact.id}>
            <code>{fact.id}</code>
            <br />
            <strong>{factValue(fact, t)}</strong>
            <small>
              {fact.as_of} · {t('選股快照', 'Scan')} #{fact.scan_id}
            </small>
          </li>
        ))}
      </ul>
    </details>
  )
}

function RawModelOutput({ content, digest, t }: { content: string; digest: string; t: Translate }) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const visible = revealed === content
  return (
    <div className="agent-method">
      <button
        type="button"
        className="text-button"
        aria-expanded={visible}
        onClick={() => setRevealed(visible ? null : content)}
      >
        {visible
          ? t('隱藏模型原始文字', 'Hide raw model text')
          : t('顯示模型原始文字', 'Reveal raw model text')}
      </button>
      <p>
        {t(
          '原始輸出預設隱藏，可能含未通過驗證的內容；顯示後僅以文字呈現。',
          'Raw output is hidden by default and may contain unverified content. Revealed output is displayed as text only.',
        )}
      </p>
      {visible && (
        <>
          <pre className="local-agent-json">{content}</pre>
          <small>{digest}</small>
        </>
      )}
    </div>
  )
}

function SavedEvidenceVerification({
  receipt,
  busy,
  disabled,
  onVerify,
  t,
}: {
  receipt: LocalAgentIntegrity | null
  busy: boolean
  disabled: boolean
  onVerify: () => void
  t: Translate
}) {
  const checkLabels: Record<string, string> = {
    analysis_method: t('分析方法', 'Analysis method'),
    rules_record: t('保存的規則紀錄', 'Saved rule record'),
    rules_fingerprint: t('規則完整指紋', 'Rule fingerprint'),
    source_binding: t('來源綁定', 'Source binding'),
    saved_facts: t('保存的輸入事實', 'Saved input facts'),
    saved_request: t('保存的分析請求', 'Saved analysis request'),
    prompt_digest: t('Prompt 指紋', 'Prompt digest'),
    schema_digest: t('輸出結構指紋', 'Output schema digest'),
    structured_output: t('結構、引用與配置限制', 'Output, citations and allocation limits'),
    output_digest: t('原始輸出指紋', 'Raw output digest'),
    result_replay: t('結果重新驗算', 'Reconstructed result'),
    analysis_completion: t('完成與取消狀態', 'Completion and cancellation status'),
  }
  const reasons: Record<string, string> = {
    prerequisite_unavailable: 'A prerequisite did not pass; this check was not performed.',
    analysis_method_unavailable:
      'No compatible verifier is available for this saved analysis method.',
    rules_record_mismatch: 'The saved rule, scan method or source columns do not agree.',
    rules_fingerprint_mismatch: 'The complete saved rule record does not match its fingerprint.',
    source_binding_mismatch:
      'The saved source summary, session or input revision does not match the rule record.',
    saved_facts_mismatch: 'Saved facts do not match facts reconstructed from the rule record.',
    saved_request_mismatch: 'The saved request, model name or request hash does not match.',
    prompt_digest_mismatch: 'The saved prompt content or model name does not match its digest.',
    schema_digest_mismatch: 'The saved output schema does not match its digest.',
    saved_output_unavailable:
      'The original structured output is missing and cannot be revalidated.',
    saved_output_invalid: 'The saved raw output is empty or exceeds its size limit.',
    output_validation_failed: 'The raw output failed schema, citation or allocation validation.',
    output_digest_mismatch: 'The raw output does not match its saved output digest.',
    result_replay_mismatch:
      'Saved perspectives, decisions or targets differ from the reconstructed result.',
    analysis_not_completed: 'The analysis did not complete or cancellation was requested.',
    saved_source_unavailable: 'The saved source or required evidence cannot be reconstructed.',
    saved_evidence_unreadable: 'Saved evidence is missing, malformed or not finite JSON.',
  }
  return (
    <section className="agent-panel" aria-label={t('保存證據驗證', 'Saved evidence verification')}>
      <div className="local-agent-section-header">
        <h2>{t('保存證據驗證', 'Saved evidence verification')}</h2>
        <button type="button" className="button" disabled={disabled} onClick={onVerify}>
          {busy ? t('驗證中…', 'Verifying…') : t('驗證保存證據', 'Verify saved evidence')}
        </button>
      </div>
      <p>
        {t(
          '只重驗已保存的規則、事實、引用與目標，不呼叫模型。歷史證據一致不代表來源仍有效，也不能證明模型品質或未來報酬。',
          'Rechecks saved rules, facts, citations and targets without calling a model. Consistent historical evidence does not establish current source eligibility, model quality or future returns.',
        )}
      </p>
      {receipt && (
        <>
          <p role="status">
            <strong>
              {receipt.verified
                ? t('歷史證據驗證通過', 'Historical evidence verified')
                : receipt.status === 'failed'
                  ? t('保存證據驗證失敗', 'Saved evidence verification failed')
                  : t('保存證據無法驗證', 'Saved evidence unavailable')}
            </strong>
          </p>
          <p>
            {receipt.source_currentness.current
              ? t(
                  '來源仍符合當期條件；提案仍需通過帳戶與風險檢查。',
                  'The source meets current conditions; a proposal still requires account and risk checks.',
                )
              : t(
                  '來源已過期或不可用，不能建立新提案。',
                  'The source is stale or unavailable and cannot support a new proposal.',
                )}
          </p>
          <p>
            {t('具有有效引用的判斷', 'Claims with valid references')}:{' '}
            <strong>
              {receipt.citation_coverage
                ? `${receipt.citation_coverage.claims_with_valid_references} / ${receipt.citation_coverage.claims}`
                : '—'}
            </strong>{' '}
            · {t('引用覆蓋率', 'Citation coverage')}:{' '}
            <strong>{percent(receipt.citation_coverage?.coverage_pct)}</strong>
          </p>
          <p>
            {t('已知引用', 'Known citations')}:{' '}
            {receipt.citation_coverage
              ? `${receipt.citation_coverage.known_citations} / ${receipt.citation_coverage.citations}`
              : '—'}{' '}
            · {t('重複引用', 'Duplicate citations')}:{' '}
            {receipt.citation_coverage?.duplicate_citations ?? '—'}
          </p>
          {!!receipt.citation_coverage?.unknown_ids.length && (
            <p>
              {t('找不到的引用', 'Unknown citations')}:{' '}
              {receipt.citation_coverage.unknown_ids.join(' · ')}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('檢查', 'Check')}</th>
                  <th scope="col">{t('結果', 'Result')}</th>
                  <th scope="col">{t('原因', 'Reason')}</th>
                </tr>
              </thead>
              <tbody>
                {receipt.checks.map((check) => (
                  <tr key={check.code}>
                    <th scope="row">{checkLabels[check.code] || check.code}</th>
                    <td>
                      {check.status === 'passed'
                        ? t('通過', 'Passed')
                        : check.status === 'failed'
                          ? t('未通過', 'Failed')
                          : t('不可用', 'Unavailable')}
                    </td>
                    <td>
                      {check.reason ? (
                        <>
                          {t(check.reason.message, reasons[check.reason.code] || check.reason.code)}{' '}
                          <code>{check.reason.code}</code>
                        </>
                      ) : (
                        '—'
                      )}
                      {check.mismatched_fields?.length
                        ? ` (${check.mismatched_fields.join(', ')})`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!receipt.validation_issues.length && (
            <p>
              {t('輸出驗證問題', 'Output validation issues')}:{' '}
              {receipt.validation_issues.map((code) => (
                <code key={code}>{code} </code>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function LocalAnalysisDetails({ run, t }: { run: LocalAgentRun; t: Translate }) {
  const phases = ['source_check', 'local_inference', 'output_validation'] as const
  const phaseLabels = {
    source_check: t('來源檢查', 'Source check'),
    local_inference: t('一次本機推論', 'One local inference'),
    output_validation: t('輸出規則驗證', 'Output validation'),
  }
  const roleLabels = {
    research_analyst: t('研究分析觀點', 'Research perspective'),
    allocation_reviewer: t('配置審閱觀點', 'Allocation perspective'),
    risk_reviewer: t('風險審閱觀點', 'Risk perspective'),
  }
  const findingEnglish: Record<string, string> = {
    complete_evidence: 'The cited candidate has complete evidence for its enabled strategies.',
    mixed_signals: 'Not all enabled strategies match; retain the limits of mixed signals.',
    within_position_limit: 'The original rule target is within its position limit.',
    cash_buffer_available: 'The original allocation retains the required cash buffer.',
    forecast_not_available: 'Consensus scores provide no evidence of future returns.',
  }
  const decisionEnglish: Record<string, string> = {
    rule_consensus: 'Retain the review based on validated rule consensus.',
    mixed_signals: 'The model chose a more conservative response to mixed strategy signals.',
    cash_caution: 'The model chose to retain more cash without increasing other targets.',
    no_forecast: 'The model chose a conservative allocation given the absence of return forecasts.',
  }
  const staleLabels: Record<string, string> = {
    local_engine_changed: t('本機分析方法已更新', 'The local analysis method changed'),
    source_fingerprint_changed: t(
      '來源工作流指紋已改變',
      'The source workflow fingerprint changed',
    ),
    source_run_stale_or_unavailable: t(
      '來源工作流已過期或不可用',
      'The source workflow is stale or unavailable',
    ),
  }
  const assessment = {
    supported: t('有支持證據', 'Supported'),
    caution: t('保留疑慮', 'Caution'),
    insufficient: t('證據不足', 'Insufficient'),
  }
  function phaseStatus(phase: (typeof phases)[number], index: number) {
    if (run.phase === 'finished') {
      if (run.result)
        return index < 2 || run.result.validation.valid
          ? t('完成', 'Complete')
          : t('受阻', 'Blocked')
      return t('未記錄完成狀態', 'Completion not recorded')
    }
    const current = phases.indexOf(run.phase)
    if (index < current) return t('完成', 'Complete')
    if (phase === run.phase)
      return run.status === 'queued'
        ? t('等待開始', 'Waiting to start')
        : t('進行中', 'In progress')
    return t('尚未開始', 'Not started')
  }
  return (
    <section className="agent-panel" aria-label={t('本機分析詳情', 'Local analysis details')}>
      <div className="local-agent-section-header">
        <h2>{t('分析進度與證據', 'Analysis progress and evidence')}</h2>
        <strong>{statusLabel(run.status, t)}</strong>
      </div>
      <p className="local-agent-meta">
        {run.model.name} ·{' '}
        {run.request.mode === 'analysis'
          ? t('分析原配置', 'Review original allocation')
          : t('保守調整', 'Conservative adjustment')}{' '}
        · {run.as_of}
        <br />
        {t('分析識別', 'Analysis ID')}: {run.id} · {t('來源工作流', 'Source workflow')}:{' '}
        {run.source_run_id}
      </p>
      {!run.current && (
        <div className="notice" role="status">
          {t(
            '此分析的來源已失效，歷史內容保留供檢閱，不能建立新提案。',
            'This analysis has stale sources. Its history remains readable, but it cannot create a new proposal.',
          )}
          <ul>
            {run.stale_reasons.map((reason) => (
              <li key={reason}>{staleLabels[reason] || reason}</li>
            ))}
          </ul>
        </div>
      )}
      {run.error && (
        <p className="error-message" role="alert">
          {issueLabel(run.error, t)} <code>{run.error.code}</code>
        </p>
      )}
      <ol
        className="local-agent-progress"
        aria-label={t('實際處理階段', 'Actual processing phases')}
      >
        {phases.map((phase, index) => (
          <li
            key={phase}
            className={run.phase === phase && localAgentActive(run.status) ? 'is-running' : ''}
          >
            <strong>
              {index + 1}. {phaseLabels[phase]}
            </strong>
            <span>{phaseStatus(phase, index)}</span>
          </li>
        ))}
      </ol>
      <p>
        {t(
          '下列角色觀點來自同一次模型推論。引用中的行情數字與原始目標由程式提供；角色分類與保守選擇由模型提出。',
          'The role perspectives below come from the same model inference. Market facts and original targets are supplied by the program; classifications and conservative choices come from the model.',
        )}
      </p>
      {run.result ? (
        <>
          <div className={`agent-verdict ${run.result.validation.valid ? 'allowed' : 'blocked'}`}>
            {run.result.validation.valid
              ? t('模型輸出規則驗證通過', 'Model output passed rule validation')
              : t(
                  '模型輸出未通過驗證；以下內容不能作為可用配置',
                  'Model output failed validation; the content below is not an eligible allocation',
                )}
          </div>
          {!!run.result.validation.issues.length && (
            <ul className="local-agent-rule-checks">
              {run.result.validation.issues.map((issue, index) => (
                <li key={index}>
                  {issueLabel(issue, t)} <code>{issue.code}</code>
                </li>
              ))}
            </ul>
          )}
          {!!run.result.role_views.length && (
            <ol className="local-agent-roles">
              {run.result.role_views.map((view, index) => (
                <li key={`${view.role}:${index}`}>
                  <h3>{roleLabels[view.role]}</h3>
                  <strong>{assessment[view.assessment]}</strong>
                  <ul>
                    {view.findings.map((finding, findingIndex) => (
                      <li key={findingIndex}>
                        {t(finding.text, findingEnglish[finding.code] || finding.code)}
                        <Evidence facts={finding.evidence} t={t} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
          {!!run.result.decisions.length && (
            <>
              <h3>{t('逐標的模型選擇', 'Model choices by symbol')}</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('標的', 'Symbol'),
                        t('選擇', 'Choice'),
                        t('原目標', 'Original target'),
                        t('計算目標', 'Computed target'),
                        t('理由與引用', 'Reason and evidence'),
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {run.result.decisions.map((decision, index) => (
                      <tr key={`${decision.symbol}:${index}`}>
                        <th scope="row">{decision.symbol}</th>
                        <td>
                          {
                            {
                              retain: t('保留', 'Retain'),
                              halve: t('減半', 'Halve'),
                              exclude: t('剔除', 'Exclude'),
                            }[decision.action]
                          }
                        </td>
                        <td>{percent(decision.original_weight_pct)}</td>
                        <td>{percent(decision.target_weight_pct)}</td>
                        <td className="local-agent-reason-cell">
                          {t(
                            decision.text,
                            decisionEnglish[decision.reason_code] || decision.reason_code,
                          )}
                          <Evidence facts={decision.evidence} t={t} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p>
            {t('通過驗證的目標現金', 'Validated target cash')}:{' '}
            <strong>{percent(run.cash_weight_pct)}</strong> ·{' '}
            {t('可接續提案', 'Ready for a proposal')}:{' '}
            {run.proposal_ready ? t('是', 'Yes') : t('否', 'No')}
          </p>
          <RawModelOutput
            content={run.result.raw_content}
            digest={run.result.output_digest}
            t={t}
          />
        </>
      ) : (
        <p>
          {localAgentActive(run.status)
            ? t(
                '等待本機模型產生完整、可驗證的輸出。',
                'Waiting for a complete, verifiable local model response.',
              )
            : t(
                '這次分析沒有可展示的完整模型輸出。',
                'This analysis has no complete model output to display.',
              )}
        </p>
      )}
      <details className="agent-method">
        <summary>{t('原始事實、方法與模型版本', 'Input facts, method and model versions')}</summary>
        <Evidence facts={run.facts} t={t} />
        <p>
          {t(
            '原規則配置與所有數字來自保存的輸入事實。模型只能選擇受支持的分類與保留／減半／剔除，程式計算最後權重；沒有分配出去的權重保留現金。',
            'Original targets and all numerical facts come from the saved inputs. The model selects supported classifications and retain/halve/exclude actions; the program calculates final weights. Unallocated weight remains cash.',
          )}
        </p>
        <p className="local-agent-meta">
          {run.engine_version} · {run.prompt_version} · {run.source.engine_version}
          <br />
          {t('模型內容指紋', 'Model digest')}: {run.model.digest}
          <br />
          {t('輸入版本', 'Input revision')}: {run.input_revision}
          <br />
          {t('開始 / 結束', 'Started / finished')}:{' '}
          {run.started_at ? dateTime(run.started_at) : '—'} /{' '}
          {run.finished_at ? dateTime(run.finished_at) : '—'}
        </p>
        <pre className="local-agent-json">
          {JSON.stringify(
            {
              source: run.source,
              prompt_digest: run.prompt_digest,
              schema_digest: run.schema_digest,
              options: run.options,
              metrics: run.result?.metrics ?? null,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  )
}

export function LocalPaperPreview({ preview, t }: { preview: PaperPreview; t: Translate }) {
  return (
    <div
      className="agent-preview"
      aria-label={t('模型配置紙上預覽', 'Model allocation paper preview')}
    >
      <div className={`agent-verdict ${preview.executable ? 'allowed' : 'blocked'}`}>
        {preview.executable
          ? t('紙上帳戶驗算通過', 'Paper account checks passed')
          : t('紙上帳戶限制未通過', 'Paper account checks blocked')}
      </div>
      <div className="agent-preview-stats">
        <span>
          {t('調整前淨值', 'Equity before trades')} <strong>{money(preview.equity_before)}</strong>
        </span>
        <span>
          {t('預計現金', 'Projected cash')} <strong>{money(preview.cash_after)}</strong>
        </span>
        <span>
          {t('總換手', 'Gross turnover')} <strong>{percent(preview.turnover_pct)}</strong>
        </span>
        <span>
          {t('費用', 'Fees')} <strong>{money(preview.fees_total)}</strong>
        </span>
        <span>
          {t('滑價', 'Slippage')} <strong>{money(preview.slippage_total)}</strong>
        </span>
        <span>
          {t('報價覆蓋', 'Price coverage')}{' '}
          <strong>
            {preview.coverage.priced}/{preview.coverage.required}
          </strong>
        </span>
      </div>
      {preview.violations.length > 0 && (
        <ul className="agent-reasons">
          {preview.violations.map((issue, index) => (
            <li key={index}>
              {issue.symbol && <strong>{issue.symbol} </strong>}
              {paperReason(issue.code, issue.message, t)}
            </li>
          ))}
        </ul>
      )}
      {preview.orders.length > 0 ? (
        <div
          className="table-scroll"
          tabIndex={0}
          aria-label={t('模型配置預計變動', 'Model allocation proposed trades')}
        >
          <table>
            <thead>
              <tr>
                {[
                  t('代碼', 'Symbol'),
                  t('變動', 'Change'),
                  t('股數', 'Shares'),
                  t('參考價', 'Reference price'),
                  t('模擬價', 'Simulated price'),
                  t('名目金額', 'Notional'),
                  t('費用', 'Fee'),
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.orders.map((order) => (
                <tr key={order.symbol}>
                  <th scope="row">{order.symbol}</th>
                  <td>{order.side === 'buy' ? t('增加', 'Increase') : t('減少', 'Decrease')}</td>
                  <td>{num(order.shares, 6)}</td>
                  <td>{money(order.reference_price)}</td>
                  <td>{money(order.fill_price)}</td>
                  <td>{money(order.notional)}</td>
                  <td>{money(order.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t('沒有可列示的紙上變動。', 'No paper trades to display.')}</p>
      )}
      {!!preview.skipped_orders?.length && (
        <ul className="agent-reasons">
          {preview.skipped_orders.map((order, index) => (
            <li key={index}>
              {order.symbol}:{' '}
              {order.reason === 'min_trade_notional'
                ? t('未達最低交易額', 'Below the minimum trade size')
                : t('股數低於允許精度', 'Shares below permitted precision')}{' '}
              · {t('保留原持倉', 'Existing holdings retained')}
            </li>
          ))}
        </ul>
      )}
      <p className="local-agent-meta">
        {t(
          '此預覽只使用已驗證配置；保存提案不會模擬成交。',
          'This preview uses validated targets only; saving a proposal does not simulate fills.',
        )}
        <br />
        {preview.engine_version} · {preview.as_of} · {t('帳戶版本', 'Account version')}{' '}
        {preview.account_version} · {preview.input_revision}
      </p>
    </div>
  )
}

export function LocalAgentSetup({
  draft,
  onChange,
  sources,
  models,
  available,
  loading,
  starting,
  onRefresh,
  onStart,
  t,
}: {
  draft: LocalAgentDraft
  onChange: (draft: LocalAgentDraft) => void
  sources: AgentRunSummary[]
  models: string[]
  available: boolean
  loading: boolean
  starting: boolean
  onRefresh: () => void
  onStart: (event: FormEvent) => void
  t: Translate
}) {
  const source = sources.find((row) => row.id === draft.sourceRunId)
  const eligible = sources.filter((row) => row.current && row.status === 'proposed')
  const canStart =
    available && models.includes(draft.model) && !!source?.current && source.status === 'proposed'
  return (
    <form
      className="agent-panel"
      onSubmit={onStart}
      aria-label={t('本機模型分析設定', 'Local model analysis settings')}
    >
      <div className="local-agent-header">
        <div>
          <div className="eyebrow">{t('本機模型分析', 'LOCAL MODEL ANALYSIS')}</div>
          <h2>{t('以本機模型審閱規則工作流', 'Review a rule workflow with a local model')}</h2>
        </div>
        <button type="button" className="button" onClick={onRefresh} disabled={loading}>
          {loading
            ? t('讀取中…', 'Loading…')
            : t('重新整理模型與來源', 'Refresh models and sources')}
        </button>
      </div>
      <p>
        {t(
          '從已保存且當期有效的規則工作流取得證據，交給這台電腦上的 Ollama 模型。一次推論產生研究、配置與風險三種角色觀點，結果再經確定性的規則驗證。',
          'Use evidence from a saved, current rule workflow with an Ollama model on this computer. One inference produces research, allocation and risk perspectives, followed by deterministic validation.',
        )}
      </p>
      <p className={`local-agent-runtime ${available ? '' : 'is-unavailable'}`} role="status">
        {loading
          ? t('正在讀取本機模型清單…', 'Reading installed local models…')
          : available
            ? t(
                '本機模型服務可用；只使用已安裝的模型。',
                'Local model service is available; only installed models are used.',
              )
            : t('本機模型服務目前不可用。', 'The local model service is currently unavailable.')}
      </p>
      <div className="agent-form-grid">
        <label className="agent-field">
          <span>{t('來源規則工作流', 'Source rule workflow')}</span>
          <select
            value={draft.sourceRunId}
            onChange={(event) => onChange({ ...draft, sourceRunId: event.target.value })}
          >
            <option value="">{t('選擇當期有效工作流', 'Select a current workflow')}</option>
            {draft.sourceRunId && !eligible.some((row) => row.id === draft.sourceRunId) && (
              <option value={draft.sourceRunId} disabled>
                {draft.sourceRunId} · {t('目前不可用', 'Unavailable')}
              </option>
            )}
            {eligible.map((row) => (
              <option key={row.id} value={row.id}>
                {dateTime(row.created_at)} · {row.coverage.selected} {t('標的', 'targets')} ·{' '}
                {row.id.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          <span>{t('已安裝的本機模型', 'Installed local model')}</span>
          <select
            value={draft.model}
            onChange={(event) => onChange({ ...draft, model: event.target.value })}
          >
            <option value="">{t('選擇本機模型', 'Select a local model')}</option>
            {draft.model && !models.includes(draft.model) && (
              <option value={draft.model} disabled>
                {draft.model} · {t('目前不可用', 'Unavailable')}
              </option>
            )}
            {models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!loading && !eligible.length && (
        <p className="notice">
          {t(
            '尚無可用來源。請先在規則 Agent 建立當期有效、具有入選標的的工作流，再重新整理。',
            'No eligible source is available. Create a current rule workflow with selected candidates in the rule agent, then refresh.',
          )}
        </p>
      )}
      {!loading && available && !models.length && (
        <p className="notice">
          {t('尚無可用的已安裝本機模型。', 'No installed local model is available.')}
        </p>
      )}
      {source && (
        <p className="local-agent-source-info">
          {t('來源日期', 'Source session')}: {source.as_of} · {t('入選', 'Selected')}:{' '}
          {source.coverage.selected}/{source.coverage.requested} ·{' '}
          {t('原目標現金', 'Original target cash')}: {percent(source.cash_weight_pct)}
          <br />
          {source.target_weights
            .map((row) => `${row.symbol} ${percent(row.weight_pct)}`)
            .join(' / ') || '—'}
        </p>
      )}
      <label className="agent-field">
        <span>{t('模型配置權限', 'Model allocation scope')}</span>
        <select
          value={draft.mode}
          onChange={(event) =>
            onChange({ ...draft, mode: event.target.value as LocalAgentDraft['mode'] })
          }
        >
          <option value="analysis">
            {t('分析原配置：只保留原目標', 'Review original allocation: retain targets only')}
          </option>
          <option value="conservative">
            {t('保守調整：可保留、減半或剔除', 'Conservative adjustment: retain, halve or exclude')}
          </option>
        </select>
      </label>
      <div className="agent-method">
        {t(
          '保守調整不提高任何標的權重；減少的部位保留現金。模型無法新增標的、補造行情或重新分配缺失權重。此步驟只保存分析結果，紙上提案需另行預覽與保存。',
          'Conservative adjustments never increase a target weight; reductions stay in cash. The model cannot add symbols, fill missing market data or redistribute missing weights. This step saves analysis only; paper proposals require a separate preview and save.',
        )}
      </div>
      <div className="actions">
        <button
          type="submit"
          className="button primary"
          disabled={loading || starting || !canStart}
        >
          {starting ? t('啟動中…', 'Starting…') : t('啟動本機分析', 'Start local analysis')}
        </button>
      </div>
    </form>
  )
}
