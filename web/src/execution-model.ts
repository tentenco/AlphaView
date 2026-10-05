export type ExecutionTargetId = 'paper_ledger' | 'alpaca_paper'
export type OrderStyle = { type: 'market' | 'limit'; limit_band_bps: number; time_in_force: string }
export type ExecutionTarget = {
  id: ExecutionTargetId
  label: string
  english: string
  available: boolean
  external: boolean
  reason: string | null
  caps?: { max_order_notional_usd: number; max_orders_per_submission: number } | null
  order_style?: OrderStyle | null
  connection_version?: string | null
}
export type ExecutionTargets = {
  engine_version: string
  targets: ExecutionTarget[]
  live_trading: { available: false; reason: string }
  method: string
  warnings: string[]
}
export type AlpacaConnection = {
  engine_version: string
  orders_version: string
  configured: boolean
  version: string | null
  connected_at: string | null
  orders_enabled: boolean
  order_caps: { max_order_notional_usd: number; max_orders_per_submission: number } | null
  order_style?: OrderStyle | null
  enable_confirmation: string
  capabilities: string[]
  endpoint: string
}
export type ExecutionOrderStatus =
  | 'pending'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'cancel_requested'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'unknown'
  | 'skipped'
export type ExecutionOrder = {
  id: string
  submission_id: string
  sequence: number
  symbol: string
  side: 'buy' | 'sell'
  qty: string
  order_type: string
  time_in_force: string
  limit_price?: string | null
  reference_price: string
  reference_notional: string
  client_order_id: string
  broker_order_id: string | null
  status: ExecutionOrderStatus
  filled_qty: string | null
  filled_avg_price: string | null
  submitted_at: string | null
  last_synced_at: string | null
  terminal: boolean
  broker: Record<string, string | null> | null
  error: { code: string; message?: string | null; [key: string]: unknown } | null
}
export type ExecutionSubmissionStatus =
  | 'simulated'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'mixed'
  | 'unknown'
export type ExecutionSubmission = {
  id: string
  engine_version: string
  account_id: string
  proposal_id: string
  target: ExecutionTargetId
  status: ExecutionSubmissionStatus
  as_of: string
  input_revision: string
  account_version: number
  connection_version: string | null
  created_at: string
  updated_at: string
  summary: Record<string, unknown>
  order_counts: Partial<Record<ExecutionOrderStatus, number>>
  order_count: number
  partial_fills?: number
  reconcile_required: boolean
  terminal: boolean
  orders?: ExecutionOrder[]
  method?: string
  warnings?: string[]
}
export type ExecutionHistory = {
  engine_version: string
  account_id: string
  as_of: string
  input_revision: string
  submissions: ExecutionSubmission[]
  targets: ExecutionTarget[]
  method: string
  warnings: string[]
}
export const submissionActive = (status: ExecutionSubmissionStatus) =>
  status === 'submitted' || status === 'partially_filled' || status === 'unknown'
export const orderCancelable = (status: ExecutionOrderStatus) =>
  status === 'accepted' || status === 'partially_filled'
export const decimalText = (value: string | null | undefined) =>
  value == null
    ? '—'
    : value.replace(
        /^(-?\d+)(\.\d+)?$/,
        (_, whole: string, fraction = '') => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction,
      )
export type ExecutionSweepResult = {
  order_id: string
  submission_id: string
  symbol: string
  side: string
  previous_status: string
  action: string | null
  error: { code: string; message?: string | null; [key: string]: unknown } | null
}
export type ExecutionSweep = {
  engine_version: string
  account_id: string
  at: string
  reason: string
  nothing_to_do: boolean
  orders_considered: number
  already_terminal?: number
  counts: Record<string, number>
  results: ExecutionSweepResult[]
  error?: { code: string; message?: string | null }
}
