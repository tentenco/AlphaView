import { describe, expect, it } from 'vitest'
import type { ExecutionOrder, ExecutionSubmission } from './execution-model'
import { executionReview, skippedContext } from './execution-review'

const order = (id: string, status: ExecutionOrder['status'] = 'accepted'): ExecutionOrder => ({
  id,
  submission_id: 'synthetic-submission',
  sequence: 1,
  symbol: id,
  side: 'buy',
  qty: '1',
  order_type: 'market',
  time_in_force: 'day',
  reference_price: '100',
  reference_notional: '100',
  client_order_id: `synthetic-${id}`,
  broker_order_id: `broker-${id}`,
  status,
  filled_qty: '0',
  filled_avg_price: null,
  submitted_at: null,
  last_synced_at: null,
  terminal: false,
  broker: null,
  error: null,
})
const entry = (item: ExecutionOrder, action = 'cancel_requested', error: unknown = null) => ({
  order_id: item.id,
  submission_id: item.submission_id,
  symbol: item.symbol,
  side: item.side,
  previous_status: 'accepted',
  action,
  error,
})
const submission = (orders: ExecutionOrder[], receipt?: unknown): ExecutionSubmission => ({
  id: 'synthetic-submission',
  engine_version: 'synthetic-v1',
  account_id: 'synthetic-account',
  proposal_id: 'synthetic-proposal',
  target: 'alpaca_paper',
  status: 'submitted',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account_version: 1,
  connection_version: null,
  created_at: '',
  updated_at: '',
  summary: receipt === undefined ? {} : { kill_switch_sweep: receipt },
  order_counts: {},
  order_count: orders.length,
  reconcile_required: true,
  terminal: false,
  orders,
})
const receipt = (results: unknown[]) => ({
  at: '2026-09-30T00:00:00+00:00',
  reason: 'kill_switch_enabled',
  results,
})

describe('saved execution review evidence', () => {
  it('preserves current states and input while grouping exact persisted reasons across every order', () => {
    const filled = order('SYNFILLED', 'filled')
    const unknown = {
      ...order('SYNUNKNOWN', 'unknown'),
      error: { code: 'network_unavailable', phase: 'sweep' },
    }
    const unchanged = order('SYNDISABLED', 'accepted')
    const saved = submission(
      [filled, unknown, unchanged],
      receipt([
        entry(filled),
        entry(unknown, 'unknown', { code: 'network_unavailable', message: 'Synthetic timeout' }),
        entry(unchanged, 'unknown', { code: 'orders_disabled', message: 'Synthetic disabled' }),
      ]),
    )
    const original = JSON.stringify(saved)
    const result = executionReview(saved)
    expect(result.receiptAvailable).toBe(true)
    expect(result.rows.map((row) => row.order.status)).toEqual(['filled', 'unknown', 'accepted'])
    expect(result.rows.map((row) => row.sweep?.action)).toEqual([
      'cancel_requested',
      'unknown',
      'unknown',
    ])
    expect(Object.fromEntries(result.filters)).toEqual({
      'order:network_unavailable': 1,
      'sweep:cancel_requested': 1,
      'sweep:network_unavailable': 1,
      'sweep:orders_disabled': 1,
    })
    expect(JSON.stringify(saved)).toBe(original)
  })

  it.each([
    'reconcile_required',
    'orders_disabled',
    'not_configured',
    'cancel_rejected',
    'network_unavailable',
  ])('keeps exact %s evidence without classifying the order as cancelled', (code) => {
    const item = order('SYNREMAIN')
    const result = executionReview(
      submission(
        [item],
        receipt([
          entry(item, code === 'cancel_rejected' ? 'cancel_rejected' : 'unknown', {
            code,
            message: `Synthetic ${code}`,
            http_status: code === 'cancel_rejected' ? 422 : undefined,
          }),
        ]),
      ),
    )
    expect(result.rows[0].order.status).toBe('accepted')
    expect(result.rows[0].sweep?.error?.code).toBe(code)
    expect(result.rows[0].reasons).toContain(`sweep:${code}`)
    expect(result.rows[0].sweep?.error?.httpStatus).toBe(code === 'cancel_rejected' ? 422 : null)
  })

  it.each([undefined, null, {}, { results: null }])(
    'marks old or absent receipts unavailable: %j',
    (saved) => {
      const result = executionReview(submission([order('SYNOLD', 'skipped')], saved))
      expect(result.receiptAvailable).toBe(false)
      expect(result.at).toBeNull()
      expect(result.rows[0].unavailable).toBe('receipt_missing')
      expect(result.rows[0].reasons).toEqual(['unavailable'])
      expect(skippedContext(result.rows[0])).toBeNull()
    },
  )

  it('rejects ambiguous, mismatched, unassociated and missing per-order evidence without hiding current orders', () => {
    const items = ['SYNDUP', 'SYNWRONG', 'SYNABSENT'].map((id) => order(id))
    const saved = receipt([
      entry(items[0]),
      entry(items[0]),
      { ...entry(items[1]), submission_id: 'another' },
      { order_id: 'foreign' },
      null,
    ])
    const result = executionReview(submission(items, saved))
    expect(result.rows).toHaveLength(3)
    expect(result.rows.map((row) => row.unavailable)).toEqual([
      'ambiguous_entry',
      'invalid_entry',
      'entry_missing',
    ])
    expect(result.rows.every((row) => row.sweep === null)).toBe(true)
    expect(result.unassociatedResults).toBe(2)
    expect(Object.fromEntries(result.filters)).toEqual({ unavailable: 3 })
  })

  it('retains known partial fields but marks incomplete metadata and malformed error evidence unavailable', () => {
    const item = order('SYNPARTIAL')
    const result = executionReview(
      submission([item], {
        ...receipt([entry(item, 'unknown', 'unstructured prose')]),
        at: 'invalid date',
        reason: '',
      }),
    )
    expect(result.receiptAvailable).toBe(false)
    expect(result.at).toBeNull()
    expect(result.reason).toBeNull()
    expect(result.rows[0].sweep?.action).toBe('unknown')
    expect(result.rows[0].sweep?.error).toBeNull()
    expect(result.rows[0].unavailable).toBe('invalid_entry')
  })

  it('distinguishes all recorded unsent reasons and never invents previous-unknown from skipped status', () => {
    for (const code of ['swept', 'not_sent', 'limit_price_missing']) {
      const item = { ...order('SYNSKIP', 'skipped'), error: { code } }
      expect(skippedContext(executionReview(submission([item])).rows[0])).toBe(code)
    }
    const skipped = order('SYNSKIP', 'skipped')
    const saved = receipt([{ ...entry(skipped, 'skipped'), previous_status: 'pending' }])
    expect(skippedContext(executionReview(submission([skipped], saved)).rows[0])).toBe('swept')
    expect(skippedContext(executionReview(submission([skipped])).rows[0])).toBeNull()
    const filled = { ...skipped, status: 'filled' as const }
    expect(skippedContext(executionReview(submission([filled], saved)).rows[0])).toBeNull()
  })
})
