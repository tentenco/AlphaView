import { expect, it } from 'vitest'
import type { ComparisonResult } from './Comparison'
import { comparisonDailyCsv, comparisonSummaryCsv } from './comparison-export'
function parse(csv: string) {
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  const raw = csv.replace(/^\uFEFF/, '')
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') {
      if (quoted && raw[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (raw[i] === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if (raw[i] === '\r' && raw[i + 1] === '\n' && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += raw[i]
  }
  return rows
    .slice(1)
    .map((values) => Object.fromEntries(rows[0].map((key, i) => [key, values[i]])))
}
function result(): ComparisonResult {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03']
  return {
    as_of: dates[2],
    window: 60,
    anchor_date: dates[0],
    end_date: dates[2],
    expected_prices: 61,
    requested_count: 2,
    eligible_count: 1,
    complete: false,
    status: 'insufficient',
    input_revision: 'recorded-inputs',
    comparison_engine_version: 'recorded-engine',
    dates,
    warnings: [],
    method: '',
    series: [
      {
        symbol: 'AAPL',
        name: ' \n=SUM(1,2) "unsafe"',
        source: 'Synthetic source',
        eligible: true,
        reason: null,
        observed_prices: 61,
        valid_prices: 61,
        anchor_price: 100,
        latest_price: 100,
        return_pct: 0,
        points: dates.map((date, i) => ({
          date,
          return_pct: i === 0 ? 0 : i === 1 ? -2 : Infinity,
        })),
      },
      {
        symbol: 'MISSING',
        name: 'Missing',
        source: null,
        eligible: false,
        reason: '+Unavailable',
        observed_prices: 0,
        valid_prices: 0,
        anchor_price: 999,
        latest_price: NaN,
        return_pct: null,
        points: [],
      },
    ],
  }
}
it('exports actual summary metadata, every requested series and finite/null/zero distinctions safely', () => {
  const csv = comparisonSummaryCsv(result(), { workspaceChanged: true, draftChanged: true })
  expect(csv.startsWith('\uFEFF')).toBe(true)
  expect(csv.endsWith('\r\n')).toBe(true)
  const rows = parse(csv)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    as_of: '2026-09-03',
    window_sessions: '60',
    input_revision: 'recorded-inputs',
    comparison_engine_version: 'recorded-engine',
    workspace_changed_since_result: 'true',
    draft_differs_from_result: 'true',
    return_pct: '0',
    anchor_adjusted_close: '100',
    name: '\' \n=SUM(1,2) "unsafe"',
  })
  expect(rows[1]).toMatchObject({
    source: '',
    eligible: 'false',
    reason: "'+Unavailable",
    observed_prices: '0',
    anchor_adjusted_close: '',
    latest_adjusted_close: '',
    return_pct: '',
  })
  expect(csv).not.toMatch(/NaN|Infinity/)
})
it('exports all dated observations plus an explicit unavailable-series row without deriving prices', () => {
  const rows = parse(comparisonDailyCsv(result(), { workspaceChanged: false, draftChanged: false }))
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({
    date: '2026-09-01',
    return_pct_from_common_anchor: '0',
    point_available: 'true',
  })
  expect(rows[1]).toMatchObject({ return_pct_from_common_anchor: '-2', point_available: 'true' })
  expect(rows[2]).toMatchObject({
    date: '2026-09-03',
    return_pct_from_common_anchor: '',
    point_available: 'false',
  })
  expect(rows[3]).toMatchObject({
    symbol: 'MISSING',
    date: '',
    return_pct_from_common_anchor: '',
    point_available: 'false',
  })
  expect(rows.every((row) => row.input_revision === 'recorded-inputs')).toBe(true)
  expect(
    Object.keys(rows[0]).some(
      (key) => key.includes('price') && !['valid_prices', 'expected_prices'].includes(key),
    ),
  ).toBe(false)
})
it('exports every daily row across a full 252-session comparison without a display-page limit', () => {
  const data = result()
  data.window = 252
  data.expected_prices = 253
  data.dates = Array.from({ length: 253 }, (_, i) =>
    new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
  )
  data.anchor_date = data.dates[0]
  data.end_date = data.dates.at(-1)!
  data.series[0].points = data.dates.map((date, i) => ({ date, return_pct: i / 10 }))
  const exported = parse(comparisonDailyCsv(data, { workspaceChanged: false, draftChanged: true }))
  expect(exported).toHaveLength(254)
  expect(exported[252]).toMatchObject({
    date: data.end_date,
    return_pct_from_common_anchor: '25.2',
    window_sessions: '252',
    draft_differs_from_result: 'true',
  })
  expect(exported[253].symbol).toBe('MISSING')
})
