export type NextOpenDraft = {
  proposalId: string
  costCap: string
  buyCashCap: string
}
export const nextOpenDraftKey = (accountId: string) =>
  `alphaview:paper-next-open-draft:v1:${accountId}`
export const defaultNextOpenDraft = (): NextOpenDraft => ({
  proposalId: '',
  costCap: '',
  buyCashCap: '',
})
export function validNextOpenDraft(value: unknown): value is NextOpenDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as NextOpenDraft
  return (
    typeof draft.proposalId === 'string' &&
    draft.proposalId.length <= 100 &&
    typeof draft.costCap === 'string' &&
    draft.costCap.length <= 50 &&
    typeof draft.buyCashCap === 'string' &&
    draft.buyCashCap.length <= 50
  )
}

/** A blank authorization is never converted into zero or an estimated amount. */
export function parseNextOpenCap(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}
import type { PaperExecutionPolicy, PaperLimits, PaperOrder, PaperPreview } from './paper-model'

export type NextOpenStatus =
  'waiting_session' | 'waiting_prices' | 'blocked' | 'filled' | 'cancelled' | 'invalidated'
export type NextOpenSource = {
  id: string
  created_at: string
  proposal_fingerprint: string
  eligible: boolean
  reason: string | null
  order_count: number
  estimated_cost: number | null
  estimated_buy_cash_debit: number
  orders: PaperOrder[]
}
export type NextOpenWindow = {
  signal_session: string
  execution_session: string
  enqueue_before: string
  eligible_after: string
  can_enqueue: boolean
  reason: string | null
}
export type NextOpenPreview = PaperPreview & {
  signal_session: string
  execution_session: string
  gross_buy_cash_debit: number | null
  max_execution_cost_usd: number
  max_buy_cash_debit_usd: number
  open_price_fingerprint: string | null
  quote_details: {
    symbol: string
    price: number | null
    price_date: string | null
    quote_status: 'ok' | 'unavailable'
    reason: string | null
  }[]
}
export type NextOpenOrder = {
  id: string
  account_id: string
  source_proposal_id: string
  engine_version: string
  as_of: string
  input_revision: string
  method: string
  warnings: string[]
  status: NextOpenStatus
  version: number
  signal_session: string
  execution_session: string
  enqueue_before: string
  eligible_after: string
  created_at: string
  updated_at: string
  completed_at: string | null
  reason_code: string
  reason: string
  execution_proposal_id: string | null
  source_account_version: number
  source_input_revision: string
  source_proposal_fingerprint: string
  max_execution_cost_usd: number
  max_buy_cash_debit_usd: number
  frozen_orders: PaperOrder[]
  source_estimated_cost: number
  source_estimated_buy_cash_debit: number
  source_prefix: { method: string; digest: string; rows: number; symbols: number; max_rows: number }
  limits: PaperLimits
  execution_policy: PaperExecutionPolicy
  last_evaluation: NextOpenPreview | null
  recorded_at: string | null
  effective_session: string | null
  late_recording: boolean
  execution_reference_revised?: boolean | null
  can_cancel: boolean
  can_process: boolean
  attempts: {
    id: number
    trigger_kind: 'manual' | 'scheduler'
    status: string
    reason_code: string
    reason: string
    input_revision: string
    created_at: string
  }[]
}
export type NextOpenCollection = {
  engine_version: string
  as_of: string
  input_revision: string
  method: string
  enqueue_window: NextOpenWindow
  source_proposals: NextOpenSource[]
  items: NextOpenOrder[]
  total: number
  limit: number
  offset: number
}
export type NextOpenEnqueue = {
  proposal_id: string
  expected_account_version: number
  expected_proposal_fingerprint: string
  max_execution_cost_usd: number
  max_buy_cash_debit_usd: number
  confirm_next_open_simulation: true
  idempotency_key: string
}
export type NextOpenAction = { expected_order_version: number; idempotency_key: string }
export const nextOpenActive = (status: NextOpenStatus) =>
  ['waiting_session', 'waiting_prices', 'blocked'].includes(status)
