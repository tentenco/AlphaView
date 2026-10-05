import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { archivePreflightCsv, downloadArchivePreflightCsv } from './archive-preflight-csv'
import './archive-preflight-records.css'

type Translate = (zh: string, en: string) => string
export type ArchivePreflightRecord = { id: string | null; compatible: boolean }
type Filter = 'all' | 'compatible' | 'unavailable'
type View = { resultIdentity: object; filter: Filter; query: string; page: number }
const PAGE_SIZE = 25
const initial = (resultIdentity: object): View => ({
  resultIdentity,
  filter: 'all',
  query: '',
  page: 0,
})

/** Presentation only. Original record objects, order, aggregates and archive bytes stay with the caller. */
export function ArchivePreflightRecords<T extends ArchivePreflightRecord>({
  records,
  resultIdentity,
  csvReport,
  t,
  children,
}: {
  records: readonly T[]
  resultIdentity: object
  csvReport?: object
  t: Translate
  children: (record: T, originalIndex: number) => ReactNode
}) {
  const id = useId()
  const [view, setView] = useState<View>(() => initial(resultIdentity))
  const [downloadError, setDownloadError] = useState<object | null>(null)
  const csv = useMemo(() => {
    if (!csvReport) return null
    try {
      if (csvReport !== resultIdentity || (csvReport as { records?: unknown }).records !== records)
        throw new Error('Preflight CSV identity mismatch')
      return { content: archivePreflightCsv(csvReport), unavailable: false }
    } catch {
      return { content: null, unavailable: true }
    }
  }, [csvReport, resultIdentity, records])
  // A new accepted report renders its first page immediately; no stale page appears before effects run.
  const current = view.resultIdentity === resultIdentity ? view : initial(resultIdentity)
  useEffect(() => {
    setView((previous) =>
      previous.resultIdentity === resultIdentity ? previous : initial(resultIdentity),
    )
  }, [resultIdentity])
  const query = current.query.toLowerCase()
  const matched = records
    .map((record, originalIndex) => ({ record, originalIndex }))
    .filter(
      ({ record }) =>
        (current.filter === 'all' ||
          (current.filter === 'compatible' ? record.compatible : !record.compatible)) &&
        (!query || (record.id !== null && record.id.toLowerCase().includes(query))),
    )
  const pages = Math.ceil(matched.length / PAGE_SIZE)
  const page = Math.min(current.page, Math.max(0, pages - 1))
  const first = page * PAGE_SIZE
  const visible = matched.slice(first, first + PAGE_SIZE)
  function update(change: Partial<Omit<View, 'resultIdentity'>>) {
    setView({ ...current, page: 0, ...change, resultIdentity })
  }
  return (
    <section className="archive-preflight-records" aria-labelledby={`${id}-heading`}>
      <h5 id={`${id}-heading`}>{t('逐筆預檢紀錄', 'Individual preflight records')}</h5>
      <p className="notice" id={`${id}-notice`}>
        {t(
          '篩選只改變紀錄清單，不會改變完整預檢結果、涵蓋、容量或封存檔。',
          'Filtering changes only the record list, not the full preflight result, coverage, capacity or archive.',
        )}
      </p>
      {csv && (
        <>
          <p className="notice">
            {t(
              '長格式 CSV 保留完整預檢中繼資料與全部原序紀錄，索引由 0 起算；篩選與分頁不縮減。型別標記區分缺欄、null 與空值；這是可讀副本，不是原封存或匯入檔。',
              'Long-format CSV retains full preflight metadata and every record in original order with zero-based indices; filters and pages do not reduce it. Type markers distinguish missing, null and empty values. This is a readable copy, not the original archive or an import file.',
            )}
          </p>
          <button
            type="button"
            disabled={!csv.content}
            onClick={() => {
              if (!csv.content || !csvReport || csvReport !== resultIdentity) return
              try {
                downloadArchivePreflightCsv(csv.content, csvReport)
                setDownloadError(null)
              } catch {
                setDownloadError(resultIdentity)
              }
            }}
          >
            {t('下載全部預檢紀錄CSV', 'Download all preflight records CSV')}
          </button>
          {(csv.unavailable || downloadError === resultIdentity) && (
            <p role="alert">
              {t(
                '完整預檢 CSV 不可用：內容不支援、來源不符、超過上限或下載失敗；未產生部分檔案。',
                'Complete preflight CSV unavailable: unsupported content, identity mismatch, exceeded limit or download failure. No partial file was produced.',
              )}
            </p>
          )}
        </>
      )}
      <div className="archive-preflight-record-filters" aria-describedby={`${id}-notice`}>
        <label htmlFor={`${id}-filter`}>
          {t('相容性篩選', 'Compatibility filter')}
          <select
            id={`${id}-filter`}
            value={current.filter}
            onChange={(event) => update({ filter: event.target.value as Filter })}
          >
            <option value="all">{t('全部', 'All')}</option>
            <option value="compatible">{t('相容', 'Compatible')}</option>
            <option value="unavailable">{t('不可用', 'Unavailable')}</option>
          </select>
        </label>
        <label htmlFor={`${id}-search`}>
          {t('搜尋收據識別（選填）', 'Search receipt ID (optional)')}
          <input
            id={`${id}-search`}
            type="search"
            value={current.query}
            onChange={(event) => update({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          disabled={current.filter === 'all' && current.query === ''}
          onClick={() => setView(initial(resultIdentity))}
        >
          {t('重設紀錄篩選', 'Reset filters')}
        </button>
      </div>
      <p className="archive-preflight-record-counts" role="status" aria-live="polite">
        {t('符合篩選', 'Matched')} {matched.length} / {records.length}{' '}
        {t('筆已回傳紀錄', 'returned records')} · {t('顯示', 'Showing')}{' '}
        {matched.length ? first + 1 : 0}–{first + visible.length} · {t('每頁 25 筆', '25 per page')}
      </p>
      <div
        className="archive-preflight-record-pages"
        role="group"
        aria-label={t('預檢紀錄分頁', 'Preflight record pages')}
      >
        <button type="button" disabled={page === 0} onClick={() => update({ page: page - 1 })}>
          {t('上一頁紀錄', 'Previous page')}
        </button>
        <span>
          {t('頁次', 'Page')} {pages ? page + 1 : 0} / {pages}
        </span>
        <button
          type="button"
          disabled={pages === 0 || page >= pages - 1}
          onClick={() => update({ page: page + 1 })}
        >
          {t('下一頁紀錄', 'Next page')}
        </button>
      </div>
      {!visible.length && (
        <p>
          {t(
            '沒有符合此篩選的紀錄；上方完整預檢結果仍然有效。',
            'No records match this filter; the full preflight result above still applies.',
          )}
        </p>
      )}
      {visible.map(({ record, originalIndex }) => {
        const unknown = record.id === null || record.id === ''
        const abbreviated = unknown
          ? t('紀錄識別未知', 'Unknown identity')
          : record.id!.length > 24
            ? `${record.id!.slice(0, 12)}…${record.id!.slice(-8)}`
            : record.id
        return (
          <details
            key={`${record.id ?? 'unknown'}:${originalIndex}`}
            className="receipt-archive-record"
            data-archive-record-index={originalIndex}
          >
            <summary className="archive-preflight-record-summary">
              <span>
                <code title={record.id ?? undefined}>{abbreviated}</code>
                <span>
                  {record.compatible
                    ? t('結構相容', 'Structure compatible')
                    : t('不可用', 'Unavailable')}
                </span>
              </span>
            </summary>
            <p className="archive-preflight-record-id">
              {t('完整收據識別', 'Full receipt ID')} ·{' '}
              <code>{record.id === null ? '—' : record.id === '' ? '""' : record.id}</code>
            </p>
            {children(record, originalIndex)}
          </details>
        )
      })}
    </section>
  )
}
