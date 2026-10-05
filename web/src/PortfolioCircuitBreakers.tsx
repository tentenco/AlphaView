import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import { dateTime, num } from './ui'
import './circuit-breakers.css'

type Translate = (zh: string, en: string) => string
type CheckCode = 'daily_loss' | 'max_drawdown' | 'max_fills_per_session'
type Check = {
  code: CheckCode
  label: string
  enabled: boolean
  observed: number | null
  limit: number | null
  status: 'pass' | 'tripped' | 'unavailable' | 'disabled'
  reason: string | null
  detail: Record<string, unknown>
}
export type BreakerPolicy = {
  daily_loss_limit_pct: number | null
  max_drawdown_pct: number | null
  max_fills_per_session: number | null
  auto_pause: boolean
  reduce_only_allowed: boolean
}
export type BreakerStatus = {
  engine_version: string
  account_id: string
  account_version: number
  kill_switch: boolean
  as_of: string
  policy: BreakerPolicy
  policy_version: number
  checks: Check[]
  tripped: boolean
  tripped_codes: CheckCode[]
  unavailable: CheckCode[]
  valuation_complete: boolean
  input_revision: string
  method: string
  warnings: string[]
  paused_now?: boolean
  already_paused?: boolean
}
export type BreakerEvent = {
  id: string
  kind: 'tripped' | 'evaluated' | 'resumed' | 'policy_changed'
  session_date: string | null
  reason_code: string | null
  evidence: Record<string, unknown>
  account_version_before: number | null
  account_version_after: number | null
  created_at: string
}
type Draft = {
  daily: string
  drawdown: string
  fills: string
  autoPause: boolean
  reduceOnly: boolean
}

type PolicyEditor = {
  draft: Draft
  baseline: Draft
  policyVersion: number
  accountVersion: number
}

const ENGLISH: Record<string, string> = {
  policy_changed: 'The breaker policy changed in another window. Reload before saving.',
  valuation_incomplete: 'The paper valuation is incomplete (a holding has no current price).',
  no_prior_nav_snapshot: 'No captured NAV snapshot before this session; capture NAV to enable it.',
  no_nav_snapshot: 'No captured NAV snapshot yet; capture NAV to enable it.',
}
const CHECK_ENGLISH: Record<CheckCode, string> = {
  daily_loss: 'Daily loss limit',
  max_drawdown: 'Max drawdown limit',
  max_fills_per_session: 'Fills per session limit',
}
async function request<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.code)
      throw Object.assign(
        new Error(t(String(detail.message), ENGLISH[detail.code] || String(detail.message))),
        {
          name: detail.code === 'policy_changed' ? 'PolicyConflict' : 'Error',
        },
      )
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
const draftFrom = (policy: BreakerPolicy): Draft => ({
  daily: policy.daily_loss_limit_pct == null ? '' : String(policy.daily_loss_limit_pct),
  drawdown: policy.max_drawdown_pct == null ? '' : String(policy.max_drawdown_pct),
  fills: policy.max_fills_per_session == null ? '' : String(policy.max_fills_per_session),
  autoPause: policy.auto_pause,
  reduceOnly: policy.reduce_only_allowed,
})
const numberOrNull = (text: string) => (text.trim() ? Number(text) : null)
function parseDraft(draft: Draft): BreakerPolicy | null {
  const daily = numberOrNull(draft.daily)
  const drawdown = numberOrNull(draft.drawdown)
  const fills = numberOrNull(draft.fills)
  if (daily !== null && !(daily >= 0.1 && daily <= 50)) return null
  if (drawdown !== null && !(drawdown >= 1 && drawdown <= 90)) return null
  if (fills !== null && !(Number.isInteger(fills) && fills >= 1 && fills <= 100)) return null
  return {
    daily_loss_limit_pct: daily,
    max_drawdown_pct: drawdown,
    max_fills_per_session: fills,
    auto_pause: draft.autoPause,
    reduce_only_allowed: draft.reduceOnly,
  }
}
const statusLabel = (status: Check['status'], t: Translate) =>
  ({
    pass: t('未觸發', 'Pass'),
    tripped: t('已觸發', 'Tripped'),
    unavailable: t('不可用', 'Unavailable'),
    disabled: t('未啟用', 'Off'),
  })[status]
const kindLabel = (kind: BreakerEvent['kind'], t: Translate) =>
  ({
    tripped: t('觸發並暫停', 'Tripped and paused'),
    evaluated: t('評估', 'Evaluated'),
    resumed: t('恢復', 'Resumed'),
    policy_changed: t('設定變更', 'Policy changed'),
  })[kind]
const observedText = (check: Check) =>
  check.observed == null
    ? '—'
    : check.code === 'max_fills_per_session'
      ? String(check.observed)
      : `${num(check.observed)}%`
const limitText = (check: Check) =>
  check.limit == null
    ? '—'
    : check.code === 'max_fills_per_session'
      ? `≥ ${check.limit}`
      : `≤ −${check.limit}%`

type Props = { account: PaperAccount; locale: Locale; onAccountChanged: () => void }
export function PortfolioCircuitBreakers(props: Props) {
  return <CircuitBreakersPanel key={props.account.id} {...props} />
}
function CircuitBreakersPanel({ account, locale, onAccountChanged }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [status, setStatus] = useState<BreakerStatus | null>(null)
  const [events, setEvents] = useState<BreakerEvent[]>([])
  const [editor, setEditor] = useState<PolicyEditor | null>(null)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState<'save' | 'evaluate' | 'reload' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  const draft = editor?.draft ?? null
  const dirty = !!editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline)
  const changed =
    conflict ||
    (!!editor &&
      (editor.accountVersion !== account.version ||
        (!!status && editor.policyVersion !== status.policy_version)))
  function setDraft(next: Draft | ((current: Draft | null) => Draft | null)) {
    setEditor((current) => {
      if (!current) return current
      const value = typeof next === 'function' ? next(current.draft) : next
      return value ? { ...current, draft: value } : current
    })
  }
  function receive(
    value: BreakerStatus,
    source: 'refresh' | 'save' | 'reload' = 'refresh',
    submitted: Draft | null = null,
  ) {
    setStatus((current) =>
      current &&
      (current.policy_version > value.policy_version ||
        current.account_version > value.account_version)
        ? current
        : value,
    )
    setEditor((current) => {
      if (
        current &&
        (current.policyVersion > value.policy_version ||
          current.accountVersion > value.account_version)
      )
        return current
      const next = draftFrom(value.policy)
      const incoming = {
        draft: next,
        baseline: next,
        policyVersion: value.policy_version,
        accountVersion: value.account_version,
      }
      if (!current) return incoming
      const untouched = JSON.stringify(current.draft) === JSON.stringify(submitted)
      if (source === 'save') return { ...incoming, draft: untouched ? next : current.draft }
      if (source === 'reload') return untouched ? incoming : current
      return JSON.stringify(current.draft) === JSON.stringify(current.baseline) ? incoming : current
    })
  }
  useEffect(() => {
    const controller = new AbortController()
    Promise.allSettled([
      request<BreakerStatus>(`/api/paper/accounts/${account.id}/circuit-breakers`, t, {
        signal: controller.signal,
      }),
      request<{ events: BreakerEvent[] }>(
        `/api/paper/accounts/${account.id}/circuit-breakers/events?limit=20`,
        t,
        { signal: controller.signal },
      ),
    ]).then(([state, history]) => {
      if (controller.signal.aborted) return
      if (state.status === 'fulfilled') {
        receive(state.value)
        setError('')
      } else setError(state.reason instanceof Error ? state.reason.message : String(state.reason))
      if (history.status === 'fulfilled') setEvents(history.value.events)
    })
    return () => controller.abort()
    // The translate helper only changes labels; account.version and refresh drive reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version, refresh])

  async function perform(
    action: NonNullable<typeof busy>,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
        if (err instanceof Error && err.name === 'PolicyConflict') setConflict(true)
      }
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  const policy = draft ? parseDraft(draft) : null
  function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || !policy || changed) return
    void perform('save', async (signal) => {
      const value = await request<BreakerStatus>(
        `/api/paper/accounts/${account.id}/circuit-breakers`,
        t,
        {
          method: 'PUT',
          signal,
          body: JSON.stringify({ policy, expected_version: editor.policyVersion }),
        },
      )
      if (signal.aborted) return
      receive(value, 'save', draft)
      setConflict(false)
      setNotice(t('斷路器設定已保存。', 'Breaker policy saved.'))
      setRefresh((n) => n + 1)
    })
  }
  function evaluate() {
    void perform('evaluate', async (signal) => {
      const value = await request<BreakerStatus>(
        `/api/paper/accounts/${account.id}/circuit-breakers/evaluate`,
        t,
        { method: 'POST', signal },
      )
      if (signal.aborted) return
      receive(value)
      setNotice(
        value.paused_now
          ? t('斷路器已觸發，帳戶已自動暫停。', 'A breaker tripped; the account was paused.')
          : value.tripped
            ? t(
                '斷路器已觸發；帳戶未自動暫停。',
                'A breaker is tripped; the account was not paused automatically.',
              )
            : t('評估完成，未觸發。', 'Evaluated; nothing tripped.'),
      )
      if (value.paused_now) onAccountChanged()
      setRefresh((n) => n + 1)
    })
  }
  function reloadCurrent() {
    void perform('reload', async (signal) => {
      const value = await request<BreakerStatus>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/circuit-breakers`,
        t,
        { signal },
      )
      if (signal.aborted) return
      receive(value, 'reload', draft)
      setConflict(false)
    })
  }
  return (
    <section
      className="agent-panel circuit-breakers"
      aria-label={t('風險斷路器', 'Circuit breakers')}
    >
      <div className="section-heading">
        <div>
          <h2>{t('風險斷路器', 'Circuit breakers')}</h2>
          <p>
            {t(
              '每日虧損、最大回撤或單日成交筆數達到上限時拒絕新的模擬成交，並可自動啟用帳戶暫停開關。基準只來自已擷取的 NAV 快照。',
              'Refuse new paper fills when the daily loss, drawdown or fills-per-session limit is hit, optionally flipping the account kill switch. Baselines come only from captured NAV snapshots.',
            )}
          </p>
        </div>
        {status && (
          <span
            className={`circuit-breakers-state${status.tripped ? ' is-tripped' : ''}`}
            role="status"
          >
            {status.tripped
              ? t('已觸發', 'Tripped')
              : status.unavailable.length
                ? t('部分不可用', 'Partly unavailable')
                : t('未觸發', 'Armed')}
            {status.kill_switch ? ` · ${t('帳戶已暫停', 'Account paused')}` : ''}
          </span>
        )}
      </div>
      {status && (
        <div className="agent-metrics circuit-breakers-checks">
          {status.checks.map((check) => (
            <div key={check.code} className={`is-${check.status}`}>
              <span>{t(check.label, CHECK_ENGLISH[check.code])}</span>
              <strong>{observedText(check)}</strong>
              <small>
                {statusLabel(check.status, t)}
                {check.limit != null ? ` · ${t('上限', 'Limit')} ${limitText(check)}` : ''}
                {check.reason ? ` · ${t(check.reason, ENGLISH[check.reason] || check.reason)}` : ''}
              </small>
            </div>
          ))}
          <div>
            <span>{t('評估交易日', 'Session')}</span>
            <strong>{status.as_of}</strong>
            <small>
              {t('設定版本', 'Policy version')} {status.policy_version}
            </small>
          </div>
        </div>
      )}
      {draft && (
        <form onSubmit={save} className="circuit-breakers-form">
          <div className="agent-form-grid">
            <label>
              {t(
                '每日虧損上限（%，0.1–50，空白停用）',
                'Daily loss limit (%, 0.1–50, blank = off)',
              )}
              <input
                inputMode="decimal"
                value={draft.daily}
                onChange={(event) => setDraft({ ...draft, daily: event.target.value })}
              />
            </label>
            <label>
              {t('最大回撤上限（%，1–90，空白停用）', 'Max drawdown limit (%, 1–90, blank = off)')}
              <input
                inputMode="decimal"
                value={draft.drawdown}
                onChange={(event) => setDraft({ ...draft, drawdown: event.target.value })}
              />
            </label>
            <label>
              {t(
                '單日成交筆數上限（1–100，空白停用）',
                'Fills per session limit (1–100, blank = off)',
              )}
              <input
                inputMode="numeric"
                value={draft.fills}
                onChange={(event) => setDraft({ ...draft, fills: event.target.value })}
              />
            </label>
            <label className="circuit-breakers-checkbox">
              <input
                type="checkbox"
                checked={draft.autoPause}
                onChange={(event) => setDraft({ ...draft, autoPause: event.target.checked })}
              />
              {t('觸發時自動暫停帳戶', 'Pause the account automatically when tripped')}
            </label>
            <label className="circuit-breakers-checkbox">
              <input
                type="checkbox"
                checked={draft.reduceOnly}
                onChange={(event) => setDraft({ ...draft, reduceOnly: event.target.checked })}
              />
              {t(
                '暫停或觸發時仍放行純減倉提案（只賣不買、不新增標的；停損提案適用）',
                'Allow strictly risk-reducing proposals while paused or tripped (sells only, no new symbols; stop proposals qualify)',
              )}
            </label>
          </div>
          {!policy && (
            <p className="error-message" role="alert">
              {t(
                '請確認每日虧損 0.1–50、回撤 1–90、成交筆數為 1–100 的整數。',
                'Daily loss must be 0.1–50, drawdown 1–90 and fills an integer 1–100.',
              )}
            </p>
          )}
          <div className="actions">
            <button className="button primary" disabled={!policy || !!busy || !editor || changed}>
              {busy === 'save'
                ? t('保存中…', 'Saving…')
                : t('保存斷路器設定', 'Save breaker policy')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!!busy || !status}
              onClick={evaluate}
            >
              {busy === 'evaluate' ? t('評估中…', 'Evaluating…') : t('立即評估', 'Evaluate now')}
            </button>
          </div>
        </form>
      )}
      {changed && (
        <p className="notice" role="status">
          {t(
            '帳戶或設定已在編輯期間變更；你的草稿已保留。請載入目前設定後再儲存。',
            'The account or policy changed while you were editing. Your draft is preserved. Load the current policy before saving.',
          )}
        </p>
      )}
      {dirty && <p className="notice">{t('有未儲存的修改。', 'You have unsaved changes.')}</p>}
      <div className="actions">
        <button type="button" className="button" disabled={!!busy} onClick={reloadCurrent}>
          {busy === 'reload' ? t('載入中…', 'Loading…') : t('載入目前設定', 'Load current policy')}
        </button>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!!events.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  t('時間', 'Time'),
                  t('事件', 'Event'),
                  t('交易日', 'Session'),
                  t('原因', 'Reason'),
                  t('帳戶版本', 'Account version'),
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{dateTime(event.created_at)}</td>
                  <td>{kindLabel(event.kind, t)}</td>
                  <td>{event.session_date || '—'}</td>
                  <td>
                    {event.reason_code
                      ? t(
                          event.reason_code,
                          CHECK_ENGLISH[event.reason_code as CheckCode] || event.reason_code,
                        )
                      : '—'}
                  </td>
                  <td>
                    {event.account_version_before == null
                      ? '—'
                      : `${event.account_version_before} → ${event.account_version_after ?? '—'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {status && (
        <details className="agent-method">
          <summary>{t('這不是什麼', 'What this is not')}</summary>
          <ul>
            {status.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <p>{status.method}</p>
        </details>
      )}
    </section>
  )
}
