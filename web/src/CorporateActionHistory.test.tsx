import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CorporateActionHistory,
  type ActionRevision,
  type ActionComparison,
} from './CorporateActionHistory'

const t = (_zh: string, en: string) => en
const accountId = 'a'.repeat(32)
const base = {
  engine_version: 'alphaview-corporate-action-history-v1',
  account_id: accountId,
  account_version: 2,
  as_of: '2024-01-31',
  input_revision: 'synthetic:4',
  source_completeness: 'unknown' as const,
  historical_coverage: null,
  historical_coverage_reason: 'historical_capture_coverage_not_stored',
}
const event = (value: number) => ({
  ex_date: '2024-01-05',
  kind: 'cash_dividend' as const,
  raw_type: 'float',
  raw_value: String(value),
  value,
  reason: null,
})
const split = {
  ex_date: '2024-01-08',
  kind: 'stock_split' as const,
  raw_type: 'float',
  raw_value: '2.0',
  value: 2,
  reason: null,
}
function revision(n: number): ActionRevision {
  const payload = {
    engine_version: 'alphaview-corporate-action-evidence-v1',
    source: 'Yahoo Finance / yfinance',
    adapter_version: 'synthetic-adapter',
    source_completeness: 'unknown' as const,
    value_basis: 'adapter_returned_not_wire_payload',
    columns_present: { Dividends: true, 'Stock Splits': true },
    events: n === 1 ? [event(1.23456789012345), split] : [event(2.34567890123456)],
  }
  return {
    symbol: 'SYNTA',
    revision: n,
    fingerprint: n.toString(16).padStart(64, '0'),
    first_fetched_at: '2024-01-31T22:00:00Z',
    integrity: { available: true, reason: null },
    evidence_engine_version: payload.engine_version,
    adapter_version: payload.adapter_version,
    saved_event_count: payload.events.length,
    columns_present: payload.columns_present,
    source_completeness: 'unknown',
    historical_coverage: null,
    historical_coverage_reason: 'historical_capture_coverage_not_stored',
    payload,
    payload_json: JSON.stringify(payload),
  }
}
const scope = () => ({
  ...base,
  symbols: [
    { symbol: 'SYNTA', available: true, reason: null },
    { symbol: 'SYNTB', available: true, reason: null },
  ],
})
function listing(items = [revision(2), revision(1)], offset = 0, total = items.length) {
  return {
    ...base,
    symbol: 'SYNTA',
    items,
    pagination: { limit: 20, offset, total, returned: items.length },
  }
}
function comparison(): ActionComparison {
  const baseline = revision(1),
    selected = revision(2)
  return {
    ...base,
    symbol: 'SYNTA',
    request: {
      expected_account_version: 2,
      baseline_revision: 1,
      selected_revision: 2,
      expected_baseline_fingerprint: baseline.fingerprint!,
      expected_selected_fingerprint: selected.fingerprint!,
    },
    baseline,
    selected,
    status: 'compared',
    change_count: 2,
    reason: null,
    changes: [
      {
        ex_date: event(1).ex_date,
        kind: 'cash_dividend',
        change_types: ['changed'],
        baseline: baseline.payload!.events[0],
        selected: selected.payload!.events[0],
        baseline_reason: null,
        selected_reason: null,
        numeric_delta: 2.34567890123456 - 1.23456789012345,
        numeric_delta_reason: null,
      },
      {
        ex_date: split.ex_date,
        kind: split.kind,
        change_types: ['removed_from_saved_payload'],
        baseline: split,
        selected: null,
        baseline_reason: null,
        selected_reason: 'event_absent_from_saved_payload',
        numeric_delta: null,
        numeric_delta_reason: 'event_absent_from_saved_payload',
      },
    ],
  }
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function mockApi() {
  const fetcher = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) => {
    if (String(url).endsWith('/context')) return response(scope())
    if (String(url).endsWith('/compare')) return response(comparison())
    if (String(url).includes('?')) return response(listing())
    return response({
      ...base,
      symbol: 'SYNTA',
      item: revision(Number(String(url).split('/').at(-1))),
    })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function load() {
  await userEvent.click(screen.getByRole('button', { name: 'Load held-symbol scope' }))
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Held symbol' }), 'SYNTA')
  await userEvent.click(screen.getByRole('button', { name: 'Load saved revisions' }))
}
async function selectTwo() {
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select revision 1' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select revision 2' }))
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saved corporate action history', () => {
  it('loads held scope and history on demand, compares exact revisions and keeps absent events unknown', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      screen.getByText(/Source completeness and historical capture windows are always unknown/),
    ).toBeTruthy()
    await load()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await selectTwo()
    await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Removed from saved payload')).toBeTruthy()
    expect(
      within(table).getByText('Absent from saved payload; not zero or cancellation'),
    ).toBeTruthy()
    expect(within(table).getByText('1.23456789012345')).toBeTruthy()
    expect(within(table).getByText('2.34567890123456')).toBeTruthy()
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual(comparison().request)
    expect(
      fetcher.mock.calls.every(([url]) => String(url).includes('/corporate-actions/history')),
    ).toBe(true)
  })

  it('downloads the exact stored payload with account/symbol/revision filename and no extra fetch', async () => {
    const item = revision(1)
    const raw = JSON.stringify(item.payload, null, 3).replace('"value": 2', '"value": 2e0') + '\n'
    item.payload_json = raw
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await load()
    fetcher.mockResolvedValueOnce(response({ ...base, symbol: 'SYNTA', item }))
    await userEvent.click(screen.getByRole('button', { name: 'Inspect revision 1' }))
    const button = await screen.findByRole('button', {
      name: 'Download this revision’s stored JSON',
    })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-revision')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = '',
      release: (() => void) | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    const timer = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 10000 && typeof callback === 'function') {
        release = () => callback(...args)
        return 123
      }
      return timer(callback, delay, ...args)
    })
    fireEvent.click(button)
    const actual = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(actual).toBe(raw)
    expect(filename).toBe(`alphaview-corporate-history-${accountId}-SYNTA-1.json`)
    expect(document.querySelector('a[download]')).toBeNull()
    release?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-revision')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('preserves raw type and missing-value reasons rather than coercing raw text to amounts', async () => {
    const item = revision(2)
    item.payload!.events[0] = {
      ...event(1),
      raw_type: 'str',
      raw_value: '2.50',
      value: null,
      reason: 'non_numeric_value',
    } as unknown as ReturnType<typeof event>
    item.payload_json = JSON.stringify(item.payload)
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await load()
    fetcher.mockResolvedValueOnce(response({ ...base, symbol: 'SYNTA', item }))
    await userEvent.click(screen.getByRole('button', { name: 'Inspect revision 2' }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('2.50')).toBeTruthy()
    expect(within(table).getByText('str · Numeric value: —')).toBeTruthy()
    expect(within(table).getByText('non_numeric_value')).toBeTruthy()
  })

  it('retains a baseline across bounded pages and permits only two selections', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load held-symbol scope' }))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'SYNTA')
    fetcher.mockResolvedValueOnce(
      response(
        listing(
          Array.from({ length: 20 }, (_, index) => revision(21 - index)),
          0,
          21,
        ),
      ),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Load saved revisions' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select revision 21' }))
    fetcher.mockResolvedValueOnce(response(listing([revision(1)], 20, 21)))
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select revision 1' }))
    expect(screen.getByText(/v21 → v1/)).toBeTruthy()
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({
      expected_account_version: 2,
      baseline_revision: 21,
      selected_revision: 1,
      expected_baseline_fingerprint: revision(21).fingerprint,
      expected_selected_fingerprint: revision(1).fingerprint,
    })
  })

  it('disables a third selection and clearing selection removes old comparison', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load held-symbol scope' }))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'SYNTA')
    fetcher.mockResolvedValueOnce(response(listing([revision(3), revision(2), revision(1)])))
    await userEvent.click(screen.getByRole('button', { name: 'Load saved revisions' }))
    await selectTwo()
    expect(
      (screen.getByRole('checkbox', { name: 'Select revision 3' }) as HTMLInputElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Clear revision selection' }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      (screen.getByRole('checkbox', { name: 'Select revision 3' }) as HTMLInputElement).disabled,
    ).toBe(false)
  })

  it.each(['account', 'enabled', 'symbol'] as const)(
    'invalidates detail and download on %s change',
    async (change) => {
      mockApi()
      const view = render(<CorporateActionHistory accountId={accountId} t={t} />)
      await load()
      await userEvent.click(screen.getByRole('button', { name: 'Inspect revision 1' }))
      await screen.findByRole('button', { name: 'Download this revision’s stored JSON' })
      if (change === 'symbol') await userEvent.selectOptions(screen.getByRole('combobox'), 'SYNTB')
      else
        view.rerender(
          <CorporateActionHistory
            accountId={change === 'account' ? 'b'.repeat(32) : accountId}
            enabled={change !== 'enabled'}
            t={t}
          />,
        )
      expect(screen.queryByRole('table')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Download this revision’s stored JSON' }),
      ).toBeNull()
    },
  )

  it('guards double click and aborts stale account responses', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<CorporateActionHistory accountId={accountId} t={t} />)
    const button = screen.getByRole('button', { name: 'Load held-symbol scope' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const signal = fetcher.mock.calls[0][1]?.signal
    view.rerender(<CorporateActionHistory accountId={'b'.repeat(32)} t={t} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve(response(scope())))
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('keeps corrupted versions unavailable, prevents comparison and offers no raw download', async () => {
    const corrupt = {
      ...revision(2),
      integrity: { available: false, reason: 'payload_hash_mismatch' },
      payload: null,
      payload_json: null,
    }
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load held-symbol scope' }))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'SYNTA')
    fetcher.mockResolvedValueOnce(response(listing([corrupt, revision(1)])))
    await userEvent.click(screen.getByRole('button', { name: 'Load saved revisions' }))
    expect(
      (screen.getByRole('checkbox', { name: 'Select revision 2' }) as HTMLInputElement).disabled,
    ).toBe(true)
    fetcher.mockResolvedValueOnce(response({ ...base, symbol: 'SYNTA', item: corrupt }))
    await userEvent.click(screen.getByRole('button', { name: 'Inspect revision 2' }))
    expect(screen.getByRole('status').textContent).toContain('payload_hash_mismatch')
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download this revision’s stored JSON' }),
    ).toBeNull()
  })

  it('rejects detail payload/raw disagreement before rendering or exporting', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await load()
    fetcher.mockResolvedValueOnce(
      response({ ...base, symbol: 'SYNTA', item: { ...revision(1), payload_json: '{}' } }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Inspect revision 1' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'history_response_identity_mismatch',
    )
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('clears scope after account-version conflict without showing a successful comparison', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await load()
    await selectTwo()
    fetcher.mockResolvedValueOnce(response({ detail: { code: 'account_scope_changed' } }, 409))
    await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
    expect((await screen.findByRole('alert')).textContent).toContain('account_scope_changed')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('does not label an empty account or absent saved history as zero real events', async () => {
    const fetcher = mockApi()
    fetcher.mockResolvedValueOnce(response({ ...scope(), symbols: [] }))
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load held-symbol scope' }))
    expect(screen.getByText('No currently held symbols to inspect.')).toBeTruthy()
    await load()
    fetcher.mockResolvedValueOnce(response(listing([])))
    await userEvent.click(screen.getByRole('button', { name: 'Load saved revisions' }))
    expect(screen.getByText('No saved payloads; source events remain unknown.')).toBeTruthy()
  })

  it('rejects an unrelated event injected into a comparison even with matching revision identities', async () => {
    const fetcher = mockApi()
    render(<CorporateActionHistory accountId={accountId} t={t} />)
    await load()
    await selectTwo()
    const value = comparison()
    value.changes![0].selected = event(999)
    fetcher.mockResolvedValueOnce(response(value))
    await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'history_response_identity_mismatch',
    )
    expect(screen.queryByRole('table')).toBeNull()
  })
})

it('downloads the complete accepted comparison text and clears it after page lifecycle change', async () => {
  const fetcher = mockApi()
  render(<CorporateActionHistory accountId={accountId} t={t} />)
  await load()
  await selectTwo()
  const raw = JSON.stringify(comparison()).replace(
    /}$/,
    ',"future_metadata":{"exact_decimal":1.0,"absent":null}}\n',
  )
  fetcher.mockResolvedValueOnce(new Response(raw))
  await userEvent.click(screen.getByRole('button', { name: 'Compare two saved payloads' }))
  const button = await screen.findByRole('button', {
    name: 'Download this comparison evidence JSON',
  })
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-comparison')
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.click(button)
  const actual = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(createObjectURL.mock.calls[0][0])
  })
  expect(actual).toBe(raw)
  expect(fetcher).toHaveBeenCalledTimes(3)
  fireEvent(window, new Event('pagehide'))
  expect(screen.queryByRole('table')).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'Download this comparison evidence JSON' }),
  ).toBeNull()
})
