import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowPathReceipts,
  type WorkflowPathReceipt,
  type PathReceiptKind,
} from './WorkflowPathReceipts'
import type { AgentRun } from './portfolio-agent-model'

// The production TypeScript project has browser types only. Load the test runner's
// built-in crypto at runtime without adding a Node type dependency to the app.
const cryptoModule: string = 'node:crypto'
const { createHash, webcrypto } = (await import(cryptoModule)) as {
  createHash: (algorithm: string) => {
    update: (data: string) => { digest: (encoding: 'hex') => string }
  }
  webcrypto: Crypto
}

const t = (_zh: string, en: string) => en
const account = { id: 'synthetic-account', version: 1 }
const run: AgentRun = {
  id: 'synthetic-receipt-run',
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
const base = `/api/paper/accounts/${account.id}/runs/${run.id}/path-receipts`
const request = {
  expected_proposal_fingerprint: run.proposal_fingerprint,
  expected_input_revision: run.input_revision,
  expected_as_of: run.as_of,
}
function fixture(kind: PathReceiptKind = 'path_validation') {
  const evidence = {
    engine_version: 'alphaview-workflow-path-validation-v1',
    agent_run_id: run.id,
    proposal_fingerprint: run.proposal_fingerprint,
    input_revision: run.input_revision,
    as_of: run.as_of,
    current_at_snapshot: true,
    evidence_fingerprint: 'b'.repeat(64),
    status: 'evaluated',
    metrics: { final_value: 105000, return_pct: 5, max_drawdown_pct: -2, total_fees: 40 },
    coverage: { required_decisions: 12, available_decisions: 12 },
    reasons: [],
    curve: [
      { date: '2025-10-02', value: 100000 },
      { date: run.as_of, value: 105000 },
    ],
    method: 'Synthetic historical method',
  }
  const costRequest = { ...request, fee_bps: [0, 10], slippage_bps: [0] }
  const value: WorkflowPathReceipt = {
    id: 'c'.repeat(64),
    account_id: account.id,
    run_id: run.id,
    kind,
    created_at: '2026-10-01T12:00:00+00:00',
    engine_version: 'alphaview-workflow-path-receipt-v1',
    content_fingerprint: '',
    integrity: { available: true, reason: null },
    currentness: { current: true, reasons: [] },
    status: 'evaluated',
    as_of: run.as_of,
    baseline_metrics: evidence.metrics,
    replayed: false,
    receipt: {
      receipt_id: 'c'.repeat(64),
      kind,
      created_at: '2026-10-01T12:00:00+00:00',
      request: kind === 'path_validation' ? request : costRequest,
      account_context: { account_id: account.id, version: 1, symbol_policy: { version: 1 } },
      source_context: {
        agent_run_id: run.id,
        proposal_fingerprint: run.proposal_fingerprint,
        input_revision: run.input_revision,
        as_of: run.as_of,
        history_fingerprint: 'd'.repeat(64),
        evidence_fingerprint: evidence.evidence_fingerprint,
        account_binding: 'review_association_only',
        versions: { path: evidence.engine_version, allocator: 'synthetic-allocator' },
      },
      evidence:
        kind === 'path_validation'
          ? evidence
          : {
              ...evidence,
              engine_version: 'alphaview-workflow-path-costs-v1',
              request: costRequest,
              baseline: evidence,
              scenarios: [
                {
                  fee_bps: 0,
                  slippage_bps: 0,
                  status: 'evaluated',
                  metrics: { ...evidence.metrics, final_value: 105100 },
                  costs: { fees: 0, slippage: 0, total: 0 },
                  differences: { final_value: 100, return_pp: 0.1 },
                },
                {
                  fee_bps: 10,
                  slippage_bps: 0,
                  status: 'unavailable',
                  metrics: null,
                  costs: null,
                  differences: null,
                },
              ],
            },
      policy: { advisory_only: true, execution_source: false, gating_authority: false },
      method: 'Synthetic receipt method',
    },
  }
  const raw = JSON.stringify(value.receipt).replace(
    '"final_value":105000',
    '"final_value":105000.0',
  )
  value.content_fingerprint = createHash('sha256').update(raw).digest('hex')
  return { value, raw }
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const history = (value: WorkflowPathReceipt) => ({
  account_id: account.id,
  run_id: run.id,
  kind: value.kind,
  items: [{ ...value, receipt: undefined }],
  pagination: { limit: 20, offset: 0, total: 1, returned: 1 },
  retention: { per_account: 50, global: 250, max_bytes: 2097152, automatic_deletion: false },
})
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save this path evidence' }))
const load = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Load receipt history for this workflow' }))
const detail = () => fireEvent.click(screen.getByRole('button', { name: /^Load path receipt / }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('immutable workflow path receipts', () => {
  it('saves reviewed provenance once and downloads verified exact stored bytes without recomputation', async () => {
    const { value, raw } = fixture()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(value))
      .mockResolvedValueOnce(
        new Response(raw, { headers: { ETag: `"${value.content_fingerprint}"` } }),
      )
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('crypto', webcrypto)
    const createObjectURL = vi.fn().mockReturnValue('blob:synthetic')
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL
        static revokeObjectURL = vi.fn()
      },
    )
    const OriginalBlob = Blob
    const blobSpy = vi.fn(function (parts: BlobPart[], options: BlobPropertyBag) {
      return new OriginalBlob(parts, options)
    })
    vi.stubGlobal('Blob', blobSpy)
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={value.receipt!.evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    expect(fetcher).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Save this path evidence' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await screen.findByText('Immutable path evidence receipt saved.')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(base)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      kind: 'path_validation',
      request,
      expected_account_version: 1,
      expected_evidence_engine_version: value.receipt!.evidence.engine_version,
      expected_evidence_fingerprint: value.receipt!.evidence.evidence_fingerprint,
    })
    expect(screen.getByText(/filing association only/)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Recorded baseline equity path' })).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Download original saved path receipt JSON' }),
    )
    await vi.waitFor(() => expect(clicked).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[1][0]).toBe(
      `${base}/${value.id}/evidence.json?expected_content_fingerprint=${value.content_fingerprint}`,
    )
    expect(blobSpy.mock.calls[0][0]).toEqual([raw])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reads scoped historical values without current evidence and keeps freshness separate', async () => {
    const { value } = fixture()
    value.currentness = { current: false, reasons: ['inputs_changed', 'account_context_changed'] }
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(history(value)))
      .mockImplementationOnce(() => response(value))
    vi.stubGlobal('fetch', fetcher)
    render(
      <WorkflowPathReceipts
        account={account}
        run={{ ...run, current: false }}
        kind="path_validation"
        enabled={false}
        t={t}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Save this path evidence' }).hasAttribute('disabled'),
    ).toBe(true)
    load()
    await screen.findByRole('table', { name: 'Path evidence receipt history' })
    expect(fetcher.mock.calls[0][0]).toBe(`${base}?kind=path_validation&limit=20&offset=0`)
    detail()
    const panel = await screen.findByRole('generic', { name: 'Saved path receipt detail' })
    expect(within(panel).getByText('Historical sources are no longer current')).toBeTruthy()
    expect(within(panel).getByText('105,000.00')).toBeTruthy()
    expect(within(panel).getByText('Workspace input revision changed')).toBeTruthy()
    expect(
      within(panel)
        .getByRole('button', { name: 'Download original saved path receipt JSON' })
        .hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true)
  })

  it('preserves cost scenarios including unavailable values and sends the reviewed grid', async () => {
    const { value } = fixture('path_costs')
    const fetcher = vi.fn().mockImplementationOnce(() => response(value))
    vi.stubGlobal('fetch', fetcher)
    render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_costs"
        evidence={value.receipt!.evidence}
        request={value.receipt!.request}
        enabled
        t={t}
      />,
    )
    save()
    const table = await screen.findByRole('table', { name: 'Recorded cost scenarios' })
    expect(within(table).getByText('105,100.00')).toBeTruthy()
    expect(within(table).getAllByText('—')).toHaveLength(4)
    expect(within(table).getByText('Evidence was unavailable at the time')).toBeTruthy()
    expect(JSON.parse(fetcher.mock.calls[0][1].body).request).toEqual(value.receipt!.request)
  })

  it('hides metrics and download for invalid stored evidence', async () => {
    const { value } = fixture()
    value.integrity = { available: false, reason: 'receipt_content_changed' }
    value.currentness = { current: null, reasons: ['receipt_unverifiable'] }
    value.receipt = null
    value.status = null
    value.baseline_metrics = null
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(history(value)))
        .mockImplementationOnce(() => response(value)),
    )
    render(
      <WorkflowPathReceipts account={account} run={run} kind="path_validation" enabled t={t} />,
    )
    load()
    await screen.findByRole('table')
    detail()
    expect(await screen.findByText(/Historical values and download are unavailable/)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Download original saved path receipt JSON' }),
    ).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('105,000.00')).toBeNull()
  })

  it('preserves unavailable original metrics as dashes with reasons', async () => {
    const { value } = fixture()
    value.status = value.receipt!.evidence.status = 'unavailable'
    value.baseline_metrics = value.receipt!.evidence.metrics = null
    value.receipt!.evidence.curve = []
    value.receipt!.evidence.reasons = [
      { code: 'held_corporate_action_unmodeled', symbol: 'SYNA', date: '2026-01-05' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(value)),
    )
    render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={value.receipt!.evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    save()
    await screen.findByText('Immutable path evidence receipt saved.')
    expect(screen.getByText(/SYNA 2026-01-05 Held corporate-action/)).toBeTruthy()
    const metrics = screen.getByText('Recorded baseline final equity').closest('dl')!
    expect(within(metrics).getAllByText('—')).toHaveLength(4)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it.each(['account', 'run', 'kind'])(
    'rejects a history response for another %s scope',
    async (scope) => {
      const { value } = fixture()
      const payload = history(value)
      if (scope === 'account') payload.account_id = 'other'
      if (scope === 'run') payload.run_id = 'other'
      if (scope === 'kind') payload.kind = 'path_costs'
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementationOnce(() => response(payload)),
      )
      render(
        <WorkflowPathReceipts account={account} run={run} kind="path_validation" enabled t={t} />,
      )
      load()
      expect((await screen.findByRole('alert')).textContent).toContain('History does not match')
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('refuses a mismatched save response without displaying the wrong historical evidence', async () => {
    const { value } = fixture()
    const evidence = structuredClone(value.receipt!.evidence)
    value.receipt!.source_context.evidence_fingerprint = 'f'.repeat(64)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(value)),
    )
    render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    save()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Saved response does not match',
    )
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('displays a stale save conflict and never applies or regenerates evidence automatically', async () => {
    const { value } = fixture()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() =>
        response({ detail: { message: 'Synthetic source changed' } }, 409),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={value.receipt!.evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    save()
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic source changed')
    view.unmount()
    render(
      <WorkflowPathReceipts account={account} run={run} kind="path_validation" enabled t={t} />,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('aborts pending work and ignores late replies when the account changes', async () => {
    const { value } = fixture()
    let finish: (response: Response) => void = () => {}
    const fetcher = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={value.receipt!.evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    save()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(
      <WorkflowPathReceipts
        account={{ id: 'other-account', version: 1 }}
        run={run}
        kind="path_validation"
        enabled
        t={t}
      />,
    )
    expect(signal.aborted).toBe(true)
    await act(async () => finish(new Response(JSON.stringify(value))))
    expect(screen.queryByText('Immutable path evidence receipt saved.')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('rejects altered download bytes even when the response repeats the expected header', async () => {
    const { value, raw } = fixture()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(value))
      .mockResolvedValueOnce(
        new Response(raw.replace('105000.0', '106000.0'), {
          headers: { ETag: `"${value.content_fingerprint}"` },
        }),
      )
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('crypto', webcrypto)
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_validation"
        evidence={value.receipt!.evidence}
        request={request}
        enabled
        t={t}
      />,
    )
    save()
    await screen.findByText('Immutable path evidence receipt saved.')
    fireEvent.click(
      screen.getByRole('button', { name: 'Download original saved path receipt JSON' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Download identity or fingerprint mismatch',
    )
    expect(clicked).not.toHaveBeenCalled()
  })

  it('requires an account and matching reviewed assumptions before saving', () => {
    const { value } = fixture('path_costs')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <WorkflowPathReceipts
        account={null}
        run={run}
        kind="path_costs"
        evidence={value.receipt!.evidence}
        request={value.receipt!.request}
        enabled
        t={t}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Save this path evidence' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Load receipt history for this workflow' })
        .hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(
      <WorkflowPathReceipts
        account={account}
        run={run}
        kind="path_costs"
        evidence={value.receipt!.evidence}
        request={{ ...value.receipt!.request, fee_bps: [9] }}
        enabled
        t={t}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Save this path evidence' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
