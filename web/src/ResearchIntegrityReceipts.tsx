import { useEffect, useRef, useState } from 'react'
import type { DeskIntegrityResult } from './ResearchDeskIntegrity'
import type { DeskConfig } from './research-desk-model'
import './research-integrity-receipts.css'

type Translate = (zh: string, en: string) => string
export type IntegrityReceiptRequest = {
  symbol: string
  config: DeskConfig
  test_start: string | null
  test_end: string | null
  max_prefixes: number
}
export type IntegrityReceipt = {
  id: string
  symbol: string
  created_at: string
  engine_version: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
  status: string | null
  as_of: string | null
  config: DeskConfig | null
  counts: DeskIntegrityResult['counts'] | null
  replayed?: boolean
  receipt?: {
    engine_version: string
    receipt_id: string
    created_at: string
    request: IntegrityReceiptRequest
    source_context: {
      symbol: string
      as_of: string
      input_revision: string
      history_fingerprint: string | null
      integrity_engine_version: string
      desk_engine_version: string
      request_fingerprint: string
      evidence_fingerprint: string
    }
    evidence: DeskIntegrityResult
    method: string
  } | null
}
type ReceiptList = {
  items: IntegrityReceipt[]
  pagination: { limit: number; offset: number; total: number; returned: number }
  retention: { workspace: number; max_bytes: number; automatic_deletion: boolean }
}
type Props = {
  symbol: string
  evidence: DeskIntegrityResult | null
  request: IntegrityReceiptRequest | null
  contextIdentity: string
  enabled: boolean
  t: Translate
}
const BASE = '/api/research-desk/integrity-receipts'
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, content]) => `${JSON.stringify(key)}:${stable(content)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const diagnosticLabel = (status: string | null, t: Translate) =>
  ({
    no_difference_detected: t('抽樣前綴未檢出差異', 'No differences in sampled prefixes'),
    differences_found: t('檢出前綴差異', 'Prefix differences detected'),
    unavailable: t('無法完成比較', 'Comparison unavailable'),
  })[status ?? ''] ?? '—'
const sourceLabel = (value: IntegrityReceipt, t: Translate) =>
  !value.integrity.available || value.currentness.current === null
    ? t('回條無法驗證', 'Receipt cannot be verified')
    : value.currentness.current
      ? t('讀取時來源相符', 'Sources matched when read')
      : t('歷史來源已非當期', 'Historical sources are no longer current')
const reasonLabel = (code: string, t: Translate) =>
  ({
    workspace_inputs_changed: t('工作區輸入版本已變更', 'Workspace input revision changed'),
    session_changed: t('最新完成交易日已變更', 'Latest completed session changed'),
    receipt_method_changed: t('回條方法版本已變更', 'Receipt method changed'),
    integrity_method_changed: t('前綴診斷方法已變更', 'Prefix diagnostic method changed'),
    desk_method_changed: t('研究引擎版本已變更', 'Research engine changed'),
    receipt_unverifiable: t(
      '回條內容或來源無法核對',
      'Receipt contents or sources cannot be verified',
    ),
    receipt_content_changed: t('回條內容指紋不符', 'Receipt content fingerprint mismatch'),
    receipt_size_limit: t('回條超出保存大小上限', 'Receipt exceeds the stored size limit'),
  })[code] ?? code

/** Download the server's stored bytes; do not parse-and-stringify the historical payload. */
function downloadStoredJson(text: string, receipt: IntegrityReceipt) {
  const value = JSON.parse(text)
  const finite = (item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Nonfinite receipt')
    if (item && typeof item === 'object') Object.values(item).forEach(finite)
  }
  finite(value)
  if (value.evidence?.symbol !== receipt.symbol) throw new Error('Receipt symbol mismatch')
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `alphaview-prefix-receipt-${safe(receipt.symbol)}-${safe(receipt.id)}.json`
  try {
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}

export function ResearchIntegrityReceipts({
  symbol,
  evidence,
  request,
  contextIdentity,
  enabled,
  t,
}: Props) {
  const identity = JSON.stringify([symbol, contextIdentity])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const operation = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy?: string
    error?: string
    notice?: string
    history?: ReceiptList
    selected?: IntegrityReceipt
  }>({ identity })
  const current = state.identity === identity ? state : null
  const validEvidence =
    evidence !== null &&
    request !== null &&
    evidence.symbol === symbol &&
    request.symbol === symbol &&
    evidence.request !== undefined &&
    stable(evidence.request) === stable(request) &&
    typeof evidence.evidence_fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(evidence.evidence_fingerprint)
  const canSave = enabled && validEvidence && !current?.busy
  useEffect(() => {
    setState({ identity })
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [identity])

  async function act(
    action: string,
    execute: (signal: AbortSignal) => Promise<Partial<typeof state>>,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setState((previous) => ({
      ...(previous.identity === identity ? previous : {}),
      identity,
      busy: action,
      error: '',
      notice: '',
    }))
    try {
      const next = await execute(controller.signal)
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState((previous) => ({ ...previous, ...next, identity, busy: undefined }))
    } catch (error) {
      if (!controller.signal.aborted && latestIdentity.current === identity)
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
  async function readResponse(response: Response) {
    const value = await response.json().catch(() => ({}))
    if (!response.ok)
      throw new Error(
        typeof value.detail?.message === 'string'
          ? value.detail.message
          : t('回條請求失敗，請重新讀取。', 'Receipt request failed. Load again.'),
      )
    return value
  }
  function save() {
    if (!canSave || !evidence || !request) return
    const frozen = {
      request,
      expected_input_revision: evidence.input_revision,
      expected_as_of: evidence.as_of,
      expected_evidence_fingerprint: evidence.evidence_fingerprint,
    }
    void act('save', async (signal) => {
      const value = (await readResponse(
        await fetch(BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal,
          body: JSON.stringify(frozen),
        }),
      )) as IntegrityReceipt
      if (
        value.symbol !== symbol ||
        !value.integrity.available ||
        !value.receipt ||
        stable(value.receipt.request) !== stable(frozen.request) ||
        value.receipt.source_context.evidence_fingerprint !==
          frozen.expected_evidence_fingerprint ||
        value.receipt.source_context.input_revision !== frozen.expected_input_revision ||
        value.receipt.source_context.as_of !== frozen.expected_as_of
      )
        throw new Error(
          t('保存回應與目前診斷不符', 'Saved response does not match this diagnostic'),
        )
      return {
        selected: value,
        history: undefined,
        notice: value.replayed
          ? t(
              '已讀取同一份既有回條；未重複保存。',
              'The existing receipt was replayed; no duplicate was saved.',
            )
          : t('已保存不可變前綴回條。', 'Immutable prefix receipt saved.'),
      }
    })
  }
  function loadHistory(offset = 0) {
    void act('list', async (signal) => {
      const value = (await readResponse(
        await fetch(`${BASE}?symbol=${encodeURIComponent(symbol)}&limit=20&offset=${offset}`, {
          cache: 'no-store',
          signal,
        }),
      )) as ReceiptList
      if (!Array.isArray(value.items) || value.items.some((item) => item.symbol !== symbol))
        throw new Error(t('歷史清單與目前標的不符', 'Receipt history does not match this symbol'))
      return { history: value }
    })
  }
  function loadReceipt(identifier: string) {
    void act('detail', async (signal) => {
      const value = (await readResponse(
        await fetch(`${BASE}/${encodeURIComponent(identifier)}`, { cache: 'no-store', signal }),
      )) as IntegrityReceipt
      if (value.id !== identifier || value.symbol !== symbol)
        throw new Error(t('歷史回條識別不符', 'Historical receipt identity mismatch'))
      return { selected: value }
    })
  }
  function download() {
    const selected = current?.selected
    if (!selected?.integrity.available || !selected.receipt) return
    void act('download', async (signal) => {
      const response = await fetch(
        `${BASE}/${encodeURIComponent(selected.id)}/evidence.json?expected_content_fingerprint=${encodeURIComponent(selected.content_fingerprint)}`,
        { cache: 'no-store', signal },
      )
      if (!response.ok) await readResponse(response)
      const text = await response.text()
      if (signal.aborted || latestIdentity.current !== identity) return {}
      downloadStoredJson(text, selected)
      return {}
    })
  }
  const selected = current?.selected
  const preserved = selected?.integrity.available ? selected.receipt : null
  const historical = preserved?.evidence
  const requestDiffers = !!preserved && !!request && stable(preserved.request) !== stable(request)
  return (
    <section
      className="integrity-receipts"
      aria-label={t('保存的前綴診斷回條', 'Saved prefix diagnostic receipts')}
    >
      <h4>{t('保存與重讀抽樣前綴證據', 'Save and reread sampled prefix evidence')}</h4>
      <p className="desk-meta">
        {t(
          '保存時伺服器會重算並核對這次證據；歷史回條不覆寫、不自動刪除。未檢出差異仍不是無洩漏或獲利證明。',
          'The server recomputes and checks this evidence before saving. Historical receipts are never overwritten or automatically deleted. No detected difference is still not proof of absence of leakage or of profitability.',
        )}
      </p>
      <div className="actions">
        <button className="button" type="button" disabled={!canSave} onClick={save}>
          {current?.busy === 'save'
            ? t('核對並保存中…', 'Checking and saving…')
            : t('保存這次前綴回條', 'Save this prefix receipt')}
        </button>
        <button
          className="button"
          type="button"
          disabled={!!current?.busy}
          onClick={() => loadHistory()}
        >
          {current?.busy === 'list'
            ? t('讀取回條中…', 'Loading receipts…')
            : t('讀取此標的回條歷史', 'Load receipt history for this symbol')}
        </button>
      </div>
      {!validEvidence && (
        <p className="desk-meta">
          {t(
            '先完成一次帶有證據指紋的前綴比較，才能保存。',
            'Complete a prefix comparison with an evidence fingerprint before saving.',
          )}
        </p>
      )}
      {current?.error && (
        <p className="error-message" role="alert">
          {current.error}
        </p>
      )}
      {current?.notice && (
        <p className="notice" role="status">
          {current.notice}
        </p>
      )}
      {current?.history && (
        <>
          <p className="desk-meta">
            {t('此標的回條數', 'Receipts for this symbol')}: {current.history.pagination.total} ·{' '}
            {t('工作區保留上限', 'Workspace retention limit')}:{' '}
            {current.history.retention.workspace}
          </p>
          {current.history.items.length === 0 ? (
            <p>{t('尚無此標的的保存回條。', 'No saved receipts for this symbol.')}</p>
          ) : (
            <div className="table-scroll">
              <table aria-label={t('前綴回條歷史', 'Prefix receipt history')}>
                <thead>
                  <tr>
                    {[
                      t('保存時間', 'Saved at'),
                      t('保存設定', 'Saved configuration'),
                      t('當次診斷', 'Recorded diagnostic'),
                      t('來源資格', 'Source eligibility'),
                      t('讀取', 'Load'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.history.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.created_at}</td>
                      <td>{item.config?.strategy ?? '—'}</td>
                      <td>{diagnosticLabel(item.status, t)}</td>
                      <td>{sourceLabel(item, t)}</td>
                      <td>
                        <button
                          className="button"
                          type="button"
                          disabled={!!current.busy}
                          onClick={() => loadReceipt(item.id)}
                          aria-label={`${t('讀取回條', 'Load receipt')} ${item.id.slice(0, 12)}`}
                        >
                          {t('讀取回條', 'Load receipt')}
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
              type="button"
              className="button"
              disabled={!!current.busy || current.history.pagination.offset === 0}
              onClick={() => loadHistory(Math.max(0, current.history!.pagination.offset - 20))}
            >
              {t('較新回條', 'Newer receipts')}
            </button>
            <button
              type="button"
              className="button"
              disabled={
                !!current.busy ||
                current.history.pagination.offset + current.history.items.length >=
                  current.history.pagination.total
              }
              onClick={() => loadHistory(current.history!.pagination.offset + 20)}
            >
              {t('較舊回條', 'Older receipts')}
            </button>
          </div>
        </>
      )}
      {selected && (
        <div
          className="integrity-receipt-detail"
          aria-label={t('保存回條明細', 'Saved receipt detail')}
        >
          <h5>{t('當時保存的診斷', 'Diagnostic recorded at that time')}</h5>
          <p>
            {selected.symbol} · {selected.created_at} · {selected.as_of ?? '—'}
          </p>
          <p role="status">{sourceLabel(selected, t)}</p>
          {!!selected.currentness.reasons.length && (
            <ul>
              {selected.currentness.reasons.map((reason) => (
                <li key={reason}>{reasonLabel(reason, t)}</li>
              ))}
            </ul>
          )}
          {!selected.integrity.available && (
            <p className="notice">
              {t(
                '回條內容無法驗證，歷史診斷與下載均不可用；不會重建或覆寫。',
                'The receipt cannot be verified. Its diagnostic and download are unavailable; it will not be rebuilt or overwritten.',
              )}
            </p>
          )}
          {preserved && historical && (
            <>
              <p>{diagnosticLabel(historical.status, t)}</p>
              <p>
                {t('保存設定', 'Saved configuration')}:{' '}
                <code>{stable(preserved.request.config)}</code>
              </p>
              <p>
                {t('保存比較區間', 'Saved comparison window')}:{' '}
                {preserved.request.test_start ?? '—'} → {preserved.request.test_end ?? '—'} ·{' '}
                {t('最多切點', 'Maximum cutoffs')}: {preserved.request.max_prefixes}
              </p>
              {requestDiffers && (
                <p className="notice">
                  {t(
                    '這份回條的設定與目前比較請求不同；讀取歷史不會套用或修改表單。',
                    'This receipt has a different request from the current comparison. Reading history does not apply it or change the form.',
                  )}
                </p>
              )}
              <p>
                {t('已比較切點', 'Cutoffs compared')}: {historical.counts.prefixes} ·{' '}
                {t('差異', 'Differences')}: {historical.counts.differences} ·{' '}
                {t('缺值', 'Missing values')}: {historical.counts.unavailable_values}
              </p>
              {!!historical.unavailable.length && (
                <ul>
                  {historical.unavailable.map((reason, index) => (
                    <li key={index}>
                      {reason.message} ({reason.code})
                    </li>
                  ))}
                </ul>
              )}
              {!!historical.prefixes.length && (
                <div className="table-scroll">
                  <table aria-label={t('保存的各切點結果', 'Saved results by cutoff')}>
                    <thead>
                      <tr>
                        {[
                          t('保留至', 'Retained through'),
                          t('比較日期數', 'Dates compared'),
                          t('差異數', 'Differences'),
                          t('當次診斷', 'Recorded diagnostic'),
                        ].map((label) => (
                          <th key={label} scope="col">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {historical.prefixes.map((prefix) => (
                        <tr key={prefix.cutoff_date}>
                          <th scope="row">{prefix.cutoff_date}</th>
                          <td>{prefix.compared_sessions}</td>
                          <td>{prefix.difference_count}</td>
                          <td>{diagnosticLabel(prefix.status, t)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button
                className="button"
                type="button"
                disabled={!!current?.busy}
                onClick={download}
              >
                {current?.busy === 'download'
                  ? t('下載回條中…', 'Downloading receipt…')
                  : t('下載保存回條原始 JSON', 'Download original saved receipt JSON')}
              </button>
              <details>
                <summary>{t('保存來源與方法', 'Saved sources and method')}</summary>
                <p>
                  {preserved.source_context.integrity_engine_version} ·{' '}
                  {preserved.source_context.desk_engine_version}
                </p>
                <p>
                  {t('保存輸入版本', 'Saved input revision')}:{' '}
                  {preserved.source_context.input_revision}
                </p>
                <p>
                  {t('保存歷史指紋', 'Saved history fingerprint')}:{' '}
                  <code>{preserved.source_context.history_fingerprint ?? '—'}</code>
                </p>
                <p>
                  {t('回條內容指紋', 'Receipt content fingerprint')}:{' '}
                  <code>{selected.content_fingerprint}</code>
                </p>
                <p>{historical.method}</p>
                <p>{preserved.method}</p>
              </details>
            </>
          )}
          <p className="desk-meta">
            {t(
              '來源資格只描述此次讀取；工作區版本變更不代表此標的日線必然改變。歷史值保留原樣，下載不會重新計算，也不保證日後來源相同。',
              'Source eligibility describes this read only. A workspace revision change does not necessarily mean this symbol’s bars changed. Historical values remain intact; downloading does not recompute or guarantee future freshness.',
            )}
          </p>
        </div>
      )}
    </section>
  )
}
