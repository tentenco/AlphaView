import { useEffect, useRef, useState } from 'react'
import { Play, Download } from '@carbon/icons-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import type { AlphaSettings, Weights } from './alpha-model'
import { validAlphaSettings } from './alpha-model'
import { api, money, num } from './ui'
import { ExperimentNotebook } from './ExperimentNotebook'
import { boundedDraftString, useSessionState } from './session-state'

export type BasketResult = {
  initial: number
  final: number
  return_pct: number
  benchmark_pct: number | null
  benchmark_error: string | null
  max_drawdown_pct: number
  total_cost: number
  traded_notional: number
  exposure_days: number
  sessions: number
  start: string
  end: string
  engine_version: string
  input_revision: string
  settings: {
    scope: Scope
    days: number
    top: number
    rebalance: number
    initial: number
    fee_bps: number
    weights: Weights
    threshold: number
    min_matches: number
  }
  method: string
  curve: {
    date: string
    value: number
    cash: number
    exposure_pct: number
    benchmark: number | null
  }[]
  events: {
    signal_date: string
    trade_date: string
    selected: string[]
    orders: { symbol: string; side: string; notional: number; cost: number }[]
    cost: number
    cash: number
  }[]
  final_holdings: { symbol: string; value: number; adjusted_units: number }[]
  final_cash: number
  sources: { date: string; scan_id: number; usable: number; total: number; selected: string[] }[]
}

export function AlphaBasket({
  data,
  scope,
  settings,
  locale,
  onOpen,
  onRestoreSettings,
}: {
  data: Overview
  scope: Scope
  settings: AlphaSettings
  locale: Locale
  onOpen: (symbol: string, scope: Scope, date: string) => void
  onRestoreSettings: (settings: BasketResult['settings']) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [days, setDays] = useSessionState(
    'alphaview-basket-days-v1',
    () => 20,
    (v): v is number => typeof v === 'number' && [10, 20, 40].includes(v),
  )
  const [top, setTop] = useSessionState(
    'alphaview-basket-top-v1',
    () => 5,
    (v): v is number => typeof v === 'number' && [3, 5, 10].includes(v),
  )
  const [interval, setInterval] = useSessionState(
    'alphaview-basket-interval-v1',
    () => 5,
    (v): v is number => typeof v === 'number' && [1, 5, 10, 20].includes(v),
  )
  const [initial, setInitial] = useSessionState(
    'alphaview-basket-capital-v1',
    () => '10000',
    boundedDraftString,
  )
  const [fee, setFee] = useSessionState('alphaview-basket-fee-v1', () => '10', boundedDraftString)
  const [result, setResult] = useState<{ key: string; value: BasketResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const valid =
    validAlphaSettings(settings) &&
    initial !== '' &&
    fee !== '' &&
    Number.isFinite(Number(initial)) &&
    Number(initial) > 0 &&
    Number(initial) <= 1e9 &&
    Number.isFinite(Number(fee)) &&
    Number(fee) >= 0 &&
    Number(fee) <= 100
  const key = JSON.stringify([
    scope,
    days,
    top,
    interval,
    initial,
    fee,
    settings.weights,
    settings.threshold,
    settings.minMatches,
    data.revision,
    data.summary.expected_session,
  ])
  const current = result?.key === key ? result.value : null
  async function run() {
    if (!valid || busy) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const value = await api<BasketResult>('/api/alpha/basket', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          scope,
          days,
          top,
          rebalance: interval,
          initial: Number(initial),
          fee_bps: Number(fee),
          weights: settings.weights,
          threshold: settings.threshold,
          min_matches: settings.minMatches,
        }),
      })
      if (!controller.signal.aborted) {
        setResult({ key, value })
        setSelectedEvent(null)
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  function download() {
    if (!current) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `alphaview-basket-${scope}-${current.end}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section className="alpha-basket">
      <div className="section-heading">
        <div>
          <h2>{t('跨策略組合實驗', 'Cross-strategy Basket Experiment')}</h2>
          <p>
            {t(
              '把 Alpha 清單組成一個假設等權重組合，觀察定期調整與成本的影響。',
              'Form a hypothetical equal-weight basket from Alpha rankings and examine the effect of rebalancing and costs.',
            )}
          </p>
        </div>
      </div>
      <div className="alpha-basket-inputs">
        <label>
          {t('最近交易日數', 'Recent Trading Sessions')}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[10, 20, 40].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('最多持有檔數', 'Maximum Basket Size')}
          <select value={top} onChange={(e) => setTop(Number(e.target.value))}>
            {[3, 5, 10].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('調整間隔（交易日）', 'Rebalance Interval (Sessions)')}
          <select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
            {[1, 5, 10, 20].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('假設起始資金 USD', 'Hypothetical Initial Capital USD')}
          <input
            type="number"
            min={1}
            max={1e9}
            value={initial}
            onChange={(e) => setInitial(e.target.value)}
          />
        </label>
        <label>
          {t('單邊成本 bps', 'One-way Cost bps')}
          <input
            type="number"
            min={0}
            max={100}
            step="any"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </label>
      </div>
      <div className="actions">
        <button className="button primary" disabled={!valid || busy} onClick={() => void run()}>
          <Play size={15} />
          {busy ? t('模擬中…', 'Simulating…') : t('執行組合實驗', 'Run Basket Experiment')}
        </button>
        <small>
          {t('10 bps = 0.1%；不會下單或修改持倉。', '10 bps = 0.1%; no orders or holding changes.')}
        </small>
      </div>
      {!valid && (
        <p role="alert">
          {t(
            '起始資金須大於零且不超過 10 億；成本須介於 0–100 bps。',
            'Initial capital must be above zero and at most 1 billion; cost must be 0–100 bps.',
          )}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {result && !current && (
        <p className="notice">
          {t(
            '參數、研究權重或輸入資料已變更，請重新執行。',
            'Parameters, weights, or inputs changed. Run the experiment again.',
          )}
        </p>
      )}
      {current && (
        <>
          <div className="alpha-basket-result-heading">
            <strong>
              {current.start} → {current.end}
            </strong>
            <span>
              {current.sessions} {t('交易日', 'sessions')} · {current.events.length}{' '}
              {t('次配置檢查', 'allocation checks')}
            </span>
            <button className="text-button" onClick={download}>
              <Download size={15} />
              {t('匯出完整實驗', 'Export Full Experiment')}
            </button>
          </div>
          <div className="alpha-stats">
            <div>
              <small>{t('模擬區間報酬', 'Simulated Period Return')}</small>
              <strong className={current.return_pct >= 0 ? 'positive' : 'negative'}>
                {num(current.return_pct, 2)}
                <span>%</span>
              </strong>
              <p>{t('含指定單邊成本', 'Includes specified one-way costs')}</p>
            </div>
            <div>
              <small>{t('初始組合買入持有', 'Initial Basket Buy & Hold')}</small>
              <strong>
                {num(current.benchmark_pct, 2)}
                <span>%</span>
              </strong>
              <p>
                {t('同起點與買入成本，之後不調整', 'Same opening and entry costs; no rebalancing')}
              </p>
            </div>
            <div>
              <small>{t('最大日末回撤', 'Maximum Daily-close Drawdown')}</small>
              <strong>
                {num(current.max_drawdown_pct, 2)}
                <span>%</span>
              </strong>
              <p>
                {t(
                  '從起始資金與歷次日末高點計算',
                  'From initial capital and running daily-close peaks',
                )}
              </p>
            </div>
            <div>
              <small>{t('模擬總成本', 'Total Simulated Costs')}</small>
              <strong>{money(current.total_cost)}</strong>
              <p>
                {t('有持倉日數', 'Invested sessions')} {current.exposure_days}/{current.sessions}
              </p>
            </div>
          </div>
          {current.benchmark_error && (
            <p className="notice">
              {t('初始組合基準不可用：', 'Initial-basket benchmark unavailable: ')}
              {current.benchmark_error}
            </p>
          )}
          <div className="alpha-basket-legend">
            <span>
              <i />
              {t('定期配置 Alpha 組合', 'Rebalanced Alpha Basket')}
            </span>
            <span>
              <i />
              {t('初始組合買入持有（非大盤）', 'Initial Basket Buy & Hold (Not a Market Index)')}
            </span>
          </div>
          <div
            className="alpha-basket-chart"
            role="img"
            aria-label={t(
              '組合實驗資產曲線，精確數值可於下方每日資料查看',
              'Basket experiment equity curves; exact values are available in the daily data below',
            )}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={current.curve} margin={{ top: 15, right: 15, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => String(value).slice(5)}
                  tick={{ fill: 'var(--muted)', fontSize: 'var(--type-meta)' }}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(value) => num(Number(value), 0)}
                  tick={{ fill: 'var(--muted)', fontSize: 'var(--type-meta)' }}
                  domain={['auto', 'auto']}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    fontSize: 'var(--type-body)',
                  }}
                  formatter={(value) => money(Number(value))}
                />
                <Line
                  name={t('Alpha 組合', 'Alpha Basket')}
                  dataKey="value"
                  stroke="var(--positive)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  name={t('初始組合買入持有', 'Initial Basket Buy & Hold')}
                  dataKey="benchmark"
                  stroke="var(--blue)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <h3>{t('配置紀錄', 'Allocation Log')}</h3>
          <p className="footnote">
            {t(
              '收盤後確認訊號，在下一交易日開盤調整；只交易新舊配置的淨差額。點開一列可核對買賣金額與成本。',
              'Signals are confirmed after close and traded at the next session’s open. Only net allocation differences are traded. Expand a row to inspect notionals and costs.',
            )}
          </p>
          <div className="alpha-allocation-log">
            {current.events.map((event) => (
              <div key={event.trade_date}>
                <button
                  className="alpha-allocation-row"
                  aria-expanded={selectedEvent === event.trade_date}
                  onClick={() =>
                    setSelectedEvent(selectedEvent === event.trade_date ? null : event.trade_date)
                  }
                >
                  <span>
                    <b>{event.trade_date}</b>
                    <small>
                      {t('訊號', 'Signal')} {event.signal_date}
                    </small>
                  </span>
                  <span>{event.selected.join(' · ') || t('現金', 'Cash')}</span>
                  <span>
                    {event.orders.length} {t('筆調整', 'adjustments')} · {money(event.cost)}
                  </span>
                </button>
                {selectedEvent === event.trade_date && (
                  <div className="alpha-allocation-detail">
                    {event.orders.length ? (
                      event.orders.map((order) => (
                        <div key={order.symbol}>
                          <b>{order.symbol}</b>
                          <span>
                            {order.side === 'buy' ? t('增加', 'Add') : t('減少', 'Reduce')}
                          </span>
                          <span>{money(order.notional)}</span>
                          <small>
                            {t('成本', 'Cost')} {money(order.cost)}
                          </small>
                        </div>
                      ))
                    ) : (
                      <p>
                        {t(
                          '目標配置未改變，無需交易。',
                          'Target allocation unchanged; no trades needed.',
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <details className="alpha-method">
            <summary>
              {t('期末模擬配置與每日資料', 'Final Simulated Allocation & Daily Data')}
            </summary>
            <div className="alpha-final-basket">
              {current.final_holdings.map((item) => (
                <button
                  className="text-button"
                  key={item.symbol}
                  onClick={() => onOpen(item.symbol, scope, current.end)}
                >
                  <b>{item.symbol}</b>
                  {money(item.value)} · {num((item.value / current.final) * 100, 1)}%
                </button>
              ))}
              <span>
                {t('現金', 'Cash')} {money(current.final_cash)}
              </span>
            </div>
            <div className="alpha-persistence-scroll">
              <table className="alpha-persistence">
                <thead>
                  <tr>
                    {[
                      t('日期', 'Date'),
                      t('Alpha 組合', 'Alpha Basket'),
                      t('初始組合基準', 'Initial Basket'),
                      t('現金', 'Cash'),
                      t('股票曝險 %', 'Stock Exposure %'),
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.curve.map((point) => (
                    <tr key={point.date}>
                      <td>{point.date}</td>
                      <td>{money(point.value)}</td>
                      <td>{money(point.benchmark)}</td>
                      <td>{money(point.cash)}</td>
                      <td>{num(point.exposure_pct, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="footnote">
            {t('各次訊號可用資料：', 'Signal-date data coverage: ')}
            {current.sources
              .map((source) => `${source.date} ${source.usable}/${source.total}`)
              .join(' · ')}
          </p>
        </>
      )}
      <ExperimentNotebook
        current={current}
        locale={locale}
        onRestore={(saved) => {
          setDays(saved.days)
          setTop(saved.top)
          setInterval(saved.rebalance)
          setInitial(String(saved.initial))
          setFee(String(saved.fee_bps))
          onRestoreSettings(saved)
        }}
      />
      <details className="alpha-method">
        <summary>{t('組合實驗的計算假設', 'Basket Experiment Assumptions')}</summary>
        <p>
          {t(
            '以目前股票池回看過去，每次取符合 Alpha 條件的前 N 檔，按成本後資產等權重配置。名額不足時只配置符合者；沒有符合者則持有現金。非調整日保持原單位，不會每天隱性調回等權重。',
            'Using the current universe retrospectively, each rebalance takes the top N Alpha-eligible symbols and equal-weights post-cost equity. Fewer matches use fewer names; no matches hold cash. Units stay fixed between rebalances, with no hidden daily equal-weighting.',
          )}
        </p>
        <p>
          {t(
            '採調整開盤／收盤價與可分割的調整單位；不是券商實際股數。單邊成本對每筆淨交易金額收取，現金利息為零；期末保留持倉市值，不強制賣出。基準買入最初相同清單並持有，未使用 SPY 或其他外部大盤基準。',
            'Uses adjusted open/close prices and fractional adjusted units, not broker share counts. One-way costs apply to each net trade; cash earns zero. Final holdings are marked to close without forced liquidation. The baseline buys and holds the first selected list; no SPY or other external market benchmark is used.',
          )}
        </p>
        <p>
          {t(
            '這是短期間、目前股票池的假設模型，不是你的實際績效，也不是歷史全市場回測。存在存活者偏差、選樣偏差與資料修訂；缺少必要成交或估值價格會停止模擬，不偷偷替換股票或補價。',
            'This is a short-window, current-universe hypothetical model, not your actual performance or a historical whole-market backtest. Survivorship, selection bias, and data revisions apply. Missing required execution or valuation prices stop the simulation rather than substituting symbols or prices.',
          )}
        </p>
      </details>
    </section>
  )
}
