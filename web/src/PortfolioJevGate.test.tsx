import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioJevGate } from './PortfolioJevGate'
import type { AgentRunSummary } from './portfolio-agent-model'
import type { JevConnection, JevQuestionSet, JevRun } from './jev-model'
import type { PaperAccount, PaperPreview, PaperProposal } from './paper-model'

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

const account: PaperAccount = {
  id: 'synthetic-jev-account',
  name: 'Synthetic jev account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const source: AgentRunSummary = {
  id: 'synthetic-source-run',
  created_at: '2026-09-29T22:00:00Z',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2026-09-29',
  status: 'proposed',
  scope: 'market',
  coverage: { requested: 2, complete: 2, eligible: 2, selected: 2, rejected: 0 },
  target_weights: [
    { symbol: 'SYNTA', weight_pct: 16 },
    { symbol: 'SYNTB', weight_pct: 16 },
  ],
  cash_weight_pct: 68,
  current: true,
  stale_reasons: [],
}
const unconfigured: JevConnection = {
  engine_version: 'alphaview-jev-decision-v1',
  question_set_version: 'alphaview-jev-questions-v1',
  provider: 'TypeSafe',
  product: 'Jev',
  endpoint: 'https://api.typesafe.ai',
  model: 'jev-1.13.0',
  configured: false,
  version: null,
  connected_at: null,
  available_models: [],
  capabilities: ['models.read', 'systemone.evaluate'],
  trading_enabled: false,
  price_basis: 'Synthetic price basis.',
  method: 'Synthetic method.',
}
const configured: JevConnection = {
  ...unconfigured,
  configured: true,
  version: 'synthetic-version',
  connected_at: '2026-09-29T22:00:00Z',
  available_models: ['jev-latest'],
}
const questions: JevQuestionSet = {
  engine_version: unconfigured.engine_version,
  question_set_version: unconfigured.question_set_version,
  model: 'jev-1.13.0',
  language: 'en',
  default_policy: { pass_threshold: 0.7, max_risk_probability: 0.5 },
  max_selected: 10,
  questions: [
    {
      id: 'uptrend_intact',
      type: 'noul',
      gate: 'high',
      label: '趨勢完整',
      english: 'Uptrend intact',
      instructions: 'Is `candidates.<symbol>` in an intact uptrend?',
      criteria: { true: 'yes', false: 'no' },
    },
    {
      id: 'buying_pressure',
      type: 'noul',
      gate: 'high',
      label: '買盤增強',
      english: 'Buying pressure',
      instructions: 'Is buying pressure building in `candidates.<symbol>`?',
      criteria: { true: 'yes', false: 'no' },
    },
    {
      id: 'overextended',
      type: 'noul',
      gate: 'low',
      label: '過度延伸',
      english: 'Overextended',
      instructions: 'Is `candidates.<symbol>` overextended?',
      criteria: { true: 'yes', false: 'no' },
    },
    {
      id: 'setup_quality',
      type: 'score',
      gate: null,
      label: '設定品質',
      english: 'Setup quality',
      instructions: 'How constructive is `candidates.<symbol>`?',
      criteria: ['Weak', 'Mixed', 'Constructive', 'Strong'],
    },
  ],
  state_fields: ['trend_structure'],
  price_basis: 'Synthetic price basis.',
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
}
function check(question: string, value: number, direction: 'high' | 'low', threshold: number) {
  const passed = direction === 'high' ? value >= threshold : value <= threshold
  return {
    question_id: `SYNTA:${question}`,
    question,
    label: question,
    english: question,
    direction,
    value,
    threshold,
    passed,
    reason: null,
  }
}
function jevRun(extra: Partial<JevRun> = {}): JevRun {
  const decisions = [
    {
      symbol: 'SYNTA',
      key: 'SYNTA',
      original_weight_pct: 16,
      evidence_complete: true,
      missing: [],
      status: 'pass' as const,
      checks: [
        check('uptrend_intact', 0.96, 'high', 0.7),
        check('buying_pressure', 0.92, 'high', 0.7),
        check('overextended', 0.32, 'low', 0.5),
      ],
      setup_quality: {
        question_id: 'SYNTA:setup_quality',
        score: 2.95,
        confidence: 0.95,
        probabilities: { '3': 0.96 },
        level_label: 'Strong',
      },
      target_weight_pct: 16,
    },
    {
      symbol: 'SYNTB',
      key: 'SYNTB',
      original_weight_pct: 16,
      evidence_complete: true,
      missing: [],
      status: 'fail' as const,
      checks: [
        check('uptrend_intact', 0.9, 'high', 0.7),
        check('buying_pressure', 0.41, 'high', 0.7),
        check('overextended', 0.2, 'low', 0.5),
      ],
      setup_quality: null,
      target_weight_pct: 0,
    },
  ]
  return {
    id: 'synthetic-jev-run',
    engine_version: unconfigured.engine_version,
    question_set_version: unconfigured.question_set_version,
    source_run_id: source.id,
    status: 'completed',
    stored_status: 'completed',
    created_at: '2026-09-29T22:01:00Z',
    as_of: source.as_of,
    input_revision: 'synthetic:1',
    request: {
      source_run_id: source.id,
      policy: { pass_threshold: 0.7, max_risk_probability: 0.5 },
      idempotency_key: 'synthetic-request',
    },
    policy: { pass_threshold: 0.7, max_risk_probability: 0.5 },
    model: { requested: 'jev-1.13.0', answered: 'jev-1.13.0' },
    latency_ms: 231,
    usage: { input_tokens: 658, output_tokens: 90 },
    estimated_cost_usd: 0.000027636,
    error: null,
    counts: { pass: 1, fail: 1, unavailable: 0 },
    proposal_ready: true,
    target_weights: [
      { symbol: 'SYNTA', weight_pct: 16 },
      { symbol: 'SYNTB', weight_pct: 0 },
    ],
    cash_weight_pct: 84,
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
      cash_weight_pct: 68,
      constraints: {
        min_score: 50,
        min_matches: 1,
        max_positions: 5,
        max_position_weight_pct: 25,
        cash_buffer_pct: 20,
      },
      strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
    },
    state: {
      as_of: source.as_of,
      price_basis: 'synthetic',
      candidates: { SYNTA: { trend_structure: 'synthetic' } },
    },
    questions: { 'SYNTA:uptrend_intact': { type: 'noul', instructions: 'synthetic' } },
    request_digest: 'synthetic-digest',
    answers: { 'SYNTA:uptrend_intact': { type: 'noul', noul: 0.96 } },
    result: {
      policy: { pass_threshold: 0.7, max_risk_probability: 0.5 },
      decisions,
      counts: { pass: 1, fail: 1, unavailable: 0 },
      blocking_reasons: [],
      target_weights: [
        { symbol: 'SYNTA', weight_pct: 16 },
        { symbol: 'SYNTB', weight_pct: 0 },
      ],
      cash_weight_pct: 84,
      proposal_ready: true,
    },
    price_basis: 'Synthetic price basis.',
    method: 'Synthetic method.',
    warnings: ['Synthetic run warning.'],
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
  targets: [{ symbol: 'SYNTA', weight_pct: 16 }],
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
  id: 'synthetic-jev-proposal',
  status: 'proposed',
  created_at: '2026-09-29T22:02:00Z',
  accepted_at: null,
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
function mockApi(
  options: {
    connection?: JevConnection
    run?: JevRun
    history?: JevRun[]
    handler?: (url: string, init?: RequestInit) => unknown
  } = {},
) {
  const run = options.run || jevRun()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = options.handler?.(url, init)
    if (custom !== undefined) return custom
    if (url === '/api/jev/connection' && (!init?.method || init.method === 'GET'))
      return response(options.connection || configured)
    if (url === '/api/jev/connection' && init?.method === 'POST') return response(configured)
    if (url === '/api/jev/questions') return response(questions)
    if (url === '/api/portfolio-agent/runs?limit=100')
      return response({
        runs: [source, { ...source, id: 'stale-source', current: false }],
        as_of: source.as_of,
        input_revision: 'synthetic:1',
        engine_version: source.engine_version,
        method: 'Synthetic rules.',
      })
    if (url === '/api/jev/runs?limit=20')
      return response({
        runs: options.history || [],
        as_of: source.as_of,
        input_revision: 'synthetic:1',
        engine_version: unconfigured.engine_version,
        question_set_version: unconfigured.question_set_version,
        model: 'jev-1.13.0',
        usage_summary: {
          listed_runs: (options.history || []).length,
          evaluated_runs: (options.history || []).length,
          average_latency_ms: 231,
          average_input_tokens: 658,
          average_estimated_cost_usd: 0.000027636,
          total_estimated_cost_usd: 0.000027636,
          price_basis: 'Synthetic price basis.',
        },
        method: 'Synthetic.',
      })
    if (url === '/api/jev/runs' && init?.method === 'POST') return response(run, 201)
    if (url === `/api/jev/runs/${run.id}`) return response(run)
    if (url === `/api/jev/runs/${run.id}/outcomes`)
      return response({
        engine_version: unconfigured.engine_version,
        run_id: run.id,
        as_of: run.as_of,
        latest_completed_session: '2026-09-30',
        input_revision: 'synthetic:1',
        items: [
          {
            symbol: 'SYNTA',
            gate_status: 'pass',
            target_weight_pct: 16,
            decision_session: run.as_of,
            latest_session: '2026-09-30',
            sessions_elapsed: 1,
            forward_return_pct: 2.5,
            available: true,
            reason: null,
          },
          {
            symbol: 'SYNTB',
            gate_status: 'fail',
            target_weight_pct: 0,
            decision_session: run.as_of,
            latest_session: null,
            sessions_elapsed: 0,
            forward_return_pct: null,
            available: false,
            reason: 'no_later_session',
          },
        ],
        method: 'Synthetic outcomes.',
      })
    if (url.endsWith('/paper-preview'))
      return response({
        run_id: run.id,
        engine_version: unconfigured.engine_version,
        paper_preview: preview,
        method: 'Synthetic bridge.',
      })
    if (url.endsWith('/paper-proposal'))
      return response({
        run_id: run.id,
        engine_version: unconfigured.engine_version,
        paper_proposal: proposal,
        method: 'Synthetic bridge.',
      })
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const body = (fetcher: ReturnType<typeof mockApi>, url: string, method: string) =>
  JSON.parse(
    String(
      fetcher.mock.calls.find(
        ([callUrl, init]) => callUrl === url && (init as RequestInit)?.method === method,
      )?.[1]?.body,
    ),
  )

describe('Jev decision gate', () => {
  it('asks for a TypeSafe key when unconfigured and verifies it through the local backend', async () => {
    const fetcher = mockApi({ connection: unconfigured })
    render(<PortfolioJevGate account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByText('TypeSafe connection not configured')
    expect(
      (screen.getByRole('button', { name: 'Run Jev gate' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.type(screen.getByLabelText('TypeSafe API Key'), 'apikey_synthetic_key_value')
    await userEvent.click(screen.getByRole('button', { name: 'Verify and save key' }))
    await screen.findByText('TypeSafe connection configured')
    expect(body(fetcher, '/api/jev/connection', 'POST')).toEqual({
      api_key: 'apikey_synthetic_key_value',
      expected_version: null,
    })
    expect(document.body.textContent || '').not.toContain('apikey_synthetic_key_value')
    expect(
      (screen.queryByLabelText('TypeSafe API Key') as HTMLInputElement | null)?.value ?? '',
    ).toBe('')
  })

  it('runs the gate with recorded thresholds, shows every probability and bridges to paper', async () => {
    const onProposal = vi.fn()
    const fetcher = mockApi()
    render(<PortfolioJevGate account={account} locale="en" onProposal={onProposal} />)
    await screen.findByText('TypeSafe connection configured')
    const select = screen.getByRole('combobox', { name: 'Source rule workflow' })
    expect(within(select).getAllByRole('option')).toHaveLength(2)
    fireEvent.change(select, { target: { value: source.id } })
    fireEvent.change(screen.getByLabelText('Pass threshold (0.50–0.99)'), {
      target: { value: '0.75' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Run Jev gate' }))
    await screen.findByRole('region', { name: 'Jev decision details' })
    const request = body(fetcher, '/api/jev/runs', 'POST')
    expect(request.source_run_id).toBe(source.id)
    expect(request.policy).toEqual({ pass_threshold: 0.75, max_risk_probability: 0.5 })
    expect(request.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,100}$/)
    const details = screen.getByRole('region', { name: 'Jev decision details' })
    expect(within(details).getByText('0.96 ✓')).toBeTruthy()
    expect(within(details).getByText('0.41 ✗')).toBeTruthy()
    expect(within(details).getByText('Pass')).toBeTruthy()
    expect(within(details).getByText('Fail')).toBeTruthy()
    expect(within(details).getByText(/16\.00% → 0\.00%/)).toBeTruthy()
    expect(within(details).getByText(/\$0\.000028/)).toBeTruthy()
    expect(within(details).getByText(/231 ms/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper limits passed; the proposal can be saved')
    expect(body(fetcher, `/api/jev/runs/${jevRun().id}/paper-preview`, 'POST')).toEqual({
      account_id: account.id,
      expected_account_version: 1,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Save paper proposal' }))
    await waitFor(() => expect(onProposal).toHaveBeenCalledWith(proposal))
    expect(screen.getByText(/Paper proposal saved; not executed/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Load later outcomes' }))
    await screen.findByText('+2.50%')
    expect(screen.getByText(/No later session is available locally yet/)).toBeTruthy()
  })

  it('keeps blocked or stale decisions readable without any paper bridge', async () => {
    const blocked = jevRun({
      status: 'blocked',
      stored_status: 'blocked',
      proposal_ready: false,
      target_weights: [],
      cash_weight_pct: null,
      counts: { pass: 0, fail: 2, unavailable: 0 },
      error: {
        code: 'answers_invalid',
        message: '回應未通過驗證',
        issues: [{ code: 'model_mismatch', message: '模型不同' }],
      },
    })
    blocked.result = {
      ...blocked.result,
      proposal_ready: false,
      target_weights: [],
      cash_weight_pct: null,
      blocking_reasons: [{ code: 'no_passing_candidates', message: '沒有標的通過' }],
    }
    mockApi({ run: blocked, history: [blocked] })
    render(<PortfolioJevGate account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByText('TypeSafe connection configured')
    await userEvent.click(await screen.findByRole('button', { name: /synthetic-je/ }))
    await screen.findByRole('region', { name: 'Jev decision details' })
    expect(screen.getByText('No allocation can proceed')).toBeTruthy()
    expect(
      screen.getByText('No symbol cleared every threshold; no liquidation proposal is created.'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'The answering model differs from the pinned version; thresholds do not apply.',
      ),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Preview paper allocation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(screen.getByText(/Estimated cost per decision/)).toBeTruthy()
  })

  it('refuses to launch with an out-of-range threshold and shows the reason', async () => {
    mockApi()
    render(<PortfolioJevGate account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByText('TypeSafe connection configured')
    fireEvent.change(screen.getByRole('combobox', { name: 'Source rule workflow' }), {
      target: { value: source.id },
    })
    fireEvent.change(screen.getByLabelText('Overextension risk ceiling (0.01–0.50)'), {
      target: { value: '0.9' },
    })
    expect(screen.getByText('The risk ceiling must be between 0.01 and 0.50.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Run Jev gate' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('surfaces backend problem codes in English without echoing secrets', async () => {
    mockApi({
      handler: (url, init) =>
        url === '/api/jev/runs' && init?.method === 'POST'
          ? response({ detail: { code: 'rate_limited', message: '請稍後再試' } }, 503)
          : undefined,
    })
    render(<PortfolioJevGate account={account} locale="en" onProposal={vi.fn()} />)
    await screen.findByText('TypeSafe connection configured')
    fireEvent.change(screen.getByRole('combobox', { name: 'Source rule workflow' }), {
      target: { value: source.id },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Run Jev gate' }))
    await screen.findByText(
      'TypeSafe asked for a lower request rate or is overloaded. Retry later.',
    )
  })
})
