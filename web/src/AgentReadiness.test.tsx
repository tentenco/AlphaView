import { act, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentReadiness, type Readiness } from './AgentReadiness'
import type { PaperAccount } from './paper-model'

afterEach(() => vi.unstubAllGlobals())

const account: PaperAccount = {
  id: 'synthetic-readiness-account',
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
const readiness = (overall: Readiness['overall']): Readiness => ({
  engine_version: 'alphaview-readiness-v3',
  account_id: account.id,
  account_version: 2,
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  overall,
  execution_target: 'paper_ledger',
  checks: [
    {
      id: 'mandate_active',
      label: '已啟用的自動化任務與執行目標',
      status: 'pass',
      observed: 'Synthetic mandate；mode=auto_simulate；target=paper_ledger',
      required: 'one enabled mandate',
      reason: null,
      reason_code: null,
    },
    {
      id: 'history_sessions',
      label: '至少 20 個交易日的完整淨值紀錄',
      status: 'fail',
      observed: 3,
      required: 20,
      reason: '完整淨值紀錄的交易日數不足',
      reason_code: 'history_too_short',
    },
    {
      id: 'alpaca_paper_orders',
      label: 'Alpaca Paper 委託已啟用並有上限',
      status: 'not_applicable',
      observed: 'paper_ledger',
      required: null,
      reason: '執行目標是本機帳本，不需要券商連線',
      reason_code: 'paper_ledger_target',
    },
    {
      id: 'outcome_hit_rate',
      label: '決策結果帳本命中率（10 個交易日地平線，至少 20 筆已結算）',
      status: 'unavailable',
      observed: 'agent_targets: settled=3, hit_rate=0.6667；jev_gate: settled=0, hit_rate=None',
      required: '≥20 settled per family and hit rate ≥ 0.4',
      reason: '已結算的決策不足 20 筆，命中率尚不可判斷',
      reason_code: 'insufficient_settled',
    },
  ],
  summary: { pass: 1, fail: 1, unavailable: 1, not_applicable: 1 },
  method: 'Synthetic method; live_ready does not exist.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('readiness gate panel', () => {
  it('renders the overall state and every check with translated reasons', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === `/api/trading-agent/readiness?account_id=${account.id}`)
        return response(readiness('not_ready'))
      throw new Error(`Unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    render(<AgentReadiness account={account} locale="en" />)
    const panel = await screen.findByRole('region', { name: 'Readiness gate' })
    expect(within(panel).getByRole('status').textContent).toBe('Not ready')
    expect(within(panel).getByText('Enabled mandate with an execution target')).toBeTruthy()
    const history = within(panel).getByText('Enough sessions of complete NAV history').closest('li')
    expect(history?.className).toBe('is-fail')
    expect(history?.textContent).toContain('Observed: 3 · Required: 20')
    expect(history?.textContent).toContain('Not enough sessions with complete NAV snapshots.')
    expect(within(panel).getByText('N/A')).toBeTruthy()
    const outcome = within(panel)
      .getByText('Decision-outcome hit rate (10-session horizon, at least 20 settled)')
      .closest('li')
    expect(outcome?.className).toBe('is-unavailable')
    expect(outcome?.textContent).toContain(
      'Fewer than 20 settled decisions; the hit rate cannot be judged yet.',
    )
    expect(within(panel).getByText('Synthetic warning.')).toBeTruthy()
  })

  it('shows blocked and paper-ready states without ever claiming live readiness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(readiness('blocked'))),
    )
    const { unmount } = render(<AgentReadiness account={account} locale="zh-TW" />)
    expect((await screen.findByRole('status')).textContent).toBe('已阻擋（暫停或觸發）')
    unmount()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(readiness('paper_ready'))),
    )
    render(<AgentReadiness account={account} locale="en" />)
    const pill = await screen.findByRole('status')
    expect(pill.textContent).toBe('Ready for unattended paper automation')
    expect(pill.textContent?.toLowerCase()).not.toContain('live')
  })

  it('reports a failed request instead of inventing a state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ detail: '找不到虛擬帳戶' }, 404)),
    )
    render(<AgentReadiness account={account} locale="en" />)
    expect((await screen.findByRole('alert')).textContent).toBe('找不到虛擬帳戶')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('refreshes local receipt readiness and removes a previously ready state after expiry or read failure', async () => {
    let poll: (() => void) | undefined
    const interval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay !== 30000) return interval(callback, delay)
      poll = callback as () => void
      return 1
    })
    let expired = false
    let failed = false
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe(`/api/trading-agent/readiness?account_id=${account.id}`)
      if (failed) return response({ detail: 'Synthetic local read failure' }, 503)
      return response({
        ...readiness(expired ? 'not_ready' : 'paper_ready'),
        execution_target: 'alpaca_paper',
        checks: [
          {
            id: 'broker_book_reconciled',
            label: 'Alpaca Paper 帳簿核對收據有效且一致（15 分鐘內）',
            status: expired ? 'unavailable' : 'pass',
            observed: `age_seconds=${expired ? 901 : 0}`,
            required: 'matched receipt ≤15 minutes',
            reason: expired ? '收據已過期' : null,
            reason_code: expired ? 'receipt_stale' : null,
          },
        ],
      })
    })
    vi.stubGlobal('fetch', fetcher)
    render(<AgentReadiness account={account} locale="en" />)
    expect((await screen.findByRole('status')).textContent).toBe(
      'Ready for unattended paper automation',
    )
    expect(
      screen.getByText('Current matched Alpaca Paper book receipt (within 15 minutes)'),
    ).toBeTruthy()
    expired = true
    await act(async () => poll?.())
    expect((await screen.findByRole('status')).textContent).toBe('Not ready')
    expect(
      screen.getByText(/The saved book receipt is older than 15 minutes\. Reconcile again\./),
    ).toBeTruthy()
    failed = true
    await act(async () => poll?.())
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic local read failure')
    expect(screen.queryByRole('status')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
