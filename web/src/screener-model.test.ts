import { describe, expect, it } from 'vitest'
import type { Research } from './types'
import { csvCell, decodePresets, EMPTY_NUMERIC, filterRows, screenerCsv, validateNumeric } from './screener-model'
import type { ScreenerSettings } from './screener-model'
const settings = (extra: Partial<ScreenerSettings> = {}): ScreenerSettings => ({ scope: 'market', strategy: 'all', only: false, newOnly: true, query: '', numeric: { ...EMPTY_NUMERIC }, sort: 'rsi', direction: 'asc', ...extra })
const row = (symbol: string, rsi: number | null, extra = {}): Research => ({ symbol, date: '2026-09-04', bars: 250, indicators: { close: 100, rsi, ...extra }, signals: [] })
describe('screener numeric filters and sorting', () => {
  it('keeps missing unrelated metrics but excludes missing or non-finite filtered metrics', () => {
    const rows = [row('NULL', null), row('GOOD', 50), row('NAN', NaN), row('INF', Infinity)]
    expect(filterRows(rows, settings(), new Set())).toHaveLength(4)
    expect(filterRows(rows, settings({ numeric: { ...EMPTY_NUMERIC, priceMin: '20' } }), new Set())).toHaveLength(4)
    expect(filterRows(rows, settings({ numeric: { ...EMPTY_NUMERIC, rsiMin: '0' } }), new Set()).map(r => r.symbol)).toEqual(['GOOD'])
  })
  it.each(['asc', 'desc'] as const)('sorts missing values last in %s order with stable symbol ties', direction => {
    const sorted = filterRows([row('NULL', null), row('B', 50), row('A', 50), row('LOW', 10)], settings({ direction }), new Set())
    expect(sorted.map(r => r.symbol)).toEqual(direction === 'asc' ? ['LOW', 'A', 'B', 'NULL'] : ['A', 'B', 'LOW', 'NULL'])
  })
  it('validates bounds, finite values and integral match count', () => {
    for (const extra of [{ rsiMin: '101' }, { priceMin: '-1' }, { volumeMin: 'Infinity' }, { matchesMin: '1.5' }, { matchesMin: '5' }, { rsiMin: '60', rsiMax: '40' }]) expect(validateNumeric({ ...EMPTY_NUMERIC, ...extra })).toBeTruthy()
    expect(validateNumeric({ ...EMPTY_NUMERIC, rsiMin: '0', rsiMax: '100', matchesMin: '4' })).toBeNull()
    expect(filterRows([row('A', 50)], settings({ numeric: { ...EMPTY_NUMERIC, rpsMin: 'NaN' } }), new Set())).toEqual([])
  })
  it('applies new-only only in market scope and selected matching strategy', () => {
    const hit = { ...row('A', 50), signals: [{ strategy: 'trend', matched: true, status: 'match' as const, reason: 'match' }] }
    expect(filterRows([hit], settings(), new Set(['A']))).toEqual([])
    expect(filterRows([hit], settings({ scope: 'portfolio' }), new Set(['A']))).toHaveLength(1)
    expect(filterRows([hit], settings({ only: true, strategy: 'turtle' }), new Set())).toEqual([])
  })
})
describe('saved presets', () => {
  it('accepts validated version-one records and rejects corrupt, unknown or duplicated records', () => {
    const good = { version: 1, name: 'Good', settings: settings() }
    const bad = [{ ...good, version: 2 }, { ...good, name: '' }, { ...good, settings: { ...settings(), scope: 'all' } }, { ...good, settings: { ...settings(), numeric: { ...EMPTY_NUMERIC, rsiMin: '200' } } }, { ...good, settings: { ...settings(), only: 'true' } }, { ...good, settings: { ...settings(), sort: '__proto__' } }]
    expect(decodePresets(JSON.stringify([...bad, good, good]))).toEqual([good])
    for (const raw of [null, '{broken', '{}', 'null', '[null, 1, "x"]']) expect(decodePresets(raw)).toEqual([])
  })
})
describe('CSV export', () => {
  it('escapes formula text and quotes without converting valid negative numbers', () => {
    expect(csvCell(' =SUM(A1)')).toBe('"\' =SUM(A1)"')
    expect(csvCell('@bad')).toBe('"\'@bad"')
    expect(csvCell('line,"quoted"')).toBe('"line,""quoted"""')
    expect(csvCell(-3)).toBe('"-3"')
  })
  it('exports all filtered rows with provenance rather than a 25-row page', () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ ...row(`S${i}`, 50), name: i === 0 ? '=evil()' : 'Company' }))
    const csv = screenerCsv(filterRows(rows, settings(), new Set()), { scope: 'market', asOf: '2026-09-04', createdAt: '2026-09-05T00:00:00Z', sources: { S0: 'Official test source' } })
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv.trim().split('\r\n')).toHaveLength(33)
    expect(csv).toContain('"S31"'); expect(csv).toContain('"\'=evil()"')
    expect(csv).toContain('"Official test source"'); expect(csv).toContain('"2026-09-05T00:00:00Z"')
  })
})
