import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDailyReport, type AgentReport } from './AgentDailyReport'
import type { PaperAccount } from './paper-model'

afterEach(() => {
  vi.unstubAllGlobals()
})

const account: PaperAccount = {
  id: 'synthetic-report-account',
  name: 'Synthetic report account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 8300,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const report: AgentReport = {
  engine_version: 'alphaview-agent-report-v1',
  as_of: '2026-09-29',
  session: '2026-09-29',
  is_session: true,
  input_revision: 'synthetic:1',
  generated_at: '2026-09-30T01:00:00Z',
  account: {
    id: account.id,
    name: account.name,
    version: 3,
    kill_switch: false,
    cash: 8300,
    initial_cash: 10000,
    equity: 10450.5,
    valuation_complete: true,
    coverage: { required: 1, priced: 1, missing: [] },
    holdings_count: 1,
    realized_pnl: 120.25,
    unrealized_pnl: 30.25,
    total_return_pct: 4.505,
  },
  nav: {
    latest: { as_of: '2026-09-29', equity: 10450.5, complete: true },
    previous: { as_of: '2026-09-26', equity: 10300, complete: true },
    session_change_pct: 1.4612,
    session_change_reason: null,
    window_return_pct: 4.5,
    window_max_drawdown_pct: 2.1,
    window_reason: null,
    captured_sessions: 5,
    observed_sessions: 5,
  },
  fills: {
    items: [
      {
        symbol: 'SYNTA',
        side: 'sell',
        shares: 10,
        price: 120,
        notional: 1200,
        fee: 1.2,
        slippage_cost: 0,
        realized_pnl: 198.8,
        proposal_id: 'synthetic-proposal-0001',
        session: '2026-09-29',
        created_at: '2026-09-29T21:00:00Z',
      },
      {
        symbol: 'SYNTB',
        side: 'buy',
        shares: 5,
        price: 40,
        notional: 200,
        fee: 0.2,
        slippage_cost: 0,
        realized_pnl: 0,
        proposal_id: 'synthetic-proposal-0001',
        session: '2026-09-29',
        created_at: '2026-09-29T21:00:00Z',
      },
    ],
    totals: {
      count: 2,
      buy_count: 1,
      sell_count: 1,
      buy_notional: 200,
      sell_notional: 1200,
      fees: 1.4,
      slippage: 0,
      cost_total: 1.4,
      realized_pnl: 198.8,
    },
  },
  window: {
    window_sessions: 20,
    start: '2026-09-01',
    end: '2026-09-29',
    fill_count: 6,
    sell_count: 3,
    realized_pnl: 150.5,
    win_rate_pct: 66.6667,
    wins: 2,
    losses: 1,
    largest_win: 198.8,
    largest_loss: -48.3,
    avg_realized_pnl: 50.17,
    cost_total: 4.2,
    gross_notional: 3400,
    reason: null,
  },
  automation: {
    attempts: [
      {
        id: 'attempt-1',
        mandate_id: 'mandate-1',
        mandate_name: 'Synthetic mandate',
        status: 'proposed',
        reason_code: 'proposal_ready',
        reason: '紙上提案已保存',
      },
    ],
    status_counts: { proposed: 1 },
    enabled_mandates: 1,
    pending_proposals: 1,
    next_open_queue: { waiting_session: 1 },
  },
  jev: {
    available: true,
    runs: 2,
    status_counts: { completed: 2 },
    symbol_counts: { pass: 3, fail: 1, unavailable: 0 },
    average_latency_ms: 231,
    estimated_cost_usd: 0.000055,
    cost_basis: 'estimate',
  },
  circuit_breaker: { available: false, reason: '尚未安裝斷路器模組' },
  data_freshness: {
    symbols: [{ symbol: 'SYNTB', latest_bar: '2026-09-29', stale: false }],
    stale_symbols: [],
    session: '2026-09-29',
  },
  method: 'Synthetic method.',
  warnings: ['紙上成交是本機模擬，不是實盤交易或真實損益。'],
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  blob: async () => new Blob(['synthetic']),
})
function mockApi(handler?: (url: string) => unknown) {
  const fetcher = vi.fn(async (url: string) => {
    const custom = handler?.(url)
    if (custom !== undefined) return custom
    if (url.startsWith('/api/trading-agent/report?')) return response(report)
    if (
      url.startsWith('/api/trading-agent/report.html?') ||
      url.startsWith('/api/trading-agent/report.csv?')
    )
      return response(null)
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const requested = (fetcher: ReturnType<typeof mockApi>, prefix: string) =>
  fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(prefix))

describe('Agent daily report', () => {
  it('loads the latest session by default and renders every metric from the response', async () => {
    const fetcher = mockApi()
    render(<AgentDailyReport account={account} locale="en" />)
    const panel = await screen.findByRole('region', { name: 'Agent daily report' })
    await within(panel).findByText('+1.46%')
    const url = new URL(requested(fetcher, '/api/trading-agent/report?')[0], 'http://local')
    expect(url.searchParams.get('account_id')).toBe(account.id)
    expect(url.searchParams.get('window_sessions')).toBe('20')
    expect(url.searchParams.has('session')).toBe(false)
    expect(within(panel).getByText('$10,450.50')).toBeTruthy()
    expect(within(panel).getByText('66.7%')).toBeTruthy()
    expect(within(panel).getByText('$-48.30')).toBeTruthy()
    expect(within(panel).getByText(/Avg latency 231 ms/)).toBeTruthy()
    expect(within(panel).getByText(/\$0\.000055/)).toBeTruthy()
    expect(within(panel).getByText('Synthetic mandate')).toBeTruthy()
    expect(within(panel).getByText('尚未安裝斷路器模組')).toBeTruthy()
    expect((screen.getByLabelText('Session') as HTMLInputElement).value).toBe('2026-09-29')
    const rows = within(panel).getAllByRole('row')
    expect(
      rows.some((row) => row.textContent?.includes('SYNTA') && row.textContent.includes('$198.80')),
    ).toBe(true)
  })

  it('refetches with the chosen session and window, and downloads HTML and CSV through blobs', async () => {
    const fetcher = mockApi()
    const createObjectURL = vi.fn(() => 'blob:synthetic')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    render(<AgentDailyReport account={account} locale="en" />)
    await screen.findByText('+1.46%')
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: '2026-09-26' } })
    fireEvent.change(screen.getByLabelText('Window sessions'), { target: { value: '60' } })
    await waitFor(() => {
      const urls = requested(fetcher, '/api/trading-agent/report?')
      const last = new URL(urls[urls.length - 1], 'http://local')
      expect(last.searchParams.get('session')).toBe('2026-09-26')
      expect(last.searchParams.get('window_sessions')).toBe('60')
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download HTML report' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    expect(requested(fetcher, '/api/trading-agent/report.html?')[0]).toContain('session=2026-09-26')
    await userEvent.click(screen.getByRole('button', { name: 'Download fills CSV' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2))
    expect(requested(fetcher, '/api/trading-agent/report.csv?')).toHaveLength(1)
  })

  it('shows backend problems and keeps unavailable values as dashes', async () => {
    mockApi((url) =>
      url.includes('session=2030-01-01')
        ? response({ detail: { code: 'session_not_completed', message: '尚未完成' } }, 422)
        : url.startsWith('/api/trading-agent/report?')
          ? response({
              ...report,
              nav: {
                ...report.nav,
                latest: null,
                previous: null,
                session_change_pct: null,
                session_change_reason: '尚未擷取此交易日或之前的淨值快照',
                window_return_pct: null,
                window_max_drawdown_pct: null,
                window_reason: '尚未擷取虛擬帳戶淨值',
              },
              window: {
                ...report.window,
                win_rate_pct: null,
                largest_loss: null,
                largest_win: null,
                reason: '沒有賣出',
              },
              jev: { available: false, reason: '此工作區沒有 Jev 決策紀錄表' },
            })
          : undefined,
    )
    render(<AgentDailyReport account={account} locale="en" />)
    const panel = await screen.findByRole('region', { name: 'Agent daily report' })
    await within(panel).findByText('尚未擷取此交易日或之前的淨值快照')
    expect(within(panel).getAllByText('—').length).toBeGreaterThanOrEqual(4)
    expect(within(panel).getByText('此工作區沒有 Jev 決策紀錄表')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: '2030-01-01' } })
    await screen.findByText('That session has not completed yet.')
  })
})

describe('decision quality block', () => {
  it('renders hit rates, the rank correlation and provenance counts without inventing numbers', async () => {
    const value: AgentReport = {
      ...report,
      decision_quality: {
        available: true,
        engine_version: 'alphaview-decision-outcome-v1',
        horizon_sessions: 10,
        window_sessions: 60,
        families: {
          agent_targets: {
            label: '規則工作流目標變動',
            english: 'Rule-workflow target changes',
            n: 7,
            n_settled: 5,
            n_pending: 2,
            hit_rate: 0.6,
            mean_excess_pct: 0.4,
            low_sample: true,
            reason: null,
            kinds: [],
          },
          jev_gate: {
            label: 'Jev 決策閘',
            english: 'Jev decision gate',
            n: 0,
            n_settled: 0,
            n_pending: 0,
            hit_rate: null,
            mean_excess_pct: null,
            low_sample: true,
            reason: 'no_decisions',
            kinds: [],
          },
        },
        score_correlation: {
          status: 'unavailable',
          spearman: null,
          n: 0,
          low_sample: true,
          reason: 'question_absent',
        },
      },
      provenance_counts: {
        engine_version: 'alphaview-proposal-provenance-v1',
        session: '2026-09-29',
        total: 2,
        by_source: { automation: 1, manual: 1 },
        by_tag: { 'allocator:equal': 1, jev_gate: 1 },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => value })),
    )
    render(<AgentDailyReport account={account} locale="en" />)
    const panel = await screen.findByRole('region', { name: 'Agent daily report' })
    expect(
      within(panel).getByText(/settled 5 · pending 2 · hit rate 60\.0% \(low sample\)/),
    ).toBeTruthy()
    expect(within(panel).getByText(/hit rate — \(low sample\) · no_decisions/)).toBeTruthy()
    expect(within(panel).getByText(/— \(N=0\) · question_absent/)).toBeTruthy()
    expect(
      within(panel).getByText(
        /Proposals this session 2 · sources automation 1 · manual 1 · gate tags allocator:equal 1 · jev_gate 1/,
      ),
    ).toBeTruthy()
  })
})
