import { STRATEGY_IDS, type AlphaCandidate, type StrategyId } from './alpha-model'
import type { Locale } from './locale'
import { num } from './ui'

export function overlapCount(rows: AlphaCandidate[], a: StrategyId, b: StrategyId) {
  let eligible = 0,
    both = 0,
    either = 0
  for (const row of rows) {
    const x = row.contributions.find((part) => part.id === a),
      y = row.contributions.find((part) => part.id === b)
    if (!x?.available || !y?.available) continue
    eligible++
    if (x.matched && y.matched) both++
    if (x.matched || y.matched) either++
  }
  return { eligible, both, either, overlapPct: either ? (both / either) * 100 : null }
}
export function AlphaOverlap({
  rows,
  locale,
  onSelect,
  selected,
}: {
  rows: AlphaCandidate[]
  locale: Locale
  onSelect: (strategies: StrategyId[]) => void
  selected: StrategyId[]
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const names = {
    turtle: t('海龜突破', 'Turtle'),
    trend: t('均線趨勢', 'Trend'),
    pullback: t('回檔觀察', 'Pullback'),
    rps: t('相對強勢', 'Relative Strength'),
  }
  return (
    <details className="alpha-overlap">
      <summary>{t('查看四策略交集', 'Explore Strategy Overlap')}</summary>
      <p>
        {t(
          '找出同時符合兩種策略的標的。交集是訊號重疊，不是報酬相關性；不受你目前的權重影響。',
          'Find symbols matching two strategies at once. This measures signal overlap, not return correlation, and is independent of your current weights.',
        )}
      </p>
      <div className="alpha-overlap-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('同時符合', 'Matches Both')}</th>
              {STRATEGY_IDS.map((id) => (
                <th key={id}>{names[id]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STRATEGY_IDS.map((a) => (
              <tr key={a}>
                <th scope="row">{names[a]}</th>
                {STRATEGY_IDS.map((b) => {
                  const cell = overlapCount(rows, a, b)
                  const active =
                    selected.includes(a) &&
                    selected.includes(b) &&
                    (a === b ? selected.length === 1 : selected.length === 2)
                  return (
                    <td key={b}>
                      <button
                        type="button"
                        aria-label={t(
                          `${names[a]}與${names[b]}同時符合：${cell.both} 檔`,
                          `${names[a]} and ${names[b]}: ${cell.both} matches`,
                        )}
                        aria-pressed={active}
                        disabled={!cell.both}
                        onClick={() => onSelect(a === b ? [a] : [a, b])}
                        title={t(
                          `兩策略有效資料 ${cell.eligible} 檔；交集／聯集 ${num(cell.overlapPct, 1)}%`,
                          `Both strategies available: ${cell.eligible}; intersection / union: ${num(cell.overlapPct, 1)}%`,
                        )}
                      >
                        <b>{cell.both}</b>
                        <small>
                          {a === b
                            ? t('單一策略', 'Single Strategy')
                            : `${num(cell.overlapPct, 0)}% ${t('重疊', 'overlap')}`}
                        </small>
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        {t(
          '百分比＝同時符合 ÷ 至少一項符合，只使用兩策略都有有效資料的標的。點選數量會顯示該交集，並重設下方搜尋與持倉篩選。',
          'Percentage = intersection / union, using only symbols with valid data for both strategies. Selecting a count shows that intersection and resets the ranking search and ownership filter.',
        )}
      </p>
    </details>
  )
}
