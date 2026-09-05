import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import { Comparison, type ComparisonResult } from './Comparison'
import { overview, response, deferred } from './test/fixtures'
vi.mock('./ComparisonChart', () => ({ default: () => <div data-testid="comparison-chart" /> }))
function result(): ComparisonResult {
  return {
    as_of: '2026-09-04',
    window: 120,
    anchor_date: '2026-03-16',
    end_date: '2026-09-04',
    expected_prices: 121,
    requested_count: 2,
    eligible_count: 2,
    complete: true,
    status: 'ready',
    input_revision: 'inputs:1',
    comparison_engine_version: 'alphaview-comparison-v1',
    dates: ['2026-03-16', '2026-09-04'],
    series: ['NVDA', 'DELL'].map((symbol) => ({
      symbol,
      name: symbol,
      source: 'Synthetic provider',
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
    warnings: [],
    method: '共同起點的調整收盤價變化。',
  }
}
describe('candidate price comparison', () => {
  it('requires explicit submission, limits selection to five and offers only known symbols', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const data = overview()
    data.market_universe.push(
      ...['AAPL', 'MSFT', 'META', 'GOOGL'].map((symbol) => ({
        symbol,
        name: symbol,
        discovered_at: 'today',
      })),
    )
    render(<Comparison data={data} onOpen={vi.fn()} />)
    expect(fetcher).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: /AAPL/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /MSFT/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /META/ }))
    expect(screen.getByRole('checkbox', { name: /GOOGL/ })).toHaveProperty('disabled', true)
    expect(screen.getByText('已選 5 / 5 檔')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('fetches readonly comparison with submitted settings and labels common anchor and coverage', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(result()))
    vi.stubGlobal('fetch', fetcher)
    const open = vi.fn()
    render(<Comparison data={overview()} onOpen={open} />)
    await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
    expect(await screen.findByText(/共同起點 2026-03-16/)).toBeTruthy()
    expect(await screen.findByTestId('comparison-chart')).toBeTruthy()
    expect(fetcher.mock.calls[0][0]).toBe('/api/comparison?symbols=NVDA%2CDELL&window=120')
    expect(fetcher.mock.calls[0][1].method).toBeUndefined()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '選擇其他標的' }))
    expect(screen.getByRole('checkbox', { name: /DELL/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'DELL' }))
    expect(open).toHaveBeenCalledWith('DELL', 'market', '2026-09-04')
  })
  it('withholds the chart for one eligible series and exposes the exact unavailable reason', async () => {
    const data = result()
    data.eligible_count = 1
    data.complete = false
    data.status = 'insufficient'
    data.series[1] = {
      ...data.series[1],
      eligible: false,
      reason: '共同起點缺少日線',
      observed_prices: 100,
      valid_prices: 100,
      anchor_price: null,
      latest_price: null,
      return_pct: null,
      points: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
    render(<Comparison data={overview()} onOpen={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
    expect(await screen.findByText(/可用標的不足兩檔/)).toBeTruthy()
    expect(screen.getByText('共同起點缺少日線')).toBeTruthy()
    expect(screen.queryByTestId('comparison-chart')).toBeNull()
    expect(screen.getByText('100 / 121')).toBeTruthy()
  })
  it('preserves submitted context while draft or workspace changes and never silently refetches', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(result()))
    vi.stubGlobal('fetch', fetcher)
    const data = { ...overview(), revision: 'one' }
    const view = render(<Comparison data={data} onOpen={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
    await screen.findByText(/共同起點 2026-03-16/)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '共同觀察期間' }), '60')
    expect(screen.getByText(/選擇條件已變更/)).toBeTruthy()
    view.rerender(<Comparison data={{ ...data, revision: 'two' }} onOpen={vi.fn()} />)
    expect(screen.getByText(/工作區資料版本已更新/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '共同觀察期間' })).toHaveProperty('value', '60')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('retries errors without altering selection and aborts on unmount', async () => {
    const pending = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: '比較讀取失敗' }), { status: 503 }),
      )
      .mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<Comparison data={overview()} onOpen={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '比較讀取失敗')
    await userEvent.click(screen.getByRole('button', { name: '重新嘗試比較' }))
    expect(screen.getByRole('button', { name: '正在比較…' })).toHaveProperty('disabled', true)
    view.unmount()
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    await act(async () => pending.resolve(response(result())))
  })
  it('has accessible names and a keyboard-focusable results region', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result())))
    const view = render(<Comparison data={overview()} onOpen={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '比較調整收盤價' }))
    expect((await screen.findByRole('region', { name: '價格比較結果與資料覆蓋' })).tabIndex).toBe(0)
    const audit = await axe.run(view.container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(audit.violations.map((item) => item.id)).toEqual([])
  })
})
