import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionSweepHistory } from './ExecutionSweepHistory'

const accountId = 'synthetic-sweep-account'
const base = `/api/execution/accounts/${accountId}/sweep-history`
const loadName = 'Load sweep history'
const openName = 'Review sweep event'
function detail(id = 'synthetic-event-1', owner = accountId) {
  return {
    id,
    account_id: owner,
    submission_id: 'synthetic-submission',
    created_at: '2026-10-02T20:00:00Z',
    engine_version: 'alphaview-execution-sweep-history-v1',
    content_fingerprint: 'a'.repeat(64),
    integrity: { available: true, reason: null as string | null },
    at: '2026-10-02T19:59:00Z',
    reason: 'kill_switch_enabled',
    results_count: 2,
    counts: { cancel_requested: 1, unknown: 1 },
    event: {
      engine_version: 'alphaview-execution-sweep-history-v1',
      account_id: owner,
      submission_id: 'synthetic-submission',
      at: '2026-10-02T19:59:00Z',
      reason: 'kill_switch_enabled',
      results: [
        {
          order_id: 'synthetic-order-a',
          submission_id: 'synthetic-submission',
          symbol: 'SYNTA',
          side: 'buy',
          previous_status: 'accepted',
          action: 'cancel_requested',
          error: null,
        },
        {
          order_id: 'synthetic-order-b',
          submission_id: 'synthetic-submission',
          symbol: 'SYNTB',
          side: 'sell',
          previous_status: 'partially_filled',
          action: 'unknown',
          error: { code: 'not_found', message: 'Synthetic broker response.', http_status: 404 },
        },
      ],
    },
  }
}
function item(id = 'synthetic-event-1', owner = accountId) {
  const { event: _event, ...summary } = detail(id, owner)
  return summary
}
function page(items: unknown[] = [item()], offset = 0, total = items.length, owner = accountId) {
  return {
    engine_version: 'alphaview-execution-sweep-history-v1',
    account_id: owner,
    items,
    pagination: { limit: 20, offset, total, returned: items.length },
    method: 'Synthetic historical values.',
    warnings: [],
  }
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const load = () => fireEvent.click(screen.getByRole('button', { name: loadName }))
async function open(index = 0) {
  fireEvent.click((await screen.findAllByRole('button', { name: openName }))[index])
}
function fixtureFetch(list: unknown = page(), event: unknown = detail()) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    response(url.includes('?') ? list : event),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

describe('saved sweep event history', () => {
  it('loads only on explicit demand and shows immutable historical per-order results with no execution controls or mutation requests', async () => {
    const fetcher = fixtureFetch()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/historical cancel request does not confirm cancellation/)).toBeTruthy()
    load()
    await open()
    const panel = await screen.findByRole('region', { name: 'Historical sweep event details' })
    expect(
      within(panel)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Symbol',
      'Recorded sweep action',
      'Saved pre-sweep status',
      'Recorded sweep error',
      'Side',
      'Order ID',
    ])
    const first = within(panel).getByRole('rowheader', { name: 'SYNTA' }).closest('tr')!
    expect(within(first).getAllByRole('cell').at(-1)?.textContent).toBe('synthetic-order-a')
    expect(
      within(panel).getByText('Account pause enabled (kill_switch_enabled)', { exact: false }),
    ).toBeTruthy()
    expect(within(panel).getByText('Accepted (accepted)')).toBeTruthy()
    expect(
      within(panel).getByText('Cancel request recorded (cancel_requested)', { selector: 'td' }),
    ).toBeTruthy()
    expect(within(panel).getByText(/Broker could not find this order \(not_found\)/)).toBeTruthy()
    expect(within(panel).getByText(/HTTP 404/)).toBeTruthy()
    expect(within(panel).getByText('Synthetic broker response.')).toBeTruthy()
    expect(
      within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Download sweep event JSON'])
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${base}?limit=20&offset=0`,
      `${base}/synthetic-event-1`,
    ])
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    )
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(true)
  })

  it('uses bilingual known codes and retains unknown historical codes once', async () => {
    const saved = detail()
    saved.reason = saved.event.reason = 'future_sweep_trigger'
    saved.event.results[0].previous_status = 'future_order_status'
    saved.event.results[0].action = 'future_action'
    saved.event.results[1].error!.code = 'future_error'
    fixtureFetch(page([{ ...item(), reason: saved.reason }]), saved)
    render(<ExecutionSweepHistory accountId={accountId} locale="zh-TW" />)
    fireEvent.click(screen.getByRole('button', { name: '讀取清掃歷程' }))
    fireEvent.click(await screen.findByRole('button', { name: '檢閱清掃事件' }))
    const panel = await screen.findByRole('region', { name: '歷史清掃事件明細' })
    expect(within(panel).getByText('部分成交 (partially_filled)')).toBeTruthy()
    for (const value of ['future_order_status', 'future_action'])
      expect(within(panel).getByText(value)).toBeTruthy()
    expect(
      within(panel)
        .getByText(/future_error/)
        .textContent?.match(/future_error/g),
    ).toHaveLength(1)
    expect(
      within(panel)
        .getByText(/future_sweep_trigger/)
        .textContent?.match(/future_sweep_trigger/g),
    ).toHaveLength(1)
  })

  it('paginates in groups of 20 and prevents duplicate in-flight list requests', async () => {
    let finish!: (result: ReturnType<typeof response>) => void
    const first = Array.from({ length: 20 }, (_, index) => item(`synthetic-event-${index}`))
    const fetcher = vi.fn((url: string) => {
      if (url.includes('offset=20'))
        return Promise.resolve(response(page([item('synthetic-last')], 20, 21)))
      return new Promise<ReturnType<typeof response>>((resolve) => {
        finish = resolve
      })
    })
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    const button = screen.getByRole('button', { name: loadName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => finish(response(page(first, 0, 21))))
    expect(screen.getAllByRole('button', { name: openName })).toHaveLength(20)
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: openName })
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await act(async () => finish(response(page(first, 0, 21))))
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${base}?limit=20&offset=0`,
      `${base}?limit=20&offset=20`,
      `${base}?limit=20&offset=0`,
    ])
  })

  it.each(['list', 'detail'] as const)(
    'aborts pending %s on account change and never adopts the late response or automatically loads the next account',
    async (phase) => {
      let finish!: (value: ReturnType<typeof response>) => void
      let signal: AbortSignal | null | undefined
      const fetcher = vi.fn((url: string, init?: RequestInit) => {
        if (phase === 'detail' && url.includes('?')) return Promise.resolve(response(page()))
        signal = init?.signal
        return new Promise<ReturnType<typeof response>>((done) => {
          finish = done
        })
      })
      vi.stubGlobal('fetch', fetcher)
      const view = render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      load()
      if (phase === 'detail') await open()
      const calls = fetcher.mock.calls.length
      view.rerender(<ExecutionSweepHistory accountId="synthetic-next-account" locale="en" />)
      expect(signal?.aborted).toBe(true)
      await act(async () => finish(response(phase === 'list' ? page() : detail())))
      expect(fetcher.mock.calls).toHaveLength(calls)
      expect(screen.queryByRole('button', { name: openName })).toBeNull()
      expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
      expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', false)
    },
  )

  it('renders corrupted content as unavailable and never uses corrupt counts or entries', async () => {
    const corrupt = {
      ...item(),
      integrity: { available: false, reason: 'content_mismatch' },
      at: null,
      reason: null,
      results_count: null,
      counts: null,
    }
    fixtureFetch(page([corrupt]), { ...corrupt, event: null })
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    await open()
    const panel = await screen.findByRole('region', { name: 'Historical sweep event details' })
    expect(within(panel).getByText('Saved evidence unavailable · content_mismatch')).toBeTruthy()
    expect(within(panel).queryByRole('table')).toBeNull()
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent)
    expect(cells).toContain('—')
    expect(cells).not.toContain('0')
  })

  it('keeps missing historical cells unavailable and never interprets a missing action as skipped', async () => {
    const saved = detail()
    Object.assign(saved.event.results[0], {
      previous_status: null,
      action: null,
      symbol: null,
      side: null,
    })
    fixtureFetch(page(), saved)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    await open()
    const panel = await screen.findByRole('region', { name: 'Historical sweep event details' })
    const row = within(panel).getByRole('cell', { name: 'synthetic-order-a' }).closest('tr')!
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['—', '—', '—', '—', 'synthetic-order-a'])
  })

  it.each(['account', 'item_account', 'pagination', 'duplicate', 'invalid_count'] as const)(
    'rejects %s list corruption',
    async (damage) => {
      const saved = page()
      if (damage === 'account') saved.account_id = 'synthetic-wrong'
      if (damage === 'item_account') saved.items = [item('synthetic-other', 'synthetic-wrong')]
      if (damage === 'pagination') saved.pagination.offset = 20
      if (damage === 'duplicate') {
        saved.items = [item(), item()]
        saved.pagination.total = saved.pagination.returned = 2
      }
      if (damage === 'invalid_count') saved.items = [{ ...item(), counts: { skipped: -1 } }]
      fixtureFetch(saved)
      render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      load()
      expect((await screen.findByRole('alert')).textContent).toContain(
        'account, submission or pagination does not match',
      )
      expect(screen.queryByRole('button', { name: openName })).toBeNull()
    },
  )

  it.each([
    'account',
    'id',
    'submission',
    'fingerprint',
    'event_account',
    'event_submission',
    'order_submission',
    'duplicate_order',
    'missing_event',
  ] as const)('rejects inconsistent %s detail', async (damage) => {
    const saved = detail()
    if (damage === 'account') saved.account_id = 'synthetic-wrong'
    if (damage === 'id') saved.id = 'synthetic-wrong'
    if (damage === 'submission') saved.submission_id = 'synthetic-wrong'
    if (damage === 'fingerprint') saved.content_fingerprint = 'b'.repeat(64)
    if (damage === 'event_account') saved.event.account_id = 'synthetic-wrong'
    if (damage === 'event_submission') saved.event.submission_id = 'synthetic-wrong'
    if (damage === 'order_submission') saved.event.results[0].submission_id = 'synthetic-wrong'
    if (damage === 'duplicate_order')
      saved.event.results[1].order_id = saved.event.results[0].order_id
    fixtureFetch(page(), damage === 'missing_event' ? { ...saved, event: null } : saved)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    await open()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'identity does not match or its content cannot be verified',
    )
    expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
  })

  it('guards duplicate detail clicks and clears previous detail during a failed subsequent read', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn((url: string) => {
      if (url.includes('?'))
        return Promise.resolve(response(page([item(), item('synthetic-event-2')])))
      if (url.endsWith('synthetic-event-1')) return Promise.resolve(response(detail()))
      return new Promise<ReturnType<typeof response>>((resolve) => {
        finish = resolve
      })
    })
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    await open()
    await screen.findByRole('region', { name: 'Historical sweep event details' })
    const second = screen.getAllByRole('button', { name: openName })[1]
    fireEvent.click(second)
    fireEvent.click(second)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
    await act(async () => finish(response({ detail: { code: 'sweep_event_not_found' } }, 404)))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'missing or belongs to another account',
    )
    expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
  })

  it('reports a local request failure rather than claiming an empty history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({}, 503)),
    )
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sweep history request failed (503)',
    )
    expect(screen.queryByText(/No saved sweep events on this page/)).toBeNull()
  })

  it('shows an explicit empty account history and never creates events from older summaries', async () => {
    const fetcher = fixtureFetch(page([]))
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    expect(
      await screen.findByText(
        'No saved sweep events on this page; older summaries are not backfilled.',
      ),
    ).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
  })

  it('stops at the API offset bound and discloses older undisplayed events without changing the total', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const offset = Number(url.match(/offset=(\d+)/)![1])
      const rows = Array.from({ length: 20 }, (_, index) =>
        item(`synthetic-event-${offset + index}`),
      )
      return response(page(rows, offset, 5021))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    for (let offset = 0; offset <= 5000; offset += 20) {
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: offset === 0 ? loadName : 'Next page' }),
        ),
      )
    }
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(fetcher).toHaveBeenCalledTimes(251)
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`${base}?limit=20&offset=5000`)
    expect(screen.getByText('Saved account event count: 5021')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(
      'Earlier saved events remain undisplayed',
    )
  }, 15000)
})

const scopeControl = () => screen.getByRole('combobox', { name: 'Sweep history scope' })
const chooseScope = (value: 'account' | 'submission') =>
  fireEvent.change(scopeControl(), { target: { value } })
const selectedSubmissionId = 'synthetic-submission'

describe('sweep history submission scope', () => {
  it('defaults to the account and requires an explicit load after switching to the selected submission', async () => {
    const fetcher = fixtureFetch()
    render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    expect(scopeControl()).toHaveProperty('value', 'account')
    expect(fetcher).not.toHaveBeenCalled()
    load()
    await screen.findByRole('button', { name: openName })
    chooseScope('submission')
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(`Selected submission: ${selectedSubmissionId}`)).toBeTruthy()
    load()
    await open()
    await screen.findByRole('region', { name: 'Historical sweep event details' })
    expect(screen.getByText('Saved selected-submission event count: 1')).toBeTruthy()
    expect(screen.queryByText(/Saved account event count:/)).toBeNull()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${base}?limit=20&offset=0`,
      `${base}?limit=20&offset=0&submission_id=${selectedSubmissionId}`,
      `${base}/synthetic-event-1`,
    ])
    chooseScope('account')
    expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each(['list', 'detail'] as const)(
    'aborts filtered %s when the selected submission changes and ignores a late old result',
    async (phase) => {
      let finish!: (value: ReturnType<typeof response>) => void
      let signal: AbortSignal | null | undefined
      const fetcher = vi.fn((url: string, init?: RequestInit) => {
        if (phase === 'detail' && url.includes('?')) return Promise.resolve(response(page()))
        signal = init?.signal
        return new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        })
      })
      vi.stubGlobal('fetch', fetcher)
      const view = render(
        <ExecutionSweepHistory
          accountId={accountId}
          selectedSubmissionId={selectedSubmissionId}
          locale="en"
        />,
      )
      chooseScope('submission')
      load()
      if (phase === 'detail') await open()
      const previousCalls = fetcher.mock.calls.length
      view.rerender(
        <ExecutionSweepHistory
          accountId={accountId}
          selectedSubmissionId="synthetic-next-submission"
          locale="en"
        />,
      )
      expect(signal?.aborted).toBe(true)
      expect(scopeControl()).toHaveProperty('value', 'submission')
      await act(async () => finish(response(phase === 'list' ? page() : detail())))
      expect(fetcher).toHaveBeenCalledTimes(previousCalls)
      expect(screen.queryByRole('button', { name: openName })).toBeNull()
      expect(screen.queryByRole('region', { name: 'Historical sweep event details' })).toBeNull()
      expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', false)
    },
  )

  it('aborts a pending account read when the scope changes without automatically fetching the new scope', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    load()
    chooseScope('submission')
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => finish(response(page())))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', false)
  })

  it('keeps an account-wide read and its displayed results when only the parent selected submission changes', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    load()
    view.rerender(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId="synthetic-next-submission"
        locale="en"
      />,
    )
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await act(async () => finish(response(page())))
    await screen.findByRole('button', { name: openName })
    view.rerender(
      <ExecutionSweepHistory accountId={accountId} selectedSubmissionId={null} locale="en" />,
    )
    expect(screen.getByRole('button', { name: openName })).toBeTruthy()
    expect(scopeControl()).toHaveProperty('value', 'account')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('cannot request a submission filter without a selection and clears filtered results when selection is lost', async () => {
    const fetcher = fixtureFetch()
    const view = render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    expect(screen.getByRole('option', { name: 'Currently selected submission' })).toHaveProperty(
      'disabled',
      true,
    )
    chooseScope('submission')
    load()
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', true)
    view.rerender(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    load()
    await screen.findByRole('button', { name: openName })
    view.rerender(
      <ExecutionSweepHistory accountId={accountId} selectedSubmissionId={null} locale="en" />,
    )
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', true)
    expect(screen.getByText(/No submission is selected/)).toBeTruthy()
    load()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects the entire filtered list when any event belongs to a different submission', async () => {
    const fetcher = fixtureFetch(
      page([item(), { ...item('synthetic-other-event'), submission_id: 'synthetic-unrelated' }]),
    )
    render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    chooseScope('submission')
    load()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'account, submission or pagination does not match',
    )
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves the submission filter through pagination and names an empty filtered page without claiming account-wide absence', async () => {
    const fetcher = vi.fn(async (url: string) =>
      response(
        url.includes('offset=20')
          ? page([], 20, 21)
          : page(
              Array.from({ length: 20 }, (_, index) => item(`synthetic-event-${index}`)),
              0,
              21,
            ),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    chooseScope('submission')
    load()
    await screen.findAllByRole('button', { name: openName })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(
      await screen.findByText(
        'No saved sweep events for this submission on this page; older summaries are not backfilled.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Saved selected-submission event count: 21')).toBeTruthy()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${base}?limit=20&offset=0&submission_id=${selectedSubmissionId}`,
      `${base}?limit=20&offset=20&submission_id=${selectedSubmissionId}`,
    ])
  })
})

const downloadName = 'Download sweep event JSON'
function mockDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:sweep-event')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const links: { filename: string; attached: boolean; href: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push({ filename: this.download, attached: this.isConnected, href: this.href })
  })
  const timeout = window.setTimeout.bind(window)
  const revocations: (() => void)[] = []
  vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
    if (delay !== 10000) return timeout(callback, delay)
    revocations.push(callback as () => void)
    return 1
  })
  return { createObjectURL, revokeObjectURL, links, revocations }
}
async function readJson(blob: Blob) {
  return JSON.parse(
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    }),
  )
}
async function readEvent() {
  load()
  await open()
  return screen.findByRole('button', { name: downloadName })
}

describe('exact saved sweep event JSON download', () => {
  it('keeps account-wide history visible but invalidates its export when the parent selected submission changes', async () => {
    fixtureFetch()
    const download = mockDownload()
    const view = render(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId={selectedSubmissionId}
        locale="en"
      />,
    )
    const oldButton = await readEvent()
    view.rerender(
      <ExecutionSweepHistory
        accountId={accountId}
        selectedSubmissionId="synthetic-next-submission"
        locale="en"
      />,
    )
    expect(screen.getByRole('region', { name: 'Historical sweep event details' })).toBeTruthy()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    fireEvent.click(oldButton)
    expect(download.createObjectURL).not.toHaveBeenCalled()
    await open()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', false),
    )
  })
  it('downloads the full accepted detail envelope including unknown nested fields and nulls without any extra fetch or changed values', async () => {
    const original = detail()
    const server = {
      ...original,
      future_read_context: { current: null, missing: null, text: '合成 "來源"\n第二行' },
      integrity: { ...original.integrity, future_integrity: null },
      event: {
        ...original.event,
        future_immutable_context: { values: [null, 0, false, 1.23456789012345] },
        results: original.event.results.map((row) => ({ ...row, future_order_value: null })),
      },
    }
    const expected = structuredClone(server)
    const fetcher = fixtureFetch(page(), server)
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    fireEvent.click(await readEvent())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(download.createObjectURL).toHaveBeenCalledTimes(1)
    const blob = download.createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(await readJson(blob)).toEqual(expected)
    expect(server).toEqual(expected)
    expect(download.links).toEqual([
      {
        filename: `alphaview-sweep-event-${server.id}.json`,
        attached: true,
        href: 'blob:sweep-event',
      },
    ])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(download.revokeObjectURL).not.toHaveBeenCalled()
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:sweep-event')
  })

  it.each(['account', 'scope', 'submission'] as const)(
    'removes an available export after %s changes without fetching again',
    async (change) => {
      const fetcher = fixtureFetch()
      const download = mockDownload()
      const view = render(
        <ExecutionSweepHistory
          accountId={accountId}
          selectedSubmissionId={selectedSubmissionId}
          locale="en"
        />,
      )
      if (change === 'submission') chooseScope('submission')
      const oldButton = await readEvent()
      expect(oldButton).toHaveProperty('disabled', false)
      if (change === 'scope') chooseScope('submission')
      else
        view.rerender(
          <ExecutionSweepHistory
            accountId={change === 'account' ? 'synthetic-next-account' : accountId}
            selectedSubmissionId={
              change === 'submission' ? 'synthetic-next-submission' : selectedSubmissionId
            }
            locale="en"
          />,
        )
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      fireEvent.click(oldButton)
      expect(download.createObjectURL).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['list', 'detail'] as const)(
    'removes the previous export during a pending %s read and after its error',
    async (phase) => {
      let finish!: (value: ReturnType<typeof response>) => void
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response(page([item(), item('synthetic-event-2')])))
        .mockResolvedValueOnce(response(detail()))
        .mockImplementationOnce(
          () =>
            new Promise<ReturnType<typeof response>>((resolve) => {
              finish = resolve
            }),
        )
      vi.stubGlobal('fetch', fetcher)
      const download = mockDownload()
      render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      const oldButton = await readEvent()
      if (phase === 'list') load()
      else await open(1)
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      fireEvent.click(oldButton)
      expect(download.createObjectURL).not.toHaveBeenCalled()
      await act(async () => finish(response({}, 503)))
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Sweep history request failed (503)',
      )
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      expect(download.createObjectURL).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(3)
    },
  )

  it('downloads only the newly selected event envelope after a second event read succeeds', async () => {
    const second = { ...detail('synthetic-event-2'), future_selected: null }
    const fetcher = vi.fn(async (url: string) =>
      response(
        url.includes('?')
          ? page([item(), item(second.id)])
          : url.endsWith(second.id)
            ? second
            : detail(),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    await readEvent()
    await open(1)
    const button = await screen.findByRole('button', { name: downloadName })
    fireEvent.click(button)
    expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(second)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('disables export for explicitly unavailable immutable evidence', async () => {
    const corrupt = {
      ...item(),
      integrity: { available: false, reason: 'sweep_event_content_changed' },
      at: null,
      reason: null,
      results_count: null,
      counts: null,
    }
    fixtureFetch(page([corrupt]), { ...corrupt, event: null, future_metadata: null })
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    const button = await readEvent()
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(download.createObjectURL).not.toHaveBeenCalled()
  })

  it.each(['account', 'id', 'fingerprint', 'event_submission'] as const)(
    'does not offer an export for a wrong %s identity',
    async (damage) => {
      const server = detail()
      if (damage === 'account') server.account_id = 'synthetic-wrong'
      if (damage === 'id') server.id = 'synthetic-wrong'
      if (damage === 'fingerprint') server.content_fingerprint = 'b'.repeat(64)
      if (damage === 'event_submission') server.event.submission_id = 'synthetic-wrong'
      fixtureFetch(page(), server)
      const download = mockDownload()
      render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      load()
      await open()
      expect((await screen.findByRole('alert')).textContent).toContain('identity does not match')
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it.each([NaN, Infinity, -Infinity])(
    'refuses a nonfinite future value (%s) without turning it into null',
    async (number) => {
      fixtureFetch(page(), { ...detail(), future_number: number })
      const download = mockDownload()
      render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      fireEvent.click(await readEvent())
      expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
      expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it('cleans up a refused browser download and disables it until the event is reviewed again', async () => {
    fixtureFetch()
    const download = mockDownload()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    fireEvent.click(await readEvent())
    expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    expect(document.querySelector('a[download]')).toBeNull()
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:sweep-event')
  })
})

describe('verified UTC-date and exact-reason filters', () => {
  const firstDate = 'First date (UTC, inclusive)'
  const lastDate = 'Last date (UTC, inclusive)'
  const reasonName = 'Reason code (exact match; empty for all)'
  function filtered(items: unknown[] = [item()], offset = 0, total = items.length) {
    return {
      ...page(items, offset, total),
      filters: {
        submission_id: null,
        start_date: '2026-10-01',
        end_date: '2026-10-02',
        reason: 'kill_switch_enabled',
      },
      filter_coverage: { unverifiable_excluded: 2 },
    }
  }
  function change() {
    fireEvent.change(screen.getByLabelText(firstDate), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText(lastDate), { target: { value: '2026-10-02' } })
    fireEvent.change(screen.getByLabelText(reasonName), {
      target: { value: 'kill_switch_enabled' },
    })
  }
  it('sends explicit UTC/exact filters on every page and displays excluded evidence count', async () => {
    const many = Array.from({ length: 20 }, (_, i) => item(`synthetic-${i}`))
    const fetcher = vi.fn(async (url: string) =>
      response(url.includes('offset=20') ? filtered([item()], 20, 21) : filtered(many, 0, 21)),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    change()
    expect(fetcher).not.toHaveBeenCalled()
    load()
    expect((await screen.findByRole('status')).textContent).toContain('excluded from filtering: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: openName })).toHaveLength(1))
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      [0, 20].map(
        (offset) =>
          `${base}?limit=20&offset=${offset}&start_date=2026-10-01&end_date=2026-10-02&reason=kill_switch_enabled`,
      ),
    )
  })
  it('rejects a response for different filters instead of showing a misleading total', async () => {
    fixtureFetch({ ...filtered(), filters: { ...filtered().filters, reason: 'manual_sweep' } })
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    change()
    load()
    expect((await screen.findByRole('alert')).textContent).toContain('does not match')
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
  })
  it('changing a filter aborts the old request and clears its later response', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    fireEvent.change(screen.getByLabelText(firstDate), { target: { value: '2026-10-01' } })
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => finish(response(page())))
    expect(screen.queryByRole('button', { name: openName })).toBeNull()
    expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', false)
  })
  it('clears downloaded detail on filter edits and rejects reversed dates before sending', async () => {
    const fetcher = fixtureFetch()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    load()
    await open()
    await screen.findByRole('button', { name: 'Download sweep event JSON' })
    fireEvent.change(screen.getByLabelText(firstDate), { target: { value: '2026-10-03' } })
    fireEvent.change(screen.getByLabelText(lastDate), { target: { value: '2026-10-01' } })
    expect(screen.queryByRole('button', { name: 'Download sweep event JSON' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('must not follow')
    load()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('bounded full-scope sweep evidence export', () => {
  const name = 'Export this scope as JSON'
  function batch(items: ReturnType<typeof detail>[] = [detail()]) {
    return {
      export_version: 'alphaview-execution-sweep-export-v1',
      account_id: accountId,
      filters: { submission_id: null, start_date: null, end_date: null, reason: null },
      filter_coverage: { unverifiable_excluded: null },
      items,
      coverage: {
        matching_events: items.length,
        exported_events: items.length,
        verified_events: items.length,
        unverifiable_events: 0,
        complete_for_filters: true,
        max_events: 250,
        max_bytes: 2097152,
      },
      future_server_field: { unknown_value: null },
    }
  }
  it('downloads the complete accepted response in one explicit GET and preserves null/future metadata', async () => {
    const saved = batch()
    const fetcher = vi.fn(async () => response(saved))
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name }))
    expect((await screen.findByRole('status')).textContent).toContain('batch download: 1')
    expect(fetcher.mock.calls).toHaveLength(1)
    expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(saved)
    expect(download.links[0].filename).toBe('alphaview-sweep-history.json')
  })
  it.each(['account', 'filter', 'coverage', 'duplicate', 'event'])(
    'rejects mismatched %s batch content',
    async (damage) => {
      const saved = batch()
      if (damage === 'account') saved.account_id = 'other'
      if (damage === 'filter') Object.assign(saved.filters, { reason: 'manual_sweep' })
      if (damage === 'coverage') saved.coverage.complete_for_filters = false
      if (damage === 'duplicate') {
        saved.items.push(detail())
        saved.coverage.matching_events =
          saved.coverage.exported_events =
          saved.coverage.verified_events =
            2
      }
      if (damage === 'event') saved.items[0].event.submission_id = 'other'
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(saved)),
      )
      const download = mockDownload()
      render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
      fireEvent.click(screen.getByRole('button', { name }))
      expect((await screen.findByRole('alert')).textContent).toContain('do not match')
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )
  it('aborts an in-flight export when filters change and suppresses late downloads', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name }))
    fireEvent.click(screen.getByRole('button', { name: 'Preparing batch JSON…' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('First date (UTC, inclusive)'), {
      target: { value: '2026-10-01' },
    })
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => finish(response(batch())))
    expect(download.createObjectURL).not.toHaveBeenCalled()
  })
  it('explains capacity rejection without creating a partial download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ detail: { code: 'sweep_export_limit' } }, 413)),
    )
    const download = mockDownload()
    render(<ExecutionSweepHistory accountId={accountId} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name }))
    expect((await screen.findByRole('alert')).textContent).toContain('Narrow the dates')
    expect(download.createObjectURL).not.toHaveBeenCalled()
  })
})
