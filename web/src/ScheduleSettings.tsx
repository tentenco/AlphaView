import { useEffect, useRef, useState } from 'react'
import { api, dateTime } from './ui'
import type { Scope } from './types'
import type { UniverseLimit } from './Screener'
export type ScheduleConfig = {
  enabled: boolean
  scope: Scope
  universe_limit: UniverseLimit
  version: number
  updated_at: string | null
  latest_eligible_session: string | null
  next_due_at: string | null
  poll_interval_seconds: number
  last_attempt: {
    session_date: string
    job_id: string | null
    scope: Scope
    universe_limit: UniverseLimit
    claimed_at: string
    status: string
    finished_at: string | null
    error: string | null
  } | null
}
const statuses: Record<string, string> = {
  running: '執行中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失敗',
  cancelled: '已取消',
  interrupted: '已中斷',
}
type Draft = Pick<ScheduleConfig, 'enabled' | 'scope' | 'universe_limit'>
export function ScheduleSettings({
  defaultUniverseLimit = 250,
  refreshKey = '',
}: {
  defaultUniverseLimit?: UniverseLimit
  refreshKey?: string
}) {
  const [status, setStatus] = useState<ScheduleConfig | null>(null)
  const [baseline, setBaseline] = useState<(Draft & { version: number }) | null>(null)
  const [draft, setDraft] = useState<Draft>({
    enabled: false,
    scope: 'market',
    universe_limit: defaultUniverseLimit,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  const dirty =
    !!baseline &&
    (baseline.enabled !== draft.enabled ||
      baseline.scope !== draft.scope ||
      baseline.universe_limit !== draft.universe_limit)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const forceReload = useRef(false)
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  function apply(config: ScheduleConfig) {
    const initialLimit =
      config.version === 0 && !config.enabled
        ? (Math.max(config.universe_limit, defaultUniverseLimit) as UniverseLimit)
        : config.universe_limit
    const values = { enabled: config.enabled, scope: config.scope, universe_limit: initialLimit }
    setStatus(config)
    setBaseline({ ...values, version: config.version })
    setDraft(values)
    setConflict(false)
  }
  useEffect(() => {
    if (submitting.current) return
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    const current = ++request.current
    setLoading(true)
    api<ScheduleConfig>('/api/schedule', { signal: pending.signal })
      .then((config) => {
        if (current !== request.current || pending.signal.aborted) return
        setStatus(config)
        if (!dirtyRef.current || forceReload.current) {
          apply(config)
          setError('')
        }
        forceReload.current = false
      })
      .catch((err) => {
        if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
      })
      .finally(() => {
        if (current === request.current) setLoading(false)
      })
    return () => {
      pending.abort()
      if (current === request.current) request.current++
    }
  }, [refreshKey, reload, defaultUniverseLimit])
  useEffect(
    () => () => {
      controller.current?.abort()
      request.current++
    },
    [],
  )
  async function save() {
    if (submitting.current || !baseline || !dirty || conflict) return
    submitting.current = true
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    const current = ++request.current
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/schedule', {
        method: 'PUT',
        signal: pending.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, version: baseline.version }),
      })
      if (current !== request.current || pending.signal.aborted) return
      if (response.status === 409) {
        setConflict(true)
        setError('排程設定已在其他視窗變更。你的設定仍保留，請載入最新版本後重新確認。')
        return
      }
      const result = await response.json().catch(() => null)
      if (current !== request.current || pending.signal.aborted) return
      if (!response.ok)
        throw new Error(
          typeof result?.detail === 'string' ? result.detail : `儲存排程失敗（${response.status}）`,
        )
      apply(result)
      setMessage(result.enabled ? '收盤後排程已啟用。' : '排程已停用；正在執行的作業不受影響。')
    } catch (err) {
      if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
    } finally {
      submitting.current = false
      if (current === request.current) {
        setSaving(false)
        setLoading(false)
      }
    }
  }
  const last = status?.last_attempt
  return (
    <section className="research-note" aria-labelledby="schedule-settings-title">
      <div className="section-heading">
        <div>
          <h2 id="schedule-settings-title">收盤後自動更新（本機）</h2>
          <p>預設停用；勾選啟用並儲存後才會開始排程。</p>
        </div>
        <span className="badge neutral">
          {status ? (status.enabled ? '已啟用' : '已停用') : '讀取設定中'}
        </span>
      </div>
      {loading && !baseline && <p role="status">載入排程設定中…</p>}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {baseline && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={saving}
              onChange={(event) =>
                setDraft((value) => ({ ...value, enabled: event.target.checked }))
              }
            />
            啟用收盤後自動更新
          </label>
          <div className="form-grid">
            <label>
              排程股票池
              <select
                aria-label="排程股票池"
                value={draft.scope}
                disabled={saving}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, scope: event.target.value as Scope }))
                }
              >
                <option value="market">市場候選股票池</option>
                <option value="portfolio">我的持股與觀察清單</option>
              </select>
            </label>
            <label>
              市場股票池上限
              <select
                aria-label="排程市場股票池上限"
                value={draft.universe_limit}
                disabled={saving || draft.scope !== 'market'}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    universe_limit: Number(event.target.value) as UniverseLimit,
                  }))
                }
              >
                <option value={250}>250 檔</option>
                <option value={500}>500 檔</option>
                <option value={1000}>1,000 檔</option>
              </select>
            </label>
          </div>
          <div className="dialog-actions">
            <span className="quiet-label">{dirty ? '變更尚未儲存' : '設定未變更'}</span>
            <button
              type="submit"
              className="button primary"
              disabled={saving || !dirty || conflict}
            >
              {saving ? '儲存排程中…' : '儲存排程設定'}
            </button>
          </div>
        </form>
      )}
      {(!baseline || conflict) && (
        <button
          type="button"
          className="button"
          disabled={saving || loading}
          onClick={() => {
            forceReload.current = true
            setReload((value) => value + 1)
          }}
        >
          {conflict ? '捨棄變更並載入最新設定' : '重新讀取排程設定'}
        </button>
      )}
      {message && <p role="status">{message}</p>}
      <p className="footnote">
        本機伺服器必須持續運行。美股交易日收盤 15
        分鐘後，針對最新已完成交易日自動嘗試一次；部分完成、失敗或取消也計入該次嘗試。電腦喚醒後僅補最新交易日，不補跑所有遺漏日期。停用排程不會取消正在執行的作業。
      </p>
      {status && (
        <>
          <p className="footnote">
            最新可排程交易日：{status.latest_eligible_session || '尚無'} · 下次檢查目標：
            {status.enabled
              ? status.next_due_at
                ? dateTime(status.next_due_at)
                : '等待可用交易日資訊'
              : '尚未啟用'}{' '}
            · 設定更新：{dateTime(status.updated_at)}
          </p>
          {last ? (
            <div className="notice">
              <div>
                <strong>
                  最近自動嘗試：{last.session_date} · {statuses[last.status] || last.status}
                </strong>
                <p>
                  {last.scope === 'market'
                    ? `市場股票池 · 最多 ${last.universe_limit} 檔`
                    : '我的持股與觀察清單'}{' '}
                  · {dateTime(last.claimed_at)} 開始
                  {last.finished_at ? ` · ${dateTime(last.finished_at)} 結束` : ''}
                </p>
                {last.error && <p>{last.error}</p>}
                <small>作業 {last.job_id || '尚未建立'}</small>
              </div>
            </div>
          ) : (
            <p className="footnote">尚無自動排程執行紀錄。</p>
          )}
        </>
      )}
    </section>
  )
}
