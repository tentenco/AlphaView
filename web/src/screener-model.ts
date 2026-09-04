import type { Research, Scope } from './types'

export const PRESET_KEY = 'alphaview.screener.presets.v1'
export const NUMERIC_FIELDS = [
  'priceMin',
  'priceMax',
  'rsiMin',
  'rsiMax',
  'volumeMin',
  'rpsMin',
  'matchesMin',
] as const
export type NumericField = (typeof NUMERIC_FIELDS)[number]
export type NumericFilters = Record<NumericField, string>
export const EMPTY_NUMERIC: NumericFilters = {
  priceMin: '',
  priceMax: '',
  rsiMin: '',
  rsiMax: '',
  volumeMin: '',
  rpsMin: '',
  matchesMin: '',
}
export const SORT_KEYS = ['matches', 'symbol', 'close', 'rsi', 'volume_ratio', 'rps'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type ScreenerSettings = {
  scope: Scope
  strategy: string
  only: boolean
  newOnly: boolean
  query: string
  numeric: NumericFilters
  sort: SortKey
  direction: 'asc' | 'desc'
}
export type Preset = { version: 1; name: string; settings: ScreenerSettings }
const STRATEGIES = ['all', 'turtle', 'trend', 'pullback', 'rps']

export function validateNumeric(filters: NumericFilters): string | null {
  for (const field of NUMERIC_FIELDS) {
    const raw = filters[field].trim()
    if (!raw) continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return '數值條件須為零以上的有限數字。'
    if (['rsiMin', 'rsiMax', 'rpsMin'].includes(field) && value > 100)
      return 'RSI 與 RPS 須介於 0–100。'
    if (field === 'matchesMin' && (!Number.isInteger(value) || value > 4))
      return '符合策略數須為 0–4 的整數。'
  }
  for (const [min, max] of [
    ['priceMin', 'priceMax'],
    ['rsiMin', 'rsiMax'],
  ] as const) {
    if (filters[min].trim() && filters[max].trim() && Number(filters[min]) > Number(filters[max]))
      return '範圍下限不可大於上限。'
  }
  return null
}
export const matchCount = (row: Research) => row.signals.filter((signal) => signal.matched).length
function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
export function filterRows(
  rows: Research[],
  settings: ScreenerSettings,
  held: Set<string>,
): Research[] {
  if (validateNumeric(settings.numeric)) return []
  const tests: [NumericField, string, 'min' | 'max'][] = [
    ['priceMin', 'close', 'min'],
    ['priceMax', 'close', 'max'],
    ['rsiMin', 'rsi', 'min'],
    ['rsiMax', 'rsi', 'max'],
    ['volumeMin', 'volume_ratio', 'min'],
    ['rpsMin', 'rps', 'min'],
    ['matchesMin', 'matches', 'min'],
  ]
  return rows
    .filter((row) => {
      if (
        settings.only &&
        !row.signals.some(
          (s) => s.matched && (settings.strategy === 'all' || s.strategy === settings.strategy),
        )
      )
        return false
      if (settings.scope === 'market' && settings.newOnly && held.has(row.symbol)) return false
      if (
        !`${row.symbol} ${row.name || ''}`
          .toLowerCase()
          .includes(settings.query.trim().toLowerCase())
      )
        return false
      return tests.every(([field, metric, comparison]) => {
        const raw = settings.numeric[field].trim()
        if (!raw) return true
        const value = metric === 'matches' ? matchCount(row) : row.indicators[metric]
        return finite(value) && (comparison === 'min' ? value >= Number(raw) : value <= Number(raw))
      })
    })
    .sort((a, b) => {
      if (settings.sort === 'symbol')
        return a.symbol.localeCompare(b.symbol) * (settings.direction === 'asc' ? 1 : -1)
      const x = settings.sort === 'matches' ? matchCount(a) : a.indicators[settings.sort]
      const y = settings.sort === 'matches' ? matchCount(b) : b.indicators[settings.sort]
      if (!finite(x) && finite(y)) return 1
      if (finite(x) && !finite(y)) return -1
      return (
        (finite(x) && finite(y) ? (x - y) * (settings.direction === 'asc' ? 1 : -1) : 0) ||
        a.symbol.localeCompare(b.symbol)
      )
    })
}
export function decodePresets(raw: string | null): Preset[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    const names = new Set<string>()
    return parsed
      .filter((p): p is Preset => {
        if (
          !p ||
          typeof p !== 'object' ||
          p.version !== 1 ||
          typeof p.name !== 'string' ||
          !p.name.trim() ||
          p.name.length > 60 ||
          names.has(p.name)
        )
          return false
        const s = p.settings
        if (
          !s ||
          !['market', 'portfolio'].includes(s.scope) ||
          !STRATEGIES.includes(s.strategy) ||
          typeof s.only !== 'boolean' ||
          typeof s.newOnly !== 'boolean' ||
          typeof s.query !== 'string' ||
          s.query.length > 200 ||
          !SORT_KEYS.includes(s.sort) ||
          !['asc', 'desc'].includes(s.direction)
        )
          return false
        if (
          !s.numeric ||
          !NUMERIC_FIELDS.every(
            (k) => typeof s.numeric[k] === 'string' && s.numeric[k].length <= 30,
          ) ||
          validateNumeric(s.numeric)
        )
          return false
        names.add(p.name)
        return true
      })
      .slice(0, 30)
  } catch {
    return []
  }
}
export function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value)
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}
export function screenerCsv(
  rows: Research[],
  context: { scope: Scope; asOf: string; createdAt: string; sources: Record<string, string> },
): string {
  const header = [
    'symbol',
    'name',
    'scope',
    'scan_date',
    'data_date',
    'calculated_at',
    'source',
    'adjusted_close',
    'rsi14',
    'relative_volume',
    'rps',
    'matched_strategies',
    'signal_details',
  ]
  const lines: unknown[][] = [
    header,
    ...rows.map((r) => [
      r.symbol,
      r.name || '',
      context.scope,
      context.asOf,
      r.date,
      context.createdAt,
      context.sources[r.symbol] || 'Yahoo Finance / yfinance',
      r.indicators.close,
      r.indicators.rsi,
      r.indicators.volume_ratio,
      r.indicators.rps,
      matchCount(r),
      r.signals.map((s) => `${s.strategy}: ${s.status} — ${s.reason}`).join(' | '),
    ]),
  ]
  return '\uFEFF' + lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
