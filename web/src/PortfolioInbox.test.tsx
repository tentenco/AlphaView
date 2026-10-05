import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PortfolioInbox } from './PortfolioInbox'

const queueOrder = {
  id: 'synthetic-queue-order',
  account_id: 'synthetic-account',
  account_name: 'Synthetic inbox account',
  source_proposal_id: 'synthetic-source',
  execution_proposal_id: null,
  status: 'waiting_prices',
  version: 4,
  execution_session: '2026-09-21',
  updated_at: '2026-09-22T22:00:00Z',
  reason_code: 'quote_unavailable',
  reason: '等待本機資料',
  can_process: true,
  can_cancel: true,
  attempt_count: 23,
}
function inbox() {
  return {
    engine_version: 'alphaview-portfolio-inbox-v3',
    as_of: '2026-09-21',
    input_revision: 'synthetic:1',
    method: 'Synthetic inbox.',
    counts: {
      accounts: 1,
      paused_accounts: 0,
      open_proposals: 1,
      simulated_proposals: 0,
      enabled_mandates: 0,
      mandates: 1,
      queue_orders: 1,
      active_queue_orders: 1,
    },
    proposals: [
      {
        id: 'synthetic-old-proposal',
        account_id: 'synthetic-account',
        account_name: 'Synthetic inbox account',
        review_status: 'stale',
        created_at: '2026-09-18T22:00:00Z',
        as_of: '2026-09-18',
        targets: [],
        order_count: 0,
        cost_total: 0,
        reasons: [{ code: 'account_changed', message: '帳戶已變更' }],
      },
    ],
    pagination: { limit: 20, offset: 0, total: 1, returned: 1, has_more: false },
    proposal_sources: {
      selected: 'all',
      total: 1,
      counts: {
        automation: 0,
        local_agent: 0,
        jev: 0,
        position_stops: 0,
        strategy_bridge: 0,
        rules_workflow: 0,
        unknown: 1,
      },
      provenance_engine_version: 'alphaview-proposal-provenance-v1',
    },
    queue_orders: [queueOrder],
    queue_pagination: { limit: 20, offset: 0, total: 1, returned: 1, has_more: false },
    mandates: [
      {
        id: 'synthetic-exact-mandate',
        name: 'Synthetic task',
        account_id: 'synthetic-account',
        account_name: 'Synthetic inbox account',
        enabled: false,
        mode: 'proposal_only',
        status: 'disabled',
        reason: null,
        next_due_at: null,
        last_checked_at: null,
        last_attempt_status: null,
      },
    ],
    recent_outcomes: [],
  }
}
afterEach(() => vi.restoreAllMocks())

it('groups a waiting order, links its exact identity and preserves explicit handling in the destination', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => inbox() }))
  vi.stubGlobal('fetch', fetcher)
  const onOpen = vi.fn()
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  const queue = await screen.findByRole('region', { name: 'Next-open order inbox' })
  expect(within(queue).getAllByRole('button', { name: 'Open this order' })).toHaveLength(1)
  expect(within(queue).getByText(/Processing attempts.*23/)).toBeTruthy()
  await userEvent.click(within(queue).getByRole('button', { name: 'Open this order' }))
  expect(onOpen).toHaveBeenLastCalledWith({
    account_id: 'synthetic-account',
    queue_order_id: 'synthetic-queue-order',
    tab: 'next-open',
  })
  expect(
    fetcher.mock.calls.every(
      (call) => call.length === 0 || !(call as unknown as [string, RequestInit])[1]?.method,
    ),
  ).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: 'Open tasks' }))
  expect(onOpen).toHaveBeenLastCalledWith({
    account_id: 'synthetic-account',
    mandate_id: 'synthetic-exact-mandate',
    tab: 'automation',
  })
  await userEvent.click(screen.getByRole('button', { name: 'Review proposal' }))
  expect(onOpen).toHaveBeenLastCalledWith({
    account_id: 'synthetic-account',
    proposal_id: 'synthetic-old-proposal',
    tab: 'plan',
  })
})

it('routes a filled outcome to its separate execution receipt', async () => {
  const result = inbox()
  const filled = {
    ...queueOrder,
    status: 'filled',
    execution_proposal_id: 'synthetic-execution-receipt',
    can_cancel: false,
    can_process: false,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ ...result, queue_orders: [filled] }) })),
  )
  const onOpen = vi.fn()
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Read execution receipt' }))
  expect(onOpen).toHaveBeenCalledWith({
    account_id: 'synthetic-account',
    proposal_id: 'synthetic-execution-receipt',
    tab: 'plan',
  })
  expect(screen.queryByRole('button', { name: /Cancel|Retry|Accept/ })).toBeNull()
})

it('pages queue orders independently from open proposals', async () => {
  const fetcher = vi.fn(async (url: string) => {
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('queue_offset'))
    return {
      ok: true,
      json: async () => ({
        ...inbox(),
        queue_pagination: {
          limit: 20,
          offset,
          total: 21,
          returned: offset ? 1 : 20,
          has_more: !offset,
        },
      }),
    }
  })
  vi.stubGlobal('fetch', fetcher)
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Next orders' }))
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => url.includes('offset=0&queue_limit=20&queue_offset=20')),
    ).toBe(true),
  )
  expect(screen.getByRole('button', { name: 'Review proposal' })).toBeTruthy()
})

it('lists Alpaca order events and opens the trading agent tab for the proposal', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  const value = {
    ...inbox(),
    counts: { ...inbox().counts, execution_events: 1, execution_attention: 1 },
    execution_events: [
      {
        key: 'execution:order-1:execution_rejected',
        kind: 'execution_rejected',
        order_id: 'order-1',
        submission_id: 'submission-1',
        account_id: 'synthetic-account',
        account_name: 'Synthetic inbox account',
        proposal_id: 'synthetic-proposal',
        target: 'alpaca_paper',
        symbol: 'SYNTA',
        side: 'buy',
        qty: '10',
        order_type: 'limit',
        limit_price: '101.25',
        status: 'rejected',
        filled_qty: '0',
        filled_avg_price: null,
        partial_fill: false,
        at: '2026-09-22T14:31:00Z',
        broker_order_id: 'broker-1',
        error: { code: 'insufficient_buying_power', message: 'rejected' },
      },
    ],
    execution_event_counts: { execution_rejected: 1 },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => value })),
  )
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  const button = await screen.findByRole('button', { name: /SYNTA buy 10 @ 101.25/ })
  expect(button.textContent).toContain('Rejected · insufficient_buying_power')
  expect(screen.getByText(/1 need attention/)).toBeTruthy()
  await user.click(button)
  expect(onOpen).toHaveBeenCalledWith({
    account_id: 'synthetic-account',
    proposal_id: 'synthetic-proposal',
    tab: 'trading-agent',
  })
})

it('lists attention items critical-first, navigates mandates to automation, and mutes unavailable sources', async () => {
  const onOpen = vi.fn()
  const value = {
    ...inbox(),
    counts: { ...inbox().counts, attention_total: 2, attention_critical: 1, attention_warn: 0 },
    attention: [
      {
        key: 'mandate:synthetic-exact-mandate:expired',
        kind: 'mandate_expired',
        severity: 'critical',
        account_id: 'synthetic-account',
        account_name: 'Synthetic inbox account',
        at: '2026-09-18T20:00:00Z',
        title_zh: '任務授權已到期',
        title_en: 'Mandate authorization expired',
        detail: 'Synthetic task：授權已於 2026-09-17 到期',
        navigation: { tab: 'automation', mandate_id: 'synthetic-exact-mandate' },
      },
      {
        key: 'source_unavailable:circuit_breakers',
        kind: 'source_unavailable',
        severity: 'info',
        account_id: null,
        account_name: null,
        at: null,
        title_zh: '斷路器來源不可用',
        title_en: 'circuit_breakers source unavailable',
        detail: 'synthetic failure',
        navigation: null,
      },
    ],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => value })),
  )
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  const region = await screen.findByRole('region', { name: 'Needs attention' })
  expect(region.textContent).toContain('critical 1')
  const button = within(region).getByRole('button', {
    name: /Critical · Mandate authorization expired/,
  })
  await userEvent.click(button)
  expect(onOpen).toHaveBeenCalledWith({
    account_id: 'synthetic-account',
    mandate_id: 'synthetic-exact-mandate',
    tab: 'automation',
  })
  const muted = within(region).getByText('circuit_breakers source unavailable', { exact: false })
  expect(muted.closest('div')?.className).toContain('muted')
  expect(within(region).queryByRole('button', { name: /source unavailable/ })).toBeNull()
})

function attentionInbox(acknowledged = false, version = 0, fingerprint = 'a'.repeat(64)) {
  return {
    ...inbox(),
    counts: {
      ...inbox().counts,
      attention_total: 2,
      attention_critical: 1,
      attention_warn: 0,
      attention_unreviewed: acknowledged ? 1 : 2,
      attention_unreviewed_critical: acknowledged ? 0 : 1,
      attention_unreviewed_warn: 0,
    },
    attention: [
      {
        key: 'breaker:synthetic-account:2026-09-21',
        kind: 'circuit_breaker_tripped',
        severity: 'critical',
        account_id: 'synthetic-account',
        account_name: 'Synthetic inbox account',
        at: '2026-09-21',
        title_zh: '斷路器觸發',
        title_en: 'Circuit breaker tripped',
        detail: 'daily_loss',
        navigation: { tab: 'risk' },
        event_fingerprint: fingerprint,
        acknowledgement: {
          engine_version: 'alphaview-inbox-acknowledgement-v1',
          can_acknowledge: true,
          acknowledged,
          version,
          acknowledged_at: acknowledged ? '2026-09-22T22:00:00Z' : null,
          updated_at: version ? '2026-09-22T22:00:00Z' : null,
        },
      },
      {
        key: 'source_unavailable:corporate_actions',
        kind: 'source_unavailable',
        severity: 'info',
        account_id: null,
        account_name: null,
        at: null,
        title_zh: '公司行動來源不可用',
        title_en: 'corporate_actions source unavailable',
        detail: 'Synthetic source failure',
        navigation: null,
        event_fingerprint: 'b'.repeat(64),
        acknowledgement: {
          engine_version: 'alphaview-inbox-acknowledgement-v1',
          can_acknowledge: false,
          acknowledged: false,
          version: 0,
          acknowledged_at: null,
          updated_at: null,
        },
      },
    ],
  }
}
const reply = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
})

it('saves the exact reviewed content, keeps risk totals, filters reviewed events and can mark them unreviewed again', async () => {
  const user = userEvent.setup()
  let acknowledged = false
  let version = 0
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      acknowledged = body.acknowledged
      version++
      return reply({ event: attentionInbox(acknowledged, version).attention[0] })
    }
    return reply(attentionInbox(acknowledged, version))
  })
  vi.stubGlobal('fetch', fetcher)
  const onOpen = vi.fn()
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  const region = await screen.findByRole('region', { name: 'Needs attention' })
  await user.selectOptions(within(region).getByLabelText('Review filter'), 'unreviewed')
  await user.click(
    within(region).getByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  )
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
  expect(post?.[0]).toBe('/api/portfolio-agent/inbox/attention/acknowledgement')
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    event_key: 'breaker:synthetic-account:2026-09-21',
    account_id: 'synthetic-account',
    acknowledged: true,
    expected_version: 0,
    expected_fingerprint: 'a'.repeat(64),
  })
  await waitFor(() =>
    expect(within(region).queryByText(/Critical · Circuit breaker tripped/)).toBeNull(),
  )
  expect(
    within(region).getByText('corporate_actions source unavailable', { exact: false }),
  ).toBeTruthy()
  expect(
    within(region).queryByRole('button', { name: /Mark reviewed.*source unavailable/ }),
  ).toBeNull()
  expect(region.textContent).toContain('critical 1')
  expect(within(region).getByText('Unreviewed: 1')).toBeTruthy()
  await user.selectOptions(within(region).getByLabelText('Review filter'), 'all')
  expect(within(region).getByText('Reviewed', { exact: true })).toBeTruthy()
  await user.click(
    within(region).getByRole('button', { name: /Critical · Circuit breaker tripped/ }),
  )
  expect(onOpen).toHaveBeenLastCalledWith({ account_id: 'synthetic-account', tab: 'risk' })
  await user.click(
    within(region).getByRole('button', { name: 'Mark unreviewed · Circuit breaker tripped' }),
  )
  await waitFor(() => expect(within(region).getByText('Unreviewed: 2')).toBeTruthy())
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(posts[1][1]?.body))).toMatchObject({
    acknowledged: false,
    expected_version: 1,
  })
  expect(region.textContent).toContain('critical 1')
  expect(within(region).getByLabelText('Review filter')).toHaveProperty('value', 'all')
})

it('guards duplicate review clicks and preserves pending state and filters across polling revisions', async () => {
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined
  let reviewed = false
  const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST')
      return new Promise<ReturnType<typeof reply>>((resolve) => {
        finish = resolve
      })
    return Promise.resolve(reply(attentionInbox(reviewed, reviewed ? 1 : 0)))
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  const button = await screen.findByRole('button', {
    name: 'Mark reviewed · Circuit breaker tripped',
  })
  fireEvent.change(screen.getByLabelText('Review filter'), { target: { value: 'unreviewed' } })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(button).toHaveProperty('disabled', true)
  view.rerender(<PortfolioInbox locale="en" revision="synthetic:2" onOpen={vi.fn()} />)
  expect(screen.getByText('Saving review…')).toBeTruthy()
  expect(screen.getByLabelText('Review filter')).toHaveProperty('value', 'unreviewed')
  expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(1)
  reviewed = true
  await act(async () => finish?.(reply({ event: attentionInbox(true, 1).attention[0] })))
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2),
  )
  expect(screen.queryByText('Saving review…')).toBeNull()
  expect(screen.getByLabelText('Review filter')).toHaveProperty('value', 'unreviewed')
})

it('keeps a 409 conflict visible after refresh without falsely marking the new content reviewed', async () => {
  let changed = false
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      changed = true
      return reply({ detail: { code: 'attention_changed', message: 'synthetic conflict' } }, 409)
    }
    return reply(attentionInbox(false, changed ? 1 : 0, (changed ? 'c' : 'a').repeat(64)))
  })
  vi.stubGlobal('fetch', fetcher)
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  await userEvent.click(
    await screen.findByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  )
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'The event or review version changed. Review the refreshed inbox before trying again.',
  )
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2),
  )
  expect(screen.queryByText('Reviewed', { exact: true })).toBeNull()
  expect(screen.getByText('Unreviewed: 2')).toBeTruthy()
  expect(screen.getByRole('alert')).toBeTruthy()
  await userEvent.click(
    screen.getByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  )
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(posts[1][1]?.body))).toMatchObject({
    expected_version: 1,
    expected_fingerprint: 'c'.repeat(64),
  })
})

it('reopens changed content on refresh and retains the unreviewed filter and unavailable sources', async () => {
  let changed = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(attentionInbox(!changed, 1, (changed ? 'c' : 'a').repeat(64)))),
  )
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  await screen.findByText('Reviewed', { exact: true })
  await userEvent.selectOptions(screen.getByLabelText('Review filter'), 'unreviewed')
  expect(screen.queryByRole('button', { name: /Circuit breaker tripped/ })).toBeNull()
  changed = true
  await userEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }))
  expect(
    await screen.findByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  ).toBeTruthy()
  expect(screen.getByLabelText('Review filter')).toHaveProperty('value', 'unreviewed')
  expect(screen.getByText('corporate_actions source unavailable', { exact: false })).toBeTruthy()
})

it('aborts an unfinished review on unmount without showing a late success', async () => {
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        signal = init.signal as AbortSignal
        return new Promise<ReturnType<typeof reply>>((resolve) => {
          finish = resolve
        })
      }
      return Promise.resolve(reply(attentionInbox()))
    }),
  )
  const view = render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  await userEvent.click(
    await screen.findByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  )
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => finish?.(reply({ event: attentionInbox(true, 1).attention[0] })))
  expect(screen.queryByText('Reviewed', { exact: true })).toBeNull()
})

function sourcedInbox(source = 'all', offset = 0, total = source === 'all' ? 25 : 3) {
  const base = attentionInbox()
  return {
    ...base,
    counts: { ...base.counts, open_proposals: 25 },
    proposal_sources: {
      ...base.proposal_sources,
      selected: source,
      total: 25,
      counts: { ...base.proposal_sources.counts, automation: 3, unknown: 22 },
    },
    proposals: total
      ? [
          {
            ...base.proposals[0],
            id: `synthetic-${source}-${offset}`,
            account_name: `Proposal ${source} page ${offset}`,
            provenance: {
              engine_version: 'alphaview-proposal-provenance-v1',
              source: source === 'all' ? 'unknown' : source,
              evidence_kind: source === 'rules_workflow' ? 'program_marker' : 'structured',
              reason: null,
            },
          },
        ]
      : [],
    pagination: {
      limit: 20,
      offset,
      total,
      returned: total ? 1 : 0,
      has_more: total > offset + 20,
    },
  }
}

it('filters proposals on the server, resets only proposal offset and keeps global attention and counts', async () => {
  const fetcher = vi.fn(async (url: string) => {
    const query = new URL(url, 'http://localhost').searchParams
    const source = query.get('source') ?? 'all'
    const offset = Number(query.get('offset'))
    return reply(sourcedInbox(source, offset))
  })
  vi.stubGlobal('fetch', fetcher)
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  const proposals = await screen.findByRole('region', { name: 'Open proposals' })
  await userEvent.click(within(proposals).getByRole('button', { name: 'Next' }))
  await screen.findByText('Proposal all page 20')
  await userEvent.selectOptions(within(proposals).getByLabelText('Proposal source'), 'automation')
  await screen.findByText('Proposal automation page 0')
  const url = new URL(fetcher.mock.calls.at(-1)![0], 'http://localhost')
  expect(url.searchParams.get('source')).toBe('automation')
  expect(url.searchParams.get('offset')).toBe('0')
  expect(url.searchParams.get('queue_offset')).toBe('0')
  expect(within(proposals).getByText(/Showing 1–1 \/ 3 · All open: 25/)).toBeTruthy()
  expect(within(proposals).getByRole('option', { name: 'Automation (3)' })).toBeTruthy()
  expect(within(proposals).getByText('Source: Automation')).toBeTruthy()
  expect(within(proposals).queryByText('Proposal all page 20')).toBeNull()
  const attention = screen.getByRole('region', { name: 'Needs attention' })
  expect(attention.textContent).toContain('critical 1')
  expect(within(attention).getByText('Unreviewed: 2')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Next-open order inbox' })).toBeTruthy()
})

it('hides mismatched proposal rows during a source change and ignores an aborted late response', async () => {
  const pending: {
    source: string
    signal?: AbortSignal
    resolve: (value: ReturnType<typeof reply>) => void
  }[] = []
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const source = new URL(url, 'http://localhost').searchParams.get('source') ?? 'all'
    if (source === 'all') return Promise.resolve(reply(sourcedInbox()))
    return new Promise<ReturnType<typeof reply>>((resolve) =>
      pending.push({ source, signal: init?.signal as AbortSignal, resolve }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  const proposals = await screen.findByRole('region', { name: 'Open proposals' })
  await userEvent.selectOptions(within(proposals).getByLabelText('Proposal source'), 'automation')
  expect(within(proposals).queryByRole('button', { name: 'Review proposal' })).toBeNull()
  expect(within(proposals).getByRole('status').textContent).toBe('Loading matching proposals…')
  await userEvent.selectOptions(within(proposals).getByLabelText('Proposal source'), 'jev')
  expect(pending[0].signal?.aborted).toBe(true)
  await act(async () => pending[1].resolve(reply(sourcedInbox('jev', 0, 0))))
  expect(within(proposals).getByText('There are no open proposals for this source.')).toBeTruthy()
  await act(async () => pending[0].resolve(reply(sourcedInbox('automation'))))
  expect(within(proposals).queryByText('Proposal automation page 0')).toBeNull()
  expect(within(proposals).getByLabelText('Proposal source')).toHaveProperty('value', 'jev')
  expect(within(proposals).getByText(/Showing 0–0 \/ 0 · All open: 25/)).toBeTruthy()
})

it('labels rationale evidence as a source marker and retains the selected source across refresh', async () => {
  const fetcher = vi.fn(async (url: string) =>
    reply(sourcedInbox(new URL(url, 'http://localhost').searchParams.get('source') ?? 'all')),
  )
  vi.stubGlobal('fetch', fetcher)
  const onOpen = vi.fn()
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={onOpen} />)
  const proposals = await screen.findByRole('region', { name: 'Open proposals' })
  await userEvent.selectOptions(
    within(proposals).getByLabelText('Proposal source'),
    'rules_workflow',
  )
  await screen.findByText('Source marker; authorship unverified')
  expect(within(proposals).getByText('Source: Rules workflow marker')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }))
  await waitFor(() => expect(fetcher.mock.calls).toHaveLength(3))
  expect(within(proposals).getByLabelText('Proposal source')).toHaveProperty(
    'value',
    'rules_workflow',
  )
  await userEvent.click(within(proposals).getByRole('button', { name: 'Review proposal' }))
  expect(onOpen).toHaveBeenLastCalledWith({
    account_id: 'synthetic-account',
    proposal_id: 'synthetic-rules_workflow-0',
    tab: 'plan',
  })
  expect(within(proposals).queryByRole('button', { name: /Accept|Execute/ })).toBeNull()
})

it('keeps an in-flight review coherent when the proposal source changes', async () => {
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined
  let reviewed = false
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return new Promise<ReturnType<typeof reply>>((resolve) => {
        finish = resolve
      })
    const source = new URL(url, 'http://localhost').searchParams.get('source') ?? 'all'
    return Promise.resolve(
      reply({
        ...sourcedInbox(source),
        attention: attentionInbox(reviewed, reviewed ? 1 : 0).attention,
        counts: {
          ...sourcedInbox(source).counts,
          ...attentionInbox(reviewed, reviewed ? 1 : 0).counts,
          open_proposals: 25,
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  render(<PortfolioInbox locale="en" revision="synthetic:1" onOpen={vi.fn()} />)
  await userEvent.click(
    await screen.findByRole('button', { name: 'Mark reviewed · Circuit breaker tripped' }),
  )
  await userEvent.selectOptions(screen.getByLabelText('Proposal source'), 'automation')
  expect(fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1)
  expect(screen.getByText('Saving review…')).toBeTruthy()
  reviewed = true
  await act(async () => finish?.(reply({ event: attentionInbox(true, 1).attention[0] })))
  await screen.findByText('Proposal automation page 0')
  expect(screen.getByText('Reviewed', { exact: true })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Needs attention' }).textContent).toContain(
    'critical 1',
  )
  expect(screen.getByLabelText('Proposal source')).toHaveProperty('value', 'automation')
})
