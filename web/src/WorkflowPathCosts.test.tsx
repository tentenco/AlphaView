import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathCosts, type WorkflowPathCostEvidence } from './WorkflowPathCosts'
import type { AgentRun } from './portfolio-agent-model'
import * as download from './workflow-evidence-json'

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-cost-run',
  created_at: '',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2026-10-01',
  input_revision: 'synthetic:1',
  status: 'proposed',
  workflow_kind: 'deterministic_rules',
  mode: 'paper_preview_only',
  saved: true,
  current: true,
  request: {
    scope: 'market',
    candidate_symbols: ['SYNA'],
    strategy_weights: { turtle: 100, trend: 0, pullback: 0, rps: 0 },
    constraints: {
      min_score: 50,
      min_matches: 1,
      max_positions: 1,
      max_position_weight_pct: 40,
      cash_buffer_pct: 20,
    },
  },
  scan: null,
  coverage: { requested: 1, complete: 1, eligible: 1, selected: 1, rejected: 0 },
  target_weights: [{ symbol: 'SYNA', weight_pct: 40 }],
  cash_weight_pct: 60,
  allocation: { slot_weight_pct: 40, unused_slots: 0 },
  candidates: [],
  risk_checks: [],
  blocking_reasons: [],
  steps: [],
  method: 'Synthetic',
  warnings: [],
  proposal_fingerprint: 'a'.repeat(64),
}
const evidence = (): WorkflowPathCostEvidence => {
  const metrics = {
    initial_cash: 100000,
    final_value: 105000,
    return_pct: 5,
    max_drawdown_pct: -2,
    total_fees: 40,
    traded_notional: 40000,
    trade_count: 1,
  }
  const curve = [
    { date: '2025-10-02', value: 100000, cash: 60000, exposure_pct: 40 },
    { date: run.as_of, value: 105000, cash: 60000, exposure_pct: 42.86 },
  ]
  return {
    engine_version: 'alphaview-workflow-path-costs-v1',
    path_engine_version: 'alphaview-workflow-path-validation-v1',
    agent_run_id: run.id,
    proposal_fingerprint: run.proposal_fingerprint,
    input_revision: run.input_revision,
    as_of: run.as_of,
    current_at_snapshot: true,
    request: { fee_bps: [0, 10, 25], slippage_bps: [0, 5, 10] },
    baseline: {
      engine_version: 'alphaview-workflow-path-validation-v1',
      agent_run_id: run.id,
      proposal_fingerprint: run.proposal_fingerprint,
      input_revision: run.input_revision,
      as_of: run.as_of,
      current_at_snapshot: true,
      candidate_symbols: ['SYNA'],
      rps_universe: [],
      reasons: [],
      settings_fingerprint: 'b'.repeat(64),
      history_fingerprint: 'c'.repeat(64),
      evidence_fingerprint: 'd'.repeat(64),
      status: 'evaluated',
      window: { start: '2025-10-02', end: run.as_of, signal_start: '2025-10-01', sessions: 252 },
      coverage: {
        required_decisions: 12,
        evaluated_decisions: 12,
        available_decisions: 12,
        required_path_sessions: 252,
        valued_path_sessions: 252,
      },
      metrics,
      curve,
      decisions: [],
      events: [],
      method: 'Synthetic baseline',
      warnings: [],
    },
    baseline_evidence_fingerprint: 'd'.repeat(64),
    history_fingerprint: 'c'.repeat(64),
    decision_fingerprint: 'e'.repeat(64),
    scenario_fingerprint: 'f'.repeat(64),
    evidence_fingerprint: '1'.repeat(64),
    status: 'evaluated',
    coverage: {
      required_scenarios: 2,
      available_scenarios: 2,
      unavailable_scenarios: 0,
      decision_sets_computed: 1,
    },
    scenarios: [
      {
        fee_bps: 0,
        slippage_bps: 0,
        is_baseline: false,
        status: 'evaluated',
        reasons: [],
        metrics: { ...metrics, final_value: 105100, return_pct: 5.1, total_fees: 0 },
        costs: { fees: 0, slippage: 0, total: 0, raw_notional: 40000, execution_notional: 40000 },
        differences: { final_value: 100, return_pp: 0.1, max_drawdown_pp: 0, explicit_cost: -40 },
        curve,
        events: [],
      },
      {
        fee_bps: 10,
        slippage_bps: 0,
        is_baseline: true,
        status: 'evaluated',
        reasons: [],
        metrics,
        costs: { fees: 40, slippage: 0, total: 40, raw_notional: 40000, execution_notional: 40000 },
        differences: { final_value: 0, return_pp: 0, max_drawdown_pp: 0, explicit_cost: 0 },
        curve,
        events: [
          {
            signal_date: '2025-10-01',
            trade_date: '2025-10-02',
            fee: 40,
            slippage_cost: 0,
            cash: 60000,
            trades: [
              {
                symbol: 'SYNA',
                side: 'buy',
                shares: 400,
                raw_open: 100,
                fill_price: 100,
                raw_notional: 40000,
                execution_notional: 40000,
                fee: 40,
                slippage_cost: 0,
              },
            ],
          },
        ],
      },
    ],
    method: 'Synthetic fixed decisions cost accounting',
    warnings: ['Synthetic limitation'],
  }
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const start = () => fireEvent.click(screen.getByRole('button', { name: 'Compare cost scenarios' }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saved path cost scenarios', () => {
  it('sends exact source and bounded grid once, displays breakdown and exports accepted raw bytes', async () => {
    const value = evidence()
    const raw = JSON.stringify(value).replace('"initial_cash":100000', '"initial_cash":100000.0')
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(raw))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    const exported = vi.spyOn(download, 'downloadWorkflowEvidenceJson').mockImplementation(() => {})
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Compare cost scenarios' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await screen.findByText(/Available cost scenarios/)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`/api/portfolio-agent/runs/${run.id}/path-costs`)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expected_proposal_fingerprint: run.proposal_fingerprint,
      expected_input_revision: run.input_revision,
      expected_as_of: run.as_of,
      fee_bps: [0, 10, 25],
      slippage_bps: [0, 5, 10],
    })
    const table = screen.getByRole('table', { name: 'Cost comparison with fixed decisions' })
    expect(within(table).getByText('105,100.00')).toBeTruthy()
    expect(within(table).getAllByText('0.0000').length).toBeGreaterThan(1)
    expect(screen.getByRole('img', { name: 'Equity path of selected cost scenario' })).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('1')
    expect(screen.getByText('SYNA', { selector: 'th' })).toBeTruthy()
    expect(screen.getByText(/need not equal fee and slippage differences/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download cost evidence JSON' }))
    expect(exported).toHaveBeenCalledWith(value, raw)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '0' } })
    expect(screen.queryByText('Simulated fills for selected scenario')).toBeNull()
  })

  it.each(['', '0, 0', '101', '-1', '0, 1, 2, 3', 'NaN', 'Infinity', '0,'])(
    'rejects invalid rates %s without a request',
    (draft) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      render(<WorkflowPathCosts run={run} enabled t={t} />)
      fireEvent.change(screen.getByLabelText('One-way fees (bps)'), { target: { value: draft } })
      expect(screen.getByRole('alert').textContent).toContain('Check the assumptions')
      expect(
        screen.getByRole('button', { name: 'Compare cost scenarios' }).hasAttribute('disabled'),
      ).toBe(true)
      start()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it('keeps missing metrics as dashes and shows a dated baseline gap in every affected scenario', async () => {
    const value = evidence()
    value.status = value.baseline.status = 'unavailable'
    value.baseline.metrics = null
    value.coverage.available_scenarios = 0
    value.coverage.unavailable_scenarios = 2
    value.scenarios.forEach((scenario) => {
      scenario.status = 'unavailable'
      scenario.metrics = scenario.costs = scenario.differences = null
      scenario.curve = []
      scenario.events = []
      scenario.reasons = [
        {
          code: 'baseline_unavailable',
          details: [
            { code: 'held_corporate_action_unmodeled', symbol: 'SYNA', date: '2026-01-05' },
          ],
        },
      ]
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    start()
    expect((await screen.findByText(/Available cost scenarios/)).textContent).toContain('0/2')
    const table = screen.getByRole('table', { name: 'Cost comparison with fixed decisions' })
    expect(within(table).getAllByText('—')).toHaveLength(14)
    expect(
      within(table).getAllByText(/SYNA 2026-01-05 A held adjustment factor changed/),
    ).toHaveLength(2)
    expect(screen.queryByRole('img')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Download cost evidence JSON' }).hasAttribute('disabled'),
    ).toBe(false)
  })

  it('removes old evidence when editing assumptions and retains the draft through source changes', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathCosts run={run} enabled t={t} />)
    start()
    await screen.findByText(/Available cost scenarios/)
    fireEvent.change(screen.getByLabelText('One-way slippage (bps)'), { target: { value: '2, 8' } })
    expect(screen.queryByRole('button', { name: 'Download cost evidence JSON' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.change(screen.getByLabelText('One-way slippage (bps)'), {
      target: { value: '0, 5, 10' },
    })
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.change(screen.getByLabelText('One-way slippage (bps)'), {
      target: { value: '2, 8' },
    })
    view.rerender(<WorkflowPathCosts run={{ ...run, current: false }} enabled t={t} />)
    expect((screen.getByLabelText('One-way slippage (bps)') as HTMLInputElement).value).toBe('2, 8')
    expect(
      screen.getByRole('button', { name: 'Compare cost scenarios' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts pending work when assumptions change and ignores its late result', async () => {
    let finish: (response: Response) => void = () => {}
    const fetcher = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    start()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    fireEvent.change(screen.getByLabelText('One-way fees (bps)'), { target: { value: '7' } })
    expect(signal.aborted).toBe(true)
    await act(async () => finish(new Response(JSON.stringify(evidence()))))
    expect(screen.queryByRole('table')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Compare cost scenarios' }).hasAttribute('disabled'),
    ).toBe(false)
  })

  it.each(['source', 'grid'])(
    'rejects mismatched %s before checking currentness',
    async (mismatch) => {
      const value = evidence()
      if (mismatch === 'source') value.input_revision = 'other'
      else value.request.slippage_bps = [0]
      const fetcher = vi.fn().mockImplementationOnce(() => response(value))
      vi.stubGlobal('fetch', fetcher)
      render(<WorkflowPathCosts run={run} enabled t={t} />)
      start()
      expect((await screen.findByRole('alert')).textContent).toContain('source changed')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('withholds completed evidence if the follow-up source check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(evidence()))
        .mockImplementationOnce(() => response({}, 503)),
    )
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    start()
    expect((await screen.findByRole('alert')).textContent).toContain('source changed')
    expect(screen.queryByRole('button', { name: 'Download cost evidence JSON' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('invalidates published evidence on visibility source check without recalculating or clearing drafts', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
      .mockImplementationOnce(() => response({ ...run, current: false }))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    start()
    await screen.findByText(/Available cost scenarios/)
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(/The cost comparison source changed/)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download cost evidence JSON' })).toBeNull()
    expect((screen.getByLabelText('One-way fees (bps)') as HTMLInputElement).value).toBe(
      '0, 10, 25',
    )
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('does not automatically recompute after refresh or a stale conflict', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ detail: { code: 'workflow_path_stale' } }, 409))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathCosts run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    start()
    await screen.findByRole('alert')
    view.unmount()
    render(<WorkflowPathCosts run={run} enabled t={t} />)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('table')).toBeNull()
  })
})
