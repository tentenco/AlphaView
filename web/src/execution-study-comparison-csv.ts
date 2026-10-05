import type { ExecutionStudyComparisonResult } from './ExecutionStudyReceiptComparison'

type Cell = string | number | null
const DAY_METRICS = {
  raw_open: 'USD_per_share',
  session_volume: 'shares',
  capacity_shares: 'shares',
  scenario_shares: 'shares',
  expired_shares: 'shares',
  fill_fraction_pct: 'percentage_points',
  reference_notional: 'USD',
}
const GTD_METRICS = {
  observed_prefix_scenario_shares: 'shares',
  last_known_remaining_shares: 'shares',
  observed_prefix_reference_notional: 'USD',
  final_scenario_shares: 'shares',
  expired_shares: 'shares',
  final_reference_notional: 'USD',
}
const SESSION_METRICS = {
  raw_open: 'USD_per_share',
  session_volume: 'shares',
  remaining_before: 'shares',
  capacity_shares: 'shares',
  scenario_shares: 'shares',
  remaining_after: 'shares',
  reference_notional: 'USD',
}
const BASIS = [
  'method_versions',
  'saved_evidence_shape',
  'study_method',
  'saved_proposal',
  'evaluation_snapshot',
  'frozen_orders_and_units',
  'exact_session_horizon',
  'raw_bar_evidence',
  'saved_coverage',
  'order_and_day_identity',
]
const hash = /^[a-f0-9]{64}$/
const id = /^[a-f0-9]{32}$/
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('execution_study_comparison_csv_incomplete_or_invalid')
}
function text(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0)
  return value
}
function nullableText(value: unknown): string | null {
  requireValue(value === null || typeof value === 'string')
  return value
}
function numeric(value: unknown): number | null {
  requireValue(value === null || (typeof value === 'number' && Number.isFinite(value)))
  return value
}
function boolean(value: unknown): string {
  requireValue(typeof value === 'boolean')
  return String(value)
}
function day(value: unknown): string {
  const result = text(value)
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/.test(result) &&
      new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) === result,
  )
  return result
}
function reasons(value: unknown): string {
  requireValue(Array.isArray(value) && value.every((item) => typeof item === 'string'))
  return value.join('; ')
}
function object(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value))
}
function finiteJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(finiteJson)
  return !!value && typeof value === 'object' && Object.values(value).every(finiteJson)
}
function csvCell(value: Cell): string {
  if (value === null) return '""'
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value))
    return `"${Object.is(value, -0) ? '-0' : String(value)}"`
  }
  requireValue(typeof value === 'string')
  const safe = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

/** A full projection of an accepted comparison, never a filtered UI view or a recalculation. */
export function executionStudyComparisonCsv(value: ExecutionStudyComparisonResult): string {
  requireValue(
    value &&
      finiteJson(value) &&
      value.engine_version === 'alphaview-execution-study-receipt-comparison-v1',
  )
  requireValue(id.test(text(value.account_id)) && id.test(text(value.proposal_id)))
  requireValue(Number.isSafeInteger(value.account_version) && value.account_version > 0)
  requireValue(['volume_day', 'limit_day', 'open_gtd'].includes(value.kind))
  requireValue(value.request?.expected_account_version === value.account_version)
  const comparison = value.comparison
  requireValue(
    comparison &&
      comparison.aggregate === null &&
      comparison.causal_attribution === false &&
      comparison.execution_authority === false,
  )
  requireValue(comparison.direction === 'selected_minus_baseline')
  const compatible = boolean(comparison.historically_comparable)
  const comparisonReasons = reasons(comparison.reasons)
  requireValue(
    Array.isArray(comparison.basis_checks) && comparison.basis_checks.length >= BASIS.length,
  )
  const codes = new Set<string>()
  for (const check of comparison.basis_checks) {
    requireValue(check && !codes.has(text(check.code)))
    codes.add(check.code)
    boolean(check.matches)
    requireValue(Object.hasOwn(check, 'baseline') && Object.hasOwn(check, 'selected'))
  }
  requireValue(BASIS.every((code) => codes.has(code)))
  requireValue(
    comparison.historically_comparable
      ? comparison.reasons.length === 0 && comparison.basis_checks.every((check) => check.matches)
      : comparisonReasons.length > 0 && comparison.basis_checks.some((check) => !check.matches),
  )
  requireValue(
    comparison.assumptions &&
      Object.hasOwn(comparison.assumptions, 'baseline') &&
      Object.hasOwn(comparison.assumptions, 'selected'),
  )
  const metadata: Cell[] = [
    value.engine_version,
    text(value.method),
    value.kind,
    value.account_id,
    value.proposal_id,
    value.account_version,
    day(value.checked_as_of),
    text(value.checked_input_revision),
    compatible,
    comparisonReasons,
    comparison.direction,
    'false',
    'readable_convenience_not_canonical_evidence',
  ]
  for (const name of ['baseline', 'selected'] as const) {
    const side = value[name],
      summary = side?.summary,
      original = side?.original_receipt
    requireValue(summary && original && summary.integrity?.available === true)
    requireValue(
      hash.test(text(summary.id)) &&
        hash.test(text(summary.content_fingerprint)) &&
        hash.test(text(summary.raw_evidence_sha256)),
    )
    requireValue(
      summary.account_id === value.account_id &&
        summary.proposal_id === value.proposal_id &&
        summary.kind === value.kind,
    )
    requireValue(
      value.request[`${name}_receipt_id`] === summary.id &&
        value.request[`expected_${name}_fingerprint`] === summary.content_fingerprint,
    )
    requireValue(
      original.receipt_id === summary.id &&
        original.kind === value.kind &&
        original.account_context?.account_id === value.account_id &&
        original.evidence?.account_id === value.account_id &&
        original.evidence.source?.account_id === value.account_id &&
        original.evidence.source.id === value.proposal_id &&
        original.source_context?.raw_evidence_sha256 === summary.raw_evidence_sha256 &&
        original.policy?.advisory_only === true &&
        original.policy.execution_source === false &&
        original.policy.gating_authority === false,
    )
    const current = summary.currentness?.current
    requireValue(current === null || typeof current === 'boolean')
    metadata.push(
      summary.id,
      summary.content_fingerprint,
      summary.raw_evidence_sha256,
      nullableText(summary.status),
      current === null ? null : String(current),
      reasons(summary.currentness.reasons),
    )
  }
  requireValue(value.baseline.summary.id !== value.selected.summary.id)
  const headers = [
    'engine_version',
    'comparison_method',
    'study_kind',
    'account_id',
    'proposal_id',
    'account_version',
    'checked_as_of',
    'checked_input_revision',
    'full_basis_compatible',
    'comparison_reasons',
    'difference_direction',
    'execution_authority',
    'evidence_role',
    ...['baseline', 'selected'].flatMap((side) => [
      `${side}_receipt_id`,
      `${side}_receipt_fingerprint`,
      `${side}_raw_evidence_sha256`,
      `${side}_receipt_status`,
      `${side}_current_at_comparison`,
      `${side}_currentness_reasons`,
    ]),
    'record_level',
    'order_number',
    'symbol',
    'session_number',
    'date',
    'date_present',
    'paired',
    'baseline_status',
    'baseline_status_present',
    'selected_status',
    'selected_status_present',
    'baseline_reason',
    'selected_reason',
    'metric_name',
    'unit',
    'baseline_value',
    'baseline_value_present',
    'baseline_value_state',
    'selected_value',
    'selected_value_present',
    'selected_value_state',
    'difference',
    'difference_present',
    'difference_state',
    'metric_reason',
  ]
  requireValue(Array.isArray(comparison.orders) && comparison.orders.length <= 100)
  const rows: Cell[][] = [],
    symbols = new Set<string>()
  for (const [orderIndex, order] of comparison.orders.entries()) {
    requireValue(order && !symbols.has(text(order.symbol)))
    const symbol = text(order.symbol)
    symbols.add(symbol)
    requireValue(Array.isArray(order.sessions) && order.sessions.length <= 5)
    requireValue(value.kind === 'open_gtd' || order.sessions.length === 0)
    const dates = new Set<string>()
    for (const [index, row] of [order, ...order.sessions].entries()) {
      requireValue(row)
      const isSession = index > 0,
        date = isSession ? day(row.date) : null
      if (date !== null) {
        requireValue(!dates.has(date))
        dates.add(date)
      }
      const paired = boolean(row.paired),
        baselineStatus = nullableText(row.baseline_status),
        selectedStatus = nullableText(row.selected_status)
      const baselineReason = nullableText(row.baseline_reason),
        selectedReason = nullableText(row.selected_reason)
      object(row.metrics)
      const required = isSession
        ? SESSION_METRICS
        : value.kind === 'open_gtd'
          ? GTD_METRICS
          : DAY_METRICS
      requireValue(
        Object.entries(required).every(
          ([name, unit]) => Object.hasOwn(row.metrics, name) && row.metrics[name]?.unit === unit,
        ),
      )
      // Export every metric, including any additional fields; missing v1 metrics reject the whole projection.
      for (const [name, metric] of Object.entries(row.metrics)) {
        text(name)
        object(metric)
        const baseline = numeric(metric.baseline),
          selected = numeric(metric.selected),
          difference = numeric(metric.delta)
        const reason = nullableText(metric.reason),
          unit = text(metric.unit)
        requireValue(
          difference === null
            ? reason !== null && reason.length > 0
            : baseline !== null &&
                selected !== null &&
                reason === null &&
                comparison.historically_comparable &&
                row.paired,
        )
        requireValue(
          comparison.historically_comparable ||
            (difference === null && reason === 'comparison_basis_incompatible'),
        )
        rows.push([
          ...metadata,
          isSession ? 'session' : 'order',
          orderIndex + 1,
          symbol,
          isSession ? index : null,
          date,
          String(isSession),
          paired,
          baselineStatus,
          String(baselineStatus !== null),
          selectedStatus,
          String(selectedStatus !== null),
          baselineReason,
          selectedReason,
          name,
          unit,
          baseline,
          String(baseline !== null),
          baseline === null ? 'unavailable' : 'present',
          selected,
          String(selected !== null),
          selected === null ? 'unavailable' : 'present',
          difference,
          String(difference !== null),
          difference === null ? 'unavailable' : 'present',
          reason,
        ])
      }
    }
  }
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

export function executionStudyComparisonCsvFilename(value: ExecutionStudyComparisonResult) {
  const safe = (part: string) => part.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
  return `alphaview-study-comparison-${safe(value.kind)}-${safe(value.baseline.summary.id)}-${safe(value.selected.summary.id)}.csv`
}
