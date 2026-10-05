import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioPositionStops, type StopsState } from './PortfolioPositionStops'
import type { PaperAccount } from './paper-model'

afterEach(() => vi.unstubAllGlobals())

const account: PaperAccount = {
  id: 'synthetic-stops-account',
  name: 'Synthetic',
  currency: 'USD',
  initial_cash: 10000,
  cash: 4000,
  version: 2,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const state = (tripped: string[]): StopsState => ({
  engine_version: 'alphaview-position-stops-v1',
  account_id: account.id,
  account_version: 2,
  as_of: '2026-09-29',
  policy: { enabled: true, stop_loss_pct: 10, trailing_stop_pct: 8, cooldown_sessions: 2 },
  policy_version: 1,
  holdings: [
    {
      symbol: 'SYNTA',
      shares: 30,
      average_cost: 100,
      close: 118,
      entry_session: '2026-09-01',
      peak_close: 130,
      status: tripped.includes('SYNTA') ? 'trailing_stop' : 'hold',
      checks: [
        { code: 'stop_loss', status: 'pass', limit: 90, observed: 118, loss_from_cost_pct: 18 },
        {
          code: 'trailing_stop',
          status: tripped.includes('SYNTA') ? 'tripped' : 'pass',
          limit: 119.6,
          peak: 130,
          observed: 118,
          drawdown_from_peak_pct: -9.2,
        },
      ],
    },
  ],
  tripped,
  unavailable: [],
  cooldowns: tripped.length
    ? []
    : [
        {
          symbol: 'SYNTB',
          until_session: '2026-10-02',
          reason: 'stop_loss',
          proposal_id: 'p1',
          created_at: '2026-09-29T22:00:00Z',
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

describe('position stops panel', () => {
  it('shows the evaluation, saves the policy with its version and creates a stop proposal', async () => {
    const onProposal = vi.fn()
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/position-stops') && (!init?.method || init.method === 'GET'))
        return response(state(['SYNTA']))
      if (url.endsWith('/position-stops') && init?.method === 'PUT')
        return response(state(['SYNTA']))
      if (url.endsWith('/position-stops/proposal'))
        return response(
          { paper_proposal: { id: 'synthetic-stop-proposal' }, cooldown_until: '2026-10-01' },
          201,
        )
      throw new Error(`Unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioPositionStops account={account} locale="en" onProposal={onProposal} />)
    await screen.findByText('Trailing stop tripped')
    expect(screen.getByText('1 tripped')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Stop-loss/), { target: { value: '12' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save stop policy' }))
    await screen.findByText('Stop policy saved.')
    const put = fetcher.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      expected_version: 1,
      policy: { enabled: true, stop_loss_pct: 12, trailing_stop_pct: 8, cooldown_sessions: 2 },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Create stop proposal' }))
    await waitFor(() => expect(onProposal).toHaveBeenCalledWith({ id: 'synthetic-stop-proposal' }))
    const post = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith('/position-stops/proposal'),
    )
    expect(JSON.parse(String(post?.[1]?.body)).expected_account_version).toBe(2)
  })

  it('lists cooldowns with a clear action and disables the proposal when nothing tripped', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return response({ removed: true })
      return response(state([]))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByText('None tripped')
    expect(
      (screen.getByRole('button', { name: 'Create stop proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Clear cooldown' }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/cooldowns/SYNTB') && (init as RequestInit)?.method === 'DELETE',
        ),
      ).toBe(true),
    )
  })
})

function draftApi() {
  const values = new Map<string, StopsState>([[account.id, state([])]])
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
    set: (value: StopsState) => values.set(value.account_id, value),
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
const draftInput = () => screen.getByLabelText(/Stop-loss/) as HTMLInputElement
const saveButton = () =>
  screen.getByRole('button', { name: 'Save stop policy' }) as HTMLButtonElement
const changedNotice = /The account or policy changed while you were editing/

it('preserves dirty policy edits through account and policy refreshes until explicitly reloaded', async () => {
  const api = draftApi()
  const view = render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
  await screen.findByLabelText(/Stop-loss/)
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.set({ ...api.current(), account_version: account.version + 1 })
  view.rerender(
    <PortfolioPositionStops
      account={{ ...account, version: account.version + 1 }}
      locale="en"
      onProposal={vi.fn()}
    />,
  )
  await screen.findByText(changedNotice)
  expect(draftInput().value).toBe('22')
  expect(saveButton().disabled).toBe(true)

  const external = structuredClone(api.current())
  external.policy.stop_loss_pct = 18
  external.policy_version += 1
  external.account_version += 1
  api.set(external)
  view.rerender(
    <PortfolioPositionStops
      account={{ ...account, version: external.account_version }}
      locale="en"
      onProposal={vi.fn()}
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
  cleanUpdate.policy.stop_loss_pct = 16
  cleanUpdate.policy_version += 1
  cleanUpdate.account_version += 1
  api.set(cleanUpdate)
  view.rerender(
    <PortfolioPositionStops
      account={{ ...account, version: cleanUpdate.account_version }}
      locale="en"
      onProposal={vi.fn()}
    />,
  )
  await waitFor(() => expect(draftInput().value).toBe('16'))
  expect(screen.queryByText('You have unsaved changes.')).toBeNull()
})

it('retains a rejected draft and its version through 409 and failed reload, then loads current policy', async () => {
  const api = draftApi()
  render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
  await screen.findByLabelText(/Stop-loss/)
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
  current.policy.stop_loss_pct = 18
  current.policy_version += 1
  api.set(current)
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(saveButton().disabled).toBe(false)
})

it('keeps edits made during save and uses the acknowledged version on the next save', async () => {
  const api = draftApi()
  render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
  await screen.findByLabelText(/Stop-loss/)
  const originalVersion = api.current().policy_version
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  fireEvent.change(draftInput(), { target: { value: '24' } })
  await act(async () => api.release())
  await screen.findByText('Stop policy saved.')
  expect(draftInput().value).toBe('24')
  expect(screen.getByText('You have unsaved changes.')).toBeTruthy()
  await userEvent.click(saveButton())
  await waitFor(() =>
    expect(api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2),
  )
  const writes = api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')
  const second = JSON.parse(String(writes[1][1]?.body))
  expect(second.expected_version).toBe(originalVersion + 1)
  expect(second.policy.stop_loss_pct).toBe(24)
  await waitFor(() => expect(screen.queryByText('You have unsaved changes.')).toBeNull())
})

it('isolates an account switch from the prior account draft and pending save response', async () => {
  const api = draftApi()
  const view = render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
  await screen.findByLabelText(/Stop-loss/)
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  const pending = api.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]
  const other = { ...account, id: 'synthetic-other-risk-account' }
  const otherState = structuredClone(api.current())
  otherState.account_id = other.id
  otherState.policy.stop_loss_pct = 18
  api.set(otherState)
  view.rerender(<PortfolioPositionStops account={other} locale="en" onProposal={vi.fn()} />)
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(pending?.signal?.aborted).toBe(true)
  fireEvent.change(draftInput(), { target: { value: '26' } })
  await act(async () => api.release())
  expect(draftInput().value).toBe('26')
  expect(screen.queryByText('Stop policy saved.')).toBeNull()
  expect(api.fetcher.mock.calls.some(([url]) => url.includes(other.id))).toBe(true)
})

it('does not offer a default policy as server truth after a failed initial load and can retry', async () => {
  const api = draftApi()
  api.failLoads(true)
  render(<PortfolioPositionStops account={account} locale="en" onProposal={vi.fn()} />)
  await screen.findByText('Synthetic policy unavailable')
  expect(screen.queryByLabelText(/Stop-loss/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save stop policy' })).toBeNull()
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await screen.findByLabelText(/Stop-loss/)
  expect(saveButton().disabled).toBe(false)
})
