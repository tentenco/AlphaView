import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathSegments, type WorkflowPathSegmentEvidence } from './WorkflowPathSegments'
import type { AgentRun } from './portfolio-agent-model'
import * as download from './workflow-evidence-json'

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-segment-run',
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
    candidate_symbols: ['SYNTA'],
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
const evidence = (): WorkflowPathSegmentEvidence => {
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
    candidate_symbols: ['SYNTA'],
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
    engine_version: 'alphaview-workflow-path-segments-v1',
    path_engine_version: baseline.engine_version,
    agent_run_id: run.id,
    proposal_fingerprint: run.proposal_fingerprint,
    input_revision: run.input_revision,
    as_of: run.as_of,
    current_at_snapshot: true,
    status: 'evaluated',
    reasons: [],
    baseline,
    baseline_evidence_fingerprint: baseline.evidence_fingerprint,
    history_fingerprint: baseline.history_fingerprint,
    settings_fingerprint: baseline.settings_fingerprint,
    segmentation_fingerprint: 'e'.repeat(64),
    evidence_fingerprint: 'f'.repeat(64),
    coverage: {
      required_segments: 4,
      available_segments: 4,
      required_path_sessions: 252,
      observed_path_sessions: 252,
      covered_path_sessions: 252,
      path_evaluations: 1,
    },
    segments: Array.from({ length: 4 }, (_, index) => ({
      segment: index + 1,
      status: 'evaluated',
      reasons: [],
      window: {
        boundary_date: date(index * 63),
        start: date(index * 63 + 1),
        end: date((index + 1) * 63),
        first_path_session: index * 63 + 1,
        last_path_session: (index + 1) * 63,
        boundary_source:
          index === 0 ? 'initial_cash_at_preceding_close' : 'previous_segment_final_close',
      },
      coverage: {
        required_sessions: 63,
        observed_sessions: 63,
        covered_sessions: 63,
        known_decisions: 3,
        known_events: 0,
      },
      metrics: {
        boundary_value: 100000,
        final_value: 100000,
        net_change: 0,
        return_pct: 0,
        max_drawdown_pct: 0,
        total_fees: 0,
        traded_notional: 0,
        turnover_pct: 0,
        trade_count: 0,
      },
      normalized_curve: Array.from({ length: 64 }, (_, offset) => ({
        date: date(index * 63 + offset),
        session: offset,
        index_value: 100,
      })),
      decision_indices: [],
      event_indices: [],
      curve_indices: [index * 63, (index + 1) * 63],
    })),
    reconciliation: {
      chained_return_pct: 0,
      full_path_return_pct: 0,
      return_residual_pp: 0,
      summed_net_change: 0,
      full_path_net_change: 0,
      fees_residual: 0,
      notional_residual: 0,
      trade_count_residual: 0,
    },
    method: 'Synthetic decomposition',
    warnings: ['These periods are not independent folds.'],
  }
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const button = () => screen.getByRole('button', { name: 'Inspect four historical segments' })
const downloadButton = () =>
  screen.getByRole('button', { name: 'Download complete segment evidence JSON' })
const ready = async () => screen.findByText('Four segments decomposed; no ranking or pass verdict')
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

describe('WorkflowPathSegments', () => {
  it('calculates only on request, prevents rapid duplicates, and shows four fixed periods and shared-scale curves', async () => {
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
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(button())
    fireEvent.click(screen.getByRole('button', { name: 'Calculating fixed segments…' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expected_proposal_fingerprint: run.proposal_fingerprint,
      expected_input_revision: run.input_revision,
      expected_as_of: run.as_of,
    })
    await act(async () => finish(new Response(JSON.stringify(evidence()))))
    await ready()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('img', { name: /normalized equity curve/ })).toHaveLength(4)
    expect(screen.getAllByRole('row')).toHaveLength(5)
    expect(screen.getByText(/These are not independent samples/)).toBeTruthy()
    expect(screen.getByText(/simulated capital is never reset/)).toBeTruthy()
    const row = screen.getAllByRole('row')[1]
    expect(within(row).getAllByText('0.00')).toHaveLength(5)
    expect(within(row).getByText('0')).toBeTruthy()
    expect(within(row).queryByText('—')).toBeNull()
  })

  it('keeps all four unavailable periods with null metrics, explicit zero coverage, and no fabricated curves', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.reasons = [{ code: 'baseline_unavailable' }, { code: 'decision_evidence_incomplete' }]
    value.baseline.status = 'unavailable'
    value.baseline.metrics = null
    value.baseline.curve = []
    value.coverage = {
      ...value.coverage,
      available_segments: 0,
      covered_path_sessions: 0,
      observed_path_sessions: 0,
    }
    value.reconciliation = null
    value.segments.forEach((segment) => {
      segment.status = 'unavailable'
      segment.metrics = null
      segment.normalized_curve = []
      segment.coverage.covered_sessions = 0
      segment.coverage.observed_sessions = 0
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(value))
        .mockImplementationOnce(() => response(run)),
    )
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByText(
      'Path or segment evidence unavailable; all four segment metrics remain missing',
    )
    expect(screen.getByText('Historical decision evidence incomplete')).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(5)
    for (const row of screen.getAllByRole('row').slice(1))
      expect(within(row).getAllByText('—')).toHaveLength(6)
    expect(screen.queryByRole('img')).toBeNull()
    expect(downloadButton().hasAttribute('disabled')).toBe(false)
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
    render(<WorkflowPathSegments run={run} enabled t={t} />)
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
    'missing_period',
    'missing_metrics',
    'false_coverage',
    'nonfinite',
  ])('rejects %s evidence before accepting a result', async (fault) => {
    const value = evidence()
    if (fault === 'wrong_source') value.input_revision = 'other'
    if (fault === 'wrong_baseline') value.baseline.agent_run_id = 'other'
    if (fault === 'missing_period') value.segments.pop()
    if (fault === 'missing_metrics') value.segments[0].metrics = null
    if (fault === 'false_coverage') value.coverage.covered_path_sessions = 251
    let raw = fault === 'empty' ? '{}' : JSON.stringify(value)
    if (fault === 'nonfinite')
      raw = raw.replace('"return_residual_pp":0', '"return_residual_pp":1e999')
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByRole('alert')
    expect(screen.queryByRole('img')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download complete segment evidence JSON' }),
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
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    expect((await screen.findByRole('alert')).textContent).toContain('The segment source changed')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('clears old raw evidence on source invalidation without recalculation', async () => {
    const fetcher = goodFetch().mockImplementationOnce(() => response({ ...run, current: false }))
    vi.stubGlobal('fetch', fetcher)
    const save = vi.spyOn(download, 'downloadWorkflowEvidenceJson').mockImplementation(() => {})
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    const old = downloadButton()
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(
      'The segment source changed or could not be checked. Recheck the workflow.',
    )
    expect(screen.queryByRole('img')).toBeNull()
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
    render(<WorkflowPathSegments run={run} enabled t={t} />)
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
      const view = render(<WorkflowPathSegments run={run} enabled t={t} />)
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
      view.rerender(<WorkflowPathSegments run={changed} enabled={kind !== 'disabled'} t={t} />)
      expect(signal.aborted).toBe(true)
      await act(async () => finish(new Response(JSON.stringify(evidence()))))
      expect(screen.queryByRole('img')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Download complete segment evidence JSON' }),
      ).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('removes accepted evidence when disabled and prevents stale-button downloads', async () => {
    vi.stubGlobal('fetch', goodFetch())
    const save = vi.spyOn(download, 'downloadWorkflowEvidenceJson').mockImplementation(() => {})
    const view = render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    await ready()
    const old = downloadButton()
    view.rerender(<WorkflowPathSegments run={run} enabled={false} t={t} />)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(old)
    expect(save).not.toHaveBeenCalled()
    expect(button().hasAttribute('disabled')).toBe(true)
  })

  it('refuses empty source input and never automatically retries after a conflict or remount', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => response({}, 409))
    vi.stubGlobal('fetch', fetcher)
    const empty = render(
      <WorkflowPathSegments
        run={{ ...run, request: { ...run.request, candidate_symbols: [] } }}
        enabled
        t={t}
      />,
    )
    expect(button().hasAttribute('disabled')).toBe(true)
    fireEvent.click(button())
    expect(fetcher).not.toHaveBeenCalled()
    empty.unmount()
    const view = render(<WorkflowPathSegments run={run} enabled t={t} />)
    fireEvent.click(button())
    await screen.findByRole('alert')
    view.unmount()
    render(<WorkflowPathSegments run={run} enabled t={t} />)
    await waitFor(() => expect(button().hasAttribute('disabled')).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
