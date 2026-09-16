import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AlphaDashboard } from './AlphaDashboard'
import { overview } from './test/fixtures'
import { STRATEGY_IDS } from './alpha-model'
import type { Overview, Research } from './types'

function workspace(): Overview {
  const data = overview()
  data.summary.expected_session = '2026-09-04'
  const result = ['NVDA', 'DELL'].map((symbol, index): Research => ({
    symbol,
    name: symbol + ' Company',
    date: '2026-09-04',
    bars: 250,
    indicators: { close: 100, rsi: 60, rps: 90 - index },
    signals: STRATEGY_IDS.map((strategy) => ({
      strategy,
      matched: strategy === 'trend' || strategy === 'rps',
      status: strategy === 'trend' || strategy === 'rps' ? 'match' : 'watch',
      reason: 'test',
    })),
  }))
  data.market_scan = {
    id: 10,
    scope: 'market',
    as_of: '2026-09-04',
    created_at: '2026-09-05',
    input_status: 'current',
    matches_current_universe: true,
    universe: ['NVDA', 'DELL'],
    result,
  }
  return data
}
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
it('keeps research selection across card/table and locale changes, then hands it to comparison', () => {
  const onCompare = vi.fn()
  const props = {
    data: workspace(),
    busy: false,
    onOpen: vi.fn(),
    onScreener: vi.fn(),
    onData: vi.fn(),
    onRun: vi.fn(),
    onAdded: vi.fn(),
    onCompare,
    onLab: vi.fn(),
  }
  const { rerender } = render(<AlphaDashboard {...props} locale="en" />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Compare NVDA' }))
  fireEvent.click(screen.getByRole('button', { name: 'Star NVDA' }))
  fireEvent.click(screen.getByRole('button', { name: 'Table' }))
  expect((screen.getByRole('checkbox', { name: 'Compare NVDA' }) as HTMLInputElement).checked).toBe(
    true,
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'Compare DELL' }))
  rerender(<AlphaDashboard {...props} locale="zh-TW" />)
  expect(
    screen.getByRole('button', { name: '移除研究清單 NVDA' }).getAttribute('aria-pressed'),
  ).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '比較 2 檔' }))
  expect(onCompare).toHaveBeenCalledWith(['NVDA', 'DELL'])
  expect(props.onAdded).not.toHaveBeenCalled()
})
it('shows the current data prerequisite instead of ranking stale candidates', () => {
  const data = workspace()
  data.market_scan!.input_status = 'stale'
  render(
    <AlphaDashboard
      data={data}
      locale="en"
      busy={false}
      onOpen={vi.fn()}
      onScreener={vi.fn()}
      onData={vi.fn()}
      onRun={vi.fn()}
      onAdded={vi.fn()}
      onCompare={vi.fn()}
      onLab={vi.fn()}
    />,
  )
  expect(screen.getByText('Refresh research data to see Alpha rankings')).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: 'Compare NVDA' })).toBeNull()
})

it('clears restrictive indicator conditions when recovering to all rankings', () => {
  render(
    <AlphaDashboard
      data={workspace()}
      locale="en"
      busy={false}
      onOpen={vi.fn()}
      onScreener={vi.fn()}
      onData={vi.fn()}
      onRun={vi.fn()}
      onAdded={vi.fn()}
      onCompare={vi.fn()}
      onLab={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByText('Advanced Indicator Filters'))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum Alpha Score' }), {
    target: { value: '100' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply Indicator Filters' }))
  expect(screen.getByText('No candidates match these conditions')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View All Rankings' }))
  expect(screen.getByRole('checkbox', { name: 'Compare NVDA' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove Minimum Alpha Score condition' })).toBeNull()
})
