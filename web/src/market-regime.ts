/** Market risk temperature settings: manual macro readings live only in this browser. */
export const REGIME_VERSION = 'alphaview-regime-v1'
export const REGIME_SETTINGS_KEY = 'alphaview-market-regime-v1'
export const FACTOR_IDS = ['buffett', 'shiller', 'yield_curve', 'technical', 'sentiment'] as const
export type FactorId = (typeof FACTOR_IDS)[number]
export const MANUAL_KEYS = [
  'buffett_ratio',
  'shiller_pe',
  'yield_10y',
  'yield_2y',
  'fear_greed',
] as const
export type ManualKey = (typeof MANUAL_KEYS)[number]
export const BENCHMARKS = ['VOO', 'SPY', 'QQQ'] as const
export type Benchmark = (typeof BENCHMARKS)[number]
export type Reading = { value: number; as_of: string | null }
export type RegimeWeights = Record<FactorId, number>
export type RegimeSettings = {
  version: 1
  benchmark: Benchmark
  weights: RegimeWeights
  inputs: Record<ManualKey, Reading | null>
}
export type RegimeZone = 'calm' | 'watch' | 'elevated' | 'extreme'
export type RegimeFactor = {
  id: FactorId
  weight: number
  weight_pct: number
  enabled: boolean
  available: boolean
  value: number | null
  as_of: string | null
  age_days: number | null
  stale: boolean
  risk: number | null
  status: string | null
  reason: string | null
  detail: Record<string, unknown> | null
}
export type RegimeResult = {
  engine_version: string
  as_of: string
  input_revision: string
  benchmark: {
    symbol: string
    name: string | null
    source: string | null
    bars: number
    last_date: string | null
    available: boolean
    reason: string | null
    deviation_pct: number | null
    adjusted_close?: number
    ma200?: number
  }
  weights: RegimeWeights
  factors: RegimeFactor[]
  score: number | null
  zone: RegimeZone | null
  complete: boolean
  missing: FactorId[]
  stale_inputs: FactorId[]
  scenarios: {
    id: string
    period: string
    score: number
    zone: RegimeZone
    factors: {
      id: FactorId
      value: number
      risk: number
      status: string | null
      weight_pct: number
    }[]
  }[]
  stale_after_days: Partial<Record<FactorId, number>>
  upstream: string
  method: string
}

export const MANUAL_RANGES: Record<ManualKey, [number, number]> = {
  buffett_ratio: [0, 1000],
  shiller_pe: [0, 200],
  yield_10y: [-5, 30],
  yield_2y: [-5, 30],
  fear_greed: [0, 100],
}
/** Official or long-running public series for each manual reading; nothing is fetched automatically. */
export const MANUAL_SOURCES: Record<ManualKey, { label: string; url: string }[]> = {
  buffett_ratio: [
    {
      label: 'Longtermtrends · Market cap / GDP',
      url: 'https://www.longtermtrends.net/market-cap-to-gdp-the-buffett-indicator/',
    },
    { label: 'FRED · US GDP', url: 'https://fred.stlouisfed.org/series/GDP' },
  ],
  shiller_pe: [
    { label: 'multpl · Shiller PE', url: 'https://www.multpl.com/shiller-pe' },
    { label: 'Robert Shiller · Online data', url: 'http://www.econ.yale.edu/~shiller/data.htm' },
  ],
  yield_10y: [{ label: 'FRED · DGS10', url: 'https://fred.stlouisfed.org/series/DGS10' }],
  yield_2y: [{ label: 'FRED · DGS2', url: 'https://fred.stlouisfed.org/series/DGS2' }],
  fear_greed: [
    { label: 'CNN · Fear & Greed', url: 'https://edition.cnn.com/markets/fear-and-greed' },
  ],
}
export const DEFAULT_REGIME_SETTINGS: RegimeSettings = {
  version: 1,
  benchmark: 'VOO',
  weights: { buffett: 15, shiller: 25, yield_curve: 25, technical: 20, sentiment: 15 },
  inputs: {
    buffett_ratio: null,
    shiller_pe: null,
    yield_10y: null,
    yield_2y: null,
    fear_greed: null,
  },
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
export const isoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
export function validReading(value: unknown, key: ManualKey): value is Reading {
  if (!value || typeof value !== 'object') return false
  const reading = value as Reading
  const [min, max] = MANUAL_RANGES[key]
  return (
    finite(reading.value) &&
    reading.value >= min &&
    reading.value <= max &&
    (reading.as_of === null || isoDate(reading.as_of))
  )
}
export function validRegimeSettings(value: unknown): value is RegimeSettings {
  if (!value || typeof value !== 'object') return false
  const settings = value as RegimeSettings
  return (
    settings.version === 1 &&
    BENCHMARKS.includes(settings.benchmark) &&
    !!settings.weights &&
    FACTOR_IDS.every(
      (id) =>
        finite(settings.weights[id]) && settings.weights[id] >= 0 && settings.weights[id] <= 100,
    ) &&
    FACTOR_IDS.reduce((sum, id) => sum + settings.weights[id], 0) > 0 &&
    !!settings.inputs &&
    typeof settings.inputs === 'object' &&
    MANUAL_KEYS.every(
      (key) => settings.inputs[key] === null || validReading(settings.inputs[key], key),
    )
  )
}
export function cloneRegimeSettings(settings: RegimeSettings): RegimeSettings {
  return {
    version: 1,
    benchmark: settings.benchmark,
    weights: { ...settings.weights },
    inputs: Object.fromEntries(
      MANUAL_KEYS.map((key) => [key, settings.inputs[key] ? { ...settings.inputs[key]! } : null]),
    ) as RegimeSettings['inputs'],
  }
}
export function readRegimeSettings(): RegimeSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REGIME_SETTINGS_KEY) || 'null')
    if (validRegimeSettings(value)) return cloneRegimeSettings(value)
  } catch {
    /* Fall back to the documented defaults. */
  }
  return cloneRegimeSettings(DEFAULT_REGIME_SETTINGS)
}
export function saveRegimeSettings(settings: RegimeSettings) {
  try {
    localStorage.setItem(REGIME_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* The current page keeps working without persistence. */
  }
}
export function zoneOf(score: number | null): RegimeZone | null {
  if (!finite(score)) return null
  return score >= 80 ? 'extreme' : score >= 60 ? 'elevated' : score >= 40 ? 'watch' : 'calm'
}
export const ZONE_BANDS: { zone: RegimeZone; from: number; to: number }[] = [
  { zone: 'calm', from: 0, to: 40 },
  { zone: 'watch', from: 40, to: 60 },
  { zone: 'elevated', from: 60, to: 80 },
  { zone: 'extreme', from: 80, to: 100 },
]
