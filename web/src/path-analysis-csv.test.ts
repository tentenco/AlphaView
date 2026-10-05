import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PathMonthly } from './WorkflowPathMonthly'
import type { PathRolling } from './WorkflowPathRolling'
import {
  downloadPathAnalysisCsv,
  pathAnalysisCsvFilename,
  pathMonthlyCsv,
  pathRollingCsv,
} from './path-analysis-csv'

const receiptId = 'b'.repeat(64)
const fingerprint = 'c'.repeat(64)
function common(kind: 'monthly' | 'rolling') {
  return {
    engine_version: `alphaview-workflow-path-${kind}-v1`,
    account_id: 'a'.repeat(32),
    account_version: 1,
    request: {
      receipt_id: receiptId,
      expected_fingerprint: fingerprint,
      expected_account_version: 1,
    },
    original_receipt: {
      receipt_id: receiptId,
      evidence: { metrics: { initial_cash: 100, final_value: 100 } },
    },
    receipt_summary: {
      id: receiptId,
      run_id: 'd'.repeat(32),
      kind: 'path_validation' as const,
      created_at: '2026-10-01T00:00:00Z',
      content_fingerprint: fingerprint,
      integrity: { available: true, reason: null },
      currentness: { current: null, reasons: ['currentness_unavailable'] },
    },
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:1',
    execution_authority: false as const,
    tolerances: {
      return_absolute_percentage_points: 1e-9,
      nav_absolute_units: 1e-6,
      relative: 1e-10,
    },
  }
}
const basis = () => ({
  status: 'evaluated' as const,
  reasons: [],
  basis_checks: [{ code: 'raw_history', available: true }],
  historical_calendar: {
    exchange: 'XNYS',
    signal_date: '2024-12-31',
    as_of: '2026-01-16',
    valued_sessions: 252,
  },
  reconciliation: [
    {
      code: 'final_nav_matches_saved',
      computed: 100,
      reference: 100,
      difference: 0,
      unit: 'nav_units' as const,
      within_tolerance: true,
    },
  ],
})
function monthly(): PathMonthly {
  // Synthetic month rows only; exact historical exchange calendars are tested on the server.
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
  return {
    ...common('monthly'),
    analysis: {
      ...basis(),
      months,
      years: [2025, 2026].map((year) => ({
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
      })),
      summary: {
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
        first_observed_date: months[0].observed_start!,
        last_observed_date: months[12].observed_end!,
      },
    },
  }
}
function rolling(): PathRolling {
  const day = (index: number) => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
  return {
    ...common('rolling'),
    analysis: {
      ...basis(),
      horizons: [21, 63, 126].map((length) => ({
        horizon_sessions: length,
        expected_window_count: 253 - length,
        window_count: 253 - length,
        windows: Array.from({ length: 253 - length }, (_, offset) => ({
          window_number: offset + 1,
          horizon_sessions: length,
          boundary_index: offset,
          start_index: offset + 1,
          end_index: offset + length,
          boundary_date: day(offset),
          observed_start: day(offset + 1),
          observed_end: day(offset + length),
          boundary_kind:
            offset === 0 ? ('initial_cash' as const) : ('preceding_saved_nav' as const),
          boundary_nav: 100,
          start_nav: 100,
          end_nav: 100,
          gross_return: 1,
          return_pct: 0,
          nav_change: 0,
        })),
        lowest: {
          return_pct: 0,
          window_numbers: Array.from({ length: 253 - length }, (_, i) => i + 1),
        },
        highest: {
          return_pct: 0,
          window_numbers: Array.from({ length: 253 - length }, (_, i) => i + 1),
        },
      })),
      summary: {
        valued_sessions: 252,
        total_window_count: 549,
        initial_cash: 100,
        final_value: 100,
        direct_return_pct: 0,
        nav_change: 0,
        first_observed_date: day(1),
        last_observed_date: day(252),
        overlapping_windows: true,
        independent_samples: false,
      },
    },
  }
}
function records(csv: string) {
  // Read quoted CSV with escaped quotes and embedded commas/newlines, not line splitting.
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  const source = csv.slice(1)
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && source[index + 1] === '\n' && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      index += 1
    } else cell += char
  }
  expect(quoted).toBe(false)
  expect(cell).toBe('')
  expect(row).toEqual([])
  const [headers, ...data] = rows
  return data.map((values) => {
    expect(values).toHaveLength(headers.length)
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('saved path analysis convenience CSV', () => {
  it('exports exactly the 13 observed months, complete coverage and partial-month context without outside-window placeholders', () => {
    const value = monthly(),
      before = JSON.stringify(value),
      content = pathMonthlyCsv(value),
      rows = records(content)
    expect(content.charCodeAt(0)).toBe(0xfeff)
    expect(content.endsWith('\r\n')).toBe(true)
    expect(content.replaceAll('\r\n', '')).not.toContain('\n')
    expect(rows).toHaveLength(13)
    expect(rows[0]).toMatchObject({
      month: '2025-01',
      status: 'complete',
      observed_sessions: '20',
      boundary_kind: 'initial_cash',
      boundary_date: '2024-12-31',
      boundary_nav: '100',
      end_nav: '100',
      total_return_pct: '0',
      nav_change: '0',
      source_receipt_id: receiptId,
      source_receipt_fingerprint: fingerprint,
      engine_version: 'alphaview-workflow-path-monthly-v1',
      checked_as_of: '2026-10-01',
      source_current_at_inspection: '',
    })
    expect(rows[12]).toMatchObject({
      month: '2026-01',
      status: 'partial',
      month_reasons: 'month_ends_before_last_session',
      observed_start: '2026-01-02',
      observed_end: '2026-01-16',
      observed_sessions: '12',
      complete_calendar_first_session: '2026-01-02',
      complete_calendar_last_session: '2026-01-27',
      complete_calendar_sessions: '20',
      unobserved_month_sessions: '8',
      boundary_kind: 'preceding_saved_nav',
      boundary_date: '2025-12-27',
    })
    expect(content).not.toContain('outside_window')
    expect(JSON.stringify(value)).toBe(before)
  })
  it('exports all 549 windows with all three horizons and preserves boundary and index evidence', () => {
    const value = rolling(),
      before = JSON.stringify(value),
      rows = records(pathRollingCsv(value))
    expect(rows).toHaveLength(549)
    expect(
      [21, 63, 126].map(
        (length) => rows.filter((row) => row.horizon_sessions === String(length)).length,
      ),
    ).toEqual([232, 190, 127])
    expect(rows[0]).toMatchObject({
      horizon_sessions: '21',
      window_number: '1',
      boundary_index: '0',
      start_index: '1',
      end_index: '21',
      boundary_kind: 'initial_cash',
      boundary_date: '2025-01-01',
      boundary_nav: '100',
      start_nav: '100',
      end_nav: '100',
      total_return_pct: '0',
      nav_change: '0',
      sample_scope: 'one_saved_path_overlapping_not_independent',
    })
    expect(rows[548]).toMatchObject({
      horizon_sessions: '126',
      window_number: '127',
      boundary_index: '126',
      start_index: '127',
      end_index: '252',
      boundary_kind: 'preceding_saved_nav',
    })
    expect(JSON.stringify(value)).toBe(before)
  })
  it.each(['=SUM(1,2)', ' +1', '\t@CMD', '-1', '＝1', '＋1', '－1', '＠A', '\rplain', '\nplain'])(
    'neutralizes spreadsheet formulas in metadata and reasons: %j',
    (payload) => {
      const value = monthly()
      value.receipt_summary.run_id = payload
      value.checked_input_revision = payload
      value.receipt_summary.currentness.reasons = [payload]
      value.analysis.months![12].reasons = [payload]
      const row = records(pathMonthlyCsv(value))[12]
      expect(row.source_run_id).toBe(`'${payload}`)
      expect(row.checked_input_revision).toBe(`'${payload}`)
      expect(row.source_currentness_reasons).toBe(`'${payload}`)
      expect(row.month_reasons).toBe(`'${payload}`)
    },
  )
  it('round-trips quotes, commas and newlines while preserving actual finite numeric signs and precision', () => {
    const value = monthly()
    value.receipt_summary.run_id = '合成,"quoted"\nline'
    value.analysis.months![0].return_pct = -0
    value.analysis.months![1].return_pct = -12.3456789012345
    value.analysis.months![1].nav_change = -2.5
    const rows = records(pathMonthlyCsv(value))
    expect(rows[0].source_run_id).toBe('合成,"quoted"\nline')
    expect(rows[0].total_return_pct).toBe('-0')
    expect(rows[1].total_return_pct).toBe('-12.3456789012345')
    expect(rows[1].nav_change).toBe('-2.5')
  })
  it.each([null, undefined, NaN, Infinity, -Infinity])(
    'rejects missing or nonfinite required numeric cells (%s) without silently writing an empty or zero',
    (invalid) => {
      const month = monthly()
      month.analysis.months![12].return_pct = invalid as number
      expect(() => pathMonthlyCsv(month)).toThrow()
      const window = rolling()
      window.analysis.horizons![2].windows[126].end_nav = invalid as number
      expect(() => pathRollingCsv(window)).toThrow()
    },
  )
  it.each([
    'unavailable',
    'missing_month',
    'missing_metadata',
    'wrong_method',
    'bad_reconciliation',
    'wrong_fingerprint',
    'outside_month',
    'bad_count',
  ])('rejects incomplete monthly evidence (%s)', (mode) => {
    const value = monthly()
    if (mode === 'unavailable') value.analysis.status = 'unavailable'
    if (mode === 'missing_month') value.analysis.months!.pop()
    if (mode === 'missing_metadata') value.checked_input_revision = undefined as unknown as string
    if (mode === 'wrong_method') value.engine_version = 'future-method'
    if (mode === 'bad_reconciliation') value.analysis.reconciliation![0].within_tolerance = false
    if (mode === 'wrong_fingerprint') value.request.expected_fingerprint = 'e'.repeat(64)
    if (mode === 'outside_month') value.analysis.months![0].status = 'outside_window'
    if (mode === 'bad_count') value.analysis.months![0].observed_sessions = 19
    expect(() => pathMonthlyCsv(value)).toThrow()
  })
  it.each([
    'unavailable',
    'missing_window',
    'missing_horizon',
    'bad_boundary',
    'bad_count',
    'bad_date',
    'missing_reconciliation',
  ])('rejects incomplete rolling evidence (%s)', (mode) => {
    const value = rolling()
    if (mode === 'unavailable') value.analysis.status = 'unavailable'
    if (mode === 'missing_window') value.analysis.horizons![2].windows.pop()
    if (mode === 'missing_horizon') value.analysis.horizons!.pop()
    if (mode === 'bad_boundary') value.analysis.horizons![1].windows[1].boundary_index = 0
    if (mode === 'bad_count') value.analysis.summary!.total_window_count = 548
    if (mode === 'bad_date') value.analysis.horizons![0].windows[0].boundary_date = '2025-02-30'
    if (mode === 'missing_reconciliation') value.analysis.reconciliation = null
    expect(() => pathRollingCsv(value)).toThrow()
  })
  it('uses a safe bounded filename and only creates a local Blob when download is explicitly called', () => {
    vi.useFakeTimers()
    const create = vi.fn((_blob: Blob) => 'blob:synthetic'),
      revoke = vi.fn(),
      clicked: string[] = []
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true)
      clicked.push(this.download)
    })
    const content = pathMonthlyCsv(monthly())
    expect(create).not.toHaveBeenCalled()
    const filename = pathAnalysisCsvFilename('monthly', '../../=unsafe/"\nname')
    expect(filename).toBe('alphaview-path-monthly-observed-months-unsafe-name.csv')
    downloadPathAnalysisCsv(content, filename)
    expect(create).toHaveBeenCalledOnce()
    expect(clicked).toEqual([filename])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    expect(create.mock.calls[0][0].type).toBe('text/csv;charset=utf-8')
    vi.advanceTimersByTime(10000)
    expect(revoke).toHaveBeenCalledWith('blob:synthetic')
    expect(pathAnalysisCsvFilename('rolling', receiptId)).toBe(
      `alphaview-path-rolling-all-windows-${receiptId}.csv`,
    )
  })
})
