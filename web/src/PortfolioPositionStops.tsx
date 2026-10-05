import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import { newPaperKey, type PaperAccount, type PaperProposal } from './paper-model'
import { dateTime, money, num } from './ui'

type Translate = (zh: string, en: string) => string
type Check = {
  code: 'stop_loss' | 'trailing_stop'
  status: 'pass' | 'tripped' | 'unavailable'
  limit?: number
  observed?: number
  peak?: number
  reason?: string
  loss_from_cost_pct?: number
  drawdown_from_peak_pct?: number
}
type Holding = {
  symbol: string
  shares: number
  average_cost: number | null
  close: number | null
  entry_session: string | null
  peak_close: number | null
  status: 'hold' | 'stop_loss' | 'trailing_stop' | 'unavailable'
  checks: Check[]
}
export type StopsState = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  policy: {
    enabled: boolean
    stop_loss_pct: number | null
    trailing_stop_pct: number | null
    cooldown_sessions: number
  }
  policy_version: number
  holdings: Holding[]
  tripped: string[]
  unavailable: string[]
  cooldowns: {
    symbol: string
    until_session: string
    reason: string
    proposal_id: string | null
    created_at: string
  }[]
  method: string
  warnings: string[]
}
type Draft = { enabled: boolean; stop: string; trailing: string; cooldown: string }
type PolicyEditor = {
  draft: Draft
  baseline: Draft
  policyVersion: number
  accountVersion: number
}
const draftFrom = (policy: StopsState['policy']): Draft => ({
  enabled: policy.enabled,
  stop: policy.stop_loss_pct == null ? '' : String(policy.stop_loss_pct),
  trailing: policy.trailing_stop_pct == null ? '' : String(policy.trailing_stop_pct),
  cooldown: String(policy.cooldown_sessions),
})
type Props = {
  account: PaperAccount
  locale: Locale
  onProposal: (proposal: PaperProposal) => void
}
const ENGLISH: Record<string, string> = {
  policy_changed: 'The stop policy changed in another window. Reload before saving.',
  stops_disabled: 'Enable the stop policy first.',
  nothing_tripped: 'No holding has tripped a stop; no proposal was created.',
  valuation_incomplete: 'A holding has no current price, so a complete target cannot be built.',
  nonpositive_equity: 'Paper equity must be positive.',
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
    if (
      detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      typeof detail.code === 'string'
    )
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
const statusLabel = (status: Holding['status'], t: Translate) =>
  ({
    hold: t('持有', 'Hold'),
    stop_loss: t('觸發停損', 'Stop-loss tripped'),
    trailing_stop: t('觸發追蹤停損', 'Trailing stop tripped'),
    unavailable: t('無法判斷', 'Unavailable'),
  })[status]

export function PortfolioPositionStops({ account, locale, onProposal }: Props) {
  return (
    <PositionStopsPanel
      key={account.id}
      account={account}
      locale={locale}
      onProposal={onProposal}
    />
  )
}

function PositionStopsPanel({ account, locale, onProposal }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [state, setState] = useState<StopsState | null>(null)
  const [editor, setEditor] = useState<PolicyEditor | null>(null)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const attempt = useRef({ key: '', idempotencyKey: '' })
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  const draft = editor?.draft ?? null
  const dirty = !!editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline)
  const changed =
    conflict ||
    (!!editor &&
      (editor.accountVersion !== account.version ||
        (!!state && editor.policyVersion !== state.policy_version)))
  function setDraft(next: Draft | ((current: Draft | null) => Draft | null)) {
    setEditor((current) => {
      if (!current) return current
      const value = typeof next === 'function' ? next(current.draft) : next
      return value ? { ...current, draft: value } : current
    })
  }
  function receive(
    value: StopsState,
    source: 'refresh' | 'save' | 'reload' = 'refresh',
    submitted: Draft | null = null,
  ) {
    setState((current) =>
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
    request<StopsState>(`/api/paper/accounts/${encodeURIComponent(account.id)}/position-stops`, t, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return
        receive(value)
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version, refresh])
  async function perform(action: string, work: (signal: AbortSignal) => Promise<void>) {
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
  const stop = draft?.stop.trim() ? Number(draft.stop) : null
  const trailing = draft?.trailing.trim() ? Number(draft.trailing) : null
  const cooldown = Number(draft?.cooldown)
  const valid =
    (stop === null || (Number.isFinite(stop) && stop >= 1 && stop <= 50)) &&
    (trailing === null || (Number.isFinite(trailing) && trailing >= 1 && trailing <= 50)) &&
    Number.isInteger(cooldown) &&
    cooldown >= 0 &&
    cooldown <= 60
  function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || !draft || !valid || changed) return
    void perform('save', async (signal) => {
      const value = await request<StopsState>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/position-stops`,
        t,
        {
          method: 'PUT',
          signal,
          body: JSON.stringify({
            expected_version: editor.policyVersion,
            policy: {
              enabled: draft.enabled,
              stop_loss_pct: stop,
              trailing_stop_pct: trailing,
              cooldown_sessions: cooldown,
            },
          }),
        },
      )
      if (signal.aborted) return
      receive(value, 'save', draft)
      setConflict(false)
      setNotice(t('停損政策已保存。', 'Stop policy saved.'))
    })
  }
  function propose() {
    if (!state?.tripped.length) return
    const key = JSON.stringify([account.id, account.version, state.as_of, state.tripped])
    if (attempt.current.key !== key) attempt.current = { key, idempotencyKey: newPaperKey() }
    void perform('propose', async (signal) => {
      const value = await request<{ paper_proposal: PaperProposal; cooldown_until: string }>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/position-stops/proposal`,
        t,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            expected_account_version: account.version,
            idempotency_key: attempt.current.idempotencyKey,
          }),
        },
      )
      if (signal.aborted) return
      setNotice(
        t(
          `停損提案已建立，冷卻至 ${value.cooldown_until}；請到配置與提案明確接受。`,
          `Stop proposal created; cooldown until ${value.cooldown_until}. Accept it under allocation & proposals.`,
        ),
      )
      onProposal(value.paper_proposal)
      setRefresh((n) => n + 1)
    })
  }
  function clear(symbol: string) {
    void perform('clear', async (signal) => {
      await request(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/position-stops/cooldowns/${encodeURIComponent(symbol)}`,
        t,
        { method: 'DELETE', signal },
      )
      if (!signal.aborted) setRefresh((n) => n + 1)
    })
  }
  function reloadCurrent() {
    void perform('reload', async (signal) => {
      const value = await request<StopsState>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/position-stops`,
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
      className="agent-panel position-stops-panel"
      aria-label={t('部位停損', 'Position stops')}
    >
      <div className="section-heading">
        <div>
          <h2>{t('部位停損與追蹤停損', 'Position stops and trailing stops')}</h2>
          <p>
            {t(
              '以收盤確認：跌破平均成本一定比例，或自進場後峰值回落一定比例，就建立賣出至零的提案（仍需明確接受），並在冷卻期內阻止重新建倉。',
              'Close-confirmed: a drop below average cost or from the post-entry peak creates a sell-to-zero proposal (still explicitly accepted) and blocks re-entry during the cooldown.',
            )}
          </p>
        </div>
        {state && (
          <strong>
            {state.tripped.length
              ? t(`${state.tripped.length} 檔觸發`, `${state.tripped.length} tripped`)
              : t('未觸發', 'None tripped')}
          </strong>
        )}
      </div>
      {draft && (
        <form onSubmit={save}>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            {t('啟用部位停損', 'Enable position stops')}
          </label>
          <div className="agent-form-grid">
            <label>
              {t(
                '停損（低於平均成本 %，1–50，留空停用）',
                'Stop-loss (% below average cost, 1–50, blank = off)',
              )}
              <input
                inputMode="decimal"
                value={draft.stop}
                onChange={(event) => setDraft({ ...draft, stop: event.target.value })}
              />
            </label>
            <label>
              {t(
                '追蹤停損（自峰值回落 %，1–50，留空停用）',
                'Trailing stop (% from peak, 1–50, blank = off)',
              )}
              <input
                inputMode="decimal"
                value={draft.trailing}
                onChange={(event) => setDraft({ ...draft, trailing: event.target.value })}
              />
            </label>
            <label>
              {t('冷卻交易日（0–60）', 'Cooldown sessions (0–60)')}
              <input
                inputMode="numeric"
                value={draft.cooldown}
                onChange={(event) => setDraft({ ...draft, cooldown: event.target.value })}
              />
            </label>
          </div>
          {!valid && (
            <p className="error-message" role="alert">
              {t(
                '停損與追蹤停損須為 1–50，冷卻須為 0–60 的整數。',
                'Stops must be 1–50 and the cooldown an integer 0–60.',
              )}
            </p>
          )}
          <div className="actions">
            <button className="button" disabled={!editor || !valid || !!busy || changed}>
              {busy === 'save' ? t('保存中…', 'Saving…') : t('保存停損政策', 'Save stop policy')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!state?.policy.enabled || !state?.tripped.length || !!busy}
              onClick={propose}
            >
              {busy === 'propose'
                ? t('建立中…', 'Creating…')
                : t('建立停損提案', 'Create stop proposal')}
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
      {state && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('標的', 'Symbol'),
                    t('平均成本', 'Avg cost'),
                    t('收盤', 'Close'),
                    t('進場日', 'Entry'),
                    t('峰值', 'Peak'),
                    t('狀態', 'Status'),
                    t('檢查', 'Checks'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!state.holdings.length && (
                  <tr>
                    <td colSpan={7}>{t('沒有虛擬持倉。', 'No paper holdings.')}</td>
                  </tr>
                )}
                {state.holdings.map((row) => (
                  <tr key={row.symbol}>
                    <th scope="row">{row.symbol}</th>
                    <td>{money(row.average_cost)}</td>
                    <td>{money(row.close)}</td>
                    <td>{row.entry_session || '—'}</td>
                    <td>{money(row.peak_close)}</td>
                    <td>{statusLabel(row.status, t)}</td>
                    <td>
                      {row.checks.length
                        ? row.checks.map((check) => (
                            <small key={check.code}>
                              {check.code === 'stop_loss'
                                ? t('停損', 'Stop')
                                : t('追蹤', 'Trailing')}
                              :{' '}
                              {check.status === 'unavailable'
                                ? `${t('無法判斷', 'unavailable')} (${check.reason})`
                                : check.status === 'tripped'
                                  ? t('觸發', 'tripped')
                                  : t('通過', 'pass')}
                              {check.limit != null
                                ? ` · ${t('觸發價', 'limit')} ${num(check.limit)}`
                                : ''}
                              {check.loss_from_cost_pct != null
                                ? ` · ${num(check.loss_from_cost_pct, 1)}%`
                                : ''}
                              {check.drawdown_from_peak_pct != null
                                ? ` · ${num(check.drawdown_from_peak_pct, 1)}%`
                                : ''}
                            </small>
                          ))
                        : t('政策未啟用', 'Policy off')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!state.cooldowns.length && (
            <>
              <h3>{t('冷卻中的標的', 'Symbols in cooldown')}</h3>
              <ul>
                {state.cooldowns.map((row) => (
                  <li key={row.symbol}>
                    {row.symbol} · {t('至', 'until')} {row.until_session} · {row.reason} ·{' '}
                    {dateTime(row.created_at)}{' '}
                    <button
                      type="button"
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => clear(row.symbol)}
                    >
                      {t('移除冷卻', 'Clear cooldown')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <details className="agent-method">
            <summary>{t('這不是什麼', 'What this is not')}</summary>
            <ul>
              {state.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p>{state.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
