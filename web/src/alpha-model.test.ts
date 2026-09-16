import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALPHA_SETTINGS as defaults,
  STRATEGY_IDS,
  rankAlpha,
  portfolioAlerts,
  validAlphaSettings,
} from './alpha-model'
import { overview, position } from './test/fixtures'
import type { Research, Scan } from './types'

function row(symbol: string, matches: string[]): Research {
  return {
    symbol,
    date: '2026-09-04',
    bars: 250,
    indicators: { close: 100, ma50: 95, ma200: 90, rsi: 55, rps: 85 },
    signals: STRATEGY_IDS.map((strategy) => ({
      strategy,
      matched: matches.includes(strategy),
      status: matches.includes(strategy) ? 'match' : 'watch',
      reason: 'test',
    })),
  }
}
function workspace() {
  const data = overview()
  data.summary.expected_session = '2026-09-04'
  const scan: Scan = {
    id: 100,
    as_of: '2026-09-04',
    created_at: '2026-09-05T01:00:00Z',
    scope: 'market',
    input_status: 'current',
    matches_current_universe: true,
    universe: ['AAA', 'BBB', 'CCC'],
    result: [
      row('AAA', ['trend', 'rps']),
      row('BBB', ['turtle', 'trend', 'rps']),
      row('CCC', ['pullback']),
    ],
  }
  data.market_scan = scan
  data.scan = { ...scan, scope: 'portfolio' }
  return data
}
describe('transparent Alpha ranking', () => {
  it('checks user price thresholds only against current quotes of actual holdings', () => {
    const data = workspace()
    data.positions = [
      {
        ...position('AAA'),
        shares: 10,
        price: 100,
        price_date: '2026-09-04',
        quote_status: 'ok',
      },
      {
        ...position('BBB'),
        shares: 0,
        price: 100,
        price_date: '2026-09-04',
        quote_status: 'ok',
      },
    ]
    const settings = {
      ...defaults,
      priceRules: [
        { symbol: 'AAA', below: 100, above: 120 },
        { symbol: 'BBB', below: 100, above: null },
      ],
    }
    const priceAlerts = () =>
      portfolioAlerts(data, settings).filter((alert) => alert.kind.startsWith('price_'))
    expect(priceAlerts()).toMatchObject([
      { symbol: 'AAA', kind: 'price_below', value: 100, threshold: 100, severity: 'high' },
    ])
    const previousId = priceAlerts()[0].id
    settings.priceRules[0].below = 101
    expect(priceAlerts()[0].id).not.toBe(previousId)
    data.positions[0].price_date = '2026-09-03'
    expect(priceAlerts()).toEqual([])
    expect(
      validAlphaSettings({ ...settings, priceRules: [{ symbol: 'AAA', below: 120, above: 100 }] }),
    ).toBe(false)
  })
  it('normalizes relative weights and requires two matching enabled strategies by default', () => {
    const data = workspace()
    const result = rankAlpha(data, 'market', defaults)
    expect(result.rows.map((r) => [r.symbol, r.score, r.alpha])).toEqual([
      ['BBB', 75, true],
      ['AAA', 50, true],
      ['CCC', 25, false],
    ])
    const doubled = { ...defaults, weights: { turtle: 50, trend: 50, pullback: 50, rps: 50 } }
    expect(rankAlpha(data, 'market', doubled).rows.map((r) => r.score)).toEqual([75, 50, 25])
  })
  it('never rewards missing strategy data by redistributing its weight', () => {
    const data = workspace()
    data.market_scan!.result[0].signals[2].status = 'insufficient'
    const candidate = rankAlpha(data, 'market', defaults).rows.find((r) => r.symbol === 'AAA')!
    expect(candidate.score).toBe(50)
    expect(candidate.coverage).toBe(75)
    expect(candidate.alpha).toBe(false)
    const disabled = { ...defaults, weights: { turtle: 25, trend: 25, pullback: 0, rps: 25 } }
    expect(rankAlpha(data, 'market', disabled).rows.find((r) => r.symbol === 'AAA')!.alpha).toBe(
      true,
    )
  })
  it('excludes stale snapshots, changed membership, invalid dates and malformed signal pairs', () => {
    const data = workspace()
    data.market_scan!.input_status = 'stale'
    expect(rankAlpha(data, 'market', defaults).rows).toEqual([])
    data.market_scan!.input_status = 'current'
    data.market_scan!.matches_current_universe = false
    expect(rankAlpha(data, 'market', defaults).ready).toBe(false)
    data.market_scan!.matches_current_universe = true
    data.market_scan!.result[1].date = '2026-09-03'
    data.market_scan!.result[0].signals[1].matched = false
    const result = rankAlpha(data, 'market', defaults)
    expect(result.rows.map((r) => r.symbol)).not.toContain('BBB')
    expect(result.rows.find((r) => r.symbol === 'AAA')!.alpha).toBe(false)
  })
  it('marks held and watched symbols without mixing personal and market RPS', () => {
    const data = workspace()
    data.positions = [position('AAA'), { ...position('BBB'), shares: 0 }]
    const result = rankAlpha(data, 'market', defaults)
    expect(result.rows.map((r) => r.relation)).toEqual(['watchlist', 'held', 'new'])
    data.scan!.result = [row('AAA', [])]
    expect(rankAlpha(data, 'portfolio', defaults).alpha).toEqual([])
  })
  it('rejects all-zero, nonfinite, negative, and malformed settings', () => {
    expect(validAlphaSettings(defaults)).toBe(true)
    expect(
      validAlphaSettings({ ...defaults, weights: { turtle: 0, trend: 0, pullback: 0, rps: 0 } }),
    ).toBe(false)
    expect(validAlphaSettings({ ...defaults, threshold: Infinity })).toBe(false)
    expect(validAlphaSettings({ ...defaults, minMatches: 1.5 })).toBe(false)
    expect(validAlphaSettings({ ...defaults, weights: { ...defaults.weights, rps: -1 } })).toBe(
      false,
    )
  })
})
describe('holding attention conditions', () => {
  it('keeps risk alerts separate from scores and excludes zero-share watchlist entries', () => {
    const data = workspace()
    data.positions = [
      { ...position('AAA'), weight: 54, change_pct: -6 },
      { ...position('BBB'), shares: 0, weight: 40 },
    ]
    data.scan!.result[0].indicators = { close: 100, ma50: 110, ma200: 105, rsi: 80 }
    expect(portfolioAlerts(data, defaults).map((a) => a.kind)).toEqual([
      'below_ma200',
      'concentration',
      'daily_drop',
      'overbought',
    ])
    expect(portfolioAlerts(data, defaults).every((a) => a.symbol === 'AAA')).toBe(true)
  })
  it('does not present stale data as a current price or technical risk signal', () => {
    const data = workspace()
    data.positions = [{ ...position('AAA'), quote_status: 'stale', change_pct: -20 }]
    expect(portfolioAlerts(data, defaults).map((a) => a.kind)).toEqual(['data_gap'])
    data.positions[0].quote_status = 'ok'
    data.positions[0].weight = null
    data.positions[0].change_pct = null
    data.scan!.input_status = 'unknown'
    expect(portfolioAlerts(data, defaults).map((a) => a.kind)).toEqual(['signal_gap'])
  })
  it('uses session-specific review IDs that change with alert thresholds', () => {
    const data = workspace()
    data.positions = [{ ...position('AAA'), weight: 30 }]
    const first = portfolioAlerts(data, defaults).find((a) => a.kind === 'concentration')!
    const next = portfolioAlerts(data, { ...defaults, concentration: 20 }).find(
      (a) => a.kind === 'concentration',
    )!
    expect(first.id).not.toBe(next.id)
  })
})
