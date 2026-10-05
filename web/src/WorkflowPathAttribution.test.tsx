import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowPathAttribution,
  type WorkflowPathAttributionEvidence,
} from './WorkflowPathAttribution'
import type { AgentRun } from './portfolio-agent-model'
import * as download from './workflow-evidence-json'

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-attribution-run',
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
  coverage: { requested: 1, complete: 1, eligible: 1, selected: 1, rejected: 0 },
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
const date = (index: number) => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
const evidence = (): WorkflowPathAttributionEvidence => {
  const baseline = {
    engine_version: 'alphaview-workflow-path-validation-v1',
    agent_run_id: run.id,
    proposal_fingerprint: run.proposal_fingerprint,
    as_of: run.as_of,
    input_revision: run.input_revision,
    settings_fingerprint: 'b'.repeat(64),
    history_fingerprint: 'c'.repeat(64),
    evidence_fingerprint: 'd'.repeat(64),
    status: 'evaluated' as const,
    current_at_snapshot: true,
    candidate_symbols: ['SYNTA', 'SYNTB'],
    rps_universe: [],
    reasons: [],
    window: { start: date(1), end: run.as_of, signal_start: date(0), sessions: 252 },
    coverage: {
      required_decisions: 12,
      evaluated_decisions: 12,
      available_decisions: 12,
      required_path_sessions: 252,
      valued_path_sessions: 252,
    },
    metrics: {
      initial_cash: 100000,
      final_value: 100000,
      return_pct: 0,
      max_drawdown_pct: 0,
      total_fees: 0,
      traded_notional: 0,
      trade_count: 0,
    },
    curve: Array.from({ length: 252 }, (_, index) => ({
      date: date(index + 1),
      value: 100000,
      cash: 100000,
      exposure_pct: 0,
    })),
    decisions: [],
    events: [],
    method: 'Synthetic original path',
    warnings: ['Synthetic baseline limitation'],
  }
  return {
    engine_version: 'alphaview-workflow-path-attribution-v1',
    path_engine_version: baseline.engine_version,
    agent_run_id: run.id,
    proposal_fingerprint: run.proposal_fingerprint,
    input_revision: run.input_revision,
    as_of: run.as_of,
    current_at_snapshot: true,
    mode: 'advisory_only',
    status: 'evaluated',
    reasons: [],
    baseline,
    baseline_evidence_fingerprint: baseline.evidence_fingerprint,
    history_fingerprint: baseline.history_fingerprint,
    reread_history_fingerprint: baseline.history_fingerprint,
    evidence_fingerprint: 'f'.repeat(64),
    coverage: {
      required_symbols: 2,
      available_symbols: 2,
      required_sessions: 252,
      available_daily_reconciliations: 252,
      required_price_values: 0,
      available_price_values: 0,
      path_evaluations: 1,
    },
    symbols: ['SYNTA', 'SYNTB'].map((symbol) => ({
      symbol,
      status: 'evaluated',
      reasons: [],
      metrics: {
        gross_pnl: 0,
        fees: 0,
        net_pnl: 0,
        contribution_pp: 0,
        traded_notional: 0,
        trade_count: 0,
        ending_shares: 0,
        quantity_roundoff: 0,
      },
      coverage: {
        required_sessions: 252,
        evaluated_sessions: 252,
        known_inactive_sessions: 252,
        required_price_values: 0,
        available_price_values: 0,
      },
    })),
    daily: Array.from({ length: 252 }, (_, index) => ({
      date: date(index + 1),
      previous_date: date(index),
      status: 'evaluated',
      reasons: [],
      contributions: ['SYNTA', 'SYNTB'].map((symbol) => ({
        symbol,
        status: 'evaluated',
        reasons: [],
        known_inactive: true,
        prior_shares: 0,
        share_change: 0,
        ending_shares: 0,
        quantity_roundoff: 0,
        previous_raw_close: null,
        current_raw_close: null,
        raw_open: null,
        fee: 0,
        gross_pnl: 0,
        net_pnl: 0,
        contribution_pp: 0,
        cumulative_pnl: 0,
        coverage: { required_price_values: 0, available_price_values: 0 },
      })),
      reconciliation: {
        symbol_pnl: 0,
        nav_change: 0,
        pnl_residual: 0,
        reconstructed_cash: 100000,
        saved_cash: 100000,
        cash_residual: 0,
        marked_nav: 100000,
        saved_nav: 100000,
        nav_residual: 0,
        tolerance: 1e-5,
      },
    })),
    aggregate: {
      initial_cash: 100000,
      symbol_pnl: 0,
      path_nav_change: 0,
      pnl_residual: 0,
      contribution_pp: 0,
      path_return_pct: 0,
      return_residual_pp: 0,
      return_tolerance_pp: 1e-8,
      total_fees: 0,
      fees_residual: 0,
      cash_interest_pnl: 0,
      tolerance: 1e-5,
    },
    method: 'Synthetic accounting attribution',
    warnings: ['Synthetic accounting limitation'],
  }
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const button = () => screen.getByRole('button', { name: 'Inspect per-symbol PnL' })
const downloadButton = () =>
  screen.getByRole('button', { name: 'Download complete attribution evidence JSON' })
const ready = async () =>
  screen.findByText('Accounting attribution decomposed; no ranking or pass verdict')
const goodFetch = () =>
  vi
    .fn()
    .mockImplementationOnce(() => response(evidence()))
    .mockImplementationOnce(() => response(run))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('WorkflowPathAttribution', () => {
  it('runs on request, prevents duplicate requests, retains all candidate zeroes, and selects one day without another request', async () => {
    let finish: (value: Response) => void = () => {}
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: 'Calculating symbol attribution…' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(`/api/portfolio-agent/runs/${run.id}/path-attribution`)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expected_proposal_fingerprint: run.proposal_fingerprint,
      expected_input_revision: run.input_revision,
      expected_as_of: run.as_of,
    })
    await act(async () => finish(new Response(JSON.stringify(evidence()))))
    await ready()
    const table = screen.getByRole('table', {
      name: 'Full-period attribution; all saved candidates retained',
    })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getAllByText('0.00')).toHaveLength(6)
    expect(within(table).queryByText('—')).toBeNull()
    fireEvent.click(screen.getByText('Daily holdings, prices and reconciliation'))
    expect(screen.getAllByText('Known inactive with no trade')).toHaveLength(2)
    const daily = screen.getByRole('table', { name: 'Selected-session symbol evidence' })
    expect(within(daily).getAllByText('—')).toHaveLength(6)
    fireEvent.change(screen.getByLabelText('Select session'), { target: { value: '251' } })
    expect(screen.getByText(`${date(251)} → ${date(252)} · Decomposed`)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Contribution pp = 100/)).toBeTruthy()
  })

  it('preserves all candidates with null metrics when the original path is unavailable', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.baseline.status = 'unavailable'
    value.baseline.metrics = null
    value.baseline.curve = []
    value.reasons = [{ code: 'baseline_unavailable' }]
    value.aggregate = null
    value.daily = []
    value.reread_history_fingerprint = null
    value.coverage.available_symbols = 0
    value.coverage.available_daily_reconciliations = 0
    value.symbols.forEach((row) => {
      row.status = 'unavailable'
      row.metrics = null
      row.coverage.evaluated_sessions = 0
      row.coverage.known_inactive_sessions = 0
      row.reasons = [{ code: 'baseline_unavailable' }]
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByText(
      'Aggregate attribution unavailable; known symbol evidence and gaps are retained',
    )
    const table = screen.getByRole('table', {
      name: 'Full-period attribution; all saved candidates retained',
    })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getAllByText('—')).toHaveLength(12)
    expect(screen.getByText('No daily path is available for attribution.')).toBeTruthy()
    expect(downloadButton().hasAttribute('disabled')).toBe(false)
  })

  it('labels unaffected symbol results as partial and keeps affected cumulative values unavailable through the last day', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.aggregate = null
    value.coverage.available_symbols = 1
    value.coverage.available_daily_reconciliations = 0
    value.symbols[1].status = 'unavailable'
    value.symbols[1].metrics = null
    value.symbols[1].coverage.evaluated_sessions = 0
    value.symbols[1].reasons = [
      { code: 'required_price_unavailable', symbol: 'SYNTB', date: date(1), field: 'close' },
    ]
    value.daily.forEach((day) => {
      day.status = 'unavailable'
      day.reconciliation = null
      day.reasons = [{ code: 'prior_aggregate_gap' }]
      const row = day.contributions[1]
      row.status = 'unavailable'
      row.net_pnl = null
      row.cumulative_pnl = null
      row.contribution_pp = null
      row.gross_pnl = null
      row.known_inactive = false
      row.reasons = value.symbols[1].reasons
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByText(
      'Aggregate attribution unavailable; known symbol evidence and gaps are retained',
    )
    expect(screen.getByText('Partial evidence')).toBeTruthy()
    fireEvent.click(screen.getByText('Daily holdings, prices and reconciliation'))
    fireEvent.change(screen.getByLabelText('Select session'), { target: { value: '251' } })
    const rows = within(
      screen.getByRole('table', { name: 'Selected-session symbol evidence' }),
    ).getAllByRole('row')
    expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
    expect(screen.getByText('An earlier gap continues to invalidate the aggregate')).toBeTruthy()
  })

  it('retains unavailable support evidence with no invented daily rows', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.aggregate = null
    value.daily = []
    value.reasons = [{ code: 'attribution_support_incomplete' }]
    value.coverage.available_symbols = 0
    value.coverage.available_daily_reconciliations = 0
    value.symbols.forEach((row) => {
      row.status = 'unavailable'
      row.metrics = null
      row.coverage.evaluated_sessions = 0
      row.coverage.known_inactive_sessions = 0
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByText(
      'Aggregate attribution unavailable; known symbol evidence and gaps are retained',
    )
    expect(screen.getByText('Attribution dates or candidates incomplete')).toBeTruthy()
    expect(screen.getByText('No daily path is available for attribution.')).toBeTruthy()
    expect(downloadButton()).toBeTruthy()
  })

  it('shows a retained tiny positive holding without displaying it as zero', async () => {
    const value = evidence()
    value.symbols[0].metrics!.ending_shares = 1e-12
    value.daily[0].contributions[0].ending_shares = 1e-12
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    const table = screen.getByRole('table', {
      name: 'Full-period attribution; all saved candidates retained',
    })
    expect(within(table).getByText('1.0000e-12')).toBeTruthy()
  })

  it('downloads the complete accepted raw bytes with float spelling, negative zero, exponent and future fields', async () => {
    const value = Object.assign(evidence(), {
      future: { one: 1, zero: -0, tiny: 1e-7, absent: null, note: '合成' },
    })
    const raw =
      JSON.stringify(value)
        .replace('"one":1', '"one":1.0')
        .replace('"zero":0', '"zero":-0.0')
        .replace('"tiny":1e-7', '"tiny":1e-07') + '\n'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(raw))
        .mockImplementationOnce(() => response(run)),
    )
    let captured: Blob | undefined
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          captured = blob
          return 'blob:synthetic'
        }),
        revokeObjectURL: vi.fn(),
      }),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    fireEvent.click(downloadButton())
    expect(captured).toBeTruthy()
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsText(captured!)
    })
    expect(downloaded).toBe(raw)
    expect(JSON.parse(downloaded).baseline.curve).toHaveLength(252)
    expect(JSON.parse(downloaded).future.absent).toBeNull()
  })

  it.each([
    'empty',
    'wrong_source',
    'wrong_baseline',
    'missing_symbol',
    'missing_metrics',
    'false_coverage',
    'nonfinite',
  ])('rejects %s evidence before accepting a result', async (fault) => {
    const value = evidence()
    if (fault === 'wrong_source') value.input_revision = 'other'
    if (fault === 'wrong_baseline') value.baseline.agent_run_id = 'other'
    if (fault === 'missing_symbol') value.symbols.pop()
    if (fault === 'missing_metrics') value.symbols[0].metrics = null
    if (fault === 'false_coverage') value.coverage.available_daily_reconciliations = 251
    let raw = fault === 'empty' ? '{}' : JSON.stringify(value)
    if (fault === 'nonfinite')
      raw = raw.replace('"return_residual_pp":0', '"return_residual_pp":1e999')
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByRole('alert')
    expect(
      screen.queryByRole('table', {
        name: 'Full-period attribution; all saved candidates retained',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download complete attribution evidence JSON' }),
    ).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('discards calculated evidence when the post-calculation source read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(evidence()))
        .mockImplementationOnce(() => response({}, 503)),
    )
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The attribution source changed',
    )
    expect(
      screen.queryByRole('table', {
        name: 'Full-period attribution; all saved candidates retained',
      }),
    ).toBeNull()
  })

  it('clears old raw evidence on source invalidation without recalculation', async () => {
    const fetcher = goodFetch().mockImplementationOnce(() => response({ ...run, current: false }))
    vi.stubGlobal('fetch', fetcher)
    const save = vi.spyOn(download, 'downloadWorkflowEvidenceJson').mockImplementation(() => {})
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    const old = downloadButton()
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(
      'The attribution source changed or could not be checked. Recheck the workflow.',
    )
    expect(
      screen.queryByRole('table', {
        name: 'Full-period attribution; all saved candidates retained',
      }),
    ).toBeNull()
    fireEvent.click(old)
    expect(save).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('blocks download during source recheck and aborts that recheck when a new calculation replaces it', async () => {
    const fetcher = goodFetch()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(run))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    fireEvent(document, new Event('visibilitychange'))
    expect(downloadButton().hasAttribute('disabled')).toBe(true)
    const signal = fetcher.mock.calls[2][1].signal as AbortSignal
    fireEvent.click(button())
    await ready()
    expect(signal.aborted).toBe(true)
    expect(downloadButton().hasAttribute('disabled')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it.each(['workflow', 'account', 'disabled'])(
    'aborts pending work and ignores late evidence after %s changes',
    async (kind) => {
      let finish: (value: Response) => void = () => {}
      const fetcher = vi.fn().mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      vi.stubGlobal('fetch', fetcher)
      const view = render(<WorkflowPathAttribution run={run} enabled t={t} />)
      fireEvent.click(button())
      const signal = fetcher.mock.calls[0][1].signal as AbortSignal
      const changed =
        kind === 'workflow'
          ? { ...run, id: 'another-run' }
          : kind === 'account'
            ? {
                ...run,
                account_context: {
                  account_id: 'another-account',
                  symbol_policy: {
                    engine_version: 'synthetic',
                    version: 1,
                    mode: 'all',
                    symbols: [],
                  },
                },
              }
            : run
      view.rerender(<WorkflowPathAttribution run={changed} enabled={kind !== 'disabled'} t={t} />)
      expect(signal.aborted).toBe(true)
      await act(async () => finish(new Response(JSON.stringify(evidence()))))
      expect(
        screen.queryByRole('table', {
          name: 'Full-period attribution; all saved candidates retained',
        }),
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Download complete attribution evidence JSON' }),
      ).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('removes accepted evidence when disabled and prevents stale-button downloads', async () => {
    vi.stubGlobal('fetch', goodFetch())
    const save = vi.spyOn(download, 'downloadWorkflowEvidenceJson').mockImplementation(() => {})
    const view = render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    const old = downloadButton()
    view.rerender(<WorkflowPathAttribution run={run} enabled={false} t={t} />)
    expect(
      screen.queryByRole('table', {
        name: 'Full-period attribution; all saved candidates retained',
      }),
    ).toBeNull()
    fireEvent.click(old)
    expect(save).not.toHaveBeenCalled()
    expect(button().hasAttribute('disabled')).toBe(true)
  })

  it('refuses empty source input and never automatically retries after a conflict or remount', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => response({}, 409))
    vi.stubGlobal('fetch', fetcher)
    const empty = render(
      <WorkflowPathAttribution
        run={{ ...run, request: { ...run.request, candidate_symbols: [] } }}
        enabled
        t={t}
      />,
    )
    expect(button().hasAttribute('disabled')).toBe(true)
    fireEvent.click(button())
    expect(fetcher).not.toHaveBeenCalled()
    empty.unmount()
    const view = render(<WorkflowPathAttribution run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByRole('alert')
    view.unmount()
    render(<WorkflowPathAttribution run={run} enabled t={t} />)
    await waitFor(() => expect(button().hasAttribute('disabled')).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
