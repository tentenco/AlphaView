import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StockModal } from './Research'
import { overview, position, response, deferred } from './test/fixtures'

vi.mock('./Charts', () => ({ PriceChart: () => null, EquityChart: () => null }))
beforeEach(() => {
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
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.startsWith('/api/notes/')
              ? { symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }
              : { position: position(), history: [], strategies: overview().strategies },
          ),
        ),
      ),
  )
})
describe('stock dialog unsaved research', () => {
  it('keeps the modal open until unsaved notes are explicitly discarded', async () => {
    const close = vi.fn()
    render(<StockModal symbol="NVDA" onClose={close} />)
    await userEvent.type(
      await screen.findByRole('textbox', { name: '研究內容' }),
      'Unsaved research',
    )
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByText('研究筆記尚未儲存，是否捨棄變更並關閉？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '繼續編輯筆記' }))
    expect(screen.queryByText('研究筆記尚未儲存，是否捨棄變更並關閉？')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    await userEvent.click(screen.getByRole('button', { name: '捨棄變更並關閉' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('intercepts native Escape cancellation for dirty notes but closes clean notes directly', async () => {
    const close = vi.fn()
    render(<StockModal symbol="NVDA" onClose={close} />)
    await userEvent.type(await screen.findByRole('textbox', { name: '研究內容' }), 'Draft')
    const event = new Event('cancel', { cancelable: true, bubbles: false })
    act(() => {
      screen.getByRole('dialog').dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(close).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '繼續編輯筆記' }))
    await userEvent.click(screen.getByRole('button', { name: '取消變更' }))
    fireEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('stock chart data integrity', () => {
  it('keeps missing chart points explicit and suppresses saved indicators for invalid data', async () => {
    const current = position('NVDA', [
      { strategy: 'trend', status: 'match', matched: true, reason: 'Old successful signal' },
    ])
    current.research!.indicators = { rsi: 64.9, volume_ratio: 2.5 }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.startsWith('/api/notes/')
              ? { symbol: 'NVDA', note: '', tags: [], version: 0, updated_at: null }
              : {
                  position: current,
                  history: [
                    {
                      date: '2026-09-03',
                      close: null,
                      ma50: null,
                      ma200: null,
                      rsi: null,
                      volume: null,
                    },
                  ],
                  strategies: overview().strategies,
                  quality: {
                    status: 'invalid',
                    valid: false,
                    invalid_count: 1,
                    issues: [{ date: '2026-09-03', reason: 'Invalid adjusted price' }],
                  },
                },
          ),
        ),
      ),
    )
    render(<StockModal symbol="NVDA" onClose={vi.fn()} />)
    expect(await screen.findByText('日線資料異常：1 筆')).toBeTruthy()
    await userEvent.click(screen.getByText('查看異常日期與原因'))
    expect(screen.getByText('2026-09-03：Invalid adjusted price')).toBeTruthy()
    expect(screen.getByText('RSI 14').textContent).toBe('RSI 14—')
    expect(screen.getByText('成交量比').textContent).toBe('成交量比—')
    expect(screen.queryByText('Old successful signal')).toBeNull()
    expect(screen.queryByText('符合條件')).toBeNull()
  })
})

describe('historical quote freshness', () => {
  it('uses the response target session for a stale historical quote, not today', async () => {
    const stock = position('NVDA')
    Object.assign(stock, {
      quote_status: 'stale',
      quote_reason: '歷史目標交易日前缺少日線',
      expected_session: '2026-08-28',
      price_date: '2026-08-27',
      price: 140,
      change_pct: 8.76,
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url.startsWith('/api/notes/')
                ? { symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }
                : { position: stock, history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<StockModal symbol="NVDA" asOf="2026-08-30" onClose={vi.fn()} />)
    expect(await screen.findByText('報價過期')).toBeTruthy()
    expect(screen.getByText(/應有交易日 2026-08-28/)).toBeTruthy()
    expect(screen.queryByText(/8.76|漲跌資料不完整/)).toBeNull()
  })
})

describe('open stock workspace refresh', () => {
  it('preserves dirty notes, selected chart range and close guard through refresh failure and retry', async () => {
    const failed = deferred<Response>()
    let stockCalls = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/notes/'))
        return Promise.resolve(
          response({ symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }),
        )
      stockCalls++
      if (stockCalls === 2) return failed.promise
      return Promise.resolve(
        response({
          position: { ...position(), price: stockCalls === 1 ? 150 : 175 },
          history: [],
          strategies: overview().strategies,
        }),
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const close = vi.fn()
    const view = render(<StockModal symbol="NVDA" revision="one" onClose={close} />)
    const note = await screen.findByRole('textbox', { name: '研究內容' })
    await userEvent.type(note, 'Preserve my draft')
    await userEvent.click(screen.getByRole('button', { name: '1M' }))
    view.rerender(<StockModal symbol="NVDA" revision="two" onClose={close} />)
    expect(screen.getByRole('textbox', { name: '研究內容' })).toBe(note)
    expect(note).toHaveProperty('value', 'Preserve my draft')
    expect(screen.getByRole('button', { name: '1M' }).className).toBe('active')
    await act(async () =>
      failed.resolve(new Response(JSON.stringify({ detail: '暫時無法讀取' }), { status: 503 })),
    )
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '暫時無法讀取 更新失敗，目前仍顯示上次載入資料，可能已過期；請重新載入。',
    )
    expect(screen.getByRole('textbox', { name: '研究內容' })).toBe(note)
    await userEvent.click(screen.getByRole('button', { name: '重新載入個股資料' }))
    expect(await screen.findByText('$175.00')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '研究內容' })).toBe(note)
    expect(fetcher.mock.calls.filter((call) => call[0].startsWith('/api/notes/'))).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(screen.getByText('研究筆記尚未儲存，是否捨棄變更並關閉？')).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
  })
  it('aborts old revision requests and ignores responses that arrive after a newer revision', async () => {
    const old = deferred<Response>()
    const fresh = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        url.startsWith('/api/notes/')
          ? Promise.resolve(
              response({ symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }),
            )
          : url.startsWith('/api/stocks/') &&
              fetcher.mock.calls.filter((call) => call[0].startsWith('/api/stocks/')).length === 1
            ? old.promise
            : fresh.promise,
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<StockModal symbol="NVDA" revision="one" onClose={vi.fn()} />)
    view.rerender(<StockModal symbol="NVDA" revision="two" onClose={vi.fn()} />)
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () =>
      fresh.resolve(
        response({ position: { ...position(), price: 175 }, history: [], strategies: [] }),
      ),
    )
    expect(await screen.findByText('$175.00')).toBeTruthy()
    await act(async () =>
      old.resolve(
        response({ position: { ...position(), price: 123 }, history: [], strategies: [] }),
      ),
    )
    expect(screen.queryByText('$123.00')).toBeNull()
  })
  it('recovers from the first load error through an explicit retry', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('/api/notes/'))
          return Promise.resolve(
            response({ symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }),
          )
        return Promise.resolve(
          ++calls === 1
            ? new Response(JSON.stringify({ detail: '初次載入失敗' }), { status: 503 })
            : response({ position: position(), history: [], strategies: [] }),
        )
      }),
    )
    render(<StockModal symbol="NVDA" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '初次載入失敗')
    await userEvent.click(screen.getByRole('button', { name: '重新載入個股資料' }))
    expect(await screen.findByRole('textbox', { name: '研究內容' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
