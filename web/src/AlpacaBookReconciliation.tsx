import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import { dateTime } from './ui'

type Translate = (zh: string, en: string) => string
type RowStatus = 'matched' | 'pending' | 'unknown' | 'unexplained' | 'drift' | 'unavailable'
export type Reconciliation = {
  engine_version: string
  as_of: string
  input_revision: string
  status: RowStatus
  broker: {
    status: 'available' | 'unavailable'
    fetched_at: string | null
    error: { code: string; message: string } | null
    account_id: string | null
  }
  rows: {
    symbol: string
    status: RowStatus
    broker_qty: string | null
    broker_position: boolean
    booked_qty: string
    difference: string | null
    reason_code?: string | null
    filled_orders: number
    working_orders: number
    unknown_orders: number
    accounts: string[]
    local_ledger: { account_id: string; shares: string }[]
  }[]
  summary: Record<string, number | string[]> & { symbols: number; accounts: string[] }
  method: string
  warnings: string[]
}
type ReceiptState = {
  version: number
  connection_version: string | null
  broker_account_id: string | null
  as_of: string
  input_revision: string
  book_fingerprint: string
  can_capture: boolean
  max_age_seconds: number
  receipt: {
    version: number
    captured_at: string
    current: boolean
    unavailable_reasons: string[]
    result: Reconciliation
  } | null
}
const STATUS: Record<RowStatus, [string, string]> = {
  matched: ['一致', 'Matched'],
  pending: ['待定（有未完結委託）', 'Pending (working orders)'],
  unknown: ['結果未知', 'Unknown outcome'],
  unexplained: ['無法解釋（帳簿無紀錄）', 'Unexplained (not in book)'],
  drift: ['漂移', 'Drift'],
  unavailable: ['不可用', 'Unavailable'],
}
const ERRORS: Record<string, [string, string]> = {
  not_configured: ['尚未設定 Alpaca Paper 連線', 'Alpaca Paper is not connected'],
  account_changed: [
    'Alpaca 回傳的帳戶身份與連線時不同',
    'Alpaca returned a different account identity',
  ],
  rate_limited: ['Alpaca 要求降低請求頻率', 'Alpaca asked to slow down'],
  provider_unavailable: ['Alpaca 未成功回應', 'Alpaca did not respond successfully'],
  network_unavailable: ['無法連線至 Alpaca Paper', 'Cannot reach Alpaca Paper'],
  authentication_failed: ['Paper 金鑰未通過驗證', 'Paper keys were rejected'],
  reconciliation_changed: [
    '核對來源或收據版本已變更；本次結果未保存，請重新核對',
    'The source or receipt version changed. This result was not saved; reconcile again.',
  ],
}
const tone = (status: RowStatus) =>
  status === 'matched'
    ? 'desk-positive'
    : status === 'drift' || status === 'unexplained'
      ? 'desk-negative'
      : ''

export function AlpacaBookReconciliation({ locale }: { locale: Locale }) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [state, setState] = useState<ReceiptState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const result = state?.receipt?.result
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (!state?.receipt) return
    const controller = new AbortController()
    let running = false
    const refresh = async () => {
      if (running || operation.current || document.visibilityState === 'hidden') return
      running = true
      const token = generation.current
      try {
        const response = await fetch('/api/alpaca-paper/reconciliation/receipt', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('receipt unavailable')
        const value = (await response.json()) as ReceiptState
        if (!controller.signal.aborted && !operation.current && token === generation.current)
          setState(value)
      } catch {
        if (!controller.signal.aborted && !operation.current && token === generation.current)
          setState((current) =>
            current?.receipt
              ? {
                  ...current,
                  receipt: {
                    ...current.receipt,
                    current: false,
                    unavailable_reasons: ['receipt_check_failed'],
                  },
                }
              : current,
          )
      } finally {
        running = false
      }
    }
    const timer = window.setInterval(() => void refresh(), 30000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [state?.version])
  async function check() {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    generation.current++
    setBusy(true)
    setError('')
    setState(null)
    try {
      const read = async (init?: RequestInit) => {
        const response = await fetch('/api/alpaca-paper/reconciliation/receipt', {
          cache: 'no-store',
          signal: controller.signal,
          ...init,
        })
        const value = await response.json().catch(() => ({}))
        if (!response.ok)
          throw new Error(
            ERRORS[value.detail?.code]
              ? t(...ERRORS[value.detail.code])
              : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
          )
        return value as ReceiptState
      }
      const context = await read()
      if (controller.signal.aborted) return
      if (!context.can_capture) throw new Error(t(...ERRORS.not_configured))
      const captured = await read({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_version: context.version,
          expected_connection_version: context.connection_version,
          expected_broker_account_id: context.broker_account_id,
          expected_as_of: context.as_of,
          expected_input_revision: context.input_revision,
          expected_book_fingerprint: context.book_fingerprint,
        }),
      })
      if (controller.signal.aborted) return
      if (!captured.receipt?.current) throw new Error(t(...ERRORS.reconciliation_changed))
      setState(captured)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const brokerError = result?.broker.error
  return (
    <section className="agent-panel" aria-label={t('帳簿核對', 'Book reconciliation')}>
      <div className="section-heading">
        <div>
          <h2>
            {t(
              '帳簿核對：已記錄成交 vs Alpaca 持倉',
              'Book reconciliation: booked fills vs Alpaca positions',
            )}
          </h2>
          <p>
            {t(
              '把執行層在 Alpaca Paper 記錄的成交股數與券商持倉逐標的比對；只顯示差異，不自動修正。',
              'Compares the fills the execution layer booked at Alpaca Paper with the broker positions per symbol; differences are shown, never corrected.',
            )}
          </p>
        </div>
        {result && (
          <strong className={state?.receipt?.current ? tone(result.status) : ''}>
            {state?.receipt?.current
              ? t(...STATUS[result.status])
              : t('收據已過期或來源已變更', 'Receipt expired or source changed')}
          </strong>
        )}
      </div>
      <p className="research-note">
        {t(
          '按下核對會讀取券商並保存本機收據；就緒閘只讀此收據。有效期限為 15 分鐘，交易日、連線或帳簿變更即失效；背景只重新檢查本機收據。',
          'Reconcile reads the broker and saves a local receipt; readiness reads only that receipt. It expires after 15 minutes or when the session, connection or book changes. Background checks only read the local receipt.',
        )}
      </p>
      {state?.receipt && !state.receipt.current && (
        <p className="notice" role="status">
          {t(
            '以下是先前收據，不能代表目前帳簿一致；請重新核對。',
            'This is an earlier receipt and cannot establish current book consistency. Reconcile again.',
          )}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={check}>
          {busy ? t('核對中…', 'Checking…') : t('核對帳簿', 'Reconcile book')}
        </button>
        {result?.broker.fetched_at && (
          <span className="muted">
            {t('券商持倉擷取', 'Broker positions retrieved')} {dateTime(result.broker.fetched_at)}
          </span>
        )}
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {brokerError && (
        <p className="notice" role="status">
          {ERRORS[brokerError.code] ? t(...ERRORS[brokerError.code]) : brokerError.message}
        </p>
      )}
      {result && (
        <>
          {!result.rows.length && result.broker.status === 'available' && (
            <p className="muted">
              {t(
                '沒有送往 Alpaca Paper 的委託，券商也沒有持倉。',
                'No orders were sent to Alpaca Paper and the broker holds no positions.',
              )}
            </p>
          )}
          {!!result.rows.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('標的', 'Symbol'),
                      t('券商數量', 'Broker qty'),
                      t('帳簿成交數量', 'Booked qty'),
                      t('差異', 'Difference'),
                      t('委託', 'Orders'),
                      t('本機模擬帳本', 'Local paper ledger'),
                      t('狀態', 'Status'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.symbol}>
                      <th scope="row">{row.symbol}</th>
                      <td>
                        {row.broker_qty ??
                          (row.status === 'unavailable' ? '—' : t('無部位', 'No position'))}
                      </td>
                      <td>{row.booked_qty}</td>
                      <td>{row.difference ?? '—'}</td>
                      <td>
                        {row.filled_orders} {t('成交', 'filled')}
                        {row.working_orders
                          ? ` · ${row.working_orders} ${t('未完結', 'working')}`
                          : ''}
                        {row.unknown_orders
                          ? ` · ${row.unknown_orders} ${t('未知', 'unknown')}`
                          : ''}
                      </td>
                      <td>
                        {row.local_ledger.length
                          ? row.local_ledger
                              .map((item) => `${item.account_id}: ${item.shares}`)
                              .join(' · ')
                          : '—'}
                      </td>
                      <td className={tone(row.status)}>
                        {t(...STATUS[row.status])}
                        {row.reason_code === 'broker_quantity_unavailable' && (
                          <small>
                            {t('券商數量無法判讀', 'Broker quantity could not be read')}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="agent-method">
            <summary>{t('這不是什麼', 'What this is not')}</summary>
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p>{result.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
