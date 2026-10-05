import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlpacaBookReconciliation, type Reconciliation } from './AlpacaBookReconciliation'

afterEach(() => vi.unstubAllGlobals())

const result = (status: Reconciliation['status']): Reconciliation => ({
  engine_version: 'alphaview-book-reconciliation-v2',
  as_of: '2024-01-04',
  input_revision: 'synthetic:1',
  status,
  broker: {
    status: status === 'unavailable' ? 'unavailable' : 'available',
    fetched_at: status === 'unavailable' ? null : '2024-01-05T15:00:00Z',
    error: status === 'unavailable' ? { code: 'not_configured', message: '尚未設定' } : null,
    account_id: 'synthetic-account',
  },
  rows:
    status === 'unavailable'
      ? []
      : [
          {
            symbol: 'SYNTA',
            status: 'matched',
            broker_qty: '30',
            broker_position: true,
            booked_qty: '30',
            difference: '0',
            filled_orders: 1,
            working_orders: 0,
            unknown_orders: 0,
            accounts: ['acct-1'],
            local_ledger: [{ account_id: 'acct-1', shares: '30' }],
          },
          {
            symbol: 'SYNTB',
            status: 'unexplained',
            broker_qty: '5',
            broker_position: true,
            booked_qty: '0',
            difference: '5',
            filled_orders: 0,
            working_orders: 0,
            unknown_orders: 0,
            accounts: [],
            local_ledger: [],
          },
        ],
  summary: {
    matched: 1,
    pending: 0,
    unknown: 0,
    unexplained: 1,
    drift: 0,
    unavailable: 0,
    symbols: 2,
    accounts: ['acct-1'],
  },
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const receipt = (value: Reconciliation, current = true) => ({
  version: 1,
  connection_version: 'a'.repeat(32),
  broker_account_id: 'synthetic-account',
  as_of: value.as_of,
  input_revision: value.input_revision,
  book_fingerprint: 'b'.repeat(64),
  can_capture: value.broker.error?.code !== 'not_configured',
  max_age_seconds: 900,
  receipt: {
    version: 1,
    captured_at: '2024-01-05T15:00:00Z',
    current,
    unavailable_reasons: current ? [] : ['receipt_stale'],
    result: value,
  },
})

describe('Alpaca book reconciliation', () => {
  it('keeps unreadable broker quantities unavailable and shows their reason', async () => {
    const value = result('unexplained')
    value.status = 'unavailable'
    value.rows = [
      {
        ...value.rows[0],
        status: 'unavailable',
        broker_qty: null,
        difference: null,
        reason_code: 'broker_quantity_unavailable',
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(receipt(value))),
    )
    render(<AlpacaBookReconciliation locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    expect(await screen.findByText('Broker quantity could not be read')).toBeTruthy()
    expect(screen.queryByText('Matched')).toBeNull()
    expect(screen.queryByText('No position')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('only reads on demand and shows per-symbol statuses', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(receipt(result('unexplained'))),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<AlpacaBookReconciliation locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    expect(await screen.findByText('Matched')).toBeTruthy()
    expect(screen.getAllByText('Unexplained (not in book)')).toHaveLength(2)
    expect(screen.getByText('acct-1: 30')).toBeTruthy()
    expect(fetcher.mock.calls[0][0]).toBe('/api/alpaca-paper/reconciliation/receipt')
    expect(fetcher.mock.calls[1][1]?.method).toBe('POST')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      expected_version: 1,
      expected_connection_version: 'a'.repeat(32),
      expected_broker_account_id: 'synthetic-account',
      expected_as_of: '2024-01-04',
      expected_input_revision: 'synthetic:1',
      expected_book_fingerprint: 'b'.repeat(64),
    })
  })

  it('states why the broker side is unavailable instead of showing empty matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(receipt(result('unavailable')))),
    )
    render(<AlpacaBookReconciliation locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    expect(await screen.findByText('Alpaca Paper is not connected')).toBeTruthy()
    expect(screen.queryByText('Matched')).toBeNull()
  })

  it('does not describe unavailable empty broker data as no positions', async () => {
    const value = result('unavailable')
    value.broker.error = { code: 'network_unavailable', message: 'Synthetic failure' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(receipt(value))),
    )
    render(<AlpacaBookReconciliation locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    expect(await screen.findByText('Cannot reach Alpaca Paper')).toBeTruthy()
    expect(
      screen.queryByText('No orders were sent to Alpaca Paper and the broker holds no positions.'),
    ).toBeNull()
  })

  it('clears the previous result on retry and leaves a version conflict visible', async () => {
    let conflict = false
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      conflict && init?.method === 'POST'
        ? {
            ok: false,
            status: 409,
            json: async () => ({ detail: { code: 'reconciliation_changed' } }),
          }
        : response(receipt(result('unexplained'))),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<AlpacaBookReconciliation locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    await screen.findByText('Matched')
    conflict = true
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The source or receipt version changed. This result was not saved; reconcile again.',
    )
    expect(screen.queryByText('Matched')).toBeNull()
    expect(screen.queryByText('acct-1: 30')).toBeNull()
  })

  it('guards repeated capture clicks and aborts an unfinished request on unmount', async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        signal = init.signal as AbortSignal
        return new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        })
      }
      return Promise.resolve(response(receipt(result('unexplained'))))
    })
    vi.stubGlobal('fetch', fetcher)
    const view = render(<AlpacaBookReconciliation locale="en" />)
    const button = screen.getByRole('button', { name: 'Reconcile book' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1),
    )
    expect(button).toHaveProperty('disabled', true)
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => finish?.(response(receipt(result('unexplained')))))
    expect(screen.queryByText('Matched')).toBeNull()
  })

  it('checks local receipt freshness in the background without another capture', async () => {
    let poll: (() => void) | undefined
    const interval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay !== 30000) return interval(callback, delay)
      poll = callback as () => void
      return 1
    })
    let current = true
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(receipt(result('unexplained'), current)),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<AlpacaBookReconciliation locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile book' }))
    await screen.findByText('Matched')
    current = false
    await act(async () => poll?.())
    expect(await screen.findByText('Receipt expired or source changed')).toBeTruthy()
    expect(
      screen.getByText(
        'This is an earlier receipt and cannot establish current book consistency. Reconcile again.',
      ),
    ).toBeTruthy()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(
      fetcher.mock.calls.every(([url]) => url === '/api/alpaca-paper/reconciliation/receipt'),
    ).toBe(true)
  })
})
