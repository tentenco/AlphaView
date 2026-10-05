import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionVolumeStudy, type ExecutionVolumeEvidence } from './ExecutionVolumeStudy'
import type { PaperProposal } from './paper-model'

const t = (_zh: string, en: string) => en
const proposal = {
  id: 'b'.repeat(32),
  account_id: 'a'.repeat(32),
  account_version: 1,
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2024-01-05',
  input_revision: 'synthetic:1',
  status: 'proposed',
  created_at: '2024-01-06T12:00:00Z',
  accepted_at: null,
  executable: true,
  orders: [
    { symbol: 'SYNTA', side: 'buy', shares: 30, reference_price: 100 },
    { symbol: 'SYNTB', side: 'sell', shares: 20, reference_price: 50 },
  ],
} as PaperProposal
const props = {
  accountId: proposal.account_id,
  proposal,
  currentAccountVersion: 1,
  currentInputRevision: 'synthetic:2',
  currentAsOf: '2024-01-08',
  t,
}
const result = (): ExecutionVolumeEvidence => ({
  engine_version: 'alphaview-execution-volume-study-v1',
  account_id: proposal.account_id,
  account_version: 1,
  input_revision: 'synthetic:2',
  as_of: '2024-01-08',
  source: {
    id: proposal.id,
    account_id: proposal.account_id,
    account_version: 1,
    engine_version: proposal.engine_version,
    created_at: proposal.created_at,
    status: proposal.status,
    as_of: proposal.as_of,
    input_revision: proposal.input_revision,
    proposal_fingerprint: 'c'.repeat(64),
    current: false,
    stale_reasons: ['inputs_changed', 'session_changed'],
    available: true,
    reason: null,
    share_precision: 6,
    skipped_orders_count: 1,
    orders: proposal.orders.map((row) => ({
      symbol: row.symbol,
      side: row.side,
      shares: row.shares,
      shares_exact: row.shares.toFixed(6),
      reference_price: row.reference_price,
    })),
  },
  execution_session: '2024-01-08',
  session_completed: true,
  time_in_force: 'DAY',
  mode: 'advisory_ex_post',
  method: 'Synthetic saved capacity method; full-day volume is unknown at the open.',
  warnings: [],
  request: {
    expected_account_version: 1,
    expected_input_revision: 'synthetic:2',
    expected_as_of: '2024-01-08',
    expected_proposal_fingerprint: 'c'.repeat(64),
    participation_pct: 1,
  },
  bars_fingerprint: 'd'.repeat(64),
  status: 'incomplete',
  coverage: { required: 2, available: 1, unavailable: 1 },
  reason: null,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 30,
      shares_exact: '30.000000',
      reference_price: 100,
      status: 'partial_expired',
      reason: null,
      raw_open: 110,
      session_volume: 1000,
      capacity_shares: 10,
      scenario_shares: 10,
      expired_shares: 20,
      fill_fraction_pct: 100 / 3,
      reference_notional: 1100,
    },
    {
      symbol: 'SYNTB',
      side: 'sell',
      shares: 20,
      shares_exact: '20.000000',
      reference_price: 50,
      status: 'unavailable',
      reason: 'missing_execution_bar',
      raw_open: null,
      session_volume: null,
      capacity_shares: null,
      scenario_shares: null,
      expired_shares: null,
      fill_fraction_pct: null,
      reference_notional: null,
    },
  ],
})
const response = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }))
function mockStudy(value = result()) {
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(value))
    .mockImplementationOnce(() => response(value))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function run() {
  await userEvent.click(screen.getByRole('button', { name: 'Study saved proposal capacity' }))
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saved proposal volume capacity evidence', () => {
  it('downloads the accepted raw study text, preserving float syntax, nulls and future fields', async () => {
    const raw = JSON.stringify(result()).replace(
      /}$/,
      ',"future":{"float":1.0,"negative_zero":-0.0,"exponent":1e-07,"missing":null}}\n',
    )
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:raw-volume')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = render(<ExecutionVolumeStudy {...props} />)
    await run()
    const button = await screen.findByRole('button', { name: 'Download capacity evidence JSON' })
    fireEvent.click(button)
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(downloaded).toBe(raw)
    expect(fetcher).toHaveBeenCalledTimes(2)
    view.rerender(<ExecutionVolumeStudy {...props} accountId={'e'.repeat(32)} />)
    expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
    fireEvent.click(button)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('rejects nonfinite raw values during export and clears export while replacing evidence', async () => {
    const raw = JSON.stringify(result()).replace(/}$/, ',"future":1e999}')
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockResolvedValueOnce(new Response(raw))
    vi.stubGlobal('fetch', fetcher)
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    fireEvent.click(await screen.findByRole('button', { name: 'Download capacity evidence JSON' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Volume evidence download failed')
    expect(createObjectURL).not.toHaveBeenCalled()
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    await run()
    expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
  })

  it('is explicit, binds the request and shows partial expiry, nulls and historical source scope', async () => {
    const fetcher = mockStudy()
    render(<ExecutionVolumeStudy {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/Full-day volume is unknown at the open/)).toBeTruthy()
    await run()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/paper/accounts/${proposal.account_id}/proposals/${proposal.id}/volume-study/context`,
    )
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(result().request)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]).getByText('Scenario partial; remainder expired')).toBeTruthy()
    expect(within(rows[1]).getByText('30.000000')).toBeTruthy()
    expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
    expect(within(rows[2]).getByText(/Exact execution-day bar is missing/)).toBeTruthy()
    expect(screen.getByText(/Evidence coverage.*1 \/ 2/)).toBeTruthy()
    expect(screen.getByText(/Historical proposal: original quantities/)).toBeTruthy()
    expect(screen.getByText('c'.repeat(64))).toBeTruthy()
    expect(
      fetcher.mock.calls.every(
        ([, options]) => !options?.body || JSON.parse(options.body).participation_pct === 1,
      ),
    ).toBe(true)
  })

  it('guards a double click synchronously and aborts an account-switched pending response', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionVolumeStudy {...props} />)
    const button = screen.getByRole('button', { name: 'Study saved proposal capacity' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    view.rerender(<ExecutionVolumeStudy {...props} accountId={'e'.repeat(32)} />)
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(await response(result())))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('table')).toBeNull()
  })

  it.each(['revision', 'version', 'proposal', 'enabled'] as const)(
    'invalidates old evidence when %s changes',
    async (kind) => {
      mockStudy()
      const view = render(<ExecutionVolumeStudy {...props} />)
      await run()
      await screen.findByRole('table')
      const changed = {
        ...props,
        ...(kind === 'revision' ? { currentInputRevision: 'synthetic:3' } : {}),
        ...(kind === 'version' ? { currentAccountVersion: 2 } : {}),
        ...(kind === 'proposal' ? { proposal: { ...proposal, id: 'e'.repeat(32) } } : {}),
        ...(kind === 'enabled' ? { enabled: false } : {}),
      }
      view.rerender(<ExecutionVolumeStudy {...changed} />)
      expect(screen.queryByRole('table')).toBeNull()
      view.rerender(<ExecutionVolumeStudy {...props} />)
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('clears evidence on cap changes and rejects empty or out-of-range caps without a request', async () => {
    const fetcher = mockStudy()
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    await screen.findByRole('table')
    const input = screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' })
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Study saved proposal capacity' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.change(input, { target: { value: '101' } })
    expect(
      (screen.getByRole('button', { name: 'Study saved proposal capacity' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not revive evidence after a hidden-tab lifecycle change', async () => {
    const fetcher = mockStudy()
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    await screen.findByRole('table')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.queryByRole('table')).toBeNull()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('table')).toBeNull()
    visibility.mockRestore()
  })

  it.each(['account', 'orders', 'version'] as const)(
    'rejects a mismatching server %s context before POST',
    async (kind) => {
      const value = result()
      if (kind === 'account') value.account_id = 'e'.repeat(32)
      if (kind === 'orders') value.source.orders[0].shares = 99
      if (kind === 'version') value.account_version = 2
      const fetcher = mockStudy(value)
      render(<ExecutionVolumeStudy {...props} />)
      await run()
      expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('409 during study clears any previous result and never reports success', async () => {
    const fetcher = mockStudy()
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    await screen.findByRole('table')
    fetcher
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() => response({ detail: { code: 'study_context_changed' } }, 409))
    await run()
    expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('rejects a result with another fingerprint or participation hypothesis', async () => {
    const changed = result()
    changed.request.participation_pct = 10
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response(result()))
      .mockImplementationOnce(() => response(changed))
    vi.stubGlobal('fetch', fetcher)
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    expect((await screen.findByRole('alert')).textContent).toContain('Study sources changed')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders an observed zero as zero while missing evidence remains unavailable', async () => {
    const value = result()
    Object.assign(value.orders[0], {
      status: 'unfilled_expired',
      session_volume: 0,
      capacity_shares: 0,
      scenario_shares: 0,
      expired_shares: 30,
      fill_fraction_pct: 0,
      reference_notional: 0,
    })
    mockStudy(value)
    render(<ExecutionVolumeStudy {...props} />)
    await run()
    const rows = within(await screen.findByRole('table')).getAllByRole('row')
    expect(within(rows[1]).getByText('Scenario unfilled; all expired')).toBeTruthy()
    expect(within(rows[1]).getAllByText('0.000000')).toHaveLength(3)
    expect(within(rows[2]).getAllByText('—')).toHaveLength(6)
  })
})

it.each(['enabled', 'version', 'revision', 'session', 'proposal_refresh'] as const)(
  'preserves an unsent participation draft through same-proposal %s refresh',
  (change) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionVolumeStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      {
        target: { value: '7.25' },
      },
    )
    const next = {
      ...props,
      ...(change === 'enabled' ? { enabled: false } : {}),
      ...(change === 'version' ? { currentAccountVersion: 2 } : {}),
      ...(change === 'revision' ? { currentInputRevision: 'synthetic:3' } : {}),
      ...(change === 'session' ? { currentAsOf: '2024-01-09' } : {}),
      ...(change === 'proposal_refresh' ? { proposal: { ...proposal, executable: false } } : {}),
    }
    view.rerender(<ExecutionVolumeStudy {...next} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '7.25')
    view.rerender(<ExecutionVolumeStudy {...props} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '7.25')
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it.each(['account', 'proposal'] as const)(
  'resets drafts only on an actual %s scope switch',
  (change) => {
    vi.stubGlobal('fetch', vi.fn())
    const view = render(<ExecutionVolumeStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      { target: { value: '7.25' } },
    )

    const changed = {
      ...props,
      ...(change === 'account'
        ? { accountId: 'e'.repeat(32) }
        : { proposal: { ...proposal, id: 'e'.repeat(32) } }),
    }
    view.rerender(<ExecutionVolumeStudy {...changed} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '1')

    view.rerender(<ExecutionVolumeStudy {...props} />)
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '1')
  },
)

it.each([
  ['context', 'success'],
  ['context', 'error'],
  ['result', 'success'],
  ['result', 'error'],
] as const)(
  'discards late %s %s after source changes away and back without losing the participation draft',
  async (stage, outcome) => {
    let finish!: (value: Response) => void
    let fail!: (reason: Error) => void
    const pending = new Promise<Response>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const value = result()
    value.request.participation_pct = 7.25
    const fetcher = vi.fn()
    if (stage === 'result') fetcher.mockImplementationOnce(() => response(value))
    fetcher.mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionVolumeStudy {...props} />)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
      { target: { value: '7.25' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal capacity' }))
    const calls = stage === 'context' ? 1 : 2
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(calls))
    const signal = fetcher.mock.calls[calls - 1][1].signal as AbortSignal
    view.rerender(<ExecutionVolumeStudy {...props} currentInputRevision="synthetic:changed" />)
    view.rerender(<ExecutionVolumeStudy {...props} />)
    expect(signal.aborted).toBe(true)
    await act(async () => {
      if (outcome === 'success') finish(await response(value))
      else fail(new Error('Old async failure'))
    })
    expect(
      screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
    ).toHaveProperty('value', '7.25')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(fetcher).toHaveBeenCalledTimes(calls)
    fetcher
      .mockImplementationOnce(() => response(value))
      .mockImplementationOnce(() => response(value))
    await run()
    await screen.findByRole('table')
    expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
      'disabled',
      false,
    )
  },
)

it('does not revive a pending result when the draft changes away and back', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(result()))
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  render(<ExecutionVolumeStudy {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal capacity' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const signal = fetcher.mock.calls[1][1].signal as AbortSignal
  const input = screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' })
  fireEvent.change(input, { target: { value: '7.25' } })
  fireEvent.change(input, { target: { value: '1' } })
  expect(signal.aborted).toBe(true)
  await act(async () => finish(await response(result())))
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
})

it('keeps historical receipt controls mounted and readable while accepted evidence is invalidated', async () => {
  const fetcher = mockStudy()
  const view = render(<ExecutionVolumeStudy {...props} />)
  const historySection = screen.getByRole('region', { name: 'Execution study receipts' })
  const historyButton = within(historySection).getByRole('button', { name: 'Load study receipts' })
  await run()
  await screen.findByRole('table')
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
  const oldDownload = screen.getByRole('button', { name: 'Download capacity evidence JSON' })
  const createObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  view.rerender(<ExecutionVolumeStudy {...props} enabled={false} />)
  expect(screen.getByRole('region', { name: 'Execution study receipts' })).toBe(historySection)
  expect(screen.getByRole('button', { name: 'Load study receipts' })).toBe(historyButton)
  expect(historyButton).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.click(oldDownload)
  expect(createObjectURL).not.toHaveBeenCalled()
  fetcher.mockImplementationOnce(() =>
    response({
      account_id: props.accountId,
      proposal_id: proposal.id,
      kind: 'volume_day',
      items: [],
      pagination: { limit: 20, offset: 0, total: 0, returned: 0 },
      checked_as_of: '2026-10-01',
      checked_input_revision: 'synthetic:2',
    }),
  )
  fireEvent.click(historyButton)
  expect(await screen.findByText('This proposal has no receipts of this study kind')).toBeTruthy()
  expect(fetcher.mock.calls[2][0]).toContain('/study-receipts?kind=volume_day')
  view.rerender(<ExecutionVolumeStudy {...props} />)
  expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
})

it('preserves the participation draft but withdraws evidence for same-ID proposal content changes and reversion', async () => {
  const value = result()
  value.request.participation_pct = 7.25
  const fetcher = mockStudy(value)
  const view = render(<ExecutionVolumeStudy {...props} />)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }), {
    target: { value: '7.25' },
  })
  await run()
  await screen.findByRole('table')
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
  view.rerender(
    <ExecutionVolumeStudy
      {...props}
      proposal={{
        ...proposal,
        orders: proposal.orders.map((order, index) => (index ? order : { ...order, shares: 31 })),
      }}
    />,
  )
  expect(screen.queryByRole('table')).toBeNull()
  expect(
    screen.getByRole('spinbutton', { name: 'Daily volume participation cap (%)' }),
  ).toHaveProperty('value', '7.25')
  view.rerender(<ExecutionVolumeStudy {...props} />)
  expect(screen.queryByRole('button', { name: 'Download capacity evidence JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    true,
  )
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('ignores old async failure without clearing a newer request in progress', async () => {
  let rejectOld!: (error: Error) => void
  let finishNewContext!: (value: Response) => void
  const old = new Promise<Response>((_resolve, reject) => {
    rejectOld = reject
  })
  const next = new Promise<Response>((resolve) => {
    finishNewContext = resolve
  })
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => response(result()))
    .mockReturnValueOnce(old)
    .mockReturnValueOnce(next)
    .mockImplementationOnce(() => response(result()))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<ExecutionVolumeStudy {...props} />)
  await run()
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  view.rerender(<ExecutionVolumeStudy {...props} enabled={false} />)
  view.rerender(<ExecutionVolumeStudy {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Study saved proposal capacity' }))
  expect(fetcher).toHaveBeenCalledTimes(3)
  await act(async () => rejectOld(new Error('Superseded study failure')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true)
  await act(async () => finishNewContext(await response(result())))
  await screen.findByRole('table')
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(screen.getByRole('button', { name: 'Save study receipt' })).toHaveProperty(
    'disabled',
    false,
  )
})
