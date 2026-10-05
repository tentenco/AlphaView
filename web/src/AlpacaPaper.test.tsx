import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AlpacaPaper } from './AlpacaPaper'

const connection = {
  configured: true,
  version: 'synthetic-version',
  endpoint: 'https://paper-api.alpaca.markets',
  environment: 'paper',
  connected_at: '2024-01-06T12:00:00Z',
  orders_enabled: false,
}
const resource = (data: unknown) => ({
  status: 'available',
  fetched_at: '2024-01-06T12:00:00Z',
  data,
  error: null,
})
const unavailable = {
  status: 'unavailable',
  fetched_at: '2024-01-06T12:00:00Z',
  data: null,
  error: { code: 'network_unavailable', message: 'Synthetic unavailable' },
}
const snapshot = {
  ...connection,
  status: 'partial',
  fetched_at: '2024-01-06T12:00:00Z',
  coverage: { available: 3, required: 4 },
  resources: {
    account: resource({
      id: 'synthetic-account',
      status: 'ACTIVE',
      currency: 'USD',
      cash: '1234.000001',
      equity: null,
      buying_power: '2468.00',
      unavailable_fields: ['equity'],
    }),
    positions: unavailable,
    orders: resource({
      items: [
        {
          id: 'synthetic-order',
          symbol: 'SYNTH',
          side: 'buy',
          type: 'market',
          status: 'filled',
          qty: '1.000000001',
          filled_qty: '1.000000001',
          filled_avg_price: '100.01',
        },
      ],
      returned: 1,
      limit: 1,
      total: null,
      possibly_truncated: true,
    }),
    clock: resource({
      is_open: false,
      timestamp: '2024-01-06T12:00:00Z',
      next_open: '2024-01-08T09:30:00-05:00',
      next_close: null,
    }),
  },
}
const response = (value: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => value,
})

describe('Alpaca paper connection', () => {
  it('saves credentials only on explicit submission and clears inputs under StrictMode', async () => {
    let configured = false
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        configured = true
        return response(connection)
      }
      if (url.includes('/snapshot')) return response(snapshot)
      return response(configured ? connection : { ...connection, configured: false, version: null })
    })
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(
      <StrictMode>
        <AlpacaPaper locale="en" />
      </StrictMode>,
    )
    await screen.findByLabelText('Paper API Key')
    await user.type(screen.getByLabelText('Paper API Key'), 'PKSYNTHETIC0000000000')
    await user.type(screen.getByLabelText('Secret Key'), 'synthetic-secret-for-tests-only')
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Verify and save paper connection' }))
    await screen.findByText('Paper account verified. Credentials saved locally.')
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      api_key: 'PKSYNTHETIC0000000000',
      secret_key: 'synthetic-secret-for-tests-only',
      expected_version: null,
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Connection settings' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    await user.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect((screen.getByLabelText('Secret Key') as HTMLInputElement).value).toBe('')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('distinguishes unavailable positions, missing numbers and truncated orders', async () => {
    const fetcher = vi.fn(async (url: string) =>
      response(url.includes('/snapshot') ? snapshot : connection),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<AlpacaPaper locale="en" />)
    await screen.findByText('Positions are unavailable.')
    expect(screen.queryByText('This Alpaca account currently has no open positions.')).toBeNull()
    expect(screen.getByText('1,234.000001')).toBeTruthy()
    expect(
      screen.getByText('The page limit was reached; additional orders may exist.'),
    ).toBeTruthy()
    expect(screen.getByText(/Missing or invalid numeric fields/).textContent).toContain('equity')
    fireEvent.change(screen.getByLabelText('Order filter'), { target: { value: 'open' } })
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url.includes('status=open&limit=50'))).toBe(true),
    )
  })

  it('clears old account numbers on failed refresh instead of showing stale data', async () => {
    let failed = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('/snapshot')) return response(connection)
        return failed
          ? response({ detail: { code: 'network_unavailable', message: 'Synthetic failure' } }, 503)
          : response(snapshot)
      }),
    )
    const user = userEvent.setup()
    render(<AlpacaPaper locale="en" />)
    await screen.findByText('1,234.000001')
    failed = true
    await user.click(screen.getByRole('button', { name: 'Refresh Alpaca data' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('1,234.000001')).toBeNull()
  })

  it('keeps a credential draft version across refresh and reports a conflict', async () => {
    let version = connection.version
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return response(
          { detail: { code: 'connection_changed', message: 'Synthetic conflict' } },
          409,
        )
      return response(
        url.includes('/snapshot') ? { ...snapshot, version } : { ...connection, version },
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<AlpacaPaper locale="en" />)
    await screen.findByText('1,234.000001')
    await user.click(screen.getByRole('button', { name: 'Connection settings' }))
    await user.type(screen.getByLabelText('Paper API Key'), 'PKSYNTHETIC0000000000')
    await user.type(screen.getByLabelText('Secret Key'), 'synthetic-secret-for-tests-only')
    version = 'synthetic-new-version'
    await user.click(screen.getByRole('button', { name: 'Refresh Alpaca data' }))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Verify and save paper connection' })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    await user.click(screen.getByRole('button', { name: 'Verify and save paper connection' }))
    await screen.findByRole('alert')
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]!.body)).expected_version).toBe('synthetic-version')
    expect((screen.getByLabelText('Secret Key') as HTMLInputElement).value).toBe(
      'synthetic-secret-for-tests-only',
    )
  })
})
