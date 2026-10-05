import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathCSCV, type WorkflowCSCVResult } from './WorkflowPathCSCV'

const t = (_zh: string, en: string) => en
const account = 'a'.repeat(32)
const id = (index: number) => (index + 1).toString(16).repeat(64)
const fp = (index: number) => (index + 5).toString(16).repeat(64)
const items = Array.from({ length: 9 }, (_, index) => ({
  id: id(index),
  account_id: account,
  run_id: `synthetic-workflow-${index}`,
  kind: 'path_validation',
  created_at: `2026-10-01T00:00:0${index}Z`,
  content_fingerprint: fp(index),
  status: 'evaluated',
  as_of: '2026-10-01',
  integrity: { available: true, reason: null as string | null },
  currentness: { current: true, reasons: [] },
}))
const indexValue = (values = items) => ({
  engine_version: 'alphaview-workflow-path-receipt-comparison-v1',
  account_id: account,
  account_version: 1,
  kind: 'path_validation',
  items: values,
  pagination: { limit: 50, offset: 0, total: values.length, returned: values.length },
})
const date = (index: number) => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
const combinations: number[][] = []
for (let a = 1; a <= 4; a++)
  for (let b = a + 1; b <= 5; b++) for (let c = b + 1; c <= 6; c++) combinations.push([a, b, c])
const evidence = (): WorkflowCSCVResult => ({
  engine_version: 'alphaview-workflow-path-cscv-v1',
  account_id: account,
  account_version: 1,
  request: {
    expected_account_version: 1,
    trials: items
      .slice(0, 3)
      .map((item) => ({ receipt_id: item.id, expected_fingerprint: item.content_fingerprint })),
  },
  status: 'evaluated',
  reasons: [],
  coverage: {
    required_trials: 3,
    verified_trials: 3,
    required_sessions: 252,
    available_sessions: 252,
    required_splits: 20,
    available_splits: 20,
  },
  trials: items.slice(0, 3).map((item, index) => ({
    receipt_id: item.id,
    content_fingerprint: item.content_fingerprint,
    configuration_fingerprint: (index + 10).toString(16).repeat(64),
    summary: item,
    original_receipt: {
      receipt_id: item.id,
      kind: 'path_validation',
      account_context: { account_id: account },
      evidence: {
        curve: Array.from({ length: 252 }, (_, day) => ({
          date: date(day),
          value: 100000 + day,
        })),
        future_original: { unknown: null },
      },
    },
  })),
  comparability: {
    basis_checks: items
      .slice(0, 3)
      .map((item) => ({ receipt_id: item.id, checks: [{ code: 'raw_history', matches: true }] })),
    duplicate_configuration_groups: [],
    settings_differences: items.slice(0, 3).map((item, index) => ({
      receipt_id: item.id,
      differences: index
        ? [
            {
              field: 'settings.workflow.constraints.max_position_weight_pct',
              baseline: 20,
              selected: 20 * (index + 1),
            },
          ]
        : [],
    })),
  },
  blocks: Array.from({ length: 6 }, (_, index) => ({
    block: index + 1,
    first_row: index * 42,
    last_row: (index + 1) * 42 - 1,
    start: date(index * 42),
    end: date((index + 1) * 42 - 1),
  })),
  return_matrix: {
    dates: Array.from({ length: 252 }, (_, index) => date(index)),
    columns: items.slice(0, 3).map((item) => item.id),
    values: Array.from({ length: 252 }, (_, index) => [
      0.02 + (index % 2) * 0.01,
      0.01 + (index % 2) * 0.01,
      (index % 2) * 0.01,
    ]),
  },
  splits: combinations.map((blocks, index) => ({
    split: index + 1,
    is_blocks: blocks,
    oos_blocks: [1, 2, 3, 4, 5, 6].filter((value) => !blocks.includes(value)),
    status: 'evaluated',
    reasons: [],
    scores: items.slice(0, 3).map((item, offset) => ({
      receipt_id: item.id,
      is: { count: 126, mean: 0.03 - offset * 0.01, sample_sd: 0.01, ratio: 3 - offset },
      oos: { count: 126, mean: 0.03 - offset * 0.01, sample_sd: 0.01, ratio: 3 - offset },
      reasons: [],
    })),
    is_maxima: [
      {
        receipt_id: id(0),
        weight: 1,
        is_ratio: 3,
        oos_ratio: 3,
        oos_average_rank: 3,
        omega: 0.75,
        logit: Math.log(3),
      },
    ],
    fractions: { at_or_below_median: 0, strictly_below_median: 0, exactly_at_median: 0 },
    is_tie_count: 1,
    oos_has_ties: false,
  })),
  aggregate: {
    at_or_below_median: 0,
    strictly_below_median: 0,
    exactly_at_median: 0,
    split_weight: 0.05,
    is_tied_splits: 0,
    oos_tied_splits: 0,
  },
  rank_metric: {
    name: 'daily_mean_over_sample_sd',
    sample_ddof: 1,
    risk_free_daily: 0,
    annualized: false,
    higher_is_better: true,
  },
  tie_method: 'exact_is_maxima_equal_weight__oos_ascending_average_rank',
  diagnostic_scope: 'selected_saved_trials_only',
  execution_authority: false,
  recommended_configuration: null,
  checked_as_of: '2026-10-01',
  checked_input_revision: 'synthetic:1',
  evidence_fingerprint: 'f'.repeat(64),
  method: 'Synthetic fixed CSCV method',
  warnings: ['Synthetic selected-set limitation'],
})
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const loadButton = () => screen.getByRole('button', { name: 'Load path receipts for this account' })
const calculate = () => screen.getByRole('button', { name: 'Inspect selected-trial CSCV' })
const download = () => screen.getByRole('button', { name: 'Download complete CSCV evidence JSON' })
const ready = () =>
  screen.findByText('All twenty splits evaluated; no pass verdict or recommended configuration')
const loadAndSelect = async (size = 3) => {
  fireEvent.click(loadButton())
  await screen.findByRole('group', { name: 'Select saved trials' })
  screen
    .getAllByRole('checkbox')
    .slice(0, size)
    .forEach((checkbox) => fireEvent.click(checkbox))
}
const goodFetch = (value = evidence()) =>
  vi
    .fn()
    .mockImplementationOnce(() => response(indexValue()))
    .mockImplementationOnce(() => response(value))
    .mockImplementationOnce(() => response(indexValue()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('WorkflowPathCSCV', () => {
  it('loads manually, submits immutable 3-trial expectations once, and retains all 20 splits with three equally visible fractions', async () => {
    let finish: (response: Response) => void = () => {}
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(indexValue()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
      .mockImplementationOnce(() => response(indexValue()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    await loadAndSelect()
    fireEvent.click(calculate())
    fireEvent.click(screen.getByRole('button', { name: 'Calculating fixed splits…' }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe(
      `/api/paper/accounts/${account}/workflow-path-receipts/cscv`,
    )
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(evidence().request)
    await act(async () => finish(new Response(JSON.stringify(evidence()))))
    await ready()
    expect(fetcher).toHaveBeenCalledTimes(3)
    const table = screen.getByRole('table', {
      name: 'All twenty complementary splits; fractions include explicit tie weights',
    })
    expect(within(table).getAllByRole('row')).toHaveLength(21)
    for (const label of [
      'At or below median (≤ 0)',
      'Strictly below median (< 0)',
      'Exactly at median (= 0)',
    ])
      expect(screen.getByText(label).parentElement?.textContent).toContain('0.00%')
    expect(screen.getByText(/unsaved or discarded discovery trials are unknown/)).toBeTruthy()
    expect(screen.getByText(/all ties produce 100%, 0%, 100%/)).toBeTruthy()
    fireEvent.click(screen.getByText('Inspect split scores, tie weights and logits'))
    fireEvent.change(screen.getByLabelText('Select split'), { target: { value: '19' } })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(
      screen.getByRole('table', { name: 'Trial daily mean / sample standard deviation' }),
    ).toBeTruthy()
  })

  it('enforces three through eight choices and keeps unverifiable receipts visible but disabled', async () => {
    const values = items.map((item) => ({ ...item }))
    values.push({
      ...items[8],
      id: 'e'.repeat(64),
      integrity: { available: false, reason: 'corrupt' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(indexValue(values))),
    )
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect(0)
    expect(calculate().hasAttribute('disabled')).toBe(true)
    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes.slice(0, 2).forEach((item) => fireEvent.click(item))
    expect(calculate().hasAttribute('disabled')).toBe(true)
    fireEvent.click(checkboxes[2])
    expect(calculate().hasAttribute('disabled')).toBe(false)
    checkboxes.slice(3, 8).forEach((item) => fireEvent.click(item))
    expect(checkboxes[8].hasAttribute('disabled')).toBe(true)
    expect(checkboxes[9].hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Original unverifiable/)).toBeTruthy()
    fireEvent.click(checkboxes[0])
    expect(checkboxes[8].hasAttribute('disabled')).toBe(false)
  })

  it('renders all-tie inclusive and median fractions without an overfit verdict', async () => {
    const value = evidence()
    value.aggregate = {
      ...value.aggregate!,
      at_or_below_median: 1,
      strictly_below_median: 0,
      exactly_at_median: 1,
      is_tied_splits: 20,
      oos_tied_splits: 20,
    }
    value.splits.forEach((split) => {
      split.is_maxima = items.slice(0, 3).map((item) => ({
        receipt_id: item.id,
        weight: 1 / 3,
        is_ratio: 1,
        oos_ratio: 1,
        oos_average_rank: 2,
        omega: 0.5,
        logit: 0,
      }))
      split.fractions = { at_or_below_median: 1, strictly_below_median: 0, exactly_at_median: 1 }
      split.is_tie_count = 3
      split.oos_has_ties = true
    })
    vi.stubGlobal('fetch', goodFetch(value))
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await ready()
    expect(screen.getByText('At or below median (≤ 0)').parentElement?.textContent).toContain(
      '100.00%',
    )
    expect(screen.getByText('Strictly below median (< 0)').parentElement?.textContent).toContain(
      '0.00%',
    )
    expect(screen.getByText('Exactly at median (= 0)').parentElement?.textContent).toContain(
      '100.00%',
    )
  })

  it('retains unavailable aggregate, original trials, and all20 split rows without inventing scores', async () => {
    const value = evidence()
    value.status = 'unavailable'
    value.aggregate = null
    value.reasons = [{ code: 'split_metric_unavailable' }]
    value.coverage.available_splits = 18
    for (const split of [value.splits[0], value.splits[19]]) {
      split.status = 'unavailable'
      split.reasons = ['trial_metric_unavailable']
      split.fractions = null
      split.is_maxima = []
      split.is_tie_count = null
      split.oos_has_ties = null
      split.scores[0].is = null
      split.scores[0].reasons = ['is_metric_unavailable']
    }
    vi.stubGlobal('fetch', goodFetch(value))
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await screen.findByText(
      'CSCV aggregate unavailable; all selected trials and twenty splits are retained',
    )
    expect(screen.getByText('At or below median (≤ 0)').parentElement?.textContent).toContain('—')
    expect(screen.getByText('At least one split has an unavailable rank metric')).toBeTruthy()
    expect(
      within(
        screen.getByRole('table', {
          name: 'All twenty complementary splits; fractions include explicit tie weights',
        }),
      ).getAllByRole('row'),
    ).toHaveLength(21)
    expect(download().hasAttribute('disabled')).toBe(false)
  })

  it('preserves the complete accepted raw JSON bytes, future fields, original receipts, and all252 matrix rows', async () => {
    const value = Object.assign(evidence(), {
      future: { one: 1, zero: -0, tiny: 1e-7, missing: null, note: '合成' },
    })
    const raw =
      JSON.stringify(value)
        .replace('"one":1', '"one":1.0')
        .replace('"zero":0', '"zero":-0.0')
        .replace('"tiny":1e-7', '"tiny":1e-07') + '\n'
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(indexValue()))
      .mockResolvedValueOnce(new Response(raw))
      .mockImplementationOnce(() => response(indexValue()))
    vi.stubGlobal('fetch', fetcher)
    let captured: Blob | undefined
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        captured = blob
        return 'blob:synthetic'
      }),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await ready()
    fireEvent.click(download())
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsText(captured!)
    })
    expect(downloaded).toBe(raw)
    expect(JSON.parse(downloaded).return_matrix.values).toHaveLength(252)
    expect(JSON.parse(downloaded).trials).toHaveLength(3)
    expect(JSON.parse(downloaded).trials[0].original_receipt.evidence.curve).toHaveLength(252)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([
    'wrong_account',
    'wrong_version',
    'wrong_request',
    'wrong_original',
    'missing_split',
    'nonfinite',
    'wrong_metric',
    'wrong_ties',
    'malformed_basis',
  ])('rejects %s evidence before post-calculation acceptance', async (fault) => {
    const value = evidence()
    if (fault === 'wrong_metric') value.rank_metric.sample_ddof = 0
    if (fault === 'wrong_ties') value.tie_method = 'first_winner'
    if (fault === 'malformed_basis') value.comparability.basis_checks = []
    if (fault === 'wrong_account') value.account_id = 'b'.repeat(32)
    if (fault === 'wrong_version') value.account_version = 2
    if (fault === 'wrong_request') value.request.trials[0].expected_fingerprint = 'e'.repeat(64)
    if (fault === 'wrong_original') value.trials[0].original_receipt.receipt_id = 'e'.repeat(64)
    if (fault === 'missing_split') value.splits.pop()
    let raw = JSON.stringify(value)
    if (fault === 'nonfinite') raw = raw.replace('"split_weight":0.05', '"split_weight":1e999')
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(indexValue()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await screen.findByRole('alert')
    expect(
      screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' }),
    ).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidates accepted evidence when selection changes and blocks detached old downloads', async () => {
    vi.stubGlobal('fetch', goodFetch())
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() })
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await ready()
    const old = download()
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(old)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' }),
    ).toBeNull()
    expect(calculate().hasAttribute('disabled')).toBe(true)
  })

  it('invalidates changed receipt fingerprints during observation but preserves checkbox draft selection', async () => {
    const changed = items.map((item) => ({ ...item }))
    changed[0].content_fingerprint = 'e'.repeat(64)
    const fetcher = goodFetch().mockImplementationOnce(() => response(indexValue(changed)))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() })
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await ready()
    const old = download()
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(
      'The selected receipts or account version changed, or cannot be checked. Reload the receipts.',
    )
    expect(
      screen.getAllByRole('checkbox').filter((item) => (item as HTMLInputElement).checked),
    ).toHaveLength(3)
    fireEvent.click(old)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('blocks downloads during a receipt recheck and aborts it when replacement calculation starts', async () => {
    const fetcher = goodFetch()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response(indexValue()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await ready()
    fireEvent(document, new Event('visibilitychange'))
    expect(download().hasAttribute('disabled')).toBe(true)
    const signal = fetcher.mock.calls[3][1].signal as AbortSignal
    fireEvent.click(calculate())
    await ready()
    expect(signal.aborted).toBe(true)
    expect(download().hasAttribute('disabled')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it.each(['account', 'version', 'disabled'])(
    'aborts pending calculations and discards late responses when %s changes',
    async (kind) => {
      let finish: (response: Response) => void = () => {}
      const fetcher = vi
        .fn()
        .mockImplementationOnce(() => response(indexValue()))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve
            }),
        )
      vi.stubGlobal('fetch', fetcher)
      const view = render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
      await loadAndSelect()
      fireEvent.click(calculate())
      const signal = fetcher.mock.calls[1][1].signal as AbortSignal
      view.rerender(
        <WorkflowPathCSCV
          accountId={kind === 'account' ? 'b'.repeat(32) : kind === 'disabled' ? null : account}
          accountVersion={kind === 'version' ? 2 : 1}
          t={t}
        />,
      )
      expect(signal.aborted).toBe(true)
      await act(async () => finish(new Response(JSON.stringify(evidence()))))
      expect(
        screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' }),
      ).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects an index with a different account version and handles empty input or reload without automatic execution', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ ...indexValue(), account_version: 2 }))
      .mockImplementationOnce(() => response(indexValue([])))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathCSCV accountId={null} accountVersion={null} t={t} />)
    expect(loadButton().hasAttribute('disabled')).toBe(true)
    fireEvent.click(loadButton())
    expect(fetcher).not.toHaveBeenCalled()
    view.rerender(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    fireEvent.click(loadButton())
    await screen.findByRole('alert')
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(loadButton())
    await screen.findByText('This account has no saved historical path receipts.')
    expect(calculate().hasAttribute('disabled')).toBe(true)
    view.unmount()
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a changed post-calculation index and never offers stale evidence for export', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(indexValue()))
      .mockImplementationOnce(() => response(evidence()))
      .mockImplementationOnce(() => response({ ...indexValue(), account_version: 2 }))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    await screen.findByRole('alert')
    expect(
      screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' }),
    ).toBeNull()
  })
})

it('explains a missing required saved configuration without dropping the selected draft or exposing a partial result', async () => {
  const detail = {
    code: 'cscv_trial_configuration_unavailable',
    receipt_ids: [items[1].id],
    coverage: {
      required_trials: 3,
      verified_trials: 3,
      available_configurations: 2,
      unavailable_configurations: 1,
    },
  }
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(indexValue()))
    .mockImplementationOnce(() => response({ detail }, 409))
  vi.stubGlobal('fetch', fetcher)
  render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
  await loadAndSelect()
  fireEvent.click(calculate())
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain(
    'A selected saved trial is missing required configuration information. The whole selection was rejected; no partial CSCV result was calculated.',
  )
  expect(error.textContent).toContain('Available configurations 2 / 3; unavailable 1.')
  expect(
    screen
      .getAllByRole('checkbox')
      .slice(0, 3)
      .every((item) => (item as HTMLInputElement).checked),
  ).toBe(true)
  expect(screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' })).toBeNull()
  expect(
    screen.queryByText('All twenty splits evaluated; no pass verdict or recommended configuration'),
  ).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(calculate().hasAttribute('disabled')).toBe(false)
})

it.each(['missing', 'wrong_counts', 'foreign_id'])(
  'omits unverified configuration error counts for %s metadata while retaining the explicit reason',
  async (shape) => {
    const detail: Record<string, unknown> = { code: 'cscv_trial_configuration_unavailable' }
    if (shape !== 'missing')
      Object.assign(detail, {
        receipt_ids: [shape === 'foreign_id' ? 'f'.repeat(64) : items[1].id],
        coverage: {
          required_trials: 3,
          verified_trials: 3,
          available_configurations: shape === 'wrong_counts' ? -1 : 2,
          unavailable_configurations: 1,
        },
      })
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(indexValue()))
      .mockImplementationOnce(() => response({ detail }, 409))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
    await loadAndSelect()
    fireEvent.click(calculate())
    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('missing required configuration information')
    expect(error.textContent).not.toContain('Available configurations')
    expect(
      screen
        .getAllByRole('checkbox')
        .slice(0, 3)
        .every((item) => (item as HTMLInputElement).checked),
    ).toBe(true)
    expect(
      screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' }),
    ).toBeNull()
  },
)

it('retains the existing source-change message for other 409 codes', async () => {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(indexValue()))
    .mockImplementationOnce(() => response({ detail: { code: 'cscv_account_changed' } }, 409))
  vi.stubGlobal('fetch', fetcher)
  render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
  await loadAndSelect()
  fireEvent.click(calculate())
  const error = await screen.findByRole('alert')
  expect(error.textContent).toBe(
    'The selected receipts or account version changed, or cannot be checked. Reload the receipts.',
  )
  expect(error.textContent).not.toContain('missing required configuration information')
})

it('removes a prior accepted result and download when the replacement selection has unavailable configuration', async () => {
  const fetcher = goodFetch().mockImplementationOnce(() =>
    response(
      {
        detail: {
          code: 'cscv_trial_configuration_unavailable',
          receipt_ids: [items[1].id],
          coverage: {
            required_trials: 3,
            verified_trials: 3,
            available_configurations: 2,
            unavailable_configurations: 1,
          },
        },
      },
      409,
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<WorkflowPathCSCV accountId={account} accountVersion={1} t={t} />)
  await loadAndSelect()
  fireEvent.click(calculate())
  await ready()
  expect(download().hasAttribute('disabled')).toBe(false)
  fireEvent.click(calculate())
  await screen.findByRole('alert')
  expect(
    screen.queryByText('All twenty splits evaluated; no pass verdict or recommended configuration'),
  ).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download complete CSCV evidence JSON' })).toBeNull()
  expect(
    screen
      .getAllByRole('checkbox')
      .slice(0, 3)
      .every((item) => (item as HTMLInputElement).checked),
  ).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(4)
})
