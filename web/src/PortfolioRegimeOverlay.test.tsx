import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioRegimeOverlay, type OverlayState } from './PortfolioRegimeOverlay'
import { REGIME_SETTINGS_KEY } from './market-regime'
import type { PaperAccount } from './paper-model'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const account: PaperAccount = {
  id: 'synthetic-overlay-account',
  name: 'Synthetic',
  currency: 'USD',
  initial_cash: 10000,
  cash: 5000,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const empty = {
  buffett_ratio: null,
  shiller_pe: null,
  yield_10y: null,
  yield_2y: null,
  fear_greed: null,
}
const state = (available: boolean): OverlayState => ({
  engine_version: 'alphaview-regime-overlay-v1',
  account_id: account.id,
  account_version: 3,
  as_of: '2026-09-29',
  policy: {
    enabled: available,
    mode: 'block',
    regime: {
      benchmark: 'VOO',
      weights: { buffett: 15, shiller: 25, yield_curve: 25, technical: 0, sentiment: 15 },
      inputs: available ? { ...empty, buffett_ratio: { value: 250, as_of: '2026-09-01' } } : empty,
    },
  },
  policy_version: available ? 2 : 0,
  cap: available
    ? {
        cap_pct: 40,
        band: 'extreme',
        score: 93.75,
        status: 'ok',
        reason: null,
        missing: [],
        stale_inputs: [],
        regime_version: 'alphaview-regime-v1',
        regime_as_of: '2026-09-29',
      }
    : {
        cap_pct: null,
        band: null,
        score: null,
        status: 'unavailable',
        reason: 'regime_incomplete',
        missing: ['buffett', 'shiller'],
        stale_inputs: [],
        regime_version: 'alphaview-regime-v1',
        regime_as_of: '2026-09-29',
      },
  caps_table: { calm: 100, watch: 80, elevated: 60, extreme: 40 },
  regime: {
    benchmark: 'VOO',
    score: available ? 93.75 : null,
    zone: available ? 'extreme' : null,
    complete: available,
    missing: available ? [] : ['buffett', 'shiller'],
    stale_inputs: [],
    factors: [],
  },
  current_exposure_pct: 45,
  exposure_missing: [],
  exposure_status: available ? 'above_cap' : 'no_cap',
  input_revision: 'synthetic:1',
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('regime overlay panel', () => {
  it('shows the cap, loads the market-risk page settings and saves with the policy version', async () => {
    localStorage.setItem(
      REGIME_SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        benchmark: 'QQQ',
        weights: { buffett: 10, shiller: 20, yield_curve: 30, technical: 25, sentiment: 15 },
        inputs: { ...empty, shiller_pe: { value: 36, as_of: '2026-09-10' } },
      }),
    )
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? response(state(true)) : response(state(true)),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioRegimeOverlay account={account} locale="en" />)
    await screen.findByText('Cap 40%')
    expect(screen.getByText(/Above cap/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Load market-risk page settings' }))
    expect((screen.getByLabelText('Shiller PE') as HTMLInputElement).value).toBe('36')
    await userEvent.click(screen.getByRole('button', { name: 'Save overlay' }))
    await screen.findByText('Regime overlay saved.')
    const put = fetcher.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT')
    const body = JSON.parse(String(put?.[1]?.body))
    expect(body.expected_version).toBe(2)
    expect(body.policy.regime.benchmark).toBe('QQQ')
    expect(body.policy.regime.inputs.shiller_pe).toEqual({ value: 36, as_of: '2026-09-10' })
    expect(body.policy.regime.weights.technical).toBe(25)
    expect(body.policy.enabled).toBe(true)
  })

  it('explains an unavailable cap and reports the missing factors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(state(false))),
    )
    render(<PortfolioRegimeOverlay account={account} locale="en" />)
    await screen.findByText('Off')
    expect(screen.getByText('— (Risk score incomplete)')).toBeTruthy()
    expect(screen.getByText('Buffett, Shiller PE')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/No cap/)).toBeTruthy())
  })
})

function draftApi() {
  const values = new Map<string, OverlayState>([[account.id, state(true)]])
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
    set: (value: OverlayState) => values.set(value.account_id, value),
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
const draftInput = () => screen.getByLabelText('Weight: Buffett') as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: 'Save overlay' }) as HTMLButtonElement
const changedNotice = /The account or policy changed while you were editing/

it('preserves dirty policy edits through account and policy refreshes until explicitly reloaded', async () => {
  const api = draftApi()
  const view = render(<PortfolioRegimeOverlay account={account} locale="en" />)
  await screen.findByLabelText('Weight: Buffett')
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.set({ ...api.current(), account_version: account.version + 1 })
  view.rerender(
    <PortfolioRegimeOverlay account={{ ...account, version: account.version + 1 }} locale="en" />,
  )
  await screen.findByText(changedNotice)
  expect(draftInput().value).toBe('22')
  expect(saveButton().disabled).toBe(true)

  const external = structuredClone(api.current())
  external.policy.regime.weights.buffett = 18
  external.policy_version += 1
  external.account_version += 1
  api.set(external)
  view.rerender(
    <PortfolioRegimeOverlay
      account={{ ...account, version: external.account_version }}
      locale="en"
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
  cleanUpdate.policy.regime.weights.buffett = 16
  cleanUpdate.policy_version += 1
  cleanUpdate.account_version += 1
  api.set(cleanUpdate)
  view.rerender(
    <PortfolioRegimeOverlay
      account={{ ...account, version: cleanUpdate.account_version }}
      locale="en"
    />,
  )
  await waitFor(() => expect(draftInput().value).toBe('16'))
  expect(screen.queryByText('You have unsaved changes.')).toBeNull()
})

it('retains a rejected draft and its version through 409 and failed reload, then loads current policy', async () => {
  const api = draftApi()
  render(<PortfolioRegimeOverlay account={account} locale="en" />)
  await screen.findByLabelText('Weight: Buffett')
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
  current.policy.regime.weights.buffett = 18
  current.policy_version += 1
  api.set(current)
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(saveButton().disabled).toBe(false)
})

it('keeps edits made during save and uses the acknowledged version on the next save', async () => {
  const api = draftApi()
  render(<PortfolioRegimeOverlay account={account} locale="en" />)
  await screen.findByLabelText('Weight: Buffett')
  const originalVersion = api.current().policy_version
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  fireEvent.change(draftInput(), { target: { value: '24' } })
  await act(async () => api.release())
  await screen.findByText('Regime overlay saved.')
  expect(draftInput().value).toBe('24')
  expect(screen.getByText('You have unsaved changes.')).toBeTruthy()
  await userEvent.click(saveButton())
  await waitFor(() =>
    expect(api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2),
  )
  const writes = api.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')
  const second = JSON.parse(String(writes[1][1]?.body))
  expect(second.expected_version).toBe(originalVersion + 1)
  expect(second.policy.regime.weights.buffett).toBe(24)
  await waitFor(() => expect(screen.queryByText('You have unsaved changes.')).toBeNull())
})

it('isolates an account switch from the prior account draft and pending save response', async () => {
  const api = draftApi()
  const view = render(<PortfolioRegimeOverlay account={account} locale="en" />)
  await screen.findByLabelText('Weight: Buffett')
  fireEvent.change(draftInput(), { target: { value: '22' } })
  api.hold()
  await userEvent.click(saveButton())
  const pending = api.fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]
  const other = { ...account, id: 'synthetic-other-risk-account' }
  const otherState = structuredClone(api.current())
  otherState.account_id = other.id
  otherState.policy.regime.weights.buffett = 18
  api.set(otherState)
  view.rerender(<PortfolioRegimeOverlay account={other} locale="en" />)
  await waitFor(() => expect(draftInput().value).toBe('18'))
  expect(pending?.signal?.aborted).toBe(true)
  fireEvent.change(draftInput(), { target: { value: '26' } })
  await act(async () => api.release())
  expect(draftInput().value).toBe('26')
  expect(screen.queryByText('Regime overlay saved.')).toBeNull()
  expect(api.fetcher.mock.calls.some(([url]) => url.includes(other.id))).toBe(true)
})

it('does not offer a default policy as server truth after a failed initial load and can retry', async () => {
  const api = draftApi()
  api.failLoads(true)
  render(<PortfolioRegimeOverlay account={account} locale="en" />)
  await screen.findByText('Synthetic policy unavailable')
  expect(screen.queryByLabelText('Weight: Buffett')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save overlay' })).toBeNull()
  api.failLoads(false)
  await userEvent.click(screen.getByRole('button', { name: 'Load current policy' }))
  await screen.findByLabelText('Weight: Buffett')
  expect(saveButton().disabled).toBe(false)
})
