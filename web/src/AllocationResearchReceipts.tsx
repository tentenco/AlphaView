import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import type { PaperAccount } from './paper-model'
import type { AllocationResearchEvidence } from './AllocationResearch'
import { dateTime } from './ui'
import { AllocationReceiptComparison } from './AllocationReceiptComparison'
import { AllocationReceiptArchive } from './AllocationReceiptArchive'

type Translate = (zh: string, en: string) => string
export type ResearchReceipt = {
  id: string
  account_id: string
  run_id: string
  created_at: string
  engine_version: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
  status: string | null
  as_of: string | null
  lookback_sessions: number | null
  replayed?: boolean
  receipt?: {
    account_context: { account_id: string; version: number; symbol_policy: { version: number } }
    source_context: {
      agent_run_id: string
      account_binding: string
      input_revision: string
      proposal_fingerprint: string
    }
    evidence: AllocationResearchEvidence
  } | null
}
type History = {
  account_id: string
  items: ResearchReceipt[]
  pagination: { offset: number; total: number; returned: number; limit: number }
}
const fingerprint = /^[a-f0-9]{64}$/

export function AllocationResearchReceipts({
  account,
  run,
  evidence,
  canSave,
  t,
  renderEvidence,
}: {
  account: PaperAccount
  run: AgentRun
  evidence: AllocationResearchEvidence | null
  canSave: boolean
  t: Translate
  renderEvidence: (value: AllocationResearchEvidence) => ReactNode
}) {
  const [history, setHistory] = useState<History | null>(null)
  const [selected, setSelected] = useState<ResearchReceipt | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operation = useRef<AbortController | null>(null)
  const accountRef = useRef(account.id)
  accountRef.current = account.id
  const source = JSON.stringify([
    account.id,
    account.version,
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    evidence?.evidence_fingerprint,
    canSave,
  ])
  const sourceRef = useRef(source)
  sourceRef.current = source
  const base = `/api/paper/accounts/${encodeURIComponent(account.id)}/allocation-research-receipts`
  useEffect(() => {
    setHistory(null)
    setSelected(null)
    setError('')
    setNotice('')
    setBusy(null)
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [account.id])
  const validEvidence =
    !!evidence &&
    fingerprint.test(evidence.evidence_fingerprint) &&
    evidence.agent_run_id === run.id &&
    evidence.proposal_fingerprint === run.proposal_fingerprint &&
    evidence.input_revision === run.input_revision &&
    evidence.as_of === run.as_of
  async function request<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      cache: 'no-store',
      signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    const value = await response.json()
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? t(
              '來源或保存條件已變更，或收據已達保留上限；保留目前畫面，請重新核對。',
              'The source or save conditions changed, or receipt capacity was reached. The current view is preserved; recheck before saving.',
            )
          : (value.detail?.message ??
              t('研究收據無法讀取或保存。', 'The research receipt could not be read or saved.')),
      )
    return value as T
  }
  async function perform(kind: string, work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        accountRef.current === account.id &&
        (kind !== 'save' || sourceRef.current === source)
      )
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(null)
      }
    }
  }
  const validReply = (value: ResearchReceipt) =>
    value.account_id === account.id && fingerprint.test(value.id)
  const exportable =
    !!selected &&
    validReply(selected) &&
    selected.integrity.available &&
    fingerprint.test(selected.content_fingerprint) &&
    !!selected.receipt &&
    selected.receipt.account_context.account_id === selected.account_id &&
    selected.receipt.source_context.agent_run_id === selected.run_id &&
    selected.receipt.evidence.agent_run_id === selected.run_id &&
    selected.receipt.source_context.proposal_fingerprint ===
      selected.receipt.evidence.proposal_fingerprint &&
    selected.receipt.source_context.input_revision === selected.receipt.evidence.input_revision &&
    selected.as_of === selected.receipt.evidence.as_of &&
    selected.lookback_sessions === selected.receipt.evidence.request.lookback_sessions &&
    fingerprint.test(selected.receipt.evidence.evidence_fingerprint)
  function exportReceipt() {
    if (!exportable || !selected || accountRef.current !== selected.account_id) return
    // Serialize the selected server envelope, including fields unknown to this UI.
    const blob = new Blob([JSON.stringify(selected, null, 2) + '\n'], {
      type: 'application/json;charset=utf-8',
    })
    const objectURL = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectURL
    anchor.download = `allocation-research-receipt-${selected.id}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(objectURL), 10000)
  }
  function load(offset = 0) {
    void perform('history', async (signal) => {
      const value = await request<History>(`${base}?limit=20&offset=${offset}`, signal)
      if (signal.aborted || accountRef.current !== account.id) return
      if (value.account_id !== account.id || !value.items.every(validReply))
        throw new Error(t('收據帳戶識別不一致。', 'Receipt account identity does not match.'))
      setHistory(value)
    })
  }
  function open(id: string) {
    void perform('detail', async (signal) => {
      const value = await request<ResearchReceipt>(`${base}/${encodeURIComponent(id)}`, signal)
      if (signal.aborted || accountRef.current !== account.id) return
      if (!validReply(value) || value.id !== id)
        throw new Error(t('收據識別不一致。', 'Receipt identity does not match.'))
      setSelected(value)
    })
  }
  function save() {
    if (!canSave || !validEvidence || !evidence) return
    void perform('save', async (signal) => {
      const value = await request<ResearchReceipt>(base, signal, {
        run_id: run.id,
        expected_account_version: account.version,
        expected_proposal_fingerprint: run.proposal_fingerprint,
        expected_input_revision: run.input_revision,
        expected_as_of: run.as_of,
        lookback_sessions: evidence.request.lookback_sessions,
        expected_evidence_fingerprint: evidence.evidence_fingerprint,
      })
      if (signal.aborted || accountRef.current !== account.id || sourceRef.current !== source)
        return
      if (
        !validReply(value) ||
        value.run_id !== run.id ||
        (value.integrity.available &&
          (value.receipt?.evidence.evidence_fingerprint !== evidence.evidence_fingerprint ||
            value.receipt?.account_context.version !== account.version))
      )
        throw new Error(t('收據識別不一致。', 'Receipt identity does not match.'))
      setSelected(value)
      setHistory(null)
      setNotice(
        value.replayed
          ? t(
              '已回放原有收據；沒有新增紀錄。',
              'The original receipt was replayed; no new record was added.',
            )
          : t('研究收據已保存。', 'Research receipt saved.'),
      )
    })
  }
  const currentLabel = (value: ResearchReceipt) =>
    value.currentness.current === null
      ? t('目前條件無法核對', 'Current context unverifiable')
      : value.currentness.current
        ? t('本次核對仍當期', 'Current at this read')
        : t('歷史條件已過期', 'Historical context is stale')
  return (
    <section className="agent-panel" aria-label={t('配置研究收據', 'Allocation research receipts')}>
      <h3>{t('配置研究收據', 'Allocation research receipts')}</h3>
      <p className="research-note">
        {t(
          '保存伺服器重建的研究快照，僅供日後檢閱；不套用配置、不建立提案或委託。帳戶條件是檢閱脈絡，不會改變研究權重。',
          'Saves a server-rebuilt research snapshot for later review; it does not apply weights or create proposals or orders. Account context is for review and does not change research weights.',
        )}
      </p>
      <div className="actions">
        <button className="button" disabled={!!busy || !canSave || !validEvidence} onClick={save}>
          {busy === 'save'
            ? t('保存收據…', 'Saving receipt…')
            : t('保存目前研究收據', 'Save current research receipt')}
        </button>
        <button className="button" disabled={!!busy} onClick={() => load()}>
          {t('讀取帳戶收據歷史', 'Load account receipt history')}
        </button>
      </div>
      <p>
        {t(
          '每帳戶最多 50 筆、全域最多 500 筆，每筆 256 KiB；達上限會拒絕新增，不自動刪除。歷史只讀取已保存值，不重新計算。',
          'Up to 50 receipts per account, 500 globally and 256 KiB each; capacity refuses new saves without automatic deletion. History reads saved values without recalculating.',
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {history && (
        <>
          <p>
            {t('帳戶歷史筆數', 'Account history count')}: {history.pagination.total}
          </p>
          {!history.items.length ? (
            <p>{t('此頁沒有研究收據。', 'No research receipts on this page.')}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('保存時間', 'Saved at')}</th>
                    <th>{t('來源交易日', 'Source session')}</th>
                    <th>{t('回看交易日', 'Lookback sessions')}</th>
                    <th>{t('當期核對', 'Currentness')}</th>
                    <th>{t('操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.items.map((item) => (
                    <tr key={item.id}>
                      <td>{dateTime(item.created_at)}</td>
                      <td>{item.as_of ?? '—'}</td>
                      <td>{item.lookback_sessions ?? '—'}</td>
                      <td>
                        {item.integrity.available
                          ? currentLabel(item)
                          : t('收據證據不可用', 'Receipt evidence unavailable')}
                      </td>
                      <td>
                        <button className="button" disabled={!!busy} onClick={() => open(item.id)}>
                          {t('檢閱收據', 'Review receipt')}
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
                history.pagination.offset + history.pagination.returned >= history.pagination.total
              }
              onClick={() => load(history.pagination.offset + 20)}
            >
              {t('下一頁', 'Next page')}
            </button>
          </div>
        </>
      )}
      <AllocationReceiptComparison
        accountId={account.id}
        history={history?.items ?? []}
        selected={exportable ? selected : null}
        disabled={!!busy}
        t={t}
      />
      {selected && (
        <section aria-label={t('歷史研究收據明細', 'Historical research receipt details')}>
          <h4>{t('已保存的歷史值', 'Saved historical values')}</h4>
          <div className="actions">
            <button className="button" disabled={!!busy || !exportable} onClick={exportReceipt}>
              {t('匯出所選收據 JSON', 'Export selected receipt JSON')}
            </button>
          </div>
          <p className="research-note">
            {t(
              '匯出所選收據的完整回傳內容與當次核對狀態，不重新讀取或計算；證據不可用或識別不符時無法匯出。',
              'Exports the complete selected receipt and its currentness at that read, without refetching or recalculating. Unavailable evidence or mismatched identity cannot be exported.',
            )}
          </p>
          <p>
            {dateTime(selected.created_at)} · {currentLabel(selected)} ·{' '}
            {selected.currentness.reasons.join(', ') || '—'}
          </p>
          <p className="workflow-json">
            {t('收據內容指紋', 'Receipt content fingerprint')}: {selected.content_fingerprint}
          </p>
          <p className="workflow-json">
            {t('來源工作流', 'Source workflow')}: {selected.run_id}
          </p>
          <p>
            {t(
              '當期標示只反映這次讀取；歷史值不因過期而被重算。',
              'Currentness reflects this read only; stale historical values are never recalculated.',
            )}
          </p>
          {selected.integrity.available && selected.receipt ? (
            <>
              <p>
                {t('保存時帳戶版本', 'Saved account version')}:{' '}
                {selected.receipt.account_context.version} ·{' '}
                {t('允許標的政策版本', 'Symbol-policy version')}:{' '}
                {selected.receipt.account_context.symbol_policy.version}
              </p>
              <p>
                {selected.receipt.source_context.account_binding === 'workflow_bound'
                  ? t(
                      '來源工作流已綁定帳戶政策。',
                      'The source workflow was bound to account policy.',
                    )
                  : t(
                      '帳戶僅關聯這份研究以便檢閱；原工作流未綁定此帳戶。',
                      'The account is associated for review only; the original workflow was not bound to it.',
                    )}
              </p>
              <details>
                <summary>{t('保存時帳戶條件', 'Saved account context')}</summary>
                <pre className="workflow-json">
                  {JSON.stringify(selected.receipt.account_context, null, 2)}
                </pre>
              </details>
              {renderEvidence(selected.receipt.evidence)}
            </>
          ) : (
            <p role="alert">
              {t(
                '收據證據不可用；不顯示無法驗證的結果。',
                'Receipt evidence is unavailable; unverifiable results are not displayed.',
              )}{' '}
              {selected.integrity.reason ?? '—'}
            </p>
          )}
        </section>
      )}
      <AllocationReceiptArchive
        account={account}
        t={t}
        sourceIdentity={JSON.stringify([source, selected?.id, history?.pagination.total])}
      />
    </section>
  )
}
