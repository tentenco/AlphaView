import { useCallback, useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import { AlpacaBookReconciliation } from './AlpacaBookReconciliation'
import './alpaca-paper.css'

type Connection = {
  configured: boolean
  version: string | null
  endpoint: string
  environment: 'paper'
  connected_at: string | null
  orders_enabled: false
}
type Resource<T> = {
  status: 'available' | 'unavailable'
  fetched_at: string | null
  data: T | null
  error: { code: string; message: string } | null
}
type Account = {
  id: string
  account_number: string | null
  status: string | null
  currency: string | null
  cash: string | null
  equity: string | null
  buying_power: string | null
  trading_blocked: boolean | null
  account_blocked: boolean | null
  trade_suspended_by_user: boolean | null
  unavailable_fields: string[]
}
type Position = {
  asset_id: string | null
  symbol: string | null
  asset_class: string | null
  side: string | null
  qty: string | null
  qty_available: string | null
  avg_entry_price: string | null
  market_value: string | null
  unrealized_pl: string | null
  current_price: string | null
}
type Order = {
  id: string | null
  symbol: string | null
  asset_class: string | null
  side: string | null
  type: string | null
  status: string | null
  qty: string | null
  notional: string | null
  filled_qty: string | null
  filled_avg_price: string | null
  submitted_at: string | null
  client_order_id: string | null
}
type Snapshot = Connection & {
  status: 'available' | 'partial' | 'unavailable'
  fetched_at: string
  coverage: { available: number; required: number }
  resources: {
    account: Resource<Account>
    positions: Resource<{ items: Position[]; count: number; complete: boolean }>
    orders: Resource<{
      items: Order[]
      returned: number
      limit: number
      total: null
      possibly_truncated: boolean
    }>
    clock: Resource<{
      is_open: boolean
      timestamp: string | null
      next_open: string | null
      next_close: string | null
    }>
  }
}
type Translate = (zh: string, en: string) => string
const decimals = (value: string | null | undefined) =>
  value == null
    ? '—'
    : value.replace(
        /^(-?\d+)(\.\d+)?$/,
        (_, whole: string, fraction = '') => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction,
      )
const time = (value: string | null | undefined) =>
  value ? value.replace('T', ' ').replace(/\.\d+(Z|[+-]\d\d:\d\d)$/, '$1') : '—'

function message(code: string, fallback: string, t: Translate) {
  const english: Record<string, string> = {
    authentication_failed:
      'Paper credentials could not be verified. Check the account, key and secret.',
    rate_limited: 'Alpaca requested a lower request rate. Refresh again later.',
    network_unavailable: 'The Alpaca Paper connection is unavailable. Check the network and retry.',
    provider_unavailable:
      'Alpaca did not return a successful response. This resource is unavailable.',
    not_configured: 'Configure the Alpaca Paper connection first.',
    connection_changed: 'The connection changed. Reload the connection settings and try again.',
    invalid_credentials:
      'Enter a Paper API key and secret. Live keys and custom endpoints are not accepted.',
    account_unverified: 'This resource was not read because the account could not be verified.',
    account_changed: 'The returned account identity changed. Configure the connection again.',
    credential_file: 'The local credential file or its owner-only permissions need attention.',
  }
  return t(fallback, english[code] || `Resource unavailable (${code}).`)
}

async function request<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json()
  if (!response.ok) {
    const detail = value.detail
    throw new Error(
      message(
        detail?.code || 'request_failed',
        typeof detail?.message === 'string' ? detail.message : '無法完成連線請求，請重新載入',
        t,
      ),
    )
  }
  return value
}

export function AlpacaPaper({ locale }: { locale: Locale }) {
  const t: Translate = useCallback((zh, en) => (locale === 'en' ? en : zh), [locale])
  const [connection, setConnection] = useState<Connection | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false)
  const [draftVersion, setDraftVersion] = useState<string | null | undefined>(undefined)
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [refresh, setRefresh] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    controller.current?.abort()
    controller.current = abort
    setLoading(true)
    setError('')
    setSnapshot(null)
    async function load() {
      try {
        const state = await request<Connection>('/api/alpaca-paper/connection', t, {
          signal: abort.signal,
        })
        if (abort.signal.aborted) return
        setConnection(state)
        setDraftVersion((version) => (version === undefined ? state.version : version))
        if (state.configured) {
          const data = await request<Snapshot>(
            `/api/alpaca-paper/snapshot?status=${filter}&limit=50`,
            t,
            { signal: abort.signal },
          )
          if (!abort.signal.aborted) setSnapshot(data)
        }
      } catch (err) {
        if (!abort.signal.aborted) setError((err as Error).message)
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => abort.abort()
  }, [filter, refresh, t])
  async function connect(event: React.FormEvent) {
    event.preventDefault()
    if (saving || loading || !connection || !apiKey || !secret) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const value = await request<Connection>('/api/alpaca-paper/connection', t, {
        method: 'POST',
        body: JSON.stringify({
          api_key: apiKey,
          secret_key: secret,
          expected_version: draftVersion,
        }),
      })
      if (!mounted.current) return
      setConnection(value)
      setApiKey('')
      setSecret('')
      setEditing(false)
      setDraftVersion(value.version)
      setNotice(
        t(
          'Paper 帳戶驗證成功，金鑰已保存於本機。',
          'Paper account verified. Credentials saved locally.',
        ),
      )
      setRefresh((value) => value + 1)
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  async function disconnect() {
    if (!connection?.version || saving || loading) return
    setSaving(true)
    setError('')
    try {
      const value = await request<Connection>('/api/alpaca-paper/connection', t, {
        method: 'DELETE',
        body: JSON.stringify({ expected_version: connection.version }),
      })
      if (!mounted.current) return
      setConnection(value)
      setSnapshot(null)
      setApiKey('')
      setSecret('')
      setEditing(false)
      setDraftVersion(null)
      setNotice(
        t(
          '已移除本機金鑰；Alpaca 帳戶與原金鑰仍存在。',
          'Local credentials removed. The Alpaca account and its API key still exist.',
        ),
      )
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  const account = snapshot?.resources.account.data
  const positions = snapshot?.resources.positions.data
  const orders = snapshot?.resources.orders.data
  const clock = snapshot?.resources.clock.data
  return (
    <div className="alpaca-paper">
      <section className="agent-panel">
        <div className="section-heading">
          <div>
            <div className="eyebrow">ALPACA / PAPER TRADING</div>
            <h2>{t('連接 Alpaca 模擬帳戶', 'Connect your Alpaca paper account')}</h2>
            <p>
              {t(
                '直接查看 Alpaca 的帳戶、持倉與委託紀錄。每個資源保留擷取時間，帳戶資料不會寫入本機研究持股。',
                'View the account, positions and orders directly from Alpaca. Each resource retains its retrieval time; account data is not imported into local research holdings.',
              )}
            </p>
          </div>
          <span className="agent-mode">
            {t('Paper API · 唯讀接入', 'Paper API · read-only connection')}
          </span>
        </div>
        <div className="actions">
          <button
            className="button"
            disabled={loading || saving}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? t('讀取中…', 'Loading…') : t('更新 Alpaca 資料', 'Refresh Alpaca data')}
          </button>
          {connection?.configured && (
            <button
              className="button"
              disabled={saving || loading}
              onClick={() => {
                if (!editing) setDraftVersion(connection.version)
                setEditing((value) => !value)
              }}
            >
              {t('連線設定', 'Connection settings')}
            </button>
          )}
          <a
            className="button"
            href="https://app.alpaca.markets/dashboard/overview"
            target="_blank"
            rel="noreferrer"
          >
            {t('開啟 Alpaca', 'Open Alpaca')}
          </a>
        </div>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {connection && (!connection.configured || editing) && (
          <form className="alpaca-connection-form" onSubmit={connect} autoComplete="off">
            <p>
              {t(
                '請使用 Paper 帳戶金鑰。Secret 只送到本機後端，保存於僅擁有者可讀寫的檔案，不進 Git、資料庫備份或瀏覽器儲存。',
                'Use paper-account credentials. The secret is sent only to the local backend and kept in an owner-only file, outside Git, database backups and browser storage.',
              )}
            </p>
            <div className="agent-form-grid">
              <label>
                Paper API Key
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={128}
                  required
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label>
                Secret Key
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  required
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </label>
            </div>
            <div className="actions">
              <button className="button primary" disabled={loading || saving || !apiKey || !secret}>
                {saving
                  ? t('驗證中…', 'Verifying…')
                  : t('驗證並保存 Paper 連線', 'Verify and save paper connection')}
              </button>
              {connection.configured && (
                <button
                  type="button"
                  className="button"
                  disabled={loading || saving}
                  onClick={() => void disconnect()}
                >
                  {t('移除本機連線', 'Remove local connection')}
                </button>
              )}
            </div>
          </form>
        )}
        <p className="research-note">
          {t(
            '連線固定使用 paper-api.alpaca.markets。本次只提供讀取能力；AlphaView 的本機提案與自動化任務仍使用原本的本機模擬帳本。',
            'The connection uses paper-api.alpaca.markets. This integration currently provides read access; AlphaView proposals and automation continue using the local paper ledger.',
          )}
        </p>
      </section>
      {snapshot && (
        <>
          <p className="alpaca-meta">
            {t('資源覆蓋', 'Resource coverage')} {snapshot.coverage.available}/
            {snapshot.coverage.required} · {t('最後擷取', 'Last retrieved')}{' '}
            {time(snapshot.fetched_at)}
          </p>
          {Object.entries(snapshot.resources)
            .filter(([, resource]) => resource.status === 'unavailable')
            .map(([name, resource]) => (
              <p className="notice" role="status" key={name}>
                {name} ·{' '}
                {message(
                  resource.error?.code || 'unavailable',
                  resource.error?.message || '資料不可用',
                  t,
                )}
              </p>
            ))}
          {account && (
            <>
              <div className="agent-metrics">
                {[
                  [t('Alpaca 淨值', 'Alpaca equity'), account.equity],
                  [t('現金', 'Cash'), account.cash],
                  [t('購買力', 'Buying power'), account.buying_power],
                ].map(([label, value]) => (
                  <div key={label!}>
                    <span>{label}</span>
                    <strong>{decimals(value)}</strong>
                    <small>{account.currency || '—'}</small>
                  </div>
                ))}
                <div>
                  <span>{t('帳戶狀態', 'Account status')}</span>
                  <strong>{account.status || '—'}</strong>
                  <small>{account.account_number || account.id}</small>
                </div>
              </div>
              <p className="research-note">
                {t(
                  '購買力依 Alpaca 帳戶規則回傳，可能包含槓桿，與可用現金不同。',
                  'Buying power follows Alpaca account rules and may include leverage; it differs from cash.',
                )}
              </p>
              {(account.account_blocked ||
                account.trading_blocked ||
                account.trade_suspended_by_user) && (
                <p className="notice">
                  {t(
                    'Alpaca 回報此帳戶有交易限制或暫停狀態。',
                    'Alpaca reports account restrictions or a trading suspension.',
                  )}
                </p>
              )}
              {account.unavailable_fields.length > 0 && (
                <p className="notice">
                  {t('未提供或無效的數值欄位', 'Missing or invalid numeric fields')}：
                  {account.unavailable_fields.join(', ')}
                </p>
              )}
            </>
          )}
          {clock && (
            <p className="alpaca-meta">
              {t('美股一般交易時段', 'US equity regular session')}：
              {clock.is_open ? t('開盤中', 'Open') : t('休市', 'Closed')} ·{' '}
              {t('下次開盤', 'Next open')} {time(clock.next_open)} ·{' '}
              {t('供應者時鐘', 'Provider clock')} {time(clock.timestamp)}
            </p>
          )}
          <section className="agent-panel">
            <h2>{t('Alpaca 持倉', 'Alpaca positions')}</h2>
            <p>
              {t('擷取時間', 'Retrieved at')} {time(snapshot.resources.positions.fetched_at)}
            </p>
            {!positions ? (
              <p>{t('持倉資料不可用。', 'Positions are unavailable.')}</p>
            ) : !positions.items.length ? (
              <p>
                {t(
                  '此 Alpaca 帳戶目前沒有未平倉部位。',
                  'This Alpaca account currently has no open positions.',
                )}
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('標的', 'Symbol'),
                        t('類別／方向', 'Class / side'),
                        t('股數／數量', 'Quantity'),
                        t('平均成本', 'Average entry'),
                        t('市值', 'Market value'),
                        t('未實現損益', 'Unrealized P/L'),
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.items.map((row, index) => (
                      <tr key={row.asset_id || index}>
                        <td>{row.symbol || '—'}</td>
                        <td>
                          {row.asset_class || '—'} / {row.side || '—'}
                        </td>
                        <td>{decimals(row.qty)}</td>
                        <td>{decimals(row.avg_entry_price)}</td>
                        <td>{decimals(row.market_value)}</td>
                        <td>{decimals(row.unrealized_pl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <AlpacaBookReconciliation locale={locale} />
          <section className="agent-panel">
            <div className="section-heading">
              <h2>{t('Alpaca 委託', 'Alpaca orders')}</h2>
              <label>
                {t('委託範圍', 'Order filter')}
                <select
                  value={filter}
                  disabled={loading || saving}
                  onChange={(event) => setFilter(event.target.value as typeof filter)}
                >
                  <option value="all">{t('全部', 'All')}</option>
                  <option value="open">{t('未結束', 'Open')}</option>
                  <option value="closed">{t('已結束', 'Closed')}</option>
                </select>
              </label>
            </div>
            <p>
              {t(
                '依提交時間顯示最近最多 50 筆，非完整歷史帳本。',
                'Shows up to 50 recent orders by submission time, not the complete historical ledger.',
              )}{' '}
              · {time(snapshot.resources.orders.fetched_at)}
            </p>
            {orders?.possibly_truncated && (
              <p className="notice">
                {t(
                  '已達本頁筆數上限，可能還有其他委託。',
                  'The page limit was reached; additional orders may exist.',
                )}
              </p>
            )}
            {!orders ? (
              <p>{t('委託資料不可用。', 'Orders are unavailable.')}</p>
            ) : !orders.items.length ? (
              <p>{t('此範圍目前沒有委託紀錄。', 'No orders were returned for this filter.')}</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('標的／方向', 'Symbol / side'),
                        t('類型', 'Type'),
                        t('委託量', 'Quantity'),
                        t('成交量', 'Filled'),
                        t('成交均價', 'Average fill'),
                        t('狀態', 'Status'),
                        t('提交時間', 'Submitted'),
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orders.items.map((row, index) => (
                      <tr key={row.id || index}>
                        <td>
                          {row.symbol || '—'} / {row.side || '—'}
                        </td>
                        <td>{row.type || '—'}</td>
                        <td>
                          {row.qty == null ? `${decimals(row.notional)} USD` : decimals(row.qty)}
                        </td>
                        <td>{decimals(row.filled_qty)}</td>
                        <td>{decimals(row.filled_avg_price)}</td>
                        <td>{row.status || '—'}</td>
                        <td>{time(row.submitted_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
