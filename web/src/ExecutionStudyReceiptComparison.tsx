import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  executionStudyComparisonCsv,
  executionStudyComparisonCsvFilename,
} from './execution-study-comparison-csv'
import { workflowEvidenceJson } from './workflow-evidence-json'
import type { ExecutionStudyKind } from './ExecutionStudyReceipts'
import './ExecutionStudyReceiptComparison.css'

type Translate = (zh: string, en: string) => string
export type ExecutionStudyComparisonReceipt = {
  id: string
  account_id: string
  proposal_id: string
  kind: ExecutionStudyKind
  created_at: string
  content_fingerprint: string
  raw_evidence_sha256: string | null
  status: string | null
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
}
type Metric = {
  baseline: number | null
  selected: number | null
  delta: number | null
  reason: string | null
  unit: string
}
type Row = {
  date?: string
  symbol?: string
  paired: boolean
  baseline_status: string | null
  selected_status: string | null
  baseline_reason: string | null
  selected_reason: string | null
  metrics: Record<string, Metric>
  sessions?: Row[]
}
type Side = {
  summary: ExecutionStudyComparisonReceipt
  original_receipt: {
    receipt_id: string
    kind: ExecutionStudyKind
    account_context: { account_id: string }
    source_context: { raw_evidence_sha256: string }
    evidence: { account_id: string; source: { id: string; account_id: string } }
    policy: { advisory_only: boolean; execution_source: boolean; gating_authority: boolean }
  }
}
type Request = {
  baseline_receipt_id: string
  selected_receipt_id: string
  expected_baseline_fingerprint: string
  expected_selected_fingerprint: string
  expected_account_version: number
}
type Result = {
  engine_version: string
  account_id: string
  proposal_id: string
  account_version: number
  kind: ExecutionStudyKind
  request: Request
  checked_as_of: string
  checked_input_revision: string
  baseline: Side
  selected: Side
  comparison: {
    historically_comparable: boolean
    reasons: string[]
    basis_checks: { code: string; matches: boolean; baseline: unknown; selected: unknown }[]
    assumptions: { baseline: unknown; selected: unknown }
    orders: Row[]
    direction: string
    aggregate: null
    causal_attribution: false
    execution_authority: false
  }
  method: string
}
export type ExecutionStudyComparisonResult = Result
type Props = {
  accountId: string
  proposalId: string
  accountVersion: number
  kind: ExecutionStudyKind
  receipts: readonly ExecutionStudyComparisonReceipt[]
  total: number
  enabled?: boolean
  t: Translate
}
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-f0-9]{32}$/
const maxBytes = 5 * 1024 * 1024
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const format = (value: number | null) => (value === null ? '—' : String(value))
const same = (first: unknown, second: unknown): boolean => {
  if (Object.is(first, second)) return true
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false
  const keys = Object.keys(first)
  return (
    Array.isArray(first) === Array.isArray(second) &&
    keys.length === Object.keys(second).length &&
    keys.every(
      (key) =>
        Object.hasOwn(second, key) &&
        same((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]),
    )
  )
}
async function sha(raw: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
const reasonText = (code: string, t: Translate) =>
  ({
    method_versions: t('方法版本不同或尚未支援', 'Method versions differ or are unsupported'),
    saved_evidence_shape: t(
      '保存的股數、日期或覆蓋結構無法核對',
      'Saved quantity, date or coverage structure cannot be verified',
    ),
    study_method: t('保存研究的方法說明不同', 'Saved study methods differ'),
    saved_proposal: t('保存提案的原始紀錄不同', 'Original saved proposal records differ'),
    evaluation_snapshot: t(
      '研究快照、交易日或帳戶政策不同',
      'Study snapshots, sessions or account policies differ',
    ),
    frozen_orders_and_units: t(
      '固定股數、單位或精度不同',
      'Frozen quantities, units or precision differ',
    ),
    exact_session_horizon: t('完整研究日期範圍不同', 'Complete study horizons differ'),
    raw_bar_evidence: t('原始日線證據指紋不同', 'Original bar evidence fingerprints differ'),
    saved_coverage: t('保存的證據覆蓋不同', 'Saved evidence coverage differs'),
    order_and_day_identity: t('標的或逐日識別不同', 'Symbol or session identities differ'),
    comparison_basis_incompatible: t('比較基礎不相容', 'Comparison basis is incompatible'),
    baseline_value_missing: t('基準未保存此值', 'Baseline did not save this value'),
    selected_value_missing: t('對照未保存此值', 'Selected did not save this value'),
    baseline_value_unavailable: t('基準值未知', 'Baseline value is unknown'),
    selected_value_unavailable: t('對照值未知', 'Selected value is unknown'),
    nonfinite_difference: t(
      '差額無法以有限值表示',
      'Difference cannot be represented as a finite number',
    ),
  })[code] ?? code
const metricText = (code: string, t: Translate) =>
  ({
    raw_open: t('原始開盤價', 'Raw open'),
    session_volume: t('全日成交量', 'Full-day volume'),
    capacity_shares: t('情境容量股數', 'Scenario capacity shares'),
    scenario_shares: t('情境股數', 'Scenario shares'),
    expired_shares: t('情境到期股數', 'Scenario expired shares'),
    fill_fraction_pct: t('情境比例', 'Scenario fraction'),
    reference_notional: t('參考金額', 'Reference notional'),
    remaining_before: t('當日前剩餘股數', 'Remaining before session'),
    remaining_after: t('當日後剩餘股數', 'Remaining after session'),
    observed_prefix_scenario_shares: t('已觀察前段情境股數', 'Observed-prefix scenario shares'),
    last_known_remaining_shares: t('最後已知剩餘股數', 'Last known remaining shares'),
    observed_prefix_reference_notional: t(
      '已觀察前段參考金額',
      'Observed-prefix reference notional',
    ),
    final_scenario_shares: t('最終情境股數', 'Final scenario shares'),
    final_reference_notional: t('最終參考金額', 'Final reference notional'),
  })[code] ?? code

function Metrics({ row, t }: { row: Row; t: Translate }) {
  return (
    <div className="execution-study-comparison-metrics">
      {Object.entries(row.metrics).map(([name, metric]) => (
        <div className="execution-study-comparison-metric" key={name}>
          <strong>
            {metricText(name, t)} <small>{metric.unit}</small>
          </strong>
          <span>
            {t('基準', 'Baseline')}: {format(metric.baseline)}
          </span>
          <span>
            {t('對照', 'Selected')}: {format(metric.selected)}
          </span>
          <span>
            {t('差額', 'Difference')}: {format(metric.delta)}
          </span>
          {metric.reason && <small>{reasonText(metric.reason, t)}</small>}
        </div>
      ))}
    </div>
  )
}

function ComparedOrders({ result, t }: { result: Result; t: Translate }) {
  const prefix = useId()
  const [view, setView] = useState({ result, query: '', page: 0 })
  const current = view.result === result ? view : { result, query: '', page: 0 }
  useEffect(() => {
    setView((previous) => (previous.result === result ? previous : { result, query: '', page: 0 }))
  }, [result])
  const query = current.query.toLowerCase()
  const matched = result.comparison.orders
    .map((row, originalIndex) => ({ row, originalIndex }))
    .filter(({ row }) => !query || row.symbol?.toLowerCase().includes(query))
  const pages = Math.ceil(matched.length / 25)
  const page = Math.min(current.page, Math.max(0, pages - 1))
  const first = page * 25
  const visible = matched.slice(first, first + 25)
  return (
    <section
      className="execution-study-comparison-orders"
      aria-label={t('逐筆訂單比較', 'Compared orders')}
    >
      <h6>{t('逐筆訂單比較', 'Compared orders')}</h6>
      <p className="research-note" id={`${prefix}-notice`}>
        {t(
          '搜尋與分頁只改變訂單清單；完整比較基礎、來源狀態與下載內容保持不變。摘要只計訂單層級差額欄位，不含逐日欄位；計數不是股數、金額、完整性或研究結論。',
          'Search and pages change only the order list; full comparison bases, source status and downloads stay unchanged. Summary counts cover order-level difference fields only, excluding daily fields; they are not quantities, amounts, completeness or research conclusions.',
        )}
      </p>
      <div
        className="execution-study-comparison-order-controls"
        aria-describedby={`${prefix}-notice`}
      >
        <label htmlFor={`${prefix}-search`}>
          {t('搜尋比較訂單的股票代碼（選填）', 'Search compared order symbols (optional)')}
          <input
            id={`${prefix}-search`}
            type="search"
            value={current.query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setView({ result, query: event.target.value, page: 0 })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
          />
        </label>
        <button
          type="button"
          disabled={current.query === ''}
          onClick={() => setView({ result, query: '', page: 0 })}
        >
          {t('清除訂單搜尋', 'Clear order search')}
        </button>
      </div>
      <p className="research-note" role="status" aria-live="polite">
        {t('符合搜尋的訂單', 'Matching orders')} {matched.length} /{' '}
        {result.comparison.orders.length} · {t('顯示訂單範圍', 'Showing orders')}{' '}
        {matched.length ? first + 1 : 0}–{first + visible.length} ·{' '}
        {t('每頁 25 筆訂單', '25 orders per page')}
      </p>
      <div
        className="execution-study-comparison-order-pages"
        role="group"
        aria-label={t('比較訂單分頁', 'Compared order pages')}
      >
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setView({ ...current, page: page - 1 })}
        >
          {t('上一頁訂單', 'Previous orders')}
        </button>
        <span>
          {t('訂單頁次', 'Order page')} {pages ? page + 1 : 0} / {pages}
        </span>
        <button
          type="button"
          disabled={pages === 0 || page >= pages - 1}
          onClick={() => setView({ ...current, page: page + 1 })}
        >
          {t('下一頁訂單', 'Next orders')}
        </button>
      </div>
      {visible.length === 0 && (
        <p>
          {t(
            '沒有符合搜尋的訂單；完整比較結果與原始下載仍保留。',
            'No orders match this search; the full comparison and original download remain available.',
          )}
        </p>
      )}
      {visible.map(({ row, originalIndex }) => {
        const metrics = Object.values(row.metrics)
        const nonzero = result.comparison.historically_comparable
          ? metrics.filter((metric) => finite(metric.delta) && metric.delta !== 0).length
          : 0
        const unknown = result.comparison.historically_comparable
          ? metrics.filter((metric) => !finite(metric.delta)).length
          : metrics.length
        return (
          <details
            className="execution-study-comparison-order"
            key={`${row.symbol ?? ''}:${originalIndex}`}
            data-comparison-order-index={originalIndex}
          >
            <summary>
              <span className="execution-study-comparison-order-heading">
                <strong>{row.symbol ?? '—'}</strong>
                <span>
                  {t('基準', 'Baseline')}: {row.baseline_status ?? '—'} · {t('對照', 'Selected')}:{' '}
                  {row.selected_status ?? '—'}
                </span>
                <span className="execution-study-comparison-order-counts">
                  {t('訂單層級差額欄位', 'Order-level difference fields')}: {metrics.length} ·{' '}
                  {t('已知非零差額欄位', 'Known nonzero difference fields')}: {nonzero} ·{' '}
                  {t('未知差額欄位', 'Unknown difference fields')}: {unknown}
                </span>
              </span>
            </summary>
            {(row.baseline_reason || row.selected_reason) && (
              <p>
                {row.baseline_reason ?? '—'} / {row.selected_reason ?? '—'}
              </p>
            )}
            <Metrics row={row} t={t} />
            {!!row.sessions?.length && (
              <details>
                <summary>{t('逐日保存值', 'Saved values by session')}</summary>
                {row.sessions.map((step) => (
                  <div key={step.date} className="execution-study-comparison-session">
                    <strong>{step.date}</strong>
                    <p>
                      {step.baseline_status ?? '—'} → {step.selected_status ?? '—'}
                    </p>
                    <Metrics row={step} t={t} />
                  </div>
                ))}
              </details>
            )}
          </details>
        )
      })}
    </section>
  )
}

export function ExecutionStudyReceiptComparison(props: Props) {
  return <Comparison key={`${props.accountId}:${props.proposalId}:${props.kind}`} {...props} />
}
function Comparison({
  accountId,
  proposalId,
  accountVersion,
  kind,
  receipts,
  total,
  enabled = true,
  t,
}: Props) {
  const prefix = useId()
  const choices = receipts.filter(
    (item) =>
      item.integrity.available &&
      item.account_id === accountId &&
      item.proposal_id === proposalId &&
      item.kind === kind &&
      hashPattern.test(item.id) &&
      hashPattern.test(item.content_fingerprint) &&
      hashPattern.test(item.raw_evidence_sha256 ?? ''),
  )
  const [baselineId, setBaselineId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const baseline = choices.find((item) => item.id === baselineId)
  const selected = choices.find((item) => item.id === selectedId)
  const identity = JSON.stringify([
    accountId,
    proposalId,
    accountVersion,
    kind,
    choices,
    baselineId,
    selectedId,
    enabled,
  ])
  const latest = useRef(identity)
  latest.current = identity
  const operation = useRef<AbortController | null>(null)
  const downloads = useRef(new Map<string, number>())
  const [state, setState] = useState<{
    identity: string
    busy?: boolean
    error?: string
    result?: Result
    raw?: string
  }>({ identity })
  const current = state.identity === identity ? state : null
  const csvExport = useMemo(() => {
    if (!current?.result) return null
    try {
      return { content: executionStudyComparisonCsv(current.result), invalid: false }
    } catch {
      return { content: null, invalid: true }
    }
  }, [current?.result])
  const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/proposals/${encodeURIComponent(proposalId)}/study-receipts/compare`
  const canCompare =
    enabled &&
    baseline &&
    selected &&
    baselineId !== selectedId &&
    !current?.busy &&
    idPattern.test(accountId) &&
    idPattern.test(proposalId) &&
    Number.isInteger(accountVersion) &&
    accountVersion > 0
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
  const choiceIdentity = JSON.stringify(choices.map((item) => item.id))
  useEffect(() => {
    if (!choices.some((item) => item.id === baselineId)) setBaselineId('')
    if (!choices.some((item) => item.id === selectedId)) setSelectedId('')
  }, [choiceIdentity, baselineId, selectedId])
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

  function validate(value: Result, request: Request) {
    if (
      value.engine_version !== 'alphaview-execution-study-receipt-comparison-v1' ||
      value.account_id !== accountId ||
      value.proposal_id !== proposalId ||
      value.account_version !== accountVersion ||
      value.kind !== kind ||
      !same(value.request, request)
    )
      throw new Error('comparison_identity_mismatch')
    for (const [side, item] of [
      [value.baseline, baseline],
      [value.selected, selected],
    ] as const) {
      const original = side?.original_receipt
      if (
        !item ||
        side.summary.id !== item.id ||
        side.summary.account_id !== accountId ||
        side.summary.proposal_id !== proposalId ||
        side.summary.kind !== kind ||
        !side.summary.integrity.available ||
        side.summary.content_fingerprint !== item.content_fingerprint ||
        side.summary.raw_evidence_sha256 !== item.raw_evidence_sha256 ||
        ![true, false, null].includes(side.summary.currentness?.current) ||
        !Array.isArray(side.summary.currentness?.reasons) ||
        !original ||
        original.receipt_id !== item.id ||
        original.kind !== kind ||
        original.account_context.account_id !== accountId ||
        original.evidence.account_id !== accountId ||
        original.evidence.source.account_id !== accountId ||
        original.evidence.source.id !== proposalId ||
        original.source_context.raw_evidence_sha256 !== item.raw_evidence_sha256 ||
        original.policy.advisory_only !== true ||
        original.policy.execution_source !== false ||
        original.policy.gating_authority !== false
      )
        throw new Error('comparison_original_mismatch')
    }
    const result = value.comparison
    if (
      typeof result.historically_comparable !== 'boolean' ||
      !Array.isArray(result.reasons) ||
      !Array.isArray(result.basis_checks) ||
      result.basis_checks.some(
        (check) => typeof check.code !== 'string' || typeof check.matches !== 'boolean',
      ) ||
      (result.historically_comparable &&
        (result.reasons.length !== 0 || result.basis_checks.some((check) => !check.matches))) ||
      (!result.historically_comparable && result.reasons.length === 0) ||
      result.direction !== 'selected_minus_baseline' ||
      result.aggregate !== null ||
      result.execution_authority !== false ||
      result.causal_attribution !== false ||
      !Array.isArray(result.orders) ||
      result.orders.length > 100 ||
      new Set(result.orders.map((row) => row.symbol)).size !== result.orders.length
    )
      throw new Error('comparison_protocol_mismatch')
    for (const order of result.orders) {
      if (
        !Array.isArray(order.sessions) ||
        order.sessions.length > 5 ||
        new Set(order.sessions.map((row) => row.date)).size !== order.sessions.length
      )
        throw new Error('comparison_session_mismatch')
      for (const row of [order, ...order.sessions]) {
        if (!row.metrics || typeof row.metrics !== 'object')
          throw new Error('comparison_metrics_missing')
        for (const metric of Object.values(row.metrics)) {
          if (
            typeof metric.unit !== 'string' ||
            ![metric.baseline, metric.selected, metric.delta].every(
              (cell) => cell === null || finite(cell),
            ) ||
            (!result.historically_comparable && metric.delta !== null) ||
            ((metric.baseline === null || metric.selected === null || metric.reason !== null) &&
              metric.delta !== null)
          )
            throw new Error('comparison_unknown_delta')
        }
      }
    }
  }
  async function compare() {
    if (!canCompare || !baseline || !selected || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    const request: Request = {
      baseline_receipt_id: baseline.id,
      selected_receipt_id: selected.id,
      expected_baseline_fingerprint: baseline.content_fingerprint,
      expected_selected_fingerprint: selected.content_fingerprint,
      expected_account_version: accountVersion,
    }
    setState({ identity, busy: true })
    try {
      const response = await fetch(base, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const raw = await response.text()
      if (!response.ok) {
        let code = `HTTP ${response.status}`
        try {
          code = JSON.parse(raw)?.detail?.code ?? code
        } catch {
          /* Keep HTTP status if server did not return JSON. */
        }
        throw new Error(code)
      }
      if (new TextEncoder().encode(raw).length > maxBytes)
        throw new Error('comparison_export_size_limit')
      const value: Result = JSON.parse(raw)
      workflowEvidenceJson(value, raw)
      if (response.headers.get('etag') !== `"${await sha(raw)}"`)
        throw new Error('comparison_response_hash_mismatch')
      validate(value, request)
      if (!controller.signal.aborted && latest.current === identity)
        setState({ identity, result: value, raw })
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity)
        setState({ identity, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  function download() {
    if (!current?.result || !current.raw || !enabled || operation.current) return
    const url = URL.createObjectURL(
      new Blob([current.raw], { type: 'application/json;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `alphaview-study-comparison-${kind}-${accountId.slice(0, 8)}-${proposalId.slice(0, 8)}-${baselineId.slice(0, 8)}-${selectedId.slice(0, 8)}.json`
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
  }
  function downloadCsv() {
    if (
      !current?.result ||
      !current.raw ||
      !csvExport?.content ||
      !enabled ||
      operation.current ||
      latest.current !== identity
    )
      return
    const url = URL.createObjectURL(
      new Blob([csvExport.content], { type: 'text/csv;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = executionStudyComparisonCsvFilename(current.result)
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
  }
  const result = current?.result
  const freshness = (side: Side) =>
    side.summary.currentness.current === true
      ? t('比較讀取時來源相符', 'Sources matched when compared')
      : side.summary.currentness.current === false
        ? t('歷史來源已變更', 'Historical sources changed')
        : t('當前來源未知', 'Current sources unknown')
  return (
    <section
      className="execution-study-comparison"
      aria-label={t('比較保存的執行研究', 'Compare saved execution studies')}
    >
      <h5>{t('比較保存的執行研究', 'Compare saved execution studies')}</h5>
      <p className="research-note">
        {t(
          '只使用已讀取的回條；差額為對照減基準，不重跑研究、不補缺值、不加總不完整股數，也不選出較佳設定。',
          'Use only loaded receipts. Differences are selected minus baseline; no study rerun, gap filling, incomplete quantity totals or winner selection.',
        )}
      </p>
      <p className="research-note">
        {t(
          '選單含本次載入歷程中全部可驗證回條，不受歷程篩選或分頁影響。',
          'Selectors contain all verifiable receipts in the loaded history, regardless of history filters or pages.',
        )}{' '}
        {choices.length} / {total}
      </p>
      <div className="execution-study-comparison-controls">
        <label htmlFor={`${prefix}-baseline`}>
          {t('基準回條', 'Baseline receipt')}
          <select
            id={`${prefix}-baseline`}
            value={baselineId}
            disabled={!!current?.busy}
            onChange={(event) => setBaselineId(event.target.value)}
          >
            <option value="">{t('選擇回條', 'Choose a receipt')}</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.created_at} · {item.status ?? '—'} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${prefix}-selected`}>
          {t('對照回條', 'Selected receipt')}
          <select
            id={`${prefix}-selected`}
            value={selectedId}
            disabled={!!current?.busy}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">{t('選擇回條', 'Choose a receipt')}</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.created_at} · {item.status ?? '—'} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!canCompare} onClick={() => void compare()}>
          {current?.busy ? t('比較中…', 'Comparing…') : t('比較兩份研究', 'Compare two studies')}
        </button>
      </div>
      {choices.length < 2 && (
        <p>
          {t(
            '這頁需要至少兩份相同種類的可驗證回條。',
            'This page needs at least two verifiable receipts of the same kind.',
          )}
        </p>
      )}
      {current?.error && (
        <p role="alert">
          {t('比較未完成：', 'Comparison did not complete: ')}
          {current.error}
        </p>
      )}
      {current?.busy && (
        <p role="status">{t('讀取兩份保存證據中…', 'Reading both saved evidence records…')}</p>
      )}
      {result && (
        <>
          <p role="status">
            {result.comparison.historically_comparable
              ? t(
                  '比較基礎相符；只比較已知數值。',
                  'Comparison bases match; only known values are compared.',
                )
              : t(
                  '比較基礎不相容；保留原值，所有差額不可用。',
                  'Comparison bases are incompatible; original values remain and all differences are unavailable.',
                )}
          </p>
          {result.comparison.reasons.length > 0 && (
            <ul>
              {result.comparison.reasons.map((reason) => (
                <li key={reason}>{reasonText(reason, t)}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={download}>
            {t('下載完整比較 JSON', 'Download full comparison JSON')}
          </button>
          {csvExport?.content && (
            <button type="button" onClick={downloadCsv}>
              {t('下載全部訂單與逐日比較 CSV', 'Download all order and daily comparisons CSV')}
            </button>
          )}
          {csvExport && (
            <p className="research-note">
              {csvExport.invalid
                ? t(
                    'CSV 無法建立：必要結構缺漏或數值不可驗證。完整原始 JSON 仍可檢閱。',
                    'CSV cannot be created: required structure is missing or values cannot be verified. The full original JSON remains available for inspection.',
                  )
                : t(
                    'CSV 包含全部訂單與保存日期，不受搜尋或分頁影響。空白數值附不可用標記；基礎不相容時保留原值與空白差額。這是閱讀便利副本，完整原件仍在 JSON；不是實際成交或交易授權。',
                    'CSV includes every order and saved session regardless of search or pages. Blank values carry unavailable markers; incompatible bases retain original side values and blank differences. This is a readable convenience; JSON retains full original evidence. It is not actual fills or trading authorization.',
                  )}
            </p>
          )}
          <div className="execution-study-comparison-sides">
            {(['baseline', 'selected'] as const).map((side) => (
              <div key={side}>
                <h6>{side === 'baseline' ? t('基準', 'Baseline') : t('對照', 'Selected')}</h6>
                <p>
                  {freshness(result[side])} · {result[side].summary.status ?? '—'}
                </p>
                <p>{result[side].summary.currentness.reasons.join(' · ')}</p>
                <p>
                  {t('回條指紋', 'Receipt fingerprint')}
                  <code>{result[side].summary.content_fingerprint}</code>
                </p>
                <p>
                  {t('原始研究 JSON 指紋', 'Original study JSON fingerprint')}
                  <code>{result[side].summary.raw_evidence_sha256}</code>
                </p>
                <pre>{JSON.stringify(result.comparison.assumptions[side], null, 2)}</pre>
              </div>
            ))}
          </div>
          <ComparedOrders result={result} t={t} />
          <details>
            <summary>{t('比較基礎與原始覆蓋', 'Comparison bases and original coverage')}</summary>
            <pre>{JSON.stringify(result.comparison.basis_checks, null, 2)}</pre>
          </details>
          <p className="research-note">
            {t(
              '這不是實際成交、開盤流動性、限價日內結果、因果歸因或交易授權。原始完整回條保留在下載內容。',
              'This is not actual fills, opening liquidity, intraday limit outcomes, causal attribution or trading authorization. Full original receipts remain in the download.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
