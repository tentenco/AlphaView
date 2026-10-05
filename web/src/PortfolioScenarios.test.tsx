import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioScenarios } from './PortfolioScenarios'
import type { PaperSnapshot } from './paper-model'
import {
  defaultScenarioDraft,
  parseScenarioDraft,
  scenarioDraftKey,
  type ScenarioCase,
  type ScenarioDraft,
  type ScenarioReport,
} from './paper-scenarios'

const snapshot: PaperSnapshot = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-18',
  input_revision: 'synthetic:1',
  account: {
    id: 'synthetic-scenarios',
    name: 'Synthetic scenarios account',
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
  method: 'Synthetic paper account.',
  warnings: [],
}
function cashCase(extra: Partial<ScenarioCase> = {}): ScenarioCase {
  return {
    name: '目前持倉',
    kind: 'current',
    status: 'available',
    coverage: { required: 0, priced: 0, missing: [] },
    base_equity: 10000,
    posttrade_equity: 10000,
    stressed_equity: 10000,
    cash: 10000,
    cash_weight_pct: 100,
    stressed_cash_weight_pct: 100,
    cost_total: 0,
    fees_total: 0,
    slippage_total: 0,
    shock_pnl: 0,
    shock_return_pct: 0,
    total_pnl: 0,
    total_return_pct: 0,
    largest_weight_pct: 0,
    stressed_largest_weight_pct: 0,
    worst_position: null,
    positions: [],
    policy_breaches: [],
    preview: null,
    ...extra,
  }
}
function report(extra: Partial<ScenarioReport> = {}): ScenarioReport {
  return {
    engine_version: 'alphaview-paper-scenarios-v1',
    paper_engine_version: 'alphaview-paper-portfolio-v2',
    as_of: snapshot.as_of,
    input_revision: snapshot.input_revision,
    account_version: 1,
    shock: { global_shock_pct: -20, symbol_shocks: [{ symbol: 'SYNTA', shock_pct: -30 }] },
    limits: snapshot.account.limits,
    current: cashCase(),
    plans: [
      cashCase({
        name: 'A',
        kind: 'plan',
        coverage: { required: 1, priced: 1, missing: [] },
        posttrade_equity: 9990,
        stressed_equity: 9390,
        cash: 7990,
        cash_weight_pct: 79.98,
        stressed_cash_weight_pct: 85.09,
        cost_total: 10,
        fees_total: 6,
        slippage_total: 4,
        shock_pnl: -600,
        shock_return_pct: -6.006,
        total_pnl: -610,
        total_return_pct: -6.1,
        largest_weight_pct: 20.02,
        stressed_largest_weight_pct: 14.91,
        worst_position: { symbol: 'SYNTA', pnl: -600, shock_pct: -30 },
        positions: [
          {
            symbol: 'SYNTA',
            shares: 20,
            base_price: 100,
            shock_pct: -30,
            stressed_price: 70,
            base_value: 2000,
            stressed_value: 1400,
            pnl: -600,
            weight_pct: 20.02,
            stressed_weight_pct: 14.91,
          },
        ],
      }),
      cashCase({ name: 'B', kind: 'plan' }),
    ],
    method: 'Synthetic scenario method.',
    warnings: [],
    ...extra,
  }
}
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
})
function saveDraft(extra: Partial<ScenarioDraft> = {}) {
  sessionStorage.setItem(
    scenarioDraftKey(snapshot.account.id),
    JSON.stringify({ ...defaultScenarioDraft(), plans: [], ...extra }),
  )
}
async function calculate() {
  await userEvent.click(screen.getByRole('button', { name: 'Calculate comparison' }))
}
function metric(label: string) {
  return within(screen.getByRole('row', { name: new RegExp(`^${label} `) }))
}

afterEach(() => sessionStorage.clear())

describe('paper scenario comparison', () => {
  it('keeps presets read-only until calculate and submits explicit full targets and overrides', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(report()))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '-20%' }))
    expect(fetcher).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Full targets (%) 1' }), 'synta 20')
    await user.click(screen.getByRole('checkbox', { name: 'All-cash plan 2' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Symbol overrides (optional)' }),
      'synta -30',
    )
    await calculate()
    await screen.findByRole('region', { name: 'Scenario comparison results' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('/api/paper/accounts/synthetic-scenarios/scenarios/compare')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      expected_version: 1,
      global_shock_pct: -20,
      symbol_shocks: [{ symbol: 'SYNTA', shock_pct: -30 }],
      plans: [
        { name: 'A', targets: [{ symbol: 'SYNTA', weight_pct: 20 }] },
        { name: 'B', targets: [] },
      ],
    })
    expect(
      metric('Execution costs')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['$0.00', '$10.00', '$0.00'])
    expect(metric('Post-cost equity').getByText('$9,990.00')).toBeTruthy()
    expect(metric('Shock P/L').getByText('$-600.00')).toBeTruthy()
    expect(metric('Total change incl. costs').getByText('$-610.00')).toBeTruthy()
    expect(metric('Stressed equity').getByText('$9,390.00')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '+10%' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/These are the last submitted assumptions/)).toBeTruthy()
    expect(screen.getByText(/SYNTA -30.00%/)).toBeTruthy()
  })

  it('preserves missing values and shows blocked plans and post-shock policy findings', async () => {
    saveDraft()
    const blocked = cashCase({
      name: 'Blocked A',
      kind: 'plan',
      status: 'blocked',
      stressed_equity: null,
      shock_pnl: null,
      shock_return_pct: null,
      total_pnl: null,
      total_return_pct: null,
      stressed_cash_weight_pct: null,
      stressed_largest_weight_pct: null,
      policy_breaches: [{ code: 'max_turnover', message: '換手超限' }],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          report({
            current: cashCase({
              status: 'unavailable',
              coverage: { required: 1, priced: 0, missing: ['SYNTA'] },
              base_equity: null,
              posttrade_equity: null,
              stressed_equity: null,
              shock_pnl: null,
              total_pnl: null,
              total_return_pct: null,
              shock_return_pct: null,
              largest_weight_pct: null,
              stressed_largest_weight_pct: null,
              cash_weight_pct: null,
              stressed_cash_weight_pct: null,
              policy_breaches: [{ code: 'quote_unavailable', message: '缺價', symbol: 'SYNTA' }],
            }),
            plans: [
              blocked,
              cashCase({
                name: 'Concentrated B',
                kind: 'plan',
                policy_breaches: [
                  { code: 'stressed_max_position_weight', message: '超限', symbol: 'SYNTB' },
                ],
              }),
            ],
          }),
        ),
      ),
    )
    render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await calculate()
    await screen.findByText('Missing valid prices: SYNTA')
    expect(
      metric('Stressed equity')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['—', '—', '$10,000.00'])
    expect(
      metric('Shock P/L')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['—', '—', '$0.00'])
    expect(screen.getByText(/This plan did not pass execution policy/)).toBeTruthy()
    expect(screen.getByText(/exceed the account turnover limit/)).toBeTruthy()
    expect(
      screen.getByText(/SYNTB: A position exceeds the concentration limit after the shock/),
    ).toBeTruthy()
  })

  it('supports current-only scenarios and grows the draft to at most five plans', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response(report({ plans: [], shock: { global_shock_pct: -10, symbol_shocks: [] } })),
      )
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    for (let index = 0; index < 3; index++)
      await user.click(screen.getByRole('button', { name: 'Add plan' }))
    expect((screen.getByRole('button', { name: 'Add plan' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getAllByRole('group')).toHaveLength(5)
    for (let index = 5; index > 0; index--)
      await user.click(screen.getByRole('button', { name: `Remove plan ${index}` }))
    await calculate()
    await screen.findByRole('region', { name: 'Scenario comparison results' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body).plans).toEqual([])
    expect(metric('Shock return').getByText('0.00%')).toBeTruthy()
  })

  it('retains incomplete draft edits across account refresh and remount, isolated by account', async () => {
    const user = userEvent.setup()
    const view = render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await user.type(screen.getByRole('textbox', { name: 'Full targets (%) 1' }), 'SYNTA unfinished')
    view.rerender(
      <PortfolioScenarios
        snapshot={{ ...snapshot, account: { ...snapshot.account, version: 2 } }}
        locale="en"
      />,
    )
    expect(
      (screen.getByRole('textbox', { name: 'Full targets (%) 1' }) as HTMLTextAreaElement).value,
    ).toBe('SYNTA unfinished')
    view.unmount()
    const mounted = render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    expect(
      (screen.getByRole('textbox', { name: 'Full targets (%) 1' }) as HTMLTextAreaElement).value,
    ).toBe('SYNTA unfinished')
    mounted.rerender(
      <PortfolioScenarios
        snapshot={{ ...snapshot, account: { ...snapshot.account, id: 'other-synthetic' } }}
        locale="en"
      />,
    )
    expect(
      (screen.getByRole('textbox', { name: 'Full targets (%) 1' }) as HTMLTextAreaElement).value,
    ).toBe('')
  })

  it('hides a response with newer market inputs instead of mixing it with the account snapshot', async () => {
    saveDraft()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(report({ input_revision: 'synthetic:2' }))),
    )
    const view = render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await calculate()
    await screen.findByText(/The account or market source changed/)
    expect(screen.queryByRole('region', { name: 'Scenario comparison results' })).toBeNull()
    view.rerender(
      <PortfolioScenarios snapshot={{ ...snapshot, input_revision: 'synthetic:2' }} locale="en" />,
    )
    expect(screen.queryByRole('region', { name: 'Scenario comparison results' })).toBeNull()
  })

  it('invalidates displayed results when account version changes and retains the draft', async () => {
    saveDraft({ globalShock: '-25' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(report())))
    const view = render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await calculate()
    await screen.findByRole('region', { name: 'Scenario comparison results' })
    view.rerender(
      <PortfolioScenarios
        snapshot={{ ...snapshot, account: { ...snapshot.account, version: 2 } }}
        locale="en"
      />,
    )
    expect(screen.queryByRole('region', { name: 'Scenario comparison results' })).toBeNull()
    expect(screen.getByText(/The account or market source changed/)).toBeTruthy()
    expect(
      (screen.getByRole('spinbutton', { name: /Global price shock/ }) as HTMLInputElement).value,
    ).toBe('-25')
  })

  it('ignores a late response after an account switch', async () => {
    saveDraft()
    let resolve: (value: unknown) => void = () => {}
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await calculate()
    view.rerender(
      <PortfolioScenarios
        snapshot={{ ...snapshot, account: { ...snapshot.account, id: 'other-synthetic' } }}
        locale="en"
      />,
    )
    await act(async () => {
      resolve(response(report()))
    })
    expect(screen.queryByRole('region', { name: 'Scenario comparison results' })).toBeNull()
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('does not convert blank targets to an all-cash plan and preserves edits after a stale rejection', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ detail: '帳戶版本已變更' }, 409))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<PortfolioScenarios snapshot={snapshot} locale="en" />)
    await calculate()
    expect(screen.getByRole('alert').textContent).toMatch(/explicitly select an all-cash plan/)
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'All-cash plan 1' }))
    await user.click(screen.getByRole('checkbox', { name: 'All-cash plan 2' }))
    await calculate()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Refresh the paper account/),
    )
    expect(
      (screen.getByRole('checkbox', { name: 'All-cash plan 1' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.queryByRole('region', { name: 'Scenario comparison results' })).toBeNull()
  })

  it('validates ranges, full-target weights and overrides without normalizing assumptions', () => {
    const draft: ScenarioDraft = {
      ...defaultScenarioDraft(),
      plans: [{ id: 'a', name: 'A', targets: 'SYNTA 20', allCash: false }],
    }
    const parse = (extra: Partial<ScenarioDraft>) =>
      parseScenarioDraft({ ...draft, ...extra }, 1, [])
    expect(parse({ globalShock: '' }).error?.code).toBe('shock')
    expect(parse({ globalShock: '-100' }).error?.code).toBe('shock')
    expect(parse({ globalShock: '201' }).error?.code).toBe('shock')
    expect(parse({ symbolShocks: 'SYNTB -20' }).error?.code).toBe('override_unused')
    expect(parse({ symbolShocks: 'SYNTA -20\nsynta -30' }).error?.code).toBe('override_duplicate')
    expect(
      parse({ plans: [{ ...draft.plans[0], targets: 'SYNTA 60\nSYNTB 50' }] }).error?.code,
    ).toBe('targets_sum')
    expect(
      parse({ plans: [draft.plans[0], { ...draft.plans[0], id: 'b', name: 'a' }] }).error?.code,
    ).toBe('name_duplicate')
    const good = parse({ globalShock: '0', symbolShocks: 'synta -99' })
    expect(good.request?.global_shock_pct).toBe(0)
    expect(good.request?.symbol_shocks).toEqual([{ symbol: 'SYNTA', shock_pct: -99 }])
    expect(good.request?.plans[0].targets).toEqual([{ symbol: 'SYNTA', weight_pct: 20 }])
  })
})
