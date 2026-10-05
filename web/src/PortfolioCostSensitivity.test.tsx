import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortfolioCostSensitivity, type CostSensitivityReport } from './PortfolioCostSensitivity'
import type { PaperPreview } from './paper-model'

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())
const preview = (): PaperPreview => ({
  engine_version: 'alphaview-paper-portfolio-v2',
  account_id: 'synthetic-costs',
  account_version: 1,
  as_of: '2024-01-05',
  input_revision: 'synthetic:1',
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  targets: [{ symbol: 'SYNTA', weight_pct: 30 }],
  coverage: { required: 1, priced: 1, missing: [] },
  valuation_complete: true,
  equity_before: 10000,
  cash_before: 10000,
  cash_after: 7000,
  cash_weight_after_pct: 70,
  turnover_pct: 30,
  cost_total: 0,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 30,
      reference_price: 100,
      notional: 3000,
      current_shares: 0,
      target_shares: 30,
      target_weight_pct: 30,
      projected_weight_pct: 30,
    },
  ],
  violations: [],
  executable: true,
  method: 'Synthetic preview.',
  warnings: [],
})
const report = (): CostSensitivityReport => ({
  engine_version: 'alphaview-paper-cost-sensitivity-v1',
  paper_engine_version: preview().engine_version,
  account_id: preview().account_id,
  account_version: 1,
  input_revision: 'synthetic:1',
  as_of: '2024-01-05',
  targets: preview().targets,
  baseline: { cost_total: 0, orders: preview().orders },
  liquidity: {
    status: 'complete',
    coverage: { required: 1, available: 1, unavailable: 0 },
    orders: [
      {
        symbol: 'SYNTA',
        side: 'buy',
        shares: 30,
        session_volume: 1000,
        participation_pct: 3,
        status: 'available',
        reason: null,
      },
    ],
  },
  scenarios: [
    {
      fee_bps: 100,
      slippage_bps: 100,
      status: 'calculated',
      fees_total: 30.3,
      slippage_total: 30,
      cost_total: 60.3,
      cost_change_vs_baseline: 60.3,
      cash_after: 6939.7,
      equity_after: 9939.7,
      violations: [],
      reason: null,
    },
  ],
  method: 'Synthetic fixed-order repricing.',
})
const response = (body: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('fixed-order cost sensitivity', () => {
  it('requests only on demand with exact source identity and shows costs separately from participation', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(report()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    expect(await screen.findByRole('table', { name: 'Cost assumption comparison' })).toBeTruthy()
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      expected_version: 1,
      expected_input_revision: 'synthetic:1',
      expected_as_of: '2024-01-05',
      expected_engine_version: preview().engine_version,
      targets: preview().targets,
      expected_orders: [{ symbol: 'SYNTA', side: 'buy', shares: 30, reference_price: 100 }],
      fee_bps: [0, 10, 25],
      slippage_bps: [0, 10, 50],
    })
    expect(fetcher.mock.calls[0][0]).toBe('/api/paper/accounts/synthetic-costs/cost-sensitivity')
    expect(screen.getByText('$6,939.70')).toBeTruthy()
    expect(screen.getByText('3.0000%')).toBeTruthy()
    expect(screen.getByText(/not executable capacity or a slippage estimate/)).toBeTruthy()
  })

  it.each(['', '0, 0', '10,', '1001', '0,1,2,3,4,5', 'NaN'])(
    'rejects invalid or empty grids %s before fetch',
    (text) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
      fireEvent.change(screen.getByLabelText('Fee assumptions (bps)'), { target: { value: text } })
      expect(
        (screen.getByRole('button', { name: 'Compare cost assumptions' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true)
      expect(screen.getByRole('alert').textContent).toContain('cannot be empty')
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each([{ executable: false }, { valuation_complete: false }, { orders: [] }])(
    'explains unavailable preview %o',
    (changes) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      render(<PortfolioCostSensitivity preview={{ ...preview(), ...changes }} locale="en" />)
      expect(screen.getByText(/First create a preview that passes limits/)).toBeTruthy()
      expect(
        (screen.getByRole('button', { name: 'Compare cost assumptions' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it('keeps missing volume unavailable and shows cost-limit blocks', async () => {
    const data = report()
    data.liquidity.status = 'incomplete'
    data.liquidity.coverage = { required: 1, available: 0, unavailable: 1 }
    data.liquidity.orders[0] = {
      ...data.liquidity.orders[0],
      session_volume: null,
      participation_pct: null,
      status: 'unavailable',
      reason: 'missing_session_volume',
    }
    data.scenarios[0].status = 'blocked'
    data.scenarios[0].violations = [{ code: 'min_cash_weight', message: 'Synthetic cash limit.' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(data)),
    )
    render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    const table = within(await screen.findByRole('table', { name: 'Volume participation' }))
    expect(table.getAllByText('—')).toHaveLength(2)
    expect(table.getByText('missing_session_volume')).toBeTruthy()
    expect(screen.getByText(/Synthetic cash limit/)).toBeTruthy()
    expect(screen.queryByText('0.0000%')).toBeNull()
  })

  it('prevents repeat submissions and ignores cancelled late responses', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    const button = screen.getByRole('button', { name: 'Compare cost assumptions' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(report())))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('preserves assumption drafts across versions and remounts, aborting stale requests', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    fireEvent.change(screen.getByLabelText('Fee assumptions (bps)'), {
      target: { value: '75, 100' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    view.rerender(
      <PortfolioCostSensitivity preview={{ ...preview(), account_version: 2 }} locale="en" />,
    )
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect((screen.getByLabelText('Fee assumptions (bps)') as HTMLInputElement).value).toBe(
      '75, 100',
    )
    await act(async () => delayed.resolve(response(report())))
    expect(screen.queryByRole('table')).toBeNull()
    view.unmount()
    render(<PortfolioCostSensitivity preview={{ ...preview(), account_version: 2 }} locale="en" />)
    expect((screen.getByLabelText('Fee assumptions (bps)') as HTMLInputElement).value).toBe(
      '75, 100',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('isolates account drafts and aborts on unmount', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    fireEvent.change(screen.getByLabelText('Fee assumptions (bps)'), { target: { value: '88' } })
    view.rerender(
      <PortfolioCostSensitivity
        preview={{ ...preview(), account_id: 'another-synthetic' }}
        locale="en"
      />,
    )
    expect((screen.getByLabelText('Fee assumptions (bps)') as HTMLInputElement).value).toBe(
      '0, 10, 25',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    view.unmount()
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(report())))
  })

  it('rejects a response for an outdated preview and reports server conflicts', async () => {
    const fetcher = vi
      .fn(async () => response({ ...report(), input_revision: 'stale:1' }))
      .mockImplementationOnce(async () => response({ detail: 'Synthetic version conflict.' }, 409))
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioCostSensitivity preview={preview()} locale="en" />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic version conflict.')
    await userEvent.click(screen.getByRole('button', { name: 'Compare cost assumptions' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Source preview changed')
    expect(screen.queryByRole('table')).toBeNull()
  })
})
