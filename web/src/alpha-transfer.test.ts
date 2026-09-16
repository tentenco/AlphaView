import { beforeEach, describe, expect, it } from 'vitest'
import { ALPHA_SETTINGS_KEY } from './alpha-model'
import {
  applyResearchPreferences,
  captureResearchPreferences,
  capturedStorage,
  parseResearchPreferences,
  SHORTLIST_KEY,
  TRANSFER_KEYS,
} from './alpha-transfer'

describe('portable Alpha research preferences', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips only the declared research categories', () => {
    localStorage.setItem('unrelated-setting', 'keep me')
    const original = captureResearchPreferences()
    const changed = {
      ...original,
      shortlist: ['NVDA', 'META'],
      settings: { ...original.settings, threshold: 75 },
    }
    applyResearchPreferences(parseResearchPreferences(JSON.stringify(changed)), capturedStorage())
    expect(captureResearchPreferences().shortlist).toEqual(['NVDA', 'META'])
    expect(JSON.parse(localStorage.getItem(ALPHA_SETTINGS_KEY)!).threshold).toBe(75)
    expect(localStorage.getItem('unrelated-setting')).toBe('keep me')
    expect(JSON.stringify(changed)).not.toContain('unrelated-setting')
  })
  it('rejects malformed categories before changing storage', () => {
    const data = captureResearchPreferences()
    expect(() =>
      parseResearchPreferences(JSON.stringify({ ...data, shortlist: ['NVDA', 'NVDA'] })),
    ).toThrow('invalid_shortlist')
    expect(() =>
      parseResearchPreferences(JSON.stringify({ ...data, experiments: [{ name: 'invalid' }] })),
    ).toThrow('invalid_experiments')
    expect(() =>
      parseResearchPreferences(
        JSON.stringify({ ...data, settings: { ...data.settings, threshold: 0 } }),
      ),
    ).toThrow('invalid_format')
  })
  it('requires a new preview if another tab changes research preferences', () => {
    const data = captureResearchPreferences(),
      before = capturedStorage()
    localStorage.setItem(SHORTLIST_KEY, '["AAPL"]')
    expect(() => applyResearchPreferences(data, before)).toThrow('changed_since_preview')
    expect(localStorage.getItem(SHORTLIST_KEY)).toBe('["AAPL"]')
  })
  it('restores the previous categories after a partial storage failure', () => {
    const values = new Map(TRANSFER_KEYS.map((key, index) => [key, `original-${index}`]))
    let writes = 0
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
      setItem: (key: string, value: string) => {
        if (++writes === 3) throw new Error('quota')
        values.set(key, value)
      },
    }
    const before = capturedStorage(storage)
    expect(() => applyResearchPreferences(captureResearchPreferences(), before, storage)).toThrow(
      'storage_unavailable',
    )
    expect(capturedStorage(storage)).toEqual(before)
  })
})
