import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionLimitStudy, type ExecutionLimitEvidence } from './ExecutionLimitStudy'
import type { PaperProposal } from './paper-model'

const t = (_zh: string, en: string) => en
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
  orders: [
    { symbol: 'SYNTA', side: 'buy', shares: 30, reference_price: 100 },
    { symbol: 'SYNTB', side: 'sell', shares: 20, reference_price: 50 },
  ],
} as PaperProposal
const props = {
  accountId: proposal.account_id,
  proposal,
  currentAccountVersion: 1,
  currentInputRevision: 'synthetic:2',
  currentAsOf: '2024-01-08',
  t,
}
const result = (): ExecutionLimitEvidence => ({
  engine_version: 'alphaview-execution-limit-study-v1',
  capacity_engine_version: 'alphaview-execution-volume-study-v1',
  scenario_window: 'open_only',
  intraday_outcome: 'unknown_from_daily_bars',
  costs_included: false,
  account_id: proposal.account_id,
  account_version: 1,
  input_revision: 'synthetic:2',
  as_of: '2024-01-08',
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
    skipped_orders_count: 1,
    orders: proposal.orders.map((row) => ({
      symbol: row.symbol,
      side: row.side,
      shares: row.shares,
      shares_exact: row.shares.toFixed(6),
      reference_price: row.reference_price,
    })),
  },
  execution_session: '2024-01-08',
  session_completed: true,
  time_in_force: 'DAY',
  mode: 'advisory_ex_post',
  method: 'Synthetic saved capacity method; full-day volume is unknown at the open.',
  warnings: [],
  request: {
    expected_account_version: 1,
    expected_input_revision: 'synthetic:2',
    expected_as_of: '2024-01-08',
    expected_proposal_fingerprint: 'c'.repeat(64),
    participation_pct: 1,
    limits: [],
  },
  bars_fingerprint: 'd'.repeat(64),
  status: 'incomplete',
  coverage: { required: 2, available: 1, unavailable: 1 },
  reason: null,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 30,
      shares_exact: '30.000000',
      reference_price: 100,
      status: 'partial_expired',
      reason: null,
      limit_price: null,
      limit_price_exact: null,
      limit_supplied: false,
      open_condition: 'not_applied',
      intraday_outcome: 'unknown_from_daily_bars',
      raw_open: 110,
      session_volume: 1000,
      capacity_shares: 10,
      scenario_shares: 10,
      expired_shares: 20,
      fill_fraction_pct: 100 / 3,
      reference_notional: 1100,
    },
    {
      symbol: 'SYNTB',
      side: 'sell',
      shares: 20,
      shares_exact: '20.000000',
      reference_price: 50,
      status: 'unavailable',
      reason: 'missing_execution_bar',
      limit_price: null,
      limit_price_exact: null,
      limit_supplied: false,
      open_condition: 'unavailable',
      intraday_outcome: 'unknown_from_daily_bars',
      raw_open: null,
      session_volume: null,
      capacity_shares: null,
      scenario_shares: null,
      expired_shares: null,
      fill_fraction_pct: null,
      reference_notional: null,
    },
  ],
})
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
function mockStudy(value = result()) {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(value))
    .mockImplementationOnce(() => response(value))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function run() {
  await userEvent.click(screen.getByRole('button', { name: 'Study saved proposal limit scenario' }))
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saved proposal open-only limit evidence', () => {
  it('downloads the accepted raw study text, preserving float syntax, nulls and future fields', async () => {
    const raw = JSON.stringify(result()).replace(
      /}$/,
      ',"future":{"float":1.0,"negative_zero":-0.0,"exponent":1e-07,"missing":null}}\n',
    )
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:raw-limit')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    let release: (() => void) | undefined
    const timer = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 10000 && typeof callback === 'function') {
        release = () => callback(...args)
        return 123
      }
      return timer(callback, delay, ...args)
    })
    const view = render(<ExecutionLimitStudy {...props} />)
    await run()
    const button = await screen.findByRole('button', {
      name: 'Download limit scenario evidence JSON',
    })
    fireEvent.click(button)
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(downloaded).toBe(raw)
    expect(filename).toBe(
      `alphaview-limit-study-${proposal.account_id}-${proposal.id}-${props.currentAsOf}.json`,
    )
    expect(document.querySelector('a[download]')).toBeNull()
    expect(release).toBeTruthy()
    release?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:raw-limit')
    expect(fetcher).toHaveBeenCalledTimes(2)
    view.rerender(<ExecutionLimitStudy {...props} accountId={'e'.repeat(32)} />)
    expect(
      screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' }),
    ).toBeNull()
    fireEvent.click(button)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('rejects nonfinite raw values during export and clears export while replacing evidence', async () => {
    const raw = JSON.stringify(result()).replace(/}$/, ',"future":1e999}')
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    render(<ExecutionLimitStudy {...props} />)
    await run()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download limit scenario evidence JSON' }),
    )
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Limit scenario evidence download failed',
    )
    expect(createObjectURL).not.toHaveBeenCalled()
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    await run()
    expect(
      screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' }),
    ).toBeNull()
  })

  it('is explicit, binds the request and shows partial expiry, nulls and historical source scope', async () => {
    const fetcher = mockStudy()
    render(<ExecutionLimitStudy {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/Full-day volume is an ex-post capacity proxy/)).toBeTruthy()
    await run()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/paper/accounts/${proposal.account_id}/proposals/${proposal.id}/limit-study/context`,
    )
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]).getByText('Scenario partial; remainder expired')).toBeTruthy()
    expect(within(rows[1]).getByText('30.000000')).toBeTruthy()
    expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
    expect(within(rows[2]).getByText(/Exact execution-day bar is missing/)).toBeTruthy()
    expect(screen.getByText(/Evidence coverage.*1 \/ 2/)).toBeTruthy()
    expect(screen.getByText(/Historical proposal: original quantities/)).toBeTruthy()
    expect(screen.getByText('c'.repeat(64))).toBeTruthy()
    expect(
      fetcher.mock.calls.every(
        ([, options]) => !options?.body || JSON.parse(options.body).participation_pct === 1,
      ),
    ).toBe(true)
  })

  it('guards a double click synchronously and aborts an account-switched pending response', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionLimitStudy {...props} />)
    const button = screen.getByRole('button', { name: 'Study saved proposal limit scenario' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(<ExecutionLimitStudy {...props} accountId={'e'.repeat(32)} />)
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(await response(result())))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('table')).toBeNull()
  })

  it.each(['revision', 'version', 'proposal', 'enabled'] as const)(
    'invalidates old evidence when %s changes',
    async (kind) => {
      mockStudy()
      const view = render(<ExecutionLimitStudy {...props} />)
      await run()
      await screen.findByRole('table')
      const changed = {
        ...props,
        ...(kind === 'revision' ? { currentInputRevision: 'synthetic:3' } : {}),
        ...(kind === 'version' ? { currentAccountVersion: 2 } : {}),
        ...(kind === 'proposal' ? { proposal: { ...proposal, id: 'e'.repeat(32) } } : {}),
        ...(kind === 'enabled' ? { enabled: false } : {}),
      }
      view.rerender(<ExecutionLimitStudy {...changed} />)
      expect(screen.queryByRole('table')).toBeNull()
      view.rerender(<ExecutionLimitStudy {...props} />)
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('clears evidence on cap changes and rejects empty or out-of-range caps without a request', async () => {
    const fetcher = mockStudy()
    render(<ExecutionLimitStudy {...props} />)
    await run()
    await screen.findByRole('table')
    const input = screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' })
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      (
        screen.getByRole('button', {
          name: 'Study saved proposal limit scenario',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.change(input, { target: { value: '101' } })
    expect(
      (
        screen.getByRole('button', {
          name: 'Study saved proposal limit scenario',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not revive evidence after a hidden-tab lifecycle change', async () => {
    const fetcher = mockStudy()
    render(<ExecutionLimitStudy {...props} />)
    await run()
    await screen.findByRole('table')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.queryByRole('table')).toBeNull()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('table')).toBeNull()
    visibility.mockRestore()
  })

  it.each(['account', 'orders', 'version'] as const)(
    'rejects a mismatching server %s context before POST',
    async (kind) => {
      const value = result()
      if (kind === 'account') value.account_id = 'e'.repeat(32)
      if (kind === 'orders') value.source.orders[0].shares = 99
      if (kind === 'version') value.account_version = 2
      const fetcher = mockStudy(value)
      render(<ExecutionLimitStudy {...props} />)
      await run()
      expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('409 during study clears any previous result and never reports success', async () => {
    const fetcher = mockStudy()
    render(<ExecutionLimitStudy {...props} />)
    await run()
    await screen.findByRole('table')
    fetcher
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() => response({ detail: { code: 'study_context_changed' } }, 409))
    await run()
    expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('rejects a result with another fingerprint or participation hypothesis', async () => {
    const changed = result()
    changed.request.participation_pct = 10
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() => response(changed))
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionLimitStudy {...props} />)
    await run()
    expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders an observed zero as zero while missing evidence remains unavailable', async () => {
    const value = result()
    Object.assign(value.orders[0], {
      status: 'unfilled_expired',
      session_volume: 0,
      capacity_shares: 0,
      scenario_shares: 0,
      expired_shares: 30,
      fill_fraction_pct: 0,
      reference_notional: 0,
    })
    mockStudy(value)
    render(<ExecutionLimitStudy {...props} />)
    await run()
    const rows = within(await screen.findByRole('table')).getAllByRole('row')
    expect(within(rows[1]).getByText('Scenario unfilled; all expired')).toBeTruthy()
    expect(within(rows[1]).getAllByText('0.000000')).toHaveLength(3)
    expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
  })
})

it('binds optional per-symbol limits and clearly separates a nonmarketable scenario zero from missing evidence', async () => {
  const value = result()
  value.request.limits = [{ symbol: 'SYNTA', limit_price: 100 }]
  Object.assign(value.orders[0], {
    limit_price: 100,
    limit_price_exact: '100',
    limit_supplied: true,
    open_condition: 'not_satisfied',
    status: 'not_marketable_at_open_expired',
    reason: 'open_does_not_meet_limit',
    scenario_shares: 0,
    expired_shares: 30,
    fill_fraction_pct: 0,
    reference_notional: 0,
  })
  const fetcher = mockStudy(value)
  render(<ExecutionLimitStudy {...props} />)
  expect(screen.getByText(/A blank limit means no price restriction/)).toBeTruthy()
  await userEvent.type(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), '100')
  await run()
  expect(JSON.parse(fetcher.mock.calls[1][1].body).limits).toEqual([
    { symbol: 'SYNTA', limit_price: 100 },
  ])
  const rows = within(await screen.findByRole('table')).getAllByRole('row')
  expect(
    within(rows[1]).getByText(/Open fails limit; all expire in this scenario only/),
  ).toBeTruthy()
  expect(within(rows[1]).getAllByText('0.000000')).toHaveLength(1)
  expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
  expect(screen.getByText(/Actual intraday outcomes are unknown for every row/)).toBeTruthy()
})

it.each(['0', '-1', 'NaN', '1e999', '1000000000001', 'not-a-price', '0x10', '1,000'])(
  'rejects invalid optional limit %s without treating it as a blank no-limit instruction',
  async (input) => {
    const fetcher = mockStudy()
    render(<ExecutionLimitStudy {...props} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
      target: { value: input },
    })
    expect(
      (
        screen.getByRole('button', {
          name: 'Study saved proposal limit scenario',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Correct the limits')
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it('clears old result and download when an optional limit changes; clearing the field restores explicit no-limit semantics', async () => {
  const fetcher = mockStudy()
  render(<ExecutionLimitStudy {...props} />)
  await run()
  await screen.findByRole('button', { name: 'Download limit scenario evidence JSON' })
  fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
    target: { value: '110' },
  })
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
    target: { value: '' },
  })
  fetcher
    .mockImplementationOnce(() => response(result()))
    .mockImplementationOnce(() => response(result()))
  await run()
  expect(JSON.parse(fetcher.mock.calls[3][1].body).limits).toEqual([])
})

it('rejects a response that used a different limit hypothesis', async () => {
  const changed = result()
  changed.request.limits = [{ symbol: 'SYNTA', limit_price: 110 }]
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(result()))
    .mockImplementationOnce(() => response(changed))
  vi.stubGlobal('fetch', fetcher)
  render(<ExecutionLimitStudy {...props} />)
  await run()
  expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
  expect(screen.queryByRole('table')).toBeNull()
})

it('preserves a positive tiny limit instead of rounding its display to zero', async () => {
  const value = result()
  value.request.limits = [{ symbol: 'SYNTA', limit_price: 0.000000001 }]
  Object.assign(value.orders[0], {
    limit_price: 0.000000001,
    limit_price_exact: '1E-9',
    limit_supplied: true,
    open_condition: 'not_satisfied',
    status: 'not_marketable_at_open_expired',
    reason: 'open_does_not_meet_limit',
    scenario_shares: 0,
    expired_shares: 30,
    fill_fraction_pct: 0,
    reference_notional: 0,
  })
  mockStudy(value)
  render(<ExecutionLimitStudy {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
    target: { value: '1e-9' },
  })
  await run()
  expect(within(await screen.findByRole('table')).getByText(/1E-9 · Not met/)).toBeTruthy()
})

it.each(['enabled', 'version', 'revision', 'session', 'proposal_refresh'] as const)(
  'preserves unsent participation and limit drafts through same-proposal %s refresh',
  (change) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionLimitStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      {
        target: { value: '7.25' },
      },
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
      target: { value: '99.2500' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'SYNTB Limit price' }), {
      target: { value: 'invalid draft' },
    })
    const next = {
      ...props,
      ...(change === 'enabled' ? { enabled: false } : {}),
      ...(change === 'version' ? { currentAccountVersion: 2 } : {}),
      ...(change === 'revision' ? { currentInputRevision: 'synthetic:3' } : {}),
      ...(change === 'session' ? { currentAsOf: '2024-01-09' } : {}),
      ...(change === 'proposal_refresh' ? { proposal: { ...proposal, executable: false } } : {}),
    }
    view.rerender(<ExecutionLimitStudy {...next} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '7.25')
    expect(screen.getByRole('textbox', { name: 'SYNTA Limit price' })).toHaveProperty(
      'value',
      '99.2500',
    )
    expect(screen.getByRole('textbox', { name: 'SYNTB Limit price' })).toHaveProperty(
      'value',
      'invalid draft',
    )
    view.rerender(<ExecutionLimitStudy {...props} />)
    expect(screen.getByRole('textbox', { name: 'SYNTA Limit price' })).toHaveProperty(
      'value',
      '99.2500',
    )
    expect(screen.getByRole('textbox', { name: 'SYNTB Limit price' })).toHaveProperty(
      'value',
      'invalid draft',
    )
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it.each(['account', 'proposal'] as const)(
  'resets drafts only on an actual %s scope switch',
  (change) => {
    vi.stubGlobal('fetch', vi.fn())
    const view = render(<ExecutionLimitStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      { target: { value: '7.25' } },
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'SYNTA Limit price' }), {
      target: { value: '99.2500' },
    })
    const changed = {
      ...props,
      ...(change === 'account'
        ? { accountId: 'e'.repeat(32) }
        : { proposal: { ...proposal, id: 'e'.repeat(32) } }),
    }
    view.rerender(<ExecutionLimitStudy {...changed} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '1')
    expect(screen.getByRole('textbox', { name: 'SYNTA Limit price' })).toHaveProperty('value', '')
    view.rerender(<ExecutionLimitStudy {...props} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '1')
  },
)

it.each([
  ['context', 'success'],
  ['context', 'error'],
  ['result', 'success'],
  ['result', 'error'],
] as const)(
  'discards late %s %s after source changes away and back without losing the participation draft',
  async (stage, outcome) => {
    let finish!: (value: Response) => void
    let fail!: (reason: Error) => void
    const pending = new Promise<Response>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const value = result()
    value.request.participation_pct = 7.25
    const fetcher = vi.fn()
    if (stage === 'result') fetcher.mockImplementationOnce(() => response(value))
    fetcher.mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionLimitStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      { target: { value: '7.25' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal limit scenario' }))
    const calls = stage === 'context' ? 1 : 2
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(calls))
    const signal = fetcher.mock.calls[calls - 1][1].signal as AbortSignal
    view.rerender(<ExecutionLimitStudy {...props} currentInputRevision="synthetic:changed" />)
    view.rerender(<ExecutionLimitStudy {...props} />)
    expect(signal.aborted).toBe(true)
    await act(async () => {
      if (outcome === 'success') finish(await response(value))
      else fail(new Error('Old async failure'))
    })
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '7.25')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' }),
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(fetcher).toHaveBeenCalledTimes(calls)
    fetcher
      .mockImplementationOnce(() => response(value))
      .mockImplementationOnce(() => response(value))
    await run()
    await screen.findByRole('table')
    expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
      'disabled',
      false,
    )
  },
)

it('does not revive a pending result when the draft changes away and back', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(result()))
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  render(<ExecutionLimitStudy {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal limit scenario' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const signal = fetcher.mock.calls[1][1].signal as AbortSignal
  const input = screen.getByRole('textbox', { name: 'SYNTA Limit price' })
  fireEvent.change(input, { target: { value: '100' } })
  fireEvent.change(input, { target: { value: '' } })
  expect(signal.aborted).toBe(true)
  await act(async () => finish(await response(result())))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
})

it('keeps historical receipt controls mounted and readable while accepted evidence is invalidated', async () => {
  const fetcher = mockStudy()
  const view = render(<ExecutionLimitStudy {...props} />)
  const historySection = screen.getByRole('region', { name: 'Execution study receipts' })
  const historyButton = within(historySection).getByRole('button', { name: 'Load study receipts' })
  await run()
  await screen.findByRole('table')
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
  const oldDownload = screen.getByRole('button', { name: 'Download limit scenario evidence JSON' })
  const createObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  view.rerender(<ExecutionLimitStudy {...props} enabled={false} />)
  expect(screen.getByRole('region', { name: 'Execution study receipts' })).toBe(historySection)
  expect(screen.getByRole('button', { name: 'Load study receipts' })).toBe(historyButton)
  expect(historyButton).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(oldDownload)
  expect(createObjectURL).not.toHaveBeenCalled()
  fetcher.mockImplementationOnce(() =>
    response({
      account_id: props.accountId,
      proposal_id: proposal.id,
      kind: 'limit_day',
      items: [],
      pagination: { limit: 20, offset: 0, total: 0, returned: 0 },
      checked_as_of: '2026-10-01',
      checked_input_revision: 'synthetic:2',
    }),
  )
  fireEvent.click(historyButton)
  expect(await screen.findByText('This proposal has no receipts of this study kind')).toBeTruthy()
  expect(fetcher.mock.calls[2][0]).toContain('/study-receipts?kind=limit_day')
  view.rerender(<ExecutionLimitStudy {...props} />)
  expect(screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
})

it('preserves the participation draft but withdraws evidence for same-ID proposal content changes and reversion', async () => {
  const value = result()
  value.request.participation_pct = 7.25
  const fetcher = mockStudy(value)
  const view = render(<ExecutionLimitStudy {...props} />)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }), {
    target: { value: '7.25' },
  })
  await run()
  await screen.findByRole('table')
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
  view.rerender(
    <ExecutionLimitStudy
      {...props}
      proposal={{
        ...proposal,
        orders: proposal.orders.map((order, index) => (index ? order : { ...order, shares: 31 })),
      }}
    />,
  )
  expect(screen.queryByRole('table')).toBeNull()
  expect(
    screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
  ).toHaveProperty('value', '7.25')
  view.rerender(<ExecutionLimitStudy {...props} />)
  expect(screen.queryByRole('button', { name: 'Download limit scenario evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('ignores old async failure without clearing a newer request in progress', async () => {
  let rejectOld!: (error: Error) => void
  let finishNewContext!: (value: Response) => void
  const old = new Promise<Response>((_resolve, reject) => {
    rejectOld = reject
  })
  const next = new Promise<Response>((resolve) => {
    finishNewContext = resolve
  })
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(result()))
    .mockReturnValueOnce(old)
    .mockReturnValueOnce(next)
    .mockImplementationOnce(() => response(result()))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<ExecutionLimitStudy {...props} />)
  await run()
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  view.rerender(<ExecutionLimitStudy {...props} enabled={false} />)
  view.rerender(<ExecutionLimitStudy {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal limit scenario' }))
  expect(fetcher).toHaveBeenCalledTimes(3)
  await act(async () => rejectOld(new Error('Superseded study failure')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true)
  await act(async () => finishNewContext(await response(result())))
  await screen.findByRole('table')
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
})
