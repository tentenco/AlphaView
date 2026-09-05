import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { deferred, overview, position, response } from './test/fixtures'
import type { Overview } from './types'

vi.mock('./Charts', () => ({ PriceChart: () => <div>Chart ready</div>, Sparkline: () => null }))
vi.mock('./Research', () => ({
  Strategies: () => null,
  StockModal: ({ symbol, onClose }: { symbol: string; onClose: () => void }) => (
    <dialog open aria-label={`${symbol} details`}>
      <textarea aria-label="Unsaved draft" defaultValue="Draft" />
      <button onClick={onClose}>Close stock</button>
    </dialog>
  ),
}))
vi.mock('./DataQuality', () => ({ DataQuality: () => null }))
const empty = (): Overview => ({
  ...overview(),
  positions: [],
  market_universe: [],
  summary: { ...overview().summary, holding_count: 0, priced_count: 0, market_value: 0 },
})
const running = (): Overview => ({
  ...empty(),
  jobs: [
    {
      id: 'job-1',
      scope: 'market',
      kind: 'refresh',
      status: 'running',
      started_at: '2026-09-05',
      finished_at: null,
      error: null,
      progress: 'Fetching market',
    },
  ],
})
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  location.hash = '#overview'
  vi.stubGlobal('scrollTo', vi.fn())
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
})
afterEach(() => {
  vi.useRealTimers()
})
async function flush() {
  await act(async () => {})
}

describe('workspace integration', () => {
  it('shows an actionable empty chart and recovers when the first symbol is added', async () => {
    let populated = false
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? populated
                  ? overview()
                  : empty()
                : { position: position(), history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<App />)
    await flush()
    expect(screen.getByText('先到「我的持股」新增觀察標的，再更新行情查看走勢。')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: /查看技術指標/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    populated = true
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    expect(screen.getByText('Chart ready')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '走勢標的' }) as HTMLSelectElement).value).toBe(
      'NVDA',
    )
  })

  it('does not reopen global search over a stock dialog or another dialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? overview()
                : { position: position(), history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<App />)
    await flush()
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
    const oldPoll = deferred<Response>()
    let overviewCalls = 0
    const newer = empty()
    newer.summary.watch_count = 77
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/jobs') return Promise.resolve(response({ id: 'new-job' }))
      overviewCalls++
      return overviewCalls === 2
        ? oldPoll.promise
        : Promise.resolve(response(overviewCalls === 1 ? empty() : newer))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    fireEvent.click(screen.getByRole('button', { name: '更新行情' }))
    await flush()
    expect(screen.getByText('0 檔持股 · 77 檔觀察')).toBeTruthy()
    const pollCall = fetcher.mock.calls.filter((call) => call[0] === '/api/overview')[1]
    expect(pollCall[1].signal.aborted).toBe(true)
    await act(async () => {
      oldPoll.resolve(response(empty()))
    })
    expect(screen.getByText('0 檔持股 · 77 檔觀察')).toBeTruthy()
  })

  it('does not restart an in-flight request during idle polling', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(90000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve(response(empty()))
    })
    expect(screen.getByText('先到「我的持股」新增觀察標的，再更新行情查看走勢。')).toBeTruthy()
  })

  it('requests cooperative cancellation and explains preserved complete scans', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.endsWith('/cancel')
              ? { id: 'job-1', status: 'running', cancel_requested: true }
              : running(),
          ),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '取消作業' }))
    await flush()
    expect(
      fetcher.mock.calls.some(
        (call) => call[0] === '/api/jobs/job-1/cancel' && call[1].method === 'POST',
      ),
    ).toBe(true)
    expect((screen.getByRole('button', { name: '取消中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByText('等待目前步驟停止，先前完整選股結果會保留。')).toBeTruthy()
  })

  it('shows cancellation errors and allows retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          url.endsWith('/cancel')
            ? Promise.reject(new Error('Offline'))
            : Promise.resolve(response(running())),
        ),
    )
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '取消作業' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '取消作業失敗：Offline')
    expect((screen.getByRole('button', { name: '取消作業' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})

describe('market expansion job plumbing', () => {
  it('sends the selected limit on a market refresh and omits it for portfolio refresh', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url === '/api/overview'
              ? empty()
              : url === '/api/jobs'
                ? { id: 'next-job' }
                : { scope: 'market', status: 'no_snapshot', current_date: null },
          ),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '每日選股' }))
    await flush()
    fireEvent.change(screen.getByRole('combobox', { name: '股票池上限' }), {
      target: { value: '500' },
    })
    fireEvent.click(screen.getByRole('button', { name: '執行市場選股' }))
    await flush()
    let posts = fetcher.mock.calls.filter((call) => call[0] === '/api/jobs')
    expect(JSON.parse(posts[0][1].body)).toEqual({
      kind: 'refresh',
      scope: 'market',
      universe_limit: 500,
    })
    fireEvent.change(screen.getByRole('combobox', { name: '選股範圍' }), {
      target: { value: 'portfolio' },
    })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '執行清單選股' }))
    await flush()
    posts = fetcher.mock.calls.filter((call) => call[0] === '/api/jobs')
    expect(JSON.parse(posts[1][1].body)).toEqual({ kind: 'refresh', scope: 'portfolio' })
  })
})

describe('portfolio valuation coverage', () => {
  it('shows a known subtotal without pretending the priced holding is the entire allocation', async () => {
    const data = overview()
    const missing = {
      ...position('DELL'),
      price: null,
      market_value: null,
      pnl: null,
      weight: null,
      change: null,
      change_pct: null,
      quote_status: 'unavailable' as const,
      quote_reason: 'Invalid latest close',
    }
    data.positions.push(missing)
    data.summary = {
      ...data.summary,
      market_value: 150,
      pnl: 25,
      holding_count: 2,
      priced_count: 1,
      partial: true,
      day_change: null,
      day_change_pct: null,
      day_change_partial: true,
      day_change_covered_count: 1,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? data
                : { position: position(), history: [], strategies: [] },
            ),
          ),
        ),
    )
    const view = render(<App />)
    await flush()
    expect(screen.getByText(/報價覆蓋 1 \/ 2 檔持股/)).toBeTruthy()
    expect(screen.getByText('部分持股缺少當期有效估值，暫不顯示配置比例。')).toBeTruthy()
    expect(view.container.querySelector('.allocation-bar')).toBeNull()
    expect(screen.getByText('當日損益').parentElement?.querySelector('h2')?.textContent).toBe('—')
    expect(screen.getByText(/持股總市值/).parentElement?.querySelector('h2')?.textContent).toBe(
      '$150.00',
    )
  })

  it('displays unavailable valuation as a placeholder', async () => {
    const data = overview()
    data.summary = {
      ...data.summary,
      market_value: null,
      pnl: null,
      day_change: null,
      priced_count: 0,
      partial: true,
      day_change_partial: true,
      day_change_covered_count: 0,
    }
    data.positions[0] = { ...data.positions[0], price: null, market_value: null, weight: null }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? data
                : { position: data.positions[0], history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<App />)
    await flush()
    expect(screen.getByText(/持股總市值/).parentElement?.querySelector('h2')?.textContent).toBe('—')
    expect(screen.getByText('未實現損益').parentElement?.querySelector('h2')?.textContent).toBe('—')
  })

  it('marks daily change unavailable even when every current price can be valued', async () => {
    const data = overview()
    data.summary = {
      ...data.summary,
      partial: false,
      day_change: null,
      day_change_pct: null,
      day_change_partial: true,
      day_change_covered_count: 0,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? data
                : { position: position(), history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<App />)
    await flush()
    expect(screen.getByText(/可比較 0 \/ 1 檔持股/)).toBeTruthy()
    expect(screen.getByText('當日損益').parentElement?.querySelector('h2')?.textContent).toBe('—')
    expect(screen.getByText(/持股總市值/).parentElement?.querySelector('h2')?.textContent).toBe(
      '$150.00',
    )
  })
})

describe('SQLite cancellation flags', () => {
  it('does not render a numeric zero for an unset cancellation flag', async () => {
    const data = running()
    data.jobs[0].cancel_requested = 0 as unknown as boolean
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(data))),
    )
    const view = render(<App />)
    await flush()
    const banner = view.container.querySelector('.job-banner')!
    expect(
      [...banner.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
    ).not.toContain('0')
    expect((screen.getByRole('button', { name: '取消作業' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})

describe('adaptive overview polling', () => {
  it('refreshes idle visible data every 30 seconds, not every four seconds', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(empty())))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(26000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('polls active jobs at four seconds then returns to the idle cadence', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(running()))
      .mockImplementation(() => Promise.resolve(response(empty())))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(26000)
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('pauses hidden-tab polling and coalesces visibility/focus into an immediate refresh', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(running())))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {
      vi.advanceTimersByTime(120000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('focus'))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('loads once even if initially hidden and retries errors at 30 seconds', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementation(() => Promise.resolve(response(empty())))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(60000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('backs off an active-job request failure instead of retrying every four seconds', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(running()))
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementation(() => Promise.resolve(response(running())))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(26000)
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('stale portfolio summary', () => {
  it('distinguishes valued stale holdings from current coverage and hides daily gain', async () => {
    const data = overview()
    Object.assign(data.summary, {
      partial: true,
      stale_count: 1,
      current_priced_count: 0,
      expected_session: '2026-09-04',
      day_change_partial: true,
      day_change: 9.87,
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url === '/api/overview'
                ? data
                : { position: position(), history: [], strategies: [] },
            ),
          ),
        ),
    )
    render(<App />)
    await flush()
    expect(screen.getByText(/有 1 檔持股報價過期/)).toBeTruthy()
    expect(screen.getByText(/當期報價覆蓋 0 \/ 1 檔/)).toBeTruthy()
    expect(screen.queryByText(/估值資料未完整，總市值與損益僅計入可用資料/)).toBeNull()
    expect(screen.getByText('當日損益').parentElement?.querySelector('h2')?.textContent).toBe('—')
  })
})

describe('revision-aware lightweight polling', () => {
  const full = (revision = 'db:1:session', jobs_revision = '0'): Overview => ({
    ...empty(),
    revision,
    jobs_revision,
  })
  it('polls only status when data is unchanged and fetches full data after revision changes', async () => {
    let changed = false
    const fetcher = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        response(
          url === '/api/status'
            ? {
                revision: changed ? 'db:2:session' : 'db:1:session',
                jobs_revision: '0',
                jobs: [],
              }
            : full(changed ? 'db:2:session' : 'db:1:session'),
        ),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/overview', '/api/status'])
    changed = true
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/overview',
      '/api/status',
      '/api/status',
      '/api/overview',
    ])
  })
  it('updates active job progress and completion without downloading unchanged market data', async () => {
    let calls = 0
    const initial = { ...running(), revision: 'db:1:session', jobs_revision: '1' }
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/overview') return Promise.resolve(response(initial))
      calls++
      return Promise.resolve(
        response({
          revision: initial.revision,
          jobs_revision: String(calls + 1),
          jobs: [
            {
              ...initial.jobs[0],
              progress: 'Progress updated',
              status: calls === 1 ? 'running' : 'completed',
            },
          ],
        }),
      )
    })
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText('Progress updated')).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('button', { name: '取消作業' })).toBeNull()
    expect(fetcher.mock.calls.filter((call) => call[0] === '/api/overview')).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => {
      vi.advanceTimersByTime(26000)
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('aborts slow status on manual refresh and ignores its late revision', async () => {
    const status = deferred<Response>()
    let fullCalls = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/status') return status.promise
      if (url === '/api/jobs') return Promise.resolve(response({ id: 'manual' }))
      fullCalls++
      return Promise.resolve(response(full(fullCalls === 1 ? 'old' : 'new')))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    fireEvent.click(screen.getByRole('button', { name: '更新行情' }))
    await flush()
    const statusCall = fetcher.mock.calls.find((call) => call[0] === '/api/status')!
    expect(statusCall[1].signal.aborted).toBe(true)
    await act(async () =>
      status.resolve(response({ revision: 'obsolete', jobs_revision: '9', jobs: [] })),
    )
    expect(fullCalls).toBe(2)
  })
  it('pauses status while hidden and coalesces focus and visibility return', async () => {
    const data = full()
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url === '/api/overview'
              ? data
              : { revision: data.revision, jobs_revision: '0', jobs: [] },
          ),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<App />)
    await flush()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {
      vi.advanceTimersByTime(60000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('focus'))
    await flush()
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/overview', '/api/status'])
  })
})

it('does not present retained stale scan matches as current overview signals', async () => {
  const data = overview()
  data.summary.research_available = false
  data.summary.matched_count = null
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url === '/api/overview' ? data : { position: position(), history: [], strategies: [] },
          ),
        ),
      ),
  )
  render(<App />)
  await flush()
  expect(screen.getByText(/目前沒有與當期行情一致的選股快照/)).toBeTruthy()
  expect(
    screen.getByText('符合策略的標的').parentElement?.querySelector('h2')?.textContent,
  ).toContain('—')
  expect(screen.getAllByText('待重算')).toHaveLength(data.strategies.length)
  expect(screen.queryByText('持續觀察')).toBeNull()
})

it('refreshes the home chart when data changes without a download timestamp change', async () => {
  let revision = 'first'
  let chartReads = 0
  const fetcher = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/overview') return Promise.resolve(response({ ...overview(), revision }))
    if (url === '/api/status')
      return Promise.resolve(response({ revision, jobs_revision: '0', jobs: [] }))
    if (url.startsWith('/api/stocks/')) {
      chartReads++
      return Promise.resolve(
        response({
          position: { ...position(), price: chartReads === 1 ? 111 : 222 },
          history: [],
          strategies: [],
        }),
      )
    }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  render(<App />)
  await flush()
  expect(screen.getByText('$111.00')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '1M' }))
  revision = 'second'
  await act(async () => {
    vi.advanceTimersByTime(30000)
  })
  await flush()
  expect(chartReads).toBe(2)
  expect(screen.getByText('$222.00')).toBeTruthy()
  expect(screen.queryByText('$111.00')).toBeNull()
  expect(screen.getByRole('button', { name: '1M' }).className).toContain('active')
})

it('retries a failed home chart read without starting a data job', async () => {
  let failed = true
  const fetcher = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/overview') return Promise.resolve(response(overview()))
    if (url.startsWith('/api/stocks/'))
      return failed
        ? Promise.reject(new Error('Chart temporarily unavailable'))
        : Promise.resolve(response({ position: position(), history: [], strategies: [] }))
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  render(<App />)
  await flush()
  expect(screen.getByRole('alert').textContent).toContain('Chart temporarily unavailable')
  failed = false
  fireEvent.click(screen.getByRole('button', { name: '重新讀取走勢' }))
  await flush()
  expect(screen.getByText('Chart ready')).toBeTruthy()
  expect(screen.queryByText('Chart temporarily unavailable')).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => url === '/api/jobs')).toBe(false)
})
