import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAgentSetup, PortfolioLocalAgent } from './PortfolioLocalAgent'
import type { AgentRunSummary } from './portfolio-agent-model'
import {
  defaultLocalAgentDraft,
  localAgentDraftKey,
  type LocalAgentCatalog,
  type LocalAgentIntegrity,
  type LocalAgentRun,
} from './local-agent-model'
import type { PaperAccount, PaperPreview, PaperProposal } from './paper-model'

const source: AgentRunSummary = {
  id: 'synthetic-source-run',
  created_at: '2026-09-18T22:00:00Z',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2026-09-18',
  status: 'proposed',
  scope: 'market',
  coverage: { requested: 4, complete: 4, eligible: 1, selected: 1, rejected: 3 },
  target_weights: [{ symbol: 'SYNTA', weight_pct: 16 }],
  cash_weight_pct: 84,
  current: true,
  stale_reasons: [],
}
const t = (_zh: string, en: string) => en
afterEach(() => {
  sessionStorage.clear()
  vi.useRealTimers()
})

const account: PaperAccount = {
  id: 'synthetic-local-account',
  name: 'Synthetic local account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-18T22:00:00Z',
  updated_at: '2026-09-18T22:00:00Z',
}
const catalog: LocalAgentCatalog = {
  engine_version: 'alphaview-local-agent-v1',
  endpoint: 'http://127.0.0.1:11434',
  available: true,
  server_version: 'synthetic',
  cloud_disabled: true,
  models: [
    {
      name: 'synthetic-local-model:small',
      digest: 'a'.repeat(64),
      size: 1000000,
      modified_at: '2026-09-18T22:00:00Z',
      details: { format: 'gguf' },
      status: 'installed',
    },
  ],
  rejected_models: [],
  reason: null,
  max_selected: 10,
  inference_timeout_seconds: 120,
  modes: ['analysis', 'conservative'],
  method: 'Synthetic method.',
}
function localRun(extra: Partial<LocalAgentRun> = {}): LocalAgentRun {
  const fact = {
    id: 'candidate:SYNTA:coverage',
    kind: 'coverage',
    value: 100,
    symbol: 'SYNTA',
    as_of: '2026-09-18',
    scan_id: 1,
  }
  return {
    id: 'synthetic-local-run',
    engine_version: catalog.engine_version,
    source_run_id: source.id,
    status: 'completed',
    stored_status: 'completed',
    phase: 'finished',
    cancel_requested: false,
    created_at: '2026-09-18T22:01:00Z',
    started_at: '2026-09-18T22:01:01Z',
    finished_at: '2026-09-18T22:01:10Z',
    as_of: '2026-09-18',
    input_revision: 'synthetic:1',
    request: {
      source_run_id: source.id,
      model: catalog.models[0].name,
      mode: 'analysis',
      idempotency_key: 'synthetic-request',
    },
    model: catalog.models[0],
    error: null,
    proposal_ready: true,
    target_weights: source.target_weights,
    cash_weight_pct: 84,
    single_model_pass: true,
    current: true,
    stale_reasons: [],
    source: {
      id: source.id,
      engine_version: source.engine_version,
      as_of: source.as_of,
      input_revision: 'synthetic:1',
      proposal_fingerprint: 'synthetic-fingerprint',
      scan: {
        id: 1,
        as_of: source.as_of,
        engine_version: 'synthetic-scan',
        input_status: 'current',
      },
      target_weights: source.target_weights,
      cash_weight_pct: 84,
      constraints: {
        min_score: 25,
        min_matches: 1,
        max_positions: 5,
        max_position_weight_pct: 25,
        cash_buffer_pct: 20,
      },
      strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
    },
    facts: [fact],
    result: {
      raw_content: '{"synthetic":true}',
      output_digest: 'synthetic-output',
      output: { synthetic: true },
      role_views: ['research_analyst', 'allocation_reviewer', 'risk_reviewer'].map((role) => ({
        role: role as 'research_analyst' | 'allocation_reviewer' | 'risk_reviewer',
        assessment: 'supported',
        findings: [
          {
            code: 'complete_evidence',
            evidence_ids: [fact.id],
            text: '證據完整',
            evidence: [fact],
          },
        ],
      })),
      decisions: [
        {
          symbol: 'SYNTA',
          action: 'retain',
          reason_code: 'rule_consensus',
          evidence_ids: ['candidate:SYNTA:score'],
          text: '合成規則共識',
          evidence: [{ ...fact, id: 'candidate:SYNTA:score', kind: 'score', value: 25 }],
          original_weight_pct: 16,
          target_weight_pct: 16,
        },
      ],
      target_weights: source.target_weights,
      cash_weight_pct: 84,
      proposal_ready: true,
      validation: { valid: true, issues: [] },
      metrics: { total_duration: 9000000000, eval_count: null },
    },
    prompt_version: 'synthetic-prompt-v1',
    prompt_digest: 'synthetic-prompt',
    schema_digest: 'synthetic-schema',
    options: { temperature: 0 },
    method: 'Synthetic method.',
    warnings: [],
    ...extra,
  }
}
const preview: PaperPreview = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: source.as_of,
  input_revision: 'synthetic:1',
  account_id: account.id,
  account_version: 1,
  limits: account.limits,
  targets: source.target_weights,
  coverage: { required: 1, priced: 1, missing: [] },
  valuation_complete: true,
  equity_before: 10000,
  equity_after: 10000,
  cash_before: 10000,
  cash_after: 8400,
  cash_weight_after_pct: 84,
  turnover_pct: 16,
  fees_total: 0,
  slippage_total: 0,
  cost_total: 0,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 16,
      reference_price: 100,
      fill_price: 100,
      fee: 0,
      notional: 1600,
      current_shares: 0,
      target_shares: 16,
      target_weight_pct: 16,
      projected_weight_pct: 16,
    },
  ],
  violations: [],
  executable: true,
  method: 'Synthetic preview.',
  warnings: [],
}
const proposal: PaperProposal = {
  ...preview,
  id: 'synthetic-local-proposal',
  status: 'proposed',
  created_at: '2026-09-18T22:02:00Z',
  accepted_at: null,
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
function mockApi(
  options: {
    history?: LocalAgentRun[]
    run?: LocalAgentRun
    preview?: PaperPreview
    catalog?: LocalAgentCatalog
    handler?: (url: string, init?: RequestInit) => unknown
  } = {},
) {
  const run = options.run || localRun()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = options.handler?.(url, init)
    if (custom !== undefined) return custom
    if (url === '/api/local-agent/models') return response(options.catalog || catalog)
    if (url === '/api/portfolio-agent/runs?limit=100')
      return response({
        runs: [source],
        as_of: source.as_of,
        input_revision: 'synthetic:1',
        engine_version: source.engine_version,
        method: 'Synthetic rules.',
      })
    if (url === '/api/local-agent/runs?limit=20')
      return response({
        runs: options.history || [],
        as_of: source.as_of,
        input_revision: 'synthetic:1',
        engine_version: catalog.engine_version,
        method: 'Synthetic local.',
      })
    if (url === '/api/local-agent/runs' || url === `/api/local-agent/runs/${run.id}`)
      return response(run)
    if (url.endsWith('/paper-preview'))
      return response({
        analysis_id: run.id,
        engine_version: catalog.engine_version,
        paper_preview: options.preview || preview,
        method: 'Synthetic bridge.',
      })
    if (url.endsWith('/paper-proposal'))
      return response({
        analysis_id: run.id,
        engine_version: catalog.engine_version,
        paper_proposal: proposal,
        method: 'Synthetic bridge.',
      })
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function selectInputs() {
  await screen.findByRole('option', { name: catalog.models[0].name })
  fireEvent.change(screen.getByRole('combobox', { name: 'Source rule workflow' }), {
    target: { value: source.id },
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Installed local model' }), {
    target: { value: catalog.models[0].name },
  })
}
async function launch() {
  await selectInputs()
  await userEvent.click(screen.getByRole('button', { name: 'Start local analysis' }))
  await screen.findByRole('region', { name: 'Local analysis details' })
}

describe('local model analysis setup', () => {
  it('requires a current saved source and installed model before explicitly starting', async () => {
    const onStart = vi.fn((event) => event.preventDefault())
    const onChange = vi.fn()
    const props = {
      draft: defaultLocalAgentDraft(),
      onChange,
      sources: [source],
      models: ['synthetic-local-model:small'],
      available: true,
      loading: false,
      starting: false,
      onRefresh: vi.fn(),
      onStart,
      t,
    }
    const view = render(<LocalAgentSetup {...props} />)
    expect(
      (screen.getByRole('button', { name: 'Start local analysis' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed local model' }), {
      target: { value: 'synthetic-local-model:small' },
    })
    expect(onChange).toHaveBeenCalledWith({
      sourceRunId: '',
      model: 'synthetic-local-model:small',
      mode: 'analysis',
    })
    expect(onStart).not.toHaveBeenCalled()
    view.rerender(
      <LocalAgentSetup
        {...props}
        draft={{
          sourceRunId: source.id,
          model: 'synthetic-local-model:small',
          mode: 'conservative',
        }}
      />,
    )
    expect(
      screen.getByText(/One inference produces research, allocation and risk perspectives/),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Start local analysis' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('keeps stale selections visible but disables launch when source or installed model is unavailable', () => {
    const view = render(
      <LocalAgentSetup
        draft={{ sourceRunId: source.id, model: 'synthetic-local-model:small', mode: 'analysis' }}
        onChange={vi.fn()}
        sources={[{ ...source, current: false, stale_reasons: ['inputs_changed'] }]}
        models={[]}
        available={false}
        loading={false}
        starting={false}
        onRefresh={vi.fn()}
        onStart={vi.fn()}
        t={t}
      />,
    )
    expect(
      (screen.getByRole('combobox', { name: 'Source rule workflow' }) as HTMLSelectElement).value,
    ).toBe(source.id)
    expect(
      (screen.getByRole('combobox', { name: 'Installed local model' }) as HTMLSelectElement).value,
    ).toBe('synthetic-local-model:small')
    expect(
      (screen.getByRole('button', { name: 'Start local analysis' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText('The local model service is currently unavailable.')).toBeTruthy()
    view.rerender(
      <LocalAgentSetup
        draft={{ sourceRunId: source.id, model: 'synthetic-local-model:small', mode: 'analysis' }}
        onChange={vi.fn()}
        sources={[source]}
        models={['synthetic-local-model:small']}
        available
        loading={false}
        starting={false}
        onRefresh={vi.fn()}
        onStart={vi.fn()}
        t={t}
      />,
    )
    expect(
      (screen.getByRole('button', { name: 'Start local analysis' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('local model analysis workflow', () => {
  it('creates a real local-analysis job, shows cited role output and saves a previewed proposal without accepting it', async () => {
    const fetcher = mockApi()
    const onProposal = vi.fn()
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={onProposal} />)
    await selectInputs()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Start local analysis' }))
    await screen.findByText('Model output passed rule validation')
    expect(screen.getByRole('heading', { name: 'Research perspective' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Allocation perspective' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Risk perspective' })).toBeTruthy()
    expect(screen.getAllByText('candidate:SYNTA:coverage').length).toBeGreaterThan(0)
    const create = fetcher.mock.calls.find(([url]) => url === '/api/local-agent/runs')
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      source_run_id: source.id,
      model: catalog.models[0].name,
      mode: 'analysis',
      idempotency_key: expect.any(String),
    })
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper account checks passed')
    await userEvent.click(screen.getByRole('button', { name: 'Save paper proposal' }))
    await screen.findByText(/Paper proposal saved; not executed/)
    expect(onProposal).toHaveBeenCalledWith(proposal)
    const paths = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => url)
    expect(paths).toEqual([
      '/api/local-agent/runs',
      '/api/local-agent/runs/synthetic-local-run/paper-preview',
      '/api/local-agent/runs/synthetic-local-run/paper-proposal',
    ])
  })

  it('polls actual phases until complete and then stops polling', async () => {
    const queued = localRun({
      status: 'queued',
      stored_status: 'queued',
      phase: 'source_check',
      result: null,
      target_weights: [],
      cash_weight_pct: null,
      proposal_ready: false,
      started_at: null,
      finished_at: null,
    })
    const fetcher = mockApi({
      run: queued,
      handler: (url) =>
        url === '/api/local-agent/runs/synthetic-local-run' ? response(localRun()) : undefined,
    })
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await selectInputs()
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Local model analysis settings' }))
    })
    expect(screen.getByText('Waiting to start')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('Model output passed rule validation')).toBeTruthy()
    const count = fetcher.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(fetcher.mock.calls).toHaveLength(count)
  })

  it('shows cancellation as pending until the runtime confirms completion', async () => {
    const running = localRun({
      status: 'running',
      stored_status: 'running',
      phase: 'local_inference',
      result: null,
      target_weights: [],
      cash_weight_pct: null,
      proposal_ready: false,
      finished_at: null,
    })
    let cancelled = false
    mockApi({
      run: running,
      handler: (url) => {
        if (url.endsWith('/cancel')) {
          cancelled = true
          return response({ ...running, cancel_requested: true })
        }
        if (cancelled && url === '/api/local-agent/runs/synthetic-local-run')
          return response({
            ...running,
            status: 'cancelled',
            stored_status: 'cancelled',
            phase: 'finished',
            cancel_requested: true,
          })
      },
    })
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await launch()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this analysis' }))
    await screen.findByText(/cancellation is not yet complete/)
    expect(
      (screen.getByRole('button', { name: 'Cancel this analysis' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh analysis status' }))
    await waitFor(() => expect(screen.queryByText(/cancellation is not yet complete/)).toBeNull())
    expect(
      within(screen.getByRole('region', { name: 'Local analysis details' })).getByText('Cancelled'),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('keeps invalid model output readable but never enables its paper bridge', async () => {
    const result = localRun().result!
    const blocked = localRun({
      status: 'blocked',
      stored_status: 'blocked',
      proposal_ready: false,
      target_weights: [],
      cash_weight_pct: null,
      result: {
        ...result,
        proposal_ready: false,
        target_weights: [],
        cash_weight_pct: null,
        validation: { valid: false, issues: [{ code: 'invalid_citation', message: '引用無效' }] },
        raw_content: '<script>synthetic-untrusted-output</script>',
      },
    })
    mockApi({ run: blocked })
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await launch()
    expect(screen.getByText(/An evidence citation is unknown or duplicated/)).toBeTruthy()
    expect(screen.queryByText('<script>synthetic-untrusted-output</script>')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reveal raw model text' }))
    expect(screen.getByText('<script>synthetic-untrusted-output</script>').tagName).toBe('PRE')
    expect(document.querySelector('script')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Hide raw model text' }))
    expect(screen.queryByText('<script>synthetic-untrusted-output</script>')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('reads stale history without launching inference and refuses a new proposal', async () => {
    const stale = localRun({
      status: 'stale',
      current: false,
      proposal_ready: false,
      stale_reasons: ['source_run_stale_or_unavailable'],
    })
    const fetcher = mockApi({ history: [stale], run: stale })
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /synthetic-lo/ }))
    await screen.findByText(/Its history remains readable/)
    expect(screen.getByText('The source workflow is stale or unavailable')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('reuses an ambiguous launch request key across a remount and keeps the user draft', async () => {
    let attempts = 0
    const fetcher = mockApi({
      handler: (url) => {
        if (url === '/api/local-agent/runs' && ++attempts === 1)
          return Promise.reject(new Error('Synthetic disconnected response'))
      },
    })
    const view = render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await selectInputs()
    fireEvent.change(screen.getByRole('combobox', { name: 'Model allocation scope' }), {
      target: { value: 'conservative' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start local analysis' }))
    await screen.findByText('Synthetic disconnected response')
    view.unmount()
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByRole('option', { name: catalog.models[0].name })
    expect(
      (screen.getByRole('combobox', { name: 'Model allocation scope' }) as HTMLSelectElement).value,
    ).toBe('conservative')
    await userEvent.click(screen.getByRole('button', { name: 'Start local analysis' }))
    await screen.findByRole('region', { name: 'Local analysis details' })
    const keys = fetcher.mock.calls
      .filter(([url]) => url === '/api/local-agent/runs')
      .map(([, init]) => JSON.parse(String(init?.body)).idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('invalidates a paper preview on account changes and preserves local input choices', async () => {
    mockApi()
    const view = render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await launch()
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper account checks passed')
    view.rerender(
      <PortfolioLocalAgent account={{ ...account, version: 2 }} locale="en" onProposal={vi.fn()} />,
    )
    expect(screen.queryByText('Paper account checks passed')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await waitFor(() =>
      expect(
        (screen.getByRole('combobox', { name: 'Installed local model' }) as HTMLSelectElement)
          .value,
      ).toBe(catalog.models[0].name),
    )
    expect(
      JSON.parse(sessionStorage.getItem(localAgentDraftKey(account.id)) || '{}').sourceRunId,
    ).toBe(source.id)
  })

  it('shows paper risk blockers and missing values without saving an executable proposal', async () => {
    const fetcher = mockApi({
      preview: {
        ...preview,
        executable: false,
        cash_after: null,
        turnover_pct: null,
        orders: [],
        fees_total: null,
        slippage_total: null,
        coverage: { required: 1, priced: 0, missing: ['SYNTA'] },
        violations: [{ code: 'quote_unavailable', message: '缺價', symbol: 'SYNTA' }],
      },
    })
    render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
    await launch()
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper account checks blocked')
    expect(screen.getByText(/A current valid USD reference price is unavailable/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/paper-proposal'))).toBe(false)
  })
})

function integrityReceipt(extra: Partial<LocalAgentIntegrity> = {}): LocalAgentIntegrity {
  return {
    engine_version: 'alphaview-local-agent-integrity-v1',
    analysis_id: 'synthetic-local-run',
    source_run_id: source.id,
    as_of: source.as_of,
    input_revision: 'synthetic:1',
    status: 'verified',
    verified: true,
    checks: [
      { code: 'saved_facts', status: 'passed', reason: null },
      { code: 'structured_output', status: 'passed', reason: null },
    ],
    citation_coverage: {
      claims: 4,
      claims_with_valid_references: 4,
      citations: 4,
      known_citations: 4,
      unknown_ids: [],
      duplicate_citations: 0,
      coverage_pct: 100,
    },
    validation_issues: [],
    source_currentness: { current: true, stale_reasons: [] },
    proposal_eligible: true,
    authorization_fingerprint: 'b'.repeat(64),
    method: 'Synthetic offline evidence verification.',
    ...extra,
  }
}

it('verifies saved evidence only on request without launching another model or disturbing the paper bridge', async () => {
  const fetcher = mockApi({
    history: [localRun()],
    handler: (url) => (url.endsWith('/integrity') ? response(integrityReceipt()) : undefined),
  })
  render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: /synthetic-lo/ }))
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/integrity'))).toBe(false)
  expect(screen.queryByText(localRun().result!.raw_content)).toBeNull()
  const before = fetcher.mock.calls.length
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  await screen.findByText('Historical evidence verified')
  const panel = screen.getByRole('region', { name: 'Saved evidence verification' })
  expect(within(panel).getByText(/Claims with valid references/).textContent).toContain('4 / 4')
  expect(within(panel).getByText(/Citation coverage/).textContent).toContain('100.00%')
  expect(fetcher.mock.calls.slice(before).map(([url]) => url)).toEqual([
    '/api/local-agent/runs/synthetic-local-run/integrity',
  ])
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  expect(
    (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
})

it('disables the bridge when saved evidence fails and shows exact check reasons with unavailable coverage', async () => {
  mockApi({
    handler: (url) =>
      url.endsWith('/integrity')
        ? response(
            integrityReceipt({
              status: 'failed',
              verified: false,
              proposal_eligible: false,
              citation_coverage: null,
              checks: [
                {
                  code: 'saved_facts',
                  status: 'failed',
                  reason: { code: 'saved_facts_mismatch', message: '保存事實不符' },
                },
              ],
            }),
          )
        : undefined,
  })
  render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await launch()
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  await screen.findByText('Saved evidence verification failed')
  expect(screen.getByText(/Saved facts do not match facts reconstructed/)).toBeTruthy()
  const panel = screen.getByRole('region', { name: 'Saved evidence verification' })
  expect(within(panel).getByText(/Claims with valid references/).textContent).toContain('—')
  expect(
    (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

it('keeps a stale source blocked even when its historical evidence verifies', async () => {
  const stale = localRun({
    status: 'stale',
    current: false,
    proposal_ready: false,
    stale_reasons: ['source_run_stale_or_unavailable'],
  })
  mockApi({
    history: [stale],
    run: stale,
    handler: (url) =>
      url.endsWith('/integrity')
        ? response(
            integrityReceipt({
              proposal_eligible: false,
              source_currentness: {
                current: false,
                stale_reasons: ['source_run_stale_or_unavailable'],
              },
            }),
          )
        : undefined,
  })
  render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: /synthetic-lo/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  await screen.findByText('Historical evidence verified')
  expect(
    screen.getByText('The source is stale or unavailable and cannot support a new proposal.'),
  ).toBeTruthy()
  expect(
    (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

it('rejects a verification receipt for a different analysis and does not display its verdict', async () => {
  mockApi({
    handler: (url) =>
      url.endsWith('/integrity')
        ? response(integrityReceipt({ analysis_id: 'wrong-analysis' }))
        : undefined,
  })
  render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await launch()
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  await screen.findByText(
    'The verification response does not match this analysis. Reload the analysis.',
  )
  expect(screen.queryByText('Historical evidence verified')).toBeNull()
})

it('aborts a pending integrity request on account switch and ignores its late receipt', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const pending = new Promise<ReturnType<typeof response>>((resolve) => {
    finish = resolve
  })
  const fetcher = mockApi({ handler: (url) => (url.endsWith('/integrity') ? pending : undefined) })
  const view = render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await launch()
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  const request = fetcher.mock.calls.find(([url]) => url.endsWith('/integrity'))![1]
  view.rerender(
    <PortfolioLocalAgent
      account={{ ...account, id: 'synthetic-other-account' }}
      locale="en"
      onProposal={vi.fn()}
    />,
  )
  expect(request?.signal?.aborted).toBe(true)
  await act(async () => finish(response(integrityReceipt())))
  expect(screen.queryByRole('region', { name: 'Local analysis details' })).toBeNull()
  expect(screen.queryByText('Historical evidence verified')).toBeNull()
})

it('clears prior verification and masks raw text again when a different saved run is selected', async () => {
  const second = localRun({ id: 'other-local-run' })
  mockApi({
    history: [localRun(), second],
    handler: (url) => {
      if (url === '/api/local-agent/runs/other-local-run') return response(second)
      if (url.endsWith('/integrity')) return response(integrityReceipt())
    },
  })
  render(<PortfolioLocalAgent account={account} locale="en" onProposal={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: /synthetic-lo/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Verify saved evidence' }))
  await screen.findByText('Historical evidence verified')
  await userEvent.click(screen.getByRole('button', { name: 'Reveal raw model text' }))
  expect(screen.getByText(localRun().result!.raw_content).tagName).toBe('PRE')
  await userEvent.click(screen.getByRole('button', { name: /other-local/ }))
  await screen.findByText(/Analysis ID.*other-local-run/)
  expect(screen.queryByText('Historical evidence verified')).toBeNull()
  expect(screen.queryByText(second.result!.raw_content)).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Reveal raw model text' }).getAttribute('aria-expanded'),
  ).toBe('false')
})
