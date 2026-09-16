import {
  ALPHA_SETTINGS_KEY,
  DEFAULT_ALPHA_SETTINGS,
  validAlphaSettings,
  type AlphaSettings,
} from './alpha-model'
import { ACK_KEY } from './alpha-preferences'
import { JOURNAL_KEY, readJournal, type ResearchSnapshot } from './alpha-journal'
import { EXPERIMENT_KEY, readExperiments, type SavedExperiment } from './ExperimentNotebook'
import {
  WEIGHT_PROFILES_KEY,
  readWeightProfiles,
  validWeightProfile,
  type WeightProfile,
} from './weight-profiles'
import {
  COMPARISON_BOOKMARKS_KEY,
  readComparisonBookmarks,
  validComparisonBookmark,
  type ComparisonBookmark,
} from './comparison-bookmarks'
import {
  TRACKER_KEY,
  readTracker,
  validTrackingRecord,
  type TrackingRecord,
} from './research-tracker'

export const SHORTLIST_KEY = 'alphaview-alpha-shortlist-v1'
export const VIEW_KEY = 'alphaview-alpha-view-v1'
export const TRANSFER_KEYS = [
  ALPHA_SETTINGS_KEY,
  ACK_KEY,
  JOURNAL_KEY,
  EXPERIMENT_KEY,
  SHORTLIST_KEY,
  VIEW_KEY,
  TRACKER_KEY,
  COMPARISON_BOOKMARKS_KEY,
  WEIGHT_PROFILES_KEY,
]
export type ResearchPreferences = {
  format: 'alphaview-research-preferences'
  version: 1
  exportedAt: string
  settings: AlphaSettings
  reviewed: string[]
  shortlist: string[]
  snapshots: ResearchSnapshot[]
  experiments: SavedExperiment[]
  view: 'cards' | 'table' | 'map'
  tracking: TrackingRecord[]
  comparisons: ComparisonBookmark[]
  profiles: WeightProfile[]
}
export function parseResearchPreferences(raw: string): ResearchPreferences {
  if (raw.length > 8 * 1024 * 1024) throw new Error('file_too_large')
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object') throw new Error('invalid_format')
  const p = data as ResearchPreferences
  if (
    p.format !== 'alphaview-research-preferences' ||
    p.version !== 1 ||
    typeof p.exportedAt !== 'string' ||
    !validAlphaSettings(p.settings) ||
    !['cards', 'table', 'map'].includes(p.view)
  )
    throw new Error('invalid_format')
  if (
    !Array.isArray(p.shortlist) ||
    p.shortlist.length > 100 ||
    !p.shortlist.every(
      (symbol) => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol),
    ) ||
    new Set(p.shortlist).size !== p.shortlist.length
  )
    throw new Error('invalid_shortlist')
  if (
    !Array.isArray(p.reviewed) ||
    p.reviewed.length > 500 ||
    !p.reviewed.every((id) => typeof id === 'string' && id.length <= 300)
  )
    throw new Error('invalid_reviewed')
  if (
    !Array.isArray(p.snapshots) ||
    p.snapshots.length > 20 ||
    readJournal({ getItem: () => JSON.stringify(p.snapshots) }).length !== p.snapshots.length
  )
    throw new Error('invalid_snapshots')
  if (
    !Array.isArray(p.experiments) ||
    p.experiments.length > 20 ||
    readExperiments({ getItem: () => JSON.stringify(p.experiments) }).length !==
      p.experiments.length
  )
    throw new Error('invalid_experiments')
  const tracking = p.tracking ?? [] // Older v1 exports predate the optional progress category.
  if (
    !Array.isArray(tracking) ||
    tracking.length > 200 ||
    !tracking.every(validTrackingRecord) ||
    new Set(tracking.map((record) => record.symbol)).size !== tracking.length
  )
    throw new Error('invalid_tracking')
  const comparisons = p.comparisons ?? []
  if (
    !Array.isArray(comparisons) ||
    comparisons.length > 20 ||
    !comparisons.every(validComparisonBookmark) ||
    new Set(comparisons.map((item) => item.id)).size !== comparisons.length
  )
    throw new Error('invalid_comparisons')
  const profiles = p.profiles ?? []
  if (
    !Array.isArray(profiles) ||
    profiles.length > 12 ||
    !profiles.every(validWeightProfile) ||
    new Set(profiles.map((item) => item.id)).size !== profiles.length
  )
    throw new Error('invalid_profiles')
  return {
    format: p.format,
    version: p.version,
    exportedAt: p.exportedAt,
    settings: p.settings,
    reviewed: p.reviewed,
    shortlist: p.shortlist,
    snapshots: p.snapshots,
    experiments: p.experiments,
    view: p.view,
    tracking,
    comparisons,
    profiles,
  }
}
export function captureResearchPreferences(storage: Pick<Storage, 'getItem'> = localStorage) {
  return parseResearchPreferences(
    JSON.stringify({
      format: 'alphaview-research-preferences',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: JSON.parse(
        storage.getItem(ALPHA_SETTINGS_KEY) || JSON.stringify(DEFAULT_ALPHA_SETTINGS),
      ),
      reviewed: JSON.parse(storage.getItem(ACK_KEY) || '[]'),
      shortlist: JSON.parse(storage.getItem(SHORTLIST_KEY) || '[]'),
      snapshots: JSON.parse(storage.getItem(JOURNAL_KEY) || '[]'),
      experiments: JSON.parse(storage.getItem(EXPERIMENT_KEY) || '[]'),
      view: storage.getItem(VIEW_KEY) || 'cards',
      tracking: readTracker(storage),
      comparisons: readComparisonBookmarks(storage),
      profiles: readWeightProfiles(storage),
    }),
  )
}
export function capturedStorage(storage: Pick<Storage, 'getItem'> = localStorage) {
  return Object.fromEntries(TRANSFER_KEYS.map((key) => [key, storage.getItem(key)]))
}
export function applyResearchPreferences(
  p: ResearchPreferences,
  expected: Record<string, string | null>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
) {
  const validated = parseResearchPreferences(JSON.stringify(p))
  if (TRANSFER_KEYS.some((key) => storage.getItem(key) !== expected[key]))
    throw new Error('changed_since_preview')
  const next: Record<string, string> = {
    [ALPHA_SETTINGS_KEY]: JSON.stringify(validated.settings),
    [ACK_KEY]: JSON.stringify(validated.reviewed),
    [JOURNAL_KEY]: JSON.stringify(validated.snapshots),
    [EXPERIMENT_KEY]: JSON.stringify(validated.experiments),
    [SHORTLIST_KEY]: JSON.stringify(validated.shortlist),
    [VIEW_KEY]: validated.view,
    [TRACKER_KEY]: JSON.stringify(validated.tracking),
    [COMPARISON_BOOKMARKS_KEY]: JSON.stringify(validated.comparisons),
    [WEIGHT_PROFILES_KEY]: JSON.stringify(validated.profiles),
  }
  try {
    for (const key of TRANSFER_KEYS) storage.setItem(key, next[key])
  } catch {
    try {
      for (const key of TRANSFER_KEYS) storage.removeItem(key)
      for (const key of TRANSFER_KEYS)
        if (expected[key] !== null) storage.setItem(key, expected[key])
    } catch {
      throw new Error('rollback_failed')
    }
    throw new Error('storage_unavailable')
  }
}
