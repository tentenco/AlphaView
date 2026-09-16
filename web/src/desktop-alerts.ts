import type { Locale } from './locale'
import type { RiskAlert } from './alpha-model'

export const DESKTOP_SETTINGS_KEY = 'alphaview-desktop-alerts-v1'
const DELIVERED_KEY = 'alphaview-desktop-delivered-v1'
const sessionDelivered = new Set<string>()
export type DesktopSettings = { enabled: boolean; level: 'high' | 'all' }
export function readDesktopSettings(): DesktopSettings {
  try {
    const value = JSON.parse(localStorage.getItem(DESKTOP_SETTINGS_KEY) || 'null')
    if (value && typeof value.enabled === 'boolean' && ['high', 'all'].includes(value.level))
      return { enabled: value.enabled, level: value.level }
  } catch {
    /* Disabled by default. */
  }
  return { enabled: false, level: 'high' }
}
export function undeliveredAlerts(
  alerts: RiskAlert[],
  settings: DesktopSettings,
  reviewed: string[],
  delivered: string[],
) {
  return settings.enabled
    ? alerts.filter(
        (alert) =>
          alert.severity !== 'data' &&
          (settings.level === 'all' || alert.severity === 'high') &&
          !reviewed.includes(alert.id) &&
          !delivered.includes(alert.id),
      )
    : []
}
function readDelivered(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DELIVERED_KEY) || '[]')
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(-1000)
      : []
  } catch {
    return []
  }
}
export async function deliverDesktopAlerts(
  alerts: RiskAlert[],
  settings: DesktopSettings,
  reviewed: string[],
  locale: Locale,
) {
  if (
    !settings.enabled ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return
  const deliver = () => {
    const delivered = [...new Set([...readDelivered(), ...sessionDelivered])]
    const fresh = undeliveredAlerts(alerts, settings, reviewed, delivered)
    if (!fresh.length) return
    const symbols = [...new Set(fresh.map((alert) => alert.symbol))]
    const title = locale === 'en' ? 'AlphaView · Holding Review' : 'AlphaView · 持倉需要檢閱'
    const body =
      locale === 'en'
        ? `${fresh.length} new review conditions: ${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '…' : ''}. Open Alpha Picks for details.`
        : `${fresh.length} 項新提醒：${symbols.slice(0, 5).join('、')}${symbols.length > 5 ? '…' : ''}。開啟 Alpha Picks 查看。`
    const notification = new Notification(title, {
      body,
      tag: 'alphaview-holding-review',
      silent: false,
    })
    fresh.forEach((alert) => sessionDelivered.add(alert.id))
    notification.onclick = () => {
      window.focus()
      window.location.hash = 'alpha'
      requestAnimationFrame(() =>
        document
          .querySelector('.alpha-alerts')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      )
      notification.close()
    }
    // Mark only after the browser accepts creation; OS delivery still follows its settings.
    localStorage.setItem(
      DELIVERED_KEY,
      JSON.stringify([...delivered, ...fresh.map((alert) => alert.id)].slice(-1000)),
    )
  }
  try {
    if (navigator.locks)
      await navigator.locks.request('alphaview-desktop-alerts', { ifAvailable: true }, (lock) => {
        if (lock) deliver()
      })
    else deliver()
  } catch {
    /* The in-app inbox remains the source of truth when browser notifications fail. */
  }
}
