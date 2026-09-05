import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { num } from './ui'
import type { ComparisonResult } from './Comparison'
const COLORS = ['#54cba0', '#82b7ff', '#e0ba70', '#c79ae8', '#ec9292']
export default function ComparisonChart({ result }: { result: ComparisonResult }) {
  const eligible = result.series.filter((series) => series.eligible)
  const points = new Map(
    eligible.map((series) => [
      series.symbol,
      new Map(series.points.map((point) => [point.date, point.return_pct])),
    ]),
  )
  const data = result.dates.map((date) =>
    Object.fromEntries([
      ['date', date],
      ...eligible.map((series) => [series.symbol, points.get(series.symbol)?.get(date) ?? null]),
    ]),
  )
  return (
    <div
      className="comparison-chart"
      role="img"
      aria-label={`調整收盤價變化比較，${result.anchor_date} 為共同零基準；詳細數字見下方比較表`}
    >
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 10, right: 18, bottom: 8, left: 4 }}>
          <CartesianGrid vertical={false} stroke="#29312d" />
          <XAxis
            dataKey="date"
            tickFormatter={(value) => String(value).slice(5)}
            minTickGap={40}
            tick={{ fill: '#a2aaa5', fontSize: 11 }}
          />
          <YAxis
            tickFormatter={(value) => `${num(Number(value), 0)}%`}
            tick={{ fill: '#a2aaa5', fontSize: 11 }}
            width={58}
          />
          <Tooltip
            formatter={(value) => `${num(Number(value))}%`}
            contentStyle={{ background: '#151b18', border: '1px solid #34403a', color: '#e8eceb' }}
          />
          <Legend />
          {eligible.map((series, index) => (
            <Line
              key={series.symbol}
              dataKey={series.symbol}
              type="linear"
              stroke={COLORS[index]}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
