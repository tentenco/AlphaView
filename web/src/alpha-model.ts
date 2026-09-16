import type { Overview, Research, Scan, Scope } from './types'

export const STRATEGY_IDS = ['turtle', 'trend', 'pullback', 'rps'] as const
export type StrategyId = (typeof STRATEGY_IDS)[number]
export type Weights = Record<StrategyId, number>
export const ALPHA_VERSION = 'alphaview-alpha-v1'
export const ALPHA_SETTINGS_KEY = 'alphaview-alpha-settings-v1'
export const WEIGHT_PRESETS: Record<string, Weights> = {
  balanced: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
  momentum: { turtle: 30, trend: 35, pullback: 5, rps: 30 },
  pullback: { turtle: 15, trend: 15, pullback: 50, rps: 20 },
}
export type AlphaSettings = {
  version: 1
  weights: Weights
  threshold: number
  minMatches: number
  concentration: number
  dailyDrop: number
  overbought: number
  priceRules?: PriceRule[]
}
export type PriceRule = { symbol: string; below: number | null; above: number | null }
export function validPriceRules(value: unknown): value is PriceRule[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (rule) =>
        rule &&
        typeof rule === 'object' &&
        typeof rule.symbol === 'string' &&
        /^[A-Z][A-Z0-9.-]{0,9}$/.test(rule.symbol) &&
        (rule.below === null || (finite(rule.below) && rule.below > 0 && rule.below <= 1e8)) &&
        (rule.above === null || (finite(rule.above) && rule.above > 0 && rule.above <= 1e8)) &&
        (rule.below !== null || rule.above !== null) &&
        (rule.below === null || rule.above === null || rule.below < rule.above),
    ) &&
    new Set(value.map((rule) => rule.symbol)).size === value.length
  )
}
export const DEFAULT_ALPHA_SETTINGS: AlphaSettings = {
  version: 1,
  weights: WEIGHT_PRESETS.balanced,
  threshold: 50,
  minMatches: 2,
  concentration: 25,
  dailyDrop: 5,
  overbought: 75,
}
export const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const range = (v: unknown, min: number, max: number) => finite(v) && v >= min && v <= max
export function validAlphaSettings(value: unknown): value is AlphaSettings {
  if (!value || typeof value !== 'object') return false
  const s = value as AlphaSettings
  return (
    s.version === 1 &&
    !!s.weights &&
    STRATEGY_IDS.every((id) => range(s.weights[id], 0, 100)) &&
    STRATEGY_IDS.reduce((sum, id) => sum + s.weights[id], 0) > 0 &&
    range(s.threshold, 1, 100) &&
    range(s.minMatches, 1, 4) &&
    Number.isInteger(s.minMatches) &&
    range(s.concentration, 1, 100) &&
    range(s.dailyDrop, 1, 50) &&
    range(s.overbought, 50, 100) &&
    (s.priceRules === undefined || validPriceRules(s.priceRules))
  )
}
export function readAlphaSettings(): AlphaSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ALPHA_SETTINGS_KEY) || 'null')
    if (validAlphaSettings(value)) return value
  } catch {
    /* Fall back to the documented defaults. */
  }
  return { ...DEFAULT_ALPHA_SETTINGS, weights: { ...DEFAULT_ALPHA_SETTINGS.weights } }
}
export type Contribution = {
  id: StrategyId
  weight: number
  available: boolean
  matched: boolean
  points: number
  reason: string
}
export type AlphaCandidate = {
  symbol: string
  name: string
  row: Research
  score: number
  coverage: number
  matched: number
  alpha: boolean
  relation: 'held' | 'watchlist' | 'new'
  contributions: Contribution[]
}
export function scanReady(scan: Scan | null, expected: string | undefined) {
  return (
    !!scan &&
    !!expected &&
    scan.as_of === expected &&
    scan.input_status === 'current' &&
    scan.matches_current_universe !== false
  )
}
export function rowUsable(row: Research, date: string) {
  const quality = (row as Research & { quality?: { valid?: boolean; status?: string } }).quality
  return (
    row.date === date &&
    finite(row.bars) &&
    row.bars > 0 &&
    finite(row.indicators.close) &&
    row.indicators.close > 0 &&
    quality?.valid !== false &&
    !['data_error', 'no_data'].includes(quality?.status || '') &&
    !row.signals.some((signal) => signal.status === 'stale' || signal.status === 'data_error')
  )
}
export function rankAlpha(data: Overview, scope: Scope, settings: AlphaSettings) {
  const scan = scope === 'market' ? data.market_scan : data.scan
  const ready = scanReady(scan, data.summary.expected_session) && validAlphaSettings(settings)
  const totalWeight = STRATEGY_IDS.reduce((sum, id) => sum + settings.weights[id], 0)
  const membership = new Set(scan?.universe || [])
  const positions = new Map(data.positions.map((position) => [position.symbol, position]))
  const names = new Map(data.market_universe.map((member) => [member.symbol, member.name]))
  const seen = new Set<string>()
  const rows: AlphaCandidate[] = []
  if (ready && scan)
    for (const row of scan.result) {
      if (seen.has(row.symbol) || !membership.has(row.symbol)) continue
      seen.add(row.symbol)
      if (!rowUsable(row, scan.as_of)) continue
      const contributions = STRATEGY_IDS.map((id) => {
        const signals = row.signals.filter((signal) => signal.strategy === id)
        const signal = signals[0]
        const available =
          signals.length === 1 &&
          (signal.status === 'match' || signal.status === 'watch') &&
          signal.matched === (signal.status === 'match')
        const matched = available && signal.matched
        return {
          id,
          weight: settings.weights[id],
          available,
          matched,
          points: matched ? (settings.weights[id] / totalWeight) * 100 : 0,
          reason: signal?.reason || '',
        }
      })
      const score = contributions.reduce((sum, part) => sum + part.points, 0)
      const availableWeight = contributions.reduce(
        (sum, part) => sum + (part.available ? part.weight : 0),
        0,
      )
      const coverage = (availableWeight / totalWeight) * 100
      const matched = contributions.filter((part) => part.matched && part.weight > 0).length
      const position = positions.get(row.symbol)
      rows.push({
        symbol: row.symbol,
        name: position?.name || names.get(row.symbol) || row.name || row.symbol,
        row,
        score,
        coverage,
        matched,
        alpha:
          availableWeight === totalWeight &&
          score + 1e-9 >= settings.threshold &&
          matched >= settings.minMatches,
        relation: position ? (position.shares > 0 ? 'held' : 'watchlist') : 'new',
        contributions,
      })
    }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.matched - a.matched ||
      (finite(b.row.indicators.rps) ? b.row.indicators.rps : -1) -
        (finite(a.row.indicators.rps) ? a.row.indicators.rps : -1) ||
      a.symbol.localeCompare(b.symbol, 'en'),
  )
  return {
    rows,
    ready,
    scan,
    total: membership.size,
    usable: rows.length,
    excluded: membership.size - rows.length,
    alpha: rows.filter((row) => row.alpha),
    totalWeight,
  }
}

export type RiskKind =
  | 'concentration'
  | 'daily_drop'
  | 'below_ma200'
  | 'below_ma50'
  | 'overbought'
  | 'data_gap'
  | 'signal_gap'
  | 'price_below'
  | 'price_above'
export type RiskAlert = {
  id: string
  symbol: string
  kind: RiskKind
  severity: 'high' | 'medium' | 'data'
  date: string | null
  value: number | null
  threshold: number | null
}
export function portfolioAlerts(data: Overview, settings: AlphaSettings): RiskAlert[] {
  const alerts: RiskAlert[] = []
  const expected = data.summary.expected_session
  const portfolioScanCurrent = scanReady(data.scan, expected)
  const scanRows = new Map(data.scan?.result.map((row) => [row.symbol, row]) || [])
  const concentrationReady =
    !!expected &&
    data.positions
      .filter((position) => position.shares > 0)
      .every(
        (position) =>
          position.price_date === expected &&
          finite(position.price) &&
          position.price > 0 &&
          !['stale', 'unavailable'].includes(position.quote_status || ''),
      )
  for (const position of data.positions.filter((position) => position.shares > 0)) {
    const add = (
      kind: RiskKind,
      severity: RiskAlert['severity'],
      value: number | null,
      threshold: number | null,
      date = expected || null,
    ) => {
      alerts.push({
        id: [position.symbol, kind, severity, date || 'unknown', threshold ?? 'none'].join(':'),
        symbol: position.symbol,
        kind,
        severity,
        date,
        value,
        threshold,
      })
    }
    const quoteCurrent =
      !!expected &&
      position.price_date === expected &&
      finite(position.price) &&
      position.price > 0 &&
      position.quote_status !== 'stale' &&
      position.quote_status !== 'unavailable'
    if (!quoteCurrent) {
      add('data_gap', 'data', null, null, position.price_date)
      continue
    }
    if (concentrationReady && finite(position.weight) && position.weight >= settings.concentration)
      add(
        'concentration',
        position.weight >= Math.max(50, settings.concentration) ? 'high' : 'medium',
        position.weight,
        settings.concentration,
      )
    if (finite(position.change_pct) && position.change_pct <= -settings.dailyDrop)
      add('daily_drop', 'high', position.change_pct, -settings.dailyDrop)
    const priceRule = settings.priceRules?.find((rule) => rule.symbol === position.symbol)
    if (priceRule?.below != null && position.price! <= priceRule.below)
      add('price_below', 'high', position.price, priceRule.below)
    if (priceRule?.above != null && position.price! >= priceRule.above)
      add('price_above', 'medium', position.price, priceRule.above)
    const row = scanRows.get(position.symbol)
    if (!portfolioScanCurrent || !row || !rowUsable(row, expected!)) {
      add('signal_gap', 'data', null, null)
      continue
    }
    const m = row.indicators
    if (finite(m.ma200) && m.ma200 > 0 && m.close! < m.ma200)
      add('below_ma200', 'high', (m.close! / m.ma200 - 1) * 100, 0)
    else if (finite(m.ma50) && m.ma50 > 0 && m.close! < m.ma50)
      add('below_ma50', 'medium', (m.close! / m.ma50 - 1) * 100, 0)
    if (finite(m.rsi) && m.rsi >= settings.overbought && m.rsi <= 100)
      add('overbought', 'medium', m.rsi, settings.overbought)
  }
  const priorities = { high: 0, medium: 1, data: 2 }
  return alerts.sort(
    (a, b) =>
      priorities[a.severity] - priorities[b.severity] ||
      a.symbol.localeCompare(b.symbol) ||
      a.kind.localeCompare(b.kind),
  )
}
