import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AllocationReceiptComparison, type ReceiptComparison } from './AllocationReceiptComparison'
import type { ResearchReceipt } from './AllocationResearchReceipts'

const t = (_zh: string, en: string) => en
const accountId = 'synthetic-comparison-account'
const receipt = (id = 'a'): ResearchReceipt => ({
  id: id.repeat(64),
  account_id: accountId,
  run_id: `synthetic-${id}`,
  created_at: '2024-01-04T22:00:00Z',
  engine_version: 'alphaview-allocation-research-receipt-v1',
  content_fingerprint: id.toUpperCase().toLowerCase().repeat(64),
  integrity: { available: true, reason: null },
  currentness: { current: true, reasons: [] },
  status: 'calculated',
  as_of: '2024-01-04',
  lookback_sessions: 60,
})
const baseline = receipt('a'),
  selected = receipt('b'),
  other = receipt('c')
const items = [baseline, selected, other]
const source = (value: ResearchReceipt) => ({
  ...value,
  research_engine_version: 'alphaview-allocation-research-v1',
  input_revision: 'synthetic:1',
  account_version: 1,
  symbol_policy_version: 1,
  selected_symbols: ['SYNTA'],
  coverage: {
    complete_symbols: 1,
    required_symbols: 1,
    common_return_sessions: 60,
    required_return_sessions: 60,
  },
})
const result = (): ReceiptComparison => ({
  engine_version: 'alphaview-allocation-research-receipt-comparison-v1',
  account_id: accountId,
  baseline: {
    ...source(baseline),
    as_of: '2024-01-03',
    currentness: { current: false, reasons: ['inputs_changed'] },
  },
  selected: source(selected),
  comparability: { compatible: true, reasons: [] },
  methods: {
    rank_sum: {
      comparable: true,
      reasons: [],
      totals: {
        cash_after_pct: { baseline: 0, selected: 10, delta: 10, reason: null },
        risk_after_volatility_annualized_pct: {
          baseline: 2,
          selected: null,
          delta: null,
          reason: 'value_unavailable',
        },
      },
      symbols: [
        {
          symbol: 'SYNTA',
          raw_weight_pct: { baseline: 90, selected: 80, delta: -10, reason: null },
          capped_weight_pct: { baseline: 40, selected: 30, delta: -10, reason: null },
          risk_after_contributions_annualized_pct: {
            baseline: -3.5,
            selected: -5,
            delta: -1.5,
            reason: null,
          },
        },
      ],
    },
    equal_risk_contribution: {
      comparable: true,
      reasons: [],
      totals: { cash_after_pct: { baseline: 20, selected: 25, delta: 5, reason: null } },
      symbols: [],
    },
  },
})
const response = (value: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => value,
})
const compareName = 'Compare baseline and selected receipt'
const baselineName = 'Baseline receipt (loaded page)'
function Subject({
  account = accountId,
  history = items,
  target = selected,
}: {
  account?: string
  history?: ResearchReceipt[]
  target?: ResearchReceipt | null
}) {
  return (
    <AllocationReceiptComparison accountId={account} history={history} selected={target} t={t} />
  )
}
function pending() {
  let resolve!: (value: ReturnType<typeof response>) => void
  const promise = new Promise<ReturnType<typeof response>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('runs only for two different selected receipts, blocks double clicks and sends exact immutable identities', async () => {
  const wait = pending(),
    fetcher = vi.fn().mockReturnValue(wait.promise)
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), selected.id)
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  const button = screen.getByRole('button', { name: compareName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe(`/api/paper/accounts/${accountId}/allocation-research-receipts/compare`)
  expect(init.method).toBe('POST')
  expect(init.cache).toBe('no-store')
  expect(JSON.parse(init.body)).toEqual({
    baseline_id: baseline.id,
    selected_id: selected.id,
    expected_baseline_content_fingerprint: baseline.content_fingerprint,
    expected_selected_content_fingerprint: selected.content_fingerprint,
  })
  await act(async () => wait.resolve(response(result())))
  expect(await screen.findByRole('region', { name: 'Receipt comparison result' })).toBeTruthy()
})

it('shows source dates, stale currentness, exact zero, missing values and signed risk differences', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result())))
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const region = await screen.findByRole('region', { name: 'Receipt comparison result' })
  expect(
    within(region).getByText('Baseline receipt', { selector: 'strong' }).closest('p')?.textContent,
  ).toBe('Baseline receipt: 2024-01-03 · Lookback sessions: 60 · Historical context is stale')
  expect(
    within(region).getByText('Selected receipt', { selector: 'strong' }).closest('p')?.textContent,
  ).toBe('Selected receipt: 2024-01-04 · Lookback sessions: 60 · Current at this read')
  fireEvent.click(within(region).getByText('Full source, identities and coverage'))
  expect(within(region).getByText('inputs_changed')).toBeTruthy()
  const table = within(region).getByRole('table', { name: 'Rank sum' })
  const cash = within(table).getByText('Cash after caps').closest('tr')!
  expect(Array.from(cash.cells).map((cell) => cell.textContent)).toEqual([
    'Cash after caps',
    '0.0000',
    '10.0000',
    '10.0000',
    '—',
  ])
  const missing = within(table).getByText('Annualized volatility after caps').closest('tr')!
  expect(Array.from(missing.cells).map((cell) => cell.textContent)).toEqual([
    'Annualized volatility after caps',
    '2.0000',
    '—',
    '—',
    'A comparable value is missing',
  ])
  const risk = within(table)
    .getByText('SYNTA · Annualized risk contribution after caps')
    .closest('tr')!
  expect(Array.from(risk.cells).map((cell) => cell.textContent)).toEqual([
    'SYNTA · Annualized risk contribution after caps',
    '-3.5000',
    '-5.0000',
    '-1.5000',
    '—',
  ])
})

it('keeps incompatible saved values visible with null differences and a reason', async () => {
  const value = result()
  value.selected.lookback_sessions = 40
  value.comparability = { compatible: false, reasons: ['lookback_changed'] }
  value.methods.rank_sum.comparable = false
  value.methods.rank_sum.reasons = ['lookback_changed']
  value.methods.rank_sum.totals.cash_after_pct = {
    baseline: 0,
    selected: 10,
    delta: null,
    reason: 'incompatible_receipts',
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const region = await screen.findByRole('region', { name: 'Receipt comparison result' })
  expect(
    within(region).getByText(
      'Conditions are incompatible; saved values remain visible and differences are unavailable.',
    ),
  ).toBeTruthy()
  expect(within(region).getAllByText('Lookback periods differ')).toHaveLength(2)
  expect(
    Array.from(
      within(region).getByRole('table', { name: 'Rank sum' }).querySelector('tbody tr')!.children,
    ).map((cell) => cell.textContent),
  ).toEqual(['Cash after caps', '0.0000', '10.0000', '—', 'Receipt conditions are incompatible'])
})

it.each(['baseline', 'selected', 'account', 'history_page'] as const)(
  'aborts pending comparison and ignores its late result when %s changes',
  async (change) => {
    const wait = pending(),
      fetcher = vi.fn().mockReturnValue(wait.promise)
    vi.stubGlobal('fetch', fetcher)
    const { rerender } = render(<Subject />)
    await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
    fireEvent.click(screen.getByRole('button', { name: compareName }))
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    if (change === 'baseline')
      await userEvent.selectOptions(screen.getByLabelText(baselineName), other.id)
    if (change === 'selected') rerender(<Subject target={other} />)
    if (change === 'account')
      rerender(<Subject account="synthetic-other-account" history={[]} target={null} />)
    if (change === 'history_page') rerender(<Subject history={[other]} />)
    expect(signal.aborted).toBe(true)
    await act(async () => wait.resolve(response(result())))
    expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
    if (change === 'account' || change === 'history_page')
      expect(screen.getByLabelText(baselineName)).toHaveProperty('value', '')
  },
)

it('clears a completed result when refreshed source currentness changes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result())))
  const { rerender } = render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  await screen.findByRole('region', { name: 'Receipt comparison result' })
  rerender(
    <Subject
      target={{ ...selected, currentness: { current: false, reasons: ['session_changed'] } }}
    />,
  )
  expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
  expect(screen.getByLabelText(baselineName)).toHaveProperty('value', baseline.id)
})

it('preserves selected identities after a 409 and supports an explicit retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ detail: { code: 'receipt_content_changed' } }, 409))
    .mockResolvedValueOnce(response(result()))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Receipts could not be compared. Reload and verify both historical records.',
  )
  expect(screen.getByLabelText(baselineName)).toHaveProperty('value', baseline.id)
  expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  expect(await screen.findByRole('region', { name: 'Receipt comparison result' })).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each(['account', 'receipt', 'fingerprint', 'method', 'integrity'] as const)(
  'rejects comparison response %s mismatch',
  async (change) => {
    const value = result()
    if (change === 'account') value.account_id = 'synthetic-unrelated'
    if (change === 'receipt') value.selected.id = other.id
    if (change === 'fingerprint') value.baseline.content_fingerprint = other.content_fingerprint
    if (change === 'method') value.engine_version = 'synthetic-unknown'
    if (change === 'integrity')
      value.selected.integrity = { available: false, reason: 'receipt_evidence_unverifiable' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<Subject />)
    await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
    await userEvent.click(screen.getByRole('button', { name: compareName }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The comparison receipt identities do not match.',
    )
    expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
  },
)

it('keeps missing or unverifiable selections disabled and aborts on unmount', async () => {
  const fetcher = vi.fn().mockReturnValue(pending().promise)
  vi.stubGlobal('fetch', fetcher)
  const { rerender, unmount } = render(<Subject target={null} />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
  rerender(<Subject target={{ ...selected, integrity: { available: false, reason: 'broken' } }} />)
  expect(screen.getByRole('button', { name: compareName })).toHaveProperty('disabled', true)
  rerender(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: compareName }))
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
})

it('shows missing coverage counts as unavailable instead of zero or literal null', async () => {
  const value = result()
  value.baseline.coverage.complete_symbols = null
  value.baseline.coverage.common_return_sessions = null
  value.comparability = { compatible: false, reasons: ['coverage_incomplete'] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  fireEvent.click(await screen.findByText('Full source, identities and coverage'))
  const context = await screen.findByRole('table', { name: 'Receipt source context' })
  expect(within(context).getByText('—/1')).toBeTruthy()
  expect(within(context).getByText('—/60')).toBeTruthy()
  expect(context.textContent).not.toContain('null')
})

it('omits extra panel padding, puts cash and weights first, and expands exact source identities without requests', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(result()))
  vi.stubGlobal('fetch', fetcher)
  render(<Subject />)
  const section = screen.getByRole('region', { name: 'Historical receipt comparison' })
  expect(section.classList.contains('agent-panel')).toBe(false)
  const target = screen.getByTitle(selected.id)
  expect(target.textContent).toBe(selected.id.slice(0, 12))
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const region = await screen.findByRole('region', { name: 'Receipt comparison result' })
  expect(
    within(region).getByRole('table', { name: 'Receipt source context' }).closest('details'),
  ).toHaveProperty('open', false)
  expect(within(region).getByRole('table', { name: 'Rank sum' }).closest('details')).toHaveProperty(
    'open',
    true,
  )
  expect(
    within(region).getByRole('table', { name: 'Full-covariance ERC' }).closest('details'),
  ).toHaveProperty('open', true)
  const firstRows = within(region)
    .getByRole('table', { name: 'Rank sum' })
    .querySelectorAll('tbody tr')
  expect(
    Array.from(firstRows)
      .slice(0, 3)
      .map((row) => row.firstElementChild?.textContent),
  ).toEqual(['Cash after caps', 'SYNTA · Capped weight', 'SYNTA · Raw weight'])
  fireEvent.click(within(region).getByText('Full source, identities and coverage'))
  const context = within(region).getByRole('table', { name: 'Receipt source context' })
  expect(context.closest('details')).toHaveProperty('open', true)
  expect(within(context).getByText(baseline.id)).toBeTruthy()
  expect(within(context).getByText(selected.id)).toBeTruthy()
  fireEvent.click(within(region).getByText('Full source, identities and coverage'))
  expect(
    within(region).getByRole('table', { name: 'Receipt source context' }).closest('details'),
  ).toHaveProperty('open', false)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

const exportName = 'Export this comparison JSON'
function mockComparisonDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-comparison')
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
async function downloadedJSON(blob: Blob) {
  return JSON.parse(
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    }),
  )
}

it('downloads the complete accepted comparison including unknown fields, nulls, incompatible reasons and currentness without refetching', async () => {
  const base = result()
  base.selected.lookback_sessions = 40
  base.baseline.currentness = { current: null, reasons: ['context_unverifiable'] }
  base.comparability = { compatible: false, reasons: ['lookback_changed'] }
  for (const method of Object.values(base.methods)) {
    method.comparable = false
    method.reasons = ['lookback_changed']
    for (const change of Object.values(method.totals)) {
      change.delta = null
      change.reason = 'incompatible_receipts'
    }
    for (const row of method.symbols)
      for (const change of Object.values(row))
        if (typeof change !== 'string') {
          change.delta = null
          change.reason = 'incompatible_receipts'
        }
  }
  const server = {
    ...base,
    future_metadata: { missing: null, labels: ['synthetic', null] },
    selected: { ...base.selected, future_source_detail: { missing: null } },
    methods: { ...base.methods, future_method: { unavailable: null } },
  }
  const fetcher = vi.fn().mockResolvedValue(response(server))
  vi.stubGlobal('fetch', fetcher)
  const download = mockComparisonDownload()
  render(<Subject />)
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  fireEvent.click(await screen.findByRole('button', { name: exportName }))
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(download.createObjectURL).toHaveBeenCalledTimes(1)
  const blob = download.createObjectURL.mock.calls[0][0]
  expect(blob.type).toBe('application/json;charset=utf-8')
  expect(await downloadedJSON(blob)).toEqual(server)
  expect(download.links).toEqual([
    {
      filename: `allocation-research-comparison-${baseline.id}-${selected.id}.json`,
      href: 'blob:synthetic-comparison',
      attached: true,
    },
  ])
  expect(document.querySelector('a[download]')).toBeNull()
  expect(download.revokeObjectURL).not.toHaveBeenCalled()
  expect(download.revocations).toHaveLength(1)
  download.revocations[0]()
  expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-comparison')
})

it.each([
  'baseline',
  'selected',
  'account',
  'currentness',
  'fingerprint',
  'integrity',
  'history_page',
] as const)('clears the accepted download when %s context changes', async (change) => {
  const fetcher = vi.fn().mockResolvedValue(response(result()))
  vi.stubGlobal('fetch', fetcher)
  const download = mockComparisonDownload()
  const { rerender } = render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const oldButton = await screen.findByRole('button', { name: exportName })
  if (change === 'baseline')
    await userEvent.selectOptions(screen.getByLabelText(baselineName), other.id)
  if (change === 'selected') rerender(<Subject target={other} />)
  if (change === 'account')
    rerender(<Subject account="synthetic-other-account" history={[]} target={null} />)
  if (change === 'currentness')
    rerender(
      <Subject
        target={{ ...selected, currentness: { current: false, reasons: ['inputs_changed'] } }}
      />,
    )
  if (change === 'fingerprint')
    rerender(<Subject target={{ ...selected, content_fingerprint: 'd'.repeat(64) }} />)
  if (change === 'integrity')
    rerender(
      <Subject
        target={{ ...selected, integrity: { available: false, reason: 'receipt_content_changed' } }}
      />,
    )
  if (change === 'history_page') rerender(<Subject history={[other]} />)
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
  fireEvent.click(oldButton)
  expect(download.createObjectURL).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('removes an older download while replacement comparison is pending and leaves none after an error', async () => {
  const wait = pending()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(result()))
    .mockReturnValueOnce(wait.promise)
  vi.stubGlobal('fetch', fetcher)
  const download = mockComparisonDownload()
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  const oldButton = await screen.findByRole('button', { name: exportName })
  fireEvent.click(screen.getByRole('button', { name: compareName }))
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  fireEvent.click(oldButton)
  expect(download.createObjectURL).not.toHaveBeenCalled()
  await act(async () =>
    wait.resolve(response({ detail: { code: 'receipt_content_changed' } }, 409)),
  )
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Receipt comparison result' })).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('never exposes an identity-mismatched API response for download', async () => {
  const wrong = result()
  wrong.selected.id = other.id
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(wrong)))
  const download = mockComparisonDownload()
  render(<Subject />)
  await userEvent.selectOptions(screen.getByLabelText(baselineName), baseline.id)
  await userEvent.click(screen.getByRole('button', { name: compareName }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The comparison receipt identities do not match.',
  )
  expect(screen.queryByRole('button', { name: exportName })).toBeNull()
  expect(download.createObjectURL).not.toHaveBeenCalled()
})
