import { beforeEach, expect, it } from 'vitest'
import {
  readTracker,
  readTrackingDrafts,
  saveTrackingRecord,
  TRACKER_DRAFT_KEY,
  validTrackingRecord,
} from './research-tracker'
import { captureResearchPreferences, parseResearchPreferences } from './alpha-transfer'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
it('preserves archived research independently of shortlist and rejects stale edits', () => {
  const original = {
    symbol: 'NVDA',
    stage: 'researching' as const,
    reason: 'Check earnings',
    reviewOn: '2026-09-10',
    version: 0,
  }
  const first = saveTrackingRecord(original)
  expect(first.version).toBe(1)
  const second = saveTrackingRecord({ ...first, stage: 'archived' })
  expect(() => saveTrackingRecord({ ...first, reason: 'Old tab' })).toThrow('tracking_conflict')
  expect(readTracker()).toEqual([second])
  const backup = captureResearchPreferences()
  expect(backup.shortlist).toEqual([])
  expect(parseResearchPreferences(JSON.stringify(backup)).tracking).toEqual([second])
})
it('rejects impossible dates and restores version-zero drafts across page remounts', () => {
  const draft = {
    symbol: 'META',
    stage: 'inbox',
    reason: 'Review',
    reviewOn: '2026-02-30',
    version: 0,
  }
  expect(validTrackingRecord({ ...draft, version: 1, updatedAt: new Date().toISOString() })).toBe(
    false,
  )
  sessionStorage.setItem(
    TRACKER_DRAFT_KEY,
    JSON.stringify({ META: { ...draft, reviewOn: '2026-09-10' }, invalid: draft }),
  )
  expect(Object.keys(readTrackingDrafts())).toEqual(['META'])
  expect(readTrackingDrafts().META.version).toBe(0)
})
