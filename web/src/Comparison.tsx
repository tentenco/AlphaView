import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Overview, Scope } from './types'
import { api, money, num } from './ui'
import './comparison.css'
import { ChartErrorBoundary } from './ChartErrorBoundary'
import { comparisonDailyCsv, comparisonSummaryCsv } from './comparison-export'
const ComparisonChart = lazy(() => import('./ComparisonChart'))
export type ComparisonResult = {
  as_of: string
  window: 60 | 120 | 252
  anchor_date: string
  end_date: string
  expected_prices: number
  requested_count: number
  eligible_count: number
  complete: boolean
  status: 'ready' | 'insufficient'
  input_revision: string
  comparison_engine_version: string
  dates: string[]
  series: {
    symbol: string
    name: string
    source: string | null
    eligible: boolean
    reason: string | null
    observed_prices: number
    valid_prices: number
    anchor_price: number | null
    latest_price: number | null
    return_pct: number | null
    points: { date: string; return_pct: number }[]
  }[]
  warnings: string[]
  method: string
}
export function Comparison({
  data,
  onOpen,
}: {
  data: Overview
  onOpen: (symbol: string, scope?: Scope, asOf?: string) => void
}) {
  const members = [
    ...data.positions,
    ...data.market_universe.filter(
      (member) => !data.positions.some((position) => position.symbol === member.symbol),
    ),
  ]
  const [selected, setSelected] = useState<string[]>(() =>
    members.slice(0, 2).map((member) => member.symbol),
  )
  const [windowSize, setWindowSize] = useState<60 | 120 | 252>(120)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(true)
  const [result, setResult] = useState<ComparisonResult | null>(null)
  const [resultKey, setResultKey] = useState('')
  const [resultRevision, setResultRevision] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [exportMessage, setExportMessage] = useState('')
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const revision = data.revision || JSON.stringify(data.datasets)
  const key = `${windowSize}:${selected.join(',')}`
  const invalid =
    selected.length < 2 ||
    selected.length > 5 ||
    selected.some((symbol) => !members.some((member) => member.symbol === symbol))
  const filtered = members.filter((member) =>
    `${member.symbol} ${member.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const currentPage = Math.min(page, pages - 1)
  useEffect(
    () => () => {
      controller.current?.abort()
      generation.current++
    },
    [],
  )
  function toggle(symbol: string) {
    setSelected((previous) =>
      previous.includes(symbol)
        ? previous.filter((item) => item !== symbol)
        : previous.length < 5
          ? [...previous, symbol]
          : previous,
    )
  }
  function exportResult(kind: 'summary' | 'daily') {
    if (!result || loading) return
    const context = {
      workspaceChanged: resultRevision !== revision,
      draftChanged: resultKey !== key,
    }
    const csv =
      kind === 'summary'
        ? comparisonSummaryCsv(result, context)
        : comparisonDailyCsv(result, context)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `AlphaView-comparison-${kind}-${result.as_of}-${result.window}d.csv`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setExportMessage(
      `已匯出${kind === 'summary' ? '比較摘要' : '每日比較值'}，使用下方已計算結果的期間與資料版本。`,
    )
  }
  async function compare() {
    if (invalid || pending.current) return
    pending.current = true
    const current = ++generation.current
    const request = new AbortController()
    controller.current?.abort()
    controller.current = request
    setLoading(true)
    setError('')
    setExportMessage('')
    try {
      const next = await api<ComparisonResult>(
        `/api/comparison?${new URLSearchParams({ symbols: selected.join(','), window: String(windowSize) })}`,
        { signal: request.signal },
      )
      if (current !== generation.current || request.signal.aborted) return
      if (
        next.window !== windowSize ||
        next.series.length !== selected.length ||
        new Set(next.series.map((series) => series.symbol)).size !== selected.length ||
        next.series.some((series) => !selected.includes(series.symbol))
      )
        throw new Error('比較資料與要求的標的或期間不一致，請重新比較。')
      setResult(next)
      setPickerOpen(false)
      setResultKey(key)
      setResultRevision(revision)
    } catch (err) {
      if (current === generation.current && !request.signal.aborted)
        setError((err as Error).message)
    } finally {
      if (current === generation.current) {
        setLoading(false)
        pending.current = false
      }
    }
  }
  return (
    <div className="comparison-page">
      <div className="page-title">
        <div>
          <div className="eyebrow">Price comparison</div>
          <h1>標的價格比較</h1>
          <p>選擇 2–5 檔已知標的，以相同起點比較調整收盤價的百分比變化。</p>
        </div>
      </div>
      <section aria-labelledby="comparison-selection-title">
        <div className="section-heading">
          <h2 id="comparison-selection-title">比較標的</h2>
          <span>已選 {selected.length} / 5 檔</span>
        </div>
        <div className="comparison-selected">
          {selected.map((symbol) => (
            <button
              type="button"
              className="button"
              key={symbol}
              disabled={loading}
              onClick={() => toggle(symbol)}
              aria-label={`移除比較標的 ${symbol}`}
            >
              {symbol} ×
            </button>
          ))}
        </div>
        <div className="actions">
          <label>
            搜尋股票池
            <input
              type="search"
              aria-label="搜尋比較標的"
              maxLength={100}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
                setPickerOpen(true)
              }}
              placeholder="代碼或公司名稱"
            />
          </label>
          <label>
            共同觀察期間
            <select
              aria-label="共同觀察期間"
              value={windowSize}
              disabled={loading}
              onChange={(event) => setWindowSize(Number(event.target.value) as 60 | 120 | 252)}
            >
              <option value={60}>60 個交易日</option>
              <option value={120}>120 個交易日</option>
              <option value={252}>252 個交易日</option>
            </select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={loading || invalid}
            onClick={() => void compare()}
          >
            {loading ? '正在比較…' : error ? '重新嘗試比較' : '比較調整收盤價'}
          </button>
        </div>
        {invalid && (
          <p className="footnote">
            請選擇 2–5 檔目前股票池中的標的；已離開股票池的選擇可從上方移除。
          </p>
        )}
        <button
          type="button"
          className="text-button"
          aria-expanded={pickerOpen}
          aria-controls="comparison-picker"
          onClick={() => setPickerOpen((open) => !open)}
        >
          {pickerOpen ? '收合股票池' : '選擇其他標的'}
        </button>
        <div id="comparison-picker" hidden={!pickerOpen}>
          <fieldset className="comparison-candidates">
            <legend>從個人清單與市場股票池選擇</legend>
            {filtered.slice(currentPage * 20, (currentPage + 1) * 20).map((member) => (
              <label key={member.symbol}>
                <input
                  type="checkbox"
                  checked={selected.includes(member.symbol)}
                  disabled={loading || (!selected.includes(member.symbol) && selected.length >= 5)}
                  onChange={() => toggle(member.symbol)}
                />
                <span>
                  <strong>{member.symbol}</strong>
                  <small>{member.name}</small>
                </span>
              </label>
            ))}
            {!filtered.length && <p>找不到符合搜尋的標的。此功能不會自動下載新股票。</p>}
          </fieldset>
          <div className="table-pagination">
            <span>
              {filtered.length} 檔可選 · 第 {currentPage + 1} / {pages} 頁
            </span>
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一頁標的
              </button>
              <button
                type="button"
                className="button"
                disabled={currentPage === pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                下一頁標的
              </button>
            </div>
          </div>
        </div>
      </section>
      {loading && (
        <p role="status" className="notice">
          正在讀取本機行情並比較；不會下載新資料。
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
          {result && ' 下方保留前次比較結果。'}
        </p>
      )}
      {result && (
        <section className="daily-section" aria-labelledby="comparison-result-title">
          <h2 id="comparison-result-title">已計算的價格比較</h2>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => exportResult('summary')}
            >
              匯出比較摘要 CSV
            </button>
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => exportResult('daily')}
            >
              匯出每日比較 CSV
            </button>
          </div>
          {exportMessage && (
            <p role="status" className="footnote">
              {exportMessage}
            </p>
          )}
          {(resultKey !== key || resultRevision !== revision) && (
            <p role="status" className="notice">
              {resultRevision !== revision
                ? '工作區資料版本已更新，這份比較可能已過期。'
                : '選擇條件已變更，下方仍是前次提交的比較。'}
              請按「比較調整收盤價」重新計算。
            </p>
          )}
          <p className="footnote" role="status">
            共同起點 {result.anchor_date} → {result.end_date} · {result.window} 個交易日 · 基準日{' '}
            {result.as_of} · 可比較 {result.eligible_count} / {result.requested_count} 檔
          </p>
          {result.eligible_count < 2 ? (
            <p role="status" className="notice">
              可用標的不足兩檔，暫不繪製比較圖。請查看下方缺少資料的原因，或選擇其他期間／標的。
            </p>
          ) : (
            <ChartErrorBoundary>
              <Suspense fallback={<p role="status">正在載入比較圖…</p>}>
                <ComparisonChart result={result} />
              </Suspense>
            </ChartErrorBoundary>
          )}
          <div
            className="table-scroll"
            role="region"
            aria-label="價格比較結果與資料覆蓋"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">標的</th>
                  <th scope="col">共同起點調整價</th>
                  <th scope="col">期末調整價</th>
                  <th scope="col">價格變化</th>
                  <th scope="col">有效日線／需要</th>
                  <th scope="col">資料狀態</th>
                </tr>
              </thead>
              <tbody>
                {result.series.map((series) => (
                  <tr key={series.symbol}>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          onOpen(
                            series.symbol,
                            data.positions.some((position) => position.symbol === series.symbol)
                              ? 'portfolio'
                              : 'market',
                            result.as_of,
                          )
                        }
                      >
                        {series.symbol}
                      </button>
                      <small>{series.source || '來源資訊不足'}</small>
                    </td>
                    <td>{money(series.eligible ? series.anchor_price : null)}</td>
                    <td>{money(series.eligible ? series.latest_price : null)}</td>
                    <td>
                      {series.eligible && series.return_pct != null
                        ? `${num(series.return_pct)}%`
                        : '—'}
                    </td>
                    <td>
                      {series.valid_prices} / {result.expected_prices}
                      <small>已儲存 {series.observed_prices} 筆</small>
                    </td>
                    <td>
                      {series.eligible ? '完整期間可用' : series.reason || '資料不足，未列入比較'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="comparison-method">
            <summary>計算方式與資料限制</summary>
            <p className="footnote">{result.method}</p>
            {result.warnings.map((warning, index) => (
              <p className="footnote" key={index}>
                {warning}
              </p>
            ))}
          </details>
        </section>
      )}
    </div>
  )
}
