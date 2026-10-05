import { useEffect, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import './readiness.css'

type Translate = (zh: string, en: string) => string
export type ReadinessStatus = 'pass' | 'fail' | 'unavailable' | 'not_applicable'
export type ReadinessCheck = {
  id: string
  label: string
  status: ReadinessStatus
  observed: string | number | null
  required: string | number | null
  reason: string | null
  reason_code: string | null
}
export type Readiness = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  overall: 'not_ready' | 'paper_ready' | 'blocked'
  execution_target: string | null
  checks: ReadinessCheck[]
  summary: Record<ReadinessStatus, number>
  method: string
  warnings: string[]
}
const CHECK_ENGLISH: Record<string, string> = {
  mandate_active: 'Enabled mandate with an execution target',
  jev_gate_declared: 'Jev gate enabled or explicitly declined',
  circuit_breakers_configured: 'All three circuit-breaker limits set',
  position_stops_enabled: 'Position stops enabled',
  alpaca_paper_orders: 'Alpaca Paper orders enabled with caps',
  broker_book_reconciled: 'Current matched Alpaca Paper book receipt (within 15 minutes)',
  no_stale_unknown_orders: 'No unknown-outcome orders from earlier sessions',
  recent_attempts_clean: 'No failed attempt among the recent automation runs',
  nav_snapshot_current: 'Complete NAV snapshot for the latest session (daily report available)',
  history_sessions: 'Enough sessions of complete NAV history',
  account_not_paused: 'Account not paused',
  no_tripped_breaker: 'No tripped circuit breaker',
  schema_current: 'Database schema registered as current',
  regime_overlay_configured: 'Regime exposure overlay enabled with a computable cap',
  corporate_actions_clear: 'No held symbol with a suspected mixed-basis corporate action',
  position_stops_evaluable: 'Position stops evaluable for every holding',
  outcome_hit_rate: 'Decision-outcome hit rate (10-session horizon, at least 20 settled)',
}
const REASON_ENGLISH: Record<string, string> = {
  no_enabled_mandate: 'This account has no enabled automation mandate.',
  no_mandate: 'No enabled mandate to read from.',
  missing_limits: 'Some breaker limits are still unset.',
  stops_off: 'Position stops are off or have no stop percentage.',
  paper_ledger_target: 'The target is the local ledger; no broker connection is needed.',
  not_configured: 'The Alpaca Paper connection is not configured.',
  orders_disabled: 'Alpaca Paper orders have not been enabled with the confirmation phrase.',
  credential_file: 'The local Alpaca credential file could not be read safely.',
  stale_unknown_orders:
    'Orders sent in an earlier session still have unknown outcomes; reconcile first.',
  no_attempts: 'No automation attempt has been recorded yet.',
  failed_attempts: 'A recent automation attempt failed.',
  nav_not_captured:
    'No complete NAV snapshot for the latest session; the daily NAV change is unavailable.',
  history_too_short: 'Not enough sessions with complete NAV snapshots.',
  kill_switch: 'The account is paused; review and resume it manually.',
  circuit_breaker_tripped: 'A circuit breaker is tripped.',
  migration_required: 'The database schema needs migration before it is current.',
  unregistered_schema: 'The database schema signature is not registered.',
  overlay_disabled:
    'The regime overlay is off; automation runs without an exposure cap (recorded, not judged).',
  regime_cap_unavailable:
    'The overlay is on but the regime score is incomplete, so no cap can be computed.',
  regime_evaluation_failed: 'The regime overlay could not be evaluated.',
  mixed_basis_flag:
    'A held symbol shows a suspected split since entry with a possibly mixed price basis; refetch its full history first.',
  entry_unknown:
    'No holding has an entry record, so corporate actions since entry cannot be judged.',
  corporate_actions_failed: 'Corporate-action detection could not run.',
  stops_unavailable:
    'Some holdings lack a current price or entry record, so their stops cannot be evaluated.',
  stops_evaluation_failed: 'Position stops could not be evaluated.',
  hit_rate_low:
    'A decision family with at least 20 settled decisions has a hit rate below 40%; review that source manually.',
  insufficient_settled: 'Fewer than 20 settled decisions; the hit rate cannot be judged yet.',
  outcome_ledger_failed: 'The decision outcome ledger could not be read.',
  receipt_missing: 'No saved book receipt. Reconcile the book on the Alpaca Paper page.',
  reconciliation_receipt_unavailable: 'The local receipt or connection identity could not be read.',
  receipt_stale: 'The saved book receipt is older than 15 minutes. Reconcile again.',
  receipt_timestamp_invalid: 'The receipt timestamp is invalid or in the future. Reconcile again.',
  receipt_session_changed: 'The latest completed session changed. Reconcile again.',
  receipt_connection_changed: 'The Alpaca connection version changed. Reconcile again.',
  receipt_account_changed: 'The configured broker account changed. Reconcile again.',
  receipt_inputs_changed: 'Workspace inputs changed since the book receipt. Reconcile again.',
  receipt_book_changed: 'The execution book changed since the receipt. Reconcile again.',
  receipt_method_changed: 'The reconciliation method changed. Reconcile again.',
  book_unavailable:
    'The most recent broker evidence is unavailable; it does not establish a match.',
  book_drift: 'The most recent receipt reports book drift. Review the reconciliation details.',
  book_unexplained: 'The broker holds positions that the local execution book cannot explain.',
  book_pending: 'Working orders keep the reconciliation pending.',
  book_unknown: 'Unknown-outcome orders prevent a confirmed book match.',
}
const overallLabel = (overall: Readiness['overall'], t: Translate) =>
  ({
    paper_ready: t('可無人值守（僅 paper）', 'Ready for unattended paper automation'),
    not_ready: t('尚未就緒', 'Not ready'),
    blocked: t('已阻擋（暫停或觸發）', 'Blocked (paused or tripped)'),
  })[overall]
const statusLabel = (status: ReadinessStatus, t: Translate) =>
  ({
    pass: t('通過', 'Pass'),
    fail: t('未通過', 'Fail'),
    unavailable: t('不可用', 'Unavailable'),
    not_applicable: t('不適用', 'N/A'),
  })[status]
const text = (value: string | number | null) => (value == null ? '—' : String(value))

export function AgentReadiness({ account, locale }: { account: PaperAccount; locale: Locale }) {
  return <ReadinessPanel key={account.id} account={account} locale={locale} />
}

function ReadinessPanel({ account, locale }: { account: PaperAccount; locale: Locale }) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [state, setState] = useState<Readiness | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    setState(null)
    const refresh = async () => {
      if (running || document.visibilityState === 'hidden') return
      running = true
      try {
        const response = await fetch(
          `/api/trading-agent/readiness?account_id=${encodeURIComponent(account.id)}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        )
        const value = await response.json().catch(() => ({}))
        if (!response.ok)
          throw new Error(
            typeof value?.detail === 'string'
              ? value.detail
              : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
          )
        if (controller.signal.aborted) return
        setState(value as Readiness)
        setError('')
      } catch (err) {
        if (!controller.signal.aborted) {
          setState(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        running = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [account.id, account.version])
  return (
    <section className="agent-panel readiness" aria-label={t('無人值守就緒閘', 'Readiness gate')}>
      <div className="section-heading">
        <div>
          <h2>{t('無人值守就緒閘（僅 paper）', 'Readiness gate (paper only)')}</h2>
          <p>
            {t(
              '以本機紀錄逐項檢查自動化任務、防護、券商連線與淨值紀錄是否齊備；缺證據視為不可用。這裡沒有實盤目標，也不會自動晉級任何設定。',
              'Mechanical checks of the mandate, protections, broker connection and NAV history from local records; missing evidence is unavailable. There is no live target and nothing is promoted automatically.',
            )}
          </p>
        </div>
        {state && (
          <span className={`readiness-overall is-${state.overall}`} role="status">
            {overallLabel(state.overall, t)}
          </span>
        )}
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {state && (
        <>
          <p className="trading-agent-meta">
            {t('評估交易日', 'Session')} {state.as_of} · {t('通過', 'Pass')} {state.summary.pass} ·{' '}
            {t('未通過', 'Fail')} {state.summary.fail} · {t('不可用', 'Unavailable')}{' '}
            {state.summary.unavailable} · {t('不適用', 'N/A')} {state.summary.not_applicable}
          </p>
          <ul className="readiness-checks">
            {state.checks.map((check) => (
              <li key={check.id} className={`is-${check.status}`}>
                <span className={`readiness-pill is-${check.status}`}>
                  {statusLabel(check.status, t)}
                </span>
                <strong>{t(check.label, CHECK_ENGLISH[check.id] || check.label)}</strong>
                <small>
                  {t('觀察', 'Observed')}: {text(check.observed)}
                  {check.required != null
                    ? ` · ${t('要求', 'Required')}: ${text(check.required)}`
                    : ''}
                  {check.reason
                    ? ` · ${t(check.reason, (check.reason_code && REASON_ENGLISH[check.reason_code]) || check.reason)}`
                    : ''}
                </small>
              </li>
            ))}
          </ul>
          <details className="agent-method">
            <summary>{t('這不是什麼', 'What this is not')}</summary>
            <ul>
              {state.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p>{state.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
