import type { ExecutionOrder, ExecutionSubmission } from './execution-model'

type SavedError = { code: string | null; message: string | null; httpStatus: number | null }
export type OrderReview = {
  order: ExecutionOrder
  currentError: SavedError | null
  sweep: {
    previousStatus: string | null
    action: string | null
    error: SavedError | null
  } | null
  unavailable: 'receipt_missing' | 'entry_missing' | 'invalid_entry' | 'ambiguous_entry' | null
  reasons: string[]
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)
function savedError(value: unknown): SavedError | null {
  const error = record(value)
  return error
    ? {
        code: text(error.code),
        message: text(error.message),
        httpStatus:
          typeof error.http_status === 'number' &&
          Number.isInteger(error.http_status) &&
          error.http_status >= 100 &&
          error.http_status <= 599
            ? error.http_status
            : null,
      }
    : null
}

/** Read saved evidence only. A sweep outcome never substitutes for the order's current status. */
export function executionReview(submission: ExecutionSubmission) {
  const receipt = record(submission.summary.kill_switch_sweep)
  const savedAt = text(receipt?.at)
  const at = savedAt && Number.isFinite(Date.parse(savedAt)) ? savedAt : null
  const reason = text(receipt?.reason)
  const results: unknown[] | null = Array.isArray(receipt?.results) ? receipt.results : null
  const orders = submission.orders ?? []
  const ids = new Set(orders.map((order) => order.id))
  const grouped = new Map<string, Record<string, unknown>[]>()
  let unassociatedResults = 0
  for (const value of results ?? []) {
    const entry = record(value)
    const id = text(entry?.order_id)
    if (!entry || !id || !ids.has(id)) {
      unassociatedResults++
      continue
    }
    grouped.set(id, [...(grouped.get(id) ?? []), entry])
  }
  const rows: OrderReview[] = orders.map((order) => {
    const entries = grouped.get(order.id) ?? []
    const entry = entries.length === 1 ? entries[0] : null
    const identified =
      entry?.submission_id === submission.id &&
      entry?.symbol === order.symbol &&
      entry?.side === order.side
    const sweep =
      entry && identified
        ? {
            previousStatus: text(entry.previous_status),
            action: text(entry.action),
            error: savedError(entry.error),
          }
        : null
    const currentError = savedError(order.error)
    const unavailable: OrderReview['unavailable'] =
      !receipt || !results
        ? 'receipt_missing'
        : entries.length > 1
          ? 'ambiguous_entry'
          : !entry
            ? 'entry_missing'
            : !at ||
                !reason ||
                !sweep?.previousStatus ||
                !sweep.action ||
                (entry.error !== null && (!sweep.error?.code || !record(entry.error)))
              ? 'invalid_entry'
              : null
    const reasons: string[] = []
    if (currentError?.code) reasons.push(`order:${currentError.code}`)
    if (sweep?.action) reasons.push(`sweep:${sweep.error?.code ?? sweep.action}`)
    if (unavailable) reasons.push('unavailable')
    return { order, currentError, sweep, unavailable, reasons }
  })
  const counts = new Map<string, number>()
  for (const row of rows) for (const key of row.reasons) counts.set(key, (counts.get(key) ?? 0) + 1)
  return {
    at,
    reason,
    receiptAvailable: !!receipt && !!results && !!at && !!reason,
    rows,
    unassociatedResults,
    filters: [...counts].sort(([a], [b]) => a.localeCompare(b)),
  }
}

export function skippedContext(row: OrderReview) {
  if (row.order.status !== 'skipped') return null
  const code = row.currentError?.code
  if (code === 'swept' || code === 'not_sent' || code === 'limit_price_missing') return code
  return !row.unavailable &&
    row.sweep?.action === 'skipped' &&
    row.sweep.previousStatus === 'pending'
    ? 'swept'
    : null
}
