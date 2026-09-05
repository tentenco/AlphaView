import type { ComparisonResult } from './Comparison'
import { csvCell } from './screener-model'
export type ComparisonExportContext = { workspaceChanged: boolean; draftChanged: boolean }
const finite = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const metadataHeader = [
  'as_of',
  'window_sessions',
  'anchor_date',
  'end_date',
  'input_revision',
  'comparison_engine_version',
  'workspace_changed_since_result',
  'draft_differs_from_result',
]
function metadata(result: ComparisonResult, context: ComparisonExportContext) {
  return [
    result.as_of,
    result.window,
    result.anchor_date,
    result.end_date,
    result.input_revision,
    result.comparison_engine_version,
    context.workspaceChanged,
    context.draftChanged,
  ]
}
function csv(rows: unknown[][]) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
export function comparisonSummaryCsv(
  result: ComparisonResult,
  context: ComparisonExportContext,
): string {
  return csv([
    [
      ...metadataHeader,
      'symbol',
      'name',
      'source',
      'eligible',
      'reason',
      'observed_prices',
      'valid_prices',
      'expected_prices',
      'anchor_adjusted_close',
      'latest_adjusted_close',
      'return_pct',
    ],
    ...result.series.map((series) => [
      ...metadata(result, context),
      series.symbol,
      series.name,
      series.source,
      series.eligible,
      series.reason,
      finite(series.observed_prices),
      finite(series.valid_prices),
      finite(result.expected_prices),
      series.eligible ? finite(series.anchor_price) : null,
      series.eligible ? finite(series.latest_price) : null,
      series.eligible ? finite(series.return_pct) : null,
    ]),
  ])
}
export function comparisonDailyCsv(
  result: ComparisonResult,
  context: ComparisonExportContext,
): string {
  const rows: unknown[][] = [
    [
      ...metadataHeader,
      'symbol',
      'name',
      'source',
      'eligible',
      'date',
      'return_pct_from_common_anchor',
      'point_available',
      'reason',
      'valid_prices',
      'expected_prices',
    ],
  ]
  for (const series of result.series) {
    const prefix = [
      ...metadata(result, context),
      series.symbol,
      series.name,
      series.source,
      series.eligible,
    ]
    if (!series.eligible) {
      rows.push([
        ...prefix,
        null,
        null,
        false,
        series.reason || '標的資料不足，未列入比較',
        finite(series.valid_prices),
        finite(result.expected_prices),
      ])
      continue
    }
    const points = new Map(series.points.map((point) => [point.date, finite(point.return_pct)]))
    for (const date of result.dates) {
      const value = points.get(date) ?? null
      rows.push([
        ...prefix,
        date,
        value,
        value !== null,
        value === null ? '該交易日沒有可用比較值' : series.reason,
        finite(series.valid_prices),
        finite(result.expected_prices),
      ])
    }
  }
  return csv(rows)
}
