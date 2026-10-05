import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioAccountComparison } from './PortfolioAccountComparison'
import {
  COMPARISON_DRAFT_KEY,
  comparisonChartData,
  parseComparisonDraft,
  type AccountComparison,
  type ComparisonPoint,
  type PaperAccountSummary,
  type PaperComparisonReport,
} from './paper-comparison'

const accounts: PaperAccountSummary[] = [
  { id: 'synthetic-a', name: 'Synthetic A', version: 1 },
  { id: 'synthetic-b', name: 'Synthetic B', version: 2 },
]
function point(day: string, equity: number | null, normalized100: number | null): ComparisonPoint {
  return {
    as_of: day,
    equity,
    normalized100,
    status: equity == null ? 'not_captured' : 'complete',
    snapshot_id: equity == null ? null : Number(day.slice(-2)),
    observed_at: equity == null ? null : `${day}T22:00:00Z`,
    account_version: equity == null ? null : 1,
    input_revision: equity == null ? null : 'synthetic-input:1',
    paper_engine_version: equity == null ? null : 'alphaview-paper-portfolio-v2',
    analytics_engine_version: equity == null ? null : 'alphaview-paper-analytics-v1',
    quote_coverage: equity == null ? null : { required: 0, priced: 0, missing: [] },
  }
}
function accountResult(index: number, extra: Partial<AccountComparison> = {}): AccountComparison {
  return {
    account_id: accounts[index].id,
    name: accounts[index].name,
    current_account_version: accounts[index].version,
    initial_cash: index ? 20000 : 10000,
    coverage: {
      expected_sessions: 2,
      captured_sessions: 2,
      complete_sessions: 2,
      missing_sessions: [],
    },
    series: [
      point('2024-01-05', index ? 20000 : 10000, 100),
      point('2024-01-08', index ? 20000 : 13000, index ? 100 : 130),
    ],
    start_equity: index ? 20000 : 10000,
    end_equity: index ? 20000 : 13000,
    equity_change: index ? 0 : 3000,
    return_pct: index ? 0 : 30,
    max_drawdown_pct: 0,
    performance_available: true,
    reason: null,
    ...extra,
  }
}
function report(extra: Partial<PaperComparisonReport> = {}): PaperComparisonReport {
  return {
    engine_version: 'alphaview-paper-nav-comparison-v1',
    as_of: '2024-01-08',
    input_revision: 'synthetic-input:1',
    period: { start: '2024-01-05', end: '2024-01-08', session_count: 2 },
    common_start_complete: true,
    comparable: true,
    reason: null,
    accounts: [accountResult(0), accountResult(1)],
    comparisons: [
      {
        left_id: accounts[0].id,
        right_id: accounts[1].id,
        return_difference_pp: 30,
        equity_change_difference: 3000,
        left_initial_cash: 10000,
        right_initial_cash: 20000,
      },
    ],
    method: 'Synthetic fixed-period comparison.',
    warnings: [],
    ...extra,
  }
}
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
})
function saveDraft(extra = {}) {
  sessionStorage.setItem(
    COMPARISON_DRAFT_KEY,
    JSON.stringify({
      accountIds: accounts.map((account) => account.id),
      start: '2024-01-05',
      end: '2024-01-08',
      ...extra,
    }),
  )
}
async function compare() {
  await userEvent.click(screen.getByRole('button', { name: 'Compare captured observations' }))
}
function metric(label: string) {
  return within(screen.getByRole('row', { name: new RegExp(`^${label} `) }))
}
afterEach(() => sessionStorage.clear())

describe('paper account NAV comparison', () => {
  it('submits only the explicit selected accounts and fixed dates, with no automatic requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(report()))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    expect(fetcher).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Synthetic A' }))
    await user.click(screen.getByRole('checkbox', { name: 'Synthetic B' }))
    fireEvent.change(screen.getByLabelText('Fixed start date'), { target: { value: '2024-01-05' } })
    fireEvent.change(screen.getByLabelText('Fixed end date'), { target: { value: '2024-01-08' } })
    await compare()
    await screen.findByRole('region', { name: 'Account comparison results' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/paper/nav/compare')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      account_ids: ['synthetic-a', 'synthetic-b'],
      start: '2024-01-05',
      end: '2024-01-08',
    })
    expect(
      metric('Start NAV')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['$10,000.00', '$20,000.00'])
    expect(
      metric('Period return')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['30.00%', '0.00%'])
    expect(screen.getByText('30.00 pp')).toBeTruthy()
    expect(
      screen.getByRole('img', { name: /NAV comparison with a shared baseline of 100/ }),
    ).toBeTruthy()
    expect(document.querySelectorAll('[data-comparison-segment]')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Fixed end date'), { target: { value: '2024-01-09' } })
    expect(screen.getByText(/These are the last submitted accounts and dates/)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not normalize a missing common start or rank unavailable results, and explains capture next steps', async () => {
    saveDraft()
    const missing = accountResult(1, {
      coverage: {
        expected_sessions: 2,
        captured_sessions: 0,
        complete_sessions: 0,
        missing_sessions: ['2024-01-05', '2024-01-08'],
      },
      series: [point('2024-01-05', null, null), point('2024-01-08', null, null)],
      start_equity: null,
      end_equity: null,
      equity_change: null,
      return_pct: null,
      max_drawdown_pct: null,
      performance_available: false,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          report({
            common_start_complete: false,
            comparable: false,
            comparisons: [],
            accounts: [
              accountResult(0, {
                series: [point('2024-01-05', 10000, null), point('2024-01-08', 13000, null)],
              }),
              missing,
            ],
          }),
        ),
      ),
    )
    render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    await compare()
    await screen.findByRole('region', { name: 'Account comparison results' })
    expect(screen.getByText(/shared baseline of 100 is unavailable/)).toBeTruthy()
    expect(screen.getByText(/Select each account, open “NAV & costs”/)).toBeTruthy()
    expect(
      metric('End NAV')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['$13,000.00', '—'])
    expect(
      metric('Period return')
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['30.00%', '—'])
    expect(screen.queryByText('Differences: first minus second')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('breaks normalized chart lines at gaps and exposes exact daily status and source metadata', async () => {
    saveDraft({ end: '2024-01-09' })
    const first = accountResult(0, {
      coverage: {
        expected_sessions: 3,
        captured_sessions: 2,
        complete_sessions: 2,
        missing_sessions: ['2024-01-08'],
      },
      series: [
        point('2024-01-05', 10000, 100),
        point('2024-01-08', null, null),
        point('2024-01-09', 13000, 130),
      ],
      equity_change: null,
      return_pct: null,
      max_drawdown_pct: null,
      performance_available: false,
    })
    const second = accountResult(1, {
      coverage: {
        expected_sessions: 3,
        captured_sessions: 3,
        complete_sessions: 3,
        missing_sessions: [],
      },
      series: [
        point('2024-01-05', 20000, 100),
        point('2024-01-08', 20000, 100),
        point('2024-01-09', 20000, 100),
      ],
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          report({
            period: { start: '2024-01-05', end: '2024-01-09', session_count: 3 },
            comparable: false,
            comparisons: [],
            accounts: [first, second],
          }),
        ),
      ),
    )
    render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    await compare()
    await screen.findByRole('region', { name: 'Account comparison results' })
    expect(document.querySelectorAll('[data-comparison-segment="synthetic-a"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-comparison-segment="synthetic-b"]')).toHaveLength(1)
    await userEvent.click(screen.getByText('Synthetic A · 2/3 complete observations'))
    const detail = within(screen.getByRole('region', { name: 'Synthetic A daily observations' }))
    expect(detail.getByRole('row', { name: /2024-01-08 — — Not captured —/ })).toBeTruthy()
    await userEvent.click(detail.getByText('#9'))
    expect(
      within(detail.getByRole('row', { name: /2024-01-09/ })).getByText(
        /alphaview-paper-portfolio-v2/,
      ),
    ).toBeTruthy()
    expect(metric('Period return').getAllByRole('cell')[0].textContent).toBe('—')
  })

  it('rejects incomplete drafts locally and enforces at most five selected accounts', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const six = Array.from({ length: 6 }, (_, index) => ({
      id: `synthetic-${index}`,
      name: `Account ${index}`,
      version: 1,
    }))
    render(<PortfolioAccountComparison accounts={six} locale="en" />)
    await compare()
    expect(screen.getByRole('alert').textContent).toBe('Select 2–5 paper accounts.')
    for (let index = 0; index < 5; index++)
      await userEvent.click(screen.getByRole('checkbox', { name: `Account ${index}` }))
    expect((screen.getByRole('checkbox', { name: 'Account 5' }) as HTMLInputElement).disabled).toBe(
      true,
    )
    await compare()
    expect(screen.getByRole('alert').textContent).toBe('Enter valid fixed start and end dates.')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves dates and account selections after server rejection and across remounts', async () => {
    saveDraft({ start: '2024-01-06' })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ detail: '起日與截止日都必須是 XNYS 交易日，未自動移動日期' }, 422),
        ),
    )
    const view = render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    await compare()
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toMatch(/Use completed XNYS trading sessions/)
    expect((screen.getByLabelText('Fixed start date') as HTMLInputElement).value).toBe('2024-01-06')
    view.unmount()
    render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    expect((screen.getByLabelText('Fixed start date') as HTMLInputElement).value).toBe('2024-01-06')
    expect(
      (screen.getByRole('checkbox', { name: 'Synthetic A' }) as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('hides old results when account version changes without overwriting draft edits', async () => {
    saveDraft()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(report())))
    const view = render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    await compare()
    await screen.findByRole('region', { name: 'Account comparison results' })
    fireEvent.change(screen.getByLabelText('Fixed start date'), { target: { value: '2024-01-04' } })
    view.rerender(
      <PortfolioAccountComparison
        accounts={[{ ...accounts[0], version: 2 }, accounts[1]]}
        locale="en"
      />,
    )
    expect(screen.queryByRole('region', { name: 'Account comparison results' })).toBeNull()
    expect(screen.getByText(/The account list or version changed/)).toBeTruthy()
    expect((screen.getByLabelText('Fixed start date') as HTMLInputElement).value).toBe('2024-01-04')
  })

  it('ignores a late response after an account-list change', async () => {
    saveDraft()
    let resolve: (data: unknown) => void = () => {}
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<PortfolioAccountComparison accounts={accounts} locale="en" />)
    await compare()
    view.rerender(
      <PortfolioAccountComparison
        accounts={[{ ...accounts[0], version: 2 }, accounts[1]]}
        locale="en"
      />,
    )
    await act(async () => {
      resolve(response(report()))
    })
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(screen.queryByRole('region', { name: 'Account comparison results' })).toBeNull()
  })

  it('shows a clear setup step when fewer than two accounts exist', () => {
    render(<PortfolioAccountComparison accounts={accounts.slice(0, 1)} locale="en" />)
    expect(screen.getByText(/Create at least two independent paper accounts/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Compare captured observations' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('uses Chinese copy directly when the selected locale is Traditional Chinese', () => {
    render(<PortfolioAccountComparison accounts={accounts} locale="zh-TW" />)
    expect(screen.getByRole('heading', { name: '在同一段時間，比較已保存的淨值' })).toBeTruthy()
    expect(screen.getByLabelText('固定起日')).toBeTruthy()
  })

  it('validates actual calendar dates and never normalizes unknown starts in chart geometry', () => {
    const draft = {
      accountIds: accounts.map((row) => row.id),
      start: '2024-02-30',
      end: '2024-03-04',
    }
    expect(parseComparisonDraft(draft, accounts).error).toBe('dates')
    expect(parseComparisonDraft({ ...draft, start: '2024-03-05' }, accounts).error).toBe('order')
    expect(
      parseComparisonDraft({ ...draft, accountIds: ['unknown', accounts[0].id] }, accounts).error,
    ).toBe('unknown')
    const noBase = comparisonChartData(report({ common_start_complete: false }))
    expect(noBase.domain).toBeNull()
    expect(noBase.series).toEqual([])
    const gapped = comparisonChartData(
      report({
        accounts: [
          accountResult(0, {
            series: [
              point('2024-01-05', 10000, 100),
              point('2024-01-08', null, null),
              point('2024-01-09', 13000, 130),
            ],
          }),
        ],
      }),
    )
    expect(gapped.series[0].segments.map((segment) => segment.map((row) => row.value))).toEqual([
      [100],
      [130],
    ])
    expect(gapped.series[0].gaps).toEqual([1])
  })
})
