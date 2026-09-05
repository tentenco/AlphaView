import { cloneElement, type ReactElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import ComparisonChart from './ComparisonChart'
import type { ComparisonResult } from './Comparison'
vi.mock('recharts', async (original) => ({
  ...(await original<typeof import('recharts')>()),
  ResponsiveContainer: ({
    children,
  }: {
    children: ReactElement<{ width: number; height: number }>
  }) => cloneElement(children, { width: 600, height: 320 }),
}))
it('keeps common-date geometry, dotted ticker labels, and gaps without unavailable curves', async () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
  const series = (symbol: string, eligible: boolean, gap: boolean) => ({
    symbol,
    name: symbol,
    source: 'Synthetic',
    eligible,
    reason: eligible ? null : 'Unavailable',
    observed_prices: 5,
    valid_prices: 5,
    anchor_price: 100,
    latest_price: 110,
    return_pct: 10,
    points: eligible
      ? dates.flatMap((date, i) => (gap && i === 2 ? [] : [{ date, return_pct: i * 2.5 }]))
      : [],
  })
  const result: ComparisonResult = {
    as_of: dates[4],
    window: 60,
    anchor_date: dates[0],
    end_date: dates[4],
    expected_prices: 61,
    requested_count: 3,
    eligible_count: 2,
    complete: false,
    status: 'ready',
    input_revision: 'synthetic',
    comparison_engine_version: 'synthetic',
    dates,
    series: [
      series('BRK.B', true, true),
      series('MSFT', true, false),
      series('MISSING', false, false),
    ],
    warnings: [],
    method: '',
  }
  const view = render(<ComparisonChart result={result} />)
  await waitFor(() =>
    expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(2),
  )
  const curves = view.container.querySelectorAll('.recharts-line-curve')
  expect(curves[0].getAttribute('d')?.match(/M/g)).toHaveLength(2)
  expect(curves[1].getAttribute('d')?.match(/M/g)).toHaveLength(1)
  expect(screen.getByText('BRK.B')).toBeTruthy()
  expect(screen.queryByText('MISSING')).toBeNull()
})
