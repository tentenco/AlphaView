export type Signal = {
  strategy: string
  status: 'match' | 'watch' | 'insufficient' | 'stale' | 'data_error'
  matched: boolean
  reason: string
}
export type Research = {
  symbol: string
  name?: string
  date: string | null
  bars: number
  indicators: Record<string, number | null>
  signals: Signal[]
}
export type Dataset = {
  symbol: string
  name: string
  currency: string
  exchange: string
  fetched_at: string | null
  last_date: string | null
  bar_count: number
  status: string
  error: string | null
  source: string
}
export type Position = {
  updated_at?: string
  symbol: string
  name: string
  shares: number
  cost: number | null
  sector: string
  source: string
  snapshot_price: number | null
  snapshot_change: number | null
  price: number | null
  change: number | null
  change_pct: number | null
  market_value: number | null
  pnl: number | null
  pnl_pct: number | null
  weight: number | null
  price_date: string | null
  quote_status?: 'ok' | 'partial' | 'stale' | 'unavailable'
  expected_session?: string
  quote_reason?: string | null
  sparkline: { date: string; close: number | null }[]
  research_context?: {
    snapshot_id: number | null
    as_of: string | null
    created_at: string | null
    scope: Scope
    input_status: 'current' | 'stale' | 'unknown'
    available: boolean
    reason: string | null
  }
  research: Research | null
  dataset: Dataset | null
}
export type Strategy = {
  id: string
  name: string
  english: string
  period: number
  description: string
  rules: string[]
  origin: string
}
export type Scan = {
  input_revision?: string | null
  current_input_revision?: string
  input_status?: 'current' | 'stale' | 'unknown'
  input_stale?: boolean | null
  matches_current_universe?: boolean
  scan_member_count?: number
  current_member_count?: number
  scope: Scope
  id: number
  as_of: string
  created_at: string
  universe: string[]
  result: Research[]
}
export type Scope = 'portfolio' | 'market'
export type Job = {
  cancel_requested?: boolean
  scope: Scope
  id: string
  kind: string
  status: string
  progress: string
  started_at: string
  finished_at: string | null
  error: string | null
}
export type Overview = {
  revision?: string
  jobs_revision?: string
  market_universe_meta?: {
    requested_limit: number
    provider_total: number
    raw_count: number
    accepted_count: number
    pages: number
    discovered_at: string
  } | null
  market_scan: Scan | null
  market_scan_dates: { as_of: string }[]
  market_universe: { symbol: string; name: string; discovered_at: string }[]
  positions: Position[]
  summary: {
    market_value: number | null
    pnl: number | null
    pnl_pct: number | null
    day_change: number | null
    day_change_partial?: boolean
    day_change_covered_count?: number
    day_change_pct: number | null
    holding_count: number
    watch_count: number
    priced_count: number
    current_priced_count?: number
    stale_count?: number
    expected_session?: string
    dates: string[]
    matched_count: number | null
    research_available?: boolean
    partial: boolean
    mixed_dates: boolean
  }
  scan: Scan | null
  scan_dates: { as_of: string }[]
  strategies: Strategy[]
  datasets: Dataset[]
  jobs: Job[]
  server_time: string
}
export type StockDetail = {
  position: Position
  history: {
    date: string
    close: number | null
    ma20: number | null
    ma50: number | null
    ma200: number | null
    rsi: number | null
    volume: number | null
  }[]
  quality?: {
    status: string
    valid: boolean
    invalid_count: number
    issues: { date: string; reason: string }[]
  }
  strategies: Strategy[]
}
export type Backtest = {
  cagr_pct?: number | null
  annualized_volatility_pct?: number | null
  sharpe_ratio?: number | null
  win_rate_pct?: number | null
  profit_factor?: number | null
  exposure_pct?: number
  avg_holding_days?: number | null
  trading_days?: number
  elapsed_days?: number
  warnings?: string[]
  cache_stale?: boolean
  current_input_fingerprint?: string
  engine_version?: string
  input_fingerprint?: string
  benchmark_symbol?: string
  parameters?: {
    initial: number
    fee_bps: number
    start_date: string | null
    end_date: string | null
  }
  created_at?: string
  symbol: string
  strategy: string
  start: string
  end: string
  initial: number
  final: number
  return_pct: number
  benchmark_pct: number
  max_drawdown_pct: number
  trades: { entry_date: string; exit_date: string; return_pct: number }[]
  open_position: { date: string; capital: number } | null
  curve: { date: string; value: number; benchmark: number }[]
  method: string
}
