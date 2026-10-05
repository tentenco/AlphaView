import type { PaperAccount } from './paper-model'

export type PaperAccountSummary = Pick<PaperAccount, 'id' | 'name' | 'version'>
export type ComparisonDraft = { accountIds: string[]; start: string; end: string }
export type ComparisonRequest = { account_ids: string[]; start: string; end: string }
export type ComparisonError = 'count' | 'unknown' | 'dates' | 'order'
export type ComparisonPoint = {
  as_of: string
  equity: number | null
  normalized100: number | null
  status: 'complete' | 'incomplete' | 'not_captured' | 'unsupported_method'
  snapshot_id: number | null
  observed_at: string | null
  account_version: number | null
  input_revision: string | null
  paper_engine_version: string | null
  analytics_engine_version: string | null
  quote_coverage: { required: number; priced: number; missing: string[] } | null
}
export type AccountComparison = {
  account_id: string
  name: string
  current_account_version: number
  initial_cash: number
  coverage: {
    expected_sessions: number
    captured_sessions: number
    complete_sessions: number
    missing_sessions: string[]
  }
  series: ComparisonPoint[]
  start_equity: number | null
  end_equity: number | null
  equity_change: number | null
  return_pct: number | null
  max_drawdown_pct: number | null
  performance_available: boolean
  reason: string | null
}
export type PaperComparisonReport = {
  engine_version: string
  as_of: string
  input_revision: string
  period: { start: string; end: string; session_count: number }
  common_start_complete: boolean
  comparable: boolean
  reason: string | null
  accounts: AccountComparison[]
  comparisons: {
    left_id: string
    right_id: string
    return_difference_pp: number
    equity_change_difference: number
    left_initial_cash: number
    right_initial_cash: number
  }[]
  method: string
  warnings: string[]
}

export const COMPARISON_DRAFT_KEY = 'alphaview-paper-nav-comparison-draft-v1'
export const defaultComparisonDraft = (): ComparisonDraft => ({
  accountIds: [],
  start: '',
  end: '',
})
export function isComparisonDraft(value: unknown): value is ComparisonDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as ComparisonDraft
  return (
    Array.isArray(draft.accountIds) &&
    draft.accountIds.length <= 5 &&
    draft.accountIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100) &&
    new Set(draft.accountIds).size === draft.accountIds.length &&
    typeof draft.start === 'string' &&
    draft.start.length <= 10 &&
    typeof draft.end === 'string' &&
    draft.end.length <= 10
  )
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const stamp = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value
}
export function parseComparisonDraft(
  draft: ComparisonDraft,
  accounts: PaperAccountSummary[],
): { request: ComparisonRequest; error: null } | { request: null; error: ComparisonError } {
  if (draft.accountIds.length < 2 || draft.accountIds.length > 5)
    return { request: null, error: 'count' }
  if (draft.accountIds.some((id) => !accounts.some((account) => account.id === id)))
    return { request: null, error: 'unknown' }
  if (!validDate(draft.start) || !validDate(draft.end)) return { request: null, error: 'dates' }
  if (draft.start >= draft.end) return { request: null, error: 'order' }
  return {
    request: { account_ids: [...draft.accountIds], start: draft.start, end: draft.end },
    error: null,
  }
}

export type ComparisonChartPoint = { index: number; value: number; as_of: string }
/** Geometry only. Never create normalized values or connect across missing captures. */
export function comparisonChartData(report: PaperComparisonReport) {
  if (!report.common_start_complete) return { domain: null, series: [] }
  let low = 100
  let high = 100
  const series = report.accounts.map((account) => {
    const segments: ComparisonChartPoint[][] = []
    let segment: ComparisonChartPoint[] = []
    const gaps: number[] = []
    account.series.forEach((point, index) => {
      if (
        point.status !== 'complete' ||
        point.normalized100 == null ||
        !Number.isFinite(point.normalized100)
      ) {
        if (segment.length) segments.push(segment)
        segment = []
        gaps.push(index)
        return
      }
      low = Math.min(low, point.normalized100)
      high = Math.max(high, point.normalized100)
      segment.push({ index, value: point.normalized100, as_of: point.as_of })
    })
    if (segment.length) segments.push(segment)
    return { accountId: account.account_id, name: account.name, segments, gaps }
  })
  const pad = Math.max((high - low) * 0.12, 1)
  return { domain: [Math.max(0, low - pad), high + pad] as [number, number], series }
}
