import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import { dateTime, num } from './ui'
import './corporate-actions.css'

type Translate = (zh: string, en: string) => string
type Kind = 'dividend' | 'suspected_split' | 'unclassified' | 'unavailable'
export type CorporateActionEvent = {
  symbol: string
  ex_date: string
  prior_session: string
  kind: Kind
  price_ratio: number | null
  factor_before: number | null
  factor_after: number | null
  factor_change_pct: number | null
  shares_multiplier: number | null
  implied_cash_per_share: number | null
  reason: string | null
  data_consistency: { flag: string; message: string } | null
  since_entry: boolean
  after_last_fill: boolean
}
type ProviderEvidence = {
  symbol: string
  engine_version: string
  status: 'unavailable' | 'partial' | 'available' | 'stale'
  source?: string
  adapter_version?: string
  fetched_at?: string
  evidence_revision?: number
  capture_version?: number
  previous_evidence_revision?: number | null
  captured_input_revision?: string
  freshness_reasons?: string[]
  coverage?: {
    first: string
    last: string
    rows: number
    unavailable_cells: number
    columns: Record<
      string,
      { present: boolean; checked: number; zero: number; events: number; unavailable: number }
    >
  }
  events: {
    ex_date: string
    kind: 'cash_dividend' | 'stock_split'
    raw_value: string | null
    raw_type: string
    value: number | null
    reason: string | null
  }[]
  comparisons: { ex_date: string; kind: string; status: string; amount_comparison: string }[]
  changes: {
    ex_date: string
    kind: string
    status: string
    previous_raw_value: string | null
    current_raw_value: string | null
  }[]
}
export type CorporateActionsSummary = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  holdings: {
    symbol: string
    shares: string
    entry_session: string | null
    last_fill_session: string | null
    events_total: number
    events_since_entry: string[]
    events_after_last_fill: string[]
    status: 'events_since_entry' | 'entry_unknown' | 'clear'
  }[]
  flagged: string[]
  entry_unknown: string[]
  events: CorporateActionEvent[]
  coverage: { symbol: string; sessions: number; first: string | null; last: string | null }[]
  method: string
  warnings: string[]
  provider_evidence?: ProviderEvidence[]
}
const KINDS: Record<Kind, [string, string]> = {
  dividend: ['股息（推算）', 'Dividend (implied)'],
  suspected_split: ['疑似拆併股', 'Suspected split'],
  unclassified: ['無法分類', 'Unclassified'],
  unavailable: ['不可用', 'Unavailable'],
}
const REASONS: Record<string, [string, string]> = {
  implied_cash_out_of_range: ['推算現金超出 0–25% 範圍', 'Implied cash outside 0–25%'],
  implied_cash_not_finite: ['推算現金不是有限值', 'Implied cash is not finite'],
  non_finite_or_nonpositive_price: ['價格非有限或非正', 'Non-finite or non-positive price'],
}

export function PortfolioCorporateActions({
  account,
  locale,
}: {
  account: PaperAccount
  locale: Locale
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [result, setResult] = useState<{ key: string; value: CorporateActionsSummary } | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const identity = JSON.stringify([account.id, account.version, refresh])
  const identityRef = useRef(identity)
  identityRef.current = identity
  const summary = result?.key === identity ? result.value : null
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    const key = identity
    setResult(null)
    setError('')
    setLoading(true)
    fetch(`/api/paper/accounts/${encodeURIComponent(account.id)}/corporate-actions`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json().catch(() => ({}))
        if (!response.ok)
          throw new Error(
            t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
          )
        if (controller.signal.aborted || key !== identityRef.current) return
        if (value.account_id !== account.id || value.account_version !== account.version)
          throw new Error(
            t(
              '回應的帳戶或版本不符，請重新載入帳戶。',
              'The response account or version does not match. Reload the account.',
            ),
          )
        setResult({ key, value: value as CorporateActionsSummary })
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted && key === identityRef.current)
          setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (operation.current === controller) operation.current = null
        if (!controller.signal.aborted && key === identityRef.current) setLoading(false)
      })
    return () => {
      controller.abort()
      if (operation.current === controller) operation.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version, refresh])
  function reloadEvidence() {
    if (operation.current) return
    setResult(null)
    setLoading(true)
    setRefresh((value) => value + 1)
  }
  function download() {
    if (
      !summary ||
      loading ||
      operation.current ||
      result?.key !== identityRef.current ||
      summary.account_id !== account.id ||
      summary.account_version !== account.version
    )
      return
    try {
      // Preserve the accepted envelope, including fields not rendered by this UI.
      const json = JSON.stringify(
        summary,
        (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value))
            throw new Error('Corporate-action evidence contains a non-finite number')
          return value
        },
        2,
      )
      const safe = (text: string) =>
        text
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64) || 'unknown'
      const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `alphaview-corporate-action-evidence-${safe(summary.as_of)}-${safe(summary.account_id)}.json`
      try {
        document.body.appendChild(anchor)
        anchor.click()
      } finally {
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      }
    } catch {
      setError(
        t(
          '無法下載這份公司行動證據，請重新讀取本機證據後再試。',
          'This corporate-action evidence could not be downloaded. Reload local evidence and retry.',
        ),
      )
    }
  }
  const amount = (event: CorporateActionEvent) =>
    event.kind === 'suspected_split' && event.shares_multiplier != null
      ? `×${num(event.shares_multiplier, 2)} ${t('股數', 'shares')}`
      : event.implied_cash_per_share != null
        ? `$${num(event.implied_cash_per_share, 4)} / ${t('股', 'share')}`
        : '—'
  return (
    <section
      className="agent-panel corporate-actions-panel"
      aria-label={t('公司行動偵測', 'Corporate-action detection')}
    >
      <div className="section-heading">
        <div>
          <h2>
            {t('公司行動偵測（股息／拆併股）', 'Corporate-action detection (dividends / splits)')}
          </h2>
          <p>
            {t(
              '從本機日線的調整因子反推持倉在進場後是否遇到股息或拆併股；只提醒，不調整模擬帳本。',
              'Infers dividends and splits for held symbols from the local adjustment factor; a reminder only, the paper ledger is not adjusted.',
            )}
          </p>
        </div>
        <button className="secondary-button" disabled={loading} onClick={reloadEvidence}>
          {t('重新讀取本機證據', 'Reload local evidence')}
        </button>
        {summary && (
          <strong className={summary.flagged.length ? 'desk-negative' : ''}>
            {summary.flagged.length
              ? t(
                  `${summary.flagged.length} 檔進場後有事件`,
                  `${summary.flagged.length} with events since entry`,
                )
              : t('推算層：進場後無事件', 'Inference: no events since entry')}
          </strong>
        )}
      </div>
      <div className="actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!summary || loading}
          onClick={download}
        >
          {t('下載公司行動證據 JSON', 'Download corporate-action evidence JSON')}
        </button>
      </div>
      <p className="research-note">
        {t(
          '下載保留本機回應的讀取時狀態與不可變來源修訂值；不會重新擷取，也不是完整公司行動帳本或已入帳證明。',
          'The download preserves the local response’s read-time status and immutable source revision values. It does not refetch data or prove a complete corporate-action ledger or posting.',
        )}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <>
          {!!summary.entry_unknown.length && (
            <p className="notice" role="status">
              {t(
                '沒有進場紀錄，無法判斷進場後事件：',
                'No entry record, so events since entry cannot be judged: ',
              )}
              {summary.entry_unknown.join(' · ')}
            </p>
          )}
          {!summary.events.length ? (
            <p className="muted">
              {summary.holdings.length
                ? t(
                    '持倉的本機日線沒有偵測到公司行動。',
                    'No corporate action detected in the local bars of the holdings.',
                  )
                : t('沒有虛擬持倉。', 'No paper holdings.')}
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('標的', 'Symbol'),
                      t('除權息日', 'Ex-date'),
                      t('類型', 'Kind'),
                      t('倍率／現金', 'Ratio / cash'),
                      t('進場後', 'Since entry'),
                      t('資料一致性', 'Data consistency'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.events.map((event) => (
                    <tr key={`${event.symbol}:${event.ex_date}`}>
                      <th scope="row">{event.symbol}</th>
                      <td>{event.ex_date}</td>
                      <td>
                        {t(...KINDS[event.kind])}
                        {event.reason ? (
                          <small>
                            {' '}
                            · {REASONS[event.reason] ? t(...REASONS[event.reason]) : event.reason}
                          </small>
                        ) : null}
                      </td>
                      <td>{amount(event)}</td>
                      <td className={event.since_entry ? 'desk-negative' : ''}>
                        {event.since_entry ? t('是', 'Yes') : t('否', 'No')}
                        {event.after_last_fill ? ` · ${t('最後成交後', 'after last fill')}` : ''}
                      </td>
                      <td title={event.data_consistency?.message || undefined}>
                        {event.data_consistency
                          ? t(
                              '可能混用拆股前後口徑；請更新行情後重檢',
                              'Possibly mixed pre/post-split rows; refresh quotes and re-check',
                            )
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <CorporateRefreshActions
            key={account.id}
            account={account}
            summary={summary}
            t={t}
            onComplete={reloadEvidence}
          />
          <ProviderEvidencePanel evidence={summary.provider_evidence || []} t={t} />
          <p className="research-note">
            {t(
              '這不是什麼：推算層是調整價的啟發式判斷；供應者回傳證據也不保證完整，兩者都不會自動調整股數或現金。',
              'What this is not: inference is a heuristic from adjusted prices; adapter-returned evidence is not guaranteed complete. Neither adjusts shares or cash automatically.',
            )}{' '}
            <small>{summary.engine_version}</small>
          </p>
        </>
      )}
    </section>
  )
}

const EVIDENCE_STATUS: Record<ProviderEvidence['status'], [string, string]> = {
  unavailable: ['未擷取／不可用', 'Not captured / unavailable'],
  partial: ['欄位或數值不完整', 'Incomplete columns or values'],
  available: ['已保存回傳證據', 'Returned evidence saved'],
  stale: ['證據已過期或與行情不一致', 'Evidence stale or misaligned with bars'],
}
const COMPARISON_STATUS: Record<string, [string, string]> = {
  inconclusive: ['無法比較', 'Inconclusive'],
  same_date_and_kind: [
    '日期與類型相同；金額口徑仍未確認',
    'Same date and kind; amount basis remains unverified',
  ],
  inferred_without_reported_event: [
    '有推算事件，回傳欄位未列事件',
    'Inferred event absent from returned columns',
  ],
  reported_without_inference: [
    '有回傳事件，調整因子未偵測到',
    'Returned event absent from factor inference',
  ],
}
const FRESHNESS_REASONS: Record<string, [string, string]> = {
  bars_changed: ['本機日線已變更', 'Local bars changed'],
  source_update_failed: ['最近一次來源更新失敗', 'Latest source update failed'],
  capture_not_aligned: ['行情與證據擷取時間不同', 'Bars and evidence capture times differ'],
  coverage_ends_before_as_of: ['覆蓋尚未到查詢交易日', 'Coverage ends before the queried session'],
}

function ProviderEvidencePanel({ evidence, t }: { evidence: ProviderEvidence[]; t: Translate }) {
  const kind = (value: string) =>
    value === 'cash_dividend'
      ? t('回傳現金股息', 'Returned cash dividend')
      : t('回傳拆併股倍率', 'Returned split ratio')
  return (
    <div>
      <h3>{t('供應者回傳證據（yfinance）', 'Adapter-returned evidence (yfinance)')}</h3>
      <p className="research-note">
        {t(
          '這是 yfinance 正規化後的回傳值，不是 Yahoo 原始封包。欄位覆蓋只計算已收到的列；來源完整性未知，回傳 0 也不能證明沒有公司行動。',
          'These are normalized yfinance values, not the original Yahoo payload. Coverage counts received rows only; upstream completeness is unknown, and a returned zero does not prove no corporate action occurred.',
        )}
      </p>
      {!evidence.length && (
        <p className="muted">{t('沒有已保存的供應者證據。', 'No saved adapter evidence.')}</p>
      )}
      {evidence.map((entry) => (
        <div key={entry.symbol} className="agent-panel">
          <h4>
            {entry.symbol} · {t(...EVIDENCE_STATUS[entry.status])}
          </h4>
          {entry.fetched_at && (
            <p className="muted">
              {entry.source} · yfinance {entry.adapter_version} · {t('擷取時間', 'Fetched at')}{' '}
              {dateTime(entry.fetched_at)}
              <br />
              {t('事件修訂', 'Event revision')} {entry.evidence_revision} ·{' '}
              {t('擷取版本', 'Capture version')} {entry.capture_version}
              {entry.previous_evidence_revision != null && (
                <>
                  {' '}
                  · {t('前次不同修訂', 'Previous distinct revision')}{' '}
                  {entry.previous_evidence_revision}
                </>
              )}
            </p>
          )}
          {entry.coverage && (
            <>
              <p>
                {t('日線覆蓋', 'Bar coverage')}：{entry.coverage.first} – {entry.coverage.last} ·{' '}
                {entry.coverage.rows} {t('列', 'rows')} · {t('不可用儲存格', 'Unavailable cells')}{' '}
                {entry.coverage.unavailable_cells}
              </p>
              <ul>
                {Object.entries(entry.coverage.columns).map(([field, counts]) => (
                  <li key={field}>
                    {field === 'Dividends'
                      ? t('股息欄', 'Dividend column')
                      : t('拆併股欄', 'Split column')}
                    ：
                    {counts.present
                      ? `${t('已檢查', 'Checked')} ${counts.checked} · ${t('回傳事件', 'Returned events')} ${counts.events} · ${t('回傳零值', 'Returned zeros')} ${counts.zero} · ${t('不可用', 'Unavailable')} ${counts.unavailable}`
                      : t('未提供；所有列均為未知', 'Not provided; all rows unknown')}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!!entry.freshness_reasons?.length && (
            <p className="notice" role="status">
              {entry.freshness_reasons
                .map((reason) =>
                  FRESHNESS_REASONS[reason] ? t(...FRESHNESS_REASONS[reason]) : reason,
                )
                .join(' · ')}
            </p>
          )}
          {!!entry.events.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('除權息日', 'Ex-date'),
                      t('回傳類型', 'Returned kind'),
                      t('回傳原值', 'Returned raw value'),
                      t('可用性', 'Availability'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entry.events.map((event) => (
                    <tr key={`${event.ex_date}:${event.kind}`}>
                      <td>{event.ex_date}</td>
                      <td>{kind(event.kind)}</td>
                      <td>{event.raw_value ?? '—'}</td>
                      <td>
                        {event.reason
                          ? `${t('不可用', 'Unavailable')} · ${EVIDENCE_REASONS[event.reason] ? t(...EVIDENCE_REASONS[event.reason]) : t('來源值無法使用', 'Source value cannot be used')}`
                          : t('已回傳；未入帳', 'Reported; not posted to ledger')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entry.status !== 'unavailable' && !entry.events.length && (
            <p className="muted">
              {t(
                '此範圍沒有回傳非零事件；不代表來源完整。',
                'No nonzero events returned in this range; this does not establish source completeness.',
              )}
            </p>
          )}
          {!!entry.comparisons.length && (
            <ul>
              {entry.comparisons.map((comparison) => (
                <li key={`${comparison.ex_date}:${comparison.kind}`}>
                  {comparison.ex_date} · {kind(comparison.kind)} ·{' '}
                  {COMPARISON_STATUS[comparison.status]
                    ? t(...COMPARISON_STATUS[comparison.status])
                    : comparison.status}
                </li>
              ))}
            </ul>
          )}
          {!!entry.changes.length && (
            <details>
              <summary>
                {t(
                  '與前次不同證據修訂的差異',
                  'Changes from the previous distinct evidence revision',
                )}{' '}
                ({entry.changes.length})
              </summary>
              <ul>
                {entry.changes.map((change) => (
                  <li key={`${change.ex_date}:${change.kind}`}>
                    {change.ex_date} · {kind(change.kind)} · {change.previous_raw_value ?? '—'} →{' '}
                    {change.current_raw_value ?? '—'} ·{' '}
                    {change.status === 'not_reported_in_latest_capture'
                      ? t(
                          '本次未回傳，非已確認撤回',
                          'Not returned this time; not a confirmed retraction',
                        )
                      : change.status === 'newly_reported'
                        ? t('本次新增回傳', 'Newly returned')
                        : t('來源值已變更', 'Source value changed')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {entry.events.length > 0 && (
            <p className="research-note">
              {t(
                '股息金額與調整價推算的調整口徑未確認，不宣告相等或衝突；拆併股也可能已反映在歷史收盤價中。',
                'The adjustment basis of returned dividends and factor-implied amounts is unverified, so neither equality nor conflict is asserted. Splits may already be reflected in historical closes.',
              )}
            </p>
          )}
          <small>{entry.engine_version}</small>
        </div>
      ))}
    </div>
  )
}

const EVIDENCE_REASONS: Record<string, [string, string]> = {
  missing_value: ['未提供數值', 'Value not provided'],
  non_numeric_value: ['回傳值不是數字', 'Returned value is not numeric'],
  non_finite_value: ['回傳值不是有限數字', 'Returned value is not finite'],
  negative_value: ['回傳值為負數', 'Returned value is negative'],
}
type CorporateRefreshJob = {
  id: string
  account_id: string
  symbol: string
  status: string
  progress: string | null
  error: string | null
  cancel_requested: boolean
  result?: {
    holding_context?: string
    after?: { inferred_events: number; returned_events: number; unavailable_cells: number | null }
  }
}
const JOB_STATUS: Record<string, [string, string]> = {
  running: ['執行中', 'Running'],
  completed: ['已完成重檢', 'Re-detection completed'],
  failed: ['更新失敗', 'Refresh failed'],
  cancelled: ['已取消', 'Cancelled'],
  interrupted: ['背景程序已中斷', 'Background process interrupted'],
}
function CorporateRefreshActions({
  account,
  summary,
  t,
  onComplete,
}: {
  account: PaperAccount
  summary: CorporateActionsSummary
  t: Translate
  onComplete: () => void
}) {
  const [job, setJob] = useState<CorporateRefreshJob | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [checking, setChecking] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const startGuard = useRef(false)
  const requestIdentity = useRef<{ context: string; key: string } | null>(null)
  const cancelGuard = useRef(false)
  const alive = useRef(true)
  const requests = useRef(new Set<AbortController>())
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const base = `/api/paper/accounts/${encodeURIComponent(account.id)}/corporate-actions/refresh`
  const message = (value: { detail?: string | { message?: string } }, status: number) =>
    typeof value.detail === 'string'
      ? value.detail
      : value.detail?.message || t(`請求失敗（${status}）`, `Request failed (${status})`)
  useEffect(() => {
    alive.current = true
    const controllers = requests.current
    return () => {
      alive.current = false
      controllers.forEach((controller) => controller.abort())
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    fetch(base, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const value = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(message(value, response.status))
        if (controller.signal.aborted) return
        if (value.job && value.job.account_id !== account.id)
          throw new Error(t('作業來源與帳戶不符', 'Job context does not match this account'))
        setJob(value.job || null)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
    // Status restoration never launches another provider request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id])
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch(`${base}/${encodeURIComponent(job.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const value = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(message(value, response.status))
        if (controller.signal.aborted) return
        if (value.job?.id !== job.id || value.job?.account_id !== account.id)
          throw new Error(t('作業來源與帳戶不符', 'Job context does not match this account'))
        setJob(value.job)
        setError('')
        if (value.job.status === 'running') timer = setTimeout(poll, 1000)
        else onCompleteRef.current()
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err))
          timer = setTimeout(poll, 3000)
        }
      }
    }
    timer = setTimeout(poll, 1000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, job?.id, job?.status])
  const start = async (symbol: string) => {
    if (startGuard.current || checking || job?.status === 'running') return
    startGuard.current = true
    setStarting(true)
    setError('')
    const controller = new AbortController()
    requests.current.add(controller)
    const context = JSON.stringify([
      symbol,
      summary.account_version,
      summary.input_revision,
      summary.as_of,
    ])
    if (requestIdentity.current?.context !== context)
      requestIdentity.current = { context, key: crypto.randomUUID() }
    try {
      const response = await fetch(base, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          expected_account_version: summary.account_version,
          expected_input_revision: summary.input_revision,
          expected_as_of: summary.as_of,
          idempotency_key: requestIdentity.current.key,
        }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(message(value, response.status))
      if (!alive.current || controller.signal.aborted) return
      if (value.job?.account_id !== account.id || value.job?.symbol !== symbol)
        throw new Error(t('作業來源與帳戶不符', 'Job context does not match this account'))
      requestIdentity.current = null
      setJob(value.job)
      if (value.job.status !== 'running') onCompleteRef.current()
    } catch (err) {
      if (alive.current && !controller.signal.aborted)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      requests.current.delete(controller)
      startGuard.current = false
      if (alive.current) setStarting(false)
    }
  }
  const cancel = async () => {
    if (!job || cancelGuard.current || job.status !== 'running' || job.cancel_requested) return
    cancelGuard.current = true
    setCancelling(true)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST',
        signal: controller.signal,
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(message(value, response.status))
      if (alive.current && !controller.signal.aborted)
        setJob((current) =>
          current?.id === job.id
            ? { ...current, cancel_requested: Boolean(value.cancel_requested) }
            : current,
        )
    } catch (err) {
      if (alive.current && !controller.signal.aborted)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      requests.current.delete(controller)
      cancelGuard.current = false
      if (alive.current) setCancelling(false)
    }
  }
  return (
    <div className="corporate-refresh-actions">
      <h3>{t('更新單一持倉標的並重檢', 'Refresh one held symbol and re-detect')}</h3>
      <p className="research-note">
        {t(
          '按下才會呼叫既有 Yahoo 來源，替換此標的最近兩年日線並重檢。更新成功不代表公司行動異常已修復；不調整股數、成本或現金。',
          'Only a click contacts the existing Yahoo source, replaces this symbol’s latest two years of daily bars, and re-detects events. A successful refresh does not prove an anomaly is resolved; shares, cost and cash are not adjusted.',
        )}
      </p>
      <div className="corporate-refresh-buttons">
        {summary.holdings.map((holding) => (
          <button
            className="secondary-button"
            key={holding.symbol}
            disabled={checking || starting || job?.status === 'running'}
            onClick={() => void start(holding.symbol)}
          >
            {t('更新兩年行情並重檢', 'Refresh two years and re-detect')} · {holding.symbol}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {job && (
        <div className="notice" role="status">
          <strong>
            {job.symbol} · {JOB_STATUS[job.status] ? t(...JOB_STATUS[job.status]) : job.status}
          </strong>
          <p>{job.error || job.progress}</p>
          {job.result?.holding_context === 'changed_not_validated' && (
            <p>
              {t(
                '帳戶或交易日已變更；本次未驗證目前持倉。',
                'The account or session changed; this run did not validate the current holding.',
              )}
            </p>
          )}
          {job.result?.after && (
            <p>
              {t('重檢結果', 'Re-detection result')}：{t('推算事件', 'Inferred events')}{' '}
              {job.result.after.inferred_events} · {t('回傳事件', 'Returned events')}{' '}
              {job.result.after.returned_events} · {t('不可用儲存格', 'Unavailable cells')}{' '}
              {job.result.after.unavailable_cells ?? '—'}
            </p>
          )}
          {job.status === 'running' && (
            <>
              <p>
                {t(
                  '取消會等待目前下載結束；已完整保存的行情仍保留。',
                  'Cancellation waits for the current download; atomically saved quotes are retained.',
                )}
              </p>
              <button
                className="secondary-button"
                disabled={cancelling || job.cancel_requested}
                onClick={() => void cancel()}
              >
                {job.cancel_requested
                  ? t('正在取消…', 'Cancelling…')
                  : t('取消本次更新', 'Cancel this refresh')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
