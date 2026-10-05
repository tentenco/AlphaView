export type PaperNavCoverage = { required: number; priced: number; missing: string[] }
export type PaperNavCurrent = {
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  paper_engine_version: string
  cash: number
  initial_cash: number
  equity: number | null
  holdings_value: number | null
  valuation_complete: boolean
  coverage: PaperNavCoverage
  total_return_pct: number | null
}
export type PaperNavPoint = {
  as_of: string
  equity: number | null
  status: 'complete' | 'incomplete' | 'not_captured'
  snapshot_id: number | null
  observed_at: string | null
  account_version: number | null
  input_revision: string | null
  coverage: PaperNavCoverage | null
  return_pct: number | null
}
export type PaperNavSummary = {
  captured_count: number
  observed_sessions: number
  complete_count: number
  missing_count: number
  start: string | null
  end: string | null
  period_return_pct: number | null
  max_drawdown_pct: number | null
  performance_available: boolean
  reason: string | null
  truncated: boolean
}
export type PaperNavReport = {
  engine_version: string
  as_of: string
  input_revision: string
  account_version: number
  current: PaperNavCurrent
  series: PaperNavPoint[]
  summary: PaperNavSummary
  costs: {
    simulated_fill_count: number
    buy_notional: number
    sell_notional: number
    fees_total: number
    slippage_total: number
    cost_total: number
    turnover_pct_sum: number
  }
  metrics?: PaperMetrics
  method: string
  warnings: string[]
}
export type PaperMetricReasons = Record<string, string>
export type PaperMetrics = {
  method_version: string
  available: boolean
  reason: string | null
  returns_n: number
  low_sample: boolean
  risk: {
    annualized_return_pct: number | null
    annualized_volatility_pct: number | null
    sharpe: number | null
    sortino: number | null
    calmar: number | null
    mean_daily_return_pct: number | null
    best_day_pct: number | null
    worst_day_pct: number | null
    positive_days: number
    negative_days: number
    reasons: PaperMetricReasons
  } | null
  drawdown: {
    max_drawdown_pct: number | null
    longest_underwater_sessions: number
    longest_underwater_from: string | null
    longest_underwater_to: string | null
    underwater_ongoing: boolean
    current_drawdown_pct: number | null
  } | null
  benchmark:
    | {
        symbol: string
        available: true
        price_basis: string
        period_return_pct: number | null
        excess_return_pct: number | null
        beta: number | null
        correlation: number | null
        tracking_error_pct: number | null
        information_ratio: number | null
        coverage: PaperNavCoverage
        reasons: PaperMetricReasons
      }
    | { symbol: string; available: false; reason: string; coverage: PaperNavCoverage }
    | null
  costs: {
    cost_total: number
    cost_drag_pct_of_initial: number | null
    net_return_since_funding_pct: number | null
    gross_return_since_funding_pct: number | null
    reason: string | null
  }
  method: string
  warnings: string[]
}
export type PaperNavCapture = {
  engine_version: string
  snapshot: PaperNavCurrent & { id: number; engine_version: string; observed_at: string }
  created: boolean
  method: string
  warnings: string[]
}

export type NavChartObservation = { index: number; value: number; as_of: string }
/** Drawing geometry only: never fill missing observations or infer a historic NAV. */
export function navChartData(series: PaperNavPoint[]) {
  const segments: NavChartObservation[][] = []
  let segment: NavChartObservation[] = []
  let minimum = Infinity
  let maximum = -Infinity
  const gaps: { index: number; as_of: string; status: PaperNavPoint['status'] }[] = []
  series.forEach((point, index) => {
    if (point.status !== 'complete' || point.equity == null || !Number.isFinite(point.equity)) {
      if (segment.length) segments.push(segment)
      segment = []
      gaps.push({ index, as_of: point.as_of, status: point.status })
      return
    }
    minimum = Math.min(minimum, point.equity)
    maximum = Math.max(maximum, point.equity)
    segment.push({ index, value: point.equity, as_of: point.as_of })
  })
  if (segment.length) segments.push(segment)
  if (!segments.length) return { segments, gaps, domain: null }
  const padding = Math.max((maximum - minimum) * 0.12, Math.abs(maximum) * 0.005, 1)
  const lower = minimum >= 0 ? Math.max(0, minimum - padding) : minimum - padding
  return { segments, gaps, domain: [lower, maximum + padding] as [number, number] }
}
