import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import { newPaperKey, type PaperProposal, type PaperSnapshot } from './paper-model'
import {
  defaultNextOpenDraft,
  nextOpenActive,
  nextOpenDraftKey,
  parseNextOpenCap,
  validNextOpenDraft,
  type NextOpenCollection,
  type NextOpenEnqueue,
  type NextOpenOrder,
  type NextOpenSource,
  type NextOpenStatus,
} from './paper-next-open'
import { useSessionState } from './session-state'
import { api, money, num } from './ui'
import './paper-next-open.css'

type Translate = (zh: string, en: string) => string
type Props = {
  snapshot: PaperSnapshot
  locale: Locale
  onAccountChanged: () => void
  onProposal?: (proposal: PaperProposal) => void
  selectedOrderId?: string
  selectionNonce?: number
}
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value)}%`)
function utc(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
const statusLabel = (status: NextOpenStatus, t: Translate) =>
  ({
    waiting_session: t('等待指定交易日完成', 'Waiting for session completion'),
    waiting_prices: t('等待指定日開盤價', 'Waiting for specified-day opens'),
    blocked: t('受阻，需手動重試', 'Blocked; manual retry required'),
    filled: t('已模擬成交', 'Paper fills recorded'),
    cancelled: t('已取消', 'Cancelled'),
    invalidated: t('已失效', 'Invalidated'),
  })[status]
function errorLabel(message: string, t: Translate) {
  return t(
    message,
    /[\u3400-\u9fff]/.test(message)
      ? 'The request could not complete. Refresh the queue and account, check the source and authorization, then retry.'
      : message,
  )
}

export function PortfolioNextOpen(props: Props) {
  return <NextOpenAccount key={props.snapshot.account.id} {...props} />
}

function NextOpenAccount({
  snapshot,
  locale,
  onAccountChanged,
  onProposal,
  selectedOrderId,
  selectionNonce,
}: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(
    nextOpenDraftKey(snapshot.account.id),
    defaultNextOpenDraft,
    validNextOpenDraft,
  )
  const [consent, setConsent] = useState<string | null>(null)
  const [collection, setCollection] = useState<{ key: string; data: NextOpenCollection } | null>(
    null,
  )
  const [order, setOrder] = useState<NextOpenOrder | null>(null)
  const [orderId, setOrderId] = useState(selectedOrderId || '')
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [detailKey, setDetailKey] = useState('')
  const [detailError, setDetailError] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'enqueue' | 'detail' | 'process' | 'cancel' | 'receipt' | null>(
    null,
  )
  const operation = useRef<AbortController | null>(null)
  const identity = useRef({ input: '', key: '' })
  const knownStatuses = useRef(new Map<string, NextOpenStatus>())
  const navigationKey = useRef(JSON.stringify([selectedOrderId, selectionNonce]))
  const callback = useRef(onAccountChanged)
  callback.current = onAccountChanged
  const base = `/api/paper/accounts/${encodeURIComponent(snapshot.account.id)}/next-open-orders`
  const sourceKey = JSON.stringify([
    snapshot.account.id,
    snapshot.account.version,
    snapshot.as_of,
    snapshot.input_revision,
    offset,
  ])
  const report = collection?.key === sourceKey ? collection.data : null
  const currentDetailKey = JSON.stringify([sourceKey, orderId, refresh, detailRefresh])
  const detailCurrent = detailKey === currentDetailKey && order?.id === orderId
  const stale =
    !!report &&
    (report.as_of !== snapshot.as_of || report.input_revision !== snapshot.input_revision)
  const source = report?.source_proposals.find((row) => row.id === draft.proposalId)
  const cost = parseNextOpenCap(draft.costCap)
  const cash = parseNextOpenCap(draft.buyCashCap)
  const validCaps = cost != null && cost <= 1e9 && cash != null && cash <= 1e12
  const consentKey = JSON.stringify([
    sourceKey,
    source?.proposal_fingerprint,
    report?.enqueue_window.execution_session,
    draft,
  ])
  const agreed = consent === consentKey
  const beforeCutoff = !!report && Date.now() < Date.parse(report.enqueue_window.enqueue_before)
  const canEnqueue =
    !!report?.enqueue_window.can_enqueue &&
    beforeCutoff &&
    !!source?.eligible &&
    !stale &&
    !loading &&
    !loadError &&
    validCaps &&
    agreed
  const hasActive =
    !!report?.items.some((row) => nextOpenActive(row.status)) ||
    (!!order && nextOpenActive(order.status))

  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (!selectedOrderId) return
    const key = JSON.stringify([selectedOrderId, selectionNonce])
    if (navigationKey.current === key) return
    navigationKey.current = key
    setOrderId(selectedOrderId)
    setDetailRefresh((value) => value + 1)
  }, [selectedOrderId, selectionNonce])
  useEffect(() => {
    if (!orderId) return
    const controller = new AbortController()
    setDetailError('')
    api<NextOpenOrder>(`${base}/${encodeURIComponent(orderId)}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        if (data.id !== orderId || data.account_id !== snapshot.account.id)
          throw new Error(
            t(
              '委託識別不符，請重新開啟。',
              'The order identity does not match. Open the order again.',
            ),
          )
        const previous = knownStatuses.current.get(data.id)
        knownStatuses.current.set(data.id, data.status)
        setOrder(data)
        setDetailKey(currentDetailKey)
        if (previous && previous !== 'filled' && data.status === 'filled') callback.current()
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setOrder(null)
        setDetailError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [base, orderId, currentDetailKey, snapshot.account.id])
  useEffect(() => {
    if (!report?.enqueue_window.can_enqueue) return
    const remaining = Date.parse(report.enqueue_window.enqueue_before) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return
    const timer = setTimeout(
      () => setRefresh((value) => value + 1),
      Math.min(remaining + 50, 2147483647),
    )
    return () => clearTimeout(timer)
  }, [report?.enqueue_window.can_enqueue, report?.enqueue_window.enqueue_before])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    api<NextOpenCollection>(`${base}?limit=20&offset=${offset}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        let newFill = false
        for (const row of data.items) {
          const previous = knownStatuses.current.get(row.id)
          if (previous && previous !== 'filled' && row.status === 'filled') newFill = true
          knownStatuses.current.set(row.id, row.status)
        }
        setCollection({ key: sourceKey, data })
        if (newFill) callback.current()
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [base, sourceKey, offset, refresh])

  useEffect(() => {
    if (!hasActive || loading) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setRefresh((value) => value + 1)
    }, 15000)
    return () => clearInterval(timer)
  }, [hasActive, loading])

  async function perform(
    action: NonNullable<typeof busy>,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  function requestKey(input: string) {
    if (identity.current.input !== input) identity.current = { input, key: newPaperKey() }
    return identity.current.key
  }
  function receive(data: NextOpenOrder, changed: boolean) {
    knownStatuses.current.set(data.id, data.status)
    setOrderId(data.id)
    setOrder(data)
    setRefresh((value) => value + 1)
    if (changed) callback.current()
  }
  function enqueue(event: FormEvent) {
    event.preventDefault()
    if (report && Date.now() >= Date.parse(report.enqueue_window.enqueue_before)) {
      setError(
        t(
          '指定交易日已開盤，排隊授權窗口已關閉。請重新整理。',
          'The specified session has opened and the authorization window is closed. Refresh the queue.',
        ),
      )
      setRefresh((value) => value + 1)
      return
    }
    if (!canEnqueue || !source || cost == null || cash == null) return
    const payload = {
      proposal_id: source.id,
      expected_account_version: snapshot.account.version,
      expected_proposal_fingerprint: source.proposal_fingerprint,
      max_execution_cost_usd: cost,
      max_buy_cash_debit_usd: cash,
      confirm_next_open_simulation: true as const,
    }
    const body: NextOpenEnqueue = {
      ...payload,
      idempotency_key: requestKey(`enqueue:${JSON.stringify(payload)}`),
    }
    void perform('enqueue', async (signal) => {
      const data = await api<NextOpenOrder>(base, {
        method: 'POST',
        signal,
        body: JSON.stringify(body),
      })
      if (signal.aborted) return
      setConsent(null)
      receive(data, true)
    })
  }
  function open(id: string) {
    setOrderId(id)
    setDetailRefresh((value) => value + 1)
  }
  function actOnOrder(action: 'process' | 'cancel') {
    if (!order || !detailCurrent || (action === 'process' ? !order.can_process : !order.can_cancel))
      return
    const payload = {
      expected_order_version: order.version,
      idempotency_key: requestKey(`${action}:${order.id}:${order.version}`),
    }
    void perform(action, async (signal) => {
      const data = await api<NextOpenOrder>(`${base}/${encodeURIComponent(order.id)}/${action}`, {
        method: 'POST',
        signal,
        body: JSON.stringify(payload),
      })
      if (!signal.aborted) receive(data, true)
    })
  }
  function readReceipt() {
    if (!detailCurrent || !order?.execution_proposal_id || !onProposal || order.status !== 'filled')
      return
    void perform('receipt', async (signal) => {
      const proposal = await api<PaperProposal>(
        `/api/paper/accounts/${encodeURIComponent(snapshot.account.id)}/proposals/${encodeURIComponent(order.execution_proposal_id!)}`,
        { signal },
      )
      if (!signal.aborted) onProposal(proposal)
    })
  }

  return (
    <div className="paper-next-open">
      <section
        className="agent-panel"
        aria-label={t('下一開盤委託授權', 'Next-open queue authorization')}
      >
        <div className="next-open-heading">
          <div>
            <div className="eyebrow">{t('模擬委託', 'PAPER ORDER QUEUE')}</div>
            <h2>
              {t(
                '授權指定下一交易日的開盤模擬',
                'Authorize a specified next-session open simulation',
              )}
            </h2>
          </div>
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? t('讀取中…', 'Loading…') : t('重新整理委託', 'Refresh queue')}
          </button>
        </div>
        <p>
          {t(
            '以已保存提案的股數排隊。指定交易日完成、日線開盤價到齊後才記帳；這是本機事後參考價模擬，不是當時的真實或即時成交。',
            'Queue the shares from a saved proposal. Recording occurs only after the specified session completes and its daily open prices are available. This is a local reference-price simulation, not a live or historical real fill.',
          )}
        </p>
        {loadError && (
          <p className="error-message" role="alert">
            {errorLabel(loadError, t)}
          </p>
        )}
        {stale && (
          <p className="notice">
            {t(
              '帳戶畫面與委託資料來源不同。請重新整理帳戶後再授權；草稿保留。',
              'The account view and queue inputs differ. Refresh the paper account before authorizing; your draft is preserved.',
            )}
          </p>
        )}
        {report && (
          <>
            <div className="next-open-schedule">
              <div>
                <span>{t('指定交易日', 'Specified session')}</span>
                <strong>{report.enqueue_window.execution_session}</strong>
              </div>
              <div>
                <span>{t('排隊截止（開盤前）', 'Enqueue before market open')}</span>
                <strong>{utc(report.enqueue_window.enqueue_before)}</strong>
              </div>
              <div>
                <span>{t('最早可檢查行情', 'Earliest data evaluation')}</span>
                <strong>{utc(report.enqueue_window.eligible_after)}</strong>
              </div>
            </div>
            {!report.enqueue_window.can_enqueue && (
              <p className="notice">
                {t(
                  report.enqueue_window.reason || '目前不能新增委託。',
                  'New orders cannot be queued: the enqueue window is closed or this account already has an active order.',
                )}
              </p>
            )}
            <form onSubmit={enqueue}>
              <label className="agent-field">
                <span>{t('來源已保存提案', 'Saved source proposal')}</span>
                <select
                  value={draft.proposalId}
                  onChange={(event) => setDraft({ ...draft, proposalId: event.target.value })}
                >
                  <option value="">{t('選擇來源提案', 'Select a source proposal')}</option>
                  {draft.proposalId &&
                    !report.source_proposals.some((row) => row.id === draft.proposalId) && (
                      <option value={draft.proposalId} disabled>
                        {draft.proposalId} · {t('目前不可用', 'Unavailable')}
                      </option>
                    )}
                  {report.source_proposals.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.id.slice(0, 14)} · {row.order_count} {t('筆變動', 'trades')} ·{' '}
                      {row.eligible ? t('可授權', 'Eligible') : t('來源失效', 'Unavailable')}
                    </option>
                  ))}
                </select>
              </label>
              {!report.source_proposals.length && (
                <p>
                  {t(
                    '尚無待接受提案。先建立並保存當期 v2 紙上提案。',
                    'No pending source proposal is available. Create and save a current v2 paper proposal first.',
                  )}
                </p>
              )}
              {source && (
                <>
                  {!source.eligible && (
                    <p className="notice">
                      {t(
                        source.reason || '來源提案不符合條件。',
                        'This source proposal failed current account, market input or source validation. Create a fresh paper proposal.',
                      )}
                    </p>
                  )}
                  <NextOpenProposalOrders
                    source={source}
                    signalSession={report.enqueue_window.signal_session}
                    t={t}
                  />
                  <p>
                    {t('原收盤估計成本', 'Original close-estimated cost')}:{' '}
                    {money(source.estimated_cost)} ·{' '}
                    {t('原收盤估計買入扣款', 'Original close-estimated gross buy debit')}:{' '}
                    {money(source.estimated_buy_cash_debit)}
                  </p>
                </>
              )}
              <div className="agent-form-grid">
                <label className="agent-field">
                  <span>{t('授權執行成本上限（USD）', 'Authorized execution cost cap (USD)')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={50}
                    value={draft.costCap}
                    placeholder={t('請自行輸入', 'Enter an amount')}
                    onChange={(event) => setDraft({ ...draft, costCap: event.target.value })}
                  />
                </label>
                <label className="agent-field">
                  <span>
                    {t('授權買入現金扣款上限（USD）', 'Authorized gross buy cash debit cap (USD)')}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={50}
                    value={draft.buyCashCap}
                    placeholder={t('請自行輸入', 'Enter an amount')}
                    onChange={(event) => setDraft({ ...draft, buyCashCap: event.target.value })}
                  />
                </label>
              </div>
              <p>
                {t(
                  '成本＝所有費用＋相對指定日開盤價的不利滑價，不包含隔夜漲跌。買入扣款＝全部買入成交本金＋買入費用，不扣除賣出收入。可明確輸入零；兩個欄位都不能留空。',
                  'Cost = all fees plus adverse slippage against the specified-day open, excluding the overnight price move. Buy debit = gross buy notionals plus buy fees, without netting sale proceeds. Zero is allowed when entered explicitly; neither field may be blank.',
                )}
              </p>
              {draft.costCap && (cost == null || cost > 1e9) && (
                <p className="error-message">
                  {t(
                    '成本上限須為 0 至 1,000,000,000 的有效金額。',
                    'The cost cap must be a valid amount from 0 to 1,000,000,000.',
                  )}
                </p>
              )}
              {draft.buyCashCap && (cash == null || cash > 1e12) && (
                <p className="error-message">
                  {t(
                    '買入扣款上限須為 0 至 1,000,000,000,000 的有效金額。',
                    'The buy debit cap must be a valid amount from 0 to 1,000,000,000,000.',
                  )}
                </p>
              )}
              <label className="next-open-consent">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setConsent(event.target.checked ? consentKey : null)}
                />
                <span>
                  {t(
                    '我同意以指定下一交易日完成日線的未調整開盤價、既定滑價與費率，模擬上述固定股數。資料晚到時延後記帳；缺價不補值、不換日期、不縮單。',
                    'I authorize the fixed shares above using the specified next session’s completed daily raw open, with the frozen slippage and fees. Late data delays recording; missing prices are not filled, dates are not rolled and shares are not reduced.',
                  )}
                </span>
              </label>
              <p className="next-open-authorization">
                {t('本次授權', 'This authorization')}: {report.enqueue_window.execution_session} ·{' '}
                {t('成本上限', 'Cost cap')} {cost} USD · {t('買入扣款上限', 'Buy debit cap')} {cash}{' '}
                USD
              </p>
              <div className="actions">
                <button type="submit" className="button primary" disabled={!!busy || !canEnqueue}>
                  {busy === 'enqueue'
                    ? t('排隊中…', 'Queueing…')
                    : t('授權並加入模擬委託', 'Authorize and queue simulation')}
                </button>
              </div>
            </form>
          </>
        )}
        <p className="next-open-meta">
          {t(
            '同一帳戶最多一批未結束委託。沒有預留資金；帳戶、風險政策或來源歷史變動會使批次失效。受阻委託不會自動重試，必須手動重新檢查或取消。',
            'Only one active batch is allowed per account. Funds are not reserved; account, policy or source-history changes invalidate the batch. Blocked orders do not retry automatically; recheck or cancel them explicitly.',
          )}
        </p>
      </section>
      {error && (
        <p className="error-message" role="alert">
          {errorLabel(error, t)}
        </p>
      )}
      {report && (
        <section className="agent-panel" aria-label={t('模擬委託歷史', 'Paper order history')}>
          <h2>{t('委託狀態與歷史', 'Queue status and history')}</h2>
          {!report.items.length ? (
            <p>{t('尚無模擬委託。', 'No queued paper orders yet.')}</p>
          ) : (
            <div className="table-scroll next-open-history">
              <table>
                <thead>
                  <tr>
                    {[
                      t('委託', 'Order'),
                      t('狀態', 'Status'),
                      t('指定交易日', 'Specified session'),
                      t('來源提案', 'Source proposal'),
                      t('授權成本 / 買入扣款', 'Authorized cost / buy debit'),
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          type="button"
                          className="button"
                          disabled={!!busy}
                          aria-pressed={order?.id === row.id}
                          onClick={() => open(row.id)}
                        >
                          {row.id.slice(0, 14)}
                          <br />
                          {utc(row.created_at)}
                        </button>
                      </td>
                      <td>{statusLabel(row.status, t)}</td>
                      <td>{row.execution_session}</td>
                      <td>{row.source_proposal_id.slice(0, 14)}</td>
                      <td>
                        {row.max_execution_cost_usd} USD / {row.max_buy_cash_debit_usd} USD
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
              type="button"
              disabled={loading || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              {t('上一頁', 'Previous')}
            </button>
            <span>
              {report.total
                ? `${offset + 1}–${offset + report.items.length} / ${report.total}`
                : '0 / 0'}
            </span>
            <button
              className="button"
              type="button"
              disabled={loading || offset + report.items.length >= report.total}
              onClick={() => setOffset(offset + 20)}
            >
              {t('下一頁', 'Next')}
            </button>
          </div>
        </section>
      )}
      {orderId && !detailCurrent && !detailError && (
        <p role="status">
          {t('正在核對這筆委託的最新狀態…', 'Checking the latest state of this order…')}
        </p>
      )}
      {detailError && (
        <p className="error-message" role="alert">
          {errorLabel(detailError, t)}{' '}
          <button className="text-button" onClick={() => open(orderId)}>
            {t('重新載入這筆委託', 'Reload this order')}
          </button>
        </p>
      )}
      {order && order.id === orderId && (
        <NextOpenDetail
          order={order}
          t={t}
          busy={!!busy || !detailCurrent}
          onRefresh={() => open(order.id)}
          onProcess={() => actOnOrder('process')}
          onCancel={() => actOnOrder('cancel')}
          onReceipt={onProposal ? readReceipt : undefined}
        />
      )}
    </div>
  )
}

export function NextOpenProposalOrders({
  source,
  signalSession,
  t,
}: {
  source: NextOpenSource
  signalSession: string
  t: Translate
}) {
  return (
    <div>
      <h3>{t('原提案的固定股數', 'Fixed shares from the saved proposal')}</h3>
      <p>
        {t(
          '下列價格與金額只屬於原提案的收盤參考估算。提案建立時尚未取得指定下一交易日的開盤價格，實際模擬金額可能不同。',
          'Prices and amounts below are closing-price estimates from the saved proposal. The specified next-session open was unavailable when it was created; simulated amounts may differ.',
        )}
      </p>
      <div
        className="table-scroll"
        tabIndex={0}
        aria-label={t('待排隊固定股數', 'Fixed shares to queue')}
      >
        <table>
          <thead>
            <tr>
              {[
                t('代碼', 'Symbol'),
                t('變動', 'Change'),
                t('固定股數', 'Fixed shares'),
                t('原收盤參考價', 'Original reference close'),
                t('原估計名目金額', 'Original estimated notional'),
                t('原估計費用', 'Original estimated fee'),
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {source.orders.map((order) => (
              <tr key={order.symbol}>
                <th scope="row">{order.symbol}</th>
                <td>{order.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                <td>{num(order.shares, 8)}</td>
                <td>{money(order.reference_price)}</td>
                <td>{money(order.notional)}</td>
                <td>{money(order.fee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="next-open-meta">
        {t('來源提案', 'Source proposal')}: {source.id} · {t('訊號交易日', 'Signal session')}:{' '}
        {signalSession}
      </p>
    </div>
  )
}

function reasonText(code: string, message: string, t: Translate) {
  const english: Record<string, string> = {
    waiting_session: 'Waiting until the specified session has completed and its data is eligible.',
    quote_unavailable: 'A required valid raw open from the specified session is unavailable.',
    policy_blocked:
      'The batch did not pass account or authorization limits. Review the evaluation below.',
    filled: 'The entire authorized batch was simulated and recorded atomically.',
    cancelled: 'This batch was cancelled; it will not be processed.',
    account_changed:
      'The account, execution policy or pause state changed; the original authorization is invalid.',
    source_changed: 'The source proposal changed or no longer satisfies its source conditions.',
    source_history_changed: 'The historical inputs used by the original signal changed.',
    source_history_unavailable:
      'The original historical input range cannot be verified completely.',
    corporate_action_unsupported:
      'A possible corporate action or changed adjustment factor prevents simulation.',
    insufficient_shares: 'The account does not hold enough shares for the frozen sale.',
    holding_limit: 'The resulting holdings exceed the supported position count.',
    method_changed: 'The simulation method changed; this authorization is no longer valid.',
    max_position_weight: 'A position exceeds the account concentration limit.',
    post_policy_max_position_weight:
      'A position exceeds the concentration limit after costs and rounding.',
    min_cash_weight: 'Cash is below the account minimum.',
    max_turnover: 'Gross turnover exceeds the account limit.',
    insufficient_cash: 'Available cash cannot fund the frozen trades and their costs.',
    nonpositive_equity: 'The account must retain positive equity.',
    min_trade_notional:
      'A frozen order is below the minimum trade size; the batch cannot partially execute.',
    execution_cost_cap: 'Fees and adverse slippage exceed the authorized execution cost cap.',
    buy_cash_debit_cap:
      'Gross buy notionals and buy fees exceed the authorized buy cash debit cap.',
  }
  return t(message, english[code] || `Recorded check: ${code}`)
}

function NextOpenDetail({
  order,
  t,
  busy,
  onRefresh,
  onProcess,
  onCancel,
  onReceipt,
}: {
  order: NextOpenOrder
  t: Translate
  busy: boolean
  onRefresh: () => void
  onProcess: () => void
  onCancel: () => void
  onReceipt?: () => void
}) {
  const evaluation = order.last_evaluation
  return (
    <section className="agent-panel" aria-label={t('模擬委託詳情', 'Paper order details')}>
      <div className="next-open-heading">
        <h2>{t('固定股數委託', 'Frozen-share order')}</h2>
        <strong>{statusLabel(order.status, t)}</strong>
      </div>
      <p className="next-open-meta">
        {order.id} · {t('委託版本', 'Order version')} {order.version} ·{' '}
        {t('來源提案', 'Source proposal')} {order.source_proposal_id}
      </p>
      <p className={order.status === 'blocked' || order.status === 'invalidated' ? 'notice' : ''}>
        {reasonText(order.reason_code, order.reason, t)} <code>{order.reason_code}</code>
      </p>
      <div className="next-open-schedule">
        <div>
          <span>{t('指定執行交易日', 'Specified execution session')}</span>
          <strong>{order.execution_session}</strong>
        </div>
        <div>
          <span>{t('最早可檢查行情', 'Earliest data evaluation')}</span>
          <strong>{utc(order.eligible_after)}</strong>
        </div>
        <div>
          <span>{t('實際記帳時間', 'Actual recording time')}</span>
          <strong>{utc(order.recorded_at)}</strong>
        </div>
      </div>
      {order.status === 'filled' && (
        <p className="notice">
          {t('假設執行交易日', 'Effective simulation session')}: {order.effective_session || '—'} ·{' '}
          {t('延後至更晚交易日記帳', 'Recorded after a later session completed')}:{' '}
          {order.late_recording ? t('是', 'Yes') : t('否', 'No')}
          <br />
          {t(
            '這是實際記帳時間與假設價格日期的分列；不會回填或改寫既有 NAV。',
            'Recording time and the assumed price date are separate. Existing NAV observations are not backfilled or rewritten.',
          )}
        </p>
      )}
      {order.execution_reference_revised === true && (
        <p className="notice">
          {t(
            '成交後，指定日的開盤參考資料已被修訂。歷史收據仍保留當時使用的價格與結果。',
            'The specified-day open data was revised after recording. The historical receipt retains the prices and results used at that time.',
          )}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={onRefresh}>
          {t('更新這筆委託', 'Refresh this order')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !order.can_process}
          onClick={onProcess}
        >
          {order.status === 'blocked'
            ? t('按原授權明確重試', 'Retry with the same authorization')
            : t('檢查並處理已授權委託', 'Check and process authorized order')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !order.can_cancel}
          onClick={onCancel}
        >
          {t('取消這筆模擬委託', 'Cancel this paper order')}
        </button>
        {onReceipt && order.status === 'filled' && order.execution_proposal_id && (
          <button type="button" className="button" disabled={busy} onClick={onReceipt}>
            {t('閱讀已成交收據', 'Read execution receipt')}
          </button>
        )}
      </div>
      {order.status === 'blocked' && (
        <p>
          {t(
            '排程不會重試受阻委託。此按鈕只按原日期、股數與上限再驗算，不提高授權；若上限不合適，請取消並建立新的合格提案。',
            'The scheduler does not retry blocked orders. This button rechecks the original date, shares and caps without increasing authorization. If the caps are unsuitable, cancel and create a new eligible proposal.',
          )}
        </p>
      )}
      <h3>{t('不可變更的授權', 'Frozen authorization')}</h3>
      <p>
        {t('執行成本上限', 'Execution cost cap')}:{' '}
        <strong>{order.max_execution_cost_usd} USD</strong> ·{' '}
        {t('買入扣款上限', 'Gross buy debit cap')}:{' '}
        <strong>{order.max_buy_cash_debit_usd} USD</strong>
        <br />
        {t('費率', 'Fee rate')}: {num(order.execution_policy.fee_bps)} bps ·{' '}
        {t('不利滑價', 'Adverse slippage')}: {num(order.execution_policy.slippage_bps)} bps ·{' '}
        {t('股數精度', 'Share precision')}: {order.execution_policy.share_precision}
      </p>
      <details className="agent-method">
        <summary>{t('查看來源固定股數', 'Inspect source frozen shares')}</summary>
        <NextOpenProposalOrders
          source={{
            id: order.source_proposal_id,
            created_at: order.created_at,
            proposal_fingerprint: order.source_proposal_fingerprint,
            eligible: false,
            reason: null,
            order_count: order.frozen_orders.length,
            estimated_cost: order.source_estimated_cost,
            estimated_buy_cash_debit: order.source_estimated_buy_cash_debit,
            orders: order.frozen_orders,
          }}
          signalSession={order.signal_session}
          t={t}
        />
      </details>
      {evaluation && (
        <>
          <h3>{t('最近一次指定日開盤驗算', 'Latest specified-open evaluation')}</h3>
          <div className={`agent-verdict ${evaluation.executable ? 'allowed' : 'blocked'}`}>
            {evaluation.executable
              ? t('本次驗算通過', 'This evaluation passed')
              : t('本次驗算未通過', 'This evaluation did not pass')}
          </div>
          <div className="agent-preview-stats">
            <span>
              {t('開盤估值前淨值', 'Equity at the specified open')}{' '}
              <strong>{money(evaluation.equity_before)}</strong>
            </span>
            <span>
              {t('預計現金', 'Projected cash')} <strong>{money(evaluation.cash_after)}</strong>
            </span>
            <span>
              {t('費用', 'Fees')} <strong>{money(evaluation.fees_total)}</strong>
            </span>
            <span>
              {t('滑價', 'Slippage')} <strong>{money(evaluation.slippage_total)}</strong>
            </span>
            <span>
              {t('執行成本', 'Execution cost')} <strong>{money(evaluation.cost_total)}</strong>
            </span>
            <span>
              {t('買入扣款', 'Gross buy debit')}{' '}
              <strong>{money(evaluation.gross_buy_cash_debit)}</strong>
            </span>
            <span>
              {t('總換手', 'Gross turnover')} <strong>{percent(evaluation.turnover_pct)}</strong>
            </span>
            <span>
              {t('報價覆蓋', 'Price coverage')}{' '}
              <strong>
                {evaluation.coverage.priced}/{evaluation.coverage.required}
              </strong>
            </span>
          </div>
          {evaluation.violations.length > 0 && (
            <ul className="agent-reasons">
              {evaluation.violations.map((issue, index) => (
                <li key={index}>
                  {issue.symbol && <strong>{issue.symbol} </strong>}
                  {reasonText(issue.code, issue.message, t)} <code>{issue.code}</code>
                </li>
              ))}
            </ul>
          )}
          <div
            className="table-scroll"
            tabIndex={0}
            aria-label={t('指定日開盤報價', 'Specified-day open quotes')}
          >
            <table>
              <thead>
                <tr>
                  {[
                    t('標的', 'Symbol'),
                    t('報價日期', 'Quote date'),
                    t('未調整開盤價', 'Raw open'),
                    t('覆蓋狀態', 'Coverage status'),
                  ].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evaluation.quote_details.map((quote) => (
                  <tr key={quote.symbol}>
                    <th scope="row">{quote.symbol}</th>
                    <td>{quote.price_date || '—'}</td>
                    <td>{money(quote.price)}</td>
                    <td>
                      {quote.quote_status === 'ok'
                        ? t('有效', 'Available')
                        : t(
                            quote.reason || '不可用',
                            'A valid open for the specified date is unavailable',
                          )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {evaluation.orders.length > 0 && (
            <div
              className="table-scroll"
              tabIndex={0}
              aria-label={t('開盤模擬變動', 'Open simulation trades')}
            >
              <table>
                <thead>
                  <tr>
                    {[
                      t('標的', 'Symbol'),
                      t('變動', 'Change'),
                      t('固定股數', 'Frozen shares'),
                      t('未調整開盤價', 'Raw open'),
                      t('含滑價模擬價', 'Simulated price with slippage'),
                      t('費用', 'Fee'),
                      t('現金變動', 'Cash change'),
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {evaluation.orders.map((row) => (
                    <tr key={row.symbol}>
                      <th scope="row">{row.symbol}</th>
                      <td>{row.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                      <td>{num(row.shares, 8)}</td>
                      <td>{money(row.reference_price)}</td>
                      <td>{money(row.fill_price)}</td>
                      <td>{money(row.fee)}</td>
                      <td>{money(row.cash_delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="next-open-meta">
            {evaluation.engine_version} · {t('行情輸入版本', 'Market input revision')}:{' '}
            {evaluation.input_revision} · {t('指定開盤資料指紋', 'Specified-open data fingerprint')}
            : {evaluation.open_price_fingerprint || '—'}
          </p>
        </>
      )}
      <h3>{t('處理紀錄（最近 20 次）', 'Processing log (latest 20 attempts)')}</h3>
      {order.attempts.length ? (
        <ol className="next-open-events">
          {order.attempts.map((attempt) => (
            <li key={attempt.id}>
              <time>{utc(attempt.created_at)}</time>
              <strong>
                {attempt.trigger_kind === 'manual'
                  ? t('手動', 'Manual')
                  : t('本機排程', 'Local scheduler')}
              </strong>{' '}
              · {reasonText(attempt.reason_code, attempt.reason, t)}
              <br />
              <code>{attempt.reason_code}</code> · {attempt.input_revision}
            </li>
          ))}
        </ol>
      ) : (
        <p>
          {t(
            '尚未處理；已排隊不等於已成交。',
            'No processing attempt yet. Queued does not mean filled.',
          )}
        </p>
      )}
      <details className="agent-method">
        <summary>{t('來源版本與方法', 'Source versions and method')}</summary>
        <p>
          {t(
            order.method,
            'Freeze the authorized shares, policies and caps before the specified open. After that session completes, use only its locally stored raw opens plus adverse slippage, checking the entire batch against cash and policy limits. Missing data never changes the date or fills a value. No partial recording, provider calls or real trading.',
          )}
        </p>
        <pre className="next-open-json">
          {JSON.stringify(
            {
              engine_version: order.engine_version,
              source_account_version: order.source_account_version,
              source_input_revision: order.source_input_revision,
              source_proposal_fingerprint: order.source_proposal_fingerprint,
              source_prefix: order.source_prefix,
              limits: order.limits,
              execution_policy: order.execution_policy,
              created_at: order.created_at,
              completed_at: order.completed_at,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  )
}
