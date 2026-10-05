import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AllocationResearchEvidenceView,
  type AllocationResearchEvidence,
} from './AllocationResearch'
import { AllocationResearchReceipts, type ResearchReceipt } from './AllocationResearchReceipts'
import type { AgentRun } from './portfolio-agent-model'
import type { PaperAccount } from './paper-model'

const account: PaperAccount = {
  id: 'synthetic-account',
  name: 'Synthetic account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 40, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '',
  updated_at: '',
}

const t = (_zh: string, en: string) => en
const run: AgentRun = {
  id: 'synthetic-run',
  created_at: '2024-01-04T22:00:00Z',
  engine_version: 'alphaview-portfolio-agent-v1',
  as_of: '2024-01-04',
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
      max_positions: 2,
      max_position_weight_pct: 40,
      cash_buffer_pct: 20,
    },
  },
  scan: null,
  coverage: { requested: 2, complete: 2, eligible: 2, selected: 2, rejected: 0 },
  target_weights: [
    { symbol: 'SYNTA', weight_pct: 40 },
    { symbol: 'SYNTB', weight_pct: 40 },
  ],
  cash_weight_pct: 20,
  allocation: { slot_weight_pct: 40, unused_slots: 0 },
  candidates: ['SYNTA', 'SYNTB'].map((symbol) => ({
    symbol,
    status: 'selected',
    score: 75,
    coverage_pct: 100,
    matched_count: 3,
    reasons: [],
    contributions: [],
    evidence: { quote_date: '2024-01-04', reference_close: 100 },
  })),
  risk_checks: [],
  blocking_reasons: [],
  steps: [],
  method: 'Synthetic',
  warnings: [],
  proposal_fingerprint: 'a'.repeat(64),
}
const risk = {
  status: 'calculated' as const,
  reason: null,
  volatility_annualized_pct: 10,
  contributions_annualized_pct: [-3.5, 13.5],
  risk_shares_pct: [-35, 135],
  max_equal_risk_share_error: 0.85,
}
const scenario = () => ({
  status: 'calculated' as const,
  reason: null,
  weights: [
    { symbol: 'SYNTA', raw_weight_pct: 53.33333333, capped_weight_pct: 40 },
    { symbol: 'SYNTB', raw_weight_pct: 26.66666667, capped_weight_pct: 26.66666666 },
  ],
  invested_before_pct: 80,
  invested_after_pct: 66.66666666,
  cash_before_pct: 20,
  cash_after_pct: 33.33333334,
  capped_or_rounded_to_cash_pct: 13.33333334,
  risk_before: risk,
  risk_after: risk,
})
const evidence = (lookback = 60): AllocationResearchEvidence => ({
  engine_version: 'alphaview-allocation-research-v1',
  agent_run_id: run.id,
  proposal_fingerprint: run.proposal_fingerprint,
  input_revision: run.input_revision,
  as_of: run.as_of,
  evidence_fingerprint: 'b'.repeat(64),
  status: 'calculated',
  reasons: [],
  request: { lookback_sessions: lookback },
  selected_symbols: ['SYNTA', 'SYNTB'],
  ranking: [
    { rank: 1, symbol: 'SYNTA', score: 75, matched_count: 3 },
    { rank: 2, symbol: 'SYNTB', score: 75, matched_count: 3 },
  ],
  invested_budget_pct: 80,
  position_cap_pct: 40,
  window: {
    price_dates: ['2023-10-10', '2024-01-04'],
    return_dates: ['2024-01-04'],
    lookback_sessions: lookback,
  },
  coverage: {
    required_symbols: 2,
    complete_symbols: 2,
    required_closes: 122,
    valid_closes: 122,
    required_return_sessions: lookback,
    common_return_sessions: lookback,
    per_symbol: ['SYNTA', 'SYNTB'].map((symbol) => ({
      symbol,
      required_closes: 61,
      valid_closes: 61,
      valid_returns: lookback,
      missing_dates: [],
      invalid_dates: [],
      status: 'complete',
    })),
  },
  covariance_annualized: [
    [0.01, -0.004],
    [-0.004, 0.04],
  ],
  correlation: [
    [1, -0.2],
    [-0.2, 1],
  ],
  matrix_diagnostics: {
    min_eigenvalue: 0.009,
    max_eigenvalue: 0.041,
    eigenvalue_ratio: 0.2195,
    condition_number: 4.5556,
    required_eigenvalue_ratio_gt: 1e-10,
  },
  solver: {
    converged: true,
    sweeps: 6,
    max_sweeps: 5000,
    max_risk_share_error: 1e-9,
    risk_share_tolerance: 1e-8,
    reason: null,
  },
  methods: { rank_sum: scenario(), equal_risk_contribution: scenario() },
  method: 'Synthetic comparison method.',
  sources: [
    {
      title: 'Primary mathematical source',
      url: 'https://arxiv.org/pdf/1311.4057',
      section: 'Equation 5',
    },
  ],
})
const reply = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
})

const saveName = 'Save current research receipt'
const historyName = 'Load account receipt history'
const base = `/api/paper/accounts/${account.id}/allocation-research-receipts`
const receipt = (overrides: Partial<ResearchReceipt> = {}): ResearchReceipt => ({
  id: 'c'.repeat(64),
  account_id: account.id,
  run_id: run.id,
  created_at: '2024-01-04T22:01:00Z',
  engine_version: 'alphaview-allocation-research-receipt-v1',
  content_fingerprint: 'd'.repeat(64),
  integrity: { available: true, reason: null },
  currentness: { current: true, reasons: [] },
  status: 'calculated',
  as_of: run.as_of,
  lookback_sessions: 60,
  receipt: {
    account_context: { account_id: account.id, version: 1, symbol_policy: { version: 1 } },
    source_context: {
      agent_run_id: run.id,
      account_binding: 'review_association_only',
      input_revision: run.input_revision,
      proposal_fingerprint: run.proposal_fingerprint,
    },
    evidence: evidence(),
  },
  ...overrides,
})
const history = (items: ResearchReceipt[] = [receipt()], total = items.length, offset = 0) => ({
  account_id: account.id,
  items,
  pagination: { total, offset, returned: items.length, limit: 20 },
})
function Subject({
  activeAccount = account,
  activeRun = run,
  value = evidence(),
  canSave = true,
}: {
  activeAccount?: PaperAccount
  activeRun?: AgentRun
  value?: AllocationResearchEvidence | null
  canSave?: boolean
}) {
  return (
    <AllocationResearchReceipts
      account={activeAccount}
      run={activeRun}
      evidence={value}
      canSave={canSave}
      t={t}
      renderEvidence={(saved) => <AllocationResearchEvidenceView result={saved} t={t} />}
    />
  )
}
function pending() {
  let resolve!: (value: ReturnType<typeof reply>) => void
  const promise = new Promise<ReturnType<typeof reply>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('saves only on demand with exact identity, blocks duplicate clicks and replays the immutable receipt', async () => {
  const wait = pending()
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(wait.promise)
    .mockResolvedValueOnce(reply(receipt({ replayed: true })))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  expect(fetcher).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: saveName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Saving receipt…' })).toHaveProperty('disabled', true)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe(base)
  expect(init.method).toBe('POST')
  expect(init.cache).toBe('no-store')
  expect(JSON.parse(init.body)).toEqual({
    run_id: run.id,
    expected_account_version: 1,
    expected_proposal_fingerprint: run.proposal_fingerprint,
    expected_input_revision: run.input_revision,
    expected_as_of: run.as_of,
    lookback_sessions: 60,
    expected_evidence_fingerprint: evidence().evidence_fingerprint,
  })
  await act(async () => wait.resolve(reply(receipt())))
  expect((await screen.findByRole('status')).textContent).toContain('Research receipt saved.')
  expect(screen.getByText('Saved historical values')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  expect((await screen.findByRole('status')).textContent).toContain(
    'The original receipt was replayed; no new record was added.',
  )
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('keeps immutable historical matrices reviewable when the current workflow is blocked and stale', async () => {
  const stale = receipt({
    currentness: { current: false, reasons: ['inputs_changed', 'account_context_changed'] },
  })
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(history([stale])))
    .mockResolvedValueOnce(reply(stale))
  vi.stubGlobal('fetch', fetcher)
  render(
    <Subject
      activeRun={{ ...run, current: false, status: 'blocked' }}
      value={null}
      canSave={false}
    />,
  )
  expect(screen.getByRole('button', { name: saveName })).toHaveProperty('disabled', true)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  expect(await screen.findByText('Historical context is stale')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Review receipt' }))
  const detail = await screen.findByRole('region', { name: 'Historical research receipt details' })
  expect(within(detail).getByText(/inputs_changed, account_context_changed/)).toBeTruthy()
  expect(within(detail).getByText('Annualized covariance')).toBeTruthy()
  expect(within(detail).getByText(/review only; the original workflow was not bound/)).toBeTruthy()
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${base}?limit=20&offset=0`,
    `${base}/${stale.id}`,
  ])
  expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true)
})

it('preserves selected history and the save context when the server returns a version conflict', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(receipt()))
    .mockResolvedValueOnce(reply({ detail: { code: 'receipt_context_changed' } }, 409))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  await screen.findByText('Saved historical values')
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  expect((await screen.findByRole('alert')).textContent).toContain('The current view is preserved')
  expect(screen.getByText('Saved historical values')).toBeTruthy()
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(
    JSON.parse(fetcher.mock.calls[0][1].body),
  )
})

it('never displays unverifiable damaged evidence but retains the receipt header and reason', async () => {
  const damaged = receipt({
    integrity: { available: false, reason: 'receipt_evidence_unverifiable' },
    currentness: { current: null, reasons: ['receipt_unverifiable'] },
    receipt: null,
    status: null,
    as_of: null,
    lookback_sessions: null,
  })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(reply(history([damaged])))
      .mockResolvedValueOnce(reply(damaged)),
  )
  render(<Subject canSave={false} />)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  expect(await screen.findByText('Receipt evidence unavailable')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Review receipt' }))
  expect((await screen.findByRole('alert')).textContent).toContain('receipt_evidence_unverifiable')
  expect(screen.getByText(/Receipt content fingerprint/).textContent).toContain(
    damaged.content_fingerprint,
  )
  expect(screen.queryByText('Annualized covariance')).toBeNull()
})

it('saves and renders unavailable results with the original reasons and null matrices', async () => {
  const unavailable = {
    ...evidence(),
    status: 'unavailable' as const,
    reasons: [{ code: 'history_incomplete' }],
    covariance_annualized: null,
    correlation: null,
  }
  const value = receipt()
  value.receipt!.evidence = unavailable
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(value)))
  render(<Subject value={unavailable} />)
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  const detail = await screen.findByRole('region', { name: 'Historical research receipt details' })
  expect(within(detail).getByText('Required adjusted closes are missing')).toBeTruthy()
  expect(
    within(detail).queryByRole('table', { name: 'Annualized covariance', hidden: true }),
  ).toBeNull()
})

it('ignores a late save response after the workflow fingerprint changes', async () => {
  const wait = pending()
  const fetcher = vi.fn().mockReturnValue(wait.promise)
  vi.stubGlobal('fetch', fetcher)
  const { rerender } = render(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: saveName }))
  rerender(<Subject activeRun={{ ...run, proposal_fingerprint: 'e'.repeat(64) }} />)
  await act(async () => wait.resolve(reply(receipt())))
  expect(screen.queryByText('Saved historical values')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: saveName })).toHaveProperty('disabled', true)
})

it('aborts an old account history request, ignores its late result and resets the new account paging', async () => {
  const wait = pending()
  const other = { ...account, id: 'synthetic-other' }
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(wait.promise)
    .mockResolvedValueOnce(reply({ ...history([]), account_id: other.id }))
  vi.stubGlobal('fetch', fetcher)
  const { rerender } = render(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: historyName }))
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal
  rerender(<Subject activeAccount={other} />)
  expect(signal.aborted).toBe(true)
  await act(async () => wait.resolve(reply(history())))
  expect(screen.queryByRole('button', { name: 'Review receipt' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  expect(await screen.findByText('No research receipts on this page.')).toBeTruthy()
  expect(fetcher.mock.calls[1][0]).toBe(
    `/api/paper/accounts/${other.id}/allocation-research-receipts?limit=20&offset=0`,
  )
})

it('aborts pending receipt requests on unmount', () => {
  const fetcher = vi.fn(() => pending().promise)
  vi.stubGlobal('fetch', fetcher)
  const { unmount } = render(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: historyName }))
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    .signal as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
})

it('requests bounded pages and can return to the first page without changing the source run', async () => {
  const items = Array.from({ length: 20 }, (_, index) =>
    receipt({ id: index.toString(16).padStart(64, '0') }),
  )
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(history(items, 21)))
    .mockResolvedValueOnce(reply(history([receipt()], 21, 20)))
    .mockResolvedValueOnce(reply(history(items, 21)))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  await screen.findByText('Account history count: 21')
  await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true),
  )
  await userEvent.click(screen.getByRole('button', { name: 'Previous page' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true),
  )
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${base}?limit=20&offset=0`,
    `${base}?limit=20&offset=20`,
    `${base}?limit=20&offset=0`,
  ])
})

it('rejects saved evidence or account identity mismatches without replacing reviewed history', async () => {
  const wrong = receipt()
  wrong.receipt!.evidence.evidence_fingerprint = 'f'.repeat(64)
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(receipt()))
    .mockResolvedValueOnce(reply(wrong))
    .mockResolvedValueOnce(reply({ ...history(), account_id: 'wrong-account' }))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  await screen.findByText('Saved historical values')
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Receipt identity does not match.',
  )
  expect(screen.getByText('b'.repeat(64))).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Receipt account identity does not match.',
  )
  expect(screen.getByText('Saved historical values')).toBeTruthy()
})

it('does not show an old save conflict in a new account-version context', async () => {
  const wait = pending()
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(wait.promise))
  const { rerender } = render(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: saveName }))
  rerender(<Subject activeAccount={{ ...account, version: 2 }} />)
  await act(async () => wait.resolve(reply({ detail: { code: 'receipt_account_changed' } }, 409)))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('Saved historical values')).toBeNull()
  expect(screen.getByRole('button', { name: saveName })).toHaveProperty('disabled', false)
})

const exportName = 'Export selected receipt JSON'
function mockDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-receipt')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const links: { filename: string; href: string; attached: boolean }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push({ filename: this.download, href: this.href, attached: this.isConnected })
  })
  const timeout = window.setTimeout.bind(window)
  const pendingRevocations: (() => void)[] = []
  vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
    if (delay !== 10000) return timeout(callback, delay)
    pendingRevocations.push(callback as () => void)
    return 1
  })
  return { createObjectURL, revokeObjectURL, links, pendingRevocations }
}
async function jsonBlob(blob: Blob) {
  return JSON.parse(
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    }),
  )
}

it('exports the exact selected server envelope including unknown fields, nulls, currentness and replay status without refetching', async () => {
  const original = receipt()
  const server = {
    ...original,
    replayed: true,
    currentness: { current: null, reasons: ['context_unverifiable'], future_reason_detail: null },
    future_metadata: { nullable: null, coverage: [null, 3], label: 'Synthetic' },
    receipt: { ...original.receipt!, future_saved_context: { missing: null } },
  }
  const fetcher = vi.fn().mockResolvedValue(reply(server))
  vi.stubGlobal('fetch', fetcher)
  const download = mockDownload()
  render(<Subject />)
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  const button = await screen.findByRole('button', { name: exportName })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(download.createObjectURL).toHaveBeenCalledTimes(1)
  const blob = download.createObjectURL.mock.calls[0][0]
  expect(blob.type).toBe('application/json;charset=utf-8')
  expect(await jsonBlob(blob)).toEqual(server)
  expect(download.links).toEqual([
    {
      filename: `allocation-research-receipt-${server.id}.json`,
      href: 'blob:synthetic-receipt',
      attached: true,
    },
  ])
  expect(document.querySelector('a[download]')).toBeNull()
  expect(download.revokeObjectURL).not.toHaveBeenCalled()
  expect(download.pendingRevocations).toHaveLength(1)
  download.pendingRevocations[0]()
  expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-receipt')
})

it('exports the selected historical receipt after selection changes and the active workflow becomes stale', async () => {
  const first = receipt()
  const second = receipt({
    id: 'e'.repeat(64),
    currentness: { current: false, reasons: ['inputs_changed'] },
  })
  second.receipt!.evidence = {
    ...second.receipt!.evidence,
    status: 'unavailable',
    covariance_annualized: null,
    correlation: null,
  }
  second.status = 'unavailable'
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(history([first, second])))
    .mockResolvedValueOnce(reply(first))
    .mockResolvedValueOnce(reply(second))
  vi.stubGlobal('fetch', fetcher)
  const download = mockDownload()
  const { rerender } = render(<Subject />)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  await screen.findAllByRole('button', { name: 'Review receipt' })
  await userEvent.click(screen.getAllByRole('button', { name: 'Review receipt' })[0])
  fireEvent.click(await screen.findByRole('button', { name: exportName }))
  expect(await jsonBlob(download.createObjectURL.mock.calls[0][0])).toEqual(first)
  await userEvent.click(screen.getAllByRole('button', { name: 'Review receipt' })[1])
  await waitFor(() => expect(screen.getByText(/Receipt content fingerprint/)).toBeTruthy())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: exportName })).toHaveProperty('disabled', false),
  )
  rerender(
    <Subject
      activeRun={{ ...run, current: false, id: 'synthetic-new-stale-run' }}
      value={null}
      canSave={false}
    />,
  )
  expect(screen.getByRole('button', { name: saveName })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: exportName }))
  expect(await jsonBlob(download.createObjectURL.mock.calls[1][0])).toEqual(second)
  expect(download.links[1].filename).toBe(`allocation-research-receipt-${second.id}.json`)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('clears the selected download on account switch and cannot export the previous account', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(receipt())))
  const download = mockDownload()
  const { rerender } = render(<Subject />)
  await userEvent.click(screen.getByRole('button', { name: saveName }))
  const oldButton = await screen.findByRole('button', { name: exportName })
  rerender(<Subject activeAccount={{ ...account, id: 'synthetic-other-account' }} />)
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  expect(screen.queryByText('Saved historical values')).toBeNull()
  fireEvent.click(oldButton)
  expect(download.createObjectURL).not.toHaveBeenCalled()
})

it.each(['unavailable_integrity', 'missing_payload', 'invalid_content_fingerprint'] as const)(
  'disables export for %s without silently downloading an API error or partial payload',
  async (damage) => {
    const broken = receipt()
    if (damage === 'unavailable_integrity')
      broken.integrity = { available: false, reason: 'receipt_evidence_unverifiable' }
    if (damage === 'missing_payload') broken.receipt = null
    if (damage === 'invalid_content_fingerprint') broken.content_fingerprint = 'broken'
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(history([broken])))
      .mockResolvedValueOnce(reply(broken))
    vi.stubGlobal('fetch', fetcher)
    const download = mockDownload()
    render(<Subject canSave={false} />)
    await userEvent.click(screen.getByRole('button', { name: historyName }))
    await userEvent.click(await screen.findByRole('button', { name: 'Review receipt' }))
    const button = await screen.findByRole('button', { name: exportName })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(download.createObjectURL).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)

it.each([
  'account',
  'receipt_id',
  'inner_account',
  'source_run',
  'evidence_run',
  'proposal_fingerprint',
  'input_revision',
  'session',
  'lookback',
] as const)('never downloads a receipt whose %s identity is inconsistent', async (mismatch) => {
  const broken = receipt()
  if (mismatch === 'account') broken.account_id = 'synthetic-unrelated'
  if (mismatch === 'receipt_id') broken.id = 'f'.repeat(64)
  if (mismatch === 'inner_account')
    broken.receipt!.account_context.account_id = 'synthetic-unrelated'
  if (mismatch === 'source_run') broken.receipt!.source_context.agent_run_id = 'synthetic-unrelated'
  if (mismatch === 'evidence_run') broken.receipt!.evidence.agent_run_id = 'synthetic-unrelated'
  if (mismatch === 'proposal_fingerprint')
    broken.receipt!.source_context.proposal_fingerprint = 'f'.repeat(64)
  if (mismatch === 'input_revision')
    broken.receipt!.source_context.input_revision = 'synthetic:changed'
  if (mismatch === 'session') broken.as_of = '2024-01-03'
  if (mismatch === 'lookback') broken.lookback_sessions = 20
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(history()))
    .mockResolvedValueOnce(reply(broken))
  vi.stubGlobal('fetch', fetcher)
  const download = mockDownload()
  render(<Subject canSave={false} />)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  await userEvent.click(await screen.findByRole('button', { name: 'Review receipt' }))
  if (mismatch === 'account' || mismatch === 'receipt_id') {
    expect((await screen.findByRole('alert')).textContent).toBe('Receipt identity does not match.')
    expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  } else {
    const button = await screen.findByRole('button', { name: exportName })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
  }
  expect(download.createObjectURL).not.toHaveBeenCalled()
})

it('connects comparison only to a loaded history baseline and the selected verified detail', async () => {
  const first = receipt(),
    second = receipt({ id: 'e'.repeat(64), content_fingerprint: 'f'.repeat(64) })
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(history([first, second])))
    .mockResolvedValueOnce(reply(second))
    .mockResolvedValueOnce(reply({ detail: { code: 'receipt_comparison_shape_unavailable' } }, 409))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject canSave={false} />)
  expect(
    screen.getByRole('button', { name: 'Compare baseline and selected receipt' }),
  ).toHaveProperty('disabled', true)
  await userEvent.click(screen.getByRole('button', { name: historyName }))
  await screen.findAllByRole('button', { name: 'Review receipt' })
  await userEvent.selectOptions(screen.getByLabelText('Baseline receipt (loaded page)'), first.id)
  expect(
    screen.getByRole('button', { name: 'Compare baseline and selected receipt' }),
  ).toHaveProperty('disabled', true)
  await userEvent.click(screen.getAllByRole('button', { name: 'Review receipt' })[1])
  await screen.findByText('Saved historical values')
  await userEvent.click(
    screen.getByRole('button', { name: 'Compare baseline and selected receipt' }),
  )
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Receipts could not be compared. Reload and verify both historical records.',
  )
  expect(fetcher.mock.calls[2][0]).toBe(`${base}/compare`)
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
    baseline_id: first.id,
    selected_id: second.id,
    expected_baseline_content_fingerprint: first.content_fingerprint,
    expected_selected_content_fingerprint: second.content_fingerprint,
  })
  expect(screen.getByRole('button', { name: exportName })).toHaveProperty('disabled', false)
})
