import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import type { WorkflowPathEvidence } from './WorkflowPathValidation'
import { downloadWorkflowEvidenceJson, workflowEvidenceJson } from './workflow-evidence-json'
import { num } from './ui'
import './workflow-path-attribution.css'

type Translate = (zh: string, en: string) => string
type Reason = { code: string; symbol?: string; symbols?: string[]; date?: string; field?: string }
type PriceCoverage = { required_price_values: number; available_price_values: number }
type SymbolMetrics = {
  gross_pnl: number
  fees: number
  net_pnl: number
  contribution_pp: number
  traded_notional: number
  trade_count: number
  ending_shares: number
  quantity_roundoff: number
}
export type AttributedSymbol = {
  symbol: string
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  metrics: SymbolMetrics | null
  coverage: PriceCoverage & {
    required_sessions: number
    evaluated_sessions: number
    known_inactive_sessions: number
  }
}
type DailyContribution = {
  symbol: string
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  known_inactive: boolean
  prior_shares: number | null
  share_change: number | null
  ending_shares: number | null
  quantity_roundoff: number
  previous_raw_close: number | null
  current_raw_close: number | null
  raw_open: number | null
  fee: number | null
  gross_pnl: number | null
  net_pnl: number | null
  contribution_pp: number | null
  cumulative_pnl: number | null
  coverage: PriceCoverage
}
type DailyReconciliation = {
  symbol_pnl: number
  nav_change: number
  pnl_residual: number
  reconstructed_cash: number
  saved_cash: number
  cash_residual: number
  marked_nav: number
  saved_nav: number
  nav_residual: number
  tolerance: number
}
export type AttributedDay = {
  date: string
  previous_date: string
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  contributions: DailyContribution[]
  reconciliation: DailyReconciliation | null
}
type Aggregate = {
  initial_cash: number
  symbol_pnl: number
  path_nav_change: number
  pnl_residual: number
  contribution_pp: number
  path_return_pct: number
  return_residual_pp: number
  return_tolerance_pp: number
  total_fees: number
  fees_residual: number
  cash_interest_pnl: number
  tolerance: number
}
export type WorkflowPathAttributionEvidence = {
  engine_version: string
  path_engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  input_revision: string
  as_of: string
  current_at_snapshot: boolean
  mode: 'advisory_only'
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  baseline: WorkflowPathEvidence
  baseline_evidence_fingerprint: string
  history_fingerprint: string | null
  reread_history_fingerprint: string | null
  evidence_fingerprint: string
  symbols: AttributedSymbol[]
  daily: AttributedDay[]
  aggregate: Aggregate | null
  coverage: PriceCoverage & {
    required_symbols: number
    available_symbols: number
    required_sessions: number
    available_daily_reconciliations: number
    path_evaluations: number
  }
  method: string
  warnings: string[]
}
const VERSION = 'alphaview-workflow-path-attribution-v1'
const metric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const residual = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toExponential(4) : '—'
const shares = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value !== 0 && Math.abs(value) < 1e-6
    ? value.toExponential(4)
    : metric(value, 8)
const contextKey = (run: AgentRun) =>
  JSON.stringify([run.account_context ?? null, run.request.account_context ?? null])
const sourceMatches = (value: AgentRun, run: AgentRun) =>
  value?.current === true &&
  value.id === run.id &&
  value.status === 'proposed' &&
  value.proposal_fingerprint === run.proposal_fingerprint &&
  value.input_revision === run.input_revision &&
  value.as_of === run.as_of &&
  !!value.request &&
  contextKey(value) === contextKey(run)
const reasonsValid = (value: Reason[]) =>
  Array.isArray(value) && value.every((reason) => reason && typeof reason.code === 'string')
const count = (value: number) => Number.isInteger(value) && value >= 0
const pricesValid = (value: PriceCoverage) =>
  !!value &&
  count(value.required_price_values) &&
  count(value.available_price_values) &&
  value.available_price_values <= value.required_price_values
const numericKeys = (value: object | null, keys: string[]) =>
  !!value && keys.every((key) => Number.isFinite((value as Record<string, unknown>)[key]))
function acceptedEvidence(value: unknown, run: AgentRun): value is WorkflowPathAttributionEvidence {
  if (!value || typeof value !== 'object') return false
  const r = value as WorkflowPathAttributionEvidence
  const same = (item: WorkflowPathEvidence | WorkflowPathAttributionEvidence) =>
    item?.agent_run_id === run.id &&
    item.proposal_fingerprint === run.proposal_fingerprint &&
    item.input_revision === run.input_revision &&
    item.as_of === run.as_of &&
    item.current_at_snapshot === true
  if (!(
    r.engine_version === VERSION &&
    same(r) &&
    same(r.baseline) &&
    r.baseline?.window?.sessions === 252 &&
    Array.isArray(r.baseline.candidate_symbols) &&
    r.baseline_evidence_fingerprint === r.baseline.evidence_fingerprint &&
    r.history_fingerprint === r.baseline.history_fingerprint &&
    r.mode === 'advisory_only' &&
    ['evaluated', 'unavailable'].includes(r.status) &&
    reasonsValid(r.reasons) &&
    Array.isArray(r.warnings) &&
    r.warnings.every((item) => typeof item === 'string') &&
    pricesValid(r.coverage) &&
    r.coverage.required_sessions === 252 &&
    r.coverage.path_evaluations === 1 &&
    Array.isArray(r.symbols) &&
    r.symbols.length > 0 &&
    r.symbols.length <= 100 &&
    r.symbols.length === r.baseline.candidate_symbols.length &&
    r.coverage.required_symbols === r.symbols.length &&
    r.coverage.available_symbols ===
      r.symbols.filter((item) => item.status === 'evaluated').length &&
    Array.isArray(r.daily) &&
    r.daily.length <= 252 &&
    r.coverage.available_daily_reconciliations ===
      r.daily.filter((item) => item.status === 'evaluated').length
  ))
    return false
  if (
    !r.symbols.every(
      (item, index) =>
        item?.symbol === r.baseline.candidate_symbols[index] &&
        reasonsValid(item.reasons) &&
        pricesValid(item.coverage) &&
        item.coverage.required_sessions === 252 &&
        count(item.coverage.evaluated_sessions) &&
        item.coverage.evaluated_sessions <= 252 &&
        count(item.coverage.known_inactive_sessions) &&
        item.coverage.known_inactive_sessions <= 252 &&
        (item.status === 'unavailable'
          ? item.metrics === null
          : item.status === 'evaluated' &&
            item.coverage.evaluated_sessions === 252 &&
            numericKeys(item.metrics, [
              'gross_pnl',
              'fees',
              'net_pnl',
              'contribution_pp',
              'traded_notional',
              'trade_count',
              'ending_shares',
              'quantity_roundoff',
            ])),
    )
  )
    return false
  if (
    !r.daily.every(
      (day) =>
        typeof day?.date === 'string' &&
        typeof day.previous_date === 'string' &&
        reasonsValid(day.reasons) &&
        ['evaluated', 'unavailable'].includes(day.status) &&
        Array.isArray(day.contributions) &&
        day.contributions.length === r.symbols.length &&
        ((day.status === 'unavailable' && day.reconciliation === null) ||
          numericKeys(day.reconciliation, [
            'symbol_pnl',
            'nav_change',
            'pnl_residual',
            'reconstructed_cash',
            'saved_cash',
            'cash_residual',
            'marked_nav',
            'saved_nav',
            'nav_residual',
            'tolerance',
          ])) &&
        day.contributions.every(
          (item, index) =>
            item?.symbol === r.symbols[index].symbol &&
            reasonsValid(item.reasons) &&
            pricesValid(item.coverage) &&
            typeof item.known_inactive === 'boolean' &&
            (item.status === 'unavailable'
              ? item.net_pnl === null &&
                item.cumulative_pnl === null &&
                item.contribution_pp === null
              : item.status === 'evaluated' &&
                numericKeys(item, [
                  'prior_shares',
                  'share_change',
                  'ending_shares',
                  'quantity_roundoff',
                  'fee',
                  'gross_pnl',
                  'net_pnl',
                  'contribution_pp',
                  'cumulative_pnl',
                ])),
        ),
    )
  )
    return false
  if (r.baseline.status !== 'evaluated')
    return (
      r.status === 'unavailable' &&
      r.aggregate === null &&
      r.daily.length === 0 &&
      r.coverage.available_symbols === 0
    )
  if (r.daily.length === 0)
    return (
      r.status === 'unavailable' &&
      r.aggregate === null &&
      r.coverage.available_symbols === 0 &&
      r.reasons.some((reason) =>
        ['attribution_support_incomplete', 'attribution_event_invalid'].includes(reason.code),
      )
    )
  if (r.daily.length !== 252 || r.reread_history_fingerprint !== r.history_fingerprint) return false
  return r.status === 'unavailable'
    ? r.aggregate === null
    : r.coverage.available_symbols === r.symbols.length &&
        r.coverage.available_daily_reconciliations === 252 &&
        numericKeys(r.aggregate, [
          'initial_cash',
          'symbol_pnl',
          'path_nav_change',
          'pnl_residual',
          'contribution_pp',
          'path_return_pct',
          'return_residual_pp',
          'return_tolerance_pp',
          'total_fees',
          'fees_residual',
          'cash_interest_pnl',
          'tolerance',
        ])
}
const reasonLabel = (code: string, t: Translate) =>
  ({
    baseline_unavailable: t('原路徑不可用', 'Original path unavailable'),
    attribution_support_incomplete: t(
      '歸屬日期或候選證據不完整',
      'Attribution dates or candidates incomplete',
    ),
    attribution_event_invalid: t(
      '原始成交事件無法核對',
      'Original trade event could not be reconciled',
    ),
    attribution_trade_invalid: t(
      '原始成交明細無法核對',
      'Original trade leg could not be reconciled',
    ),
    quantity_reconstruction_unavailable: t(
      '股數無法可靠重建',
      'Share quantities could not be reconstructed',
    ),
    required_price_unavailable: t('必要價格不可用', 'Required price unavailable'),
    saved_trade_price_mismatch: t('原始成交價與歷史不符', 'Saved trade price differs from history'),
    attribution_arithmetic_unavailable: t('歸屬算術不可用', 'Attribution arithmetic unavailable'),
    symbol_attribution_incomplete: t('部分標的歸屬不完整', 'Some symbol attribution is incomplete'),
    daily_accounting_mismatch: t('逐日帳務對帳有差異', 'Daily accounting mismatch'),
    prior_aggregate_gap: t(
      '先前缺口持續影響合計',
      'An earlier gap continues to invalidate the aggregate',
    ),
    aggregate_accounting_mismatch: t('全期帳務對帳有差異', 'Full-period accounting mismatch'),
  })[code] ?? code
const reasonsText = (reasons: Reason[], t: Translate) =>
  reasons
    .map((reason) =>
      [
        reason.symbol,
        reason.symbols?.join(', '),
        reason.date,
        reason.field,
        reasonLabel(reason.code, t),
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(' · ')
export function WorkflowPathAttribution({
  run,
  enabled,
  t,
}: {
  run: AgentRun
  enabled: boolean
  t: Translate
}) {
  const labelId = useId()
  const [dayIndex, setDayIndex] = useState(0)
  const available =
    enabled &&
    !!run.id &&
    run.saved &&
    run.current !== false &&
    run.status === 'proposed' &&
    run.request.candidate_symbols.length > 0
  const identity = JSON.stringify([
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    contextKey(run),
    available,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const accepted = useRef<{ identity: string; result: WorkflowPathAttributionEvidence } | null>(
    null,
  )
  if (accepted.current?.identity !== identity) accepted.current = null
  const operation = useRef<AbortController | null>(null)
  const checkingRef = useRef(false)
  const [checking, setChecking] = useState(false)
  const [state, setState] = useState<{
    identity: string
    busy?: boolean
    stale?: boolean
    error?: string
    result?: WorkflowPathAttributionEvidence
    rawJson?: string
  } | null>(null)
  const active = state?.identity === identity ? state : null
  const evidence = available && active?.result && !active.stale ? active.result : null
  const sourceMessage = t(
    '歸屬來源已變更或無法核對；請重新檢查工作流。',
    'The attribution source changed or could not be checked. Recheck the workflow.',
  )

  useEffect(() => {
    setDayIndex(0)
    setState(null)
    setChecking(false)
    checkingRef.current = false
    return () => {
      operation.current?.abort()
      operation.current = null
      accepted.current = null
    }
  }, [identity])

  useEffect(() => {
    if (!evidence) return
    const controller = new AbortController()
    const check = async () => {
      if (checkingRef.current || operation.current || document.visibilityState === 'hidden') return
      checkingRef.current = true
      setChecking(true)
      try {
        const response = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !sourceMatches((await response.json()) as AgentRun, run))
          throw new Error('stale')
      } catch {
        if (!controller.signal.aborted && latestIdentity.current === identity) {
          accepted.current = null
          setState({ identity, stale: true })
        }
      } finally {
        if (!controller.signal.aborted && latestIdentity.current === identity) {
          checkingRef.current = false
          setChecking(false)
        }
      }
    }
    const timer = window.setInterval(() => void check(), 30000)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      checkingRef.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [evidence, identity])

  async function inspect() {
    if (!available || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    accepted.current = null
    checkingRef.current = false
    setChecking(false)
    setState({ identity, busy: true })
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/path-attribution`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            expected_proposal_fingerprint: run.proposal_fingerprint,
            expected_input_revision: run.input_revision,
            expected_as_of: run.as_of,
          }),
        },
      )
      const rawJson = await response.text()
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
        )
      const value: unknown = JSON.parse(rawJson)
      if (controller.signal.aborted || latestIdentity.current !== identity) return
      if (!acceptedEvidence(value, run)) throw new Error(sourceMessage)
      workflowEvidenceJson(value, rawJson)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !sourceMatches((await checked.json()) as AgentRun, run))
        throw new Error(sourceMessage)
      if (!controller.signal.aborted && latestIdentity.current === identity) {
        accepted.current = { identity, result: value }
        setState({ identity, result: value, rawJson })
      }
    } catch (error) {
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState({ identity, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }

  function download() {
    if (
      !evidence ||
      accepted.current?.result !== evidence ||
      active?.rawJson === undefined ||
      checkingRef.current ||
      operation.current ||
      latestIdentity.current !== identity
    )
      return
    try {
      downloadWorkflowEvidenceJson(evidence, active.rawJson)
    } catch {
      setState((previous) =>
        previous?.identity === identity
          ? { ...previous, error: t('歸屬證據下載失敗', 'Attribution evidence download failed') }
          : previous,
      )
    }
  }
  const day = evidence?.daily[Math.min(dayIndex, evidence.daily.length - 1)]
  return (
    <section className="agent-panel workflow-path-attribution" aria-labelledby={labelId}>
      <h3 id={labelId}>{t('同一路徑的逐標的損益', 'Per-symbol PnL of the same path')}</h3>
      <p className="research-note">
        {t(
          '沿用同一條模擬路徑的持股與成交，拆解美元損益、費用及對原始資金的貢獻百分點。這不是個別標的報酬率、因果 alpha、排名或交易指示。',
          'Decompose the same simulated holdings and trades into dollar PnL, fees and contribution percentage points of original capital. This is not an individual investment return, causal alpha, ranking or trade instruction.',
        )}
      </p>
      <p>
        {t(
          '必要價格或算術一旦缺失，受影響標的累計與組合合計持續不可用；完整標的只代表部分證據。未持有且未成交的已知零不需要行情。',
          'Once required prices or arithmetic are missing, affected cumulative PnL and the aggregate remain unavailable. Complete symbols provide only partial evidence. Known inactive zero positions require no prices.',
        )}
      </p>
      {!available && (
        <p className="notice">
          {t('請先取得當期可用的已保存工作流。', 'A current saved workflow is required.')}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={!available || active?.busy}
          onClick={inspect}
        >
          {active?.busy
            ? t('拆解逐標的損益中…', 'Calculating symbol attribution…')
            : t('檢查逐標的損益', 'Inspect per-symbol PnL')}
        </button>
        {evidence && (
          <button className="button" type="button" disabled={checking} onClick={download}>
            {t('下載完整歸屬證據 JSON', 'Download complete attribution evidence JSON')}
          </button>
        )}
      </div>
      {active?.error && (
        <p className="error-message" role="alert">
          {active.error}
        </p>
      )}
      {active?.stale && (
        <p className="notice" role="status">
          {sourceMessage}
        </p>
      )}
      {evidence && (
        <>
          <p role="status">
            {evidence.status === 'evaluated'
              ? t(
                  '帳務歸屬已拆解，沒有排名或通過判定',
                  'Accounting attribution decomposed; no ranking or pass verdict',
                )
              : t(
                  '組合歸屬不可用；保留各標的已知證據與缺口',
                  'Aggregate attribution unavailable; known symbol evidence and gaps are retained',
                )}
          </p>
          <p>
            {t('可用標的', 'Available symbols')}: {evidence.coverage.available_symbols}/
            {evidence.coverage.required_symbols} · {t('可對帳交易日', 'Reconciled sessions')}:{' '}
            {evidence.coverage.available_daily_reconciliations}/
            {evidence.coverage.required_sessions} · {t('必要價格涵蓋', 'Required price coverage')}:{' '}
            {evidence.coverage.available_price_values}/{evidence.coverage.required_price_values}
          </p>
          {!!evidence.reasons.length && (
            <p className="notice">{reasonsText(evidence.reasons, t)}</p>
          )}
          <dl className="workflow-attribution-totals">
            <div>
              <dt>{t('標的淨損益合計（美元）', 'Total symbol net PnL (USD)')}</dt>
              <dd>{metric(evidence.aggregate?.symbol_pnl)}</dd>
            </div>
            <div>
              <dt>{t('原路徑資產增減（美元）', 'Original path NAV change (USD)')}</dt>
              <dd>{metric(evidence.aggregate?.path_nav_change)}</dd>
            </div>
            <div>
              <dt>{t('貢獻合計（百分點）', 'Total contribution (pp)')}</dt>
              <dd>{metric(evidence.aggregate?.contribution_pp, 4)}</dd>
            </div>
            <div>
              <dt>{t('原始模擬資金（美元）', 'Original simulated capital (USD)')}</dt>
              <dd>{metric(evidence.baseline.metrics?.initial_cash)}</dd>
            </div>
          </dl>
          <div className="table-scroll">
            <table>
              <caption>
                {t(
                  '全期逐標的歸屬；保留全部保存候選',
                  'Full-period attribution; all saved candidates retained',
                )}
              </caption>
              <thead>
                <tr>
                  {[
                    t('標的與涵蓋', 'Symbol and coverage'),
                    t('費用前損益（美元）', 'Gross PnL (USD)'),
                    t('費用（美元）', 'Fees (USD)'),
                    t('淨損益（美元）', 'Net PnL (USD)'),
                    t('貢獻（百分點）', 'Contribution (pp)'),
                    t('期末股數', 'Ending shares'),
                    t('成交筆數', 'Trade legs'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evidence.symbols.map((item) => (
                  <tr key={item.symbol}>
                    <th scope="row">
                      {item.symbol}
                      <span>
                        {item.status === 'unavailable'
                          ? t('不可用', 'Unavailable')
                          : evidence.status === 'unavailable'
                            ? t('部分證據', 'Partial evidence')
                            : t('已拆解', 'Decomposed')}
                      </span>
                      <span>
                        {t('涵蓋交易日', 'Covered sessions')}: {item.coverage.evaluated_sessions}/
                        {item.coverage.required_sessions}
                      </span>
                      <span>
                        {t('已知未持有日', 'Known inactive sessions')}:{' '}
                        {item.coverage.known_inactive_sessions}
                      </span>
                      <span>
                        {t('必要價格涵蓋', 'Required price coverage')}:{' '}
                        {item.coverage.available_price_values}/{item.coverage.required_price_values}
                      </span>
                      {!!item.reasons.length && <span>{reasonsText(item.reasons, t)}</span>}
                    </th>
                    <td>{metric(item.metrics?.gross_pnl)}</td>
                    <td>{metric(item.metrics?.fees)}</td>
                    <td>{metric(item.metrics?.net_pnl)}</td>
                    <td>{metric(item.metrics?.contribution_pp, 4)}</td>
                    <td>{shares(item.metrics?.ending_shares)}</td>
                    <td>{metric(item.metrics?.trade_count, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {t(
              '貢獻百分點 = 100 × 標的淨損益 ÷ 原始模擬資金；費用只扣除一次，現金利息採原路徑的零假設。',
              'Contribution pp = 100 × symbol net PnL / original simulated capital. Fees are deducted once; cash interest follows the original zero-interest assumption.',
            )}
          </p>
          <details>
            <summary>{t('全期對帳差額與容差', 'Full-period residuals and tolerances')}</summary>
            <dl className="workflow-attribution-totals">
              <div>
                <dt>{t('損益差額（美元）', 'PnL residual (USD)')}</dt>
                <dd>{residual(evidence.aggregate?.pnl_residual)}</dd>
              </div>
              <div>
                <dt>{t('費用差額（美元）', 'Fee residual (USD)')}</dt>
                <dd>{residual(evidence.aggregate?.fees_residual)}</dd>
              </div>
              <div>
                <dt>{t('金額容差（美元）', 'Currency tolerance (USD)')}</dt>
                <dd>{residual(evidence.aggregate?.tolerance)}</dd>
              </div>
              <div>
                <dt>{t('貢獻差額（百分點）', 'Contribution residual (pp)')}</dt>
                <dd>{residual(evidence.aggregate?.return_residual_pp)}</dd>
              </div>
              <div>
                <dt>{t('貢獻容差（百分點）', 'Contribution tolerance (pp)')}</dt>
                <dd>{residual(evidence.aggregate?.return_tolerance_pp)}</dd>
              </div>
            </dl>
          </details>
          <details>
            <summary>
              {t('逐日持股、價格與對帳', 'Daily holdings, prices and reconciliation')}
            </summary>
            {day ? (
              <>
                <label className="workflow-attribution-day">
                  {t('選擇交易日', 'Select session')}
                  <select
                    value={Math.min(dayIndex, evidence.daily.length - 1)}
                    onChange={(event) => setDayIndex(Number(event.target.value))}
                  >
                    {evidence.daily.map((item, index) => (
                      <option key={item.date} value={index}>
                        {item.date}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  {day.previous_date} → {day.date} ·{' '}
                  {day.status === 'evaluated'
                    ? t('已拆解', 'Decomposed')
                    : t('不可用', 'Unavailable')}
                </p>
                {!!day.reasons.length && <p className="notice">{reasonsText(day.reasons, t)}</p>}
                <div className="table-scroll">
                  <table>
                    <caption>{t('當日逐標的證據', 'Selected-session symbol evidence')}</caption>
                    <thead>
                      <tr>
                        {[
                          t('標的與狀態', 'Symbol and status'),
                          t('前日股數', 'Prior shares'),
                          t('增減股數', 'Share change'),
                          t('期末股數', 'Ending shares'),
                          t('前日收盤', 'Prior close'),
                          t('當日開盤', 'Session open'),
                          t('當日收盤', 'Session close'),
                          t('費用（美元）', 'Fees (USD)'),
                          t('淨損益（美元）', 'Net PnL (USD)'),
                          t('累計損益（美元）', 'Cumulative PnL (USD)'),
                          t('貢獻（百分點）', 'Contribution (pp)'),
                        ].map((label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {day.contributions.map((item) => (
                        <tr key={item.symbol}>
                          <th scope="row">
                            {item.symbol}
                            <span>
                              {item.known_inactive
                                ? t('已知未持有且未成交', 'Known inactive with no trade')
                                : item.status === 'evaluated'
                                  ? t('已拆解', 'Decomposed')
                                  : t('不可用', 'Unavailable')}
                            </span>
                            <span>
                              {t('必要價格涵蓋', 'Required price coverage')}:{' '}
                              {item.coverage.available_price_values}/
                              {item.coverage.required_price_values}
                            </span>
                            {!!item.reasons.length && <span>{reasonsText(item.reasons, t)}</span>}
                            {item.quantity_roundoff !== 0 && (
                              <span>
                                {t('完整退出股數尾差', 'Full-exit share roundoff')}:{' '}
                                {residual(item.quantity_roundoff)}
                              </span>
                            )}
                          </th>
                          <td>{shares(item.prior_shares)}</td>
                          <td>{shares(item.share_change)}</td>
                          <td>{shares(item.ending_shares)}</td>
                          <td>{metric(item.previous_raw_close, 4)}</td>
                          <td>{metric(item.raw_open, 4)}</td>
                          <td>{metric(item.current_raw_close, 4)}</td>
                          <td>{metric(item.fee)}</td>
                          <td>{metric(item.net_pnl)}</td>
                          <td>{metric(item.cumulative_pnl)}</td>
                          <td>{metric(item.contribution_pp, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  {t(
                    '價格欄空值可能代表不需要該價格，請搭配持股與必要價格涵蓋判讀。',
                    'An empty price can mean that price is not required; read it with holdings and required price coverage.',
                  )}
                </p>
                <dl className="workflow-attribution-totals">
                  <div>
                    <dt>{t('損益差額（美元）', 'PnL residual (USD)')}</dt>
                    <dd>{residual(day.reconciliation?.pnl_residual)}</dd>
                  </div>
                  <div>
                    <dt>{t('現金差額（美元）', 'Cash residual (USD)')}</dt>
                    <dd>{residual(day.reconciliation?.cash_residual)}</dd>
                  </div>
                  <div>
                    <dt>{t('資產差額（美元）', 'NAV residual (USD)')}</dt>
                    <dd>{residual(day.reconciliation?.nav_residual)}</dd>
                  </div>
                  <div>
                    <dt>{t('金額容差（美元）', 'Currency tolerance (USD)')}</dt>
                    <dd>{residual(day.reconciliation?.tolerance)}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p>{t('沒有可拆解的逐日路徑。', 'No daily path is available for attribution.')}</p>
            )}
          </details>
          <details>
            <summary>{t('方法、來源與限制', 'Method, source and limitations')}</summary>
            <p>
              <code>{evidence.engine_version}</code>
            </p>
            <p>
              {t('原路徑指紋', 'Original path fingerprint')}:{' '}
              <code>{evidence.baseline_evidence_fingerprint}</code>
            </p>
            <p>
              {t('歷史指紋', 'History fingerprint')}:{' '}
              <code>{evidence.history_fingerprint ?? '—'}</code>
            </p>
            <p>
              {t('完整證據指紋', 'Complete evidence fingerprint')}:{' '}
              <code>{evidence.evidence_fingerprint}</code>
            </p>
            <p>{evidence.method}</p>
            <p>
              {t(
                '下載保留完整原路徑、逐日歸屬及對帳證據；來源有效只限當次快照，離線開啟時需重新確認當期性。',
                'The download retains the complete original path, daily attribution and reconciliation. Source validity applies only to its snapshot; freshness must be checked again when opened offline.',
              )}
            </p>
            <ul>
              {evidence.warnings.map((warning) => (
                <li key={warning}>{t(warning, warning)}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
