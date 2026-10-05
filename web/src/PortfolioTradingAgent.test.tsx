import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioTradingAgent } from './PortfolioTradingAgent'
import type { PaperAccount, PaperProposal, PaperSnapshot } from './paper-model'
import type { AlpacaConnection, ExecutionSubmission, ExecutionTargets } from './execution-model'

vi.mock('./AgentDailyReport', () => ({
  AgentDailyReport: () => <section aria-label="Daily report stub" />,
}))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

const account: PaperAccount = {
  id: 'synthetic-exec-account',
  name: 'Synthetic execution account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 7000,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const proposal: PaperProposal = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account_id: account.id,
  account_version: 3,
  limits: account.limits,
  targets: [{ symbol: 'SYNTA', weight_pct: 30 }],
  coverage: { required: 1, priced: 1, missing: [] },
  valuation_complete: true,
  equity_before: 10000,
  equity_after: 10000,
  cash_before: 10000,
  cash_after: 7000,
  cash_weight_after_pct: 70,
  turnover_pct: 30,
  fees_total: 3,
  slippage_total: 0,
  cost_total: 3,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 30,
      reference_price: 100,
      fill_price: 100,
      fee: 3,
      notional: 3000,
      current_shares: 0,
      target_shares: 30,
      target_weight_pct: 30,
      projected_weight_pct: 30,
    },
  ],
  violations: [],
  executable: true,
  method: 'Synthetic preview.',
  warnings: [],
  id: 'synthetic-proposal-0001',
  status: 'proposed',
  created_at: '2026-09-30T00:00:00Z',
  accepted_at: null,
}
const snapshot = {
  account,
  proposals: [proposal, { ...proposal, id: 'synthetic-proposal-0002', status: 'simulated' }],
  ledger: [],
} as unknown as PaperSnapshot
const targets = (alpacaReady: boolean): ExecutionTargets => ({
  engine_version: 'alphaview-execution-v1',
  targets: [
    {
      id: 'paper_ledger',
      label: '本機模擬帳本',
      english: 'Local paper ledger',
      available: true,
      external: false,
      reason: null,
    },
    {
      id: 'alpaca_paper',
      label: 'Alpaca Paper 委託',
      english: 'Alpaca Paper orders',
      available: alpacaReady,
      external: true,
      reason: alpacaReady ? null : 'orders_disabled',
      caps: { max_order_notional_usd: 5000, max_orders_per_submission: 20 },
      connection_version: 'v1',
    },
  ],
  live_trading: { available: false, reason: 'No live broker target.' },
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const connection = (enabled: boolean): AlpacaConnection => ({
  engine_version: 'alphaview-alpaca-paper-connection-v1',
  orders_version: 'alphaview-alpaca-paper-orders-v1',
  configured: true,
  version: enabled ? 'v2' : 'v1',
  connected_at: '2026-09-29T22:00:00Z',
  orders_enabled: enabled,
  order_caps: { max_order_notional_usd: 5000, max_orders_per_submission: 20 },
  order_style: { type: 'market', limit_band_bps: 50, time_in_force: 'day' },
  enable_confirmation: 'ENABLE PAPER ORDERS',
  capabilities: ['account.read'],
  endpoint: 'https://paper-api.alpaca.markets',
})
const submission = (
  status: ExecutionSubmission['status'],
  orderStatus = 'accepted',
): ExecutionSubmission => ({
  id: 'synthetic-submission-0001',
  engine_version: 'alphaview-execution-v1',
  account_id: account.id,
  proposal_id: proposal.id,
  target: 'alpaca_paper',
  status,
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account_version: 3,
  connection_version: 'v2',
  created_at: '2026-09-30T00:05:00Z',
  updated_at: '2026-09-30T00:05:00Z',
  summary: { sent: 1 },
  order_counts: { [orderStatus]: 1 },
  order_count: 1,
  reconcile_required: status === 'submitted',
  terminal: status === 'filled',
  orders: [
    {
      id: 'synthetic-order-0001',
      submission_id: 'synthetic-submission-0001',
      sequence: 1,
      symbol: 'SYNTA',
      side: 'buy',
      qty: '30',
      order_type: 'market',
      time_in_force: 'day',
      reference_price: '100',
      reference_notional: '3000',
      client_order_id: 'av-synthetic-SYNTA',
      broker_order_id: 'broker-0001',
      status: orderStatus as ExecutionSubmission['orders'] extends (infer O)[] | undefined
        ? O extends { status: infer S }
          ? S
          : never
        : never,
      filled_qty: orderStatus === 'filled' ? '30' : '0',
      filled_avg_price: orderStatus === 'filled' ? '101.5' : null,
      submitted_at: '2026-09-30T00:05:00Z',
      last_synced_at: '2026-09-30T00:05:00Z',
      terminal: orderStatus === 'filled',
      broker: null,
      error: null,
    },
  ],
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
function mockApi(
  options: {
    alpacaReady?: boolean
    enabled?: boolean
    history?: ExecutionSubmission[]
    detail?: ExecutionSubmission
  } = {},
) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/execution/targets') return response(targets(!!options.alpacaReady))
    if (url === '/api/alpaca-paper/connection') return response(connection(!!options.enabled))
    if (url === `/api/execution/accounts/${account.id}/submissions?limit=20`)
      return response({
        submissions: options.history || [],
        targets: targets(!!options.alpacaReady).targets,
      })
    if (url === '/api/alpaca-paper/orders-policy') return response(connection(true))
    if (url.endsWith('/submit')) {
      const body = JSON.parse(String(init?.body))
      return response(
        body.target === 'paper_ledger'
          ? { ...submission('simulated'), target: 'paper_ledger', terminal: true }
          : submission('submitted'),
        201,
      )
    }
    if (url === '/api/execution/submissions/synthetic-submission-0001')
      return response(options.detail || submission('submitted'))
    if (url.endsWith('/reconcile')) return response(submission('filled', 'filled'))
    if (url.endsWith('/cancel')) return response(submission('submitted', 'cancel_requested'))
    if (url.endsWith('/cancel-working'))
      return response({
        engine_version: 'alphaview-execution-v1',
        account_id: account.id,
        at: '2026-09-30T00:06:00Z',
        reason: 'manual_sweep',
        nothing_to_do: false,
        orders_considered: 2,
        already_terminal: 1,
        counts: { cancel_requested: 1, skipped: 1 },
        results: [
          {
            order_id: 'synthetic-order-0001',
            submission_id: 'synthetic-submission-0001',
            symbol: 'SYNTA',
            side: 'buy',
            previous_status: 'accepted',
            action: 'cancel_requested',
            error: null,
          },
          {
            order_id: 'synthetic-order-0002',
            submission_id: 'synthetic-submission-0001',
            symbol: 'SYNTB',
            side: 'sell',
            previous_status: 'pending',
            action: 'skipped',
            error: null,
          },
        ],
      })
    if (url.startsWith('/api/trading-agent/readiness'))
      return response({
        engine_version: 'alphaview-readiness-v1',
        account_id: account.id,
        account_version: account.version,
        as_of: '2026-09-29',
        input_revision: 'synthetic:1',
        overall: 'not_ready',
        execution_target: 'paper_ledger',
        checks: [],
        summary: { pass: 0, fail: 0, unavailable: 0, not_applicable: 0 },
        method: 'Synthetic readiness method.',
        warnings: [],
      })
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const bodyOf = (fetcher: ReturnType<typeof mockApi>, suffix: string) =>
  JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith(suffix))?.[1]?.body))

it('loads immutable sweep history only on demand and never turns the legacy last summary into a history event', async () => {
  const saved = savedSweepSubmission()
  const ordinary = mockApi({ history: [saved], detail: saved })
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/sweep-history'))
      return response({
        account_id: account.id,
        items: [],
        pagination: { limit: 20, offset: 0, total: 0, returned: 0 },
      })
    return ordinary(url, init)
  })
  vi.stubGlobal('fetch', fetcher)
  render(
    <PortfolioTradingAgent
      account={account}
      snapshot={snapshot}
      locale="en"
      onAccountChanged={vi.fn()}
    />,
  )
  await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
  expect(await screen.findByRole('region', { name: 'Saved sweep review' })).toBeTruthy()
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/sweep-history'))).toHaveLength(0)
  const panel = screen.getByRole('region', { name: 'Saved sweep history' })
  await userEvent.click(within(panel).getByRole('button', { name: 'Load sweep history' }))
  expect(
    await within(panel).findByText(
      'No saved sweep events on this page; older summaries are not backfilled.',
    ),
  ).toBeTruthy()
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/sweep-history'))).toHaveLength(1)
  expect(within(panel).queryByRole('button', { name: 'Review sweep event' })).toBeNull()
  fireEvent.change(within(panel).getByRole('combobox', { name: 'Sweep history scope' }), {
    target: { value: 'submission' },
  })
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/sweep-history'))).toHaveLength(1)
  const scopedPanel = screen.getByRole('region', { name: 'Saved sweep history' })
  await userEvent.click(within(scopedPanel).getByRole('button', { name: 'Load sweep history' }))
  expect(
    await within(scopedPanel).findByText(
      'No saved sweep events for this submission on this page; older summaries are not backfilled.',
    ),
  ).toBeTruthy()
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/sweep-history')).at(-1)?.[0]).toBe(
    `/api/execution/accounts/${account.id}/sweep-history?limit=20&offset=0&submission_id=${saved.id}`,
  )
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
})

describe('Trading agent tab', () => {
  it('shows targets, requires the exact confirmation phrase to enable paper orders', async () => {
    const fetcher = mockApi()
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByText('Local paper ledger')
    expect(screen.getByText(/Alpaca Paper orders are not enabled/)).toBeTruthy()
    expect(screen.getByText(/Live broker/)).toBeTruthy()
    const enable = screen.getByRole('button', { name: 'Enable paper orders' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type the confirmation phrase/), {
      target: { value: 'ENABLE PAPER ORDERS' },
    })
    await waitFor(() => expect(enable.disabled).toBe(false))
    await userEvent.click(enable)
    await screen.findByText(/Alpaca Paper orders enabled/)
    expect(bodyOf(fetcher, '/orders-policy')).toEqual({
      expected_version: 'v1',
      orders_enabled: true,
      confirmation: 'ENABLE PAPER ORDERS',
      max_order_notional_usd: 5000,
      max_orders_per_submission: 20,
      order_type: 'market',
      limit_band_bps: 50,
    })
  })

  it('submits to the local ledger without acknowledgement and to Alpaca only after ticking it', async () => {
    const onAccountChanged = vi.fn()
    const fetcher = mockApi({ alpacaReady: true, enabled: true })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={onAccountChanged}
      />,
    )
    await screen.findByText('Local paper ledger')
    const select = screen.getByRole('combobox', { name: 'Proposal awaiting review' })
    expect(within(select).getAllByRole('option')).toHaveLength(2)
    fireEvent.change(select, { target: { value: proposal.id } })
    const button = screen.getByRole('button', {
      name: 'Simulate in local ledger',
    }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    await userEvent.click(button)
    await screen.findByText(/simulated in the local ledger/)
    expect(bodyOf(fetcher, '/submit')).toMatchObject({
      target: 'paper_ledger',
      expected_account_version: 3,
      acknowledge_external: false,
    })
    expect(onAccountChanged).toHaveBeenCalledTimes(1)
    fireEvent.change(select, { target: { value: proposal.id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution target' }), {
      target: { value: 'alpaca_paper' },
    })
    const send = screen.getByRole('button', { name: 'Send to Alpaca Paper' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await userEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(send.disabled).toBe(false))
    await userEvent.click(send)
    await screen.findByText(/recorded and sent to Alpaca Paper/)
    const bodies = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/submit'))
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[1]).toMatchObject({ target: 'alpaca_paper', acknowledge_external: true })
    expect(bodies[1].idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,100}$/)
  })

  it('opens a submission, reconciles it and cancels a working order', async () => {
    const fetcher = mockApi({
      alpacaReady: true,
      enabled: true,
      history: [submission('submitted')],
    })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByText('Submitted, working')
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    const details = await screen.findByLabelText('Execution details')
    expect(within(details).getByText('broker-0001')).toBeTruthy()
    await userEvent.click(within(details).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(bodyOf(fetcher, '/cancel')).toEqual({ expected_status: 'accepted' }))
    await screen.findByText('Cancel requested')
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    await screen.findAllByText('Filled')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/reconcile'))).toBe(true)
  })

  it('shows limit prices per order and terminal partial fills on expired limit orders', async () => {
    const expired = submission('mixed', 'expired')
    const limitOrder = {
      ...expired.orders![0],
      order_type: 'limit',
      limit_price: '100.50',
      filled_qty: '3',
      filled_avg_price: '99.4',
      terminal: true,
    }
    const detail = { ...expired, terminal: true, partial_fills: 1, orders: [limitOrder] }
    const fetcher = mockApi({ alpacaReady: true, enabled: true, history: [detail], detail })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByText('1 partial fill(s)')
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('Limit @ 100.50')).toBeTruthy()
    expect(screen.getByText('3 @ 99.4')).toBeTruthy()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/reconcile'))).toBe(false)
  })
})

describe('Trading agent order-style override and kill-switch sweep', () => {
  it('sends a per-submission style override and sweeps working orders only after acknowledging', async () => {
    const working = {
      ...submission('submitted'),
      summary: { sent: 1, order_style_source: 'override', order_type: 'limit' },
    }
    const fetcher = mockApi({ alpacaReady: true, enabled: true, history: [working] })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByText('Local paper ledger')
    expect(await screen.findByText(/style override/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Proposal awaiting review' }), {
      target: { value: proposal.id },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution target' }), {
      target: { value: 'alpaca_paper' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Order style (this submission)' }), {
      target: { value: 'limit' },
    })
    const band = screen.getByRole('textbox', { name: /Limit band bps/ })
    fireEvent.change(band, { target: { value: '750' } })
    const send = screen.getByRole('button', { name: 'Send to Alpaca Paper' }) as HTMLButtonElement
    await userEvent.click(screen.getByRole('checkbox', { name: /I understand this sends/ }))
    expect(send.disabled).toBe(true)
    fireEvent.change(band, { target: { value: '75' } })
    await waitFor(() => expect(send.disabled).toBe(false))
    await userEvent.click(send)
    await screen.findByText(/recorded and sent to Alpaca Paper/)
    expect(bodyOf(fetcher, '/submit')).toMatchObject({
      target: 'alpaca_paper',
      acknowledge_external: true,
      order_style_override: { type: 'limit', limit_band_bps: 75 },
    })
    const sweepButton = screen.getByRole('button', {
      name: 'Cancel all working orders',
    }) as HTMLButtonElement
    expect(sweepButton.disabled).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: /Send one cancel request/ }))
    await waitFor(() => expect(sweepButton.disabled).toBe(false))
    await userEvent.click(sweepButton)
    await screen.findByText(/2 working order\(s\) processed: cancel_requested 1, skipped 1/)
    expect(bodyOf(fetcher, '/cancel-working')).toEqual({
      expected_account_version: account.version,
      reason: 'manual_sweep',
    })
    expect(
      screen.getByText(/SYNTA accepted → cancel_requested · SYNTB pending → skipped/),
    ).toBeTruthy()
  })
})

function savedSweepSubmission(): ExecutionSubmission {
  const detail = submission('mixed')
  const base = detail.orders![0]
  const cases = [
    ['SYNFILLED', 'filled', null],
    ['SYNSWEPT', 'skipped', 'swept'],
    ['SYNPRIOR', 'skipped', 'not_sent'],
    ['SYNREJECT', 'accepted', 'cancel_rejected'],
    ['SYNUNKNOWN', 'unknown', 'network_unavailable'],
    ['SYNMISSING', 'accepted', null],
  ] as const
  const orders = cases.map(([symbol, status, code], index) => ({
    ...base,
    id: `synthetic-review-order-${index}`,
    sequence: index + 1,
    symbol,
    status,
    broker_order_id: symbol === 'SYNMISSING' ? null : base.broker_order_id,
    error: code
      ? { code, message: `Synthetic ${code}`, phase: code === 'not_sent' ? 'submit' : 'sweep' }
      : null,
  }))
  return {
    ...detail,
    orders,
    order_count: orders.length,
    summary: {
      kill_switch_sweep: {
        at: '2026-09-30T00:06:00Z',
        reason: 'kill_switch_enabled',
        results: orders
          .filter((item) => item.symbol !== 'SYNPRIOR')
          .map((item) => ({
            order_id: item.id,
            submission_id: detail.id,
            symbol: item.symbol,
            side: item.side,
            previous_status: item.symbol === 'SYNSWEPT' ? 'pending' : 'accepted',
            action:
              item.symbol === 'SYNFILLED'
                ? 'cancel_requested'
                : item.symbol === 'SYNSWEPT'
                  ? 'skipped'
                  : item.symbol === 'SYNREJECT'
                    ? 'cancel_rejected'
                    : 'unknown',
            error:
              item.symbol === 'SYNMISSING'
                ? { code: 'reconcile_required', message: 'Synthetic missing broker id' }
                : item.symbol === 'SYNREJECT'
                  ? {
                      code: 'cancel_rejected',
                      message: 'Synthetic rejection detail',
                      http_status: 422,
                    }
                  : item.symbol === 'SYNUNKNOWN'
                    ? { code: 'network_unavailable', message: 'Synthetic timeout detail' }
                    : null,
          })),
      },
    },
  }
}

describe('Persisted sweep review', () => {
  it('reads saved sweep reasons after reload, keeps present states separate and filters without broker actions', async () => {
    const detail = savedSweepSubmission()
    const fetcher = mockApi({ history: [detail], detail })
    const props = { account, snapshot, locale: 'en' as const, onAccountChanged: vi.fn() }
    const first = render(<PortfolioTradingAgent {...props} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    await screen.findByRole('region', { name: 'Saved sweep review' })
    first.unmount()
    render(<PortfolioTradingAgent {...props} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const details = await screen.findByLabelText('Execution details')
    expect(
      within(details).getByText(/Sweep trigger: Account pause enabled \(kill_switch_enabled\)/),
    ).toBeTruthy()
    expect(within(details).getByText(/historical evidence, not current broker status/)).toBeTruthy()
    const filled = within(details).getByRole('rowheader', { name: 'SYNFILLED' }).closest('tr')!
    expect(within(filled).getByText('Filled')).toBeTruthy()
    expect(within(filled).getByText('accepted → cancel_requested')).toBeTruthy()
    expect(within(details).getByText('Skipped (not sent) · Unsent at sweep')).toBeTruthy()
    expect(
      within(details).getByText('Skipped (not sent) · Previous order outcome unknown'),
    ).toBeTruthy()
    expect(within(details).getByText('Unknown')).toBeTruthy()
    expect(
      within(details).getByText(/reconcile_required · Synthetic missing broker id/),
    ).toBeTruthy()
    const beforeFilter = fetcher.mock.calls.length
    const selector = within(details).getByRole('combobox', {
      name: 'Reason filter for this submission',
    })
    await userEvent.selectOptions(selector, 'sweep:cancel_rejected')
    expect(within(details).getByText(/Orders shown: 1 \/ 6/)).toBeTruthy()
    expect(within(details).getByRole('rowheader', { name: 'SYNREJECT' })).toBeTruthy()
    expect(within(details).queryByRole('rowheader', { name: 'SYNFILLED' })).toBeNull()
    expect(
      within(details).getByText('cancel_rejected · HTTP 422 · Synthetic rejection detail'),
    ).toBeTruthy()
    await userEvent.selectOptions(selector, 'order:not_sent')
    expect(within(details).getByRole('rowheader', { name: 'SYNPRIOR' })).toBeTruthy()
    await userEvent.selectOptions(selector, 'all')
    expect(within(details).getAllByRole('rowheader')).toHaveLength(6)
    expect(fetcher.mock.calls).toHaveLength(beforeFilter)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(props.onAccountChanged).not.toHaveBeenCalled()
  })

  it('labels legacy skipped rows neutrally and preserves unavailable saved evidence', async () => {
    const detail = submission('rejected', 'skipped')
    mockApi({ history: [detail], detail })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const details = await screen.findByLabelText('Execution details')
    expect(within(details).getByText('Skipped (not sent)')).toBeTruthy()
    expect(within(details).queryByText(/previous unknown/i)).toBeNull()
    expect(
      within(details).getByText(/Saved sweep evidence is unavailable or incomplete/),
    ).toBeTruthy()
    expect(within(details).getByText(/Last recorded sweep time: — · Sweep trigger: —/)).toBeTruthy()
    await userEvent.selectOptions(within(details).getByRole('combobox'), 'unavailable')
    expect(within(details).getByText(/Orders shown: 1 \/ 1/)).toBeTruthy()
  })

  it('resets the reason selector when opening another submission', async () => {
    const first = savedSweepSubmission()
    const second = {
      ...submission('submitted'),
      id: 'synthetic-submission-0002',
      orders: [{ ...submission('submitted').orders![0], symbol: 'SYNSECOND' }],
    }
    const base = mockApi({ history: [first, second], detail: first })
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url === `/api/execution/submissions/${second.id}`
          ? Promise.resolve(response(second))
          : base(url, init),
      ),
    )
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(2))
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Reason filter for this submission' }),
      'sweep:cancel_rejected',
    )
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[1])
    await screen.findByRole('rowheader', { name: 'SYNSECOND' })
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Reason filter for this submission',
        }) as HTMLSelectElement
      ).value,
    ).toBe('all')
    expect(screen.getByText(/Orders shown: 1 \/ 1/)).toBeTruthy()
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[1])
    await screen.findByRole('rowheader', { name: 'SYNFILLED' })
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Reason filter for this submission',
        }) as HTMLSelectElement
      ).value,
    ).toBe('all')
    expect(screen.getByText(/Orders shown: 6 \/ 6/)).toBeTruthy()
  })

  it('aborts an old account detail request and ignores its late saved receipt', async () => {
    const detail = savedSweepSubmission()
    const other = { ...account, id: 'synthetic-other-account' }
    const base = mockApi({ history: [detail], detail })
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    let detailSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === `/api/execution/submissions/${detail.id}`) {
          detailSignal = init?.signal
          return new Promise<ReturnType<typeof response>>((resolve) => {
            finish = resolve
          })
        }
        if (url === `/api/execution/accounts/${other.id}/submissions?limit=20`)
          return Promise.resolve(response({ submissions: [] }))
        return base(url, init)
      }),
    )
    const view = render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    view.rerender(
      <PortfolioTradingAgent
        account={other}
        snapshot={{ ...snapshot, account: other }}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await screen.findByText('No executions yet.')
    expect(detailSignal?.aborted).toBe(true)
    await act(async () => finish?.(response(detail)))
    expect(screen.queryByLabelText('Execution details')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Saved sweep review' })).toBeNull()
  })
})

describe('Sweep review display labels', () => {
  it.each(['en', 'zh-TW'] as const)(
    'labels known order errors once and keeps unknown codes verbatim in %s',
    async (locale) => {
      const detail = savedSweepSubmission()
      detail.orders![0].error = {
        code: 'not_found',
        message: 'Synthetic missing order',
        phase: 'reconcile',
      }
      detail.orders![1].error = {
        code: 'order_rejected',
        message: 'Synthetic rejected order',
        phase: 'submit',
      }
      detail.orders![2].error = {
        code: 'future_guard',
        message: 'Synthetic unknown code',
        phase: 'submit',
      }
      const fetcher = mockApi({ history: [detail], detail })
      render(
        <PortfolioTradingAgent
          account={account}
          snapshot={snapshot}
          locale={locale}
          onAccountChanged={vi.fn()}
        />,
      )
      await userEvent.click(
        await screen.findByRole('button', { name: locale === 'en' ? 'Details' : '明細' }),
      )
      const selector = await screen.findByRole('combobox', {
        name: locale === 'en' ? 'Reason filter for this submission' : '這筆送出紀錄的原因篩選',
      })
      const origin = locale === 'en' ? 'Current recorded error' : '目前記錄的錯誤'
      expect(
        within(selector).getByRole('option', {
          name: `${origin}: ${locale === 'en' ? 'Broker could not find this order' : '券商找不到此委託'} (not_found) (1)`,
        }),
      ).toBeTruthy()
      expect(
        within(selector).getByRole('option', {
          name: `${origin}: ${locale === 'en' ? 'Order rejected' : '委託遭拒絕'} (order_rejected) (1)`,
        }),
      ).toBeTruthy()
      expect(
        within(selector).getByRole('option', { name: `${origin}: future_guard (1)` }),
      ).toBeTruthy()
      expect(
        within(selector).queryByRole('option', { name: /future_guard \(future_guard\)/ }),
      ).toBeNull()
      const before = fetcher.mock.calls.length
      await userEvent.selectOptions(selector, 'order:not_found')
      expect(screen.getByRole('rowheader', { name: 'SYNFILLED' })).toBeTruthy()
      expect(screen.queryByRole('rowheader', { name: 'SYNSWEPT' })).toBeNull()
      expect(fetcher.mock.calls).toHaveLength(before)
      expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    },
  )

  it.each([
    [
      'circuit_breaker_tripped:daily_loss',
      'Daily-loss circuit breaker tripped (circuit_breaker_tripped:daily_loss)',
    ],
    ['circuit_breaker_tripped:future_guard', 'circuit_breaker_tripped:future_guard'],
  ])('uses only exact known trigger labels for %s', async (reason, expected) => {
    const detail = savedSweepSubmission()
    const receipt = detail.summary.kill_switch_sweep as Record<string, unknown>
    receipt.reason = reason
    mockApi({ history: [detail], detail })
    render(
      <PortfolioTradingAgent
        account={account}
        snapshot={snapshot}
        locale="en"
        onAccountChanged={vi.fn()}
      />,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const panel = await screen.findByRole('region', { name: 'Saved sweep review' })
    const trigger = within(panel).getByText(/Last recorded sweep time:/)
    expect(trigger.textContent).toContain(`Sweep trigger: ${expected}`)
    if (reason.includes('future_guard'))
      expect(trigger.textContent?.match(/future_guard/g)).toHaveLength(1)
  })
})
