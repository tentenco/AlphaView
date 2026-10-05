import { describe, expect, it } from 'vitest'
import type { ExecutionStudyComparisonResult } from './ExecutionStudyReceiptComparison'
import {
  executionStudyComparisonCsv,
  executionStudyComparisonCsvFilename,
} from './execution-study-comparison-csv'

const basisNames = [
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
const dayFields = [
  'raw_open',
  'session_volume',
  'capacity_shares',
  'scenario_shares',
  'expired_shares',
  'fill_fraction_pct',
  'reference_notional',
]
const gtdFields = [
  'observed_prefix_scenario_shares',
  'last_known_remaining_shares',
  'observed_prefix_reference_notional',
  'final_scenario_shares',
  'expired_shares',
  'final_reference_notional',
]
const dailyFields = [
  'raw_open',
  'session_volume',
  'remaining_before',
  'capacity_shares',
  'scenario_shares',
  'remaining_after',
  'reference_notional',
]
function metrics(names: string[], missing = false) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        baseline: missing ? null : 10,
        selected: missing ? null : 12,
        delta: missing ? null : 2,
        reason: missing ? 'baseline_value_unavailable' : null,
        unit:
          name === 'raw_open'
            ? 'USD_per_share'
            : name === 'fill_fraction_pct'
              ? 'percentage_points'
              : name.includes('notional')
                ? 'USD'
                : 'shares',
      },
    ]),
  )
}
function fixture(
  kind: ExecutionStudyComparisonResult['kind'] = 'volume_day',
  count = 100,
): ExecutionStudyComparisonResult {
  const account = 'a'.repeat(32),
    proposal = 'b'.repeat(32)
  const side = (letter: string) => ({
    summary: {
      id: letter.repeat(64),
      account_id: account,
      proposal_id: proposal,
      kind,
      created_at: '2026-10-01T00:00:00Z',
      content_fingerprint: (letter === 'c' ? 'e' : 'f').repeat(64),
      raw_evidence_sha256: '0'.repeat(64),
      status: 'incomplete',
      integrity: { available: true, reason: null },
      currentness: { current: null, reasons: ['currentness_unavailable'] },
    },
    original_receipt: {
      receipt_id: letter.repeat(64),
      kind,
      account_context: { account_id: account },
      source_context: { raw_evidence_sha256: '0'.repeat(64) },
      evidence: { account_id: account, source: { id: proposal, account_id: account } },
      policy: { advisory_only: true, execution_source: false, gating_authority: false },
    },
  })
  const value: ExecutionStudyComparisonResult = {
    engine_version: 'alphaview-execution-study-receipt-comparison-v1',
    account_id: account,
    proposal_id: proposal,
    account_version: 1,
    kind,
    request: {
      baseline_receipt_id: 'c'.repeat(64),
      selected_receipt_id: 'd'.repeat(64),
      expected_baseline_fingerprint: 'e'.repeat(64),
      expected_selected_fingerprint: 'f'.repeat(64),
      expected_account_version: 1,
    },
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:1',
    baseline: side('c'),
    selected: side('d'),
    method: 'Saved comparison of synthetic evidence only',
    comparison: {
      historically_comparable: true,
      reasons: [],
      basis_checks: basisNames.map((code) => ({
        code,
        matches: true,
        baseline: 'saved',
        selected: 'saved',
      })),
      assumptions: { baseline: { participation_pct: 10 }, selected: { participation_pct: 20 } },
      direction: 'selected_minus_baseline',
      aggregate: null,
      causal_attribution: false,
      execution_authority: false,
      orders: Array.from({ length: count }, (_, index) => ({
        symbol: `SYN${String(index).padStart(3, '0')}`,
        paired: true,
        baseline_status: 'partial_expired',
        selected_status: 'unavailable',
        baseline_reason: null,
        selected_reason: 'future_unknown',
        metrics: metrics(kind === 'open_gtd' ? gtdFields : dayFields),
        sessions:
          kind === 'open_gtd'
            ? Array.from({ length: 5 }, (_, day) => ({
                date: `2026-10-${String(day + 1).padStart(2, '0')}`,
                paired: true,
                baseline_status: day === 4 ? 'future_unknown' : 'evaluated',
                selected_status: day === 4 ? 'future_unknown' : 'evaluated',
                baseline_reason: day === 4 ? 'future_unknown' : null,
                selected_reason: day === 4 ? 'future_unknown' : null,
                metrics: metrics(dailyFields, day === 4),
              }))
            : [],
      })),
    },
  }
  return value
}
function records(csv: string) {
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  for (let i = 1; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && csv[i + 1] === '\n' && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += char
  }
  expect(quoted).toBe(false)
  expect(cell).toBe('')
  expect(row).toEqual([])
  const [headers, ...data] = rows
  return data.map((values) => {
    expect(values).toHaveLength(headers.length)
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]))
  })
}
function incompatible(value: ExecutionStudyComparisonResult) {
  value.comparison.historically_comparable = false
  value.comparison.reasons = ['raw_bar_evidence']
  value.comparison.basis_checks.find((row) => row.code === 'raw_bar_evidence')!.matches = false
  for (const order of value.comparison.orders)
    for (const row of [order, ...order.sessions!])
      for (const metric of Object.values(row.metrics)) {
        metric.delta = null
        metric.reason = 'comparison_basis_incompatible'
      }
  return value
}

describe('full saved execution-study comparison CSV', () => {
  it.each(['volume_day', 'limit_day'] as const)(
    'exports all 100 %s orders and seven original metrics with full provenance',
    (kind) => {
      const value = fixture(kind),
        before = JSON.stringify(value),
        csv = executionStudyComparisonCsv(value),
        rows = records(csv)
      expect(rows).toHaveLength(700)
      expect(csv.replaceAll('\r\n', '')).not.toContain('\n')
      expect(rows[0]).toMatchObject({
        record_level: 'order',
        order_number: '1',
        symbol: 'SYN000',
        date: '',
        date_present: 'false',
        session_number: '',
        metric_name: 'raw_open',
        baseline_value: '10',
        selected_value: '12',
        difference: '2',
        baseline_value_present: 'true',
        baseline_value_state: 'present',
        full_basis_compatible: 'true',
        engine_version: value.engine_version,
        comparison_method: value.method,
        checked_as_of: '2026-10-01',
        baseline_receipt_id: 'c'.repeat(64),
        selected_receipt_fingerprint: 'f'.repeat(64),
        baseline_current_at_comparison: '',
        execution_authority: 'false',
      })
      expect(rows[699]).toMatchObject({
        order_number: '100',
        symbol: 'SYN099',
        metric_name: 'reference_notional',
        unit: 'USD',
      })
      expect(JSON.stringify(value)).toBe(before)
    },
  )
  it('exports all 4100 GTD order/daily metrics, including explicitly unavailable future sessions', () => {
    const value = fixture('open_gtd'),
      rows = records(executionStudyComparisonCsv(value))
    expect(rows).toHaveLength(4100)
    expect(rows.filter((row) => row.record_level === 'order')).toHaveLength(600)
    expect(rows.filter((row) => row.record_level === 'session')).toHaveLength(3500)
    expect(rows[6]).toMatchObject({
      record_level: 'session',
      order_number: '1',
      symbol: 'SYN000',
      session_number: '1',
      date: '2026-10-01',
      date_present: 'true',
      metric_name: 'raw_open',
    })
    expect(rows.at(-1)).toMatchObject({
      record_level: 'session',
      order_number: '100',
      symbol: 'SYN099',
      session_number: '5',
      date: '2026-10-05',
      baseline_status: 'future_unknown',
      selected_reason: 'future_unknown',
      metric_name: 'reference_notional',
      baseline_value: '',
      selected_value: '',
      difference: '',
      baseline_value_present: 'false',
      selected_value_present: 'false',
      difference_present: 'false',
      baseline_value_state: 'unavailable',
      difference_state: 'unavailable',
      metric_reason: 'baseline_value_unavailable',
    })
  })
  it('preserves known zero, negative zero, negative values and numeric precision without formula prefixes', () => {
    const value = fixture('volume_day', 1)
    value.comparison.orders[0].metrics.scenario_shares = {
      baseline: 12.3456789012345,
      selected: 0,
      delta: -12.3456789012345,
      reason: null,
      unit: 'shares',
    }
    value.comparison.orders[0].metrics.expired_shares = {
      baseline: 0,
      selected: -0,
      delta: -0,
      reason: null,
      unit: 'shares',
    }
    const rows = records(executionStudyComparisonCsv(value))
    expect(rows.find((row) => row.metric_name === 'scenario_shares')).toMatchObject({
      baseline_value: '12.3456789012345',
      selected_value: '0',
      difference: '-12.3456789012345',
      selected_value_present: 'true',
      difference_state: 'present',
    })
    expect(rows.find((row) => row.metric_name === 'expired_shares')).toMatchObject({
      baseline_value: '0',
      selected_value: '-0',
      difference: '-0',
    })
  })
  it('retains finite incompatible side values while every difference stays blank with its original reason', () => {
    const value = incompatible(fixture('open_gtd', 1)),
      rows = records(executionStudyComparisonCsv(value))
    expect(rows).toHaveLength(41)
    expect(
      rows.every(
        (row) =>
          row.full_basis_compatible === 'false' &&
          row.difference === '' &&
          row.difference_present === 'false' &&
          row.metric_reason === 'comparison_basis_incompatible',
      ),
    ).toBe(true)
    expect(rows[0]).toMatchObject({
      baseline_value: '10',
      selected_value: '12',
      comparison_reasons: 'raw_bar_evidence',
    })
    expect(rows.at(-1)).toMatchObject({
      baseline_value: '',
      selected_value: '',
      baseline_value_state: 'unavailable',
    })
  })
  it.each([
    '=SUM(1,2)',
    ' +1',
    '\t@COMMAND',
    '-text',
    '＝1',
    '＋1',
    '－1',
    '＠A',
    '\rtext',
    '\ntext',
  ])('guards every string projection including source/status/metric text (%j)', (payload) => {
    const value = incompatible(fixture('volume_day', 1)),
      order = value.comparison.orders[0]
    value.method = payload
    value.checked_input_revision = payload
    value.baseline.summary.currentness.reasons = [payload]
    value.baseline.summary.status = payload
    order.symbol = payload
    order.baseline_status = payload
    order.baseline_reason = payload
    order.selected_reason = payload
    order.metrics[payload] = {
      baseline: null,
      selected: null,
      delta: null,
      reason: 'comparison_basis_incompatible',
      unit: payload,
    }
    const rows = records(executionStudyComparisonCsv(value)),
      row = rows.at(-1)!
    expect(row.comparison_method).toBe(`'${payload}`)
    expect(row.checked_input_revision).toBe(`'${payload}`)
    expect(row.baseline_currentness_reasons).toBe(`'${payload}`)
    expect(row.baseline_receipt_status).toBe(`'${payload}`)
    expect(row.symbol).toBe(`'${payload}`)
    expect(row.baseline_status).toBe(`'${payload}`)
    expect(row.baseline_reason).toBe(`'${payload}`)
    expect(row.selected_reason).toBe(`'${payload}`)
    expect(row.metric_name).toBe(`'${payload}`)
    expect(row.unit).toBe(`'${payload}`)
  })
  it('round-trips Unicode, embedded quotes, commas and newlines and retains extra saved metrics', () => {
    const value = fixture('volume_day', 1),
      literal = '合成,"quoted"\nnotes'
    value.method = literal
    value.comparison.orders[0].metrics.extra_saved_metric = {
      baseline: null,
      selected: 0,
      delta: null,
      reason: literal,
      unit: literal,
    }
    const rows = records(executionStudyComparisonCsv(value))
    expect(rows).toHaveLength(8)
    expect(rows.at(-1)).toMatchObject({
      comparison_method: literal,
      metric_name: 'extra_saved_metric',
      baseline_value: '',
      baseline_value_present: 'false',
      selected_value: '0',
      selected_value_present: 'true',
      difference: '',
      metric_reason: literal,
      unit: literal,
    })
  })
  it.each([undefined, NaN, Infinity, -Infinity])(
    'rejects missing or nonfinite numeric data (%s) instead of dropping it or filling zero',
    (invalid) => {
      const value = fixture('open_gtd', 1)
      value.comparison.orders[0].sessions![4].metrics.reference_notional.selected =
        invalid as number
      expect(() => executionStudyComparisonCsv(value)).toThrow()
    },
  )
  it.each([
    'missing_basis',
    'missing_metric',
    'missing_sessions',
    'missing_status',
    'missing_source',
    'wrong_fingerprint',
    'missing_reason',
    'incompatible_delta',
    'wrong_engine',
    'invalid_date',
    'duplicate_date',
    'daily_rows_in_day',
  ])('rejects incomplete or contradictory response structure (%s)', (mode) => {
    const value = fixture('open_gtd', 1)
    if (mode === 'missing_basis') value.comparison.basis_checks.pop()
    if (mode === 'missing_metric') delete value.comparison.orders[0].sessions![0].metrics.raw_open
    if (mode === 'missing_sessions') delete value.comparison.orders[0].sessions
    if (mode === 'missing_status')
      value.comparison.orders[0].baseline_status = undefined as unknown as string
    if (mode === 'missing_source') value.baseline.summary.raw_evidence_sha256 = null
    if (mode === 'wrong_fingerprint') value.request.expected_baseline_fingerprint = '1'.repeat(64)
    if (mode === 'missing_reason')
      value.comparison.orders[0].sessions![4].metrics.raw_open.reason = null
    if (mode === 'incompatible_delta') {
      incompatible(value)
      value.comparison.orders[0].metrics.final_scenario_shares.delta = 2
    }
    if (mode === 'wrong_engine') value.engine_version = 'unknown-method'
    if (mode === 'invalid_date') value.comparison.orders[0].sessions![0].date = '2026-02-30'
    if (mode === 'duplicate_date') value.comparison.orders[0].sessions![1].date = '2026-10-01'
    if (mode === 'daily_rows_in_day') value.kind = 'volume_day'
    expect(() => executionStudyComparisonCsv(value)).toThrow()
  })
  it('rejects nonfinite values elsewhere in the accepted evidence instead of treating the projection as valid', () => {
    const value = fixture('volume_day', 1)
    value.comparison.assumptions.baseline = { nested: { unknown: Infinity } }
    expect(() => executionStudyComparisonCsv(value)).toThrow()
  })
  it('creates a bounded safe filename identifying both full source receipts', () => {
    const value = fixture('limit_day', 1)
    expect(executionStudyComparisonCsvFilename(value)).toBe(
      `alphaview-study-comparison-limit_day-${'c'.repeat(64)}-${'d'.repeat(64)}.csv`,
    )
    value.baseline.summary.id = '../=bad/file'
    value.selected.summary.id = 'x'.repeat(200)
    expect(executionStudyComparisonCsvFilename(value)).toBe(
      `alphaview-study-comparison-limit_day--bad-file-${'x'.repeat(64)}.csv`,
    )
  })
})
