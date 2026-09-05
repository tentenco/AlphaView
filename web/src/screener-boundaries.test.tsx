import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Screener } from './Screener'
import {
  decodePresets,
  validateNumeric,
  EMPTY_NUMERIC,
  filterRows,
  PRESET_KEY,
  screenerCsv,
  type ScreenerSettings,
} from './screener-model'
import { marketOverview } from './market-overview-model'
import { overview, response } from './test/fixtures'
import type { Research, Scan } from './types'
vi.mock('./SignalChanges', () => ({ SignalChanges: () => null }))
afterEach(() => localStorage.clear())
const settings = (): ScreenerSettings => ({
  scope: 'market',
  strategy: 'trend',
  only: true,
  newOnly: true,
  query: 'synthetic',
  numeric: {
    ...EMPTY_NUMERIC,
    priceMin: '100',
    priceMax: '900',
    rsiMin: '20',
    rsiMax: '80',
    volumeMin: '1',
    rpsMin: '50',
    matchesMin: '1',
  },
  sort: 'rsi',
  direction: 'desc',
})
function rows(): Research[] {
  return Array.from({ length: 1000 }, (_, i) => ({
    symbol: `S${String(i).padStart(4, '0')}`,
    name: `Synthetic ${i}`,
    date: '2026-09-04',
    bars: 250,
    indicators: {
      close: i + 1,
      rsi: i % 7 === 0 ? null : (i % 5) * 20,
      rps: i % 11 === 0 ? null : 75,
      volume_ratio: i % 13 === 0 ? null : 2,
      ma50: 100,
      ma200: 100,
    },
    signals: [
      {
        strategy: 'trend',
        matched: i % 3 === 0,
        status: i % 3 === 0 ? 'match' : 'watch',
        reason: 'Synthetic condition',
      },
    ],
  }))
}
function scan(result: Research[]): Scan {
  return {
    id: 1,
    scope: 'market',
    as_of: '2026-09-04',
    created_at: '2026-09-05T00:00:00Z',
    universe: result.map((row) => row.symbol),
    result,
  }
}
describe('large screener boundary audit', () => {
  it('preserves exact combined filtering and stable ties across1000 rows, preset roundtrip, and full CSV', () => {
    const source = rows()
    const held = new Set(source.filter((_, i) => i % 17 === 0).map((row) => row.symbol))
    const config = settings()
    const expected = source
      .filter(
        (_, i) =>
          i % 3 === 0 &&
          i % 17 !== 0 &&
          i + 1 >= 100 &&
          i + 1 <= 900 &&
          i % 7 !== 0 &&
          i % 5 >= 1 &&
          i % 11 !== 0 &&
          i % 13 !== 0,
      )
      .sort((a, b) => b.indicators.rsi! - a.indicators.rsi! || a.symbol.localeCompare(b.symbol))
    const actual = filterRows([...source].reverse(), config, held)
    expect(actual.map((row) => row.symbol)).toEqual(expected.map((row) => row.symbol))
    const restored = decodePresets(
      JSON.stringify([{ version: 1, name: 'Synthetic', settings: config }]),
    )[0]
    expect(filterRows(source, restored.settings, held)).toEqual(actual)
    const csv = screenerCsv(actual, {
      scope: 'market',
      asOf: '2026-09-04',
      createdAt: '2026-09-05T00:00:00Z',
      sources: {},
    })
    expect([...csv.matchAll(/^"(S\d+)"/gm)].map((match) => match[1])).toEqual(
      actual.map((row) => row.symbol),
    )
    expect(source[0].symbol).toBe('S0000')
    const model = marketOverview(scan(source), overview().strategies)
    expect(model.strategies.find((row) => row.strategy.id === 'trend')?.count).toBe(334)
    expect(
      filterRows(
        source,
        { ...config, query: '', newOnly: false, numeric: { ...EMPTY_NUMERIC } },
        held,
      ),
    ).toHaveLength(334)
  })
  it('rejects a nondecimal preset before an invisible filter can be applied', async () => {
    const config = { ...settings(), query: '', numeric: { ...EMPTY_NUMERIC, priceMin: '0x10' } }
    localStorage.setItem(
      PRESET_KEY,
      JSON.stringify([{ version: 1, name: 'Hex preset', settings: config }]),
    )
    expect(decodePresets(localStorage.getItem(PRESET_KEY))).toHaveLength(0)
    const candidates = rows().slice(0, 25)
    const data = overview()
    data.market_scan = scan(candidates)
    data.market_scan_dates = [{ as_of: '2026-09-04' }]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(data.market_scan))),
    )
    render(<Screener data={data} busy={false} onRun={vi.fn()} onOpen={vi.fn()} onAdded={vi.fn()} />)
    await screen.findByRole('button', { name: 'S0000' })
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    expect(screen.queryByRole('option', { name: 'Hex preset' })).toBeNull()
    expect(screen.getByRole('spinbutton', { name: '調整股價下限（USD）' })).toHaveProperty(
      'value',
      '',
    )
    expect(screen.getByRole('button', { name: 'S0000' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'S0015' })).toBeTruthy()
  })
  it.each(['0x10', '0b10', '0o10', '+1', ' 1', '1 ', '1.', '1.e2', '1_000', '１２', '1e', '1e+'])(
    'rejects number-control incompatible saved value %s',
    (value) => {
      expect(validateNumeric({ ...EMPTY_NUMERIC, priceMin: value })).toBeTruthy()
      expect(
        decodePresets(
          JSON.stringify([
            {
              version: 1,
              name: 'invalid',
              settings: { ...settings(), numeric: { ...EMPTY_NUMERIC, priceMin: value } },
            },
          ]),
        ),
      ).toEqual([])
    },
  )
  it.each(['0', '-0', '01', '0.5', '.5', '1e2', '1E+2', '1e-2', '0'.repeat(29) + '1'])(
    'roundtrips visible decimal/scientific value %s unchanged',
    (value) => {
      const numeric = { ...EMPTY_NUMERIC, priceMin: value }
      expect(validateNumeric(numeric)).toBeNull()
      const input = document.createElement('input')
      input.type = 'number'
      input.value = value
      expect(input.value).toBe(value)
      const preset = { version: 1, name: 'valid', settings: { ...settings(), numeric } }
      expect(decodePresets(JSON.stringify([preset]))).toEqual([preset])
    },
  )
})
