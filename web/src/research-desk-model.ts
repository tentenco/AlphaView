export type DeskStrategyId =
  | 'buy_hold'
  | 'sma_cross'
  | 'rsi_reversion'
  | 'donchian_breakout'
  | 'bollinger_reversion'
  | 'alphaview_turtle'
  | 'alphaview_trend'
  | 'alphaview_pullback'
export type DeskParamSpec = {
  name: string
  kind: 'int' | 'float'
  label: string
  english: string
  min: number
  max: number
  default: number
}
export type DeskStrategy = {
  id: DeskStrategyId
  label: string
  english: string
  family: 'baseline' | 'trend' | 'mean_reversion' | 'alphaview'
  source: string
  summary: string
  summary_en: string
  params: DeskParamSpec[]
}
export type DeskConfig = { strategy: DeskStrategyId; params: Record<string, number> }
export type DeskRisk = {
  initial_cash: number
  fee_bps: number
  slippage_bps: number
  position_pct: number
  stop_loss_pct: number | null
  take_profit_pct: number | null
}
export type DeskRankBy = 'excess_return' | 'sharpe' | 'profit_factor' | 'max_drawdown'
export type DeskCatalog = {
  engine_version: string
  pine_export_version: string
  strategies: DeskStrategy[]
  classic_set: DeskConfig[]
  risk_defaults: DeskRisk
  limits: {
    symbols: number
    configs: number
    min_window_sessions: number
    min_sample_trades: number
  }
  attribution: { project: string; url: string; license: string }
  method: string
  warnings: string[]
}
export type DeskMetrics = {
  start: string
  end: string
  sessions: number
  final_equity: number | null
  net_profit: number | null
  return_pct: number | null
  cagr_pct: number | null
  max_drawdown_pct: number | null
  peak_equity: number | null
  lowest_equity: number | null
  sharpe_ratio: number | null
  annualized_volatility_pct: number | null
  closed_trades: number
  wins: number
  win_rate_pct: number | null
  gross_profit: number | null
  gross_loss: number | null
  profit_factor: number | null
  avg_trade_return_pct: number | null
  largest_win_pct: number | null
  largest_loss_pct: number | null
  max_consecutive_losses: number
  avg_holding_sessions: number | null
  exposure_pct: number | null
  open_position: boolean
  invalid_signal_sessions: number
  excess_return_pct: number | null
}
export type DeskAggregate = {
  symbols: number
  mean_return_pct: number | null
  mean_excess_return_pct: number | null
  beats_benchmark: number
  mean_max_drawdown_pct: number | null
  mean_sharpe_ratio: number | null
  pooled_closed_trades: number
  pooled_win_rate_pct: number | null
  pooled_profit_factor: number | null
  mean_exposure_pct: number | null
  open_positions: number
}
export type DeskFlag =
  | 'benchmark_strategy'
  | 'low_sample'
  | 'no_trades'
  | 'beats_benchmark_minority'
  | 'out_of_sample_decay'
export type DeskLeaderRow = {
  rank: number
  config_index: number
  config: DeskConfig
  label: string
  label_en: string
  family: DeskStrategy['family']
  in_sample: DeskAggregate | null
  out_of_sample: DeskAggregate | null
  full: DeskAggregate | null
  rank_value: number | null
  flags: DeskFlag[]
}
export type DeskWindow = { start: string; end: string; sessions: number }
export type DeskSymbol = {
  symbol: string
  status: 'ok' | 'unavailable'
  error: { code: string; message: string } | null
  bars?: number
  data_start?: string
  data_end?: string
  history_stale?: boolean
  windows?: { full: DeskWindow; in_sample: DeskWindow; out_of_sample?: DeskWindow }
  out_of_sample_available?: boolean
  out_of_sample_reason?: string | null
  fingerprint?: string
}
export type DeskRequest = {
  symbols: string[]
  configs: DeskConfig[]
  risk: DeskRisk
  start_date: string | null
  end_date: string | null
  oos_pct: number
  rank_by: DeskRankBy
  save: boolean
}
export type DeskResult = {
  engine_version: string
  as_of: string
  input_revision: string
  request: DeskRequest
  rank_by: DeskRankBy
  configs_tested: number
  symbols: DeskSymbol[]
  results: {
    config_index: number
    symbol: string
    full: DeskMetrics
    in_sample: DeskMetrics
    out_of_sample: DeskMetrics | null
  }[]
  leaderboard: DeskLeaderRow[]
  benchmark_summary: Record<'full' | 'in_sample' | 'out_of_sample', number | null>
  method: string
  warnings: string[]
  run_id: string | null
  created_at?: string
  current?: boolean
  stale_reasons?: string[]
}
export type DeskTrade = {
  signal_date: string
  entry_date: string
  entry_price: number | null
  exit_date: string
  exit_price: number | null
  exit_reason: 'signal' | 'stop_loss' | 'take_profit'
  units: number | null
  cost: number | null
  entry_fee: number | null
  exit_fee: number | null
  net_pnl: number | null
  return_pct: number | null
  holding_sessions: number
  holding_days: number
  rsi_at_signal: number | null
  volatility_at_signal_pct: number | null
  conditions: Record<DeskConditionDimension, string>
}
export type DeskConditionDimension =
  'trend' | 'rsi_zone' | 'volatility' | 'benchmark' | 'holding' | 'exit_reason'
export type DeskBucket = {
  bucket: string
  trades: number
  wins: number
  win_rate_pct: number | null
  total_pnl: number | null
  gross_loss: number | null
  avg_return_pct: number | null
  worst_return_pct: number | null
  loss_share_pct: number | null
}
export type DeskDiagnosis = {
  engine_version: string
  as_of: string
  input_revision: string
  symbol: string
  config: DeskConfig
  label: string
  label_en: string
  window: DeskWindow
  summary: DeskMetrics
  benchmark: DeskMetrics
  curve: { date: string; value: number; benchmark: number }[]
  trades: DeskTrade[]
  open_position: {
    signal_date: string
    entry_date: string
    entry_price: number
    mark_date: string
    mark_price: number
    unrealized_pnl: number
    unrealized_return_pct: number
  } | null
  conditions: Record<DeskConditionDimension, DeskBucket[]>
  drawdowns: {
    peak_date: string
    trough_date: string
    recovery_date: string | null
    depth_pct: number | null
    sessions_to_trough: number
    sessions_to_recovery: number | null
  }[]
  hypotheses: { code: string; text: string; text_en: string; evidence: Record<string, number> }[]
  benchmark_symbol: string
  fingerprint: string
  method: string
  warnings: string[]
  request?: {
    risk: DeskRisk
    test_start: string | null
    test_end: string | null
    benchmark_symbol: string
  }
}
export type DeskPreset = {
  id: string
  name: string
  config: DeskConfig
  risk: DeskRisk
  version: number
  label: string
  label_en: string
  created_at: string
  updated_at: string
}
export type DeskRunSummary = {
  id: string
  created_at: string
  as_of: string
  symbols: string[]
  symbols_ok: number
  configs_tested: number
  rank_by: DeskRankBy
  oos_pct: number
  top: { label: string; label_en: string; rank_value: number | null }[]
  current: boolean
  stale_reasons: string[]
}
export type DeskPine = {
  filename: string
  code: string
  label: string
  label_en: string
  notes: string[]
}

export type DeskConfigDraft = { strategy: DeskStrategyId; params: Record<string, string> }
export type DeskDraft = {
  symbols: string
  startDate: string
  endDate: string
  oosPct: string
  rankBy: DeskRankBy
  risk: {
    initial_cash: string
    fee_bps: string
    slippage_bps: string
    position_pct: string
    stop_loss_pct: string
    take_profit_pct: string
  }
  configs: DeskConfigDraft[]
}
export const DESK_DRAFT_KEY = 'alphaview:research-desk-draft:v1'
export const defaultDeskDraft = (): DeskDraft => ({
  symbols: '',
  startDate: '',
  endDate: '',
  oosPct: '30',
  rankBy: 'excess_return',
  risk: {
    initial_cash: '100000',
    fee_bps: '10',
    slippage_bps: '0',
    position_pct: '100',
    stop_loss_pct: '',
    take_profit_pct: '',
  },
  configs: [],
})
const shortText = (value: unknown, limit = 32) => typeof value === 'string' && value.length <= limit
export function validDeskDraft(value: unknown): value is DeskDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as DeskDraft
  return (
    shortText(draft.symbols, 400) &&
    shortText(draft.startDate) &&
    shortText(draft.endDate) &&
    shortText(draft.oosPct) &&
    ['excess_return', 'sharpe', 'profit_factor', 'max_drawdown'].includes(draft.rankBy) &&
    !!draft.risk &&
    Object.keys(defaultDeskDraft().risk).every((key) =>
      shortText(draft.risk[key as keyof DeskDraft['risk']]),
    ) &&
    Array.isArray(draft.configs) &&
    draft.configs.length <= 24 &&
    draft.configs.every(
      (config) =>
        !!config &&
        typeof config.strategy === 'string' &&
        !!config.params &&
        typeof config.params === 'object' &&
        Object.values(config.params).every((item) => shortText(item)),
    )
  )
}
export const configDraft = (config: DeskConfig): DeskConfigDraft => ({
  strategy: config.strategy,
  params: Object.fromEntries(
    Object.entries(config.params).map(([key, value]) => [key, String(value)]),
  ),
})
export function parseSymbols(text: string) {
  return text
    .trim()
    .toUpperCase()
    .split(/[\s,，;；]+/)
    .filter(Boolean)
}
export type DeskDraftError =
  | {
      code:
        'symbols' | 'duplicate_symbols' | 'configs' | 'duplicate_configs' | 'risk' | 'oos' | 'dates'
    }
  | { code: 'param'; index: number; name: string }
  | { code: 'relation'; index: number }
const numberOf = (text: string) => (text.trim() ? Number(text) : NaN)
/** Mirror the backend bounds exactly; nothing is clamped or silently defaulted. */
export function parseConfig(
  draft: DeskConfigDraft,
  catalog: DeskCatalog,
  index = 0,
): { config: DeskConfig; error: null } | { config: null; error: DeskDraftError } {
  const spec = catalog.strategies.find((item) => item.id === draft.strategy)
  if (!spec) return { config: null, error: { code: 'configs' } }
  const params: Record<string, number> = {}
  for (const rule of spec.params) {
    const value = numberOf(draft.params[rule.name] ?? String(rule.default))
    if (
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max ||
      (rule.kind === 'int' && !Number.isInteger(value))
    )
      return { config: null, error: { code: 'param', index, name: rule.name } }
    params[rule.name] = value
  }
  if (spec.id === 'sma_cross' && params.fast >= params.slow)
    return { config: null, error: { code: 'relation', index } }
  if (spec.id === 'rsi_reversion' && params.entry >= params.exit)
    return { config: null, error: { code: 'relation', index } }
  return { config: { strategy: spec.id, params }, error: null }
}
export const configKey = (config: DeskConfig) =>
  JSON.stringify([
    config.strategy,
    Object.entries(config.params).sort(([left], [right]) => left.localeCompare(right)),
  ])
export function parseDeskDraft(
  draft: DeskDraft,
  catalog: DeskCatalog,
): { request: DeskRequest; error: null } | { request: null; error: DeskDraftError } {
  const symbols = parseSymbols(draft.symbols)
  if (
    symbols.length < 1 ||
    symbols.length > catalog.limits.symbols ||
    symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
  )
    return { request: null, error: { code: 'symbols' } }
  if (new Set(symbols).size !== symbols.length)
    return { request: null, error: { code: 'duplicate_symbols' } }
  if (draft.configs.length < 1 || draft.configs.length > catalog.limits.configs)
    return { request: null, error: { code: 'configs' } }
  const configs: DeskConfig[] = []
  for (const [index, item] of draft.configs.entries()) {
    const parsed = parseConfig(item, catalog, index)
    if (parsed.error) return { request: null, error: parsed.error }
    configs.push(parsed.config)
  }
  if (new Set(configs.map(configKey)).size !== configs.length)
    return { request: null, error: { code: 'duplicate_configs' } }
  const risk = draft.risk
  const cash = numberOf(risk.initial_cash)
  const fee = numberOf(risk.fee_bps)
  const slippage = numberOf(risk.slippage_bps)
  const position = numberOf(risk.position_pct)
  const stop = risk.stop_loss_pct.trim() ? Number(risk.stop_loss_pct) : null
  const target = risk.take_profit_pct.trim() ? Number(risk.take_profit_pct) : null
  if (
    !(cash >= 1000 && cash <= 1e9) ||
    !(fee >= 0 && fee <= 100) ||
    !(slippage >= 0 && slippage <= 100) ||
    !(position >= 1 && position <= 100) ||
    (stop !== null && !(stop >= 0.5 && stop <= 50)) ||
    (target !== null && !(target >= 1 && target <= 500))
  )
    return { request: null, error: { code: 'risk' } }
  const oos = numberOf(draft.oosPct)
  if (!Number.isInteger(oos) || (oos !== 0 && (oos < 10 || oos > 50)))
    return { request: null, error: { code: 'oos' } }
  const date = /^\d{4}-\d{2}-\d{2}$/
  if (
    (draft.startDate && !date.test(draft.startDate)) ||
    (draft.endDate && !date.test(draft.endDate)) ||
    (draft.startDate && draft.endDate && draft.startDate > draft.endDate)
  )
    return { request: null, error: { code: 'dates' } }
  return {
    request: {
      symbols,
      configs,
      risk: {
        initial_cash: cash,
        fee_bps: fee,
        slippage_bps: slippage,
        position_pct: position,
        stop_loss_pct: stop,
        take_profit_pct: target,
      },
      start_date: draft.startDate || null,
      end_date: draft.endDate || null,
      oos_pct: oos,
      rank_by: draft.rankBy,
      save: true,
    },
    error: null,
  }
}
/** Cartesian parameter grid, keeping only combinations the backend accepts. */
export function parameterGrid(
  strategy: DeskStrategyId,
  values: Record<string, number[]>,
  catalog: DeskCatalog,
): DeskConfig[] {
  const names = Object.keys(values)
  const combos = names.reduce<Record<string, number>[]>(
    (rows, name) => rows.flatMap((row) => values[name].map((value) => ({ ...row, [name]: value }))),
    [{}],
  )
  return combos.flatMap((params) => {
    const parsed = parseConfig(
      {
        strategy,
        params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      },
      catalog,
    )
    return parsed.config ? [parsed.config] : []
  })
}
export const deskPercent = (value: number | null | undefined, digits = 2) =>
  value == null
    ? '—'
    : `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}%`
export const deskRatio = (value: number | null | undefined) =>
  value == null ? '—' : value.toFixed(2)

export type DeskValidationFold = {
  index: number
  start: string
  end: string
  sessions: number
  return_pct: number | null
  closed_trades: number
  win_rate_pct: number | null
  max_drawdown_pct: number | null
  sharpe_ratio: number | null
  status: 'positive' | 'negative' | 'no_trades'
}
export type DeskValidation = {
  engine_version: string
  desk_engine_version: string
  as_of: string
  input_revision: string
  symbol: string
  config: DeskConfig
  label: string
  label_en: string
  window: DeskWindow
  summary: {
    return_pct: number | null
    max_drawdown_pct: number | null
    sharpe_ratio: number | null
    closed_trades: number
    win_rate_pct: number | null
    profit_factor: number | null
    avg_trade_return_pct: number | null
  }
  walk_forward: {
    available: boolean
    reason: string | null
    detail: string | null
    folds: DeskValidationFold[]
    consistency: number | null
    traded_folds?: number
    positive_folds?: number
  }
  bootstrap: {
    available: boolean
    reason: string | null
    closed_trades: number
    required?: number
    samples: number
    seed: number
    mean_trade_return_pct?: number | null
    ci95_lower_pct?: number | null
    ci95_upper_pct?: number | null
    probability_mean_le_zero?: number | null
  }
  sharpe: {
    available: boolean
    reason: string | null
    sessions: number
    trials: number
    required?: number
    sharpe_daily?: number | null
    sharpe_annualized?: number | null
    skewness?: number | null
    kurtosis?: number | null
    benchmark_sharpe_daily?: number | null
    kind?: 'probabilistic' | 'deflated'
    probability?: number | null
  }
  verdict: { status: 'pass' | 'warn' | 'fail'; reasons: string[]; rule: string }
  fingerprint: string
  method: string
  warnings: string[]
}
export type DeskValidationBatch = {
  engine_version: string
  as_of: string
  input_revision: string
  config: DeskConfig
  label: string
  label_en: string
  folds: number
  trials: number
  items: (
    | {
        symbol: string
        status: 'evaluated'
        verdict: 'pass' | 'warn' | 'fail'
        reasons: string[]
        window: DeskWindow
        closed_trades: number
        return_pct: number | null
        consistency: number | null
        ci95: [number | null, number | null] | null
        probability: number | null
        unavailable: string[]
      }
    | { symbol: string; status: 'unavailable'; code: string; message: string; verdict: null }
  )[]
  counts: { pass: number; warn: number; fail: number; unavailable: number }
  pass_share: number | null
  overall: 'pass' | 'warn' | 'fail' | 'unavailable'
  method: string
  warnings: string[]
}
