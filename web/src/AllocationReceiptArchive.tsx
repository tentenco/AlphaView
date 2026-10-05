import { ArchivePreflightRecords } from './ArchivePreflightRecords'
import { useEffect, useId, useRef, useState } from 'react'
import type { PaperAccount } from './paper-model'
import { dateTime } from './ui'
import './allocation-receipt-archive.css'

type Translate = (zh: string, en: string) => string
const ENGINE = 'alphaview-allocation-receipt-archive-v1'
const MAX_BYTES = 32 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
type Policy = {
  read_only: true
  import_authorized: false
  delete_authorized: false
  execution_source: false
}
type Currentness = { current: boolean | null; reasons: string[] }
export type ReceiptArchive = {
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
    integrity_available: number
    integrity_unavailable: number
  }
}
export type ArchivePreflight = {
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
    absent_locally: number
    account_remaining: number
    global_remaining: number
    automatic_deletion: false
    import_authorized: false
  } | null
  records: {
    id: string | null
    content_fingerprint: string | null
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
    archive_json_invalid: t('封存內容不是有效 UTF-8 JSON', 'Archive is not valid UTF-8 JSON'),
    nonfinite_json: t('JSON 含非有限數值', 'JSON contains a nonfinite number'),
    duplicate_json_key: t('JSON 含重複欄位', 'JSON contains duplicate keys'),
    archive_shape_invalid: t('封存欄位或資料形狀不符', 'Archive fields or shape do not match'),
    archive_version_unsupported: t('封存版本不支援', 'Archive version unsupported'),
    archive_size_limit: t('封存檔超過 32 MiB', 'Archive exceeds 32 MiB'),
    archive_count_limit: t(
      '封存收據超過每帳戶 50 筆上限',
      'Archive exceeds the 50-receipt account limit',
    ),
    archive_checksum_mismatch: t('封存校驗值不符', 'Archive checksum mismatch'),
    archive_account_mismatch: t('封存檔屬於其他帳戶', 'Archive belongs to another account'),
    archive_coverage_mismatch: t(
      '封存筆數或完整集合標示不符',
      'Archive counts or full-set declaration mismatch',
    ),
    archive_records_incompatible: t('有收據未通過相容性檢查', 'Some receipts are incompatible'),
    record_columns_invalid: t('原始紀錄欄位不符', 'Raw record columns mismatch'),
    archive_content_withheld: t(
      '部分原始內容因上限或型別未保留',
      'Some raw content was withheld due to limits or storage type',
    ),
    cell_storage_unavailable: t('原始儲存型別不可用', 'Raw storage type unavailable'),
    cell_encoding_invalid: t('原始儲存格編碼無效', 'Raw cell encoding invalid'),
    cell_size_limit: t('原始儲存格超過上限', 'Raw cell exceeds its size limit'),
    cell_checksum_mismatch: t('原始儲存格校驗值不符', 'Raw cell checksum mismatch'),
    receipt_identity_invalid: t('收據識別無效', 'Receipt identity invalid'),
    duplicate_archive_identity: t(
      '封存檔內有重複收據識別',
      'Duplicate receipt identity inside archive',
    ),
    receipt_account_mismatch: t('收據屬於其他帳戶', 'Receipt belongs to another account'),
    entry_identity_mismatch: t(
      '摘要與原始紀錄識別不符',
      'Summary and raw record identities differ',
    ),
    receipt_evidence_unverifiable: t('收據證據無法驗證', 'Receipt evidence unverifiable'),
    receipt_content_changed: t('收據內容指紋不符', 'Receipt content fingerprint mismatch'),
    receipt_size_limit: t('收據內容超過 256 KiB', 'Receipt payload exceeds 256 KiB'),
    receipt_shape_unsupported: t('收據內容形狀不支援', 'Receipt content shape unsupported'),
    receipt_request_shape_invalid: t(
      '保存請求形狀或證據綁定不符',
      'Saved request shape or evidence binding mismatch',
    ),
    receipt_method_unsupported: t('收據方法版本不支援', 'Receipt method version unsupported'),
    research_method_unsupported: t('研究方法版本不支援', 'Research method version unsupported'),
    workflow_method_unsupported: t('工作流方法版本不支援', 'Workflow method version unsupported'),
    scan_method_unsupported: t('掃描方法版本不支援', 'Scan method version unsupported'),
    archived_integrity_mismatch: t(
      '封存完整性標示與重新核對不符',
      'Archived integrity label differs from verification',
    ),
    local_identity_conflict: t(
      '本機同識別收據內容衝突',
      'Local receipt with the same identity conflicts',
    ),
    archive_content_unverifiable: t('原始封存內容無法驗證', 'Raw archive content unverifiable'),
    account_not_compatible: t(
      '帳戶不相容，未核對其他帳戶來源',
      'Account incompatible; other-account sources were not checked',
    ),
    archive_unverifiable: t('封存無法驗證', 'Archive unverifiable'),
    account_version_changed: t('帳戶版本已變更', 'Account version changed'),
    inputs_changed: t('輸入資料已變更', 'Inputs changed'),
    session_changed: t('已完成交易日已變更', 'Completed session changed'),
    receipt_set_changed: t('目前帳戶收據集合不同', 'Current account receipt set differs'),
    account_context_changed: t('帳戶條件已變更', 'Account context changed'),
    workflow_missing: t('來源工作流已不存在', 'Source workflow no longer exists'),
    workflow_changed: t('來源工作流已變更', 'Source workflow changed'),
    workflow_unverifiable: t('來源工作流無法核對', 'Source workflow unverifiable'),
    context_unverifiable: t('目前來源條件無法核對', 'Current source context unverifiable'),
    receipt_unverifiable: t('收據無法驗證', 'Receipt unverifiable'),
    research_method_changed: t('研究方法已變更', 'Research method changed'),
    workflow_method_changed: t('工作流方法已變更', 'Workflow method changed'),
    scan_method_changed: t('掃描方法已變更', 'Scan method changed'),
    account_missing: t('來源帳戶已不存在', 'Source account no longer exists'),
  })[code] ?? code
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
  policy.delete_authorized === false &&
  policy.execution_source === false

export function AllocationReceiptArchive({
  account,
  t,
  sourceIdentity = '',
}: {
  account: PaperAccount
  t: Translate
  sourceIdentity?: string
}) {
  const fieldId = useId()
  const [prepared, setPrepared] = useState<{
    key: string
    value: ReceiptArchive
    text: string
  } | null>(null)
  const [checked, setChecked] = useState<{
    key: string
    draft: string
    value: ArchivePreflight
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
  const key = JSON.stringify([account.id, account.version, sourceIdentity])
  const identity = useRef(key)
  identity.current = key
  const base = `/api/paper/accounts/${encodeURIComponent(account.id)}/allocation-research-receipt-archive`
  const bundle = prepared?.key === key ? prepared : null
  const report = checked?.key === key && checked.draft === draft ? checked.value : null

  useEffect(() => {
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
    if (operation.current || (kind === 'preflight' && (!draft.trim() || fileRead.current))) return
    if (kind === 'preflight' && new TextEncoder().encode(draft).byteLength > MAX_BYTES) {
      setChecked(null)
      setError({ key, message: t('封存檔超過 32 MiB', 'Archive exceeds 32 MiB') })
      return
    }
    const controller = new AbortController()
    operation.current = { controller, kind }
    setBusy(kind)
    setError(null)
    if (kind === 'prepare') setPrepared(null)
    else setChecked(null)
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
      if (!response.ok)
        throw new Error(
          t('本機封存請求失敗', 'Local archive request failed') + ` (${response.status})`,
        )
      if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
        throw new Error(t('封存檔超過 32 MiB', 'Archive exceeds 32 MiB'))
      const value = JSON.parse(text, (_field, item: unknown) => {
        if (typeof item === 'number' && !Number.isFinite(item))
          throw new Error(t('JSON 含非有限數值', 'JSON contains a nonfinite number'))
        return item
      })
      if (
        value.engine_version !== ENGINE ||
        value.account_id !== account.id ||
        value.account_version !== account.version ||
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
          value.coverage.exported !== value.records.length
        )
          throw new Error(
            t(
              '封存回應未包含完整帳戶收據集合。',
              'Archive response does not contain the complete account receipt set.',
            ),
          )
        setPrepared({ key, value, text })
      } else {
        if (
          !['compatible', 'blocked'].includes(value.verdict) ||
          value.compatible !== (value.verdict === 'compatible') ||
          !Array.isArray(value.records)
        )
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
    if (!bundle || busy || operation.current || bundle.key !== identity.current) return
    let url: string | null = null
    let anchor: HTMLAnchorElement | null = null
    try {
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      url = URL.createObjectURL(new Blob([bundle.text], { type: 'application/json;charset=utf-8' }))
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `allocation-receipt-archive-${safe(account.id)}-${safe(bundle.value.as_of)}-${bundle.value.checksum.slice(0, 12)}.json`
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
      className="allocation-receipt-archive"
      aria-label={t('研究收據封存與預檢', 'Research receipt archive and preflight')}
    >
      <h4>{t('研究收據封存與預檢', 'Research receipt archive and preflight')}</h4>
      <p className="research-note">
        {t(
          '完整匯出此帳戶保存的收據；預檢只核對結構與相容性。沒有匯入或刪除授權，不會套用配置或建立委託。每帳戶 50 筆、全域 500 筆滿額仍拒絕新增。',
          'Exports all saved receipts for this account; preflight checks structure and compatibility only. Import and deletion are not authorized, and no allocation or order is created. New saves remain rejected at 50 receipts per account or 500 globally.',
        )}
      </p>
      <div className="receipt-archive-actions">
        <button type="button" disabled={!!busy} onClick={() => void perform('prepare')}>
          {t('準備完整帳戶封存', 'Prepare complete account archive')}
        </button>
        <button type="button" disabled={!!busy || !bundle} onClick={download}>
          {t('下載完整帳戶封存', 'Download complete account archive')}
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
            · {t('完整性可核對', 'Integrity verifiable')}{' '}
            {count(bundle.value.coverage.integrity_available)} ·{' '}
            {t('完整性不可用', 'Integrity unavailable')}{' '}
            {count(bundle.value.coverage.integrity_unavailable)}
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
              '下載原始伺服器回應文字，保留收據原值、缺值與損壞標記。完整筆數不代表每筆內容完整；校驗值不是簽章或來源真實性的證明。',
              'Downloads the original server response text with receipt values, missing values and corruption markers. A complete row count does not mean every payload is complete; checksums are not signatures or proof of authenticity.',
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
          maxLength={MAX_BYTES}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          spellCheck={false}
        />
        <p className="muted">
          {t(
            '檔案只讀入此草稿；按下預檢才送至本機 API。帳戶、版本或來源改變會撤下舊結果並保留草稿；不同帳戶不可移植。',
            'Files are read into this draft only; the local API receives it when you request preflight. Account, version or source changes clear old results and preserve the draft. Archives cannot be ported to another account.',
          )}
        </p>
        <button
          type="button"
          disabled={!!busy || readingFile || !draft.trim()}
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
            {t('來源資格未知', 'Source eligibility unknown')}{' '}
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
              {t('目前帳戶容量', 'Current account capacity')} {count(report.capacity.account_used)}{' '}
              / {count(report.capacity.account_limit)} ·{' '}
              {t('目前全域容量', 'Current global capacity')} {count(report.capacity.global_used)} /{' '}
              {count(report.capacity.global_limit)} · {t('本機尚無紀錄', 'Records absent locally')}{' '}
              {count(report.capacity.absent_locally)}
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
                <p>{duplicate(record.duplicate, t)}</p>
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
              '相容只表示此版本能核對保存內容；過期來源仍是歷史資料。預檢不是匯入承諾、備份還原、研究通過或交易就緒，不會騰出容量。',
              'Compatibility only means this version can verify the saved content; stale sources remain historical. Preflight is not an import commitment, backup restoration, research approval or trading readiness, and does not free capacity.',
            )}
          </p>
        </div>
      )}
    </section>
  )
}
