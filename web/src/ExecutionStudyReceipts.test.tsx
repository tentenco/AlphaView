import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionStudyReceipts, type ExecutionStudyKind } from './ExecutionStudyReceipts'

const cryptoModule: string = 'node:crypto'
const { createHash, webcrypto } = (await import(cryptoModule)) as {
  createHash: (name: string) => { update: (raw: string) => { digest: (kind: 'hex') => string } }
  webcrypto: Crypto
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
const accountId = 'a'.repeat(32)
const proposalId = 'b'.repeat(32)
const base = `/api/paper/accounts/${accountId}/proposals/${proposalId}/study-receipts`
const t = (_zh: string, en: string) => en
const engines = {
  volume_day: 'alphaview-execution-volume-study-v1',
  limit_day: 'alphaview-execution-limit-study-v1',
  open_gtd: 'alphaview-execution-gtd-study-v1',
}
function fixture(kind: ExecutionStudyKind = 'volume_day') {
  const request = {
    expected_account_version: 1,
    expected_input_revision: 'synthetic:2',
    expected_as_of: '2026-10-01',
    expected_proposal_fingerprint: 'c'.repeat(64),
    participation_pct: 10,
    ...(kind !== 'volume_day' ? { limits: [{ symbol: 'SYNA', limit_price: 100 }] } : {}),
    ...(kind === 'open_gtd' ? { gtd_date: '2026-10-02' } : {}),
  }
  const value = {
    engine_version: engines[kind],
    account_id: accountId,
    account_version: 1,
    input_revision: request.expected_input_revision,
    as_of: request.expected_as_of,
    mode: 'advisory_ex_post',
    status: 'unavailable',
    request,
    source: {
      id: proposalId,
      account_id: accountId,
      proposal_fingerprint: request.expected_proposal_fingerprint,
      current: false,
    },
    coverage: { required: 2, available: 1, unavailable: 1 },
    orders: [
      {
        symbol: 'SYNA',
        scenario_shares: 1,
        expired_shares: null,
        reason: 'execution_session_not_completed',
      },
    ],
    synthetic_future: {
      whole: 1,
      negativeZero: 0,
      exponent: 1e-9,
      unicode: '合成é',
      missing: null,
    },
  }
  const raw = JSON.stringify(value)
    .replace('"whole":1,', '"whole":1.0,')
    .replace('"negativeZero":0,', '"negativeZero":-0.0,')
    .replace('"exponent":1e-9,', '"exponent":1e-09,')
  const evidence = JSON.parse(raw)
  const meta = {
    engine_version: 'alphaview-execution-study-receipt-v1',
    receipt_id: 'd'.repeat(64),
    kind,
    created_at: '2026-10-01T22:00:00+00:00',
    request,
    account_context: { account_id: accountId, version: 1 },
    source_context: {
      raw_evidence_sha256: hash(raw),
      proposal_fingerprint: request.expected_proposal_fingerprint,
    },
    policy: { advisory_only: true, execution_source: false, gating_authority: false },
    method: 'Synthetic research only',
  }
  const completeRaw = '{"evidence":' + raw + ',' + JSON.stringify(meta).slice(1)
  const item = {
    id: meta.receipt_id,
    account_id: accountId,
    proposal_id: proposalId,
    kind,
    created_at: meta.created_at,
    engine_version: meta.engine_version,
    content_fingerprint: hash(completeRaw),
    raw_evidence_sha256: hash(raw),
    integrity: { available: true, reason: null },
    currentness: { current: true, reasons: [] as string[] },
    as_of: evidence.as_of,
    status: evidence.status,
    coverage: evidence.coverage,
    source_proposal_current: false,
    receipt: { ...meta, evidence },
    replayed: false,
  }
  const props = {
    kind,
    accountId,
    proposalId,
    accountVersion: 1,
    request,
    evidence,
    rawEvidence: raw,
    enabled: true,
    t,
  }
  return { props, raw, completeRaw, item }
}
const json = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify(value, (_key, cell) =>
      Object.is(cell, -0) ? '__SYNTHETIC_NEGATIVE_ZERO__' : cell,
    ).replaceAll('"__SYNTHETIC_NEGATIVE_ZERO__"', '-0.0'),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
function history(item: ReturnType<typeof fixture>['item'], offset = 0, total = 1) {
  return {
    account_id: accountId,
    proposal_id: proposalId,
    kind: item.kind,
    items: [item],
    pagination: { limit: 20, offset, total, returned: 1 },
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:2',
  }
}
function historyRows(count = 27, kind: ExecutionStudyKind = 'volume_day') {
  const f = fixture(kind)
  return Array.from({ length: count }, (_, index) => {
    const unavailable = [5, 17, 24].includes(index)
    const unknown = unavailable || [9, 25].includes(index)
    return {
      ...f.item,
      id: index === 0 ? f.item.id : 'a'.repeat(60) + index.toString(16).padStart(4, '0'),
      receipt: null,
      integrity: {
        available: !unavailable,
        reason: unavailable ? 'synthetic_integrity_unavailable' : null,
      },
      raw_evidence_sha256: unavailable ? null : f.item.raw_evidence_sha256,
      currentness: {
        current: unknown ? null : index % 2 === 0,
        reasons: unknown ? ['synthetic_source_unknown'] : [],
      },
    }
  })
}
function historyBatch(items: ReturnType<typeof historyRows>, offset = 0, total = items.length) {
  const page = items.slice(offset, offset + 20)
  return {
    ...history(fixture(items[0]?.kind).item),
    kind: items[0]?.kind ?? 'volume_day',
    items: page,
    pagination: { limit: 20, offset, total, returned: page.length },
  }
}
const filteredList = () => screen.getByRole('list', { name: 'Filtered study receipts' })
const integrityFilter = () => screen.getByRole('combobox', { name: 'Receipt integrity filter' })
const search = () => screen.getByRole('searchbox', { name: 'Search receipt ID' })
const saveButton = () => screen.getByRole('button', { name: 'Save study receipt' })
const loadButton = () => screen.getByRole('button', { name: 'Load study receipts' })
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
let clicked: string[]
let blobs: Blob[]
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  clicked = []
  blobs = []
  vi.stubGlobal('fetch', vi.fn())
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return `blob:synthetic-${blobs.length}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function readBlob(blob: Blob) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

describe('ExecutionStudyReceipts', () => {
  it('does not fetch on mount and supports history without current evidence', () => {
    const f = fixture()
    render(
      <ExecutionStudyReceipts {...f.props} evidence={null} rawEvidence={null} enabled={false} />,
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(saveButton()).toHaveProperty('disabled', true)
    expect(loadButton()).toHaveProperty('disabled', false)
    expect(screen.getByText(/This is not a fill/)).not.toBeNull()
  })

  it.each(['volume_day', 'limit_day', 'open_gtd'] as const)(
    'saves exact raw hash for %s and guards rapid clicks',
    async (kind) => {
      const f = fixture(kind)
      vi.mocked(fetch).mockResolvedValue(json(f.item, 201))
      render(<ExecutionStudyReceipts {...f.props} />)
      const button = saveButton()
      fireEvent.click(button)
      fireEvent.click(button)
      await screen.findByText('Research receipt saved')
      expect(fetch).toHaveBeenCalledTimes(1)
      const [path, options] = vi.mocked(fetch).mock.calls[0]
      expect(path).toBe(base)
      expect(JSON.parse(String(options?.body))).toEqual({
        kind,
        request: f.props.request,
        expected_evidence_engine_version: engines[kind],
        expected_raw_evidence_sha256: hash(f.raw),
      })
      expect(screen.getByText('Original study JSON fingerprint')).not.toBeNull()
      expect(screen.getByText(f.item.raw_evidence_sha256)).not.toBeNull()
      expect(screen.getByText(f.item.content_fingerprint)).not.toBeNull()
      expect(screen.getByText(/Historical proposal/)).not.toBeNull()
    },
  )

  it.each([true, false])(
    'downloads exact original/full bytes without any extra POST: original=%s',
    async (original) => {
      const f = fixture()
      const content = original ? f.raw : f.completeRaw
      vi.mocked(fetch)
        .mockResolvedValueOnce(json(f.item, 201))
        .mockResolvedValueOnce(
          new Response(content, {
            headers: {
              ETag: `"${hash(content)}"`,
              'X-Receipt-Fingerprint': f.item.content_fingerprint,
            },
          }),
        )
      const view = render(<ExecutionStudyReceipts {...f.props} />)
      fireEvent.click(saveButton())
      await screen.findByText('Research receipt saved')
      fireEvent.click(
        screen.getByRole('button', {
          name: original ? 'Download original study JSON' : 'Download complete receipt JSON',
        }),
      )
      await waitFor(() => expect(blobs).toHaveLength(1))
      expect(await readBlob(blobs[0])).toBe(content)
      expect(clicked[0]).toMatch(/^alphaview-study-volume_day-[a-f0-9-]+-(evidence|receipt)\.json$/)
      expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(
        1,
      )
      expect(vi.mocked(fetch).mock.calls[1][0]).toContain(
        original ? '/evidence.json?' : '/receipt.json?',
      )
      view.unmount()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-1')
    },
  )

  it('keeps stale historical originals downloadable and labels unknowns without zero substitution', async () => {
    const f = fixture()
    f.item.currentness = { current: false, reasons: ['inputs_changed'] }
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(history(f.item)))
      .mockResolvedValueOnce(json(f.item))
    render(
      <ExecutionStudyReceipts {...f.props} evidence={null} rawEvidence={null} enabled={false} />,
    )
    fireEvent.click(loadButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Review study receipt' }))
    await screen.findByText('Study as saved')
    expect(screen.getAllByText(/Historical study sources changed/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Download original study JSON' })).toHaveProperty(
      'disabled',
      false,
    )
    expect(screen.getByText(/"expired_shares": null/)).not.toBeNull()
    expect(screen.getByText(/execution_session_not_completed/)).not.toBeNull()
  })

  it('shows empty history and has no selected download', async () => {
    const f = fixture()
    vi.mocked(fetch).mockResolvedValue(
      json({
        ...history(f.item),
        items: [],
        pagination: { limit: 20, offset: 0, total: 0, returned: 0 },
      }),
    )
    render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    await screen.findByText('This proposal has no receipts of this study kind')
    expect(screen.queryByRole('button', { name: /Download original/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
  })

  it('keeps a 409 visible without success or download', async () => {
    const f = fixture()
    vi.mocked(fetch).mockResolvedValue(json({ detail: { code: 'receipt_context_changed' } }, 409))
    render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(saveButton())
    expect((await screen.findByRole('alert')).textContent).toContain('receipt_context_changed')
    expect(screen.queryByText('Research receipt saved')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download original/ })).toBeNull()
  })

  it('rejects accepted/raw mismatch and missing/nonfinite evidence before any request', () => {
    const f = fixture()
    const view = render(
      <ExecutionStudyReceipts {...f.props} rawEvidence={f.raw.replace('1.0,', '2.0,')} />,
    )
    expect(saveButton()).toHaveProperty('disabled', true)
    view.rerender(
      <ExecutionStudyReceipts {...f.props} evidence={{ ...f.props.evidence, invalid: Infinity }} />,
    )
    expect(saveButton()).toHaveProperty('disabled', true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['account', 'proposal', 'draft', 'enabled', 'revision'] as const)(
    'aborts late save on %s change and does not revive old result',
    async (change) => {
      const f = fixture()
      let resolve!: (response: Response) => void
      vi.mocked(fetch).mockReturnValue(
        new Promise((done) => {
          resolve = done
        }),
      )
      const view = render(<ExecutionStudyReceipts {...f.props} />)
      fireEvent.click(saveButton())
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
      const next = { ...f.props }
      if (change === 'account') next.accountId = 'e'.repeat(32)
      if (change === 'proposal') next.proposalId = 'e'.repeat(32)
      if (change === 'draft') next.request = { ...next.request, participation_pct: 11 }
      if (change === 'enabled') next.enabled = false
      if (change === 'revision')
        next.request = { ...next.request, expected_input_revision: 'synthetic:3' }
      view.rerender(<ExecutionStudyReceipts {...next} />)
      expect(signal?.aborted).toBe(true)
      await act(async () => {
        resolve(json(f.item, 201))
      })
      view.rerender(<ExecutionStudyReceipts {...f.props} />)
      expect(screen.queryByText('Research receipt saved')).toBeNull()
      expect(screen.queryByRole('button', { name: /Download original/ })).toBeNull()
    },
  )

  it('aborts on pagehide and ignores late completion after unmount', async () => {
    const f = fixture()
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const view = render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    fireEvent(window, new Event('pagehide'))
    expect(signal?.aborted).toBe(true)
    view.unmount()
    await act(async () => {
      resolve(json(history(f.item)))
    })
    expect(blobs).toHaveLength(0)
  })

  it('does not expose corrupt receipt details or a download', async () => {
    const f = fixture()
    const broken = {
      ...f.item,
      receipt: null,
      integrity: { available: false, reason: 'receipt_content_changed' },
      raw_evidence_sha256: null,
    }
    vi.mocked(fetch).mockResolvedValue(json({ ...history(f.item), items: [broken] }))
    render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    expect(await screen.findByRole('button', { name: 'Review study receipt' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByText('receipt_content_changed')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Download original/ })).toBeNull()
  })

  it.each(['identity', 'bytes', 'header'] as const)(
    'rejects wrong download %s and never makes a Blob',
    async (change) => {
      const f = fixture()
      const raw = change === 'bytes' ? f.raw.replace('1.0,', '2.0,') : f.raw
      const item = change === 'identity' ? { ...f.item, account_id: 'e'.repeat(32) } : f.item
      vi.mocked(fetch)
        .mockResolvedValueOnce(json(item, 201))
        .mockResolvedValueOnce(
          new Response(raw, {
            headers: {
              ETag: change === 'header' ? '"bad"' : `"${hash(raw)}"`,
              'X-Receipt-Fingerprint': f.item.content_fingerprint,
            },
          }),
        )
      render(<ExecutionStudyReceipts {...f.props} />)
      fireEvent.click(saveButton())
      if (change !== 'identity') {
        await screen.findByText('Research receipt saved')
        fireEvent.click(screen.getByRole('button', { name: 'Download original study JSON' }))
      }
      expect(await screen.findByRole('alert')).not.toBeNull()
      expect(blobs).toHaveLength(0)
    },
  )

  it('loads bounded full history only on explicit load, then browses ten local rows without extra requests', async () => {
    const f = fixture()
    const rows = historyRows()
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(historyBatch(rows)))
      .mockResolvedValueOnce(json(historyBatch(rows, 20)))
    render(<ExecutionStudyReceipts {...f.props} />)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(loadButton())
    await screen.findByRole('list', { name: 'Filtered study receipts' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(base + '?kind=volume_day&limit=20&offset=0')
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(base + '?kind=volume_day&limit=20&offset=20')
    expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(10)
    expect(
      screen.getByText('Matching filters: 27 / 27 · Showing 1–10 · At most 10 per page'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(10)
    expect(within(filteredList()).getByText(rows[10].id)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(7)
    expect(
      screen.getByText('Matching filters: 27 / 27 · Showing 21–27 · At most 10 per page'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', false)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([0, 50])(
    'loads the complete %i-receipt retention boundary without extra requests',
    async (count) => {
      const rows = historyRows(count)
      vi.mocked(fetch).mockImplementation(async (url) => {
        const offset = Number(new URL(String(url), 'http://localhost').searchParams.get('offset'))
        return json(historyBatch(rows, offset))
      })
      render(<ExecutionStudyReceipts {...fixture().props} />)
      fireEvent.click(loadButton())
      const totals = await screen.findByLabelText('Full study history totals')
      expect(within(totals).getByText('Full history count').nextElementSibling?.textContent).toBe(
        String(count),
      )
      expect(fetch).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 20)))
      if (count === 0) {
        expect(screen.getByText('This proposal has no receipts of this study kind')).toBeTruthy()
        expect(
          screen.getByText('Matching filters: 0 / 0 · Showing 0–0 · At most 10 per page'),
        ).toBeTruthy()
        expect(within(filteredList()).queryAllByRole('listitem')).toHaveLength(0)
      } else {
        expect(vi.mocked(fetch).mock.calls[2][0]).toBe(base + '?kind=volume_day&limit=20&offset=40')
        for (let page = 0; page < 4; page++)
          fireEvent.click(screen.getByRole('button', { name: 'Next' }))
        expect(
          screen.getByText('Matching filters: 50 / 50 · Showing 41–50 · At most 10 per page'),
        ).toBeTruthy()
        expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(10)
        expect(within(filteredList()).getByText(rows[49].id)).toBeTruthy()
        expect(fetch).toHaveBeenCalledTimes(3)
      }
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
    },
  )

  it('keeps full totals and unknown currentness visible through keyboard filters and case-insensitive ID search', async () => {
    const f = fixture(),
      rows = historyRows()
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(historyBatch(rows)))
      .mockResolvedValueOnce(json(historyBatch(rows, 20)))
    render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    const totals = await screen.findByLabelText('Full study history totals')
    const originalTotals = totals.textContent
    expect(within(totals).getByText('Full history count').nextElementSibling?.textContent).toBe(
      '27',
    )
    expect(within(totals).getByText('Verified receipts').nextElementSibling?.textContent).toBe('24')
    expect(within(totals).getByText('Integrity unavailable').nextElementSibling?.textContent).toBe(
      '3',
    )
    expect(
      within(totals).getByText('Unknown currentness (full history)').nextElementSibling
        ?.textContent,
    ).toBe('5')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.selectOptions(integrityFilter(), 'unavailable')
    expect(
      screen.getByText('Matching filters: 3 / 27 · Showing 1–3 · At most 10 per page'),
    ).toBeTruthy()
    expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(3)
    expect(
      within(filteredList())
        .getAllByRole('button')
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true)
    await userEvent.selectOptions(integrityFilter(), 'verified')
    expect(
      screen.getByText('Matching filters: 24 / 27 · Showing 1–10 · At most 10 per page'),
    ).toBeTruthy()
    await userEvent.click(search())
    await userEvent.type(search(), `  ${rows[26].id.toUpperCase()}  `)
    expect(document.activeElement).toBe(search())
    expect(within(filteredList()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(filteredList()).getByText(rows[26].id)).toBeTruthy()
    expect(
      screen.getByText('Matching filters: 1 / 27 · Showing 1–1 · At most 10 per page'),
    ).toBeTruthy()
    await userEvent.clear(search())
    await userEvent.type(search(), 'NO-MATCH')
    expect(
      screen.getByText('Matching filters: 0 / 27 · Showing 0–0 · At most 10 per page'),
    ).toBeTruthy()
    expect(screen.getByText(/No receipts match the current filters and search/)).toBeTruthy()
    expect(totals.textContent).toBe(originalTotals)
    expect(
      screen.getByText(/Verified integrity does not establish current execution eligibility/),
    ).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('preserves selected evidence, full comparison choices and exact downloads when a filter hides the selected row', async () => {
    const f = fixture(),
      rows = historyRows()
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(historyBatch(rows)))
      .mockResolvedValueOnce(json(historyBatch(rows, 20)))
      .mockResolvedValueOnce(json(f.item))
      .mockResolvedValueOnce(
        new Response(f.raw, {
          headers: {
            ETag: `"${hash(f.raw)}"`,
            'X-Receipt-Fingerprint': f.item.content_fingerprint,
          },
        }),
      )
    render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    await screen.findByRole('list', { name: 'Filtered study receipts' })
    fireEvent.click(
      within(filteredList()).getAllByRole('button', { name: 'Review study receipt' })[0],
    )
    await screen.findByText('Study as saved')
    const detail = screen.getByText('Study as saved').closest('.execution-study-receipt-detail')!
    const savedText = detail.textContent
    fireEvent.change(integrityFilter(), { target: { value: 'unavailable' } })
    fireEvent.change(search(), { target: { value: 'NO-MATCH' } })
    expect(within(filteredList()).queryByText(f.item.id)).toBeNull()
    expect(detail.textContent).toBe(savedText)
    expect(
      within(screen.getByRole('combobox', { name: 'Baseline receipt' })).getAllByRole('option'),
    ).toHaveLength(25)
    expect(fetch).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Download original study JSON' }))
    await waitFor(() => expect(blobs).toHaveLength(1))
    expect(await readBlob(blobs[0])).toBe(f.raw)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(
      true,
    )
  })

  it('resets pagination after a smaller refreshed history and resets browsing controls for a different study kind', async () => {
    const f = fixture(),
      rows = historyRows()
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(historyBatch(rows)))
      .mockResolvedValueOnce(json(historyBatch(rows, 20)))
      .mockResolvedValueOnce(json(historyBatch(historyRows(5))))
      .mockResolvedValueOnce(json(historyBatch(historyRows(2, 'limit_day'))))
    const view = render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    await screen.findByRole('list', { name: 'Filtered study receipts' })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(loadButton())
    await screen.findByText('Matching filters: 5 / 5 · Showing 1–5 · At most 10 per page')
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
    fireEvent.change(integrityFilter(), { target: { value: 'unavailable' } })
    fireEvent.change(search(), { target: { value: 'abc' } })
    view.rerender(<ExecutionStudyReceipts {...fixture('limit_day').props} />)
    expect(screen.queryByRole('list', { name: 'Filtered study receipts' })).toBeNull()
    fireEvent.click(loadButton())
    await screen.findByText('Matching filters: 2 / 2 · Showing 1–2 · At most 10 per page')
    expect(integrityFilter()).toHaveProperty('value', 'all')
    expect(search()).toHaveProperty('value', '')
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it.each(['total', 'revision', 'session', 'duplicate', 'missing', 'scope'] as const)(
    'rejects %s drift across history pages without publishing a partial history',
    async (change) => {
      const f = fixture(),
        rows = historyRows(change === 'total' ? 28 : 27)
      const first = historyBatch(rows, 0, 27),
        second = historyBatch(rows, 20)
      if (change === 'revision') second.checked_input_revision = 'synthetic:3'
      if (change === 'session') second.checked_as_of = '2026-10-02'
      if (change === 'duplicate') second.items[0] = first.items[0]
      if (change === 'missing') {
        second.items.pop()
        second.pagination.returned -= 1
      }
      if (change === 'scope') second.proposal_id = 'e'.repeat(32)
      vi.mocked(fetch).mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(second))
      render(<ExecutionStudyReceipts {...f.props} />)
      fireEvent.click(loadButton())
      await screen.findByRole('alert')
      expect(screen.queryByRole('list', { name: 'Filtered study receipts' })).toBeNull()
      expect(screen.queryByLabelText('Full study history totals')).toBeNull()
      expect(screen.queryByRole('button', { name: /Download original/ })).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('stops at the account retention bound and does not request extra pages for an oversized history', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(historyBatch(historyRows(), 0, 51)))
    render(<ExecutionStudyReceipts {...fixture().props} />)
    fireEvent.click(loadButton())
    expect((await screen.findByRole('alert')).textContent).toContain('receipt_history_mismatch')
    expect(screen.queryByRole('list', { name: 'Filtered study receipts' })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight later history page on scope change without publishing earlier pages', async () => {
    const f = fixture(),
      rows = historyRows()
    let finish!: (value: Response) => void
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(historyBatch(rows)))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    const view = render(<ExecutionStudyReceipts {...f.props} />)
    fireEvent.click(loadButton())
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('list', { name: 'Filtered study receipts' })).toBeNull()
    const signal = vi.mocked(fetch).mock.calls[1][1]?.signal
    view.rerender(<ExecutionStudyReceipts {...f.props} accountId={'e'.repeat(32)} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(json(historyBatch(rows, 20))))
    expect(screen.queryByRole('list', { name: 'Filtered study receipts' })).toBeNull()
    expect(screen.queryByLabelText('Full study history totals')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

it('mounts comparison from already-loaded history without duplicate autoload or fresh evidence', async () => {
  const f = fixture()
  const second = { ...f.item, id: 'e'.repeat(64), content_fingerprint: 'f'.repeat(64) }
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      json({
        ...history(f.item),
        items: [f.item, second],
        pagination: { limit: 20, offset: 0, total: 2, returned: 2 },
      }),
    )
    .mockResolvedValueOnce(json({ detail: { code: 'comparison_account_changed' } }, 409))
  render(<ExecutionStudyReceipts {...f.props} evidence={null} rawEvidence={null} enabled={false} />)
  fireEvent.click(loadButton())
  fireEvent.change(await screen.findByRole('combobox', { name: 'Baseline receipt' }), {
    target: { value: f.item.id },
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Selected receipt' }), {
    target: { value: second.id },
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Compare two studies' }))
  expect((await screen.findByRole('alert')).textContent).toContain('comparison_account_changed')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fetch).mock.calls[1][0]).toBe(base + '/compare')
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
    baseline_receipt_id: f.item.id,
    selected_receipt_id: second.id,
    expected_baseline_fingerprint: f.item.content_fingerprint,
    expected_selected_fingerprint: second.content_fingerprint,
    expected_account_version: 1,
  })
})
