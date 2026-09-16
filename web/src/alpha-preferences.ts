export const ACK_KEY = 'alphaview-alpha-reviewed-v1'
export const ALPHA_PREFERENCES_EVENT = 'alphaview-alpha-preferences'
export function readReviewed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACK_KEY) || '[]')
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(-500)
      : []
  } catch {
    return []
  }
}
export function notifyAlphaPreferences() {
  window.dispatchEvent(new Event(ALPHA_PREFERENCES_EVENT))
}
