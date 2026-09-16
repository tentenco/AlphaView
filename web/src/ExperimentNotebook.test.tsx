import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  comparable,
  EXPERIMENT_KEY,
  ExperimentNotebook,
  type SavedExperiment,
} from './ExperimentNotebook'
import type { BasketResult } from './AlphaBasket'
const result: BasketResult = {
  initial: 10000,
  final: 10200,
  return_pct: 2,
  benchmark_pct: 1,
  benchmark_error: null,
  max_drawdown_pct: -3,
  total_cost: 20,
  traded_notional: 20000,
  exposure_days: 20,
  sessions: 20,
  start: '2026-08-10',
  end: '2026-09-04',
  engine_version: 'alphaview-alpha-basket-v1',
  input_revision: 'r1',
  method: '',
  curve: [],
  events: [],
  final_holdings: [],
  final_cash: 0,
  sources: [],
  settings: {
    scope: 'market',
    days: 20,
    top: 5,
    rebalance: 5,
    initial: 10000,
    fee_bps: 10,
    weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
    threshold: 50,
    min_matches: 2,
  },
}
beforeEach(() => localStorage.clear())
it('shows current-minus-baseline differences only for matching data and allocation conditions', () => {
  const saved: SavedExperiment = {
    id: 'baseline',
    name: 'Baseline A',
    savedAt: '2026-09-07T00:00:00Z',
    result,
  }
  localStorage.setItem(EXPERIMENT_KEY, JSON.stringify([saved]))
  const current = { ...result, return_pct: 5, max_drawdown_pct: -2, total_cost: 25 }
  const { rerender } = render(
    <ExperimentNotebook current={current} locale="en" onRestore={vi.fn()} />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use as Comparison Baseline' }))
  expect(screen.getByText('+3.00')).toBeTruthy()
  expect(screen.getByText('+1.00')).toBeTruthy()
  expect(screen.getByText('+5.00')).toBeTruthy()
  rerender(
    <ExperimentNotebook
      current={{ ...current, input_revision: 'r2' }}
      locale="en"
      onRestore={vi.fn()}
    />,
  )
  expect(screen.queryByText('+3.00')).toBeNull()
  expect(
    screen.getByText(/Data version, dates, model, or allocation conditions differ/),
  ).toBeTruthy()
  expect(comparable(result, { ...result, settings: { ...result.settings, top: 10 } })).toBe(false)
})
