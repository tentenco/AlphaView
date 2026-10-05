import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPathDrawdowns, type PathDrawdowns } from './WorkflowPathDrawdowns'

const t = (_zh: string, en: string) => en
const accountId = 'a'.repeat(32)
const receiptId = 'b'.repeat(64)
const fingerprint = 'c'.repeat(64)
const base = `/api/paper/accounts/${accountId}/workflow-path-receipts`
function receipt() {
  return {
    id: receiptId,
    run_id: 'd'.repeat(32),
    kind: 'path_validation' as const,
    created_at: '2026-10-01T12:00:00+00:00',
    content_fingerprint: fingerprint,
    integrity: { available: true, reason: null },
    currentness: { current: false, reasons: ['inputs_changed'] },
  }
}
function result(): PathDrawdowns {
  return {
    engine_version: 'synthetic-drawdown-v1',
    account_id: accountId,
    account_version: 1,
    request: {
      receipt_id: receiptId,
      expected_fingerprint: fingerprint,
      expected_account_version: 1,
    },
    original_receipt: {
      receipt_id: receiptId,
      evidence: { metrics: { initial_cash: 100, max_drawdown_pct: -20 } },
    },
    receipt_summary: receipt(),
    checked_as_of: '2026-10-01',
    checked_input_revision: 'synthetic:1',
    execution_authority: false,
    analysis: {
      status: 'evaluated',
      reasons: [],
      basis_checks: [{ code: 'raw_history', available: true }],
      historical_calendar: {
        exchange: 'XNYS',
        signal_date: '2025-10-01',
        as_of: '2026-10-01',
        valued_sessions: 252,
      },
      curve: [
        { index: 0, date: '2025-10-01', nav: 100, peak_nav: 100, drawdown_pct: 0, episode: null },
        { index: 1, date: '2025-10-02', nav: 80, peak_nav: 100, drawdown_pct: -20, episode: 1 },
        { index: 2, date: '2025-10-03', nav: 90, peak_nav: 100, drawdown_pct: -10, episode: 1 },
      ],
      episodes: [
        {
          episode: 1,
          status: 'open',
          peak_date: '2025-10-01',
          peak_nav: 100,
          first_underwater_date: '2025-10-02',
          trough_date: '2025-10-02',
          trough_nav: 80,
          depth_pct: -20,
          recovery_date: null,
          recovery_nav: null,
          duration_sessions: null,
          underwater_sessions: null,
          to_trough_sessions: 1,
          trough_to_recovery_sessions: null,
          observed_underwater_sessions: 2,
          observed_elapsed_sessions: 2,
          observed_through_date: '2025-10-03',
        },
      ],
      summary: {
        episode_count: 1,
        recovered_episode_count: 0,
        open_episode_count: 1,
        unrecovered_at_end: true,
        max_drawdown_pct: -20,
        total_underwater_sessions: 2,
        longest_observed_underwater_sessions: 2,
        longest_closed_duration_sessions: null,
        longest_observed_elapsed_sessions: 2,
      },
      reconciliation: {
        computed_max_drawdown_pct: -20,
        recorded_max_drawdown_pct: -20,
        difference_percentage_points: 0,
        within_tolerance: true,
        absolute_tolerance_percentage_points: 1e-9,
        relative_tolerance: 1e-10,
      },
    },
  }
}
const listing = () => ({ account_id: accountId, kind: 'path_validation', items: [receipt()] })
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
function load() {
  fireEvent.click(screen.getByRole('button', { name: 'Load historical path receipts' }))
}
async function select() {
  const input = await screen.findByRole('combobox', { name: 'Drawdown source receipt' })
  fireEvent.change(input, { target: { value: receiptId } })
  return input
}
function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Inspect saved drawdown episodes' }))
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saved path drawdowns', () => {
  it('loads only on demand and inspects exact selected fingerprint once with open duration missing', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    load()
    await select()
    inspect()
    inspect()
    await screen.findByText('Drawdown episodes verified')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(`${base}?kind=path_validation&limit=50`)
    expect(fetcher.mock.calls[1][0]).toBe(`${base}/drawdowns`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    expect(screen.getByText(/Still unrecovered at the end/)).toBeTruthy()
    expect(screen.getByText('— / —')).toBeTruthy()
    expect(screen.getByText('1 / —')).toBeTruthy()
    expect(screen.getByText(/Historical sources are no longer current/)).toBeTruthy()
    expect(
      screen.getByRole('img', { name: 'Daily drawdown curve from the saved path' }),
    ).toBeTruthy()
  })

  it('keeps empty and corrupt selections disabled', async () => {
    const data = listing()
    data.items.push({
      ...receipt(),
      id: 'e'.repeat(64),
      integrity: { available: false, reason: null },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => response(data)),
    )
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await screen.findByRole('combobox', { name: 'Drawdown source receipt' })
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved drawdown episodes' })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByRole('option', { name: /Unverifiable/ }).hasAttribute('disabled')).toBe(true)
  })

  it('preserves selected draft across same-account checking and version changes while clearing accepted analysis', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(() => response(result()))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText('Drawdown episodes verified')
    view.rerender(<WorkflowPathDrawdowns accountId={accountId} accountVersion={null} t={t} />)
    expect(
      (screen.getByRole('combobox', { name: 'Drawdown source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    expect(screen.queryByText('Drawdown episodes verified')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved drawdown episodes' })
        .hasAttribute('disabled'),
    ).toBe(true)
    view.rerender(<WorkflowPathDrawdowns accountId={accountId} accountVersion={2} t={t} />)
    expect(
      (screen.getByRole('combobox', { name: 'Drawdown source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    expect(
      screen
        .getByRole('button', { name: 'Inspect saved drawdown episodes' })
        .hasAttribute('disabled'),
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts a late analysis and clears all selections when switching accounts', async () => {
    let finish: (response: Response) => void = () => undefined
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(listing()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    view.rerender(<WorkflowPathDrawdowns accountId={'e'.repeat(32)} accountVersion={1} t={t} />)
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Drawdown source receipt' })).toBeNull()
    await act(async () => finish(new Response(JSON.stringify(result()))))
    expect(screen.queryByText('Drawdown episodes verified')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
  })

  it('preserves missing analysis as dashes while retaining original recorded values', async () => {
    const value = result()
    value.analysis = {
      ...value.analysis,
      status: 'unavailable',
      reasons: ['drawdown_saved_metric_mismatch'],
      summary: null,
      episodes: null,
      curve: null,
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText('Drawdown analysis unavailable')
    expect(
      screen.getByText('Observed drawdown does not reconcile with the saved maximum drawdown.'),
    ).toBeTruthy()
    expect(screen.getByText('-20.00')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
    expect(screen.queryByRole('img', { name: /Daily drawdown/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Download complete/ })).toBeTruthy()
  })

  it('shows no episodes as known zero without inventing duration', async () => {
    const value = result()
    value.analysis.episodes = []
    value.analysis.summary = {
      ...value.analysis.summary!,
      episode_count: 0,
      open_episode_count: 0,
      max_drawdown_pct: 0,
      unrecovered_at_end: false,
      total_underwater_sessions: 0,
      longest_observed_elapsed_sessions: null,
      longest_observed_underwater_sessions: 0,
    }
    value.analysis.curve = value.analysis.curve!.map((point) => ({
      ...point,
      nav: 100,
      drawdown_pct: 0,
      episode: null,
    }))
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() => response(value)),
    )
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText(
      'No drawdown was observed in this saved window. Drawdown and counts are 0; episode durations are —.',
    )
    expect(screen.queryByText(/Still unrecovered/)).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('downloads the exact accepted response text including the original without another request', async () => {
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
        return 'blob:synthetic'
      }),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    const download = await screen.findByRole('button', {
      name: 'Download complete original receipt and drawdown analysis JSON',
    })
    fireEvent.click(download)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(click).toHaveBeenCalledOnce()
    expect(blobs).toHaveLength(1)
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0])
    })
    expect(downloaded).toBe(raw)
  })

  it.each(['wrong_account', 'wrong_fingerprint', 'wrong_version', 'oversized'])(
    'rejects %s response without exporting it',
    async (mode) => {
      const value = result()
      if (mode === 'wrong_account') value.account_id = 'e'.repeat(32)
      if (mode === 'wrong_fingerprint') value.request.expected_fingerprint = 'e'.repeat(64)
      if (mode === 'wrong_version') value.account_version = 2
      const raw = mode === 'oversized' ? ' '.repeat(3 * 1024 * 1024 + 1) : JSON.stringify(value)
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => response(listing()))
          .mockResolvedValueOnce(new Response(raw)),
      )
      render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
      load()
      await select()
      inspect()
      await screen.findByRole('alert')
      expect(screen.queryByText('Drawdown episodes verified')).toBeNull()
      expect(screen.queryByRole('button', { name: /Download complete/ })).toBeNull()
    },
  )

  it('displays a conflict and retains the selected draft for an explicit retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => response(listing()))
        .mockImplementationOnce(() =>
          response({ detail: { code: 'drawdown_account_changed' } }, 409),
        ),
    )
    render(<WorkflowPathDrawdowns accountId={accountId} accountVersion={1} t={t} />)
    load()
    await select()
    inspect()
    await screen.findByText('The account version changed; inspect again.')
    expect(
      (screen.getByRole('combobox', { name: 'Drawdown source receipt' }) as HTMLSelectElement)
        .value,
    ).toBe(receiptId)
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Inspect saved drawdown episodes' })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
  })
})
