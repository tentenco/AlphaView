import { ArrowRight, Time } from '@carbon/icons-react'
import type { Overview, Scope } from './types'
import { dateTime, Delta, num } from './ui'
import { marketOverview } from './market-overview-model'
import type { Breadth } from './market-overview-model'

export function MarketOverview({
  data,
  onStrategy,
  onOpen,
  onScreener,
}: {
  data: Overview
  onStrategy: (strategy: string) => void
  onOpen: (symbol: string, scope: Scope, asOf?: string) => void
  onScreener: () => void
}) {
  const scan = data.market_scan
  const model = scan ? marketOverview(scan, data.strategies) : null
  const measures: [string, Breadth][] = model
    ? [
        ['高於 MA50', model.ma50],
        ['高於 MA200', model.ma200],
        ['RSI ≥ 70', model.overbought],
        ['RSI ≤ 30', model.oversold],
      ]
    : []
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">Market overview</div>
          <h1>市場概況</h1>
          <p>以最近一次市場選股快照，觀察股票池的趨勢與資料覆蓋。</p>
        </div>
        <button type="button" className="button" onClick={onScreener}>
          前往市場選股 <ArrowRight size={16} />
        </button>
      </div>
      {!scan || !model ? (
        <div className="empty-state">
          尚無市場選股快照。請先執行市場選股，完成後即可查看股票池概況。
        </div>
      ) : (
        <>
          <p className="footnote">
            <Time size={14} /> 選股日期 {scan.as_of} · {dateTime(scan.created_at)} 計算 · 快照 #
            {scan.id}
          </p>
          {scan.matches_current_universe === false && (
            <div className="notice" role="status">
              這份快照使用原股票池 {scan.scan_member_count ?? model.coverage.total} 檔；目前股票池{' '}
              {scan.current_member_count ?? data.market_universe.length}{' '}
              檔。以下統計保留原快照範圍，可前往市場選股重新計算。
            </div>
          )}
          <div className="metrics-wrap">
            <div className="metrics compact">
              <div>
                <p>快照股票池</p>
                <h2>{model.coverage.total}</h2>
                <small>每檔等權計數</small>
              </div>
              <div>
                <p>當期可用日線</p>
                <h2>
                  {model.coverage.usable}
                  <span className="stat-denominator"> / {model.coverage.total}</span>
                </h2>
                <small>日期一致且收盤價有效</small>
              </div>
              <div>
                <p>資料異常／缺少</p>
                <h2>{model.coverage.dataError + model.coverage.missing}</h2>
                <small>
                  異常 {model.coverage.dataError} · 缺少 {model.coverage.missing}
                </small>
              </div>
              <div>
                <p>過期資料</p>
                <h2>{model.coverage.stale}</h2>
                <small>不列入當期統計</small>
              </div>
            </div>
          </div>
          <section className="daily-section">
            <div className="section-heading">
              <div>
                <h2>股票池趨勢廣度</h2>
                <p>各指標使用自己的有效樣本數，缺值不補為零。</p>
              </div>
            </div>
            <div className="metrics-wrap">
              <div className="metrics compact">
                {measures.map(([label, measure]) => (
                  <div key={label}>
                    <p>{label}</p>
                    <h2>{measure.percent == null ? '—' : `${num(measure.percent, 1)}%`}</h2>
                    <small>
                      {measure.count} / {measure.eligible} 檔符合 · 排除 {measure.excluded} 檔
                    </small>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section className="daily-section">
            <div className="section-heading">
              <div>
                <h2>策略覆蓋</h2>
                <p>僅以「符合條件」或「持續觀察」的有效當期資料作為分母。</p>
              </div>
            </div>
            <div className="signal-summary">
              {model.strategies.map(({ strategy, count, eligible, excluded }) => (
                <button type="button" key={strategy.id} onClick={() => onStrategy(strategy.id)}>
                  <div className="signal-top">
                    <span>{strategy.english}</span>
                    <ArrowRight size={16} />
                  </div>
                  <h3>{strategy.name}</h3>
                  <div className="signal-bottom">
                    <strong>
                      {count}
                      <small> / {eligible} 檔符合</small>
                    </strong>
                    <span>排除 {excluded} 檔</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <section className="watchlist-section">
            <div className="section-heading">
              <div>
                <h2>120 日報酬 · 前五檔</h2>
                <p>有效樣本 {model.returnEligible} 檔，以調整收盤價計算；屬歷史排序。</p>
              </div>
            </div>
            {model.leaders.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>標的</th>
                      <th className="number">120 日報酬</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.leaders.map((row) => (
                      <tr key={row.symbol}>
                        <td>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpen(row.symbol, 'market', scan.as_of)}
                          >
                            <strong>{row.symbol}</strong>
                            <ArrowRight size={14} />
                          </button>
                          <small>{row.name || row.symbol}</small>
                        </td>
                        <td className="number">
                          <Delta value={row.indicators.return120! * 100} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">目前沒有可用的 120 日報酬樣本。</div>
            )}
          </section>
          <div className="research-note">
            <div className="note-title">統計範圍與解讀</div>
            <p>
              這是所選市場子集的等權標的計數，不代表全美股或市值加權指數，也不是買賣建議。均線分母限當期有效收盤價與正值均線；RSI
              分母限 0–100 的有效數值。資料異常、過期與缺值均排除。股票池變更會改變廣度及 RPS
              排名，跨快照比較時應先核對成分。
            </p>
          </div>
        </>
      )}
    </>
  )
}
