import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StockModal } from './Research'
import { overview, position, response } from './test/fixtures'

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
