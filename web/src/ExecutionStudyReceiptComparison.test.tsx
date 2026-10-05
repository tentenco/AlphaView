import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ExecutionStudyReceiptComparison,
  type ExecutionStudyComparisonReceipt,
  type ExecutionStudyComparisonResult,
} from './ExecutionStudyReceiptComparison'

const cryptoModule: string = 'node:crypto'
const { createHash, webcrypto } = (await import(cryptoModule)) as {
  createHash: (algorithm: string) => {
    update: (value: string) => { digest: (encoding: 'hex') => string }
  }
  webcrypto: Crypto
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
const accountId = 'a'.repeat(32),
  proposalId = 'b'.repeat(32)
const t = (_zh: string, en: string) => en
const summary = (id: string): ExecutionStudyComparisonReceipt => ({
  id: id.repeat(64),
  account_id: accountId,
  proposal_id: proposalId,
  kind: 'volume_day',
  created_at: '2026-10-01T23:00:00+00:00',
  content_fingerprint: (id === 'c' ? 'e' : 'f').repeat(64),
  raw_evidence_sha256: '0'.repeat(64),
  status: 'incomplete',
  integrity: { available: true, reason: null },
  currentness: { current: true, reasons: [] },
})
const entries = [summary('c'), summary('d')]
const props = {
  accountId,
  proposalId,
  accountVersion: 1,
  kind: 'volume_day' as const,
  receipts: entries,
  total: 2,
  t,
}
function result() {
  const side = (entry: ExecutionStudyComparisonReceipt) => ({
    summary: { ...entry },
    original_receipt: {
      receipt_id: entry.id,
      kind: entry.kind,
      account_context: { account_id: accountId },
      source_context: { raw_evidence_sha256: entry.raw_evidence_sha256 },
      evidence: {
        account_id: accountId,
        source: { id: proposalId, account_id: accountId },
        synthetic: { whole: 1, negativeZero: 0, exponent: 1e-9, unicode: '合成é', missing: null },
      },
      policy: { advisory_only: true, execution_source: false, gating_authority: false },
    },
  })
  return {
    engine_version: 'alphaview-execution-study-receipt-comparison-v1',
    account_id: accountId,
    proposal_id: proposalId,
    account_version: 1,
    kind: 'volume_day',
    request: {
      baseline_receipt_id: entries[0].id,
      selected_receipt_id: entries[1].id,
      expected_baseline_fingerprint: entries[0].content_fingerprint,
      expected_selected_fingerprint: entries[1].content_fingerprint,
      expected_account_version: 1,
    },
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:4',
    baseline: side(entries[0]),
    selected: side(entries[1]),
    comparison: {
      historically_comparable: true,
      reasons: [] as string[],
      basis_checks: [
        {
          code: 'raw_bar_evidence',
          matches: true,
          baseline: '1'.repeat(64),
          selected: '1'.repeat(64),
        },
      ],
      assumptions: {
        baseline: { participation_pct: 10, limits: null, gtd_date: null },
        selected: { participation_pct: 20, limits: null, gtd_date: null },
      },
      orders: [
        {
          symbol: 'SYNA',
          paired: true,
          baseline_status: 'partial_expired',
          selected_status: 'unavailable',
          baseline_reason: null,
          selected_reason: 'missing_execution_bar',
          metrics: {
            scenario_shares: {
              baseline: 10 as number | null,
              selected: 20 as number | null,
              delta: 10 as number | null,
              reason: null as string | null,
              unit: 'shares',
            },
            expired_shares: {
              baseline: null as number | null,
              selected: null as number | null,
              delta: null as number | null,
              reason: 'baseline_value_unavailable' as string | null,
              unit: 'shares',
            },
          },
          sessions: [] as {
            date: string
            paired: boolean
            baseline_status: string
            selected_status: string
            baseline_reason: null
            selected_reason: null
            metrics: {
              scenario_shares: {
                baseline: number
                selected: number
                delta: number
                reason: null
                unit: string
              }
            }
          }[],
        },
      ],
      direction: 'selected_minus_baseline',
      aggregate: null,
      causal_attribution: false,
      execution_authority: false,
    },
    method: 'Synthetic research comparison',
  }
}
function response(value: unknown = result(), status = 200, badHash = false) {
  const raw = JSON.stringify(value)
    .replaceAll('"whole":1,', '"whole":1.0,')
    .replaceAll('"negativeZero":0,', '"negativeZero":-0.0,')
    .replaceAll('"exponent":1e-9,', '"exponent":1e-09,')
  return {
    raw,
    response: new Response(raw, {
      status,
      headers: { ETag: `"${badHash ? '0'.repeat(64) : hash(raw)}"` },
    }),
  }
}
function manyOrders() {
  const value = result()
  const template = value.comparison.orders[0]
  value.comparison.orders = Array.from({ length: 100 }, (_, index) => {
    const row = structuredClone(template)
    row.symbol = `SYN${String(99 - index).padStart(3, '0')}`
    row.baseline_status = 'partial_expired'
    row.selected_status = index % 4 >= 2 ? 'unavailable' : 'scenario_full'
    row.metrics.scenario_shares = {
      baseline: 10,
      selected: index % 4 === 2 ? null : index % 4 === 1 ? 10 : 12,
      delta: index % 4 === 2 ? null : index % 4 === 1 ? -0 : 2,
      reason: index % 4 === 2 ? 'selected_value_unavailable' : null,
      unit: 'shares',
    }
    row.metrics.expired_shares = {
      baseline: index % 4 >= 2 ? null : 5,
      selected: index % 4 >= 2 ? null : 5,
      delta: index % 4 >= 2 ? null : 0,
      reason: index % 4 >= 2 ? 'baseline_value_unavailable' : null,
      unit: 'shares',
    }
    row.sessions = [
      {
        date: '2026-10-01',
        paired: true,
        baseline_status: 'evaluated',
        selected_status: 'evaluated',
        baseline_reason: null,
        selected_reason: null,
        metrics: {
          scenario_shares: { baseline: 0, selected: 123, delta: 123, reason: null, unit: 'shares' },
        },
      },
    ]
    return row
  })
  return value
}
function fullCsvResult(
  kind: ExecutionStudyComparisonResult['kind'] = 'volume_day',
): ExecutionStudyComparisonResult {
  const value = manyOrders() as ExecutionStudyComparisonResult
  value.kind = kind
  for (const side of [value.baseline, value.selected]) {
    side.summary.kind = kind
    side.original_receipt.kind = kind
  }
  value.comparison.basis_checks = [
    'method_versions',
    'saved_evidence_shape',
    'study_method',
    'saved_proposal',
    'evaluation_snapshot',
    'frozen_orders_and_units',
    'exact_session_horizon',
    'raw_bar_evidence',
    'saved_coverage',
    'order_and_day_identity',
  ].map((code) => ({ code, matches: true, baseline: 'saved', selected: 'saved' }))
  const metricSet = (names: string[], unknown = false) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          baseline: unknown ? null : 10,
          selected: unknown ? null : 12,
          delta: unknown ? null : 2,
          reason: unknown ? 'baseline_value_unavailable' : null,
          unit:
            name === 'raw_open'
              ? 'USD_per_share'
              : name === 'fill_fraction_pct'
                ? 'percentage_points'
                : name.includes('notional')
                  ? 'USD'
                  : 'shares',
        },
      ]),
    )
  for (const row of value.comparison.orders) {
    row.metrics = metricSet(
      kind === 'open_gtd'
        ? [
            'observed_prefix_scenario_shares',
            'last_known_remaining_shares',
            'observed_prefix_reference_notional',
            'final_scenario_shares',
            'expired_shares',
            'final_reference_notional',
          ]
        : [
            'raw_open',
            'session_volume',
            'capacity_shares',
            'scenario_shares',
            'expired_shares',
            'fill_fraction_pct',
            'reference_notional',
          ],
    )
    row.sessions =
      kind === 'open_gtd'
        ? Array.from({ length: 5 }, (_, index) => ({
            date: `2026-10-${String(index + 1).padStart(2, '0')}`,
            paired: true,
            baseline_status: index === 4 ? 'future_unknown' : 'evaluated',
            selected_status: index === 4 ? 'future_unknown' : 'evaluated',
            baseline_reason: index === 4 ? 'future_unknown' : null,
            selected_reason: index === 4 ? 'future_unknown' : null,
            metrics: metricSet(
              [
                'raw_open',
                'session_volume',
                'remaining_before',
                'capacity_shares',
                'scenario_shares',
                'remaining_after',
                'reference_notional',
              ],
              index === 4,
            ),
          }))
        : []
  }
  return value
}
const orderNodes = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLDetailsElement>('[data-comparison-order-index]'),
]
const searchOrders = () =>
  screen.getByRole('searchbox', { name: 'Search compared order symbols (optional)' })
const choose = () => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Baseline receipt' }), {
    target: { value: entries[0].id },
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
    target: { value: entries[1].id },
  })
}
const button = () => screen.getByRole('button', { name: 'Compare two studies' })
let blobs: Blob[]
let filenames: string[]
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', vi.fn())
  blobs = []
  filenames = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:synthetic-comparison'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filenames.push(this.download)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })

describe('ExecutionStudyReceiptComparison', () => {
  it('uses already-loaded rows, does no autoload and disables empty/same selections', () => {
    const view = render(<ExecutionStudyReceiptComparison {...props} receipts={[]} total={0} />)
    expect(fetch).not.toHaveBeenCalled()
    expect(button()).toHaveProperty('disabled', true)
    expect(screen.getByText(/at least two verifiable/)).not.toBeNull()
    view.rerender(<ExecutionStudyReceiptComparison {...props} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Baseline receipt' }), {
      target: { value: entries[0].id },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
      target: { value: entries[0].id },
    })
    expect(button()).toHaveProperty('disabled', true)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('filters corrupt, foreign-scope and wrong-kind rows without using their data', () => {
    const invalid = [
      { ...entries[1], integrity: { available: false, reason: 'corrupt' } },
      { ...entries[1], account_id: 'f'.repeat(32) },
      { ...entries[1], kind: 'open_gtd' as const },
    ]
    render(
      <ExecutionStudyReceiptComparison {...props} receipts={[entries[0], ...invalid]} total={4} />,
    )
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByText(/at least two verifiable/)).not.toBeNull()
  })
  it('supports keyboard selection and one explicit compare with both hashes and account version', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response().response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Baseline receipt' }),
      entries[0].id,
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Selected receipt' }),
      entries[1].id,
    )
    const target = button()
    target.focus()
    await user.keyboard('{Enter}')
    await screen.findByText('Comparison bases match; only known values are compared.')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      `/api/paper/accounts/${accountId}/proposals/${proposalId}/study-receipts/compare`,
    )
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(result().request)
    expect(screen.getByText('Baseline value is unknown')).not.toBeNull()
    expect(screen.getByText(/not actual fills/)).not.toBeNull()
  })
  it('guards rapid clicks and downloads unchanged full response bytes without another request', async () => {
    const evidence = response()
    vi.mocked(fetch).mockResolvedValue(evidence.response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    const target = button()
    fireEvent.click(target)
    fireEvent.click(target)
    fireEvent.click(await screen.findByRole('button', { name: 'Download full comparison JSON' }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await readBlob(blobs[0])).toBe(evidence.raw)
    expect(filenames[0]).toMatch(/^alphaview-study-comparison-volume_day-[a-f0-9-]+\.json$/)
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-comparison')
  })
  it('shows incompatible bases and null deltas while retaining original values and download', async () => {
    const value = result()
    value.comparison.historically_comparable = false
    value.comparison.reasons = ['saved_coverage']
    value.comparison.orders[0].metrics.scenario_shares.delta = null
    value.comparison.orders[0].metrics.scenario_shares.reason = 'comparison_basis_incompatible'
    vi.mocked(fetch).mockResolvedValue(response(value).response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText(
      'Comparison bases are incompatible; original values remain and all differences are unavailable.',
    )
    expect(screen.getByText('Saved evidence coverage differs')).not.toBeNull()
    expect(screen.getByText('Baseline: 10')).not.toBeNull()
    expect(screen.getByText('Selected: 20')).not.toBeNull()
    expect(screen.getAllByText('Difference: —').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Download full comparison JSON' })).not.toBeNull()
  })
  it('allows stale verified originals and shows their observation separately', async () => {
    const value = result()
    value.baseline.summary.currentness = { current: false, reasons: ['inputs_changed'] }
    vi.mocked(fetch).mockResolvedValue(response(value).response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText(/Historical sources changed/)
    expect(
      screen.getByText('Comparison bases match; only known values are compared.'),
    ).not.toBeNull()
  })
  it.each(['account', 'proposal', 'version', 'history', 'disabled'] as const)(
    'invalidates pending response on %s change without stale download revival',
    async (change) => {
      let resolve!: (response: Response) => void
      vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
          resolve = done
        }),
      )
      const view = render(<ExecutionStudyReceiptComparison {...props} />)
      choose()
      fireEvent.click(button())
      const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
      const next = { ...props, enabled: true }
      if (change === 'account') next.accountId = 'f'.repeat(32)
      if (change === 'proposal') next.proposalId = 'f'.repeat(32)
      if (change === 'version') next.accountVersion = 2
      if (change === 'history') next.receipts = [entries[0]]
      if (change === 'disabled') next.enabled = false
      view.rerender(<ExecutionStudyReceiptComparison {...next} />)
      expect(signal?.aborted).toBe(true)
      await act(async () => {
        resolve(response().response)
      })
      view.rerender(<ExecutionStudyReceiptComparison {...props} />)
      expect(screen.queryByRole('button', { name: 'Download full comparison JSON' })).toBeNull()
      expect(
        screen.queryByText('Comparison bases match; only known values are compared.'),
      ).toBeNull()
    },
  )
  it('clears completed result on selection changes and source away/back', async () => {
    vi.mocked(fetch).mockResolvedValue(response().response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByRole('button', { name: 'Download full comparison JSON' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
      target: { value: entries[0].id },
    })
    choose()
    expect(screen.queryByRole('button', { name: 'Download full comparison JSON' })).toBeNull()
    view.rerender(<ExecutionStudyReceiptComparison {...props} enabled={false} />)
    view.rerender(<ExecutionStudyReceiptComparison {...props} />)
    expect(screen.queryByRole('button', { name: 'Download full comparison JSON' })).toBeNull()
  })
  it('aborts on pagehide and unmount with no late result or Blob', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    fireEvent(window, new Event('pagehide'))
    expect(signal?.aborted).toBe(true)
    view.unmount()
    await act(async () => {
      resolve(response().response)
    })
    expect(blobs).toHaveLength(0)
  })
  it('shows conflict without preserving an earlier comparison as current', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response().response)
      .mockResolvedValueOnce(
        new Response('{"detail":{"code":"comparison_account_changed"}}', { status: 409 }),
      )
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByRole('button', { name: 'Download full comparison JSON' })
    fireEvent.click(button())
    expect((await screen.findByRole('alert')).textContent).toContain('comparison_account_changed')
    expect(screen.queryByRole('button', { name: 'Download full comparison JSON' })).toBeNull()
  })
  it.each(['identity', 'hash', 'unknown_delta', 'incompatible_delta'] as const)(
    'rejects invalid %s response',
    async (change) => {
      const value = result()
      if (change === 'identity')
        value.selected.original_receipt.evidence.source.account_id = 'f'.repeat(32)
      if (change === 'unknown_delta')
        value.comparison.orders[0].metrics.scenario_shares.reason = 'missing_value'
      if (change === 'incompatible_delta') value.comparison.historically_comparable = false
      vi.mocked(fetch).mockResolvedValue(response(value, 200, change === 'hash').response)
      render(<ExecutionStudyReceiptComparison {...props} />)
      choose()
      fireEvent.click(button())
      await screen.findByRole('alert')
      expect(screen.queryByRole('button', { name: 'Download full comparison JSON' })).toBeNull()
      expect(blobs).toHaveLength(0)
    },
  )
  it('renders saved daily rows without substituting missing values', async () => {
    const value = result()
    value.comparison.orders[0].sessions = [
      {
        date: '2026-10-01',
        paired: true,
        baseline_status: 'evaluated',
        selected_status: 'evaluated',
        baseline_reason: null,
        selected_reason: null,
        metrics: {
          scenario_shares: { baseline: 0, selected: 2, delta: 2, reason: null, unit: 'shares' },
        },
      },
    ]
    vi.mocked(fetch).mockResolvedValue(response(value).response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText('Saved values by session')
    expect(screen.getByText('Baseline: 0')).not.toBeNull()
    expect(screen.getByText('2026-10-01')).not.toBeNull()
    expect(screen.getAllByText('Baseline: —').length).toBeGreaterThan(0)
  })
  it('shows 100 orders in original order, initially closed, with order-only delta-field counts', async () => {
    const value = manyOrders()
    const original = structuredClone(value)
    const evidence = response(value)
    vi.mocked(fetch).mockResolvedValue(evidence.response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText('Order page 1 / 4')
    let rows = orderNodes(view.container)
    expect(rows).toHaveLength(25)
    expect(rows.every((row) => !row.open)).toBe(true)
    expect(rows.map((row) => row.dataset.comparisonOrderIndex)).toEqual(
      Array.from({ length: 25 }, (_, index) => String(index)),
    )
    expect(rows.map((row) => row.querySelector('summary strong')?.textContent)).toEqual(
      value.comparison.orders.slice(0, 25).map((row) => row.symbol),
    )
    const summaries = rows.slice(0, 4).map((row) => row.querySelector('summary')!.textContent)
    expect(summaries[0]).toContain('Baseline: partial_expired · Selected: scenario_full')
    expect(summaries[0]).toContain('Order-level difference fields: 2')
    expect(summaries[0]).toContain(
      'Known nonzero difference fields: 1 · Unknown difference fields: 0',
    )
    expect(summaries[1]).toContain(
      'Known nonzero difference fields: 0 · Unknown difference fields: 0',
    )
    expect(summaries[2]).toContain(
      'Known nonzero difference fields: 0 · Unknown difference fields: 2',
    )
    expect(summaries[3]).toContain(
      'Known nonzero difference fields: 1 · Unknown difference fields: 1',
    )
    // Daily nonzero fields are inside the original detail, not counted in the order summary.
    expect(rows[1].querySelectorAll('.execution-study-comparison-metric')).toHaveLength(3)
    expect(within(rows[1]).getByText('Difference: 123')).not.toBeNull()
    expect(screen.getByText(/Matching orders 100 \/ 100 · Showing orders 1–25/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    rows = orderNodes(view.container)
    expect(rows[0].dataset.comparisonOrderIndex).toBe('75')
    expect(rows.at(-1)?.querySelector('summary strong')?.textContent).toBe('SYN000')
    expect(screen.getByRole('button', { name: 'Next orders' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous orders' }))
    expect(orderNodes(view.container)[0].dataset.comparisonOrderIndex).toBe('50')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(value).toEqual(original)
  })
  it('keeps local symbol search and page on unrelated rerenders, resets on new accepted comparison', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(manyOrders()).response)
      .mockResolvedValueOnce(response(manyOrders()).response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText('Order page 1 / 4')
    fireEvent.change(searchOrders(), { target: { value: 'sYn0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    const firstNode = orderNodes(view.container)[0]
    fireEvent.click(firstNode.querySelector('summary')!)
    expect(firstNode.open).toBe(true)
    view.rerender(
      <ExecutionStudyReceiptComparison
        {...props}
        receipts={entries.map((entry) => ({ ...entry }))}
        total={50}
        t={(_zh, en) => en}
      />,
    )
    expect(searchOrders()).toHaveProperty('value', 'sYn0')
    expect(screen.getByText('Order page 2 / 4')).not.toBeNull()
    expect(orderNodes(view.container)[0]).toBe(firstNode)
    expect(firstNode.open).toBe(true)
    fireEvent.change(searchOrders(), { target: { value: 'syN00' } })
    expect(screen.getByText('Order page 1 / 1')).not.toBeNull()
    expect(orderNodes(view.container)).toHaveLength(10)
    expect(orderNodes(view.container)[0].dataset.comparisonOrderIndex).toBe('90')
    fireEvent.change(searchOrders(), { target: { value: 'SYN[0]' } })
    expect(orderNodes(view.container)).toHaveLength(0)
    expect(screen.getByText('Order page 0 / 0')).not.toBeNull()
    expect(screen.getByText(/No orders match this search/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Previous orders' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Next orders' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear order search' }))
    fireEvent.change(searchOrders(), { target: { value: 'syn0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.click(button())
    await screen.findByText('Order page 1 / 4')
    expect(searchOrders()).toHaveProperty('value', '')
    expect(orderNodes(view.container).every((row) => !row.open)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('retains incompatible verdict, original statuses and exact full download after filtering to no orders', async () => {
    const value = manyOrders()
    value.comparison.historically_comparable = false
    value.comparison.reasons = ['saved_coverage']
    value.comparison.basis_checks[0].matches = false
    value.baseline.summary.currentness = { current: false, reasons: ['inputs_changed'] }
    value.selected.summary.currentness = { current: false, reasons: ['session_changed'] }
    for (const row of value.comparison.orders) {
      for (const metric of Object.values(row.metrics)) {
        metric.delta = null
        metric.reason = 'comparison_basis_incompatible'
      }
      row.sessions = []
    }
    const evidence = response(value)
    vi.mocked(fetch).mockResolvedValue(evidence.response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText('Order page 1 / 4')
    const summary = orderNodes(view.container)[0].querySelector('summary')!
    expect(summary.textContent).toContain(
      'Known nonzero difference fields: 0 · Unknown difference fields: 2',
    )
    expect(summary.textContent).not.toMatch(/no change|complete|winner/i)
    fireEvent.change(searchOrders(), { target: { value: 'missing-symbol' } })
    expect(orderNodes(view.container)).toHaveLength(0)
    expect(screen.getByText(/Comparison bases are incompatible/)).not.toBeNull()
    expect(screen.getByText('Saved evidence coverage differs')).not.toBeNull()
    expect(screen.getByText('inputs_changed')).not.toBeNull()
    expect(screen.getByText('session_changed')).not.toBeNull()
    expect(screen.getAllByText(/Historical sources changed · incomplete/)).toHaveLength(2)
    expect(
      screen.getByText('Comparison bases and original coverage').closest('details'),
    ).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download full comparison JSON' }))
    expect(await readBlob(blobs[0])).toBe(evidence.raw)
    expect(JSON.parse(await readBlob(blobs[0])).comparison.orders).toHaveLength(100)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('downloads all 100 GTD orders and every daily metric from a later page or filtered view, then preserves literal original JSON', async () => {
    const value = fullCsvResult('open_gtd'),
      saved = response(value)
    vi.mocked(fetch).mockResolvedValueOnce(saved.response)
    render(
      <ExecutionStudyReceiptComparison
        {...props}
        kind="open_gtd"
        receipts={entries.map((item) => ({ ...item, kind: 'open_gtd' }))}
      />,
    )
    choose()
    fireEvent.click(button())
    const csv = await screen.findByRole('button', {
      name: 'Download all order and daily comparisons CSV',
    })
    expect(blobs).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    expect(screen.getByText('Order page 2 / 4')).toBeTruthy()
    fireEvent.click(csv)
    fireEvent.change(searchOrders(), { target: { value: 'SYN099' } })
    expect(screen.getByText('Order page 1 / 1')).toBeTruthy()
    fireEvent.click(csv)
    fireEvent.click(screen.getByRole('button', { name: 'Download full comparison JSON' }))
    const contents = await Promise.all(blobs.map(readBlob))
    expect(contents[1]).toBe(contents[0])
    expect(contents[2]).toBe(saved.raw)
    const [headers, ...rows] = contents[0]
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((row) => row.slice(1, -1).split('","'))
    const data = rows.map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index]])),
    )
    expect(data).toHaveLength(4100)
    expect(data.filter((row) => row.record_level === 'order')).toHaveLength(600)
    expect(data.filter((row) => row.record_level === 'session')).toHaveLength(3500)
    expect(data[0]).toMatchObject({
      order_number: '1',
      symbol: 'SYN099',
      date: '',
      date_present: 'false',
      baseline_receipt_id: entries[0].id,
      selected_receipt_fingerprint: entries[1].content_fingerprint,
    })
    expect(data.at(-1)).toMatchObject({
      order_number: '100',
      symbol: 'SYN000',
      session_number: '5',
      date: '2026-10-05',
      baseline_value: '',
      difference: '',
      difference_present: 'false',
      difference_state: 'unavailable',
      metric_reason: 'baseline_value_unavailable',
    })
    expect(filenames[0]).toBe(
      `alphaview-study-comparison-open_gtd-${entries[0].id}-${entries[1].id}.csv`,
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('exports incompatible original side values with blank differences while unavailable fields remain explicit', async () => {
    const value = fullCsvResult()
    value.comparison.historically_comparable = false
    value.comparison.reasons = ['raw_bar_evidence']
    value.comparison.basis_checks[7].matches = false
    for (const row of value.comparison.orders)
      for (const metric of Object.values(row.metrics)) {
        metric.delta = null
        metric.reason = 'comparison_basis_incompatible'
      }
    value.comparison.orders[0].metrics.raw_open.baseline = null
    vi.mocked(fetch).mockResolvedValueOnce(response(value).response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download all order and daily comparisons CSV' }),
    )
    const content = await readBlob(blobs[0]),
      [headers, ...rows] = content
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n')
        .map((row) => row.slice(1, -1).split('","'))
    const data = rows.map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index]])),
    )
    expect(data).toHaveLength(700)
    expect(
      data.every(
        (row) =>
          row.full_basis_compatible === 'false' &&
          row.difference === '' &&
          row.difference_present === 'false',
      ),
    ).toBe(true)
    expect(data[0]).toMatchObject({
      baseline_value: '',
      baseline_value_present: 'false',
      selected_value: '12',
      metric_reason: 'comparison_basis_incompatible',
    })
  })

  it('retains original JSON but refuses CSV if required metric structure is missing', async () => {
    const value = fullCsvResult()
    delete value.comparison.orders[0].metrics.raw_open
    vi.mocked(fetch).mockResolvedValueOnce(response(value).response)
    render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByRole('button', { name: 'Download full comparison JSON' })
    expect(
      screen.queryByRole('button', { name: 'Download all order and daily comparisons CSV' }),
    ).toBeNull()
    expect(screen.getByText(/CSV cannot be created/)).toBeTruthy()
  })

  it.each([
    'account',
    'proposal',
    'version',
    'kind',
    'history',
    'disabled',
    'selection',
    'pagehide',
  ] as const)('clears accepted CSV after %s changes', async (change) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(fullCsvResult()).response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByRole('button', { name: 'Download all order and daily comparisons CSV' })
    if (change === 'account')
      view.rerender(<ExecutionStudyReceiptComparison {...props} accountId={'f'.repeat(32)} />)
    if (change === 'proposal')
      view.rerender(<ExecutionStudyReceiptComparison {...props} proposalId={'f'.repeat(32)} />)
    if (change === 'version')
      view.rerender(<ExecutionStudyReceiptComparison {...props} accountVersion={2} />)
    if (change === 'kind')
      view.rerender(<ExecutionStudyReceiptComparison {...props} kind="limit_day" />)
    if (change === 'history')
      view.rerender(<ExecutionStudyReceiptComparison {...props} receipts={[]} />)
    if (change === 'disabled')
      view.rerender(<ExecutionStudyReceiptComparison {...props} enabled={false} />)
    if (change === 'selection')
      fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
        target: { value: '' },
      })
    if (change === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
    expect(
      screen.queryByRole('button', { name: 'Download all order and daily comparisons CSV' }),
    ).toBeNull()
    expect(blobs).toHaveLength(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uses native keyboard controls and keeps multiple mounted comparisons and surrounding drafts isolated', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(manyOrders()).response)
      .mockResolvedValueOnce(response().response)
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    const originalHash = window.location.hash
    const view = render(
      <form onSubmit={submit}>
        <input aria-label="Unsubmitted research draft" defaultValue="keep 7,19" />
        <ExecutionStudyReceiptComparison {...props} />
        <ExecutionStudyReceiptComparison {...props} />
      </form>,
    )
    const regions = screen.getAllByRole('region', { name: 'Compare saved execution studies' })
    for (const region of regions) {
      const scope = within(region)
      await user.selectOptions(
        scope.getByRole('combobox', { name: 'Baseline receipt' }),
        entries[0].id,
      )
      await user.selectOptions(
        scope.getByRole('combobox', { name: 'Selected receipt' }),
        entries[1].id,
      )
      await user.click(scope.getByRole('button', { name: 'Compare two studies' }))
      await scope.findByRole('searchbox')
    }
    const first = within(regions[0]),
      second = within(regions[1])
    first.getByRole('searchbox').focus()
    await user.keyboard('{Enter}')
    expect(submit).not.toHaveBeenCalled()
    first.getByRole('button', { name: 'Next orders' }).focus()
    await user.keyboard('{Enter}')
    expect(first.getByText('Order page 2 / 4')).not.toBeNull()
    const summary = orderNodes(regions[0])[0].querySelector('summary')!
    summary.focus()
    expect(document.activeElement).toBe(summary)
    await user.click(summary)
    expect(orderNodes(regions[0])[0].open).toBe(true)
    expect(orderNodes(regions[0])[1].open).toBe(false)
    expect(second.getByRole('searchbox')).toHaveProperty('value', '')
    expect(second.getByText('Order page 1 / 1')).not.toBeNull()
    expect(orderNodes(regions[1])[0].open).toBe(false)
    expect(screen.getByRole('textbox', { name: 'Unsubmitted research draft' })).toHaveProperty(
      'value',
      'keep 7,19',
    )
    const ids = [...view.container.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(submit).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(originalHash)
  })
  it('handles an empty original order list without inventing orders or suppressing full evidence', async () => {
    const value = result()
    value.comparison.orders = []
    vi.mocked(fetch).mockResolvedValue(response(value).response)
    const view = render(<ExecutionStudyReceiptComparison {...props} />)
    choose()
    fireEvent.click(button())
    await screen.findByText('Order page 0 / 0')
    expect(orderNodes(view.container)).toHaveLength(0)
    expect(screen.getByText(/Matching orders 0 \/ 0 · Showing orders 0–0/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Download full comparison JSON' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next orders' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Previous orders' })).toHaveProperty('disabled', true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
