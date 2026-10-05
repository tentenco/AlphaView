import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  WorkflowPathTrialInventory,
  type PathTrialInventory,
  type InventoryRecord,
} from './WorkflowPathTrialInventory'
const account = 'a'.repeat(32)
const t = (_zh: string, en: string) => en
const loadName = 'Load complete saved trial inventory'
const downloadName = 'Download complete trial inventory JSON'
const record = (id: string): InventoryRecord => ({
  ordinal: 1,
  id,
  account_id: account,
  run_id: 'b'.repeat(32),
  kind: 'path_validation',
  created_at: '2026-10-01T01:00:00Z',
  content_fingerprint: 'c'.repeat(64),
  integrity: { available: true, reason: null },
  category: 'comparable_path',
  diagnostic_status: 'evaluated',
  currentness: { current: true, reasons: [] },
  reasons: [],
  basis_fingerprint: 'd'.repeat(64),
  configuration_fingerprint: 'e'.repeat(64),
  configuration: { settings: { rebalance_sessions: 21 } },
  coverage: { required_path_sessions: 252, valued_path_sessions: 252 },
  identity_cells: {},
})
const inventory = (): PathTrialInventory => {
  const first = record('1'.repeat(64)),
    second = { ...record('2'.repeat(64)), ordinal: 2 }
  const cost: InventoryRecord = {
    ...record('3'.repeat(64)),
    ordinal: 3,
    kind: 'path_costs',
    category: 'cost_receipt',
    basis_fingerprint: null,
    configuration_fingerprint: null,
    configuration: null,
    reasons: ['cost_receipt_not_trial'],
  }
  const bad: InventoryRecord = {
    ...record('4'.repeat(64)),
    ordinal: 4,
    integrity: { available: false, reason: 'receipt_content_changed' },
    category: 'unavailable_path',
    diagnostic_status: null,
    currentness: { current: null, reasons: ['receipt_unverifiable'] },
    reasons: ['receipt_content_changed'],
    basis_fingerprint: null,
    configuration_fingerprint: null,
    configuration: null,
    coverage: null,
  }
  return {
    engine_version: 'alphaview-workflow-path-trial-inventory-v1',
    account_id: account,
    account_version: 1,
    scope: 'saved_receipts_only',
    unrecorded_trials: null,
    full_search_denominator: null,
    full_search_coverage: 'unknown',
    policy: {
      read_only: true,
      saved_receipts_only: true,
      execution_authority: false,
      automatic_cscv_selection: false,
      reconstruction: false,
    },
    coverage: {
      complete_set: true,
      account_receipts: 4,
      returned_receipts: 4,
      path_receipts: 3,
      cost_receipts: 1,
      unknown_kind_receipts: 0,
      verified_receipts: 3,
      unverifiable_receipts: 1,
      basis_available_path_receipts: 2,
      basis_unavailable_path_receipts: 1,
      basis_groups: 1,
      configurations_within_groups: 1,
      duplicate_configuration_groups: 1,
      duplicate_receipts_extra: 1,
    },
    records: [first, second, cost, bad],
    groups: [
      {
        basis_fingerprint: 'd'.repeat(64),
        basis: { facts: { complete_coverage: true } },
        receipt_ids: [first.id!, second.id!],
        receipt_count: 2,
        distinct_configurations: 1,
        duplicate_configuration_groups: 1,
        duplicate_receipts_extra: 1,
        configurations: [
          {
            configuration_fingerprint: 'e'.repeat(64),
            configuration: first.configuration!,
            receipt_ids: [first.id!, second.id!],
            multiplicity: 2,
          },
        ],
      },
    ],
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:4',
    checked_at: '2026-10-01T01:00:00Z',
    inventory_fingerprint: 'f'.repeat(64),
    method: 'Synthetic method',
  }
}
const response = (value: unknown, status = 200, raw?: string) => ({
  ok: status === 200,
  status,
  text: async () => raw ?? JSON.stringify(value),
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const mount = () =>
  render(<WorkflowPathTrialInventory accountId={account} accountVersion={1} t={t} />)
async function load() {
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  await screen.findByText(/All receipts 4 \/ 4/)
}

it('only loads on explicit click and preserves all duplicate identities, cost exclusion and unknown full denominator', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(inventory()))
  vi.stubGlobal('fetch', fetcher)
  mount()
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  await load()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/paper/accounts/${account}/workflow-path-trial-inventory`,
  )
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  expect(screen.getByText(/Saved multiplicity 2/)).toBeTruthy()
  expect(screen.getAllByText('1'.repeat(64)).length).toBeGreaterThan(0)
  expect(screen.getAllByText('2'.repeat(64)).length).toBeGreaterThan(0)
  expect(screen.getByText(/Unrecorded trials \/ full-search denominator —/)).toBeTruthy()
  expect(screen.getByText(/full experiment registry or complete-search PBO/)).toBeTruthy()
  expect(screen.getByText(/Cost receipts are not trial configurations/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /calculate|select.*cscv/i })).toBeNull()
})

it('filtering and empty search retain full coverage, duplicate multiplicity and raw download without additional requests', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(inventory()))
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  await load()
  fireEvent.change(screen.getByRole('combobox', { name: 'Inventory category' }), {
    target: { value: 'comparable_path' },
  })
  expect(screen.getByText(/Matched 2 \/ 4/)).toBeTruthy()
  expect(view.container.querySelectorAll('.trial-inventory-record')).toHaveLength(2)
  expect(screen.getByText(/All receipts 4 \/ 4/)).toBeTruthy()
  expect(screen.getByText(/Path basis unavailable 1/)).toBeTruthy()
  expect(screen.getByText(/Retained additional duplicate receipts 1/)).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matches' } })
  expect(screen.getByText(/Matched 0 \/ 4/)).toBeTruthy()
  expect(screen.getByText(/All receipts 4 \/ 4/)).toBeTruthy()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', false)
  expect(fetcher).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Reset inventory filters' }))
  expect(screen.getByText(/Matched 4 \/ 4/)).toBeTruthy()
})

it('paginates all 50 rows locally and never drops unknown identity rows or their original position', async () => {
  const value = inventory()
  value.groups = []
  value.records = Array.from({ length: 50 }, (_, i) => ({
    ...value.records[3],
    ordinal: i + 1,
    id: i === 49 ? null : i.toString(16).padStart(64, '0'),
  }))
  value.coverage = {
    ...value.coverage,
    account_receipts: 50,
    returned_receipts: 50,
    path_receipts: 50,
    cost_receipts: 0,
    verified_receipts: 0,
    unverifiable_receipts: 50,
    basis_available_path_receipts: 0,
    basis_unavailable_path_receipts: 50,
    basis_groups: 0,
    configurations_within_groups: 0,
    duplicate_configuration_groups: 0,
    duplicate_receipts_extra: 0,
  }
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  await screen.findByText(/All receipts 50 \/ 50/)
  expect(view.container.querySelectorAll('.trial-inventory-record')).toHaveLength(25)
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getByText('Page 2 / 2')).toBeTruthy()
  expect(
    view.container.querySelector('.trial-inventory-record')?.getAttribute('data-inventory-ordinal'),
  ).toBe('26')
  expect(screen.getByText('Receipt identity unknown')).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('downloads full original response bytes independent of active filters with safe filename and Blob cleanup', async () => {
  const value = inventory()
  const raw =
    JSON.stringify(value).slice(0, -1) +
    ',"future":{"whole":1.0,"zero":-0.0,"exp":1e-8,"text":"合成","missing":null}}\n'
  const fetcher = vi.fn().mockResolvedValue(response(value, 200, raw))
  vi.stubGlobal('fetch', fetcher)
  const blobs: Blob[] = []
  const create = vi.fn((blob: Blob) => {
      blobs.push(blob)
      return 'blob:synthetic'
    }),
    revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create
      static revokeObjectURL = revoke
    },
  )
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  mount()
  await load()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matches' } })
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: downloadName }))
  expect(blobs).toHaveLength(1)
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toMatch(
    /^saved-path-trials-[a-z0-9-]+\.json$/,
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(revoke).not.toHaveBeenCalled()
  vi.advanceTimersByTime(10000)
  expect(revoke).toHaveBeenCalledWith('blob:synthetic')
  vi.useRealTimers()
  const bytes = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsText(blobs[0])
  })
  expect(bytes).toBe(raw)
})

it('guards double click and aborts late response after account changes', async () => {
  let resolve!: (value: unknown) => void
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  expect(fetcher).toHaveBeenCalledTimes(1)
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal
  view.rerender(<WorkflowPathTrialInventory accountId={'b'.repeat(32)} accountVersion={1} t={t} />)
  expect(signal.aborted).toBe(true)
  await act(async () => resolve(response(inventory())))
  expect(screen.queryByText(/All receipts 4 \/ 4/)).toBeNull()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('clears prior evidence on disabled lifecycle and does not revive it when reenabled', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(inventory()))
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  await load()
  view.rerender(
    <WorkflowPathTrialInventory accountId={account} accountVersion={1} enabled={false} t={t} />,
  )
  expect(screen.getByRole('button', { name: loadName })).toHaveProperty('disabled', true)
  expect(screen.queryByText(/All receipts 4 \/ 4/)).toBeNull()
  view.rerender(<WorkflowPathTrialInventory accountId={account} accountVersion={1} enabled t={t} />)
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('account version change clears accepted data while unrelated rerenders preserve filters', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(inventory()))
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  await load()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '1'.repeat(12) } })
  view.rerender(<WorkflowPathTrialInventory accountId={account} accountVersion={1} t={t} />)
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '1'.repeat(12))
  view.rerender(<WorkflowPathTrialInventory accountId={account} accountVersion={2} t={t} />)
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['account', 'count', 'group_id', 'multiplicity', 'policy', 'infinite', 'size'])(
  'rejects inconsistent %s evidence without stale download',
  async (caseName) => {
    const good = inventory(),
      bad = inventory()
    let raw: string | undefined
    if (caseName === 'account') bad.account_id = 'b'.repeat(32)
    if (caseName === 'count') bad.coverage.account_receipts = 3
    if (caseName === 'group_id') bad.groups[0].receipt_ids[0] = '9'.repeat(64)
    if (caseName === 'multiplicity') bad.groups[0].configurations[0].multiplicity = 1
    if (caseName === 'policy') Object.assign(bad.policy, { automatic_cscv_selection: true })
    if (caseName === 'infinite') raw = JSON.stringify(bad).slice(0, -1) + ',"untrusted":1e999}'
    if (caseName === 'size') raw = ' '.repeat(3 * 1024 * 1024) + JSON.stringify(bad)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(good))
      .mockResolvedValueOnce(response(bad, 200, raw))
    vi.stubGlobal('fetch', fetcher)
    mount()
    await load()
    fireEvent.click(screen.getByRole('button', { name: loadName }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    expect(screen.queryByText(/All receipts 4 \/ 4/)).toBeNull()
  },
)

it('reports backend refusal as a whole-set failure, not a partial inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(response({ detail: { code: 'inventory_receipt_count_limit' } }, 413)),
  )
  mount()
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  await screen.findByRole('alert')
  expect(screen.getByText(/no partial inventory returned/)).toBeTruthy()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('keeps a complete empty saved set distinct from an unknown full-search denominator', async () => {
  const value = inventory()
  value.records = []
  value.groups = []
  for (const key of Object.keys(value.coverage))
    if (key !== 'complete_set') (value.coverage as unknown as Record<string, unknown>)[key] = 0
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  mount()
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  await screen.findByText(/All receipts 0 \/ 0/)
  expect(screen.getByText(/full-search denominator —/)).toBeTruthy()
  expect(screen.getByText(/Unknown, not zero/)).toBeTruthy()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', false)
})

it('aborts pending inventory on unmount and performs no subsequent actions', async () => {
  let resolve!: (value: unknown) => void
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: loadName }))
  view.unmount()
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  await act(async () => resolve(response(inventory())))
  expect(fetcher).toHaveBeenCalledTimes(1)
})
