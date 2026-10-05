import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ResearchIntegrityArchive,
  type IntegrityArchivePreflight,
  type IntegrityArchive,
} from './ResearchIntegrityArchive'

const symbol = 'SYNTA'
const t = (_zh: string, en: string) => en
const policy = {
  read_only: true,
  import_authorized: false,
  restore_authorized: false,
  delete_authorized: false,
  execution_source: false,
} as const
const prepareName = 'Prepare complete symbol archive'
const downloadName = 'Download complete symbol archive'
const preflightName = 'Preflight archive read-only'
const textareaName = 'Or paste complete archive JSON'
const fileName = 'Choose local archive JSON (up to 32 MiB)'
const archive = (): IntegrityArchive => ({
  engine_version: 'alphaview-research-integrity-archive-v1',
  schema_version: 1,
  symbol,
  as_of: '2024-01-31',
  input_revision: 'synthetic:1',
  exported_at: '2024-02-01T01:00:00Z',
  checksum: 'a'.repeat(64),
  policy,
  records: [{ id: 'b'.repeat(64), integrity: { available: true, reason: null } }],
  coverage: {
    symbol_total: 1,
    exported: 1,
    complete_set: true,
    raw_complete: 1,
    verified: 1,
    unavailable: 0,
  },
})
const preflight = (): IntegrityArchivePreflight => ({
  engine_version: 'alphaview-research-integrity-archive-v1',
  symbol,
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
    symbol,
    as_of: '2024-01-30',
    input_revision: 'synthetic:0',
    exported_at: '2024-01-30T23:00:00Z',
  },
  snapshot_currentness: {
    current: false,
    reasons: ['session_changed', 'workspace_inputs_changed'],
  },
  capacity: {
    workspace_used: 500,
    workspace_limit: 500,
    remaining: 0,
    unknown_identities: 0,
    projected_total: 500,
    absent_locally: 0,
    automatic_deletion: false,
    import_authorized: false,
  },
  records: [
    {
      id: 'b'.repeat(64),
      ordinal: 1,
      diagnostic_status: 'differences_found',
      compatible: true,
      reasons: [],
      duplicate: 'identical_locally',
      integrity: { available: true, reason: null },
      archived_currentness: { current: true, reasons: [] },
      currentness: { current: false, reasons: ['workspace_inputs_changed'] },
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
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: preflightName })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect(await screen.findByText('a'.repeat(64))).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/research-desk/integrity-receipt-archive?symbol=SYNTA')
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  expect(screen.getByText(/Import, restoration and deletion are not authorized/)).toBeTruthy()
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
  value.coverage.verified = 0
  value.coverage.unavailable = 1
  const exact = JSON.stringify(value, null, 4) + '\n'
  const fetcher = vi.fn().mockResolvedValue(response(value, 200, exact))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: downloadName }))
  expect(await readBlob(mock.createObjectURL.mock.calls[0][0])).toBe(exact)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(mock.names[0]).toContain('research-integrity-archive-SYNTA-2024-01-31')
  expect(document.querySelector('a[download]')).toBeNull()
})

it('sends the exact pasted JSON text only for explicit read-only preflight and separates stale state from compatibility', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(preflight()))
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
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
  expect(screen.getByText(/Workspace capacity 500 \/ 500/)).toBeTruthy()
  expect(screen.getAllByText('Workspace input revision changed').length).toBeGreaterThan(0)
  expect(screen.getByText(/Original diagnostic result · Sampled differences found/)).toBeTruthy()
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
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  expect(await screen.findByText('Archive compatibility blocked')).toBeTruthy()
  expect(
    screen.getByText(/Receipts checked 0 \/ — · Compatible receipts 0 · Unavailable receipts —/),
  ).toBeTruthy()
  expect(screen.getByText('Archive is not valid UTF-8 JSON')).toBeTruthy()
})

it.each(['symbol', 'enabled', 'source'])(
  'invalidates prepared and checked results on %s change while preserving the draft',
  async (change) => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(response(url.includes('/preflight?') ? preflight() : archive())),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <ResearchIntegrityArchive symbol={symbol} t={t} contextIdentity="source-a" />,
    )
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    await screen.findByText('a'.repeat(64))
    fireEvent.change(screen.getByLabelText(textareaName), {
      target: { value: 'synthetic unsaved draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: preflightName }))
    await screen.findByText('Archive structure compatible')
    view.rerender(
      <ResearchIntegrityArchive
        symbol={change === 'symbol' ? 'SYNTB' : symbol}
        enabled={change !== 'enabled'}
        t={t}
        contextIdentity={change === 'source' ? 'source-b' : 'source-a'}
      />,
    )
    expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'synthetic unsaved draft')
    expect(screen.queryByText('Archive structure compatible')).toBeNull()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)

it('blocks repeated prepare clicks and discards late responses after symbol change', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  let signal!: AbortSignal
  const fetcher = vi.fn((_url, options) => {
    signal = options.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  const button = screen.getByRole('button', { name: prepareName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  view.rerender(<ResearchIntegrityArchive symbol="SYNTB" t={t} />)
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
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'first draft' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'second draft' } })
  expect(signal.aborted).toBe(true)
  await act(async () => finish(response(preflight())))
  expect(screen.queryByText('Archive structure compatible')).toBeNull()
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'second draft')
})

it.each(['symbol', 'version', 'policy', 'coverage'])(
  'refuses a prepared %s mismatch before download',
  async (field) => {
    const value = {
      ...archive(),
      ...(field === 'symbol'
        ? { symbol: 'SYNTB' }
        : field === 'version'
          ? { schema_version: 3 }
          : field === 'policy'
            ? { policy: { ...policy, import_authorized: true } }
            : { coverage: { ...archive().coverage, symbol_total: 2 } }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  },
)

it('loads a selected local file into the draft without fetching or treating raw markup as HTML', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
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
    render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
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
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect((await screen.findByRole('alert')).textContent).toBe('Local archive request failed (503)')
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('prevents repeated preflight submissions and clears a completed report immediately on draft change', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  const fetcher = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'draft' } })
  const button = screen.getByRole('button', { name: preflightName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => finish(response(preflight())))
  expect(await screen.findByText('Archive structure compatible')).toBeTruthy()
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'edited draft' } })
  expect(screen.queryByText('Archive structure compatible')).toBeNull()
})

it.each(['coverage', 'record', 'currentness', 'policy'])(
  'rejects unsafe nested %s preflight responses visibly',
  async (field) => {
    const value = {
      ...preflight(),
      ...(field === 'coverage'
        ? { coverage: null }
        : field === 'record'
          ? { records: [null] }
          : field === 'currentness'
            ? { snapshot_currentness: null }
            : { policy: { ...policy, restore_authorized: true } }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
    fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: preflightName }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('Archive structure compatible')).toBeNull()
  },
)

it('clears a checked report on rejected file input while preserving its editable draft', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(preflight())))
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: 'preserved draft' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive structure compatible')
  const file = new File(['bad'], 'synthetic-large.json')
  Object.defineProperty(file, 'size', { value: 32 * 1024 * 1024 + 1 })
  fireEvent.change(screen.getByLabelText(fileName), { target: { files: [file] } })
  expect(screen.queryByText('Archive structure compatible')).toBeNull()
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', 'preserved draft')
  expect(screen.getByRole('alert')).toBeTruthy()
})

it('retains an unavailable original diagnostic without presenting it as success', async () => {
  const value = preflight()
  value.records[0].diagnostic_status = 'unavailable'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive structure compatible')
  expect(screen.getByText(/Original diagnostic result · Diagnostic unavailable/)).toBeTruthy()
  expect(
    screen.queryByText(/Original diagnostic result · No sampled difference detected/),
  ).toBeNull()
})

it('pages 500 records while keeping the blocked full verdict and capacity visible under Compatible filtering', async () => {
  const value = preflight()
  const original = value.records[0]
  value.records = Array.from({ length: 500 }, (_, index) => ({
    ...original,
    id: index === 499 ? null : (index + 1).toString(16).padStart(64, '0'),
    ordinal: index + 1,
    compatible: index !== 499,
    reasons: index === 499 ? ['archive_receipt_unverifiable'] : [],
    integrity: { available: index !== 499, reason: index === 499 ? 'receipt_unverifiable' : null },
  }))
  value.compatible = false
  value.verdict = 'blocked'
  value.reasons = ['archive_records_incompatible']
  value.coverage = { declared: 500, checked: 500, compatible: 499, unavailable: 1 }
  value.capacity!.unknown_identities = 1
  value.capacity!.projected_total = null
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
  const draft = '{"original":1,"original":2}\n'
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: draft } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive compatibility blocked')
  expect(view.container.querySelectorAll('[data-archive-record-index]')).toHaveLength(25)
  expect(screen.getByText('Page 1 / 20')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Compatibility filter' }), {
    target: { value: 'compatible' },
  })
  expect(screen.getByText(/Matched 499 \/ 500 returned records/)).toBeTruthy()
  expect(screen.getByText('Archive compatibility blocked')).toBeTruthy()
  expect(screen.getByText('Some receipts are incompatible')).toBeTruthy()
  expect(
    screen.getByText(
      /Receipts checked 500 \/ 500 · Compatible receipts 499 · Unavailable receipts 1/,
    ),
  ).toBeTruthy()
  expect(screen.getByText(/Workspace capacity 500 \/ 500/)).toBeTruthy()
  expect(screen.getByText(/Unknown identities 1/)).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unavailable' } })
  expect(view.container.querySelectorAll('[data-archive-record-index]')).toHaveLength(1)
  expect(screen.getByText('Unknown identity')).toBeTruthy()
  expect(
    view.container
      .querySelector('[data-archive-record-index]')
      ?.getAttribute('data-archive-record-index'),
  ).toBe('499')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-present' } })
  expect(screen.getByText(/Matched 0 \/ 500 returned records/)).toBeTruthy()
  expect(screen.getByText('Archive compatibility blocked')).toBeTruthy()
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', draft)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].body).toBe(draft)
})

it('downloads all accepted preflight metadata and records locally, then removes CSV on draft change', async () => {
  const value = preflight()
  value.verdict = 'blocked'
  value.compatible = false
  value.reasons = ['archive_records_incompatible']
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  render(<ResearchIntegrityArchive symbol={symbol} t={t} />)
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
