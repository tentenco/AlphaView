import { useEffect, useMemo, useState } from 'react'
import { Save, ArrowRight, Download } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import { num } from './ui'
import { SnapshotAlerts } from './SnapshotAlerts'
import { rankAlpha, portfolioAlerts, type AlphaSettings } from './alpha-model'
import {
  createSnapshot,
  readJournal,
  saveJournalSnapshot,
  previousComparable,
  snapshotChanges,
  JOURNAL_KEY,
  type ResearchSnapshot,
} from './alpha-journal'

export function ResearchJournal({
  data,
  scope,
  settings,
  locale,
  onOpen,
}: {
  data: Overview
  scope: Scope
  settings: AlphaSettings
  locale: Locale
  onOpen: (symbol: string, scope: Scope, date: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [history, setHistory] = useState(readJournal)
  const [message, setMessage] = useState('')
  const [writing, setWriting] = useState(false)
  const [removed, setRemoved] = useState<ResearchSnapshot | null>(null)
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === JOURNAL_KEY || event.key === null) setHistory(readJournal())
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const ranking = useMemo(() => rankAlpha(data, scope, settings), [data, scope, settings])
  const current = useMemo(
    () =>
      ranking.ready && ranking.scan
        ? createSnapshot(
            scope,
            ranking.scan.as_of,
            ranking.scan.universe,
            ranking.rows,
            portfolioAlerts(data, settings),
            settings,
          )
        : null,
    [data, scope, settings, ranking],
  )
  const previous = current ? previousComparable(history, current) : null
  const changes = current && previous ? snapshotChanges(current, previous) : null
  const saved = history
    .filter((item) => item.scope === scope)
    .sort((a, b) => b.date.localeCompare(a.date) || b.savedAt.localeCompare(a.savedAt))
  const detail = saved.find((item) => item.id === selected)
  async function writeLocked(write: () => ResearchSnapshot[]) {
    return navigator.locks?.request
      ? navigator.locks.request('alphaview-research-journal', write)
      : write()
  }
  async function save() {
    if (!current || writing) return
    setWriting(true)
    try {
      setHistory(await writeLocked(() => saveJournalSnapshot(readJournal(), current)))
      setMessage(
        t(
          '已保存本次研究快照。同日、同設定的快照會更新。',
          'Research snapshot saved. A snapshot with the same date and settings is updated.',
        ),
      )
    } catch {
      setMessage(
        t(
          '瀏覽器儲存空間不足，快照未保存。可刪除較早的快照後重試。',
          'Could not save the snapshot. Browser storage may be full; remove an older snapshot and retry.',
        ),
      )
    } finally {
      setWriting(false)
    }
  }
  async function remove(item: ResearchSnapshot) {
    if (writing) return
    setWriting(true)
    try {
      const next = await writeLocked(() => {
        const latest = readJournal()
        const target = latest.find((entry) => entry.id === item.id)
        if (JSON.stringify(target) !== JSON.stringify(item)) throw new Error('snapshot_changed')
        const remaining = latest.filter((entry) => entry.id !== item.id)
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(remaining))
        return remaining
      })
      setHistory(next)
      setRemoved(item)
      if (selected === item.id) setSelected(null)
      setMessage(t('已移除此快照，可以復原。', 'Snapshot removed. You can undo this removal.'))
    } catch (error) {
      setHistory(readJournal())
      setMessage(
        (error as Error).message === 'snapshot_changed'
          ? t(
              '快照已由其他操作更新，請檢查最新記錄後重試。',
              'The snapshot changed elsewhere. Review the latest record before retrying.',
            )
          : t('無法更新瀏覽器儲存空間。', 'Unable to update browser storage.'),
      )
    } finally {
      setWriting(false)
    }
  }
  async function undoRemove() {
    if (!removed || writing) return
    setWriting(true)
    try {
      setHistory(
        await writeLocked(() => {
          const latest = readJournal()
          if (latest.some((item) => item.id === removed.id)) throw new Error('snapshot_exists')
          return saveJournalSnapshot(latest, removed)
        }),
      )
      setSelected(removed.id)
      setRemoved(null)
      setMessage(t('快照已復原。', 'Snapshot restored.'))
    } catch (error) {
      setHistory(readJournal())
      setMessage(
        (error as Error).message === 'snapshot_exists'
          ? t(
              '已有同日同設定的快照，未覆寫現有記錄。',
              'A snapshot with that date and configuration already exists; it was not overwritten.',
            )
          : t(
              '無法復原快照，請檢查瀏覽器儲存空間。',
              'Could not restore the snapshot. Check browser storage.',
            ),
      )
    } finally {
      setWriting(false)
    }
  }
  return (
    <section className="alpha-journal">
      <div className="section-heading">
        <div>
          <div className="eyebrow">RESEARCH MEMORY</div>
          <h2>{t('今天有什麼變化', 'What Changed?')}</h2>
          <p>
            {previous
              ? t(
                  `與 ${previous.date} 已存快照比較`,
                  `Compared with saved snapshot from ${previous.date}`,
                )
              : t(
                  '保存今天，為下一個交易日建立比較基準。',
                  'Save today to establish a baseline for the next trading session.',
                )}
          </p>
        </div>
        <div className="actions">
          <button className="button" disabled={!current || writing} onClick={() => void save()}>
            <Save size={15} />
            {t('保存今日快照', 'Save Today')}
          </button>
          <button
            className="text-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {t(`已存快照 (${saved.length})`, `Saved Snapshots (${saved.length})`)}
          </button>
        </div>
      </div>
      {message && <p role="status">{message}</p>}
      {removed && (
        <div className="actions">
          <button
            type="button"
            className="text-button"
            disabled={writing}
            onClick={() => void undoRemove()}
          >
            {t(`復原 ${removed.date} 快照`, `Restore ${removed.date} Snapshot`)}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={writing}
            onClick={() => setRemoved(null)}
          >
            {t('略過復原', 'Dismiss Undo')}
          </button>
        </div>
      )}
      {changes && current && (
        <div className="alpha-change-grid">
          {(
            [
              [t('新進 Alpha', 'Entered Alpha'), changes.entered],
              [t('不再符合 Alpha', 'Exited Alpha'), changes.exited],
              [t('新增有效覆蓋的 Alpha', 'Alpha with New Coverage'), changes.newCoverage],
              [t('先前 Alpha 資料待補', 'Previous Alpha Missing Data'), changes.unavailable],
            ] as const
          ).map(([label, rows]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{rows.length}</strong>
              <div>
                {rows.slice(0, 8).map((row) => (
                  <button
                    className="text-button"
                    key={row.symbol}
                    onClick={() => onOpen(row.symbol, scope, current.date)}
                  >
                    {row.symbol}
                    <ArrowRight size={12} />
                  </button>
                ))}
                {rows.length > 8 && <span>+{rows.length - 8}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {!changes && (
        <p className="footnote">
          {t(
            '僅比較相同股票池、相同權重與門檻、較早交易日的已存快照。新增覆蓋與資料消失會分開標示，不當成訊號進出。',
            'Only earlier saved sessions with the same universe, weights, and thresholds are compared. Newly covered and unavailable rows are kept separate from signal entries and exits.',
          )}
        </p>
      )}
      {expanded && (
        <div className="alpha-journal-history">
          {!saved.length && <p>{t('目前尚無快照。', 'No snapshots saved yet.')}</p>}
          {saved.map((item) => (
            <div className="alpha-journal-row" key={item.id}>
              <button
                className="text-button"
                aria-expanded={selected === item.id}
                onClick={() => setSelected(selected === item.id ? null : item.id)}
              >
                {item.date} · {item.rows.filter((row) => row.alpha).length} Alpha ·{' '}
                {item.rows.length}/{item.universe.length} {t('有效資料', 'valid rows')}
              </button>
              <small>
                {new Date(item.savedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-TW')}
              </small>
              <button className="text-button" disabled={writing} onClick={() => void remove(item)}>
                {t('刪除', 'Delete')}
              </button>
            </div>
          ))}
          {detail && (
            <div className="alpha-snapshot-detail">
              <h3>
                {detail.date} · {t('保存時的 Alpha 清單', 'Alpha List at Save Time')}
              </h3>
              <p className="footnote">
                {t(
                  '這是當時保存的研究排序，不是目前訊號。',
                  'This is the ranking saved at that time, not current signals.',
                )}
              </p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  const payload = {
                    format_version: 1,
                    project: 'AlphaView',
                    exported_at: new Date().toISOString(),
                    snapshot: detail,
                  }
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
                  )
                  const link = document.createElement('a')
                  link.href = url
                  link.download = `alphaview-snapshot-${detail.scope}-${detail.date}.json`
                  link.click()
                  setTimeout(() => URL.revokeObjectURL(url), 1000)
                  setMessage(
                    t(
                      '已匯出此歷史快照，含當時的提醒與設定識別。',
                      'Historical snapshot exported with saved alerts and scoring configuration.',
                    ),
                  )
                }}
              >
                <Download size={15} />
                {t('匯出此快照 JSON', 'Export This Snapshot JSON')}
              </button>
              <div>
                {detail.rows
                  .filter((row) => row.alpha)
                  .map((row) => (
                    <span key={row.symbol}>
                      <b>{row.symbol}</b> {num(row.score, 0)} /100
                    </span>
                  ))}
              </div>
              <SnapshotAlerts alerts={detail.alerts} locale={locale} />
            </div>
          )}
        </div>
      )}
      <p className="footnote">
        {t(
          '最多保存最近 20 次快照，僅存於此瀏覽器。切換權重會使用不同的比較基準；刪除瀏覽器資料也會刪除快照。',
          'Keeps the latest 20 saves in this browser only. Different weights use a different comparison baseline. Clearing browser data removes snapshots.',
        )}
      </p>
    </section>
  )
}
