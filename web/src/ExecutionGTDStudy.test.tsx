import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionGTDStudy, type ExecutionGTDEvidence } from './ExecutionGTDStudy'
import type { PaperProposal } from './paper-model'

const proposal = {
  id: 'b'.repeat(32),
  account_id: 'a'.repeat(32),
  account_version: 1,
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2024-01-05',
  input_revision: 'synthetic:1',
  status: 'proposed',
  created_at: '2024-01-06T12:00:00Z',
  accepted_at: null,
  executable: true,
  orders: [{ symbol: 'SYNTA', side: 'buy', shares: 30, reference_price: 100 }],
} as PaperProposal
const props = {
  accountId: proposal.account_id,
  proposal,
  currentAccountVersion: 1,
  currentInputRevision: 'synthetic:2',
  currentAsOf: '2024-01-09',
  t: (_zh: string, en: string) => en,
}
const dates = ['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12']
const result = (): ExecutionGTDEvidence => ({
  engine_version: 'alphaview-execution-gtd-study-v1',
  capacity_engine_version: 'alphaview-execution-volume-study-v1',
  limit_engine_version: 'alphaview-execution-limit-study-v1',
  account_id: proposal.account_id,
  account_version: 1,
  input_revision: props.currentInputRevision,
  as_of: props.currentAsOf,
  time_in_force: 'GTD',
  mode: 'advisory_ex_post',
  scenario_window: 'open_only',
  intraday_outcome: 'unknown_from_daily_bars',
  costs_included: false,
  max_sessions: 5,
  allowed_expiry_sessions: dates.map((date) => ({ date, completed: date <= props.currentAsOf })),
  source: {
    id: proposal.id,
    account_id: proposal.account_id,
    account_version: 1,
    engine_version: proposal.engine_version,
    created_at: proposal.created_at,
    status: proposal.status,
    as_of: proposal.as_of,
    input_revision: proposal.input_revision,
    proposal_fingerprint: 'c'.repeat(64),
    current: false,
    stale_reasons: ['inputs_changed', 'session_changed'],
    available: true,
    reason: null,
    share_precision: 6,
    orders: proposal.orders.map((order) => ({
      symbol: order.symbol,
      side: order.side,
      shares: order.shares,
      shares_exact: order.shares.toFixed(6),
      reference_price: order.reference_price,
    })),
  },
  method: 'SYNTHETIC GTD method; never actual fills.',
  warnings: ['Synthetic fixture, no orders.'],
  request: {
    expected_account_version: 1,
    expected_input_revision: props.currentInputRevision,
    expected_as_of: props.currentAsOf,
    expected_proposal_fingerprint: 'c'.repeat(64),
    participation_pct: 1,
    limits: [],
    gtd_date: dates[4],
  },
  gtd_date: dates[4],
  gtd_session_completed: false,
  horizon: dates.map((date) => ({ date, completed: date <= props.currentAsOf })),
  status: 'unavailable',
  coverage: {
    required_orders: 1,
    complete_orders: 0,
    unavailable_orders: 1,
    observed_prefix_orders: 1,
  },
  reason: null,
  bars_fingerprint: 'd'.repeat(64),
  evidence_fingerprint: 'e'.repeat(64),
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 30,
      shares_exact: '30.000000',
      reference_price: 100,
      status: 'unavailable',
      reason: 'execution_session_not_completed',
      limit_price: null,
      observed_prefix_end: dates[1],
      observed_prefix_scenario_shares_exact: '2.000000',
      last_known_remaining_shares_exact: '28.000000',
      final_scenario_shares_exact: null,
      expired_shares_exact: null,
      expiry_verified: false,
      expiry_state: 'unknown',
      intraday_outcome: 'unknown_from_daily_bars',
      coverage: {
        required_sessions: 5,
        evaluated_sessions: 2,
        not_required_sessions: 0,
        unknown_sessions: 3,
        complete: false,
      },
      sessions: dates.map((date, index) => ({
        date,
        session_completed: index < 2,
        status: index < 2 ? 'evaluated' : index === 2 ? 'future_unknown' : 'blocked_by_unknown',
        reason:
          index < 2
            ? null
            : index === 2
              ? 'execution_session_not_completed'
              : 'prior_evidence_unavailable',
        open_condition: index < 2 ? 'not_applied' : 'unavailable',
        raw_open: index < 2 ? 100 : null,
        session_volume: index < 2 ? 100 : null,
        remaining_before_exact: index < 3 ? `${30 - index}.000000` : null,
        capacity_shares_exact: index < 2 ? '1.000000' : null,
        scenario_shares_exact: index < 2 ? '1.000000' : null,
        remaining_after_exact: index < 2 ? `${29 - index}.000000` : null,
        reference_notional_exact: index < 2 ? '100.00000000' : null,
        intraday_outcome: 'unknown_from_daily_bars',
      })),
    },
  ],
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const loadName = 'Load GTD dates and source'
const runName = 'Study frozen-quantity GTD scenario'
const downloadName = 'Download GTD evidence JSON'
function mockApi(value = result()) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
    response(String(url).endsWith('/context') ? result() : value),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function loadAndChoose() {
  await userEvent.click(screen.getByRole('button', { name: loadName }))
  await screen.findByText(/Historical saved source/)
  fireEvent.change(screen.getByLabelText('Explicit GTD expiry session'), {
    target: { value: dates[4] },
  })
}
async function run() {
  await loadAndChoose()
  await userEvent.click(screen.getByRole('button', { name: runName }))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('multi-session GTD research', () => {
  it('requires explicit context load and an exact date before POST, preserving frozen quantities', async () => {
    const fetcher = mockApi()
    const original = JSON.stringify(proposal)
    render(<ExecutionGTDStudy {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: runName })).toHaveProperty('disabled', true)
    expect(
      screen.getByText(/not an execution model, actual fills or trading authority/),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: loadName }))
    await screen.findByText(/Historical saved source/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: runName })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Explicit GTD expiry session'), {
      target: { value: dates[4] },
    })
    await userEvent.click(screen.getByRole('button', { name: runName }))
    await screen.findByRole('button', { name: downloadName })
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(result().request)
    expect(JSON.stringify(proposal)).toBe(original)
    expect(fetcher.mock.calls[1][1]?.method).toBe('POST')
  })

  it('shows observed prefix separately from unknown final totals and never replaces gaps with zero', async () => {
    mockApi()
    render(<ExecutionGTDStudy {...props} />)
    await run()
    await screen.findByRole('heading', { name: /Some final progressions are unknown/ })
    expect(screen.getByText(/Observed-prefix scenario shares:/).textContent).toContain('2.000000')
    expect(screen.getByText(/Final scenario shares:/).textContent).toContain(
      'Final scenario shares: —',
    )
    const table = screen.getByRole('table', { name: 'SYNTA daily scenario' })
    const future = within(table).getByRole('rowheader', { name: dates[2] }).closest('tr')!
    expect(within(future).getAllByText('—')).toHaveLength(5)
    expect(future.textContent).toContain('future_unknown')
    expect(screen.getByText(/Complete \/ required orders/).textContent).toContain('0 / 1')
  })

  it('accepts an early full scenario with future GTD while explicitly declining expiry verification', async () => {
    const evidence = result()
    evidence.status = 'complete'
    evidence.coverage.complete_orders = 1
    evidence.coverage.unavailable_orders = 0
    const order = evidence.orders[0]
    Object.assign(order, {
      status: 'scenario_full',
      reason: null,
      observed_prefix_end: dates[0],
      observed_prefix_scenario_shares_exact: '30.000000',
      last_known_remaining_shares_exact: '0.000000',
      final_scenario_shares_exact: '30.000000',
      expiry_state: 'not_applicable_scenario_full',
      coverage: {
        required_sessions: 5,
        evaluated_sessions: 1,
        not_required_sessions: 4,
        unknown_sessions: 0,
        complete: true,
      },
    })
    order.sessions = order.sessions.map((step, index) =>
      index === 0
        ? {
            ...step,
            session_volume: 3000,
            capacity_shares_exact: '30.000000',
            scenario_shares_exact: '30.000000',
            remaining_after_exact: '0.000000',
            reference_notional_exact: '3000.00000000',
          }
        : {
            ...step,
            status: 'not_required_scenario_full',
            reason: 'no_scenario_remainder',
            raw_open: null,
            session_volume: null,
            open_condition: 'unavailable',
            remaining_before_exact: null,
            capacity_shares_exact: null,
            scenario_shares_exact: null,
            remaining_after_exact: null,
            reference_notional_exact: null,
          },
    )
    mockApi(evidence)
    render(<ExecutionGTDStudy {...props} />)
    await run()
    expect(
      await screen.findByRole('heading', { name: /Scenario full; expiry not verified/ }),
    ).toBeTruthy()
    expect(screen.getByText(/Scenario expired shares:/).textContent).toContain(
      'Scenario expired shares: —',
    )
    expect(screen.getByRole('button', { name: downloadName })).toBeTruthy()
  })

  it('shows scenario expiry only for an explicitly selected completed horizon', async () => {
    const evidence = result()
    Object.assign(evidence, {
      status: 'complete',
      gtd_date: dates[1],
      gtd_session_completed: true,
      horizon: evidence.horizon.slice(0, 2),
    })
    evidence.request.gtd_date = dates[1]
    evidence.coverage.complete_orders = 1
    evidence.coverage.unavailable_orders = 0
    Object.assign(evidence.orders[0], {
      status: 'partial_expired',
      reason: null,
      final_scenario_shares_exact: '2.000000',
      expired_shares_exact: '28.000000',
      expiry_verified: true,
      expiry_state: 'scenario_expired_at_gtd_close',
      sessions: evidence.orders[0].sessions.slice(0, 2),
      coverage: {
        required_sessions: 2,
        evaluated_sessions: 2,
        not_required_sessions: 0,
        unknown_sessions: 0,
        complete: true,
      },
    })
    mockApi(evidence)
    render(<ExecutionGTDStudy {...props} />)
    await loadAndChoose()
    fireEvent.change(screen.getByLabelText('Explicit GTD expiry session'), {
      target: { value: dates[1] },
    })
    await userEvent.click(screen.getByRole('button', { name: runName }))
    expect(
      await screen.findByRole('heading', { name: /Scenario partial; remainder expired/ }),
    ).toBeTruthy()
    expect(screen.getByText(/Scenario expired shares:/).textContent).toContain('28.000000')
  })

  it('retains drafts when enabled/currentness changes while permanently invalidating evidence', async () => {
    const fetcher = mockApi()
    const view = render(<ExecutionGTDStudy {...props} />)
    await run()
    await screen.findByRole('button', { name: downloadName })
    fireEvent.change(screen.getByLabelText('Daily volume participation (%)'), {
      target: { value: '2.5' },
    })
    fireEvent.change(screen.getByLabelText('SYNTA · Fixed limit (optional)'), {
      target: { value: '101.25' },
    })
    view.rerender(<ExecutionGTDStudy {...props} enabled={false} />)
    view.rerender(
      <ExecutionGTDStudy
        {...props}
        currentInputRevision="synthetic:3"
        currentAccountVersion={2}
        currentAsOf="2024-01-10"
      />,
    )
    expect(screen.getByLabelText('Daily volume participation (%)')).toHaveProperty('value', '2.5')
    expect(screen.getByLabelText('SYNTA · Fixed limit (optional)')).toHaveProperty(
      'value',
      '101.25',
    )
    expect(screen.getByLabelText('Explicit GTD expiry session')).toHaveProperty('value', dates[4])
    view.rerender(<ExecutionGTDStudy {...props} />)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(screen.getByRole('button', { name: runName })).toHaveProperty('disabled', true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('clears accepted raw evidence after an input changes away and back', async () => {
    mockApi()
    render(<ExecutionGTDStudy {...props} />)
    await run()
    await screen.findByRole('button', { name: downloadName })
    fireEvent.change(screen.getByLabelText('Daily volume participation (%)'), {
      target: { value: '2' },
    })
    fireEvent.change(screen.getByLabelText('Daily volume participation (%)'), {
      target: { value: '1' },
    })
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
  })

  it('validates blank participation, finite limits and does not submit invalid drafts', async () => {
    const fetcher = mockApi()
    render(<ExecutionGTDStudy {...props} />)
    await loadAndChoose()
    const participation = screen.getByLabelText('Daily volume participation (%)')
    fireEvent.change(participation, { target: { value: '' } })
    expect(screen.getByRole('button', { name: runName })).toHaveProperty('disabled', true)
    fireEvent.change(participation, { target: { value: '1' } })
    for (const value of ['0', '-1', 'Infinity', '1e999', '1000000000001']) {
      fireEvent.change(screen.getByLabelText('SYNTA · Fixed limit (optional)'), {
        target: { value },
      })
      expect(screen.getByRole('button', { name: runName })).toHaveProperty('disabled', true)
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('guards duplicate POST and ignores an old request after lifecycle changes without discarding drafts', async () => {
    const delayed = deferred<Response>()
    const fetcher = vi.fn((url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).endsWith('/context') ? Promise.resolve(response(result())) : delayed.promise,
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionGTDStudy {...props} />)
    await loadAndChoose()
    const button = screen.getByRole('button', { name: runName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(2)
    view.rerender(<ExecutionGTDStudy {...props} enabled={false} />)
    view.rerender(<ExecutionGTDStudy {...props} />)
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(result())))
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(screen.getByLabelText('Explicit GTD expiry session')).toHaveProperty('value', dates[4])
  })

  it('cancels and aborts on account switch with new account drafts reset', async () => {
    const delayed = deferred<Response>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionGTDStudy {...props} />)
    fireEvent.change(screen.getByLabelText('Daily volume participation (%)'), {
      target: { value: '12' },
    })
    fireEvent.click(screen.getByRole('button', { name: loadName }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel waiting' }))
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: loadName }))
    view.rerender(<ExecutionGTDStudy {...props} accountId={'f'.repeat(32)} />)
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
    expect(screen.getByLabelText('Daily volume participation (%)')).toHaveProperty('value', '1')
    await act(async () => delayed.resolve(response(result())))
    expect(screen.queryByText(/Historical saved source/)).toBeNull()
  })

  it('clears evidence on pagehide while preserving unsent dates and participation', async () => {
    mockApi()
    render(<ExecutionGTDStudy {...props} />)
    await run()
    await screen.findByRole('button', { name: downloadName })
    act(() => window.dispatchEvent(new Event('pagehide')))
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(screen.getByLabelText('Explicit GTD expiry session')).toHaveProperty('value', dates[4])
    expect(screen.getByLabelText('Daily volume participation (%)')).toHaveProperty('value', '1')
  })

  it('downloads exact server JSON including whole floats, negative zero and Unicode without another request', async () => {
    const raw = JSON.stringify(result()).replace(
      /}$/,
      ',"future":{"whole":1.0,"zero":-0.0,"exponent":1e-07,"text":"合成\\u0020情境","missing":null}}\n',
    )
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/context') ? response(result()) : new Response(raw),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionGTDStudy {...props} />)
    await run()
    const button = await screen.findByRole('button', { name: downloadName })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:gtd')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    let revoke: (() => void) | undefined
    const timeout = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
      if (delay !== 10000) return timeout(callback, delay)
      revoke = callback as () => void
      return 1
    })
    fireEvent.click(button)
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(text).toBe(raw)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(filename).toMatch(/^alphaview-gtd-study-[a-zA-Z0-9_-]+\.json$/)
    expect(document.querySelector('a[download]')).toBeNull()
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gtd')
  })

  it.each(['source', 'request', 'expiry', 'aggregate', 'unknown-total'] as const)(
    'rejects inconsistent %s evidence rather than displaying false certainty',
    async (change) => {
      const evidence = result()
      if (change === 'source') evidence.input_revision = 'different'
      if (change === 'request') evidence.request.gtd_date = dates[0]
      if (change === 'expiry') evidence.orders[0].expiry_verified = true
      if (change === 'aggregate') evidence.status = 'complete'
      if (change === 'unknown-total') evidence.orders[0].final_scenario_shares_exact = '0.000000'
      mockApi(evidence)
      render(<ExecutionGTDStudy {...props} />)
      await run()
      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    },
  )

  it('shows 409 without false success and keeps draft values', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/context')
        ? response(result())
        : response({ detail: { code: 'study_context_changed' } }, 409),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionGTDStudy {...props} />)
    await run()
    expect((await screen.findByRole('alert')).textContent).toContain('input drafts are preserved')
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(screen.getByLabelText('Explicit GTD expiry session')).toHaveProperty('value', dates[4])
  })
})
