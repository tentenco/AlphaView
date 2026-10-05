import { describe, expect, it } from 'vitest'
import {
  defaultJevDraft,
  jevCost,
  jevProbability,
  jevSourceEligible,
  parseJevPolicy,
  validJevDraft,
} from './jev-model'

describe('jev gate model', () => {
  it('parses thresholds with the backend bounds and never clamps', () => {
    expect(parseJevPolicy(defaultJevDraft())).toEqual({
      policy: { pass_threshold: 0.7, max_risk_probability: 0.5 },
      error: null,
    })
    expect(parseJevPolicy({ ...defaultJevDraft(), passThreshold: '0.49' }).error).toBe(
      'pass_threshold',
    )
    expect(parseJevPolicy({ ...defaultJevDraft(), passThreshold: '1' }).error).toBe(
      'pass_threshold',
    )
    expect(parseJevPolicy({ ...defaultJevDraft(), passThreshold: '' }).error).toBe('pass_threshold')
    expect(parseJevPolicy({ ...defaultJevDraft(), maxRiskProbability: '0.51' }).error).toBe(
      'max_risk_probability',
    )
    expect(parseJevPolicy({ ...defaultJevDraft(), maxRiskProbability: 'abc' }).error).toBe(
      'max_risk_probability',
    )
    expect(
      parseJevPolicy({ sourceRunId: 'x', passThreshold: '0.95', maxRiskProbability: '0.25' })
        .policy,
    ).toEqual({ pass_threshold: 0.95, max_risk_probability: 0.25 })
  })

  it('validates session drafts structurally', () => {
    expect(validJevDraft(defaultJevDraft())).toBe(true)
    expect(validJevDraft(null)).toBe(false)
    expect(
      validJevDraft({
        sourceRunId: 'x'.repeat(301),
        passThreshold: '0.7',
        maxRiskProbability: '0.5',
      }),
    ).toBe(false)
    expect(validJevDraft({ sourceRunId: 'x', passThreshold: 0.7, maxRiskProbability: '0.5' })).toBe(
      false,
    )
  })

  it('formats cost and probability without inventing values', () => {
    expect(jevCost(null)).toBe('—')
    expect(jevCost(0.000027636)).toBe('$0.000028')
    expect(jevProbability(null)).toBe('—')
    expect(jevProbability(0.955)).toBe('0.95')
  })

  it('only offers current proposed sources within the size limit', () => {
    expect(jevSourceEligible({ current: true, status: 'proposed' }, 3, 10)).toBe(true)
    expect(jevSourceEligible({ current: false, status: 'proposed' }, 3, 10)).toBe(false)
    expect(jevSourceEligible({ current: true, status: 'blocked' }, 3, 10)).toBe(false)
    expect(jevSourceEligible({ current: true, status: 'proposed' }, 11, 10)).toBe(false)
    expect(jevSourceEligible({ current: true, status: 'proposed' }, 0, 10)).toBe(false)
  })
})
