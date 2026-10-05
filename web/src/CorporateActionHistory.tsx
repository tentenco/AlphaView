import { useEffect, useRef, useState } from 'react'
import { workflowEvidenceJson } from './workflow-evidence-json'
import './corporate-action-history.css'

type Translate = (zh: string, en: string) => string
const VERSION = 'alphaview-corporate-action-history-v1'
type Event = {
  ex_date: string
  kind: 'cash_dividend' | 'stock_split'
  raw_type: string
  raw_value: string | null
  value: number | null
  reason: string | null
}
type Payload = {
  engine_version: string
  adapter_version: string
  source: string
  source_completeness: 'unknown'
  value_basis: string
  columns_present: Record<string, boolean>
  events: Event[]
}
export type ActionRevision = {
  symbol: string
  revision: number | null
  fingerprint: string | null
  first_fetched_at: string | null
  integrity: { available: boolean; reason: string | null }
  evidence_engine_version: string | null
  adapter_version: string | null
  saved_event_count: number | null
  columns_present: Record<string, boolean> | null
  source_completeness: 'unknown'
  historical_coverage: null
  historical_coverage_reason: string
  payload?: Payload | null
  payload_json?: string | null
}
type Base = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  source_completeness: 'unknown'
  historical_coverage: null
  historical_coverage_reason: string
  symbol?: string
}
type Context = Base & { symbols: { symbol: string; available: boolean; reason: string | null }[] }
type Listing = Base & {
  items: ActionRevision[]
  pagination: { limit: number; offset: number; total: number; returned: number }
}
type Detail = Base & { item: ActionRevision }
export type ActionComparison = Base & {
  request: {
    expected_account_version: number
    baseline_revision: number
    selected_revision: number
    expected_baseline_fingerprint: string
    expected_selected_fingerprint: string
  }
  status: 'compared' | 'unavailable'
  baseline: ActionRevision
  selected: ActionRevision
  changes:
    | null
    | {
        ex_date: string
        kind: Event['kind']
        change_types: string[]
        baseline: Event | null
        selected: Event | null
        baseline_reason: string | null
        selected_reason: string | null
        numeric_delta: number | null
        numeric_delta_reason: string | null
      }[]
  change_count: number | null
  reason: string | null
}
type Props = { accountId: string; enabled?: boolean; t: Translate }
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const eventValid = (event: Event) =>
  event &&
  /^\d{4}-\d{2}-\d{2}$/.test(event.ex_date) &&
  ['cash_dividend', 'stock_split'].includes(event.kind) &&
  typeof event.raw_type === 'string' &&
  (event.raw_value === null || typeof event.raw_value === 'string') &&
  (event.value === null || (typeof event.value === 'number' && Number.isFinite(event.value))) &&
  (event.reason === null || typeof event.reason === 'string')
function revisionValid(item: ActionRevision, symbol: string, detail = false) {
  if (
    !item ||
    item.symbol !== symbol ||
    item.source_completeness !== 'unknown' ||
    item.historical_coverage !== null ||
    !item.integrity
  )
    return false
  if (item.integrity.available === false)
    return !detail || (item.payload === null && item.payload_json === null)
  if (
    item.integrity.available !== true ||
    !Number.isInteger(item.revision) ||
    item.revision! < 1 ||
    !fingerprint(item.fingerprint) ||
    item.evidence_engine_version !== 'alphaview-corporate-action-evidence-v1' ||
    !Number.isInteger(item.saved_event_count) ||
    item.saved_event_count! < 0 ||
    item.saved_event_count! > 1600
  )
    return false
  if (!detail) return true
  const payload = item.payload
  if (
    !payload ||
    typeof item.payload_json !== 'string' ||
    payload.engine_version !== item.evidence_engine_version ||
    payload.source_completeness !== 'unknown' ||
    !Array.isArray(payload.events) ||
    payload.events.length !== item.saved_event_count ||
    !payload.events.every(eventValid) ||
    new Set(payload.events.map((event) => `${event.ex_date}:${event.kind}`)).size !==
      payload.events.length
  )
    return false
  try {
    workflowEvidenceJson(payload, item.payload_json)
    return true
  } catch {
    return false
  }
}
function Cell({ event, t }: { event: Event | null; t: Translate }) {
  return event ? (
    <div>
      <code>{event.raw_value === null ? '—' : event.raw_value}</code>
      <small>
        {event.raw_type} · {t('數值', 'Numeric value')}:{' '}
        {event.value === null ? '—' : String(event.value)}
      </small>
      {event.reason && <small>{event.reason}</small>}
    </div>
  ) : (
    <span>
      {t(
        '保存內容中缺少此事件；不是零或取消',
        'Absent from saved payload; not zero or cancellation',
      )}
    </span>
  )
}
function kindLabel(kind: Event['kind'], t: Translate) {
  return kind === 'cash_dividend' ? t('現金股息', 'Cash dividend') : t('拆併股', 'Stock split')
}
function changeLabel(code: string, t: Translate) {
  if (code === 'added') return t('新增於保存內容', 'Added to saved payload')
  if (code === 'removed_from_saved_payload')
    return t('從保存內容移除', 'Removed from saved payload')
  if (code === 'raw_type_changed') return t('原始型別改變', 'Raw type changed')
  return code === 'changed' ? t('保存欄位改變', 'Saved fields changed') : code
}
export function CorporateActionHistory(props: Props) {
  return <History key={`${props.accountId}:${props.enabled ?? true}`} {...props} />
}
function History({ accountId, enabled = true, t }: Props) {
  const [context, setContext] = useState<Context | null>(null)
  const [symbol, setSymbol] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const selectedItems = useRef(new Map<number, ActionRevision>())
  const [comparison, setComparison] = useState<{ value: ActionComparison; raw: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const accepted = useRef<{ detail: Detail | null; comparison: typeof comparison }>({
    detail: null,
    comparison: null,
  })
  const abort = () => {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
  }
  const clearEvidence = () => {
    accepted.current = { detail: null, comparison: null }
    setDetail(null)
    setComparison(null)
  }
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        abort()
        clearEvidence()
      }
    }
    const pagehide = () => {
      abort()
      clearEvidence()
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', pagehide)
    return () => {
      pending.current?.abort()
      accepted.current = { detail: null, comparison: null }
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [])
  const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/corporate-actions/history`
  const validBase = (value: Base, selectedSymbol?: string) =>
    value?.engine_version === VERSION &&
    value.account_id === accountId &&
    Number.isInteger(value.account_version) &&
    value.account_version > 0 &&
    value.source_completeness === 'unknown' &&
    value.historical_coverage === null &&
    (!selectedSymbol || value.symbol === selectedSymbol) &&
    (!context || value.account_version === context.account_version)
  async function request(
    kind: 'context' | 'list' | 'detail' | 'compare',
    revision = 0,
    offset = 0,
  ) {
    if (
      !enabled ||
      pending.current ||
      (kind !== 'context' && (!context || !symbol)) ||
      (kind === 'compare' && selected.length !== 2)
    )
      return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError('')
    clearEvidence()
    if (kind === 'context') {
      setContext(null)
      setListing(null)
      setSelected([])
      selectedItems.current.clear()
      setSymbol('')
    }
    try {
      const prefix = `${base}/${encodeURIComponent(symbol)}`
      let body: ActionComparison['request'] | undefined
      if (kind === 'compare') {
        const rows = selected.map((id) => selectedItems.current.get(id))
        if (!rows.every((item) => item?.integrity.available && fingerprint(item.fingerprint)))
          throw new Error('revision_selection_unavailable')
        body = {
          expected_account_version: context!.account_version,
          baseline_revision: selected[0],
          selected_revision: selected[1],
          expected_baseline_fingerprint: rows[0]!.fingerprint!,
          expected_selected_fingerprint: rows[1]!.fingerprint!,
        }
      }
      const response = await fetch(
        kind === 'context'
          ? `${base}/context`
          : kind === 'list'
            ? `${prefix}?limit=20&offset=${offset}`
            : kind === 'detail'
              ? `${prefix}/${revision}`
              : `${prefix}/compare`,
        {
          method: kind === 'compare' ? 'POST' : 'GET',
          cache: 'no-store',
          signal: controller.signal,
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        },
      )
      const raw = await response.text()
      const value = JSON.parse(raw)
      if (controller.signal.aborted) return
      if (!response.ok) {
        if (response.status === 409 || response.status === 404) {
          setContext(null)
          setListing(null)
          setSelected([])
          selectedItems.current.clear()
          setSymbol('')
        }
        throw new Error(
          typeof value?.detail?.code === 'string' ? value.detail.code : `HTTP ${response.status}`,
        )
      }
      if (kind === 'context') {
        if (
          value?.engine_version !== VERSION ||
          value.account_id !== accountId ||
          !Number.isInteger(value.account_version) ||
          value.account_version < 1 ||
          !Array.isArray(value.symbols) ||
          value.symbols.length > 100 ||
          value.source_completeness !== 'unknown' ||
          value.historical_coverage !== null ||
          value.symbols.some(
            (item: Context['symbols'][number]) =>
              typeof item.symbol !== 'string' || typeof item.available !== 'boolean',
          ) ||
          new Set(value.symbols.map((item: Context['symbols'][number]) => item.symbol)).size !==
            value.symbols.length
        )
          throw new Error('history_response_identity_mismatch')
        setContext(value)
      } else {
        if (!validBase(value, symbol)) throw new Error('history_response_identity_mismatch')
        if (kind === 'list') {
          const page = value as Listing
          if (
            !Array.isArray(page.items) ||
            page.items.length > 20 ||
            !page.items.every((item) => revisionValid(item, symbol)) ||
            page.pagination?.limit !== 20 ||
            page.pagination.offset !== offset ||
            page.pagination.returned !== page.items.length ||
            !Number.isInteger(page.pagination.total) ||
            page.pagination.total < offset + page.items.length
          )
            throw new Error('history_response_identity_mismatch')
          setListing(page)
        } else if (kind === 'detail') {
          if (
            !revisionValid(value.item, symbol, true) ||
            value.item.revision !== revision ||
            value.item.fingerprint !==
              listing?.items.find((item) => item.revision === revision)?.fingerprint
          )
            throw new Error('history_response_identity_mismatch')
          setDetail(value)
          accepted.current.detail = value
        } else {
          const result = value as ActionComparison
          if (
            !revisionValid(result.baseline, symbol, true) ||
            !revisionValid(result.selected, symbol, true) ||
            result.baseline.revision !== selected[0] ||
            result.selected.revision !== selected[1] ||
            result.baseline.fingerprint !== body!.expected_baseline_fingerprint ||
            result.selected.fingerprint !== body!.expected_selected_fingerprint ||
            Object.entries(body!).some(
              ([key, item]) => result.request?.[key as keyof typeof body] !== item,
            ) ||
            (result.status === 'compared'
              ? !result.baseline.integrity.available ||
                !result.selected.integrity.available ||
                !Array.isArray(result.changes) ||
                result.changes.length > 3200 ||
                result.change_count !== result.changes.length ||
                new Set(result.changes.map((row) => `${row.ex_date}:${row.kind}`)).size !==
                  result.changes.length ||
                result.changes.some(
                  (row) =>
                    (row.baseline === null && row.selected === null) ||
                    JSON.stringify(row.baseline) !==
                      JSON.stringify(
                        result.baseline.payload!.events.find(
                          (event) => event.ex_date === row.ex_date && event.kind === row.kind,
                        ) ?? null,
                      ) ||
                    JSON.stringify(row.selected) !==
                      JSON.stringify(
                        result.selected.payload!.events.find(
                          (event) => event.ex_date === row.ex_date && event.kind === row.kind,
                        ) ?? null,
                      ) ||
                    (row.baseline !== null && !eventValid(row.baseline)) ||
                    (row.selected !== null && !eventValid(row.selected)) ||
                    !Array.isArray(row.change_types) ||
                    row.change_types.some(
                      (code) =>
                        ![
                          'added',
                          'removed_from_saved_payload',
                          'changed',
                          'raw_type_changed',
                        ].includes(code),
                    ) ||
                    (row.numeric_delta !== null && !Number.isFinite(row.numeric_delta)),
                )
              : result.status !== 'unavailable' ||
                result.changes !== null ||
                result.change_count !== null)
          )
            throw new Error('history_response_identity_mismatch')
          const next = { value: result, raw }
          setComparison(next)
          accepted.current.comparison = next
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof Error && failure.message === 'history_response_identity_mismatch') {
          setContext(null)
          setListing(null)
          setSelected([])
          setSymbol('')
          selectedItems.current.clear()
        }
        setError(failure instanceof Error ? failure.message : 'history_unavailable')
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  function download(kind: 'payload' | 'comparison') {
    if (
      !enabled ||
      busy ||
      pending.current ||
      (kind === 'payload'
        ? !detail || accepted.current.detail !== detail || !detail.item.integrity.available
        : !comparison || accepted.current.comparison !== comparison)
    )
      return
    let url: string | null = null
    let anchor: HTMLAnchorElement | null = null
    try {
      const raw =
        kind === 'payload'
          ? workflowEvidenceJson(detail!.item.payload, detail!.item.payload_json!)
          : workflowEvidenceJson(comparison!.value, comparison!.raw)
      const safe = (value: string) =>
        value.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      const suffix =
        kind === 'payload'
          ? String(detail!.item.revision)
          : `${comparison!.value.baseline.revision}-vs-${comparison!.value.selected.revision}`
      url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `alphaview-corporate-history-${safe(accountId)}-${safe(symbol)}-${suffix}.json`
      document.body.appendChild(anchor)
      anchor.click()
    } catch {
      setError(t('公司行動歷史下載失敗', 'Corporate history download failed'))
    } finally {
      anchor?.remove()
      if (url) {
        const release = url
        window.setTimeout(() => URL.revokeObjectURL(release), 10000)
      }
    }
  }
  return (
    <section
      className="corporate-action-history"
      aria-label={t('公司行動保存版本', 'Saved corporate-action revisions')}
    >
      <h3>{t('公司行動保存版本', 'Saved corporate-action revisions')}</h3>
      <p>
        {t(
          '只比較目前持有標的的兩份保存內容；來源完整性與歷史擷取範圍一律未知。未保存某個事件不代表沒有發生、金額為零或事件取消。',
          'Compare two saved payloads for a currently held symbol only. Source completeness and historical capture windows are always unknown. An absent event does not mean it did not occur, had zero amount or was cancelled.',
        )}
      </p>
      <p>
        {t(
          '這不是權利確認、帳本調整或來源重抓；不改持股、現金、提案或委託。內容指紋不綁定標的或首次擷取時間，也不是數位簽章。',
          'This is not entitlement verification, a ledger adjustment or a source refresh. Holdings, cash, proposals and orders stay unchanged. Payload hashes do not bind symbol or first-fetch time and are not digital signatures.',
        )}
      </p>
      <button type="button" disabled={!enabled || busy} onClick={() => void request('context')}>
        {t('載入持有標的範圍', 'Load held-symbol scope')}
      </button>
      {busy && <p role="status">{t('正在讀取保存證據…', 'Reading saved evidence…')}</p>}
      {error && (
        <p role="alert">
          {t(
            '歷史證據操作未完成，請重新載入範圍。',
            'History evidence action did not complete. Reload the scope.',
          )}{' '}
          {error}
        </p>
      )}
      {context && (
        <div className="corporate-history-controls">
          {!context.symbols.length ? (
            <p>{t('目前沒有可查閱的持有標的。', 'No currently held symbols to inspect.')}</p>
          ) : (
            <>
              <label>
                {t('持有標的', 'Held symbol')}
                <select
                  value={symbol}
                  disabled={busy || !enabled}
                  onChange={(event) => {
                    abort()
                    clearEvidence()
                    setListing(null)
                    setSelected([])
                    selectedItems.current.clear()
                    setError('')
                    setSymbol(event.target.value)
                  }}
                >
                  <option value="">{t('選擇標的', 'Select a symbol')}</option>
                  {context.symbols.map((item) => (
                    <option key={item.symbol} value={item.symbol} disabled={!item.available}>
                      {item.symbol}
                      {item.available ? '' : ` · ${item.reason}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!enabled || busy || !symbol}
                onClick={() => void request('list')}
              >
                {t('載入保存版本', 'Load saved revisions')}
              </button>
            </>
          )}
        </div>
      )}
      {listing && (
        <div>
          <p>
            {t('保存版本數', 'Saved revision count')}: {listing.pagination.total} ·{' '}
            {t(
              '同樣內容的再次擷取不會新增版本；這不是擷取次數。',
              'Repeated captures of identical content do not add revisions; this is not a fetch count.',
            )}
          </p>
          {!listing.items.length && (
            <p>
              {t(
                '尚無保存內容；來源事件仍未知。',
                'No saved payloads; source events remain unknown.',
              )}
            </p>
          )}
          <div className="corporate-history-list">
            {listing.items.map((item, index) => (
              <article key={`${item.revision}:${index}`}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${t('選取版本', 'Select revision')} ${item.revision ?? '—'}`}
                    checked={item.revision !== null && selected.includes(item.revision)}
                    disabled={
                      !enabled ||
                      busy ||
                      !item.integrity.available ||
                      (selected.length >= 2 && !selected.includes(item.revision!))
                    }
                    onChange={(event) => {
                      clearEvidence()
                      if (event.target.checked) selectedItems.current.set(item.revision!, item)
                      else selectedItems.current.delete(item.revision!)
                      setSelected(
                        event.target.checked
                          ? [...selected, item.revision!]
                          : selected.filter((revision) => revision !== item.revision),
                      )
                    }}
                  />
                  v{item.revision ?? '—'}
                </label>
                <span>{item.first_fetched_at ?? '—'}</span>
                <span>
                  {item.integrity.available
                    ? `${t('保存事件列', 'Saved event rows')}: ${item.saved_event_count}`
                    : `${t('證據不可用', 'Evidence unavailable')}: ${item.integrity.reason}`}
                </span>
                <button
                  type="button"
                  disabled={!enabled || busy || item.revision === null}
                  onClick={() => void request('detail', item.revision!)}
                >
                  {t('檢視版本', 'Inspect revision')} {item.revision ?? '—'}
                </button>
              </article>
            ))}
          </div>
          <p>
            {t(
              '依勾選順序：第一份為基準，第二份為比較對象。',
              'Selection order: first is the baseline; second is the comparison.',
            )}
            {selected.length > 0 && ` ${selected.map((revision) => `v${revision}`).join(' → ')}`}
          </p>
          <div className="corporate-history-controls">
            <button
              type="button"
              disabled={!enabled || busy || selected.length !== 2}
              onClick={() => void request('compare')}
            >
              {t('比較兩份保存內容', 'Compare two saved payloads')}
            </button>
            <button
              type="button"
              disabled={!enabled || busy || selected.length === 0}
              onClick={() => {
                clearEvidence()
                selectedItems.current.clear()
                setSelected([])
              }}
            >
              {t('清除版本選取', 'Clear revision selection')}
            </button>
            <button
              type="button"
              disabled={!enabled || busy || listing.pagination.offset === 0}
              onClick={() => void request('list', 0, listing.pagination.offset - 20)}
            >
              {t('上一頁', 'Previous page')}
            </button>
            <span>
              {listing.pagination.offset + (listing.items.length ? 1 : 0)}–
              {listing.pagination.offset + listing.items.length} / {listing.pagination.total}
            </span>
            <button
              type="button"
              disabled={
                !enabled ||
                busy ||
                listing.pagination.offset >= 5000 ||
                listing.pagination.offset + listing.items.length >= listing.pagination.total
              }
              onClick={() => void request('list', 0, listing.pagination.offset + 20)}
            >
              {t('下一頁', 'Next page')}
            </button>
          </div>
          {listing.pagination.offset >= 5000 && listing.pagination.total > 5020 && (
            <p>
              {t(
                '已到查閱上限；更早版本未列出。',
                'Browsing limit reached; earlier revisions are not listed.',
              )}
            </p>
          )}
        </div>
      )}
      {detail && (
        <div className="corporate-history-detail">
          <h4>
            {t('保存內容', 'Saved payload')} · {symbol} v{detail.item.revision}
          </h4>
          {!detail.item.integrity.available || !detail.item.payload ? (
            <p role="status">
              {t('證據不可用', 'Evidence unavailable')}: {detail.item.integrity.reason}
            </p>
          ) : (
            <>
              <p>
                {detail.item.evidence_engine_version} · {detail.item.adapter_version}
              </p>
              <p>
                <code>{detail.item.fingerprint}</code>
              </p>
              <button type="button" disabled={!enabled || busy} onClick={() => download('payload')}>
                {t('下載此版本原始保存 JSON', 'Download this revision’s stored JSON')}
              </button>
              <p>
                {t(
                  '歷史覆蓋範圍未知；以下只列保存事件。',
                  'Historical coverage is unknown; only saved events are listed below.',
                )}
              </p>
              <div
                className="corporate-history-table"
                tabIndex={0}
                role="region"
                aria-label={t('保存事件明細', 'Saved event details')}
              >
                <table>
                  <thead>
                    <tr>
                      <th>{t('事件日期', 'Event date')}</th>
                      <th>{t('種類', 'Kind')}</th>
                      <th>{t('原始儲存格／數值', 'Raw cell / numeric value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.item.payload.events.map((event) => (
                      <tr key={`${event.ex_date}:${event.kind}`}>
                        <td>{event.ex_date}</td>
                        <td>{kindLabel(event.kind, t)}</td>
                        <td>
                          <Cell event={event} t={t} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      {comparison && (
        <div className="corporate-history-detail">
          <h4>
            {t('保存內容差異', 'Saved payload differences')} · v{comparison.value.baseline.revision}{' '}
            → v{comparison.value.selected.revision}
          </h4>
          <p>
            {t('基準／比較轉接器版本', 'Baseline / selected adapter version')}:{' '}
            {comparison.value.baseline.adapter_version ?? '—'} /{' '}
            {comparison.value.selected.adapter_version ?? '—'}
          </p>
          <button type="button" disabled={!enabled || busy} onClick={() => download('comparison')}>
            {t('下載此比較證據 JSON', 'Download this comparison evidence JSON')}
          </button>
          {comparison.value.changes === null ? (
            <p role="status">{comparison.value.reason}</p>
          ) : (
            <>
              <p>
                {t('保存事件差異列', 'Changed saved event rows')}: {comparison.value.change_count}
              </p>
              {comparison.value.changes.length === 0 && (
                <p>
                  {t(
                    '事件儲存格沒有差異；不代表來源完整或沒有其他事件。',
                    'Event cells do not differ; this does not establish complete coverage or absence of other events.',
                  )}
                </p>
              )}
              <div
                className="corporate-history-table"
                tabIndex={0}
                role="region"
                aria-label={t('版本差異明細', 'Revision difference details')}
              >
                <table>
                  <thead>
                    <tr>
                      <th>{t('事件日期／種類', 'Event date / kind')}</th>
                      <th>{t('差異類別', 'Change category')}</th>
                      <th>{t('基準保存值', 'Baseline saved cell')}</th>
                      <th>{t('比較保存值', 'Selected saved cell')}</th>
                      <th>{t('相容數值差／原因', 'Compatible numeric delta / reason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.value.changes.map((row) => (
                      <tr key={`${row.ex_date}:${row.kind}`}>
                        <td>
                          {row.ex_date} · {kindLabel(row.kind, t)}
                        </td>
                        <td>{row.change_types.map((code) => changeLabel(code, t)).join(' · ')}</td>
                        <td>
                          <Cell event={row.baseline} t={t} />
                        </td>
                        <td>
                          <Cell event={row.selected} t={t} />
                        </td>
                        <td>
                          {row.numeric_delta === null ? '—' : String(row.numeric_delta)}
                          {row.numeric_delta_reason && <small>{row.numeric_delta_reason}</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
