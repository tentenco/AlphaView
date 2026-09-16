import { useState } from 'react'
import { ArrowRight, Star, StarFilled } from '@carbon/icons-react'
import type { Locale } from './locale'
import { finite, type AlphaCandidate } from './alpha-model'
import { num } from './ui'

export function AlphaOpportunityMap({
  rows,
  locale,
  shortlist,
  onOpen,
  onStar,
}: {
  rows: AlphaCandidate[]
  locale: Locale
  shortlist: string[]
  onOpen: (row: AlphaCandidate) => void
  onStar: (symbol: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const points = rows.filter(
    (row) =>
      finite(row.row.indicators.rsi) &&
      row.row.indicators.rsi >= 0 &&
      row.row.indicators.rsi <= 100 &&
      finite(row.row.indicators.rps) &&
      row.row.indicators.rps >= 0 &&
      row.row.indicators.rps <= 100,
  )
  const [selected, setSelected] = useState<string | null>(null)
  const current = points.find((row) => row.symbol === selected) || points[0]
  const color = (row: AlphaCandidate) =>
    row.relation === 'held'
      ? 'var(--series-2)'
      : row.relation === 'watchlist'
        ? 'var(--series-1)'
        : 'var(--positive)'
  const x = (value: number) => 54 + value * 6.72
  const y = (value: number) => 338 - value * 3
  const relation = (row: AlphaCandidate) =>
    row.relation === 'held'
      ? t('已持有', 'Held')
      : row.relation === 'watchlist'
        ? t('觀察名單', 'Watchlist')
        : t('新標的', 'New')
  return (
    <div className="alpha-opportunity-map">
      <div className="alpha-map-key">
        <span>
          <i style={{ background: 'var(--positive)' }} />
          {t('新標的', 'New')}
        </span>
        <span>
          <i style={{ background: 'var(--series-1)' }} />
          {t('觀察名單', 'Watchlist')}
        </span>
        <span>
          <i style={{ background: 'var(--series-2)' }} />
          {t('已持有', 'Held')}
        </span>
        <small>{t('圓越大，Alpha 分數越高', 'Larger circles indicate higher Alpha scores')}</small>
      </div>
      <p className="footnote">
        {t(
          '橫軸 RSI 14、縱軸同股票池 RPS。點選圓點看標的；也可使用下方選單。虛線只標示策略參考門檻，不代表買賣區域。',
          'Horizontal axis: RSI 14. Vertical axis: same-universe RPS. Select a point or use the dropdown below. Dashed lines are strategy reference thresholds, not buy or sell regions.',
        )}
      </p>
      {points.length > 0 && (
        <svg
          viewBox="0 0 760 390"
          className="alpha-map-chart"
          role="img"
          aria-label={t(
            `${points.length} 檔候選的 RSI 與 RPS 分布。可使用下方選單讀取個股數值。`,
            `RSI and RPS distribution for ${points.length} candidates. Use the dropdown below for individual values.`,
          )}
        >
          {[0, 20, 40, 60, 80, 100].map((tick) => (
            <g key={tick}>
              <line x1={54} y1={y(tick)} x2={726} y2={y(tick)} stroke="var(--line)" />
              <text
                x={44}
                y={y(tick) + 4}
                textAnchor="end"
                fill="var(--muted)"
                fontSize="var(--type-meta)"
              >
                {tick}
              </text>
              <text
                x={x(tick)}
                y={359}
                textAnchor="middle"
                fill="var(--muted)"
                fontSize="var(--type-meta)"
              >
                {tick}
              </text>
            </g>
          ))}
          <text x={18} y={20} fill="var(--muted)" fontSize="var(--type-body)">
            RPS
          </text>
          <text x={390} y={382} textAnchor="middle" fill="var(--muted)" fontSize="var(--type-body)">
            RSI 14
          </text>
          {[30, 45].map((value) => (
            <line
              key={value}
              x1={x(value)}
              y1={38}
              x2={x(value)}
              y2={338}
              stroke="var(--muted)"
              strokeOpacity={0.45}
              strokeDasharray="3 5"
            />
          ))}
          <line
            x1={54}
            y1={y(80)}
            x2={726}
            y2={y(80)}
            stroke="var(--series-3)"
            strokeOpacity={0.6}
            strokeDasharray="3 5"
          />
          {[...points].reverse().map((row) => (
            <circle
              key={row.symbol}
              cx={x(row.row.indicators.rsi!)}
              cy={y(row.row.indicators.rps!)}
              r={4 + row.score / 20}
              fill={color(row)}
              fillOpacity={current?.symbol === row.symbol ? 0.95 : 0.45}
              stroke={current?.symbol === row.symbol ? 'var(--text)' : color(row)}
              strokeWidth={current?.symbol === row.symbol ? 2 : 0.5}
              onClick={() => setSelected(row.symbol)}
              style={{ cursor: 'pointer' }}
            >
              <title>
                {row.symbol} · RSI {num(row.row.indicators.rsi, 1)} · RPS{' '}
                {num(row.row.indicators.rps, 1)} · Alpha {num(row.score, 0)}
              </title>
            </circle>
          ))}
          {current && (
            <g pointerEvents="none">
              <circle
                cx={x(current.row.indicators.rsi!)}
                cy={y(current.row.indicators.rps!)}
                r={7 + current.score / 20}
                fill="none"
                stroke="var(--text)"
                strokeWidth={1}
              />
              <text
                x={Math.min(690, Math.max(70, x(current.row.indicators.rsi!)))}
                y={Math.max(24, y(current.row.indicators.rps!) - 16)}
                textAnchor="middle"
                fontSize="var(--type-body)"
                fill="var(--text)"
                stroke="var(--surface)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {current.symbol}
              </text>
            </g>
          )}
        </svg>
      )}
      <p className="footnote">
        {t(
          `顯示 ${points.length} / ${rows.length} 檔；缺少有效 RSI 或 RPS 者未繪圖。`,
          `Showing ${points.length} of ${rows.length} candidates; missing or invalid RSI/RPS values are excluded from the plot.`,
        )}
      </p>
      {current && (
        <div className="alpha-map-selection">
          <label>
            {t('檢視圖中標的', 'Inspect a Plotted Symbol')}
            <select value={current.symbol} onChange={(event) => setSelected(event.target.value)}>
              {points.map((row) => (
                <option key={row.symbol} value={row.symbol}>
                  {row.symbol} · {num(row.score, 0)} {t('分', 'points')}
                </option>
              ))}
            </select>
          </label>
          <div>
            <strong>
              {current.symbol} <span>{relation(current)}</span>
            </strong>
            <p>{current.name}</p>
            <small>
              RSI {num(current.row.indicators.rsi, 1)} · RPS {num(current.row.indicators.rps, 1)} ·
              Alpha {num(current.score, 0)} · {current.matched} {t('項策略符合', 'matches')}
            </small>
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={() => onStar(current.symbol)}>
              {shortlist.includes(current.symbol) ? <StarFilled size={15} /> : <Star size={15} />}
              {shortlist.includes(current.symbol)
                ? t('移除星號', 'Unstar')
                : t('加入研究清單', 'Star for Research')}
            </button>
            <button type="button" className="button" onClick={() => onOpen(current)}>
              {t('開啟個股', 'Open Symbol')}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
