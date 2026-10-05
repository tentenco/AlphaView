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
  defaultJevDraft,
  jevCost,
  jevDraftKey,
  jevProbability,
  jevSourceEligible,
  parseJevPolicy,
  validJevDraft,
  type JevCheck,
  type JevConnection,
  type JevDraft,
  type JevGateStatus,
  type JevHistory,
  type JevIssue,
  type JevOutcomes,
  type JevPaperPreview,
  type JevPaperProposal,
  type JevQuestionSet,
  type JevRun,
  type JevRunSummary,
  type JevStatus,
  type JevUsageSummary,
} from './jev-model'
import { useSessionState } from './session-state'
import { dateTime, money, num } from './ui'
import './jev-gate.css'

type Translate = (zh: string, en: string) => string
type Props = {
  account: PaperAccount
  locale: Locale
  onProposal: (proposal: PaperProposal) => void
}
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value)}%`)
const ENGLISH: Record<string, string> = {
  not_configured: 'Configure the Jev API connection first.',
  authentication_failed: 'The Jev API key was rejected. Configure the connection again.',
  rate_limited: 'TypeSafe asked for a lower request rate or is overloaded. Retry later.',
  network_unavailable: 'The TypeSafe API is unreachable. Check the network and retry.',
  provider_unavailable: 'TypeSafe did not return a successful response; nothing was used.',
  invalid_response: 'TypeSafe returned an invalid response; nothing was used.',
  request_rejected: 'TypeSafe rejected the request format; nothing was used.',
  response_limit: 'The TypeSafe response exceeded a size or time limit; nothing was used.',
  connection_changed: 'The connection changed. Reload the connection settings and try again.',
  invalid_credentials: 'Enter a TypeSafe API key starting with apikey_. Nothing else is accepted.',
  credential_file: 'The local credential file or its owner-only permissions need attention.',
  source_stale: 'The source rules workflow is not current or not proposed. Recompute it first.',
  source_size: 'The gate needs between 1 and 10 selected rule targets.',
  scan_missing: 'The source scan snapshot no longer exists.',
  symbol_key_conflict: 'Two candidate symbols collide in the state keys; the request was not sent.',
  idempotency_conflict: 'This request identifier was already used with different content.',
  run_not_found: 'The Jev decision record was not found.',
  answers_invalid: 'The response failed validation; no allocation is available from this run.',
  source_changed:
    'The source market data, session or engine changed during evaluation; the result is kept but cannot proceed.',
  no_passing_candidates: 'No symbol cleared every threshold; no liquidation proposal is created.',
  model_mismatch: 'The answering model differs from the pinned version; thresholds do not apply.',
  answers_incomplete: 'The response was missing, duplicated or added answers.',
  answer_invalid: 'An answer had the wrong type or value.',
  state_incomplete: 'Required indicators were missing, so no question was asked.',
  answer_unavailable: 'No valid answer was returned for this question.',
}
const codeLabel = (code: string, fallback: string, t: Translate) =>
  t(fallback, ENGLISH[code] || fallback)

async function jevRequest<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string')
      throw new Error(
        codeLabel(
          detail.code,
          typeof detail.message === 'string' ? detail.message : detail.code,
          t,
        ),
      )
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
const statusLabel = (status: JevStatus, t: Translate) =>
  ({
    completed: t('已完成', 'Completed'),
    blocked: t('受阻', 'Blocked'),
    stale: t('來源已過期', 'Stale'),
    failed: t('失敗', 'Failed'),
  })[status]
const gateLabel = (status: JevGateStatus, t: Translate) =>
  ({
    pass: t('通過', 'Pass'),
    fail: t('未通過', 'Fail'),
    unavailable: t('不可用', 'Unavailable'),
  })[status]

export function PortfolioJevGate(props: Props) {
  return <JevGateAccount key={props.account.id} {...props} />
}

function JevGateAccount({ account, locale, onProposal }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(jevDraftKey(account.id), defaultJevDraft, validJevDraft)
  const [connection, setConnection] = useState<JevConnection | null>(null)
  const [questions, setQuestions] = useState<JevQuestionSet | null>(null)
  const [sources, setSources] = useState<AgentRunSummary[]>([])
  const [history, setHistory] = useState<JevRunSummary[]>([])
  const [usage, setUsage] = useState<JevUsageSummary | null>(null)
  const [run, setRun] = useState<JevRun | null>(null)
  const [outcomes, setOutcomes] = useState<JevOutcomes | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<
    'connect' | 'disconnect' | 'run' | 'detail' | 'preview' | 'save' | 'outcomes' | null
  >(null)
  const [apiKey, setApiKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [bridge, setBridge] = useState<{ key: string; preview: PaperPreview } | null>(null)
  const [saved, setSaved] = useState<{ key: string; proposal: PaperProposal } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const runAttempt = useRef({ input: '', key: '' })
  const bridgeAttempt = useRef({ key: '', idempotencyKey: '' })
  const policy = parseJevPolicy(draft)
  const maxSelected = questions?.max_selected ?? 10
  const source = sources.find((row) => row.id === draft.sourceRunId)
  const sourceOk = !!source && jevSourceEligible(source, source.target_weights.length, maxSelected)
  const canRun = !!connection?.configured && sourceOk && !!policy.policy && !busy && !loading
  const bridgeKey = JSON.stringify([run?.id, run?.input_revision, account.id, account.version])
  const canBridge = !!run && run.status === 'completed' && run.current && run.proposal_ready
  const preview = canBridge && bridge?.key === bridgeKey ? bridge.preview : null
  const savedProposal = saved?.key === bridgeKey ? saved.proposal : null

  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    Promise.allSettled([
      jevRequest<JevConnection>('/api/jev/connection', t, { signal: controller.signal }),
      jevRequest<JevQuestionSet>('/api/jev/questions', t, { signal: controller.signal }),
      jevRequest<AgentHistory>('/api/portfolio-agent/runs?limit=100', t, {
        signal: controller.signal,
      }),
      jevRequest<JevHistory>('/api/jev/runs?limit=20', t, { signal: controller.signal }),
    ]).then(([link, rulebook, rules, runs]) => {
      if (controller.signal.aborted) return
      const errors: string[] = []
      const reason = (item: PromiseRejectedResult) =>
        String(item.reason instanceof Error ? item.reason.message : item.reason)
      if (link.status === 'fulfilled') setConnection(link.value)
      else errors.push(reason(link))
      if (rulebook.status === 'fulfilled') setQuestions(rulebook.value)
      else errors.push(reason(rulebook))
      if (rules.status === 'fulfilled') setSources(rules.value.runs)
      else errors.push(reason(rules))
      if (runs.status === 'fulfilled') {
        setHistory(runs.value.runs)
        setUsage(runs.value.usage_summary)
        setRun((current) => {
          if (!current) return current
          const summary = runs.value.runs.find((row) => row.id === current.id)
          return summary ? { ...current, ...summary } : current
        })
      } else errors.push(reason(runs))
      setLoadErrors(errors)
      setLoading(false)
    })
    return () => controller.abort()
    // The translate helper only changes with locale, which re-renders labels without refetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, account.version])

  async function perform(
    action: NonNullable<typeof busy>,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  function showRun(data: JevRun) {
    setRun(data)
    setOutcomes(null)
    setBridge(null)
    setSaved(null)
    setHistory((rows) => [data, ...rows.filter((row) => row.id !== data.id)].slice(0, 20))
  }
  function connect(event: FormEvent) {
    event.preventDefault()
    if (!connection || !apiKey.trim()) return
    void perform('connect', async (signal) => {
      const value = await jevRequest<JevConnection>('/api/jev/connection', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({ api_key: apiKey.trim(), expected_version: connection.version }),
      })
      if (signal.aborted) return
      setConnection(value)
      setApiKey('')
      setEditing(false)
      setNotice(
        t(
          'TypeSafe 金鑰驗證成功，已保存於本機擁有者專用檔案。',
          'TypeSafe key verified and saved in the local owner-only file.',
        ),
      )
    })
  }
  function disconnect() {
    if (!connection?.version) return
    void perform('disconnect', async (signal) => {
      const value = await jevRequest<JevConnection>('/api/jev/connection', t, {
        method: 'DELETE',
        signal,
        body: JSON.stringify({ expected_version: connection.version }),
      })
      if (signal.aborted) return
      setConnection(value)
      setApiKey('')
      setEditing(false)
      setNotice(
        t(
          '已移除本機金鑰；TypeSafe 帳戶與原金鑰仍存在，需另至 console.typesafe.ai 撤銷。',
          'Local key removed. The TypeSafe account and key still exist; revoke them at console.typesafe.ai.',
        ),
      )
    })
  }
  function start(event: FormEvent) {
    event.preventDefault()
    if (!canRun || !policy.policy) return
    const body = { source_run_id: draft.sourceRunId, policy: policy.policy }
    const input = JSON.stringify(body)
    if (runAttempt.current.input !== input) runAttempt.current = { input, key: newPaperKey() }
    const key = runAttempt.current.key
    void perform('run', async (signal) => {
      const data = await jevRequest<JevRun>('/api/jev/runs', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({ ...body, idempotency_key: key }),
      })
      if (signal.aborted) return
      runAttempt.current = { input: '', key: '' }
      showRun(data)
      setRefresh((value) => value + 1)
    })
  }
  function openRun(id: string) {
    void perform('detail', async (signal) => {
      const data = await jevRequest<JevRun>(`/api/jev/runs/${encodeURIComponent(id)}`, t, {
        signal,
      })
      if (!signal.aborted) showRun(data)
    })
  }
  function loadOutcomes() {
    if (!run) return
    const id = run.id
    void perform('outcomes', async (signal) => {
      const data = await jevRequest<JevOutcomes>(
        `/api/jev/runs/${encodeURIComponent(id)}/outcomes`,
        t,
        { signal },
      )
      if (!signal.aborted) setOutcomes(data)
    })
  }
  function paperBridge(save: boolean) {
    if (!run || !canBridge || (save && (!preview?.executable || savedProposal))) return
    if (bridgeAttempt.current.key !== bridgeKey)
      bridgeAttempt.current = { key: bridgeKey, idempotencyKey: newPaperKey() }
    void perform(save ? 'save' : 'preview', async (signal) => {
      const data = await jevRequest<JevPaperPreview | JevPaperProposal>(
        `/api/jev/runs/${encodeURIComponent(run.id)}/${save ? 'paper-proposal' : 'paper-preview'}`,
        t,
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

  const eligibleSources = sources.filter((row) =>
    jevSourceEligible(row, row.target_weights.length, maxSelected),
  )
  return (
    <div className="jev-gate">
      <section className="agent-panel" aria-label={t('Jev 連線', 'Jev connection')}>
        <div className="section-heading">
          <div>
            <div className="eyebrow">JEV / SYSTEM ONE DECISION GATE</div>
            <h2>{t('Jev 決策閘', 'Jev decision gate')}</h2>
            <p>
              {t(
                '規則工作流負責一次性的策略設計與排序；Jev 以固定問題對每個入選標的回傳校準機率；門檻與風險限制由本機程式檢查；模擬帳戶最後才執行。',
                'The rules workflow does the one-time strategy design and ranking; Jev returns calibrated probabilities for fixed questions about each selected symbol; local code checks thresholds and risk limits; the paper account executes last.',
              )}
            </p>
          </div>
          <span className="agent-mode">
            {t('外部付費 API · 僅供研究', 'External paid API · research only')}
          </span>
        </div>
        <div
          className={`jev-gate-connection${connection?.configured ? '' : ' is-unconfigured'}`}
          role="status"
        >
          <strong>
            {loading && !connection
              ? t('讀取中…', 'Loading…')
              : connection?.configured
                ? t('已設定 TypeSafe 連線', 'TypeSafe connection configured')
                : t('尚未設定 TypeSafe 連線', 'TypeSafe connection not configured')}
          </strong>
          <p className="jev-gate-meta">
            {connection?.endpoint || 'https://api.typesafe.ai'} · {t('釘選模型', 'Pinned model')}{' '}
            {connection?.model || '—'} · {t('問題集', 'Question set')}{' '}
            {connection?.question_set_version || '—'}
            {connection?.connected_at
              ? ` · ${t('連線於', 'Connected')} ${dateTime(connection.connected_at)}`
              : ''}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={loading || !!busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('重新整理', 'Refresh')}
          </button>
          {connection?.configured && (
            <>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => setEditing((value) => !value)}
              >
                {t('連線設定', 'Connection settings')}
              </button>
              <button type="button" className="button" disabled={!!busy} onClick={disconnect}>
                {t('移除本機金鑰', 'Remove local key')}
              </button>
            </>
          )}
        </div>
        {connection && (!connection.configured || editing) && (
          <form className="jev-gate-form" onSubmit={connect} autoComplete="off">
            <p>
              {t(
                '請貼上 TypeSafe API Key（apikey_ 開頭）。金鑰只送到本機後端，保存於僅擁有者可讀寫的檔案，不進 Git、資料庫、備份或瀏覽器儲存。',
                'Paste a TypeSafe API key (starting with apikey_). It is sent only to the local backend and kept in an owner-only file, outside Git, the database, backups and browser storage.',
              )}
            </p>
            <div className="agent-form-grid">
              <label>
                TypeSafe API Key
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={300}
                  required
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            </div>
            <div className="actions">
              <button className="button primary" disabled={!!busy || !apiKey.trim()}>
                {busy === 'connect'
                  ? t('驗證中…', 'Verifying…')
                  : t('驗證並保存金鑰', 'Verify and save key')}
              </button>
            </div>
          </form>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {loadErrors.map((message, index) => (
          <p className="error-message" role="alert" key={index}>
            {message}
          </p>
        ))}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </section>

      <Rulebook
        questions={questions}
        draft={draft}
        onChange={setDraft}
        policyError={policy.error}
        t={t}
      />

      <section className="agent-panel" aria-label={t('執行 Jev 決策閘', 'Run Jev decision gate')}>
        <h2>{t('對已保存工作流執行決策閘', 'Run the gate on a saved workflow')}</h2>
        <form onSubmit={start}>
          <div className="agent-form-grid">
            <label>
              {t('來源規則工作流', 'Source rule workflow')}
              <select
                value={draft.sourceRunId}
                onChange={(event) => setDraft({ ...draft, sourceRunId: event.target.value })}
              >
                <option value="">{t('選擇工作流', 'Select a workflow')}</option>
                {eligibleSources.map((row) => (
                  <option key={row.id} value={row.id}>
                    {dateTime(row.created_at)} ·{' '}
                    {row.target_weights.map((target) => target.symbol).join(' · ')} · {row.as_of}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="jev-gate-meta">
            {t(
              `只列出當期有效、已提出且最多 ${maxSelected} 個入選標的的工作流。每次執行是一次付費的外部呼叫，費用依回傳 token 估算。`,
              `Only current, proposed workflows with up to ${maxSelected} selected symbols are listed. Every run is one paid external call, costed from returned tokens.`,
            )}
          </p>
          <div className="actions">
            <button className="button primary" disabled={!canRun}>
              {busy === 'run' ? t('評估中…', 'Evaluating…') : t('執行 Jev 決策閘', 'Run Jev gate')}
            </button>
          </div>
          {!connection?.configured && !loading && (
            <p className="notice">
              {t('請先設定 TypeSafe 連線。', 'Configure the TypeSafe connection first.')}
            </p>
          )}
        </form>
      </section>

      {run && (
        <>
          <RunDetails run={run} questions={questions} t={t} />
          <section className="agent-panel" aria-label={t('Jev 紙上操作', 'Jev paper actions')}>
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => openRun(run.id)}
              >
                {t('更新決策狀態', 'Refresh decision status')}
              </button>
              <button type="button" className="button" disabled={!!busy} onClick={loadOutcomes}>
                {busy === 'outcomes'
                  ? t('讀取中…', 'Loading…')
                  : t('查看後續走勢', 'Load later outcomes')}
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
                  '只有當期有效、至少一個標的通過全部門檻的已完成決策，才能進入紙上預覽。',
                  'Only a completed, current decision with at least one symbol passing every threshold can enter paper preview.',
                )}
              </p>
            )}
            {outcomes && <OutcomesTable outcomes={outcomes} t={t} />}
            {preview && <PreviewSummary preview={preview} t={t} />}
            {savedProposal && (
              <p className="notice" role="status">
                {t('紙上提案已保存，尚未執行。', 'Paper proposal saved; not executed.')}{' '}
                {savedProposal.id}
              </p>
            )}
          </section>
        </>
      )}

      <section className="agent-panel" aria-label={t('Jev 決策歷史', 'Jev decision history')}>
        <h2>{t('已保存決策', 'Saved decisions')}</h2>
        {usage && usage.evaluated_runs > 0 && (
          <p className="jev-gate-meta">
            {t('列出', 'Listed')} {usage.listed_runs} · {t('平均延遲', 'Average latency')}{' '}
            {usage.average_latency_ms == null ? '—' : `${num(usage.average_latency_ms, 0)} ms`} ·{' '}
            {t('平均輸入 token', 'Average input tokens')}{' '}
            {usage.average_input_tokens == null ? '—' : num(usage.average_input_tokens, 0)} ·{' '}
            {t('每次估算費用', 'Estimated cost per decision')}{' '}
            {jevCost(usage.average_estimated_cost_usd)} · {t('合計', 'Total')}{' '}
            {jevCost(usage.total_estimated_cost_usd)}
          </p>
        )}
        {!history.length ? (
          <p>
            {loading ? t('讀取中…', 'Loading…') : t('尚無 Jev 決策。', 'No Jev decisions yet.')}
          </p>
        ) : (
          <div className="table-scroll jev-gate-history">
            <table>
              <thead>
                <tr>
                  {[
                    t('決策', 'Decision'),
                    t('狀態', 'Status'),
                    t('通過 / 未通過 / 不可用', 'Pass / fail / unavailable'),
                    t('延遲', 'Latency'),
                    t('輸入 token', 'Input tokens'),
                    t('估算費用', 'Estimated cost'),
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
                    <td>{statusLabel(row.status, t)}</td>
                    <td>
                      {row.counts.pass} / {row.counts.fail} / {row.counts.unavailable}
                    </td>
                    <td>{row.latency_ms == null ? '—' : `${row.latency_ms} ms`}</td>
                    <td>{row.usage.input_tokens ?? '—'}</td>
                    <td>{jevCost(row.estimated_cost_usd)}</td>
                    <td>{row.as_of}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export function Rulebook({
  questions,
  draft,
  onChange,
  policyError,
  t,
}: {
  questions: JevQuestionSet | null
  draft: JevDraft
  onChange: (draft: JevDraft) => void
  policyError: 'pass_threshold' | 'max_risk_probability' | null
  t: Translate
}) {
  return (
    <section className="agent-panel" aria-label={t('Jev 規則書', 'Jev rulebook')}>
      <h2>{t('固定問題與門檻', 'Fixed questions and thresholds')}</h2>
      <p>
        {t(
          '每條規則都寫成固定結果的問題；問題文字為英文且隨版本固定，回答只會是機率。門檻在本機保存於每次決策紀錄。',
          'Each rule is written as a fixed-outcome question; the wording is English and versioned, and the only answer is a probability. Thresholds are stored locally with every decision.',
        )}
      </p>
      {questions ? (
        <ol className="jev-gate-rulebook">
          {questions.questions.map((question) => (
            <li key={question.id}>
              <strong>
                {t(question.label, question.english)} ·{' '}
                {question.type === 'noul'
                  ? t('是／否機率', 'Yes/no probability')
                  : t('等級評分', 'Level score')}{' '}
                ·{' '}
                {question.gate === 'high'
                  ? t('須 ≥ 通過門檻', 'must be ≥ pass threshold')
                  : question.gate === 'low'
                    ? t('須 ≤ 風險上限', 'must be ≤ risk ceiling')
                    : t('僅供參考', 'informational only')}
              </strong>
              <code>{question.instructions}</code>
            </li>
          ))}
        </ol>
      ) : (
        <p>{t('讀取問題集…', 'Loading question set…')}</p>
      )}
      <div className="agent-form-grid">
        <label>
          {t('通過門檻（0.50–0.99）', 'Pass threshold (0.50–0.99)')}
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.5"
            max="0.99"
            value={draft.passThreshold}
            onChange={(event) => onChange({ ...draft, passThreshold: event.target.value })}
          />
        </label>
        <label>
          {t('過度延伸風險上限（0.01–0.50）', 'Overextension risk ceiling (0.01–0.50)')}
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            max="0.5"
            value={draft.maxRiskProbability}
            onChange={(event) => onChange({ ...draft, maxRiskProbability: event.target.value })}
          />
        </label>
      </div>
      {policyError && (
        <p className="error-message" role="alert">
          {policyError === 'pass_threshold'
            ? t(
                '通過門檻必須介於 0.50 與 0.99。',
                'The pass threshold must be between 0.50 and 0.99.',
              )
            : t(
                '風險上限必須介於 0.01 與 0.50。',
                'The risk ceiling must be between 0.01 and 0.50.',
              )}
        </p>
      )}
      {questions && (
        <details className="agent-method">
          <summary>{t('這不是什麼', 'What this is not')}</summary>
          <ul>
            {questions.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <p className="jev-gate-meta">{questions.method}</p>
        </details>
      )}
    </section>
  )
}

function CheckCell({ check, t }: { check: JevCheck; t: Translate }) {
  const state = check.passed == null ? 'unavailable' : check.passed ? 'pass' : 'fail'
  const title = check.reason ? codeLabel(check.reason, check.reason, t) : undefined
  return (
    <span className={`jev-gate-check is-${state}`} title={title}>
      {jevProbability(check.value)} {check.passed == null ? '' : check.passed ? '✓' : '✗'}
      <small>
        {check.direction === 'high' ? '≥' : '≤'} {check.threshold.toFixed(2)}
      </small>
    </span>
  )
}

function RunDetails({
  run,
  questions,
  t,
}: {
  run: JevRun
  questions: JevQuestionSet | null
  t: Translate
}) {
  const gated = (questions?.questions || []).filter((question) => question.gate)
  const staleLabels: Record<string, string> = {
    jev_engine_changed: t('決策方法已更新', 'The decision method changed'),
    question_set_changed: t('問題集版本已更新', 'The question set version changed'),
    source_fingerprint_changed: t(
      '來源工作流指紋已改變',
      'The source workflow fingerprint changed',
    ),
    source_run_stale_or_unavailable: t(
      '來源工作流已過期或不可用',
      'The source workflow is stale or unavailable',
    ),
  }
  const issues: JevIssue[] = run.error?.issues || []
  return (
    <section className="agent-panel" aria-label={t('Jev 決策詳情', 'Jev decision details')}>
      <div className="section-heading">
        <div>
          <h2>{t('決策結果', 'Decision result')}</h2>
          <p className="jev-gate-meta">
            {t('決策識別', 'Decision ID')}: {run.id} · {t('來源工作流', 'Source workflow')}:{' '}
            {run.source_run_id} · {run.as_of}
            <br />
            {t('回答模型', 'Answering model')}: {run.model.answered || '—'} · {t('延遲', 'Latency')}
            : {run.latency_ms == null ? '—' : `${run.latency_ms} ms`} ·{' '}
            {t('輸入 token', 'Input tokens')}: {run.usage.input_tokens ?? '—'} ·{' '}
            {t('估算費用', 'Estimated cost')}: {jevCost(run.estimated_cost_usd)}
            <br />
            {t('通過門檻', 'Pass threshold')} {run.policy.pass_threshold.toFixed(2)} ·{' '}
            {t('風險上限', 'Risk ceiling')} {run.policy.max_risk_probability.toFixed(2)} ·{' '}
            {run.question_set_version}
          </p>
        </div>
        <strong>{statusLabel(run.status, t)}</strong>
      </div>
      {!run.current && (
        <div className="notice" role="status">
          {t(
            '此決策的來源已失效，歷史內容保留供檢閱，不能建立新提案。',
            'This decision has stale sources. Its history remains readable, but it cannot create a new proposal.',
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
          {codeLabel(run.error.code, run.error.message, t)} <code>{run.error.code}</code>
        </p>
      )}
      {!!issues.length && (
        <ul className="jev-gate-issues">
          {issues.map((issue, index) => (
            <li key={index}>
              {codeLabel(issue.code, issue.message, t)}{' '}
              <code>{issue.question_id || issue.code}</code>
            </li>
          ))}
        </ul>
      )}
      <div className={`agent-verdict ${run.result.proposal_ready ? 'allowed' : 'blocked'}`}>
        {run.result.proposal_ready
          ? t(
              `${run.counts.pass} 檔通過全部門檻；未通過或不可用的標的歸零並保留現金。`,
              `${run.counts.pass} symbol(s) cleared every threshold; failing or unavailable symbols go to zero and stay in cash.`,
            )
          : t('沒有可接續的配置', 'No allocation can proceed')}
      </div>
      {!!run.result.blocking_reasons.length && (
        <ul className="jev-gate-issues">
          {run.result.blocking_reasons.map((reason, index) => (
            <li key={index}>
              {codeLabel(reason.code, reason.message, t)} <code>{reason.code}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('標的', 'Symbol')}</th>
              {gated.map((question) => (
                <th scope="col" key={question.id}>
                  {t(question.label, question.english)}
                </th>
              ))}
              <th scope="col">{t('設定品質', 'Setup quality')}</th>
              <th scope="col">{t('閘門', 'Gate')}</th>
              <th scope="col">{t('原配置 → 目標', 'Slot → target')}</th>
            </tr>
          </thead>
          <tbody>
            {run.result.decisions.map((decision) => (
              <tr key={decision.symbol}>
                <th scope="row">{decision.symbol}</th>
                {gated.map((question) => {
                  const check = decision.checks.find((item) => item.question === question.id)
                  return (
                    <td key={question.id}>{check ? <CheckCell check={check} t={t} /> : '—'}</td>
                  )
                })}
                <td>
                  {decision.setup_quality
                    ? `${decision.setup_quality.level_label || '—'} (${num(decision.setup_quality.score)} · ${t('信心', 'confidence')} ${jevProbability(decision.setup_quality.confidence)})`
                    : '—'}
                </td>
                <td>
                  <span className={`jev-gate-decision is-${decision.status}`}>
                    {gateLabel(decision.status, t)}
                  </span>
                  {!decision.evidence_complete && (
                    <small className="jev-gate-meta">
                      {' '}
                      {t('缺少', 'Missing')}: {decision.missing.join(', ')}
                    </small>
                  )}
                </td>
                <td>
                  {percent(decision.original_weight_pct)} → {percent(decision.target_weight_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="jev-gate-meta">
        {run.result.proposal_ready
          ? `${t('目標現金比例', 'Target cash weight')} ${percent(run.result.cash_weight_pct)}`
          : ''}
      </p>
      <details className="agent-method">
        <summary>{t('檢視送出的狀態與問題', 'Inspect the submitted state and questions')}</summary>
        <pre className="jev-gate-json">{JSON.stringify(run.state, null, 2)}</pre>
        <pre className="jev-gate-json">{JSON.stringify(run.questions, null, 2)}</pre>
        <p className="jev-gate-meta">
          {t('請求指紋', 'Request digest')}: {run.request_digest}
        </p>
      </details>
      <ul>
        {run.warnings.map((warning, index) => (
          <li key={index} className="jev-gate-meta">
            {warning}
          </li>
        ))}
      </ul>
    </section>
  )
}

function OutcomesTable({ outcomes, t }: { outcomes: JevOutcomes; t: Translate }) {
  const reasons: Record<string, string> = {
    decision_close_unavailable: t(
      '決策日調整收盤價不可用',
      'Decision-session adjusted close unavailable',
    ),
    no_later_session: t('本機尚無後續交易日資料', 'No later session is available locally yet'),
    latest_close_invalid: t('最新調整收盤價無效', 'The latest adjusted close is invalid'),
  }
  return (
    <div className="table-scroll" aria-label={t('後續走勢', 'Later outcomes')}>
      <p className="jev-gate-meta">
        {t('決策日', 'Decision session')} {outcomes.as_of} ·{' '}
        {t('最新完成交易日', 'Latest completed session')} {outcomes.latest_completed_session}
      </p>
      <table>
        <thead>
          <tr>
            {[
              t('標的', 'Symbol'),
              t('閘門', 'Gate'),
              t('目標', 'Target'),
              t('最新日期', 'Latest session'),
              t('經過交易日', 'Sessions'),
              t('調整收盤變動', 'Adjusted close change'),
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {outcomes.items.map((item) => (
            <tr key={item.symbol}>
              <th scope="row">{item.symbol}</th>
              <td>{gateLabel(item.gate_status, t)}</td>
              <td>{percent(item.target_weight_pct)}</td>
              <td>{item.latest_session || '—'}</td>
              <td>{item.sessions_elapsed}</td>
              <td>
                {item.available
                  ? `${item.forward_return_pct != null && item.forward_return_pct > 0 ? '+' : ''}${num(item.forward_return_pct)}%`
                  : `— (${reasons[item.reason || ''] || item.reason})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="jev-gate-meta">{outcomes.method}</p>
    </div>
  )
}

function PreviewSummary({ preview, t }: { preview: PaperPreview; t: Translate }) {
  return (
    <div>
      <div className={`agent-verdict ${preview.executable ? 'allowed' : 'blocked'}`}>
        {preview.executable
          ? t('紙上限制檢查通過，可保存提案', 'Paper limits passed; the proposal can be saved')
          : t('紙上限制未通過', 'Paper limits failed')}
      </div>
      {!!preview.violations.length && (
        <ul className="jev-gate-issues">
          {preview.violations.map((violation, index) => (
            <li key={index}>
              {violation.message} <code>{violation.code}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                t('標的', 'Symbol'),
                t('方向', 'Side'),
                t('股數', 'Shares'),
                t('模擬價', 'Fill price'),
                t('金額', 'Notional'),
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
                <td>{order.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                <td>{num(order.shares, 4)}</td>
                <td>{money(order.fill_price)}</td>
                <td>{money(order.notional)}</td>
                <td>{money(order.fee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="jev-gate-meta">
        {t('模擬後現金', 'Cash after')} {money(preview.cash_after)} · {t('換手', 'Turnover')}{' '}
        {percent(preview.turnover_pct)} · {t('成本合計', 'Total cost')} {money(preview.cost_total)}
      </p>
    </div>
  )
}
