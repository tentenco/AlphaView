import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PortfolioPaperPerformance } from './PortfolioPaperPerformance'
import {
  navChartData,
  type PaperNavCapture,
  type PaperNavPoint,
  type PaperNavReport,
} from './paper-performance'
import type { PaperSnapshot } from './paper-model'

const snapshot: PaperSnapshot = {
  engine_version: 'alphaview-paper-v2',
  as_of: '2026-09-18',
  input_revision: 'synthetic:1',
  account: {
    id: 'synthetic-nav-account',
    name: 'Synthetic NAV account',
    currency: 'USD',
    initial_cash: 10000,
    cash: 10000,
    version: 1,
    kill_switch: false,
    limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
    created_at: '2026-09-15T22:00:00Z',
    updated_at: '2026-09-15T22:00:00Z',
  },
  holdings: [],
  coverage: { required: 0, priced: 0, missing: [] },
  valuation_complete: true,
  equity: 10000,
  holdings_value: 0,
  cash_weight_pct: 100,
  unrealized_pnl: 0,
  realized_pnl: 0,
  total_return_pct: 0,
  ledger: [],
  proposals: [],
  method: 'Synthetic paper account.',
  warnings: [],
}
function point(
  as_of: string,
  equity: number | null,
  status: PaperNavPoint['status'] = equity == null ? 'not_captured' : 'complete',
): PaperNavPoint {
  return {
    as_of,
    equity,
    status,
    snapshot_id: status === 'not_captured' ? null : Number(as_of.slice(-2)),
    observed_at: status === 'not_captured' ? null : `${as_of}T22:00:00Z`,
    account_version: status === 'not_captured' ? null : 1,
    input_revision: status === 'not_captured' ? null : 'synthetic:1',
    coverage: status === 'not_captured' ? null : { required: 0, priced: 0, missing: [] },
    return_pct: null,
  }
}
function navReport(extra: Partial<PaperNavReport> = {}): PaperNavReport {
  return {
    engine_version: 'alphaview-paper-analytics-v1',
    as_of: '2026-09-18',
    input_revision: 'synthetic:1',
    account_version: 1,
    current: {
      account_id: snapshot.account.id,
      account_version: 1,
      as_of: '2026-09-18',
      input_revision: 'synthetic:1',
      paper_engine_version: 'alphaview-paper-v2',
      cash: 10000,
      initial_cash: 10000,
      equity: 10000,
      holdings_value: 0,
      valuation_complete: true,
      coverage: { required: 0, priced: 0, missing: [] },
      total_return_pct: 0,
    },
    series: [],
    summary: {
      captured_count: 0,
      observed_sessions: 0,
      complete_count: 0,
      missing_count: 0,
      start: null,
      end: null,
      period_return_pct: null,
      max_drawdown_pct: null,
      performance_available: false,
      reason: '尚未擷取虛擬帳戶淨值',
      truncated: false,
    },
    costs: {
      simulated_fill_count: 0,
      buy_notional: 0,
      sell_notional: 0,
      fees_total: 0,
      slippage_total: 0,
      cost_total: 0,
      turnover_pct_sum: 0,
    },
    method: 'Synthetic observed NAV method.',
    warnings: [],
    ...extra,
  }
}
function captured(created = true): PaperNavCapture {
  return {
    engine_version: 'alphaview-paper-analytics-v1',
    snapshot: {
      ...navReport().current,
      id: 1,
      engine_version: 'alphaview-paper-analytics-v1',
      observed_at: '2026-09-18T22:30:00Z',
    },
    created,
    method: 'Synthetic capture.',
    warnings: [],
  }
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('paper NAV observations', () => {
  it('reads without mutation, captures explicitly with versions, and reports a reused observation honestly', async () => {
    let captureCount = 0
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response(captured(++captureCount === 1))
      return response(navReport())
    })
    vi.stubGlobal('fetch', fetcher)
    const onCaptured = vi.fn()
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" onCaptured={onCaptured} />)
    expect(await screen.findByText('No paper NAV has been captured yet.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /Captured paper NAV chart/ })).toBeNull()
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Capture current paper NAV' }))
    expect(
      await screen.findByText('A new NAV observation was saved.', { exact: false }),
    ).toBeTruthy()
    const captureCall = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(captureCall?.[1]?.body))).toEqual({
      expected_version: 1,
      expected_input_revision: 'synthetic:1',
    })
    expect(onCaptured).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Capture current paper NAV' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    await user.click(screen.getByRole('button', { name: 'Capture current paper NAV' }))
    expect(await screen.findByText(/original record is retained/)).toBeTruthy()
    expect(onCaptured).toHaveBeenCalledTimes(2)
  })

  it('leaves a gap between separated captures and does not display invented period metrics', async () => {
    const series = [
      point('2026-09-16', 10000),
      point('2026-09-17', null),
      point('2026-09-18', 10200),
    ]
    const report = navReport({
      series,
      summary: {
        ...navReport().summary,
        captured_count: 2,
        observed_sessions: 3,
        complete_count: 2,
        missing_count: 1,
        start: '2026-09-16',
        end: '2026-09-18',
        reason: '觀察區間含缺價或未擷取交易日',
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(report)))
    const view = render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    const chart = await screen.findByRole('img', { name: /Captured paper NAV chart/ })
    expect(chart.querySelectorAll('polyline[data-nav-segment]').length).toBe(0)
    expect(chart.querySelectorAll('circle').length).toBe(2)
    expect(chart.querySelectorAll('.paper-nav-gap').length).toBe(1)
    expect(screen.getByText(/Period return and maximum drawdown remain unavailable/)).toBeTruthy()
    const metrics = view.container.querySelector('.paper-nav-metrics')!
    expect(
      within(metrics as HTMLElement)
        .getByText('Observation-window return')
        .parentElement?.querySelector('strong')?.textContent,
    ).toBe('—')
    const details = screen.getByRole('region', { name: 'Daily observation details' })
    const missingRow = within(details).getByText('2026-09-17').closest('tr')!
    expect(within(missingRow).getByText('Not captured')).toBeTruthy()
    expect(within(missingRow).getAllByRole('cell')[2].textContent).toBe('—')
    expect(within(missingRow).getAllByRole('cell')[3].textContent).toBe('—')
  })

  it('keeps a valid zero return and zero drawdown visible for complete observations', async () => {
    const report = navReport({
      series: [point('2026-09-17', 10000), { ...point('2026-09-18', 10000), return_pct: 0 }],
      summary: {
        ...navReport().summary,
        captured_count: 2,
        observed_sessions: 2,
        complete_count: 2,
        start: '2026-09-17',
        end: '2026-09-18',
        period_return_pct: 0,
        max_drawdown_pct: 0,
        performance_available: true,
        reason: null,
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(report)))
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    const chart = await screen.findByRole('img', { name: /Captured paper NAV chart/ })
    expect(chart.querySelectorAll('polyline[data-nav-segment]').length).toBe(1)
    for (const label of ['Observation-window return', 'Observed maximum drawdown'])
      expect(screen.getByText(label).parentElement?.querySelector('strong')?.textContent).toBe(
        '0.00%',
      )
    expect(screen.queryByText(/Period return and maximum drawdown remain unavailable/)).toBeNull()
  })

  it('records incomplete observations without treating partial holdings as total NAV', async () => {
    const current = {
      ...navReport().current,
      equity: null,
      valuation_complete: false,
      total_return_pct: null,
      coverage: { required: 2, priced: 1, missing: ['SYNTB'] },
    }
    const report = navReport({ current })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? response({ ...captured(), snapshot: { ...captured().snapshot, ...current } })
          : response(report),
      ),
    )
    render(
      <PortfolioPaperPerformance
        snapshot={{ ...snapshot, valuation_complete: false, equity: null }}
        locale="en"
      />,
    )
    expect(await screen.findByText(/partial holdings are not treated as total NAV/)).toBeTruthy()
    expect(
      screen.getByText('Current paper NAV').parentElement?.querySelector('strong')?.textContent,
    ).toBe('—')
    await userEvent.click(screen.getByRole('button', { name: 'Capture current paper NAV' }))
    expect(await screen.findByText(/This observation has missing prices/)).toBeTruthy()
  })

  it('rejects stale capture without adding an observation or calling the success callback', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({ detail: '擷取前行情版本已變更，請重新載入虛擬帳戶' }, 409)
        : response(navReport()),
    )
    vi.stubGlobal('fetch', fetcher)
    const onCaptured = vi.fn()
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" onCaptured={onCaptured} />)
    await screen.findByText('No paper NAV has been captured yet.')
    await userEvent.click(screen.getByRole('button', { name: 'Capture current paper NAV' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onCaptured).not.toHaveBeenCalled()
    expect(screen.queryByText('A new NAV observation was saved.', { exact: false })).toBeNull()
    expect(screen.queryByRole('img', { name: /Captured paper NAV chart/ })).toBeNull()
  })

  it('changes the observation window with read-only requests and labels costs as lifetime totals', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(
        navReport({
          costs: {
            simulated_fill_count: 3,
            buy_notional: 1600,
            sell_notional: 500,
            fees_total: 2,
            slippage_total: 1,
            cost_total: 3,
            turnover_pct_sum: 21,
          },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    await screen.findByText(/These totals cover the account’s lifetime/)
    await userEvent.selectOptions(screen.getByLabelText('Observation window'), '60')
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('window_sessions=60'))).toBe(
        true,
      ),
    )
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
    expect(
      screen.getByText('Sum of gross turnover').parentElement?.querySelector('strong')?.textContent,
    ).toBe('21.00%')
  })

  it('does not allow capturing against an account snapshot older than the report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(navReport({ account_version: 2 }))))
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    expect(await screen.findByText(/Reload the paper account before capturing/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Capture current paper NAV' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})

describe('NAV chart data gaps', () => {
  it('separates complete runs at uncaptured and incomplete sessions, preserving original indices', () => {
    const series = [
      point('2026-09-14', 100),
      point('2026-09-15', 110),
      point('2026-09-16', null),
      point('2026-09-17', 120),
      point('2026-09-18', null, 'incomplete'),
    ]
    const data = navChartData(series)
    expect(data.segments.map((segment) => segment.map((item) => item.index))).toEqual([[0, 1], [3]])
    expect(data.gaps.map((gap) => gap.index)).toEqual([2, 4])
    expect(navChartData([point('2026-09-18', null)]).domain).toBeNull()
    expect(navChartData([point('2026-09-18', 0)]).segments[0][0].value).toBe(0)
  })
})

describe('paper advanced metrics', () => {
  const metrics = (): NonNullable<PaperNavReport['metrics']> => ({
    method_version: 'alphaview-paper-metrics-v1',
    available: true,
    reason: null,
    returns_n: 3,
    low_sample: true,
    risk: {
      annualized_return_pct: 427.7,
      annualized_volatility_pct: 24.3,
      sharpe: 6.94,
      sortino: 18.42,
      calmar: 427.7,
      mean_daily_return_pct: 0.67,
      best_day_pct: 2.01,
      worst_day_pct: -1,
      positive_days: 2,
      negative_days: 1,
      reasons: {},
    },
    drawdown: {
      max_drawdown_pct: 1,
      longest_underwater_sessions: 1,
      longest_underwater_from: '2026-09-16',
      longest_underwater_to: '2026-09-17',
      underwater_ongoing: false,
      current_drawdown_pct: 0,
    },
    benchmark: {
      symbol: 'SPY',
      available: false,
      reason: 'benchmark_unavailable',
      coverage: { required: 4, priced: 3, missing: ['2026-09-17'] },
    },
    costs: {
      cost_total: 12.5,
      cost_drag_pct_of_initial: 0.125,
      net_return_since_funding_pct: 2,
      gross_return_since_funding_pct: 2.125,
      reason: null,
    },
    method: 'Synthetic metrics method.',
    warnings: ['Synthetic metrics warning.'],
  })

  it('shows ratios with the small-sample notice and an unfilled benchmark reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(navReport({ metrics: metrics() }))))
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    expect(await screen.findByText('18.42')).toBeTruthy()
    expect(screen.getByText(/Only 3 daily returns/)).toBeTruthy()
    expect(screen.getByText('Benchmark prices are incomplete; nothing is filled')).toBeTruthy()
    expect(screen.getByText('· 3/4')).toBeTruthy()
    expect(screen.getByText('2.00% / 2.13%')).toBeTruthy()
  })

  it('states why advanced metrics are unavailable instead of showing zeros', async () => {
    const unavailable = {
      ...metrics(),
      available: false,
      reason: '觀察區間含缺價或未擷取交易日',
      risk: null,
      drawdown: null,
      benchmark: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(navReport({ metrics: unavailable }))))
    render(<PortfolioPaperPerformance snapshot={snapshot} locale="en" />)
    expect(await screen.findByText(/Advanced metrics unavailable/)).toBeTruthy()
    expect(screen.queryByText('Sortino')).toBeNull()
    expect(screen.getByText('0.13%')).toBeTruthy()
  })
})
