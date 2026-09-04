import { describe, expect, it } from 'vitest'
import { marketOverview } from './market-overview-model'
import type { Research, Scan } from './types'
import { overview } from './test/fixtures'
const row = (
  symbol: string,
  indicators: Research['indicators'],
  status: Research['signals'][number]['status'] = 'watch',
  date: string | null = '2026-09-04',
): Research => ({
  symbol,
  date,
  bars: 250,
  indicators,
  signals: [{ strategy: 'trend', status, matched: status === 'match', reason: 'test' }],
})
const snapshot = (rows: Research[], universe = rows.map((r) => r.symbol)): Scan => ({
  scope: 'market',
  id: 1,
  as_of: '2026-09-04',
  created_at: '2026-09-05',
  universe,
  result: rows,
})
describe('market breadth denominators', () => {
  it('uses distinct eligible samples for MA50, MA200, RSI and strategy coverage', () => {
    const scan = snapshot(
      [
        row('A', { close: 100, ma50: 90, ma200: 110, rsi: 70, return120: 0.2 }, 'match'),
        row('B', { close: 100, ma50: 110, ma200: null, rsi: 30, return120: -0.1 }),
        row('C', { close: 100, ma50: null, ma200: 90, rsi: null }, 'insufficient'),
        row('BAD', { close: 100, ma50: 1, ma200: 1, rsi: 80 }, 'data_error'),
        row('OLD', { close: 100, ma50: 1, ma200: 1, rsi: 80 }, 'watch', '2026-09-03'),
      ],
      ['A', 'B', 'C', 'BAD', 'OLD', 'MISSING'],
    )
    const model = marketOverview(scan, overview().strategies)
    expect(model.coverage).toEqual({ total: 6, usable: 3, dataError: 1, stale: 1, missing: 1 })
    expect(model.ma50).toEqual({ count: 1, eligible: 2, excluded: 4, percent: 50 })
    expect(model.ma200).toEqual({ count: 1, eligible: 2, excluded: 4, percent: 50 })
    expect(model.overbought).toEqual({ count: 1, eligible: 2, excluded: 4, percent: 50 })
    expect(model.oversold.count).toBe(1)
    expect(model.strategies.find((s) => s.strategy.id === 'trend')).toMatchObject({
      count: 1,
      eligible: 2,
      excluded: 4,
    })
    expect(model.leaders.map((r) => r.symbol)).toEqual(['A', 'B'])
  })
  it('does not count zero, negative, nonfinite or unavailable metrics as valid', () => {
    const model = marketOverview(
      snapshot([
        row('A', { close: 100, ma50: 0, ma200: -1, rsi: 101, return120: Infinity }),
        row('B', { close: 0, ma50: 1, ma200: 1, rsi: 30 }),
        row('C', { close: NaN, ma50: 1, ma200: 1, rsi: 30 }),
        row('D', { close: 100, ma50: NaN, ma200: Infinity, rsi: -1, return120: -2 }),
      ]),
      overview().strategies,
    )
    expect(model.coverage.usable).toBe(2)
    expect(model.ma50.percent).toBeNull()
    expect(model.ma200.percent).toBeNull()
    expect(model.overbought.eligible).toBe(0)
    expect(model.oversold.percent).toBeNull()
    expect(model.returnEligible).toBe(0)
  })
  it('respects declared snapshot membership, deduplicates symbols, and excludes explicit bad quality', () => {
    const bad = {
      ...row('A', { close: 100, ma50: 1 }),
      quality: { valid: false, status: 'data_error' },
    }
    const scan = snapshot([bad, row('EXTRA', { close: 100, ma50: 1 })], ['A', 'A'])
    const model = marketOverview(scan, overview().strategies)
    expect(model.coverage).toEqual({ total: 1, usable: 0, dataError: 1, stale: 0, missing: 0 })
    expect(model.ma50.percent).toBeNull()
  })
  it('excludes contradictory or duplicate strategy signals from that strategy denominator', () => {
    const contradictory = row('BAD', { close: 100 }, 'match')
    contradictory.signals[0].matched = false
    const duplicate = row('DUPLICATE', { close: 100 }, 'match')
    duplicate.signals.push({ ...duplicate.signals[0], status: 'watch', matched: false })
    const valid = row('VALID', { close: 100 }, 'match')
    const model = marketOverview(snapshot([contradictory, duplicate, valid]), overview().strategies)
    expect(model.strategies.find((strategy) => strategy.strategy.id === 'trend')).toMatchObject({
      count: 1,
      eligible: 1,
      excluded: 2,
      percent: 100,
    })
    // Valid observed quotes remain useful for other independent measurements.
    expect(model.coverage.usable).toBe(3)
  })
  it('classifies explicit no-data and invalid history counts as missing', () => {
    const absent = {
      ...row('ABSENT', { close: 100 }),
      quality: { status: 'no_data', valid: false },
    }
    const invalidCounts = [NaN, Infinity, -1, 1.5].map((bars, i) => ({
      ...row(`COUNT${i}`, { close: 100, ma50: 90 }),
      bars,
    }))
    const model = marketOverview(snapshot([absent, ...invalidCounts]), overview().strategies)
    expect(model.coverage).toEqual({ total: 5, usable: 0, dataError: 0, stale: 0, missing: 5 })
  })
  it('requires a complete return window and finite displayed percentage for ranking', () => {
    const short = { ...row('SHORT', { close: 100, return120: 0.9 }), bars: 59 }
    const huge = row('HUGE', { close: 100, return120: 1e308 })
    const valid = row('VALID', { close: 100, return120: 0.5 })
    const model = marketOverview(snapshot([short, huge, valid]), overview().strategies)
    expect(model.returnEligible).toBe(1)
    expect(model.leaders.map((entry) => entry.symbol)).toEqual(['VALID'])
    expect(model.leaders.every((entry) => Number.isFinite(entry.indicators.return120! * 100))).toBe(
      true,
    )
  })
})
