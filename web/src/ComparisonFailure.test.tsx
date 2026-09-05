import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Comparison } from './Comparison'
import { overview, response } from './test/fixtures'
vi.mock('./ComparisonChart', async () => {
  throw new Error('Failed to fetch dynamically imported chart module')
})
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())
it('keeps data and export controls available when the lazy chart chunk rejects', async () => {
  const data = {
    as_of: '2026-09-04',
    window: 120,
    anchor_date: '2026-03-16',
    end_date: '2026-09-04',
    expected_prices: 121,
    requested_count: 2,
    eligible_count: 2,
    complete: true,
    status: 'ready',
    input_revision: 'one',
    comparison_engine_version: 'test',
    dates: ['2026-03-16', '2026-09-04'],
    warnings: [],
    method: '',
    series: ['NVDA', 'DELL'].map((symbol) => ({
      symbol,
      name: symbol,
      source: 'Synthetic',
      eligible: true,
      reason: null,
      observed_prices: 121,
      valid_prices: 121,
      anchor_price: 100,
      latest_price: 125,
      return_pct: 25,
      points: [
        { date: '2026-03-16', return_pct: 0 },
        { date: '2026-09-04', return_pct: 25 },
      ],
    })),
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
  render(<Comparison data={overview()} onOpen={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
  expect(await screen.findByText(/比較圖暫時無法顯示/)).toBeTruthy()
  expect(screen.getByRole('region', { name: '價格比較結果與資料覆蓋' })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: '共同觀察期間' })).toHaveProperty('value', '120')
  const createObjectURL = vi.fn().mockReturnValue('blob:still-exportable')
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.click(screen.getByRole('button', { name: '匯出比較摘要 CSV' }))
  expect(createObjectURL).toHaveBeenCalledTimes(1)
})
