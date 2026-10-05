import { useEffect, useRef, useState } from 'react'
import type { LocalAgentRun } from './local-agent-model'
import { newPaperKey, type PaperAccount } from './paper-model'
import './local-agent-review.css'

const VERSION = 'alphaview-local-agent-review-v1'
const REASONS = [
  'evidence_uncertain',
  'source_stale',
  'model_limitations',
  'allocation_concern',
  'insufficient_information',
] as const
type Reason = (typeof REASONS)[number]
type ReviewState = 'review_required' | 'reviewed' | 'rejected'
type Translator = (zh: string, en: string) => string
type Program = {
  integrity_version: string
  evidence_status: 'verified' | 'failed' | 'unavailable'
  verified: boolean
  source_currentness: { current: boolean; stale_reasons: string[] }
  proposal_eligible: boolean
  paper_preview_required: true
  validation_issues: string[]
  uncertainty_codes: string[]
}
type Binding = {
  engine_version: string
  account_id: string
  account_version: number
  analysis_id: string
  analysis_engine_version: string
  source_run_id: string
  as_of: string
  input_revision: string
  analysis_content_fingerprint: string
  rule_content_fingerprint: string | null
  program: Program
}
export type ReviewEvent = {
  id: string
  account_id: string
  analysis_id: string
  version: number
  created_at: string
  engine_version: string
  binding_fingerprint: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  receipt: null | {
    id: string
    engine_version: string
    account_id: string
    analysis_id: string
    version: number
    created_at: string
    binding_fingerprint: string
    binding: Binding
    state: ReviewState
    reason_codes: Reason[]
  }
}
export type ReviewContext = {
  engine_version: string
  account_id: string
  analysis_id: string
  binding: Binding
  binding_fingerprint: string
  program: Program
  can_review: boolean
  unavailable_reason: string | null
  version: number
  latest: ReviewEvent | null
  effective_state: ReviewState
  review_current: boolean
  review_reason: string | null
}
type History = {
  engine_version: string
  account_id: string
  analysis_id: string
  items: ReviewEvent[]
  pagination: { limit: number; offset: number; total: number; returned: number }
}
type Props = { account: PaperAccount; run: LocalAgentRun; enabled?: boolean; t: Translator }
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const validState = (value: unknown): value is ReviewState =>
  ['review_required', 'reviewed', 'rejected'].includes(String(value))
const validProgram = (value: Program) =>
  value &&
  ['verified', 'failed', 'unavailable'].includes(value.evidence_status) &&
  typeof value.verified === 'boolean' &&
  typeof value.proposal_eligible === 'boolean' &&
  value.paper_preview_required === true &&
  typeof value.source_currentness?.current === 'boolean' &&
  strings(value.source_currentness.stale_reasons) &&
  strings(value.uncertainty_codes) &&
  strings(value.validation_issues) &&
  value.verified === (value.evidence_status === 'verified') &&
  value.proposal_eligible === (value.verified && value.source_currentness.current)
const validEvent = (event: ReviewEvent, accountId: string, analysisId: string) => {
  if (
    !event ||
    event.account_id !== accountId ||
    event.analysis_id !== analysisId ||
    event.engine_version !== VERSION ||
    !Number.isInteger(event.version) ||
    event.version < 1 ||
    typeof event.id !== 'string' ||
    !event.id ||
    !fingerprint(event.content_fingerprint) ||
    !fingerprint(event.binding_fingerprint) ||
    typeof event.created_at !== 'string' ||
    !event.integrity
  )
    return false
  if (event.integrity.available === false) return event.receipt === null
  const receipt = event.receipt
  return (
    event.integrity.available === true &&
    !!receipt &&
    receipt.id === event.id &&
    receipt.account_id === accountId &&
    receipt.analysis_id === analysisId &&
    receipt.version === event.version &&
    receipt.engine_version === VERSION &&
    receipt.created_at === event.created_at &&
    receipt.binding_fingerprint === event.binding_fingerprint &&
    validState(receipt.state) &&
    Array.isArray(receipt.reason_codes) &&
    receipt.reason_codes.every((code) => REASONS.includes(code)) &&
    receipt.binding?.account_id === accountId &&
    receipt.binding.analysis_id === analysisId &&
    validProgram(receipt.binding.program)
  )
}
function stateLabel(state: ReviewState, t: Translator) {
  return state === 'reviewed'
    ? t('已檢閱', 'Reviewed')
    : state === 'rejected'
      ? t('人工不採納', 'Rejected by reviewer')
      : t('待檢閱', 'Review required')
}
function reasonLabel(reason: Reason, t: Translator) {
  switch (reason) {
    case 'evidence_uncertain':
      return t('證據仍有疑慮', 'Evidence uncertainty')
    case 'source_stale':
      return t('來源已過期', 'Stale source')
    case 'model_limitations':
      return t('模型限制', 'Model limitations')
    case 'allocation_concern':
      return t('配置疑慮', 'Allocation concern')
    case 'insufficient_information':
      return t('資訊不足', 'Insufficient information')
  }
}
function ProgramEvidence({ program, t }: { program: Program; t: Translator }) {
  return (
    <div
      className="local-review-evidence"
      aria-label={t('獨立程式證據', 'Independent program evidence')}
    >
      <strong>
        {t('獨立程式證據', 'Independent program evidence')}:{' '}
        {program.evidence_status === 'verified'
          ? t('已驗證', 'Verified')
          : program.evidence_status === 'failed'
            ? t('失敗', 'Failed')
            : t('不可用', 'Unavailable')}
      </strong>
      <p>
        {t('來源狀態', 'Source status')}:{' '}
        {program.source_currentness.current
          ? t('目前有效', 'Current')
          : t('已過期或不可用', 'Stale or unavailable')}{' '}
        · {t('程式提案資格', 'Program proposal eligibility')}:{' '}
        {program.proposal_eligible
          ? t('符合；仍須獨立紙上預覽', 'Eligible; separate paper preview still required')
          : t('不符合', 'Ineligible')}
      </p>
      {program.uncertainty_codes.length > 0 && <p>{program.uncertainty_codes.join(' · ')}</p>}
      {program.validation_issues.length > 0 && <p>{program.validation_issues.join(' · ')}</p>}
    </div>
  )
}
function EventDetails({ event, t }: { event: ReviewEvent; t: Translator }) {
  const receipt = event.receipt
  return (
    <article className="local-review-event">
      <div>
        <strong>
          v{event.version} ·{' '}
          {event.integrity.available && receipt
            ? stateLabel(receipt.state, t)
            : t('歷史證據不可用', 'Historical evidence unavailable')}
        </strong>
        <span>{event.created_at}</span>
      </div>
      {!event.integrity.available || !receipt ? (
        <p role="status">{event.integrity.reason || 'review_event_unverifiable'}</p>
      ) : (
        <details>
          <summary>{t('檢視保存的檢閱依據', 'Inspect saved review context')}</summary>
          <p>
            {receipt.reason_codes.length
              ? receipt.reason_codes.map((code) => reasonLabel(code, t)).join(' · ')
              : t('未標記疑慮', 'No concerns marked')}
          </p>
          <ProgramEvidence program={receipt.binding.program} t={t} />
          <dl>
            <dt>{t('來源工作流程', 'Source workflow')}</dt>
            <dd>{receipt.binding.source_run_id}</dd>
            <dt>{t('完成交易日／輸入版本', 'Completed session / input revision')}</dt>
            <dd>
              {receipt.binding.as_of} / {receipt.binding.input_revision}
            </dd>
            <dt>{t('檢閱綁定指紋', 'Review binding fingerprint')}</dt>
            <dd>{event.binding_fingerprint}</dd>
            <dt>{t('紀錄內容指紋', 'Event content fingerprint')}</dt>
            <dd>{event.content_fingerprint}</dd>
          </dl>
        </details>
      )}
    </article>
  )
}

export function LocalAgentReview(props: Props) {
  const { account, run, enabled = true } = props
  // A new saved-analysis/source identity must not inherit a previous response or pending action.
  const identity = JSON.stringify([
    account.id,
    account.version,
    account.symbol_policy,
    account.limits,
    account.execution_policy,
    run.id,
    run.engine_version,
    run.source_run_id,
    run.current,
    run.stale_reasons,
    run.status,
    run.cancel_requested,
    run.as_of,
    run.input_revision,
    run.prompt_digest,
    run.schema_digest,
    run.result?.output_digest,
    run.target_weights,
    run.source,
    enabled,
  ])
  return <ReviewPanel key={identity} {...props} enabled={enabled} />
}
function ReviewPanel({ account, run, enabled = true, t }: Props) {
  const [context, setContext] = useState<ReviewContext | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [draftState, setDraftState] = useState<ReviewState>('review_required')
  const [reasons, setReasons] = useState<Reason[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const active = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const dirty = useRef(false)
  const replay = useRef<{ request: string; key: string } | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      controller.current?.abort()
    }
  }, [])
  const endpoint = `/api/paper/accounts/${encodeURIComponent(account.id)}/local-agent/${encodeURIComponent(run.id)}`
  const accepts = (value: ReviewContext) =>
    value &&
    value.engine_version === VERSION &&
    value.account_id === account.id &&
    value.analysis_id === run.id &&
    fingerprint(value.binding_fingerprint) &&
    value.binding?.account_id === account.id &&
    value.binding.analysis_id === run.id &&
    value.binding.account_version === account.version &&
    value.binding.source_run_id === run.source_run_id &&
    value.binding.analysis_engine_version === run.engine_version &&
    validProgram(value.program) &&
    JSON.stringify(value.program) === JSON.stringify(value.binding.program) &&
    Number.isInteger(value.version) &&
    value.version >= 0 &&
    validState(value.effective_state) &&
    typeof value.can_review === 'boolean' &&
    typeof value.review_current === 'boolean' &&
    (value.latest === null
      ? value.version === 0 && !value.review_current && value.effective_state === 'review_required'
      : validEvent(value.latest, account.id, run.id) &&
        value.latest.version === value.version &&
        (value.review_current
          ? value.latest.integrity.available &&
            value.latest.binding_fingerprint === value.binding_fingerprint &&
            value.latest.receipt?.state === value.effective_state
          : value.effective_state === 'review_required'))
  async function request(kind: 'load' | 'save' | 'history', offset = 0) {
    if (
      !enabled ||
      pending.current ||
      (kind === 'save' &&
        (!context ||
          !context.can_review ||
          (context.latest && !context.latest.integrity.available) ||
          (draftState === 'rejected' && !reasons.length)))
    )
      return
    pending.current = true
    setBusy(true)
    setError('')
    setSaved(false)
    controller.current = new AbortController()
    try {
      let body: string | undefined
      if (kind === 'save' && context) {
        const data = {
          expected_version: context.version,
          expected_account_version: context.binding.account_version,
          expected_input_revision: context.binding.input_revision,
          expected_as_of: context.binding.as_of,
          expected_binding_fingerprint: context.binding_fingerprint,
          state: draftState,
          reason_codes: [...reasons].sort(),
        }
        const canonical = JSON.stringify(data)
        if (replay.current?.request !== canonical)
          replay.current = { request: canonical, key: newPaperKey() }
        body = JSON.stringify({ ...data, idempotency_key: replay.current.key })
      }
      const response = await fetch(
        kind === 'history' ? `${endpoint}/reviews?limit=20&offset=${offset}` : `${endpoint}/review`,
        {
          method: kind === 'save' ? 'POST' : 'GET',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body,
          signal: controller.current.signal,
          cache: 'no-store',
        },
      )
      const value = await response.json()
      if (!active.current) return
      if (!response.ok) {
        if (response.status === 409) {
          setContext(null)
          replay.current = null
        }
        const code =
          typeof value?.detail?.code === 'string' ? value.detail.code : `HTTP ${response.status}`
        throw new Error(code)
      }
      if (kind === 'history') {
        const page = value as History
        if (
          page.engine_version !== VERSION ||
          page.account_id !== account.id ||
          page.analysis_id !== run.id ||
          !Array.isArray(page.items) ||
          page.items.length > 20 ||
          !page.items.every((event) => validEvent(event, account.id, run.id)) ||
          new Set(page.items.map((event) => event.id)).size !== page.items.length ||
          page.pagination?.limit !== 20 ||
          page.pagination.offset !== offset ||
          page.pagination.returned !== page.items.length ||
          !Number.isInteger(page.pagination.total) ||
          page.pagination.total < offset + page.items.length
        )
          throw new Error('review_response_identity_mismatch')
        setHistory(page)
      } else {
        if (
          !accepts(value) ||
          (kind === 'save' &&
            context &&
            (value.version !== context.version + 1 ||
              !value.review_current ||
              value.binding_fingerprint !== context.binding_fingerprint ||
              value.latest?.receipt?.state !== draftState ||
              JSON.stringify(value.latest?.receipt?.reason_codes) !==
                JSON.stringify([...reasons].sort())))
        ) {
          setContext(null)
          throw new Error('review_response_identity_mismatch')
        }
        setContext(value)
        if (!dirty.current || kind === 'save') {
          setDraftState(value.effective_state)
          setReasons(
            value.review_current && value.latest?.receipt ? value.latest.receipt.reason_codes : [],
          )
          dirty.current = false
        }
        if (kind === 'save') {
          setSaved(true)
          setHistory(null)
          replay.current = null
        }
      }
    } catch (failure) {
      if (active.current && !(failure instanceof DOMException && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : 'review_unavailable')
    } finally {
      if (active.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section
      className="local-agent-review"
      aria-label={t('獨立人工檢閱', 'Independent human review')}
    >
      <h4>{t('獨立人工檢閱', 'Independent human review')}</h4>
      <p>
        <code>{VERSION}</code>
      </p>
      <p className="local-review-warning">
        {t(
          '已檢閱不代表已驗證或已批准。人工不採納只是研究註記，並非執行控制；程式證據與紙上提案資格仍各自判定。',
          'Reviewed is not verified or approved. Rejection is a research annotation, not an execution control; program evidence and paper proposal eligibility remain independent.',
        )}
      </p>
      <p>
        {t(
          '這裡只保存固定理由的人工註記；不呼叫模型、不調整權重，也不建立提案或委託。來源改變後須重新檢閱。',
          'This records a human annotation with fixed reasons only. It does not call a model, change weights, create proposals or place orders. Changed sources require a new review.',
        )}
      </p>
      <div className="local-review-actions">
        <button type="button" disabled={!enabled || busy} onClick={() => void request('load')}>
          {t('載入檢閱狀態', 'Load review status')}
        </button>
        <button type="button" disabled={!enabled || busy} onClick={() => void request('history')}>
          {t('載入檢閱歷史', 'Load review history')}
        </button>
      </div>
      {busy && (
        <p role="status">{t('正在讀取或保存檢閱註記…', 'Loading or saving review annotation…')}</p>
      )}
      {error && (
        <p role="alert">
          {t(
            '檢閱操作未確認，請重新載入狀態後再試。',
            'Review action was not confirmed. Reload the status before trying again.',
          )}{' '}
          {error}
        </p>
      )}
      {saved && (
        <p role="status">
          {t(
            '檢閱註記已保存；程式資格未被人工註記覆寫。',
            'Review annotation saved; program eligibility was not overridden.',
          )}
        </p>
      )}
      {context && (
        <div className="local-review-current">
          <h5>
            {t('目前人工狀態', 'Current human status')}: {stateLabel(context.effective_state, t)} ·
            v{context.version}
          </h5>
          {!context.review_current && (
            <p>
              {context.review_reason === 'source_changed'
                ? t(
                    '來源或帳戶脈絡已改變。舊檢閱保留於歷史，目前須重新檢閱。',
                    'Source or account context changed. The old review remains in history; a new review is required.',
                  )
                : context.review_reason === 'review_history_unavailable'
                  ? t(
                      '最新歷史紀錄無法驗證，不能沿用舊狀態或新增覆蓋紀錄。',
                      'The latest history event cannot be verified. Earlier states cannot be reused or overwritten.',
                    )
                  : t('這個脈絡尚未有人工檢閱。', 'This context has no human review yet.')}
            </p>
          )}
          <ProgramEvidence program={context.program} t={t} />
          <p>
            {t('完成交易日／輸入版本', 'Completed session / input revision')}:{' '}
            {context.binding.as_of} / {context.binding.input_revision}
          </p>
          {!context.can_review && <p role="status">{context.unavailable_reason}</p>}
          <fieldset
            disabled={
              !enabled ||
              busy ||
              !context.can_review ||
              !!(context.latest && !context.latest.integrity.available)
            }
          >
            <legend>{t('新增人工檢閱註記', 'Add a human review annotation')}</legend>
            <label>
              {t('人工判斷', 'Human judgment')}
              <select
                value={draftState}
                onChange={(event) => {
                  dirty.current = true
                  setSaved(false)
                  setDraftState(event.target.value as ReviewState)
                }}
              >
                <option value="review_required">{stateLabel('review_required', t)}</option>
                <option value="reviewed">{stateLabel('reviewed', t)}</option>
                <option value="rejected">{stateLabel('rejected', t)}</option>
              </select>
            </label>
            <div className="local-review-reasons">
              {REASONS.map((reason) => (
                <label key={reason}>
                  <input
                    type="checkbox"
                    checked={reasons.includes(reason)}
                    onChange={(event) => {
                      dirty.current = true
                      setSaved(false)
                      setReasons(
                        event.target.checked
                          ? [...reasons, reason]
                          : reasons.filter((item) => item !== reason),
                      )
                    }}
                  />
                  {reasonLabel(reason, t)}
                </label>
              ))}
            </div>
            {draftState === 'rejected' && !reasons.length && (
              <p>{t('人工不採納至少需要一項疑慮。', 'Rejection requires at least one concern.')}</p>
            )}
            <button
              type="button"
              disabled={draftState === 'rejected' && !reasons.length}
              onClick={() => void request('save')}
            >
              {t('保存檢閱註記', 'Save review annotation')}
            </button>
          </fieldset>
        </div>
      )}
      {history && (
        <div className="local-review-history">
          <h5>
            {t('不可變更的檢閱歷史', 'Immutable review history')} · {history.pagination.total}
          </h5>
          <p>
            {t(
              '歷史狀態只屬於當時保存的脈絡，不能代表目前資格。',
              'Historical states describe their saved context only and do not represent current eligibility.',
            )}
          </p>
          {!history.items.length && <p>{t('尚無保存的檢閱事件。', 'No saved review events.')}</p>}
          {history.items.map((event) => (
            <EventDetails key={event.id} event={event} t={t} />
          ))}
          <div className="local-review-actions">
            <button
              type="button"
              disabled={busy || !enabled || history.pagination.offset === 0}
              onClick={() => void request('history', history.pagination.offset - 20)}
            >
              {t('上一頁', 'Previous page')}
            </button>
            <span>
              {history.pagination.offset + (history.items.length ? 1 : 0)}–
              {history.pagination.offset + history.items.length} / {history.pagination.total}
            </span>
            <button
              type="button"
              disabled={
                busy ||
                !enabled ||
                history.pagination.offset >= 5000 ||
                history.pagination.offset + history.items.length >= history.pagination.total
              }
              onClick={() => void request('history', history.pagination.offset + 20)}
            >
              {t('下一頁', 'Next page')}
            </button>
          </div>
          {history.pagination.offset >= 5000 && history.pagination.total > 5020 && (
            <p>
              {t(
                '已到本次查閱上限；更早的歷史未列出。',
                'The browsing limit is reached; earlier history is not listed.',
              )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
