import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AllocationReceiptArchive,
  type ArchivePreflight,
  type ReceiptArchive,
} from './AllocationReceiptArchive'
import type { PaperAccount } from './paper-model'

const account = { id: 'synthetic-archive-account', version: 2 } as PaperAccount
const t = (_zh: string, en: string) => en
const policy = {
  read_only: true,
  import_authorized: false,
  delete_authorized: false,
  execution_source: false,
} as const
const prepareName = 'Prepare complete account archive'
const downloadName = 'Download complete account archive'
const preflightName = 'Preflight archive read-only'
const textareaName = 'Or paste complete archive JSON'
const fileName = 'Choose local archive JSON (up to 32 MiB)'
const archive = (): ReceiptArchive => ({
  engine_version: 'alphaview-allocation-receipt-archive-v1',
  schema_version: 1,
  account_id: account.id,
  account_version: account.version,
  as_of: '2024-01-31',
  input_revision: 'synthetic:1',
  exported_at: '2024-02-01T01:00:00Z',
  checksum: 'a'.repeat(64),
  policy,
  records: [{ id: 'b'.repeat(64), integrity: { available: true, reason: null } }],
  coverage: {
    account_total: 1,
    exported: 1,
    complete_set: true,
    raw_complete: 1,
    integrity_available: 1,
    integrity_unavailable: 0,
  },
})
const preflight = (): ArchivePreflight => ({
  engine_version: 'alphaview-allocation-receipt-archive-v1',
  account_id: account.id,
  account_version: account.version,
  as_of: '2024-01-31',
  input_revision: 'synthetic:1',
  checked_at: '2024-02-01T01:00:00Z',
  verdict: 'compatible',
  compatible: true,
  archive_checksum: 'a'.repeat(64),
  policy,
  reasons: [],
  coverage: { declared: 1, checked: 1, compatible: 1, unavailable: 0 },
  archive_context: {
    account_id: account.id,
    account_version: 1,
    as_of: '2024-01-30',
    input_revision: 'synthetic:0',
    exported_at: '2024-01-30T23:00:00Z',
  },
  snapshot_currentness: { current: false, reasons: ['account_version_changed', 'inputs_changed'] },
  capacity: {
    account_used: 50,
    account_limit: 50,
    global_used: 500,
    global_limit: 500,
    absent_locally: 0,
    account_remaining: 0,
    global_remaining: 0,
    automatic_deletion: false,
    import_authorized: false,
  },
  records: [
    {
      id: 'b'.repeat(64),
      content_fingerprint: 'c'.repeat(64),
      compatible: true,
      reasons: [],
      duplicate: 'identical_locally',
      integrity: { available: true, reason: null },
      archived_currentness: { current: true, reasons: [] },
      currentness: { current: false, reasons: ['workflow_changed'] },
    },
  ],
})
const response = (value: unknown, code = 200, text?: string) => ({
  ok: code === 200,
  status: code,
  text: async () => text ?? JSON.stringify(value),
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('does no work on mount, preserves empty-input protection, and prepares only on explicit click', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(archive()))
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationReceiptArchive account={account} t={t} />)
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: preflightName })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect(await screen.findByText('a'.repeat(64))).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/paper/accounts/${account.id}/allocation-research-receipt-archive`,
  )
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  expect(screen.getByText(/Import and deletion are not authorized/)).toBeTruthy()
})

function downloads() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-archive')
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  const names: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download)
  })
  return { createObjectURL, names }
}
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })

it('downloads exact server text including corruption metadata and unknown fields without another read', async () => {
  const value = { ...archive(), future_value: { missing: null, precise: 1.1234567890123, zero: 0 } }
  value.records[0].integrity = { available: false, reason: 'receipt_evidence_unverifiable' }
  value.coverage.integrity_available = 0
  value.coverage.integrity_unavailable = 1
  const exact = JSON.stringify(value, null, 4) + '\n'
  const fetcher = vi.fn().mockResolvedValue(response(value, 200, exact))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: downloadName }))
  expect(await readBlob(mock.createObjectURL.mock.calls[0][0])).toBe(exact)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(mock.names[0]).toContain('allocation-receipt-archive-synthetic-archive-account-2024-01-31')
  expect(document.querySelector('a[download]')).toBeNull()
})

it('sends the exact pasted JSON text only for explicit read-only preflight and separates stale state from compatibility', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(preflight()))
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationReceiptArchive account={account} t={t} />)
  const draft = '{"synthetic":"draft", "duplicate":1, "duplicate":2}\n'
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: draft } })
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  expect(await screen.findByText('Archive structure compatible')).toBeTruthy()
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: draft,
    headers: { 'Content-Type': 'application/json' },
  })
  expect(
    screen.getByText(/Current account capacity 50 \/ 50 · Current global capacity 500 \/ 500/),
  ).toBeTruthy()
  expect(screen.getByText('Source workflow changed')).toBeTruthy()
  expect(screen.getByText(/preflight is not an import commitment/i)).toBeTruthy()
})

it('renders structural failures and null coverage without turning missing counts into zero', async () => {
  const value = {
    ...preflight(),
    compatible: false,
    verdict: 'blocked',
    reasons: ['archive_json_invalid'],
    coverage: { declared: null, checked: 0, compatible: 0, unavailable: null },
    archive_context: null,
    capacity: null,
    records: [],
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  expect(await screen.findByText('Archive compatibility blocked')).toBeTruthy()
  expect(
    screen.getByText(/Receipts checked 0 \/ — · Compatible receipts 0 · Unavailable receipts —/),
  ).toBeTruthy()
  expect(screen.getByText('Archive is not valid UTF-8 JSON')).toBeTruthy()
})

it.each(['account', 'version', 'source'])(
  'invalidates prepared and checked results on %s change while preserving the draft',
  async (change) => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(response(url.endsWith('/preflight') ? preflight() : archive())),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <AllocationReceiptArchive account={account} t={t} sourceIdentity="source-a" />,
    )
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    await screen.findByText('a'.repeat(64))
    fireEvent.change(screen.getByLabelText(textareaName), {
      target: { value: 'synthetic unsaved draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: preflightName }))
    await screen.findByText('Archive structure compatible')
    view.rerender(
      <AllocationReceiptArchive
        account={
          change === 'account'
            ? { ...account, id: 'synthetic-next' }
            : change === 'version'
              ? { ...account, version: 3 }
              : account
        }
        t={t}
        sourceIdentity={change === 'source' ? 'source-b' : 'source-a'}
      />,
    )
    expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'synthetic unsaved draft')
    expect(screen.queryByText('Archive structure compatible')).toBeNull()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)

it('blocks repeated prepare clicks and discards late responses after account change', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  let signal!: AbortSignal
  const fetcher = vi.fn((_url, options) => {
    signal = options.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<AllocationReceiptArchive account={account} t={t} />)
  const button = screen.getByRole('button', { name: prepareName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  view.rerender(<AllocationReceiptArchive account={{ ...account, id: 'synthetic-next' }} t={t} />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(response(archive())))
  expect(screen.queryByText('a'.repeat(64))).toBeNull()
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('aborts in-flight preflight on draft edit and ignores its late result', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  let signal!: AbortSignal
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options) => {
      signal = options.signal
      return new Promise((resolve) => {
        finish = resolve
      })
    }),
  )
  render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'first draft' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'second draft' } })
  expect(signal.aborted).toBe(true)
  await act(async () => finish(response(preflight())))
  expect(screen.queryByText('Archive structure compatible')).toBeNull()
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'second draft')
})

it.each(['account', 'version', 'policy', 'coverage'])(
  'refuses a prepared %s mismatch before download',
  async (field) => {
    const value = {
      ...archive(),
      ...(field === 'account'
        ? { account_id: 'synthetic-other' }
        : field === 'version'
          ? { account_version: 3 }
          : field === 'policy'
            ? { policy: { ...policy, import_authorized: true } }
            : { coverage: { ...archive().coverage, account_total: 2 } }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<AllocationReceiptArchive account={account} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  },
)

it('loads a selected local file into the draft without fetching or treating raw markup as HTML', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationReceiptArchive account={account} t={t} />)
  const text = '{"synthetic":"<img src=x onerror=alert(1)>"}'
  fireEvent.change(screen.getByLabelText(fileName), {
    target: { files: [new File([text], 'synthetic.json', { type: 'application/json' })] },
  })
  await waitFor(() => expect(screen.getByLabelText(textareaName)).toHaveProperty('value', text))
  expect(screen.getByText('synthetic.json')).toBeTruthy()
  expect(fetcher).not.toHaveBeenCalled()
  expect(document.querySelector('img')).toBeNull()
})

it.each(['oversize', 'invalid_utf8'])(
  'rejects %s upload and preserves the existing draft',
  async (problem) => {
    vi.stubGlobal('fetch', vi.fn())
    render(<AllocationReceiptArchive account={account} t={t} />)
    fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'preserved draft' } })
    const file = new File([new Uint8Array([0xff, 0xfe])], 'synthetic-invalid.json')
    if (problem === 'oversize') Object.defineProperty(file, 'size', { value: 32 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByLabelText(fileName), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain('the draft is preserved')
    expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'preserved draft')
  },
)

it('clears the previous prepared download after a replacement request fails', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(archive()))
    .mockResolvedValueOnce(response({}, 503))
  vi.stubGlobal('fetch', fetcher)
  render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect((await screen.findByRole('alert')).textContent).toBe('Local archive request failed (503)')
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('keeps full allocation failures and exact prepared archive bytes while record filters and pages change', async () => {
  const value = preflight()
  const original = value.records[0]
  value.records = Array.from({ length: 50 }, (_, index) => ({
    ...original,
    id: (index + 1).toString(16).padStart(64, '0'),
    compatible: index < 45,
    reasons: index < 45 ? [] : ['archive_records_incompatible'],
  }))
  value.compatible = false
  value.verdict = 'blocked'
  value.reasons = ['archive_records_incompatible']
  value.coverage = { declared: 50, checked: 50, compatible: 45, unavailable: 5 }
  const exported = { ...archive(), future_value: { missing: null, original: 'preserved' } }
  const raw = JSON.stringify(exported, null, 4) + '\n'
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response(exported, 200, raw))
    .mockResolvedValueOnce(response(value))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  const view = render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  const draft = '{"archive":"verbatim", "duplicate":1, "duplicate":2}\n'
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: draft } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive compatibility blocked')
  fireEvent.change(screen.getByRole('combobox', { name: 'Compatibility filter' }), {
    target: { value: 'compatible' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(view.container.querySelectorAll('[data-archive-record-index]')).toHaveLength(20)
  expect(screen.getByText(/Matched 45 \/ 50 returned records · Showing 26–45/)).toBeTruthy()
  expect(screen.getByText('Archive compatibility blocked')).toBeTruthy()
  expect(screen.getByText('Some receipts are incompatible')).toBeTruthy()
  expect(
    screen.getByText(/Receipts checked 50 \/ 50 · Compatible receipts 45 · Unavailable receipts 5/),
  ).toBeTruthy()
  expect(
    screen.getByText(/Current account capacity 50 \/ 50 · Current global capacity 500 \/ 500/),
  ).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent ID' } })
  expect(screen.getByText(/Matched 0 \/ 50 returned records/)).toBeTruthy()
  expect(screen.getByText('Archive compatibility blocked')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: downloadName }))
  expect(await readBlob(mock.createObjectURL.mock.calls[0][0])).toBe(raw)
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', draft)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][1].body).toBe(draft)
})

it('downloads all accepted preflight metadata and records locally, then removes CSV on draft change', async () => {
  const value = preflight()
  value.verdict = 'blocked'
  value.compatible = false
  value.reasons = ['archive_records_incompatible']
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  render(<AllocationReceiptArchive account={account} t={t} />)
  fireEvent.change(screen.getByRole('textbox', { name: textareaName }), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  const button = await screen.findByRole('button', { name: 'Download all preflight records CSV' })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search receipt ID (optional)' }), {
    target: { value: 'no matches' },
  })
  fireEvent.click(button)
  const csv = await readBlob(mock.createObjectURL.mock.calls[0][0])
  expect(csv).toContain('"/verdict","string","blocked"')
  expect(csv).toContain('"/reasons/0","string","archive_records_incompatible"')
  expect(csv).toContain('"/records/0/id","string","' + value.records[0].id + '"')
  expect(csv).toContain('"/snapshot_currentness/current","boolean","false"')
  expect(csv).toContain('"/capacity/')
  expect(fetcher).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByRole('textbox', { name: textareaName }), {
    target: { value: '{"edited":true}' },
  })
  expect(screen.queryByRole('button', { name: 'Download all preflight records CSV' })).toBeNull()
})
