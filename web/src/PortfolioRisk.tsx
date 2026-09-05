import { useEffect, useState } from 'react'
import { api, money, num } from './ui'

export type PortfolioRiskResult = {
  as_of: string | null
  window: 60 | 120
  start: string | null
  end: string | null
  min_observations: number
  holding_count: number
  priced_count: number
  valuation_complete: boolean
  market_value: number | null
  largest_weight_pct: number | null
  top3_weight_pct: number | null
  holdings: {
    symbol: string
    name: string
    market_value: number | null
    weight_pct: number | null
    quote_status: 'ok' | 'stale' | 'unavailable'
    return_count: number
    history_status: 'ok' | 'stale' | 'unavailable'
    reason: string | null
  }[]
  pairs: {
    left: string
    right: string
    correlation: number | null
    observations: number
    start: string | null
    end: string | null
    reason: string | null
  }[]
  warnings: string[]
  method: string
}
const statusLabel = { ok: '可用', stale: '資料過期', unavailable: '資料不足或異常' }
const percent = (value: number | null) => (value == null ? '—' : `${num(value, 1)}%`)

export function PortfolioRisk({
  refreshKey = '',
  onOpen,
}: {
  refreshKey?: string | number
  onOpen?: (symbol: string) => void
}) {
  const [windowSize, setWindowSize] = useState<60 | 120>(60)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<PortfolioRiskResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setData(null)
    setError('')
    setPage(0)
    api<PortfolioRiskResult>(`/api/portfolio/risk?window=${windowSize}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.window !== windowSize) throw new Error('分析期間與要求不一致，請重新計算。')
        setData(result)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [windowSize, revision, refreshKey])
  const pairs = data?.pairs.filter((pair) => pair.left !== pair.right) || []
  const pages = Math.max(1, Math.ceil(pairs.length / 25))
  const currentPage = Math.min(page, pages - 1)
  return (
    <section className="daily-section portfolio-risk" aria-labelledby="portfolio-risk-title">
      <div className="section-heading">
        <div>
          <h2 id="portfolio-risk-title">持倉集中度與相關性</h2>
          <p>僅分析目前股數大於零的持倉，使用已儲存的調整日線。</p>
        </div>
        <div className="actions">
          <label>
            分析期間{' '}
            <select
              aria-label="相關性分析期間"
              value={windowSize}
              onChange={(event) => setWindowSize(Number(event.target.value) as 60 | 120)}
            >
              <option value={60}>60 個交易日</option>
              <option value={120}>120 個交易日</option>
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            重新計算風險概況
          </button>
        </div>
      </div>
      {loading && (
        <p role="status" className="loading-line">
          正在計算持倉相關性…
        </p>
      )}
      {error && (
        <div role="alert" className="error-message">
          {error}
        </div>
      )}
      {data &&
        (data.holding_count === 0 ? (
          <div className="empty-state">
            目前沒有實際持倉。加入股數後即可分析；觀察名單不列入持倉風險。
          </div>
        ) : (
          <>
            <p className="footnote">
              資料基準日 {data.as_of || '尚無資料'} · 觀察期間 {data.start || '—'} 至{' '}
              {data.end || '—'} · 最近 {data.window} 個交易日
            </p>
            {!data.valuation_complete && (
              <div className="notice" role="status">
                僅 {data.priced_count} / {data.holding_count}{' '}
                檔具有當期可用估值。以下市值是可估值小計，集中度與權重暫不顯示。
              </div>
            )}
            <div className="metrics-wrap">
              <div className="metrics compact">
                <div>
                  <p>估值覆蓋</p>
                  <h2>
                    {data.priced_count} / {data.holding_count}
                  </h2>
                  <small>目前持倉檔數</small>
                </div>
                <div>
                  <p>{data.valuation_complete ? '持倉市值' : '可估值市值小計'}</p>
                  <h2>{money(data.market_value)}</h2>
                  <small>依當期可用報價</small>
                </div>
                <div>
                  <p>最大單一持倉占比</p>
                  <h2>{percent(data.valuation_complete ? data.largest_weight_pct : null)}</h2>
                  <small>完整持倉估值為分母</small>
                </div>
                <div>
                  <p>前三大持倉合計占比</p>
                  <h2>{percent(data.valuation_complete ? data.top3_weight_pct : null)}</h2>
                  <small>不足三檔時合計現有持倉</small>
                </div>
              </div>
            </div>
            {data.warnings.map((warning, index) => (
              <p className="notice" key={index}>
                {warning}
              </p>
            ))}
            <div className="table-scroll" role="region" aria-label="持倉資料覆蓋" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">持倉</th>
                    <th scope="col">市值</th>
                    <th scope="col">占比</th>
                    <th scope="col">報價／報酬資料</th>
                    <th scope="col">可用日報酬數</th>
                    <th scope="col">說明</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((holding) => (
                    <tr key={holding.symbol}>
                      <td>
                        {onOpen ? (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => onOpen(holding.symbol)}
                          >
                            {holding.symbol}
                          </button>
                        ) : (
                          holding.symbol
                        )}
                        <small>{holding.name}</small>
                      </td>
                      <td>{money(holding.market_value)}</td>
                      <td>{percent(data.valuation_complete ? holding.weight_pct : null)}</td>
                      <td>
                        {statusLabel[holding.quote_status]}／
                        {holding.history_status !== 'ok'
                          ? statusLabel[holding.history_status]
                          : holding.return_count < data.min_observations
                            ? '樣本不足'
                            : holding.return_count < data.window
                              ? '部分日期可用'
                              : '可用'}
                      </td>
                      <td>{holding.return_count}</td>
                      <td>{holding.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>成對日報酬相關係數</h3>
            <p className="footnote">
              每組使用共同且相鄰交易日的有效日報酬，至少需要 {data.min_observations}{' '}
              筆；單檔樣本足夠仍不代表兩檔有足夠共同樣本，各組分別判定。係數介於 −1 與
              1，缺值不補零，未列自我相關。
            </p>
            {!pairs.length ? (
              <p className="empty-state">至少需要兩檔實際持倉才能比較成對相關性。</p>
            ) : (
              <>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="持倉成對相關性"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">標的一</th>
                        <th scope="col">標的二</th>
                        <th scope="col">相關係數</th>
                        <th scope="col">共同樣本數</th>
                        <th scope="col">有效樣本期間</th>
                        <th scope="col">說明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.slice(currentPage * 25, (currentPage + 1) * 25).map((pair) => (
                        <tr key={`${pair.left}-${pair.right}`}>
                          <td>{pair.left}</td>
                          <td>{pair.right}</td>
                          <td>{num(pair.correlation, 3)}</td>
                          <td>{pair.observations}</td>
                          <td>
                            {pair.start || '—'} 至 {pair.end || '—'}
                          </td>
                          <td>{pair.reason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="table-pagination">
                  <span>
                    {pairs.length} 組 · 第 {currentPage + 1} / {pages} 頁
                  </span>
                  <div className="actions">
                    <button
                      className="button"
                      type="button"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      上一組相關性
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={currentPage >= pages - 1}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      下一組相關性
                    </button>
                  </div>
                </div>
              </>
            )}
            <p className="footnote">{data.method}</p>
            <p className="footnote">
              這是目前持倉的資料診斷，不是歷史投資組合績效、損失預測或買賣建議；過去相關性可能改變。
            </p>
          </>
        ))}
    </section>
  )
}
