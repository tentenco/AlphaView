import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PortfolioCircuitBreakers,
  type BreakerEvent,
  type BreakerStatus,
} from './PortfolioCircuitBreakers'
import type { PaperAccount } from './paper-model'

afterEach(() => vi.unstubAllGlobals())

const account: PaperAccount = {
  id: 'synthetic-breaker-account',
  name: 'Synthetic breaker account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 7000,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
function status(extra: Partial<BreakerStatus> = {}): BreakerStatus {
  return {
    engine_version: 'alphaview-circuit-breaker-v1',
    account_id: account.id,
    account_version: 3,
    kill_switch: false,
    as_of: '2026-09-29',
    policy: {
      daily_loss_limit_pct: null,
      max_drawdown_pct: null,
      max_fills_per_session: null,
      auto_pause: true,
      reduce_only_allowed: false,
    },
    policy_version: 1,
    checks: [
      {
        code: 'daily_loss',
        label: '每日虧損上限',
        enabled: false,
        observed: null,
        limit: null,
        status: 'disabled',
        reason: null,
        detail: {},
      },
      {
        code: 'max_drawdown',
        label: '最大回撤上限',
        enabled: false,
        observed: null,
        limit: null,
        status: 'disabled',
        reason: null,
        detail: {},
      },
      {
        code: 'max_fills_per_session',
        label: '單日成交筆數上限',
        enabled: false,
        observed: 0,
        limit: null,
        status: 'disabled',
        reason: null,
        detail: { fills: 0 },
      },
    ],
    tripped: false,
    tripped_codes: [],
    unavailable: [],
    valuation_complete: true,
    input_revision: 'synthetic:1',
    method: 'Synthetic method.',
    warnings: ['Synthetic warning.'],
    ...extra,
  }
}
const tripped = status({
  policy: {
    daily_loss_limit_pct: 5,
    max_drawdown_pct: null,
    max_fills_per_session: null,
    auto_pause: true,
    reduce_only_allowed: false,
  },
  policy_version: 2,
  checks: [
    {
      code: 'daily_loss',
      label: '每日虧損上限',
      enabled: true,
      observed: -6.25,
      limit: 5,
      status: 'tripped',
      reason: null,
      detail: { reference_as_of: '2026-09-26' },
    },
    {
      code: 'max_drawdown',
      label: '最大回撤上限',
      enabled: true,
      observed: null,
      limit: 10,
      status: 'unavailable',
      reason: 'no_nav_snapshot',
      detail: {},
    },
    {
      code: 'max_fills_per_session',
      label: '單日成交筆數上限',
      enabled: false,
      observed: 1,
      limit: null,
      status: 'disabled',
      reason: null,
      detail: { fills: 1 },
    },
  ],
  tripped: true,
  tripped_codes: ['daily_loss'],
  unavailable: ['max_drawdown'],
})
const events: BreakerEvent[] = [
  {
    id: 'event-1',
    kind: 'tripped',
    session_date: '2026-09-29',
    reason_code: 'daily_loss',
    evidence: { trigger: 'manual' },
    account_version_before: 3,
    account_version_after: 4,
    created_at: '2026-09-30T00:00:00Z',
  },
]
const response = (body: unknown, ok = true, code = 200) => ({
  ok,
  status: code,
  json: async () => body,
})
function mockApi(
  options: { initial?: BreakerStatus; evaluate?: BreakerStatus; put?: unknown } = {},
) {
  // Stateful like the backend: later GETs return whatever the last write produced.
  let current: BreakerStatus = options.initial || status()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const base = `/api/paper/accounts/${account.id}/circuit-breakers`
    if (url === base && (!init?.method || init.method === 'GET')) return response(current)
    if (url === base && init?.method === 'PUT') {
      if (options.put !== undefined) return options.put
      current = status({ policy: JSON.parse(String(init.body)).policy, policy_version: 2 })
      return response(current)
    }
    if (url === `${base}/evaluate`) {
      current = options.evaluate || { ...tripped, paused_now: true, kill_switch: true }
      return response(current)
    }
    if (url.startsWith(`${base}/events`)) return response({ events })
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const putBody = (fetcher: ReturnType<typeof mockApi>) =>
  JSON.parse(
    String(
      fetcher.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT')?.[1]?.body,
    ),
  )

describe('circuit breakers panel', () => {
  it('shows the default policy, validates limits and saves with the stored version', async () => {
    const fetcher = mockApi()
    render(<PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />)
    const panel = await screen.findByRole('region', { name: 'Circuit breakers' })
    await within(panel).findByText('Armed')
    expect(within(panel).getAllByText('Off')).toHaveLength(3)
    const daily = within(panel).getByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
    fireEvent.change(daily, { target: { value: '0.01' } })
    expect(within(panel).getByRole('alert').textContent).toMatch(/Daily loss must be 0.1–50/)
    expect(
      (within(panel).getByRole('button', { name: 'Save breaker policy' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.change(daily, { target: { value: '5' } })
    fireEvent.change(within(panel).getByLabelText('Fills per session limit (1–100, blank = off)'), {
      target: { value: '3' },
    })
    await userEvent.click(
      within(panel).getByLabelText('Pause the account automatically when tripped'),
    )
    await userEvent.click(within(panel).getByRole('button', { name: 'Save breaker policy' }))
    await within(panel).findByText('Breaker policy saved.')
    expect(putBody(fetcher)).toEqual({
      policy: {
        daily_loss_limit_pct: 5,
        max_drawdown_pct: null,
        max_fills_per_session: 3,
        auto_pause: false,
        reduce_only_allowed: false,
      },
      expected_version: 1,
    })
    expect(within(panel).getByText('Policy version 2')).toBeTruthy()
  })

  it('evaluates on demand, reports the trip in English and notifies the account change', async () => {
    const onAccountChanged = vi.fn()
    mockApi({ initial: tripped })
    render(
      <PortfolioCircuitBreakers
        account={account}
        locale="en"
        onAccountChanged={onAccountChanged}
      />,
    )
    const panel = await screen.findByRole('region', { name: 'Circuit breakers' })
    await within(panel).findByText('Tripped')
    expect(within(panel).getByText('-6.25%')).toBeTruthy()
    expect(within(panel).getByText(/Limit ≤ −5%/)).toBeTruthy()
    expect(within(panel).getByText(/No captured NAV snapshot yet/)).toBeTruthy()
    expect(within(panel).getByText('Tripped and paused')).toBeTruthy()
    await userEvent.click(within(panel).getByRole('button', { name: 'Evaluate now' }))
    await within(panel).findByText('A breaker tripped; the account was paused.')
    await waitFor(() => expect(onAccountChanged).toHaveBeenCalledTimes(1))
    expect(within(panel).getByText(/Account paused/)).toBeTruthy()
  })

  it('surfaces a version conflict from the backend without losing the draft', async () => {
    mockApi({
      put: response({ detail: { code: 'policy_changed', message: '設定已更新' } }, false, 409),
    })
    render(<PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />)
    const panel = await screen.findByRole('region', { name: 'Circuit breakers' })
    await within(panel).findByText('Armed')
    const drawdown = within(panel).getByLabelText('Max drawdown limit (%, 1–90, blank = off)')
    fireEvent.change(drawdown, { target: { value: '12' } })
    await userEvent.click(within(panel).getByRole('button', { name: 'Save breaker policy' }))
    await within(panel).findByText(
      'The breaker policy changed in another window. Reload before saving.',
    )
    expect((drawdown as HTMLInputElement).value).toBe('12')
  })
})

function draftApi() {
  const values = new Map<string, BreakerStatus>([
    [account.id, status({ policy: { ...status().policy, daily_loss_limit_pct: 10 } })],
  ])
  let loadFailure = false
  let nextConflict = false
  let holdSave = false
  let finishSave = () => {}
  let saveGate = Promise.resolve()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
    })
    if (url.includes('/events')) return reply({ events: [] })
    const current = values.get(url.split('/')[4])!
    if (init?.method === 'PUT') {
      if (nextConflict) {
        nextConflict = false
        return reply({ detail: { code: 'policy_changed', message: '設定已更新' } }, 409)
      }
      const body = JSON.parse(String(init.body))
      if (holdSave) await saveGate
      const updated = {
        ...current,
        policy: body.policy,
        policy_version: current.policy_version + 1,
      }
      values.set(current.account_id, updated)
      return reply(updated)
    }
    if (loadFailure) return reply({ detail: 'Synthetic policy unavailable' }, 503)
    return reply(current)
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    fetcher,
    current: () => values.get(account.id)!,
    set: (value: BreakerStatus) => values.set(value.account_id, value),
    failLoads: (value: boolean) => {
      loadFailure = value
    },
    conflict: () => {
      nextConflict = true
    },
    hold: () => {
      holdSave = true
      saveGate = new Promise<void>((resolve) => {
        finishSave = resolve
      })
    },
    release: () => {
      holdSave = false
      finishSave()
    },
  }
}
const draftInput = () =>
  screen.getByLabelText('Daily loss limit (%, 0.1–50, blank = off)') as HTMLInputElement
const saveButton = () =>
  screen.getByRole('button', { name: 'Save breaker policy' }) as HTMLButtonElement
const changedNotice = /The account or policy changed while you were editing/

it('preserves dirty policy edits through account and policy refreshes until explicitly reloaded', async () => {
  const api = draftApi()
  const view = render(
    <PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />,
  )
  await screen.findByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.set({ ...api.current(), account_version: account.version + 1 })
  view.rerender(
    <PortfolioCircuitBreakers
      account={{ ...account, version: account.version + 1 }}
      locale="en"
      onAccountChanged={vi.fn()}
    />,
  )
  await screen.findByText(changedNotice)
  expect(draftInput().value).toBe('22')
  expect(saveButton().disabled).toBe(true)

  const external = structuredClone(api.current())
  external.policy.daily_loss_limit_pct = 18
  external.policy_version += 1
  external.account_version += 1
  api.set(external)
  view.rerender(
    <PortfolioCircuitBreakers
      account={{ ...account, version: external.account_version }}
      locale="en"
      onAccountChanged={vi.fn()}
    />,
  )
  await waitFor(() =>
    expect(
      api.fetcher.mock.calls.filter(([, init]) => !init?.method).length,
    ).toBeGreaterThanOrEqual(3),
  )
  expect(draftInput().value).toBe('22')
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(saveButton().disabled).toBe(false)
  expect(screen.queryByText(changedNotice)).toBeNull()

  const cleanUpdate = structuredClone(external)
  cleanUpdate.policy.daily_loss_limit_pct = 16
  cleanUpdate.policy_version += 1
  cleanUpdate.account_version += 1
  api.set(cleanUpdate)
  view.rerender(
    <PortfolioCircuitBreakers
      account={{ ...account, version: cleanUpdate.account_version }}
      locale="en"
      onAccountChanged={vi.fn()}
    />,
  )
  await waitFor(() => expect(draftInput().value).toBe('16'))
  expect(screen.queryByText('You have unsaved changes.')).toBeNull()
})

it('retains a rejected draft and its version through 409 and failed reload, then loads current policy', async () => {
  const api = draftApi()
  render(<PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />)
  await screen.findByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
  const originalVersion = api.current().policy_version
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.conflict()
  await userEvent.click(saveButton())
  await screen.findByText(changedNotice)
  const put = api.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(JSON.parse(String(put?.[1]?.body)).expected_version).toBe(originalVersion)
  expect(draftInput().value).toBe('22')
  expect(saveButton().disabled).toBe(true)
  api.failLoads(true)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await screen.findByText('Synthetic policy unavailable')
  expect(draftInput().value).toBe('22')
  expect(saveButton().disabled).toBe(true)
  const current = structuredClone(api.current())
  current.policy.daily_loss_limit_pct = 18
  current.policy_version += 1
  api.set(current)
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(saveButton().disabled).toBe(false)
})

it('keeps edits made during save and uses the acknowledged version on the next save', async () => {
  const api = draftApi()
  render(<PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />)
  await screen.findByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
  const originalVersion = api.current().policy_version
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  fireEvent.change(draftInput(), { target: { value: '24' } })
  await act(async () => api.release())
  await screen.findByText('Breaker policy saved.')
  expect(draftInput().value).toBe('24')
  expect(screen.getByText('You have unsaved changes.')).toBeTruthy()
  await userEvent.click(saveButton())
  await waitFor(() =>
    expect(api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2),
  )
  const writes = api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')
  const second = JSON.parse(String(writes[1][1]?.body))
  expect(second.expected_version).toBe(originalVersion + 1)
  expect(second.policy.daily_loss_limit_pct).toBe(24)
  await waitFor(() => expect(screen.queryByText('You have unsaved changes.')).toBeNull())
})

it('isolates an account switch from the prior account draft and pending save response', async () => {
  const api = draftApi()
  const view = render(
    <PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />,
  )
  await screen.findByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  const pending = api.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]
  const other = { ...account, id: 'synthetic-other-risk-account' }
  const otherState = structuredClone(api.current())
  otherState.account_id = other.id
  otherState.policy.daily_loss_limit_pct = 18
  api.set(otherState)
  view.rerender(<PortfolioCircuitBreakers account={other} locale="en" onAccountChanged={vi.fn()} />)
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(pending?.signal?.aborted).toBe(true)
  fireEvent.change(draftInput(), { target: { value: '26' } })
  await act(async () => api.release())
  expect(draftInput().value).toBe('26')
  expect(screen.queryByText('Breaker policy saved.')).toBeNull()
  expect(api.fetcher.mock.calls.some(([url]) => url.includes(other.id))).toBe(true)
})

it('does not offer a default policy as server truth after a failed initial load and can retry', async () => {
  const api = draftApi()
  api.failLoads(true)
  render(<PortfolioCircuitBreakers account={account} locale="en" onAccountChanged={vi.fn()} />)
  await screen.findByText('Synthetic policy unavailable')
  expect(screen.queryByLabelText('Daily loss limit (%, 0.1–50, blank = off)')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save breaker policy' })).toBeNull()
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await screen.findByLabelText('Daily loss limit (%, 0.1–50, blank = off)')
  expect(saveButton().disabled).toBe(false)
})
