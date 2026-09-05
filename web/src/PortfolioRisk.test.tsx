import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { Portfolio } from './Portfolio'
import { position } from './test/fixtures'
import { describe, expect, it, vi } from 'vitest'
import { PortfolioRisk, type PortfolioRiskResult } from './PortfolioRisk'
import { deferred, response } from './test/fixtures'
vi.mock('./Charts', () => ({ Sparkline: () => null }))
function result(window: 60 | 120 = 60): PortfolioRiskResult {
  return {
    as_of: '2026-09-04',
    window,
    start: '2026-06-10',
    end: '2026-09-04',
    min_observations: 40,
    holding_count: 2,
    priced_count: 1,
    valuation_complete: false,
    market_value: 1000,
    largest_weight_pct: null,
    top3_weight_pct: null,
    holdings: [
      {
        symbol: 'AAPL',
        name: 'Apple',
        market_value: 1000,
        weight_pct: null,
        quote_status: 'ok',
        return_count: 59,
        history_status: 'ok',
        reason: null,
      },
      {
        symbol: 'MSFT',
        name: 'Microsoft',
        market_value: null,
        weight_pct: null,
        quote_status: 'stale',
        return_count: 0,
        history_status: 'stale',
        reason: '報價未達基準日',
      },
    ],
    pairs: [
      {
        left: 'AAPL',
        right: 'AAPL',
        correlation: 1,
        observations: 59,
        start: '2026-06-10',
        end: '2026-09-04',
        reason: null,
      },
      {
        left: 'AAPL',
        right: 'MSFT',
        correlation: null,
        observations: 0,
        start: null,
        end: null,
        reason: '資料過期，無法計算',
      },
    ],
    warnings: [],
    method: '使用調整收盤價日報酬的 Pearson 相關係數。',
  }
}
describe('portfolio risk diagnostics', () => {
  it('shows partial coverage and null correlation honestly without false weights or self pairs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result())))
    render(<PortfolioRisk />)
    await screen.findByText('可估值市值小計')
    expect(screen.getByText(/僅 1 \/ 2 檔具有當期可用估值/)).toBeTruthy()
    expect(screen.getByText('報價未達基準日')).toBeTruthy()
    const pairs = within(screen.getByRole('region', { name: '持倉成對相關性' }))
    expect(pairs.getAllByRole('row')).toHaveLength(2)
    expect(pairs.getByText('資料過期，無法計算')).toBeTruthy()
    expect(pairs.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.queryByText('100.0%')).toBeNull()
  })
  it('discards a late response from the previous window and shows actual pair samples', async () => {
    const old = deferred<Response>()
    const latest = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioRisk />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '相關性分析期間' }), '120')
    const next = result(120)
    next.pairs[1] = {
      ...next.pairs[1],
      correlation: 0.654,
      observations: 95,
      start: '2026-04-01',
      end: '2026-09-04',
      reason: null,
    }
    await act(async () => latest.resolve(response(next)))
    expect(await screen.findByText('0.654')).toBeTruthy()
    expect(screen.getByText('95')).toBeTruthy()
    await act(async () => old.resolve(response(result())))
    expect(screen.getByText('0.654')).toBeTruthy()
    expect(fetcher.mock.calls[1][0]).toBe('/api/portfolio/risk?window=120')
  })
  it('allows an explicit retry after API failure and explains an empty portfolio', async () => {
    const empty = { ...result(), holding_count: 0, priced_count: 0, holdings: [], pairs: [] }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: '分析暫時不可用' }), { status: 503 }),
      )
      .mockResolvedValueOnce(response(empty))
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioRisk />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '分析暫時不可用')
    await userEvent.click(screen.getByRole('button', { name: '重新計算風險概況' }))
    expect(await screen.findByText(/目前沒有實際持倉/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('refreshes on portfolio revision without making mutation requests', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(result())))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioRisk refreshKey="one" />)
    await screen.findByText('可估值市值小計')
    view.rerender(<PortfolioRisk refreshKey="two" />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls.every((call) => !call[1]?.method)).toBe(true)
  })
  it('aborts obsolete portfolio revisions and ignores late results after refresh or unmount', async () => {
    const old = deferred<Response>()
    const fresh = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioRisk refreshKey="old" />)
    const oldSignal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(<PortfolioRisk refreshKey="fresh" />)
    expect(oldSignal.aborted).toBe(true)
    const next = result()
    next.pairs[1] = { ...next.pairs[1], correlation: 0.321, observations: 45 }
    await act(async () => fresh.resolve(response(next)))
    expect(await screen.findByText('0.321')).toBeTruthy()
    await act(async () => old.resolve(response(result())))
    expect(screen.getByText('0.321')).toBeTruthy()
    const freshSignal = fetcher.mock.calls[1][1].signal as AbortSignal
    view.unmount()
    expect(freshSignal.aborted).toBe(true)
  })
  it('integrates with the portfolio and keeps labeled tables keyboard reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(result()))),
    )
    const open = vi.fn()
    const view = render(
      <Portfolio
        positions={[position('AAPL')]}
        onOpen={open}
        onEdit={vi.fn()}
        onAdd={vi.fn()}
        riskRefreshKey="portfolio-1"
      />,
    )
    await screen.findByText('可估值市值小計')
    const coverage = screen.getByRole('region', { name: '持倉資料覆蓋' })
    expect(coverage.tabIndex).toBe(0)
    expect(screen.getByRole('region', { name: '持倉成對相關性' }).tabIndex).toBe(0)
    await userEvent.click(within(coverage).getByRole('button', { name: 'AAPL' }))
    expect(open).toHaveBeenCalledWith('AAPL')
    const report = await axe.run(view.container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(
      report.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.html),
      })),
    ).toEqual([])
  })
  it.each([
    [12, '樣本不足'],
    [45, '部分日期可用'],
    [60, '可用'],
  ] as const)('distinguishes usable quote from %s return observations', async (count, label) => {
    const data = result()
    data.holdings[0].return_count = count
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
    render(<PortfolioRisk />)
    const region = await screen.findByRole('region', { name: '持倉資料覆蓋' })
    const row = within(region).getByText('AAPL').closest('tr')!
    expect(within(row).getByText(`可用／${label}`)).toBeTruthy()
    expect(screen.getByText(/單檔樣本足夠仍不代表兩檔有足夠共同樣本/)).toBeTruthy()
  })
})
