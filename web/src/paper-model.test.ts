import { describe, expect, it } from 'vitest'
import { parsePaperTargets } from './paper-model'

describe('complete paper target portfolios', () => {
  it('preserves explicit cash and zero targets without normalizing weights', () => {
    expect(parsePaperTargets('syntA, 20\nSYNTB 0\nSYNTC，15')).toEqual({
      targets: [
        { symbol: 'SYNTA', weight_pct: 20 },
        { symbol: 'SYNTB', weight_pct: 0 },
        { symbol: 'SYNTC', weight_pct: 15 },
      ],
      error: null,
    })
  })

  it('rejects ambiguity and nonfinite or excessive allocations', () => {
    for (const value of [
      'SYNTA 20\nsynta 10',
      'SYNTA Infinity',
      'SYNTA NaN',
      'SYNTA',
      'SYNTA 20 extra',
      'SYNTA -1',
      'SYNTA 80\nSYNTB 21',
      '',
    ]) {
      expect(parsePaperTargets(value).targets).toBeNull()
    }
  })

  it('enforces the backend portfolio size boundary', () => {
    const rows = Array.from({ length: 51 }, (_, index) => `SYN${index} 1`)
    expect(parsePaperTargets(rows.slice(0, 50).join('\n')).error).toBeNull()
    expect(parsePaperTargets(rows.join('\n')).error).toBe('limit')
  })
})
