import { cloneElement } from 'react'
import type { ReactElement } from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PriceChart } from './Charts'

// Supply a deterministic viewport because jsdom cannot measure ResizeObserver layouts.
// All actual Recharts geometry and SVG path generation remain enabled.
vi.mock('recharts', async (original) => ({
  ...(await original<typeof import('recharts')>()),
  ResponsiveContainer: ({
    children,
  }: {
    children: ReactElement<{ width: number; height: number }>
  }) => cloneElement(children, { width: 600, height: 300 }),
}))
describe('price chart missing-data geometry', () => {
  it('renders separate line segments instead of connecting across a missing daily bar', async () => {
    const data = [100, 101, null, 103, 104].map((close, index) => ({
      date: `2026-09-0${index + 1}`,
      close,
      ma50: close,
      ma200: close,
    }))
    const view = render(<PriceChart data={data} />)
    await waitFor(() =>
      expect(view.container.querySelectorAll('.recharts-area-curve')).toHaveLength(3),
    )
    for (const line of view.container.querySelectorAll('.recharts-area-curve')) {
      // Two SVG move-to commands prove the missing bar starts a new segment.
      expect(line.getAttribute('d')?.match(/M/g)).toHaveLength(2)
    }
  })
})
