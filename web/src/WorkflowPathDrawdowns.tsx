import { useEffect, useRef, useState } from 'react'
import { num } from './ui'
import './workflow-path-drawdowns.css'

type Translate = (zh: string, en: string) => string
type Receipt = {
  id: string
  run_id: string
  kind: 'path_validation'
  created_at: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
}
type Episode = {
  episode: number
  status: 'open' | 'recovered'
  peak_date: string
  peak_nav: number
  first_underwater_date: string
  trough_date: string
  trough_nav: number
  depth_pct: number
  recovery_date: string | null
  recovery_nav: number | null
  duration_sessions: number | null
  underwater_sessions: number | null
  to_trough_sessions: number
  trough_to_recovery_sessions: number | null
  observed_underwater_sessions: number
  observed_elapsed_sessions: number
  observed_through_date: string
}
export type PathDrawdowns = {
  engine_version: string
  account_id: string
  account_version: number
  request: { receipt_id: string; expected_fingerprint: string; expected_account_version: number }
  original_receipt: {
    receipt_id: string
    evidence: { metrics: Record<string, number | null> | null }
  }
  receipt_summary: Receipt
  checked_as_of: string
  checked_input_revision: string
  execution_authority: false
  analysis: {
    status: 'evaluated' | 'unavailable'
    reasons: string[]
    basis_checks: { code: string; available: boolean }[]
    historical_calendar: {
      exchange: string
      signal_date: string
      as_of: string
      valued_sessions: number
    } | null
    episodes: Episode[] | null
    curve:
      | {
          index: number
          date: string
          nav: number
          peak_nav: number
          drawdown_pct: number
          episode: number | null
        }[]
      | null
    summary: {
      episode_count: number
      recovered_episode_count: number
      open_episode_count: number
      unrecovered_at_end: boolean
      max_drawdown_pct: number
      total_underwater_sessions: number
      longest_observed_underwater_sessions: number
      longest_closed_duration_sessions: number | null
      longest_observed_elapsed_sessions: number | null
    } | null
    reconciliation: {
      computed_max_drawdown_pct: number
      recorded_max_drawdown_pct: number
      difference_percentage_points: number | null
      within_tolerance: boolean
      absolute_tolerance_percentage_points: number
      relative_tolerance: number
    } | null
  }
}
const LIMIT_BYTES = 3 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
const numeric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const basisLabel = (code: string, t: Translate) =>
  ({
    method_versions: t('保存方法版本', 'Saved method versions'),
    pricing_method: t('估值與成交方法', 'Pricing method'),
    raw_history: t('原始資料指紋', 'Raw history fingerprint'),
    candidate_symbols: t('候選股票池', 'Candidate universe'),
    rps_universe: t('RPS 股票池', 'RPS universe'),
    exact_window: t('完整估值期間', 'Complete valuation window'),
    exact_valued_dates: t('逐日估值日期', 'Exact valued dates'),
    complete_coverage: t('原路徑涵蓋', 'Original path coverage'),
    initial_cash_and_baseline_costs: t('起始資金與基準成本', 'Initial cash and baseline costs'),
    required_metrics: t('必要指標', 'Required metrics'),
  })[code] ?? code
function reason(code: string, t: Translate) {
  if (code.startsWith('drawdown_basis_'))
    return `${basisLabel(code.slice('drawdown_basis_'.length), t)}: ${t('不可用或不完整', 'Unavailable or incomplete')}`
  return (
    {
      drawdown_exact_historical_calendar_mismatch: t(
        '保存日期未完整符合歷史 XNYS 交易日曆。',
        'Saved dates do not match the complete historical XNYS calendar.',
      ),
      drawdown_historical_calendar_unavailable: t(
        '歷史交易日曆不可用。',
        'Historical session calendar is unavailable.',
      ),
      drawdown_saved_metric_mismatch: t(
        '逐日回撤與保存的最大回撤不相符。',
        'Observed drawdown does not reconcile with the saved maximum drawdown.',
      ),
      drawdown_curve_values_unavailable: t(
        '淨值包含缺漏、非有限或非正數。',
        'NAV contains missing, nonfinite or nonpositive values.',
      ),
      drawdown_curve_dates_unavailable: t(
        '日期重複或順序不符。',
        'Dates repeat or are out of order.',
      ),
      drawdown_curve_size_unavailable: t(
        '曲線觀察數量不可用。',
        'Curve observation count is unavailable.',
      ),
      drawdown_arithmetic_unavailable: t(
        '回撤無法以有限值表示。',
        'Drawdown cannot be represented as a finite value.',
      ),
      drawdown_account_changed: t(
        '帳戶版本已變更，請重新檢視。',
        'The account version changed; inspect again.',
      ),
      drawdown_path_receipt_required: t(
        '請選擇歷史路徑回條。',
        'Choose a historical path receipt.',
      ),
      drawdown_observation_session_changed: t(
        '觀察交易日已變更，請重新檢視。',
        'The observation session changed; inspect again.',
      ),
      drawdown_export_size_limit: t(
        '完整回應超過 3 MiB；未截短。',
        'The complete response exceeds 3 MiB; it was not truncated.',
      ),
    }[code] ?? code
  )
}

function DrawdownCurve({ curve, t }: { curve: PathDrawdowns['analysis']['curve']; t: Translate }) {
  if (!curve?.length || curve.some((point) => !Number.isFinite(point.drawdown_pct))) return null
  const floor = Math.min(...curve.map((point) => point.drawdown_pct))
  const points = curve
    .map(
      (point, index) =>
        `${48 + (index / Math.max(1, curve.length - 1)) * 560},${18 + (floor < 0 ? point.drawdown_pct / floor : 0) * 104}`,
    )
    .join(' ')
  return (
    <figure className="path-drawdown-curve">
      <svg
        viewBox="0 0 640 150"
        role="img"
        aria-label={t('保存路徑的逐日回撤曲線', 'Daily drawdown curve from the saved path')}
      >
        <title>{t('保存路徑的逐日回撤曲線', 'Daily drawdown curve from the saved path')}</title>
        <line x1="48" y1="18" x2="608" y2="18" className="drawdown-zero" />
        <text x="4" y="22">
          0%
        </text>
        {floor < 0 && (
          <text x="4" y="126">
            {numeric(floor, 1)}%
          </text>
        )}
        <polyline points={points} className="drawdown-line" />
      </svg>
      <figcaption>
        {curve[0].date} → {curve[curve.length - 1].date} ·{' '}
        {t(
          '含期初現金錨點；依交易日順序。',
          'Includes the initial cash anchor; session order is preserved.',
        )}
      </figcaption>
    </figure>
  )
}

export function WorkflowPathDrawdowns({
  accountId,
  accountVersion,
  t,
}: {
  accountId: string | null
  accountVersion: number | null
  t: Translate
}) {
  const identity = JSON.stringify([accountId, accountVersion])
  const latest = useRef(identity)
  latest.current = identity
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    accountId: string | null
    busy?: boolean
    error?: string
    items?: Receipt[]
    selected?: string
    result?: PathDrawdowns
    raw?: string
  }>({ identity, accountId })
  const current = state.accountId === accountId ? state : null
  const result = state.identity === identity ? current?.result : undefined
  const busy = state.identity === identity && current?.busy
  const items = current?.items ?? []
  const selected = items.find((item) => item.id === current?.selected)
  const base = `/api/paper/accounts/${encodeURIComponent(accountId ?? '')}/workflow-path-receipts`
  useEffect(() => {
    setState((old) =>
      old.accountId === accountId
        ? { identity, accountId, items: old.items, selected: old.selected }
        : { identity, accountId },
    )
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [identity, accountId])
  async function accepted(response: Response) {
    const raw = await response.text()
    if (new TextEncoder().encode(raw).length > LIMIT_BYTES)
      throw new Error(
        t(
          '完整回應超過 3 MiB；未截短。',
          'The complete response exceeds 3 MiB; it was not truncated.',
        ),
      )
    const value = JSON.parse(raw)
    if (!response.ok)
      throw new Error(
        reason(
          value.detail?.code ??
            value.detail?.message ??
            t('無法讀取回條。', 'Could not read the receipt.'),
          t,
        ),
      )
    return { raw, value }
  }
  async function perform(task: (signal: AbortSignal) => Promise<Partial<typeof state>>) {
    if (!accountId || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setState((old) => ({
      ...old,
      identity,
      accountId,
      busy: true,
      error: undefined,
      result: undefined,
      raw: undefined,
    }))
    try {
      const update = await task(controller.signal)
      if (!controller.signal.aborted && latest.current === identity)
        setState((old) => ({ ...old, ...update, identity, accountId, busy: false }))
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity)
        setState((old) => ({
          ...old,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }
  function load() {
    void perform(async (signal) => {
      const { value } = await accepted(
        await fetch(`${base}?kind=path_validation&limit=50`, { signal }),
      )
      if (
        value.account_id !== accountId ||
        value.kind !== 'path_validation' ||
        !Array.isArray(value.items)
      )
        throw new Error(t('回條範圍不相符。', 'Receipt scope does not match.'))
      return {
        items: value.items,
        selected:
          current?.selected && value.items.some((item: Receipt) => item.id === current.selected)
            ? current.selected
            : undefined,
      }
    })
  }
  function inspect() {
    if (
      !selected?.integrity.available ||
      !hash.test(selected.id) ||
      !hash.test(selected.content_fingerprint) ||
      !accountVersion ||
      pending.current
    )
      return
    const request = {
      receipt_id: selected.id,
      expected_fingerprint: selected.content_fingerprint,
      expected_account_version: accountVersion,
    }
    void perform(async (signal) => {
      const { value, raw } = await accepted(
        await fetch(`${base}/drawdowns`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      )
      if (
        value.account_id !== accountId ||
        value.account_version !== accountVersion ||
        Object.entries(request).some(([key, item]) => value.request?.[key] !== item) ||
        value.receipt_summary?.id !== selected.id ||
        value.receipt_summary?.content_fingerprint !== selected.content_fingerprint ||
        value.original_receipt?.receipt_id !== selected.id ||
        value.execution_authority !== false ||
        !['evaluated', 'unavailable'].includes(value.analysis?.status)
      )
        throw new Error(
          t('回撤回應與所選回條不相符。', 'Drawdown response does not match the selected receipt.'),
        )
      return { result: value, raw }
    })
  }
  function download() {
    if (!result || !current?.raw) return
    const object = URL.createObjectURL(new Blob([current.raw], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = object
    link.download = `alphaview-path-drawdowns-${result.request.receipt_id.slice(0, 12)}.json`
    link.click()
    URL.revokeObjectURL(object)
  }
  const analysis = result?.analysis
  const summary = analysis?.summary
  const original = result?.original_receipt.evidence.metrics
  return (
    <section
      className="workflow-path-drawdowns"
      aria-label={t('保存路徑回撤與恢復', 'Saved path drawdowns and recovery')}
    >
      <h3>{t('保存路徑回撤與恢復', 'Saved path drawdowns and recovery')}</h3>
      <p>
        {t(
          '從一筆保存回條辨識每段回撤、谷底與恢復時間。只讀原淨值，按原日期保留所有觀察。',
          'Inspect each drawdown, trough and recovery in one saved receipt. Read original NAV and preserve every observation in its original order.',
        )}
      </p>
      <p className="notice">
        {t(
          '這是保存歷史的描述，不是未來恢復預測、風險排名、通過判定或交易授權。未恢復區段不填入未來日期。',
          'This describes saved history; it is not a recovery forecast, risk ranking, pass decision or trading authorization. Open episodes receive no future recovery date.',
        )}
      </p>
      <div className="actions">
        <button type="button" disabled={!accountId || !!busy} onClick={load}>
          {busy ? t('讀取中…', 'Reading…') : t('載入歷史路徑回條', 'Load historical path receipts')}
        </button>
      </div>
      {current?.error && state.identity === identity && <p role="alert">{current.error}</p>}
      {current?.items && (
        <>
          <p>
            {t('已載入', 'Loaded')} {items.length}{' '}
            {t(
              '筆，最多 50 筆；選擇一筆可驗證回條。',
              'receipts, up to 50; choose one verifiable receipt.',
            )}
          </p>
          <label className="path-drawdown-selector">
            {t('回撤來源回條', 'Drawdown source receipt')}
            <select
              value={current.selected ?? ''}
              disabled={!!busy}
              onChange={(event) =>
                setState((old) => ({
                  ...old,
                  selected: event.target.value,
                  result: undefined,
                  raw: undefined,
                  error: undefined,
                }))
              }
            >
              <option value="">{t('請選擇', 'Choose a receipt')}</option>
              {items.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={
                    !item.integrity.available ||
                    !hash.test(item.id) ||
                    !hash.test(item.content_fingerprint)
                  }
                >
                  {item.created_at} · {item.run_id.slice(0, 10)} · {item.id.slice(0, 10)}
                  {item.integrity.available ? '' : ` · ${t('不可驗證', 'Unverifiable')}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              !!busy ||
              !accountVersion ||
              !selected?.integrity.available ||
              !hash.test(selected.id) ||
              !hash.test(selected.content_fingerprint)
            }
            onClick={inspect}
          >
            {t('檢視保存回撤區段', 'Inspect saved drawdown episodes')}
          </button>
          {!accountVersion && (
            <p role="status">
              {t(
                '正在核對帳戶；保留所選回條。',
                'Checking the account; your receipt selection is retained.',
              )}
            </p>
          )}
        </>
      )}
      {result && analysis && (
        <div aria-live="polite">
          <h4>
            {analysis.status === 'evaluated'
              ? t('回撤區段已核對', 'Drawdown episodes verified')
              : t('回撤分析不可用', 'Drawdown analysis unavailable')}
          </h4>
          <p className="drawdown-observation">
            {result.receipt_summary.currentness.current === true
              ? t('檢視當下來源相符。', 'Sources matched when inspected.')
              : result.receipt_summary.currentness.current === false
                ? t(
                    '歷史來源已非當期；仍保留原回撤觀察。',
                    'Historical sources are no longer current; original drawdown observations remain.',
                  )
                : t('檢視當下來源無法核對。', 'Sources could not be checked when inspected.')}{' '}
            {t('觀察交易日', 'Observation session')}: {result.checked_as_of}
          </p>
          <p className="muted">
            {t(
              '來源狀態不會自動更新，也不會改寫保存淨值或目前執行資格。',
              'Source status does not refresh automatically, rewrite saved NAV or change current execution eligibility.',
            )}
          </p>
          {!!analysis.reasons.length && (
            <ul>
              {analysis.reasons.map((code) => (
                <li key={code}>{reason(code, t)}</li>
              ))}
            </ul>
          )}
          <dl className="path-drawdown-summary">
            <div>
              <dt>{t('原回條最大回撤（%）', 'Original receipt max drawdown (%)')}</dt>
              <dd>{numeric(original?.max_drawdown_pct)}</dd>
            </div>
            <div>
              <dt>{t('逐日核對最大回撤（%）', 'Reconciled max drawdown (%)')}</dt>
              <dd>{numeric(summary?.max_drawdown_pct)}</dd>
            </div>
            <div>
              <dt>{t('回撤區段數', 'Drawdown episodes')}</dt>
              <dd>{numeric(summary?.episode_count, 0)}</dd>
            </div>
            <div>
              <dt>{t('已恢復區段數', 'Recovered episodes')}</dt>
              <dd>{numeric(summary?.recovered_episode_count, 0)}</dd>
            </div>
            <div>
              <dt>{t('觀察到的水下交易日合計', 'Total observed underwater sessions')}</dt>
              <dd>{numeric(summary?.total_underwater_sessions, 0)}</dd>
            </div>
            <div>
              <dt>{t('最長已完成區段間隔', 'Longest completed episode interval')}</dt>
              <dd>{numeric(summary?.longest_closed_duration_sessions, 0)}</dd>
            </div>
          </dl>
          {summary?.unrecovered_at_end && (
            <p className="notice drawdown-open" role="status">
              {t(
                '期末仍未恢復。恢復日期與完整恢復時間不可用；已觀察時間不代表未來還需多久。',
                'Still unrecovered at the end. Recovery date and completed duration are unavailable; observed time does not predict remaining time.',
              )}
            </p>
          )}
          {analysis.status === 'evaluated' && analysis.episodes?.length === 0 && (
            <p>
              {t(
                '此保存期間未觀察到回撤。回撤與計數為 0；區段時間為 —。',
                'No drawdown was observed in this saved window. Drawdown and counts are 0; episode durations are —.',
              )}
            </p>
          )}
          <DrawdownCurve curve={analysis.curve} t={t} />
          {!!analysis.episodes?.length && (
            <>
              <h4>{t('依時間排序的回撤區段', 'Drawdown episodes in chronological order')}</h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('區段／狀態', 'Episode / status')}</th>
                      <th>{t('高點 → 谷底', 'Peak → trough')}</th>
                      <th>{t('深度（%）', 'Depth (%)')}</th>
                      <th>{t('恢復日期', 'Recovery date')}</th>
                      <th>{t('完整區段／水下日數', 'Completed interval / underwater sessions')}</th>
                      <th>{t('至谷底／谷底至恢復', 'To trough / trough to recovery')}</th>
                      <th>
                        {t('已觀察間隔／水下日數', 'Observed interval / underwater sessions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.episodes.map((episode) => (
                      <tr
                        key={episode.episode}
                        className={episode.status === 'open' ? 'drawdown-open-row' : undefined}
                      >
                        <th scope="row">
                          {episode.episode} ·{' '}
                          {episode.status === 'open'
                            ? t('未恢復', 'Open')
                            : t('已恢復', 'Recovered')}
                        </th>
                        <td>
                          {episode.peak_date}
                          <br />→ {episode.trough_date}
                          <br />
                          <span className="muted">
                            {numeric(episode.peak_nav)} → {numeric(episode.trough_nav)}
                          </span>
                        </td>
                        <td>{numeric(episode.depth_pct)}</td>
                        <td>{episode.recovery_date ?? '—'}</td>
                        <td>
                          {numeric(episode.duration_sessions, 0)} /{' '}
                          {numeric(episode.underwater_sessions, 0)}
                        </td>
                        <td>
                          {numeric(episode.to_trough_sessions, 0)} /{' '}
                          {numeric(episode.trough_to_recovery_sessions, 0)}
                        </td>
                        <td>
                          {numeric(episode.observed_elapsed_sessions, 0)} /{' '}
                          {numeric(episode.observed_underwater_sessions, 0)}
                          <br />
                          <span className="muted">
                            {t('截至', 'Through')} {episode.observed_through_date}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="muted">
            {t(
              '時間單位為 XNYS 交易日觀察間隔，不是日曆天。水下日數排除恢復當日；完整區段包括從高點到恢復的間隔。',
              'Durations use XNYS observation-session intervals, not calendar days. Underwater counts exclude the recovery session; completed intervals run from peak to recovery.',
            )}
          </p>
          <details>
            <summary>{t('核對基礎與計算口徑', 'Basis and calculation convention')}</summary>
            <p>
              {t(
                '期初現金為索引 0；沒有回撤時，高點相等取較晚日期。回撤開始後固定高點，谷底相等保留首次；第一次回到或超過該高點即恢復。',
                'Initial cash is index 0. Outside an episode, equal peaks use the latest date. Once underwater, freeze the peak, retain the first equal trough, and recover on the first value at or above that peak.',
              )}
            </p>
            <ul>
              {analysis.basis_checks.map((check) => (
                <li key={check.code}>
                  {basisLabel(check.code, t)}:{' '}
                  {check.available ? t('可核對', 'Verified') : t('不可用', 'Unavailable')}
                </li>
              ))}
            </ul>
            {analysis.historical_calendar && (
              <p>
                XNYS · {analysis.historical_calendar.signal_date} →{' '}
                {analysis.historical_calendar.as_of} ·{' '}
                {analysis.historical_calendar.valued_sessions}{' '}
                {t('個估值交易日，加期初錨點。', 'valued sessions plus the initial anchor.')}
              </p>
            )}
            {analysis.reconciliation && (
              <p>
                {t('最大回撤差額（百分點）', 'Max drawdown difference (percentage points)')}:{' '}
                {numeric(analysis.reconciliation.difference_percentage_points, 10)} ·{' '}
                {t('絕對容差', 'Absolute tolerance')}:{' '}
                {analysis.reconciliation.absolute_tolerance_percentage_points} ·{' '}
                {t('相對容差', 'Relative tolerance')}: {analysis.reconciliation.relative_tolerance}
              </p>
            )}
            <p>
              <code>{result.engine_version}</code>
            </p>
          </details>
          <button type="button" onClick={download}>
            {t(
              '下載完整原回條與回撤分析 JSON',
              'Download complete original receipt and drawdown analysis JSON',
            )}
          </button>
        </div>
      )}
    </section>
  )
}
