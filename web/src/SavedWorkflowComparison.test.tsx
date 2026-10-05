import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedWorkflowComparison, type SavedComparison } from './SavedWorkflowComparison'
import type { AgentRun, AgentRunSummary } from './portfolio-agent-model'

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-comparison',
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
    candidate_symbols: ['SYNTA', 'SYNTB'],
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
  coverage: { requested: 2, complete: 2, eligible: 2, selected: 1, rejected: 0 },
  target_weights: [{ symbol: 'SYNTA', weight_pct: 0 }],
  cash_weight_pct: 100,
  allocation: { slot_weight_pct: 0, unused_slots: 1 },
  candidates: [],
  risk_checks: [],
  blocking_reasons: [],
  steps: [],
  method: 'Synthetic method',
  warnings: [],
  proposal_fingerprint: 'a'.repeat(64),
}
const baseline: AgentRunSummary = {
  id: 'synthetic-baseline',
  created_at: '2026-09-30T22:00:00Z',
  engine_version: run.engine_version,
  as_of: '2026-09-30',
  status: 'proposed',
  scope: 'market',
  coverage: run.coverage,
  target_weights: [{ symbol: 'SYNTA', weight_pct: 10 }],
  cash_weight_pct: 90,
  current: false,
  stale_reasons: ['session_changed'],
}
const third = { ...baseline, id: 'synthetic-third' }
const history = [baseline, third, { ...baseline, id: run.id }]
const known = (value: unknown) => ({ known: true, value, reason: null })
const missing = (reason = 'not_recorded') => ({ known: false, value: null, reason })
function comparison(): SavedComparison {
  const metadata = {
    id: run.id,
    created_at: run.created_at,
    engine_version: run.engine_version,
    as_of: run.as_of,
    input_revision: run.input_revision,
    proposal_fingerprint: run.proposal_fingerprint,
    status: run.status,
    current: true,
    stale_reasons: [],
  }
  return {
    engine_version: 'alphaview-workflow-comparison-v1',
    as_of: run.as_of,
    input_revision: 'synthetic:1',
    baseline: {
      ...metadata,
      id: baseline.id,
      as_of: baseline.as_of,
      proposal_fingerprint: 'b'.repeat(64),
      current: false,
      stale_reasons: ['session_changed'],
    },
    comparison: metadata,
    rows: [
      {
        symbol: 'SYNTA',
        baseline: {
          candidate_recorded: true,
          target_recorded: true,
          status: known('selected'),
          score: known(50),
          weight_pct: known(10),
        },
        comparison: {
          candidate_recorded: true,
          target_recorded: true,
          status: known('selected'),
          score: known(75),
          weight_pct: known(0),
        },
        score_delta: known(25),
        weight_delta_pp: known(-10),
      },
      {
        symbol: 'SYNTB',
        baseline: {
          candidate_recorded: true,
          target_recorded: false,
          status: known('unselected'),
          score: known(25),
          weight_pct: missing(),
        },
        comparison: {
          candidate_recorded: false,
          target_recorded: false,
          status: missing(),
          score: missing(),
          weight_pct: missing(),
        },
        score_delta: missing('missing_side'),
        weight_delta_pp: missing('missing_side'),
      },
    ],
    selected: {
      baseline: ['SYNTA'],
      comparison: ['SYNTA'],
      only_in_baseline: [],
      only_in_comparison: [],
    },
    cash: { baseline: known(90), comparison: known(100), delta_pp: known(10) },
    settings: [
      {
        field: 'constraints.min_score',
        baseline: known(40),
        comparison: known(50),
        status: 'changed',
      },
    ],
    sources: [
      {
        field: 'input_revision',
        baseline: known('synthetic:old'),
        comparison: known('synthetic:1'),
        status: 'changed',
      },
    ],
    comparability: {
      score_deltas: true,
      baseline_allocation: true,
      comparison_allocation: true,
      weight_delta_semantics: 'saved_percentage_point_arithmetic_only',
      performance_comparison: false,
    },
    coverage: { union_symbols: 2, score_deltas_available: 1, weight_deltas_available: 1 },
    method: 'Synthetic saved observation method.',
    warnings: ['Synthetic no-performance warning.'],
  }
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const buttonName = 'Compare saved records'
const downloadName = 'Download saved comparison JSON'
const downloadButton = () => screen.getByRole('button', { name: downloadName })
const source = () => screen.getByRole('combobox', { name: 'Choose a baseline workflow' })
async function choose(id = baseline.id) {
  await userEvent.selectOptions(source(), id)
}
async function compare() {
  await choose()
  await userEvent.click(screen.getByRole('button', { name: buttonName }))
}
afterEach(() => vi.unstubAllGlobals())

function mockDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:saved-comparison')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const links: { filename: string; href: string; attached: boolean }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push({ filename: this.download, href: this.href, attached: this.isConnected })
  })
  const timeout = window.setTimeout.bind(window)
  const revocations: (() => void)[] = []
  vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
    if (delay !== 10000) return timeout(callback, delay)
    revocations.push(callback as () => void)
    return 1
  })
  return { createObjectURL, revokeObjectURL, links, revocations }
}

async function readJson(blob: Blob) {
  return JSON.parse(
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    }),
  )
}

describe('saved workflow comparison', () => {
  it('requests only saved IDs on demand and shows persisted differences, explicit zero and missing cells distinctly', async () => {
    const fetcher = vi.fn(async () => response(comparison()))
    vi.stubGlobal('fetch', fetcher)
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: buttonName }).hasAttribute('disabled')).toBe(true)
    expect(within(source()).getAllByRole('option')).toHaveLength(3)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/portfolio-agent/compare')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      baseline_run_id: baseline.id,
      comparison_run_id: run.id,
    })
    const rowA = screen.getByRole('rowheader', { name: 'SYNTA' }).closest('tr')!
    expect(
      within(rowA)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Selected', 'Selected', '50', '75', '25', '10', '0', '-10'])
    const rowB = screen.getByRole('rowheader', { name: 'SYNTB' }).closest('tr')!
    expect(
      within(rowB)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Not selected',
      '—',
      '25',
      '—Not recorded',
      '—One side is missing',
      '—Not recorded',
      '—Not recorded',
      '—One side is missing',
    ])
    expect(screen.getByText('Historical source')).toBeTruthy()
    expect(screen.getByText('Source current at comparison')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Saved settings differences' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Source and method differences' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Minimum consensus score' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Saved input revision' })).toBeTruthy()
    expect(screen.getByText(run.proposal_fingerprint)).toBeTruthy()
  })

  it('allows historical/blocked observations while making score and allocation noncomparability visible', async () => {
    const value = comparison()
    value.baseline.status = 'blocked'
    value.baseline.engine_version = 'historical-workflow-v0'
    value.comparability.score_deltas = false
    value.comparability.baseline_allocation = false
    value.rows[0].score_delta = missing('method_changed')
    value.rows[0].baseline.weight_pct = missing('allocation_unavailable')
    value.rows[0].weight_delta_pp = missing('missing_side')
    value.cash.baseline = missing('allocation_unavailable')
    value.cash.delta_pp = missing('missing_side')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(value)),
    )
    render(
      <SavedWorkflowComparison run={run} history={[{ ...baseline, status: 'blocked' }]} t={t} />,
    )
    await compare()
    expect(await screen.findByText(/Workflow method versions differ or are missing/)).toBeTruthy()
    expect(screen.getByText(/At least one saved allocation is blocked/)).toBeTruthy()
    const row = screen.getByRole('rowheader', { name: 'SYNTA' }).closest('tr')!
    expect(within(row).getByText('50')).toBeTruthy()
    expect(within(row).getByText('75')).toBeTruthy()
    expect(within(row).getByText('Score methods are not comparable')).toBeTruthy()
    expect(within(row).getByText('Allocation unavailable')).toBeTruthy()
  })

  it('aborts a pending comparison on baseline change and ignores a late result without automatically fetching again', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<ReturnType<typeof response>>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await choose(third.id)
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    await act(async () => resolve(response(comparison())))
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: buttonName }).hasAttribute('disabled')).toBe(false)
  })

  it('clears displayed results on run source or baseline identity change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(comparison())),
    )
    const view = render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    view.rerender(
      <SavedWorkflowComparison
        run={{ ...run, input_revision: 'synthetic:2' }}
        history={history}
        t={t}
      />,
    )
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
    view.rerender(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByText('Synthetic saved observation method.')
    view.rerender(
      <SavedWorkflowComparison
        run={run}
        history={[{ ...baseline, as_of: '2026-09-29' }, third]}
        t={t}
      />,
    )
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
  })

  it('guards double submission and aborts when unmounted', async () => {
    const fetcher = vi.fn((_url: string, _init: RequestInit) => new Promise(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await choose()
    const button = screen.getByRole('button', { name: buttonName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
  })

  it('rejects mismatched response identity and clears previous evidence on a failed rerun', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(comparison()))
      .mockResolvedValueOnce(response({ detail: { message: 'Synthetic unavailable' } }, 404))
      .mockResolvedValueOnce(
        response({
          ...comparison(),
          comparison: { ...comparison().comparison, proposal_fingerprint: 'wrong' },
        }),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Synthetic unavailable')
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'saved workflow identity does not match',
      ),
    )
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
  })

  it('does not request when another saved run is absent', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(<SavedWorkflowComparison run={run} history={[]} t={t} />)
    expect(
      screen.getByText('Another saved workflow in the loaded history is required.'),
    ).toBeTruthy()
    expect(source().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: buttonName }).hasAttribute('disabled')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('downloads the entire displayed server response with nulls, future fields, context and exact numbers without another request', async () => {
    const original = comparison()
    const server = {
      ...original,
      baseline: {
        ...original.baseline,
        current: null,
        account_context: null,
        future_source: { unavailable: null, reasons: ['synthetic_unverifiable'] },
      },
      comparison: {
        ...original.comparison,
        account_context: { account_id: 'synthetic-paper-account', future_policy: null },
      },
      future_metadata: { nullable: null, values: [null, 0, false], label: '合成 "來源"\n第二行' },
      current_at_snapshot: null,
    }
    server.rows[0].comparison.score = known(75.12345678912345)
    const expected = structuredClone(server)
    const fetcher = vi.fn(async () => response(server))
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(downloadButton())
    expect(download.createObjectURL).not.toHaveBeenCalled()
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    expect(downloadButton()).toHaveProperty('disabled', false)
    await userEvent.click(downloadButton())
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(download.createObjectURL).toHaveBeenCalledTimes(1)
    const blob = download.createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(await readJson(blob)).toEqual(expected)
    expect(server).toEqual(expected)
    expect(download.links).toEqual([
      {
        filename: `alphaview-saved-workflow-comparison-${server.as_of}-${baseline.id}-${run.id}.json`,
        href: 'blob:saved-comparison',
        attached: true,
      },
    ])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(download.revokeObjectURL).not.toHaveBeenCalled()
    expect(download.revocations).toHaveLength(1)
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:saved-comparison')
  })

  it('uses a safe bounded filename without rewriting source IDs or session in the JSON', async () => {
    const unsafeRun = { ...run, id: '../<synthetic run>/' + 'r'.repeat(200) }
    const unsafeBaseline = { ...baseline, id: '../<synthetic baseline>/' + 'b'.repeat(200) }
    const server = {
      ...comparison(),
      as_of: '../2026-10-01\n' + 's'.repeat(200),
      baseline: { ...comparison().baseline, id: unsafeBaseline.id },
      comparison: { ...comparison().comparison, id: unsafeRun.id },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(server)),
    )
    const download = mockDownload()
    render(<SavedWorkflowComparison run={unsafeRun} history={[unsafeBaseline]} t={t} />)
    await choose(unsafeBaseline.id)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByText('Synthetic saved observation method.')
    await userEvent.click(downloadButton())
    expect(download.links[0].filename).toMatch(
      /^alphaview-saved-workflow-comparison-[a-zA-Z0-9_-]+\.json$/,
    )
    expect(download.links[0].filename.length).toBeLessThan(240)
    expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(server)
  })

  it.each([
    'baseline_selection',
    'comparison_run',
    'source_revision',
    'account_context',
    'baseline_context',
  ] as const)('invalidates an available download after %s changes', async (change) => {
    const fetcher = vi.fn(async () => response(comparison()))
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    const view = render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    expect(downloadButton()).toHaveProperty('disabled', false)
    const accountContext = {
      account_id: 'synthetic-other-account',
      symbol_policy: { engine_version: 'synthetic-v1', version: 2, mode: 'market', symbols: [] },
    }
    if (change === 'baseline_selection') await choose(third.id)
    else {
      const changedRun =
        change === 'comparison_run'
          ? { ...run, id: 'synthetic-other-run' }
          : change === 'source_revision'
            ? { ...run, input_revision: 'synthetic:2' }
            : change === 'account_context'
              ? { ...run, account_context: accountContext }
              : run
      const changedHistory =
        change === 'baseline_context'
          ? [{ ...baseline, account_context: accountContext }, third]
          : history
      view.rerender(<SavedWorkflowComparison run={changedRun} history={changedHistory} t={t} />)
    }
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(downloadButton())
    expect(download.createObjectURL).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Synthetic saved observation method.')).toBeNull()
  })

  it('cannot download a previous account after the parent account key changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(comparison())),
    )
    const download = mockDownload()
    const view = render(
      <SavedWorkflowComparison key="synthetic-account-a" run={run} history={history} t={t} />,
    )
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    const oldButton = downloadButton()
    view.rerender(
      <SavedWorkflowComparison key="synthetic-account-b" run={run} history={history} t={t} />,
    )
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(oldButton)
    fireEvent.click(downloadButton())
    expect(download.createObjectURL).not.toHaveBeenCalled()
  })

  it('disables the previous download immediately while a new comparison waits and after it fails', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(comparison()))
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof response>>((done) => {
            resolve = done
          }),
      )
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    const oldDownload = downloadButton()
    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    expect(screen.getByRole('button', { name: 'Comparing…' })).toHaveProperty('disabled', true)
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(oldDownload)
    expect(download.createObjectURL).not.toHaveBeenCalled()
    await act(async () => resolve(response({ detail: { message: 'Synthetic unavailable' } }, 404)))
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic unavailable')
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(downloadButton())
    expect(download.createObjectURL).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['baseline', 'comparison', 'fingerprint'] as const)(
    'rejects downloads after the server returns the wrong %s identity',
    async (mismatch) => {
      const server = comparison()
      if (mismatch === 'baseline') server.baseline.id = 'synthetic-wrong'
      else if (mismatch === 'comparison') server.comparison.id = 'synthetic-wrong'
      else server.comparison.proposal_fingerprint = 'wrong'
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(server)),
      )
      const download = mockDownload()
      render(<SavedWorkflowComparison run={run} history={history} t={t} />)
      await compare()
      expect((await screen.findByRole('alert')).textContent).toContain(
        'saved workflow identity does not match',
      )
      expect(downloadButton()).toHaveProperty('disabled', true)
      fireEvent.click(downloadButton())
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it.each([NaN, Infinity, -Infinity])(
    'does not silently serialize a nonfinite future field (%s) as null',
    async (number) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response({ ...comparison(), future_field: number })),
      )
      const download = mockDownload()
      render(<SavedWorkflowComparison run={run} history={history} t={t} />)
      await compare()
      await screen.findByText('Synthetic saved observation method.')
      await userEvent.click(downloadButton())
      expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it('reports a refused download and cleans up its temporary anchor and object URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(comparison())),
    )
    const download = mockDownload()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    render(<SavedWorkflowComparison run={run} history={history} t={t} />)
    await compare()
    await screen.findByText('Synthetic saved observation method.')
    await userEvent.click(downloadButton())
    expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
    expect(document.querySelector('a[download]')).toBeNull()
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:saved-comparison')
  })
})
