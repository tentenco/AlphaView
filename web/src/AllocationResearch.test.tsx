import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AllocationResearch, type AllocationResearchEvidence } from './AllocationResearch'
import type { AgentRun } from './portfolio-agent-model'
import type { PaperAccount } from './paper-model'

const account: PaperAccount = {
  id: 'synthetic-account',
  name: 'Synthetic account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 40, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '',
  updated_at: '',
}

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-run',
  created_at: '2024-01-04T22:00:00Z',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2024-01-04',
  input_revision: 'synthetic:1',
  status: 'proposed',
  workflow_kind: 'deterministic_rules',
  mode: 'paper_preview_only',
  saved: true,
  current: true,
  stale_reasons: [],
  request: {
    scope: 'market',
    candidate_symbols: ['SYNTA', 'SYNTB'],
    strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
    constraints: {
      min_score: 50,
      min_matches: 1,
      max_positions: 2,
      max_position_weight_pct: 40,
      cash_buffer_pct: 20,
    },
  },
  scan: null,
  coverage: { requested: 2, complete: 2, eligible: 2, selected: 2, rejected: 0 },
  target_weights: [
    { symbol: 'SYNTA', weight_pct: 40 },
    { symbol: 'SYNTB', weight_pct: 40 },
  ],
  cash_weight_pct: 20,
  allocation: { slot_weight_pct: 40, unused_slots: 0 },
  candidates: ['SYNTA', 'SYNTB'].map((symbol) => ({
    symbol,
    status: 'selected',
    score: 75,
    coverage_pct: 100,
    matched_count: 3,
    reasons: [],
    contributions: [],
    evidence: { quote_date: '2024-01-04', reference_close: 100 },
  })),
  risk_checks: [],
  blocking_reasons: [],
  steps: [],
  method: 'Synthetic',
  warnings: [],
  proposal_fingerprint: 'a'.repeat(64),
}
const risk = {
  status: 'calculated' as const,
  reason: null,
  volatility_annualized_pct: 10,
  contributions_annualized_pct: [-3.5, 13.5],
  risk_shares_pct: [-35, 135],
  max_equal_risk_share_error: 0.85,
}
const scenario = () => ({
  status: 'calculated' as const,
  reason: null,
  weights: [
    { symbol: 'SYNTA', raw_weight_pct: 53.33333333, capped_weight_pct: 40 },
    { symbol: 'SYNTB', raw_weight_pct: 26.66666667, capped_weight_pct: 26.66666666 },
  ],
  invested_before_pct: 80,
  invested_after_pct: 66.66666666,
  cash_before_pct: 20,
  cash_after_pct: 33.33333334,
  capped_or_rounded_to_cash_pct: 13.33333334,
  risk_before: risk,
  risk_after: risk,
})
const evidence = (lookback = 60): AllocationResearchEvidence => ({
  engine_version: 'alphaview-allocation-research-v1',
  agent_run_id: run.id,
  proposal_fingerprint: run.proposal_fingerprint,
  input_revision: run.input_revision,
  as_of: run.as_of,
  evidence_fingerprint: 'b'.repeat(64),
  status: 'calculated',
  reasons: [],
  request: { lookback_sessions: lookback },
  selected_symbols: ['SYNTA', 'SYNTB'],
  ranking: [
    { rank: 1, symbol: 'SYNTA', score: 75, matched_count: 3 },
    { rank: 2, symbol: 'SYNTB', score: 75, matched_count: 3 },
  ],
  invested_budget_pct: 80,
  position_cap_pct: 40,
  window: {
    price_dates: ['2023-10-10', '2024-01-04'],
    return_dates: ['2024-01-04'],
    lookback_sessions: lookback,
  },
  coverage: {
    required_symbols: 2,
    complete_symbols: 2,
    required_closes: 122,
    valid_closes: 122,
    required_return_sessions: lookback,
    common_return_sessions: lookback,
    per_symbol: ['SYNTA', 'SYNTB'].map((symbol) => ({
      symbol,
      required_closes: 61,
      valid_closes: 61,
      valid_returns: lookback,
      missing_dates: [],
      invalid_dates: [],
      status: 'complete',
    })),
  },
  covariance_annualized: [
    [0.01, -0.004],
    [-0.004, 0.04],
  ],
  correlation: [
    [1, -0.2],
    [-0.2, 1],
  ],
  matrix_diagnostics: {
    min_eigenvalue: 0.009,
    max_eigenvalue: 0.041,
    eigenvalue_ratio: 0.2195,
    condition_number: 4.5556,
    required_eigenvalue_ratio_gt: 1e-10,
  },
  solver: {
    converged: true,
    sweeps: 6,
    max_sweeps: 5000,
    max_risk_share_error: 1e-9,
    risk_share_tolerance: 1e-8,
    reason: null,
  },
  methods: { rank_sum: scenario(), equal_risk_contribution: scenario() },
  method: 'Synthetic comparison method.',
  sources: [
    {
      title: 'Primary mathematical source',
      url: 'https://arxiv.org/pdf/1311.4057',
      section: 'Equation 5',
    },
  ],
})
const reply = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
})
const compareName = 'Compare rank and equal risk contribution'
const lookbackName = 'Research lookback sessions (20–120)'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('runs only on demand with exact saved identity, displays cash, signed risk contributions and matrices', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(init?.method === 'POST' ? evidence() : run),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationResearch account={account} run={run} enabled t={t} />)
  expect(fetcher).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const rank = await screen.findByRole('region', { name: 'Rank sum' })
  expect(fetcher.mock.calls).toHaveLength(2)
  expect(fetcher.mock.calls[0][0]).toBe(`/api/portfolio-agent/runs/${run.id}/allocation-research`)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    expected_proposal_fingerprint: run.proposal_fingerprint,
    expected_input_revision: run.input_revision,
    expected_as_of: run.as_of,
    lookback_sessions: 60,
  })
  expect(rank.textContent).toContain('33.3333')
  expect(rank.textContent).toContain('-3.5')
  expect(rank.textContent).toContain('-35')
  expect(screen.getByText(/Complete symbols: 2\/2.*Valid closes: 122\/122/)).toBeTruthy()
  await userEvent.click(screen.getByText('Covariance and correlation matrices'))
  expect(screen.getByRole('table', { name: 'Annualized covariance' })).toBeTruthy()
  expect(screen.getByRole('table', { name: 'Correlation' })).toBeTruthy()
  expect(
    within(screen.getByRole('table', { name: 'Correlation' })).getAllByText('-2.0000e-1'),
  ).toHaveLength(2)
  expect(screen.queryByRole('button', { name: /Apply|Accept|Execute/ })).toBeNull()
})

it('shows complete coverage gaps and unavailable values without substitute weights', async () => {
  const value = evidence()
  value.status = 'unavailable'
  value.reasons = [{ code: 'history_incomplete', symbol: 'SYNTB' }]
  value.coverage.complete_symbols = 1
  value.coverage.valid_closes = 121
  value.coverage.common_return_sessions = 58
  value.coverage.per_symbol[1].missing_dates = ['2023-12-11']
  value.covariance_annualized = null
  value.correlation = null
  value.solver = null
  value.matrix_diagnostics = null
  for (const method of Object.values(value.methods))
    Object.assign(method, {
      status: 'unavailable',
      reason: 'history_incomplete',
      weights: [],
      cash_after_pct: null,
      risk_before: null,
      risk_after: null,
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => reply(init?.method === 'POST' ? value : run)),
  )
  render(<AllocationResearch account={account} run={run} enabled t={t} />)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  expect(
    await screen.findByText('Comparison unavailable; no substitute allocation was produced.'),
  ).toBeTruthy()
  expect(screen.getByText(/Complete symbols: 1\/2.*Valid closes: 121\/122/)).toBeTruthy()
  await userEvent.click(screen.getByText('Date coverage and frozen ranks'))
  expect(screen.getByText(/SYNTB:.*Missing dates: 2023-12-11/)).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Rank sum' })).queryByRole('table')).toBeNull()
  await userEvent.click(screen.getByText('Covariance and correlation matrices'))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getAllByText('Unavailable —')).toHaveLength(2)
})

it.each(['', '19', '121', '20.5'])(
  'rejects invalid lookback %s without sending a calculation',
  (lookback) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(<AllocationResearch account={account} run={run} enabled t={t} />)
    fireEvent.change(screen.getByLabelText(lookbackName), { target: { value: lookback } })
    expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').textContent).toBe('Enter an integer from 20 to 120.')
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it.each([
  { enabled: false, current: true, saved: true },
  { enabled: true, current: false, saved: true },
  { enabled: true, current: true, saved: false },
])('requires a current saved and enabled context: %j', (settings) => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(
    <AllocationResearch
      account={account}
      run={{ ...run, current: settings.current, saved: settings.saved }}
      enabled={settings.enabled}
      t={t}
    />,
  )
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
  expect(screen.getByText('Open a saved workflow whose source is still current.')).toBeTruthy()
  expect(fetcher).not.toHaveBeenCalled()
})

it('blocks repeated clicks and ignores a cancelled late result', async () => {
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined
  let signal: AbortSignal | undefined
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal
    return new Promise<ReturnType<typeof reply>>((resolve) => {
      finish = resolve
    })
  })
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationResearch account={account} run={run} enabled t={t} />)
  const button = screen.getByRole('button', { name: compareName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: 'Cancel research' }))
  expect(signal?.aborted).toBe(true)
  await act(async () => finish?.(reply(evidence())))
  expect(screen.queryByRole('region', { name: 'Rank sum' })).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('aborts source switches while preserving the lookback draft and rejects late evidence', async () => {
  let finish: ((value: ReturnType<typeof reply>) => void) | undefined
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal
      return new Promise<ReturnType<typeof reply>>((resolve) => {
        finish = resolve
      })
    }),
  )
  const view = render(<AllocationResearch account={account} run={run} enabled t={t} />)
  fireEvent.change(screen.getByLabelText(lookbackName), { target: { value: '80' } })
  fireEvent.click(screen.getByRole('button', { name: compareName }))
  view.rerender(
    <AllocationResearch account={account} run={{ ...run, id: 'synthetic-other' }} enabled t={t} />,
  )
  expect(signal?.aborted).toBe(true)
  expect(screen.getByLabelText(lookbackName)).toHaveProperty('value', '80')
  await act(async () => finish?.(reply(evidence(80))))
  expect(screen.queryByRole('region', { name: 'Rank sum' })).toBeNull()
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', false)
})

it('invalidates a result when its lookback changes and requires a fresh explicit calculation', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(
      init?.method === 'POST' ? evidence(JSON.parse(String(init.body)).lookback_sessions) : run,
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationResearch account={account} run={run} enabled t={t} />)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  await screen.findByRole('region', { name: 'Rank sum' })
  fireEvent.change(screen.getByLabelText(lookbackName), { target: { value: '20' } })
  expect(screen.queryByRole('region', { name: 'Rank sum' })).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  await screen.findByRole('region', { name: 'Rank sum' })
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).lookback_sessions).toBe(20)
})

it.each(['409', 'response_identity', 'recheck_identity'])(
  'does not show evidence when source check fails: %s',
  async (fault) => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return fault === '409'
          ? reply({ detail: { message: 'Changed' } }, 409)
          : reply({
              ...evidence(),
              proposal_fingerprint:
                fault === 'response_identity' ? 'c'.repeat(64) : run.proposal_fingerprint,
            })
      return reply({ ...run, proposal_fingerprint: 'c'.repeat(64) })
    })
    vi.stubGlobal('fetch', fetcher)
    render(<AllocationResearch account={account} run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: compareName }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The workflow source changed or could not be checked. Recheck the workflow.',
    )
    expect(screen.queryByRole('region', { name: 'Rank sum' })).toBeNull()
    expect(fetcher.mock.calls).toHaveLength(fault === 'recheck_identity' ? 2 : 1)
  },
)

it('invalidates stale evidence on a visibility check without rerunning research or clearing drafts', async () => {
  let current = true
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(init?.method === 'POST' ? evidence(80) : { ...run, current }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationResearch account={account} run={run} enabled t={t} />)
  fireEvent.change(screen.getByLabelText(lookbackName), { target: { value: '80' } })
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  await screen.findByRole('region', { name: 'Rank sum' })
  current = false
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Rank sum' })).toBeNull())
  expect(screen.getByLabelText(lookbackName)).toHaveProperty('value', '80')
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('aborts in-flight work on unmount', async () => {
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal
      return new Promise(() => {})
    }),
  )
  const view = render(<AllocationResearch account={account} run={run} enabled t={t} />)
  fireEvent.click(screen.getByRole('button', { name: compareName }))
  view.unmount()
  expect(signal?.aborted).toBe(true)
})
