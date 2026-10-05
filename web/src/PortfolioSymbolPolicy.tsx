import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { PaperSnapshot, PaperSymbolPolicy } from './paper-model'
import { useSessionState } from './session-state'
import { api, dateTime } from './ui'

type Draft = { mode: PaperSymbolPolicy['mode']; symbols: string; accountVersion: number }
type History = { items: { policy: PaperSymbolPolicy; created_at: string }[] }
const initialPolicy: PaperSymbolPolicy = {
  engine_version: 'alphaview-paper-symbol-policy-v1',
  version: 1,
  mode: 'unrestricted',
  symbols: [],
}
function validDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Draft
  return (
    ['unrestricted', 'allowlist'].includes(draft.mode) &&
    typeof draft.symbols === 'string' &&
    draft.symbols.length <= 4000 &&
    Number.isInteger(draft.accountVersion) &&
    draft.accountVersion > 0
  )
}
function draftFrom(snapshot: PaperSnapshot): Draft {
  const policy = snapshot.account.symbol_policy || initialPolicy
  return {
    mode: policy.mode,
    symbols: policy.symbols.join('\n'),
    accountVersion: snapshot.account.version,
  }
}

export function PortfolioSymbolPolicy({
  snapshot,
  locale,
  onUpdated,
}: {
  snapshot: PaperSnapshot
  locale: Locale
  onUpdated: (snapshot: PaperSnapshot) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const policy = snapshot.account.symbol_policy || initialPolicy
  const [draft, setDraft] = useSessionState(
    `paper-symbol-policy-${snapshot.account.id}-v1`,
    () => draftFrom(snapshot),
    validDraft,
  )
  const [history, setHistory] = useState<History | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    api<History>(`/api/paper/accounts/${snapshot.account.id}/symbol-policy/history`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setHistory(value)
          setHistoryError(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryError(true)
      })
    return () => controller.abort()
  }, [snapshot.account.id, policy.version])
  const symbols =
    draft.mode === 'unrestricted'
      ? []
      : draft.symbols
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((symbol) => symbol.toUpperCase())
          .sort()
  const valid =
    symbols.length <= 100 &&
    new Set(symbols).size === symbols.length &&
    symbols.every((symbol) => /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/.test(symbol))
  const stale = draft.accountVersion !== snapshot.account.version
  const changed =
    draft.mode !== policy.mode || JSON.stringify(symbols) !== JSON.stringify(policy.symbols)
  const added = symbols.filter((symbol) => !policy.symbols.includes(symbol))
  const removed = policy.symbols.filter((symbol) => !symbols.includes(symbol))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || stale || !valid || !changed) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    try {
      const updated = await api<PaperSnapshot>(
        `/api/paper/accounts/${snapshot.account.id}/controls`,
        {
          method: 'PATCH',
          signal: controller.signal,
          body: JSON.stringify({
            expected_version: draft.accountVersion,
            symbol_policy: { mode: draft.mode, symbols },
          }),
        },
      )
      if (controller.signal.aborted) return
      setDraft(draftFrom(updated))
      onUpdated(updated)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <section className="agent-card" aria-label={t('允許標的政策', 'Symbol policy')}>
      <h3>{t('允許標的政策', 'Symbol policy')}</h3>
      <p className="agent-meta">
        {t('目前政策版本', 'Current policy version')} {policy.version} ·{' '}
        {policy.mode === 'unrestricted'
          ? t('不限制標的', 'Unrestricted symbols')
          : `${t('明確允許清單', 'Explicit allowlist')} (${policy.symbols.length})`}
      </p>
      <form onSubmit={save}>
        <label className="agent-field">
          {t('標的範圍', 'Symbol scope')}
          <select
            value={draft.mode}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, mode: event.target.value as Draft['mode'] })}
          >
            <option value="unrestricted">{t('不限制標的', 'Unrestricted symbols')}</option>
            <option value="allowlist">{t('明確允許清單', 'Explicit allowlist')}</option>
          </select>
        </label>
        {draft.mode === 'allowlist' && (
          <label className="agent-field">
            {t('允許的標的（每行一個，最多 100 個）', 'Allowed symbols (one per line, up to 100)')}
            <textarea
              value={draft.symbols}
              maxLength={4000}
              rows={4}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, symbols: event.target.value })}
            />
          </label>
        )}
        {!valid && (
          <p className="notice" role="alert">
            {t(
              '代碼格式無效、重複或超過 100 個。',
              'Symbols are invalid, duplicated, or exceed 100 entries.',
            )}
          </p>
        )}
        {valid && changed && (
          <div className="research-note" aria-label={t('政策變更預覽', 'Policy change preview')}>
            <p>
              {t('新增清單項目', 'Added entries')}: {added.join(', ') || '—'}
            </p>
            <p>
              {t('移除清單項目', 'Removed entries')}: {removed.join(', ') || '—'}
            </p>
            <p>
              {draft.mode === 'unrestricted'
                ? t('儲存後不限制新增標的。', 'Saving permits new exposure to any symbol.')
                : symbols.length === 0
                  ? t(
                      '空清單禁止所有新增股數；既有持倉仍可減碼。',
                      'An empty list blocks all share increases; existing holdings may be reduced.',
                    )
                  : t(
                      '儲存後僅清單內標的可新增股數。',
                      'Only listed symbols may increase their shares after saving.',
                    )}
            </p>
          </div>
        )}
        <p className="research-note">
          {t(
            '清單外既有持倉可維持或減少股數；減碼仍需完整報價並符合原有風險、費用與精度限制。政策變更會使舊提案與委託失效；自動化任務需重新檢閱授權。排除的規則配置保留現金，不補位。這不是券商交易權限，也不會下單。',
            'Excluded holdings may retain or reduce shares; reductions still require complete prices and existing risk, cost and precision checks. Policy changes invalidate earlier proposals and queued orders; automation requires reviewed authorization. Excluded rule slots remain cash without replacements. This is a local paper policy and cannot place broker orders.',
          )}
        </p>
        {stale && (
          <div className="notice" role="status">
            <p>
              {t(
                '帳戶版本已變更；草稿已保留。請載入目前政策後再修改。',
                'The account version changed; your draft is preserved. Load the current policy before editing again.',
              )}
            </p>
            <button type="button" className="button" onClick={() => setDraft(draftFrom(snapshot))}>
              {t('載入目前標的政策', 'Load current symbol policy')}
            </button>
          </div>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <button className="button" disabled={busy || stale || !valid || !changed}>
          {t('儲存標的政策', 'Save symbol policy')}
        </button>
      </form>
      <details>
        <summary>{t('政策版本紀錄', 'Policy history')}</summary>
        {historyError ? (
          <p>{t('暫時無法載入版本紀錄。', 'Policy history is temporarily unavailable.')}</p>
        ) : (
          <ol>
            {history?.items.map(({ policy: saved, created_at }) => (
              <li key={saved.version}>
                v{saved.version} · {dateTime(created_at)} ·{' '}
                {saved.mode === 'unrestricted'
                  ? t('不限制標的', 'Unrestricted symbols')
                  : saved.symbols.join(', ') || t('空清單', 'Empty allowlist')}
              </li>
            ))}
          </ol>
        )}
        <p className="agent-meta">{policy.engine_version}</p>
      </details>
    </section>
  )
}
