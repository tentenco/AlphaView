import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowValidation, type WorkflowEvidence } from './WorkflowValidation'
import type { AgentRun } from './portfolio-agent-model'
import * as evidenceDownload from './workflow-evidence-json'

const t = (_zh: string, en: string) => en
const makeRun = (symbols = ['SYNTA', 'SYNTB']): AgentRun => ({
  id: 'synthetic-run',
  created_at: '2026-10-01T22:00:00Z',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2026-10-01',
  input_revision: 'synthetic:1',
  status: 'proposed',
  workflow_kind: 'deterministic_rules',
  mode: 'paper_preview_only',
  saved: true,
  current: true,
  stale_reasons: [],
  request: {
    scope: 'market',
    candidate_symbols: symbols,
    strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
    constraints: {
      min_score: 50,
      min_matches: 1,
      max_positions: 6,
      max_position_weight_pct: 20,
      cash_buffer_pct: 20,
    },
  },
  scan: null,
  coverage: {
    requested: symbols.length,
    complete: symbols.length,
    eligible: symbols.length,
    selected: symbols.length,
    rejected: 0,
  },
  target_weights: symbols.map((symbol) => ({ symbol, weight_pct: 10 })),
  cash_weight_pct: 100 - symbols.length * 10,
  allocation: { slot_weight_pct: 10, unused_slots: 0 },
  candidates: symbols.map((symbol) => ({
    symbol,
    status: 'selected',
    score: 75,
    coverage_pct: 100,
    matched_count: 3,
    reasons: [],
    contributions: [],
    evidence: { quote_date: '2026-10-01', reference_close: 100 },
  })),
  risk_checks: [],
  blocking_reasons: [],
  steps: [],
  method: 'Synthetic method',
  warnings: [],
  proposal_fingerprint: 'a'.repeat(64),
})
const run = makeRun()
const evidence = (): WorkflowEvidence => ({
  engine_version: 'alphaview-workflow-validation-v1',
  validation_engine_version: 'alphaview-validation-v1',
  agent_run_id: run.id,
  proposal_fingerprint: run.proposal_fingerprint,
  rule_fingerprint: 'b'.repeat(64),
  evidence_fingerprint: 'c'.repeat(64),
  as_of: run.as_of,
  input_revision: run.input_revision,
  mode: 'advisory_only',
  request: {
    symbols: ['SYNTA', 'SYNTB'],
    trials: 1,
    test_start: '2025-10-02',
    test_end: run.as_of,
  },
  uninspected_symbols: [],
  coverage: {
    required_pairs: 8,
    requested_pairs: 8,
    evaluated_pairs: 6,
    fully_available_pairs: 5,
    unavailable_pairs: 2,
    uninspected_pairs: 0,
  },
  items: [
    {
      symbol: 'SYNTA',
      rule: 'turtle',
      weight: 25,
      status: 'evaluated',
      verdict: 'warn',
      code: null,
      reasons: ['Synthetic missing trade evidence'],
      window: { start: '2025-10-02', end: run.as_of, sessions: 252 },
      closed_trades: 3,
      consistency: 0.5,
      ci95: null,
      probability: null,
      unavailable_tests: [
        { test: 'bootstrap', reason: 'insufficient_trades' },
        { test: 'sharpe', reason: 'zero_volatility' },
      ],
    },
    {
      symbol: 'SYNTA',
      rule: 'rps',
      weight: 25,
      status: 'unavailable',
      verdict: null,
      code: 'unsupported_cross_sectional_rule',
      reasons: ['Synthetic cross-sectional reason'],
      window: null,
      closed_trades: null,
      consistency: null,
      ci95: null,
      probability: null,
      unavailable_tests: [{ test: 'walk_forward', reason: 'unsupported_cross_sectional_rule' }],
    },
  ],
  method: 'Synthetic standalone method.',
  warnings: ['Synthetic limitation.'],
})
const response = (body: unknown, status = 200, raw = JSON.stringify(body)) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => raw,
})
const buttonName = 'Inspect enabled rules for selected symbols'
const downloadName = 'Download current evidence JSON'
function mockApi() {
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
    String(url).endsWith('/validation') ? response(evidence()) : response(run),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

describe('saved workflow standalone rule evidence', () => {
  it('downloads the exact displayed evidence without another request or aggregate verdict', async () => {
    const server = {
      ...evidence(),
      desk_engine_version: 'alphaview-research-desk-v1',
      request: { ...evidence().request, risk: { fee_bps: 10, stop_loss_pct: null } },
      future_metadata: {
        preserved: true,
        whole: 1,
        signed_zero: -0,
        exponent: 1e-7,
        text: '合成證據 留存',
        missing: null,
      },
    }
    const raw =
      JSON.stringify(server)
        .replace('"whole":1,', '"whole":1.0,')
        .replace('"signed_zero":0,', '"signed_zero":-0.0,')
        .replace('1e-7', '1e-07')
        .replace('合成證據 留存', '合成證據\\u0020留存') + '\n'
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/validation') ? response(server, 200, raw) : response(run),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    const button = await screen.findByRole('button', { name: downloadName })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:displayed-evidence')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const timeout = window.setTimeout.bind(window)
    let revoke: (() => void) | undefined
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
      if (delay !== 10000) return timeout(callback, delay)
      revoke = callback as () => void
      return 1
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const blob = createObjectURL.mock.calls[0][0]
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(text).toBe(raw)
    const saved = JSON.parse(text)
    expect(saved).toEqual(server)
    expect(saved.items[1].closed_trades).toBeNull()
    expect(saved).not.toHaveProperty('overall')
    expect(saved).not.toHaveProperty('verdict')
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:displayed-evidence')
  })

  it('exports only the replacement result after changed settings are inspected again', async () => {
    const fetcher = mockApi()
    const download = vi
      .spyOn(evidenceDownload, 'downloadWorkflowEvidenceJson')
      .mockImplementation(() => {})
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('button', { name: downloadName })
    fireEvent.change(screen.getByLabelText('Settings tried (trials, 1–500)'), {
      target: { value: '2' },
    })
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    const replacement = {
      ...evidence(),
      evidence_fingerprint: 'd'.repeat(64),
      request: { ...evidence().request, trials: 2 },
    }
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    fetcher.mockImplementation((url) =>
      String(url).endsWith('/validation')
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(response(run)),
    )
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    await act(async () => finish?.(response(replacement)))
    fireEvent.click(await screen.findByRole('button', { name: downloadName }))
    expect(download).toHaveBeenCalledExactlyOnceWith(replacement, JSON.stringify(replacement))
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('disables download during a pending source check and hides it when lifecycle or run identity changes', async () => {
    const interval = window.setInterval.bind(window)
    let poll: (() => void) | undefined
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay !== 30000) return interval(callback, delay)
      poll = callback as () => void
      return 1
    })
    const fetcher = mockApi()
    const view = render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    const download = await screen.findByRole('button', { name: downloadName })
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    act(() => poll?.())
    expect(download).toHaveProperty('disabled', true)
    await act(async () => finish?.(response(run)))
    expect(download).toHaveProperty('disabled', false)
    view.rerender(<WorkflowValidation run={run} enabled={false} t={t} />)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    view.rerender(
      <WorkflowValidation run={{ ...run, input_revision: 'changed:2' }} enabled t={t} />,
    )
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('computes only on demand with bound saved provenance and displays missing evidence without zero filling', async () => {
    const fetcher = mockApi()
    render(<WorkflowValidation run={run} enabled t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(screen.getByText(/latest 252 completed sessions, 4 folds/)).toBeTruthy()
    expect(screen.getByText(/does not validate the consensus score or allocator/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('table')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(`/api/portfolio-agent/runs/${run.id}/validation`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      symbols: ['SYNTA', 'SYNTB'],
      trials: 1,
      expected_proposal_fingerprint: run.proposal_fingerprint,
      expected_input_revision: run.input_revision,
      expected_as_of: run.as_of,
    })
    const rps = screen.getByRole('rowheader', { name: 'SYNTA · Relative strength' }).closest('tr')!
    expect(within(rps).getAllByText('—')).toHaveLength(4)
    expect(within(rps).getByText('Unavailable')).toBeTruthy()
    expect(rps.textContent).toContain('RPS needs cross-sectional ranks')
    const turtle = screen.getByRole('rowheader', { name: /SYNTA · Turtle breakout/ }).closest('tr')!
    expect(within(turtle).getAllByText('—')).toHaveLength(2)
    expect(turtle.textContent).toContain('Fewer than 10 closed trades')
    expect(screen.getByText(/Symbol × enabled-rule coverage/).textContent).toContain('6/8')
    expect(screen.getByText('Synthetic limitation.')).toBeTruthy()
  })

  it.each(['disabled', 'revision', 'run', 'current'] as const)(
    'permanently discards raw evidence after %s changes away and back',
    async (change) => {
      const fetcher = mockApi()
      const view = render(<WorkflowValidation run={run} enabled t={t} />)
      await userEvent.click(screen.getByRole('button', { name: buttonName }))
      await screen.findByRole('button', { name: downloadName })
      const changed =
        change === 'revision'
          ? { ...run, input_revision: 'changed:2' }
          : change === 'run'
            ? { ...run, id: 'other' }
            : change === 'current'
              ? { ...run, current: false }
              : run
      view.rerender(<WorkflowValidation run={changed} enabled={change !== 'disabled'} t={t} />)
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      view.rerender(<WorkflowValidation run={run} enabled t={t} />)
      expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it('does not accept a late raw response after lifecycle changes away and back without remounting', async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowValidation run={run} enabled t={t} />)
    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    const signal = fetcher.mock.calls[0][1]?.signal
    view.rerender(<WorkflowValidation run={run} enabled={false} t={t} />)
    view.rerender(<WorkflowValidation run={run} enabled t={t} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => finish?.(response(evidence())))
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects nonfinite values hidden in raw future metadata before accepting evidence', async () => {
    const raw = JSON.stringify(evidence()).replace(/}$/, ',"future_metadata":{"overflow":1e999}}')
    const fetcher = vi.fn(async () => response(evidence(), 200, raw))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect((await screen.findByRole('alert')).textContent).toContain('non-finite')
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('caps symbol selection at five, reports partial coverage and rejects blank or noninteger trials', async () => {
    const fetcher = mockApi()
    render(
      <WorkflowValidation
        run={makeRun(['SYNTA', 'SYNTB', 'SYNTC', 'SYNTD', 'SYNTE', 'SYNTF'])}
        enabled
        t={t}
      />,
    )
    const user = userEvent.setup()
    expect(screen.getByText(/Partial run coverage; not inspected:/).textContent).toContain('SYNTF')
    expect(screen.getByRole('checkbox', { name: 'SYNTF' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('checkbox', { name: 'SYNTA' }))
    await user.click(screen.getByRole('checkbox', { name: 'SYNTF' }))
    expect(
      screen.getAllByRole('checkbox').filter((node) => (node as HTMLInputElement).checked),
    ).toHaveLength(5)
    const input = screen.getByLabelText('Settings tried (trials, 1–500)')
    await user.clear(input)
    expect(screen.getByRole('button', { name: buttonName })).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(screen.getByRole('button', { name: buttonName })).toHaveProperty('disabled', true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('clears prior evidence on changed controls and preserves the saved workflow targets', async () => {
    mockApi()
    const before = JSON.stringify(run)
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('checkbox', { name: 'SYNTB' }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(JSON.stringify(run)).toBe(before)
  })

  it('rejects evidence when the exact saved source turns stale after computation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/validation')
          ? response(evidence())
          : response({ ...run, current: false }),
      ),
    )
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'source changed or could not be checked',
    )
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('reports 409 and mismatched evidence provenance without showing a false result', async () => {
    const fetcher = vi.fn(async () =>
      response({ detail: { code: 'workflow_validation_stale' } }, 409),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('alert')
    fetcher.mockImplementation(async () => response({ ...evidence(), input_revision: 'changed:2' }))
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'source changed or could not be checked',
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('guards double clicks and aborts requests when switching the run or account', async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal
      return new Promise<ReturnType<typeof response>>((resolve) => {
        finish = resolve
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowValidation key="old-account-run" run={run} enabled t={t} />)
    const button = screen.getByRole('button', { name: buttonName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    view.rerender(
      <WorkflowValidation key="new-account-run" run={{ ...run, id: 'other' }} enabled t={t} />,
    )
    expect(signal?.aborted).toBe(true)
    await act(async () => finish?.(response(evidence())))
    expect(screen.queryByRole('table')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('only rereads local currentness in the background and hides evidence after source failure', async () => {
    const interval = window.setInterval.bind(window)
    let poll: (() => void) | undefined
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay !== 30000) return interval(callback, delay)
      poll = callback as () => void
      return 1
    })
    const fetcher = mockApi()
    render(<WorkflowValidation run={run} enabled t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('table')
    fetcher.mockImplementation(async () => response({}, 503))
    await act(async () => poll?.())
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull())
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect((await screen.findByRole('status')).textContent).toContain('evidence is inactive')
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})
