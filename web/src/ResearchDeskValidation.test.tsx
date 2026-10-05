import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchDeskValidation } from './ResearchDeskValidation'
import type { DeskValidation } from './research-desk-model'

afterEach(() => vi.unstubAllGlobals())

const t = (zh: string, en: string) => en
const config = { strategy: 'sma_cross', params: { fast: 5, slow: 20 } } as const
const validation = (): DeskValidation => ({
  engine_version: 'alphaview-validation-v1',
  desk_engine_version: 'alphaview-research-desk-v1',
  as_of: '2024-12-31',
  input_revision: 'synthetic:1',
  symbol: 'SYNTA',
  config,
  label: 'SMA 交叉 5/20',
  label_en: 'SMA cross 5/20',
  window: { start: '2023-02-01', end: '2024-12-31', sessions: 480 },
  summary: {
    return_pct: 12.5,
    max_drawdown_pct: -8,
    sharpe_ratio: 0.9,
    closed_trades: 16,
    win_rate_pct: 56.25,
    profit_factor: 1.4,
    avg_trade_return_pct: 0.8,
  },
  walk_forward: {
    available: true,
    reason: null,
    detail: null,
    traded_folds: 4,
    positive_folds: 3,
    consistency: 0.75,
    folds: [
      {
        index: 1,
        start: '2023-02-01',
        end: '2023-07-31',
        sessions: 120,
        return_pct: 4,
        closed_trades: 4,
        win_rate_pct: 50,
        max_drawdown_pct: -3,
        sharpe_ratio: 1,
        status: 'positive',
      },
      {
        index: 2,
        start: '2023-08-01',
        end: '2024-01-31',
        sessions: 120,
        return_pct: -1,
        closed_trades: 4,
        win_rate_pct: 25,
        max_drawdown_pct: -5,
        sharpe_ratio: -0.2,
        status: 'negative',
      },
    ],
  },
  bootstrap: {
    available: false,
    reason: 'insufficient_trades',
    closed_trades: 9,
    required: 10,
    samples: 2000,
    seed: 20261001,
  },
  sharpe: {
    available: true,
    reason: null,
    sessions: 480,
    trials: 12,
    sharpe_daily: 0.05,
    sharpe_annualized: 0.79,
    skewness: 0.1,
    kurtosis: 3.2,
    benchmark_sharpe_daily: 0.1,
    kind: 'deflated',
    probability: 0.31,
  },
  verdict: {
    status: 'warn',
    reasons: ['bootstrap 不可用：insufficient_trades'],
    rule: 'Synthetic rule.',
  },
  fingerprint: 'abc',
  method: 'Synthetic method.',
  warnings: ['Synthetic warning.'],
})
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('research desk validation gate', () => {
  it('runs on demand with the diagnosis parameters and shows the verdict, folds and unavailable tests', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(validation()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(
      <ResearchDeskValidation
        symbol="SYNTA"
        config={config}
        testStart="2023-02-01"
        testEnd="2024-12-31"
        t={t}
      />,
    )
    expect(fetcher).not.toHaveBeenCalled()
    await userEvent.clear(screen.getByLabelText('Configurations compared (1–500)'))
    await userEvent.type(screen.getByLabelText('Configurations compared (1–500)'), '12')
    await userEvent.click(screen.getByRole('button', { name: 'Run validation gate' }))
    expect(await screen.findByText(/Warn · alphaview-validation-v1/)).toBeTruthy()
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      symbol: 'SYNTA',
      config,
      test_start: '2023-02-01',
      test_end: '2024-12-31',
      folds: 4,
      trials: 12,
    })
    expect(screen.getByText('3/4 (0.75)')).toBeTruthy()
    expect(screen.getByText('Fewer than 10 closed trades')).toBeTruthy()
    expect(screen.getByText('Deflated Sharpe probability')).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('rejects out-of-range inputs before requesting and surfaces server errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ detail: { code: 'insufficient_history', message: '歷史不足' } }, 422),
      ),
    )
    render(<ResearchDeskValidation symbol="SYNTA" config={config} t={t} />)
    await userEvent.clear(screen.getByLabelText('Folds (2–8)'))
    await userEvent.type(screen.getByLabelText('Folds (2–8)'), '9')
    expect(
      (screen.getByRole('button', { name: 'Run validation gate' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.clear(screen.getByLabelText('Folds (2–8)'))
    await userEvent.type(screen.getByLabelText('Folds (2–8)'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Run validation gate' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('歷史不足'))
  })
})

describe('cross-symbol validation batch', () => {
  it('validates every tournament symbol with the same settings and keeps unavailable ones explicit', async () => {
    const batch = {
      engine_version: 'alphaview-validation-v1',
      as_of: '2024-12-31',
      input_revision: 'synthetic:1',
      config,
      label: 'SMA 交叉 5/20',
      label_en: 'SMA cross 5/20',
      folds: 4,
      trials: 1,
      items: [
        {
          symbol: 'SYNTA',
          status: 'evaluated',
          verdict: 'warn',
          reasons: ['bootstrap 不可用：insufficient_trades'],
          window: { start: '2023-02-01', end: '2024-12-31', sessions: 480 },
          closed_trades: 9,
          return_pct: 12.5,
          consistency: 0.75,
          ci95: null,
          probability: 0.9,
          unavailable: ['bootstrap'],
        },
        {
          symbol: 'SYNTB',
          status: 'unavailable',
          code: 'insufficient_history',
          message: '歷史不足',
          verdict: null,
        },
      ],
      counts: { pass: 0, warn: 1, fail: 0, unavailable: 1 },
      pass_share: 0,
      overall: 'warn',
      method: 'Synthetic method.',
      warnings: [],
    }
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).endsWith('/validate-batch') ? response(batch) : response(validation()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(
      <ResearchDeskValidation
        symbol="SYNTA"
        config={config}
        symbols={['SYNTA', 'SYNTB', 'SYNTA']}
        t={t}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Validate all 2 tournament symbols' }))
    expect(await screen.findByText(/Cross-symbol summary/)).toBeTruthy()
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).symbols).toEqual(['SYNTA', 'SYNTB'])
    expect(screen.getByText('歷史不足')).toBeTruthy()
    expect(
      screen.getByText('bootstrap 不可用：insufficient_trades；bootstrap: unavailable'),
    ).toBeTruthy()
  })
})
