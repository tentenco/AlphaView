import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathMonthly, type PathMonthly } from './WorkflowPathMonthly'

const t = (_zh: string, en: string) => en
const accountId = 'a'.repeat(32)
const receiptId = 'b'.repeat(64)
const fingerprint = 'c'.repeat(64)
const base = `/api/paper/accounts/${accountId}/workflow-path-receipts`
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
function result(): PathMonthly {
  const months: NonNullable<PathMonthly['analysis']['months']> = [
    {
      month: '2026-01',
      year: 2026,
      month_number: 1,
      status: 'complete',
      reasons: [],
      observed_start: '2026-01-02',
      observed_end: '2026-01-30',
      observed_sessions: 20,
      expected_sessions: 20,
      expected_first_session: '2026-01-02',
      expected_last_session: '2026-01-30',
      unobserved_month_sessions: 0,
      boundary_date: '2025-12-31',
      boundary_nav: 100,
      boundary_kind: 'initial_cash',
      end_nav: 110,
      gross_return: 1.1,
      return_pct: 10,
      nav_change: 10,
    },
    {
      month: '2026-02',
      year: 2026,
      month_number: 2,
      status: 'partial',
      reasons: ['month_ends_before_last_session'],
      observed_start: '2026-02-02',
      observed_end: '2026-02-03',
      observed_sessions: 2,
      expected_sessions: 19,
      expected_first_session: '2026-02-02',
      expected_last_session: '2026-02-27',
      unobserved_month_sessions: 17,
      boundary_date: '2026-01-30',
      boundary_nav: 110,
      boundary_kind: 'preceding_saved_nav',
      end_nav: 99,
      gross_return: 0.9,
      return_pct: -10,
      nav_change: -11,
    },
  ]
  const cells: NonNullable<PathMonthly['analysis']['years']>[number]['months'] = Array.from(
    { length: 12 },
    (_, index) =>
      months[index] ?? {
        month: `2026-${String(index + 1).padStart(2, '0')}`,
        month_number: index + 1,
        status: 'outside_window',
        reasons: ['outside_saved_window'],
        return_pct: null,
        nav_change: null,
        observed_sessions: null,
        expected_sessions: null,
        observed_start: null,
        observed_end: null,
      },
  )
  return {
    engine_version: 'synthetic-monthly-v1',
    account_id: accountId,
    account_version: 1,
    request: {
      receipt_id: receiptId,
      expected_fingerprint: fingerprint,
      expected_account_version: 1,
    },
    original_receipt: {
      receipt_id: receiptId,
      evidence: { metrics: { initial_cash: 100, final_value: 99, return_pct: -1 } },
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
        signal_date: '2025-12-31',
        as_of: '2026-02-03',
        valued_sessions: 22,
      },
      months,
      years: [{ year: 2026, months: cells }],
      summary: {
        observed_month_count: 2,
        complete_month_count: 1,
        partial_month_count: 1,
        valued_sessions: 22,
        initial_cash: 100,
        final_value: 99,
        nav_change: -1,
        summed_monthly_nav_change: -1,
        direct_return_pct: -1,
        chained_return_pct: -1,
        chained_final_value: 99,
        first_observed_date: '2026-01-02',
        last_observed_date: '2026-02-03',
      },
      reconciliation: [
        {
          code: 'chained_return_matches_saved',
          computed: -1,
          reference: -1,
          difference: 0,
          unit: 'percentage_points',
          within_tolerance: true,
        },
      ],
    },
  }
}
function csvResult(): PathMonthly {
  const value = result()
  const template = value.analysis.months![0]
  const months: NonNullable<PathMonthly['analysis']['months']> = Array.from(
    { length: 13 },
    (_, index) => {
      const year = 2025 + Math.floor(index / 12),
        monthNumber = (index % 12) + 1
      const month = `${year}-${String(monthNumber).padStart(2, '0')}`
      const previous =
        index === 0
          ? '2024-12-31'
          : `${year - (monthNumber === 1 ? 1 : 0)}-${String(monthNumber === 1 ? 12 : monthNumber - 1).padStart(2, '0')}-27`
      return {
        ...template,
        month,
        year,
        month_number: monthNumber,
        status: index === 12 ? 'partial' : 'complete',
        reasons: index === 12 ? ['month_ends_before_last_session'] : [],
        observed_start: `${month}-02`,
        observed_end: `${month}-${index === 12 ? '16' : '27'}`,
        observed_sessions: index === 12 ? 12 : 20,
        expected_sessions: 20,
        expected_first_session: `${month}-02`,
        expected_last_session: `${month}-27`,
        unobserved_month_sessions: index === 12 ? 8 : 0,
        boundary_kind: index === 0 ? 'initial_cash' : 'preceding_saved_nav',
        boundary_date: previous,
        boundary_nav: 100,
        end_nav: 100,
        gross_return: 1,
        return_pct: 0,
        nav_change: 0,
      }
    },
  )
  value.engine_version = 'alphaview-workflow-path-monthly-v1'
  value.analysis.months = months
  value.analysis.years = [2025, 2026].map((year) => ({
    year,
    months: Array.from(
      { length: 12 },
      (_, index) =>
        months.find((row) => row.year === year && row.month_number === index + 1) ?? {
          month: `${year}-${String(index + 1).padStart(2, '0')}`,
          month_number: index + 1,
          status: 'outside_window' as const,
          reasons: ['outside_saved_window'],
          return_pct: null,
          nav_change: null,
          observed_sessions: null,
          expected_sessions: null,
          observed_start: null,
          observed_end: null,
        },
    ),
  }))
  value.analysis.summary = {
    ...value.analysis.summary!,
    observed_month_count: 13,
    complete_month_count: 12,
    partial_month_count: 1,
    valued_sessions: 252,
    initial_cash: 100,
    final_value: 100,
    nav_change: 0,
    summed_monthly_nav_change: 0,
    direct_return_pct: 0,
    chained_return_pct: 0,
    chained_final_value: 100,
    first_observed_date: '2025-01-02',
    last_observed_date: '2026-01-16',
  }
  return value
}
const listing = () => ({ account_id: accountId, kind: 'path_validation', items: [receipt()] })
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
function load() {
  fireEvent.click(screen.getByRole('button', { name: 'Load monthly return receipts' }))
}
async function select() {
  const input = await screen.findByRole('combobox', { name: 'Monthly return source receipt' })
  fireEvent.change(input, { target: { value: receiptId } })
  return input
}
function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Inspect saved monthly returns' }))
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saved path monthly return calendar', () => {
  it('loads only on demand and guards duplicate inspection with the selected fingerprint and account version', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    load()
    await select()
    inspect()
    inspect()
    await screen.findByText('Monthly and full-period outcomes reconciled')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`${base}?kind=path_validation&limit=50`)
    expect(fetcher.mock.calls[1][0]).toBe(`${base}/monthly`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    expect(screen.getByText(/Historical sources are no longer current/)).toBeTruthy()
  })

  it('renders all twelve month cells, text plus color, known partial returns, and outside-window dashes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(result())),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    const grid = await screen.findByRole('list', { name: '2026 twelve months' })
    expect(within(grid).getAllByRole('listitem')).toHaveLength(12)
    const january = within(grid).getByText('Jan').closest('li')!
    const february = within(grid).getByText('Feb').closest('li')!
    const march = within(grid).getByText('Mar').closest('li')!
    expect(within(january).getByText('+10.00%')).toBeTruthy()
    expect(within(january).getByText('Up')).toBeTruthy()
    expect(january.classList.contains('monthly-positive')).toBe(true)
    expect(within(january).getByText('Complete month')).toBeTruthy()
    expect(within(february).getByText('-10.00%')).toBeTruthy()
    expect(within(february).getByText('Down')).toBeTruthy()
    expect(february.classList.contains('monthly-negative')).toBe(true)
    expect(within(february).getByText('Partial month')).toBeTruthy()
    expect(within(february).getByText('2/19 sessions')).toBeTruthy()
    expect(within(march).getByText('—')).toBeTruthy()
    expect(within(march).getByText('Outside saved window')).toBeTruthy()
    expect(within(march).queryByText('0.00%')).toBeNull()
    expect(screen.getAllByText('-1.00%')).toHaveLength(2)
    expect(screen.getByText('Ends before the last session of the month')).toBeTruthy()
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows[1].textContent).toContain('2026-01')
    expect(rows[2].textContent).toContain('2026-02')
  })

  it('shows a known zero observed month distinctly from an outside-window missing month', async () => {
    const value = result()
    value.analysis.months![0].return_pct = 0
    value.analysis.years![0].months[0].return_pct = 0
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    const grid = await screen.findByRole('list', { name: '2026 twelve months' })
    const january = within(grid).getByText('Jan').closest('li')!
    expect(within(january).getByText('0.00%')).toBeTruthy()
    expect(within(january).getByText('Unchanged')).toBeTruthy()
    expect(january.classList.contains('monthly-neutral')).toBe(true)
    expect(within(grid).getAllByText('Outside saved window')).toHaveLength(10)
  })

  it('keeps empty and corrupt selections disabled', async () => {
    const data = listing()
    data.items.push({
      ...receipt(),
      id: 'e'.repeat(64),
      integrity: { available: false, reason: null },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => response(data)),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await screen.findByRole('combobox', { name: 'Monthly return source receipt' })
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved monthly returns' })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByRole('option', { name: /Unverifiable/ }).hasAttribute('disabled')).toBe(true)
  })

  it('retains the selected draft through same-account checking and version change but invalidates accepted analysis', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText('Monthly and full-period outcomes reconciled')
    view.rerender(<WorkflowPathMonthly accountId={accountId} accountVersion={null} t={t} />)
    expect(
      (screen.getByRole('combobox', { name: 'Monthly return source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    expect(screen.queryByText('Monthly and full-period outcomes reconciled')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved monthly returns' })
        .hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(<WorkflowPathMonthly accountId={accountId} accountVersion={2} t={t} />)
    expect(
      (screen.getByRole('combobox', { name: 'Monthly return source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved monthly returns' })
        .hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts a late response and clears the selection when switching accounts', async () => {
    let finish: (response: Response) => void = () => undefined
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
    const view = render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    view.rerender(<WorkflowPathMonthly accountId={'e'.repeat(32)} accountVersion={1} t={t} />)
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Monthly return source receipt' })).toBeNull()
    await act(async () => finish(new Response(JSON.stringify(result()))))
    expect(screen.queryByText('Monthly and full-period outcomes reconciled')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
  })

  it('keeps all analysis missing on reconciliation failure while retaining the original return', async () => {
    const value = result()
    value.analysis = {
      ...value.analysis,
      status: 'unavailable',
      reasons: ['monthly_saved_metrics_mismatch'],
      months: null,
      years: null,
      summary: null,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText('Monthly return analysis unavailable')
    expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
    expect(
      screen.getByText(
        'Chained monthly outcomes do not reconcile with the saved full-period metrics.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('-1.00%')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('list', { name: '2026 twelve months' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: /Download complete/ })).toBeTruthy()
  })

  it('downloads the exact accepted full-original response without another request', async () => {
    const raw = JSON.stringify(result(), null, 2) + '\n'
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
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Download complete original receipt and monthly analysis JSON',
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

  it('explicitly downloads all 13 observed months including partial context, keeps raw JSON exact, then clears CSV on empty selection', async () => {
    const raw = JSON.stringify(csvResult(), null, 2) + '\n'
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
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    const input = await select()
    inspect()
    const csv = await screen.findByRole('button', { name: 'Download observed months CSV' })
    expect(blobs).toHaveLength(0)
    expect(
      within(screen.getByRole('list', { name: '2025 twelve months' })).getAllByRole('listitem'),
    ).toHaveLength(12)
    expect(
      within(screen.getByRole('list', { name: '2026 twelve months' })).getAllByRole('listitem'),
    ).toHaveLength(12)
    fireEvent.click(csv)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Download complete original receipt and monthly analysis JSON',
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
    expect(rows).toHaveLength(14)
    const data = Object.fromEntries(rows[0].map((header, index) => [header, rows[13][index]]))
    expect(data).toMatchObject({
      month: '2026-01',
      status: 'partial',
      observed_sessions: '12',
      complete_calendar_sessions: '20',
      unobserved_month_sessions: '8',
      boundary_kind: 'preceding_saved_nav',
      boundary_date: '2025-12-27',
      total_return_pct: '0',
      source_receipt_id: receiptId,
      source_receipt_fingerprint: fingerprint,
    })
    expect(contents[0]).not.toContain('outside_window')
    expect(contents[1]).toBe(raw)
    expect(filenames[0]).toBe(`alphaview-path-monthly-observed-months-${receiptId}.csv`)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
  })

  it('withholds CSV for evaluated evidence with a missing numeric cell while retaining its raw JSON', async () => {
    const value = csvResult()
    value.analysis.months![12].return_pct = null
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByRole('button', { name: /Download complete/ })
    expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
    expect(screen.getByText(/CSV cannot be created/)).toBeTruthy()
  })

  it.each(['wrong_account', 'wrong_fingerprint', 'wrong_version', 'wrong_original', 'oversized'])(
    'rejects %s without showing or exporting a calendar',
    async (mode) => {
      const value = result()
      if (mode === 'wrong_account') value.account_id = 'e'.repeat(32)
      if (mode === 'wrong_fingerprint') value.request.expected_fingerprint = 'e'.repeat(64)
      if (mode === 'wrong_version') value.account_version = 2
      if (mode === 'wrong_original') value.original_receipt.receipt_id = 'e'.repeat(64)
      const raw = mode === 'oversized' ? '月'.repeat(1024 * 1024 + 1) : JSON.stringify(value)
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => response(listing()))
          .mockResolvedValueOnce(new Response(raw)),
      )
      render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
      load()
      await select()
      inspect()
      await screen.findByRole('alert')
      expect(screen.queryByRole('list', { name: '2026 twelve months' })).toBeNull()
      expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
    },
  )

  it('clears an earlier accepted result on a conflict while retaining the receipt draft for retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(result()))
        .mockImplementationOnce(() =>
          response({ detail: { code: 'monthly_account_changed' } }, 409),
        ),
    )
    render(<WorkflowPathMonthly accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByRole('button', { name: /Download complete/ })
    inspect()
    await screen.findByText('The account version changed; inspect again.')
    expect(
      (screen.getByRole('combobox', { name: 'Monthly return source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download observed months CSV' })).toBeNull()
    expect(screen.queryByRole('list', { name: '2026 twelve months' })).toBeNull()
  })
})
