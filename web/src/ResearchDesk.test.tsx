import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchDesk } from './ResearchDesk'
import { catalog } from './test/research-desk-catalog'
import type { DeskDiagnosis, DeskMetrics, DeskResult } from './research-desk-model'

vi.mock('./Charts', () => ({ EquityChart: () => <div data-testid="equity-chart" /> }))
afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

const metrics = (changes: Partial<DeskMetrics> = {}): DeskMetrics => ({
  start: '2025-07-22',
  end: '2026-09-29',
  sessions: 300,
  final_equity: 120000,
  net_profit: 20000,
  return_pct: 20,
  cagr_pct: 16,
  max_drawdown_pct: -12,
  peak_equity: 125000,
  lowest_equity: 95000,
  sharpe_ratio: 1.1,
  annualized_volatility_pct: 20,
  closed_trades: 12,
  wins: 7,
  win_rate_pct: 58.3,
  gross_profit: 30000,
  gross_loss: 10000,
  profit_factor: 3,
  avg_trade_return_pct: 1.5,
  largest_win_pct: 9,
  largest_loss_pct: -6,
  max_consecutive_losses: 2,
  avg_holding_sessions: 8,
  exposure_pct: 45,
  open_position: false,
  invalid_signal_sessions: 0,
  excess_return_pct: -5,
  ...changes,
})
const aggregate = (excess: number) => ({
  symbols: 2,
  mean_return_pct: 10,
  mean_excess_return_pct: excess,
  beats_benchmark: excess > 0 ? 2 : 0,
  mean_max_drawdown_pct: -12,
  mean_sharpe_ratio: 1,
  pooled_closed_trades: 12,
  pooled_win_rate_pct: 58.3,
  pooled_profit_factor: 1.8,
  mean_exposure_pct: 45,
  open_positions: 0,
})
const result: DeskResult = {
  engine_version: 'alphaview-research-desk-v1',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  request: {
    symbols: ['SYNTA', 'SYNTB'],
    configs: [
      { strategy: 'buy_hold', params: {} },
      { strategy: 'sma_cross', params: { fast: 20, slow: 50 } },
    ],
    risk: {
      initial_cash: 100000,
      fee_bps: 10,
      slippage_bps: 0,
      position_pct: 100,
      stop_loss_pct: null,
      take_profit_pct: null,
    },
    start_date: null,
    end_date: null,
    oos_pct: 30,
    rank_by: 'excess_return',
    save: true,
  },
  rank_by: 'excess_return',
  configs_tested: 2,
  symbols: [
    {
      symbol: 'SYNTA',
      status: 'ok',
      error: null,
      windows: {
        full: { start: '2025-07-22', end: '2026-09-29', sessions: 300 },
        in_sample: { start: '2025-07-22', end: '2026-05-20', sessions: 210 },
        out_of_sample: { start: '2026-05-21', end: '2026-09-29', sessions: 90 },
      },
      out_of_sample_available: true,
    },
    {
      symbol: 'SYNTB',
      status: 'unavailable',
      error: { code: 'no_history', message: 'SYNTB 沒有本機日線' },
    },
  ],
  results: [],
  leaderboard: [
    {
      rank: 1,
      config_index: 0,
      config: { strategy: 'buy_hold', params: {} },
      label: '買入持有',
      label_en: 'Buy and hold',
      family: 'baseline',
      in_sample: aggregate(0),
      out_of_sample: aggregate(0),
      full: aggregate(0),
      rank_value: 0,
      flags: ['benchmark_strategy'],
    },
    {
      rank: 2,
      config_index: 1,
      config: { strategy: 'sma_cross', params: { fast: 20, slow: 50 } },
      label: '均線交叉 20/50',
      label_en: 'Moving-average crossover 20/50',
      family: 'trend',
      in_sample: aggregate(-12.5),
      out_of_sample: aggregate(3.25),
      full: aggregate(-8),
      rank_value: -12.5,
      flags: ['low_sample', 'beats_benchmark_minority'],
    },
  ],
  benchmark_summary: { full: 40, in_sample: 30, out_of_sample: 10 },
  method: 'Synthetic method.',
  warnings: ['Synthetic multiple-comparison warning.'],
  run_id: 'synthetic-run-000000',
}
const diagnosis: DeskDiagnosis = {
  engine_version: 'alphaview-research-desk-v1',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  symbol: 'SYNTA',
  config: { strategy: 'sma_cross', params: { fast: 20, slow: 50 } },
  label: '均線交叉 20/50',
  label_en: 'Moving-average crossover 20/50',
  window: { start: '2025-07-22', end: '2026-09-29', sessions: 300 },
  summary: metrics(),
  benchmark: metrics({ return_pct: 25, excess_return_pct: null }),
  curve: [{ date: '2025-07-22', value: 100000, benchmark: 100000 }],
  trades: [
    {
      signal_date: '2025-08-01',
      entry_date: '2025-08-04',
      entry_price: 100,
      exit_date: '2025-08-20',
      exit_price: 94,
      exit_reason: 'signal',
      units: 999,
      cost: 100000,
      entry_fee: 100,
      exit_fee: 94,
      net_pnl: -6100,
      return_pct: -6.1,
      holding_sessions: 12,
      holding_days: 16,
      rsi_at_signal: 55,
      volatility_at_signal_pct: 40,
      conditions: {
        trend: 'below_ma200',
        rsi_zone: 'strong',
        volatility: 'high',
        benchmark: 'unavailable',
        holding: 'medium',
        exit_reason: 'signal',
      },
    },
  ],
  open_position: null,
  conditions: {
    trend: [
      {
        bucket: 'below_ma200',
        trades: 1,
        wins: 0,
        win_rate_pct: 0,
        total_pnl: -6100,
        gross_loss: 6100,
        avg_return_pct: -6.1,
        worst_return_pct: -6.1,
        loss_share_pct: 100,
      },
    ],
    rsi_zone: [],
    volatility: [],
    benchmark: [],
    holding: [],
    exit_reason: [],
  },
  drawdowns: [
    {
      peak_date: '2025-08-01',
      trough_date: '2025-08-20',
      recovery_date: null,
      depth_pct: -6.2,
      sessions_to_trough: 13,
      sessions_to_recovery: null,
    },
  ],
  hypotheses: [
    {
      code: 'trend_losses',
      text: '100% 的虧損金額來自收盤低於 MA200 時進場（1 筆）',
      text_en: '100% of losses came from entries taken below the 200-day SMA (1 trades)',
      evidence: { loss_share_pct: 100 },
    },
  ],
  benchmark_symbol: 'SPY',
  fingerprint: 'abcdef1234567890',
  method: 'Synthetic diagnosis method.',
  warnings: ['Synthetic diagnosis warning.'],
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  blob: async () => new Blob(['csv']),
})
function mockApi(handler?: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = handler?.(url, init)
    if (custom !== undefined) return custom
    if (url === '/api/research-desk/catalog') return response(catalog)
    if (url === '/api/research-desk/presets' && (!init?.method || init.method === 'GET'))
      return response({ presets: [] })
    if (url === '/api/research-desk/presets' && init?.method === 'POST')
      return response({ id: 'preset', version: 1 }, 201)
    if (url === '/api/research-desk/runs?limit=50')
      return response({
        runs: [
          {
            id: 'synthetic-run-000000',
            created_at: '2026-09-30T00:00:00Z',
            as_of: '2026-09-29',
            symbols: ['SYNTA', 'SYNTB'],
            symbols_ok: 1,
            configs_tested: 2,
            rank_by: 'excess_return',
            oos_pct: 30,
            top: [{ label: '買入持有', label_en: 'Buy and hold', rank_value: 0 }],
            current: false,
            stale_reasons: ['inputs_changed'],
          },
        ],
        total: 1,
      })
    if (url === '/api/research-desk/tournament') return response(result)
    if (url === '/api/research-desk/runs/synthetic-run-000000')
      return response({ ...result, current: false, stale_reasons: ['inputs_changed'] })
    if (url === '/api/research-desk/diagnose') return response(diagnosis)
    if (url === '/api/research-desk/pine')
      return response({
        filename: 'alphaview-sma_cross.pine',
        code: '//@version=6\nstrategy("AlphaView RD")',
        label: '均線交叉 20/50',
        label_en: 'Moving-average crossover 20/50',
        notes: ['Not compiled in TradingView.'],
      })
    if (url === '/api/research-desk/trades.csv') return response(null)
    if (url === '/api/paper/accounts') return response({ accounts: [] })
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const bodyOf = (fetcher: ReturnType<typeof mockApi>, url: string) =>
  JSON.parse(String(fetcher.mock.calls.find(([callUrl]) => callUrl === url)?.[1]?.body))

describe('Research Desk', () => {
  it('loads the classic set, uses holdings and sends the validated tournament request', async () => {
    const fetcher = mockApi()
    render(<ResearchDesk locale="en" holdings={['MU', 'GOOGL']} />)
    const load = await screen.findByRole('button', { name: 'Load the classic strategy set' })
    await waitFor(() => expect((load as HTMLButtonElement).disabled).toBe(false))
    const run = screen.getByRole('button', { name: 'Run tournament' }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    await userEvent.click(load)
    await userEvent.click(screen.getByRole('button', { name: 'Use my holdings' }))
    expect(run.disabled).toBe(false)
    await userEvent.click(run)
    await screen.findByRole('region', { name: 'Strategy leaderboard' })
    const request = bodyOf(fetcher, '/api/research-desk/tournament')
    expect(request.symbols).toEqual(['MU', 'GOOGL'])
    expect(request.configs).toEqual(catalog.classic_set)
    expect(request.risk.fee_bps).toBe(10)
    expect(request.oos_pct).toBe(30)
    const board = screen.getByRole('region', { name: 'Strategy leaderboard' })
    expect(within(board).getByText('-12.50%')).toBeTruthy()
    expect(within(board).getByText('+3.25%')).toBeTruthy()
    expect(within(board).getByText('Small sample')).toBeTruthy()
    expect(within(board).getByText('Benchmark')).toBeTruthy()
  })

  it('adds an SMA grid without duplicates and blocks invalid parameters with a reason', async () => {
    const fetcher = mockApi()
    render(<ResearchDesk locale="en" holdings={[]} />)
    const grid = await screen.findByRole('button', { name: 'Add an SMA parameter grid' })
    await waitFor(() => expect((grid as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(grid)
    await userEvent.click(grid)
    expect(screen.getByRole('heading', { name: /Strategy set \(8\/24\)/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Symbols (space or comma separated, up to 10)'), {
      target: { value: 'SYNTA' },
    })
    fireEvent.change(screen.getAllByLabelText('Fast SMA')[0], { target: { value: '80' } })
    expect(
      screen.getByText(/Config 1 \(Moving-average crossover\): the fast period must be below/),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Run tournament' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => url === '/api/research-desk/tournament')).toBe(false)
  })

  it('diagnoses a leaderboard row on the tournament window and exports Pine and CSV', async () => {
    const fetcher = mockApi()
    const createObjectURL = vi.fn(() => 'blob:synthetic')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    render(<ResearchDesk locale="en" holdings={['SYNTA']} />)
    await userEvent.click(await screen.findByRole('button', { name: /09\/30/ }))
    const board = await screen.findByRole('region', { name: 'Strategy leaderboard' })
    expect(within(board).getByText(/Saved result: Market data changed afterwards/)).toBeTruthy()
    await userEvent.click(
      within(board).getByRole('button', {
        name: 'Diagnose Moving-average crossover 20/50 (SYNTA)',
      }),
    )
    const panel = await screen.findByRole('region', { name: 'Strategy diagnosis' })
    expect(bodyOf(fetcher, '/api/research-desk/diagnose')).toEqual({
      symbol: 'SYNTA',
      config: { strategy: 'sma_cross', params: { fast: 20, slow: 50 } },
      risk: result.request.risk,
      test_start: '2025-07-22',
      test_end: null,
    })
    expect(within(panel).getByText(/100% of losses came from entries taken below/)).toBeTruthy()
    expect(within(panel).getAllByText('Below 200-day SMA').length).toBeGreaterThan(0)
    expect(within(panel).getByText('Not yet')).toBeTruthy()
    await userEvent.click(within(panel).getByRole('button', { name: 'Export Pine Script v6' }))
    await within(panel).findByText(/strategy\("AlphaView RD"\)/)
    expect(bodyOf(fetcher, '/api/research-desk/pine').start_date).toBe('2025-07-22')
    await userEvent.click(within(panel).getByRole('button', { name: 'Download trades CSV' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    expect(bodyOf(fetcher, '/api/research-desk/trades.csv').symbol).toBe('SYNTA')
  })

  it('shows backend problem messages in English', async () => {
    mockApi((url) =>
      url === '/api/research-desk/tournament'
        ? response(
            { detail: { code: 'no_usable_symbols', message: '所有代碼都沒有足夠的有效本機日線' } },
            422,
          )
        : undefined,
    )
    render(<ResearchDesk locale="en" holdings={['SYNTA']} />)
    const load = await screen.findByRole('button', { name: 'Load the classic strategy set' })
    await waitFor(() => expect((load as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(load)
    await userEvent.click(screen.getByRole('button', { name: 'Use my holdings' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run tournament' }))
    await screen.findByText(
      'No symbol has enough valid local history. Refresh data or use strategies with a shorter warm-up.',
    )
  })

  it('removes prefix evidence downloads when the research form changes and while history loads', async () => {
    let waitForHistory = false
    let finishHistory: ((value: ReturnType<typeof response>) => void) | undefined
    const fetcher = mockApi((url, init) => {
      if (url === '/api/research-desk/integrity')
        return response({
          engine_version: 'alphaview-research-integrity-v1',
          as_of: diagnosis.as_of,
          input_revision: diagnosis.input_revision,
          symbol: diagnosis.symbol,
          config: diagnosis.config,
          fingerprint: diagnosis.fingerprint,
          request: JSON.parse(String(init?.body)),
          status: 'no_difference_detected',
          fields: ['entry'],
          prefixes: [],
          counts: {
            prefixes: 0,
            compared_session_pairs: 0,
            differences: 0,
            unavailable_values: 0,
            invalid_signal_sessions: 0,
          },
          differences: [],
          differences_truncated: false,
          unavailable: [],
          unavailable_values: [],
          unavailable_values_truncated: false,
          method: 'Synthetic sampled diagnostic only.',
        })
      if (waitForHistory && url === '/api/research-desk/runs/synthetic-run-000000')
        return new Promise<ReturnType<typeof response>>((resolve) => {
          finishHistory = resolve
        })
    })
    render(<ResearchDesk locale="en" holdings={['SYNTA']} />)
    await userEvent.click(await screen.findByRole('button', { name: /09\/30/ }))
    const board = await screen.findByRole('region', { name: 'Strategy leaderboard' })
    await userEvent.click(
      within(board).getByRole('button', {
        name: 'Diagnose Moving-average crossover 20/50 (SYNTA)',
      }),
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Compare historical prefixes' }),
    )
    await screen.findByRole('button', { name: 'Download current prefix evidence JSON' })
    fireEvent.change(screen.getByLabelText('Symbols (space or comma separated, up to 10)'), {
      target: { value: 'SYNTB' },
    })
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
    expect(
      fetcher.mock.calls.filter(([url]) => url === '/api/research-desk/integrity'),
    ).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    await screen.findByRole('button', { name: 'Download current prefix evidence JSON' })
    waitForHistory = true
    await userEvent.click(screen.getByRole('button', { name: /09\/30/ }))
    await waitFor(() => expect(finishHistory).toBeDefined())
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Compare historical prefixes' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    finishHistory?.(response(result))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Strategy diagnosis' })).toBeNull(),
    )
  })
})
