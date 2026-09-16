import { useState } from 'react'
import { Notification } from '@carbon/icons-react'
import type { Locale } from './locale'
import { DESKTOP_SETTINGS_KEY, readDesktopSettings, type DesktopSettings } from './desktop-alerts'
import { notifyAlphaPreferences } from './alpha-preferences'

export function DesktopAlertSettings({ locale }: { locale: Locale }) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [settings, setSettings] = useState(readDesktopSettings)
  const [permission, setPermission] = useState(() =>
    typeof window.Notification === 'undefined' ? 'unsupported' : window.Notification.permission,
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  function save(next: DesktopSettings) {
    try {
      localStorage.setItem(DESKTOP_SETTINGS_KEY, JSON.stringify(next))
      setSettings(next)
      notifyAlphaPreferences()
    } catch {
      setMessage(
        t(
          '無法保存提醒設定，請檢查瀏覽器儲存空間。',
          'Could not save notification settings. Check browser storage.',
        ),
      )
    }
  }
  async function toggle() {
    if (settings.enabled) {
      save({ ...settings, enabled: false })
      return
    }
    if (typeof window.Notification === 'undefined') return
    setBusy(true)
    setMessage('')
    try {
      const granted = await window.Notification.requestPermission()
      setPermission(granted)
      if (granted === 'granted') save({ ...settings, enabled: true })
      else
        setMessage(
          t(
            '瀏覽器尚未允許通知。你仍可在持倉提醒中心查看全部項目。',
            'Browser notifications are not allowed. All conditions remain available in Holding Alerts.',
          ),
        )
    } catch {
      setMessage(
        t(
          '這個瀏覽器無法開啟桌面通知，請使用頁面內提醒。',
          'This browser could not enable desktop notifications. Use the in-app alert center.',
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="alpha-desktop-settings">
      <summary>
        <Notification size={16} />
        {t('桌面提醒設定', 'Desktop Notification Settings')}
      </summary>
      <p>
        {t(
          '瀏覽器保持開啟、行情更新後，對新出現且未檢閱的持倉條件發送本機桌面提醒。',
          'While this browser stays open, workspace updates can create local desktop notifications for new, unreviewed holding conditions.',
        )}
      </p>
      <div className="alpha-desktop-state">
        <span>
          {settings.enabled && permission === 'granted'
            ? t('已開啟', 'Enabled')
            : t('未開啟', 'Disabled')}
        </span>
        <button
          type="button"
          className="button"
          disabled={busy || permission === 'unsupported'}
          onClick={() => void toggle()}
        >
          {settings.enabled
            ? t('關閉桌面提醒', 'Disable Desktop Alerts')
            : t('開啟桌面提醒', 'Enable Desktop Alerts')}
        </button>
      </div>
      <fieldset>
        <legend>{t('提醒範圍', 'Notification Level')}</legend>
        <label>
          <input
            type="radio"
            name="desktop-alert-level"
            value="high"
            checked={settings.level === 'high'}
            onChange={() => save({ ...settings, level: 'high' })}
          />
          {t('只提醒高風險條件', 'High-severity Conditions Only')}
        </label>
        <label>
          <input
            type="radio"
            name="desktop-alert-level"
            value="all"
            checked={settings.level === 'all'}
            onChange={() => save({ ...settings, level: 'all' })}
          />
          {t('所有持倉風險條件', 'All Holding Risk Conditions')}
        </label>
      </fieldset>
      {permission === 'unsupported' && (
        <p>
          {t('此瀏覽器不支援桌面通知。', 'This browser does not support desktop notifications.')}
        </p>
      )}
      {permission === 'denied' && (
        <p>
          {t(
            '通知權限已被封鎖，可在瀏覽器的網站權限設定中重新允許。',
            'Notifications are blocked. You can allow them in this browser’s site permissions.',
          )}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <p className="footnote">
        {t(
          '預設關閉，首次開啟也會檢查目前未檢閱條件。不寄 Email、不連接外部推播服務。資料缺漏不觸發桌面風險提醒；相同條件會去重。通知顯示仍受作業系統設定影響。',
          'Off by default; enabling also checks current unreviewed conditions. No email or external push service. Data gaps do not trigger desktop risk notifications. Repeated conditions are deduplicated; visibility also depends on operating-system settings.',
        )}
      </p>
    </details>
  )
}
