import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import { dateTime } from './ui'

type Translate = (zh: string, en: string) => string
export const REVIEW_REASONS: Record<string, [string, string]> = {
  not_found: ['券商找不到此委託', 'Broker could not find this order'],
  order_rejected: ['委託遭拒絕', 'Order rejected'],
  swept: ['清掃時尚未送出', 'Unsent at sweep'],
  not_sent: ['前一筆委託結果未知', 'Previous order outcome unknown'],
  limit_price_missing: ['記錄的限價缺失', 'Recorded limit price missing'],
  reconcile_required: ['缺少券商識別', 'Broker identifier missing'],
  orders_disabled: ['委託能力未啟用', 'Order capability disabled'],
  not_configured: ['連線設定不可用', 'Connection unavailable'],
  cancel_rejected: ['取消請求被拒絕', 'Cancel request rejected'],
  cancel_requested: ['已記錄取消請求', 'Cancel request recorded'],
  skipped: ['清掃時略過未送出委託', 'Unsent order skipped during sweep'],
  unknown: ['清掃結果未知', 'Sweep outcome unknown'],
  network_unavailable: ['取消時無法連線', 'Connection unavailable during cancellation'],
  provider_unavailable: ['券商回應不可用', 'Broker response unavailable'],
}
const SWEEP_TRIGGERS: Record<string, [string, string]> = {
  manual_sweep: ['手動清掃', 'Manual sweep'],
  kill_switch: ['帳戶暫停清掃', 'Account pause sweep'],
  kill_switch_enabled: ['啟用帳戶暫停開關', 'Account pause enabled'],
  'circuit_breaker_tripped:daily_loss': [
    '每日虧損斷路器觸發',
    'Daily-loss circuit breaker tripped',
  ],
  'circuit_breaker_tripped:max_drawdown': [
    '最大回撤斷路器觸發',
    'Maximum-drawdown circuit breaker tripped',
  ],
  'circuit_breaker_tripped:max_fills_per_session': [
    '單日成交筆數斷路器觸發',
    'Session fill-count circuit breaker tripped',
  ],
}
export const sweepTriggerLabel = (reason: string | null, t: Translate) => {
  if (!reason) return '—'
  const label = SWEEP_TRIGGERS[reason]
  return label ? `${t(...label)} (${reason})` : reason
}
type SavedError = { code?: string | null; message?: string | null; http_status?: number | null }
type SavedOrder = {
  order_id: string
  submission_id: string
  symbol: string | null
  side: string | null
  previous_status: string | null
  action: string | null
  error: SavedError | null
}
type EventSummary = {
  id: string
  account_id: string
  submission_id: string
  created_at: string
  engine_version: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  at: string | null
  reason: string | null
  results_count: number | null
  counts: Record<string, number> | null
}
type EventDetail = EventSummary & {
  event: {
    engine_version: string
    account_id: string
    submission_id: string
    at: string
    reason: string
    results: SavedOrder[]
  } | null
}
type History = {
  account_id: string
  items: EventSummary[]
  pagination: { offset: number; limit: number; total: number; returned: number }
  filters?: {
    submission_id: string | null
    start_date: string | null
    end_date: string | null
    reason: string | null
  }
  filter_coverage?: { unverifiable_excluded: number | null }
}
type Filters = { start: string; end: string; reason: string }
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const countText = (value: unknown) => (count(value) ? String(value) : '—')
const time = (value: unknown) =>
  text(value) && Number.isFinite(Date.parse(value)) ? dateTime(value) : '—'
const codeLabel = (value: unknown, labels: Record<string, [string, string]>, t: Translate) =>
  text(value) ? (labels[value] ? `${t(...labels[value])} (${value})` : value) : '—'
const orderStatus = (value: unknown, t: Translate) =>
  codeLabel(
    value,
    {
      pending: ['未送出', 'Not sent'],
      accepted: ['券商已接受', 'Accepted'],
      partially_filled: ['部分成交', 'Partially filled'],
      filled: ['已成交', 'Filled'],
      cancel_requested: ['取消中', 'Cancel requested'],
      cancelled: ['已取消', 'Cancelled'],
      expired: ['已過期', 'Expired'],
      rejected: ['遭拒絕', 'Rejected'],
      unknown: ['未知', 'Unknown'],
      skipped: ['略過（未送出）', 'Skipped (not sent)'],
    },
    t,
  )
function validSummary(value: unknown, accountId: string): value is EventSummary {
  const identified =
    record(value) &&
    text(value.id) &&
    value.account_id === accountId &&
    text(value.submission_id) &&
    record(value.integrity) &&
    typeof value.integrity.available === 'boolean'
  if (!identified || !record(value)) return false
  if (!(value.integrity as { available: boolean }).available) return true
  return (
    text(value.engine_version) &&
    text(value.created_at) &&
    typeof value.content_fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.content_fingerprint) &&
    (value.at == null || text(value.at)) &&
    (value.reason == null || text(value.reason)) &&
    (value.results_count == null || count(value.results_count)) &&
    (value.counts == null || (record(value.counts) && Object.values(value.counts).every(count)))
  )
}
function validHistory(
  value: unknown,
  accountId: string,
  offset: number,
  submissionId: string | null,
  filters: Filters,
): value is History {
  if (
    !record(value) ||
    value.account_id !== accountId ||
    !Array.isArray(value.items) ||
    !record(value.pagination)
  )
    return false
  const page = value.pagination
  const filtering = !!(filters.start || filters.end || filters.reason)
  if (
    filtering &&
    (!record(value.filters) ||
      value.filters.submission_id !== submissionId ||
      value.filters.start_date !== (filters.start || null) ||
      value.filters.end_date !== (filters.end || null) ||
      value.filters.reason !== (filters.reason || null) ||
      !record(value.filter_coverage) ||
      !count(value.filter_coverage.unverifiable_excluded))
  )
    return false
  return (
    value.items.every(
      (item) =>
        validSummary(item, accountId) && (!submissionId || item.submission_id === submissionId),
    ) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length &&
    page.offset === offset &&
    page.limit === 20 &&
    page.returned === value.items.length &&
    count(page.total) &&
    count(page.returned) &&
    page.returned <= 20 &&
    page.total >= page.returned
  )
}
function validDetail(
  value: unknown,
  requested: EventSummary,
  accountId: string,
): value is EventDetail {
  if (
    !validSummary(value, accountId) ||
    value.id !== requested.id ||
    value.submission_id !== requested.submission_id ||
    value.content_fingerprint !== requested.content_fingerprint
  )
    return false
  if (!value.integrity.available) return true
  const event = (value as EventDetail).event
  return (
    record(event) &&
    event.account_id === accountId &&
    event.engine_version === value.engine_version &&
    event.submission_id === value.submission_id &&
    event.at === value.at &&
    event.reason === value.reason &&
    text(event.at) &&
    Number.isFinite(Date.parse(event.at)) &&
    text(event.reason) &&
    Array.isArray(event.results) &&
    event.results.length === value.results_count &&
    event.results.every(
      (row) => record(row) && text(row.order_id) && row.submission_id === value.submission_id,
    ) &&
    new Set(event.results.map((row) => row.order_id)).size === event.results.length
  )
}

function saveJson(value: unknown, filename: string) {
  const json = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new Error('Sweep evidence contains a non-finite number')
      return item
    },
    2,
  )
  const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  try {
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}

type Props = { accountId: string; locale: Locale; selectedSubmissionId?: string | null }
type Scope = 'account' | 'submission'
export function ExecutionSweepHistory(props: Props) {
  return <SweepHistoryAccount key={props.accountId} {...props} />
}
function SweepHistoryAccount(props: Props) {
  const [scope, setScope] = useState<Scope>('account')
  const currentSubmission = text(props.selectedSubmissionId) ? props.selectedSubmissionId : null
  const submissionId = scope === 'submission' ? currentSubmission : null
  return (
    <SweepHistoryView
      key={JSON.stringify([scope, submissionId])}
      {...props}
      scope={scope}
      setScope={setScope}
      submissionId={submissionId}
      currentSubmission={currentSubmission}
    />
  )
}
function SweepHistoryView({
  accountId,
  locale,
  scope,
  setScope,
  submissionId,
  currentSubmission,
}: Props & {
  scope: Scope
  setScope: (scope: Scope) => void
  submissionId: string | null
  currentSubmission: string | null
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [history, setHistory] = useState<History | null>(null)
  const [selected, setSelected] = useState<EventDetail | null>(null)
  const [busy, setBusy] = useState<'list' | 'detail' | 'batch' | null>(null)
  const [batchCount, setBatchCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>({ start: '', end: '', reason: '' })
  const selectionContext = useRef({ id: currentSubmission })
  if (selectionContext.current.id !== currentSubmission)
    selectionContext.current = { id: currentSubmission }
  const [exportContext, setExportContext] = useState<{ id: string | null } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const base = `/api/execution/accounts/${encodeURIComponent(accountId)}/sweep-history`
  useEffect(() => () => operation.current?.abort(), [])
  const filterError =
    filters.start && filters.end && filters.start > filters.end
      ? t('開始日期不可晚於結束日期。', 'The first date must not follow the last date.')
      : filters.reason !== filters.reason.trim()
        ? t('原因代碼的前後不可有空白。', 'The reason code must not have surrounding whitespace.')
        : ''
  function changeFilter(key: keyof Filters, value: string) {
    operation.current?.abort()
    operation.current = null
    setBusy(null)
    setHistory(null)
    setSelected(null)
    setExportContext(null)
    setBatchCount(null)
    setError('')
    setFilters((previous) => ({ ...previous, [key]: value }))
  }
  async function request(url: string, signal: AbortSignal) {
    const response = await fetch(url, { cache: 'no-store', signal })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) {
      const code = record(value) && record(value.detail) ? value.detail.code : null
      throw new Error(
        code === 'sweep_export_limit' || code === 'sweep_export_size'
          ? t(
              '匯出超過 250 筆或 2 MiB；請縮小日期、原因或送出紀錄範圍。',
              'Export exceeds 250 events or 2 MiB. Narrow the dates, reason or submission.',
            )
          : code === 'sweep_event_not_found'
            ? t(
                '這筆清掃事件不存在或不屬於此帳戶。',
                'This sweep event is missing or belongs to another account.',
              )
            : t(
                `清掃歷程讀取失敗（${response.status}）`,
                `Sweep history request failed (${response.status})`,
              ),
      )
    }
    return value as unknown
  }
  function queryFilter() {
    let filter = submissionId ? `&submission_id=${encodeURIComponent(submissionId)}` : ''
    if (filters.start) filter += `&start_date=${encodeURIComponent(filters.start)}`
    if (filters.end) filter += `&end_date=${encodeURIComponent(filters.end)}`
    if (filters.reason) filter += `&reason=${encodeURIComponent(filters.reason)}`
    return filter
  }
  async function exportBatch() {
    if (operation.current || filterError || (scope === 'submission' && !submissionId)) return
    const context = selectionContext.current
    const controller = new AbortController()
    operation.current = controller
    setBusy('batch')
    setError('')
    setBatchCount(null)
    try {
      const filter = queryFilter()
      const value = await request(
        `${base}/export${filter ? `?${filter.slice(1)}` : ''}`,
        controller.signal,
      )
      if (controller.signal.aborted || context !== selectionContext.current) return
      if (
        !record(value) ||
        value.export_version !== 'alphaview-execution-sweep-export-v1' ||
        value.account_id !== accountId ||
        !record(value.filters) ||
        value.filters.submission_id !== submissionId ||
        value.filters.start_date !== (filters.start || null) ||
        value.filters.end_date !== (filters.end || null) ||
        value.filters.reason !== (filters.reason || null) ||
        !Array.isArray(value.items) ||
        value.items.length > 250 ||
        !record(value.coverage) ||
        value.coverage.complete_for_filters !== true ||
        value.coverage.matching_events !== value.items.length ||
        value.coverage.exported_events !== value.items.length ||
        !value.items.every(
          (item) =>
            validSummary(item, accountId) &&
            (!submissionId || item.submission_id === submissionId) &&
            (item.integrity.available
              ? validDetail(item, item, accountId)
              : (item as EventDetail).event === null),
        ) ||
        new Set(value.items.map((item) => item.id)).size !== value.items.length ||
        value.coverage.verified_events !==
          value.items.filter((item) => item.integrity.available).length ||
        value.coverage.unverifiable_events !==
          value.items.filter((item) => !item.integrity.available).length
      )
        throw new Error(
          t(
            '批次證據的帳戶、條件或覆蓋不符，未下載。',
            'Batch evidence account, filters or coverage do not match; no download was created.',
          ),
        )
      saveJson(value, 'alphaview-sweep-history.json')
      setBatchCount(value.items.length)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  async function load(offset = 0) {
    if (operation.current || filterError || (scope === 'submission' && !submissionId)) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('list')
    setError('')
    setSelected(null)
    setHistory(null)
    try {
      const filter = queryFilter()
      const value = await request(`${base}?limit=20&offset=${offset}${filter}`, controller.signal)
      if (controller.signal.aborted) return
      if (!validHistory(value, accountId, offset, submissionId, filters))
        throw new Error(
          t(
            '清掃歷程的帳戶、送出紀錄或分頁資料不符。',
            'Sweep history account, submission or pagination does not match.',
          ),
        )
      setHistory(value)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  async function open(item: EventSummary) {
    if (operation.current) return
    const context = selectionContext.current
    const controller = new AbortController()
    operation.current = controller
    setBusy('detail')
    setError('')
    setSelected(null)
    try {
      const value = await request(`${base}/${encodeURIComponent(item.id)}`, controller.signal)
      if (controller.signal.aborted) return
      if (!validDetail(value, item, accountId))
        throw new Error(
          t(
            '清掃事件身份不符或內容無法驗證。',
            'Sweep event identity does not match or its content cannot be verified.',
          ),
        )
      setSelected(value)
      setExportContext(context)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  const selectedItem = history?.items.find((item) => item.id === selected?.id)
  const exportable =
    selected &&
    selectedItem &&
    exportContext === selectionContext.current &&
    selected.integrity.available &&
    selected.event &&
    validDetail(selected, selectedItem, accountId) &&
    (!submissionId || selected.submission_id === submissionId)
      ? selected
      : null
  function download() {
    if (!exportable || busy || operation.current || error) return
    try {
      // Keep the complete accepted envelope, including future fields outside the rendered table.
      const safe =
        exportable.id
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64) || 'unknown'
      saveJson(exportable, `alphaview-sweep-event-${safe}.json`)
    } catch {
      setError(
        t(
          '無法下載這份清掃事件，請重新檢閱事件後再試。',
          'This sweep event could not be downloaded. Review the event again and retry.',
        ),
      )
    }
  }
  const unavailable = (item: EventSummary) => (
    <>
      {t('保存證據不可用', 'Saved evidence unavailable')}
      {text(item.integrity.reason) ? ` · ${item.integrity.reason}` : ''}
    </>
  )
  return (
    <section className="agent-panel" aria-label={t('已保存清掃歷程', 'Saved sweep history')}>
      <h2>{t('已保存清掃歷程', 'Saved sweep history')}</h2>
      <p className="research-note">
        {t(
          '只讀取此帳戶已保存的清掃事件，不回補舊摘要。歷史取消請求不代表已取消，也不是目前券商委託狀態；這裡不送單、不撤單、不對帳。',
          'Reads saved sweep events for this account without backfilling older summaries. A historical cancel request does not confirm cancellation or describe current broker order state. This view does not send, cancel or reconcile orders.',
        )}
      </p>
      <label className="agent-field">
        {t('清掃歷程範圍', 'Sweep history scope')}
        <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          <option value="account">{t('整個帳戶', 'Whole account')}</option>
          <option value="submission" disabled={!currentSubmission}>
            {t('目前選取的送出紀錄', 'Currently selected submission')}
          </option>
        </select>
      </label>
      <div className="agent-form-grid">
        <label className="agent-field">
          {t('開始日期（UTC，含當日）', 'First date (UTC, inclusive)')}
          <input
            type="date"
            value={filters.start}
            onChange={(event) => changeFilter('start', event.target.value)}
          />
        </label>
        <label className="agent-field">
          {t('結束日期（UTC，含當日）', 'Last date (UTC, inclusive)')}
          <input
            type="date"
            value={filters.end}
            onChange={(event) => changeFilter('end', event.target.value)}
          />
        </label>
        <label className="agent-field">
          {t('原因代碼（完全符合；空白為全部）', 'Reason code (exact match; empty for all)')}
          <input
            value={filters.reason}
            maxLength={200}
            list="sweep-trigger-codes"
            onChange={(event) => changeFilter('reason', event.target.value)}
          />
        </label>
        <datalist id="sweep-trigger-codes">
          {Object.entries(SWEEP_TRIGGERS).map(([code, label]) => (
            <option key={code} value={code}>
              {t(...label)}
            </option>
          ))}
        </datalist>
      </div>
      <p className="research-note">
        {t(
          '日期以 UTC 清掃時間判斷；篩選先於分頁。留空可讀取全部事件。',
          'Dates use UTC sweep time; filtering precedes pagination. Leave empty to read all events.',
        )}
      </p>
      {filterError && (
        <p role="alert" className="error-message">
          {filterError}
        </p>
      )}
      {scope === 'submission' && (
        <p className="workflow-json">
          {submissionId ? (
            <>
              {t('所選送出紀錄', 'Selected submission')}: {submissionId}
            </>
          ) : (
            t(
              '尚未選取送出紀錄；請先開啟送出明細，或切回整個帳戶。',
              'No submission is selected. Open submission details first, or switch to the whole account.',
            )
          )}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          disabled={!!busy || !!filterError || (scope === 'submission' && !submissionId)}
          onClick={() => load()}
        >
          {busy === 'list'
            ? t('讀取清掃歷程…', 'Loading sweep history…')
            : t('讀取清掃歷程', 'Load sweep history')}
        </button>
        <button
          className="button"
          disabled={!!busy || !!filterError || (scope === 'submission' && !submissionId)}
          onClick={exportBatch}
        >
          {busy === 'batch'
            ? t('準備批次 JSON…', 'Preparing batch JSON…')
            : t('匯出此範圍 JSON', 'Export this scope as JSON')}
        </button>
      </div>
      <p className="research-note">
        {t(
          '批次匯出最多 250 筆、2 MiB，涵蓋全部符合條件的事件；不受目前頁碼限制，也不刪除資料。',
          'Batch export includes all matching events, up to 250 events and 2 MiB, regardless of the current page. It does not delete data.',
        )}
      </p>
      {batchCount !== null && (
        <p role="status">
          {t('已準備批次下載的事件數', 'Events prepared for batch download')}: {batchCount}
        </p>
      )}
      {busy === 'detail' && <p role="status">{t('讀取清掃事件…', 'Loading sweep event…')}</p>}
      {error && (
        <p className="error-message workflow-json" role="alert">
          {error}
        </p>
      )}
      {history && (
        <>
          {(filters.start || filters.end || filters.reason) && (
            <p role="status" className="notice">
              {t(
                '符合篩選的可驗證事件；不可驗證且未納入篩選的記錄數',
                'Verified events matching filters; unverifiable records excluded from filtering',
              )}
              : {countText(history.filter_coverage?.unverifiable_excluded)}
            </p>
          )}
          <p>
            {scope === 'submission'
              ? t('所選送出紀錄已保存事件數', 'Saved selected-submission event count')
              : t('帳戶已保存事件數', 'Saved account event count')}
            : {countText(history.pagination.total)}
          </p>
          {!history.items.length ? (
            <p>
              {scope === 'submission'
                ? t(
                    '此送出紀錄的這一頁沒有已保存清掃事件；舊摘要不會補成歷程。',
                    'No saved sweep events for this submission on this page; older summaries are not backfilled.',
                  )
                : t(
                    '此頁沒有已保存清掃事件；舊摘要不會補成歷程。',
                    'No saved sweep events on this page; older summaries are not backfilled.',
                  )}
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('清掃時間', 'Sweep time'),
                      t('觸發原因', 'Trigger'),
                      t('送出紀錄', 'Submission'),
                      t('保存項目數', 'Saved result count'),
                      t('證據狀態', 'Evidence status'),
                      t('檢閱', 'Review'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.items.map((item) => (
                    <tr key={item.id}>
                      <td>{time(item.integrity.available ? item.at : null)}</td>
                      <td className="workflow-reason-cell">
                        {sweepTriggerLabel(item.integrity.available ? item.reason : null, t)}
                      </td>
                      <td className="workflow-json">{item.submission_id}</td>
                      <td>{countText(item.integrity.available ? item.results_count : null)}</td>
                      <td>
                        {item.integrity.available
                          ? t('歷史事件已保存', 'Historical event saved')
                          : unavailable(item)}
                      </td>
                      <td>
                        <button className="button" disabled={!!busy} onClick={() => open(item)}>
                          {t('檢閱清掃事件', 'Review sweep event')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions">
            <button
              className="button"
              disabled={!!busy || history.pagination.offset === 0}
              onClick={() => load(Math.max(0, history.pagination.offset - 20))}
            >
              {t('上一頁', 'Previous page')}
            </button>
            <button
              className="button"
              disabled={
                !!busy ||
                history.pagination.offset + history.pagination.returned >=
                  history.pagination.total ||
                history.pagination.offset + 20 > 5000
              }
              onClick={() => load(history.pagination.offset + 20)}
            >
              {t('下一頁', 'Next page')}
            </button>
          </div>
          {history.pagination.offset + history.pagination.returned < history.pagination.total &&
            history.pagination.offset + 20 > 5000 && (
              <p className="notice" role="status">
                {t(
                  '已到歷程瀏覽上限；仍有更早的保存事件未顯示，總筆數維持原值。',
                  'The history browsing limit has been reached. Earlier saved events remain undisplayed; the total count is unchanged.',
                )}
              </p>
            )}
        </>
      )}
      {selected && (
        <section aria-label={t('歷史清掃事件明細', 'Historical sweep event details')}>
          <h3>{t('保存時的清掃結果', 'Sweep results as saved')}</h3>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={!exportable || !!busy || !!error}
              onClick={download}
            >
              {t('下載清掃事件 JSON', 'Download sweep event JSON')}
            </button>
          </div>
          {!selected.integrity.available || !selected.event ? (
            <p className="workflow-json" role="status">
              {unavailable(selected)}
            </p>
          ) : (
            <>
              <p className="workflow-json">
                {t('清掃時間', 'Sweep time')}: {time(selected.event.at)} ·{' '}
                {sweepTriggerLabel(selected.event.reason, t)}
              </p>
              <p className="workflow-json">
                {t('送出紀錄', 'Submission')}: {selected.submission_id}
              </p>
              <p className="workflow-json">
                {t('保存結果計數', 'Saved outcome counts')}:{' '}
                {selected.counts && Object.keys(selected.counts).length
                  ? Object.entries(selected.counts)
                      .map(
                        ([code, value]) =>
                          `${codeLabel(code, REVIEW_REASONS, t)}: ${countText(value)}`,
                      )
                      .join(' · ')
                  : '—'}
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('標的', 'Symbol'),
                        t('當時記錄的處理', 'Recorded sweep action'),
                        t('清掃前保存狀態', 'Saved pre-sweep status'),
                        t('當時記錄的錯誤', 'Recorded sweep error'),
                        t('方向', 'Side'),
                        t('委託識別', 'Order ID'),
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.event.results.map((row) => (
                      <tr key={row.order_id}>
                        <th scope="row">{text(row.symbol) ? row.symbol : '—'}</th>
                        <td className="workflow-reason-cell">
                          {codeLabel(row.action, REVIEW_REASONS, t)}
                        </td>
                        <td className="workflow-reason-cell">
                          {orderStatus(row.previous_status, t)}
                        </td>
                        <td className="workflow-reason-cell">
                          {row.error && record(row.error) ? (
                            <>
                              {codeLabel(row.error.code, REVIEW_REASONS, t)}
                              {typeof row.error.http_status === 'number' &&
                              Number.isInteger(row.error.http_status) &&
                              row.error.http_status >= 100 &&
                              row.error.http_status <= 599
                                ? ` · HTTP ${row.error.http_status}`
                                : ''}
                              {text(row.error.message) ? <p>{row.error.message}</p> : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {row.side === 'buy'
                            ? t('買進', 'Buy')
                            : row.side === 'sell'
                              ? t('賣出', 'Sell')
                              : text(row.side)
                                ? row.side
                                : '—'}
                        </td>
                        <td className="workflow-json">{row.order_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <details>
            <summary>{t('保存來源身份', 'Saved source identity')}</summary>
            <p className="workflow-json">
              {selected.id} · {text(selected.engine_version) ? selected.engine_version : '—'}
            </p>
            <p className="workflow-json">
              {text(selected.content_fingerprint) ? selected.content_fingerprint : '—'}
            </p>
            <p>
              {t('保存時間', 'Saved at')}: {time(selected.created_at)}
            </p>
          </details>
        </section>
      )}
    </section>
  )
}
