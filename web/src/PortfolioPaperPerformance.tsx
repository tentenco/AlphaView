import { useEffect, useId, useRef, useState } from 'react'
import type { Locale } from './locale'
import type { PaperSnapshot } from './paper-model'
import { api, dateTime, money, num } from './ui'
import {
  navChartData,
  type PaperNavCapture,
  type PaperNavCoverage,
  type PaperNavPoint,
  type PaperNavReport,
  type PaperNavSummary,
  type PaperMetrics,
} from './paper-performance'
import './paper-performance.css'

type Translate = (zh: string, en: string) => string
type Props = { snapshot: PaperSnapshot; locale: Locale; onCaptured?: () => void }
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value, 2)}%`)
const axisNumber = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: Math.abs(value) >= 100000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 2,
  }).format(value)
const navStatus = (status: PaperNavPoint['status'], t: Translate) =>
  ({
    complete: t('完整觀測', 'Complete observation'),
    incomplete: t('已保存，但缺價格', 'Captured, missing prices'),
    not_captured: t('未擷取', 'Not captured'),
  })[status]
function coverageLabel(coverage: PaperNavCoverage | null, t: Translate) {
  if (!coverage) return '—'
  return coverage.required === 0
    ? t('全現金，無報價需求', 'All cash; no quotes required')
    : `${coverage.priced}/${coverage.required}`
}
function unavailableReason(summary: PaperNavSummary, t: Translate) {
  if (!summary.observed_sessions)
    return t('尚未擷取虛擬帳戶淨值。', 'No paper NAV has been captured yet.')
  if (summary.missing_count)
    return t(
      '觀察區間含缺價或未擷取交易日，區間報酬與最大回落保留空值。',
      'The observation window contains missing prices or uncaptured sessions. Period return and maximum drawdown remain unavailable.',
    )
  return t(
    summary.reason || '至少需要兩個相鄰且完整的交易日觀測。',
    'At least two consecutive complete trading-session observations are required.',
  )
}
function errorLabel(message: string, t: Translate) {
  return t(
    message,
    /[\u3400-\u9fff]/.test(message)
      ? 'The account or market inputs may have changed. Refresh the paper account and retry.'
      : message,
  )
}

export function PortfolioPaperPerformance(props: Props) {
  return <PaperPerformanceAccount key={props.snapshot.account.id} {...props} />
}

function PaperPerformanceAccount({ snapshot, locale, onCaptured }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [windowSessions, setWindowSessions] = useState(252)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ key: string; report: PaperNavReport } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [captureError, setCaptureError] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [capture, setCapture] = useState<PaperNavCapture | null>(null)
  const [allRows, setAllRows] = useState(false)
  const captureRequest = useRef<AbortController | null>(null)
  const requestKey = JSON.stringify([
    snapshot.account.id,
    snapshot.account.version,
    snapshot.input_revision,
    snapshot.as_of,
    windowSessions,
  ])
  const report = result?.key === requestKey ? result.report : null
  const accountCurrent =
    !!report &&
    report.account_version === snapshot.account.version &&
    report.input_revision === snapshot.input_revision &&
    report.as_of === snapshot.as_of

  useEffect(() => () => captureRequest.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    api<PaperNavReport>(
      `/api/paper/accounts/${encodeURIComponent(snapshot.account.id)}/nav?window_sessions=${windowSessions}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, report: data })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [requestKey, refresh, snapshot.account.id, windowSessions])

  async function captureNow() {
    if (captureRequest.current || loading || !accountCurrent) return
    const controller = new AbortController()
    captureRequest.current = controller
    setCapturing(true)
    setCaptureError('')
    setCapture(null)
    try {
      const data = await api<PaperNavCapture>(
        `/api/paper/accounts/${encodeURIComponent(snapshot.account.id)}/nav/capture`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            expected_version: snapshot.account.version,
            expected_input_revision: snapshot.input_revision,
          }),
        },
      )
      if (controller.signal.aborted) return
      setCapture(data)
      setRefresh((value) => value + 1)
      onCaptured?.()
    } catch (err) {
      if (!controller.signal.aborted)
        setCaptureError(err instanceof Error ? err.message : String(err))
    } finally {
      if (captureRequest.current === controller) captureRequest.current = null
      if (!controller.signal.aborted) setCapturing(false)
    }
  }

  const rows = report ? [...(allRows ? report.series : report.series.slice(-12))].reverse() : []
  return (
    <div className="paper-performance">
      <section className="agent-panel" aria-label={t('紙上淨值觀測', 'Paper NAV observations')}>
        <div className="paper-nav-heading">
          <div>
            <div className="eyebrow">{t('紙上績效', 'PAPER PERFORMANCE')}</div>
            <h2>{t('累積實際保存的紙上觀測', 'Build a record of captured paper observations')}</h2>
            <p>
              {t(
                '按下擷取才會保存當時的帳戶淨值；重新整理只讀取紀錄。不從今日持倉倒推過去，也不補齊缺少的交易日。',
                'Capture saves the account NAV as observed at that time; refreshing only reads records. Past NAV is never reconstructed from today’s holdings, and missing sessions are never filled in.',
              )}
            </p>
          </div>
        </div>
        <div className="paper-nav-controls">
          <label className="agent-field">
            {t('觀察窗口', 'Observation window')}
            <select
              value={windowSessions}
              onChange={(event) => {
                setWindowSessions(Number(event.target.value))
                setAllRows(false)
              }}
            >
              {[20, 60, 252, 756].map((days) => (
                <option key={days} value={days}>
                  {days} {t('個交易日', 'trading sessions')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={loading || capturing}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('重新整理觀測', 'Refresh observations')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={loading || capturing || !accountCurrent}
            onClick={() => void captureNow()}
          >
            {capturing
              ? t('擷取中…', 'Capturing…')
              : t('擷取目前紙上淨值', 'Capture current paper NAV')}
          </button>
        </div>
        <p>
          {t('最新已完成交易日', 'Latest completed session')} <strong>{snapshot.as_of}</strong> ·{' '}
          {t('帳戶版本', 'Account version')} {snapshot.account.version}
        </p>
        {loading && <p role="status">{t('載入觀測紀錄…', 'Loading observations…')}</p>}
        {loadError && (
          <p className="error-message" role="alert">
            {errorLabel(loadError, t)}
          </p>
        )}
        {captureError && (
          <p className="error-message" role="alert">
            {errorLabel(captureError, t)}
          </p>
        )}
        {report && !accountCurrent && (
          <p className="notice">
            {t(
              '帳戶或行情版本已更新。請先重新載入帳戶，再擷取此刻的淨值。',
              'The account or market data version changed. Reload the paper account before capturing its current NAV.',
            )}
          </p>
        )}
        {capture && (
          <p className="paper-nav-receipt" role="status">
            {capture.created
              ? t('已保存新的淨值觀測。', 'A new NAV observation was saved.')
              : t(
                  '相同帳戶與資料版本的觀測已存在，沿用原紀錄。',
                  'An observation for these account and data versions already exists; the original record is retained.',
                )}{' '}
            {!capture.snapshot.valuation_complete &&
              t(
                '此觀測缺少價格，淨值保持不可用。',
                'This observation has missing prices; its NAV remains unavailable.',
              )}{' '}
            <span>
              {capture.snapshot.as_of} · #{capture.snapshot.id} ·{' '}
              {dateTime(capture.snapshot.observed_at)}
            </span>
          </p>
        )}
        {report && (
          <>
            <div className="paper-nav-metrics">
              <Metric
                label={t('目前紙上淨值', 'Current paper NAV')}
                value={money(report.current.valuation_complete ? report.current.equity : null)}
                detail={`${t('價格覆蓋', 'Quote coverage')}: ${coverageLabel(report.current.coverage, t)}`}
              />
              <Metric
                label={t('自初始資金累計報酬', 'Return since initial funding')}
                value={percent(
                  report.current.valuation_complete ? report.current.total_return_pct : null,
                )}
                detail={t(
                  '目前完整淨值相對初始虛擬資金',
                  'Current complete NAV versus initial virtual cash',
                )}
              />
              <Metric
                label={t('觀察區間報酬', 'Observation-window return')}
                value={percent(
                  report.summary.performance_available ? report.summary.period_return_pct : null,
                )}
                detail={t('僅完整且相鄰的交易日區間', 'Requires complete consecutive sessions')}
              />
              <Metric
                label={t('觀察最大回落', 'Observed maximum drawdown')}
                value={percent(
                  report.summary.performance_available ? report.summary.max_drawdown_pct : null,
                )}
                detail={t(
                  '已觀測日淨值的峰值至谷值，非盤中',
                  'Peak-to-trough observed daily NAV, not intraday',
                )}
              />
            </div>
            {!report.current.valuation_complete && (
              <p className="notice">
                {t(
                  '目前估值不完整；不以部分持股估值代替總淨值。缺少價格：',
                  'Current valuation is incomplete; partial holdings are not treated as total NAV. Missing prices: ',
                )}
                {report.current.coverage.missing.join(' · ') || '—'}
              </p>
            )}
            {!report.summary.performance_available && (
              <p className="notice">{unavailableReason(report.summary, t)}</p>
            )}
            <div className="agent-preview-stats">
              <span>
                {t('已保存交易日', 'Captured sessions')}{' '}
                <strong>
                  {report.summary.captured_count}/{report.summary.observed_sessions}
                </strong>
              </span>
              <span>
                {t('完整觀測', 'Complete observations')}{' '}
                <strong>{report.summary.complete_count}</strong>
              </span>
              <span>
                {t('缺價或未擷取', 'Missing or uncaptured')}{' '}
                <strong>{report.summary.missing_count}</strong>
              </span>
            </div>
            {report.metrics && <PaperMetricsPanel metrics={report.metrics} t={t} />}
            <PaperNavChart series={report.series} t={t} />
            <p>
              {t('觀察範圍', 'Observation range')}: {report.summary.start || '—'} →{' '}
              {report.summary.end || '—'}.{' '}
              {t(
                '同日多次擷取採最後一筆。圖表保留缺口，縱軸依觀測範圍調整。',
                'The latest capture is used for each session. Chart gaps remain visible; the vertical axis follows the observed range.',
              )}
            </p>
            {report.summary.truncated && (
              <p className="notice">
                {t(
                  '顯示的是所選窗口內資料，較早觀測不納入此區間指標。',
                  'Only the selected observation window is shown; earlier records are excluded from these period metrics.',
                )}
              </p>
            )}
          </>
        )}
      </section>

      {report && (
        <>
          <section
            className="agent-panel"
            aria-label={t('模擬成本與活動', 'Paper costs and activity')}
          >
            <h2>{t('模擬成本與活動', 'Paper costs and activity')}</h2>
            <p>
              {t(
                '以下從帳戶建立以來累積，不受上方觀察窗口影響。周轉率為各次已接受提案的總換手比例相加，沒有年化。',
                'These totals cover the account’s lifetime and do not change with the observation window. Turnover is the sum of accepted-proposal gross turnover percentages; it is not annualized.',
              )}
            </p>
            <div className="paper-nav-metrics">
              <Metric
                label={t('累計模擬費用', 'Cumulative simulated fees')}
                value={money(report.costs.fees_total)}
              />
              <Metric
                label={t('累計模擬滑價', 'Cumulative simulated slippage')}
                value={money(report.costs.slippage_total)}
              />
              <Metric
                label={t('費用與滑價合計', 'Fees plus slippage')}
                value={money(report.costs.cost_total)}
              />
              <Metric
                label={t('總換手比例累加', 'Sum of gross turnover')}
                value={percent(report.costs.turnover_pct_sum)}
              />
            </div>
            <div className="agent-preview-stats">
              <span>
                {t('模擬成交筆數', 'Simulated fills')}{' '}
                <strong>{report.costs.simulated_fill_count}</strong>
              </span>
              <span>
                {t('增加部位名目金額', 'Buy notional')}{' '}
                <strong>{money(report.costs.buy_notional)}</strong>
              </span>
              <span>
                {t('減少部位名目金額', 'Sell notional')}{' '}
                <strong>{money(report.costs.sell_notional)}</strong>
              </span>
            </div>
          </section>
          <section
            className="agent-panel"
            aria-label={t('每日觀測明細', 'Daily observation details')}
          >
            <h2>{t('每日觀測明細', 'Daily observation details')}</h2>
            <p>
              {t(
                '新到舊排列。日報酬只在相鄰兩個交易日均有完整觀測時顯示；未保存、缺價格與零報酬是不同狀態。',
                'Newest sessions first. Daily returns require complete observations on consecutive trading sessions; uncaptured, missing-price and zero-return states remain distinct.',
              )}
            </p>
            {rows.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('交易日', 'Session')}</th>
                      <th>{t('狀態', 'Status')}</th>
                      <th>{t('紙上淨值', 'Paper NAV')}</th>
                      <th>{t('相鄰日報酬', 'Consecutive-session return')}</th>
                      <th>{t('價格覆蓋', 'Quote coverage')}</th>
                      <th>{t('擷取時間', 'Captured at')}</th>
                      <th>{t('帳戶版本', 'Account version')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((point) => (
                      <tr key={point.as_of}>
                        <td>{point.as_of}</td>
                        <td>{navStatus(point.status, t)}</td>
                        <td>{money(point.status === 'complete' ? point.equity : null)}</td>
                        <td>{percent(point.return_pct)}</td>
                        <td>
                          {coverageLabel(point.coverage, t)}
                          {!!point.coverage?.missing.length && (
                            <small>{point.coverage.missing.join(' · ')}</small>
                          )}
                        </td>
                        <td>
                          {point.observed_at ? dateTime(point.observed_at) : '—'}
                          {point.snapshot_id != null && <small>#{point.snapshot_id}</small>}
                        </td>
                        <td>{point.account_version ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="agent-empty">
                {t(
                  '擷取第一筆觀測後，這裡會開始累積紀錄。',
                  'Capture the first observation to begin this record.',
                )}
              </p>
            )}
            {report.series.length > 12 && (
              <button
                type="button"
                className="button"
                onClick={() => setAllRows((value) => !value)}
              >
                {allRows
                  ? t('只顯示最近 12 個交易日', 'Show only the latest 12 sessions')
                  : t(
                      `顯示窗口內 ${report.series.length} 個交易日`,
                      `Show all ${report.series.length} sessions in the window`,
                    )}
              </button>
            )}
            <details className="agent-method">
              <summary>{t('績效口徑與限制', 'Performance method and limitations')}</summary>
              <p>
                {t(
                  report.method,
                  'NAV records the paper account and valid local unadjusted closes only when explicitly captured. Records are immutable; each session uses its latest capture. Missing prices and uncaptured sessions remain gaps. Period return and maximum drawdown require a complete daily observation window. The account has initial virtual funding only; there are no subsequent external cash flows.',
                )}
              </p>
              <p>
                {t(
                  '這是已保存的虛擬帳戶觀測，不是完整歷史回測或真實績效。模擬費用與滑價依帳戶設定；不含稅、股息及拆併股自動調整。',
                  'These are captured paper-account observations, not a complete historical backtest or actual returns. Fees and slippage follow account settings; taxes, dividends and automatic split adjustments are not included.',
                )}
              </p>
              <small>
                {report.engine_version} · {report.current.paper_engine_version} ·{' '}
                {report.input_revision}
              </small>
            </details>
          </section>
        </>
      )}
    </div>
  )
}

const METRIC_REASONS: Record<string, [string, string]> = {
  benchmark_unavailable: [
    '基準價格覆蓋不足，不用鄰近價填補',
    'Benchmark prices are incomplete; nothing is filled',
  ],
  zero_volatility: ['日報酬無波動', 'Daily returns have zero volatility'],
  no_downside_observations: [
    '沒有負報酬日，無下方偏差',
    'No negative days, so no downside deviation',
  ],
  no_drawdown: ['沒有回落', 'No drawdown observed'],
  insufficient_returns: ['日報酬樣本不足', 'Not enough daily returns'],
  benchmark_zero_variance: ['基準無波動', 'Benchmark has zero variance'],
  zero_tracking_error: ['超額報酬無波動', 'Excess returns have zero variance'],
  valuation_incomplete: ['目前估值不完整', 'Current valuation is incomplete'],
  overflow: ['數值溢位', 'Numeric overflow'],
}
const ratio = (value: number | null | undefined) => (value == null ? '—' : num(value, 2))
function reasonText(code: string | undefined, t: Translate) {
  if (!code) return ''
  const pair = METRIC_REASONS[code]
  return pair ? t(pair[0], pair[1]) : code
}
function PaperMetricsPanel({ metrics, t }: { metrics: PaperMetrics; t: Translate }) {
  const stat = (label: string, value: string, reason?: string) => (
    <span key={label} title={reasonText(reason, t) || undefined}>
      {label} <strong>{value}</strong>
      {reason && <small> · {reasonText(reason, t)}</small>}
    </span>
  )
  return (
    <section
      className="paper-metrics"
      aria-label={t('進階績效指標', 'Advanced performance metrics')}
    >
      <h3>
        {t('進階績效指標', 'Advanced performance metrics')} <small>{metrics.method_version}</small>
      </h3>
      {!metrics.available && (
        <p className="notice">
          {t('進階指標不可用：', 'Advanced metrics unavailable: ')}
          {metrics.reason}
        </p>
      )}
      {metrics.available && metrics.risk && metrics.drawdown && (
        <>
          {metrics.low_sample && (
            <p className="notice">
              {t(
                `日報酬樣本只有 ${metrics.returns_n} 筆（少於 20），年化指標與比率只供參考。`,
                `Only ${metrics.returns_n} daily returns (fewer than 20); annualised figures and ratios are indicative only.`,
              )}
            </p>
          )}
          <div className="agent-preview-stats">
            {stat(t('日報酬樣本', 'Daily returns'), String(metrics.returns_n))}
            {stat(
              t('年化報酬', 'Annualised return'),
              percent(metrics.risk.annualized_return_pct),
              metrics.risk.reasons.annualized_return_pct,
            )}
            {stat(
              t('年化波動', 'Annualised volatility'),
              percent(metrics.risk.annualized_volatility_pct),
              metrics.risk.reasons.annualized_volatility_pct,
            )}
            {stat('Sharpe', ratio(metrics.risk.sharpe), metrics.risk.reasons.sharpe)}
            {stat('Sortino', ratio(metrics.risk.sortino), metrics.risk.reasons.sortino)}
            {stat('Calmar', ratio(metrics.risk.calmar), metrics.risk.reasons.calmar)}
            {stat(
              t('最佳／最差單日', 'Best / worst day'),
              `${percent(metrics.risk.best_day_pct)} / ${percent(metrics.risk.worst_day_pct)}`,
            )}
            {stat(
              t('正／負報酬日', 'Up / down days'),
              `${metrics.risk.positive_days} / ${metrics.risk.negative_days}`,
            )}
            {stat(
              t('最長水下期間', 'Longest underwater'),
              `${metrics.drawdown.longest_underwater_sessions} ${t('個交易日', 'sessions')}${metrics.drawdown.underwater_ongoing ? t('（進行中）', ' (ongoing)') : ''}`,
            )}
            {stat(
              t('目前回落', 'Current drawdown'),
              percent(metrics.drawdown.current_drawdown_pct),
            )}
          </div>
          <div className="agent-preview-stats">
            {metrics.benchmark?.available ? (
              <>
                {stat(
                  t(
                    `基準 ${metrics.benchmark.symbol} 區間報酬`,
                    `${metrics.benchmark.symbol} window return`,
                  ),
                  percent(metrics.benchmark.period_return_pct),
                )}
                {stat(t('超額報酬', 'Excess return'), percent(metrics.benchmark.excess_return_pct))}
                {stat('Beta', ratio(metrics.benchmark.beta), metrics.benchmark.reasons.beta)}
                {stat(t('相關係數', 'Correlation'), ratio(metrics.benchmark.correlation))}
                {stat(
                  t('追蹤誤差', 'Tracking error'),
                  percent(metrics.benchmark.tracking_error_pct),
                )}
                {stat(
                  t('資訊比率', 'Information ratio'),
                  ratio(metrics.benchmark.information_ratio),
                  metrics.benchmark.reasons.information_ratio,
                )}
              </>
            ) : (
              metrics.benchmark && (
                <span>
                  {t(`基準 ${metrics.benchmark.symbol}`, `Benchmark ${metrics.benchmark.symbol}`)}{' '}
                  <strong>{reasonText(metrics.benchmark.reason, t)}</strong>
                  <small>
                    {' '}
                    · {metrics.benchmark.coverage.priced}/{metrics.benchmark.coverage.required}
                  </small>
                </span>
              )
            )}
          </div>
        </>
      )}
      <div className="agent-preview-stats">
        {stat(t('累計成本', 'Total costs'), money(metrics.costs.cost_total))}
        {stat(
          t('成本拖累（占初始資金）', 'Cost drag (of initial cash)'),
          percent(metrics.costs.cost_drag_pct_of_initial),
        )}
        {stat(
          t('淨／毛累計報酬', 'Net / gross return since funding'),
          `${percent(metrics.costs.net_return_since_funding_pct)} / ${percent(metrics.costs.gross_return_since_funding_pct)}`,
          metrics.costs.reason ?? undefined,
        )}
      </div>
      <details className="agent-method">
        <summary>
          {t('進階指標的口徑與限制', 'How these metrics are computed and their limits')}
        </summary>
        <p>{metrics.method}</p>
        <ul>
          {metrics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function PaperNavChart({ series, t }: { series: PaperNavPoint[]; t: Translate }) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const id = useId()
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(260, entry.contentRect.width))
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const data = navChartData(series)
  const height = width < 420 ? 260 : 300
  const left = width < 420 ? 65 : 80
  const right = width - 20
  const top = 26
  const bottom = height - 42
  const x = (index: number) =>
    series.length < 2 ? (left + right) / 2 : left + (index / (series.length - 1)) * (right - left)
  const y = (value: number) =>
    data.domain
      ? bottom - ((value - data.domain[0]) / (data.domain[1] - data.domain[0])) * (bottom - top)
      : bottom
  const ticks = data.domain
    ? [0, 0.5, 1].map((ratio) => data.domain![0] + ratio * (data.domain![1] - data.domain![0]))
    : []
  const dates = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])].filter(
    (index) => index >= 0,
  )
  return (
    <div className="paper-nav-chart" ref={container}>
      {data.domain ? (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
        >
          <title id={`${id}-title`}>{t('已保存紙上淨值折線圖', 'Captured paper NAV chart')}</title>
          <desc id={`${id}-description`}>
            {t(
              '橫軸為交易日，縱軸為美元淨值。缺價格或未擷取的交易日不連線；完整數值在每日觀測表中。',
              'The horizontal axis shows trading sessions; the vertical axis shows NAV in USD. Missing-price and uncaptured sessions break the line. Exact values are available in the daily observation table.',
            )}
          </desc>
          <text x={left} y={15} className="paper-nav-axis-label">
            {t('淨值（USD）', 'NAV (USD)')}
          </text>
          {ticks.map((value) => (
            <g key={value}>
              <line x1={left} x2={right} y1={y(value)} y2={y(value)} className="paper-nav-grid" />
              <text x={left - 8} y={y(value) + 4} textAnchor="end" className="paper-nav-axis-label">
                {axisNumber(value)}
              </text>
            </g>
          ))}
          <line x1={left} x2={right} y1={bottom} y2={bottom} className="paper-nav-grid" />
          {dates.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={bottom + 23}
              textAnchor={
                index === 0 && series.length > 1
                  ? 'start'
                  : index === series.length - 1 && series.length > 1
                    ? 'end'
                    : 'middle'
              }
              className="paper-nav-axis-label"
            >
              {series[index].as_of.slice(5)}
            </text>
          ))}
          {data.gaps.map((gap) => (
            <line
              key={gap.index}
              x1={x(gap.index)}
              x2={x(gap.index)}
              y1={top}
              y2={bottom}
              className="paper-nav-gap"
            >
              <title>
                {gap.as_of} · {navStatus(gap.status, t)}
              </title>
            </line>
          ))}
          {data.segments.map((segment, index) => (
            <g key={index}>
              {segment.length > 1 && (
                <polyline
                  data-nav-segment="true"
                  points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')}
                  className="paper-nav-line"
                />
              )}
              {segment.map((point) => (
                <circle
                  key={point.as_of}
                  cx={x(point.index)}
                  cy={y(point.value)}
                  r={series.length > 60 ? 2 : 3.5}
                  className="paper-nav-point"
                >
                  <title>
                    {point.as_of} · {money(point.value)}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      ) : (
        <div className="paper-nav-empty">
          {series.length
            ? t(
                '此窗口尚無完整淨值，缺口保留在每日明細。',
                'This window has no complete NAV observations. Gaps remain in the daily details.',
              )
            : t(
                '尚無觀測。從現在開始擷取，不會建立過去的假想淨值。',
                'No observations yet. Capturing begins now; it does not invent past NAV.',
              )}
        </div>
      )}
      {!!data.gaps.length && (
        <p className="paper-nav-legend">
          <span />
          {t(
            '虛線：未擷取或價格不完整的交易日',
            'Dashed lines: uncaptured sessions or incomplete prices',
          )}
        </p>
      )}
    </div>
  )
}
