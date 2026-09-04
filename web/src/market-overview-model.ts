import type { Research, Scan, Strategy } from './types'

export type Breadth = { count: number; eligible: number; excluded: number; percent: number | null }
export type MarketCoverage = {
  total: number
  usable: number
  dataError: number
  stale: number
  missing: number
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
function qualityState(row: Research) {
  return (row as Research & { quality?: { status?: string; valid?: boolean } }).quality
}
function qualityError(row: Research) {
  const quality = qualityState(row)
  return (
    quality?.status === 'data_error' ||
    quality?.valid === false ||
    row.signals.some((signal) => signal.status === 'data_error')
  )
}
export function marketOverview(scan: Scan, strategies: Strategy[]) {
  const universe = [...new Set(scan.universe)]
  const bySymbol = new Map(scan.result.map((row) => [row.symbol, row]))
  const coverage: MarketCoverage = {
    total: universe.length,
    usable: 0,
    dataError: 0,
    stale: 0,
    missing: 0,
  }
  const usable: Research[] = []
  for (const symbol of universe) {
    const row = bySymbol.get(symbol)
    if (!row || qualityState(row)?.status === 'no_data') {
      coverage.missing++
      continue
    }
    if (qualityError(row)) {
      coverage.dataError++
      continue
    }
    if (
      row.date &&
      (row.date !== scan.as_of || row.signals.some((signal) => signal.status === 'stale'))
    ) {
      coverage.stale++
      continue
    }
    if (
      !row.date ||
      !finite(row.bars) ||
      !Number.isInteger(row.bars) ||
      row.bars <= 0 ||
      !finite(row.indicators.close) ||
      row.indicators.close <= 0
    ) {
      coverage.missing++
      continue
    }
    coverage.usable++
    usable.push(row)
  }
  function breadth(eligible: Research[], matches: (row: Research) => boolean): Breadth {
    const count = eligible.filter(matches).length
    return {
      count,
      eligible: eligible.length,
      excluded: coverage.total - eligible.length,
      percent: eligible.length ? (count / eligible.length) * 100 : null,
    }
  }
  function average(key: 'ma50' | 'ma200') {
    return breadth(
      usable.filter((row) => finite(row.indicators[key]) && row.indicators[key]! > 0),
      (row) => row.indicators.close! > row.indicators[key]!,
    )
  }
  const rsiRows = usable.filter(
    (row) => finite(row.indicators.rsi) && row.indicators.rsi! >= 0 && row.indicators.rsi! <= 100,
  )
  const strategyBreadth = strategies.map((strategy) => {
    const eligible = usable.filter((row) => {
      const signals = row.signals.filter((signal) => signal.strategy === strategy.id)
      if (signals.length !== 1) return false
      const signal = signals[0]
      return (
        (signal.status === 'match' || signal.status === 'watch') &&
        typeof signal.matched === 'boolean' &&
        signal.matched === (signal.status === 'match')
      )
    })
    return {
      strategy,
      ...breadth(eligible, (row) =>
        row.signals.some(
          (signal) =>
            signal.strategy === strategy.id && signal.status === 'match' && signal.matched,
        ),
      ),
    }
  })
  const rankedReturns = usable
    .filter(
      (row) =>
        row.bars >= 121 &&
        finite(row.indicators.return120) &&
        row.indicators.return120! >= -1 &&
        finite(row.indicators.return120! * 100),
    )
    .sort(
      (a, b) =>
        b.indicators.return120! - a.indicators.return120! || a.symbol.localeCompare(b.symbol),
    )
  return {
    coverage,
    ma50: average('ma50'),
    ma200: average('ma200'),
    overbought: breadth(rsiRows, (row) => row.indicators.rsi! >= 70),
    oversold: breadth(rsiRows, (row) => row.indicators.rsi! <= 30),
    strategies: strategyBreadth,
    returnEligible: rankedReturns.length,
    leaders: rankedReturns.slice(0, 5),
  }
}
