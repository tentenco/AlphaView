import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Strategies } from './Research'
import { backtest, deferred, overview, response } from './test/fixtures'

vi.mock('./Charts', () => ({ EquityChart: () => null, PriceChart: () => null, Sparkline: () => null }))

describe('strategy research request lifecycle', () => {
  it('keeps a fresh POST result when an older cached GET arrives afterwards', async () => {
    const cached = deferred<Response>()
    const posted = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(cached.promise).mockReturnValueOnce(posted.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<Strategies data={overview()}/>)
    await userEvent.click(screen.getByRole('button', { name: '執行回測' }))
    expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    await act(async () => { posted.resolve(response(backtest('NVDA', 'turtle', 'Fresh POST result'))) })
    expect(await screen.findByText(/Fresh POST result/)).toBeTruthy()
    await act(async () => { cached.resolve(response(backtest('NVDA', 'turtle', 'Old cached result'))) })
    expect(screen.queryByText(/Old cached result/)).toBeNull()
    expect(screen.getByText(/Fresh POST result/)).toBeTruthy()
  })

  it('ignores out-of-order symbol and strategy responses and includes market candidates only once', async () => {
    const first = deferred<Response>(); const second = deferred<Response>(); const third = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise))
    render(<Strategies data={overview()}/>)
    expect(screen.getAllByRole('option', { name: /NVDA/ })).toHaveLength(1)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '研究標的' }), 'DELL')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '交易策略' }), 'trend')
    await act(async () => { third.resolve(response(backtest('DELL', 'trend', 'Current DELL trend'))) })
    expect(await screen.findByText(/Current DELL trend/)).toBeTruthy()
    await act(async () => { first.resolve(response(backtest('NVDA', 'turtle', 'Old NVDA'))); second.resolve(response(backtest('DELL', 'turtle', 'Old DELL'))) })
    expect(screen.queryByText(/Old NVDA|Old DELL/)).toBeNull()
    expect(screen.getByText(/Current DELL trend/)).toBeTruthy()
  })

  it('locks strategy navigation while a run is pending and recovers after an API failure', async () => {
    const posted = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(null)).mockReturnValueOnce(posted.promise))
    render(<Strategies data={overview()}/>)
    await userEvent.click(screen.getByRole('button', { name: '執行回測' }))
    expect((screen.getByRole('button', { name: /均線趨勢.*trend/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: '研究標的' }) as HTMLSelectElement).disabled).toBe(true)
    await act(async () => { posted.resolve(new Response(JSON.stringify({ detail: '日線資料不足' }), { status: 400 })) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '日線資料不足')
    expect((screen.getByRole('button', { name: '執行回測' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: /均線趨勢.*trend/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('aborts an active POST on unmount and accepts a late response without a state update', async () => {
    const posted = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(response(null)).mockReturnValueOnce(posted.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<Strategies data={overview()}/>)
    await userEvent.click(screen.getByRole('button', { name: '執行回測' }))
    view.unmount()
    expect((fetcher.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(true)
    await act(async () => { posted.resolve(response(backtest())) })
    expect(screen.queryByText(/Fresh result/)).toBeNull()
  })

  it('falls back to available market members when NVDA is absent and handles an empty universe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(null)))
    const data = overview(); data.positions = []; data.market_universe = data.market_universe.filter(m => m.symbol === 'DELL')
    const view = render(<Strategies data={data}/>)
    expect((screen.getByRole('combobox', { name: '研究標的' }) as HTMLSelectElement).value).toBe('DELL')
    view.rerender(<Strategies data={{ ...data, market_universe: [] }}/>)
    await waitFor(() => expect((screen.getByRole('button', { name: '執行回測' }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByRole('option', { name: '尚無可研究標的' })).toBeTruthy()
  })
})


describe('backtest parameters and diagnostics', () => {
  it('sends explicit parameters and uses them in saved-result lookup', async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(response(init?.method === 'POST' ? backtest() : null)))
    vi.stubGlobal('fetch', fetcher)
    render(<Strategies data={overview()}/>)
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始資金（USD）' }), { target: { value: '25000' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '單邊交易成本（bps）' }), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('開始日期（選填）'), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText('結束日期（選填）'), { target: { value: '2026-01-01' } })
    await act(async () => {})
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain('initial=25000&fee_bps=25&start_date=2025-01-01&end_date=2026-01-01')
    await userEvent.click(screen.getByRole('button', { name: '執行回測' }))
    const posted = fetcher.mock.calls.find(call => call[1]?.method === 'POST')!
    expect(JSON.parse(posted[1]!.body as string)).toEqual({ symbol: 'NVDA', strategy: 'turtle', initial: 25000, fee_bps: 25, start_date: '2025-01-01', end_date: '2026-01-01' })
  })
  it('blocks invalid capital, costs and reversed dates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(null))))
    render(<Strategies data={overview()}/>)
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始資金（USD）' }), { target: { value: '0' } })
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '起始資金必須大於 0。')
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始資金（USD）' }), { target: { value: '10000' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '單邊交易成本（bps）' }), { target: { value: '101' } })
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '單邊交易成本須介於 0 至 100 bps。')
    fireEvent.change(screen.getByRole('spinbutton', { name: '單邊交易成本（bps）' }), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('開始日期（選填）'), { target: { value: '2026-09-05' } })
    fireEvent.change(screen.getByLabelText('結束日期（選填）'), { target: { value: '2025-09-05' } })
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '開始日期不可晚於結束日期。')
    expect((screen.getByRole('button', { name: '執行回測' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {})
  })
  it('renders supplied diagnostics, null ratios and sample/cache warnings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...backtest(), engine_version: '2', cagr_pct: 12.5,
      annualized_volatility_pct: 18, sharpe_ratio: null, win_rate_pct: null, profit_factor: null,
      exposure_pct: 30, avg_holding_days: null, trading_days: 120, warnings: ['Sample too small'], cache_stale: true })))
    render(<Strategies data={overview()}/>)
    expect(await screen.findByText('Sample too small')).toBeTruthy()
    expect(screen.getByText(/此回測使用較早的日線/)).toBeTruthy()
    expect(screen.getByText('年化報酬 CAGR')).toBeTruthy()
    expect(screen.getByText('Sharpe 比率').parentElement?.textContent).toBe('Sharpe 比率—')
  })
})
