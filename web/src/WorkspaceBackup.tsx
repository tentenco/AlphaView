import { useEffect, useRef, useState } from 'react'
import { Download } from '@carbon/icons-react'
import { decodePresets, NUMERIC_FIELDS, PRESET_KEY } from './screener-model'
import type { Preset, NumericFilters } from './screener-model'
import { UNIVERSE_LIMIT_KEY } from './Screener'
import type { UniverseLimit } from './Screener'

export function backupPreferences(storage: Pick<Storage, 'getItem'>) {
  const preferences: { presets?: Preset[]; universe_limit?: UniverseLimit } = {}
  const warnings: string[] = []
  try {
    const raw = storage.getItem(PRESET_KEY)
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw)
      const valid = decodePresets(raw)
      preferences.presets = valid.map((preset) => ({
        version: 1,
        name: preset.name,
        settings: {
          scope: preset.settings.scope,
          strategy: preset.settings.strategy,
          only: preset.settings.only,
          newOnly: preset.settings.newOnly,
          query: preset.settings.query,
          sort: preset.settings.sort,
          direction: preset.settings.direction,
          numeric: Object.fromEntries(
            NUMERIC_FIELDS.map((key) => [key, preset.settings.numeric[key]]),
          ) as NumericFilters,
        },
      }))
      if (!Array.isArray(parsed) || parsed.length !== valid.length)
        warnings.push('部分篩選設定格式無效或超過上限，已略過；資料庫仍會備份。')
    }
  } catch {
    warnings.push('無法讀取有效篩選設定，已略過；資料庫仍會備份。')
  }
  try {
    const raw = storage.getItem(UNIVERSE_LIMIT_KEY)
    if (raw != null) {
      const limit = Number(raw)
      if ([250, 500, 1000].includes(limit)) preferences.universe_limit = limit as UniverseLimit
      else warnings.push('股票池上限設定無效，已略過；資料庫仍會備份。')
    }
  } catch {
    warnings.push('無法讀取股票池上限，已略過；資料庫仍會備份。')
  }
  return { preferences, warnings }
}

export function WorkspaceBackup() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const active = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      controller.current?.abort()
    }
  }, [])
  async function download() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    const current = new AbortController()
    controller.current = current
    try {
      let settings: ReturnType<typeof backupPreferences>
      try {
        settings = backupPreferences(localStorage)
      } catch {
        settings = {
          preferences: {},
          warnings: ['瀏覽器設定無法讀取，僅備份資料庫與已儲存研究筆記。'],
        }
      }
      setWarnings(settings.warnings)
      const response = await fetch('/api/backups', {
        method: 'POST',
        signal: current.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: settings.preferences }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(
          typeof detail?.detail === 'string'
            ? detail.detail
            : `備份失敗（${response.status}），請稍後重試。`,
        )
      }
      if (
        response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
        'application/zip'
      )
        throw new Error('伺服器未回傳 ZIP 備份，未下載檔案。')
      const blob = await response.blob()
      if (!active.current || current.signal.aborted) return
      if (!blob.size) throw new Error('備份檔案為空，請重新嘗試。')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const filename = response.headers
        .get('Content-Disposition')
        ?.match(/filename="?([A-Za-z0-9._-]+\.zip)"?/i)?.[1]
      link.download = filename || `alphaview-backup-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(link)
      try {
        link.click()
      } finally {
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      }
      setMessage('本機備份已開始下載；請確認下載資料夾中的 ZIP 檔案。')
    } catch (err) {
      if (active.current && !current.signal.aborted) setError((err as Error).message)
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <section className="research-note" aria-labelledby="workspace-backup-title">
      <div className="section-heading">
        <div>
          <h2 id="workspace-backup-title">本機工作區備份</h2>
          <p>包含持股與成本、已儲存研究筆記、日線與研究紀錄，以及有效的篩選設定和股票池上限。</p>
        </div>
        <button type="button" className="button" disabled={busy} onClick={() => void download()}>
          <Download size={16} />
          {busy ? '準備備份中…' : '下載本機備份'}
        </button>
      </div>
      <p className="footnote">
        ZIP
        檔案未加密，僅下載至本機；不包含尚未儲存的筆記草稿。不會自動備份或還原，也不會讀取其他網站設定。
      </p>
      {warnings.map((warning) => (
        <p className="notice" key={warning}>
          {warning}
        </p>
      ))}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
