import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioAgentWorkflow } from './PortfolioAgentWorkflow'
import {
  agentDraftKey,
  defaultAgentDraft,
  parseAgentDraft,
  type AgentRun,
  type AgentAllocationComparison,
  type AllocationMethod,
  type AgentRunSummary,
} from './portfolio-agent-model'
import type { PaperAccount, PaperPreview, PaperProposal } from './paper-model'

const account: PaperAccount = {
  id: 'synthetic-paper',
  name: 'Synthetic account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-18T22:00:00Z',
  updated_at: '2026-09-18T22:00:00Z',
}
function workflow(extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'synthetic-run',
    created_at: '2026-09-18T22:10:00Z',
    engine_version: 'alphaview-portfolio-agent-v1',
    as_of: '2026-09-18',
    input_revision: 'synthetic:1',
    status: 'proposed',
    workflow_kind: 'deterministic_rules',
    mode: 'paper_preview_only',
    saved: true,
    current: true,
    stale_reasons: [],
    request: {
      scope: 'market',
      candidate_symbols: ['SYNTA'],
      strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
      constraints: {
        min_score: 50,
        min_matches: 1,
        max_positions: 5,
        max_position_weight_pct: 25,
        cash_buffer_pct: 20,
        allocation_method: 'equal',
        volatility_lookback_sessions: 60,
      },
    },
    scan: {
      id: 1,
      as_of: '2026-09-18',
      engine_version: 'alphaview-scan-v1',
      input_status: 'current',
    },
    coverage: { requested: 1, complete: 1, eligible: 1, selected: 1, rejected: 0 },
    target_weights: [{ symbol: 'SYNTA', weight_pct: 16 }],
    cash_weight_pct: 84,
    allocation: { slot_weight_pct: 16, unused_slots: 4 },
    candidates: [
      {
        symbol: 'SYNTA',
        status: 'selected',
        score: 75,
        coverage_pct: 100,
        matched_count: 3,
        reasons: [],
        contributions: [
          {
            strategy: 'turtle',
            weight: 25,
            enabled: true,
            available: true,
            matched: true,
            points: 25,
            status: 'match',
            reason: 'Synthetic evidence',
          },
        ],
        evidence: { quote_date: '2026-09-18', reference_close: 100 },
      },
    ],
    risk_checks: [{ code: 'cash_buffer', passed: true, observed: 84, limit: 20 }],
    blocking_reasons: [],
    steps: ['research_analyst', 'allocation_planner', 'risk_reviewer', 'proposal'].map((role) => ({
      role: role as AgentRun['steps'][number]['role'],
      engine: 'deterministic_rules',
      engine_version: 'alphaview-portfolio-agent-v1',
      status: 'completed',
      summary: '合成角色結果',
      evidence: { synthetic: true },
    })),
    method: 'Synthetic local rules method.',
    warnings: [],
    proposal_fingerprint: 'synthetic-fingerprint',
    ...extra,
  }
}
const preview: PaperPreview = {
  engine_version: 'alphaview-paper-v1',
  as_of: '2026-09-18',
  input_revision: 'synthetic:1',
  account_id: account.id,
  account_version: 1,
  limits: account.limits,
  targets: [{ symbol: 'SYNTA', weight_pct: 16 }],
  coverage: { required: 1, priced: 1, missing: [] },
  valuation_complete: true,
  equity_before: 10000,
  cash_before: 10000,
  cash_after: 8400,
  cash_weight_after_pct: 84,
  turnover_pct: 16,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 16,
      reference_price: 100,
      notional: 1600,
      current_shares: 0,
      target_shares: 16,
      target_weight_pct: 16,
      projected_weight_pct: 16,
    },
  ],
  violations: [],
  executable: true,
  method: 'Synthetic paper preview.',
  warnings: [],
}
const proposal: PaperProposal = {
  ...preview,
  id: 'synthetic-proposal',
  status: 'proposed',
  created_at: '2026-09-18T22:11:00Z',
  accepted_at: null,
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const summary = (run: AgentRun): AgentRunSummary => ({
  ...run,
  scope: run.request.scope,
  current: run.current ?? true,
  stale_reasons: run.stale_reasons || [],
})

function mockApi(run = workflow(), history: AgentRunSummary[] = []) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('?limit=20')) return response({ runs: history })
    if (url.endsWith('/paper-preview'))
      return response({ agent_run_id: run.id, paper_preview: preview })
    if (url.endsWith('/paper-proposal'))
      return response({ agent_run_id: run.id, paper_proposal: proposal }, 201)
    if (url === '/api/portfolio-agent/runs') return response(run, 201)
    if (url === `/api/portfolio-agent/runs/${run.id}`) return response(run)
    throw new Error(`Unexpected endpoint: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

async function createWorkflow() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Candidate symbols'), 'synta')
  await user.click(screen.getByRole('button', { name: 'Create and save workflow' }))
  await screen.findByRole('region', { name: 'Saved workflow details' })
  return user
}

afterEach(() => sessionStorage.clear())

describe('local agent workflow', () => {
  it('keeps one path and one cost panel when saved-source availability refreshes', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    let stale = false
    fetcher.mockImplementation((url, init) =>
      String(url) === '/api/portfolio-agent/runs/synthetic-run' && stale
        ? Promise.resolve(response(workflow({ current: false, stale_reasons: ['inputs_changed'] })))
        : fallback(url, init),
    )
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    const assertUnique = () => {
      expect(
        screen.getAllByRole('region', { name: 'Historical path of saved settings' }),
      ).toHaveLength(1)
      expect(
        screen.getAllByRole('region', { name: 'Cost scenarios on the same path' }),
      ).toHaveLength(1)
    }
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compare cost scenarios' })).toHaveProperty(
        'disabled',
        false,
      ),
    )
    assertUnique()
    await user.clear(screen.getByLabelText('One-way fees (bps)'))
    await user.type(screen.getByLabelText('One-way fees (bps)'), '7, 19')
    await user.clear(screen.getByLabelText('One-way slippage (bps)'))
    await user.type(screen.getByLabelText('One-way slippage (bps)'), '3')
    stale = true
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compare cost scenarios' })).toHaveProperty(
        'disabled',
        true,
      ),
    )
    assertUnique()
    expect(screen.getByLabelText('One-way fees (bps)')).toHaveProperty('value', '7, 19')
    expect(screen.getByLabelText('One-way slippage (bps)')).toHaveProperty('value', '3')
    stale = false
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compare cost scenarios' })).toHaveProperty(
        'disabled',
        false,
      ),
    )
    assertUnique()
    expect(screen.getByLabelText('One-way fees (bps)')).toHaveProperty('value', '7, 19')
    expect(screen.getByLabelText('One-way slippage (bps)')).toHaveProperty('value', '3')
  })

  it('offers advisory rule evidence for the saved run before the paper bridge without starting validation', async () => {
    const fetcher = mockApi()
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    await createWorkflow()
    const panel = await screen.findByRole('region', { name: 'Workflow rule evidence' })
    await waitFor(() =>
      expect(
        within(panel).getByRole('button', { name: 'Inspect enabled rules for selected symbols' }),
      ).toHaveProperty('disabled', false),
    )
    expect(within(panel).getByRole('checkbox', { name: 'SYNTA' })).toHaveProperty('checked', true)
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/validation'))).toBe(false)
    expect(screen.getByRole('button', { name: 'Preview paper rebalance' })).toHaveProperty(
      'disabled',
      false,
    )
    const bridge = screen.getByRole('region', { name: 'Continue to paper proposal' })
    expect(panel.compareDocumentPosition(bridge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('rechecks an exact workflow outside the history page and removes bridge actions when its source becomes stale', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    let stale = false
    fetcher.mockImplementation((url, init) =>
      String(url) === '/api/portfolio-agent/runs/synthetic-run' && stale
        ? Promise.resolve(response(workflow({ current: false, stale_reasons: ['inputs_changed'] })))
        : fallback(url, init),
    )
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    const symbols = screen.getByLabelText('Candidate symbols') as HTMLTextAreaElement
    await user.clear(symbols)
    await user.type(symbols, 'SYNTB')
    stale = true
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await screen.findByText(/Workspace inputs changed/)
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal and review' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(symbols.value).toBe('SYNTB')
  })

  it('disables a previously current bridge while exact currentness is loading and after failure', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    let pending = false
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    fetcher.mockImplementation((url, init) =>
      String(url) === '/api/portfolio-agent/runs/synthetic-run' && pending
        ? new Promise((resolve) => {
            finish = resolve
          })
        : fallback(url, init),
    )
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    pending = true
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await waitFor(() => expect(finish).toBeTruthy())
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    finish!(response({ detail: 'Synthetic exact workflow unavailable' }, 404))
    await screen.findByText('Synthetic exact workflow unavailable')
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal and review' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('shows paper execution costs and independent blockers even when Agent targets passed', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    const costPreview: PaperPreview = {
      ...preview,
      engine_version: 'alphaview-paper-v2',
      executable: false,
      execution_policy: {
        fee_bps: 10,
        slippage_bps: 5,
        min_trade_notional: 20,
        share_precision: 6,
      },
      fees_total: 1.6,
      slippage_total: 0.8,
      orders: [{ ...preview.orders[0], fill_price: 100.05, fee: 1.6 }],
      violations: [{ code: 'min_cash_weight', message: '現金低於帳戶限制' }],
      skipped_orders: [
        {
          symbol: 'SYNTB',
          reason: 'min_trade_notional',
          requested_shares: 0.01,
          reference_notional: 1,
        },
      ],
    }
    fetcher.mockImplementation((url, init) =>
      String(url).endsWith('/paper-preview')
        ? Promise.resolve(response({ agent_run_id: 'synthetic-run', paper_preview: costPreview }))
        : fallback(url, init),
    )
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    await user.click(screen.getByRole('button', { name: 'Preview paper rebalance' }))
    expect(
      await screen.findByText('Paper proposal blocked; saving will not make it executable'),
    ).toBeTruthy()
    expect(
      screen.getByText('The target or projected cash is below the account minimum.'),
    ).toBeTruthy()
    expect(screen.getByText('$100.05')).toBeTruthy()
    expect(screen.getByText('Below the minimum trade amount', { exact: false })).toBeTruthy()
    expect(screen.getByText('alphaview-paper-v2', { exact: false })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull()
  })

  it('creates a structured run, previews changes, and only saves a proposal after review', async () => {
    const fetcher = mockApi()
    const onProposal = vi.fn()
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={onProposal} />)
    const user = await createWorkflow()
    const createCall = fetcher.mock.calls.find(([url]) => url === '/api/portfolio-agent/runs')
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      ...workflow().request,
      account_context: { account_id: account.id, expected_policy_version: 1 },
    })
    const details = screen.getByRole('region', { name: 'Saved workflow details' })
    for (const label of [
      'Research analyst',
      'Allocation planner',
      'Risk reviewer',
      'Portfolio proposal',
    ])
      expect(within(details).getByText(label)).toBeTruthy()
    expect(within(details).getByText('84.00%')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal and review' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Preview paper rebalance' }))
    await screen.findByText('Paper account checks passed')
    const previewCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/paper-preview'))
    expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
      account_id: account.id,
      expected_account_version: 1,
    })
    await user.click(screen.getByRole('button', { name: 'Save paper proposal and review' }))
    await waitFor(() => expect(onProposal).toHaveBeenCalledWith(proposal))
    const saveCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/paper-proposal'))
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      account_id: account.id,
      expected_account_version: 1,
      idempotency_key: expect.any(String),
    })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/accept'))).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal and review' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('keeps an unscorable candidate unavailable and blocks the paper bridge', async () => {
    const run = workflow({
      status: 'blocked',
      target_weights: [],
      cash_weight_pct: null,
      coverage: { requested: 1, complete: 0, eligible: 0, selected: 0, rejected: 1 },
      blocking_reasons: [{ code: 'no_eligible_candidates', message: '沒有符合候選' }],
      candidates: [
        {
          ...workflow().candidates[0],
          score: null,
          status: 'rejected',
          coverage_pct: 75,
          reasons: [
            { code: 'enabled_strategy_unavailable', message: '必要策略缺失', strategy: 'trend' },
          ],
        },
      ],
    })
    mockApi(run)
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    await createWorkflow()
    expect(screen.getByText('Workflow blocked')).toBeTruthy()
    expect(screen.getByText(/No candidates qualify/)).toBeTruthy()
    expect(screen.getByText(/An enabled strategy has no verifiable signal/)).toBeTruthy()
    const candidateTable = screen.getByRole('columnheader', { name: 'Consensus' }).closest('table')!
    const row = within(candidateTable).getByText('SYNTA').closest('tr')!
    expect(within(row).getAllByRole('cell')[2].textContent).toBe('—')
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('shows risk-aware allocation evidence and the fail-closed volatility warning', async () => {
    const allocator = {
      engine_version: 'alphaview-allocator-v1',
      method: 'inverse_volatility' as const,
      status: 'applied' as const,
      lookback_sessions: 40,
      slot_weight_pct: 16,
      invested_budget_pct: 16,
      capped_to_cash_pct: 0,
      per_symbol: [
        {
          symbol: 'SYNTA',
          score: 75,
          sigma_annualized_pct: 18.5,
          raw_weight_pct: 16,
          capped_weight_pct: 16,
          reason: null,
        },
      ],
      unavailable: [],
    }
    const base = workflow()
    mockApi(
      workflow({
        request: {
          ...base.request,
          constraints: {
            ...base.request.constraints,
            allocation_method: 'inverse_volatility',
            volatility_lookback_sessions: 40,
          },
        },
        allocation: { slot_weight_pct: 16, unused_slots: 4, method: 'inverse_volatility' },
        allocator,
      }),
    )
    const view = render(
      <PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />,
    )
    const user = await createWorkflow()
    const evidence = screen.getByRole('region', { name: 'Risk-aware allocation evidence' })
    expect(within(evidence).getByText(/Inverse volatility/)).toBeTruthy()
    expect(within(evidence).getByText('18.50%')).toBeTruthy()
    expect(within(evidence).queryByRole('alert')).toBeNull()
    view.unmount()
    mockApi(
      workflow({
        status: 'blocked',
        target_weights: [],
        cash_weight_pct: null,
        blocking_reasons: [
          {
            code: 'allocation_unavailable',
            message: '風險配置所需的波動率不可用',
            symbols: ['SYNTA'],
          },
        ],
        allocation: { slot_weight_pct: 16, unused_slots: 4, method: 'inverse_volatility' },
        allocator: {
          ...allocator,
          status: 'unavailable',
          per_symbol: [
            {
              ...allocator.per_symbol[0],
              sigma_annualized_pct: null,
              raw_weight_pct: null,
              capped_weight_pct: null,
              reason: { code: 'history_incomplete', message: '回看窗口內缺少調整收盤日線' },
            },
          ],
          unavailable: [
            { symbol: 'SYNTA', code: 'history_incomplete', message: '回看窗口內缺少調整收盤日線' },
          ],
        },
      }),
    )
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    await user.type(screen.getByLabelText('Candidate symbols'), 'synta')
    await user.click(screen.getByRole('button', { name: 'Create and save workflow' }))
    const blocked = await screen.findByRole('region', { name: 'Risk-aware allocation evidence' })
    expect(within(blocked).getByRole('alert').textContent).toContain(
      'Adjusted closes missing inside the lookback',
    )
    expect(screen.getByText('Workflow blocked')).toBeTruthy()
  })

  it('posts the selected allocation method and lookback with the workflow', async () => {
    const fetcher = mockApi()
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText(/Allocation method/), 'score_tilt')
    await user.clear(screen.getByLabelText(/Volatility lookback sessions/))
    await user.type(screen.getByLabelText(/Volatility lookback sessions/), '40')
    await user.type(screen.getByLabelText('Candidate symbols'), 'synta')
    await user.click(screen.getByRole('button', { name: 'Create and save workflow' }))
    await screen.findByRole('region', { name: 'Saved workflow details' })
    const createCall = fetcher.mock.calls.find(([url]) => url === '/api/portfolio-agent/runs')
    expect(JSON.parse(String(createCall?.[1]?.body)).constraints).toMatchObject({
      allocation_method: 'score_tilt',
      volatility_lookback_sessions: 40,
    })
  })

  it('shows stale history with its reason and never bridges it', async () => {
    const stale = workflow({ current: false, stale_reasons: ['inputs_changed'] })
    const fetcher = mockApi(stale, [summary(stale)])
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /SYNTA.*Stale source/ }))
    expect(await screen.findByText(/Workspace inputs changed/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/paper-'))).toBe(false)
  })

  it('blocks a saved workflow bound to another account even when its source remains current', async () => {
    const bound = workflow({
      account_context: {
        account_id: 'another-synthetic-account',
        symbol_policy: {
          engine_version: 'alphaview-paper-symbol-policy-v1',
          version: 1,
          mode: 'unrestricted',
          symbols: [],
        },
      },
    })
    const fetcher = mockApi(bound, [summary(bound)])
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /SYNTA/ }))
    await screen.findByText(
      'This workflow is bound to another account or an older symbol policy. Create a fresh workflow for this account.',
    )
    expect(
      (screen.getByRole('button', { name: 'Preview paper rebalance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/paper-'))).toBe(false)
  })

  it('preserves unapplied draft edits across history refresh, account refresh, and remount', async () => {
    mockApi()
    const onProposal = vi.fn()
    const view = render(
      <PortfolioAgentWorkflow account={account} locale="en" onProposal={onProposal} />,
    )
    const user = await createWorkflow()
    const symbols = screen.getByLabelText('Candidate symbols') as HTMLTextAreaElement
    await user.clear(symbols)
    await user.type(symbols, 'SYNTB, SYNTC')
    const weight = screen.getByLabelText('Turtle breakout') as HTMLInputElement
    await user.clear(weight)
    expect(screen.getByText('Each strategy weight must be a number from 0 to 100.')).toBeTruthy()
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Refresh history' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Refresh history' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    view.rerender(
      <PortfolioAgentWorkflow
        account={{ ...account, version: 2 }}
        locale="en"
        onProposal={onProposal}
      />,
    )
    expect(symbols.value).toBe('SYNTB, SYNTC')
    expect(weight.value).toBe('')
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem(agentDraftKey(account.id))!).symbols).toBe(
        'SYNTB, SYNTC',
      ),
    )
    view.unmount()
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={onProposal} />)
    expect((screen.getByLabelText('Candidate symbols') as HTMLTextAreaElement).value).toBe(
      'SYNTB, SYNTC',
    )
    expect((screen.getByLabelText('Turtle breakout') as HTMLInputElement).value).toBe('')
  })

  it('invalidates the paper preview when the account version changes', async () => {
    mockApi()
    const view = render(
      <PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />,
    )
    const user = await createWorkflow()
    await user.click(screen.getByRole('button', { name: 'Preview paper rebalance' }))
    await screen.findByText('Paper account checks passed')
    view.rerender(
      <PortfolioAgentWorkflow
        account={{ ...account, version: 2 }}
        locale="en"
        onProposal={vi.fn()}
      />,
    )
    expect(
      screen.getByText('The account version or workflow source changed. Preview again.'),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal and review' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect((screen.getByLabelText('Candidate symbols') as HTMLTextAreaElement).value).toBe('synta')
  })

  it('reuses the same idempotency key after an uncertain proposal-save response', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    let saves = 0
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/paper-proposal') && ++saves === 1)
        throw new Error('Connection interrupted')
      return fallback(url, init)
    })
    const onProposal = vi.fn()
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={onProposal} />)
    const user = await createWorkflow()
    await user.click(screen.getByRole('button', { name: 'Preview paper rebalance' }))
    await screen.findByText('Paper account checks passed')
    await user.click(screen.getByRole('button', { name: 'Save paper proposal and review' }))
    await screen.findByText('Connection interrupted')
    await user.click(screen.getByRole('button', { name: 'Save paper proposal and review' }))
    await waitFor(() => expect(onProposal).toHaveBeenCalledTimes(1))
    const payloads = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/paper-proposal'))
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(payloads[0].idempotency_key).toBe(payloads[1].idempotency_key)
  })

  it('isolates account drafts and ignores a late run response after switching accounts', async () => {
    const fetcher = mockApi()
    const fallback = fetcher.getMockImplementation()!
    let resolveRun!: (value: ReturnType<typeof response>) => void
    fetcher.mockImplementation((url, init) =>
      String(url) === '/api/portfolio-agent/runs'
        ? new Promise((resolve) => {
            resolveRun = resolve
          })
        : fallback(url, init),
    )
    const onProposal = vi.fn()
    const view = render(
      <PortfolioAgentWorkflow account={account} locale="en" onProposal={onProposal} />,
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Candidate symbols'), 'SYNTA')
    await user.click(screen.getByRole('button', { name: 'Create and save workflow' }))
    view.rerender(
      <PortfolioAgentWorkflow
        account={{ ...account, id: 'second-synthetic' }}
        locale="en"
        onProposal={onProposal}
      />,
    )
    resolveRun(response(workflow(), 201))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Saved workflow details' })).toBeNull(),
    )
    expect((screen.getByLabelText('Candidate symbols') as HTMLTextAreaElement).value).toBe('')
    expect(onProposal).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem(agentDraftKey(account.id))!).symbols).toBe('SYNTA')
  })
})

describe('workflow input boundaries', () => {
  it('does not turn missing numeric input into a zero weight or normalize an incomplete total', () => {
    const draft = { ...defaultAgentDraft(), symbols: 'SYNTA' }
    expect(parseAgentDraft({ ...draft, weights: { ...draft.weights, turtle: '' } }).error).toBe(
      'weights',
    )
    expect(parseAgentDraft({ ...draft, weights: { ...draft.weights, turtle: '20' } }).error).toBe(
      'weight_sum',
    )
    expect(parseAgentDraft({ ...draft, symbols: 'SYNTA, synta' }).error).toBe('duplicate')
    expect(
      parseAgentDraft({
        ...draft,
        weights: { turtle: '100', trend: '0', pullback: '0', rps: '0' },
        constraints: { ...draft.constraints, min_matches: '2' },
      }).error,
    ).toBe('matches')
    expect(
      parseAgentDraft({ ...draft, constraints: { ...draft.constraints, cash_buffer_pct: '100' } })
        .error,
    ).toBe('constraints')
  })

  it('defaults older drafts to equal slots and bounds the allocator settings', () => {
    const draft = { ...defaultAgentDraft(), symbols: 'SYNTA' }
    const legacy = {
      min_score: '50',
      min_matches: '1',
      max_positions: '5',
      max_position_weight_pct: '25',
      cash_buffer_pct: '20',
    }
    expect(parseAgentDraft({ ...draft, constraints: legacy }).input?.constraints).toMatchObject({
      allocation_method: 'equal',
      volatility_lookback_sessions: 60,
    })
    expect(
      parseAgentDraft({
        ...draft,
        constraints: { ...draft.constraints, allocation_method: 'risk_parity' },
      }).error,
    ).toBe('constraints')
    expect(
      parseAgentDraft({
        ...draft,
        constraints: { ...draft.constraints, volatility_lookback_sessions: '10' },
      }).error,
    ).toBe('constraints')
    expect(
      parseAgentDraft({
        ...draft,
        constraints: {
          ...draft.constraints,
          allocation_method: 'inverse_volatility',
          volatility_lookback_sessions: '40',
        },
      }).input?.constraints,
    ).toMatchObject({ allocation_method: 'inverse_volatility', volatility_lookback_sessions: 40 })
  })
})

function allocationComparison(): AgentAllocationComparison {
  const evidenceRow = (symbol: string, sigma: number | null, reason: string | null) => ({
    symbol,
    score: 75,
    sigma_annualized_pct: sigma,
    raw_weight_pct: null,
    capped_weight_pct: null,
    reason: reason ? { code: reason, message: 'synthetic' } : null,
  })
  const allocator = (method: AllocationMethod, status: 'applied' | 'unavailable') => ({
    engine_version: 'alphaview-allocator-v1',
    method,
    status,
    lookback_sessions: 60,
    slot_weight_pct: 16,
    invested_budget_pct: 32,
    capped_to_cash_pct: 0,
    per_symbol: [
      evidenceRow('SYNTA', 18.5, null),
      evidenceRow(
        'SYNTB',
        status === 'applied' ? 37 : null,
        status === 'applied' ? null : 'history_incomplete',
      ),
    ],
    unavailable:
      status === 'applied'
        ? []
        : [{ symbol: 'SYNTB', code: 'history_incomplete', message: 'synthetic' }],
  })
  return {
    engine_version: 'alphaview-allocator-v1',
    agent_run_id: 'synthetic-run',
    as_of: '2026-09-18',
    input_revision: 'synthetic:1',
    run_method: 'equal',
    lookback_sessions: 60,
    methods: {
      equal: {
        status: 'applied',
        targets: [
          { symbol: 'SYNTA', weight_pct: 16 },
          { symbol: 'SYNTB', weight_pct: 16 },
        ],
        cash_weight_pct: 68,
        allocator: allocator('equal', 'applied'),
      },
      inverse_volatility: {
        status: 'applied',
        targets: [
          { symbol: 'SYNTA', weight_pct: 21.33333333 },
          { symbol: 'SYNTB', weight_pct: 10.66666666 },
        ],
        cash_weight_pct: 68.00000001,
        allocator: allocator('inverse_volatility', 'applied'),
      },
      score_tilt: {
        status: 'unavailable',
        targets: [],
        cash_weight_pct: null,
        allocator: allocator('score_tilt', 'unavailable'),
      },
    },
    method: 'Synthetic comparison method.',
    warnings: ['Synthetic comparison warning.'],
  }
}

describe('allocation method comparison', () => {
  it('compares the three methods on demand as a what-if and shows unavailable methods as reasons', async () => {
    const base = mockApi()
    const comparison = allocationComparison()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/allocations') ? response(comparison) : base(input, init),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/allocations'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Compare the three methods' }))
    const region = await screen.findByRole('region', { name: 'Allocation method comparison' })
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/allocations'))
    expect(String(call?.[0])).toBe('/api/portfolio-agent/runs/synthetic-run/allocations')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ volatility_lookback_sessions: 60 })
    expect(within(region).getByText('21.33%')).toBeTruthy()
    expect(within(region).getByText('10.67%')).toBeTruthy()
    expect(within(region).getByText('history_incomplete')).toBeTruthy()
    expect(within(region).getByText(/Unavailable: SYNTB history_incomplete/)).toBeTruthy()
    expect(within(region).queryByText('0.00%')).toBeNull()
    expect(within(region).getByText(/Workflow uses Equal slots|Workflow uses/)).toBeTruthy()
    expect(within(region).getByText('Synthetic comparison warning.')).toBeTruthy()
  })

  it('downloads the displayed response after a lookback edit without fetching or using the draft', async () => {
    const base = mockApi()
    const comparison = { ...allocationComparison(), input_revision: 'synthetic:compared:7' }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/allocations') ? response(comparison) : base(input, init),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    expect(screen.queryByRole('button', { name: 'Download allocation comparison CSV' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Compare the three methods' }))
    const download = await screen.findByRole('button', {
      name: 'Download allocation comparison CSV',
    })
    const lookback = screen.getByRole('spinbutton', {
      name: /^Volatility lookback sessions \(20–120\)/,
    })
    await user.clear(lookback)
    await user.type(lookback, '40')
    const requests = fetcher.mock.calls.length
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:allocation-comparison')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const filenames: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download)
    })
    const callbacks: (() => void)[] = []
    const timeout = vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      callbacks.push(callback as () => void)
      return 1
    })
    fireEvent.click(download)
    expect(fetcher).toHaveBeenCalledTimes(requests)
    expect(filenames).toEqual(['alphaview-allocation-comparison-2026-09-18-synthetic-run-60d.csv'])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(blob)
    })
    expect(csv).toContain('"synthetic:compared:7","equal","60"')
    expect(csv).toContain('"21.33333333"')
    expect(csv).toContain('"history_incomplete"')
    expect(csv).toContain('"current_local_bars_what_if"')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    callbacks.forEach((callback) => callback())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:allocation-comparison')
    timeout.mockRestore()
  })

  it('aborts a pending comparison on account change and ignores its late response', async () => {
    const base = mockApi()
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/allocations')) return base(input, init)
      signal = init?.signal as AbortSignal
      return new Promise<ReturnType<typeof response>>((resolve) => {
        finish = resolve
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />,
    )
    const user = await createWorkflow()
    const compare = screen.getByRole('button', { name: 'Compare the three methods' })
    fireEvent.click(compare)
    fireEvent.click(compare)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/allocations'))).toHaveLength(
      1,
    )
    expect(screen.getByRole('button', { name: 'Comparing…' })).toHaveProperty('disabled', true)
    view.rerender(
      <PortfolioAgentWorkflow
        account={{ ...account, id: 'synthetic-other' }}
        locale="en"
        onProposal={vi.fn()}
      />,
    )
    expect(signal?.aborted).toBe(true)
    await act(async () => finish?.(response(allocationComparison())))
    expect(screen.queryByRole('button', { name: 'Download allocation comparison CSV' })).toBeNull()
    expect(screen.queryByText('21.33%')).toBeNull()
    await user.type(screen.getByLabelText('Candidate symbols'), 'SYNTB')
    expect(screen.getByLabelText('Candidate symbols')).toHaveProperty('value', 'SYNTB')
  })

  it('clears the prior download after a refresh reports stale inputs while retaining the draft', async () => {
    const base = mockApi()
    let stale = false
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/allocations')) return response(allocationComparison())
      if (String(input) === '/api/portfolio-agent/runs/synthetic-run' && stale)
        return response(workflow({ current: false, stale_reasons: ['inputs_changed'] }))
      return base(input, init)
    })
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    await user.click(screen.getByRole('button', { name: 'Compare the three methods' }))
    await screen.findByRole('button', { name: 'Download allocation comparison CSV' })
    const lookback = screen.getByRole('spinbutton', {
      name: /^Volatility lookback sessions \(20–120\)/,
    })
    await user.clear(lookback)
    await user.type(lookback, '40')
    stale = true
    await user.click(screen.getByRole('button', { name: 'Refresh history' }))
    await screen.findByText(/Workspace inputs changed/)
    expect(screen.queryByRole('button', { name: 'Download allocation comparison CSV' })).toBeNull()
    expect(screen.queryByText('21.33%')).toBeNull()
    expect(lookback).toHaveProperty('value', '40')
  })

  it('rejects a response belonging to another workflow and offers a retry', async () => {
    const base = mockApi()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/allocations')
        ? response({ ...allocationComparison(), agent_run_id: 'synthetic-other-run' })
        : base(input, init),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioAgentWorkflow account={account} locale="en" onProposal={vi.fn()} />)
    const user = await createWorkflow()
    await user.click(screen.getByRole('button', { name: 'Compare the three methods' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The comparison workflow identity does not match. Compare again.',
    )
    expect(screen.queryByRole('button', { name: 'Download allocation comparison CSV' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Compare the three methods' })).toHaveProperty(
      'disabled',
      false,
    )
  })
})
