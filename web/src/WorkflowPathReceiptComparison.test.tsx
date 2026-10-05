import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowPathReceiptComparison,
  type PathReceiptComparison,
} from './WorkflowPathReceiptComparison'

const t = (_zh: string, en: string) => en
const accountId = 'a'.repeat(32)
const ids = ['b'.repeat(64), 'c'.repeat(64)]
const fingerprints = ['d'.repeat(64), 'e'.repeat(64)]
const base = `/api/paper/accounts/${accountId}/workflow-path-receipts`
function summary(index: number) {
  return {
    id: ids[index],
    run_id: String(index + 1).repeat(32),
    kind: 'path_validation' as const,
    created_at: `2026-10-01T12:00:0${index}+00:00`,
    content_fingerprint: fingerprints[index],
    integrity: { available: true, reason: null },
    currentness: { current: false, reasons: ['inputs_changed'] },
  }
}
function result(): PathReceiptComparison {
  return {
    account_id: accountId,
    kind: 'path_validation',
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:1',
    request: {
      baseline_receipt_id: ids[0],
      selected_receipt_id: ids[1],
      expected_baseline_fingerprint: fingerprints[0],
      expected_selected_fingerprint: fingerprints[1],
    },
    baseline: {
      summary: summary(0),
      original_receipt: {
        evidence: {
          metrics: {
            final_value: 100000,
            return_pct: 0,
            max_drawdown_pct: -4,
            total_fees: 10,
            trade_count: 3,
          },
        },
      },
    },
    selected: {
      summary: summary(1),
      original_receipt: {
        evidence: {
          metrics: {
            final_value: 101000,
            return_pct: 1,
            max_drawdown_pct: -2,
            total_fees: 12,
            trade_count: 4,
          },
        },
      },
    },
    comparison: {
      historically_comparable: true,
      reasons: [],
      basis_checks: [{ code: 'raw_history', matches: true, baseline: 'f', selected: 'f' }],
      settings_differences: [
        { field: 'workflow.constraints.max_positions', baseline: 1, selected: 2 },
      ],
      source_context_differences: [
        { field: 'agent_run_id', baseline: 'first', selected: 'second' },
      ],
      baseline_metric_deltas: {
        final_value: 1000,
        return_pct: 1,
        max_drawdown_pct: 2,
        total_fees: 2,
        trade_count: 1,
      },
      scenario_pairs: [],
    },
  }
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const listing = () => ({
  account_id: accountId,
  kind: 'path_validation',
  items: [summary(0), summary(1)],
})
const load = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Load all receipts for this account' }))
async function select() {
  await screen.findByRole('combobox', { name: 'Baseline receipt' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Baseline receipt' }), {
    target: { value: ids[0] },
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
    target: { value: ids[1] },
  })
}
const compare = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Compare the two saved originals' }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('immutable path receipt comparison', () => {
  it('loads only on demand, compares exact fingerprints once, and retains descriptive stale evidence', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    load()
    await select()
    compare()
    compare()
    await screen.findByText('Historical comparison basis matches')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`${base}?kind=path_validation&limit=50`)
    expect(fetcher.mock.calls[1][0]).toBe(`${base}/compare`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    expect(screen.getAllByText('Historical sources are no longer current')).toHaveLength(2)
    expect(screen.getByText('workflow.constraints.max_positions')).toBeTruthy()
    expect(
      screen.getByText('Difference direction: selected − baseline. No winner is selected.'),
    ).toBeTruthy()
  })

  it('keeps empty and identical selection disabled, and prevents corrupt receipt selection', async () => {
    const data = listing()
    data.items.push({
      ...summary(0),
      id: 'f'.repeat(64),
      integrity: { available: false, reason: null },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => response(data)),
    )
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    load()
    await screen.findByRole('combobox', { name: 'Baseline receipt' })
    expect(
      screen
        .getByRole('button', { name: 'Compare the two saved originals' })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Baseline receipt' }), {
      target: { value: ids[0] },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
      target: { value: ids[0] },
    })
    expect(screen.getByText('Choose distinct receipts.')).toBeTruthy()
    expect(
      screen
        .getAllByRole('option', { name: /Unverifiable/ })
        .every((item) => item.hasAttribute('disabled')),
    ).toBe(true)
  })

  it('shows missing quantitative differences as dashes without erasing original metrics', async () => {
    const value = result()
    value.comparison.historically_comparable = false
    value.comparison.reasons = ['raw_history']
    value.comparison.baseline_metric_deltas = null
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    compare()
    await screen.findByText('Raw history fingerprints differ or are missing')
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
    expect(screen.getByText('100,000.00')).toBeTruthy()
    expect(screen.getByText('101,000.00')).toBeTruthy()
  })

  it('downloads the exact accepted response text without another request', async () => {
    const raw = JSON.stringify(result(), null, 2) + '\n'
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return 'blob:synthetic-comparison'
      }),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    compare()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download this complete comparison JSON' }),
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    const text = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsText(blobs[0])
    })
    expect(text).toBe(raw)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-comparison')
  })

  it('fences late responses and clears selection when account or account version changes', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />,
    )
    load()
    view.rerender(
      <WorkflowPathReceiptComparison accountId={'9'.repeat(32)} accountVersion={2} t={t} />,
    )
    await act(async () => finish(new Response(JSON.stringify(listing()))))
    expect(screen.queryByRole('combobox', { name: 'Baseline receipt' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('clears accepted results on selection changes and preserves 409 as an explicit error', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() =>
        response(
          { detail: { code: 'comparison_receipt_changed', message: 'Saved receipt changed' } },
          409,
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    compare()
    await screen.findByRole('button', { name: 'Download this complete comparison JSON' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
      target: { value: '' },
    })
    expect(
      screen.queryByRole('button', { name: 'Download this complete comparison JSON' }),
    ).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
      target: { value: ids[1] },
    })
    compare()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Saved receipt changed')
    expect(
      screen.queryByRole('button', { name: 'Download this complete comparison JSON' }),
    ).toBeNull()
  })

  it('rejects an over-limit or incorrectly scoped response before offering export', async () => {
    const wrong = { ...result(), account_id: '9'.repeat(32) }
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(wrong))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathReceiptComparison accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    compare()
    await screen.findByText('Comparison response does not match the selected receipts.')
    expect(
      screen.queryByRole('button', { name: 'Download this complete comparison JSON' }),
    ).toBeNull()
    fetcher.mockResolvedValueOnce(new Response(' '.repeat(5 * 1024 * 1024 + 1)))
    compare()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Response exceeds 5 MiB'),
    )
  })
})
