export const TRACKER_KEY = 'alphaview-research-tracker-v1'
export const TRACKER_DRAFT_KEY = 'alphaview-research-tracker-drafts-v1'
export const RESEARCH_STAGES = ['inbox', 'researching', 'monitoring', 'archived'] as const
export type ResearchStage = (typeof RESEARCH_STAGES)[number]
export type TrackingRecord = {
  symbol: string
  stage: ResearchStage
  reason: string
  reviewOn: string
  updatedAt: string
  version: number
}
export type TrackingDraft = Omit<TrackingRecord, 'updatedAt'> & { base?: string | null }
export function trackingBase(record: TrackingRecord | undefined) {
  return record && record.version > 0
    ? JSON.stringify([
        record.symbol,
        record.stage,
        record.reason,
        record.reviewOn,
        record.version,
        record.updatedAt,
      ])
    : null
}
export function validTrackingRecord(value: unknown): value is TrackingRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as TrackingRecord
  return (
    typeof r.symbol === 'string' &&
    /^[A-Z][A-Z0-9.-]{0,9}$/.test(r.symbol) &&
    RESEARCH_STAGES.includes(r.stage) &&
    typeof r.reason === 'string' &&
    r.reason.length <= 280 &&
    typeof r.reviewOn === 'string' &&
    (r.reviewOn === '' ||
      (/^\d{4}-\d{2}-\d{2}$/.test(r.reviewOn) &&
        Number.isFinite(Date.parse(r.reviewOn)) &&
        new Date(r.reviewOn).toISOString().slice(0, 10) === r.reviewOn)) &&
    typeof r.updatedAt === 'string' &&
    Number.isFinite(Date.parse(r.updatedAt)) &&
    Number.isInteger(r.version) &&
    r.version >= 1
  )
}
export function readTracker(storage: Pick<Storage, 'getItem'> = localStorage): TrackingRecord[] {
  try {
    const records: unknown = JSON.parse(storage.getItem(TRACKER_KEY) || '[]')
    if (!Array.isArray(records)) return []
    return records
      .filter(validTrackingRecord)
      .filter((r, i, rows) => rows.findIndex((other) => other.symbol === r.symbol) === i)
      .slice(0, 200)
  } catch {
    return []
  }
}
export function saveTrackingRecord(
  draft: Omit<TrackingRecord, 'updatedAt'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  expectedBase?: string | null,
) {
  const records = readTracker(storage)
  const current = records.find((record) => record.symbol === draft.symbol)
  if ((current?.version || 0) !== draft.version) throw new Error('tracking_conflict')
  if (expectedBase !== undefined && trackingBase(current) !== expectedBase)
    throw new Error('tracking_conflict')
  if (!current && records.length >= 200) throw new Error('tracking_limit')
  const next = {
    symbol: draft.symbol,
    stage: draft.stage,
    reviewOn: draft.reviewOn,
    reason: draft.reason.trim(),
    version: draft.version + 1,
    updatedAt: new Date().toISOString(),
  }
  if (!validTrackingRecord(next)) throw new Error('tracking_invalid')
  storage.setItem(
    TRACKER_KEY,
    JSON.stringify([...records.filter((record) => record.symbol !== draft.symbol), next]),
  )
  return next
}
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
export function readTrackingDrafts(
  storage: Pick<Storage, 'getItem'> = sessionStorage,
): Record<string, TrackingDraft> {
  try {
    const value: unknown = JSON.parse(storage.getItem(TRACKER_DRAFT_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .filter(([symbol, draft]) => {
          if (!draft || typeof draft !== 'object') return false
          return (
            draft.symbol === symbol &&
            Number.isInteger(draft.version) &&
            draft.version >= 0 &&
            (draft.base === undefined ||
              draft.base === null ||
              (typeof draft.base === 'string' && draft.base.length <= 3000)) &&
            validTrackingRecord({
              ...draft,
              version: draft.version + 1,
              updatedAt: new Date().toISOString(),
            })
          )
        })
        .slice(0, 200),
    )
  } catch {
    return {}
  }
}
