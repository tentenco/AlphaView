import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import {
  newPaperKey,
  type PaperAccount,
  type PaperProposal,
  type PaperSnapshot,
} from './paper-model'
import {
  decimalText,
  orderCancelable,
  submissionActive,
  type AlpacaConnection,
  type ExecutionHistory,
  type ExecutionOrder,
  type ExecutionSubmission,
  type ExecutionTargetId,
  type ExecutionTargets,
  type ExecutionSweep,
} from './execution-model'
import { AgentDailyReport } from './AgentDailyReport'
import { AgentReadiness } from './AgentReadiness'
import { AgentDecisionOutcomes } from './AgentDecisionOutcomes'
import { executionReview, skippedContext, type OrderReview } from './execution-review'
import { ExecutionSweepHistory, REVIEW_REASONS, sweepTriggerLabel } from './ExecutionSweepHistory'
import { dateTime, money, num } from './ui'
import './trading-agent.css'

type Translate = (zh: string, en: string) => string
type Props = {
  account: PaperAccount
  snapshot: PaperSnapshot
  locale: Locale
  onAccountChanged: () => void
}
const ENGLISH: Record<string, string> = {
  not_configured: 'Configure the Alpaca Paper connection first.',
  orders_disabled:
    'Alpaca Paper orders are not enabled. Enable them with the confirmation phrase first.',
  acknowledgement_required: 'Tick the acknowledgement before sending orders to Alpaca Paper.',
  confirmation_required: 'Enter the exact confirmation phrase to enable paper orders.',
  connection_changed: 'The connection changed. Reload and try again.',
  kill_switch: 'The paper account is paused; nothing can be executed.',
  proposal_not_executable: 'Only an unaccepted, executable proposal can be submitted.',
  inputs_changed: 'The session or market data changed. Recreate the proposal.',
  account_changed: 'The account changed after the proposal was created. Recreate it.',
  preview_mismatch: 'The proposal no longer passes the paper checks. Recreate it.',
  order_count_cap: 'The proposal has more orders than the per-submission cap.',
  order_notional_cap: 'An order exceeds the per-order notional cap.',
  quantity_precision: 'A quantity rounds to zero at nine decimals.',
  idempotency_conflict: 'This request key was already used with different content.',
  submission_not_found: 'The submission no longer exists.',
  order_not_found: 'The order no longer exists.',
  order_changed: 'The order status changed; reload before cancelling.',
  order_not_cancelable: 'This order cannot be cancelled in its current state.',
  reconcile_required: 'Reconcile first so the order has a broker id.',
  not_reconcilable: 'Local ledger executions do not need reconciliation.',
  circuit_breaker_tripped: 'A circuit breaker tripped; execution is blocked.',
  network_unavailable: 'Alpaca Paper is unreachable; outcomes are unknown until reconciled.',
  rate_limited: 'Alpaca asked for a lower request rate. Retry later.',
  provider_unavailable: 'Alpaca did not respond successfully; reconcile later.',
  authentication_failed: 'The paper credentials were rejected.',
}
const codeLabel = (code: string, fallback: string, t: Translate) =>
  t(fallback, ENGLISH[code] || fallback)
export async function executionRequest<T>(
  url: string,
  t: Translate,
  init?: RequestInit,
): Promise<T> {
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
      throw new Error(
        codeLabel(
          detail.code,
          typeof detail.message === 'string' ? detail.message : detail.code,
          t,
        ),
      )
    throw new Error(
      typeof detail === 'string'
        ? t(
            detail,
            /[㐀-鿿]/.test(detail)
              ? 'The request was refused. Reload the account and try again.'
              : detail,
          )
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
const submissionLabel = (status: ExecutionSubmission['status'], t: Translate) =>
  ({
    simulated: t('已在本機模擬', 'Simulated locally'),
    submitted: t('已送出，等待成交', 'Submitted, working'),
    partially_filled: t('部分成交', 'Partially filled'),
    filled: t('全部成交', 'Filled'),
    cancelled: t('已取消', 'Cancelled'),
    rejected: t('遭拒絕', 'Rejected'),
    mixed: t('結果混合', 'Mixed outcome'),
    unknown: t('結果未知，需核對', 'Unknown, reconcile'),
  })[status]
const orderLabel = (status: ExecutionOrder['status'], t: Translate) =>
  ({
    pending: t('未送出', 'Not sent'),
    accepted: t('券商已接受', 'Accepted'),
    partially_filled: t('部分成交', 'Partially filled'),
    filled: t('已成交', 'Filled'),
    cancel_requested: t('取消中', 'Cancel requested'),
    cancelled: t('已取消', 'Cancelled'),
    expired: t('已過期', 'Expired'),
    rejected: t('遭拒絕', 'Rejected'),
    unknown: t('未知', 'Unknown'),
    skipped: t('略過（未送出）', 'Skipped (not sent)'),
  })[status]
const UNAVAILABLE_REASONS: Record<NonNullable<OrderReview['unavailable']>, [string, string]> = {
  receipt_missing: ['沒有可讀取的已保存清掃紀錄', 'No readable saved sweep receipt'],
  entry_missing: ['最近清掃未記錄這筆委託', 'The last sweep did not record this order'],
  invalid_entry: [
    '已保存欄位缺失或身分不一致',
    'Saved fields are missing or identities do not match',
  ],
  ambiguous_entry: [
    '同一委託有多筆清掃項目，無法判定',
    'Multiple sweep entries for this order are ambiguous',
  ],
}
const reviewReasonLabel = (key: string, t: Translate) => {
  if (key === 'unavailable')
    return t('清掃證據不可用或不完整', 'Sweep evidence unavailable or incomplete')
  const separator = key.indexOf(':')
  const origin = key.slice(0, separator)
  const code = key.slice(separator + 1)
  const label = REVIEW_REASONS[code]
  const description = label ? `${t(...label)} (${code})` : code
  return `${origin === 'order' ? t('目前記錄的錯誤', 'Current recorded error') : t('最近清掃紀錄', 'Last recorded sweep')}: ${description}`
}
const reviewedOrderLabel = (row: OrderReview, t: Translate) => {
  const context = skippedContext(row)
  return row.order.status === 'skipped' && context
    ? `${orderLabel(row.order.status, t)} · ${t(...REVIEW_REASONS[context])}`
    : orderLabel(row.order.status, t)
}
const statusClass = (status: ExecutionSubmission['status']) =>
  status === 'unknown' || status === 'rejected'
    ? 'is-failed'
    : submissionActive(status)
      ? 'is-open'
      : 'is-terminal'

export function PortfolioTradingAgent(props: Props) {
  return <TradingAgentAccount key={props.account.id} {...props} />
}

function TradingAgentAccount({ account, snapshot, locale, onAccountChanged }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [targets, setTargets] = useState<ExecutionTargets | null>(null)
  const [connection, setConnection] = useState<AlpacaConnection | null>(null)
  const [history, setHistory] = useState<ExecutionSubmission[]>([])
  const [selected, setSelected] = useState<ExecutionSubmission | null>(null)
  const [detailFilter, setDetailFilter] = useState({ submission: '', reason: 'all' })
  const [proposalId, setProposalId] = useState('')
  const [target, setTarget] = useState<ExecutionTargetId>('paper_ledger')
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [notional, setNotional] = useState('')
  const [orderCap, setOrderCap] = useState('')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [band, setBand] = useState('')
  const [overrideType, setOverrideType] = useState<'connection' | 'market' | 'limit'>('connection')
  const [overrideBand, setOverrideBand] = useState('')
  const [sweepAck, setSweepAck] = useState(false)
  const [sweep, setSweep] = useState<ExecutionSweep | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [refresh, setRefresh] = useState(0)
  const operation = useRef<AbortController | null>(null)
  const submitAttempt = useRef({ input: '', key: '' })
  const proposals = snapshot.proposals.filter((row) => row.status === 'proposed')
  const proposal = proposals.find((row) => row.id === proposalId) || null
  const alpacaTarget = targets?.targets.find((row) => row.id === 'alpaca_paper') || null
  const alpacaReady = !!alpacaTarget?.available
  const overrideBandValue = overrideBand.trim() === '' ? null : Number(overrideBand)
  const overrideValid =
    overrideType !== 'limit' ||
    overrideBandValue === null ||
    (Number.isFinite(overrideBandValue) && overrideBandValue >= 0 && overrideBandValue <= 500)
  const canSubmit =
    !!proposal &&
    !busy &&
    !account.kill_switch &&
    (target === 'paper_ledger' || (alpacaReady && acknowledged && overrideValid))
  const workingSubmissions = history.filter((row) => row.target === 'alpaca_paper' && !row.terminal)
  const review = selected?.orders ? executionReview(selected) : null
  const reviewFilter = detailFilter.submission === selected?.id ? detailFilter.reason : 'all'
  const reviewedOrders =
    review?.rows.filter((row) => reviewFilter === 'all' || row.reasons.includes(reviewFilter)) ?? []

  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.allSettled([
      executionRequest<ExecutionTargets>('/api/execution/targets', t, {
        signal: controller.signal,
      }),
      executionRequest<AlpacaConnection>('/api/alpaca-paper/connection', t, {
        signal: controller.signal,
      }),
      executionRequest<ExecutionHistory>(
        `/api/execution/accounts/${encodeURIComponent(account.id)}/submissions?limit=20`,
        t,
        { signal: controller.signal },
      ),
    ]).then(([targetResult, connectionResult, historyResult]) => {
      if (controller.signal.aborted) return
      const errors: string[] = []
      const reason = (item: PromiseRejectedResult) =>
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      if (targetResult.status === 'fulfilled') setTargets(targetResult.value)
      else errors.push(reason(targetResult))
      if (connectionResult.status === 'fulfilled') {
        setConnection(connectionResult.value)
        const caps = connectionResult.value.order_caps
        setNotional((current) => current || (caps ? String(caps.max_order_notional_usd) : ''))
        setOrderCap((current) => current || (caps ? String(caps.max_orders_per_submission) : ''))
        const style = connectionResult.value.order_style
        if (style) {
          setOrderType(style.type)
          setBand((current) => current || String(style.limit_band_bps))
        }
      } else errors.push(reason(connectionResult))
      if (historyResult.status === 'fulfilled') setHistory(historyResult.value.submissions)
      else errors.push(reason(historyResult))
      setLoadErrors(errors)
    })
    return () => controller.abort()
    // Labels re-render with the locale; no refetch is needed for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, account.id, account.version])

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
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  function savePolicy(enable: boolean) {
    if (!connection?.version) return
    void perform('policy', async (signal) => {
      const value = await executionRequest<AlpacaConnection>('/api/alpaca-paper/orders-policy', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          expected_version: connection.version,
          orders_enabled: enable,
          ...(enable ? { confirmation: confirmation.trim() } : {}),
          ...(notional.trim() ? { max_order_notional_usd: Number(notional) } : {}),
          ...(orderCap.trim() ? { max_orders_per_submission: Number(orderCap) } : {}),
          order_type: orderType,
          ...(band.trim() ? { limit_band_bps: Number(band) } : {}),
        }),
      })
      if (signal.aborted) return
      setConnection(value)
      setConfirmation('')
      setNotice(
        enable
          ? t(
              '已啟用 Alpaca Paper 委託；仍需逐筆確認送出。',
              'Alpaca Paper orders enabled; each submission still needs an explicit acknowledgement.',
            )
          : t('已停用 Alpaca Paper 委託。', 'Alpaca Paper orders disabled.'),
      )
      setRefresh((value) => value + 1)
    })
  }
  function showSubmission(data: ExecutionSubmission) {
    setSelected(data)
    setDetailFilter((current) =>
      current.submission === data.id ? current : { submission: data.id, reason: 'all' },
    )
    setHistory((rows) => [data, ...rows.filter((row) => row.id !== data.id)].slice(0, 20))
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit || !proposal) return
    const body = {
      target,
      expected_account_version: account.version,
      acknowledge_external: target === 'alpaca_paper' ? acknowledged : false,
      ...(target === 'alpaca_paper' && overrideType !== 'connection'
        ? {
            order_style_override: {
              type: overrideType,
              ...(overrideType === 'limit' && overrideBandValue !== null
                ? { limit_band_bps: overrideBandValue }
                : {}),
            },
          }
        : {}),
    }
    const input = JSON.stringify([proposal.id, body])
    if (submitAttempt.current.input !== input) submitAttempt.current = { input, key: newPaperKey() }
    const key = submitAttempt.current.key
    void perform('submit', async (signal) => {
      const data = await executionRequest<ExecutionSubmission>(
        `/api/execution/accounts/${encodeURIComponent(account.id)}/proposals/${encodeURIComponent(proposal.id)}/submit`,
        t,
        { method: 'POST', signal, body: JSON.stringify({ ...body, idempotency_key: key }) },
      )
      if (signal.aborted) return
      submitAttempt.current = { input: '', key: '' }
      setAcknowledged(false)
      setProposalId('')
      showSubmission(data)
      setNotice(
        data.target === 'paper_ledger'
          ? t('提案已在本機模擬帳本成交。', 'The proposal was simulated in the local ledger.')
          : t(
              '委託已記錄並送往 Alpaca Paper；請核對成交狀態。',
              'Orders were recorded and sent to Alpaca Paper; reconcile to see fills.',
            ),
      )
      onAccountChanged()
    })
  }
  function sweepWorking() {
    if (!sweepAck || busy) return
    void perform('sweep', async (signal) => {
      const data = await executionRequest<ExecutionSweep>(
        `/api/execution/accounts/${encodeURIComponent(account.id)}/cancel-working`,
        t,
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            expected_account_version: account.version,
            reason: 'manual_sweep',
          }),
        },
      )
      if (signal.aborted) return
      setSweep(data)
      setSweepAck(false)
      setRefresh((value) => value + 1)
      setNotice(
        data.nothing_to_do
          ? t('沒有未完結的 Alpaca Paper 委託。', 'No working Alpaca Paper orders.')
          : t(
              `已對 ${data.orders_considered} 筆未完結委託處理：${Object.entries(data.counts)
                .map(([key, value]) => `${key} ${value}`)
                .join('、')}。請核對結果。`,
              `${data.orders_considered} working order(s) processed: ${Object.entries(data.counts)
                .map(([key, value]) => `${key} ${value}`)
                .join(', ')}. Reconcile to confirm.`,
            ),
      )
    })
  }
  function open(id: string) {
    void perform('detail', async (signal) => {
      const data = await executionRequest<ExecutionSubmission>(
        `/api/execution/submissions/${encodeURIComponent(id)}`,
        t,
        { signal },
      )
      if (!signal.aborted) showSubmission(data)
    })
  }
  function reconcile(id: string) {
    void perform('reconcile', async (signal) => {
      const data = await executionRequest<ExecutionSubmission>(
        `/api/execution/submissions/${encodeURIComponent(id)}/reconcile`,
        t,
        { method: 'POST', signal },
      )
      if (!signal.aborted) showSubmission(data)
    })
  }
  function cancel(order: ExecutionOrder) {
    void perform('cancel', async (signal) => {
      const data = await executionRequest<ExecutionSubmission>(
        `/api/execution/orders/${encodeURIComponent(order.id)}/cancel`,
        t,
        { method: 'POST', signal, body: JSON.stringify({ expected_status: order.status }) },
      )
      if (!signal.aborted) showSubmission(data)
    })
  }
  const stages: [string, string, string, string][] = [
    ['資料', 'Data', '本機日線與最新完成交易日', 'Local daily bars, latest completed session'],
    [
      '研究',
      'Research',
      '選股、規則工作流、Research Desk',
      'Screen, rules workflow, Research Desk',
    ],
    ['決策閘', 'Gate', 'Jev 機率門檻（選用）', 'Jev probability thresholds (optional)'],
    ['風險', 'Risk', '帳戶限制、允許標的、斷路器', 'Account limits, allowlist, circuit breakers'],
    [
      '執行',
      'Execute',
      '本機帳本或 Alpaca Paper，皆需明確確認',
      'Local ledger or Alpaca Paper, always acknowledged',
    ],
  ]
  return (
    <div className="trading-agent">
      <AgentReadiness account={account} locale={locale} />
      <section className="agent-panel" aria-label={t('交易代理管線', 'Trading agent pipeline')}>
        <div className="section-heading">
          <div>
            <div className="eyebrow">TRADING AGENT / PAPER EXECUTION</div>
            <h2>{t('交易代理', 'Trading agent')}</h2>
            <p>
              {t(
                '從資料到執行的每一步都留下紀錄，執行只到 paper：本機模擬帳本，或明確啟用的 Alpaca Paper 委託。沒有實盤券商目標。',
                'Every step from data to execution is recorded, and execution stops at paper: the local ledger or explicitly enabled Alpaca Paper orders. There is no live-broker target.',
              )}
            </p>
          </div>
          <span className="agent-mode">
            {t('僅限 paper · 需逐筆確認', 'Paper only · acknowledged per submission')}
          </span>
        </div>
        <ol className="trading-agent-stages">
          {stages.map(([zh, en, zhDetail, enDetail], index) => (
            <li key={en}>
              <strong>
                {index + 1}. {t(zh, en)}
              </strong>
              <span>{t(zhDetail, enDetail)}</span>
            </li>
          ))}
        </ol>
        <div className="trading-agent-targets">
          {(targets?.targets || []).map((row) => (
            <div
              key={row.id}
              className={`trading-agent-target ${row.available ? 'is-available' : 'is-blocked'}`}
            >
              <strong>{t(row.label, row.english)}</strong>
              <small>
                {row.available
                  ? row.caps
                    ? `${t('每筆上限', 'Per-order cap')} $${num(row.caps.max_order_notional_usd, 0)} · ${t('每次最多', 'Max per submission')} ${row.caps.max_orders_per_submission} · ${row.order_style?.type === 'limit' ? `${t('限價', 'Limit')} ±${num(row.order_style.limit_band_bps, 0)} bps` : t('市價', 'Market')}`
                    : t('可用', 'Available')
                  : codeLabel(
                      row.reason || '',
                      row.reason === 'not_configured'
                        ? '尚未設定 Alpaca Paper 連線'
                        : 'Alpaca Paper 委託尚未啟用',
                      t,
                    )}
              </small>
            </div>
          ))}
          {targets && (
            <div className="trading-agent-target is-blocked">
              <strong>{t('實盤券商', 'Live broker')}</strong>
              <small>
                {t('不提供：', 'Not available: ')}
                {targets.live_trading.reason}
              </small>
            </div>
          )}
        </div>
        {loadErrors.map((message, index) => (
          <p className="error-message" role="alert" key={index}>
            {message}
          </p>
        ))}
      </section>

      <section
        className="agent-panel"
        aria-label={t('Alpaca Paper 委託政策', 'Alpaca Paper order policy')}
      >
        <h2>{t('Alpaca Paper 委託政策', 'Alpaca Paper order policy')}</h2>
        {!connection?.configured ? (
          <p>
            {t(
              '尚未設定 Alpaca Paper 連線。請先在「Alpaca Paper」視圖驗證金鑰，再回到這裡啟用委託。',
              'No Alpaca Paper connection yet. Verify the keys in the Alpaca Paper view first, then enable orders here.',
            )}
          </p>
        ) : (
          <>
            <p className="trading-agent-meta">
              {t('狀態', 'Status')}:{' '}
              {connection.orders_enabled ? t('已啟用', 'Enabled') : t('已停用', 'Disabled')} ·{' '}
              {t('連線於', 'Connected')} {dateTime(connection.connected_at)} · {connection.endpoint}
            </p>
            <div className="agent-form-grid">
              <label>
                {t('每筆委託參考金額上限（USD）', 'Per-order notional cap (USD)')}
                <input
                  inputMode="decimal"
                  value={notional}
                  onChange={(event) => setNotional(event.target.value)}
                />
              </label>
              <label>
                {t('每次送出最多筆數', 'Max orders per submission')}
                <input
                  inputMode="numeric"
                  value={orderCap}
                  onChange={(event) => setOrderCap(event.target.value)}
                />
              </label>
              <label>
                {t('委託型態', 'Order style')}
                <select
                  value={orderType}
                  onChange={(event) => setOrderType(event.target.value as 'market' | 'limit')}
                >
                  <option value="market">{t('市價 DAY', 'Market DAY')}</option>
                  <option value="limit">
                    {t('限價 DAY（參考價 ± 限價帶）', 'Limit DAY (reference ± band)')}
                  </option>
                </select>
              </label>
              {orderType === 'limit' && (
                <label>
                  {t('限價帶（基點，0–500）', 'Limit band (bps, 0–500)')}
                  <input
                    inputMode="decimal"
                    value={band}
                    onChange={(event) => setBand(event.target.value)}
                  />
                </label>
              )}
              {!connection.orders_enabled && (
                <label>
                  {t(
                    `輸入確認字串 ${connection.enable_confirmation}`,
                    `Type the confirmation phrase ${connection.enable_confirmation}`,
                  )}
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              )}
            </div>
            <div className="actions">
              {connection.orders_enabled ? (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy}
                  onClick={() => savePolicy(false)}
                >
                  {t('停用 Paper 委託', 'Disable paper orders')}
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={!!busy || confirmation.trim() !== connection.enable_confirmation}
                  onClick={() => savePolicy(true)}
                >
                  {t('啟用 Paper 委託', 'Enable paper orders')}
                </button>
              )}
              {connection.orders_enabled && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy}
                  onClick={() => savePolicy(true)}
                >
                  {t('更新上限與型態', 'Update caps and style')}
                </button>
              )}
            </div>
            <p className="trading-agent-meta">
              {t(
                '啟用後的每次送出仍需勾選確認；重新設定金鑰會自動回到停用。委託只會送到 paper-api.alpaca.markets。',
                'Even when enabled, every submission needs its own acknowledgement; saving new keys resets orders to disabled. Orders only ever go to paper-api.alpaca.markets.',
              )}
            </p>
          </>
        )}
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
      </section>

      <section className="agent-panel" aria-label={t('送出提案執行', 'Submit a proposal')}>
        <h2>{t('送出提案執行', 'Submit a proposal')}</h2>
        <form onSubmit={submit}>
          <div className="agent-form-grid">
            <label>
              {t('待審閱的提案', 'Proposal awaiting review')}
              <select value={proposalId} onChange={(event) => setProposalId(event.target.value)}>
                <option value="">{t('選擇提案', 'Select a proposal')}</option>
                {proposals.map((row: PaperProposal) => (
                  <option key={row.id} value={row.id}>
                    {dateTime(row.created_at)} ·{' '}
                    {row.targets.map((item) => item.symbol).join(' · ') || t('全現金', 'All cash')}{' '}
                    · {row.orders.length} {t('筆', 'orders')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('執行目標', 'Execution target')}
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value as ExecutionTargetId)}
              >
                <option value="paper_ledger">{t('本機模擬帳本', 'Local paper ledger')}</option>
                <option value="alpaca_paper" disabled={!alpacaReady}>
                  {t('Alpaca Paper 委託', 'Alpaca Paper orders')}
                  {alpacaReady ? '' : ` (${t('未啟用', 'not enabled')})`}
                </option>
              </select>
            </label>
          </div>
          {proposal && (
            <p className="trading-agent-meta">
              {t('成本合計', 'Total cost')} {money(proposal.cost_total)} · {t('換手', 'Turnover')}{' '}
              {proposal.turnover_pct == null ? '—' : `${num(proposal.turnover_pct, 1)}%`} ·{' '}
              {t('模擬後現金', 'Cash after')} {money(proposal.cash_after)}
            </p>
          )}
          {target === 'alpaca_paper' && (
            <div className="agent-form-grid">
              <label>
                {t('委託型態（本次送出）', 'Order style (this submission)')}
                <select
                  value={overrideType}
                  onChange={(event) =>
                    setOverrideType(event.target.value as 'connection' | 'market' | 'limit')
                  }
                >
                  <option value="connection">
                    {t('依連線設定', 'Connection default')} (
                    {connection?.order_style?.type === 'limit'
                      ? `${t('限價', 'limit')} ±${num(connection.order_style.limit_band_bps, 0)} bps`
                      : t('市價', 'market')}
                    )
                  </option>
                  <option value="market">{t('市價 DAY', 'Market DAY')}</option>
                  <option value="limit">
                    {t('限價 DAY（參考價 ± 限價帶）', 'Limit DAY (reference ± band)')}
                  </option>
                </select>
              </label>
              {overrideType === 'limit' && (
                <label>
                  {t(
                    '限價帶 bps（0–500，留空用連線設定）',
                    'Limit band bps (0–500, blank = connection band)',
                  )}
                  <input
                    inputMode="decimal"
                    value={overrideBand}
                    onChange={(event) => setOverrideBand(event.target.value)}
                    aria-invalid={!overrideValid}
                  />
                </label>
              )}
            </div>
          )}
          {target === 'alpaca_paper' && (
            <label className="trading-agent-acknowledge">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                {t(
                  '我了解這會在我的 Alpaca Paper 帳戶送出真實的模擬市價委託（DAY），成交價可能與提案參考價不同，且不會回寫本機模擬帳本。',
                  'I understand this sends real market DAY orders to my Alpaca Paper account, fills can differ from the proposal reference prices, and nothing is written back to the local paper ledger.',
                )}
              </span>
            </label>
          )}
          <div className="actions">
            <button className="button primary" disabled={!canSubmit}>
              {busy === 'submit'
                ? t('送出中…', 'Submitting…')
                : target === 'alpaca_paper'
                  ? t('送出到 Alpaca Paper', 'Send to Alpaca Paper')
                  : t('在本機模擬成交', 'Simulate in local ledger')}
            </button>
          </div>
          {account.kill_switch && (
            <p className="notice">
              {t('帳戶已暫停，無法執行。', 'The account is paused; nothing can be executed.')}
            </p>
          )}
          {!!workingSubmissions.length && (
            <div
              className="trading-agent-sweep"
              aria-label={t('取消未完結委託', 'Cancel working orders')}
            >
              <label className="trading-agent-acknowledge">
                <input
                  type="checkbox"
                  checked={sweepAck}
                  onChange={(event) => setSweepAck(event.target.checked)}
                />
                <span>
                  {t(
                    `對此帳戶 ${workingSubmissions.length} 筆未終態送出紀錄中的每一筆未完結 Alpaca Paper 委託各送出一次取消請求；取消不保證在成交前到達，之後請核對。暫停帳戶（殺手開關或斷路器）時會自動執行同樣的清掃。`,
                    `Send one cancel request for every working Alpaca Paper order across ${workingSubmissions.length} open submission(s) of this account; a cancel may arrive after a fill, so reconcile afterwards. Pausing the account (kill switch or circuit breaker) runs the same sweep automatically.`,
                  )}
                </span>
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={!sweepAck || !!busy}
                  onClick={sweepWorking}
                >
                  {busy === 'sweep'
                    ? t('取消中…', 'Cancelling…')
                    : t('取消所有未完結委託', 'Cancel all working orders')}
                </button>
              </div>
              {sweep && (
                <p className="trading-agent-meta">
                  {t('上次清掃', 'Last sweep')} {dateTime(sweep.at)} ·{' '}
                  {sweepTriggerLabel(sweep.reason, t)} ·{' '}
                  {sweep.results
                    .map((item) => `${item.symbol} ${item.previous_status} → ${item.action ?? '—'}`)
                    .join(' · ') || t('沒有未完結委託', 'nothing working')}
                  {sweep.error ? ` · ${sweep.error.code}` : ''}
                </p>
              )}
            </div>
          )}
          {!proposals.length && (
            <p className="trading-agent-meta">
              {t(
                '目前沒有待審閱的提案。先在配置與提案、Agent 工作流、Jev 決策閘或回測研究台建立提案。',
                'No proposal is awaiting review. Create one from allocation & proposals, the Agent workflow, the Jev gate or the Research Desk first.',
              )}
            </p>
          )}
        </form>
      </section>

      <section className="agent-panel" aria-label={t('執行紀錄', 'Execution history')}>
        <div className="section-heading">
          <h2>{t('執行紀錄', 'Execution history')}</h2>
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('重新整理', 'Refresh')}
          </button>
        </div>
        {!history.length ? (
          <p>{t('尚無執行紀錄。', 'No executions yet.')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('時間', 'Time'),
                    t('目標', 'Target'),
                    t('狀態', 'Status'),
                    t('委託', 'Orders'),
                    t('提案', 'Proposal'),
                    t('操作', 'Actions'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{dateTime(row.created_at)}</td>
                    <td>
                      {row.target === 'paper_ledger'
                        ? t('本機帳本', 'Local ledger')
                        : 'Alpaca Paper'}
                      {row.summary.order_style_source === 'override' && (
                        <small> · {t('型態覆寫', 'style override')}</small>
                      )}
                      {!!row.summary.kill_switch_sweep && <small> · {t('已清掃', 'swept')}</small>}
                    </td>
                    <td>
                      <span className={`trading-agent-status ${statusClass(row.status)}`}>
                        {submissionLabel(row.status, t)}
                      </span>
                      {!!row.partial_fills && (
                        <small>
                          {t(
                            `部分成交 ${row.partial_fills} 筆`,
                            `${row.partial_fills} partial fill(s)`,
                          )}
                        </small>
                      )}
                    </td>
                    <td>{row.order_count}</td>
                    <td>{row.proposal_id.slice(0, 12)}</td>
                    <td>
                      <div className="actions" style={{ margin: 0 }}>
                        <button
                          type="button"
                          className="button"
                          disabled={!!busy}
                          onClick={() => open(row.id)}
                          aria-pressed={selected?.id === row.id}
                        >
                          {t('明細', 'Details')}
                        </button>
                        {row.target === 'alpaca_paper' && !row.terminal && (
                          <button
                            type="button"
                            className="button"
                            disabled={!!busy}
                            onClick={() => reconcile(row.id)}
                          >
                            {t('核對', 'Reconcile')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selected?.orders && review && (
          <div aria-label={t('執行明細', 'Execution details')}>
            <h3>
              {submissionLabel(selected.status, t)} · {selected.as_of} · {selected.engine_version}
              {selected.summary.order_style_source
                ? ` · ${t('型態', 'style')} ${String(selected.summary.order_type ?? '')} (${
                    selected.summary.order_style_source === 'override'
                      ? t('本次覆寫', 'override')
                      : t('依連線', 'connection')
                  })`
                : ''}
            </h3>
            {selected.target === 'alpaca_paper' && (
              <section aria-label={t('已保存的清掃檢閱', 'Saved sweep review')}>
                <p className="research-note">
                  {t(
                    '篩選僅涵蓋這筆送出紀錄的全部委託。最近清掃紀錄是歷史證據，不是目前券商狀態；取消請求不代表已取消，也不是完整清掃歷程。',
                    'Filters cover every order in this selected submission only. The last saved sweep is historical evidence, not current broker status; a cancel request does not confirm cancellation or provide a complete sweep history.',
                  )}
                </p>
                <p className="trading-agent-meta">
                  {t('最近清掃時間', 'Last recorded sweep time')}:{' '}
                  {review.at ? dateTime(review.at) : '—'}
                  {' · '}
                  {t('清掃觸發原因', 'Sweep trigger')}: {sweepTriggerLabel(review.reason, t)}
                </p>
                {!review.receiptAvailable && (
                  <p className="notice">
                    {t(
                      '已保存的清掃證據不可用或不完整；不推測未記錄的原因。',
                      'Saved sweep evidence is unavailable or incomplete; unrecorded reasons are not inferred.',
                    )}
                  </p>
                )}
                {review.unassociatedResults > 0 && (
                  <p className="notice">
                    {t(
                      '無法對應至這筆送出紀錄的清掃項目',
                      'Sweep entries that cannot be associated with this submission',
                    )}
                    : {review.unassociatedResults}
                  </p>
                )}
                <label className="agent-field">
                  {t('這筆送出紀錄的原因篩選', 'Reason filter for this submission')}
                  <select
                    value={reviewFilter}
                    onChange={(event) =>
                      setDetailFilter({ submission: selected.id, reason: event.target.value })
                    }
                  >
                    <option value="all">
                      {t('全部委託', 'All orders')} ({review.rows.length})
                    </option>
                    {review.filters.map(([key, count]) => (
                      <option key={key} value={key}>
                        {reviewReasonLabel(key, t)} ({count})
                      </option>
                    ))}
                    {reviewFilter !== 'all' &&
                      !review.filters.some(([key]) => key === reviewFilter) && (
                        <option value={reviewFilter}>
                          {reviewReasonLabel(reviewFilter, t)} (0)
                        </option>
                      )}
                  </select>
                </label>
                <p className="trading-agent-meta">
                  {t('顯示委託', 'Orders shown')}: {reviewedOrders.length} / {review.rows.length} ·{' '}
                  {t(
                    '同一委託可能具有多項原因；篩選不會送出或取消委託。',
                    'An order can have several reasons; filtering does not submit or cancel orders.',
                  )}
                </p>
              </section>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('標的', 'Symbol'),
                      t('方向', 'Side'),
                      t('股數', 'Qty'),
                      t('參考價', 'Reference'),
                      t('型態', 'Type'),
                      t('狀態', 'Status'),
                      t('最近清掃紀錄', 'Last recorded sweep'),
                      t('成交', 'Filled'),
                      t('券商編號', 'Broker id'),
                      t('操作', 'Actions'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reviewedOrders.map((row) => {
                    const { order } = row
                    return (
                      <tr key={order.id}>
                        <th scope="row">{order.symbol}</th>
                        <td>{order.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                        <td>{decimalText(order.qty)}</td>
                        <td>{decimalText(order.reference_price)}</td>
                        <td>
                          {order.order_type === 'limit'
                            ? `${t('限價', 'Limit')} @ ${decimalText(order.limit_price)}`
                            : t('市價', 'Market')}
                        </td>
                        <td>
                          {reviewedOrderLabel(row, t)}
                          {order.error && (
                            <small>
                              {codeLabel(
                                order.error.code,
                                order.error.message || order.error.code,
                                t,
                              )}
                            </small>
                          )}
                        </td>
                        <td className="workflow-reason-cell">
                          {row.sweep ? (
                            <>
                              <span>
                                {row.sweep.previousStatus ?? '—'} → {row.sweep.action ?? '—'}
                              </span>
                              {row.sweep.error && (
                                <p>
                                  {row.sweep.error.code ?? '—'}
                                  {row.sweep.error.httpStatus !== null
                                    ? ` · HTTP ${row.sweep.error.httpStatus}`
                                    : ''}
                                  {row.sweep.error.message ? ` · ${row.sweep.error.message}` : ''}
                                </p>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                          {row.unavailable && (
                            <p>
                              {t('清掃證據不可用', 'Sweep evidence unavailable')}:{' '}
                              {t(...UNAVAILABLE_REASONS[row.unavailable])}
                            </p>
                          )}
                        </td>
                        <td>
                          {order.filled_qty && order.filled_qty !== '0'
                            ? `${decimalText(order.filled_qty)} @ ${decimalText(order.filled_avg_price)}`
                            : '—'}
                        </td>
                        <td>{order.broker_order_id || '—'}</td>
                        <td>
                          {orderCancelable(order.status) && order.broker_order_id && (
                            <button
                              type="button"
                              className="button"
                              disabled={!!busy}
                              onClick={() => cancel(order)}
                            >
                              {t('取消', 'Cancel')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {reviewFilter !== 'all' && !reviewedOrders.length && (
                    <tr>
                      <td colSpan={10}>
                        {t(
                          '這筆送出紀錄沒有符合原因的委託。',
                          'No orders in this submission match this reason.',
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {selected.warnings && (
              <ul className="trading-agent-meta">
                {selected.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <ExecutionSweepHistory
        accountId={account.id}
        selectedSubmissionId={selected?.id}
        locale={locale}
      />
      <AgentDailyReport account={account} locale={locale} />
      <AgentDecisionOutcomes account={account} locale={locale} />
    </div>
  )
}
