import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import { api, dateTime, money, num } from './ui'
import {
  newPaperKey,
  type PaperAccount,
  type PaperPreview,
  type PaperProposal,
} from './paper-model'
import { useSessionState } from './session-state'
import { downloadAllocationComparisonCsv } from './allocation-comparison-csv'
import { WorkflowValidation } from './WorkflowValidation'
import { WorkflowPathValidation } from './WorkflowPathValidation'
import { WorkflowPathCosts } from './WorkflowPathCosts'
import { WorkflowPathSegments } from './WorkflowPathSegments'
import { WorkflowPathAttribution } from './WorkflowPathAttribution'
import { WorkflowPathReceiptComparison } from './WorkflowPathReceiptComparison'
import { WorkflowPathCSCV } from './WorkflowPathCSCV'
import { WorkflowPathTrialInventory } from './WorkflowPathTrialInventory'
import { WorkflowPathDrawdowns } from './WorkflowPathDrawdowns'
import { WorkflowPathMonthly } from './WorkflowPathMonthly'
import { WorkflowPathRolling } from './WorkflowPathRolling'
import { WorkflowPathReceiptArchive } from './WorkflowPathReceiptArchive'
import { AllocationResearch } from './AllocationResearch'
import { SavedWorkflowComparison } from './SavedWorkflowComparison'
import {
  ALLOCATION_METHODS,
  AGENT_STRATEGIES,
  agentDraftKey,
  defaultAgentDraft,
  parseAgentDraft,
  validAgentDraft,
  type AgentCandidate,
  type AgentAllocator,
  type AgentConstraints,
  type AllocationMethod,
  type AgentHistory,
  type AgentPaperPreview,
  type AgentPaperProposal,
  type AgentReason,
  type AgentRun,
  type AgentRunSummary,
  type AgentStrategy,
  type AgentAllocationComparison,
} from './portfolio-agent-model'
import { ResearchEvidenceNavigation } from './ResearchEvidenceNavigation'
import { ResearchEvidenceSection } from './ResearchEvidenceSection'
import './portfolio-agent-workflow.css'

type Translate = (zh: string, en: string) => string
type Props = {
  account: PaperAccount
  locale: Locale
  onProposal: (proposal: PaperProposal) => void
}
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value, 2)}%`)
const strategyLabel = (strategy: AgentStrategy, t: Translate) =>
  ({
    turtle: t('海龜突破', 'Turtle breakout'),
    trend: t('趨勢追蹤', 'Trend following'),
    pullback: t('強勢回調', 'Pullback'),
    rps: t('相對強度', 'Relative strength'),
  })[strategy]
const roleLabel = (role: AgentRun['steps'][number]['role'], t: Translate) =>
  ({
    research_analyst: t('研究分析', 'Research analyst'),
    allocation_planner: t('配置規劃', 'Allocation planner'),
    risk_reviewer: t('風險審閱', 'Risk reviewer'),
    proposal: t('組合提案', 'Portfolio proposal'),
  })[role]
const candidateLabel = (status: AgentCandidate['status'], t: Translate) =>
  ({
    selected: t('已選入', 'Selected'),
    unselected: t('未選入', 'Not selected'),
    rejected: t('不符合', 'Rejected'),
  })[status]

function reasonLabel(reason: AgentReason, t: Translate) {
  const english: Record<string, string> = {
    scan_missing: 'No scan snapshot. Run a scan for the latest completed session first.',
    scan_session_mismatch: 'The scan is not from the latest completed session.',
    scan_provenance_unavailable:
      'The scan engine or input version is outdated or cannot be verified.',
    scan_universe_changed: 'The universe changed after this scan. Run a fresh scan.',
    source_unavailable: 'The current scan source did not pass validation.',
    scan_row_missing: 'The scan has no unique row for this candidate.',
    scan_row_duplicate: 'The scan contains duplicate candidate rows.',
    candidate_history_unavailable: 'Current valid daily history is unavailable.',
    candidate_data_error: 'The candidate failed scan data checks.',
    adjusted_close_unavailable: 'The adjusted close is unavailable.',
    current_quote_unavailable:
      'The unadjusted close for the latest completed session is unavailable.',
    enabled_strategy_unavailable: 'An enabled strategy has no verifiable signal.',
    score_below_minimum: 'The fixed-weight consensus score is below the threshold.',
    matches_below_minimum: 'Too few enabled strategies match.',
    position_limit: 'Ranked beyond the position limit; other weights are not increased.',
    no_eligible_candidates: 'No candidates qualify. No liquidation target is created.',
    allocation_constraint_failed: 'The target portfolio failed an allocation constraint.',
    kill_switch: 'Paper execution is paused. Create a fresh proposal after resuming.',
    quote_unavailable: 'A current valid price is unavailable.',
    max_position_weight: 'The target exceeds the position weight limit.',
    post_policy_max_position_weight:
      'The resulting position exceeds the limit after execution costs and rounding.',
    min_cash_weight: 'The target or projected cash is below the account minimum.',
    holding_limit: 'The resulting number of holdings exceeds the supported limit.',
    max_turnover: 'Total buy and sell reference notional exceeds the turnover limit.',
    insufficient_cash: 'Projected cash is insufficient. Orders are not automatically reduced.',
    nonpositive_equity: 'Paper equity must remain positive after costs.',
    symbol_not_allowed:
      'The symbol is outside the account allowlist. Its original allocation slot stays in cash; no replacement is selected.',
    symbol_policy: 'The account symbol policy does not permit this increase in holdings.',
  }
  return `${t(reason.message, english[reason.code] || reason.code)}${reason.strategy ? ` (${reason.strategy})` : ''}`
}

function staleLabel(code: string, t: Translate) {
  const labels: Record<string, [string, string]> = {
    engine_changed: ['工作流引擎已更新', 'The workflow engine changed'],
    inputs_changed: ['工作區輸入已變更', 'Workspace inputs changed'],
    session_changed: ['最新已完成交易日已變更', 'The latest completed session changed'],
    scan_engine_changed: ['選股引擎已更新', 'The scan engine changed'],
    symbol_policy_changed: ['帳戶允許標的政策已變更', 'The account symbol policy changed'],
  }
  return labels[code] ? t(...labels[code]) : code
}

function errorLabel(error: unknown, t: Translate) {
  const message = error instanceof Error ? error.message : String(error)
  return t(
    message,
    /[\u3400-\u9fff]/.test(message)
      ? 'The request could not be completed. Refresh the run and account, check the inputs, then retry.'
      : message,
  )
}

/** Account changes remount the inner view; each account retains its own per-tab draft. */
export function PortfolioAgentWorkflow(props: Props) {
  return <WorkflowAccount key={props.account.id} {...props} />
}

function WorkflowAccount({ account, locale, onProposal }: Props) {
  const evidenceWorkspace = useRef<HTMLDivElement>(null)
  const evidencePrefix = useId()
  const evidenceTarget = (name: string) => `${evidencePrefix}-${name}`
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(
    agentDraftKey(account.id),
    defaultAgentDraft,
    validAgentDraft,
  )
  const [runs, setRuns] = useState<AgentRunSummary[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [validatedRunKey, setValidatedRunKey] = useState('')
  const [runCheckError, setRunCheckError] = useState('')
  const [poolBusy, setPoolBusy] = useState(false)
  const [poolNotice, setPoolNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'run' | 'detail' | 'preview' | 'save' | null>(null)
  const [bridge, setBridge] = useState<{ key: string; preview: PaperPreview } | null>(null)
  const [saved, setSaved] = useState<{ key: string; proposal: PaperProposal } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const poolOperation = useRef<AbortController | null>(null)
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  const bridgeIdentity = useRef({ key: '', idempotency: newPaperKey() })
  const parsed = parseAgentDraft(draft)
  const bridgeKey = JSON.stringify([
    run?.id,
    run?.proposal_fingerprint,
    account.id,
    account.version,
  ])
  const policyVersion = account.symbol_policy?.version ?? 1
  const runCheckKey = JSON.stringify([run?.id, account.version, policyVersion, refresh])
  const runChecked = validatedRunKey === runCheckKey
  const policyBindingCurrent =
    !run?.account_context ||
    (run.account_context.account_id === account.id &&
      run.account_context.symbol_policy.version === policyVersion)
  const canBridge =
    !!run &&
    run.status === 'proposed' &&
    run.current !== false &&
    policyBindingCurrent &&
    runChecked &&
    !runCheckError &&
    !historyError
  const currentPreview = canBridge && bridge?.key === bridgeKey ? bridge.preview : null
  const currentSaved = saved?.key === bridgeKey ? saved.proposal : null
  const changedDraft =
    !!run &&
    JSON.stringify(parsed.input) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(run.request).filter(([key]) => key !== 'account_context'),
        ),
      )

  useEffect(
    () => () => {
      operation.current?.abort()
      poolOperation.current?.abort()
    },
    [],
  )
  useEffect(() => {
    const controller = new AbortController()
    setLoadingHistory(true)
    api<AgentHistory>('/api/portfolio-agent/runs?limit=20', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        setRuns(data.runs)
        setHistoryError('')
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setHistoryError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingHistory(false)
      })
    return () => controller.abort()
  }, [refresh, account.version])
  useEffect(() => {
    if (!run?.id) return
    const id = run.id
    const controller = new AbortController()
    setRunCheckError('')
    api<AgentRun>(`/api/portfolio-agent/runs/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return
        if (value.id !== id)
          throw new Error(
            t(
              '工作流識別不符，請重新開啟。',
              'The workflow identity does not match. Open it again.',
            ),
          )
        setRun((current) => (current?.id === id ? value : current))
        setValidatedRunKey(runCheckKey)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setRunCheckError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [run?.id, runCheckKey])

  async function request(
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

  function createRun(event: FormEvent) {
    event.preventDefault()
    if (!parsed.input) return
    void request('run', async (signal) => {
      const result = await api<AgentRun>('/api/portfolio-agent/runs', {
        method: 'POST',
        body: JSON.stringify({
          ...parsed.input,
          account_context: { account_id: account.id, expected_policy_version: policyVersion },
        }),
        signal,
      })
      if (signal.aborted) return
      setRun({
        ...result,
        current: result.current ?? true,
        stale_reasons: result.stale_reasons ?? [],
      })
      setBridge(null)
      setSaved(null)
      setRefresh((value) => value + 1)
    })
  }

  function openRun(id: string) {
    void request('detail', async (signal) => {
      const result = await api<AgentRun>(`/api/portfolio-agent/runs/${encodeURIComponent(id)}`, {
        signal,
      })
      if (signal.aborted) return
      setRun(result)
      setBridge(null)
      setSaved(null)
    })
  }

  function paperBridge(save: boolean) {
    if (!run || !canBridge || (save && (!currentPreview || currentSaved))) return
    if (bridgeIdentity.current.key !== bridgeKey)
      bridgeIdentity.current = { key: bridgeKey, idempotency: newPaperKey() }
    void request(save ? 'save' : 'preview', async (signal) => {
      const result = await api<AgentPaperPreview | AgentPaperProposal>(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/${save ? 'paper-proposal' : 'paper-preview'}`,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            account_id: account.id,
            expected_account_version: account.version,
            ...(save ? { idempotency_key: bridgeIdentity.current.idempotency } : {}),
          }),
        },
      )
      if (signal.aborted) return
      if ('paper_proposal' in result) {
        setSaved({ key: bridgeKey, proposal: result.paper_proposal })
        onProposal(result.paper_proposal)
      } else setBridge({ key: bridgeKey, preview: result.paper_preview })
    })
  }

  const validation = {
    symbols: t(
      '請輸入 1–100 個有效代碼，以逗號、空格或換行分隔，每個最多 10 字元。',
      'Enter 1–100 valid symbols, separated by commas, spaces or newlines; up to 10 characters each.',
    ),
    duplicate: t('候選代碼不能重複。', 'Candidate symbols must be unique.'),
    weights: t(
      '各策略權重須為 0–100 的有效數字。',
      'Each strategy weight must be a number from 0 to 100.',
    ),
    weight_sum: t(
      '策略權重必須合計 100%；不會自動正規化。',
      'Strategy weights must total 100%; they are not normalized automatically.',
    ),
    constraints: t(
      '請檢查限制範圍；策略數、持倉數與波動回看（20–120）必須為整數，現金緩衝須小於 100%。',
      'Check constraint ranges. Match and position counts and the volatility lookback (20–120) must be integers; the cash buffer must be below 100%.',
    ),
    matches: t(
      '最低符合策略數不能超過權重大於零的策略數。',
      'Minimum matches cannot exceed the number of strategies with positive weights.',
    ),
  }
  const constraintFields: [keyof AgentConstraints, string, number, number, string][] = [
    ['min_score', t('最低共識分數', 'Minimum consensus score'), 0, 100, 'any'],
    ['min_matches', t('最低符合策略數', 'Minimum matching strategies'), 1, 4, '1'],
    ['max_positions', t('最多持倉數', 'Maximum positions'), 1, 30, '1'],
    [
      'max_position_weight_pct',
      t('單檔目標上限（%）', 'Target position cap (%)'),
      0.00000001,
      100,
      'any',
    ],
    ['cash_buffer_pct', t('現金緩衝（%）', 'Cash buffer (%)'), 0, 99.99999999, 'any'],
  ]

  return (
    <div className="portfolio-agent-workflow" ref={evidenceWorkspace}>
      <form
        className="agent-panel"
        onSubmit={createRun}
        aria-label={t('Agent 工作流設定', 'Agent workflow settings')}
      >
        <div className="eyebrow">{t('本機規則工作流', 'LOCAL RULE WORKFLOW')}</div>
        <h2>{t('從研究訊號產生組合提案', 'Turn research signals into a portfolio proposal')}</h2>
        <p>
          {t(
            '研究、配置與風險角色使用可重現的本機規則，沒有呼叫 LLM 或券商。權重缺口保留現金，缺少訊號不會提高其他標的配置。',
            'Research, allocation and risk roles use reproducible local rules, with no LLM or broker calls. Unused allocation stays in cash; missing signals never increase another position.',
          )}
        </p>
        <label className="agent-field">
          {t('候選股票代碼', 'Candidate symbols')}
          <textarea
            value={draft.symbols}
            rows={3}
            maxLength={6000}
            placeholder={t(
              '輸入股票代碼，以逗號或換行分隔',
              'Enter symbols separated by commas or newlines',
            )}
            onChange={(event) => setDraft({ ...draft, symbols: event.target.value })}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={poolBusy || !!busy}
            onClick={async () => {
              const weights = Object.fromEntries(
                AGENT_STRATEGIES.map((id) => [
                  id,
                  draft.weights[id].trim() ? Number(draft.weights[id]) : NaN,
                ]),
              )
              const minScore = draft.constraints.min_score.trim()
                ? Number(draft.constraints.min_score)
                : NaN
              const minMatches = draft.constraints.min_matches.trim()
                ? Number(draft.constraints.min_matches)
                : NaN
              if (
                Object.values(weights).some((value) => !Number.isFinite(value)) ||
                !Number.isFinite(minScore) ||
                !Number.isFinite(minMatches)
              ) {
                setPoolNotice(
                  t(
                    '請先填寫有效的策略權重與門檻。',
                    'Enter valid strategy weights and thresholds first.',
                  ),
                )
                return
              }
              setPoolBusy(true)
              setPoolNotice('')
              const draftAtRequest = JSON.stringify(draft)
              const controller = new AbortController()
              poolOperation.current = controller
              try {
                const result = await api<{
                  status: string
                  candidate_symbols: string[]
                  coverage: { pool: number; complete: number; eligible: number; selected: number }
                  reasons: AgentReason[]
                }>('/api/portfolio-agent/candidates', {
                  method: 'POST',
                  signal: controller.signal,
                  body: JSON.stringify({
                    scope: draft.scope,
                    strategy_weights: weights,
                    min_score: minScore,
                    min_matches: minMatches,
                    limit: 100,
                  }),
                })
                if (controller.signal.aborted) return
                if (JSON.stringify(currentDraft.current) !== draftAtRequest) {
                  setPoolNotice(
                    t(
                      '草稿已變更，保留目前輸入；請重新帶入候選。',
                      'The draft changed. Your edits were kept; load candidates again.',
                    ),
                  )
                  return
                }
                if (result.status === 'ready') {
                  setDraft((current) => ({
                    ...current,
                    symbols: result.candidate_symbols.join('\n'),
                  }))
                  setPoolNotice(
                    t(
                      `已帶入 ${result.coverage.selected} 個候選；完整資料 ${result.coverage.complete}/${result.coverage.pool}，符合門檻 ${result.coverage.eligible}。`,
                      `Loaded ${result.coverage.selected} candidates; complete ${result.coverage.complete}/${result.coverage.pool}, eligible ${result.coverage.eligible}.`,
                    ),
                  )
                } else
                  setPoolNotice(result.reasons.map((reason) => reasonLabel(reason, t)).join(' '))
              } catch (err) {
                if (!controller.signal.aborted) setPoolNotice(errorLabel(err, t))
              } finally {
                if (poolOperation.current === controller) poolOperation.current = null
                if (!controller.signal.aborted) setPoolBusy(false)
              }
            }}
          >
            {poolBusy
              ? t('篩選候選中…', 'Selecting candidates…')
              : t('從當期選股帶入候選', 'Load candidates from current scan')}
          </button>
        </div>
        {poolNotice && (
          <p className="notice" role="status">
            {poolNotice}
          </p>
        )}
        <label className="agent-field">
          {t('選股來源', 'Scan source')}
          <select
            value={draft.scope}
            onChange={(event) =>
              setDraft({ ...draft, scope: event.target.value as 'market' | 'portfolio' })
            }
          >
            <option value="market">{t('市場候選池', 'Market universe')}</option>
            <option value="portfolio">{t('我的持股研究清單', 'Holdings research list')}</option>
          </select>
        </label>
        <p>
          {t(
            '使用最新已完成交易日的選股快照。若沒有當期掃描，工作流會保存阻塞原因；不會自行下載行情或執行掃描。',
            'Uses the scan for the latest completed session. If it is unavailable, the workflow records the blocker; it does not download data or run a scan.',
          )}
        </p>
        <fieldset className="workflow-fieldset">
          <legend>{t('策略權重（合計 100%）', 'Strategy weights (total 100%)')}</legend>
          <div className="agent-form-grid">
            {AGENT_STRATEGIES.map((strategy) => (
              <label key={strategy}>
                {strategyLabel(strategy, t)}
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  required
                  value={draft.weights[strategy]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      weights: { ...draft.weights, [strategy]: event.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="workflow-fieldset">
          <legend>{t('候選與配置限制', 'Candidate and allocation constraints')}</legend>
          <div className="agent-form-grid">
            {constraintFields.map(([key, label, min, max, step]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  required
                  value={draft.constraints[key]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      constraints: { ...draft.constraints, [key]: event.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="agent-form-grid">
            <label>
              {t('配置方法', 'Allocation method')}
              <select
                value={draft.constraints.allocation_method ?? 'equal'}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    constraints: { ...draft.constraints, allocation_method: event.target.value },
                  })
                }
              >
                <option value="equal">{t('等權席位（預設）', 'Equal slots (default)')}</option>
                <option value="inverse_volatility">
                  {t('反波動（1/σ）', 'Inverse volatility (1/σ)')}
                </option>
                <option value="score_tilt">
                  {t('分數傾斜（共識分數 × 1/σ）', 'Score tilt (consensus score × 1/σ)')}
                </option>
              </select>
              <small>
                {t(
                  '風險方法只改變相同總投入的分配方式；任一入選標的缺 σ 就整個不可用，不回退等權。',
                  'Risk methods only change how the same invested total is split; a missing σ for any selected symbol makes the whole allocation unavailable instead of falling back to equal slots.',
                )}
              </small>
            </label>
            <label>
              {t('波動回看交易日（20–120）', 'Volatility lookback sessions (20–120)')}
              <input
                type="number"
                min={20}
                max={120}
                step="1"
                required
                value={draft.constraints.volatility_lookback_sessions ?? '60'}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    constraints: {
                      ...draft.constraints,
                      volatility_lookback_sessions: event.target.value,
                    },
                  })
                }
              />
              <small>
                {t(
                  'σ 是回看期間調整收盤日對數報酬的樣本標準差（年化）；只用於反波動與分數傾斜。',
                  'σ is the annualised sample deviation of daily log returns of adjusted close over the lookback; used only by the risk methods.',
                )}
              </small>
            </label>
          </div>
        </fieldset>
        {parsed.error && (draft.symbols.trim() || parsed.error !== 'symbols') && (
          <p className="error-message" role="alert">
            {validation[parsed.error]}
          </p>
        )}
        <p className="workflow-draft-note">
          {t(
            '草稿保留在此分頁；重新整理歷程或帳戶不會覆寫未套用的設定。',
            'Drafts are kept in this tab. Refreshing history or the account will not overwrite unapplied settings.',
          )}
        </p>
        <button className="button primary" disabled={!!busy || !parsed.input}>
          {busy === 'run'
            ? t('產生並保存中…', 'Creating and saving…')
            : t('產生並保存工作流', 'Create and save workflow')}
        </button>
      </form>

      <section className="agent-panel" aria-label={t('工作流歷程', 'Workflow history')}>
        <div className="workflow-section-heading">
          <div>
            <h2>{t('工作流歷程', 'Workflow history')}</h2>
            <p>
              {t(
                '最近 20 次工作區執行。選取歷程不會修改目前草稿。',
                'The latest 20 workspace runs. Selecting a run leaves the current draft intact.',
              )}
            </p>
          </div>
          <button
            type="button"
            className="button"
            disabled={loadingHistory || !!busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('重新整理歷程', 'Refresh history')}
          </button>
        </div>
        {historyError && (
          <p className="error-message" role="alert">
            {errorLabel(new Error(historyError), t)}
          </p>
        )}
        {loadingHistory && <p role="status">{t('載入歷程…', 'Loading history…')}</p>}
        {!loadingHistory && !historyError && !runs.length && (
          <p className="agent-empty">
            {t(
              '尚無已保存工作流。輸入候選與限制後即可開始。',
              'No saved workflows yet. Enter candidates and constraints to begin.',
            )}
          </p>
        )}
        <div className="agent-proposal-list">
          {runs.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={!!busy}
              className={run?.id === item.id ? 'selected' : ''}
              aria-pressed={run?.id === item.id}
              onClick={() => openRun(item.id)}
            >
              <span>
                <strong>
                  {item.target_weights.map((target) => target.symbol).join(' · ') ||
                    t('沒有可用目標', 'No eligible targets')}
                </strong>
                <small>
                  {dateTime(item.created_at)} · {item.as_of} ·{' '}
                  {item.scope === 'market' ? t('市場', 'Market') : t('持股清單', 'Holdings list')}
                </small>
              </span>
              <span className="agent-status">
                {item.status === 'blocked' ? t('受阻', 'Blocked') : t('已產生提案', 'Proposed')}
                {!item.current && ` · ${t('來源已過期', 'Stale source')}`}
              </span>
            </button>
          ))}
        </div>
      </section>

      {error && (
        <p className="error-message" role="alert">
          {errorLabel(new Error(error), t)}
        </p>
      )}
      {busy === 'detail' && (
        <p role="status">{t('載入工作流明細…', 'Loading workflow details…')}</p>
      )}
      {run && (
        <>
          <RunDetails run={run} t={t} />
          <ResearchEvidenceNavigation
            collapsible
            workspaceRef={evidenceWorkspace}
            scopeKey={`${account.id}:${run.id}`}
            tools={[
              { targetId: evidenceTarget('comparison'), label: t('保存版本', 'Saved versions') },
              { targetId: evidenceTarget('rules'), label: t('單項規則', 'Rule evidence') },
              { targetId: evidenceTarget('path'), label: t('投組路徑', 'Portfolio path') },
              { targetId: evidenceTarget('costs'), label: t('成本情境', 'Cost scenarios') },
              { targetId: evidenceTarget('segments'), label: t('時間分段', 'Time segments') },
              { targetId: evidenceTarget('attribution'), label: t('損益歸屬', 'P&L attribution') },
              {
                targetId: evidenceTarget('receipt-comparison'),
                label: t('路徑回條比較', 'Path receipt comparison'),
              },
              {
                targetId: evidenceTarget('trial-inventory'),
                label: t('保存試驗清單', 'Saved trial inventory'),
              },
              { targetId: evidenceTarget('cscv'), label: t('試驗集排序', 'Trial-set ranks') },
              { targetId: evidenceTarget('drawdowns'), label: t('回撤歷程', 'Drawdown episodes') },
              { targetId: evidenceTarget('monthly'), label: t('月報酬', 'Monthly returns') },
              { targetId: evidenceTarget('rolling'), label: t('滾動期間', 'Rolling windows') },
              {
                targetId: evidenceTarget('path-archive'),
                label: t('路徑回條封存', 'Path receipt archive'),
              },
              {
                targetId: evidenceTarget('allocation'),
                label: t('配置與回條', 'Allocation and receipts'),
              },
            ]}
            t={t}
          />
          <ResearchEvidenceSection
            id={evidenceTarget('comparison')}
            title={t('保存版本', 'Saved versions')}
          >
            <SavedWorkflowComparison
              key={JSON.stringify([account.id, run.id, refresh])}
              run={run}
              history={runs}
              t={t}
            />
          </ResearchEvidenceSection>
          <AllocationComparison
            key={JSON.stringify([
              run.id,
              account.version,
              policyVersion,
              run.input_revision,
              run.current,
              refresh,
            ])}
            run={run}
            lookback={draft.constraints.volatility_lookback_sessions}
            t={t}
          />
          <ResearchEvidenceSection
            id={evidenceTarget('rules')}
            title={t('單項規則', 'Rule evidence')}
          >
            <WorkflowValidation
              key={JSON.stringify(['rule-validation', account.id, run.id])}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('path')}
            title={t('投組路徑', 'Portfolio path')}
          >
            <WorkflowPathValidation
              key={JSON.stringify(['path-validation', account.id, run.id])}
              account={account}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('costs')}
            title={t('成本情境', 'Cost scenarios')}
          >
            <WorkflowPathCosts
              key={JSON.stringify(['path-costs', account.id, run.id])}
              account={account}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('segments')}
            title={t('時間分段', 'Time segments')}
          >
            <WorkflowPathSegments
              key={JSON.stringify(['path-segments', account.id, run.id])}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('attribution')}
            title={t('損益歸屬', 'P&L attribution')}
          >
            <WorkflowPathAttribution
              key={JSON.stringify(['path-attribution', account.id, run.id])}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('receipt-comparison')}
            title={t('路徑回條比較', 'Path receipt comparison')}
          >
            <WorkflowPathReceiptComparison
              accountId={account.id}
              accountVersion={account.version}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('trial-inventory')}
            title={t('保存試驗清單', 'Saved trial inventory')}
          >
            <WorkflowPathTrialInventory
              accountId={account.id}
              accountVersion={account.version}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('cscv')}
            title={t('試驗集排序', 'Trial-set ranks')}
          >
            <WorkflowPathCSCV accountId={account.id} accountVersion={account.version} t={t} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('drawdowns')}
            title={t('回撤歷程', 'Drawdown episodes')}
          >
            <WorkflowPathDrawdowns accountId={account.id} accountVersion={account.version} t={t} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('monthly')}
            title={t('月報酬', 'Monthly returns')}
          >
            <WorkflowPathMonthly accountId={account.id} accountVersion={account.version} t={t} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('rolling')}
            title={t('滾動期間', 'Rolling windows')}
          >
            <WorkflowPathRolling accountId={account.id} accountVersion={account.version} t={t} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('path-archive')}
            title={t('路徑回條封存', 'Path receipt archive')}
          >
            <WorkflowPathReceiptArchive
              accountId={account.id}
              accountVersion={account.version}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={evidenceTarget('allocation')}
            title={t('配置與回條', 'Allocation and receipts')}
          >
            <AllocationResearch
              key={JSON.stringify([run.id, account.version, policyVersion, refresh])}
              account={account}
              run={run}
              enabled={canBridge}
              t={t}
            />
          </ResearchEvidenceSection>
          <section
            className="agent-panel"
            aria-label={t('接續紙上提案', 'Continue to paper proposal')}
          >
            <h2>{t('接續到紙上帳戶', 'Continue to the paper account')}</h2>
            <p>
              {t('帳戶', 'Account')} <strong>{account.name}</strong> · {t('版本', 'Version')}{' '}
              {account.version}
            </p>
            <p>
              {t(
                '這是完整目標組合：未列入的既有虛擬持倉目標為 0%。先核對調倉明細，再保存提案；保存不會成交。',
                'These targets replace the full portfolio: omitted paper holdings target 0%. Review the changes before saving a proposal. Saving does not execute it.',
              )}
            </p>
            {changedDraft && (
              <p className="notice">
                {t(
                  '目前表單有尚未套用的設定。以下接續的是已保存工作流的目標，並非表單草稿。',
                  'The form contains unapplied settings. This bridge uses the saved workflow targets, not the form draft.',
                )}
              </p>
            )}
            {!policyBindingCurrent && (
              <p className="notice">
                {t(
                  '此工作流綁定另一帳戶或舊版標的政策，請在此帳戶重新產生工作流。',
                  'This workflow is bound to another account or an older symbol policy. Create a fresh workflow for this account.',
                )}
              </p>
            )}
            {!runChecked && !runCheckError && (
              <p role="status">
                {t('正在核對這筆工作流的來源…', 'Checking this workflow’s current source…')}
              </p>
            )}
            {runCheckError && (
              <p className="error-message" role="alert">
                {runCheckError}{' '}
                <button className="text-button" onClick={() => setRefresh((value) => value + 1)}>
                  {t('重新核對工作流', 'Recheck workflow')}
                </button>
              </p>
            )}
            {runChecked && !canBridge && !runCheckError && (
              <p className="notice">
                {t(
                  '此工作流受阻或來源已過期，請重新產生工作流。歷程保留供檢閱。',
                  'This workflow is blocked or stale. Create a fresh workflow; the saved history remains available for review.',
                )}
              </p>
            )}
            {account.kill_switch && (
              <p className="notice">
                {t(
                  '帳戶目前暫停模擬執行，紙上驗算仍會顯示限制與原因。',
                  'Paper execution is paused. The preview will still show limits and reasons.',
                )}
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={!!busy || !canBridge}
                onClick={() => paperBridge(false)}
              >
                {busy === 'preview'
                  ? t('驗算中…', 'Checking…')
                  : t('預覽紙上調倉', 'Preview paper rebalance')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!!busy || !currentPreview || !!currentSaved}
                onClick={() => paperBridge(true)}
              >
                {busy === 'save'
                  ? t('保存中…', 'Saving…')
                  : t('保存紙上提案並檢閱', 'Save paper proposal and review')}
              </button>
            </div>
            {bridge && !currentPreview && (
              <p className="notice">
                {t(
                  '帳戶版本或工作流來源已改變，請重新預覽。',
                  'The account version or workflow source changed. Preview again.',
                )}
              </p>
            )}
            {currentPreview && <BridgePreview preview={currentPreview} t={t} />}
            {currentSaved && (
              <p role="status">
                {t('紙上提案已保存，尚未執行。', 'Paper proposal saved; it has not been executed.')}{' '}
                <code>{currentSaved.id}</code>
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

const METHOD_LABELS: Record<AllocationMethod, [string, string]> = {
  equal: ['等權席位', 'Equal slots'],
  inverse_volatility: ['反波動（1/σ）', 'Inverse volatility (1/σ)'],
  score_tilt: ['分數傾斜（分數 × 1/σ）', 'Score tilt (score × 1/σ)'],
}
const ALLOCATOR_REASONS: Record<string, [string, string]> = {
  history_incomplete: ['回看窗口內缺少調整收盤日線', 'Adjusted closes missing inside the lookback'],
  calendar_unavailable: ['無法取得回看交易日曆', 'Lookback calendar unavailable'],
  invalid_price: ['回看窗口內有無效價格', 'Invalid price inside the lookback'],
  zero_volatility: ['波動為零', 'Zero volatility'],
  nonpositive_score: ['分數傾斜需要正的共識分數', 'Score tilt needs a positive consensus score'],
}
function AllocatorEvidence({ allocator, t }: { allocator: AgentAllocator; t: Translate }) {
  const reason = (code: string, message: string) =>
    ALLOCATOR_REASONS[code] ? t(...ALLOCATOR_REASONS[code]) : t(message, code)
  return (
    <section
      className="workflow-allocator"
      aria-label={t('風險感知配置證據', 'Risk-aware allocation evidence')}
    >
      <h3>
        {t('風險感知配置', 'Risk-aware allocation')} · {t(...METHOD_LABELS[allocator.method])}{' '}
        <small>{allocator.engine_version}</small>
      </h3>
      <p>
        {t('回看交易日', 'Lookback sessions')} {allocator.lookback_sessions ?? '—'} ·{' '}
        {t('總投入', 'Invested budget')} {percent(allocator.invested_budget_pct)} ·{' '}
        {t('因單檔上限留現金', 'Capped excess kept in cash')}{' '}
        {percent(allocator.capped_to_cash_pct)}
      </p>
      {allocator.status === 'unavailable' && (
        <p className="error-message" role="alert">
          {t(
            '波動率不可用，整個配置不產生目標、不回退等權：',
            'Volatility unavailable, so no targets were produced and nothing fell back to equal slots: ',
          )}
          {allocator.unavailable
            .map((item) => `${item.symbol}（${reason(item.code, item.message)}）`)
            .join('、')}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('標的', 'Symbol')}</th>
              <th>{t('共識分數', 'Consensus')}</th>
              <th>{t('年化 σ', 'Annualised σ')}</th>
              <th>{t('原始權重', 'Raw weight')}</th>
              <th>{t('上限後權重', 'Capped weight')}</th>
              <th>{t('原因', 'Reason')}</th>
            </tr>
          </thead>
          <tbody>
            {allocator.per_symbol.map((row) => (
              <tr key={row.symbol}>
                <td>
                  <strong>{row.symbol}</strong>
                </td>
                <td>{num(row.score, 2)}</td>
                <td>{percent(row.sigma_annualized_pct)}</td>
                <td>{percent(row.raw_weight_pct)}</td>
                <td>{percent(row.capped_weight_pct)}</td>
                <td>{row.reason ? reason(row.reason.code, row.reason.message) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AllocationComparison({
  run,
  lookback,
  t,
}: {
  run: AgentRun
  lookback: string | number | undefined
  t: Translate
}) {
  const [result, setResult] = useState<AgentAllocationComparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  const requested = Number(lookback ?? 60)
  const lookbackValid = Number.isInteger(requested) && requested >= 20 && requested <= 120
  const selected = run.candidates.some((candidate) => candidate.status === 'selected')
  if (!selected) return null
  function compare() {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    api<AgentAllocationComparison>(
      `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/allocations`,
      {
        method: 'POST',
        body: JSON.stringify(lookbackValid ? { volatility_lookback_sessions: requested } : {}),
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted) return
        if (value.agent_run_id !== run.id)
          throw new Error(
            t(
              '配置比較的工作流識別不符，請重新比較。',
              'The comparison workflow identity does not match. Compare again.',
            ),
          )
        setResult(value)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorLabel(err, t))
      })
      .finally(() => {
        if (operation.current === controller) operation.current = null
        if (!controller.signal.aborted) setBusy(false)
      })
  }
  function download() {
    if (!result || operation.current) return
    try {
      downloadAllocationComparisonCsv(result)
    } catch (err) {
      setError(errorLabel(err, t))
    }
  }
  const symbols = result
    ? Array.from(
        new Set(
          ALLOCATION_METHODS.flatMap((method) =>
            result.methods[method].allocator.per_symbol.map((row) => row.symbol),
          ),
        ),
      )
    : []
  const sigma = (symbol: string) =>
    ALLOCATION_METHODS.map(
      (method) =>
        result?.methods[method].allocator.per_symbol.find((row) => row.symbol === symbol)
          ?.sigma_annualized_pct ?? null,
    ).find((value) => value != null) ?? null
  const cell = (method: AllocationMethod, symbol: string) => {
    const block = result!.methods[method]
    if (block.status === 'applied') {
      const target = block.targets.find((row) => row.symbol === symbol)
      return target ? percent(target.weight_pct) : '—'
    }
    const row = block.allocator.per_symbol.find((item) => item.symbol === symbol)
    return row?.reason ? row.reason.code : t('不可用', 'Unavailable')
  }
  return (
    <section
      className="agent-panel workflow-allocation-comparison"
      aria-label={t('配置方法比較', 'Allocation method comparison')}
    >
      <div className="section-heading">
        <div>
          <h3>{t('比較三種配置', 'Compare the three allocation methods')}</h3>
          <p>
            {t(
              '以目前本機日線重算同一批入選標的在等權、反波動、分數傾斜下的權重。這是假設情境，不是保存工作流當時的證據；只有工作流本身的方法能接續紙上提案。',
              'Re-splits the same selected symbols under equal, inverse-volatility and score-tilt on current local bars. A what-if, not the saved evidence; only the workflow’s own method can continue to a paper proposal.',
            )}
          </p>
        </div>
        <button type="button" className="button" disabled={busy} onClick={compare}>
          {busy ? t('比較中…', 'Comparing…') : t('比較三種配置', 'Compare the three methods')}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="agent-report-meta">
            {t('回看交易日', 'Lookback sessions')} {result.lookback_sessions} ·{' '}
            {t('工作流採用', 'Workflow uses')} {t(...METHOD_LABELS[result.run_method])} ·{' '}
            {result.as_of} · {result.engine_version}
          </p>
          <button type="button" className="button" disabled={busy} onClick={download}>
            {t('下載配置比較 CSV', 'Download allocation comparison CSV')}
          </button>
          <p className="research-note">
            {t(
              'CSV 保存畫面上的比較結果、輸入版本與不可用原因；修改回看草稿不會重算已顯示的結果。這不是交易指令或保存工作流當時的證據。',
              'The CSV keeps the displayed comparison, input revision and unavailable reasons. Editing the lookback draft does not recalculate the displayed result. This is not a trade instruction or the saved workflow evidence.',
            )}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('標的', 'Symbol')}</th>
                  <th scope="col">{t('年化波動 σ', 'Annualised σ')}</th>
                  {ALLOCATION_METHODS.map((method) => (
                    <th scope="col" key={method}>
                      {t(...METHOD_LABELS[method])}
                      {method === result.run_method ? ` (${t('工作流', 'workflow')})` : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbols.map((symbol) => (
                  <tr key={symbol}>
                    <th scope="row">{symbol}</th>
                    <td>{percent(sigma(symbol))}</td>
                    {ALLOCATION_METHODS.map((method) => (
                      <td key={method}>{cell(method, symbol)}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th scope="row">{t('現金（含上限超出）', 'Cash (incl. capped excess)')}</th>
                  <td>—</td>
                  {ALLOCATION_METHODS.map((method) => (
                    <td key={method}>{percent(result.methods[method].cash_weight_pct)}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t('狀態', 'Status')}</th>
                  <td>—</td>
                  {ALLOCATION_METHODS.map((method) => (
                    <td key={method}>
                      {result.methods[method].status === 'applied'
                        ? t('可計算', 'Available')
                        : `${t('不可用', 'Unavailable')}: ${result.methods[
                            method
                          ].allocator.unavailable
                            .map((item) => `${item.symbol} ${item.code}`)
                            .join(', ')}`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <details className="agent-method">
            <summary>{t('這不是什麼', 'What this is not')}</summary>
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p>{result.method}</p>
          </details>
        </>
      )}
    </section>
  )
}

function RunDetails({ run, t }: { run: AgentRun; t: Translate }) {
  const stepEnglish: Record<AgentRun['steps'][number]['role'], string> = {
    research_analyst:
      'Verifies scan provenance, current prices, enabled signals and fixed-weight consensus.',
    allocation_planner:
      run.allocator && run.allocator.method !== 'equal'
        ? 'Splits the same invested total by the risk-aware method after ranking; caps and the cash buffer are unchanged and capped excess stays in cash.'
        : 'Fills fixed allocation slots by rank. Unfilled slots remain cash.',
    risk_reviewer:
      'Checks position caps, cash, complete evidence and no leverage. The paper account is validated separately.',
    proposal:
      run.status === 'proposed'
        ? 'Saves traceable targets for review before the paper rebalance.'
        : 'Stops proposal creation because the source or allocation is incomplete.',
  }
  const checkLabels: Record<string, [string, string]> = {
    position_count: ['持倉數上限', 'Position count limit'],
    position_weight: ['單檔權重上限', 'Position weight limit'],
    cash_buffer: ['現金緩衝', 'Cash buffer'],
    long_only_unlevered: ['僅做多、無槓桿', 'Long-only, no leverage'],
    complete_selected_evidence: ['入選證據完整', 'Complete selected evidence'],
  }
  return (
    <section className="agent-panel" aria-label={t('已保存工作流明細', 'Saved workflow details')}>
      <div className="workflow-section-heading">
        <h2>{t('已保存工作流', 'Saved workflow')}</h2>
        <span
          className={`agent-verdict ${run.status === 'proposed' && run.current !== false ? 'allowed' : 'blocked'}`}
        >
          {run.status === 'blocked'
            ? t('工作流受阻', 'Workflow blocked')
            : run.current === false
              ? t('來源已過期', 'Stale source')
              : t('目標已產生', 'Targets proposed')}
        </span>
      </div>
      <p>
        {run.as_of} · {dateTime(run.created_at)} ·{' '}
        {t('本機規則，非語言模型', 'Local rules, not a language model')}
      </p>
      {run.current === false && (
        <p className="notice">
          {t('此歷程不能接續紙上提案：', 'This history cannot create a paper proposal: ')}
          {(run.stale_reasons || []).map((reason) => staleLabel(reason, t)).join(' · ')}
        </p>
      )}
      {run.blocking_reasons.length > 0 && (
        <ul className="agent-reasons">
          {run.blocking_reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>{reasonLabel(reason, t)}</li>
          ))}
        </ul>
      )}
      <div className="agent-preview-stats">
        <span>
          {t('候選', 'Candidates')} <strong>{run.coverage.requested}</strong>
        </span>
        <span>
          {t('可計分', 'Scorable')}{' '}
          <strong>
            {run.coverage.complete}/{run.coverage.requested}
          </strong>
        </span>
        <span>
          {t('符合條件', 'Eligible')} <strong>{run.coverage.eligible}</strong>
        </span>
        <span>
          {t('已選入', 'Selected')} <strong>{run.coverage.selected}</strong>
        </span>
        <span>
          {t('目標現金', 'Target cash')} <strong>{percent(run.cash_weight_pct)}</strong>
        </span>
      </div>
      <ol className="workflow-trace">
        {run.steps.map((step, index) => (
          <li key={step.role} className={step.status === 'blocked' ? 'is-blocked' : ''}>
            <div className="workflow-step-title">
              <span className="workflow-step-number">{index + 1}</span>
              <strong>{roleLabel(step.role, t)}</strong>
              <span>
                {step.status === 'completed' ? t('完成', 'Complete') : t('受阻', 'Blocked')}
              </span>
            </div>
            <p>{t(step.summary, stepEnglish[step.role])}</p>
            <details className="agent-method">
              <summary>{t('角色證據', 'Role evidence')}</summary>
              <pre className="workflow-json">{JSON.stringify(step.evidence, null, 2)}</pre>
              <small>{step.engine_version}</small>
            </details>
          </li>
        ))}
      </ol>
      <h3>{t('目標配置', 'Target allocation')}</h3>
      {run.target_weights.length ? (
        <div className="workflow-targets">
          {run.target_weights.map((target) => (
            <span key={target.symbol}>
              <strong>{target.symbol}</strong>
              {percent(target.weight_pct)}
            </span>
          ))}
        </div>
      ) : (
        <p>
          {t(
            '沒有產生配置；不代表將持倉清空。',
            'No allocation was produced; this does not mean liquidating holdings.',
          )}
        </p>
      )}
      <p>
        {t('每個配置席位', 'Allocation per slot')} {percent(run.allocation.slot_weight_pct)} ·{' '}
        {t('保留空席', 'Unused slots')} {run.allocation.unused_slots}
      </p>
      {run.allocator && run.allocator.method !== 'equal' && (
        <AllocatorEvidence allocator={run.allocator} t={t} />
      )}
      <h3>{t('候選與原因', 'Candidates and reasons')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('標的', 'Symbol')}</th>
              <th>{t('狀態', 'Status')}</th>
              <th>{t('共識分數', 'Consensus')}</th>
              <th>{t('策略覆蓋', 'Signal coverage')}</th>
              <th>{t('符合數', 'Matches')}</th>
              <th>{t('價格日期', 'Price date')}</th>
              <th>{t('原因與證據', 'Reasons and evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {run.candidates.map((candidate) => (
              <tr key={candidate.symbol}>
                <td>
                  <strong>{candidate.symbol}</strong>
                </td>
                <td>{candidateLabel(candidate.status, t)}</td>
                <td>{num(candidate.score, 2)}</td>
                <td>{percent(candidate.coverage_pct)}</td>
                <td>{candidate.matched_count}</td>
                <td>{candidate.evidence.quote_date || '—'}</td>
                <td className="workflow-reason-cell">
                  {candidate.reasons.map((reason, index) => (
                    <p key={`${reason.code}-${index}`}>{reasonLabel(reason, t)}</p>
                  ))}
                  <details>
                    <summary>{t('策略明細', 'Strategy details')}</summary>
                    <ul>
                      {candidate.contributions.map((contribution) => (
                        <li key={contribution.strategy}>
                          <strong>{strategyLabel(contribution.strategy, t)}</strong> ·{' '}
                          {percent(contribution.weight)} ·{' '}
                          {contribution.enabled
                            ? contribution.available
                              ? contribution.matched
                                ? t('符合', 'Matched')
                                : t('未符合', 'Not matched')
                              : t('不可用', 'Unavailable')
                            : t('停用', 'Disabled')}{' '}
                          · {t('計分', 'Points')} {num(contribution.points, 2)}
                        </li>
                      ))}
                    </ul>
                    <p>
                      {t('未調整參考收盤價', 'Unadjusted reference close')}{' '}
                      {money(candidate.evidence.reference_close)}
                    </p>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{t('配置規則檢查', 'Allocation rule checks')}</h3>
      <ul className="workflow-checks">
        {run.risk_checks.map((check) => (
          <li key={check.code}>
            <span>{checkLabels[check.code] ? t(...checkLabels[check.code]) : check.code}</span>
            <strong>{check.passed ? t('通過', 'Passed') : t('受阻', 'Blocked')}</strong>
            <span>
              {t('觀測值', 'Observed')} {num(check.observed, 2)} · {t('門檻', 'Limit')}{' '}
              {num(check.limit, 2)}
            </span>
          </li>
        ))}
      </ul>
      <details className="agent-method">
        <summary>{t('方法、保存設定與來源版本', 'Method, saved settings and provenance')}</summary>
        <p>
          {t(
            '只採當期且來源有效的選股快照。所有啟用策略都須有可用訊號，權重不重分配。依共識分數、符合數及代碼排序，每檔取得固定席位配置，空席保留現金。Alpha 分數不是預期報酬，配置風險檢查也不是未來損失預測。',
            run.method,
          )}
        </p>
        <p>
          {t(
            '單檔配置 = min((100 − 現金緩衝) ÷ 最多持倉數，單檔上限)，向下取至 8 位小數。',
            'Allocation per slot = min((100 − cash buffer) / maximum positions, position cap), rounded down to 8 decimal places.',
          )}
        </p>
        <p>
          {t(
            '以下是這次已保存執行的設定與來源，與目前表單草稿分開。',
            'The following settings and provenance belong to this saved run, independently of the current form draft.',
          )}
        </p>
        <pre className="workflow-json">
          {JSON.stringify(
            {
              request: run.request,
              scan: run.scan,
              input_revision: run.input_revision,
              proposal_fingerprint: run.proposal_fingerprint,
            },
            null,
            2,
          )}
        </pre>
        <small>
          {run.engine_version} · {run.id}
        </small>
      </details>
    </section>
  )
}

function BridgePreview({ preview, t }: { preview: PaperPreview; t: Translate }) {
  const hasCosts =
    !!preview.execution_policy || preview.orders.some((order) => order.fill_price != null)
  return (
    <div className="agent-preview">
      <div className={`agent-verdict ${preview.executable ? 'allowed' : 'blocked'}`}>
        {preview.executable
          ? t('紙上帳戶驗算通過', 'Paper account checks passed')
          : t(
              '紙上提案受阻，保存後仍不能執行',
              'Paper proposal blocked; saving will not make it executable',
            )}
      </div>
      <div className="agent-preview-stats">
        <span>
          {t('預計現金', 'Projected cash')} <strong>{money(preview.cash_after)}</strong>
        </span>
        <span>
          {t('總換手', 'Gross turnover')} <strong>{percent(preview.turnover_pct)}</strong>
        </span>
        {hasCosts && (
          <>
            <span>
              {t('估計費用', 'Estimated fees')} <strong>{money(preview.fees_total)}</strong>
            </span>
            <span>
              {t('估計滑價', 'Estimated slippage')} <strong>{money(preview.slippage_total)}</strong>
            </span>
          </>
        )}
        <span>
          {t('價格覆蓋', 'Price coverage')}{' '}
          <strong>
            {preview.coverage.priced}/{preview.coverage.required}
          </strong>
        </span>
      </div>
      {preview.violations.length > 0 && (
        <ul className="agent-reasons">
          {preview.violations.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>
              {reason.symbol && <strong>{reason.symbol} </strong>}
              {reasonLabel(reason, t)}
            </li>
          ))}
        </ul>
      )}
      {preview.orders.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('標的', 'Symbol')}</th>
                <th>{t('紙上變動', 'Paper change')}</th>
                <th>{t('股數', 'Shares')}</th>
                <th>{t('參考收盤價', 'Reference close')}</th>
                {hasCosts && <th>{t('模擬成交價', 'Simulated fill price')}</th>}
                <th>{t('名目金額', 'Notional')}</th>
                {hasCosts && <th>{t('費用', 'Fee')}</th>}
              </tr>
            </thead>
            <tbody>
              {preview.orders.map((order) => (
                <tr key={order.symbol}>
                  <td>
                    <strong>{order.symbol}</strong>
                  </td>
                  <td>{order.side === 'buy' ? t('增加', 'Increase') : t('減少', 'Decrease')}</td>
                  <td>{num(order.shares, 6)}</td>
                  <td>{money(order.reference_price)}</td>
                  {hasCosts && <td>{money(order.fill_price)}</td>}
                  <td>{money(order.notional)}</td>
                  {hasCosts && <td>{money(order.fee)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t('沒有可列出的紙上股數變動。', 'No paper share changes are available.')}</p>
      )}
      {!!preview.skipped_orders?.length && (
        <div>
          <h3>{t('保留原持倉的標的', 'Positions kept unchanged')}</h3>
          <ul className="agent-reasons">
            {preview.skipped_orders.map((order) => (
              <li key={order.symbol}>
                <strong>{order.symbol}</strong> ·{' '}
                {order.reason === 'min_trade_notional'
                  ? t('低於最小交易金額', 'Below the minimum trade amount')
                  : t('低於設定的股數或金額精度', 'Below the configured share or amount precision')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        {t(
          '保存後，仍需到提案明細明確接受才會更新虛擬帳本。紙上情境以參考收盤價與帳戶執行政策計算，沒有公司行動處理，並非實際成交。',
          'After saving, explicit acceptance in proposal review is required to update the virtual ledger. This paper scenario uses reference closes and the account execution policy, has no corporate-action handling, and is not an actual fill.',
        )}
      </p>
      <small>
        {preview.engine_version} · {preview.as_of}
      </small>
    </div>
  )
}
