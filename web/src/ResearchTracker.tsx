import { useEffect, useState } from 'react'
import { ArrowRight, Save, Download } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { AlphaCandidate } from './alpha-model'
import { calendarRecords, researchCalendar } from './research-calendar'
import {
  localToday,
  readTracker,
  readTrackingDrafts,
  trackingBase,
  RESEARCH_STAGES,
  saveTrackingRecord,
  TRACKER_KEY,
  TRACKER_DRAFT_KEY,
  type ResearchStage,
  type TrackingRecord,
} from './research-tracker'

export function ResearchTracker({
  shortlist,
  candidates,
  locale,
  onOpen,
}: {
  shortlist: string[]
  candidates: AlphaCandidate[]
  locale: Locale
  onOpen: (symbol: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const labels: Record<ResearchStage, string> = {
    inbox: t('待研究', 'Inbox'),
    researching: t('研究中', 'Researching'),
    monitoring: t('持續觀察', 'Monitoring'),
    archived: t('封存', 'Archived'),
  }
  const [records, setRecords] = useState(readTracker)
  const [stage, setStage] = useState('active')
  const [dueOnly, setDueOnly] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [drafts, setDrafts] = useState(readTrackingDrafts)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const today = localToday()
  const symbols = [
    ...new Set([...shortlist, ...records.map((record) => record.symbol), ...Object.keys(drafts)]),
  ]
  const entries = symbols.map(
    (symbol) =>
      records.find((record) => record.symbol === symbol) || {
        symbol,
        stage: 'inbox' as const,
        reason: '',
        reviewOn: '',
        version: 0,
        updatedAt: '',
      },
  )
  const due = entries.filter(
    (record) => record.stage !== 'archived' && record.reviewOn && record.reviewOn <= today,
  )
  const rows = entries
    .filter(
      (record) =>
        (stage === 'all' ||
          (stage === 'active' && record.stage !== 'archived') ||
          record.stage === stage) &&
        (!dueOnly || (record.stage !== 'archived' && record.reviewOn && record.reviewOn <= today)),
    )
    .sort(
      (a, b) =>
        (a.reviewOn || '9999').localeCompare(b.reviewOn || '9999') ||
        a.symbol.localeCompare(b.symbol),
    )
  useEffect(() => {
    try {
      sessionStorage.setItem(TRACKER_DRAFT_KEY, JSON.stringify(drafts))
    } catch {
      if (Object.keys(drafts).length)
        setMessage(
          t(
            '此分頁無法暫存草稿，離開前請儲存進度。',
            'This tab cannot retain drafts. Save progress before leaving.',
          ),
        )
    }
  }, [drafts])
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === TRACKER_KEY || event.key === null) setRecords(readTracker())
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  function edit(record: TrackingRecord) {
    setDrafts((previous) => ({
      ...previous,
      [record.symbol]: previous[record.symbol] || { ...record, base: trackingBase(record) },
    }))
    setEditing(record.symbol)
    setMessage('')
  }
  async function save() {
    if (!editing || saving) return
    const draft = drafts[editing]
    setSaving(true)
    try {
      if (draft.version > 0 && draft.base === undefined) throw new Error('tracking_conflict')
      const write = () => saveTrackingRecord(draft, localStorage, draft.base)
      // Serialize cooperating tabs, then compare the record version while holding the lock.
      if (navigator.locks?.request)
        await navigator.locks.request('alphaview-research-tracker', write)
      else write()
      setRecords(readTracker())
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[draft.symbol]
        return next
      })
      setEditing(null)
      setMessage(t(`${draft.symbol} 研究進度已儲存。`, `${draft.symbol} research progress saved.`))
    } catch (err) {
      setMessage(
        (err as Error).message === 'tracking_conflict'
          ? t(
              '其他分頁已更新此標的。草稿仍保留；可複製理由，再按「載入最新記錄」合併。',
              'Another tab updated this symbol. Your draft is preserved. Copy your reason, then load the latest record to merge.',
            )
          : t(
              '無法儲存研究進度，請檢查瀏覽器儲存空間。最多 200 筆。',
              'Could not save research progress. Check browser storage; the limit is 200 records.',
            ),
      )
    } finally {
      setSaving(false)
    }
  }
  function exportCalendar() {
    try {
      const latest = readTracker()
      setRecords(latest)
      if (!calendarRecords(latest).length) {
        setMessage(t('尚無已儲存的複查日期。', 'No saved review dates to export.'))
        return
      }
      const url = URL.createObjectURL(
        new Blob([researchCalendar(latest, locale)], { type: 'text/calendar;charset=utf-8' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `alphaview-reviews-${today}.ics`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(
        t(
          '已匯出複查日期。匯入行事曆後可自行設定提醒；後續修改不會自動同步。',
          'Review dates exported. Import into your calendar and configure reminders there; later changes do not sync automatically.',
        ),
      )
    } catch {
      setMessage(
        t(
          '無法匯出，請確認複查日期在有效範圍內。',
          'Could not export. Check that review dates are within the supported range.',
        ),
      )
    }
  }
  const draft = editing ? drafts[editing] : null
  return (
    <details className="alpha-tracker">
      <summary>
        {t('研究進度', 'Research Progress')}{' '}
        <span>
          {entries.filter((r) => r.stage !== 'archived').length} {t('檔追蹤', 'tracking')} ·{' '}
          {due.length} {t('待複查', 'due for review')}
        </span>
      </summary>
      <p className="footnote">
        {t(
          '加星號後可安排自己的研究進度。階段與複查日期是個人紀錄；不改變持倉、選股權重或觸發下載。詳細筆記仍在個股頁。記錄保存在此瀏覽器，可透過研究備份搬家。',
          'Star a candidate to organize your research. Stages and review dates are personal records; they do not change positions, scores, or downloads. Detailed notes remain on the symbol page. Progress is saved in this browser and included in the research backup.',
        )}
      </p>
      <div className="alpha-filters">
        <select
          aria-label={t('研究階段篩選', 'Research stage filter')}
          value={stage}
          onChange={(event) => setStage(event.target.value)}
        >
          <option value="active">{t('進行中', 'Active')}</option>
          <option value="all">{t('所有階段', 'All Stages')}</option>
          {RESEARCH_STAGES.map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
        <label className="check-label">
          <input
            type="checkbox"
            checked={dueOnly}
            onChange={(event) => setDueOnly(event.target.checked)}
          />
          {t('只看待複查', 'Due for Review Only')}
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={!calendarRecords(records).length}
          onClick={exportCalendar}
        >
          <Download size={16} />
          {t('匯出全部複查日期', 'Export All Review Dates')} ({calendarRecords(records).length})
        </button>
        <span className="footnote">
          {t(
            'ICS 包含已儲存的追蹤理由，不含封存項目與未儲存草稿。',
            'ICS includes saved tracking reasons, excluding archived records and unsaved drafts.',
          )}
        </span>
      </div>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {draft && (
        <div className="alpha-tracker-editor">
          <strong>
            {draft.symbol} · {t('編輯研究進度', 'Edit Research Progress')}
          </strong>
          <div className="alpha-basket-inputs">
            <label>
              {t('研究階段', 'Research Stage')}
              <select
                value={draft.stage}
                disabled={saving}
                onChange={(event) =>
                  setDrafts({
                    ...drafts,
                    [draft.symbol]: { ...draft, stage: event.target.value as ResearchStage },
                  })
                }
              >
                {RESEARCH_STAGES.map((value) => (
                  <option key={value} value={value}>
                    {labels[value]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('下次複查日期', 'Next Review Date')}
              <input
                type="date"
                value={draft.reviewOn}
                disabled={saving}
                onChange={(event) =>
                  setDrafts({
                    ...drafts,
                    [draft.symbol]: { ...draft, reviewOn: event.target.value },
                  })
                }
              />
            </label>
          </div>
          <label>
            {t('追蹤理由／下次要確認的事', 'Tracking Reason / Next Question')}
            <textarea
              maxLength={280}
              rows={3}
              value={draft.reason}
              disabled={saving}
              onChange={(event) =>
                setDrafts({ ...drafts, [draft.symbol]: { ...draft, reason: event.target.value } })
              }
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="button primary"
              disabled={saving}
              onClick={() => void save()}
            >
              <Save size={16} />
              {t('儲存進度', 'Save Progress')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              {t('收起並保留草稿', 'Close and Keep Draft')}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={saving}
              onClick={() => {
                const latest = readTracker().find((record) => record.symbol === draft.symbol)
                setDrafts({
                  ...drafts,
                  [draft.symbol]: latest
                    ? { ...latest, base: trackingBase(latest) }
                    : {
                        symbol: draft.symbol,
                        stage: 'inbox',
                        reason: '',
                        reviewOn: '',
                        version: 0,
                        base: null,
                      },
                })
                setMessage('')
              }}
            >
              {t('載入最新記錄（取代草稿）', 'Load Latest Record (Replace Draft)')}
            </button>
          </div>
          <p className="footnote">
            {t(
              '未儲存草稿暫存在此分頁，切換頁面或重新整理後仍可繼續。正式進度與備份只包含按下儲存的內容。',
              'Unsaved drafts stay in this tab across navigation and reloads. Saved progress and backups include only explicitly saved content.',
            )}
          </p>
        </div>
      )}
      <div className="alpha-tracker-list">
        {rows.map((record) => {
          const candidate = candidates.find((row) => row.symbol === record.symbol)
          return (
            <article key={record.symbol}>
              <div>
                <strong>{record.symbol}</strong>
                <span className="badge">{labels[record.stage]}</span>
                {candidate ? (
                  <small>
                    {candidate.alpha ? 'Alpha Pick' : t('當期有資料', 'Current research available')}{' '}
                    ·{' '}
                    {candidate.relation === 'held'
                      ? t('已持有', 'Held')
                      : candidate.relation === 'watchlist'
                        ? t('觀察名單', 'Watchlist')
                        : t('新標的', 'New')}
                  </small>
                ) : (
                  <small>{t('目前範圍無有效研究資料', 'No valid research in this scope')}</small>
                )}
              </div>
              {record.reason && <p>{record.reason}</p>}
              <div className="alpha-tracker-actions">
                <small>
                  {record.reviewOn
                    ? `${record.reviewOn}${record.stage !== 'archived' && record.reviewOn <= today ? t(' · 待複查', ' · Review Due') : ''}`
                    : t('未排複查日期', 'No review date')}
                </small>
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => edit(record)}
                >
                  {t('編輯進度', 'Edit Progress')}
                  {drafts[record.symbol] ? ' •' : ''}
                </button>
                {candidate && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpen(record.symbol)}
                  >
                    {t('個股與筆記', 'Symbol & Notes')}
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {!rows.length && (
        <p className="footnote">
          {entries.length
            ? t('這個篩選下沒有記錄。', 'No records match this filter.')
            : t(
                '先在下方候選旁按星號，再回來安排研究進度。',
                'Star a candidate below, then return here to plan your research.',
              )}
        </p>
      )}
    </details>
  )
}
