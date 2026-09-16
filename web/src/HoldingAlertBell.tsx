import { useEffect, useMemo, useState } from 'react'
import { Notification } from '@carbon/icons-react'
import type { Overview } from './types'
import type { Locale } from './locale'
import { portfolioAlerts, readAlphaSettings } from './alpha-model'
import { ALPHA_PREFERENCES_EVENT, readReviewed } from './alpha-preferences'
import { deliverDesktopAlerts, readDesktopSettings } from './desktop-alerts'

export function HoldingAlertBell({
  data,
  locale,
  onOpen,
}: {
  data: Overview
  locale: Locale
  onOpen: () => void
}) {
  const [preferences, setPreferences] = useState(() => ({
    settings: readAlphaSettings(),
    reviewed: readReviewed(),
    desktop: readDesktopSettings(),
  }))
  useEffect(() => {
    const update = () =>
      setPreferences({
        settings: readAlphaSettings(),
        reviewed: readReviewed(),
        desktop: readDesktopSettings(),
      })
    window.addEventListener(ALPHA_PREFERENCES_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(ALPHA_PREFERENCES_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  const alerts = useMemo(
    () =>
      portfolioAlerts(data, preferences.settings).filter(
        (alert) => !preferences.reviewed.includes(alert.id),
      ),
    [data, preferences],
  )
  useEffect(() => {
    void deliverDesktopAlerts(alerts, preferences.desktop, preferences.reviewed, locale)
  }, [alerts, preferences, locale])
  const label =
    locale === 'en'
      ? `Holding alerts: ${alerts.length} unreviewed`
      : `持倉提醒：${alerts.length} 項待檢閱`
  return (
    <button
      type="button"
      className="icon-button alpha-alert-bell"
      translate="no"
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <Notification size={18} />
      {alerts.length > 0 && <span>{alerts.length > 99 ? '99+' : alerts.length}</span>}
    </button>
  )
}
