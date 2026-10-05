import { ExecutionStudyReceipts } from './ExecutionStudyReceipts'
import { useEffect, useId, useRef, useState } from 'react'
import type { PaperProposal } from './paper-model'
import { workflowEvidenceJson } from './workflow-evidence-json'
import './execution-gtd-study.css'

type Translate = (zh: string, en: string) => string
type FrozenOrder = {
  symbol: string
  side: 'buy' | 'sell'
  shares: number
  shares_exact: string
  reference_price: number
}
type Session = { date: string; completed: boolean }
type Context = {
  engine_version: string
  capacity_engine_version: string
  limit_engine_version: string
  account_id: string
  account_version: number
  input_revision: string
  as_of: string
  time_in_force: 'GTD'
  mode: 'advisory_ex_post'
  scenario_window: 'open_only'
  intraday_outcome: 'unknown_from_daily_bars'
  costs_included: false
  max_sessions: number
  allowed_expiry_sessions: Session[]
  source: {
    id: string
    account_id: string
    account_version: number
    engine_version: string
    created_at: string
    status: string
    as_of: string
    input_revision: string
    proposal_fingerprint: string
    current: boolean
    stale_reasons: string[]
    available: boolean
    reason: string | null
    share_precision: number
    orders: FrozenOrder[]
  }
  method: string
  warnings: string[]
}
type GTDRequest = {
  expected_account_version: number
  expected_input_revision: string
  expected_as_of: string
  expected_proposal_fingerprint: string
  participation_pct: number
  limits: { symbol: string; limit_price: number }[]
  gtd_date: string
}
type Step = {
  date: string
  session_completed: boolean
  status:
    | 'evaluated'
    | 'unavailable'
    | 'future_unknown'
    | 'blocked_by_unknown'
    | 'not_required_scenario_full'
  reason: string | null
  open_condition: string
  raw_open: number | null
  session_volume: number | null
  remaining_before_exact: string | null
  capacity_shares_exact: string | null
  scenario_shares_exact: string | null
  remaining_after_exact: string | null
  reference_notional_exact: string | null
  intraday_outcome: string
}
type StudyOrder = FrozenOrder & {
  status: 'scenario_full' | 'partial_expired' | 'unfilled_expired' | 'unavailable'
  reason: string | null
  limit_price: number | null
  observed_prefix_end: string | null
  observed_prefix_scenario_shares_exact: string | null
  last_known_remaining_shares_exact: string | null
  final_scenario_shares_exact: string | null
  expired_shares_exact: string | null
  expiry_verified: boolean
  expiry_state: string
  intraday_outcome: string
  sessions: Step[]
  coverage: {
    required_sessions: number
    evaluated_sessions: number
    not_required_sessions: number
    unknown_sessions: number
    complete: boolean
  }
}
export type ExecutionGTDEvidence = Context & {
  request: GTDRequest
  gtd_date: string
  gtd_session_completed: boolean
  horizon: Session[]
  status: 'complete' | 'unavailable'
  coverage: {
    required_orders: number
    complete_orders: number
    unavailable_orders: number
    observed_prefix_orders: number
  }
  orders: StudyOrder[]
  reason: string | null
  bars_fingerprint: string
  evidence_fingerprint: string
}
type Props = {
  accountId: string
  proposal: PaperProposal
  currentAccountVersion: number
  currentInputRevision: string
  currentAsOf: string
  enabled?: boolean
  t: Translate
}
const METHOD = 'alphaview-execution-gtd-study-v1'
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const orderIdentity = (
  orders: Pick<FrozenOrder, 'symbol' | 'side' | 'shares' | 'reference_price'>[],
) =>
  JSON.stringify(
    orders.map((order) => [order.symbol, order.side, order.shares, order.reference_price]),
  )
const cell = (value: string | number | null | undefined) => (value == null ? '—' : String(value))

export function ExecutionGTDStudy(props: Props) {
  // Drafts reset only when switching account/proposal, not on transient busy or
  // currentness changes. Shared parents should also avoid transient remount keys.
  return <GTDWorkspace key={`${props.accountId}:${props.proposal.id}`} {...props} />
}
function GTDWorkspace({
  accountId,
  proposal,
  currentAccountVersion,
  currentInputRevision,
  currentAsOf,
  enabled = true,
  t,
}: Props) {
  const id = useId()
  const [participation, setParticipation] = useState('1')
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({})
  const [gtdDate, setGtdDate] = useState('')
  const binding = JSON.stringify([
    accountId,
    proposal,
    currentAccountVersion,
    currentInputRevision,
    currentAsOf,
    enabled,
  ])
  const draft = JSON.stringify([participation, limitDrafts, gtdDate])
  const identity = JSON.stringify([binding, draft])
  const latest = useRef(identity)
  latest.current = identity
  const operation = useRef<AbortController | null>(null)
  const [contextState, setContext] = useState<{ binding: string; value: Context } | null>(null)
  const context = enabled && contextState?.binding === binding ? contextState.value : null
  const [accepted, setAccepted] = useState<{
    identity: string
    value: ExecutionGTDEvidence
    raw: string
  } | null>(null)
  const result = enabled && accepted?.identity === identity ? accepted.value : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cap = Number(participation)
  const validCap = participation.trim() !== '' && Number.isFinite(cap) && cap >= 0 && cap <= 100
  const limits = proposal.orders
    .filter((order) => (limitDrafts[order.symbol] ?? '').trim() !== '')
    .map((order) => ({ symbol: order.symbol, limit_price: Number(limitDrafts[order.symbol]) }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
  const validLimits =
    proposal.orders.length <= 100 &&
    new Set(proposal.orders.map((order) => order.symbol)).size === proposal.orders.length &&
    Object.values(limitDrafts).every(
      (value) => value.trim() === '' || /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()),
    ) &&
    limits.every(
      (row) => Number.isFinite(row.limit_price) && row.limit_price > 0 && row.limit_price <= 1e12,
    )
  const validDate = Boolean(context?.allowed_expiry_sessions.some((item) => item.date === gtdDate))
  const changed = t(
    '研究來源已變更，請重新讀取 GTD 日期；輸入草稿仍保留。',
    'Study sources changed. Reload GTD dates; input drafts are preserved.',
  )
  function invalidate() {
    operation.current?.abort()
    operation.current = null
    setAccepted(null)
    setBusy(false)
    setError('')
  }
  useEffect(() => {
    invalidate()
    setContext(null)
  }, [binding])
  useEffect(() => {
    invalidate()
  }, [draft])
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        invalidate()
        setContext(null)
      }
    }
    const pagehide = () => {
      invalidate()
      setContext(null)
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', pagehide)
    return () => {
      operation.current?.abort()
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [])
  const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/proposals/${encodeURIComponent(proposal.id)}/gtd-study`
  function matchesContext(value: Context) {
    const source = value?.source
    return (
      value?.engine_version === METHOD &&
      value.capacity_engine_version === 'alphaview-execution-volume-study-v1' &&
      value.limit_engine_version === 'alphaview-execution-limit-study-v1' &&
      value.account_id === accountId &&
      value.account_version === currentAccountVersion &&
      value.input_revision === currentInputRevision &&
      value.as_of === currentAsOf &&
      value.time_in_force === 'GTD' &&
      value.mode === 'advisory_ex_post' &&
      value.scenario_window === 'open_only' &&
      value.intraday_outcome === 'unknown_from_daily_bars' &&
      value.costs_included === false &&
      value.max_sessions === 5 &&
      source?.id === proposal.id &&
      source.account_id === accountId &&
      source.account_version === proposal.account_version &&
      source.engine_version === proposal.engine_version &&
      source.created_at === proposal.created_at &&
      source.status === proposal.status &&
      source.as_of === proposal.as_of &&
      source.input_revision === proposal.input_revision &&
      fingerprint(source.proposal_fingerprint) &&
      Array.isArray(source.orders) &&
      orderIdentity(source.orders) === orderIdentity(proposal.orders) &&
      new Set(source.orders.map((row) => row.symbol)).size === source.orders.length &&
      Array.isArray(value.allowed_expiry_sessions) &&
      value.allowed_expiry_sessions.length === 5 &&
      value.allowed_expiry_sessions.every(
        (item, index, items) =>
          /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
          item.date > source.as_of &&
          item.completed === item.date <= value.as_of &&
          (index === 0 || item.date > items[index - 1].date),
      )
    )
  }
  async function read(response: Response) {
    const raw = await response.text()
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error(t('研究回應無法讀取。', 'The study response could not be read.'))
    }
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? changed
          : (value?.detail?.code ?? t('GTD 研究暫時不可用。', 'The GTD study is unavailable.')),
      )
    workflowEvidenceJson(value, raw)
    return { value, raw }
  }
  async function load() {
    if (!enabled || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setAccepted(null)
    setContext(null)
    setBusy(true)
    setError('')
    const matches = () =>
      !controller.signal.aborted && operation.current === controller && latest.current === identity
    try {
      const received = (
        await read(await fetch(`${base}/context`, { cache: 'no-store', signal: controller.signal }))
      ).value as Context
      if (!matches()) return
      if (!matchesContext(received)) throw new Error(changed)
      setContext({ binding, value: received })
    } catch (err) {
      if (matches()) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (matches()) setBusy(false)
      if (operation.current === controller) operation.current = null
    }
  }
  async function run() {
    if (!enabled || !context || !validCap || !validLimits || !validDate || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    const matches = () =>
      !controller.signal.aborted && operation.current === controller && latest.current === identity
    const request: GTDRequest = {
      expected_account_version: currentAccountVersion,
      expected_input_revision: currentInputRevision,
      expected_as_of: currentAsOf,
      expected_proposal_fingerprint: context.source.proposal_fingerprint,
      participation_pct: cap,
      limits,
      gtd_date: gtdDate,
    }
    setAccepted(null)
    setBusy(true)
    setError('')
    try {
      const reply = await read(
        await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          cache: 'no-store',
          signal: controller.signal,
        }),
      )
      if (!matches()) return
      const value = reply.value as ExecutionGTDEvidence
      workflowEvidenceJson(request, JSON.stringify(value.request))
      const horizon = context.allowed_expiry_sessions.filter((item) => item.date <= gtdDate)
      if (
        !matchesContext(value) ||
        value.source.proposal_fingerprint !== context.source.proposal_fingerprint ||
        value.gtd_date !== gtdDate ||
        value.gtd_session_completed !== gtdDate <= currentAsOf ||
        !fingerprint(value.bars_fingerprint) ||
        !fingerprint(value.evidence_fingerprint) ||
        JSON.stringify(value.horizon) !== JSON.stringify(horizon) ||
        !Array.isArray(value.orders) ||
        orderIdentity(value.orders) !== orderIdentity(context.source.orders) ||
        value.orders.some(
          (order) =>
            order.intraday_outcome !== 'unknown_from_daily_bars' ||
            order.limit_price !==
              (limits.find((item) => item.symbol === order.symbol)?.limit_price ?? null) ||
            !['scenario_full', 'partial_expired', 'unfilled_expired', 'unavailable'].includes(
              order.status,
            ) ||
            !Array.isArray(order.sessions) ||
            order.sessions.length !== horizon.length ||
            order.sessions.some(
              (step, index) =>
                step.date !== horizon[index].date ||
                step.session_completed !== horizon[index].completed ||
                step.intraday_outcome !== 'unknown_from_daily_bars' ||
                ![
                  'evaluated',
                  'unavailable',
                  'future_unknown',
                  'blocked_by_unknown',
                  'not_required_scenario_full',
                ].includes(step.status),
            ) ||
            order.coverage.required_sessions !== horizon.length ||
            order.coverage.evaluated_sessions !==
              order.sessions.filter((step) => step.status === 'evaluated').length ||
            order.coverage.not_required_sessions !==
              order.sessions.filter((step) => step.status === 'not_required_scenario_full')
                .length ||
            order.coverage.unknown_sessions !==
              order.sessions.filter((step) =>
                ['unavailable', 'future_unknown', 'blocked_by_unknown'].includes(step.status),
              ).length ||
            order.coverage.complete !== (order.coverage.unknown_sessions === 0) ||
            (order.status === 'unavailable') !== !order.coverage.complete ||
            (order.status === 'unavailable' &&
              (order.final_scenario_shares_exact !== null ||
                order.expired_shares_exact !== null ||
                order.expiry_verified)) ||
            (order.status === 'scenario_full' &&
              (order.expiry_verified || order.expired_shares_exact !== null)) ||
            (order.expiry_verified && !value.gtd_session_completed),
        ) ||
        value.coverage.required_orders !== value.orders.length ||
        value.coverage.complete_orders !==
          value.orders.filter((order) => order.coverage.complete).length ||
        value.coverage.unavailable_orders !==
          value.orders.filter((order) => !order.coverage.complete).length ||
        value.status !==
          (value.orders.length > 0 && value.coverage.unavailable_orders === 0
            ? 'complete'
            : 'unavailable')
      )
        throw new Error(changed)
      setAccepted({ identity, value, raw: reply.raw })
    } catch (err) {
      if (matches()) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (matches()) setBusy(false)
      if (operation.current === controller) operation.current = null
    }
  }
  function download() {
    if (
      !result ||
      !accepted ||
      !enabled ||
      busy ||
      operation.current ||
      latest.current !== identity
    )
      return
    let url: string | null = null
    const anchor = document.createElement('a')
    try {
      const raw = workflowEvidenceJson(result, accepted.raw)
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
      anchor.href = url
      anchor.download = `alphaview-gtd-study-${safe(accountId)}-${safe(proposal.id)}-${safe(result.gtd_date)}.json`
      document.body.appendChild(anchor)
      anchor.click()
    } catch {
      setError(t('GTD 證據下載失敗。', 'GTD evidence download failed.'))
    } finally {
      anchor.remove()
      if (url) {
        const release = url
        window.setTimeout(() => URL.revokeObjectURL(release), 10000)
      }
    }
  }
  const status = (value: StudyOrder['status']) =>
    ({
      scenario_full: t('情境全數；不宣稱到期已驗證', 'Scenario full; expiry not verified'),
      partial_expired: t('情境部分；餘量到期', 'Scenario partial; remainder expired'),
      unfilled_expired: t('情境零股；全數到期', 'Scenario zero shares; all expired'),
      unavailable: t('最終結果未知', 'Final outcome unknown'),
    })[value]
  return (
    <section
      className="execution-gtd-study"
      aria-label={t('多日 GTD 開盤情境', 'Multi-session GTD open scenario')}
    >
      <h3>{t('多日 GTD 開盤情境', 'Multi-session GTD open scenario')}</h3>
      <p>
        {t(
          '保存提案的固定股數，在訊號日之後最多五個 XNYS 交易日逐日延續。請選明確到期交易日；買入開盤價 ≤ 限價、賣出 ≥ 限價，未填則不限制價格。',
          'Carry frozen saved quantities across up to five XNYS sessions after the signal date. Choose an explicit expiry session; buy open ≤ limit, sell open ≥ limit, and blank means no price restriction.',
        )}
      </p>
      <p className="research-note">
        {t(
          '全日成交量只是事後容量代理，在開盤時尚未知；不代表開盤流動性。盤中成交一律未知，不從日線高低價推論。這不是執行模型、真實成交或交易授權。',
          'Full-day volume is an ex-post capacity proxy unknown at the open, not opening liquidity. Intraday fills are always unknown; daily highs and lows cannot establish them. This is not an execution model, actual fills or trading authority.',
        )}
      </p>
      <p>
        {t(
          '任何必要資料缺失會停止該標的後續股數推算。已知前綴與最終結果分開顯示；只有完整觀察到期所需交易日，才讓餘量在情境中到期。',
          'Any missing required evidence stops subsequent quantity progression for that symbol. The observed prefix is separate from the final outcome; a remainder expires in the scenario only after all required sessions through expiry are observed.',
        )}
      </p>
      <fieldset disabled={!enabled || busy}>
        <legend>{t('GTD 研究草稿', 'GTD research draft')}</legend>
        <label htmlFor={`${id}-cap`}>
          {t('每日成交量參與率（%）', 'Daily volume participation (%)')}
        </label>
        <input
          id={`${id}-cap`}
          inputMode="decimal"
          value={participation}
          onChange={(event) => setParticipation(event.target.value)}
        />
        {proposal.orders.map((order) => (
          <label key={order.symbol}>
            {order.symbol} · {t('固定限價（可留空）', 'Fixed limit (optional)')}
            <input
              inputMode="decimal"
              value={limitDrafts[order.symbol] ?? ''}
              onChange={(event) =>
                setLimitDrafts({ ...limitDrafts, [order.symbol]: event.target.value })
              }
            />
          </label>
        ))}
        <label htmlFor={`${id}-date`}>
          {t('明確 GTD 到期交易日', 'Explicit GTD expiry session')}
        </label>
        <select
          id={`${id}-date`}
          value={gtdDate}
          onChange={(event) => setGtdDate(event.target.value)}
        >
          <option value="">{t('請先讀取並選擇日期', 'Load and choose a date')}</option>
          {!context && gtdDate && (
            <option value={gtdDate}>
              {gtdDate} · {t('草稿；待重新核對', 'Draft; recheck required')}
            </option>
          )}
          {context?.allowed_expiry_sessions.map((item) => (
            <option key={item.date} value={item.date}>
              {item.date} ·{' '}
              {item.completed
                ? t('已完成交易日', 'Completed session')
                : t('尚未完成', 'Not completed')}
            </option>
          ))}
        </select>
      </fieldset>
      {!validCap || !validLimits ? (
        <p>
          {t(
            '請填入 0–100% 參與率；限價須為大於零且不超過 1e12 的有限數字。',
            'Enter 0–100% participation; limits must be finite, positive and no greater than 1e12.',
          )}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button-secondary"
          disabled={!enabled || busy}
          onClick={() => void load()}
        >
          {t('讀取 GTD 日期與來源', 'Load GTD dates and source')}
        </button>
        <button
          type="button"
          className="button"
          disabled={!enabled || busy || !context || !validDate || !validCap || !validLimits}
          onClick={() => void run()}
        >
          {busy
            ? t('讀取或計算中…', 'Loading or computing…')
            : t('研究固定股數 GTD 情境', 'Study frozen-quantity GTD scenario')}
        </button>
        {busy && (
          <button type="button" className="button-secondary" onClick={invalidate}>
            {t('取消等待', 'Cancel waiting')}
          </button>
        )}
        {result && (
          <button type="button" className="button-secondary" onClick={download}>
            {t('下載 GTD 證據 JSON', 'Download GTD evidence JSON')}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {context && (
        <p className="research-note">
          {t('保存提案日期', 'Saved proposal date')}: {context.source.as_of} ·{' '}
          {t('目前快照', 'Current snapshot')}: {context.as_of} ·{' '}
          {context.source.current
            ? t('保存來源仍屬當期', 'Saved source is current')
            : t(
                '歷史保存來源；不代表目前可執行',
                'Historical saved source; not current execution eligibility',
              )}{' '}
          · {context.source.stale_reasons.join(', ')}
        </p>
      )}
      {result && (
        <div className="gtd-study-result">
          <h4>
            {result.status === 'complete'
              ? t('情境所需進程皆可計算', 'All required scenario progressions are known')
              : t(
                  '部分最終進程未知；不提供合計',
                  'Some final progressions are unknown; no aggregate total',
                )}
          </h4>
          <p>
            {t('完整標的／所需標的', 'Complete / required orders')}:{' '}
            {result.coverage.complete_orders} / {result.coverage.required_orders} · GTD{' '}
            {result.gtd_date}
          </p>
          {result.reason && <p>{result.reason}</p>}
          {result.orders.map((order) => (
            <article key={order.symbol}>
              <h4>
                {order.symbol} · {order.side} · {status(order.status)}
              </h4>
              <p>
                {t('固定股數', 'Frozen shares')}: {order.shares_exact} ·{' '}
                {t('最後已知前綴日期', 'Last observed prefix date')}:{' '}
                {cell(order.observed_prefix_end)}
              </p>
              <p>
                {t('已觀察前綴情境股數', 'Observed-prefix scenario shares')}:{' '}
                {cell(order.observed_prefix_scenario_shares_exact)} ·{' '}
                {t('前綴後最後已知餘量', 'Last known remainder after prefix')}:{' '}
                {cell(order.last_known_remaining_shares_exact)}
              </p>
              <p>
                {t('最終情境股數', 'Final scenario shares')}:{' '}
                {cell(order.final_scenario_shares_exact)} ·{' '}
                {t('情境到期股數', 'Scenario expired shares')}: {cell(order.expired_shares_exact)} ·{' '}
                {order.expiry_state}
              </p>
              {order.reason && <p>{order.reason}</p>}
              <div className="gtd-table">
                <table aria-label={`${order.symbol} ${t('逐日情境', 'daily scenario')}`}>
                  <thead>
                    <tr>
                      {[
                        t('交易日', 'Session'),
                        t('原始開盤', 'Raw open'),
                        t('日成交量', 'Daily volume'),
                        t('開盤條件', 'Open condition'),
                        t('開始餘量', 'Starting remainder'),
                        t('容量代理', 'Capacity proxy'),
                        t('情境股數', 'Scenario shares'),
                        t('結束餘量', 'Ending remainder'),
                        t('狀態與原因', 'Status and reason'),
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {order.sessions.map((step) => (
                      <tr key={step.date}>
                        <th scope="row">{step.date}</th>
                        <td>{cell(step.raw_open)}</td>
                        <td>{cell(step.session_volume)}</td>
                        <td>{step.open_condition}</td>
                        <td>{cell(step.remaining_before_exact)}</td>
                        <td>{cell(step.capacity_shares_exact)}</td>
                        <td>{cell(step.scenario_shares_exact)}</td>
                        <td>{cell(step.remaining_after_exact)}</td>
                        <td>
                          {step.status}
                          {step.reason && ` · ${step.reason}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
          <details>
            <summary>{t('GTD 方法與來源', 'GTD method and source')}</summary>
            <p>{result.engine_version}</p>
            <p>{result.method}</p>
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p>{result.source.proposal_fingerprint}</p>
            <p>{result.bars_fingerprint}</p>
            <p>{result.evidence_fingerprint}</p>
          </details>
        </div>
      )}
      <ExecutionStudyReceipts
        kind="open_gtd"
        accountId={accountId}
        proposalId={proposal.id}
        accountVersion={currentAccountVersion}
        request={result?.request ?? null}
        evidence={result}
        rawEvidence={result ? (accepted?.raw ?? null) : null}
        enabled={enabled && !busy}
        t={t}
      />
    </section>
  )
}
