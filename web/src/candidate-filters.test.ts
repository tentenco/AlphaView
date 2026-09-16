import { expect, it } from 'vitest'
import { EMPTY_CRITERIA, refineCandidates, validCandidateCriteria } from './candidate-filters'
import type { AlphaCandidate } from './alpha-model'
function candidate(
  symbol: string,
  score: number,
  rps: number | null,
  rsi: number | null,
  volume: number | null,
): AlphaCandidate {
  return {
    symbol,
    name: symbol,
    score,
    matched: 2,
    coverage: 100,
    alpha: score >= 50,
    relation: 'new',
    contributions: [],
    row: {
      symbol,
      date: '2026-09-04',
      bars: 250,
      signals: [],
      indicators: { rps, rsi, volume_ratio: volume },
    },
  }
}
it('keeps default score tie-breaks and excludes missing values only when their filter is enabled', () => {
  const rows = [
    candidate('ZZZ', 75, 90, 80, 2),
    candidate('AAA', 75, 80, 60, null),
    candidate('BBB', 50, null, null, 3),
  ]
  expect(refineCandidates(rows, EMPTY_CRITERIA, 'score').map((r) => r.symbol)).toEqual([
    'ZZZ',
    'AAA',
    'BBB',
  ])
  expect(
    refineCandidates(rows, { minScore: 50, minRps: 80, maxRsi: 70 }, 'score').map((r) => r.symbol),
  ).toEqual(['AAA'])
  expect(refineCandidates(rows, EMPTY_CRITERIA, 'volume').map((r) => r.symbol)).toEqual([
    'BBB',
    'ZZZ',
    'AAA',
  ])
  expect(rows.map((r) => r.symbol)).toEqual(['ZZZ', 'AAA', 'BBB'])
  expect(validCandidateCriteria({ ...EMPTY_CRITERIA, minRps: NaN })).toBe(false)
  expect(validCandidateCriteria({ ...EMPTY_CRITERIA, maxRsi: 101 })).toBe(false)
})
