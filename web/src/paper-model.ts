export type PaperLimits = {
  max_position_weight_pct: number
  max_turnover_pct: number
  min_cash_weight_pct: number
}

export type PaperExecutionPolicy = {
  fee_bps: number
  slippage_bps: number
  min_trade_notional: number
  share_precision: number
}
export type PaperSymbolPolicy = {
  engine_version: 'alphaview-paper-symbol-policy-v1'
  version: number
  mode: 'unrestricted' | 'allowlist'
  symbols: string[]
}
export type PaperPolicyDraft = {
  limits: PaperLimits
  execution: PaperExecutionPolicy
  version: number
}
export function validPaperPolicyDraft(value: unknown): value is PaperPolicyDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as PaperPolicyDraft
  return (
    Number.isInteger(draft.version) &&
    draft.version > 0 &&
    !!draft.limits &&
    !!draft.execution &&
    ['max_position_weight_pct', 'max_turnover_pct', 'min_cash_weight_pct'].every(
      (key) =>
        typeof draft.limits[key as keyof PaperLimits] === 'number' &&
        Number.isFinite(draft.limits[key as keyof PaperLimits]),
    ) &&
    ['fee_bps', 'slippage_bps', 'min_trade_notional', 'share_precision'].every(
      (key) =>
        typeof draft.execution[key as keyof PaperExecutionPolicy] === 'number' &&
        Number.isFinite(draft.execution[key as keyof PaperExecutionPolicy]),
    )
  )
}
export const DEFAULT_PAPER_EXECUTION: PaperExecutionPolicy = {
  fee_bps: 0,
  slippage_bps: 0,
  min_trade_notional: 0,
  share_precision: 6,
}

export type PaperAccount = {
  id: string
  name: string
  currency: 'USD'
  initial_cash: number
  cash: number
  version: number
  kill_switch: boolean
  limits: PaperLimits
  execution_policy?: PaperExecutionPolicy
  symbol_policy?: PaperSymbolPolicy
  created_at: string
  updated_at: string
}

export type PaperTarget = { symbol: string; weight_pct: number }
export type PaperOrder = {
  symbol: string
  side: 'buy' | 'sell'
  shares: number
  reference_price: number
  fill_price?: number
  reference_notional?: number
  fee?: number
  slippage_cost?: number
  cash_delta?: number
  notional: number
  current_shares: number
  target_shares: number
  target_weight_pct: number
  projected_weight_pct: number
}
export type PaperPreview = {
  engine_version: string
  as_of: string
  input_revision: string
  account_id: string
  account_version: number
  limits: PaperLimits
  execution_policy?: PaperExecutionPolicy
  symbol_policy?: PaperSymbolPolicy
  symbol_policy_method?: string
  skipped_orders?: {
    symbol: string
    reason: string
    requested_shares: number
    reference_notional: number
  }[]
  fees_total?: number | null
  slippage_total?: number | null
  cost_total?: number | null
  equity_after?: number | null
  projected_holdings?: {
    symbol: string
    shares: number
    weight_pct: number
    market_value: number
  }[]
  targets: PaperTarget[]
  coverage: { required: number; priced: number; missing: unknown[] }
  valuation_complete: boolean
  equity_before: number | null
  cash_before: number
  cash_after: number | null
  cash_weight_after_pct: number | null
  turnover_pct: number | null
  risk_direction?: 'reducing' | 'increasing' | 'mixed' | 'unchanged' | null
  orders: PaperOrder[]
  violations: { code: string; message: string; symbol?: string }[]
  executable: boolean
  method: string
  warnings: string[]
}
export type PaperProvenance = {
  engine_version: string
  source:
    | 'manual'
    | 'automation'
    | 'rules_workflow'
    | 'position_stops'
    | 'strategy_bridge'
    | 'jev'
    | 'local_agent'
  tags: string[]
}
export type PaperProposal = PaperPreview & {
  id: string
  provenance?: PaperProvenance
  status: 'proposed' | 'blocked' | 'simulated' | 'rejected' | 'submitted_external'
  created_at: string
  accepted_at: string | null
}
export type PaperSnapshot = {
  engine_version: string
  as_of: string
  input_revision: string
  account: PaperAccount
  holdings: {
    symbol: string
    shares: number
    cost_basis: number
    average_cost: number
    price: number | null
    price_date: string | null
    quote_status: string
    reason: string | null
    market_value: number | null
    weight_pct: number | null
    unrealized_pnl: number | null
  }[]
  coverage: { required: number; priced: number; missing: unknown[] }
  valuation_complete: boolean
  equity: number | null
  holdings_value: number | null
  cash_weight_pct: number | null
  unrealized_pnl: number | null
  realized_pnl: number
  total_return_pct: number | null
  ledger: {
    id: string | number
    kind: string
    symbol: string | null
    shares_delta: number | null
    price: number | null
    cash_delta: number
    cash_after: number
    realized_pnl: number | null
    proposal_id: string | null
    created_at: string
  }[]
  proposals: PaperProposal[]
  ledger_count?: number
  ledger_truncated?: boolean
  proposal_count?: number
  proposals_truncated?: boolean
  method: string
  warnings: string[]
}

export function parsePaperTargets(
  value: string,
): { targets: PaperTarget[]; error: null } | { targets: null; error: string } {
  const lines = value
    .trim()
    .split(/\n/)
    .filter((line) => line.trim())
  if (!lines.length) return { targets: null, error: 'empty' }
  if (lines.length > 50) return { targets: null, error: 'limit' }
  const symbols = new Set<string>()
  const targets: PaperTarget[] = []
  for (const line of lines) {
    const parts = line.trim().split(/[\s,，]+/)
    const symbol = parts[0].toUpperCase()
    const weight = Number(parts[1])
    if (
      parts.length !== 2 ||
      !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 100
    )
      return { targets: null, error: 'format' }
    if (symbols.has(symbol)) return { targets: null, error: 'duplicate' }
    symbols.add(symbol)
    targets.push({ symbol, weight_pct: weight })
  }
  if (targets.reduce((total, row) => total + row.weight_pct, 0) > 100)
    return { targets: null, error: 'sum' }
  return { targets, error: null }
}

export function newPaperKey() {
  return crypto.randomUUID()
}
