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
    if (filters[field].length > 30) return '每個數值條件最多 30 個字元，請縮短輸入後再儲存。'
    const raw = filters[field].trim()
    if (!raw) continue
    // HTML valid floating-point syntax; Number() also accepts invisible hex/space forms.
    if (!/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(filters[field]))
      return '數值請使用十進位或科學記號，不可含空白、前置加號或其他格式。'
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
export function validatePreset(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '篩選設定格式不正確。'
  const preset = value as Partial<Preset>
  if (preset.version !== 1) return '不支援此篩選設定版本。'
  if (typeof preset.name !== 'string' || !preset.name.trim()) return '請先輸入篩選設定名稱。'
  if (preset.name.length > 60) return '篩選設定名稱最多 60 個字元。'
  const settings = preset.settings
  if (
    !settings ||
    !['market', 'portfolio'].includes(settings.scope) ||
    !STRATEGIES.includes(settings.strategy) ||
    typeof settings.only !== 'boolean' ||
    typeof settings.newOnly !== 'boolean' ||
    typeof settings.query !== 'string' ||
    !SORT_KEYS.includes(settings.sort) ||
    !['asc', 'desc'].includes(settings.direction)
  )
    return '篩選設定欄位格式不正確。'
  if (settings.query.length > 200) return '搜尋文字最多 200 個字元，請縮短輸入後再儲存。'
  if (
    !settings.numeric ||
    !NUMERIC_FIELDS.every((key) => typeof settings.numeric[key] === 'string')
  )
    return '數值條件欄位格式不正確。'
  return validateNumeric(settings.numeric)
}
export function decodePresets(raw: string | null): Preset[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    const names = new Set<string>()
    return parsed
      .filter((preset): preset is Preset => {
        if (validatePreset(preset) || names.has(preset.name)) return false
        names.add(preset.name)
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
  context: {
    scope: Scope
    asOf: string
    createdAt: string
    sources: Record<string, string>
    snapshotId?: number
    inputRevision?: string | null
    inputStatus?: string
  },
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
    'snapshot_id',
    'input_revision',
    'input_status',
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
      context.snapshotId,
      context.inputRevision,
      context.inputStatus || 'unknown',
    ]),
  ]
  return '\uFEFF' + lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
