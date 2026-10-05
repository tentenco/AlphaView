import { ExecutionStudyReceipts } from './ExecutionStudyReceipts'
import { useEffect, useId, useRef, useState } from 'react'
import type { PaperProposal } from './paper-model'
import { num } from './ui'
import { workflowEvidenceJson } from './workflow-evidence-json'
import './execution-volume-study.css'

type Translate = (zh: string, en: string) => string
type FrozenOrder = {
  symbol: string
  side: 'buy' | 'sell'
  shares: number
  shares_exact: string
  reference_price: number
}
type StudySource = {
  id: string
  account_id: string
  engine_version: string
  created_at: string
  status: string
  as_of: string
  input_revision: string
  account_version: number
  proposal_fingerprint: string
  current: boolean
  stale_reasons: string[]
  available: boolean
  reason: string | null
  share_precision: number
  skipped_orders_count: number
  orders: FrozenOrder[]
}
type StudyContext = {
  engine_version: string
  account_id: string
  account_version: number
  input_revision: string
  as_of: string
  source: StudySource
  execution_session: string
  session_completed: boolean
  time_in_force: 'DAY'
  mode: 'advisory_ex_post'
  method: string
  warnings: string[]
}
type StudyOrder = FrozenOrder & {
  status: 'full' | 'partial_expired' | 'unfilled_expired' | 'unavailable'
  reason: string | null
  raw_open: number | null
  session_volume: number | null
  capacity_shares: number | null
  scenario_shares: number | null
  expired_shares: number | null
  fill_fraction_pct: number | null
  reference_notional: number | null
}
export type ExecutionVolumeEvidence = StudyContext & {
  request: {
    expected_account_version: number
    expected_input_revision: string
    expected_as_of: string
    expected_proposal_fingerprint: string
    participation_pct: number
  }
  bars_fingerprint: string
  status: 'complete' | 'incomplete' | 'unavailable'
  coverage: { required: number; available: number; unavailable: number }
  orders: StudyOrder[]
  reason: string | null
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
const METHOD = 'alphaview-execution-volume-study-v1'
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const metric = (value: number | null | undefined, precision = 6) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, precision) : '—'
const orderIdentity = (
  orders: Pick<FrozenOrder, 'symbol' | 'side' | 'shares' | 'reference_price'>[],
) =>
  JSON.stringify(
    orders.map(({ symbol, side, shares, reference_price }) => [
      symbol,
      side,
      shares,
      reference_price,
    ]),
  )
const reasonText = (code: string | null, t: Translate) => {
  const labels: Record<string, [string, string]> = {
    execution_session_not_completed: [
      '指定交易日尚未完成',
      'The execution session has not completed',
    ],
    missing_execution_bar: ['缺少指定交易日日線', 'Exact execution-day bar is missing'],
    missing_signal_bar: ['缺少訊號日日線', 'Signal-day bar is missing'],
    invalid_execution_volume: ['指定日成交量不可用', 'Execution-day volume is unavailable'],
    invalid_execution_open: ['指定日原始開盤價不可用', 'Execution-day raw open is unavailable'],
    invalid_execution_bar: ['指定日日線未通過品質檢查', 'Execution-day bar failed quality checks'],
    invalid_signal_basis: ['訊號日調整基礎不可用', 'Signal-day adjustment basis is unavailable'],
    invalid_execution_basis: [
      '指定日調整基礎不可用',
      'Execution-day adjustment basis is unavailable',
    ],
    signal_reference_changed: ['訊號日收盤已修訂', 'Signal-day close has been revised'],
    adjustment_factor_changed: [
      '跨日調整因子改變；不轉換股數',
      'Adjustment factor changed; no share conversion',
    ],
    usd_identity_unavailable: ['無法確認 USD 計價', 'USD currency identity is unavailable'],
    blocked_source_proposal: ['來源提案受阻擋', 'The source proposal is blocked'],
    paper_method_unsupported: ['來源方法不支援此研究', 'The source method is unsupported'],
    no_saved_orders: ['沒有保存的委託股數', 'No saved order quantities'],
    saved_proposal_unavailable: ['保存提案證據不可用', 'Saved proposal evidence is unavailable'],
    nonfinite_input: ['輸入必須是有限數值', 'Inputs must be finite numbers'],
  }
  return code ? (labels[code] ? t(...labels[code]) : code) : '—'
}

export function ExecutionVolumeStudy(props: Props) {
  // Same-proposal refreshes keep editable drafts and the history workspace mounted.
  return <Study key={JSON.stringify([props.accountId, props.proposal.id])} {...props} />
}

function Study({
  accountId,
  proposal,
  currentAccountVersion,
  currentInputRevision,
  currentAsOf,
  enabled = true,
  t,
}: Props) {
  const [participation, setParticipation] = useState('1')
  const binding = JSON.stringify([
    accountId,
    proposal,
    currentAccountVersion,
    currentInputRevision,
    currentAsOf,
    enabled,
  ])
  const identity = JSON.stringify([binding, participation])
  // Returning to prior values is still a new edit or source refresh.
  const latest = useRef({ identity, generation: 0 })
  if (latest.current.identity !== identity) {
    latest.current = { identity, generation: latest.current.generation + 1 }
  }
  const generation = latest.current.generation
  const [accepted, setAccepted] = useState<{
    identity: string
    generation: number
    result: ExecutionVolumeEvidence
    rawJson: string
  } | null>(null)
  const acceptedRef = useRef(accepted)
  const result =
    enabled && accepted?.identity === identity && accepted.generation === generation
      ? accepted.result
      : null
  const [failure, setFailure] = useState<{
    identity: string
    generation: number
    message: string
  } | null>(null)
  const error =
    failure?.identity === identity && failure.generation === generation ? failure.message : ''
  const setError = (message: string) =>
    setFailure(message ? { identity, generation, message } : null)
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const inputId = useId()
  const cap = Number(participation)
  const validCap = participation.trim() !== '' && Number.isFinite(cap) && cap >= 0 && cap <= 100
  const changedMessage = t(
    '研究來源已變更；請重新載入提案後檢查。',
    'Study sources changed. Reload the proposal and check again.',
  )
  const invalidate = () => {
    operation.current?.abort()
    operation.current = null
    acceptedRef.current = null
    setAccepted(null)
    setBusy(false)
    setError('')
  }
  useEffect(() => {
    invalidate()
  }, [identity])
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', invalidate)
    return () => {
      operation.current?.abort()
      acceptedRef.current = null
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
    }
  }, [])
  function matchesContext(value: StudyContext) {
    const source = value?.source
    return (
      value?.engine_version === METHOD &&
      value.account_id === accountId &&
      value.account_version === currentAccountVersion &&
      value.input_revision === currentInputRevision &&
      value.as_of === currentAsOf &&
      value.mode === 'advisory_ex_post' &&
      value.time_in_force === 'DAY' &&
      source?.id === proposal.id &&
      source.account_id === accountId &&
      source.as_of === proposal.as_of &&
      source.input_revision === proposal.input_revision &&
      source.account_version === proposal.account_version &&
      source.engine_version === proposal.engine_version &&
      source.created_at === proposal.created_at &&
      source.status === proposal.status &&
      fingerprint(source.proposal_fingerprint) &&
      Array.isArray(source.orders) &&
      orderIdentity(source.orders) === orderIdentity(proposal.orders)
    )
  }
  async function run() {
    if (
      !validCap ||
      !enabled ||
      operation.current ||
      latest.current.identity !== identity ||
      latest.current.generation !== generation
    )
      return
    const controller = new AbortController()
    operation.current = controller
    const matches = () =>
      !controller.signal.aborted &&
      operation.current === controller &&
      latest.current.identity === identity &&
      latest.current.generation === generation
    setBusy(true)
    acceptedRef.current = null
    setAccepted(null)
    setError('')
    const base = `/api/paper/accounts/${encodeURIComponent(accountId)}/proposals/${encodeURIComponent(proposal.id)}/volume-study`
    const read = async (response: Response) => {
      const rawJson = await response.text()
      let value
      try {
        value = JSON.parse(rawJson)
      } catch {
        value = {}
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? changedMessage
            : typeof value.detail?.code === 'string'
              ? reasonText(value.detail.code, t)
              : t('研究暫時不可用，請稍後重試。', 'The study is unavailable. Try again later.'),
        )
      return { value, rawJson }
    }
    try {
      const context = (
        await read(await fetch(`${base}/context`, { cache: 'no-store', signal: controller.signal }))
      ).value as StudyContext
      if (!matches()) return
      if (!matchesContext(context)) throw new Error(changedMessage)
      const request = {
        expected_account_version: currentAccountVersion,
        expected_input_revision: currentInputRevision,
        expected_as_of: currentAsOf,
        expected_proposal_fingerprint: context.source.proposal_fingerprint,
        participation_pct: cap,
      }
      const reply = await read(
        await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify(request),
        }),
      )
      const evidence = reply.value as ExecutionVolumeEvidence
      if (!matches()) return
      if (
        !matchesContext(evidence) ||
        evidence.source.proposal_fingerprint !== context.source.proposal_fingerprint ||
        evidence.execution_session !== context.execution_session ||
        !fingerprint(evidence.bars_fingerprint) ||
        Object.entries(request).some(
          ([key, value]) => evidence.request?.[key as keyof typeof request] !== value,
        ) ||
        !Array.isArray(evidence.orders) ||
        orderIdentity(evidence.orders) !== orderIdentity(context.source.orders) ||
        evidence.coverage?.required !== evidence.orders.length ||
        evidence.coverage.available !==
          evidence.orders.filter((row) => row.status !== 'unavailable').length ||
        evidence.coverage.unavailable !==
          evidence.orders.filter((row) => row.status === 'unavailable').length
      )
        throw new Error(changedMessage)
      const next = { identity, generation, result: evidence, rawJson: reply.rawJson }
      acceptedRef.current = next
      setAccepted(next)
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
      acceptedRef.current !== accepted ||
      busy ||
      operation.current ||
      !enabled ||
      latest.current.identity !== identity ||
      latest.current.generation !== generation
    )
      return
    let url: string | null = null
    let anchor: HTMLAnchorElement | null = null
    try {
      const rawJson = workflowEvidenceJson(accepted.result, accepted.rawJson)
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      url = URL.createObjectURL(new Blob([rawJson], { type: 'application/json;charset=utf-8' }))
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `alphaview-volume-study-${safe(accountId)}-${safe(proposal.id)}-${safe(accepted.result.as_of)}.json`
      document.body.appendChild(anchor)
      anchor.click()
    } catch {
      setError(t('容量證據下載失敗', 'Volume evidence download failed'))
    } finally {
      anchor?.remove()
      if (url) {
        const release = url
        window.setTimeout(() => URL.revokeObjectURL(release), 10000)
      }
    }
  }
  const statusLabel = (status: StudyOrder['status']) =>
    ({
      full: t('情境全數', 'Scenario full'),
      partial_expired: t('情境部分；餘量到期', 'Scenario partial; remainder expired'),
      unfilled_expired: t('情境未成交；全數到期', 'Scenario unfilled; all expired'),
      unavailable: t('不可用', 'Unavailable'),
    })[status] ?? status
  return (
    <section
      className="execution-volume-study"
      aria-label={t('日成交量容量研究', 'Daily volume capacity study')}
    >
      <header>
        <h3>{t('日成交量容量研究', 'Daily volume capacity study')}</h3>
        <span>{t('唯讀・事後情境', 'Read only · ex-post scenario')}</span>
      </header>
      <p className="research-note">
        {t(
          '固定保存股數；訊號日收盤 → 下一個 XNYS 交易日原始開盤參考價。日成交量乘上參與率並依保存精度向下取整，剩餘股數在該日收盤到期。',
          'Freeze saved quantities; signal close → next XNYS session raw-open reference. Daily volume × participation is rounded down to saved share precision; the remainder expires at that close.',
        )}
      </p>
      <p className="research-note">
        {t(
          '全日成交量在開盤時尚未知；這不是開盤成交可行性、限價路徑或實際成交。未計衝擊、費用與現金可負擔性，也不送單。',
          'Full-day volume is unknown at the open. This does not establish opening-fill feasibility, limit-price chronology or actual fills. Impact, fees and cash affordability are excluded; no orders are sent.',
        )}
      </p>
      <div className="execution-volume-controls">
        <label htmlFor={inputId}>
          {t('日成交量參與率上限（%）', 'Daily volume participation cap (%)')}
          <input
            id={inputId}
            type="number"
            min="0"
            max="100"
            step="any"
            value={participation}
            disabled={busy || !enabled}
            onChange={(event) => {
              invalidate()
              setParticipation(event.target.value)
            }}
          />
        </label>
        <button type="button" disabled={busy || !enabled || !validCap} onClick={() => void run()}>
          {busy
            ? t('檢查中…', 'Checking…')
            : t('研究保存提案容量', 'Study saved proposal capacity')}
        </button>
        {result && (
          <button type="button" disabled={busy || !enabled} onClick={download}>
            {t('下載容量證據 JSON', 'Download capacity evidence JSON')}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div aria-live="polite">
          <p>
            {t('證據覆蓋', 'Evidence coverage')}: {result.coverage.available} /{' '}
            {result.coverage.required}
            {' · '}
            {t('不可用', 'Unavailable')}: {result.coverage.unavailable}
            {' · '}
            {t('指定交易日', 'Execution session')}: {result.execution_session} · DAY
          </p>
          <p>
            {result.source.current
              ? t('提案來源與目前快照一致', 'Proposal source matches the current snapshot')
              : t(
                  '歷史提案：固定原始股數；目前帳戶或行情已變更',
                  'Historical proposal: original quantities; current account or market inputs differ',
                )}
          </p>
          {result.reason && <p>{reasonText(result.reason, t)}</p>}
          <div
            className="execution-volume-table"
            tabIndex={0}
            role="region"
            aria-label={t('容量情境明細', 'Capacity scenario details')}
          >
            <table>
              <thead>
                <tr>
                  <th>{t('標的', 'Symbol')}</th>
                  <th>{t('方向', 'Side')}</th>
                  <th>{t('固定股數', 'Frozen quantity')}</th>
                  <th>{t('原始開盤參考價', 'Raw-open reference')}</th>
                  <th>{t('當日成交量', 'Session volume')}</th>
                  <th>{t('容量上限股數', 'Capacity quantity')}</th>
                  <th>{t('情境股數', 'Scenario quantity')}</th>
                  <th>{t('到期股數', 'Expired quantity')}</th>
                  <th>{t('參考金額（USD）', 'Reference notional (USD)')}</th>
                  <th>{t('情境狀態／原因', 'Scenario status / reason')}</th>
                </tr>
              </thead>
              <tbody>
                {result.orders.map((row) => (
                  <tr key={`${row.symbol}:${row.side}`}>
                    <td>{row.symbol}</td>
                    <td>{row.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                    <td>{row.shares_exact}</td>
                    <td>{metric(row.raw_open, 8)}</td>
                    <td>{metric(row.session_volume)}</td>
                    <td>{metric(row.capacity_shares)}</td>
                    <td>{metric(row.scenario_shares)}</td>
                    <td>{metric(row.expired_shares)}</td>
                    <td>{metric(row.reference_notional, 8)}</td>
                    <td>
                      {statusLabel(row.status)}
                      {row.reason && <> · {reasonText(row.reason, t)}</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>{t('來源與方法', 'Sources and method')}</summary>
            <dl>
              <dt>{t('研究方法', 'Study method')}</dt>
              <dd>{result.engine_version}</dd>
              <dt>{t('保存提案', 'Saved proposal')}</dt>
              <dd>
                {result.source.id} · {result.source.engine_version}
              </dd>
              <dt>{t('保存訊號日與輸入', 'Saved signal session and inputs')}</dt>
              <dd>
                {result.source.as_of} · {result.source.input_revision}
              </dd>
              <dt>{t('研究快照', 'Study snapshot')}</dt>
              <dd>
                {result.as_of} · {result.input_revision} · v{result.account_version}
              </dd>
              <dt>{t('提案指紋', 'Proposal fingerprint')}</dt>
              <dd>{result.source.proposal_fingerprint}</dd>
              <dt>{t('日線證據指紋', 'Bar evidence fingerprint')}</dt>
              <dd>{result.bars_fingerprint}</dd>
              <dt>{t('未納入的原提案略過委託', 'Original skipped orders excluded')}</dt>
              <dd>{result.source.skipped_orders_count}</dd>
            </dl>
            <p>{result.method}</p>
          </details>
        </div>
      )}
      <ExecutionStudyReceipts
        kind="volume_day"
        accountId={accountId}
        proposalId={proposal.id}
        accountVersion={currentAccountVersion}
        request={result?.request ?? null}
        evidence={result}
        rawEvidence={result ? (accepted?.rawJson ?? null) : null}
        enabled={enabled && !busy}
        t={t}
      />
    </section>
  )
}
