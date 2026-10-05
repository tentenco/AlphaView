import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ResearchIntegrityReceipts,
  type IntegrityReceipt,
  type IntegrityReceiptRequest,
} from './ResearchIntegrityReceipts'
import type { DeskIntegrityResult } from './ResearchDeskIntegrity'

const t = (_zh: string, en: string) => en
const request: IntegrityReceiptRequest = {
  symbol: 'SYNTA',
  config: { strategy: 'rsi_reversion', params: { period: 14, entry: 30, exit: 55 } },
  test_start: null,
  test_end: '2026-10-01',
  max_prefixes: 6,
}
const evidence: DeskIntegrityResult = {
  engine_version: 'alphaview-research-integrity-v1',
  evidence_fingerprint: 'a'.repeat(64),
  as_of: '2026-10-01',
  input_revision: 'synthetic:1',
  symbol: 'SYNTA',
  config: request.config,
  fingerprint: 'b'.repeat(64),
  request,
  status: 'no_difference_detected',
  fields: ['entry', 'exit', 'valid', 'close', 'rsi'],
  prefixes: [
    {
      cutoff_date: '2026-09-30',
      compared_start: '2026-01-02',
      compared_sessions: 100,
      difference_count: 0,
      unavailable_values: 0,
      invalid_signal_sessions: 0,
      status: 'no_difference_detected',
    },
  ],
  counts: {
    prefixes: 1,
    compared_session_pairs: 100,
    differences: 0,
    unavailable_values: 0,
    invalid_signal_sessions: 0,
  },
  differences: [],
  differences_truncated: false,
  unavailable: [],
  unavailable_values: [],
  unavailable_values_truncated: false,
  method: 'Synthetic sampled diagnostic, not a proof.',
}
const makeReceipt = (): IntegrityReceipt => ({
  id: 'c'.repeat(64),
  symbol: 'SYNTA',
  created_at: '2026-10-01T22:00:00Z',
  engine_version: 'alphaview-research-integrity-receipt-v1',
  content_fingerprint: 'd'.repeat(64),
  integrity: { available: true, reason: null },
  currentness: { current: true, reasons: [] },
  status: evidence.status,
  as_of: evidence.as_of,
  config: request.config,
  counts: evidence.counts,
  replayed: false,
  receipt: {
    engine_version: 'alphaview-research-integrity-receipt-v1',
    receipt_id: 'c'.repeat(64),
    created_at: '2026-10-01T22:00:00Z',
    request,
    source_context: {
      symbol: 'SYNTA',
      as_of: evidence.as_of,
      input_revision: evidence.input_revision,
      history_fingerprint: evidence.fingerprint,
      integrity_engine_version: evidence.engine_version,
      desk_engine_version: 'alphaview-research-desk-v1',
      request_fingerprint: 'e'.repeat(64),
      evidence_fingerprint: evidence.evidence_fingerprint!,
    },
    evidence,
    method: 'Synthetic immutable receipt.',
  },
})
const list = (items: IntegrityReceipt[]) => ({
  items,
  pagination: { limit: 20, offset: 0, total: items.length, returned: items.length },
  retention: { workspace: 500, max_bytes: 262144, automatic_deletion: false },
})
const props = {
  symbol: 'SYNTA',
  evidence,
  request,
  contextIdentity: 'diagnosis-1',
  enabled: true,
  t,
}
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('immutable prefix diagnostic receipts', () => {
  it('does not read or save automatically, and saves only the exact request and expected source fields', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => response(makeReceipt(), 201))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchIntegrityReceipts {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Save this prefix receipt' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await screen.findByText('Immutable prefix receipt saved.')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/research-desk/integrity-receipts')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      request,
      expected_input_revision: evidence.input_revision,
      expected_as_of: evidence.as_of,
      expected_evidence_fingerprint: evidence.evidence_fingerprint,
    })
    expect(screen.getByText('No differences in sampled prefixes', { selector: 'p' })).toBeTruthy()
    expect(screen.getByText(/still not proof of absence of leakage/)).toBeTruthy()
    expect(screen.queryByText('Pass')).toBeNull()
  })

  it('disables saving legacy, absent, disabled, or differently requested evidence', () => {
    const view = render(
      <ResearchIntegrityReceipts
        {...props}
        evidence={{ ...evidence, evidence_fingerprint: undefined }}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Save this prefix receipt' }).hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(<ResearchIntegrityReceipts {...props} evidence={null} request={null} />)
    expect(
      screen.getByRole('button', { name: 'Save this prefix receipt' }).hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(<ResearchIntegrityReceipts {...props} enabled={false} />)
    expect(
      screen.getByRole('button', { name: 'Save this prefix receipt' }).hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(
      <ResearchIntegrityReceipts {...props} request={{ ...request, max_prefixes: 3 }} />,
    )
    expect(
      screen.getByRole('button', { name: 'Save this prefix receipt' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Load receipt history for this symbol' })
        .hasAttribute('disabled'),
    ).toBe(false)
  })

  it('preserves server replay labeling and marks historical context separately', async () => {
    const receipt = makeReceipt()
    receipt.replayed = true
    receipt.currentness = { current: false, reasons: ['workspace_inputs_changed'] }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(receipt)),
    )
    render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save this prefix receipt' }))
    expect(
      await screen.findByText('The existing receipt was replayed; no duplicate was saved.'),
    ).toBeTruthy()
    expect(screen.getByText('Historical sources are no longer current')).toBeTruthy()
    expect(screen.getByText('No differences in sampled prefixes', { selector: 'p' })).toBeTruthy()
    expect(screen.getByText(/does not necessarily mean this symbol’s bars changed/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Download original saved receipt JSON' }),
    ).toBeTruthy()
  })

  it('loads stale historical configuration explicitly without applying it to current props', async () => {
    const receipt = makeReceipt()
    receipt.receipt = structuredClone(receipt.receipt!)
    receipt.receipt.request.max_prefixes = 2
    receipt.receipt.evidence.request!.max_prefixes = 2
    receipt.currentness = { current: false, reasons: ['session_changed'] }
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(list([receipt])))
      .mockImplementationOnce(() => response(receipt))
    vi.stubGlobal('fetch', fetcher)
    const original = structuredClone(request)
    render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load receipt history for this symbol' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Load receipt c/ }))
    expect(await screen.findByText(/different request from the current comparison/)).toBeTruthy()
    expect(screen.getByText(/Maximum cutoffs/).textContent).toContain('2')
    expect(request).toEqual(original)
    expect(fetcher.mock.calls.every((call) => call[1].method === undefined)).toBe(true)
  })

  it('keeps corrupt history visible as unavailable and blocks its download', async () => {
    const receipt = makeReceipt()
    receipt.integrity = { available: false, reason: 'receipt_content_changed' }
    receipt.currentness = { current: null, reasons: ['receipt_unverifiable'] }
    receipt.receipt = null
    receipt.status = null
    receipt.counts = null
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(list([receipt])))
        .mockImplementationOnce(() => response(receipt)),
    )
    render(<ResearchIntegrityReceipts {...props} evidence={null} request={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load receipt history for this symbol' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Load receipt c/ }))
    expect(await screen.findByText(/Its diagnostic and download are unavailable/)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Download original saved receipt JSON' }),
    ).toBeNull()
    expect(screen.queryByText('No differences in sampled prefixes')).toBeNull()
  })

  it('downloads exact server bytes including numeric spelling without recomputing evidence', async () => {
    const receipt = makeReceipt()
    const raw = JSON.stringify(receipt.receipt).replace(
      '"difference_count":0',
      '"difference_count":0.0',
    )
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(receipt, 201))
      .mockImplementationOnce(() => Promise.resolve(new Response(raw)))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:prefix-receipt')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save this prefix receipt' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download original saved receipt JSON' }),
    )
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    expect(await readBlob(createObjectURL.mock.calls[0][0])).toBe(raw)
    expect(filename).toMatch(/^alphaview-prefix-receipt-SYNTA-[a-f0-9]{64}\.json$/)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(fetcher.mock.calls[1][0]).toContain(
      `/evidence.json?expected_content_fingerprint=${receipt.content_fingerprint}`,
    )
    expect(fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1)
  })

  it('rejects changed source responses instead of displaying a successful save', async () => {
    const receipt = makeReceipt()
    receipt.receipt = structuredClone(receipt.receipt!)
    receipt.receipt.source_context.evidence_fingerprint = 'f'.repeat(64)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(receipt, 201)),
    )
    render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save this prefix receipt' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'does not match this diagnostic',
    )
    expect(screen.queryByText('Immutable prefix receipt saved.')).toBeNull()
  })

  it('retains a conflict error without automatic retries or writes', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() =>
        response(
          { detail: { code: 'receipt_source_changed', message: 'Synthetic changed source' } },
          409,
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save this prefix receipt' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic changed source')
    expect(
      screen.getByRole('button', { name: 'Save this prefix receipt' }).hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('aborts pending reads and ignores late receipts after context or symbol changes', async () => {
    let resolve: (value: Response) => void = () => {}
    const fetcher = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchIntegrityReceipts {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load receipt history for this symbol' }))
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(
      <ResearchIntegrityReceipts
        {...props}
        symbol="SYNTB"
        contextIdentity="diagnosis-2"
        evidence={null}
        request={null}
      />,
    )
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(new Response(JSON.stringify(list([makeReceipt()])))))
    expect(screen.queryByRole('table', { name: 'Prefix receipt history' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not poll, apply history, or automatically restore receipts on remount', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => response(list([])))
    vi.stubGlobal('fetch', fetcher)
    const interval = vi.spyOn(window, 'setInterval')
    const view = render(<ResearchIntegrityReceipts {...props} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load receipt history for this symbol' }))
    })
    expect(screen.getByText('No saved receipts for this symbol.')).toBeTruthy()
    expect(interval).not.toHaveBeenCalled()
    view.unmount()
    render(<ResearchIntegrityReceipts {...props} />)
    expect(screen.queryByText('No saved receipts for this symbol.')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves unavailable values rather than changing them to a successful diagnostic', async () => {
    const unavailable = {
      ...evidence,
      status: 'unavailable' as const,
      fingerprint: null,
      prefixes: [],
      unavailable: [{ code: 'no_history', message: 'Synthetic missing history' }],
      counts: {
        prefixes: 0,
        compared_session_pairs: 0,
        differences: 0,
        unavailable_values: 0,
        invalid_signal_sessions: 0,
      },
    }
    const receipt = makeReceipt()
    receipt.status = 'unavailable'
    receipt.counts = unavailable.counts
    receipt.receipt = {
      ...receipt.receipt!,
      evidence: unavailable,
      source_context: { ...receipt.receipt!.source_context, history_fingerprint: null },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => response(receipt, 201)),
    )
    render(<ResearchIntegrityReceipts {...props} evidence={unavailable} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save this prefix receipt' }))
    await screen.findByText('Immutable prefix receipt saved.')
    const detail = screen.getByRole('region', { name: 'Saved prefix diagnostic receipts' })
    expect(within(detail).getByText('Comparison unavailable')).toBeTruthy()
    expect(screen.getByText('Synthetic missing history (no_history)')).toBeTruthy()
    expect(screen.getByText(/Saved history fingerprint/).textContent).toContain('—')
    expect(screen.getByText(/Cutoffs compared/).textContent).toContain('0')
  })
})
