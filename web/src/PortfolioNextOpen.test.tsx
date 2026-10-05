import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortfolioNextOpen } from './PortfolioNextOpen'
import {
  nextOpenDraftKey,
  parseNextOpenCap,
  type NextOpenCollection,
  type NextOpenOrder,
  type NextOpenPreview,
  type NextOpenSource,
} from './paper-next-open'
import type { PaperOrder, PaperProposal, PaperSnapshot } from './paper-model'

const snapshot: PaperSnapshot = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-18',
  input_revision: 'synthetic:1',
  account: {
    id: 'synthetic-next-open-account',
    name: 'Synthetic next open',
    currency: 'USD',
    initial_cash: 10000,
    cash: 10000,
    version: 1,
    kill_switch: false,
    limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
    execution_policy: { fee_bps: 10, slippage_bps: 0, min_trade_notional: 0, share_precision: 8 },
    created_at: '2026-09-18T22:00:00Z',
    updated_at: '2026-09-18T22:00:00Z',
  },
  holdings: [],
  coverage: { required: 0, priced: 0, missing: [] },
  valuation_complete: true,
  equity: 10000,
  holdings_value: 0,
  cash_weight_pct: 100,
  unrealized_pnl: 0,
  realized_pnl: 0,
  total_return_pct: 0,
  ledger: [],
  proposals: [],
  method: 'Synthetic paper.',
  warnings: [],
}
const frozen: PaperOrder = {
  symbol: 'SYNTA',
  side: 'buy',
  shares: 10,
  reference_price: 100,
  fill_price: 100,
  fee: 1,
  notional: 1000,
  current_shares: 0,
  target_shares: 10,
  target_weight_pct: 10,
  projected_weight_pct: 10,
}
const source: NextOpenSource = {
  id: 'synthetic-source-proposal',
  created_at: '2026-09-18T22:10:00Z',
  proposal_fingerprint: 'a'.repeat(64),
  eligible: true,
  reason: null,
  order_count: 1,
  estimated_cost: 1,
  estimated_buy_cash_debit: 1001,
  orders: [frozen],
}
const window = {
  signal_session: '2026-09-18',
  execution_session: '2026-09-21',
  enqueue_before: '2026-09-21T13:30:00Z',
  eligible_after: '2026-09-21T20:15:00Z',
  can_enqueue: true,
  reason: null,
}
function order(extra: Partial<NextOpenOrder> = {}): NextOpenOrder {
  return {
    id: 'synthetic-queue-order',
    account_id: snapshot.account.id,
    source_proposal_id: source.id,
    engine_version: 'alphaview-paper-next-open-v1',
    as_of: snapshot.as_of,
    input_revision: snapshot.input_revision,
    method: 'Synthetic next-open method.',
    warnings: [],
    status: 'waiting_session',
    version: 1,
    ...window,
    created_at: '2026-09-20T01:00:00Z',
    updated_at: '2026-09-20T01:00:00Z',
    completed_at: null,
    reason_code: 'waiting_session',
    reason: '等待指定日完成',
    execution_proposal_id: null,
    source_account_version: 1,
    source_input_revision: snapshot.input_revision,
    source_proposal_fingerprint: source.proposal_fingerprint,
    max_execution_cost_usd: 20,
    max_buy_cash_debit_usd: 1500,
    frozen_orders: [frozen],
    source_estimated_cost: 1,
    source_estimated_buy_cash_debit: 1001,
    source_prefix: {
      method: 'synthetic-prefix',
      digest: 'b'.repeat(64),
      rows: 400,
      symbols: 4,
      max_rows: 500000,
    },
    limits: snapshot.account.limits,
    execution_policy: snapshot.account.execution_policy!,
    last_evaluation: null,
    recorded_at: null,
    effective_session: null,
    late_recording: false,
    execution_reference_revised: null,
    can_cancel: true,
    can_process: false,
    attempts: [],
    ...extra,
  }
}
function evaluation(extra: Partial<NextOpenPreview> = {}): NextOpenPreview {
  return {
    engine_version: 'alphaview-paper-next-open-v1',
    as_of: window.execution_session,
    input_revision: 'synthetic:2',
    account_id: snapshot.account.id,
    account_version: 1,
    limits: snapshot.account.limits,
    execution_policy: snapshot.account.execution_policy,
    targets: [{ symbol: 'SYNTA', weight_pct: 10 }],
    coverage: { required: 1, priced: 1, missing: [] },
    valuation_complete: true,
    equity_before: 10000,
    cash_before: 10000,
    cash_after: 8898.9,
    equity_after: 9998.9,
    cash_weight_after_pct: 89,
    turnover_pct: 11,
    fees_total: 1.1,
    slippage_total: 0,
    cost_total: 1.1,
    orders: [
      {
        ...frozen,
        reference_price: 110,
        fill_price: 110,
        fee: 1.1,
        notional: 1100,
        cash_delta: -1101.1,
      },
    ],
    skipped_orders: [],
    violations: [],
    executable: true,
    method: 'Synthetic open method.',
    warnings: [],
    signal_session: window.signal_session,
    execution_session: window.execution_session,
    gross_buy_cash_debit: 1101.1,
    max_execution_cost_usd: 20,
    max_buy_cash_debit_usd: 1500,
    open_price_fingerprint: 'c'.repeat(64),
    quote_details: [
      {
        symbol: 'SYNTA',
        price: 110,
        price_date: window.execution_session,
        quote_status: 'ok',
        reason: null,
      },
    ],
    ...extra,
  }
}
function filledOrder(): NextOpenOrder {
  return order({
    status: 'filled',
    version: 3,
    reason_code: 'filled',
    reason: '模擬完成',
    execution_proposal_id: 'synthetic-execution-receipt',
    last_evaluation: evaluation(),
    can_cancel: false,
    can_process: false,
    completed_at: '2026-09-22T22:00:00Z',
    recorded_at: '2026-09-22T22:00:00Z',
    effective_session: window.execution_session,
    late_recording: true,
    execution_reference_revised: true,
    attempts: [
      {
        id: 1,
        trigger_kind: 'manual',
        status: 'filled',
        reason_code: 'filled',
        reason: '完成',
        input_revision: 'synthetic:2',
        created_at: '2026-09-22T22:00:00Z',
      },
    ],
  })
}
const receipt: PaperProposal = {
  ...evaluation(),
  id: 'synthetic-execution-receipt',
  status: 'simulated',
  created_at: '2026-09-22T22:00:00Z',
  accepted_at: '2026-09-22T22:00:00Z',
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const base = `/api/paper/accounts/${snapshot.account.id}/next-open-orders`
function mockApi(
  options: {
    initial?: NextOpenOrder
    collection?: Partial<NextOpenCollection>
    mutate?: (action: string) => NextOpenOrder
    handler?: (url: string, init?: RequestInit) => unknown
  } = {},
) {
  let current = options.initial
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = options.handler?.(url, init)
    if (custom !== undefined) return custom
    if (url.startsWith(`${base}?`))
      return response({
        engine_version: 'alphaview-paper-next-open-v1',
        as_of: snapshot.as_of,
        input_revision: snapshot.input_revision,
        method: 'Synthetic queue.',
        enqueue_window: { ...window, can_enqueue: !current || !current.can_cancel },
        source_proposals: [source],
        items: current ? [current] : [],
        total: current ? 1 : 0,
        limit: 20,
        offset: 0,
        ...options.collection,
      })
    if (url === base && init?.method === 'POST') {
      current = order()
      return response(current)
    }
    if (url === `${base}/synthetic-queue-order`) return response(current || order())
    if (url.endsWith('/process') || url.endsWith('/cancel')) {
      current = options.mutate
        ? options.mutate(url.endsWith('/process') ? 'process' : 'cancel')
        : order({
            status: 'cancelled',
            reason_code: 'cancelled',
            reason: '取消',
            version: 2,
            can_cancel: false,
            can_process: false,
          })
      return response(current)
    }
    if (url.endsWith('/proposals/synthetic-execution-receipt')) return response(receipt)
    throw new Error(`Unexpected API: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function selectSource() {
  await screen.findByRole('option', { name: new RegExp(source.id.slice(0, 14)) })
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved source proposal' }), {
    target: { value: source.id },
  })
}
async function enterAuthorization(cost = '20', cash = '1500') {
  await selectSource()
  fireEvent.change(screen.getByRole('textbox', { name: 'Authorized execution cost cap (USD)' }), {
    target: { value: cost },
  })
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Authorized gross buy cash debit cap (USD)' }),
    { target: { value: cash } },
  )
  await userEvent.click(screen.getByRole('checkbox'))
}
async function openOrder() {
  await userEvent.click(await screen.findByRole('button', { name: /synthetic-queu/ }))
  await screen.findByRole('region', { name: 'Paper order details' })
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T00:00:00Z'))
})
afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('next-open paper queue', () => {
  it('opens an exact inbox order outside the listed page and cancels through its existing versioned action', async () => {
    const fetcher = mockApi({ collection: { items: [], total: 24 } })
    render(
      <PortfolioNextOpen
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
        selectedOrderId="synthetic-queue-order"
        selectionNonce={1}
      />,
    )
    await screen.findByRole('region', { name: 'Paper order details' })
    expect(fetcher.mock.calls.some(([url]) => url === `${base}/synthetic-queue-order`)).toBe(true)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this paper order' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Cancel this paper order' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    )
    expect(
      within(screen.getByRole('region', { name: 'Paper order details' })).getByText('Cancelled'),
    ).toBeTruthy()
    const sent = fetcher.mock.calls.find(([url]) => url.endsWith('/cancel'))
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      expected_order_version: 1,
      idempotency_key: expect.any(String),
    })
  })

  it('refetches an off-page selection and blocks old actions while a terminal result is loading', async () => {
    let reads = 0
    let complete: ((value: unknown) => void) | undefined
    mockApi({
      collection: { items: [], total: 24 },
      handler: (url) => {
        if (url === `${base}/synthetic-queue-order`) {
          reads += 1
          if (reads > 1)
            return new Promise((resolve) => {
              complete = resolve
            })
          return response(order())
        }
      },
    })
    const view = render(
      <PortfolioNextOpen
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
        selectedOrderId="synthetic-queue-order"
      />,
    )
    await screen.findByRole('region', { name: 'Paper order details' })
    view.rerender(
      <PortfolioNextOpen
        snapshot={{ ...snapshot, input_revision: 'synthetic:2' }}
        locale="en"
        onAccountChanged={vi.fn()}
        selectedOrderId="synthetic-queue-order"
      />,
    )
    await waitFor(() => expect(complete).toBeTruthy())
    expect(
      (screen.getByRole('button', { name: 'Cancel this paper order' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    complete!(response(filledOrder()))
    await screen.findByText('Paper fills recorded', { selector: 'strong' })
    expect(
      (screen.getByRole('button', { name: 'Cancel this paper order' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Check and process authorized order',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })

  it('clears stale detail actions after an exact order disappears or has a mismatched identity', async () => {
    let unavailable = false
    mockApi({
      collection: { items: [], total: 0 },
      handler: (url) => {
        if (unavailable && url === `${base}/synthetic-queue-order`)
          return response({ detail: 'Synthetic order is unavailable' }, 404)
      },
    })
    const view = render(
      <PortfolioNextOpen
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
        selectedOrderId="synthetic-queue-order"
        selectionNonce={1}
      />,
    )
    await screen.findByRole('region', { name: 'Paper order details' })
    unavailable = true
    view.rerender(
      <PortfolioNextOpen
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
        selectedOrderId="synthetic-queue-order"
        selectionNonce={2}
      />,
    )
    await screen.findByText('Synthetic order is unavailable')
    expect(screen.queryByRole('button', { name: 'Cancel this paper order' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check and process authorized order' })).toBeNull()
  })

  it('requires user-entered caps and explicit consent before queueing immutable shares', async () => {
    const fetcher = mockApi()
    const changed = vi.fn()
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={changed} />)
    await selectSource()
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Authorized execution cost cap (USD)',
        }) as HTMLInputElement
      ).value,
    ).toBe('')
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Authorized gross buy cash debit cap (USD)',
        }) as HTMLInputElement
      ).value,
    ).toBe('')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Authorize and queue simulation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await enterAuthorization()
    await userEvent.click(screen.getByRole('button', { name: 'Authorize and queue simulation' }))
    await screen.findByRole('region', { name: 'Paper order details' })
    const posted = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(posted?.[0]).toBe(base)
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
      proposal_id: source.id,
      expected_account_version: 1,
      expected_proposal_fingerprint: source.proposal_fingerprint,
      max_execution_cost_usd: 20,
      max_buy_cash_debit_usd: 1500,
      confirm_next_open_simulation: true,
      idempotency_key: expect.any(String),
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No processing attempt yet. Queued does not mean filled.')).toBeTruthy()
    expect(
      fetcher.mock.calls.some(([url]) => url.endsWith('/accept') || url.endsWith('/process')),
    ).toBe(false)
  })

  it('clears consent when authorization changes and never persists consent across a remount', async () => {
    mockApi()
    const view = render(
      <PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />,
    )
    await enterAuthorization()
    fireEvent.change(screen.getByRole('textbox', { name: 'Authorized execution cost cap (USD)' }), {
      target: { value: '35' },
    })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    await userEvent.click(screen.getByRole('checkbox'))
    view.rerender(
      <PortfolioNextOpen
        snapshot={{ ...snapshot, account: { ...snapshot.account, version: 2 } }}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByRole('checkbox')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    view.unmount()
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />)
    await screen.findByRole('checkbox')
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Authorized execution cost cap (USD)',
        }) as HTMLInputElement
      ).value,
    ).toBe('35')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(
      JSON.parse(sessionStorage.getItem(nextOpenDraftKey(snapshot.account.id)) || '{}'),
    ).not.toHaveProperty('consent')
  })

  it('does not enqueue after the server-defined open cutoff even from an already rendered form', async () => {
    const fetcher = mockApi()
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />)
    await enterAuthorization()
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-09-21T13:31:00Z'))
    fireEvent.submit(
      screen.getByRole('button', { name: 'Authorize and queue simulation' }).closest('form')!,
    )
    await screen.findByText(/authorization window is closed/)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('requires an explicit blocked retry and reads a separate executed receipt with actual recording time', async () => {
    const blocked = order({
      status: 'blocked',
      version: 2,
      can_process: true,
      reason_code: 'policy_blocked',
      reason: '超過上限',
      last_evaluation: evaluation({
        executable: false,
        violations: [{ code: 'buy_cash_debit_cap', message: '超過授權買入扣款' }],
      }),
    })
    const fetcher = mockApi({ initial: blocked, mutate: () => filledOrder() })
    const changed = vi.fn(),
      onProposal = vi.fn()
    render(
      <PortfolioNextOpen
        snapshot={snapshot}
        locale="en"
        onAccountChanged={changed}
        onProposal={onProposal}
      />,
    )
    await openOrder()
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(screen.getByText(/Gross buy notionals and buy fees exceed/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Retry with the same authorization' }))
    await screen.findByRole('button', { name: 'Read execution receipt' })
    const action = fetcher.mock.calls.find(([url]) => url.endsWith('/process'))
    expect(JSON.parse(String(action?.[1]?.body))).toEqual({
      expected_order_version: 2,
      idempotency_key: expect.any(String),
    })
    expect(
      within(screen.getByRole('region', { name: 'Paper order details' })).getByText(
        '2026-09-22 22:00:00 UTC',
        { selector: 'strong' },
      ),
    ).toBeTruthy()
    expect(screen.getByText(/data was revised after recording/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Read execution receipt' }))
    await waitFor(() => expect(onProposal).toHaveBeenCalledWith(receipt))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/accept'))).toBe(false)
  })

  it('keeps missing opens and valuations unavailable without substituting close prices', async () => {
    const missing = evaluation({
      executable: false,
      valuation_complete: false,
      equity_before: null,
      cash_after: null,
      equity_after: null,
      cash_weight_after_pct: null,
      turnover_pct: null,
      fees_total: null,
      slippage_total: null,
      cost_total: null,
      gross_buy_cash_debit: null,
      orders: [],
      coverage: { required: 1, priced: 0, missing: ['SYNTA'] },
      quote_details: [
        {
          symbol: 'SYNTA',
          price: null,
          price_date: null,
          quote_status: 'unavailable',
          reason: '指定日無資料',
        },
      ],
      violations: [{ code: 'quote_unavailable', message: '缺指定日開盤價', symbol: 'SYNTA' }],
    })
    mockApi({
      initial: order({
        status: 'waiting_prices',
        can_process: true,
        reason_code: 'quote_unavailable',
        reason: '缺價',
        last_evaluation: missing,
      }),
    })
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />)
    await openOrder()
    const quotes = screen
      .getByRole('region', { name: 'Paper order details' })
      .querySelector('[aria-label="Specified-day open quotes"]') as HTMLElement
    expect(within(quotes).getAllByText('—')).toHaveLength(2)
    expect(within(quotes).queryByText('$100.00')).toBeNull()
    expect(screen.getByText('A valid open for the specified date is unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Read execution receipt' })).toBeNull()
  })

  it('reuses the same cancellation identity after a lost response and never sends replacement caps', async () => {
    let calls = 0
    const fetcher = mockApi({
      initial: order(),
      handler: (url) => {
        if (url.endsWith('/cancel') && ++calls === 1)
          return Promise.reject(new Error('Synthetic connection lost'))
      },
    })
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />)
    await openOrder()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this paper order' }))
    await screen.findByText('Synthetic connection lost')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this paper order' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Cancel this paper order' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    )
    const bodies = fetcher.mock.calls
      .filter(([url]) => url.endsWith('/cancel'))
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toEqual({ expected_order_version: 1, idempotency_key: expect.any(String) })
  })

  it('does not authorize stale source proposals or mismatched market snapshots', async () => {
    const fetcher = mockApi({
      collection: {
        source_proposals: [{ ...source, eligible: false, reason: '來源過期' }],
        input_revision: 'synthetic:2',
      },
    })
    render(<PortfolioNextOpen snapshot={snapshot} locale="en" onAccountChanged={vi.fn()} />)
    await enterAuthorization()
    expect(screen.getByText(/account view and queue inputs differ/)).toBeTruthy()
    expect(screen.getByText(/source proposal failed current account/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Authorize and queue simulation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('distinguishes explicit zero caps from blank, negative or non-finite authorizations', () => {
    expect(parseNextOpenCap('')).toBeNull()
    expect(parseNextOpenCap('  ')).toBeNull()
    expect(parseNextOpenCap('-1')).toBeNull()
    expect(parseNextOpenCap('Infinity')).toBeNull()
    expect(parseNextOpenCap('0')).toBe(0)
    expect(parseNextOpenCap('12.50')).toBe(12.5)
  })
})
