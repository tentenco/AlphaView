import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { deferred, overview, position, response } from './test/fixtures'
import type { Overview } from './types'

vi.mock('./Charts', () => ({ PriceChart: () => <div>Chart ready</div>, Sparkline: () => null }))
vi.mock('./Research', () => ({ Strategies: () => null, StockModal: ({ symbol, onClose }: {symbol:string;onClose:()=>void}) => <dialog open aria-label={`${symbol} details`}><textarea aria-label="Unsaved draft" defaultValue="Draft"/><button onClick={onClose}>Close stock</button></dialog> }))
vi.mock('./DataQuality', () => ({ DataQuality: () => null }))
const empty = (): Overview => ({ ...overview(), positions: [], market_universe: [], summary: { ...overview().summary, holding_count: 0, priced_count: 0, market_value: 0 } })
const running = (): Overview => ({ ...empty(), jobs: [{ id: 'job-1', scope: 'market', kind: 'refresh', status: 'running', started_at: '2026-09-05', finished_at: null, error: null, progress: 'Fetching market' }] })
beforeEach(() => {
  vi.useFakeTimers()
  location.hash = '#overview'
  vi.stubGlobal('scrollTo', vi.fn())
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterEach(() => { vi.useRealTimers() })
async function flush() { await act(async () => {}) }

describe('workspace integration', () => {
  it('shows an actionable empty chart and recovers when the first symbol is added', async () => {
    let populated = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(response(url === '/api/overview' ? populated ? overview() : empty() : { position: position(), history: [], strategies: [] }))))
    render(<App/>); await flush()
    expect(screen.getByText('先到「我的持股」新增觀察標的，再更新行情查看走勢。')).toBeTruthy()
    expect((screen.getByRole('button', { name: /查看技術指標/ }) as HTMLButtonElement).disabled).toBe(true)
    populated = true
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.getByText('Chart ready')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '走勢標的' }) as HTMLSelectElement).value).toBe('NVDA')
  })

  it('does not reopen global search over a stock dialog or another dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(response(url === '/api/overview' ? overview() : { position: position(), history: [], strategies: [] }))))
    render(<App/>); await flush()
    fireEvent.click(screen.getByRole('button', { name: /查看技術指標/ }))
    expect(screen.getByRole('dialog', { name: 'NVDA details' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('textbox', { name: '搜尋股票代碼或名稱' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toHaveProperty('value', 'Draft')
    fireEvent.click(screen.getByRole('button', { name: 'Close stock' }))
    fireEvent.click(screen.getByRole('button', { name: '使用說明' }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('textbox', { name: '搜尋股票代碼或名稱' })).toBeNull()
  })

  it('lets a manual refresh supersede a slow poll and ignores its late response', async () => {
    const oldPoll = deferred<Response>(); let overviewCalls = 0
    const newer = empty(); newer.summary.watch_count = 77
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/jobs') return Promise.resolve(response({ id: 'new-job' }))
      overviewCalls++
      return overviewCalls === 2 ? oldPoll.promise : Promise.resolve(response(overviewCalls === 1 ? empty() : newer))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<App/>); await flush()
    await act(async () => { vi.advanceTimersByTime(4000) })
    fireEvent.click(screen.getByRole('button', { name: '更新行情' })); await flush()
    expect(screen.getByText('0 檔持股 · 77 檔觀察')).toBeTruthy()
    const pollCall = fetcher.mock.calls.filter(call => call[0] === '/api/overview')[1]
    expect(pollCall[1].signal.aborted).toBe(true)
    await act(async () => { oldPoll.resolve(response(empty())) })
    expect(screen.getByText('0 檔持股 · 77 檔觀察')).toBeTruthy()
  })

  it('does not restart an in-flight poll every four seconds', async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<App/>); await flush()
    await act(async () => { vi.advanceTimersByTime(12000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(response(empty())) })
    expect(screen.getByText('先到「我的持股」新增觀察標的，再更新行情查看走勢。')).toBeTruthy()
  })

  it('requests cooperative cancellation and explains preserved complete scans', async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/cancel') ? { id: 'job-1', status: 'running', cancel_requested: true } : running())))
    vi.stubGlobal('fetch', fetcher)
    render(<App/>); await flush()
    fireEvent.click(screen.getByRole('button', { name: '取消作業' })); await flush()
    expect(fetcher.mock.calls.some(call => call[0] === '/api/jobs/job-1/cancel' && call[1].method === 'POST')).toBe(true)
    expect((screen.getByRole('button', { name: '取消中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('等待目前步驟停止，先前完整選股結果會保留。')).toBeTruthy()
  })

  it('shows cancellation errors and allows retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => url.endsWith('/cancel') ? Promise.reject(new Error('Offline')) : Promise.resolve(response(running()))))
    render(<App/>); await flush()
    fireEvent.click(screen.getByRole('button', { name: '取消作業' })); await flush()
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '取消作業失敗：Offline')
    expect((screen.getByRole('button', { name: '取消作業' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
