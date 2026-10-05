import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPortfolio } from './AgentPortfolio'
import type { PaperAccount, PaperProposal, PaperSnapshot } from './paper-model'
import type { BreakerStatus } from './PortfolioCircuitBreakers'
import type { StopsState } from './PortfolioPositionStops'
import type { OverlayState } from './PortfolioRegimeOverlay'
import type { CorporateActionsSummary } from './PortfolioCorporateActions'

vi.mock('./PortfolioFork', () => ({ PortfolioFork: () => null }))
vi.mock('./PortfolioSymbolPolicy', () => ({ PortfolioSymbolPolicy: () => null }))
vi.mock('./PortfolioInbox', () => ({
  PortfolioInbox: ({ onOpen }: { onOpen: (value: unknown) => void }) => (
    <button
      onClick={() =>
        onOpen({
          account_id: 'synthetic-account',
          proposal_id: 'synthetic-older-proposal',
          tab: 'plan',
        })
      }
    >
      Open older proposal
    </button>
  ),
}))

const snapshot: PaperSnapshot = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-18',
  input_revision: 'synthetic:1',
  account: {
    id: 'synthetic-account',
    name: 'Synthetic paper account',
    currency: 'USD',
    initial_cash: 10000,
    cash: 10000,
    version: 1,
    kill_switch: false,
    limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
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
  proposal_count: 25,
  proposals_truncated: true,
  method: 'Synthetic account.',
  warnings: [],
}
const original: PaperProposal = {
  id: 'synthetic-older-proposal',
  account_id: snapshot.account.id,
  account_version: 1,
  engine_version: snapshot.engine_version,
  as_of: snapshot.as_of,
  input_revision: snapshot.input_revision,
  status: 'proposed',
  created_at: '2026-09-18T22:01:00Z',
  accepted_at: null,
  targets: [],
  limits: snapshot.account.limits,
  coverage: snapshot.coverage,
  valuation_complete: true,
  equity_before: 10000,
  cash_before: 10000,
  cash_after: 10000,
  cash_weight_after_pct: 100,
  turnover_pct: 0,
  orders: [],
  violations: [],
  executable: true,
  method: 'Synthetic proposal.',
  warnings: [],
}
const base = '/api/paper/accounts/synthetic-account'
function mockApi(
  extra: {
    method?: string
    missing?: () => boolean
    accounts?: PaperSnapshot['account'][]
    proposal?: Partial<PaperProposal>
  } = {},
) {
  let current = {
    ...original,
    engine_version: extra.method || original.engine_version,
    ...extra.proposal,
  }
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value })
    if (url === '/api/paper/accounts') return ok({ accounts: extra.accounts ?? [snapshot.account] })
    if (url === base) return ok(snapshot)
    if (url === `${base}/proposals/${original.id}`)
      return extra.missing?.()
        ? {
            ok: false,
            status: 404,
            json: async () => ({ detail: 'Synthetic proposal unavailable' }),
          }
        : ok(current)
    if (url === `${base}/proposals/${original.id}/reject` && init?.method === 'POST') {
      current = { ...current, status: 'rejected' }
      return ok(current)
    }
    throw new Error(`Unexpected synthetic API: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function openOlderProposal() {
  await screen.findByRole('tab', { name: 'Allocation & proposals' })
  await userEvent.click(screen.getByRole('button', { name: 'All-account inbox' }))
  await userEvent.click(screen.getByRole('button', { name: 'Open older proposal' }))
  await screen.findByRole('button', { name: 'Reject proposal' })
}
afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
  history.replaceState(null, '', location.pathname)
})

it('refreshes an older inbox proposal by exact ID after rejection despite the snapshot page omitting it', async () => {
  const fetcher = mockApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await openOlderProposal()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Reject proposal' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  await userEvent.click(screen.getByRole('button', { name: 'Reject proposal' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull())
  expect(screen.queryByRole('button', { name: 'Accept and simulate' })).toBeNull()
  expect(screen.getByText('Rejected')).toBeTruthy()
  expect(
    fetcher.mock.calls.filter(([url]) => url === `${base}/proposals/${original.id}`).length,
  ).toBeGreaterThanOrEqual(2)
})

it('removes old proposal controls when the exact object cannot be refreshed', async () => {
  let missing = false
  mockApi({ missing: () => missing })
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await openOlderProposal()
  missing = true
  await userEvent.click(screen.getByRole('button', { name: 'Refresh paper accounts' }))
  await screen.findByText('Synthetic proposal unavailable')
  expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Accept and simulate' })).toBeNull()
})

it('does not offer consent to accept an old paper method even when other versions match', async () => {
  mockApi({ method: 'synthetic-obsolete-paper-method' })
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await openOlderProposal()
  expect(
    (screen.getByRole('button', { name: 'Accept and simulate' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(screen.queryByRole('checkbox', { name: /I reviewed targets/ })).toBeNull()
})

it('shows the actual inbox account when it was added after the account list was loaded', async () => {
  mockApi({ accounts: [] })
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.click(await screen.findByRole('button', { name: 'All-account inbox' }))
  await userEvent.click(screen.getByRole('button', { name: 'Open older proposal' }))
  await screen.findByRole('button', { name: 'Reject proposal' })
  await waitFor(() => {
    const select = screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement
    expect(select.value).toBe(snapshot.account.id)
    expect(select.selectedOptions[0].textContent).toBe(snapshot.account.name)
  })
})

it('explains which source and gates shaped a proposal from its provenance', async () => {
  mockApi({
    proposal: {
      provenance: {
        engine_version: 'alphaview-proposal-provenance-v1',
        source: 'strategy_bridge',
        tags: ['validation:overridden', 'corporate_action_notice'],
      },
    },
  })
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await openOlderProposal()
  const why = screen.getByRole('region', { name: 'Why this proposal' })
  expect(within(why).getByText('Strategy bridge')).toBeTruthy()
  expect(within(why).getByText('Validation gate overridden')).toBeTruthy()
  expect(within(why).getByText(/ledger was not adjusted automatically/)).toBeTruthy()
  expect(within(why).getByText(/nothing is inferred/)).toBeTruthy()
})

function riskStates(account: PaperAccount) {
  const common = {
    account_id: account.id,
    account_version: account.version,
    as_of: snapshot.as_of,
    input_revision: snapshot.input_revision,
    method: 'Synthetic risk policy.',
    warnings: [],
  }
  return {
    'circuit-breakers': {
      ...common,
      engine_version: 'alphaview-circuit-breaker-v1',
      kill_switch: account.kill_switch,
      policy: {
        daily_loss_limit_pct: null,
        max_drawdown_pct: null,
        max_fills_per_session: null,
        auto_pause: true,
        reduce_only_allowed: false,
      },
      policy_version: 1,
      checks: [],
      tripped: false,
      tripped_codes: [],
      unavailable: [],
      valuation_complete: true,
    } satisfies BreakerStatus,
    'position-stops': {
      ...common,
      engine_version: 'alphaview-position-stops-v1',
      policy: {
        enabled: true,
        stop_loss_pct: 5,
        trailing_stop_pct: null,
        cooldown_sessions: 5,
      },
      policy_version: 1,
      holdings: [],
      tripped: ['SYN'],
      unavailable: [],
      cooldowns: [],
    } satisfies StopsState,
    'regime-overlay': {
      ...common,
      engine_version: 'alphaview-regime-overlay-v1',
      policy: {
        enabled: false,
        mode: 'block',
        regime: {
          benchmark: 'VOO',
          weights: { buffett: 15, shiller: 25, yield_curve: 25, technical: 20, sentiment: 15 },
          inputs: {
            buffett_ratio: null,
            shiller_pe: null,
            yield_10y: null,
            yield_2y: null,
            fear_greed: null,
          },
        },
      },
      policy_version: 1,
      cap: {
        cap_pct: null,
        band: null,
        score: null,
        status: 'unavailable',
        reason: 'regime_incomplete',
        missing: ['buffett', 'shiller', 'yield_curve', 'technical', 'sentiment'],
        stale_inputs: [],
        regime_version: 'alphaview-regime-v1',
        regime_as_of: snapshot.as_of,
      },
      caps_table: { calm: 100, watch: 80, elevated: 60, extreme: 40 },
      regime: {
        benchmark: 'VOO',
        score: null,
        zone: null,
        complete: false,
        missing: ['buffett', 'shiller', 'yield_curve', 'technical', 'sentiment'],
        stale_inputs: [],
        factors: [],
      },
      current_exposure_pct: 0,
      exposure_missing: [],
      exposure_status: 'no_cap',
    } satisfies OverlayState,
    'corporate-actions': {
      ...common,
      engine_version: 'alphaview-corporate-actions-v1',
      holdings: [],
      flagged: [],
      entry_unknown: [],
      events: [],
      coverage: [],
    } satisfies CorporateActionsSummary,
  }
}

function mockRiskApi(accounts = [snapshot.account]) {
  const snapshots = accounts.map((account) => ({ ...snapshot, account }))
  const fallback = mockApi({ accounts })
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value })
    const current = snapshots.find((value) =>
      url.startsWith(`/api/paper/accounts/${value.account.id}`),
    )
    if (current) {
      const path = url.slice(`/api/paper/accounts/${current.account.id}`.length + 1)
      if (!path) return ok(current)
      const risks = riskStates(current.account)
      if (path in risks) return ok(risks[path as keyof typeof risks])
      if (path === 'circuit-breakers/events?limit=20') return ok({ events: [] })
      if (path === 'corporate-actions/refresh' && (!init?.method || init.method === 'GET'))
        return ok({ job: null })
      if (path === 'circuit-breakers/evaluate' && init?.method === 'POST') {
        current.account = { ...current.account, kill_switch: true, version: 2 }
        return ok({
          ...riskStates(current.account)['circuit-breakers'],
          paused_now: true,
          tripped: true,
        })
      }
      if (path === 'position-stops/proposal' && init?.method === 'POST')
        return ok({ paper_proposal: original, cooldown_until: '2026-09-25' })
    }
    return fallback(url, init)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

const riskPath = /\/(circuit-breakers|position-stops|regime-overlay|corporate-actions)/

it('loads the risk controls on first visit and keeps allocation separate', async () => {
  const fetcher = mockRiskApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  const tab = await screen.findByRole('tab', { name: 'Risk controls' })
  expect(fetcher.mock.calls.some(([url]) => riskPath.test(url))).toBe(false)
  expect(screen.queryByRole('region', { name: 'Position stops' })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Target weights' })).toBeTruthy()

  await userEvent.click(tab)
  await screen.findByText('Inference: no events since entry')
  for (const name of [
    'Circuit breakers',
    'Position stops',
    'Regime overlay',
    'Corporate-action detection',
  ])
    expect(screen.getByRole('region', { name })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Target weights' })).toBeNull()
  expect(screen.getByRole('tabpanel', { name: 'Risk controls' }).id).toBe(
    tab.getAttribute('aria-controls'),
  )
  const riskRequests = fetcher.mock.calls.filter(([url]) => riskPath.test(url))
  expect(riskRequests.map(([url]) => url).sort()).toEqual([
    `${base}/circuit-breakers`,
    `${base}/circuit-breakers/events?limit=20`,
    `${base}/corporate-actions`,
    `${base}/corporate-actions/ledger-preview`,
    `${base}/corporate-actions/refresh`,
    `${base}/position-stops`,
    `${base}/regime-overlay`,
  ])
  expect(riskRequests.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
})

it('preserves allocation and risk drafts across tab changes and background revisions', async () => {
  const fetcher = mockRiskApi()
  const view = render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  const targets = await screen.findByRole('textbox', { name: 'Target weights' })
  await userEvent.type(targets, 'SYN 25')
  await userEvent.click(screen.getByRole('tab', { name: 'Risk controls' }))
  const stop = await screen.findByRole('textbox', { name: /Stop-loss \(% below/ })
  await waitFor(() => expect((stop as HTMLInputElement).value).toBe('5'))
  await userEvent.clear(stop)
  await userEvent.type(stop, '9')
  const requests = fetcher.mock.calls.filter(([url]) => riskPath.test(url)).length

  await userEvent.click(screen.getByRole('tab', { name: 'Allocation & proposals' }))
  expect(
    (screen.getByRole('textbox', { name: 'Target weights' }) as HTMLTextAreaElement).value,
  ).toBe('SYN 25')
  view.rerender(<AgentPortfolio locale="en" revision="synthetic:2" />)
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === base)).toHaveLength(2))
  await userEvent.click(screen.getByRole('tab', { name: 'Risk controls' }))
  expect(
    (screen.getByRole('textbox', { name: /Stop-loss \(% below/ }) as HTMLInputElement).value,
  ).toBe('9')
  expect(fetcher.mock.calls.filter(([url]) => riskPath.test(url))).toHaveLength(requests)
})

it('opens a stop proposal in allocation, restores tab focus and requires explicit acceptance', async () => {
  const fetcher = mockRiskApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.click(await screen.findByRole('tab', { name: 'Risk controls' }))
  const create = await screen.findByRole('button', { name: 'Create stop proposal' })
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  await userEvent.click(create)
  await screen.findByRole('button', { name: 'Reject proposal' })
  const allocation = screen.getByRole('tab', { name: 'Allocation & proposals' })
  expect(allocation.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(allocation)
  expect(
    (screen.getByRole('button', { name: 'Accept and simulate' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/accept'))).toBe(false)
  expect(fetcher.mock.calls.some(([url]) => url === `${base}/proposals/${original.id}`)).toBe(true)
})

it('refreshes account controls after a risk breaker pauses the paper account', async () => {
  const fetcher = mockRiskApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.click(await screen.findByRole('tab', { name: 'Risk controls' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Evaluate now' }))
  await screen.findByRole('button', { name: 'Resume paper execution' })
  expect(screen.getByRole('tab', { name: 'Risk controls' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(fetcher.mock.calls.filter(([url]) => url === base)).toHaveLength(2)
})

it('unmounts prior risk drafts on account switch and loads the newly selected account on demand', async () => {
  const second = { ...snapshot.account, id: 'synthetic-second', name: 'Synthetic second account' }
  const fetcher = mockRiskApi([snapshot.account, second])
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.click(await screen.findByRole('tab', { name: 'Risk controls' }))
  const stop = await screen.findByRole('textbox', { name: /Stop-loss \(% below/ })
  await waitFor(() => expect((stop as HTMLInputElement).value).toBe('5'))
  await userEvent.clear(stop)
  await userEvent.type(stop, '9')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Paper account' }), second.id)
  await screen.findByRole('tabpanel', { name: 'Allocation & proposals' })
  expect(screen.queryByRole('region', { name: 'Position stops' })).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => url.includes(second.id) && riskPath.test(url))).toBe(
    false,
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Risk controls' }))
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: /Stop-loss \(% below/ }) as HTMLInputElement).value,
    ).toBe('5'),
  )
  expect(
    fetcher.mock.calls.some(([url]) => url === `/api/paper/accounts/${second.id}/position-stops`),
  ).toBe(true)
})

it('supports a single tab stop, arrow navigation, Home and End with a labelled focusable panel', async () => {
  mockRiskApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  const allocation = await screen.findByRole('tab', { name: 'Allocation & proposals' })
  allocation.focus()
  await userEvent.keyboard('{ArrowRight}')
  const risk = screen.getByRole('tab', { name: 'Risk controls' })
  expect(document.activeElement).toBe(risk)
  expect(risk.getAttribute('aria-selected')).toBe('true')
  expect(screen.getAllByRole('tab').filter((tab) => tab.tabIndex === 0)).toEqual([risk])
  await userEvent.tab()
  expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Risk controls' }))
  risk.focus()
  await userEvent.keyboard('{End}')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Holdings & ledger' }))
  await userEvent.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(allocation)
  await userEvent.keyboard('{ArrowLeft}')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Holdings & ledger' }))
  await userEvent.keyboard('{Home}')
  expect(document.activeElement).toBe(allocation)
  expect(screen.getByRole('tabpanel', { name: 'Allocation & proposals' })).toBeTruthy()
})

it('opens a linked account and risk tab after validating the account list', async () => {
  const second = { ...snapshot.account, id: 'synthetic-second', name: 'Synthetic second account' }
  sessionStorage.setItem('paper-selected-account-v1', JSON.stringify(snapshot.account.id))
  history.replaceState(null, '', '#agent-portfolio?account=synthetic-second&view=account&tab=risk')
  const fetcher = mockRiskApi([snapshot.account, second])
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByRole('region', { name: 'Position stops' })
  expect((screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement).value).toBe(
    second.id,
  )
  expect(screen.getByRole('tab', { name: 'Risk controls' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(fetcher.mock.calls.some(([url]) => url === base)).toBe(false)
  expect(
    fetcher.mock.calls.some(([url]) => url === `/api/paper/accounts/${second.id}/position-stops`),
  ).toBe(true)
})

it.each([
  'account=../synthetic-secret',
  'account=synthetic-account&account=synthetic-other',
  'account=synthetic-account&tab=invalid',
  `account=synthetic-account&tab=${'r'.repeat(200)}`,
])(
  'uses an explicit fallback for invalid link parameters without erasing drafts: %s',
  async (query) => {
    history.replaceState(null, '', `#agent-portfolio?${query}`)
    sessionStorage.setItem('paper-targets-synthetic-account-v1', JSON.stringify('SYNTA 20'))
    const fetcher = mockApi()
    render(<AgentPortfolio locale="en" revision="synthetic:1" />)
    await screen.findByText(/The linked account or page parameters are invalid/)
    expect(
      ((await screen.findByRole('textbox', { name: 'Target weights' })) as HTMLTextAreaElement)
        .value,
    ).toBe('SYNTA 20')
    expect(
      fetcher.mock.calls
        .map(([url]) => url)
        .filter((url) => url.startsWith('/api/paper/accounts/')),
    ).toEqual([base])
    expect(location.hash).toBe(`#agent-portfolio?${query}`)
  },
)

it('explains a stale linked account and uses the valid remembered account', async () => {
  history.replaceState(null, '', '#agent-portfolio?account=synthetic-deleted&tab=risk')
  sessionStorage.setItem('paper-selected-account-v1', JSON.stringify(snapshot.account.id))
  const fetcher = mockRiskApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByText(/The linked paper account is missing or unavailable/)
  await screen.findByRole('region', { name: 'Position stops' })
  expect(fetcher.mock.calls.some(([url]) => url.includes('synthetic-deleted'))).toBe(false)
  expect((screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement).value).toBe(
    snapshot.account.id,
  )
})

it('restores the selected tab and per-account allocation draft on refresh without writing history', async () => {
  mockRiskApi()
  const view = render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.type(await screen.findByRole('textbox', { name: 'Target weights' }), 'SYNTA 25')
  await userEvent.click(screen.getByRole('tab', { name: 'Risk controls' }))
  await screen.findByRole('region', { name: 'Position stops' })
  const hash = location.hash
  view.unmount()
  const push = vi.spyOn(history, 'pushState')
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByRole('region', { name: 'Position stops' })
  expect(screen.getByRole('tab', { name: 'Risk controls' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(location.hash).toBe(hash)
  expect(push).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('tab', { name: 'Allocation & proposals' }))
  expect(
    (screen.getByRole('textbox', { name: 'Target weights' }) as HTMLTextAreaElement).value,
  ).toBe('SYNTA 25')
})

it('follows browser back and forward without navigation loops or losing mounted risk drafts', async () => {
  history.replaceState(null, '', '#agent-portfolio?account=synthetic-account&view=account&tab=plan')
  mockRiskApi()
  const push = vi.spyOn(history, 'pushState')
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await userEvent.click(await screen.findByRole('tab', { name: 'Risk controls' }))
  const stop = await screen.findByRole('textbox', { name: /Stop-loss \(% below/ })
  await userEvent.clear(stop)
  await userEvent.type(stop, '9')
  await userEvent.click(screen.getByRole('tab', { name: 'Allocation & proposals' }))
  await act(async () => history.back())
  await screen.findByRole('tabpanel', { name: 'Risk controls' })
  expect(
    (screen.getByRole('textbox', { name: /Stop-loss \(% below/ }) as HTMLInputElement).value,
  ).toBe('9')
  await act(async () => history.forward())
  await screen.findByRole('tabpanel', { name: 'Allocation & proposals' })
  expect(push).toHaveBeenCalledTimes(2)
  expect(new URLSearchParams(location.hash.split('?')[1]).get('tab')).toBe('plan')
})

it('records Inbox navigation in the fragment without serializing the exact proposal selection', async () => {
  mockApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await openOlderProposal()
  const params = new URLSearchParams(location.hash.split('?')[1])
  expect(Object.fromEntries(params)).toEqual({
    account: snapshot.account.id,
    view: 'account',
    tab: 'plan',
  })
  expect(location.hash).not.toContain(original.id)
})

it('restores the inbox view on direct entry and refresh', async () => {
  history.replaceState(null, '', '#agent-portfolio?view=inbox')
  mockApi()
  const view = render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByRole('button', { name: 'Open older proposal' })
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement).disabled,
    ).toBe(false),
  )
  expect(screen.queryByRole('tabpanel')).toBeNull()
  view.unmount()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByRole('button', { name: 'Open older proposal' })
  expect(
    screen.getByRole('button', { name: 'All-account inbox' }).getAttribute('aria-pressed'),
  ).toBe('true')
})

it('applies an edited hash to the mounted workspace and does not write it back', async () => {
  const second = { ...snapshot.account, id: 'synthetic-second', name: 'Synthetic second account' }
  mockRiskApi([snapshot.account, second])
  const push = vi.spyOn(history, 'pushState')
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByRole('textbox', { name: 'Target weights' })
  await act(async () => {
    location.hash = '#agent-portfolio?account=synthetic-second&tab=risk'
  })
  await screen.findByRole('region', { name: 'Position stops' })
  expect((screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement).value).toBe(
    second.id,
  )
  expect(push).not.toHaveBeenCalled()
  expect(location.hash).toBe('#agent-portfolio?account=synthetic-second&tab=risk')
})
