import { ArchivePreflightRecords } from './ArchivePreflightRecords'
import { useEffect, useId, useRef, useState } from 'react'
import { dateTime } from './ui'
import './execution-study-receipt-archive.css'

type Translate = (zh: string, en: string) => string
const ENGINE = 'alphaview-execution-study-receipt-archive-v1'
const MAX_BYTES = 32 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
type Policy = {
  read_only: true
  import_authorized: false
  restore_authorized: false
  delete_authorized: false
  execution_source: false
}
type Currentness = { current: boolean | null; reasons: string[] }
export type ExecutionStudyArchive = {
  engine_version: string
  schema_version: number
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  exported_at: string
  checksum: string
  policy: Policy
  records: { id: string | null; integrity: { available: boolean; reason: string | null } }[]
  coverage: {
    account_total: number
    exported: number
    complete_set: boolean
    raw_complete: number
    verified: number
    unavailable: number
  }
}
export type ExecutionStudyArchivePreflight = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  checked_at: string
  verdict: 'compatible' | 'blocked'
  compatible: boolean
  archive_checksum: string | null
  policy: Policy
  reasons: string[]
  coverage: {
    declared: number | null
    checked: number
    compatible: number
    unavailable: number | null
  }
  archive_context: {
    account_id: string
    account_version: number
    as_of: string
    input_revision: string
    exported_at: string
  } | null
  snapshot_currentness: Currentness
  capacity: {
    account_used: number
    account_limit: number
    global_used: number
    global_limit: number
    account_remaining: number
    global_remaining: number
    unknown_identities: number
    projected_account_total: number | null
    projected_global_total: number | null
    absent_locally: number
    automatic_deletion: false
    import_authorized: false
  } | null
  records: {
    id: string | null
    ordinal: number
    diagnostic_status: string | null
    kind: string | null
    proposal_id: string | null
    compatible: boolean
    reasons: string[]
    duplicate: string
    integrity: { available: boolean; reason: string | null }
    archived_currentness: Currentness
    currentness: Currentness
  }[]
}
const count = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
const reason = (code: string, t: Translate) =>
  ({
    study_archive_size_limit: t(
      '完整封存超過 32 MiB，未產生部分檔案',
      'Complete archive exceeds 32 MiB; no partial file was produced',
    ),
    study_archive_count_limit: t(
      '收據超過每帳戶 50 筆或全域 250 筆上限，未產生部分檔案',
      'Receipts exceed the 50-per-account or 250-global limit; no partial file was produced',
    ),
    study_archive_media_type: t('預檢需要 JSON 內容', 'Preflight requires JSON content'),
    study_archive_session_changed: t(
      '讀取期間交易日已變更，請重新讀取',
      'Completed session changed during the read; read again',
    ),
    archive_json_invalid: t('封存內容不是有效 UTF-8 JSON', 'Archive is not valid UTF-8 JSON'),
    duplicate_json_key: t('JSON 含重複欄位', 'JSON contains duplicate keys'),
    nonfinite_json: t('JSON 含非有限數值', 'JSON contains a nonfinite number'),
    archive_shape_invalid: t('封存欄位或資料形狀不符', 'Archive fields or shape do not match'),
    archive_version_unsupported: t('封存版本不支援', 'Archive version unsupported'),
    archive_checksum_mismatch: t('封存校驗值不符', 'Archive checksum mismatch'),
    archive_set_fingerprint_mismatch: t(
      '完整收據集合指紋不符',
      'Complete receipt-set fingerprint mismatch',
    ),
    archive_record_columns_invalid: t('原始紀錄欄位不符', 'Raw record columns mismatch'),
    archive_row_checksum_mismatch: t('收據列校驗值不符', 'Receipt row checksum mismatch'),
    archive_integrity_label_mismatch: t(
      '完整性標示與核對結果不符',
      'Integrity label differs from verification',
    ),
    archive_diagnostic_label_mismatch: t(
      '診斷標示與原值不符',
      'Diagnostic label differs from original value',
    ),
    archive_receipt_identity_invalid: t('收據識別無效', 'Receipt identity invalid'),
    archive_entry_identity_mismatch: t(
      '摘要與原始紀錄識別不符',
      'Summary and raw record identities differ',
    ),
    archive_saved_request_invalid: t('保存請求形狀不符', 'Saved request shape mismatch'),
    archive_receipt_method_unsupported: t(
      '收據方法版本不支援',
      'Receipt method version unsupported',
    ),
    archive_evidence_method_unsupported: t(
      '研究方法版本不支援',
      'Evidence method version unsupported',
    ),
    archive_desk_method_unsupported: t('研究方法版本不支援', 'Research method version unsupported'),
    archive_account_mismatch: t('封存檔屬於其他帳戶', 'Archive belongs to another account'),
    archive_receipt_account_mismatch: t('收據屬於其他帳戶', 'Receipt belongs to another account'),
    archive_coverage_mismatch: t(
      '封存筆數或完整集合標示不符',
      'Archive counts or full-set declaration mismatch',
    ),
    archive_records_incompatible: t('有收據未通過相容性檢查', 'Some receipts are incompatible'),
    archive_cell_checksum_mismatch: t('儲存格校驗值不符', 'Cell checksum mismatch'),
    archive_cell_encoding_invalid: t('儲存格編碼無效', 'Cell encoding invalid'),
    archive_receipt_nontext: t(
      '收據含非文字儲存格，僅保留原值',
      'Receipt contains nontext cells; raw values preserved',
    ),
    archive_receipt_unverifiable: t('收據證據無法驗證', 'Receipt evidence unverifiable'),
    archive_evidence_shape_unsupported: t(
      '研究內容形狀無法核對',
      'Evidence shape cannot be verified',
    ),
    archive_duplicate_identity: t(
      '封存檔內有重複收據識別',
      'Duplicate receipt identity inside archive',
    ),
    archive_local_identity_conflict: t(
      '本機同識別收據內容衝突',
      'Local receipt with the same identity conflicts',
    ),
    archive_receipt_capacity: t(
      '帳戶或全域收據容量不足',
      'Account or global receipt capacity is insufficient',
    ),
    archive_local_set_size_limit: t(
      '本機集合超過可核對大小',
      'Local set exceeds the verifiable size limit',
    ),
    workspace_inputs_changed: t('工作區輸入版本已變更', 'Workspace input revision changed'),
    inputs_changed: t('工作區輸入版本已變更', 'Workspace input revision changed'),
    session_changed: t('已完成交易日已變更', 'Completed session changed'),
    receipt_set_changed: t('目前帳戶收據集合不同', 'Current account receipt set differs'),
    archive_unverifiable: t('封存無法驗證', 'Archive unverifiable'),
    receipt_unverifiable: t('收據無法驗證', 'Receipt unverifiable'),
    receipt_content_changed: t('收據內容指紋不符', 'Receipt content fingerprint mismatch'),
    receipt_size_limit: t('收據內容超過 2 MiB', 'Receipt payload exceeds 2 MiB'),
    method_changed: t('收據方法版本已變更', 'Receipt method version changed'),
    archive_context_unverifiable: t('來源條件無法核對', 'Source context unverifiable'),
    archive_account_unverifiable: t('來源帳戶無法核對', 'Source account unverifiable'),
    source_inputs_changed: t('來源輸入已變更', 'Source inputs changed'),
    evidence_method_changed: t('研究方法已變更', 'Evidence method changed'),
    account_version_changed: t('帳戶版本已變更', 'Account version changed'),
    account_context_changed: t('帳戶條件已變更', 'Account context changed'),
    account_missing: t('來源帳戶已不存在', 'Source account no longer exists'),
    proposal_missing: t('來源提案已不存在', 'Source proposal no longer exists'),
    proposal_changed: t('來源提案已變更', 'Source proposal changed'),
    context_unverifiable: t('來源條件無法核對', 'Source context unverifiable'),
    archive_receipt_envelope_unsupported: t(
      '完整收據封裝不支援',
      'Complete receipt envelope unsupported',
    ),
    archive_method_text_unsupported: t(
      '方法說明與版本不符',
      'Method text differs from supported version',
    ),
    receipt_size_or_storage_invalid: t(
      '原始收據大小或儲存型別無效',
      'Original receipt size or storage type invalid',
    ),
    desk_method_changed: t('研究方法已變更', 'Research method changed'),
  })[code] ?? code
const diagnostic = (code: string | null, t: Translate) =>
  code === 'complete'
    ? t('原始涵蓋完整', 'Original coverage complete')
    : code === 'incomplete'
      ? t('部分情境不可用', 'Some scenarios unavailable')
      : code === 'unavailable'
        ? t('研究不可用', 'Research unavailable')
        : '—'
const receiptKind = (code: string | null, t: Translate) =>
  ({
    volume_day: t('成交量 DAY 研究', 'Volume DAY study'),
    limit_day: t('開盤限價 DAY 研究', 'Open-only limit DAY study'),
    open_gtd: t('多日開盤 GTD 研究', 'Multi-session open-only GTD study'),
  })[code ?? ''] ??
  code ??
  '—'

const currentness = (value: Currentness, t: Translate) =>
  value.current === null
    ? t('目前條件不可用', 'Current context unavailable')
    : value.current
      ? t('本次讀取仍相符', 'Matches at this read')
      : t('目前條件已不同', 'Current context differs')
const duplicate = (code: string, t: Translate) =>
  ({
    identical_locally: t('本機已有完全相同紀錄', 'Identical record already exists locally'),
    absent_locally: t('本機尚無此紀錄', 'Record absent locally'),
    conflicting_local_identity: t('本機同識別內容衝突', 'Local identity content conflict'),
    unverifiable: t('本機重複狀態無法核對', 'Local duplicate status unverifiable'),
  })[code] ?? code
const safePolicy = (policy: Policy | undefined) =>
  policy?.read_only === true &&
  policy.import_authorized === false &&
  policy.restore_authorized === false &&
  policy.delete_authorized === false &&
  policy.execution_source === false
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const nonnegative = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const safeCurrentness = (value: Currentness | undefined) =>
  !!value &&
  (value.current === null || typeof value.current === 'boolean') &&
  strings(value.reasons)
const safePreflight = (value: ExecutionStudyArchivePreflight) =>
  ['compatible', 'blocked'].includes(value.verdict) &&
  value.compatible === (value.verdict === 'compatible') &&
  strings(value.reasons) &&
  safeCurrentness(value.snapshot_currentness) &&
  !!value.coverage &&
  [value.coverage.checked, value.coverage.compatible].every(nonnegative) &&
  [value.coverage.declared, value.coverage.unavailable].every(
    (item) => item === null || nonnegative(item),
  ) &&
  (value.archive_context === null ||
    (!!value.archive_context &&
      typeof value.archive_context.account_id === 'string' &&
      nonnegative(value.archive_context.account_version) &&
      typeof value.archive_context.as_of === 'string')) &&
  (value.capacity === null ||
    (!!value.capacity &&
      [
        value.capacity.account_used,
        value.capacity.account_limit,
        value.capacity.global_used,
        value.capacity.global_limit,
        value.capacity.account_remaining,
        value.capacity.global_remaining,
        value.capacity.absent_locally,
        value.capacity.unknown_identities,
      ].every(nonnegative) &&
      value.capacity.automatic_deletion === false &&
      value.capacity.import_authorized === false)) &&
  Array.isArray(value.records) &&
  value.records.length <= 50 &&
  value.records.every(
    (record) =>
      record &&
      (record.id === null || typeof record.id === 'string') &&
      (record.proposal_id === null || typeof record.proposal_id === 'string') &&
      (record.kind === null || typeof record.kind === 'string') &&
      typeof record.compatible === 'boolean' &&
      strings(record.reasons) &&
      typeof record.duplicate === 'string' &&
      (record.diagnostic_status === null ||
        ['complete', 'incomplete', 'unavailable'].includes(record.diagnostic_status)) &&
      safeCurrentness(record.archived_currentness) &&
      safeCurrentness(record.currentness),
  )

export function ExecutionStudyReceiptArchive({
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
  const fieldId = useId()
  const [prepared, setPrepared] = useState<{
    key: string
    value: ExecutionStudyArchive
    text: string
  } | null>(null)
  const [checked, setChecked] = useState<{
    key: string
    draft: string
    value: ExecutionStudyArchivePreflight
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [readingFile, setReadingFile] = useState(false)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const operation = useRef<{ controller: AbortController; kind: string } | null>(null)
  const fileRead = useRef<FileReader | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const key = JSON.stringify([accountId, accountVersion, enabled])
  const identity = useRef(key)
  identity.current = key
  const preparedRef = useRef<typeof prepared>(null)
  const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/execution-study-receipt-archive`
  const bundle = prepared?.key === key ? prepared : null
  const report = checked?.key === key && checked.draft === draft ? checked.value : null

  useEffect(() => {
    preparedRef.current = null
    setPrepared(null)
    setChecked(null)
    setError(null)
    setBusy(null)
    setReadingFile(false)
    return () => {
      operation.current?.controller.abort()
      operation.current = null
      fileRead.current?.abort()
      fileRead.current = null
    }
  }, [key])

  function updateDraft(value: string, name = '') {
    fileRead.current?.abort()
    fileRead.current = null
    setReadingFile(false)
    if (operation.current?.kind === 'preflight') {
      operation.current.controller.abort()
      operation.current = null
      setBusy(null)
    }
    draftRef.current = value
    setDraft(value)
    setFileName(name)
    setChecked(null)
    setError(null)
  }

  function chooseFile(file: File | undefined) {
    if (!file) return
    fileRead.current?.abort()
    fileRead.current = null
    setReadingFile(false)
    setChecked(null)
    if (operation.current?.kind === 'preflight') {
      operation.current.controller.abort()
      operation.current = null
      setBusy(null)
    }
    if (file.size > MAX_BYTES) {
      setChecked(null)
      setError({
        key,
        message: t(
          '檔案超過 32 MiB；草稿保持原樣。',
          'File exceeds 32 MiB; the draft is preserved.',
        ),
      })
      return
    }
    const reader = new FileReader()
    fileRead.current = reader
    setReadingFile(true)
    reader.onload = () => {
      if (fileRead.current !== reader || identity.current !== key) return
      fileRead.current = null
      setReadingFile(false)
      try {
        updateDraft(
          new TextDecoder('utf-8', { fatal: true }).decode(reader.result as ArrayBuffer),
          file.name,
        )
      } catch {
        setError({
          key,
          message: t(
            '封存檔不是有效 UTF-8；草稿保持原樣。',
            'Archive is not valid UTF-8; the draft is preserved.',
          ),
        })
      }
    }
    reader.onerror = () => {
      if (fileRead.current !== reader || identity.current !== key) return
      fileRead.current = null
      setReadingFile(false)
      setError({
        key,
        message: t(
          '無法讀取本機封存檔；草稿保持原樣。',
          'Could not read the local archive; the draft is preserved.',
        ),
      })
    }
    reader.readAsArrayBuffer(file)
  }

  async function perform(kind: 'prepare' | 'preflight') {
    if (
      !enabled ||
      operation.current ||
      (kind === 'preflight' && (!draft.trim() || fileRead.current))
    )
      return
    if (kind === 'preflight' && new TextEncoder().encode(draft).byteLength > MAX_BYTES) {
      setChecked(null)
      setError({ key, message: t('封存檔超過 32 MiB', 'Archive exceeds 32 MiB') })
      return
    }
    const controller = new AbortController()
    operation.current = { controller, kind }
    setBusy(kind)
    setError(null)
    if (kind === 'prepare') {
      preparedRef.current = null
      setPrepared(null)
    } else setChecked(null)
    const submitted = draft
    try {
      const response = await fetch(kind === 'prepare' ? base : `${base}/preflight`, {
        cache: 'no-store',
        signal: controller.signal,
        ...(kind === 'preflight'
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: submitted }
          : {}),
      })
      const text = await response.text()
      if (
        controller.signal.aborted ||
        identity.current !== key ||
        (kind === 'preflight' && draftRef.current !== submitted)
      )
        return
      if (!response.ok) {
        let code: string | null = null
        try {
          const problem = JSON.parse(text)
          if (typeof problem?.detail?.code === 'string') code = problem.detail.code
        } catch {
          code = null
        }
        throw new Error(
          (code ? reason(code, t) : t('本機封存請求失敗', 'Local archive request failed')) +
            ` (${response.status})`,
        )
      }
      if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
        throw new Error(t('封存檔超過 32 MiB', 'Archive exceeds 32 MiB'))
      const value = JSON.parse(text, (_field, item: unknown) => {
        if (typeof item === 'number' && !Number.isFinite(item))
          throw new Error(t('JSON 含非有限數值', 'JSON contains a nonfinite number'))
        return item
      })
      if (
        !value ||
        value.engine_version !== ENGINE ||
        value.account_id !== accountId ||
        value.account_version !== accountVersion ||
        typeof value.as_of !== 'string' ||
        typeof value.input_revision !== 'string' ||
        !safePolicy(value.policy)
      )
        throw new Error(
          t(
            '封存回應的帳戶、版本或唯讀政策不符。',
            'Archive response account, version or read-only policy mismatch.',
          ),
        )
      if (kind === 'prepare') {
        if (
          value.schema_version !== 1 ||
          !hash.test(value.checksum) ||
          !Array.isArray(value.records) ||
          value.records.length > 50 ||
          value.coverage?.complete_set !== true ||
          value.coverage.account_total !== value.records.length ||
          value.coverage.exported !== value.records.length ||
          value.coverage.raw_complete !== value.records.length ||
          !nonnegative(value.coverage.verified) ||
          !nonnegative(value.coverage.unavailable) ||
          value.coverage.verified + value.coverage.unavailable !== value.records.length ||
          typeof value.exported_at !== 'string'
        )
          throw new Error(
            t(
              '封存回應未包含完整帳戶收據集合。',
              'Archive response does not contain the complete account receipt set.',
            ),
          )
        const accepted = { key, value, text }
        preparedRef.current = accepted
        setPrepared(accepted)
      } else {
        if (!safePreflight(value) || typeof value.checked_at !== 'string')
          throw new Error(t('預檢回應格式不符。', 'Preflight response shape mismatch.'))
        setChecked({ key, draft: submitted, value })
      }
    } catch (cause) {
      if (!controller.signal.aborted && identity.current === key)
        setError({ key, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (operation.current?.controller === controller) {
        operation.current = null
        setBusy(null)
      }
    }
  }

  function download() {
    if (
      !enabled ||
      !bundle ||
      preparedRef.current !== bundle ||
      busy ||
      operation.current ||
      bundle.key !== identity.current
    )
      return
    let url: string | null = null
    let anchor: HTMLAnchorElement | null = null
    try {
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      url = URL.createObjectURL(new Blob([bundle.text], { type: 'application/json;charset=utf-8' }))
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `execution-study-receipt-archive-${safe(accountId)}-${safe(bundle.value.as_of)}-${bundle.value.checksum.slice(0, 12)}.json`
      document.body.appendChild(anchor)
      anchor.click()
    } catch {
      setError({
        key,
        message: t('研究收據封存檔無法下載。', 'Research receipt archive could not be downloaded.'),
      })
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
      className="execution-study-receipt-archive"
      aria-label={t('執行研究收據封存與預檢', 'Execution study receipt archive and preflight')}
    >
      <h4>{t('執行研究收據封存與預檢', 'Execution study receipt archive and preflight')}</h4>
      <p className="research-note">
        {t(
          '完整匯出此帳戶跨提案保存的成交量 DAY、開盤限價 DAY 與 GTD 研究收據；預檢只核對結構與相容性。尚未實作預覽匯入，不還原、刪除或重跑研究。每帳戶 50 筆、全域 250 筆滿額仍拒絕新增。',
          'Exports all saved volume DAY, open-only limit DAY and GTD study receipts across proposals for this account; preflight checks structure and compatibility only. Preview import is not implemented; no restoration, deletion or study rerun. New saves remain rejected at 50 receipts per account or 250 globally.',
        )}
      </p>
      <div className="receipt-archive-actions">
        <button type="button" disabled={!enabled || !!busy} onClick={() => void perform('prepare')}>
          {t('準備完整執行研究收據封存', 'Prepare complete execution study receipt archive')}
        </button>
        <button type="button" disabled={!enabled || !!busy || !bundle} onClick={download}>
          {t('下載完整執行研究收據封存', 'Download complete execution study receipt archive')}
        </button>
      </div>
      {busy && (
        <p role="status">
          {busy === 'prepare'
            ? t('正在讀取完整本機收據集合…', 'Reading the complete local receipt set…')
            : t('正在執行唯讀封存預檢…', 'Running read-only archive preflight…')}
        </p>
      )}
      {error?.key === key && (
        <p role="alert" className="notice">
          {error.message}
        </p>
      )}
      {bundle && (
        <div className="receipt-archive-summary">
          <p>
            {t('已封存收據', 'Archived receipts')} {count(bundle.value.coverage.exported)} /{' '}
            {count(bundle.value.coverage.account_total)} ·{' '}
            {t('原始內容完整', 'Raw content complete')} {count(bundle.value.coverage.raw_complete)}{' '}
            · {t('完整性可核對', 'Integrity verifiable')} {count(bundle.value.coverage.verified)} ·{' '}
            {t('完整性不可用', 'Integrity unavailable')} {count(bundle.value.coverage.unavailable)}
          </p>
          <p>
            {t('封存讀取時間', 'Archive read at')} {dateTime(bundle.value.exported_at)} ·{' '}
            {bundle.value.as_of}
          </p>
          <p>
            {t('封存 SHA-256', 'Archive SHA-256')} <code>{bundle.value.checksum}</code>
          </p>
          <p className="muted">
            {t(
              '下載原始伺服器回應文字，保留每格儲存型別、原值、缺值與損壞內容。原始內容完整不代表證據可驗證；校驗值不是簽章或來源真實性的證明。',
              'Downloads the original server response text with cell storage types, values, missing values and corrupt content. Complete raw content does not mean verifiable evidence; checksums are not signatures or proof of authenticity.',
            )}
          </p>
        </div>
      )}
      <div className="receipt-archive-draft">
        <label htmlFor={`${fieldId}-file`}>
          {t('選取本機封存 JSON（最多 32 MiB）', 'Choose local archive JSON (up to 32 MiB)')}
        </label>
        <input
          id={`${fieldId}-file`}
          type="file"
          accept=".json,application/json"
          onChange={(event) => chooseFile(event.target.files?.[0])}
        />
        {fileName && <p className="muted">{fileName}</p>}
        <label htmlFor={`${fieldId}-text`}>
          {t('或貼上完整封存 JSON', 'Or paste complete archive JSON')}
        </label>
        <textarea
          id={`${fieldId}-text`}
          rows={6}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          spellCheck={false}
        />
        <p className="muted">
          {t(
            '檔案只讀入此草稿；按下預檢才送至本機 API。帳戶或版本改變會撤下舊結果並保留草稿；預檢只接受同一帳戶。',
            'Files are read into this draft only; the local API receives it when you request preflight. Account or version changes clear old results and preserve the draft. Preflight accepts the same account only.',
          )}
        </p>
        <button
          type="button"
          disabled={!enabled || !!busy || readingFile || !draft.trim()}
          onClick={() => void perform('preflight')}
        >
          {t('唯讀預檢封存檔', 'Preflight archive read-only')}
        </button>
      </div>
      {report && (
        <div
          className="receipt-archive-preflight"
          aria-label={t('封存預檢結果', 'Archive preflight result')}
        >
          <h4>
            {report.compatible
              ? t('封存結構相容', 'Archive structure compatible')
              : t('封存相容性受阻', 'Archive compatibility blocked')}
          </h4>
          <p>
            {t('已檢查收據', 'Receipts checked')} {count(report.coverage.checked)} /{' '}
            {count(report.coverage.declared)} · {t('相容收據', 'Compatible receipts')}{' '}
            {count(report.coverage.compatible)} · {t('不可用收據', 'Unavailable receipts')}{' '}
            {count(report.coverage.unavailable)}
          </p>
          {report.reasons.map((code) => (
            <p className="notice" key={code}>
              {reason(code, t)}
            </p>
          ))}
          <p>
            {t('預檢時間', 'Preflight at')} {dateTime(report.checked_at)} ·{' '}
            {t('封存條件比對', 'Archive context comparison')} ·{' '}
            {currentness(report.snapshot_currentness, t)}
          </p>
          <p>
            {t('來源當期', 'Sources current')}{' '}
            {report.records.filter((record) => record.currentness.current === true).length} ·{' '}
            {t('來源過期', 'Sources stale')}{' '}
            {report.records.filter((record) => record.currentness.current === false).length} ·{' '}
            {t('來源狀態未知', 'Source state unknown')}{' '}
            {report.records.filter((record) => record.currentness.current === null).length}
          </p>
          {report.snapshot_currentness.reasons.length > 0 && (
            <p className="muted">
              {report.snapshot_currentness.reasons.map((code) => reason(code, t)).join(' · ')}
            </p>
          )}
          {report.archive_context && (
            <p className="muted">
              {t('封存帳戶版本', 'Archived account version')}{' '}
              {count(report.archive_context.account_version)} →{' '}
              {t('目前帳戶版本', 'Current account version')} {count(report.account_version)} ·{' '}
              {t('封存交易日', 'Archived session')} {report.archive_context.as_of}
            </p>
          )}
          {report.capacity && (
            <p>
              {t('帳戶容量', 'Account capacity')} {count(report.capacity.account_used)} /{' '}
              {count(report.capacity.account_limit)} · {t('全域容量', 'Global capacity')}{' '}
              {count(report.capacity.global_used)} / {count(report.capacity.global_limit)} ·{' '}
              {t('本機尚無紀錄', 'Records absent locally')} {count(report.capacity.absent_locally)}{' '}
              · {t('識別未知', 'Unknown identities')} {count(report.capacity.unknown_identities)}
            </p>
          )}
          {report.capacity && (
            <p>
              {t('帳戶剩餘容量', 'Account capacity remaining')}{' '}
              {count(report.capacity.account_remaining)} ·{' '}
              {t('全域剩餘容量', 'Global capacity remaining')}{' '}
              {count(report.capacity.global_remaining)} ·{' '}
              {t(
                '計入缺少紀錄後的帳戶／全域筆數',
                'Projected account / global count including absent records',
              )}{' '}
              {count(report.capacity.projected_account_total)} /{' '}
              {count(report.capacity.projected_global_total)}
            </p>
          )}
          <ArchivePreflightRecords
            records={report.records}
            resultIdentity={report}
            csvReport={report}
            t={t}
          >
            {(record) => (
              <>
                <p>
                  {receiptKind(record.kind, t)} · {duplicate(record.duplicate, t)}
                </p>
                <p>
                  {t('來源提案', 'Source proposal')} <code>{record.proposal_id ?? '—'}</code>
                </p>
                <p>
                  {t('原始研究狀態', 'Original research status')} ·{' '}
                  {diagnostic(record.diagnostic_status, t)}
                </p>
                <p>
                  {t('封存時來源狀態', 'Source state at export')} ·{' '}
                  {currentness(record.archived_currentness, t)} →{' '}
                  {t('本次來源狀態', 'Source state at preflight')} ·{' '}
                  {currentness(record.currentness, t)}
                </p>
                {[...record.reasons, ...record.currentness.reasons]
                  .filter((code, index, values) => values.indexOf(code) === index)
                  .map((code) => (
                    <p key={code} className="muted">
                      {reason(code, t)}
                    </p>
                  ))}
              </>
            )}
          </ArchivePreflightRecords>
          <p className="research-note">
            {t(
              '相容只表示此版本能核對保存內容；原始執行研究情境可能不完整或不可用。來源當期狀態另外呈現。預檢不是匯入承諾、備份還原、研究通過或交易就緒，也不會騰出容量。',
              'Compatibility only means this version can verify the saved content; original execution-study scenarios may be incomplete or unavailable. Source currentness is separate. Preflight is not an import commitment, backup restoration, research approval or trading readiness, and does not free capacity.',
            )}
          </p>
        </div>
      )}
    </section>
  )
}
