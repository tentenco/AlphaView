import {
  ALPHA_VERSION,
  STRATEGY_IDS,
  type AlphaSettings,
  type AlphaCandidate,
  type RiskAlert,
} from './alpha-model'
import type { Scope } from './types'

export const JOURNAL_KEY = 'alphaview-research-journal-v1'
export type ResearchSnapshot = {
  version: 1
  id: string
  savedAt: string
  date: string
  scope: Scope
  configuration: string
  universe: string[]
  rows: { symbol: string; score: number; alpha: boolean; matched: number }[]
  alerts: RiskAlert[]
}
export function scoringConfiguration(settings: AlphaSettings) {
  const sum = STRATEGY_IDS.reduce((value, id) => value + settings.weights[id], 0)
  return JSON.stringify([
    ALPHA_VERSION,
    ...STRATEGY_IDS.map((id) => Number((settings.weights[id] / sum).toFixed(10))),
    settings.threshold,
    settings.minMatches,
  ])
}
export function createSnapshot(
  scope: Scope,
  date: string,
  universe: string[],
  rows: AlphaCandidate[],
  alerts: RiskAlert[],
  settings: AlphaSettings,
): ResearchSnapshot {
  const configuration = scoringConfiguration(settings)
  return {
    version: 1,
    id: `${scope}:${date}:${configuration}`,
    savedAt: new Date().toISOString(),
    date,
    scope,
    configuration,
    universe: [...new Set(universe)].sort(),
    rows: rows.map(({ symbol, score, alpha, matched }) => ({ symbol, score, alpha, matched })),
    alerts,
  }
}
export function readJournal(storage: Pick<Storage, 'getItem'> = localStorage): ResearchSnapshot[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(JOURNAL_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value
      .filter((entry): entry is ResearchSnapshot => {
        if (!entry || typeof entry !== 'object') return false
        const item = entry as ResearchSnapshot
        return (
          item.version === 1 &&
          typeof item.id === 'string' &&
          typeof item.configuration === 'string' &&
          typeof item.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
          typeof item.savedAt === 'string' &&
          ['market', 'portfolio'].includes(item.scope) &&
          Array.isArray(item.universe) &&
          item.universe.length <= 10000 &&
          item.universe.every((symbol) => typeof symbol === 'string') &&
          Array.isArray(item.rows) &&
          item.rows.length <= 10000 &&
          item.rows.every(
            (row) =>
              row &&
              typeof row.symbol === 'string' &&
              typeof row.score === 'number' &&
              Number.isFinite(row.score) &&
              row.score >= 0 &&
              row.score <= 100.00001 &&
              typeof row.alpha === 'boolean' &&
              Number.isInteger(row.matched) &&
              row.matched >= 0 &&
              row.matched <= 4,
          ) &&
          Array.isArray(item.alerts)
        )
      })
      .slice(-20)
  } catch {
    return []
  }
}
export function saveJournalSnapshot(previous: ResearchSnapshot[], snapshot: ResearchSnapshot) {
  const next = [...previous.filter((item) => item.id !== snapshot.id), snapshot].slice(-20)
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(next))
  return next
}
export function previousComparable(history: ResearchSnapshot[], current: ResearchSnapshot) {
  return (
    history
      .filter(
        (item) =>
          item.scope === current.scope &&
          item.date < current.date &&
          item.configuration === current.configuration &&
          JSON.stringify(item.universe) === JSON.stringify(current.universe),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.savedAt.localeCompare(a.savedAt))[0] || null
  )
}
export function snapshotChanges(current: ResearchSnapshot, previous: ResearchSnapshot) {
  const old = new Map(previous.rows.map((row, index) => [row.symbol, { ...row, rank: index + 1 }]))
  const now = new Map(current.rows.map((row, index) => [row.symbol, { ...row, rank: index + 1 }]))
  return {
    entered: current.rows.filter(
      (row) => row.alpha && old.has(row.symbol) && !old.get(row.symbol)!.alpha,
    ),
    exited: previous.rows.filter(
      (row) => row.alpha && now.has(row.symbol) && !now.get(row.symbol)!.alpha,
    ),
    unavailable: previous.rows.filter((row) => row.alpha && !now.has(row.symbol)),
    newCoverage: current.rows.filter((row) => row.alpha && !old.has(row.symbol)),
    movement: new Map(
      current.rows
        .filter((row) => old.has(row.symbol))
        .map((row) => [
          row.symbol,
          {
            score: row.score - old.get(row.symbol)!.score,
            rank: old.get(row.symbol)!.rank - now.get(row.symbol)!.rank,
          },
        ]),
    ),
  }
}
