import { STRATEGY_IDS, type StrategyId } from './alpha-model'
import type { Scope } from './types'
import {
  EMPTY_CRITERIA,
  CANDIDATE_SORTS,
  validCandidateCriteria,
  type CandidateSort,
  type CandidateCriteria,
} from './candidate-filters'
export const DASHBOARD_SESSION_KEY = 'alphaview-dashboard-session-v1'
export type DashboardSession = {
  scope: Scope
  filter: string
  relation: string
  query: string
  intersection: StrategyId[]
  page: number
  expanded: string | null
  compare: string[]
  criteria: CandidateCriteria
  sort: CandidateSort
}
const defaults: DashboardSession = {
  scope: 'market',
  filter: 'alpha',
  relation: 'all',
  query: '',
  intersection: [],
  page: 0,
  expanded: null,
  compare: [],
  criteria: { ...EMPTY_CRITERIA },
  sort: 'score',
}
export function readDashboardSession(): DashboardSession {
  try {
    const p = JSON.parse(
      sessionStorage.getItem(DASHBOARD_SESSION_KEY) || 'null',
    ) as DashboardSession | null
    if (
      !p ||
      !['market', 'portfolio'].includes(p.scope) ||
      !['alpha', 'all', 'shortlist', ...STRATEGY_IDS].includes(p.filter) ||
      !['all', 'new', 'held', 'watchlist'].includes(p.relation) ||
      typeof p.query !== 'string' ||
      p.query.length > 200 ||
      !Array.isArray(p.intersection) ||
      p.intersection.length > 2 ||
      !p.intersection.every((id) => STRATEGY_IDS.includes(id)) ||
      !Number.isInteger(p.page) ||
      p.page < 0 ||
      p.page > 1000 ||
      (p.expanded !== null &&
        (typeof p.expanded !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(p.expanded))) ||
      !Array.isArray(p.compare) ||
      p.compare.length > 5 ||
      !p.compare.every(
        (symbol) => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol),
      )
    )
      return { ...defaults }
    return {
      ...p,
      compare: [...new Set(p.compare)],
      criteria: validCandidateCriteria(p.criteria) ? p.criteria : { ...EMPTY_CRITERIA },
      sort: CANDIDATE_SORTS.includes(p.sort) ? p.sort : 'score',
    }
  } catch {
    return { ...defaults }
  }
}
