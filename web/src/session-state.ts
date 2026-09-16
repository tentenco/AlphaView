import { useEffect, useState } from 'react'
import {
  DEFAULT_ALPHA_SETTINGS,
  STRATEGY_IDS,
  validAlphaSettings,
  type AlphaSettings,
} from './alpha-model'

/** Per-tab drafts only. Never used as a cache of calculated market results. */
export function useSessionState<T>(
  key: string,
  initial: () => T,
  valid: (value: unknown) => value is T,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(key) || 'null')
      if (valid(saved)) return saved
    } catch {
      /* Use initial state when session storage is unavailable. */
    }
    return initial()
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* The current page state still works without persistence. */
    }
  }, [key, value])
  return [value, setValue] as const
}
export const boundedDraftString = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 100
export function isAlphaEditingSettings(value: unknown): value is AlphaSettings {
  if (!value || typeof value !== 'object') return false
  const p = value as AlphaSettings
  const bounded = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6
  return (
    !!p.weights &&
    STRATEGY_IDS.every((id) => bounded(p.weights[id])) &&
    bounded(p.threshold) &&
    bounded(p.minMatches) &&
    validAlphaSettings({
      ...p,
      weights: DEFAULT_ALPHA_SETTINGS.weights,
      threshold: 50,
      minMatches: 2,
    })
  )
}
