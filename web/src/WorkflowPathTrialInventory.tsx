import { useEffect, useId, useRef, useState } from 'react'
import { workflowEvidenceJson } from './workflow-evidence-json'
import './workflow-path-trial-inventory.css'

type Translate = (zh: string, en: string) => string
type Category = 'comparable_path' | 'unavailable_path' | 'cost_receipt' | 'unknown_receipt'
type Currentness = { current: boolean | null; reasons: string[] }
type Configuration = Record<string, unknown>
export type InventoryRecord = {
  ordinal: number
  id: string | null
  account_id: string | null
  run_id: string | null
  kind: string | null
  created_at: string | null
  content_fingerprint: string | null
  integrity: { available: boolean; reason: string | null }
  category: Category
  diagnostic_status: string | null
  currentness: Currentness
  reasons: string[]
  basis_fingerprint: string | null
  configuration_fingerprint: string | null
  configuration: Configuration | null
  coverage: Record<string, unknown> | null
  identity_cells: Record<string, unknown>
}
type Group = {
  basis_fingerprint: string
  basis: Record<string, unknown>
  receipt_ids: string[]
  receipt_count: number
  distinct_configurations: number
  duplicate_configuration_groups: number
  duplicate_receipts_extra: number
  configurations: {
    configuration_fingerprint: string
    configuration: Configuration
    receipt_ids: string[]
    multiplicity: number
  }[]
}
export type PathTrialInventory = {
  engine_version: string
  account_id: string
  account_version: number
  scope: 'saved_receipts_only'
  unrecorded_trials: null
  full_search_denominator: null
  full_search_coverage: 'unknown'
  policy: {
    read_only: true
    saved_receipts_only: true
    execution_authority: false
    automatic_cscv_selection: false
    reconstruction: false
  }
  coverage: {
    complete_set: true
    account_receipts: number
    returned_receipts: number
    path_receipts: number
    cost_receipts: number
    unknown_kind_receipts: number
    verified_receipts: number
    unverifiable_receipts: number
    basis_available_path_receipts: number
    basis_unavailable_path_receipts: number
    basis_groups: number
    configurations_within_groups: number
    duplicate_configuration_groups: number
    duplicate_receipts_extra: number
  }
  records: InventoryRecord[]
  groups: Group[]
  checked_as_of: string
  checked_input_revision: string
  checked_at: string
  inventory_fingerprint: string
  method: string
}
const VERSION = 'alphaview-workflow-path-trial-inventory-v1'
const MAX_BYTES = 3 * 1024 * 1024
const PAGE_SIZE = 25
const hash = /^[a-f0-9]{64}$/
const categories: Category[] = [
  'comparable_path',
  'unavailable_path',
  'cost_receipt',
  'unknown_receipt',
]
const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const nullableText = (value: unknown) => value === null || typeof value === 'string'
function valid(value: PathTrialInventory, account: string, version: number) {
  if (
    !value ||
    value.engine_version !== VERSION ||
    value.account_id !== account ||
    value.account_version !== version ||
    value.scope !== 'saved_receipts_only' ||
    value.unrecorded_trials !== null ||
    value.full_search_denominator !== null ||
    value.full_search_coverage !== 'unknown' ||
    !value.policy ||
    value.policy.read_only !== true ||
    value.policy.saved_receipts_only !== true ||
    value.policy.execution_authority !== false ||
    value.policy.automatic_cscv_selection !== false ||
    value.policy.reconstruction !== false ||
    !hash.test(value.inventory_fingerprint) ||
    typeof value.checked_as_of !== 'string' ||
    typeof value.checked_input_revision !== 'string' ||
    !Array.isArray(value.records) ||
    value.records.length > 50 ||
    !Array.isArray(value.groups) ||
    value.groups.length > 50 ||
    !value.coverage ||
    value.coverage.complete_set !== true
  )
    return false
  const c = value.coverage
  if (
    Object.entries(c).some(([key, item]) => key !== 'complete_set' && !integer(item)) ||
    c.account_receipts !== value.records.length ||
    c.returned_receipts !== value.records.length ||
    c.path_receipts + c.cost_receipts + c.unknown_kind_receipts !== c.account_receipts ||
    c.verified_receipts + c.unverifiable_receipts !== c.account_receipts ||
    c.basis_available_path_receipts + c.basis_unavailable_path_receipts !== c.path_receipts ||
    c.basis_groups !== value.groups.length
  )
    return false
  if (
    !value.records.every(
      (r, i) =>
        r &&
        r.ordinal === i + 1 &&
        nullableText(r.id) &&
        nullableText(r.run_id) &&
        nullableText(r.kind) &&
        nullableText(r.content_fingerprint) &&
        categories.includes(r.category) &&
        r.integrity &&
        typeof r.integrity.available === 'boolean' &&
        nullableText(r.integrity.reason) &&
        r.currentness &&
        [true, false, null].includes(r.currentness.current) &&
        strings(r.currentness.reasons) &&
        strings(r.reasons) &&
        nullableText(r.diagnostic_status) &&
        (r.basis_fingerprint === null || hash.test(r.basis_fingerprint)) &&
        (r.configuration_fingerprint === null || hash.test(r.configuration_fingerprint)) &&
        (r.category !== 'comparable_path' ||
          (r.integrity.available &&
            r.id &&
            hash.test(r.id) &&
            r.account_id === account &&
            r.basis_fingerprint &&
            r.configuration_fingerprint &&
            r.configuration)),
    )
  )
    return false
  const available = value.records.filter((r) => r.category === 'comparable_path')
  if (
    available.length !== c.basis_available_path_receipts ||
    value.records.filter((r) => r.integrity.available).length !== c.verified_receipts ||
    value.records.filter((r) => r.kind === 'path_validation').length !== c.path_receipts ||
    value.records.filter((r) => r.kind === 'path_costs').length !== c.cost_receipts
  )
    return false
  const allIds: string[] = []
  for (const group of value.groups) {
    if (
      !group ||
      !hash.test(group.basis_fingerprint) ||
      !strings(group.receipt_ids) ||
      group.receipt_ids.length !== group.receipt_count ||
      !Array.isArray(group.configurations) ||
      !group.configurations.length ||
      group.configurations.length !== group.distinct_configurations
    )
      return false
    const ids: string[] = []
    for (const configuration of group.configurations) {
      if (
        !configuration ||
        !hash.test(configuration.configuration_fingerprint) ||
        !strings(configuration.receipt_ids) ||
        !configuration.receipt_ids.length ||
        configuration.multiplicity !== configuration.receipt_ids.length ||
        !configuration.configuration
      )
        return false
      for (const id of configuration.receipt_ids) {
        if (
          !available.some(
            (r) =>
              r.id === id &&
              r.basis_fingerprint === group.basis_fingerprint &&
              r.configuration_fingerprint === configuration.configuration_fingerprint,
          )
        )
          return false
        ids.push(id)
      }
    }
    if (
      new Set(ids).size !== ids.length ||
      [...ids].sort().join() !== [...group.receipt_ids].sort().join() ||
      group.duplicate_configuration_groups !==
        group.configurations.filter((x) => x.multiplicity > 1).length ||
      group.duplicate_receipts_extra !== ids.length - group.configurations.length
    )
      return false
    allIds.push(...ids)
  }
  return (
    new Set(allIds).size === allIds.length &&
    allIds.length === available.length &&
    c.configurations_within_groups ===
      value.groups.reduce((sum, g) => sum + g.distinct_configurations, 0) &&
    c.duplicate_configuration_groups ===
      value.groups.reduce((sum, g) => sum + g.duplicate_configuration_groups, 0) &&
    c.duplicate_receipts_extra ===
      value.groups.reduce((sum, g) => sum + g.duplicate_receipts_extra, 0)
  )
}
const categoryName = (category: Category, t: Translate) =>
  ({
    comparable_path: t('可比較基礎完整的路徑', 'Paths with complete comparable basis'),
    unavailable_path: t('基礎不可用的路徑', 'Paths with unavailable basis'),
    cost_receipt: t('成本收據（不計為試驗）', 'Cost receipts (not trials)'),
    unknown_receipt: t('種類未知的收據', 'Unknown-kind receipts'),
  })[category]
const stateName = (value: Currentness, t: Translate) =>
  value.current === true
    ? t('本次讀取來源相符', 'Source matches at this read')
    : value.current === false
      ? t('歷史來源已不同', 'Historical source differs')
      : t('來源狀態未知', 'Source state unknown')
const reason = (code: string, t: Translate) =>
  ({
    inventory_receipt_count_limit: t(
      '帳戶或全域收據超過上限；未回傳部分清單。',
      'Account or global receipt limit exceeded; no partial inventory returned.',
    ),
    inventory_export_size_limit: t(
      '完整清單超過 3 MiB；未截短或提供部分下載。',
      'Complete inventory exceeds 3 MiB; no truncation or partial download.',
    ),
    inventory_identity_size_limit: t(
      '原始識別欄位超過大小限制；未省略該列。',
      'Original identity metadata exceeds the size limit; the row was not omitted.',
    ),
    inventory_original_size_limit: t(
      '原始收據超過大小限制，保留此列為不可用。',
      'Original receipt exceeds the size limit; this row remains unavailable.',
    ),
    inventory_observation_session_changed: t(
      '讀取期間交易日已變更，請重新載入。',
      'Completed session changed during the read; reload.',
    ),
    inventory_configuration_unavailable: t(
      '保存設定的必要欄位缺少或不支援。',
      'Required saved configuration fields are missing or unsupported.',
    ),
    cost_receipt_not_trial: t(
      '成本收據不計為試驗設定。',
      'Cost receipts are not trial configurations.',
    ),
    complete_coverage: t('原始路徑覆蓋不完整。', 'Original path coverage is incomplete.'),
    receipt_content_changed: t('原始收據指紋不符。', 'Original receipt fingerprint mismatch.'),
    archive_evidence_method_unsupported: t(
      '保存的方法版本不支援。',
      'Saved method version unsupported.',
    ),
  })[code] ?? code

export function WorkflowPathTrialInventory({
  accountId,
  accountVersion,
  enabled = true,
  t,
}: {
  accountId: string
  accountVersion: number
  enabled?: boolean
  t: Translate
}) {
  const id = useId()
  const key = JSON.stringify([accountId, accountVersion, enabled])
  const identity = useRef(key)
  identity.current = key
  const operation = useRef<AbortController | null>(null)
  const [accepted, setAccepted] = useState<{
    key: string
    value: PathTrialInventory
    raw: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [filter, setFilter] = useState<'all' | Category>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const result = accepted?.key === key ? accepted : null
  useEffect(() => {
    setAccepted(null)
    setError(null)
    setBusy(false)
    setFilter('all')
    setQuery('')
    setPage(0)
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [key])
  async function load() {
    if (!enabled || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setAccepted(null)
    setError(null)
    try {
      const response = await fetch(
        `/api/paper/accounts/${encodeURIComponent(accountId)}/workflow-path-trial-inventory`,
        { cache: 'no-store', signal: controller.signal },
      )
      const raw = await response.text()
      if (controller.signal.aborted || identity.current !== key) return
      if (!response.ok) {
        let code = ''
        try {
          code = JSON.parse(raw)?.detail?.code ?? ''
        } catch {
          code = ''
        }
        throw new Error(
          (code ? reason(code, t) : t('清單讀取失敗', 'Inventory read failed')) +
            ` (${response.status})`,
        )
      }
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
        throw new Error(reason('inventory_export_size_limit', t))
      const value = JSON.parse(raw) as PathTrialInventory
      workflowEvidenceJson(value, raw)
      if (!valid(value, accountId, accountVersion))
        throw new Error(
          t('清單帳戶、涵蓋或分組內容不符。', 'Inventory account, coverage or grouping mismatch.'),
        )
      setAccepted({ key, value, raw })
      setFilter('all')
      setQuery('')
      setPage(0)
    } catch (cause) {
      if (!controller.signal.aborted && identity.current === key)
        setError({ key, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(false)
      }
    }
  }
  function download() {
    if (!enabled || !result || busy || operation.current || result.key !== identity.current) return
    let url: string | null = null
    let anchor: HTMLAnchorElement | null = null
    try {
      url = URL.createObjectURL(
        new Blob([workflowEvidenceJson(result.value, result.raw)], {
          type: 'application/json;charset=utf-8',
        }),
      )
      anchor = document.createElement('a')
      anchor.href = url
      const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      anchor.download = `saved-path-trials-${safe(accountId)}-${safe(result.value.checked_as_of)}-${result.value.inventory_fingerprint.slice(0, 12)}.json`
      document.body.appendChild(anchor)
      anchor.click()
    } catch {
      setError({
        key,
        message: t('完整試驗清單無法下載。', 'Complete trial inventory could not be downloaded.'),
      })
    } finally {
      anchor?.remove()
      if (url) {
        const release = url
        window.setTimeout(() => URL.revokeObjectURL(release), 10000)
      }
    }
  }
  const value = result?.value
  const records = value?.records ?? []
  const matches = records.filter(
    (r) =>
      (filter === 'all' || r.category === filter) &&
      (!query ||
        [r.id, r.run_id, r.configuration_fingerprint, r.basis_fingerprint].some((v) =>
          v?.toLowerCase().includes(query.toLowerCase()),
        )),
  )
  const pages = Math.ceil(matches.length / PAGE_SIZE)
  const currentPage = Math.min(page, Math.max(0, pages - 1))
  const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  return (
    <section className="workflow-path-trial-inventory" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>{t('已保存路徑試驗清單', 'Saved path trial inventory')}</h4>
      <p className="research-note">
        {t(
          '只盤點此帳戶已保存的收據；未保存或已捨棄的試驗數與完整搜尋分母未知。這不是事前登錄、完整實驗登錄或完整搜尋 PBO。',
          'Inventories only this account’s saved receipts. Unrecorded or discarded trials and the full-search denominator are unknown. This is not preregistration, a full experiment registry or complete-search PBO.',
        )}
      </p>
      <div className="trial-inventory-actions">
        <button type="button" disabled={!enabled || busy} onClick={() => void load()}>
          {t('載入完整已保存試驗清單', 'Load complete saved trial inventory')}
        </button>
        <button type="button" disabled={!enabled || busy || !result} onClick={download}>
          {t('下載完整試驗清單 JSON', 'Download complete trial inventory JSON')}
        </button>
      </div>
      {busy && <p role="status">{t('正在讀取所有保存收據…', 'Reading all saved receipts…')}</p>}
      {error?.key === key && <p role="alert">{error.message}</p>}
      {value && (
        <>
          <div
            className="trial-inventory-coverage"
            aria-label={t('完整清單涵蓋', 'Full inventory coverage')}
          >
            <p>
              {t('全部收據', 'All receipts')} {value.coverage.returned_receipts} /{' '}
              {value.coverage.account_receipts} · {t('路徑收據', 'Path receipts')}{' '}
              {value.coverage.path_receipts} · {t('成本收據', 'Cost receipts')}{' '}
              {value.coverage.cost_receipts} · {t('種類未知', 'Unknown kind')}{' '}
              {value.coverage.unknown_kind_receipts}
            </p>
            <p>
              {t('完整性可核對', 'Integrity verifiable')} {value.coverage.verified_receipts} ·{' '}
              {t('完整性不可用', 'Integrity unavailable')} {value.coverage.unverifiable_receipts} ·{' '}
              {t('可比較基礎完整', 'Comparable basis complete')}{' '}
              {value.coverage.basis_available_path_receipts} ·{' '}
              {t('路徑基礎不可用', 'Path basis unavailable')}{' '}
              {value.coverage.basis_unavailable_path_receipts}
            </p>
            <p>
              {t('完全相同比較基礎分組', 'Exact comparable basis groups')}{' '}
              {value.coverage.basis_groups} ·{' '}
              {t('各組設定數合計', 'Sum of within-group configurations')}{' '}
              {value.coverage.configurations_within_groups} ·{' '}
              {t('重複設定群', 'Repeated configuration groups')}{' '}
              {value.coverage.duplicate_configuration_groups} ·{' '}
              {t('保留的額外重複收據', 'Retained additional duplicate receipts')}{' '}
              {value.coverage.duplicate_receipts_extra}
            </p>
            <p>
              {t('未記錄試驗／完整搜尋分母', 'Unrecorded trials / full-search denominator')} — ·{' '}
              {t('未知，不是零', 'Unknown, not zero')}
            </p>
            <p>
              {t('本次讀取來源相符', 'Source matches at this read')}{' '}
              {records.filter((r) => r.currentness.current === true).length} ·{' '}
              {t('來源已不同', 'Source differs')}{' '}
              {records.filter((r) => r.currentness.current === false).length} ·{' '}
              {t('來源狀態未知', 'Source state unknown')}{' '}
              {records.filter((r) => r.currentness.current === null).length}
            </p>
            <p className="muted">
              {t('讀取時間', 'Read at')} {value.checked_at} · {value.checked_as_of} ·{' '}
              <code>{value.checked_input_revision}</code> ·{' '}
              <code>{value.inventory_fingerprint}</code>
            </p>
          </div>
          <p className="notice">
            {t(
              '完整性有效不代表可比較；相同基礎也不代表 CSCV 已通過。重複設定與全部收據保持可見，不會自動選取或計算 CSCV。',
              'Valid integrity does not mean comparability; matching bases do not mean CSCV passed. Duplicate configurations and every receipt remain visible. No automatic CSCV selection or calculation.',
            )}
          </p>
          {value.groups.map((group) => (
            <details key={group.basis_fingerprint} className="trial-inventory-group">
              <summary>
                {t('比較基礎', 'Comparison basis')}{' '}
                <code>{group.basis_fingerprint.slice(0, 12)}</code> · {t('收據', 'Receipts')}{' '}
                {group.receipt_count} · {t('不同設定', 'Distinct configurations')}{' '}
                {group.distinct_configurations}
              </summary>
              <pre>{JSON.stringify(group.basis, null, 2)}</pre>
              {group.configurations.map((configuration) => (
                <details key={configuration.configuration_fingerprint}>
                  <summary>
                    {t('設定指紋', 'Configuration fingerprint')}{' '}
                    <code>{configuration.configuration_fingerprint.slice(0, 12)}</code> ·{' '}
                    {t('保存次數', 'Saved multiplicity')} {configuration.multiplicity}
                  </summary>
                  <p>
                    <code>{configuration.configuration_fingerprint}</code>
                  </p>
                  <p>{t('保留全部原始收據 ID', 'All original receipt IDs retained')}</p>
                  {configuration.receipt_ids.map((receipt) => (
                    <p key={receipt}>
                      <code>{receipt}</code>
                    </p>
                  ))}
                  <pre>{JSON.stringify(configuration.configuration, null, 2)}</pre>
                </details>
              ))}
            </details>
          ))}
          <p id={`${id}-filter-note`}>
            {t(
              '篩選只改清單；完整涵蓋、重複次數、分組和下載不變。',
              'Filtering changes only the list; full coverage, multiplicity, groups and download stay unchanged.',
            )}
          </p>
          <div className="trial-inventory-filters" aria-describedby={`${id}-filter-note`}>
            <label htmlFor={`${id}-category`}>
              {t('清單分類', 'Inventory category')}
              <select
                id={`${id}-category`}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value as typeof filter)
                  setPage(0)
                }}
              >
                <option value="all">{t('全部', 'All')}</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {categoryName(category, t)}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-search`}>
              {t('搜尋收據、工作流或指紋', 'Search receipt, workflow or fingerprint')}
              <input
                id={`${id}-search`}
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault()
                }}
              />
            </label>
            <button
              type="button"
              disabled={filter === 'all' && !query}
              onClick={() => {
                setFilter('all')
                setQuery('')
                setPage(0)
              }}
            >
              {t('重設清單篩選', 'Reset inventory filters')}
            </button>
          </div>
          <p role="status">
            {t('符合篩選', 'Matched')} {matches.length} / {records.length} · {t('顯示', 'Showing')}{' '}
            {matches.length ? currentPage * PAGE_SIZE + 1 : 0}–
            {currentPage * PAGE_SIZE + visible.length} · {t('每頁 25 筆', '25 per page')}
          </p>
          <div className="trial-inventory-actions">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              {t('上一頁紀錄', 'Previous page')}
            </button>
            <span>
              {t('頁次', 'Page')} {pages ? currentPage + 1 : 0} / {pages}
            </span>
            <button
              type="button"
              disabled={!pages || currentPage >= pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              {t('下一頁紀錄', 'Next page')}
            </button>
          </div>
          {!visible.length && (
            <p>
              {t(
                '沒有符合條件的收據；上方完整清單涵蓋仍有效。',
                'No receipts match; full inventory coverage above still applies.',
              )}
            </p>
          )}
          {visible.map((r) => (
            <details
              key={`${r.ordinal}:${r.id ?? 'unknown'}`}
              className="trial-inventory-record"
              data-inventory-ordinal={r.ordinal}
            >
              <summary>
                <code title={r.id ?? undefined}>
                  {r.id ? `${r.id.slice(0, 12)}…` : t('收據識別未知', 'Receipt identity unknown')}
                </code>{' '}
                · {categoryName(r.category, t)}
              </summary>
              <p>
                {t('完整收據 ID', 'Full receipt ID')} <code>{r.id ?? '—'}</code>
              </p>
              <p>
                {t('工作流 ID', 'Workflow ID')} <code>{r.run_id ?? '—'}</code>
              </p>
              <p>
                {t('原始收據指紋', 'Original receipt fingerprint')}{' '}
                <code>{r.content_fingerprint ?? '—'}</code>
              </p>
              <p>
                {t('原始研究狀態', 'Original research status')} {r.diagnostic_status ?? '—'} ·{' '}
                {stateName(r.currentness, t)}
              </p>
              <p>
                {t('設定指紋', 'Configuration fingerprint')}{' '}
                <code>{r.configuration_fingerprint ?? '—'}</code>
              </p>
              <p>
                {t('比較基礎指紋', 'Comparison basis fingerprint')}{' '}
                <code>{r.basis_fingerprint ?? '—'}</code>
              </p>
              {[...new Set([...r.reasons, ...r.currentness.reasons])].map((code) => (
                <p key={code} className="notice">
                  {reason(code, t)}
                </p>
              ))}
              {r.configuration && <pre>{JSON.stringify(r.configuration, null, 2)}</pre>}
              {r.coverage && <pre>{JSON.stringify(r.coverage, null, 2)}</pre>}
              {!r.integrity.available && (
                <details>
                  <summary>{t('原始識別儲存型別', 'Original identity storage types')}</summary>
                  <pre>{JSON.stringify(r.identity_cells, null, 2)}</pre>
                </details>
              )}
            </details>
          ))}
          <p className="research-note">
            {t(
              '下載包含完整清單的保存身分、指紋、設定與基礎摘要，最多 3 MiB；原始收據全文請使用各收據或封存下載。完整試驗登錄仍未完成。',
              'Download contains the complete saved identities, fingerprints, configurations and basis summaries, up to 3 MiB. Original receipt envelopes use individual or archive downloads. A full trial registry remains unfinished.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
