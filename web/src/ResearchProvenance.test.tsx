import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { Strategies, StockModal } from './Research'
import { backtest, overview, response, deferred, position } from './test/fixtures'

vi.mock('./Charts', () => ({
  EquityChart: () => null,
  PriceChart: () => null,
  Sparkline: () => null,
}))

it('revalidates a visible saved backtest after the workspace data revision changes', async () => {
  const fresh = { ...backtest('NVDA', 'turtle', 'Saved result'), cache_stale: false }
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(fresh))
    .mockResolvedValueOnce(response({ ...fresh, cache_stale: true }))
  vi.stubGlobal('fetch', fetcher)
  const data = { ...overview(), revision: 'workspace:1:2026-09-04' }
  const view = render(<Strategies data={data} />)
  expect(await screen.findByText(/Saved result/)).toBeTruthy()
  await act(async () => {
    view.rerender(<Strategies data={{ ...data, revision: 'workspace:2:2026-09-04' }} />)
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await screen.findByText(/此回測使用較早的日線或計算版本/)).toBeTruthy()
})

it('defers freshness revalidation until an active POST completes', async () => {
  const post = deferred<Response>()
  const fresh = backtest('NVDA', 'turtle', 'Original')
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(fresh))
    .mockReturnValueOnce(post.promise)
    .mockResolvedValueOnce(response({ ...fresh, cache_stale: true }))
  vi.stubGlobal('fetch', fetcher)
  const data = { ...overview(), revision: 'first' }
  const view = render(<Strategies data={data} />)
  await screen.findByText(/Original/)
  await userEvent.click(screen.getByRole('button', { name: '執行回測' }))
  view.rerender(<Strategies data={{ ...data, revision: 'second' }} />)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(false)
  await act(async () => post.resolve(response(backtest('NVDA', 'turtle', 'POST finished'))))
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(await screen.findByText(/此回測使用較早的日線或計算版本/)).toBeTruthy()
})
it('ignores late freshness checks after changing the selected symbol', async () => {
  const late = deferred<Response>()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(backtest('NVDA', 'turtle', 'Original')))
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce(response(backtest('DELL', 'turtle', 'Current selection')))
  vi.stubGlobal('fetch', fetcher)
  const data = { ...overview(), revision: 'first' }
  const view = render(<Strategies data={data} />)
  await screen.findByText(/Original/)
  view.rerender(<Strategies data={{ ...data, revision: 'second' }} />)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '研究標的' }), 'DELL')
  expect(await screen.findByText(/Current selection/)).toBeTruthy()
  await act(async () =>
    late.resolve(response({ ...backtest('NVDA', 'turtle', 'Obsolete check'), cache_stale: true })),
  )
  expect(screen.queryByText(/Obsolete check/)).toBeNull()
  expect(screen.getByText(/Current selection/)).toBeTruthy()
})
it('revalidates relevant dataset versions when a legacy overview has no revision', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(backtest()))
    .mockResolvedValueOnce(response({ ...backtest(), cache_stale: true }))
  vi.stubGlobal('fetch', fetcher)
  const data = overview()
  const view = render(<Strategies data={data} />)
  await act(async () => {})
  const updated = {
    ...data,
    datasets: [
      ...data.datasets.filter((item) => item.symbol !== 'NVDA'),
      { symbol: 'NVDA', fetched_at: 'new' } as (typeof data.datasets)[number],
    ],
  }
  view.rerender(<Strategies data={updated} />)
  expect(await screen.findByText(/此回測使用較早的日線或計算版本/)).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('explains withheld stock signals with their original snapshot date and scope', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
  const stock = {
    ...position(),
    research: null,
    research_context: {
      snapshot_id: 42,
      as_of: '2026-08-28',
      created_at: '2026-08-29T00:00:00Z',
      scope: 'market',
      input_status: 'stale',
      available: false,
      reason: '日線已更新，原選股結果不再對應目前資料。',
    },
  }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.startsWith('/api/notes/')
              ? { symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }
              : { position: stock, history: [], strategies: overview().strategies },
          ),
        ),
      ),
  )
  render(<StockModal symbol="NVDA" onClose={vi.fn()} />)
  expect(await screen.findByText('選股需要重算')).toBeTruthy()
  expect(screen.getByText(/原快照 #42.*市場股票池.*選股日期 2026-08-28/)).toBeTruthy()
  expect(screen.queryByText('持續觀察')).toBeNull()
})
