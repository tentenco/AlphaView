import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import type { AgentRun, AgentRunSummary, AgentWorkflowInput } from './portfolio-agent-model'
import { api, dateTime, num } from './ui'
import { useSessionState } from './session-state'
import {
  RebalanceTriggerEditor,
  RebalanceTriggerFields,
  RebalanceTriggerTrace,
} from './PortfolioRebalanceTrigger'
import { isTriggerDraft, parseTrigger, triggerDraft } from './rebalance-trigger'
import type { RebalanceTrigger, TriggerEvidence } from './rebalance-trigger'

type OutcomeGuard = {
  engine_version: string
  as_of: string
  status: 'low' | 'ok' | 'insufficient' | 'unavailable'
  manual_review: boolean
  downgraded: boolean
  requested_mode: 'proposal_only' | 'auto_simulate'
  effective_mode: 'proposal_only' | 'auto_simulate'
  relevant_families: string[]
  low_families: string[]
  horizon_sessions: number
  window_sessions: number
  required_settled: number
  low_threshold: number
  flags: { family: string; n_settled: number | null; hit_rate: number | null; status: string }[]
}
type Attempt = {
  id: string
  session_date: string
  mandate_version: number
  account_version: number
  status: string
  mode: 'proposal_only' | 'auto_simulate'
  trigger_kind: string
  started_at: string
  finished_at: string | null
  run_id: string
  paper_proposal_id: string | null
  reason: string | null
  result: { rebalance_trigger?: TriggerEvidence; outcome_guard?: OutcomeGuard } | null
}
type Mandate = {
  id: string
  name: string
  account_id: string
  account_name: string
  workflow: AgentWorkflowInput
  candidate_source?: 'explicit' | 'scan_pool'
  selector_limit?: number
  enabled: boolean
  mode: 'proposal_only' | 'auto_simulate'
  execution_target?: 'paper_ledger' | 'alpaca_paper'
  jev_gate?: { enabled: boolean; pass_threshold: number; max_risk_probability: number }
  expires_on?: string | null
  sessions_remaining?: number | null
  reauth_required?: boolean
  reauth_reason?: string | null
  lifecycle?: 'active' | 'expiring_soon' | 'expired' | 'reauth_required' | 'inactive'
  lifecycle_message?: string | null
  version: number
  status: string
  reason: string | null
  latest_eligible_session: string
  next_due_at: string | null
  last_checked_at: string | null
  last_attempt: Attempt | null
  current_attempt: Attempt | null
  rebalance_trigger?: RebalanceTrigger
  symbol_policy_authorization?: {
    status: 'current' | 'stale'
    authorized_policy_version: number
    current_policy: { engine_version: string; version: number; mode: string; symbols: string[] }
    reason: string | null
  }
}
type AutomationState = {
  engine_version: string
  as_of: string
  input_revision: string
  mandates: Mandate[]
  poll_interval_seconds: number
  method: string
  warnings: string[]
}
type Translate = (zh: string, en: string) => string
const LIFECYCLE: Record<string, [string, string]> = {
  active: ['授權有效', 'Authorized'],
  expiring_soon: ['授權即將到期', 'Expiring soon'],
  expired: ['授權已到期', 'Expired'],
  reauth_required: ['需重新授權', 'Re-authorization required'],
  inactive: ['排程未啟用', 'Schedule off'],
}
function lifecycleLabel(value: string | undefined, t: Translate) {
  return value && LIFECYCLE[value]
    ? t(...LIFECYCLE[value])
    : t('授權狀態未知', 'Authorization unknown')
}
function lifecycleTag(mandate: Mandate, t: Translate) {
  return mandate.lifecycle && mandate.lifecycle !== 'active' && mandate.lifecycle !== 'inactive'
    ? ` · ${lifecycleLabel(mandate.lifecycle, t)}`
    : ''
}
function statusLabel(value: string, t: Translate) {
  const labels: Record<string, [string, string]> = {
    disabled: ['尚未啟用', 'Disabled'],
    paused: ['帳戶已暫停', 'Account paused'],
    pending: ['等待下一次檢查', 'Waiting for next check'],
    waiting: ['等待完整資料', 'Waiting for complete data'],
    blocked: ['本輪被限制阻塞', 'Blocked this session'],
    proposed: ['已產生提案', 'Proposal created'],
    proposal_created: ['已產生提案', 'Proposal created'],
    simulated: ['已自動模擬', 'Paper simulation complete'],
    submitted: ['已送出 Alpaca Paper 委託，待核對', 'Sent to Alpaca Paper; reconcile pending'],
    interrupted: ['已中斷，保留紀錄', 'Interrupted; records retained'],
    failed: ['本輪失敗', 'Attempt failed'],
    running: ['執行中', 'Running'],
    claimed: ['已取得本輪執行權', 'Session claimed'],
    already_attempted: ['本交易日已執行', 'Already attempted this session'],
    skipped: ['本交易日略過', 'Skipped this session'],
  }
  return labels[value] ? t(...labels[value]) : value
}

function OutcomeGuardTrace({ evidence, t }: { evidence: OutcomeGuard; t: Translate }) {
  const label =
    evidence.status === 'unavailable'
      ? t('結果證據無法評估', 'Outcome evidence unavailable')
      : evidence.status === 'low'
        ? t('相關來源家族命中率偏低', 'Relevant source family has a low hit rate')
        : evidence.status === 'insufficient'
          ? t('已結算樣本不足', 'Insufficient settled samples')
          : t('未觸發結果降級', 'Outcome downgrade not triggered')
  return (
    <details className="agent-method" open={evidence.manual_review}>
      <summary>
        {t('結果證據', 'Outcome evidence')} · {label}
      </summary>
      {evidence.manual_review ? (
        <p className="notice">
          {t(
            '本輪改為人工審閱；其餘檢查通過後才保存提案，不自動模擬或送出 Alpaca Paper 委託。任務模式與授權保持原設定；下一交易日重新評估。',
            'This attempt requires manual review. A proposal is saved only after all other checks pass; it cannot simulate automatically or submit Alpaca Paper orders. The saved task mode and authorization remain in effect, with a new evaluation next session.',
          )}
        </p>
      ) : evidence.status === 'insufficient' ? (
        <p>
          {t(
            '樣本不足不會單獨觸發降級；其他風險檢查仍須通過。',
            'Insufficient samples alone do not downgrade the attempt; all other risk checks still apply.',
          )}
        </p>
      ) : null}
      {evidence.status === 'unavailable' && (
        <p>
          {t(
            '命中率 —。證據不可用，不能判定為低命中率。',
            'Hit rate —. Unavailable evidence is not classified as a low hit rate.',
          )}
        </p>
      )}
      <p>
        {t('凍結於交易日', 'Frozen for session')} {evidence.as_of} · {t('結算期', 'Horizon')}{' '}
        {evidence.horizon_sessions} {t('個交易日', 'sessions')} · {t('回看', 'Lookback')}{' '}
        {evidence.window_sessions} {t('個交易日', 'sessions')}。{t('至少', 'At least')}{' '}
        {evidence.required_settled} {t('筆已結算，命中率低於', 'settled; hit rate below')}{' '}
        {num(evidence.low_threshold * 100, 0)}% {t('時要求審閱。', 'requires review.')}
      </p>
      {evidence.flags
        .filter((flag) => evidence.relevant_families.includes(flag.family))
        .map((flag) => (
          <p key={flag.family}>
            {flag.family === 'agent_targets'
              ? t('規則工作流目標變動', 'Rule-workflow target changes')
              : flag.family === 'jev_gate'
                ? t('Jev 決策閘', 'Jev decision gate')
                : flag.family}{' '}
            · {t('已結算', 'Settled')}{' '}
            {typeof flag.n_settled === 'number' && Number.isFinite(flag.n_settled)
              ? flag.n_settled
              : '—'}{' '}
            · {t('命中率', 'Hit rate')}{' '}
            {typeof flag.hit_rate === 'number' && Number.isFinite(flag.hit_rate)
              ? `${num(flag.hit_rate * 100, 1)}%`
              : '—'}
          </p>
        ))}
      <p>
        {t(
          '統計涵蓋工作區來源家族，不代表個別策略、模型或此任務的績效，也不是投資建議。',
          'These statistics cover source families across the workspace, not an individual strategy, model, or task. They are not investment advice.',
        )}
      </p>
      <small>{evidence.engine_version}</small>
    </details>
  )
}

export function PortfolioAutomation({
  account,
  locale,
  onAccountChanged,
  selectedMandateId,
  selectionNonce,
}: {
  account: PaperAccount
  locale: Locale
  onAccountChanged: () => void
  selectedMandateId?: string
  selectionNonce?: number
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [state, setState] = useState<AutomationState | null>(null)
  const [runs, setRuns] = useState<AgentRunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState('')
  const [template, setTemplate] = useState<AgentWorkflowInput | null>(null)
  const [name, setName] = useSessionState(
    `automation-name-${account.id}-v1`,
    () => '',
    (value): value is string => typeof value === 'string' && value.length <= 80,
  )
  const [mode, setMode] = useState<Mandate['mode']>('proposal_only')
  const [executionTarget, setExecutionTarget] = useState<'paper_ledger' | 'alpaca_paper'>(
    'paper_ledger',
  )
  const [jevGate, setJevGate] = useState({ enabled: false, pass: '0.70', risk: '0.50' })
  const [expiresOn, setExpiresOn] = useState('')
  const jevPass = Number(jevGate.pass)
  const jevRisk = Number(jevGate.risk)
  const jevGateValid =
    !jevGate.enabled ||
    (Number.isFinite(jevPass) &&
      jevPass >= 0.5 &&
      jevPass <= 0.99 &&
      Number.isFinite(jevRisk) &&
      jevRisk >= 0.01 &&
      jevRisk <= 0.5)
  const [candidateSource, setCandidateSource] = useState<'explicit' | 'scan_pool'>('explicit')
  const [allowAuto, setAllowAuto] = useState(false)
  const [trigger, setTrigger] = useSessionState(
    `automation-create-trigger-${account.id}-v1`,
    () => triggerDraft(),
    isTriggerDraft,
  )
  const parsedTrigger = parseTrigger(trigger)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState('')
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const mounted = useRef(true)
  const pendingSelection = useRef(selectedMandateId)
  useEffect(() => {
    pendingSelection.current = selectedMandateId
  }, [selectedMandateId, selectionNonce])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let active = true
    let loading = false
    const controller = new AbortController()
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const value = await api<AutomationState>('/api/agent-automation/state', {
          signal: controller.signal,
        })
        if (!active) return
        setState(value)
        const requested = pendingSelection.current
        if (requested) {
          const found = value.mandates.some(
            (mandate) => mandate.id === requested && mandate.account_id === account.id,
          )
          setSelected(found ? requested : '')
          if (found) pendingSelection.current = undefined
          if (!found)
            setError(
              t(
                '指定任務已不可用，請重新整理待辦。',
                'The requested task is unavailable. Refresh the inbox.',
              ),
            )
          return
        }
        setSelected((current) =>
          value.mandates.some(
            (mandate) => mandate.id === current && mandate.account_id === account.id,
          )
            ? current
            : value.mandates.find((mandate) => mandate.account_id === account.id)?.id || '',
        )
      } catch (err) {
        if (active) setError((err as Error).message)
      } finally {
        loading = false
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 15000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(timer)
    }
  }, [account.id, account.version, refresh, selectedMandateId, selectionNonce])
  useEffect(() => {
    const controller = new AbortController()
    api<{ runs: AgentRunSummary[] }>('/api/portfolio-agent/runs?limit=100', {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setRuns(value.runs)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setTemplate(null)
    if (!selectedRun) return
    api<AgentRun>(`/api/portfolio-agent/runs/${selectedRun}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setTemplate(value.request)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
    return () => controller.abort()
  }, [selectedRun])
  useEffect(() => {
    const controller = new AbortController()
    setAttempts([])
    if (!selected) return
    api<{ attempts: Attempt[] }>(`/api/agent-automation/mandates/${selected}/attempts`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setAttempts(value.attempts)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
    return () => controller.abort()
  }, [
    selected,
    refresh,
    state?.mandates.find((mandate) => mandate.id === selected)?.current_attempt?.status,
  ])
  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (
      !template ||
      !name.trim() ||
      !parsedTrigger ||
      !jevGateValid ||
      busy ||
      (mode === 'auto_simulate' && !allowAuto)
    )
      return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const value = await api<{ mandate: Mandate }>('/api/agent-automation/mandates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          account_id: account.id,
          workflow: {
            ...template,
            ...(candidateSource === 'scan_pool' ? { candidate_symbols: [] } : {}),
            account_context: {
              account_id: account.id,
              expected_policy_version: account.symbol_policy?.version ?? 1,
            },
          },
          candidate_source: candidateSource,
          selector_limit: 100,
          rebalance_trigger: parsedTrigger,
          enabled: false,
          mode,
          execution_target: mode === 'auto_simulate' ? executionTarget : 'paper_ledger',
          ...(expiresOn ? { expires_on: expiresOn } : {}),
          jev_gate: jevGate.enabled
            ? { enabled: true, pass_threshold: jevPass, max_risk_probability: jevRisk }
            : { enabled: false },
        }),
      })
      if (!mounted.current) return
      setSelected(value.mandate.id)
      setCreating(false)
      setName('')
      setExpiresOn('')
      setAllowAuto(false)
      setTrigger(triggerDraft())
      setRefresh((current) => current + 1)
      setNotice(
        t(
          '任務已保存，排程目前關閉。可先手動產生提案，或啟用每日排程。',
          'Task saved with its schedule disabled. Try a manual proposal or enable the daily schedule.',
        ),
      )
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const mandates = state?.mandates.filter((mandate) => mandate.account_id === account.id) || []
  const current = mandates.find((mandate) => mandate.id === selected)
  return (
    <>
      <section className="agent-panel">
        <div className="section-heading">
          <div>
            <div className="eyebrow">LOCAL AUTOMATION / SESSION CADENCE</div>
            <h2>{t('讓組合工作流持續運行', 'Keep the portfolio workflow running')}</h2>
            <p>
              {t(
                '在最新已完成交易日，套用保存的規則與風險限制。每個任務每個交易日最多執行一次，沒有遺漏日期補跑。',
                'Apply saved rules and risk limits to the latest completed session. Each task attempts at most once per session; missed dates are not replayed.',
              )}
            </p>
          </div>
          <button type="button" className="button" onClick={() => setCreating(!creating)}>
            {t('新增自動化任務', 'New automation task')}
          </button>
        </div>
        <div className="agent-preview-stats">
          <span>
            {t('排程檢查間隔', 'Scheduler interval')}{' '}
            <strong>
              {state?.poll_interval_seconds ?? '—'} {t('秒', 'seconds')}
            </strong>
          </span>
          <span>
            {t('適用交易日', 'Eligible session')} <strong>{state?.as_of || '—'}</strong>
          </span>
          <span>
            {t('啟用中', 'Enabled')}{' '}
            <strong>
              {mandates.filter((mandate) => mandate.enabled).length}/{mandates.length}
            </strong>
          </span>
        </div>
        <p className="research-note">
          {t(
            '本機伺服器需持續運行。資料尚未就緒時會等待，不會以過期選股代替，也不會消耗當天的執行機會。行情更新沿用「資料管理」的排程。',
            'The local server must stay running. Incomplete sources wait without substituting old scans or consuming the session attempt. Market refresh remains under Data Management.',
          )}
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setError('')
                setRefresh((value) => value + 1)
              }}
            >
              {t('重新載入', 'Reload')}
            </button>
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {(creating || !mandates.length) && (
          <form className="agent-automation-create" onSubmit={create}>
            <h3>{t('以已保存的工作流建立任務', 'Create a task from a saved workflow')}</h3>
            {!runs.length ? (
              <p>
                {t(
                  '先到「Agent 工作流」產生並保存一次工作流，再把相同規則保存為任務。',
                  'First create a saved run in Agent Workflow, then reuse its rules as an automation task.',
                )}
              </p>
            ) : (
              <>
                <div className="agent-form-grid">
                  <label>
                    {t('任務名稱', 'Task name')}
                    <input
                      value={name}
                      maxLength={80}
                      required
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('規則來源', 'Rules from saved run')}
                    <select
                      value={selectedRun}
                      required
                      onChange={(event) => setSelectedRun(event.target.value)}
                    >
                      <option value="">{t('選擇工作流', 'Select a saved run')}</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {dateTime(run.created_at)} · {run.scope} · {run.coverage.requested}{' '}
                          {t('個候選', 'candidates')} · {run.id.slice(0, 6)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {template && <WorkflowSummary workflow={template} t={t} />}
                <p className="research-note">
                  {t(
                    '新任務將套用此帳戶目前的允許標的政策',
                    'The new task will use this account’s current symbol policy',
                  )}{' '}
                  v{account.symbol_policy?.version ?? 1} ·{' '}
                  {account.symbol_policy?.mode === 'allowlist'
                    ? account.symbol_policy.symbols.join(', ') ||
                      t('不允許新增任何標的', 'No new symbols allowed')
                    : t('未限制標的', 'Unrestricted symbols')}
                </p>
                <label className="agent-field">
                  {t('每日候選來源', 'Daily candidate source')}
                  <select
                    value={candidateSource}
                    onChange={(event) =>
                      setCandidateSource(event.target.value as 'explicit' | 'scan_pool')
                    }
                  >
                    <option value="explicit">
                      {t('追蹤此固定候選清單', 'Track this fixed candidate list')}
                    </option>
                    <option value="scan_pool">
                      {t('每天從最新選股重新挑選', 'Select from the latest scan each day')}
                    </option>
                  </select>
                </label>
                {candidateSource === 'scan_pool' && (
                  <p className="notice">
                    {t(
                      '每天以同一策略權重與門檻檢查當期股票池，最多帶入 100 個合格候選。每次保存實際母體與排除原因；不保留舊日的候選名單。',
                      'Each day applies the same weights and thresholds to the current pool, taking up to 100 eligible candidates. Each run retains pool coverage and exclusions; it does not reuse yesterday’s list.',
                    )}
                  </p>
                )}
                <label className="agent-field">
                  {t('執行模式', 'Execution mode')}
                  <select
                    value={mode}
                    onChange={(event) => {
                      setMode(event.target.value as Mandate['mode'])
                      setAllowAuto(false)
                    }}
                  >
                    <option value="proposal_only">
                      {t('只產生待審閱提案', 'Create proposals for review')}
                    </option>
                    <option value="auto_simulate">
                      {t('通過限制後自動模擬', 'Automatically simulate after risk checks')}
                    </option>
                  </select>
                </label>
                {mode === 'auto_simulate' && (
                  <label className="agent-confirm">
                    <input
                      type="checkbox"
                      checked={allowAuto}
                      onChange={(event) => setAllowAuto(event.target.checked)}
                    />
                    {t(
                      '我了解此模式在排程啟用後可自動更新這個虛擬帳戶，並受現金、持倉限制與暫停開關約束。',
                      'I understand this mode can update this paper account automatically once enabled, subject to cash, position limits, and the pause switch.',
                    )}
                  </label>
                )}
                {mode === 'auto_simulate' && (
                  <label className="agent-field">
                    {t('自動執行目標', 'Automatic execution target')}
                    <select
                      value={executionTarget}
                      onChange={(event) =>
                        setExecutionTarget(event.target.value as 'paper_ledger' | 'alpaca_paper')
                      }
                    >
                      <option value="paper_ledger">
                        {t('本機模擬帳本', 'Local paper ledger')}
                      </option>
                      <option value="alpaca_paper">
                        {t(
                          'Alpaca Paper 委託（需先在交易代理啟用）',
                          'Alpaca Paper orders (enable them in the Trading agent tab first)',
                        )}
                      </option>
                    </select>
                    {executionTarget === 'alpaca_paper' && (
                      <small>
                        {t(
                          '排程通過全部限制與斷路器後，會把提案送成 Alpaca Paper 市價 DAY 委託；成交不回寫本機帳本，需在交易代理分頁核對。',
                          'Once every limit and circuit breaker passes, the schedule sends the proposal as Alpaca Paper market DAY orders; fills are not written to the local ledger and must be reconciled in the Trading agent tab.',
                        )}
                      </small>
                    )}
                  </label>
                )}
                <label className="agent-field">
                  {t(
                    '授權到期日（交易日，留空＝不設到期）',
                    'Authorization expiry (session date; blank = none)',
                  )}
                  <input
                    type="date"
                    value={expiresOn}
                    onChange={(event) => setExpiresOn(event.target.value)}
                  />
                  <small>
                    {t(
                      '到期後任務只記錄受阻嘗試，不建立提案、不模擬、不送委託；斷路器觸發或手動暫停也會要求重新授權。',
                      'After expiry the task only records blocked attempts: no proposal, no simulation, no orders. A tripped breaker or a manual pause also requires re-authorization.',
                    )}
                  </small>
                </label>
                <label className="agent-confirm">
                  <input
                    type="checkbox"
                    checked={jevGate.enabled}
                    onChange={(event) => setJevGate({ ...jevGate, enabled: event.target.checked })}
                  />
                  {t(
                    '啟用 Jev 決策閘：規則工作流後先以固定問題取得機率，未過門檻的標的歸零保留現金（每次一筆付費呼叫；未設定連線時本輪受阻，不退回未過濾目標）。',
                    'Enable the Jev gate: after the rules run, fixed-outcome probabilities filter the targets and failing symbols go to cash (one paid call per run; without a connection the attempt is blocked rather than falling back).',
                  )}
                </label>
                {jevGate.enabled && (
                  <div className="agent-form-grid">
                    <label>
                      {t('Jev 通過門檻（0.50–0.99）', 'Jev pass threshold (0.50–0.99)')}
                      <input
                        inputMode="decimal"
                        value={jevGate.pass}
                        onChange={(event) => setJevGate({ ...jevGate, pass: event.target.value })}
                      />
                    </label>
                    <label>
                      {t('Jev 風險上限（0.01–0.50）', 'Jev risk ceiling (0.01–0.50)')}
                      <input
                        inputMode="decimal"
                        value={jevGate.risk}
                        onChange={(event) => setJevGate({ ...jevGate, risk: event.target.value })}
                      />
                    </label>
                  </div>
                )}
                {!jevGateValid && (
                  <p className="error-message" role="alert">
                    {t(
                      'Jev 門檻超出範圍：通過門檻 0.50–0.99、風險上限 0.01–0.50。',
                      'Jev thresholds are out of range: pass 0.50–0.99, risk ceiling 0.01–0.50.',
                    )}
                  </p>
                )}
                <RebalanceTriggerFields
                  value={trigger}
                  onChange={setTrigger}
                  t={t}
                  disabled={busy}
                />
                {!parsedTrigger && (
                  <p className="notice">
                    {t(
                      '請填入啟用門檻的有效數值。',
                      'Enter a valid value for each enabled threshold.',
                    )}
                  </p>
                )}
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !template ||
                    !name.trim() ||
                    !parsedTrigger ||
                    (mode === 'auto_simulate' && !allowAuto)
                  }
                >
                  {t('保存任務，稍後啟用', 'Save task with schedule off')}
                </button>
              </>
            )}
          </form>
        )}
      </section>
      {mandates.length > 0 && (
        <div className="agent-columns">
          <section className="agent-panel">
            <h2>{t('此帳戶的任務', 'Tasks for this account')}</h2>
            <div className="agent-proposal-list">
              {mandates.map((mandate) => (
                <button
                  type="button"
                  className={mandate.id === selected ? 'selected' : ''}
                  key={mandate.id}
                  onClick={() => {
                    pendingSelection.current = undefined
                    setSelected(mandate.id)
                  }}
                >
                  <span>
                    <strong>{mandate.name}</strong>
                    <small>
                      {mandate.mode === 'auto_simulate'
                        ? mandate.execution_target === 'alpaca_paper'
                          ? t('自動送 Alpaca Paper', 'Auto Alpaca Paper')
                          : t('自動模擬', 'Auto simulation')
                        : t('只產生提案', 'Proposal only')}
                      {mandate.jev_gate?.enabled ? ` · ${t('Jev 閘', 'Jev gate')}` : ''}
                      {lifecycleTag(mandate, t)} · v{mandate.version}
                    </small>
                  </span>
                  <span className="agent-status">{statusLabel(mandate.status, t)}</span>
                </button>
              ))}
            </div>
          </section>
          {current && (
            <MandateControls
              key={current.id}
              mandate={current}
              account={account}
              t={t}
              onChanged={() => {
                setRefresh((value) => value + 1)
                onAccountChanged()
              }}
            />
          )}
        </div>
      )}
      {current && (
        <section className="agent-panel">
          <h2>
            {t('執行紀錄', 'Execution history')} · {current.name}
          </h2>
          <p>
            {t(
              '中斷或失敗的已取得執行權紀錄會保留；同一交易日不自動重試。',
              'Claimed attempts remain in history even after interruption or failure. They are not automatically retried in the same session.',
            )}
          </p>
          {!attempts.length ? (
            <p className="agent-empty">
              {t(
                '尚無執行紀錄。等待資料不會新增執行次數。',
                'No attempts yet. Waiting for data does not create an attempt.',
              )}
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('交易日', 'Session')}</th>
                    <th>{t('狀態', 'Status')}</th>
                    <th>{t('模式', 'Mode')}</th>
                    <th>{t('任務版本', 'Task version')}</th>
                    <th>{t('原因', 'Reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((attempt) => (
                    <tr key={attempt.id}>
                      <td>{attempt.session_date}</td>
                      <td>{statusLabel(attempt.status, t)}</td>
                      <td>
                        {attempt.mode === 'auto_simulate'
                          ? t('自動模擬', 'Auto simulation')
                          : t('只產生提案', 'Proposal only')}
                      </td>
                      <td>{attempt.mandate_version}</td>
                      <td className="agent-reason-cell">
                        {attempt.status === 'skipped' && attempt.result?.rebalance_trigger
                          ? t(
                              attempt.reason || '本日略過',
                              'Skipped by the configured rebalance checks; see the decision below.',
                            )
                          : attempt.reason || '—'}
                        {attempt.result?.rebalance_trigger && (
                          <RebalanceTriggerTrace
                            evidence={attempt.result.rebalance_trigger}
                            t={t}
                          />
                        )}
                        {attempt.result?.outcome_guard && (
                          <OutcomeGuardTrace evidence={attempt.result.outcome_guard} t={t} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="agent-method">
            <summary>{t('執行方法', 'Execution method')}</summary>
            <p>{state?.method}</p>
            <small>{state?.engine_version}</small>
          </details>
        </section>
      )}
    </>
  )
}

function WorkflowSummary({ workflow, t }: { workflow: AgentWorkflowInput; t: Translate }) {
  return (
    <div className="agent-preview">
      <p>
        <strong>{t('候選範圍', 'Candidate universe')}</strong> · {workflow.scope} ·{' '}
        {workflow.candidate_symbols.join(', ')}
      </p>
      <div className="agent-preview-stats">
        <span>
          {t('最低共識分數', 'Minimum score')} <strong>{workflow.constraints.min_score}</strong>
        </span>
        <span>
          {t('最多標的', 'Maximum positions')} <strong>{workflow.constraints.max_positions}</strong>
        </span>
        <span>
          {t('單股上限', 'Position cap')}{' '}
          <strong>{num(workflow.constraints.max_position_weight_pct, 1)}%</strong>
        </span>
        <span>
          {t('現金緩衝', 'Cash buffer')}{' '}
          <strong>{num(workflow.constraints.cash_buffer_pct, 1)}%</strong>
        </span>
      </div>
      <p>
        {t(
          '只帶入規則設定；每次執行重新驗證當期資料，不重用舊提案或舊行情。',
          'Only rule settings are reused. Every run validates current inputs instead of reusing past proposals or prices.',
        )}
      </p>
    </div>
  )
}

function MandateControls({
  mandate,
  account,
  t,
  onChanged,
}: {
  mandate: Mandate
  account: PaperAccount
  t: Translate
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [allowAuto, setAllowAuto] = useState(false)
  const [reviewedPolicy, setReviewedPolicy] = useState(false)
  const [rename, setRename] = useState(mandate.name)
  const [editing, setEditing] = useState(false)
  const [baseVersion, setBaseVersion] = useState(mandate.version)
  const [renewing, setRenewing] = useState(false)
  const [renewDate, setRenewDate] = useState(mandate.expires_on ?? '')
  const [renewAck, setRenewAck] = useState(false)
  const lifecycleBlocked =
    mandate.lifecycle === 'expired' || mandate.lifecycle === 'reauth_required'
  const stale = editing && baseVersion !== mandate.version
  const policyAuthorization = mandate.symbol_policy_authorization
  const policyStale = policyAuthorization?.status === 'stale'
  useEffect(() => setAllowAuto(false), [mandate.version, account.version])
  useEffect(
    () => setReviewedPolicy(false),
    [mandate.version, policyAuthorization?.current_policy.version],
  )
  async function update(values: Record<string, unknown>) {
    setBusy(true)
    setError('')
    setResult('')
    try {
      await api(`/api/agent-automation/mandates/${mandate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_version: editing ? baseVersion : mandate.version,
          ...values,
        }),
      })
      setEditing(false)
      setAllowAuto(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function run() {
    if (busy || account.kill_switch) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      const value = await api<{ status: string; reason?: string }>(
        `/api/agent-automation/mandates/${mandate.id}/run`,
        {
          method: 'POST',
          body: JSON.stringify({
            expected_version: mandate.version,
            allow_auto_simulate: allowAuto && mandate.mode === 'auto_simulate',
          }),
        },
      )
      setResult(value.reason || statusLabel(value.status, t))
      setAllowAuto(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function renew() {
    if (busy || !renewAck) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      await api(`/api/paper/accounts/${account.id}/mandates/${mandate.id}/renew`, {
        method: 'POST',
        body: JSON.stringify({
          expected_version: mandate.version,
          expires_on: renewDate || null,
          acknowledge: true,
        }),
      })
      setRenewing(false)
      setRenewAck(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="agent-panel">
      <div className="section-heading">
        <h2>{mandate.name}</h2>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setEditing(!editing)
            setRename(mandate.name)
            setBaseVersion(mandate.version)
          }}
        >
          {t('編輯名称', 'Rename')}
        </button>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!stale) void update({ name: rename.trim() })
          }}
        >
          <label className="agent-field">
            {t('任務名稱', 'Task name')}
            <input
              value={rename}
              maxLength={80}
              required
              onChange={(event) => setRename(event.target.value)}
            />
          </label>
          <button className="button" disabled={busy || stale}>
            {t('儲存名稱', 'Save name')}
          </button>
          {stale && (
            <p className="notice">
              {t(
                '任務版本已變更，草稿仍保留。重新開啟編輯後再儲存。',
                'The task version changed. Your draft is preserved; reopen editing before saving.',
              )}
            </p>
          )}
        </form>
      )}
      <p>
        <strong>{statusLabel(mandate.status, t)}</strong>
        {mandate.reason && (
          <>
            <br />
            {mandate.reason}
          </>
        )}
      </p>
      <p className="agent-lifecycle">
        <strong>{lifecycleLabel(mandate.lifecycle, t)}</strong>
        {mandate.expires_on
          ? ` · ${t('到期日', 'Expires')} ${mandate.expires_on}` +
            (mandate.sessions_remaining != null
              ? `（${t('剩', 'remaining')} ${mandate.sessions_remaining} ${t('個交易日', 'sessions')}）`
              : '')
          : ` · ${t('未設到期日', 'No expiry')}`}
        {mandate.reauth_reason ? ` · ${mandate.reauth_reason}` : ''}
        {mandate.lifecycle_message && (
          <>
            <br />
            <span className="agent-lifecycle-message">{mandate.lifecycle_message}</span>
          </>
        )}
        <br />
        <button
          type="button"
          className="text-button"
          disabled={busy || editing}
          onClick={() => {
            setRenewing(!renewing)
            setRenewDate(mandate.expires_on ?? '')
            setRenewAck(false)
          }}
        >
          {t('重新授權／續期', 'Re-authorize / renew')}
        </button>
      </p>
      {renewing && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void renew()
          }}
        >
          <label className="agent-field">
            {t('新的到期日（交易日，留空＝不設到期）', 'New expiry (session date; blank = none)')}
            <input
              type="date"
              value={renewDate}
              onChange={(event) => setRenewDate(event.target.value)}
            />
          </label>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={renewAck}
              onChange={(event) => setRenewAck(event.target.checked)}
            />
            {t(
              '我重新授權此任務在上述期限內依設定自動執行；先前待處理提案將失效，本交易日不再次自動執行。',
              'I re-authorize this task to run as configured until the expiry above; pending proposals are invalidated and today will not run again automatically.',
            )}
          </label>
          <button className="button" disabled={busy || !renewAck}>
            {t('確認續期', 'Confirm renewal')}
          </button>
        </form>
      )}
      <WorkflowSummary workflow={mandate.workflow} t={t} />
      <RebalanceTriggerEditor mandate={mandate} t={t} onChanged={onChanged} />
      {policyStale && policyAuthorization && (
        <div className="notice">
          <h3>{t('請檢閱新版允許標的政策', 'Review the updated symbol policy')}</h3>
          <p>
            {t('任務授權版本', 'Task authorization version')} v
            {policyAuthorization.authorized_policy_version}
            {' → '}
            {t('帳戶目前版本', 'Current account version')} v
            {policyAuthorization.current_policy.version}
          </p>
          <p>
            {policyAuthorization.current_policy.mode === 'allowlist'
              ? `${t('允許新增持倉的標的', 'Symbols allowed for new exposure')}: ${policyAuthorization.current_policy.symbols.join(', ') || t('無', 'None')}`
              : t('目前不限制新增標的。', 'New symbols are currently unrestricted.')}
          </p>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={reviewedPolicy}
              disabled={busy}
              onChange={(event) => setReviewedPolicy(event.target.checked)}
            />
            {t(
              '我已檢閱，讓此任務使用上述政策；既有本日執行紀錄不會重跑。',
              'I reviewed this policy and want this task to use it. An existing attempt for today will not run again.',
            )}
          </label>
          <button
            className="button"
            type="button"
            disabled={busy || editing || !reviewedPolicy}
            onClick={() =>
              void update({
                workflow: {
                  ...mandate.workflow,
                  account_context: {
                    account_id: mandate.account_id,
                    expected_policy_version: policyAuthorization.current_policy.version,
                  },
                },
              })
            }
          >
            {t('套用已檢閱的標的政策', 'Apply reviewed symbol policy')}
          </button>
        </div>
      )}
      {mandate.current_attempt?.result?.rebalance_trigger && (
        <RebalanceTriggerTrace evidence={mandate.current_attempt.result.rebalance_trigger} t={t} />
      )}
      {mandate.current_attempt?.result?.outcome_guard && (
        <OutcomeGuardTrace evidence={mandate.current_attempt.result.outcome_guard} t={t} />
      )}
      {mandate.candidate_source === 'scan_pool' && (
        <p className="notice">
          {t(
            '候選每天從最新選股快照重新挑選，最多',
            'Candidates are selected from the latest scan each day, up to',
          )}{' '}
          {mandate.selector_limit ?? 100} {t('個。', 'symbols.')}
        </p>
      )}
      <p>
        {t('下次檢查／執行', 'Next check / attempt')} ·{' '}
        {mandate.next_due_at ? dateTime(mandate.next_due_at) : '—'}
        <br />
        {t('最近檢查', 'Last checked')} ·{' '}
        {mandate.last_checked_at ? dateTime(mandate.last_checked_at) : '—'}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="notice" role="status">
          {result}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          disabled={busy || editing}
          onClick={() => void update({ enabled: !mandate.enabled })}
        >
          {mandate.enabled
            ? t('停用每日排程', 'Disable daily schedule')
            : t('啟用每日排程', 'Enable daily schedule')}
        </button>
        {mandate.mode === 'auto_simulate' && (
          <button
            type="button"
            className="button"
            disabled={busy || editing}
            onClick={() => void update({ mode: 'proposal_only', enabled: false })}
          >
            {t('改為只產生提案', 'Switch to proposal only')}
          </button>
        )}
      </div>
      {!mandate.current_attempt && mandate.mode === 'auto_simulate' && (
        <label className="agent-confirm">
          <input
            type="checkbox"
            checked={allowAuto}
            onChange={(event) => setAllowAuto(event.target.checked)}
          />
          {t(
            '本次手動執行也允許通過限制後自動模擬。',
            'Allow this manual attempt to simulate after passing all limits.',
          )}
        </label>
      )}
      <button
        type="button"
        className="button primary"
        disabled={
          busy ||
          account.kill_switch ||
          !!mandate.current_attempt ||
          editing ||
          policyStale ||
          lifecycleBlocked
        }
        onClick={() => void run()}
      >
        {busy
          ? t('執行中…', 'Running…')
          : allowAuto
            ? t('立即執行並自動模擬', 'Run and auto simulate now')
            : t('立即執行本日調倉檢查', 'Run today’s rebalance check')}
      </button>
      {mandate.current_attempt && (
        <p>
          {t(
            '本交易日已有執行紀錄，下次自動執行會等待下一個完成交易日。',
            'This session already has an attempt. The next automatic attempt waits for the next completed session.',
          )}
        </p>
      )}
    </section>
  )
}
