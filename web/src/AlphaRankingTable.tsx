import { Fragment } from 'react'
import { Star, StarFilled, WarningAlt } from '@carbon/icons-react'
import { translateText, type Locale } from './locale'
import type { AlphaCandidate, RiskAlert } from './alpha-model'
import { money, num } from './ui'

export function AlphaRankingTable({
  rows,
  locale,
  offset,
  shortlist,
  compare,
  alerts,
  expanded,
  busy,
  adding,
  actions,
}: {
  rows: AlphaCandidate[]
  locale: Locale
  offset: number
  shortlist: string[]
  compare: string[]
  alerts: RiskAlert[]
  expanded: string | null
  busy: boolean
  adding: string | null
  actions: {
    open: (row: AlphaCandidate) => void
    star: (symbol: string) => void
    compare: (symbol: string) => void
    expand: (symbol: string) => void
    scenario: (symbol: string) => void
    watch: (row: AlphaCandidate) => void
    fit: (symbol: string) => void
    handoff: (symbol: string) => void
  }
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const names = [t('海龜', 'Turtle'), t('趨勢', 'Trend'), t('回檔', 'Pullback'), 'RPS']
  return (
    <div className="alpha-table-scroll">
      <table className="alpha-ranking-table">
        <caption>
          {t(
            '研究排序；策略欄為加權貢獻分數，價格為調整收盤價。',
            'Research ranking; strategy columns show weighted points and prices are adjusted closes.',
          )}
        </caption>
        <thead>
          <tr>
            <th>{t('比較', 'Compare')}</th>
            <th>{t('標的', 'Symbol')}</th>
            <th>{t('分數', 'Score')}</th>
            {names.map((name) => (
              <th key={name}>{name}</th>
            ))}
            <th>{t('調整收盤', 'Adjusted Close')}</th>
            <th>RSI 14</th>
            <th>{t('關係', 'Relationship')}</th>
            <th>{t('研究操作', 'Research Actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Fragment key={row.symbol}>
              <tr className={row.alpha ? 'is-alpha' : ''}>
                <td>
                  <input
                    type="checkbox"
                    name={`compare-${row.symbol}`}
                    aria-label={t(`比較 ${row.symbol}`, `Compare ${row.symbol}`)}
                    checked={compare.includes(row.symbol)}
                    disabled={!compare.includes(row.symbol) && compare.length >= 5}
                    onChange={() => actions.compare(row.symbol)}
                  />
                </td>
                <td>
                  <div className="alpha-table-symbol">
                    <span className="alpha-rank">{offset + index + 1}</span>
                    <button type="button" className="text-button" onClick={() => actions.open(row)}>
                      <strong>{row.symbol}</strong>
                    </button>
                    <button
                      type="button"
                      className="icon-button alpha-star"
                      aria-label={
                        shortlist.includes(row.symbol)
                          ? t(`移除研究清單 ${row.symbol}`, `Unstar ${row.symbol}`)
                          : t(`加入研究清單 ${row.symbol}`, `Star ${row.symbol}`)
                      }
                      aria-pressed={shortlist.includes(row.symbol)}
                      onClick={() => actions.star(row.symbol)}
                    >
                      {shortlist.includes(row.symbol) ? (
                        <StarFilled size={16} />
                      ) : (
                        <Star size={16} />
                      )}
                    </button>
                  </div>
                  <small className="alpha-table-company" title={row.name}>
                    {row.name}
                  </small>
                </td>
                <td>
                  <strong className="alpha-table-score">{num(row.score, 0)}</strong>
                  <small>/100</small>
                </td>
                {row.contributions.map((part, i) => (
                  <td key={part.id}>
                    <span
                      className={part.matched && part.weight > 0 ? 'alpha-table-match' : ''}
                      style={
                        part.matched && part.weight > 0
                          ? { color: `var(--series-${i})` }
                          : undefined
                      }
                      title={
                        part.weight === 0
                          ? t('停用', 'Disabled')
                          : !part.available
                            ? t('資料不足', 'Unavailable')
                            : part.matched
                              ? t('符合策略', 'Strategy Match')
                              : t('未符合策略', 'No Match')
                      }
                    >
                      {part.weight === 0
                        ? '—'
                        : !part.available
                          ? '?'
                          : part.matched
                            ? `+${num(part.points, 0)}`
                            : '0'}
                    </span>
                  </td>
                ))}
                <td>{money(row.row.indicators.close)}</td>
                <td>{num(row.row.indicators.rsi, 1)}</td>
                <td>
                  <span className={`alpha-relation ${row.relation}`}>
                    {row.relation === 'held'
                      ? t('已持有', 'Held')
                      : row.relation === 'watchlist'
                        ? t('觀察中', 'Watching')
                        : t('新標的', 'New')}
                  </span>
                  {alerts.some(
                    (alert) => alert.symbol === row.symbol && alert.severity !== 'data',
                  ) && (
                    <WarningAlt
                      size={14}
                      className="alpha-table-risk"
                      aria-label={t('持倉有提醒', 'Holding Alert')}
                    />
                  )}
                </td>
                <td>
                  <div className="actions">
                    <button
                      type="button"
                      className="text-button"
                      aria-expanded={expanded === row.symbol}
                      onClick={() => actions.expand(row.symbol)}
                    >
                      {t('拆解', 'Breakdown')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => actions.scenario(row.symbol)}
                    >
                      {t('試算', 'Scenario')}
                    </button>
                    {row.relation === 'new' && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy || !!adding}
                        onClick={() => actions.watch(row)}
                      >
                        {adding === row.symbol ? t('加入中…', 'Adding…') : t('觀察', 'Watch')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {expanded === row.symbol && (
                <tr className="alpha-table-details">
                  <td colSpan={11}>
                    <div className="alpha-table-breakdown">
                      {row.contributions.map((part, index) => (
                        <div key={part.id}>
                          <strong>{names[index]}</strong>
                          <span>
                            {part.weight === 0
                              ? t('停用', 'Disabled')
                              : !part.available
                                ? t('資料不足', 'Unavailable')
                                : part.matched
                                  ? t('符合', 'Match')
                                  : t('未符合', 'No Match')}
                          </span>
                          <b>+{num(part.points, 1)}</b>
                          <small className="alpha-rule-reason">
                            {translateText(part.reason, locale)}
                          </small>
                        </div>
                      ))}
                    </div>
                    <p>
                      {t('有效權重覆蓋', 'Weighted Data Coverage')} {num(row.coverage, 0)}% · RPS{' '}
                      {num(row.row.indicators.rps, 1)} · {row.matched}{' '}
                      {t('項策略共識', 'strategies in agreement')}
                    </p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => actions.fit(row.symbol)}
                    >
                      {t('和現有持倉比較走勢', 'Compare Returns with Holdings')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => actions.handoff(row.symbol)}
                    >
                      {t('複製研究交接包', 'Copy Research Handoff')}
                    </button>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
