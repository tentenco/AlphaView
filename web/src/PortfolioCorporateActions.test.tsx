import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PortfolioCorporateActions,
  type CorporateActionsSummary,
} from './PortfolioCorporateActions'
import type { PaperAccount } from './paper-model'

afterEach(() => vi.unstubAllGlobals())

const account: PaperAccount = {
  id: 'synthetic-ca-account',
  name: 'Synthetic',
  currency: 'USD',
  initial_cash: 10000,
  cash: 4000,
  version: 2,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const summary = (): CorporateActionsSummary => ({
  engine_version: 'alphaview-corporate-actions-v1',
  account_id: account.id,
  account_version: 2,
  as_of: '2024-01-31',
  input_revision: 'synthetic:1',
  holdings: [
    {
      symbol: 'SYNTA',
      shares: '30',
      entry_session: '2024-01-08',
      last_fill_session: '2024-01-08',
      events_total: 1,
      events_since_entry: ['2024-01-12'],
      events_after_last_fill: ['2024-01-12'],
      status: 'events_since_entry',
    },
    {
      symbol: 'SYNTB',
      shares: '10',
      entry_session: null,
      last_fill_session: null,
      events_total: 1,
      events_since_entry: [],
      events_after_last_fill: [],
      status: 'entry_unknown',
    },
  ],
  flagged: ['SYNTA'],
  entry_unknown: ['SYNTB'],
  events: [
    {
      symbol: 'SYNTA',
      ex_date: '2024-01-12',
      prior_session: '2024-01-11',
      kind: 'dividend',
      price_ratio: 1,
      factor_before: 0.98,
      factor_after: 1,
      factor_change_pct: 2.0408,
      shares_multiplier: null,
      implied_cash_per_share: 2,
      reason: null,
      data_consistency: null,
      since_entry: true,
      after_last_fill: true,
    },
    {
      symbol: 'SYNTB',
      ex_date: '2024-01-05',
      prior_session: '2024-01-04',
      kind: 'suspected_split',
      price_ratio: 0.5,
      factor_before: 0.5,
      factor_after: 1,
      factor_change_pct: 100,
      shares_multiplier: 2,
      implied_cash_per_share: null,
      reason: null,
      data_consistency: { flag: 'possible_mixed_basis', message: 'refresh' },
      since_entry: false,
      after_last_fill: false,
    },
  ],
  coverage: [],
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})

describe('corporate-action detection panel', () => {
  it('lists inferred events with since-entry and consistency flags and names unknown entries', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => summary(),
    }))
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('1 with events since entry')).toBeTruthy()
    expect(String(fetcher.mock.calls[0][0])).toBe(
      '/api/paper/accounts/synthetic-ca-account/corporate-actions',
    )
    expect(screen.getByText('Dividend (implied)')).toBeTruthy()
    expect(screen.getByText('$2.0000 / share')).toBeTruthy()
    expect(screen.getByText('×2.00 shares')).toBeTruthy()
    expect(screen.getByText(/Possibly mixed pre\/post-split rows/)).toBeTruthy()
    expect(screen.getByText(/No entry record/).textContent).toContain('SYNTB')
    expect(screen.getByText(/What this is not/)).toBeTruthy()
  })

  it('shows the request error instead of an empty table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL) => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    )
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect((await screen.findByRole('alert')).textContent).toBe('Request failed (404)')
    expect(screen.queryByText('No events since entry')).toBeNull()
  })
})

const providerSummary = (): CorporateActionsSummary => ({
  ...summary(),
  provider_evidence: [
    {
      symbol: 'SYNTA',
      engine_version: 'alphaview-corporate-action-evidence-v1',
      status: 'available',
      source: 'Yahoo Finance / yfinance',
      adapter_version: 'synthetic-1',
      fetched_at: '2026-09-30T22:00:00Z',
      evidence_revision: 2,
      capture_version: 3,
      previous_evidence_revision: 1,
      captured_input_revision: 'synthetic:2',
      freshness_reasons: [],
      coverage: {
        first: '2024-01-02',
        last: '2024-01-31',
        rows: 20,
        unavailable_cells: 0,
        columns: {
          Dividends: { present: true, checked: 20, zero: 19, events: 1, unavailable: 0 },
          'Stock Splits': { present: true, checked: 20, zero: 20, events: 0, unavailable: 0 },
        },
      },
      events: [
        {
          ex_date: '2024-01-12',
          kind: 'cash_dividend',
          raw_value: '2.1234567890123',
          raw_type: 'float',
          value: 2.1234567890123,
          reason: null,
        },
      ],
      comparisons: [
        {
          ex_date: '2024-01-12',
          kind: 'cash_dividend',
          status: 'same_date_and_kind',
          amount_comparison: 'inconclusive_adjustment_basis',
        },
      ],
      changes: [
        {
          ex_date: '2024-01-12',
          kind: 'cash_dividend',
          status: 'changed',
          previous_raw_value: '2.0',
          current_raw_value: '2.1234567890123',
        },
      ],
    },
  ],
})

describe('adapter corporate-action evidence', () => {
  it('shows precise returned evidence, coverage, revisions and the unverified adjustment basis', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => providerSummary(),
    }))
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Returned evidence saved')).toBeTruthy()
    expect(screen.getByText('2.1234567890123', { selector: 'td' })).toBeTruthy()
    expect(screen.getByText(/Event revision 2/).textContent).toContain('Capture version 3')
    expect(screen.getByText(/Bar coverage/).textContent).toContain('Unavailable cells 0')
    expect(screen.getByText(/upstream completeness is unknown/)).toBeTruthy()
    expect(screen.getByText(/Same date and kind; amount basis remains unverified/)).toBeTruthy()
    expect(screen.getByText(/neither equality nor conflict is asserted/)).toBeTruthy()
    expect(screen.getByText(/Source value changed/).textContent).toContain('2.0 → 2.1234567890123')
    expect(fetcher.mock.calls.filter((call) => !String(call[0]).endsWith('/refresh'))).toHaveLength(
      1,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload local evidence' }))
    expect(await screen.findByText('SYNTA · Returned evidence saved')).toBeTruthy()
    expect(fetcher.mock.calls.filter((call) => !String(call[0]).endsWith('/refresh'))).toHaveLength(
      2,
    )
  })

  it('keeps missing columns unknown and invalid raw text escaped instead of replacing them with zero', async () => {
    const value = providerSummary()
    const item = value.provider_evidence![0]
    item.status = 'partial'
    item.coverage!.unavailable_cells = 21
    item.coverage!.columns['Stock Splits'] = {
      present: false,
      checked: 0,
      zero: 0,
      events: 0,
      unavailable: 20,
    }
    item.events[0] = {
      ...item.events[0],
      raw_value: '<script>bad()</script>',
      value: null,
      reason: 'non_numeric_value',
    }
    item.comparisons[0].status = 'inconclusive'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => value })),
    )
    const { container } = render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Incomplete columns or values')).toBeTruthy()
    expect(screen.getByText(/Not provided; all rows unknown/)).toBeTruthy()
    expect(screen.getByText('<script>bad()</script>')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText(/Unavailable · Returned value is not numeric/)).toBeTruthy()
    expect(screen.queryByText(/Same date and kind/)).toBeNull()
  })

  it('exposes stale bars and distinguishes absent latest evidence from a confirmed retraction', async () => {
    const value = providerSummary()
    const item = value.provider_evidence![0]
    item.status = 'stale'
    item.freshness_reasons = ['bars_changed', 'source_update_failed']
    item.changes[0] = {
      ...item.changes[0],
      current_raw_value: null,
      status: 'not_reported_in_latest_capture',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => value })),
    )
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Evidence stale or misaligned with bars')).toBeTruthy()
    expect(screen.getByText(/Local bars changed · Latest source update failed/)).toBeTruthy()
    expect(screen.getByText(/Not returned this time; not a confirmed retraction/)).toBeTruthy()
  })

  it('clears the previous account while loading and ignores its aborted late response', async () => {
    let finishOld:
      | ((value: {
          ok: boolean
          status: number
          json: () => Promise<CorporateActionsSummary>
        }) => void)
      | undefined
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...summary(),
          account_id: 'next',
          events: [],
          holdings: [],
          flagged: [],
          entry_unknown: [],
          provider_evidence: [],
        }),
      })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ job: null }) })
    vi.stubGlobal('fetch', fetcher)
    const { rerender } = render(<PortfolioCorporateActions account={account} locale="en" />)
    rerender(<PortfolioCorporateActions account={{ ...account, id: 'next' }} locale="en" />)
    expect(await screen.findByText('No paper holdings.')).toBeTruthy()
    finishOld!({ ok: true, status: 200, json: async () => providerSummary() })
    await Promise.resolve()
    expect(screen.queryByText('SYNTA · Returned evidence saved')).toBeNull()
    expect((fetcher.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true)
  })
})

const refreshJob = (status = 'running') => ({
  id: 'ca-synthetic-request',
  account_id: account.id,
  symbol: 'SYNTA',
  status,
  progress: 'Synthetic local job receipt',
  error: null,
  cancel_requested: false,
  result: {
    holding_context: 'unchanged',
    after: { inferred_events: 1, returned_events: 1, unavailable_cells: null },
  },
})
const reply = (value: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => value })
const refreshButton = async () => {
  const button = await screen.findByRole('button', {
    name: 'Refresh two years and re-detect · SYNTA',
  })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  return button
}

describe('explicit held-symbol refresh jobs', () => {
  it('only GETs on mount, sends context tokens on one double-click request, and uses existing cancellation', async () => {
    let finish: ((value: Awaited<ReturnType<typeof reply>>) => void) | undefined
    const requests: { url: string; options?: RequestInit }[] = []
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      requests.push({ url, options })
      if (url.endsWith('/cancel')) return reply({ cancel_requested: true }, 202)
      if (options?.method === 'POST')
        return new Promise((resolve) => {
          finish = resolve
        })
      if (url.endsWith('/refresh')) return reply({ job: null })
      return reply(providerSummary())
    })
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCorporateActions account={account} locale="en" />)
    const button = await refreshButton()
    expect(requests.every((request) => request.options?.method !== 'POST')).toBe(true)
    fireEvent.click(button)
    fireEvent.click(button)
    const posts = requests.filter((request) => request.options?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0].options?.body))).toMatchObject({
      symbol: 'SYNTA',
      expected_account_version: 2,
      expected_input_revision: 'synthetic:1',
      expected_as_of: '2024-01-31',
    })
    await act(async () => finish!(await reply({ job: refreshJob() }, 202)))
    expect(await screen.findByText('SYNTA · Running')).toBeTruthy()
    const cancel = screen.getByRole('button', { name: 'Cancel this refresh' })
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeTruthy()
    expect(requests.filter((request) => request.url.endsWith('/cancel'))).toHaveLength(1)
    expect(screen.getByText(/atomically saved quotes are retained/)).toBeTruthy()
  })

  it('retains evidence after busy or stale-context rejection without launching a second request', async () => {
    const posts: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          posts.push(options)
          return reply(
            { detail: { code: 'workspace_busy', message: 'Synthetic workspace busy' } },
            409,
          )
        }
        if (url.endsWith('/refresh')) return reply({ job: null })
        return reply(providerSummary())
      }),
    )
    render(<PortfolioCorporateActions account={account} locale="en" />)
    fireEvent.click(await refreshButton())
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic workspace busy')
    expect(screen.getByText('2.1234567890123', { selector: 'td' })).toBeTruthy()
    expect(posts).toHaveLength(1)
    expect((await refreshButton()).hasAttribute('disabled')).toBe(false)
  })

  it('restores a running job after remount, polls to completion, and reloads only local evidence', async () => {
    let status = 'running'
    const requests: { url: string; options?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options?: RequestInit) => {
        requests.push({ url, options })
        if (url.endsWith('/refresh/ca-synthetic-request')) {
          status = 'completed'
          return reply({ job: refreshJob(status) })
        }
        if (url.endsWith('/refresh')) return reply({ job: refreshJob(status) })
        return reply(providerSummary())
      }),
    )
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Running')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('SYNTA · Re-detection completed')).toBeTruthy(), {
      timeout: 2500,
    })
    expect(requests.filter((request) => request.url.endsWith('/corporate-actions'))).toHaveLength(2)
    expect(requests.every((request) => request.options?.method !== 'POST')).toBe(true)
    expect(
      screen.getByText(/A successful refresh does not prove an anomaly is resolved/),
    ).toBeTruthy()
    expect(screen.getByText(/Re-detection result/).textContent).toContain('Unavailable cells —')
  })

  it('aborts an in-flight start when the account changes and ignores its late response', async () => {
    let finish: ((value: Awaited<ReturnType<typeof reply>>) => void) | undefined
    let startSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          startSignal = options.signal
          return new Promise((resolve) => {
            finish = resolve
          })
        }
        if (url.endsWith('/refresh')) return reply({ job: null })
        if (url.includes('/next/'))
          return reply({
            ...summary(),
            account_id: 'next',
            holdings: [],
            events: [],
            flagged: [],
            entry_unknown: [],
            provider_evidence: [],
          })
        return reply(providerSummary())
      }),
    )
    const { rerender } = render(<PortfolioCorporateActions account={account} locale="en" />)
    fireEvent.click(await refreshButton())
    rerender(<PortfolioCorporateActions account={{ ...account, id: 'next' }} locale="en" />)
    expect(await screen.findByText('No paper holdings.')).toBeTruthy()
    expect(startSignal?.aborted).toBe(true)
    await act(async () => finish!(await reply({ job: refreshJob() }, 202)))
    expect(screen.queryByText('SYNTA · Running')).toBeNull()
    expect(screen.queryByRole('button', { name: /Refresh two years and re-detect/ })).toBeNull()
  })

  it('restores interrupted/changed-context receipts without claiming a validated holding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/refresh')
          ? reply({
              job: {
                ...refreshJob('interrupted'),
                result: { holding_context: 'changed_not_validated' },
              },
            })
          : reply(providerSummary()),
      ),
    )
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(await screen.findByText('SYNTA · Background process interrupted')).toBeTruthy()
    expect(screen.getByText(/did not validate the current holding/)).toBeTruthy()
    expect((await refreshButton()).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('2026-09-30T22:00:00Z')).toBeNull()
  })
})

it('reuses the same idempotency key after an ambiguous network failure', async () => {
  const bodies: { idempotency_key: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        bodies.push(JSON.parse(String(options.body)))
        if (bodies.length === 1) return Promise.reject(new Error('Synthetic response lost'))
        return reply({ job: refreshJob(), replayed: true }, 202)
      }
      if (url.endsWith('/refresh')) return reply({ job: null })
      return reply(providerSummary())
    }),
  )
  render(<PortfolioCorporateActions account={account} locale="en" />)
  fireEvent.click(await refreshButton())
  expect((await screen.findByRole('alert')).textContent).toBe('Synthetic response lost')
  fireEvent.click(await refreshButton())
  expect(await screen.findByText('SYNTA · Running')).toBeTruthy()
  expect(bodies).toHaveLength(2)
  expect(bodies[0].idempotency_key).toBe(bodies[1].idempotency_key)
})

const downloadName = 'Download corporate-action evidence JSON'
const downloadButton = () => screen.getByRole('button', { name: downloadName })
function mockDownload() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:corporate-evidence')
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
async function readJson(blob: Blob) {
  return JSON.parse(
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    }),
  )
}
function localEvidenceFetch(value: unknown) {
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    reply(url.endsWith('/refresh') ? { job: null } : value),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('corporate-action local evidence JSON download', () => {
  it('downloads the complete accepted envelope with raw precision, revision, nulls, unknown fields and read status without extra reads or writes', async () => {
    const original = providerSummary()
    const server = {
      ...original,
      current_at_snapshot: null,
      future_context: { missing: null, values: [0, false, null], label: '合成 "來源"\n第二行' },
      provider_evidence: [
        {
          ...original.provider_evidence![0],
          source_completeness: 'unknown',
          previous_evidence_revision: null,
          future_capture: { immutable_revision_detail: null },
          coverage: { ...original.provider_evidence![0].coverage!, future_coverage: null },
        },
      ],
    }
    const expected = structuredClone(server)
    const fetcher = localEvidenceFetch(server)
    const download = mockDownload()
    render(<PortfolioCorporateActions account={account} locale="en" />)
    expect(downloadButton()).toHaveProperty('disabled', true)
    fireEvent.click(downloadButton())
    expect(download.createObjectURL).not.toHaveBeenCalled()
    await refreshButton()
    expect(downloadButton()).toHaveProperty('disabled', false)
    const callsBefore = fetcher.mock.calls.length
    fireEvent.click(downloadButton())
    expect(fetcher.mock.calls).toHaveLength(callsBefore)
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
    expect(download.createObjectURL).toHaveBeenCalledTimes(1)
    const blob = download.createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(await readJson(blob)).toEqual(expected)
    expect(server).toEqual(expected)
    expect(download.links).toEqual([
      {
        filename: `alphaview-corporate-action-evidence-${server.as_of}-${account.id}.json`,
        href: 'blob:corporate-evidence',
        attached: true,
      },
    ])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(download.revokeObjectURL).not.toHaveBeenCalled()
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:corporate-evidence')
    expect(
      screen.getByText(
        /does not refetch data or prove a complete corporate-action ledger or posting/,
      ),
    ).toBeTruthy()
  })

  it.each(['stale', 'partial', 'unavailable'] as const)(
    'exports an accepted %s source envelope without replacing unknown values or claiming current evidence',
    async (status) => {
      const server = providerSummary()
      const entry = server.provider_evidence![0]
      entry.status = status
      entry.freshness_reasons = status === 'stale' ? ['source_update_failed'] : []
      entry.events[0] = {
        ...entry.events[0],
        raw_value: null,
        value: null,
        reason: 'missing_value',
      }
      entry.coverage!.unavailable_cells = 1
      entry.comparisons[0].status = 'inconclusive'
      if (status === 'unavailable')
        server.provider_evidence = [
          {
            symbol: 'SYNTA',
            engine_version: entry.engine_version,
            status,
            events: [],
            comparisons: [],
            changes: [],
          },
        ]
      const envelope = { ...server, source_completeness: 'unknown', future_status: null }
      const fetcher = localEvidenceFetch(envelope)
      const download = mockDownload()
      render(<PortfolioCorporateActions account={account} locale="en" />)
      await refreshButton()
      if (status === 'stale') expect(screen.getByText('Latest source update failed')).toBeTruthy()
      expect(screen.queryByText('SYNTA · Returned evidence saved')).toBeNull()
      fireEvent.click(downloadButton())
      expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(envelope)
      expect(fetcher.mock.calls).toHaveLength(2)
    },
  )

  it.each(['http', 'network'] as const)(
    'disables the old download during a local reload and after a %s failure',
    async (failure) => {
      let complete!: (value: Awaited<ReturnType<typeof reply>>) => void
      let reject!: (error: Error) => void
      let reads = 0
      const fetcher = vi.fn((url: string) => {
        if (url.endsWith('/refresh')) return reply({ job: null })
        if (++reads === 1) return reply(providerSummary())
        return new Promise<Awaited<ReturnType<typeof reply>>>((done, fail) => {
          complete = done
          reject = fail
        })
      })
      vi.stubGlobal('fetch', fetcher)
      const download = mockDownload()
      render(<PortfolioCorporateActions account={account} locale="en" />)
      await refreshButton()
      const oldDownload = downloadButton()
      fireEvent.click(screen.getByRole('button', { name: 'Reload local evidence' }))
      expect(downloadButton()).toHaveProperty('disabled', true)
      fireEvent.click(oldDownload)
      expect(download.createObjectURL).not.toHaveBeenCalled()
      await act(async () => {
        if (failure === 'http') complete(await reply({}, 503))
        else reject(new Error('Synthetic read failure'))
      })
      expect((await screen.findByRole('alert')).textContent).toContain(
        failure === 'http' ? 'Request failed (503)' : 'Synthetic read failure',
      )
      expect(downloadButton()).toHaveProperty('disabled', true)
      fireEvent.click(downloadButton())
      expect(download.createObjectURL).not.toHaveBeenCalled()
      expect(reads).toBe(2)
      expect(screen.queryByText('SYNTA · Returned evidence saved')).toBeNull()
    },
  )

  it.each(['account', 'version'] as const)(
    'invalidates the old download on %s change and ignores an aborted late response',
    async (change) => {
      const nextAccount =
        change === 'account'
          ? { ...account, id: 'synthetic-next' }
          : { ...account, version: account.version + 1 }
      const next = {
        ...providerSummary(),
        account_id: nextAccount.id,
        account_version: nextAccount.version,
        input_revision: 'synthetic:next',
      }
      let reads = 0
      const pending: {
        signal: AbortSignal
        resolve: (value: Awaited<ReturnType<typeof reply>>) => void
      }[] = []
      const fetcher = vi.fn((url: string, options?: RequestInit) => {
        if (url.endsWith('/refresh')) return reply({ job: null })
        if (++reads === 1) return reply(providerSummary())
        return new Promise<Awaited<ReturnType<typeof reply>>>((resolve) => {
          pending.push({ signal: options!.signal!, resolve })
        })
      })
      vi.stubGlobal('fetch', fetcher)
      const download = mockDownload()
      const view = render(<PortfolioCorporateActions account={account} locale="en" />)
      await refreshButton()
      const oldButton = downloadButton()
      fireEvent.click(screen.getByRole('button', { name: 'Reload local evidence' }))
      view.rerender(<PortfolioCorporateActions account={nextAccount} locale="en" />)
      expect(downloadButton()).toHaveProperty('disabled', true)
      expect(pending[0].signal.aborted).toBe(true)
      fireEvent.click(oldButton)
      await act(async () => pending[0].resolve(await reply(providerSummary())))
      expect(downloadButton()).toHaveProperty('disabled', true)
      expect(download.createObjectURL).not.toHaveBeenCalled()
      await act(async () => pending[1].resolve(await reply(next)))
      await refreshButton()
      fireEvent.click(downloadButton())
      expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(next)
      expect(reads).toBe(3)
    },
  )

  it.each(['account', 'version', 'missing_version'] as const)(
    'rejects a returned %s identity mismatch before display or export',
    async (mismatch) => {
      const server: Record<string, unknown> = { ...providerSummary() }
      if (mismatch === 'account') server.account_id = 'synthetic-unrelated'
      else if (mismatch === 'version') server.account_version = account.version + 1
      else delete server.account_version
      const fetcher = localEvidenceFetch(server)
      const download = mockDownload()
      render(<PortfolioCorporateActions account={account} locale="en" />)
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The response account or version does not match. Reload the account.',
      )
      expect(downloadButton()).toHaveProperty('disabled', true)
      fireEvent.click(downloadButton())
      expect(download.createObjectURL).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('SYNTA · Returned evidence saved')).toBeNull()
    },
  )

  it('clears a ready download immediately when the account changes', async () => {
    let reads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/refresh')) return reply({ job: null })
        if (++reads === 1) return reply(providerSummary())
        return new Promise(() => {})
      }),
    )
    const download = mockDownload()
    const view = render(<PortfolioCorporateActions account={account} locale="en" />)
    await refreshButton()
    const oldButton = downloadButton()
    expect(oldButton).toHaveProperty('disabled', false)
    view.rerender(
      <PortfolioCorporateActions account={{ ...account, id: 'synthetic-next' }} locale="en" />,
    )
    expect(downloadButton()).toHaveProperty('disabled', true)
    expect(screen.queryByText('SYNTA · Returned evidence saved')).toBeNull()
    fireEvent.click(oldButton)
    expect(download.createObjectURL).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -Infinity])(
    'refuses to turn a nonfinite future value (%s) into null',
    async (number) => {
      localEvidenceFetch({ ...providerSummary(), future_value: number })
      const download = mockDownload()
      render(<PortfolioCorporateActions account={account} locale="en" />)
      await refreshButton()
      fireEvent.click(downloadButton())
      expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
      expect(download.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it('sanitizes and bounds the filename without rewriting the response', async () => {
    const unusual = { ...account, id: '../synthetic <account>/' + 'a'.repeat(200) }
    const server = {
      ...providerSummary(),
      account_id: unusual.id,
      as_of: '../2024-01-31\n' + 's'.repeat(200),
    }
    localEvidenceFetch(server)
    const download = mockDownload()
    render(<PortfolioCorporateActions account={unusual} locale="en" />)
    await refreshButton()
    fireEvent.click(downloadButton())
    expect(download.links[0].filename).toMatch(
      /^alphaview-corporate-action-evidence-[a-zA-Z0-9_-]+\.json$/,
    )
    expect(download.links[0].filename.length).toBeLessThan(175)
    expect(await readJson(download.createObjectURL.mock.calls[0][0])).toEqual(server)
  })

  it('reports download refusal and releases the temporary anchor and URL', async () => {
    localEvidenceFetch(providerSummary())
    const download = mockDownload()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    render(<PortfolioCorporateActions account={account} locale="en" />)
    await refreshButton()
    fireEvent.click(downloadButton())
    expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
    expect(document.querySelector('a[download]')).toBeNull()
    download.revocations[0]()
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:corporate-evidence')
  })
})
