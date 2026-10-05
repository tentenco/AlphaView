import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathValidation, type WorkflowPathEvidence } from './WorkflowPathValidation'
import type { AgentRun } from './portfolio-agent-model'
import * as download from './workflow-evidence-json'

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-run',
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
    candidate_symbols: ['SYNTA', 'SYNTB'],
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
  coverage: { requested: 2, complete: 2, eligible: 2, selected: 1, rejected: 0 },
  target_weights: [{ symbol: 'SYNTA', weight_pct: 40 }],
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
const evidence = (): WorkflowPathEvidence => ({
  engine_version: 'alphaview-workflow-path-validation-v1',
  agent_run_id: run.id,
  proposal_fingerprint: run.proposal_fingerprint,
  as_of: run.as_of,
  input_revision: run.input_revision,
  settings_fingerprint: 'b'.repeat(64),
  history_fingerprint: 'c'.repeat(64),
  evidence_fingerprint: 'd'.repeat(64),
  status: 'evaluated',
  current_at_snapshot: true,
  candidate_symbols: ['SYNTA', 'SYNTB'],
  rps_universe: [],
  reasons: [],
  window: { start: '2025-10-02', end: run.as_of, signal_start: '2025-10-01', sessions: 252 },
  coverage: {
    required_decisions: 12,
    evaluated_decisions: 12,
    available_decisions: 12,
    required_path_sessions: 252,
    valued_path_sessions: 252,
  },
  metrics: {
    initial_cash: 100000,
    final_value: 105000,
    return_pct: 5,
    max_drawdown_pct: -2,
    total_fees: 40,
    traded_notional: 40000,
    trade_count: 1,
  },
  curve: [
    { date: '2025-10-02', value: 100000, cash: 60000, exposure_pct: 40 },
    { date: run.as_of, value: 105000, cash: 60000, exposure_pct: 42.86 },
  ],
  decisions: [
    {
      signal_date: '2025-10-01',
      trade_date: '2025-10-02',
      status: 'rebalance',
      targets: [{ symbol: 'SYNTB', weight_pct: 40 }],
      cash_weight_pct: 60,
      reasons: [],
    },
    {
      signal_date: '2025-10-30',
      trade_date: '2025-10-31',
      status: 'hold_no_candidates',
      targets: [],
      cash_weight_pct: null,
      reasons: [],
    },
  ],
  events: [
    {
      signal_date: '2025-10-01',
      trade_date: '2025-10-02',
      fee: 40,
      cash: 60000,
      trades: [
        { symbol: 'SYNTB', side: 'buy', shares: 200, raw_open: 200, notional: 40000, fee: 40 },
      ],
    },
  ],
  method: 'Synthetic prefix-only method',
  warnings: ['Synthetic fixed-universe limitation'],
})
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('saved workflow historical path', () => {
  it('exports accepted raw bytes with Python float spelling and future fields without another request', async () => {
    const raw = JSON.stringify(evidence()).replace(
      /}$/,
      ',"future":{"float":1.0,"negative_zero":-0.0,"exponent":1e-07,"missing":null}}\n',
    )
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(raw))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:raw-path')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Download path evidence JSON' }))
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(downloaded).toBe(raw)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('sends exact saved provenance once and displays path, candidate reselection, fills, and scope', async () => {
    const value = evidence()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(value))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    const exportSpy = vi
      .spyOn(download, 'downloadWorkflowEvidenceJson')
      .mockImplementation(() => {})
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    expect(screen.getByText(/point-in-time universe strategy backtest/)).toBeTruthy()
    expect(screen.getByText(/Saved candidates/).textContent).toContain('SYNTA · SYNTB')
    const button = screen.getByRole('button', { name: 'Inspect historical path of saved settings' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await screen.findByText('Path calculated; no pass/fail verdict')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`/api/portfolio-agent/runs/${run.id}/path-validation`)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expected_proposal_fingerprint: run.proposal_fingerprint,
      expected_input_revision: run.input_revision,
      expected_as_of: run.as_of,
    })
    expect(screen.getByRole('img', { name: 'Simulated equity path' })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Historical decisions' })
    expect(within(table).getByText('SYNTB 40.00%')).toBeTruthy()
    expect(within(table).getByText('No eligible candidates; retain holdings')).toBeTruthy()
    expect(screen.getByText('200.0000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download path evidence JSON' }))
    expect(exportSpy).toHaveBeenCalledWith(value, JSON.stringify(value))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('shows unavailable evidence with missing metrics and the dated corporate-action gap', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.metrics = null
    value.curve = []
    value.events = []
    value.coverage.valued_path_sessions = 0
    value.reasons = [
      { code: 'held_corporate_action_unmodeled', symbol: 'SYNTB', date: '2026-01-05' },
    ]
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    expect(await screen.findByText('Path unavailable; performance remains missing')).toBeTruthy()
    expect(
      screen.getByText(/corporate-action accounting cannot be reconstructed/).textContent,
    ).toContain('SYNTB 2026-01-05')
    expect(screen.queryByRole('img', { name: 'Simulated equity path' })).toBeNull()
    const stats = screen.getByText('Simulated return (%)').closest('dl')!
    expect(within(stats).getAllByText('—')).toHaveLength(4)
    expect(
      screen.getByRole('button', { name: 'Download path evidence JSON' }).hasAttribute('disabled'),
    ).toBe(false)
  })

  it('retains known zero metrics as zero and produces no fabricated verdict', async () => {
    const value = evidence()
    value.metrics = { ...value.metrics!, return_pct: 0, max_drawdown_pct: 0, total_fees: 0 }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByText('Path calculated; no pass/fail verdict')
    const stats = screen.getByText('Simulated return (%)').closest('dl')!
    expect(within(stats).getAllByText('0.00')).toHaveLength(3)
    expect(screen.queryByText('Pass')).toBeNull()
  })

  it('does not expose a computed result when the follow-up source read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(evidence()))
        .mockImplementationOnce(() => response({}, 503)),
    )
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('The path source changed')
    expect(screen.queryByText('Path calculated; no pass/fail verdict')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download path evidence JSON' })).toBeNull()
  })

  it('rejects mismatched response evidence before another source check', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ ...evidence(), input_revision: 'changed' }))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('The path source changed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidates evidence on a later local source check without rerunning computation', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
      .mockImplementationOnce(() => response({ ...run, current: false }))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByText('Path calculated; no pass/fail verdict')
    fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByText(/The path source changed or could not be checked/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Simulated equity path' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download path evidence JSON' })).toBeNull()
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('aborts pending work and ignores late results when the workflow changes', async () => {
    let finish: (response: Response) => void = () => {}
    const fetcher = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(<WorkflowPathValidation run={{ ...run, id: 'other-run' }} enabled t={t} />)
    expect(signal.aborted).toBe(true)
    await act(async () => finish(new Response(JSON.stringify(evidence()))))
    expect(screen.queryByText('Path calculated; no pass/fail verdict')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Inspect historical path of saved settings' })
        .hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('releases a pending source check when a new calculation replaces its evidence', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByText('Path calculated; no pass/fail verdict')
    fireEvent(document, new Event('visibilitychange'))
    expect(
      screen.getByRole('button', { name: 'Download path evidence JSON' }).hasAttribute('disabled'),
    ).toBe(true)
    const sourceSignal = fetcher.mock.calls[2][1].signal as AbortSignal
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByText('Path calculated; no pass/fail verdict')
    expect(sourceSignal.aborted).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Download path evidence JSON' }).hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('removes evidence immediately when access is disabled and refuses fresh requests', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathValidation run={run} enabled t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByText('Path calculated; no pass/fail verdict')
    view.rerender(<WorkflowPathValidation run={run} enabled={false} t={t} />)
    expect(screen.queryByRole('button', { name: 'Download path evidence JSON' })).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Inspect historical path of saved settings' })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('has no automatic calculation on mount, refresh, or after a stale conflict', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ detail: { code: 'workflow_path_stale' } }, 409))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathValidation run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect historical path of saved settings' }),
    )
    await screen.findByRole('alert')
    view.unmount()
    render(<WorkflowPathValidation run={run} enabled t={t} />)
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Inspect historical path of saved settings' })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
