import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import { dateTime, money, num } from './ui'
import './agent-report.css'

type Translate = (zh: string, en: string) => string
export type ReportFill = {
  symbol: string
  side: 'buy' | 'sell'
  shares: number | null
  price: number | null
  notional: number | null
  fee: number | null
  slippage_cost: number | null
  realized_pnl: number | null
  proposal_id: string | null
  session: string
  created_at: string
}
export type AgentReport = {
  engine_version: string
  as_of: string
  session: string
  is_session: boolean
  input_revision: string
  generated_at: string
  account: {
    id: string
    name: string
    version: number
    kill_switch: boolean
    cash: number | null
    initial_cash: number | null
    equity: number | null
    valuation_complete: boolean
    coverage: { required: number; priced: number; missing: string[] }
    holdings_count: number
    realized_pnl: number | null
    unrealized_pnl: number | null
    total_return_pct: number | null
  }
  decision_quality?:
    | {
        available: true
        engine_version: string
        horizon_sessions: number
        window_sessions: number
        families: Record<
          string,
          {
            label: string
            english: string
            n: number
            n_settled: number
            n_pending: number
            hit_rate: number | null
            mean_excess_pct: number | null
            low_sample: boolean
            reason: string | null
            kinds: {
              kind: string
              label: string
              english: string
              n_settled: number
              hit_rate: number | null
              low_sample: boolean
            }[]
          }
        >
        score_correlation: {
          status: string
          spearman: number | null
          n: number
          low_sample: boolean
          reason: string | null
        }
      }
    | { available: false; reason: string }
  provenance_counts?: {
    engine_version: string
    session: string
    total: number
    by_source: Record<string, number>
    by_tag: Record<string, number>
  }
  operations?: {
    readiness:
      | {
          available: true
          overall: string
          execution_target: string | null
          failing: string[]
          unavailable: string[]
        }
      | { available: false; reason: string }
    mandates:
      | {
          available: true
          count: number
          lifecycle_counts: Record<string, number>
          attention: {
            id: string
            name: string
            lifecycle: string
            expires_on: string | null
            sessions_remaining: number | null
            message: string | null
          }[]
        }
      | { available: false; reason: string }
    position_stops:
      | {
          available: true
          enabled: boolean
          tripped: string[]
          unavailable: string[]
          holdings: number
        }
      | { available: false; reason: string }
    regime_overlay:
      | {
          available: true
          enabled: boolean
          mode: string | null
          zone: string | null
          score: number | null
          complete: boolean
          cap_pct: number | null
          cap_status: string | null
          current_exposure_pct: number | null
          exposure_status: string
        }
      | { available: false; reason: string }
  }
  nav: {
    latest: { as_of: string; equity: number | null; complete: boolean } | null
    previous: { as_of: string; equity: number | null; complete: boolean } | null
    session_change_pct: number | null
    session_change_reason: string | null
    window_return_pct: number | null
    window_max_drawdown_pct: number | null
    window_reason: string | null
    captured_sessions: number
    observed_sessions: number
  }
  fills: {
    items: ReportFill[]
    totals: {
      count: number
      buy_count: number
      sell_count: number
      buy_notional: number | null
      sell_notional: number | null
      fees: number | null
      slippage: number | null
      cost_total: number | null
      realized_pnl: number | null
    }
  }
  window: {
    window_sessions: number
    start: string | null
    end: string | null
    fill_count: number
    sell_count: number
    realized_pnl: number | null
    win_rate_pct: number | null
    wins: number
    losses: number
    largest_win: number | null
    largest_loss: number | null
    avg_realized_pnl: number | null
    cost_total: number | null
    gross_notional: number | null
    reason: string | null
  }
  automation: {
    attempts: {
      id: string
      mandate_id: string
      mandate_name: string | null
      status: string
      reason_code: string | null
      reason: string | null
    }[]
    status_counts: Record<string, number>
    enabled_mandates: number | null
    pending_proposals: number
    next_open_queue: Record<string, number> | null
  }
  jev: {
    available: boolean
    reason?: string
    runs?: number
    status_counts?: Record<string, number>
    symbol_counts?: { pass: number; fail: number; unavailable: number }
    average_latency_ms?: number | null
    estimated_cost_usd?: number | null
    cost_basis?: string
  }
  circuit_breaker: { available: boolean; reason?: string; [key: string]: unknown }
  data_freshness: {
    symbols: { symbol: string; latest_bar: string | null; stale: boolean }[]
    stale_symbols: string[]
    session: string
  }
  method: string
  warnings: string[]
}
const ENGLISH: Record<string, string> = {
  invalid_session: 'The session must be a YYYY-MM-DD date.',
  session_not_completed: 'That session has not completed yet.',
}
async function request<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.code)
      throw new Error(t(String(detail.message), ENGLISH[detail.code] || String(detail.message)))
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
async function download(url: string, filename: string, t: Translate) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    const detail = value?.detail
    throw new Error(
      detail && typeof detail === 'object' && detail.message
        ? t(String(detail.message), ENGLISH[detail.code] || String(detail.message))
        : t('下載失敗', 'Download failed'),
    )
  }
  const blob = await response.blob()
  const link = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = link
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(link), 10000)
}
const pct = (value: number | null | undefined, digits = 2) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${num(value, digits)}%`
const tone = (value: number | null | undefined) =>
  value == null ? '' : value > 0 ? 'positive' : value < 0 ? 'negative' : ''

export function AgentDailyReport({ account, locale }: { account: PaperAccount; locale: Locale }) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [session, setSession] = useState('')
  const [windowSessions, setWindowSessions] = useState('20')
  const [report, setReport] = useState<AgentReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'html' | 'csv' | null>(null)
  const [refresh, setRefresh] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const query = (() => {
    const params = new URLSearchParams({ account_id: account.id, window_sessions: windowSessions })
    if (session) params.set('session', session)
    return params.toString()
  })()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    request<AgentReport>(`/api/trading-agent/report?${query}`, t, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setReport(data)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // The translate helper only relabels; refetch on account/session/window changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, account.version, refresh])
  async function exportFile(kind: 'html' | 'csv') {
    if (!report || busy) return
    setBusy(kind)
    setError('')
    try {
      await download(
        `/api/trading-agent/report.${kind}?${query}`,
        `alphaview-agent-report-${report.account.id.slice(0, 8)}-${report.session}.${kind}`,
        t,
      )
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }
  const cards: [string, string, string?][] = report
    ? [
        [
          t('淨值', 'Equity'),
          money(report.account.equity),
          report.account.valuation_complete
            ? `${t('現金', 'Cash')} ${money(report.account.cash)}`
            : `${t('估值不完整，缺價', 'Incomplete valuation, missing')} ${report.account.coverage.missing.join(', ')}`,
        ],
        [
          t('當日淨值變動', 'Session NAV change'),
          pct(report.nav.session_change_pct),
          report.nav.session_change_reason ||
            `${t('對比', 'vs')} ${report.nav.previous?.as_of ?? '—'}`,
        ],
        [
          t('區間報酬', 'Window return'),
          pct(report.nav.window_return_pct),
          report.nav.window_reason ||
            `${report.window.window_sessions} ${t('個交易日', 'sessions')}`,
        ],
        [
          t('區間最大回撤', 'Window max drawdown'),
          report.nav.window_max_drawdown_pct == null
            ? '—'
            : `${num(report.nav.window_max_drawdown_pct)}%`,
          `${t('已擷取', 'Captured')} ${report.nav.captured_sessions}/${report.nav.observed_sessions}`,
        ],
        [
          t('當日成交', 'Session fills'),
          String(report.fills.totals.count),
          `${t('買入', 'Buys')} ${report.fills.totals.buy_count} · ${t('賣出', 'Sells')} ${report.fills.totals.sell_count}`,
        ],
        [
          t('當日已實現損益', 'Session realized P/L'),
          money(report.fills.totals.realized_pnl),
          `${t('費用與滑價', 'Fees and slippage')} ${money(report.fills.totals.cost_total)}`,
        ],
        [
          t('區間勝率', 'Window win rate'),
          report.window.win_rate_pct == null ? '—' : `${num(report.window.win_rate_pct, 1)}%`,
          report.window.reason ||
            `${report.window.wins} ${t('勝', 'wins')} / ${report.window.sell_count} ${t('賣出', 'sells')}`,
        ],
        [
          t('最大單筆虧損', 'Largest loss'),
          money(report.window.largest_loss),
          `${t('最大單筆獲利', 'Largest win')} ${money(report.window.largest_win)}`,
        ],
        [
          t('Jev 決策', 'Jev decisions'),
          report.jev.available ? String(report.jev.runs ?? 0) : '—',
          report.jev.available
            ? `${t('平均延遲', 'Avg latency')} ${report.jev.average_latency_ms == null ? '—' : `${num(report.jev.average_latency_ms, 0)} ms`} · ${t('估算費用', 'Est. cost')} ${report.jev.estimated_cost_usd == null ? '—' : `$${report.jev.estimated_cost_usd.toFixed(6)}`}`
            : (report.jev.reason ?? ''),
        ],
        [
          t('自動化嘗試', 'Automation attempts'),
          String(report.automation.attempts.length),
          Object.entries(report.automation.status_counts)
            .map(([status, count]) => `${status} ${count}`)
            .join(' · ') || t('無', 'None'),
        ],
        [
          t('待審提案', 'Pending proposals'),
          String(report.automation.pending_proposals),
          report.account.kill_switch
            ? t('帳戶已暫停', 'Account paused')
            : `${t('啟用任務', 'Enabled mandates')} ${report.automation.enabled_mandates ?? '—'}`,
        ],
        [
          t('資料新鮮度', 'Data freshness'),
          `${report.data_freshness.stale_symbols.length} ${t('檔過期', 'stale')}`,
          report.data_freshness.stale_symbols.join(', ') ||
            t('持股日線已到所選交易日', 'Holdings are priced through the session'),
        ],
      ]
    : []
  const breaker = report?.circuit_breaker
  return (
    <section
      className="agent-panel agent-report"
      aria-label={t('Agent 日報', 'Agent daily report')}
    >
      <div className="section-heading">
        <div>
          <h2>{t('Trading Agent 日報', 'Trading Agent daily report')}</h2>
          <p>
            {t(
              '一個模擬帳戶、一個已完成交易日：成交、損益、勝率、最大虧損、成本、Jev 延遲與費用、自動化與資料狀態。全部來自本機紀錄，沒有推估。',
              'One paper account, one completed session: fills, P/L, win rate, largest loss, costs, Jev latency and cost, automation and data status. Everything comes from local records; nothing is estimated.',
            )}
          </p>
        </div>
      </div>
      <div className="agent-form-grid agent-report-controls">
        <label>
          {t('交易日', 'Session')}
          <input
            type="date"
            value={session || report?.session || ''}
            max={report?.as_of}
            onChange={(event) => setSession(event.target.value)}
          />
        </label>
        <label>
          {t('區間交易日數', 'Window sessions')}
          <select
            value={windowSessions}
            onChange={(event) => setWindowSessions(event.target.value)}
          >
            {['5', '20', '60', '120', '252'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={loading || !!busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? t('讀取中…', 'Loading…') : t('重新整理', 'Refresh')}
        </button>
        <button
          type="button"
          className="button"
          disabled={!report || !!busy}
          onClick={() => void exportFile('html')}
        >
          {busy === 'html'
            ? t('下載中…', 'Downloading…')
            : t('下載 HTML 日報', 'Download HTML report')}
        </button>
        <button
          type="button"
          className="button"
          disabled={!report || !!busy}
          onClick={() => void exportFile('csv')}
        >
          {busy === 'csv' ? t('下載中…', 'Downloading…') : t('下載成交 CSV', 'Download fills CSV')}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <p className="agent-report-meta">
            {report.account.name} · {report.session}
            {report.is_session ? '' : ` · ${t('非交易日', 'not a session')}`} ·{' '}
            {t('最新完成交易日', 'Latest session')} {report.as_of} · {t('產生於', 'Generated')}{' '}
            {dateTime(report.generated_at)} · {report.engine_version}
          </p>
          <div className="agent-report-grid">
            {cards.map(([label, value, note]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{note}</small>
              </div>
            ))}
          </div>
          {report.operations && (
            <>
              <h3>{t('營運狀態', 'Operations')}</h3>
              <ul className="agent-report-list">
                <li>
                  <strong>{t('就緒閘', 'Readiness')}</strong>:{' '}
                  {report.operations.readiness.available
                    ? `${report.operations.readiness.overall} · ${t('未通過', 'failing')} ${report.operations.readiness.failing.join('、') || t('無', 'none')} · ${t('不可用', 'unavailable')} ${report.operations.readiness.unavailable.join('、') || t('無', 'none')}`
                    : report.operations.readiness.reason}
                </li>
                <li>
                  <strong>{t('任務授權', 'Mandates')}</strong>:{' '}
                  {report.operations.mandates.available
                    ? `${report.operations.mandates.count} · ${
                        Object.entries(report.operations.mandates.lifecycle_counts)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(' · ') || t('無', 'none')
                      }${report.operations.mandates.attention.length ? ` · ${t('需注意', 'attention')}: ${report.operations.mandates.attention.map((item) => `${item.name} (${item.lifecycle})`).join('、')}` : ''}`
                    : report.operations.mandates.reason}
                </li>
                <li>
                  <strong>{t('部位停損', 'Position stops')}</strong>:{' '}
                  {report.operations.position_stops.available
                    ? `${report.operations.position_stops.enabled ? t('已啟用', 'enabled') : t('未啟用', 'off')} · ${t('觸發', 'tripped')} ${report.operations.position_stops.tripped.join('、') || t('無', 'none')}`
                    : report.operations.position_stops.reason}
                </li>
                <li>
                  <strong>{t('市場風險覆蓋', 'Regime overlay')}</strong>:{' '}
                  {report.operations.regime_overlay.available
                    ? `${report.operations.regime_overlay.enabled ? `${t('已啟用', 'enabled')} ${report.operations.regime_overlay.mode}` : t('未啟用', 'off')} · ${t('區間', 'zone')} ${report.operations.regime_overlay.zone ?? '—'} · ${t('上限', 'cap')} ${report.operations.regime_overlay.cap_pct == null ? '—' : `${num(report.operations.regime_overlay.cap_pct, 0)}%`} · ${t('曝險', 'exposure')} ${report.operations.regime_overlay.current_exposure_pct == null ? '—' : `${num(report.operations.regime_overlay.current_exposure_pct, 1)}%`} (${report.operations.regime_overlay.exposure_status})`
                    : report.operations.regime_overlay.reason}
                </li>
              </ul>
            </>
          )}
          {report.decision_quality && (
            <>
              <h3>{t('決策品質', 'Decision quality')}</h3>
              {report.decision_quality.available ? (
                <ul className="agent-report-list">
                  {Object.entries(report.decision_quality.families).map(([key, family]) => (
                    <li key={key}>
                      <strong>{t(family.label, family.english)}</strong>: {t('已結算', 'settled')}{' '}
                      {family.n_settled} · {t('待定', 'pending')} {family.n_pending} ·{' '}
                      {t('命中率', 'hit rate')}{' '}
                      {family.hit_rate == null ? '—' : `${num(family.hit_rate * 100, 1)}%`}
                      {family.low_sample ? ` (${t('樣本少', 'low sample')})` : ''}
                      {family.reason ? ` · ${family.reason}` : ''}
                    </li>
                  ))}
                  <li>
                    <strong>{t('setup_quality 秩相關', 'setup_quality rank correlation')}</strong>:{' '}
                    {report.decision_quality.score_correlation.spearman == null
                      ? '—'
                      : num(report.decision_quality.score_correlation.spearman, 3)}{' '}
                    (N={report.decision_quality.score_correlation.n})
                    {report.decision_quality.score_correlation.reason
                      ? ` · ${report.decision_quality.score_correlation.reason}`
                      : ''}
                  </li>
                </ul>
              ) : (
                <p className="agent-report-meta">{report.decision_quality.reason}</p>
              )}
            </>
          )}
          {report.provenance_counts && (
            <p className="agent-report-meta">
              {t('此交易日提案', 'Proposals this session')} {report.provenance_counts.total} ·{' '}
              {t('來源', 'sources')}{' '}
              {Object.entries(report.provenance_counts.by_source)
                .map(([key, value]) => `${key} ${value}`)
                .join(' · ') || t('無', 'none')}{' '}
              · {t('閘門標籤', 'gate tags')}{' '}
              {Object.entries(report.provenance_counts.by_tag)
                .map(([key, value]) => `${key} ${value}`)
                .join(' · ') || t('無', 'none')}
            </p>
          )}
          <h3>{t('斷路器', 'Circuit breaker')}</h3>
          {breaker?.available ? (
            <ul className="agent-report-list">
              {Object.entries(breaker)
                .filter(([key]) => key !== 'available')
                .map(([key, value]) => (
                  <li key={key}>
                    <code>{key}</code>:{' '}
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="agent-report-meta">
              {breaker?.reason || t('斷路器不可用', 'Circuit breaker unavailable')}
            </p>
          )}
          <h3>
            {t('當日紙上成交', 'Session paper fills')} ({report.fills.items.length})
          </h3>
          {report.fills.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('代碼', 'Symbol'),
                      t('方向', 'Side'),
                      t('股數', 'Shares'),
                      t('價格', 'Price'),
                      t('金額', 'Notional'),
                      t('費用', 'Fee'),
                      t('滑價', 'Slippage'),
                      t('已實現損益', 'Realized P/L'),
                      t('提案', 'Proposal'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.fills.items.map((fill, index) => (
                    <tr key={`${fill.proposal_id}-${fill.symbol}-${index}`}>
                      <th scope="row">{fill.symbol}</th>
                      <td>{fill.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                      <td>{num(fill.shares, 4)}</td>
                      <td>{money(fill.price)}</td>
                      <td>{money(fill.notional)}</td>
                      <td>{money(fill.fee)}</td>
                      <td>{money(fill.slippage_cost)}</td>
                      <td className={tone(fill.realized_pnl)}>{money(fill.realized_pnl)}</td>
                      <td>{fill.proposal_id?.slice(0, 12) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="agent-report-meta">
              {t('此交易日沒有紙上成交。', 'No paper fills on this session.')}
            </p>
          )}
          {!!report.automation.attempts.length && (
            <>
              <h3>{t('自動化嘗試', 'Automation attempts')}</h3>
              <ul className="agent-report-list">
                {report.automation.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    <strong>{attempt.mandate_name || attempt.mandate_id}</strong> · {attempt.status}
                    {attempt.reason_code ? ` · ${attempt.reason_code}` : ''}
                    {attempt.reason ? ` · ${attempt.reason}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          <details className="agent-method">
            <summary>{t('提醒與方法', 'Warnings and method')}</summary>
            <ul className="agent-report-list">
              {report.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p className="agent-report-meta">{report.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
