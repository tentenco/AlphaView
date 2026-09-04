import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Play, Checkmark } from '@carbon/icons-react'
import type { Backtest, Overview, StockDetail, Scope } from './types'
import { api, Badge, dateTime, Delta, Modal, money, num } from './ui'
import { EquityChart, PriceChart } from './Charts'
import { ResearchNotes } from './ResearchNotes'

export function Strategies({ data }: { data: Overview }) {
  const members = [
    ...data.positions,
    ...data.market_universe.filter((m) => !data.positions.some((p) => p.symbol === m.symbol)),
  ]
  const [selected, setSelected] = useState('turtle')
  const [symbol, setSymbol] = useState(
    () => members.find((p) => p.symbol === 'NVDA')?.symbol || members[0]?.symbol || '',
  )
  const [strategy, setStrategy] = useState('turtle')
  const [initial, setInitial] = useState('10000')
  const [feeBps, setFeeBps] = useState('10')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const optionsError =
    !Number.isFinite(Number(initial)) || Number(initial) <= 0
      ? '起始資金必須大於 0。'
      : feeBps === '' ||
          !Number.isFinite(Number(feeBps)) ||
          Number(feeBps) < 0 ||
          Number(feeBps) > 100
        ? '單邊交易成本須介於 0 至 100 bps。'
        : startDate && endDate && startDate > endDate
          ? '開始日期不可晚於結束日期。'
          : ''
  const [result, setResult] = useState<Backtest | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  useEffect(() => {
    if (!members.some((p) => p.symbol === symbol)) setSymbol(members[0]?.symbol || '')
  }, [symbol, members.map((p) => p.symbol).join(',')])
  useEffect(() => {
    controller.current?.abort()
    const current = ++request.current
    const pending = new AbortController()
    controller.current = pending
    submitting.current = false
    setBusy(false)
    setResult(null)
    setError('')
    setLoading(!!symbol && !optionsError)
    const params = new URLSearchParams({ initial, fee_bps: feeBps })
    if (startDate) params.set('start_date', startDate)
    if (endDate) params.set('end_date', endDate)
    if (symbol && !optionsError)
      api<Backtest | null>(`/api/backtest/${symbol}/${strategy}?${params}`, {
        signal: pending.signal,
      })
        .then((r) => {
          if (current === request.current) setResult(r)
        })
        .catch((e) => {
          if (current === request.current && !pending.signal.aborted) setError(e.message)
        })
        .finally(() => {
          if (current === request.current) setLoading(false)
        })
    return () => {
      pending.abort()
      if (current === request.current) request.current++
    }
  }, [symbol, strategy, initial, feeBps, startDate, endDate, optionsError])
  useEffect(
    () => () => {
      controller.current?.abort()
      request.current++
    },
    [],
  )
  async function runBacktest() {
    if (submitting.current || !symbol || optionsError) return
    submitting.current = true
    controller.current?.abort()
    const current = ++request.current
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    setLoading(false)
    setError('')
    setResult(null)
    try {
      const next = await api<Backtest>('/api/backtest', {
        method: 'POST',
        signal: pending.signal,
        body: JSON.stringify({
          symbol,
          strategy,
          initial: Number(initial),
          fee_bps: Number(feeBps),
          start_date: startDate || null,
          end_date: endDate || null,
        }),
      })
      if (current === request.current) setResult(next)
    } catch (err) {
      if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
    } finally {
      if (current === request.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  const active = data.strategies.find((s) => s.id === selected)!
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">Strategy lab</div>
          <h1>策略研究</h1>
          <p>理解規則，再用歷史資料驗證想法。</p>
        </div>
        <span className="quiet-label">AlphaView · 美股研究版</span>
      </div>
      <div className="strategy-layout">
        <div className="strategy-menu">
          {data.strategies.map((s, i) => (
            <button
              type="button"
              key={s.id}
              className={s.id === selected ? 'selected' : ''}
              disabled={busy}
              onClick={() => {
                setSelected(s.id)
                if (s.id !== 'rps') {
                  setStrategy(s.id)
                }
              }}
            >
              <span className="strategy-number">0{i + 1}</span>
              <div>
                <strong>{s.name}</strong>
                <small>{s.english}</small>
              </div>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
        <div className="strategy-detail">
          <div className="section-heading">
            <div>
              <h2>{active.name}</h2>
              <p>{active.description}</p>
            </div>
            <span className="badge neutral">至少 {active.period} 日</span>
          </div>
          <ul role="list" className="rules-list">
            {active.rules.map((rule) => (
              <li key={rule}>
                <Checkmark size={16} />
                {rule}
              </li>
            ))}
          </ul>
          <div className="footnote">{active.origin}</div>
        </div>
      </div>
      <section className="backtest-section">
        <div className="section-heading">
          <div>
            <h2>歷史回測</h2>
            <p>設定資金、成本與日期，比較策略與買入持有。</p>
          </div>
          <span className="quiet-label">單一標的 · 僅做多</span>
        </div>
        <form
          className="backtest-form"
          style={{ flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault()
            void runBacktest()
          }}
        >
          <label>
            研究標的
            <select
              disabled={busy}
              name="backtest-symbol"
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value)
                setResult(null)
              }}
            >
              {!members.length && <option value="">尚無可研究標的</option>}
              {members.map((p) => (
                <option key={p.symbol} value={p.symbol}>
                  {p.symbol} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            交易策略
            <select
              disabled={busy}
              name="backtest-strategy"
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value)
                setResult(null)
              }}
            >
              {data.strategies
                .filter((s) => s.id !== 'rps')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            起始資金（USD）
            <input
              name="backtest-initial"
              type="number"
              min="0"
              step="any"
              required
              disabled={busy}
              value={initial}
              onChange={(event) => setInitial(event.target.value)}
            />
          </label>
          <label>
            單邊交易成本（bps）
            <input
              name="backtest-fee"
              type="number"
              min="0"
              max="100"
              step="any"
              required
              disabled={busy}
              value={feeBps}
              onChange={(event) => setFeeBps(event.target.value)}
            />
          </label>
          <label>
            開始日期（選填）
            <input
              name="backtest-start"
              type="date"
              disabled={busy}
              value={startDate}
              max={endDate || undefined}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            結束日期（選填）
            <input
              name="backtest-end"
              type="date"
              disabled={busy}
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !symbol || !!optionsError}
          >
            <Play size={16} />
            {busy ? '回測中…' : '執行回測'}
          </button>
        </form>
        {optionsError && (
          <div role="alert" className="error-message">
            {optionsError}
          </div>
        )}
        {error && (
          <div role="alert" className="error-message">
            {error}
          </div>
        )}
        {result ? (
          <>
            <div className="backtest-meta">
              {result.symbol} · {data.strategies.find((s) => s.id === result.strategy)?.name} ·{' '}
              {result.start} — {result.end} · {dateTime(result.created_at)} 計算 · 起始資金{' '}
              {money(result.initial)}
              {result.parameters && <> · 單邊 {num(result.parameters.fee_bps)} bps</>}
            </div>
            <div className="metrics compact">
              <div>
                <p>策略報酬</p>
                <h2>
                  <Delta value={result.return_pct} />
                </h2>
              </div>
              <div>
                <p>買入持有</p>
                <h2>
                  <Delta value={result.benchmark_pct} />
                </h2>
              </div>
              <div>
                <p>最大回撤</p>
                <h2>
                  <Delta value={result.max_drawdown_pct} />
                </h2>
              </div>
              <div>
                <p>已平倉交易</p>
                <h2>
                  {result.trades.length}
                  <small> 次</small>
                </h2>
              </div>
            </div>
            {result.engine_version && (
              <>
                <div className="metrics compact">
                  <div>
                    <p>年化報酬 CAGR</p>
                    <h2>
                      <Delta value={result.cagr_pct} />
                    </h2>
                  </div>
                  <div>
                    <p>年化波動</p>
                    <h2>
                      {result.annualized_volatility_pct == null
                        ? '—'
                        : `${num(result.annualized_volatility_pct)}%`}
                    </h2>
                  </div>
                  <div>
                    <p>Sharpe 比率</p>
                    <h2>{num(result.sharpe_ratio)}</h2>
                  </div>
                  <div>
                    <p>已平倉勝率</p>
                    <h2>{result.win_rate_pct == null ? '—' : `${num(result.win_rate_pct)}%`}</h2>
                  </div>
                </div>
                <div className="detail-metrics">
                  <div>
                    獲利因子<strong>{num(result.profit_factor)}</strong>
                  </div>
                  <div>
                    持倉時間占比
                    <strong>
                      {result.exposure_pct == null ? '—' : `${num(result.exposure_pct)}%`}
                    </strong>
                  </div>
                  <div>
                    平均持有天數<strong>{num(result.avg_holding_days, 1)}</strong>
                  </div>
                  <div>
                    回測交易日<strong>{num(result.trading_days, 0)}</strong>
                  </div>
                </div>
                <p className="footnote">
                  無法定義的指標顯示「—」；平均持有天數只計已平倉交易的日曆天數。
                  {result.benchmark_symbol && <>比較標的：{result.benchmark_symbol}。</>}
                </p>
              </>
            )}
            {result.cache_stale && (
              <div className="notice">
                此回測使用較早的日線或計算版本，請重新執行以取得最新結果。
              </div>
            )}
            {result.warnings?.map((warning) => (
              <div className="notice" key={warning}>
                {warning}
              </div>
            ))}
            <div className="chart-legend">
              <span>
                <i className="green" />
                策略淨值
              </span>
              <span>
                <i className="gray" />
                買入持有
              </span>
            </div>
            <EquityChart data={result.curve} />
            <p className="footnote">{result.method} 歷史績效不代表未來結果。</p>
            <details className="trade-details">
              <summary>
                交易紀錄（{result.trades.length} 筆已平倉
                {result.open_position ? '，另有 1 筆未平倉' : ''}）
              </summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>進場日期</th>
                      <th>出場日期</th>
                      <th className="number">含費用報酬</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i}>
                        <td>{t.entry_date}</td>
                        <td>{t.exit_date}</td>
                        <td className="number">
                          <Delta value={t.return_pct} />
                        </td>
                      </tr>
                    ))}
                    {result.open_position && (
                      <tr>
                        <td>{result.open_position.date}</td>
                        <td>未平倉</td>
                        <td className="number">按末日收盤評價</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="backtest-empty">
            <div className="empty-chart-lines" />
            <h3>{busy ? '正在執行回測' : loading ? '載入已儲存回測…' : '讓數據檢驗策略'}</h3>
            <p>
              {busy
                ? '完成後會顯示本次選擇的標的與策略結果。'
                : '選擇持股或市場候選標的，查看歷史報酬與回撤。'}
            </p>
            <small>訊號於收盤確認，次日開盤模擬成交；10 bps 相當於單邊成本 0.1%。</small>
          </div>
        )}
      </section>
    </>
  )
}

export function StockModal({
  symbol,
  scope = 'portfolio',
  asOf,
  onClose,
}: {
  symbol: string
  scope?: Scope
  asOf?: string
  onClose: () => void
}) {
  const [data, setData] = useState<StockDetail | null>(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState(126)
  const [noteDirty, setNoteDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const close = () => {
    if (noteDirty) setConfirmClose(true)
    else onClose()
  }
  useEffect(() => {
    let active = true
    api<StockDetail>(`/api/stocks/${symbol}?scope=${scope}${asOf ? `&as_of=${asOf}` : ''}`)
      .then((r) => {
        if (active) setData(r)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [symbol, scope, asOf])
  return (
    <Modal title={data ? `${symbol} · ${data.position.name}` : symbol} onClose={close} wide>
      {confirmClose && (
        <div className="notice" role="alert">
          <span>研究筆記尚未儲存，是否捨棄變更並關閉？</span>
          <button type="button" className="button" onClick={() => setConfirmClose(false)}>
            繼續編輯筆記
          </button>
          <button type="button" className="button" onClick={onClose}>
            捨棄變更並關閉
          </button>
        </div>
      )}
      {error ? (
        <div role="alert" className="error-message">
          {error}
        </div>
      ) : !data ? (
        <div className="empty-state">載入日線與策略…</div>
      ) : (
        <>
          {data.position.quote_status && data.position.quote_status !== 'ok' && (
            <div className="notice" role="status">
              <strong>
                {data.position.quote_status === 'unavailable' ? '報價不可用' : '漲跌資料不完整'}
              </strong>
              <span>{data.position.quote_reason || '請至資料管理檢查日線資料。'}</span>
            </div>
          )}
          <div className="stock-price">
            <div>
              <h2>{money(data.position.price)}</h2>
              <Delta value={data.position.change_pct} />
              <p>{data.position.price_date} · USD · 收盤價</p>
            </div>
            <div className="segments">
              {[
                [21, '1M'],
                [63, '3M'],
                [126, '6M'],
                [252, '1Y'],
                [9999, '全部'],
              ].map(([n, label]) => (
                <button
                  type="button"
                  key={n}
                  className={range === n ? 'active' : ''}
                  onClick={() => setRange(Number(n))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-legend">
            <span>
              <i className="green" />
              調整收盤價
            </span>
            <span>
              <i className="blue" />
              MA50
            </span>
            <span>
              <i className="amber" />
              MA200
            </span>
          </div>
          {data.quality?.valid === false && (
            <div className="notice" role="status">
              <div>
                <strong>日線資料異常：{data.quality.invalid_count} 筆</strong>
                <p>
                  價格圖保留可用資料，缺值處中斷連線；異常資料影響的技術指標不顯示，請至資料管理重新檢查。
                </p>
                {data.quality.issues.length > 0 && (
                  <details>
                    <summary>查看異常日期與原因</summary>
                    <ul>
                      {data.quality.issues.map((issue, index) => (
                        <li key={`${issue.date}-${index}`}>
                          {issue.date}：{issue.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          )}
          <PriceChart data={data.history.slice(-range)} />
          <div className="detail-metrics">
            <div>
              RSI 14
              <strong>
                {num(
                  data.quality?.valid === false ? null : data.position.research?.indicators.rsi,
                  1,
                )}
              </strong>
            </div>
            <div>
              成交量比
              <strong>
                {data.quality?.valid === false ||
                data.position.research?.indicators.volume_ratio == null
                  ? '—'
                  : `${num(data.position.research.indicators.volume_ratio)}×`}
              </strong>
            </div>
            <div>
              目前持股數
              <strong>
                {num(data.position.shares, Number.isInteger(data.position.shares) ? 0 : 4)}
              </strong>
            </div>
            <div>
              平均成本<strong>{money(data.position.cost)}</strong>
            </div>
          </div>
          <div className="detail-signals">
            {data.strategies.map((s) => {
              const signal =
                data.quality?.valid === false
                  ? {
                      strategy: s.id,
                      status: 'data_error' as const,
                      matched: false,
                      reason: '日線資料存在異常，暫不採用已儲存的策略訊號。請修復資料後重新掃描。',
                    }
                  : data.position.research?.signals.find((r) => r.strategy === s.id)
              return (
                <div key={s.id}>
                  <div className="section-heading">
                    <h3>{s.name}</h3>
                    {signal && <Badge signal={signal} />}
                  </div>
                  <p>{signal?.reason || '尚未掃描'}</p>
                  <small>{s.rules.join(' · ')}</small>
                </div>
              )
            })}
          </div>
          <p className="footnote">
            行情：{data.position.dataset?.source || '尚未取得'} ·{' '}
            {dateTime(data.position.dataset?.fetched_at)}{' '}
            更新。圖表與技術指標使用調整後日線；持股估值使用收盤價。
          </p>
          <ResearchNotes symbol={symbol} onDirtyChange={setNoteDirty} />
          {data.position.snapshot_price != null && (
            <p className="footnote">
              截圖匯入價格：{money(data.position.snapshot_price)}（截圖日期未提供，僅供對照）。
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
