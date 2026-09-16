import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketRegime } from './MarketRegime'
import { REGIME_SETTINGS_KEY, type RegimeResult } from './market-regime'

const factor = (
  id: RegimeResult['factors'][number]['id'],
  weight: number,
  extra: Partial<RegimeResult['factors'][number]> = {},
): RegimeResult['factors'][number] => ({
  id,
  weight,
  weight_pct: weight,
  enabled: weight > 0,
  available: false,
  value: null,
  as_of: null,
  age_days: null,
  stale: false,
  risk: null,
  status: null,
  reason: 'missing_input',
  detail: null,
  ...extra,
})
function result(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return {
    engine_version: 'alphaview-regime-v1',
    as_of: '2026-09-04',
    input_revision: 'id:1',
    benchmark: {
      symbol: 'VOO',
      name: null,
      source: null,
      bars: 0,
      last_date: null,
      available: false,
      reason: 'no_history',
      deviation_pct: null,
    },
    weights: { buffett: 15, shiller: 25, yield_curve: 25, technical: 20, sentiment: 15 },
    factors: [
      factor('buffett', 15, {
        available: true,
        value: 190,
        risk: 90,
        as_of: '2026-06-30',
        age_days: 66,
        stale: false,
        reason: null,
      }),
      factor('shiller', 25, {
        available: true,
        value: 38.1,
        risk: 90,
        as_of: '2026-03-01',
        age_days: 187,
        stale: true,
        reason: null,
      }),
      factor('yield_curve', 25, { detail: { missing: ['yield_2y'] } }),
      factor('technical', 20, { reason: 'no_history' }),
      factor('sentiment', 15),
    ],
    score: null,
    zone: null,
    complete: false,
    missing: ['yield_curve', 'technical', 'sentiment'],
    stale_inputs: ['shiller'],
    scenarios: [
      { id: '2000-03', period: '2000-03', score: 70.5, zone: 'elevated', factors: [] },
      { id: '2007-10', period: '2007-10', score: 52.25, zone: 'watch', factors: [] },
      { id: '2022-01', period: '2022-01', score: 62, zone: 'elevated', factors: [] },
    ],
    stale_after_days: { buffett: 120, shiller: 45, yield_curve: 10, sentiment: 7 },
    upstream: 'https://github.com/middletoo/US_Stock_Crash_Monitor',
    method: 'test',
    ...overrides,
  }
}
const response = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
})

afterEach(() => {
  localStorage.clear()
})

describe('market risk temperature', () => {
  it('posts saved settings on mount and shows an incomplete score without fabricating a number', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(result()))
    vi.stubGlobal('fetch', fetcher)
    render(<MarketRegime locale="zh-TW" revision="r1" expectedSession="2026-09-04" />)
    await screen.findByText('不完整：缺', { exact: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0][1].body)
    expect(body.benchmark).toBe('VOO')
    expect(body.weights).toEqual({
      buffett: 15,
      shiller: 25,
      yield_curve: 25,
      technical: 20,
      sentiment: 15,
    })
    expect(body.inputs.fear_greed).toBeNull()
    expect(screen.getByText('—', { selector: 'h3' })).toBeTruthy()
    expect(
      screen.getByText(/10 年減 2 年公債利差、VOO 200 日均線乖離、恐懼與貪婪指數/),
    ).toBeTruthy()
    expect(screen.getByText(/尚未輸入 yield_2y/)).toBeTruthy()
    expect(screen.getByText(/本機沒有 VOO 日線/)).toBeTruthy()
    expect(screen.getByText(/建議更新/)).toBeTruthy()
    expect(screen.getByText('70.5')).toBeTruthy()
    expect(screen.getByText('52.3')).toBeTruthy()
    expect(screen.queryByText(/減碼|對沖|買 Put/)).toBeNull()
  })
  it('renders a complete score, its zone and the benchmark deviation', async () => {
    const complete = result({
      score: 62.75,
      zone: 'elevated',
      complete: true,
      missing: [],
      stale_inputs: [],
      benchmark: {
        symbol: 'VOO',
        name: 'Vanguard S&P 500 ETF',
        source: 'Yahoo Finance / yfinance',
        bars: 250,
        last_date: '2026-09-04',
        available: true,
        reason: null,
        deviation_pct: 9.95,
        adjusted_close: 110,
        ma200: 100.05,
      },
      factors: [
        factor('buffett', 15, { available: true, value: 190, risk: 90, reason: null }),
        factor('shiller', 25, { available: true, value: 38.1, risk: 90, reason: null }),
        factor('yield_curve', 25, {
          available: true,
          value: 0.4,
          risk: 70,
          status: 'reinversion',
          reason: null,
        }),
        factor('technical', 20, {
          available: true,
          value: 9.95,
          risk: 40,
          as_of: '2026-09-04',
          age_days: 0,
          reason: null,
        }),
        factor('sentiment', 15, { available: true, value: 55, risk: 40, reason: null }),
      ],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(complete)))
    render(<MarketRegime locale="en" revision="r1" expectedSession="2026-09-04" />)
    await screen.findByText('62.8', { selector: 'h3' })
    expect(screen.getAllByText('Elevated').length).toBeGreaterThan(0)
    expect(screen.getByText('+0.40 pp')).toBeTruthy()
    expect(screen.getByText('Re-steepening / flat')).toBeTruthy()
    expect(screen.getByText('10.0%')).toBeTruthy()
    expect(screen.getByRole('img', { name: /Score 62.8, Elevated/ })).toBeTruthy()
  })
  it('validates edited readings, saves them locally and recalculates with the new body', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(result()))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<MarketRegime locale="zh-TW" revision="r1" expectedSession="2026-09-04" />)
    await screen.findByText('不完整：缺', { exact: false })
    await user.click(screen.getByText('輸入宏觀讀數與權重'))
    const fearGreed = screen.getByLabelText('恐懼與貪婪指數（0–100）', {
      selector: 'input[type="number"]',
    })
    await user.clear(fearGreed)
    await user.type(fearGreed, '120')
    await user.click(screen.getByRole('button', { name: '套用並重新計算' }))
    expect(screen.getByRole('alert').textContent).toMatch(/超出允許範圍/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(REGIME_SETTINGS_KEY)).toBeNull()
    await user.clear(fearGreed)
    await user.type(fearGreed, '72')
    await user.type(screen.getByLabelText('恐懼與貪婪指數（0–100） 資料日期'), '2026-09-03')
    const technicalWeight = screen.getByLabelText('VOO 200 日均線乖離', {
      selector: 'input[type="number"]',
    })
    await user.clear(technicalWeight)
    await user.type(technicalWeight, '0')
    await user.click(screen.getByRole('button', { name: '套用並重新計算' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetcher.mock.calls[1][1].body)
    expect(body.inputs.fear_greed).toEqual({ value: 72, as_of: '2026-09-03' })
    expect(body.weights.technical).toBe(0)
    const saved = JSON.parse(localStorage.getItem(REGIME_SETTINGS_KEY) || 'null')
    expect(saved.inputs.fear_greed).toEqual({ value: 72, as_of: '2026-09-03' })
    expect(saved.weights.technical).toBe(0)
  })
  it('shows the server error and recalculates on demand', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ detail: '資料庫忙碌' }, false, 503))
      .mockResolvedValueOnce(response(result()))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<MarketRegime locale="zh-TW" revision="r1" expectedSession="2026-09-04" />)
    expect((await screen.findByRole('alert')).textContent).toBe('資料庫忙碌')
    await user.click(screen.getByRole('button', { name: '重新計算' }))
    await screen.findByText('不完整：缺', { exact: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
