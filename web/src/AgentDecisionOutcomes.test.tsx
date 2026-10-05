import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentDecisionOutcomes,
  type DecisionOutcomes,
  type OutcomeGroup,
} from './AgentDecisionOutcomes'
import type { PaperAccount } from './paper-model'

afterEach(() => vi.unstubAllGlobals())

const account: PaperAccount = {
  id: 'synthetic-outcomes-account',
  name: 'Synthetic outcomes account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 8300,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const group = (
  kind: string,
  label: string,
  english: string,
  overrides: Partial<OutcomeGroup> = {},
): OutcomeGroup => ({
  kind,
  label,
  english,
  direction: 'long',
  n: 0,
  n_settled: 0,
  n_pending: 0,
  n_unavailable: 0,
  hit_rate: null,
  hits: 0,
  mean_return_pct: null,
  mean_excess_pct: null,
  excess_coverage: { n: 0, of: 0, reason: null },
  low_sample: true,
  reason: 'no_decisions',
  ...overrides,
})
const outcomes = (horizon: number): DecisionOutcomes => ({
  engine_version: 'alphaview-decision-outcome-v1',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  generated_at: '2026-09-30T01:00:00Z',
  horizon_sessions: horizon,
  horizons: [5, 10, 20],
  window: { sessions: 60, start: '2026-07-06', end: '2026-09-29' },
  account: { id: account.id, name: account.name },
  price_basis: 'Synthetic price basis.',
  benchmark: 'SPY',
  low_sample_threshold: 5,
  families: [
    {
      id: 'scan_signals',
      label: '選股訊號',
      english: 'Scan signals',
      groups: [
        group('turtle', '海龜突破', 'Turtle breakout', {
          n: 9,
          n_settled: 7,
          n_pending: 2,
          hit_rate: 0.5714,
          hits: 4,
          mean_return_pct: horizon === 5 ? 1.25 : 2.5,
          mean_excess_pct: 0.4,
          excess_coverage: { n: 7, of: 7, reason: null },
          low_sample: false,
          reason: null,
        }),
        group('trend', '趨勢跟隨', 'Trend following', {
          n: 2,
          n_settled: 2,
          hit_rate: 0,
          mean_return_pct: -3.1,
          mean_excess_pct: null,
          excess_coverage: { n: 0, of: 2, reason: 'benchmark_unavailable' },
          low_sample: true,
          reason: null,
        }),
      ],
      total: group('total', '', '', { n: 11, n_settled: 9 }),
    },
    {
      id: 'jev_gate',
      label: 'Jev 決策閘',
      english: 'Jev decision gate',
      groups: [
        group('unavailable', '不可用（歸零）', 'Unavailable (zeroed)', {
          direction: null,
          n: 1,
          reason: 'no_direction',
        }),
      ],
      total: group('total', '', '', { n: 1 }),
    },
  ],
  calibration: {
    questions: [
      {
        id: 'overextended',
        label: '過度延伸',
        english: 'Overextended',
        realization: {
          kind: 'pullback',
          label: '回檔',
          english: 'Pullback',
          description: 'Synthetic realization.',
        },
        n: 2,
        n_pending: 1,
        unavailable: { history_insufficient: 1 },
        brier: 0.05,
        base_rate: 0.5,
        mean_predicted: 0.4,
        bins: [
          { range: [0, 0.2], n: 1, mean_predicted: 0.1, realized_rate: 0, low_sample: true },
          { range: [0.2, 0.4], n: 0, mean_predicted: null, realized_rate: null, low_sample: true },
          { range: [0.6, 0.8], n: 1, mean_predicted: 0.7, realized_rate: 1, low_sample: true },
        ],
        low_sample: true,
      },
    ],
    unscorable: [
      {
        id: 'setup_quality',
        label: '設定品質',
        english: 'Setup quality',
        reason: 'Synthetic reason.',
      },
    ],
    score_correlation: {
      question: 'setup_quality',
      status: 'available',
      reason: null,
      n: 7,
      n_pending: 2,
      n_unavailable: 0,
      spearman: 0.3214,
      low_sample: true,
      method: 'Synthetic correlation method.',
    },
    bins: [
      [0, 0.2],
      [0.2, 0.4],
      [0.4, 0.6],
      [0.6, 0.8],
      [0.8, 1],
    ],
    note: 'Synthetic note.',
  },
  items: [],
  items_truncated: false,
  items_total: 12,
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('decision outcome ledger panel', () => {
  it('renders families, calibration bins and refetches when the horizon changes', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const horizon = Number(new URL(url, 'http://local').searchParams.get('horizon_sessions'))
      return response(outcomes(horizon))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<AgentDecisionOutcomes account={account} locale="en" />)
    await screen.findByText('Turtle breakout')
    const first = new URL(String(fetcher.mock.calls[0][0]), 'http://local')
    expect(first.pathname).toBe('/api/trading-agent/outcomes')
    expect(first.searchParams.get('account_id')).toBe(account.id)
    expect(first.searchParams.get('horizon_sessions')).toBe('10')
    expect(first.searchParams.get('window_sessions')).toBe('60')
    expect(screen.getByText('+2.50%')).toBeTruthy()
    expect(screen.getByText('57.1%')).toBeTruthy()
    expect(screen.getByText('12 decisions')).toBeTruthy()
    expect(screen.getByText(/Benchmark bars unavailable/)).toBeTruthy()
    expect(screen.getByText('Directionless decisions are not scored')).toBeTruthy()
    expect(screen.getByText('Low sample')).toBeTruthy()
    expect(screen.getByText(/Brier 0\.0500/)).toBeTruthy()
    expect(screen.getByText(/history_insufficient 1/)).toBeTruthy()
    expect(screen.getByText(/Not calibrated/)).toBeTruthy()
    expect(screen.getByText('Synthetic warning.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Horizon (sessions)'), { target: { value: '5' } })
    await screen.findByText('+1.25%')
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            new URL(String(url), 'http://local').searchParams.get('horizon_sessions') === '5',
        ),
      ).toBe(true),
    )
  })

  it('shows the API error instead of numbers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ detail: { code: 'invalid_horizon', message: 'Synthetic failure' } }, 422),
      ),
    )
    render(<AgentDecisionOutcomes account={account} locale="zh-TW" />)
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic failure')
    expect(screen.queryByText('海龜突破')).toBeNull()
  })

  it('offers the per-decision CSV for the same query and shows the setup-quality correlation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL) => response(outcomes(10))),
    )
    render(<AgentDecisionOutcomes account={account} locale="en" />)
    const link = (await screen.findByRole('link', {
      name: 'Download per-decision CSV',
    })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(
      `/api/trading-agent/outcomes.csv?account_id=${account.id}&horizon_sessions=10&window_sessions=60`,
    )
    expect(link.hasAttribute('download')).toBe(true)
    expect(screen.getByText(/Spearman 0\.3214 · N=7 \(low sample\)/)).toBeTruthy()
  })
})
