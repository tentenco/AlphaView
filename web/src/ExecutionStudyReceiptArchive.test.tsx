import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ExecutionStudyReceiptArchive,
  type ExecutionStudyArchivePreflight,
  type ExecutionStudyArchive,
} from './ExecutionStudyReceiptArchive'

const accountId = 'a'.repeat(32)
const accountVersion = 2
const t = (_zh: string, en: string) => en
const policy = {
  read_only: true,
  import_authorized: false,
  restore_authorized: false,
  delete_authorized: false,
  execution_source: false,
} as const
const prepareName = 'Prepare complete execution study receipt archive'
const downloadName = 'Download complete execution study receipt archive'
const preflightName = 'Preflight archive read-only'
const textareaName = 'Or paste complete archive JSON'
const fileName = 'Choose local archive JSON (up to 32 MiB)'
const archive = (): ExecutionStudyArchive => ({
  engine_version: 'alphaview-execution-study-receipt-archive-v1',
  schema_version: 1,
  account_id: accountId,
  account_version: accountVersion,
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
    verified: 1,
    unavailable: 0,
  },
})
const preflight = (): ExecutionStudyArchivePreflight => ({
  engine_version: 'alphaview-execution-study-receipt-archive-v1',
  account_id: accountId,
  account_version: accountVersion,
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
    account_id: accountId,
    account_version: accountVersion,
    as_of: '2024-01-30',
    input_revision: 'synthetic:0',
    exported_at: '2024-01-30T23:00:00Z',
  },
  snapshot_currentness: {
    current: false,
    reasons: ['session_changed', 'workspace_inputs_changed'],
  },
  capacity: {
    account_used: 50,
    account_limit: 50,
    global_used: 250,
    global_limit: 250,
    account_remaining: 0,
    global_remaining: 0,
    unknown_identities: 0,
    projected_account_total: 50,
    projected_global_total: 250,
    absent_locally: 0,
    automatic_deletion: false,
    import_authorized: false,
  },
  records: [
    {
      id: 'b'.repeat(64),
      ordinal: 1,
      diagnostic_status: 'incomplete',
      kind: 'limit_day',
      proposal_id: 'synthetic-workflow',
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: preflightName })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect(await screen.findByText('a'.repeat(64))).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/paper/accounts/${accountId}/execution-study-receipt-archive`,
  )
  expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  expect(
    screen.getByText(/Preview import is not implemented; no restoration, deletion or study rerun/),
  ).toBeTruthy()
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await screen.findByText('a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: downloadName }))
  expect(await readBlob(mock.createObjectURL.mock.calls[0][0])).toBe(exact)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(mock.names[0]).toContain(`execution-study-receipt-archive-${accountId}-2024-01-31`)
  expect(document.querySelector('a[download]')).toBeNull()
})

it('sends the exact pasted JSON text only for explicit read-only preflight and separates stale state from compatibility', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(preflight()))
  vi.stubGlobal('fetch', fetcher)
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
  expect(screen.getByText(/Account capacity 50 \/ 50 · Global capacity 250 \/ 250/)).toBeTruthy()
  expect(screen.getAllByText('Workspace input revision changed').length).toBeGreaterThan(0)
  expect(screen.getByText(/Original research status · Some scenarios unavailable/)).toBeTruthy()
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  expect(await screen.findByText('Archive compatibility blocked')).toBeTruthy()
  expect(
    screen.getByText(/Receipts checked 0 \/ — · Compatible receipts 0 · Unavailable receipts —/),
  ).toBeTruthy()
  expect(screen.getByText('Archive is not valid UTF-8 JSON')).toBeTruthy()
})

it.each(['account', 'version'])(
  'invalidates prepared and checked results on %s change while preserving the draft',
  async (change) => {
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(response(url.endsWith('/preflight') ? preflight() : archive())),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    await screen.findByText('a'.repeat(64))
    fireEvent.change(screen.getByLabelText(textareaName), {
      target: { value: 'synthetic unsaved draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: preflightName }))
    await screen.findByText('Archive structure compatible')
    view.rerender(
      <ExecutionStudyReceiptArchive
        accountId={change === 'account' ? 'b'.repeat(32) : accountId}
        accountVersion={change === 'version' ? 3 : accountVersion}
        t={t}
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
  const view = render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  const button = screen.getByRole('button', { name: prepareName })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetcher).toHaveBeenCalledTimes(1)
  view.rerender(
    <ExecutionStudyReceiptArchive
      accountId={'b'.repeat(32)}
      accountVersion={accountVersion}
      t={t}
    />,
  )
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
        ? { account_id: 'b'.repeat(32) }
        : field === 'version'
          ? { schema_version: 3 }
          : field === 'policy'
            ? { policy: { ...policy, import_authorized: true } }
            : { coverage: { ...archive().coverage, account_total: 2 } }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    render(
      <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: prepareName }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  },
)

it('loads a selected local file into the draft without fetching or treating raw markup as HTML', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
    render(
      <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
    )
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
    render(
      <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
    )
    fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: preflightName }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('Archive structure compatible')).toBeNull()
  },
)

it('clears a checked report on rejected file input while preserving its editable draft', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(preflight())))
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive structure compatible')
  expect(screen.getByText(/Original research status · Research unavailable/)).toBeTruthy()
  expect(screen.queryByText(/Original research status · Evaluated/)).toBeNull()
})

it('shows account and global projected occupancy without inventing counts for unknown identities', async () => {
  const value = preflight()
  value.compatible = false
  value.verdict = 'blocked'
  value.reasons = ['archive_records_incompatible']
  value.capacity!.unknown_identities = 1
  value.capacity!.projected_account_total = null
  value.capacity!.projected_global_total = null
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive compatibility blocked')
  expect(
    screen.getByText(/Projected account \/ global count including absent records — \/ —/),
  ).toBeTruthy()
})

it('explains whole-set count overflow without leaving a partial downloadable archive', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(response({ detail: { code: 'study_archive_count_limit' } }, 413)),
  )
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    '50-per-account or 250-global limit',
  )
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
})

it('filters record compatibility without hiding full execution-study archive failures or rewriting original research status', async () => {
  const value = preflight()
  const original = value.records[0]
  value.records = Array.from({ length: 50 }, (_, index) => ({
    ...original,
    id: (index + 1).toString(16).padStart(64, '0'),
    ordinal: index + 1,
    compatible: index % 2 === 0,
    reasons: index % 2 ? ['archive_receipt_unverifiable'] : [],
    diagnostic_status: index === 0 ? 'unavailable' : original.diagnostic_status,
  }))
  value.compatible = false
  value.verdict = 'blocked'
  value.reasons = ['archive_records_incompatible']
  value.coverage = { declared: 50, checked: 50, compatible: 25, unavailable: 25 }
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const view = render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  const draft = '{"path":"unchanged original text"}\n'
  fireEvent.change(screen.getByLabelText(textareaName), { target: { value: draft } })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive compatibility blocked')
  expect(screen.getByText('Page 1 / 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(
    view.container
      .querySelector('[data-archive-record-index]')
      ?.getAttribute('data-archive-record-index'),
  ).toBe('25')
  fireEvent.change(screen.getByRole('combobox', { name: 'Compatibility filter' }), {
    target: { value: 'compatible' },
  })
  expect(screen.getByText('Page 1 / 1')).toBeTruthy()
  expect(screen.getByText(/Matched 25 \/ 50 returned records/)).toBeTruthy()
  expect(screen.getByText('Archive compatibility blocked')).toBeTruthy()
  expect(screen.getByText('Some receipts are incompatible')).toBeTruthy()
  expect(
    screen.getByText(
      /Receipts checked 50 \/ 50 · Compatible receipts 25 · Unavailable receipts 25/,
    ),
  ).toBeTruthy()
  expect(screen.getByText(/Account capacity 50 \/ 50 · Global capacity 250 \/ 250/)).toBeTruthy()
  expect(screen.getByText(/Original research status · Research unavailable/)).toBeTruthy()
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', draft)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].body).toBe(draft)
})

it('invalidates prepared evidence during disabled lifecycle without reviving it and preserves unsent draft', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(archive()))
  vi.stubGlobal('fetch', fetcher)
  const view = render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.change(screen.getByLabelText(textareaName), {
    target: { value: '{"synthetic":"draft"}' },
  })
  fireEvent.click(screen.getByRole('button', { name: prepareName }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', false),
  )
  view.rerender(
    <ExecutionStudyReceiptArchive
      accountId={accountId}
      accountVersion={accountVersion}
      enabled={false}
      t={t}
    />,
  )
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: preflightName })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: prepareName })).toHaveProperty('disabled', true)
  view.rerender(
    <ExecutionStudyReceiptArchive
      accountId={accountId}
      accountVersion={accountVersion}
      enabled
      t={t}
    />,
  )
  expect(screen.getByRole('button', { name: downloadName })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText(textareaName)).toHaveProperty('value', '{"synthetic":"draft"}')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('shows all three saved study kinds and preserves each original diagnostic and proposal identity', async () => {
  const value = preflight()
  value.records = ['volume_day', 'limit_day', 'open_gtd'].map((kind, index) => ({
    ...value.records[0],
    kind,
    id: String(index + 1).repeat(64),
    proposal_id: String(index + 1).repeat(32),
    ordinal: index + 1,
    diagnostic_status: ['complete', 'incomplete', 'unavailable'][index],
  }))
  value.coverage = { declared: 3, checked: 3, compatible: 3, unavailable: 0 }
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
  fireEvent.change(screen.getByLabelText(textareaName), {
    target: { value: '{"synthetic":"archive"}' },
  })
  fireEvent.click(screen.getByRole('button', { name: preflightName }))
  await screen.findByText('Archive structure compatible')
  for (const label of [
    'Volume DAY study',
    'Open-only limit DAY study',
    'Multi-session open-only GTD study',
  ])
    expect(screen.getByText(new RegExp(label))).toBeTruthy()
  expect(screen.getByText(/Original research status · Research unavailable/)).toBeTruthy()
  expect(screen.getByText(/Original research status · Original coverage complete/)).toBeTruthy()
  expect(screen.getByText('3'.repeat(32))).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('downloads all accepted preflight metadata and records locally, then removes CSV on draft change', async () => {
  const value = preflight()
  value.verdict = 'blocked'
  value.compatible = false
  value.reasons = ['archive_records_incompatible']
  const fetcher = vi.fn().mockResolvedValue(response(value))
  vi.stubGlobal('fetch', fetcher)
  const mock = downloads()
  render(
    <ExecutionStudyReceiptArchive accountId={accountId} accountVersion={accountVersion} t={t} />,
  )
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
