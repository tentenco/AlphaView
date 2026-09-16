import { DEFAULT_ALPHA_SETTINGS, validAlphaSettings, type AlphaSettings } from './alpha-model'
export const WEIGHT_PROFILES_KEY = 'alphaview-weight-profiles-v1'
export type WeightConfiguration = Pick<AlphaSettings, 'weights' | 'threshold' | 'minMatches'>
export type WeightProfile = WeightConfiguration & { id: string; name: string; savedAt: string }
export function validWeightProfile(value: unknown): value is WeightProfile {
  if (!value || typeof value !== 'object') return false
  const p = value as WeightProfile
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    p.id.length <= 100 &&
    typeof p.name === 'string' &&
    p.name.trim().length > 0 &&
    p.name.length <= 60 &&
    typeof p.savedAt === 'string' &&
    Number.isFinite(Date.parse(p.savedAt)) &&
    validAlphaSettings({
      ...DEFAULT_ALPHA_SETTINGS,
      weights: p.weights,
      threshold: p.threshold,
      minMatches: p.minMatches,
    })
  )
}
export function readWeightProfiles(
  storage: Pick<Storage, 'getItem'> = localStorage,
): WeightProfile[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(WEIGHT_PROFILES_KEY) || '[]')
    return Array.isArray(value)
      ? value
          .filter(validWeightProfile)
          .filter((p, i, rows) => rows.findIndex((row) => row.id === p.id) === i)
          .slice(-12)
      : []
  } catch {
    return []
  }
}
