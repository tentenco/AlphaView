import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathRolling, type PathRolling, type RollingWindow } from './WorkflowPathRolling'

const t = (_zh: string, en: string) => en
const accountId = 'a'.repeat(32)
const receiptId = 'b'.repeat(64)
const fingerprint = 'c'.repeat(64)
const base = `/api/paper/accounts/${accountId}/workflow-path-receipts`
const props = { accountId, accountVersion: 1, t }
function receipt() {
  return {
    id: receiptId,
    run_id: 'd'.repeat(32),
    kind: 'path_validation' as const,
    created_at: '2026-10-01T12:00:00+00:00',
    content_fingerprint: fingerprint,
    integrity: { available: true, reason: null },
    currentness: { current: false, reasons: ['inputs_changed'] },
  }
}
function result(nav = (_index: number) => 100): PathRolling {
  // Synthetic monotonically ordered UI dates; the server tests own exact XNYS calendar validation.
  const dates = Array.from({ length: 253 }, (_, index) =>
    new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
  )
  const horizons = [21, 63, 126].map((length) => {
    const windows: RollingWindow[] = Array.from({ length: 253 - length }, (_, offset) => {
      const end = offset + length
      return {
        window_number: offset + 1,
        horizon_sessions: length,
        boundary_index: offset,
        start_index: offset + 1,
        end_index: end,
        boundary_date: dates[offset],
        observed_start: dates[offset + 1],
        observed_end: dates[end],
        boundary_kind: offset === 0 ? 'initial_cash' : 'preceding_saved_nav',
        boundary_nav: nav(offset),
        start_nav: nav(offset + 1),
        end_nav: nav(end),
        gross_return: nav(end) / nav(offset),
        return_pct: (nav(end) / nav(offset) - 1) * 100,
        nav_change: nav(end) - nav(offset),
      }
    })
    const lowest = Math.min(...windows.map((row) => row.return_pct)),
      highest = Math.max(...windows.map((row) => row.return_pct))
    return {
      horizon_sessions: length,
      expected_window_count: 253 - length,
      window_count: windows.length,
      windows,
      lowest: {
        return_pct: lowest,
        window_numbers: windows
          .filter((row) => row.return_pct === lowest)
          .map((row) => row.window_number),
      },
      highest: {
        return_pct: highest,
        window_numbers: windows
          .filter((row) => row.return_pct === highest)
          .map((row) => row.window_number),
      },
    }
  })
  return {
    engine_version: 'alphaview-workflow-path-rolling-v1',
    account_id: accountId,
    account_version: 1,
    request: {
      receipt_id: receiptId,
      expected_fingerprint: fingerprint,
      expected_account_version: 1,
    },
    original_receipt: {
      receipt_id: receiptId,
      evidence: {
        metrics: {
          initial_cash: nav(0),
          final_value: nav(252),
          return_pct: (nav(252) / nav(0) - 1) * 100,
        },
      },
    },
    receipt_summary: receipt(),
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:1',
    execution_authority: false,
    tolerances: {
      return_absolute_percentage_points: 1e-9,
      nav_absolute_units: 1e-6,
      relative: 1e-10,
    },
    analysis: {
      status: 'evaluated',
      reasons: [],
      basis_checks: [{ code: 'raw_history', available: true }],
      historical_calendar: {
        exchange: 'XNYS',
        signal_date: dates[0],
        as_of: dates[252],
        valued_sessions: 252,
      },
      horizons,
      summary: {
        valued_sessions: 252,
        total_window_count: 549,
        initial_cash: nav(0),
        final_value: nav(252),
        direct_return_pct: (nav(252) / nav(0) - 1) * 100,
        nav_change: nav(252) - nav(0),
        first_observed_date: dates[1],
        last_observed_date: dates[252],
        overlapping_windows: true,
        independent_samples: false,
      },
      reconciliation: [
        {
          code: 'final_nav_matches_saved',
          computed: nav(252),
          reference: nav(252),
          difference: 0,
          unit: 'nav_units',
          within_tolerance: true,
        },
      ],
    },
  }
}
const listing = () => ({ account_id: accountId, kind: 'path_validation', items: [receipt()] })
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
function load() {
  fireEvent.click(screen.getByRole('button', { name: 'Load rolling-window receipts' }))
}
async function select() {
  const input = await screen.findByRole('combobox', { name: 'Rolling-window source receipt' })
  fireEvent.change(input, { target: { value: receiptId } })
  return input as HTMLSelectElement
}
function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Inspect saved rolling windows' }))
}
function mock(value = result()) {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(listing()))
    .mockImplementationOnce(() => response(value))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function show(value = result()) {
  const fetcher = mock(value)
  const view = render(<WorkflowPathRolling {...props} />)
  load()
  await select()
  inspect()
  await screen.findByText('Complete rolling windows verified')
  return { fetcher, ...view }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saved path fixed rolling windows', () => {
  it('loads only on demand, guards double submission, and shows all horizon counts with explicit limits', async () => {
    const fetcher = mock()
    render(<WorkflowPathRolling {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    load()
    await select()
    inspect()
    inspect()
    await screen.findByText('Complete rolling windows verified')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`${base}?kind=path_validation&limit=50`)
    expect(fetcher.mock.calls[1][0]).toBe(`${base}/rolling`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    expect(screen.getByText('Complete windows: 232 / 232')).toBeTruthy()
    expect(screen.getByText('Complete windows: 190 / 190')).toBeTruthy()
    expect(screen.getByText('Complete windows: 127 / 127')).toBeTruthy()
    expect(
      screen.getByText(/not independent samples, forecasts or statistical confidence/),
    ).toBeTruthy()
    expect(screen.getByText(/Historical sources are no longer current/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders only 25 rows on demand and can reach every tied plateau window in chronological order', async () => {
    const { fetcher } = await show()
    const horizon = screen.getByRole('region', { name: '21 session windows' })
    expect(within(horizon).getAllByText('232 tied windows')).toHaveLength(2)
    fireEvent.click(within(horizon).getByRole('button', { name: 'Inspect all lowest ties' }))
    let rows = within(within(horizon).getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(26)
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('1')
    expect(rows[1].textContent).toContain('Initial cash')
    expect(rows[2].textContent).toContain('Preceding saved NAV')
    const next = within(horizon).getByRole('button', { name: 'Next page' }) as HTMLButtonElement
    for (let page = 1; page < 10; page += 1) fireEvent.click(next)
    rows = within(within(horizon).getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(8)
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('226')
    expect(within(rows[7]).getByRole('rowheader').textContent).toBe('232')
    expect(next.disabled).toBe(true)
    expect(
      within(horizon).getByText(
        'Showing 226–232 / 232 · Chronological order, at most 25 per page.',
      ),
    ).toBeTruthy()
    fireEvent.click(within(horizon).getByRole('button', { name: 'Inspect all highest ties' }))
    expect(within(within(horizon).getByRole('table')).getAllByRole('row')).toHaveLength(26)
    expect(
      within(horizon).getByText('Showing 1–25 / 232 · Chronological order, at most 25 per page.'),
    ).toBeTruthy()
    expect(
      (within(horizon).getByRole('button', { name: 'Previous page' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(within(horizon).getByRole('button', { name: 'Hide window details' }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('filters complete extrema without a chosen winner and keeps their preceding boundary evidence', async () => {
    await show(result((index) => ([1, 252].includes(index) ? 50 : 100)))
    const horizon = screen.getByRole('region', { name: '63 session windows' })
    expect(within(horizon).getByText('-50.00%')).toBeTruthy()
    expect(within(horizon).getByText('+100.00%')).toBeTruthy()
    fireEvent.click(within(horizon).getByRole('button', { name: 'Inspect all highest ties' }))
    let rows = within(within(horizon).getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('2')
    expect(rows[1].textContent).toContain('50.00Preceding saved NAV')
    fireEvent.change(within(horizon).getByRole('combobox', { name: 'Detail set' }), {
      target: { value: 'lowest' },
    })
    rows = within(within(horizon).getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('190')
    fireEvent.change(within(horizon).getByRole('combobox', { name: 'Detail set' }), {
      target: { value: 'all' },
    })
    expect(within(within(horizon).getByRole('table')).getAllByRole('row')).toHaveLength(26)
  })

  it('keeps empty or unverifiable selection disabled and never automatically computes after loading', async () => {
    const data = listing()
    data.items.push({
      ...receipt(),
      id: 'e'.repeat(64),
      integrity: { available: false, reason: null },
    })
    const fetcher = vi.fn().mockImplementation(() => response(data))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathRolling {...props} />)
    load()
    await screen.findByRole('combobox', { name: 'Rolling-window source receipt' })
    expect(
      (screen.getByRole('button', { name: 'Inspect saved rolling windows' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('option', { name: /Unverifiable/ }) as HTMLOptionElement).disabled,
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains same-account selection during version checks while clearing accepted results and pagination', async () => {
    const view = await show()
    const input = screen.getByRole('combobox', {
      name: 'Rolling-window source receipt',
    }) as HTMLSelectElement
    fireEvent.click(screen.getAllByRole('button', { name: 'Show all window details' })[0])
    view.rerender(<WorkflowPathRolling {...props} accountVersion={null} />)
    expect(input.value).toBe(receiptId)
    expect(screen.queryByText('Complete rolling windows verified')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Inspect saved rolling windows' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    view.rerender(<WorkflowPathRolling {...props} accountVersion={2} />)
    expect(input.value).toBe(receiptId)
    expect(
      (screen.getByRole('button', { name: 'Inspect saved rolling windows' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(view.fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['account', 'version', 'unmount'])(
    'aborts a late inspection after %s change and cannot revive its download',
    async (change) => {
      let finish: (value: Response) => void = () => undefined
      const fetcher = vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve
            }),
        )
      vi.stubGlobal('fetch', fetcher)
      const view = render(<WorkflowPathRolling {...props} />)
      load()
      await select()
      inspect()
      if (change === 'account')
        view.rerender(<WorkflowPathRolling {...props} accountId={'e'.repeat(32)} />)
      if (change === 'version') view.rerender(<WorkflowPathRolling {...props} accountVersion={2} />)
      if (change === 'unmount') view.unmount()
      expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
      await act(async () => finish(new Response(JSON.stringify(result()))))
      expect(screen.queryByText('Complete rolling windows verified')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
      ).toBeNull()
      expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
      ).toBeNull()
      if (change === 'account')
        expect(screen.queryByRole('combobox', { name: 'Rolling-window source receipt' })).toBeNull()
      if (change === 'version')
        expect(
          (
            screen.getByRole('combobox', {
              name: 'Rolling-window source receipt',
            }) as HTMLSelectElement
          ).value,
        ).toBe(receiptId)
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it('keeps unavailable derived values as dashes while retaining original evidence and its export', async () => {
    const value = result()
    value.original_receipt.evidence.metrics!.return_pct = -7
    value.analysis = {
      ...value.analysis,
      status: 'unavailable',
      reasons: ['rolling_saved_metrics_mismatch'],
      horizons: null,
      summary: null,
    }
    mock(value)
    render(<WorkflowPathRolling {...props} />)
    load()
    await select()
    inspect()
    await screen.findByText('Rolling-window analysis unavailable')
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    expect(
      screen.getByText('Saved NAV does not reconcile with the original full-period metrics.'),
    ).toBeTruthy()
    expect(screen.getByText('-7.00%')).toBeTruthy()
    expect(screen.getByText('— / 252')).toBeTruthy()
    expect(screen.getByText('— / 549')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '21 session windows' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: /Download complete/ })).toBeTruthy()
  })

  it('downloads the exact literal full response including original evidence and unknown fields without another request', async () => {
    const raw = JSON.stringify(result(), null, 2).replace(
      /}$/,
      ',"future":{"float":1.0,"negative_zero":-0.0,"exponent":1e-07,"missing":null}}\n',
    )
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return 'blob:synthetic'
      }),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<WorkflowPathRolling {...props} />)
    load()
    await select()
    inspect()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Download complete original receipt and rolling windows JSON',
      }),
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(click).toHaveBeenCalledOnce()
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0])
    })
    expect(downloaded).toBe(raw)
  })

  it('downloads all 549 windows across horizons even while details are filtered and paged, preserving the exact raw JSON', async () => {
    const raw = JSON.stringify(
      result((index) => ([1, 252].includes(index) ? 50 : 100)),
      null,
      2,
    ).replace(/}$/, ',"future":{"negative_zero":-0.0,"exponent":1e-07}}\n')
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const blobs: Blob[] = [],
      filenames: string[] = []
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return 'blob:synthetic'
      }),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download)
    })
    render(<WorkflowPathRolling {...props} />)
    load()
    await select()
    inspect()
    const csv = await screen.findByRole('button', { name: 'Download all horizons and windows CSV' })
    const first = screen.getByRole('region', { name: '21 session windows' }),
      second = screen.getByRole('region', { name: '63 session windows' })
    fireEvent.click(within(first).getByRole('button', { name: 'Inspect all highest ties' }))
    expect(within(within(first).getByRole('table')).getAllByRole('row')).toHaveLength(2)
    fireEvent.click(within(second).getByRole('button', { name: 'Show all window details' }))
    fireEvent.click(within(second).getByRole('button', { name: 'Next page' }))
    expect(
      within(second).getByText('Showing 26–50 / 190 · Chronological order, at most 25 per page.'),
    ).toBeTruthy()
    expect(blobs).toHaveLength(0)
    fireEvent.click(csv)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Download complete original receipt and rolling windows JSON',
      }),
    )
    const contents = await Promise.all(
      blobs.map(
        (blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.readAsText(blob)
          }),
      ),
    )
    const rows = contents[0]
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((row) => row.slice(1, -1).split('","'))
    const [headers, ...values] = rows,
      data = values.map((row) =>
        Object.fromEntries(headers.map((header, index) => [header, row[index]])),
      )
    expect(data).toHaveLength(549)
    expect(
      [21, 63, 126].map(
        (length) => data.filter((row) => row.horizon_sessions === String(length)).length,
      ),
    ).toEqual([232, 190, 127])
    expect(data[0]).toMatchObject({
      window_number: '1',
      boundary_kind: 'initial_cash',
      boundary_index: '0',
      boundary_nav: '100',
    })
    expect(data[548]).toMatchObject({
      horizon_sessions: '126',
      window_number: '127',
      end_index: '252',
      source_receipt_id: receiptId,
      source_receipt_fingerprint: fingerprint,
      engine_version: 'alphaview-workflow-path-rolling-v1',
      checked_as_of: '2026-10-01',
    })
    expect(contents[1]).toBe(raw)
    expect(filenames[0]).toBe(`alphaview-path-rolling-all-windows-${receiptId}.csv`)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    'wrong_account',
    'wrong_fingerprint',
    'wrong_version',
    'wrong_original',
    'wrong_method',
    'missing_window',
    'missing_tie',
    'duplicate_tie',
    'nonfinite',
    'oversized',
  ])('rejects %s without partial windows or a download', async (mode) => {
    const value = result()
    if (mode === 'wrong_account') value.account_id = 'e'.repeat(32)
    if (mode === 'wrong_fingerprint') value.request.expected_fingerprint = 'e'.repeat(64)
    if (mode === 'wrong_version') value.account_version = 2
    if (mode === 'wrong_original') value.original_receipt.receipt_id = 'e'.repeat(64)
    if (mode === 'wrong_method') value.engine_version = 'synthetic-unknown-method'
    if (mode === 'missing_window') value.analysis.horizons![0].windows.pop()
    if (mode === 'missing_tie') value.analysis.horizons![0].lowest.window_numbers.pop()
    if (mode === 'duplicate_tie') value.analysis.horizons![0].highest.window_numbers[1] = 1
    const raw =
      mode === 'oversized'
        ? '月'.repeat(1024 * 1024 + 1)
        : mode === 'nonfinite'
          ? JSON.stringify(value).replace(/}$/, ',"future":1e999}')
          : JSON.stringify(value)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockResolvedValueOnce(new Response(raw)),
    )
    render(<WorkflowPathRolling {...props} />)
    load()
    await select()
    inspect()
    await screen.findByRole('alert')
    expect(screen.queryByText('Complete rolling windows verified')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
  })

  it('clears accepted results on conflict or empty selection while retaining the selected receipt for retry', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() => response({ detail: { code: 'rolling_account_changed' } }, 409))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathRolling {...props} />)
    load()
    const input = await select()
    inspect()
    await screen.findByRole('button', { name: /Download complete/ })
    inspect()
    await screen.findByText('The account version changed; inspect again.')
    expect(input.value).toBe(receiptId)
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    inspect()
    await screen.findByRole('button', { name: /Download complete/ })
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    expect(screen.queryByText('Complete rolling windows verified')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download all horizons and windows CSV' }),
    ).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Inspect saved rolling windows' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
