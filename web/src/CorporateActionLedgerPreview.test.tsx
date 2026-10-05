import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CorporateActionLedgerPreview,
  type CorporateActionLedgerResult,
} from './CorporateActionLedgerPreview'
import type { PaperAccount } from './paper-model'

const account = { id: 'synthetic-ledger-account', version: 2 } as PaperAccount
const effect = (shares = 10) => ({
  shares,
  cost_basis: 1000,
  average_cost: 1000 / shares,
  shares_exact: String(shares),
  cost_basis_exact: '1000',
  average_cost_exact: String(1000 / shares),
})
function result(): CorporateActionLedgerResult {
  return {
    engine_version: 'alphaview-corporate-action-ledger-preview-v1',
    account_id: account.id,
    account_version: account.version,
    input_revision: 'synthetic:1',
    as_of: '2024-01-31',
    read_at: '2024-02-01T01:00:00Z',
    status: 'review_only',
    ledger_mutated: false,
    source_completeness: 'unknown',
    coverage: {
      holdings: 1,
      conditional_holdings: 1,
      unavailable_holdings: 0,
      reported_events: 2,
      calculated_splits: 1,
    },
    method: 'Synthetic method',
    warnings: ['Synthetic warning'],
    holdings: [
      {
        symbol: 'SYNTA',
        status: 'conditional',
        reasons: [],
        current: effect(),
        conditional_after: effect(20),
        ledger: { status: 'reconciled', entry_session: '2024-01-02', rows_checked: 1, reasons: [] },
        coverage: {
          required_sessions: 21,
          captured_sessions: 21,
          unknown_split_cells: 0,
          reported_events: 2,
          applicable_splits: 1,
          calculated_splits: 1,
          unavailable_events: 1,
        },
        source: {
          status: 'available',
          source: 'Synthetic provider',
          source_completeness: 'unknown',
          adapter_version: 'synthetic-v1',
          fingerprint: 'a'.repeat(64),
          fetched_at: '2024-01-31T22:00:00Z',
          first_fetched_at: '2024-01-30T22:00:00Z',
          evidence_revision: 3,
          capture_version: 4,
          captured_input_revision: 'synthetic:1',
          freshness_reasons: [],
          coverage: {
            first: '2024-01-02',
            last: '2024-01-31',
            rows: 21,
            unavailable_cells: 0,
            columns: {
              'Stock Splits': { present: true, checked: 21, zero: 20, events: 1, unavailable: 0 },
              Dividends: { present: true, checked: 21, zero: 20, events: 1, unavailable: 0 },
            },
          },
        },
        events: [
          {
            ex_date: '2024-01-10',
            kind: 'stock_split',
            source_value: 2,
            raw_value: '2.0',
            raw_type: 'float',
            source_reason: null,
            status: 'conditional',
            entitlement: 'local_pre_event_holding_only',
            reasons: [],
            record_date: null,
            pay_date: null,
            cash_entitlement: null,
            before: effect(),
            after: effect(20),
            shares_delta: 10,
          },
          {
            ex_date: '2024-01-12',
            kind: 'cash_dividend',
            source_value: 1.123456789012,
            raw_value: '1.123456789012',
            raw_type: 'float',
            source_reason: null,
            status: 'unavailable',
            entitlement: 'unknown',
            reasons: ['dividend_entitlement_unknown', 'record_and_pay_dates_unknown'],
            record_date: null,
            pay_date: null,
            cash_entitlement: null,
            before: null,
            after: null,
            shares_delta: null,
          },
        ],
      },
    ],
  }
}
const response = (value: unknown, code = 200) => ({
  ok: code === 200,
  status: code,
  json: async () => value,
})
const reloadName = 'Reload ledger preview'
const downloadName = 'Download ledger preview JSON'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('reads only the local GET, renders conditional arithmetic and explicitly unknown dividends', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(result()))
  vi.stubGlobal('fetch', fetcher)
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  expect(await screen.findByText('SYNTA · Conditional arithmetic · Unposted')).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/paper/accounts/${account.id}/corporate-actions/ledger-preview`,
  )
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  expect(
    screen.getByText('Dividend cash entitlement — · Record date — · Payment date —'),
  ).toBeTruthy()
  expect(
    screen.getByText(/Dividend entitlement unverified · Record and payment dates unknown/),
  ).toBeTruthy()
  expect(screen.getByText('a'.repeat(64))).toBeTruthy()
  expect(screen.getByText(/Holding-period session coverage 21 \/ 21/)).toBeTruthy()
  expect(screen.getByText(/This is not a posting or receivable confirmation/)).toBeTruthy()
})

it.each(['stale', 'partial', 'unavailable'])(
  'keeps %s evidence and null values visibly unavailable',
  async (sourceStatus) => {
    const value = result(),
      holding = value.holdings[0]
    holding.status = 'unavailable'
    holding.reasons = ['source_not_current']
    holding.conditional_after = null
    holding.source.status = sourceStatus
    holding.source.freshness_reasons = ['source_update_failed']
    holding.source.coverage!.unavailable_cells = 2
    holding.coverage.captured_sessions = null
    holding.coverage.required_sessions = null
    holding.coverage.unknown_split_cells = null
    holding.events[0] = {
      ...holding.events[0],
      status: 'unavailable',
      before: null,
      after: null,
      shares_delta: null,
      source_value: null,
      raw_value: 'nan',
      source_reason: 'non_finite_value',
      reasons: ['source_not_current'],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<CorporateActionLedgerPreview account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Unavailable')).toBeTruthy()
    expect(screen.getByText('Latest source update failed')).toBeTruthy()
    expect(
      screen.getByText(/Holding-period session coverage — \/ — · Unknown split cells —/),
    ).toBeTruthy()
    const metric = screen.getByText('Conditional shares after splits').parentElement!
    expect(within(metric).getByText('—')).toBeTruthy()
    expect(screen.getByText(/Source shares multiplier —/)).toBeTruthy()
    expect(screen.queryByText('SYNTA · Conditional arithmetic · Unposted')).toBeNull()
  },
)

it('shows empty holdings without inventing a zero-valued adjustment', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      response({
        ...result(),
        status: 'empty',
        holdings: [],
        coverage: {
          holdings: 0,
          conditional_holdings: 0,
          unavailable_holdings: 0,
          calculated_splits: 0,
          reported_events: 0,
        },
      }),
    ),
  )
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  expect(await screen.findByText('No paper holdings to preview.')).toBeTruthy()
  expect(screen.queryByText('Conditional shares after splits')).toBeNull()
})

it.each(['account', 'version', 'method', 'mutation'])(
  'rejects %s mismatch before display or export',
  async (field) => {
    const value = {
      ...result(),
      ...(field === 'account'
        ? { account_id: 'synthetic-other' }
        : field === 'version'
          ? { account_version: 99 }
          : field === 'method'
            ? { engine_version: 'unknown' }
            : { ledger_mutated: true }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<CorporateActionLedgerPreview account={account} locale="en" />)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Ledger preview account, version or method mismatch.',
    )
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    expect(screen.queryByText('SYNTA · Conditional arithmetic · Unposted')).toBeNull()
  },
)

it('blocks double reload and clears previous results during loading and after failure', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(result()))
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
  vi.stubGlobal('fetch', fetcher)
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  await screen.findByText('SYNTA · Conditional arithmetic · Unposted')
  const reload = screen.getByRole('button', { name: reloadName })
  fireEvent.click(reload)
  fireEvent.click(reload)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('SYNTA · Conditional arithmetic · Unposted')).toBeNull()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  await act(async () => finish(response({}, 503)))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Could not read the local ledger preview. (503)',
  )
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it.each(['account', 'version'])(
  'aborts and ignores old %s responses and immediately hides old results',
  async (change) => {
    const pending: { signal: AbortSignal; finish: (value: ReturnType<typeof response>) => void }[] =
      []
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(result()))
      .mockImplementation(
        (_url, options) =>
          new Promise((finish) => {
            pending.push({ signal: options.signal, finish })
          }),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<CorporateActionLedgerPreview account={account} locale="en" />)
    await screen.findByText('SYNTA · Conditional arithmetic · Unposted')
    fireEvent.click(screen.getByRole('button', { name: reloadName }))
    const next =
      change === 'account' ? { ...account, id: 'synthetic-next' } : { ...account, version: 3 }
    view.rerender(<CorporateActionLedgerPreview account={next} locale="en" />)
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => pending[0].finish(response(result())))
    expect(screen.queryByText('SYNTA · Conditional arithmetic · Unposted')).toBeNull()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    await act(async () =>
      pending[1].finish(
        response({ ...result(), account_id: next.id, account_version: next.version }),
      ),
    )
    expect(await screen.findByText('SYNTA · Conditional arithmetic · Unposted')).toBeTruthy()
    expect(fetcher.mock.calls.every(([, options]) => options.method === undefined)).toBe(true)
  },
)

function downloadMocks() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-preview')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { createObjectURL, revokeObjectURL, click }
}
function readBlob(blob: Blob): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(JSON.parse(String(reader.result)))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

it('exports the exact accepted envelope including unknown fields and nulls without a new request', async () => {
  const value = {
    ...result(),
    future_context: { unavailable: null, precise: 1.234567890123, zero: 0, flag: false },
  }
  value.holdings[0].source.status = 'stale'
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloadMocks()
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  const button = screen.getByRole('button', { name: downloadName })
  expect(button).toHaveProperty('disabled', true)
  await screen.findByText('SYNTA · Conditional arithmetic · Unposted')
  fireEvent.click(button)
  expect(mock.createObjectURL).toHaveBeenCalledTimes(1)
  expect(await readBlob(mock.createObjectURL.mock.calls[0][0])).toEqual(value)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(document.querySelector('a[download]')).toBeNull()
})

it.each([NaN, Infinity, -Infinity])(
  'rejects nonfinite future export value %s instead of rewriting it',
  async (number) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ ...result(), future_value: number })),
    )
    const mock = downloadMocks()
    render(<CorporateActionLedgerPreview account={account} locale="en" />)
    await screen.findByText('SYNTA · Conditional arithmetic · Unposted')
    fireEvent.click(screen.getByRole('button', { name: downloadName }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Local ledger preview JSON could not be downloaded.',
    )
    expect(mock.createObjectURL).not.toHaveBeenCalled()
  },
)

it('remounts with only a fresh local read and supports Traditional Chinese labels', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(result()))
  vi.stubGlobal('fetch', fetcher)
  const first = render(<CorporateActionLedgerPreview account={account} locale="zh-TW" />)
  expect(await screen.findByText('SYNTA · 條件式試算・未入帳')).toBeTruthy()
  expect(screen.getByRole('button', { name: '重新讀取帳本預覽' })).toBeTruthy()
  first.unmount()
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  expect(fetcher.mock.calls.every(([, options]) => options.method === undefined)).toBe(true)
})

it('keeps very small positive shares and source values visibly nonzero', async () => {
  const value = result()
  value.holdings[0].conditional_after = effect(0.0000001)
  value.holdings[0].events[0].source_value = 0.0000000001
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(<CorporateActionLedgerPreview account={account} locale="en" />)
  await screen.findByText('SYNTA · Conditional arithmetic · Unposted')
  const metric = screen.getByText('Conditional shares after splits').parentElement!
  expect(within(metric).getByText('1.0000e-7')).toBeTruthy()
  expect(screen.getByText(/Source shares multiplier 1.0000e-10/)).toBeTruthy()
})
