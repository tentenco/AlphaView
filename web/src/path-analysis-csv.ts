import type { PathMonthly } from './WorkflowPathMonthly'
import type { PathRolling } from './WorkflowPathRolling'

type Cell = string | number | null
type SavedAnalysis = PathMonthly | PathRolling
type Kind = 'monthly' | 'rolling'
const hash = /^[a-f0-9]{64}$/
const date = /^\d{4}-\d{2}-\d{2}$/
const fail = () => {
  throw new Error('path_analysis_csv_incomplete_or_invalid')
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) fail()
}
function text(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0)
  return value
}
function number(value: unknown): number {
  requireValue(typeof value === 'number' && Number.isFinite(value))
  return value
}
function integer(value: unknown, minimum = 0): number {
  const result = number(value)
  requireValue(Number.isSafeInteger(result) && result >= minimum)
  return result
}
function day(value: unknown): string {
  const result = text(value)
  requireValue(
    date.test(result) && new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) === result,
  )
  return result
}
function reasons(value: unknown): string {
  requireValue(Array.isArray(value) && value.every((item) => typeof item === 'string'))
  return value.join('; ')
}
function positive(value: unknown): number {
  const result = number(value)
  requireValue(result > 0)
  return result
}
function csvCell(value: Cell): string {
  if (value === null) return '""'
  // Values have already passed the strict projection below. Never turn NaN or
  // missing fields into empty cells; only an explicit nullable value is empty.
  if (typeof value === 'number') {
    number(value)
    return `"${Object.is(value, -0) ? '-0' : String(value)}"`
  }
  requireValue(typeof value === 'string')
  // RFC 4180 quoting alone does not stop spreadsheet formula execution.
  // Apply the guard to every string, including provenance, reasons and headers.
  const safe = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
function csv(rows: Cell[][]) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
const metadataHeaders = [
  'export_kind',
  'engine_version',
  'source_receipt_id',
  'source_receipt_fingerprint',
  'source_run_id',
  'checked_as_of',
  'checked_input_revision',
  'source_current_at_inspection',
  'source_currentness_reasons',
  'evidence_role',
]
function metadata(value: SavedAnalysis, kind: Kind): Cell[] {
  requireValue(value && value.engine_version === `alphaview-workflow-path-${kind}-v1`)
  requireValue(value.analysis?.status === 'evaluated' && value.execution_authority === false)
  requireValue(reasons(value.analysis.reasons) === '')
  requireValue(
    Array.isArray(value.analysis.basis_checks) &&
      value.analysis.basis_checks.length > 0 &&
      value.analysis.basis_checks.every((check) => check && check.available === true),
  )
  requireValue(
    Array.isArray(value.analysis.reconciliation) &&
      value.analysis.reconciliation.length > 0 &&
      value.analysis.reconciliation.every(
        (check) =>
          check &&
          check.within_tolerance === true &&
          Number.isFinite(check.computed) &&
          Number.isFinite(check.reference) &&
          (check.difference === null || Number.isFinite(check.difference)),
      ),
  )
  const receipt = value.receipt_summary
  requireValue(
    receipt?.integrity?.available === true &&
      receipt.kind === 'path_validation' &&
      hash.test(text(receipt.id)) &&
      hash.test(text(receipt.content_fingerprint)) &&
      value.request?.receipt_id === receipt.id &&
      value.request.expected_fingerprint === receipt.content_fingerprint &&
      value.request.expected_account_version === integer(value.account_version, 1) &&
      value.original_receipt?.receipt_id === receipt.id,
  )
  requireValue([true, false, null].includes(receipt.currentness?.current))
  requireValue(value.analysis.summary?.valued_sessions === 252)
  return [
    kind === 'monthly' ? 'observed_months' : 'all_rolling_windows',
    value.engine_version,
    receipt.id,
    receipt.content_fingerprint,
    text(receipt.run_id),
    day(value.checked_as_of),
    text(value.checked_input_revision),
    receipt.currentness.current === null ? null : String(receipt.currentness.current),
    reasons(receipt.currentness.reasons),
    'readable_convenience_not_canonical_evidence',
  ]
}

/** Project every observed month, never the outside-window year-grid placeholders. */
export function pathMonthlyCsv(value: PathMonthly): string {
  const context = metadata(value, 'monthly')
  const months = value.analysis.months
  const summary = value.analysis.summary
  requireValue(Array.isArray(months) && months.length > 0 && months.length <= 252 && summary)
  requireValue(
    summary.observed_month_count === months.length &&
      summary.complete_month_count === months.filter((row) => row.status === 'complete').length &&
      summary.partial_month_count === months.filter((row) => row.status === 'partial').length,
  )
  const headers = [
    ...metadataHeaders,
    'month',
    'year',
    'month_number',
    'status',
    'month_reasons',
    'observed_start',
    'observed_end',
    'observed_sessions',
    'complete_calendar_first_session',
    'complete_calendar_last_session',
    'complete_calendar_sessions',
    'unobserved_month_sessions',
    'boundary_kind',
    'boundary_date',
    'boundary_nav',
    'end_nav',
    'gross_return',
    'total_return_pct',
    'nav_change',
  ]
  let sessions = 0
  const rows: Cell[][] = months.map((row, index) => {
    requireValue(row && ['complete', 'partial'].includes(row.status))
    const month = text(row.month)
    const year = integer(row.year, 1),
      monthNumber = integer(row.month_number, 1)
    requireValue(
      monthNumber <= 12 &&
        month === `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`,
    )
    requireValue(index === 0 || months[index - 1].month < month)
    const observed = integer(row.observed_sessions, 1),
      expected = integer(row.expected_sessions, 1)
    requireValue(
      expected >= observed && integer(row.unobserved_month_sessions) === expected - observed,
    )
    sessions += observed
    const start = day(row.observed_start),
      end = day(row.observed_end)
    const first = day(row.expected_first_session),
      last = day(row.expected_last_session)
    const boundary = day(row.boundary_date)
    requireValue(boundary < start && first <= start && start <= end && end <= last)
    requireValue(
      start.startsWith(month) &&
        end.startsWith(month) &&
        first.startsWith(month) &&
        last.startsWith(month),
    )
    requireValue(row.boundary_kind === (index === 0 ? 'initial_cash' : 'preceding_saved_nav'))
    requireValue(
      row.status === 'complete'
        ? observed === expected && start === first && end === last
        : observed < expected,
    )
    return [
      ...context,
      month,
      year,
      monthNumber,
      row.status,
      reasons(row.reasons),
      start,
      end,
      observed,
      first,
      last,
      expected,
      row.unobserved_month_sessions,
      row.boundary_kind,
      boundary,
      positive(row.boundary_nav),
      positive(row.end_nav),
      positive(row.gross_return),
      number(row.return_pct),
      number(row.nav_change),
    ]
  })
  requireValue(sessions === summary.valued_sessions)
  return csv([headers, ...rows])
}

/** Project all horizons and all windows; local details filters/pages are not inputs. */
export function pathRollingCsv(value: PathRolling): string {
  const context = metadata(value, 'rolling')
  const horizons = value.analysis.horizons
  const summary = value.analysis.summary
  requireValue(Array.isArray(horizons) && horizons.length === 3 && summary)
  requireValue(
    summary.total_window_count === 549 &&
      summary.overlapping_windows === true &&
      summary.independent_samples === false,
  )
  const headers = [
    ...metadataHeaders,
    'horizon_sessions',
    'window_number',
    'boundary_index',
    'start_index',
    'end_index',
    'observed_start',
    'observed_end',
    'boundary_kind',
    'boundary_date',
    'boundary_nav',
    'start_nav',
    'end_nav',
    'gross_return',
    'total_return_pct',
    'nav_change',
    'sample_scope',
  ]
  const rows: Cell[][] = []
  for (const [index, horizon] of horizons.entries()) {
    const length = [21, 63, 126][index],
      count = 253 - length
    requireValue(
      horizon &&
        horizon.horizon_sessions === length &&
        horizon.window_count === count &&
        horizon.expected_window_count === count,
    )
    requireValue(Array.isArray(horizon.windows) && horizon.windows.length === count)
    for (const [offset, row] of horizon.windows.entries()) {
      requireValue(
        row &&
          row.horizon_sessions === length &&
          row.window_number === offset + 1 &&
          row.boundary_index === offset &&
          row.start_index === offset + 1 &&
          row.end_index === offset + length,
      )
      const start = day(row.observed_start),
        end = day(row.observed_end),
        boundary = day(row.boundary_date)
      requireValue(
        boundary < start &&
          start <= end &&
          row.boundary_kind === (offset === 0 ? 'initial_cash' : 'preceding_saved_nav'),
      )
      rows.push([
        ...context,
        length,
        row.window_number,
        row.boundary_index,
        row.start_index,
        row.end_index,
        start,
        end,
        row.boundary_kind,
        boundary,
        positive(row.boundary_nav),
        positive(row.start_nav),
        positive(row.end_nav),
        positive(row.gross_return),
        number(row.return_pct),
        number(row.nav_change),
        'one_saved_path_overlapping_not_independent',
      ])
    }
  }
  requireValue(rows.length === summary.total_window_count)
  return csv([headers, ...rows])
}

export function pathAnalysisCsvFilename(kind: Kind, receiptId: string) {
  const safe =
    receiptId
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  return `alphaview-path-${kind}-${kind === 'monthly' ? 'observed-months' : 'all-windows'}-${safe}.csv`
}

/** Explicit local download; CSV is already validated before any Blob is created. */
export function downloadPathAnalysisCsv(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}
