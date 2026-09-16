import { finite, type AlphaCandidate } from './alpha-model'
export type CandidateCriteria = {
  minScore: number | null
  minRps: number | null
  maxRsi: number | null
}
export const EMPTY_CRITERIA: CandidateCriteria = { minScore: null, minRps: null, maxRsi: null }
export const CANDIDATE_SORTS = ['score', 'matches', 'rps', 'volume', 'symbol'] as const
export type CandidateSort = (typeof CANDIDATE_SORTS)[number]
export function validCandidateCriteria(value: unknown): value is CandidateCriteria {
  if (!value || typeof value !== 'object') return false
  return Object.keys(EMPTY_CRITERIA).every((key) => {
    const v = (value as CandidateCriteria)[key as keyof CandidateCriteria]
    return v === null || (finite(v) && v >= 0 && v <= 100)
  })
}
export function refineCandidates(
  rows: AlphaCandidate[],
  criteria: CandidateCriteria,
  sort: CandidateSort,
) {
  const metric = (row: AlphaCandidate) =>
    sort === 'matches'
      ? row.matched
      : sort === 'rps'
        ? row.row.indicators.rps
        : sort === 'volume'
          ? row.row.indicators.volume_ratio
          : row.score
  return rows
    .filter(
      (row) =>
        (criteria.minScore === null || row.score >= criteria.minScore) &&
        (criteria.minRps === null ||
          (finite(row.row.indicators.rps) && row.row.indicators.rps >= criteria.minRps)) &&
        (criteria.maxRsi === null ||
          (finite(row.row.indicators.rsi) && row.row.indicators.rsi <= criteria.maxRsi)),
    )
    .sort((a, b) => {
      if (sort === 'symbol') return a.symbol.localeCompare(b.symbol, 'en')
      const av = metric(a),
        bv = metric(b)
      if (finite(av) !== finite(bv)) return finite(av) ? -1 : 1
      return (
        (finite(av) && finite(bv) ? bv - av : 0) ||
        b.score - a.score ||
        b.matched - a.matched ||
        (finite(b.row.indicators.rps) ? b.row.indicators.rps : -1) -
          (finite(a.row.indicators.rps) ? a.row.indicators.rps : -1) ||
        a.symbol.localeCompare(b.symbol, 'en')
      )
    })
}
