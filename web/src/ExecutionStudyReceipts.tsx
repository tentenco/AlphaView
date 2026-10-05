import { useEffect, useRef, useState } from 'react'
import { workflowEvidenceJson } from './workflow-evidence-json'
import { ExecutionStudyReceiptComparison } from './ExecutionStudyReceiptComparison'
import './ExecutionStudyReceipts.css'

type Translate = (zh: string, en: string) => string
export type ExecutionStudyKind = 'volume_day' | 'limit_day' | 'open_gtd'
export type ExecutionStudyReceiptRequest = {
  expected_account_version: number
  expected_input_revision: string
  expected_as_of: string
  expected_proposal_fingerprint: string
  participation_pct: number
  limits?: { symbol: string; limit_price: number }[]
  gtd_date?: string
}
type Evidence = {
  engine_version: string
  account_id: string
  account_version: number
  input_revision: string
  as_of: string
  mode: string
  status: string
  request: ExecutionStudyReceiptRequest
  source: { id: string; account_id: string; proposal_fingerprint: string; current: boolean }
  coverage: Record<string, unknown>
  orders: unknown[]
}
type Receipt = {
  id: string
  account_id: string
  proposal_id: string
  kind: ExecutionStudyKind
  created_at: string
  engine_version: string
  content_fingerprint: string
  raw_evidence_sha256: string | null
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
  as_of: string | null
  status: string | null
  coverage: Record<string, unknown> | null
  source_proposal_current: boolean | null
  replayed?: boolean
  receipt?: {
    engine_version: string
    receipt_id: string
    kind: ExecutionStudyKind
    created_at: string
    request: ExecutionStudyReceiptRequest
    account_context: { account_id: string; version: number }
    source_context: { raw_evidence_sha256: string; proposal_fingerprint: string }
    evidence: Evidence
    policy: { advisory_only: boolean; execution_source: boolean; gating_authority: boolean }
    method: string
  } | null
}
type History = {
  account_id: string
  proposal_id: string
  kind: ExecutionStudyKind
  items: Receipt[]
  pagination: { limit: number; offset: number; total: number; returned: number }
  checked_as_of: string
  checked_input_revision: string
}
type LoadedHistory = Omit<History, 'pagination'> & { total: number }
type IntegrityFilter = 'all' | 'verified' | 'unavailable'
const historyPageSize = 10
const methods = {
  volume_day: 'alphaview-execution-volume-study-v1',
  limit_day: 'alphaview-execution-limit-study-v1',
  open_gtd: 'alphaview-execution-gtd-study-v1',
}
const idPattern = /^[a-f0-9]{32}$/
const hashPattern = /^[a-f0-9]{64}$/
const maxBytes = 2097152
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  )
}
async function sha(raw: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function checked(response: Response) {
  if (!response.ok) {
    const value = await response.json().catch(() => null)
    throw new Error(value?.detail?.code ?? `HTTP ${response.status}`)
  }
  return response
}
function acceptedEvidence(
  evidence: unknown,
  raw: string | null,
  request: ExecutionStudyReceiptRequest | null,
  account: string,
  proposal: string,
  version: number,
  kind: ExecutionStudyKind,
): evidence is Evidence {
  try {
    if (!raw || !request || new TextEncoder().encode(raw).length > maxBytes) return false
    workflowEvidenceJson(evidence, raw)
    const value = evidence as Evidence
    return (
      value.engine_version === methods[kind] &&
      value.account_id === account &&
      value.account_version === version &&
      request.expected_account_version === version &&
      value.source.id === proposal &&
      value.source.account_id === account &&
      value.source.proposal_fingerprint === request.expected_proposal_fingerprint &&
      value.input_revision === request.expected_input_revision &&
      value.as_of === request.expected_as_of &&
      value.mode === 'advisory_ex_post' &&
      ['complete', 'incomplete', 'unavailable'].includes(value.status) &&
      Array.isArray(value.orders) &&
      !!value.coverage &&
      same(value.request, request)
    )
  } catch {
    return false
  }
}

export function ExecutionStudyReceipts({
  kind,
  accountId,
  proposalId,
  accountVersion,
  request = null,
  evidence = null,
  rawEvidence = null,
  enabled = true,
  t,
}: {
  kind: ExecutionStudyKind
  accountId: string
  proposalId: string
  accountVersion: number
  request?: ExecutionStudyReceiptRequest | null
  evidence?: unknown
  rawEvidence?: string | null
  enabled?: boolean
  t: Translate
}) {
  const identity = JSON.stringify([
    kind,
    accountId,
    proposalId,
    accountVersion,
    request,
    evidence,
    rawEvidence,
    enabled,
  ])
  const latest = useRef(identity)
  latest.current = identity
  const operation = useRef<AbortController | null>(null)
  const downloads = useRef(new Map<string, number>())
  const [state, setState] = useState<{
    identity: string
    busy?: string
    error?: string
    notice?: string
    history?: LoadedHistory
    selected?: Receipt
  }>({ identity })
  const current = state.identity === identity ? state : null
  const [integrityFilter, setIntegrityFilter] = useState<IntegrityFilter>('all')
  const [receiptQuery, setReceiptQuery] = useState('')
  const [historyPage, setHistoryPage] = useState(0)
  const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/proposals/${encodeURIComponent(proposalId)}/study-receipts`
  const validScope = idPattern.test(accountId) && idPattern.test(proposalId)
  const bound = acceptedEvidence(
    evidence,
    rawEvidence,
    request,
    accountId,
    proposalId,
    accountVersion,
    kind,
  )
  const canSave = validScope && enabled && bound && !current?.busy
  useEffect(() => {
    setIntegrityFilter('all')
    setReceiptQuery('')
    setHistoryPage(0)
  }, [kind, accountId, proposalId])
  useEffect(() => setHistoryPage(0), [current?.history])
  useEffect(() => {
    setState({ identity })
    const hide = () => {
      operation.current?.abort()
      operation.current = null
      setState({ identity })
    }
    window.addEventListener('pagehide', hide)
    return () => {
      operation.current?.abort()
      operation.current = null
      window.removeEventListener('pagehide', hide)
    }
  }, [identity])
  useEffect(
    () => () => {
      for (const [url, timer] of downloads.current) {
        window.clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      downloads.current.clear()
    },
    [],
  )

  function validateItem(item: Receipt, detail = false) {
    if (
      !item ||
      item.account_id !== accountId ||
      item.proposal_id !== proposalId ||
      item.kind !== kind ||
      typeof item.integrity?.available !== 'boolean' ||
      !Array.isArray(item.currentness?.reasons) ||
      ![true, false, null].includes(item.currentness.current)
    )
      throw new Error('receipt_identity_mismatch')
    if (!item.integrity.available) {
      if (detail && item.receipt !== null) throw new Error('receipt_integrity_mismatch')
      return item
    }
    if (
      !hashPattern.test(item.id) ||
      !hashPattern.test(item.content_fingerprint) ||
      !hashPattern.test(item.raw_evidence_sha256 ?? '')
    )
      throw new Error('receipt_hash_missing')
    const payload = item.receipt
    if (
      detail &&
      (!payload ||
        payload.receipt_id !== item.id ||
        payload.kind !== kind ||
        payload.engine_version !== item.engine_version ||
        payload.created_at !== item.created_at ||
        payload.account_context.account_id !== accountId ||
        payload.evidence.account_id !== accountId ||
        payload.evidence.source.id !== proposalId ||
        payload.evidence.source.account_id !== accountId ||
        payload.source_context.raw_evidence_sha256 !== item.raw_evidence_sha256 ||
        payload.policy.advisory_only !== true ||
        payload.policy.execution_source !== false ||
        payload.policy.gating_authority !== false)
    )
      throw new Error('receipt_detail_mismatch')
    return item
  }
  async function act(
    action: string,
    work: (signal: AbortSignal) => Promise<Partial<typeof state>>,
  ) {
    if (!validScope || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setState((previous) => ({
      ...(previous.identity === identity ? previous : {}),
      identity,
      busy: action,
      error: undefined,
      notice: undefined,
    }))
    try {
      const update = await work(controller.signal)
      if (!controller.signal.aborted && latest.current === identity)
        setState((previous) => ({ ...previous, ...update, identity, busy: undefined }))
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity)
        setState((previous) => ({
          ...previous,
          identity,
          busy: undefined,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  function history() {
    void act('history', async (signal) => {
      let first: History | undefined
      const items: Receipt[] = []
      do {
        if (signal.aborted || latest.current !== identity) return {}
        const offset = items.length
        const response = await checked(
          await fetch(`${base}?kind=${kind}&limit=20&offset=${offset}`, { signal }),
        )
        const value: History = await response.json()
        const page = value.pagination
        if (
          value.account_id !== accountId ||
          value.proposal_id !== proposalId ||
          value.kind !== kind ||
          !Array.isArray(value.items) ||
          !page ||
          page.limit !== 20 ||
          page.offset !== offset ||
          !Number.isInteger(page.total) ||
          page.total < 0 ||
          page.total > 50 ||
          page.returned !== value.items.length ||
          value.items.length !== Math.min(20, page.total - offset) ||
          typeof value.checked_as_of !== 'string' ||
          !value.checked_as_of ||
          typeof value.checked_input_revision !== 'string' ||
          !value.checked_input_revision
        )
          throw new Error('receipt_history_mismatch')
        if (
          first &&
          (page.total !== first.pagination.total ||
            value.checked_as_of !== first.checked_as_of ||
            value.checked_input_revision !== first.checked_input_revision)
        )
          throw new Error('receipt_history_context_changed')
        value.items.forEach((item) => validateItem(item))
        items.push(...value.items)
        if (new Set(items.map((item) => item.id)).size !== items.length)
          throw new Error('receipt_history_mismatch')
        first ??= value
      } while (items.length < first.pagination.total)
      return {
        history: {
          account_id: first.account_id,
          proposal_id: first.proposal_id,
          kind: first.kind,
          checked_as_of: first.checked_as_of,
          checked_input_revision: first.checked_input_revision,
          items,
          total: first.pagination.total,
        },
        selected: undefined,
      }
    })
  }
  function save() {
    if (!canSave || !request || !rawEvidence || !bound) return
    void act('save', async (signal) => {
      const fingerprint = await sha(rawEvidence)
      if (signal.aborted || latest.current !== identity) return {}
      const response = await checked(
        await fetch(base, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            request,
            expected_evidence_engine_version: (evidence as Evidence).engine_version,
            expected_raw_evidence_sha256: fingerprint,
          }),
        }),
      )
      const item = validateItem(await response.json(), true)
      if (
        !item.integrity.available ||
        item.raw_evidence_sha256 !== fingerprint ||
        !same(item.receipt?.evidence, evidence)
      )
        throw new Error('receipt_saved_evidence_mismatch')
      return {
        selected: item,
        history: undefined,
        notice: item.replayed
          ? t('已讀取相同的原始回條', 'Replayed the same original receipt')
          : t('研究回條已保存', 'Research receipt saved'),
      }
    })
  }
  function detail(item: Receipt) {
    if (!item.integrity.available || !hashPattern.test(item.id)) return
    void act('detail', async (signal) => {
      const value = validateItem(
        await (await checked(await fetch(`${base}/${item.id}`, { signal }))).json(),
        true,
      )
      if (value.id !== item.id || value.content_fingerprint !== item.content_fingerprint)
        throw new Error('receipt_selection_changed')
      return { selected: value }
    })
  }
  function download(item: Receipt, original: boolean) {
    if (!item.integrity.available || !item.receipt) return
    const payload = item.receipt
    void act('download', async (signal) => {
      const response = await checked(
        await fetch(
          `${base}/${item.id}/${original ? 'evidence' : 'receipt'}.json?expected_content_fingerprint=${item.content_fingerprint}`,
          { signal },
        ),
      )
      const raw = await response.text()
      if (new TextEncoder().encode(raw).length > maxBytes) throw new Error('receipt_size_limit')
      const hash = await sha(raw)
      if (
        hash !== (original ? item.raw_evidence_sha256 : item.content_fingerprint) ||
        response.headers.get('etag') !== `"${hash}"` ||
        response.headers.get('x-receipt-fingerprint') !== item.content_fingerprint
      )
        throw new Error('receipt_download_hash_mismatch')
      workflowEvidenceJson(original ? payload.evidence : payload, raw)
      if (signal.aborted || latest.current !== identity) return {}
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `alphaview-study-${kind}-${accountId.slice(0, 8)}-${proposalId.slice(0, 8)}-${item.id.slice(0, 16)}-${original ? 'evidence' : 'receipt'}.json`
      document.body.appendChild(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
        downloads.current.set(
          url,
          window.setTimeout(() => {
            URL.revokeObjectURL(url)
            downloads.current.delete(url)
          }, 10000),
        )
      }
      return {}
    })
  }
  const freshness = (item: Receipt) =>
    !item.integrity.available
      ? t('回條無法驗證', 'Receipt cannot be verified')
      : item.currentness.current === true
        ? t('讀取時研究來源相符', 'Study sources matched when read')
        : item.currentness.current === false
          ? t('歷史研究來源已變更', 'Historical study sources changed')
          : t('目前來源無法核對', 'Current sources cannot be checked')
  const selected = current?.selected
  const loaded = current?.history
  const allItems = loaded?.items ?? []
  const normalizedQuery = receiptQuery.trim().toLowerCase()
  const filteredItems = allItems.filter(
    (item) =>
      (integrityFilter === 'all' ||
        item.integrity.available === (integrityFilter === 'verified')) &&
      (typeof item.id === 'string' ? item.id.toLowerCase() : '').includes(normalizedQuery),
  )
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / historyPageSize))
  const page = Math.min(historyPage, pageCount - 1)
  const firstVisible = page * historyPageSize
  const visibleItems = filteredItems.slice(firstVisible, firstVisible + historyPageSize)
  const verifiedCount = allItems.filter((item) => item.integrity.available).length
  const unknownCurrentnessCount = allItems.filter(
    (item) => item.currentness.current === null,
  ).length
  return (
    <section
      className="execution-study-receipts"
      aria-label={t('執行研究回條', 'Execution study receipts')}
    >
      <h5>{t('執行研究回條', 'Execution study receipts')}</h5>
      <p className="research-note">
        {t(
          '保存當時完整研究與缺值；不是成交、委託授權或提案就緒證明。舊訊號提案與研究讀取時的來源狀態分開標示。',
          'Keep the full study and its gaps as observed. This is not a fill, order authorization or proposal eligibility proof. Signal-date proposal status is separate from study source currentness.',
        )}
      </p>
      <div className="execution-study-receipts-actions">
        <button type="button" disabled={!canSave} onClick={save}>
          {current?.busy === 'save'
            ? t('保存中…', 'Saving…')
            : t('保存研究回條', 'Save study receipt')}
        </button>
        <button type="button" disabled={!validScope || !!current?.busy} onClick={() => history()}>
          {t('讀取研究回條', 'Load study receipts')}
        </button>
      </div>
      {!canSave && !current?.busy && (
        <p className="research-note">
          {t(
            '需有目前來源相符、尚未變更的完整原始研究回應，才可新增回條；歷史回條仍可讀取。',
            'A full original study response bound to the current context is required for a new receipt. Historical receipts can still be read.',
          )}
        </p>
      )}
      {current?.busy && <p role="status">{t('處理研究回條中…', 'Processing study receipt…')}</p>}
      {current?.error && (
        <p role="alert">
          {t('回條操作未完成：', 'Receipt action did not complete: ')}
          {current.error}
        </p>
      )}
      {current?.notice && <p role="status">{current.notice}</p>}
      {loaded && (
        <>
          <dl
            className="execution-study-history-totals"
            aria-label={t('完整研究歷史摘要', 'Full study history totals')}
          >
            <div>
              <dt>{t('完整歷史筆數', 'Full history count')}</dt>
              <dd>{loaded.total}</dd>
            </div>
            <div>
              <dt>{t('可驗證回條', 'Verified receipts')}</dt>
              <dd>{verifiedCount}</dd>
            </div>
            <div>
              <dt>{t('完整性不可用', 'Integrity unavailable')}</dt>
              <dd>{allItems.length - verifiedCount}</dd>
            </div>
            <div>
              <dt>{t('來源狀態未知（全歷史）', 'Unknown currentness (full history)')}</dt>
              <dd>{unknownCurrentnessCount}</dd>
            </div>
          </dl>
          <p className="research-note">
            {t(
              '可驗證不表示目前可執行；搜尋、篩選與分頁只改變清單，不改變來源狀態。',
              'Verified integrity does not establish current execution eligibility. Search, filters and paging only change the list, not source currentness.',
            )}
          </p>
          <div className="execution-study-history-controls">
            <label>
              {t('回條完整性篩選', 'Receipt integrity filter')}
              <select
                value={integrityFilter}
                onChange={(event) => {
                  setIntegrityFilter(event.target.value as IntegrityFilter)
                  setHistoryPage(0)
                }}
              >
                <option value="all">{t('全部回條', 'All receipts')}</option>
                <option value="verified">{t('可驗證回條', 'Verified receipts')}</option>
                <option value="unavailable">{t('完整性不可用', 'Integrity unavailable')}</option>
              </select>
            </label>
            <label>
              {t('搜尋回條 ID', 'Search receipt ID')}
              <input
                type="search"
                value={receiptQuery}
                onChange={(event) => {
                  setReceiptQuery(event.target.value)
                  setHistoryPage(0)
                }}
              />
            </label>
          </div>
          <p role="status">
            {t('篩選符合', 'Matching filters')}: {filteredItems.length} / {loaded.total} ·{' '}
            {t('顯示', 'Showing')} {filteredItems.length ? firstVisible + 1 : 0}–
            {firstVisible + visibleItems.length} · {t('每頁最多 10 筆', 'At most 10 per page')}
          </p>
          {!allItems.length && (
            <p>{t('此提案尚無這類研究回條', 'This proposal has no receipts of this study kind')}</p>
          )}
          {!!allItems.length && !filteredItems.length && (
            <p>
              {t(
                '沒有符合目前篩選與搜尋的回條；完整歷史與已選證據仍保留。',
                'No receipts match the current filters and search; full history and selected evidence are retained.',
              )}
            </p>
          )}
          <ul
            className="execution-study-receipts-list"
            aria-label={t('篩選後研究回條', 'Filtered study receipts')}
          >
            {visibleItems.map((item, index) => (
              <li key={item.id || index}>
                <span className="execution-study-history-id">
                  {t('回條 ID', 'Receipt ID')}:{' '}
                  <code>{typeof item.id === 'string' && item.id ? item.id : '—'}</code>
                </span>
                <span>
                  {item.created_at || '—'} · {item.status ?? '—'} · {freshness(item)}
                </span>
                {!item.integrity.available && <span>{item.integrity.reason ?? '—'}</span>}
                <button
                  type="button"
                  disabled={!!current?.busy || !item.integrity.available}
                  onClick={() => detail(item)}
                >
                  {t('檢閱研究回條', 'Review study receipt')}
                </button>
              </li>
            ))}
          </ul>
          <div
            className="execution-study-receipts-actions"
            role="group"
            aria-label={t('研究回條清單分頁', 'Study receipt list pagination')}
          >
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setHistoryPage(Math.max(0, page - 1))}
            >
              {t('上一頁', 'Previous')}
            </button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setHistoryPage(page + 1)}
            >
              {t('下一頁', 'Next')}
            </button>
          </div>
        </>
      )}
      {current?.history && (
        <ExecutionStudyReceiptComparison
          accountId={accountId}
          proposalId={proposalId}
          accountVersion={accountVersion}
          kind={kind}
          receipts={current.history.items}
          total={current.history.total}
          enabled={!current.busy}
          t={t}
        />
      )}
      {selected && (
        <div className="execution-study-receipt-detail">
          <h6>{t('保存當時的研究', 'Study as saved')}</h6>
          <p>
            {freshness(selected)} · {selected.as_of ?? '—'} · {selected.status ?? '—'}
          </p>
          {!!selected.currentness.reasons.length && (
            <p>{selected.currentness.reasons.join(' · ')}</p>
          )}
          <p>
            {t('原訊號提案在研究當時：', 'Signal-date proposal when studied: ')}
            {selected.source_proposal_current === true
              ? t('來源相符', 'Sources matched')
              : selected.source_proposal_current === false
                ? t('歷史提案', 'Historical proposal')
                : '—'}
          </p>
          <dl>
            <dt>{t('完整回條指紋', 'Complete receipt fingerprint')}</dt>
            <dd>
              <code>{selected.content_fingerprint}</code>
            </dd>
            <dt>{t('原始研究 JSON 指紋', 'Original study JSON fingerprint')}</dt>
            <dd>
              <code>{selected.raw_evidence_sha256 ?? '—'}</code>
            </dd>
          </dl>
          {selected.integrity.available && selected.receipt && (
            <>
              <div className="execution-study-receipts-actions">
                <button
                  type="button"
                  disabled={!!current?.busy}
                  onClick={() => download(selected, true)}
                >
                  {t('下載原始研究 JSON', 'Download original study JSON')}
                </button>
                <button
                  type="button"
                  disabled={!!current?.busy}
                  onClick={() => download(selected, false)}
                >
                  {t('下載完整回條 JSON', 'Download complete receipt JSON')}
                </button>
              </div>
              <details>
                <summary>
                  {t(
                    '檢閱保存的設定、覆蓋與逐筆證據',
                    'Review saved settings, coverage and per-order evidence',
                  )}
                </summary>
                <p className="research-note">
                  {t(
                    '下方是保存值的閱讀表示；下載保留伺服器原始 JSON 位元組。',
                    'The view below is a readable representation of saved values; downloads preserve original server JSON bytes.',
                  )}
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      request: selected.receipt.request,
                      coverage: selected.receipt.evidence.coverage,
                      orders: selected.receipt.evidence.orders,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </div>
      )}
      <p className="research-note">
        {t(
          '每帳戶最多 50 份、工作區 250 份，每份 2 MiB；不自動刪除、不匯入、不覆寫。',
          'Up to 50 per account and 250 per workspace, 2 MiB each; no automatic deletion, import or overwrite.',
        )}
      </p>
    </section>
  )
}
