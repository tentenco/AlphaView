import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import { api, money, num } from './ui'
import { useSessionState } from './session-state'
import { newPaperKey, type PaperSnapshot } from './paper-model'

type ForkSource = {
  account_id: string
  account_name: string
  account_version: number
  input_revision: string
  as_of: string
  cash: string
  initial_cash: string
  kill_switch: boolean
  holdings: { symbol: string; shares: string; reference_price: string; opening_value: string }[]
}
type ForkPreview = {
  engine_version: string
  source: ForkSource
  source_digest: string
  as_of: string
  input_revision: string
  method: string
}
type ForkDraft = { name: string; key: string }
function validDraft(value: unknown): value is ForkDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as ForkDraft
  return (
    typeof draft.name === 'string' &&
    draft.name.length <= 80 &&
    typeof draft.key === 'string' &&
    /^[a-zA-Z0-9._:-]{8,100}$/.test(draft.key)
  )
}

export function PortfolioFork({
  snapshot,
  locale,
  onCreated,
}: {
  snapshot: PaperSnapshot
  locale: Locale
  onCreated: (accountId: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useSessionState(
    `paper-fork-${snapshot.account.id}-v1`,
    () => ({ name: '', key: newPaperKey() }),
    validDraft,
  )
  const [preview, setPreview] = useState<ForkPreview | null>(null)
  const [origin, setOrigin] = useState<{ source: ForkSource; source_digest: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null)
  const [error, setError] = useState('')
  const [ack, setAck] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const current =
    preview &&
    preview.source.account_version === snapshot.account.version &&
    preview.input_revision === snapshot.input_revision &&
    preview.as_of === snapshot.as_of
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    api<{ origin: { source: ForkSource; source_digest: string } | null }>(
      `/api/paper/accounts/${snapshot.account.id}/origin`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setOrigin(value.origin)
      })
      .catch(() => {
        /* Lineage is supplementary; a temporary failure must not hide the account. */
      })
    return () => controller.abort()
  }, [snapshot.account.id])
  const calculate = async () => {
    if (busy) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('preview')
    setError('')
    setAck(false)
    try {
      const value = await api<ForkPreview>(
        `/api/paper/accounts/${snapshot.account.id}/fork/preview`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ expected_version: snapshot.account.version }),
        },
      )
      if (controller.signal.aborted) return
      if (value.source_digest !== preview?.source_digest)
        setDraft((d) => ({ ...d, key: newPaperKey() }))
      setPreview(value)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  const create = async () => {
    if (busy || !current || !preview || !ack || !draft.name.trim()) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('create')
    setError('')
    try {
      const value = await api<{ account: PaperSnapshot }>(
        `/api/paper/accounts/${snapshot.account.id}/fork`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            expected_version: preview.source.account_version,
            name: draft.name.trim(),
            expected_source_digest: preview.source_digest,
            idempotency_key: draft.key,
          }),
        },
      )
      if (controller.signal.aborted) return
      setDraft({ name: '', key: newPaperKey() })
      setAck(false)
      setOpen(false)
      onCreated(value.account.account.id)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  return (
    <div className="portfolio-fork">
      {origin && (
        <p className="research-note">
          {t('實驗起點來自', 'Experiment opened from')}{' '}
          <strong>{origin.source.account_name}</strong> · {origin.source.as_of} · v
          {origin.source.account_version} ·{' '}
          {t(
            '成本與報酬從分支起點重新計算。',
            'Cost basis and returns start at the fork observation.',
          )}
        </p>
      )}
      <button
        className="text-button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t('從目前帳戶建立實驗分支', 'Fork this account into an experiment')}
      </button>
      {open && (
        <section className="agent-panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">SAME STARTING POSITIONS / INDEPENDENT EXPERIMENT</div>
          <h2>{t('保留配置，建立新的實驗起點', 'Keep the allocation, start a new experiment')}</h2>
          <p>
            {t(
              '分支保留目前虛擬現金與股數，以當期價格建立新的成本基礎，損益從零開始。兩個帳戶之後獨立運行，適合比較不同規則或限制。',
              'A fork keeps current virtual cash and shares, sets a new cost basis at current prices, and starts P&L from zero. The accounts then evolve independently for comparing rules or limits.',
            )}
          </p>
          <p>
            {t(
              '風險限制、費用與暫停狀態會複製；過去紀錄、自動化任務與待處理委託不會複製。',
              'Risk limits, execution costs, and pause state are copied. Past records, automation tasks, and pending orders are not copied.',
            )}
          </p>
          <label className="agent-field">
            {t('分支名稱', 'Experiment name')}
            <input
              value={draft.name}
              maxLength={80}
              disabled={!!busy}
              onChange={(event) => {
                setDraft({ name: event.target.value, key: newPaperKey() })
                setAck(false)
              }}
            />
          </label>
          <button
            className="button"
            disabled={!!busy || !snapshot.valuation_complete}
            onClick={() => void calculate()}
          >
            {busy === 'preview'
              ? t('計算起點…', 'Calculating start…')
              : t('預覽分支起點', 'Preview experiment start')}
          </button>
          {!snapshot.valuation_complete && (
            <p className="notice">
              {t(
                '目前缺少完整價格，暫時無法建立一致的分支起點。',
                'Complete current prices are required to establish a consistent starting point.',
              )}
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {preview && !current && (
            <p className="notice">
              {t(
                '來源已變更，請重新預覽。名稱草稿已保留。',
                'The source changed. Preview again; your name draft is preserved.',
              )}
            </p>
          )}
          {current && preview && (
            <div className="agent-preview">
              <div className="agent-preview-stats">
                <span>
                  {t('新初始資金', 'New initial capital')}{' '}
                  <strong>{money(Number(preview.source.initial_cash))}</strong>
                </span>
                <span>
                  {t('保留現金', 'Retained cash')}{' '}
                  <strong>{money(Number(preview.source.cash))}</strong>
                </span>
                <span>
                  {t('新已實現損益', 'New realized P&L')} <strong>{money(0)}</strong>
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('標的', 'Symbol')}</th>
                      <th>{t('保留股數', 'Retained shares')}</th>
                      <th>{t('開帳參考價', 'Opening reference')}</th>
                      <th>{t('新成本基礎', 'New cost basis')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.source.holdings.map((row) => (
                      <tr key={row.symbol}>
                        <td>{row.symbol}</td>
                        <td>{num(Number(row.shares), 6)}</td>
                        <td>{money(Number(row.reference_price))}</td>
                        <td>{money(Number(row.opening_value))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.source.kill_switch && (
                <p className="notice">
                  {t(
                    '來源已暫停，新的分支也會保持暫停。',
                    'The source is paused, so the new experiment will also be paused.',
                  )}
                </p>
              )}
              <label className="agent-confirm">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />
                {t(
                  '我了解這會建立獨立的模擬實驗，開帳紀錄不是成交，後續需另外設定自動化任務。',
                  'I understand this creates an independent paper experiment. Opening marks are not fills, and automation must be configured separately.',
                )}
              </label>
              <button
                className="button primary"
                disabled={!!busy || !ack || !draft.name.trim()}
                onClick={() => void create()}
              >
                {busy === 'create'
                  ? t('建立分支…', 'Creating experiment…')
                  : t('建立實驗分支', 'Create experiment')}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
