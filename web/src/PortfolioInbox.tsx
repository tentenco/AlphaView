import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import { api, dateTime, money } from './ui'
import type { NextOpenStatus } from './paper-next-open'
import './portfolio-inbox.css'

export type PortfolioInboxAction = {
  account_id: string
  proposal_id?: string
  queue_order_id?: string
  mandate_id?: string
  tab: 'plan' | 'automation' | 'next-open' | 'trading-agent' | 'risk'
}
const PROPOSAL_SOURCE_LABELS = {
  automation: ['自動化任務', 'Automation'],
  local_agent: ['本機模型', 'Local model'],
  jev: ['Jev 決策閘', 'Jev decision gate'],
  position_stops: ['部位停損標記', 'Position stops marker'],
  strategy_bridge: ['策略橋接標記', 'Strategy bridge marker'],
  rules_workflow: ['規則工作流標記', 'Rules workflow marker'],
  unknown: ['來源不明', 'Unknown source'],
} as const
type ProposalSource = keyof typeof PROPOSAL_SOURCE_LABELS
type ProposalFilter = 'all' | ProposalSource
type InboxProposal = {
  id: string
  account_id: string
  account_name: string
  review_status: 'ready' | 'stale' | 'paused' | 'blocked'
  created_at: string
  as_of: string
  targets: { symbol: string; weight_pct: number }[]
  order_count: number
  cost_total: number | null
  reasons: { code: string; message: string }[]
  provenance?: {
    engine_version: string
    source: ProposalSource
    reason: string | null
    evidence_kind: 'structured' | 'program_marker' | 'unknown'
  }
}
type Inbox = {
  as_of: string
  input_revision: string
  engine_version: string
  method: string
  counts: {
    accounts: number
    paused_accounts: number
    open_proposals: number
    simulated_proposals: number
    enabled_mandates: number
    mandates: number
    queue_orders: number
    active_queue_orders: number
    execution_events?: number
    execution_attention?: number
    attention_total?: number
    attention_critical?: number
    attention_warn?: number
    attention_unreviewed?: number
    attention_unreviewed_critical?: number
    attention_unreviewed_warn?: number
  }
  proposals: InboxProposal[]
  proposal_sources?: {
    selected: ProposalFilter
    total: number
    counts: Record<ProposalSource, number>
    provenance_engine_version: string
  }
  pagination: { limit: number; offset: number; total: number; returned: number; has_more: boolean }
  queue_orders: {
    id: string
    account_id: string
    account_name: string
    status: NextOpenStatus
    version: number
    execution_session: string
    updated_at: string
    reason_code: string
    reason: string
    source_proposal_id: string
    execution_proposal_id: string | null
    attempt_count: number
    can_process: boolean
    can_cancel: boolean
  }[]
  queue_pagination: {
    limit: number
    offset: number
    total: number
    returned: number
    has_more: boolean
  }
  mandates: {
    id: string
    name: string
    account_id: string
    account_name: string
    enabled: boolean
    mode: string
    status: string
    reason: string | null
    next_due_at: string | null
    last_checked_at: string | null
    last_attempt_status: string | null
  }[]
  recent_outcomes: {
    proposal_id: string
    account_id: string
    account_name: string
    status: string
    created_at: string
    accepted_at: string | null
  }[]
  execution_events?: InboxExecutionEvent[]
  execution_event_counts?: Record<string, number>
  attention?: InboxAttention[]
}
type InboxAttention = {
  key: string
  kind: string
  severity: 'critical' | 'warn' | 'info'
  account_id: string | null
  account_name: string | null
  at: string | null
  title_zh: string
  title_en: string
  detail: string
  event_fingerprint?: string
  acknowledgement?: {
    engine_version: string
    can_acknowledge: boolean
    acknowledged: boolean
    version: number
    acknowledged_at: string | null
    updated_at: string | null
  }
  navigation: {
    tab: PortfolioInboxAction['tab']
    proposal_id?: string
    mandate_id?: string
    order_id?: string
  } | null
}
const SEVERITY_LABELS: Record<InboxAttention['severity'], [string, string]> = {
  critical: ['緊急', 'Critical'],
  warn: ['注意', 'Warning'],
  info: ['資訊', 'Info'],
}
type InboxExecutionEvent = {
  key: string
  kind:
    | 'execution_filled'
    | 'execution_partial'
    | 'execution_expired'
    | 'execution_cancelled'
    | 'execution_rejected'
    | 'execution_unknown_outcome'
  order_id: string
  submission_id: string
  account_id: string
  account_name: string
  proposal_id: string
  target: string
  symbol: string
  side: string
  qty: string
  order_type: string
  limit_price: string | null
  status: string
  filled_qty: string | null
  filled_avg_price: string | null
  partial_fill: boolean
  at: string | null
  broker_order_id: string | null
  error: { code: string | null; message: string | null } | null
}
const EXECUTION_KINDS: Record<InboxExecutionEvent['kind'], [string, string]> = {
  execution_filled: ['已成交', 'Filled'],
  execution_partial: ['部分成交', 'Partially filled'],
  execution_expired: ['已到期', 'Expired'],
  execution_cancelled: ['已取消', 'Cancelled'],
  execution_rejected: ['已拒絕', 'Rejected'],
  execution_unknown_outcome: ['結果未知', 'Unknown outcome'],
}

export function PortfolioInbox({
  locale,
  revision,
  onOpen,
}: {
  locale: Locale
  revision: string
  onOpen: (action: PortfolioInboxAction) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [result, setResult] = useState<Inbox | null>(null)
  const [offset, setOffset] = useState(0)
  const [proposalSource, setProposalSource] = useState<ProposalFilter>('all')
  const [queueOffset, setQueueOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attentionFilter, setAttentionFilter] = useState<'all' | 'unreviewed'>('all')
  const [reviewBusy, setReviewBusy] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState('')
  const reviewOperation = useRef<AbortController | null>(null)
  const lastRequest = useRef(0)
  useEffect(() => () => reviewOperation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    let running = false
    const request = async () => {
      if (running || reviewOperation.current || document.visibilityState === 'hidden') return
      running = true
      const token = ++lastRequest.current
      setBusy(true)
      try {
        const value = await api<Inbox>(
          `/api/portfolio-agent/inbox?limit=20&offset=${offset}&queue_limit=20&queue_offset=${queueOffset}&source=${proposalSource}`,
          {
            signal: controller.signal,
          },
        )
        if (controller.signal.aborted || token !== lastRequest.current) return
        if ((value.proposal_sources?.selected ?? 'all') !== proposalSource)
          throw new Error(
            t(
              '提案來源回應不符，請重新整理待辦。',
              'Proposal source response does not match. Refresh the inbox.',
            ),
          )
        if (offset > 0 && value.pagination.total <= offset) {
          setOffset(Math.max(0, Math.floor(Math.max(0, value.pagination.total - 1) / 20) * 20))
          return
        }
        if (queueOffset > 0 && value.queue_pagination.total <= queueOffset) {
          setQueueOffset(
            Math.max(0, Math.floor(Math.max(0, value.queue_pagination.total - 1) / 20) * 20),
          )
          return
        }
        setResult(value)
        setError('')
      } catch (err) {
        if (!controller.signal.aborted && token === lastRequest.current)
          setError((err as Error).message)
      } finally {
        running = false
        if (!controller.signal.aborted) setBusy(false)
      }
    }
    void request()
    const timer = window.setInterval(() => void request(), 30000)
    document.addEventListener('visibilitychange', request)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', request)
    }
  }, [offset, queueOffset, revision, refresh, proposalSource])
  async function changeReview(item: InboxAttention) {
    if (
      reviewOperation.current ||
      !item.account_id ||
      !item.event_fingerprint ||
      !item.acknowledgement?.can_acknowledge ||
      item.kind === 'source_unavailable'
    )
      return
    const controller = new AbortController()
    reviewOperation.current = controller
    lastRequest.current++
    setReviewBusy(item.key)
    setReviewError('')
    const acknowledged = !item.acknowledgement.acknowledged
    try {
      const response = await fetch('/api/portfolio-agent/inbox/attention/acknowledgement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          event_key: item.key,
          account_id: item.account_id,
          acknowledged,
          expected_version: item.acknowledgement.version,
          expected_fingerprint: item.event_fingerprint,
        }),
      })
      if (controller.signal.aborted) return
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? t(
                '事項內容或檢閱版本已變更，請重新檢閱更新後的待辦。',
                'The event or review version changed. Review the refreshed inbox before trying again.',
              )
            : t(
                '檢閱狀態未能保存，請重新整理後重試。',
                'The review status could not be saved. Refresh and try again.',
              ),
        )
      const value = (await response.json()) as { event: InboxAttention }
      if (controller.signal.aborted) return
      if (
        value.event?.key !== item.key ||
        value.event.account_id !== item.account_id ||
        value.event.event_fingerprint !== item.event_fingerprint ||
        value.event.acknowledgement?.acknowledged !== acknowledged
      ) {
        throw new Error(
          t(
            '檢閱回應與事項不符，請重新整理待辦。',
            'The review response does not match the event. Refresh the inbox.',
          ),
        )
      }
      // This is a confirmed server receipt, never an optimistic risk-resolution state.
      setResult((current) => {
        if (!current) return current
        const attention = current.attention?.map((entry) =>
          entry.key === item.key && entry.event_fingerprint === item.event_fingerprint
            ? value.event
            : entry,
        )
        const unreviewed = attention?.filter(isUnreviewed) ?? []
        return {
          ...current,
          attention,
          counts: {
            ...current.counts,
            attention_unreviewed: unreviewed.length,
            attention_unreviewed_critical: unreviewed.filter(
              (entry) => entry.severity === 'critical',
            ).length,
            attention_unreviewed_warn: unreviewed.filter((entry) => entry.severity === 'warn')
              .length,
          },
        }
      })
    } catch (err) {
      if (!controller.signal.aborted)
        setReviewError(err instanceof Error ? err.message : String(err))
    } finally {
      if (reviewOperation.current === controller) reviewOperation.current = null
      if (!controller.signal.aborted) {
        setReviewBusy(null)
        setRefresh((value) => value + 1)
      }
    }
  }
  const isUnreviewed = (item: InboxAttention) =>
    item.kind === 'source_unavailable' || !item.acknowledgement?.acknowledged
  const visibleAttention =
    result?.attention?.filter((item) => attentionFilter === 'all' || isUnreviewed(item)) ?? []
  const proposalResultCurrent = (result?.proposal_sources?.selected ?? 'all') === proposalSource
  const queueLabels: Record<NextOpenStatus, string> = {
    waiting_session: t('等待指定交易日完成', 'Waiting for session completion'),
    waiting_prices: t('等待指定日開盤價', 'Waiting for specified-day opens'),
    blocked: t('受阻，需手動重試', 'Blocked; manual retry required'),
    filled: t('已模擬成交', 'Paper fills recorded'),
    cancelled: t('已取消', 'Cancelled'),
    invalidated: t('已失效', 'Invalidated'),
  }
  const queueReasons: Record<string, string> = {
    waiting_session: 'Waiting until the specified session has completed.',
    quote_unavailable: 'Required valid opens for the specified session are unavailable.',
    policy_blocked: 'The batch did not pass its account or authorization limits.',
    filled: 'The authorized batch was simulated and recorded.',
    cancelled: 'This order was cancelled and will not be processed.',
    account_changed: 'The account or its policy changed; the original authorization is invalid.',
    source_changed: 'The source proposal changed or no longer satisfies its conditions.',
    source_history_changed: 'The historical inputs used by the original signal changed.',
    source_history_unavailable: 'The original historical inputs cannot be verified.',
    method_changed: 'The method changed; the original authorization is invalid.',
  }
  const labels = {
    ready: t('等待檢閱', 'Ready to review'),
    stale: t('來源已變更', 'Source changed'),
    paused: t('帳戶已暫停', 'Account paused'),
    blocked: t('受限制阻塞', 'Blocked by limits'),
  }
  const reasonLabel = (reason: { code: string; message: string }) =>
    locale !== 'en'
      ? reason.message
      : {
          account_changed: 'Account changed. Generate a new proposal.',
          inputs_changed: 'Market inputs changed. Generate a new proposal.',
          session_changed: 'The proposal is from an older completed session.',
          method_changed: 'The paper method changed; this proposal is read-only.',
          automation_changed: 'The automation source changed or is no longer valid.',
          account_paused: 'Paper execution is paused for this account.',
        }[reason.code] || reason.message
  return (
    <section className="portfolio-inbox" aria-label={t('跨帳戶待辦', 'Portfolio inbox')}>
      <div className="section-heading">
        <div>
          <div className="eyebrow">ALL PAPER ACCOUNTS / INBOX</div>
          <h2>{t('需要你檢閱的決策', 'Decisions to review')}</h2>
          <p>
            {t(
              '一次查看所有模擬帳戶的未結案提案、排程狀態與最近結果。',
              'See open proposals, automation status, and recent outcomes across paper accounts.',
            )}
          </p>
        </div>
        <button className="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
          {t('重新整理待辦', 'Refresh inbox')}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!result ? (
        <p role="status">
          {busy
            ? t('載入待辦…', 'Loading inbox…')
            : t('尚無可用待辦資料。', 'Inbox data is unavailable.')}
        </p>
      ) : (
        <>
          {result.attention && (
            <section
              className="agent-panel portfolio-inbox-attention"
              aria-label={t('需要處理', 'Needs attention')}
            >
              <h3>
                {t('需要處理', 'Needs attention')}
                <small>
                  {' '}
                  · {t('緊急', 'critical')} {result.counts.attention_critical ?? 0} ·{' '}
                  {t('注意', 'warnings')} {result.counts.attention_warn ?? 0}
                </small>
              </h3>
              <p className="research-note">
                {t(
                  '已檢閱只表示看過這份內容，不代表風險解除；內容變更會重新顯示未檢閱。來源不可用仍會保留。',
                  'Reviewed means this content was read, not that the risk was resolved. Changed content becomes unreviewed again. Unavailable sources remain visible.',
                )}
              </p>
              <div className="portfolio-inbox-attention-controls">
                <label>
                  {t('檢閱篩選', 'Review filter')}
                  <select
                    value={attentionFilter}
                    onChange={(event) =>
                      setAttentionFilter(event.target.value as 'all' | 'unreviewed')
                    }
                  >
                    <option value="all">{t('全部事項', 'All events')}</option>
                    <option value="unreviewed">{t('只看未檢閱', 'Unreviewed only')}</option>
                  </select>
                </label>
                <span>
                  {t('未檢閱', 'Unreviewed')}:{' '}
                  {result.counts.attention_unreviewed ??
                    result.attention.filter(isUnreviewed).length}
                </span>
              </div>
              {reviewError && (
                <p className="error-message" role="alert">
                  {reviewError}
                </p>
              )}
              {!result.attention.length ? (
                <p>{t('目前沒有需要處理的事項。', 'Nothing needs attention right now.')}</p>
              ) : !visibleAttention.length ? (
                <p>
                  {t(
                    '目前沒有未檢閱事項；已檢閱事項仍保留原有風險。',
                    'No unreviewed events. Reviewed events still carry their original risks.',
                  )}
                </p>
              ) : (
                <div className="portfolio-inbox-attention-list">
                  {visibleAttention.map((item) => (
                    <article key={item.key} className={`attention-${item.severity}`}>
                      {item.navigation && item.account_id ? (
                        <button
                          className="portfolio-inbox-attention-open"
                          onClick={() =>
                            onOpen({
                              account_id: item.account_id as string,
                              tab: item.navigation!.tab,
                              ...(item.navigation!.proposal_id
                                ? { proposal_id: item.navigation!.proposal_id }
                                : {}),
                              ...(item.navigation!.mandate_id
                                ? { mandate_id: item.navigation!.mandate_id }
                                : {}),
                            })
                          }
                        >
                          <strong className={item.severity === 'critical' ? 'desk-negative' : ''}>
                            {t(...SEVERITY_LABELS[item.severity])} ·{' '}
                            {t(item.title_zh, item.title_en)}
                          </strong>
                          <span>
                            {item.account_name ? `${item.account_name} · ` : ''}
                            {item.detail}
                          </span>
                          <small>{item.at ? dateTime(item.at) : '—'}</small>
                        </button>
                      ) : (
                        <div className="portfolio-inbox-attention-open muted">
                          <strong>
                            {t(...SEVERITY_LABELS[item.severity])} ·{' '}
                            {t(item.title_zh, item.title_en)}
                          </strong>
                          <span>{item.detail}</span>
                        </div>
                      )}
                      <div className="portfolio-inbox-attention-review">
                        <span className="agent-status">
                          {isUnreviewed(item) ? t('未檢閱', 'Unreviewed') : t('已檢閱', 'Reviewed')}
                        </span>
                        {!isUnreviewed(item) && item.acknowledgement?.acknowledged_at && (
                          <small>{dateTime(item.acknowledgement.acknowledged_at)}</small>
                        )}
                        {item.kind !== 'source_unavailable' &&
                          item.acknowledgement?.can_acknowledge &&
                          item.event_fingerprint && (
                            <button
                              type="button"
                              className="button"
                              disabled={reviewBusy !== null}
                              aria-label={`${item.acknowledgement.acknowledged ? t('標示未檢閱', 'Mark unreviewed') : t('標示已檢閱', 'Mark reviewed')} · ${t(item.title_zh, item.title_en)}`}
                              onClick={() => void changeReview(item)}
                            >
                              {reviewBusy === item.key
                                ? t('保存檢閱狀態…', 'Saving review…')
                                : item.acknowledgement.acknowledged
                                  ? t('標示未檢閱', 'Mark unreviewed')
                                  : t('標示已檢閱', 'Mark reviewed')}
                            </button>
                          )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          <div className="agent-metrics">
            <div>
              <span>{t('未結案提案', 'Open proposals')}</span>
              <strong>{result.counts.open_proposals}</strong>
              <small>{t('包含待審、舊版與受阻', 'Includes current, stale, and blocked')}</small>
            </div>
            <div>
              <span>{t('啟用中的任務', 'Enabled tasks')}</span>
              <strong>
                {result.counts.enabled_mandates} / {result.counts.mandates}
              </strong>
              <small>{t('每個帳戶最多啟用一個', 'At most one enabled per account')}</small>
            </div>
            <div>
              <span>{t('已完成模擬', 'Completed simulations')}</span>
              <strong>{result.counts.simulated_proposals}</strong>
              <small>{t('全部帳戶的累計提案數', 'All-time proposal count')}</small>
            </div>
            <div>
              <span>{t('已暫停帳戶', 'Paused accounts')}</span>
              <strong>
                {result.counts.paused_accounts} / {result.counts.accounts}
              </strong>
              <small>{t('暫停時仍可閱讀紀錄', 'History remains readable while paused')}</small>
            </div>
          </div>
          <section
            className="agent-panel"
            aria-label={t('次日開盤委託待辦', 'Next-open order inbox')}
          >
            <h3>{t('次日開盤委託與結果', 'Next-open orders and outcomes')}</h3>
            <p>
              {t(
                '同一委託的重複等待合併為一筆，明細保留每次嘗試。開啟後可依原授權重查、明確重試或取消。',
                'Repeated waits are grouped by order; every attempt remains in its details. Open the exact order to recheck, retry explicitly, or cancel under its original authorization.',
              )}
            </p>
            <p>
              {t('未結束委託', 'Active orders')}: {result.counts.active_queue_orders} /{' '}
              {result.counts.queue_orders}
            </p>
            {!result.queue_orders.length ? (
              <p>{t('目前沒有次日開盤模擬委託。', 'There are no next-open paper orders.')}</p>
            ) : (
              <div className="portfolio-inbox-items">
                {result.queue_orders.map((item) => (
                  <article key={item.id}>
                    <div className="portfolio-inbox-item-title">
                      <div>
                        <strong>{item.account_name}</strong>
                        <small>{item.id}</small>
                      </div>
                      <span className="agent-status">{queueLabels[item.status]}</span>
                    </div>
                    <p>
                      {t('指定交易日', 'Specified session')}: {item.execution_session}
                    </p>
                    <p>
                      {locale === 'en'
                        ? queueReasons[item.reason_code] || queueLabels[item.status]
                        : item.reason}
                    </p>
                    <small>
                      {t('處理嘗試', 'Processing attempts')}: {item.attempt_count} ·{' '}
                      {dateTime(item.updated_at)}
                    </small>
                    <div className="portfolio-inbox-item-footer">
                      <button
                        className="button"
                        onClick={() =>
                          onOpen({
                            account_id: item.account_id,
                            queue_order_id: item.id,
                            tab: 'next-open',
                          })
                        }
                      >
                        {t('開啟這筆委託', 'Open this order')}
                      </button>
                      {item.status === 'filled' && item.execution_proposal_id && (
                        <button
                          className="text-button"
                          onClick={() =>
                            onOpen({
                              account_id: item.account_id,
                              proposal_id: item.execution_proposal_id!,
                              tab: 'plan',
                            })
                          }
                        >
                          {t('閱讀已成交收據', 'Read execution receipt')}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="portfolio-inbox-pagination">
              <span>
                {t('顯示', 'Showing')}{' '}
                {result.queue_pagination.total ? result.queue_pagination.offset + 1 : 0}–
                {result.queue_pagination.offset + result.queue_pagination.returned} /{' '}
                {result.queue_pagination.total}
              </span>
              <button
                className="button"
                aria-label={t('上一頁委託', 'Previous orders')}
                disabled={busy || queueOffset === 0}
                onClick={() => setQueueOffset((n) => Math.max(0, n - 20))}
              >
                {t('上一頁', 'Previous')}
              </button>
              <button
                className="button"
                aria-label={t('下一頁委託', 'Next orders')}
                disabled={busy || !result.queue_pagination.has_more}
                onClick={() => setQueueOffset((n) => n + 20)}
              >
                {t('下一頁', 'Next')}
              </button>
            </div>
          </section>
          <section className="agent-panel" aria-label={t('未結案提案', 'Open proposals')}>
            <h3>{t('未結案提案', 'Open proposals')}</h3>
            <p>
              {t(
                '開啟提案可逐筆檢閱或拒絕。待審狀態不會跳過接受時的版本與風險检查。',
                'Open a proposal to review or reject it. Review status never bypasses acceptance-time version and risk checks.',
              )}
            </p>
            <label>
              {t('提案來源', 'Proposal source')}
              <select
                value={proposalSource}
                onChange={(event) => {
                  lastRequest.current++
                  setProposalSource(event.target.value as ProposalFilter)
                  setOffset(0)
                }}
              >
                <option value="all">
                  {t('全部來源', 'All sources')} ({result.counts.open_proposals})
                </option>
                {(Object.keys(PROPOSAL_SOURCE_LABELS) as ProposalSource[]).map((source) => (
                  <option key={source} value={source}>
                    {t(PROPOSAL_SOURCE_LABELS[source][0], PROPOSAL_SOURCE_LABELS[source][1])} (
                    {result.proposal_sources?.counts[source] ?? '—'})
                  </option>
                ))}
              </select>
            </label>
            <p className="research-note">
              {t(
                '只篩選未結案提案，先篩選完整清單再分頁。來源標籤不代表授權仍有效；理由中的程式標記可以複製，不是作者驗證。沒有明確標記者保留為來源不明。風險事項與檢閱收據維持全部帳戶範圍。',
                'Filters all open proposals before pagination. Source labels do not confirm current authorization. Program markers in rationale can be copied and do not verify authorship. Absent explicit markers remain unknown. Risk events and review receipts still cover all accounts.',
              )}
            </p>
            {!proposalResultCurrent ? (
              <p role="status">{t('正在載入符合來源的提案…', 'Loading matching proposals…')}</p>
            ) : !result.proposals.length ? (
              <p>
                {proposalSource === 'all'
                  ? t('目前沒有未結案提案。', 'There are no open proposals.')
                  : t(
                      '這個來源目前沒有未結案提案。',
                      'There are no open proposals for this source.',
                    )}
              </p>
            ) : (
              <div className="portfolio-inbox-items">
                {result.proposals.map((item) => (
                  <article key={item.id}>
                    <div className="portfolio-inbox-item-title">
                      <div>
                        <strong>{item.account_name}</strong>
                        <small>
                          {dateTime(item.created_at)} · {item.as_of}
                        </small>
                      </div>
                      <span
                        className={`agent-status ${item.review_status === 'ready' ? 'is-ready' : ''}`}
                      >
                        {labels[item.review_status]}
                      </span>
                    </div>
                    <p>
                      {t('來源', 'Source')}:{' '}
                      {t(
                        PROPOSAL_SOURCE_LABELS[item.provenance?.source ?? 'unknown'][0],
                        PROPOSAL_SOURCE_LABELS[item.provenance?.source ?? 'unknown'][1],
                      )}
                    </p>
                    {item.provenance?.evidence_kind === 'program_marker' && (
                      <small>
                        {t('來源標記；未驗證作者', 'Source marker; authorship unverified')}
                      </small>
                    )}
                    <p>
                      {item.targets
                        .map((target) => `${target.symbol} ${target.weight_pct}%`)
                        .join(' · ') || t('全現金目標', 'All-cash target')}
                    </p>
                    <div className="portfolio-inbox-item-footer">
                      <small>
                        {item.order_count} {t('筆模擬變動', 'paper changes')} ·{' '}
                        {t('預估成本', 'Estimated cost')} {money(item.cost_total)}
                      </small>
                      <button
                        className="button"
                        onClick={() =>
                          onOpen({ account_id: item.account_id, proposal_id: item.id, tab: 'plan' })
                        }
                      >
                        {t('檢閱提案', 'Review proposal')}
                      </button>
                    </div>
                    {item.reasons.length > 0 && (
                      <details>
                        <summary>
                          {t('查看原因', 'View reasons')} ({item.reasons.length})
                        </summary>
                        <ul>
                          {item.reasons.map((reason, i) => (
                            <li key={`${reason.code}-${i}`}>{reasonLabel(reason)}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            )}
            <div className="portfolio-inbox-pagination">
              <span>
                {proposalResultCurrent ? (
                  <>
                    {t('顯示', 'Showing')}{' '}
                    {result.pagination.total ? result.pagination.offset + 1 : 0}–
                    {result.pagination.offset + result.pagination.returned} /{' '}
                    {result.pagination.total}
                  </>
                ) : (
                  '—'
                )}
                {' · '}
                {t('全部未結案', 'All open')}: {result.counts.open_proposals}
              </span>
              <button
                className="button"
                disabled={busy || !proposalResultCurrent || offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - 20))}
              >
                {t('上一頁', 'Previous')}
              </button>
              <button
                className="button"
                disabled={busy || !proposalResultCurrent || !result.pagination.has_more}
                onClick={() => setOffset((n) => n + 20)}
              >
                {t('下一頁', 'Next')}
              </button>
            </div>
          </section>
          <section className="agent-panel">
            <h3>{t('自動化任務狀態', 'Automation status')}</h3>
            {!result.mandates.length ? (
              <p>
                {t(
                  '尚未建立任務，可先保存一組 Agent 工作流，再到自動化任務建立。',
                  'No tasks yet. Save an Agent workflow, then create an automation task.',
                )}
              </p>
            ) : (
              <div className="portfolio-inbox-items">
                {result.mandates.map((task) => (
                  <article key={task.id}>
                    <div className="portfolio-inbox-item-title">
                      <div>
                        <strong>{task.name}</strong>
                        <small>
                          {task.account_name} ·{' '}
                          {task.mode === 'auto_simulate'
                            ? t('自動模擬', 'Auto simulation')
                            : t('只產生提案', 'Proposal only')}
                        </small>
                      </div>
                      <span className="agent-status">
                        {task.enabled ? t('已啟用', 'Enabled') : t('未啟用', 'Disabled')}
                      </span>
                    </div>
                    <p>{task.reason || task.status}</p>
                    <div className="portfolio-inbox-item-footer">
                      <small>
                        {t('下次檢查／執行', 'Next check / run')} · {dateTime(task.next_due_at)}
                      </small>
                      <button
                        className="button"
                        onClick={() =>
                          onOpen({
                            account_id: task.account_id,
                            mandate_id: task.id,
                            tab: 'automation',
                          })
                        }
                      >
                        {t('開啟任務', 'Open tasks')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section className="agent-panel">
            <h3>{t('最近結案結果', 'Recent closed outcomes')}</h3>
            {!result.recent_outcomes.length ? (
              <p>{t('尚無已模擬或拒絕的提案。', 'No simulated or rejected proposals yet.')}</p>
            ) : (
              <div className="portfolio-inbox-outcomes">
                {result.recent_outcomes.map((item) => (
                  <button
                    key={item.proposal_id}
                    onClick={() =>
                      onOpen({
                        account_id: item.account_id,
                        proposal_id: item.proposal_id,
                        tab: 'plan',
                      })
                    }
                  >
                    <strong>{item.account_name}</strong>
                    <span>
                      {item.status === 'simulated'
                        ? t('已模擬', 'Simulated')
                        : t('已拒絕', 'Rejected')}
                    </span>
                    <small>
                      {item.accepted_at
                        ? `${t('模擬時間', 'Simulated')} ${dateTime(item.accepted_at)}`
                        : `${t('建立時間', 'Created')} ${dateTime(item.created_at)}`}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </section>
          {result.execution_events && (
            <section
              className="agent-panel"
              aria-label={t('Alpaca 委託事件', 'Alpaca order events')}
            >
              <h3>
                {t('Alpaca Paper 委託事件', 'Alpaca Paper order events')}
                {result.counts.execution_attention ? (
                  <small>
                    {' '}
                    · {result.counts.execution_attention} {t('需注意', 'need attention')}
                  </small>
                ) : null}
              </h3>
              {!result.execution_events.length ? (
                <p>{t('沒有送往 Alpaca Paper 的委託事件。', 'No Alpaca Paper order events.')}</p>
              ) : (
                <div className="portfolio-inbox-outcomes">
                  {result.execution_events.map((item) => (
                    <button
                      key={item.key}
                      onClick={() =>
                        onOpen({
                          account_id: item.account_id,
                          proposal_id: item.proposal_id,
                          tab: 'trading-agent',
                        })
                      }
                    >
                      <strong>
                        {item.account_name} · {item.symbol}{' '}
                        {item.side === 'buy' ? t('買入', 'buy') : t('賣出', 'sell')} {item.qty}
                        {item.order_type === 'limit' && item.limit_price
                          ? ` @ ${item.limit_price}`
                          : ''}
                      </strong>
                      <span>
                        {t(...EXECUTION_KINDS[item.kind])}
                        {item.partial_fill && item.kind !== 'execution_partial'
                          ? ` · ${t('含部分成交', 'with partial fill')}`
                          : ''}
                        {item.filled_qty && item.filled_qty !== '0'
                          ? ` · ${t('成交', 'filled')} ${item.filled_qty}${item.filled_avg_price ? ` @ ${item.filled_avg_price}` : ''}`
                          : ''}
                        {item.error?.code ? ` · ${item.error.code}` : ''}
                      </span>
                      <small>{item.at ? dateTime(item.at) : '—'}</small>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <p className="research-note">
            {t(
              '待辦每 30 秒更新；只讀取模擬帳戶，不會從這裡批次接受提案或啟用任務。',
              'The inbox refreshes every 30 seconds. It reads paper accounts only and does not bulk-accept proposals or enable tasks.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
