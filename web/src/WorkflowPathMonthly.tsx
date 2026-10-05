import { useEffect, useMemo, useRef, useState } from 'react'
import { num } from './ui'
import {
  downloadPathAnalysisCsv,
  pathAnalysisCsvFilename,
  pathMonthlyCsv,
} from './path-analysis-csv'
import './workflow-path-monthly.css'

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
type MonthCell = {
  month: string
  month_number: number
  status: 'complete' | 'partial' | 'outside_window'
  reasons: string[]
  return_pct: number | null
  nav_change: number | null
  observed_sessions: number | null
  expected_sessions: number | null
  observed_start: string | null
  observed_end: string | null
}
type Month = MonthCell & {
  year: number
  expected_first_session: string
  expected_last_session: string
  unobserved_month_sessions: number
  boundary_date: string
  boundary_nav: number
  boundary_kind: 'initial_cash' | 'preceding_saved_nav'
  end_nav: number
  gross_return: number
}
export type PathMonthly = {
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
  tolerances: {
    return_absolute_percentage_points: number
    nav_absolute_units: number
    relative: number
  }
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
    months: Month[] | null
    years: { year: number; months: MonthCell[] }[] | null
    summary: {
      observed_month_count: number
      complete_month_count: number
      partial_month_count: number
      valued_sessions: number
      initial_cash: number
      final_value: number
      nav_change: number
      summed_monthly_nav_change: number
      direct_return_pct: number
      chained_return_pct: number
      chained_final_value: number
      first_observed_date: string
      last_observed_date: string
    } | null
    reconciliation:
      | {
          code: string
          computed: number
          reference: number
          difference: number | null
          unit: 'percentage_points' | 'nav_units'
          within_tolerance: boolean
        }[]
      | null
  }
}
const LIMIT_BYTES = 3 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const numeric = (value: number | null | undefined, digits = 2) =>
  finite(value) ? num(value, digits) : '—'
const percent = (value: number | null | undefined) =>
  finite(value) ? `${value > 0 ? '+' : ''}${num(value, 2)}%` : '—'
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
  if (code.startsWith('monthly_basis_'))
    return `${basisLabel(code.slice('monthly_basis_'.length), t)}: ${t('不可用或不完整', 'Unavailable or incomplete')}`
  return (
    {
      outside_saved_window: t('保存期間外', 'Outside saved window'),
      month_starts_after_first_session: t(
        '起點晚於該月首個交易日',
        'Starts after the first session of the month',
      ),
      month_ends_before_last_session: t(
        '終點早於該月最後交易日',
        'Ends before the last session of the month',
      ),
      monthly_exact_historical_calendar_mismatch: t(
        '保存日期未完整符合歷史 XNYS 交易日曆。',
        'Saved dates do not match the complete historical XNYS calendar.',
      ),
      monthly_month_calendar_mismatch: t(
        '保存月份內的交易日不完整。',
        'Saved sessions within a month are incomplete.',
      ),
      monthly_historical_calendar_unavailable: t(
        '歷史交易日曆不可用。',
        'Historical session calendar is unavailable.',
      ),
      monthly_exact_session_count_required: t(
        '月曆需要完整 252 個保存估值日。',
        'The calendar requires all 252 saved valuation sessions.',
      ),
      monthly_curve_values_unavailable: t(
        '淨值包含缺漏、非有限或非正數。',
        'NAV contains missing, nonfinite or nonpositive values.',
      ),
      monthly_curve_dates_unavailable: t(
        '日期重複或順序不符。',
        'Dates repeat or are out of order.',
      ),
      monthly_curve_size_unavailable: t(
        '曲線觀察數量不可用。',
        'Curve observation count is unavailable.',
      ),
      monthly_arithmetic_unavailable: t(
        '月份或整段報酬無法以有限值表示。',
        'Monthly or full-period returns cannot be represented as finite values.',
      ),
      monthly_saved_metrics_mismatch: t(
        '月份串接結果與保存整段指標不相符。',
        'Chained monthly outcomes do not reconcile with the saved full-period metrics.',
      ),
      monthly_account_changed: t(
        '帳戶版本已變更，請重新檢視。',
        'The account version changed; inspect again.',
      ),
      monthly_path_receipt_required: t('請選擇歷史路徑回條。', 'Choose a historical path receipt.'),
      monthly_observation_session_changed: t(
        '觀察交易日已變更，請重新檢視。',
        'The observation session changed; inspect again.',
      ),
      monthly_export_size_limit: t(
        '完整回應超過 3 MiB；未截短。',
        'The complete response exceeds 3 MiB; it was not truncated.',
      ),
    }[code] ?? code
  )
}
const reconciliationLabel = (code: string, t: Translate) =>
  ({
    final_nav_matches_saved: t('期末淨值與原件', 'Final NAV versus original'),
    direct_return_matches_saved: t('首尾報酬與原件', 'Endpoint return versus original'),
    chained_return_matches_saved: t('月份串接報酬與原件', 'Chained monthly return versus original'),
    chained_return_matches_direct: t(
      '月份串接報酬與首尾報酬',
      'Chained return versus endpoint return',
    ),
    monthly_nav_changes_match_total: t(
      '月份淨值變動加總與首尾差額',
      'Summed monthly NAV changes versus endpoint change',
    ),
    chained_final_nav_matches_final: t(
      '串接期末淨值與保存末點',
      'Chained final NAV versus saved endpoint',
    ),
  })[code] ?? code

function MonthlyGrid({
  years,
  t,
}: {
  years: NonNullable<PathMonthly['analysis']['years']>
  t: Translate
}) {
  const names = [
    t('1 月', 'Jan'),
    t('2 月', 'Feb'),
    t('3 月', 'Mar'),
    t('4 月', 'Apr'),
    t('5 月', 'May'),
    t('6 月', 'Jun'),
    t('7 月', 'Jul'),
    t('8 月', 'Aug'),
    t('9 月', 'Sep'),
    t('10 月', 'Oct'),
    t('11 月', 'Nov'),
    t('12 月', 'Dec'),
  ]
  return (
    <div className="path-monthly-years">
      {years.map((year) => (
        <section
          key={year.year}
          aria-label={`${year.year} ${t('保存月報酬', 'saved monthly returns')}`}
        >
          <h4>{year.year}</h4>
          <ol
            className="path-monthly-grid"
            aria-label={`${year.year} ${t('十二個月份', 'twelve months')}`}
          >
            {year.months.map((cell) => {
              const value = cell.return_pct
              const outcome = !finite(value)
                ? 'unavailable'
                : value > 0
                  ? 'positive'
                  : value < 0
                    ? 'negative'
                    : 'neutral'
              return (
                <li key={cell.month} className={`monthly-${outcome}`}>
                  <time dateTime={cell.month}>{names[cell.month_number - 1]}</time>
                  <strong>{percent(value)}</strong>
                  {cell.status === 'outside_window' ? (
                    <span>{reason('outside_saved_window', t)}</span>
                  ) : (
                    <>
                      <span>
                        {outcome === 'positive'
                          ? t('上升', 'Up')
                          : outcome === 'negative'
                            ? t('下降', 'Down')
                            : t('無變動', 'Unchanged')}
                      </span>
                      <small className={cell.status === 'partial' ? 'monthly-partial' : undefined}>
                        {cell.status === 'partial'
                          ? t('部分月份', 'Partial month')
                          : t('完整月份', 'Complete month')}
                      </small>
                      <small>
                        {numeric(cell.observed_sessions, 0)}/{numeric(cell.expected_sessions, 0)}{' '}
                        {t('交易日', 'sessions')}
                      </small>
                    </>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

export function WorkflowPathMonthly({
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
    result?: PathMonthly
    raw?: string
  }>({ identity, accountId })
  const current = state.accountId === accountId ? state : null
  const result = state.identity === identity ? current?.result : undefined
  const busy = state.identity === identity && current?.busy
  const items = current?.items ?? []
  const selected = items.find((item) => item.id === current?.selected)
  const validVersion =
    typeof accountVersion === 'number' &&
    Number.isSafeInteger(accountVersion) &&
    accountVersion > 0 &&
    accountVersion <= 2147483647
  const base = `/api/paper/accounts/${encodeURIComponent(accountId ?? '')}/workflow-path-receipts`
  const csvExport = useMemo(() => {
    if (result?.analysis.status !== 'evaluated') return null
    try {
      return { content: pathMonthlyCsv(result), invalid: false }
    } catch {
      return { content: null, invalid: true }
    }
  }, [result])
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
      !validVersion ||
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
        await fetch(`${base}/monthly`, {
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
          t('月曆回應與所選回條不相符。', 'Monthly response does not match the selected receipt.'),
        )
      return { result: value, raw }
    })
  }
  function download() {
    if (!result || !current?.raw) return
    const object = URL.createObjectURL(new Blob([current.raw], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = object
    link.download = `alphaview-path-monthly-${result.request.receipt_id.slice(0, 12)}.json`
    link.click()
    URL.revokeObjectURL(object)
  }
  function downloadCsv() {
    if (
      !result ||
      !current?.raw ||
      !csvExport?.content ||
      latest.current !== identity ||
      pending.current
    )
      return
    downloadPathAnalysisCsv(
      csvExport.content,
      pathAnalysisCsvFilename('monthly', result.request.receipt_id),
    )
  }
  const analysis = result?.analysis
  const summary = analysis?.summary
  const original = result?.original_receipt.evidence.metrics
  return (
    <section
      className="workflow-path-monthly"
      aria-label={t('保存路徑月報酬', 'Saved path monthly returns')}
    >
      <h3>{t('保存路徑月報酬', 'Saved path monthly returns')}</h3>
      <p>
        {t(
          '按月份查看一筆原回條的保存結果。每月從前一個保存淨值接續，第一個月從期初現金接續。',
          'Review one original receipt month by month. Each month continues from the preceding saved NAV, and the first month begins at initial cash.',
        )}
      </p>
      <p className="notice">
        {t(
          '部分月份只描述已觀察區間；不當成完整月份，不年化、不與基準比較，也不排名、預測或授權交易。期間外顯示 —。',
          'Partial months describe only their observed interval. They are not full-month returns, annualized figures, benchmarks, rankings, forecasts or trading authorization. Outside the window shows —.',
        )}
      </p>
      <div className="actions">
        <button type="button" disabled={!accountId || !!busy} onClick={load}>
          {busy
            ? t('讀取中…', 'Reading…')
            : t('載入月報酬來源回條', 'Load monthly return receipts')}
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
          <label className="path-monthly-selector">
            {t('月報酬來源回條', 'Monthly return source receipt')}
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
              !validVersion ||
              !selected?.integrity.available ||
              !hash.test(selected.id) ||
              !hash.test(selected.content_fingerprint)
            }
            onClick={inspect}
          >
            {t('檢視保存月報酬', 'Inspect saved monthly returns')}
          </button>
          {!validVersion && (
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
              ? t('月份與整段結果已核對', 'Monthly and full-period outcomes reconciled')
              : t('月報酬分析不可用', 'Monthly return analysis unavailable')}
          </h4>
          <p>
            {result.receipt_summary.currentness.current === true
              ? t('檢視當下來源相符。', 'Sources matched when inspected.')
              : result.receipt_summary.currentness.current === false
                ? t(
                    '歷史來源已非當期；仍保留原月份觀察。',
                    'Historical sources are no longer current; original monthly observations remain.',
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
          <dl className="path-monthly-summary">
            <div>
              <dt>{t('原回條整段報酬', 'Original full-period return')}</dt>
              <dd>{percent(original?.return_pct)}</dd>
            </div>
            <div>
              <dt>{t('月份串接整段報酬', 'Chained full-period return')}</dt>
              <dd>{percent(summary?.chained_return_pct)}</dd>
            </div>
            <div>
              <dt>{t('整段淨值變動', 'Full-period NAV change')}</dt>
              <dd>{numeric(summary?.nav_change)}</dd>
            </div>
            <div>
              <dt>{t('完整／部分月份數', 'Complete / partial months')}</dt>
              <dd>
                {numeric(summary?.complete_month_count, 0)} /{' '}
                {numeric(summary?.partial_month_count, 0)}
              </dd>
            </div>
          </dl>
          {summary && (
            <p>
              {summary.first_observed_date} → {summary.last_observed_date} ·{' '}
              {summary.valued_sessions}{' '}
              {t(
                '個保存估值日。月份報酬相乘串接，不能直接相加。',
                'saved valuation sessions. Monthly gross returns are chained by multiplication, not addition.',
              )}
            </p>
          )}
          {!!summary?.partial_month_count && (
            <p className="notice">
              {t(
                '部分月份仍有已知觀察報酬；標籤與交易日涵蓋不可省略。完整與否依該月歷史 XNYS 首末交易日判定。',
                'Partial months still have known observed returns; retain their labels and session coverage. Completeness uses the historical first and last XNYS sessions of that month.',
              )}
            </p>
          )}
          {analysis.years && <MonthlyGrid years={analysis.years} t={t} />}
          {!!analysis.months?.length && (
            <>
              <h4>{t('依時間排序的月份明細', 'Monthly details in chronological order')}</h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('月份／涵蓋', 'Month / coverage')}</th>
                      <th>{t('觀察期間', 'Observed interval')}</th>
                      <th>{t('接續邊界', 'Preceding boundary')}</th>
                      <th>{t('期末淨值', 'Ending NAV')}</th>
                      <th>{t('觀察報酬', 'Observed return')}</th>
                      <th>{t('淨值變動', 'NAV change')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.months.map((month) => (
                      <tr key={month.month}>
                        <th scope="row">
                          {month.month}
                          <br />
                          {month.status === 'partial'
                            ? t('部分月份', 'Partial month')
                            : t('完整月份', 'Complete month')}
                          <br />
                          {numeric(month.observed_sessions, 0)}/
                          {numeric(month.expected_sessions, 0)} {t('交易日', 'sessions')}
                          {!!month.reasons.length && (
                            <ul>
                              {month.reasons.map((code) => (
                                <li key={code}>{reason(code, t)}</li>
                              ))}
                            </ul>
                          )}
                        </th>
                        <td>
                          {month.observed_start} → {month.observed_end}
                          <br />
                          <span className="muted">
                            {t('完整月份', 'Complete month')}: {month.expected_first_session} →{' '}
                            {month.expected_last_session}
                          </span>
                        </td>
                        <td>
                          {month.boundary_date}
                          <br />
                          {numeric(month.boundary_nav)}
                          <br />
                          <span className="muted">
                            {month.boundary_kind === 'initial_cash'
                              ? t('期初現金', 'Initial cash')
                              : t('前一保存淨值', 'Preceding saved NAV')}
                          </span>
                        </td>
                        <td>{numeric(month.end_nav)}</td>
                        <td>{percent(month.return_pct)}</td>
                        <td>{numeric(month.nav_change)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <details>
            <summary>{t('核對基礎與計算口徑', 'Basis and calculation convention')}</summary>
            <p>
              {t(
                '每月報酬 =（月末保存淨值 ÷ 接續邊界淨值 − 1）× 100；淨值變動 = 月末保存淨值 − 接續邊界淨值。首月邊界是保存訊號日的期初現金，不計入該月估值日數。',
                'Monthly return = (ending saved NAV / preceding boundary NAV − 1) × 100. NAV change = ending saved NAV − boundary NAV. The first boundary is initial cash on the saved signal date and is not counted as a valued session.',
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
            {analysis.reconciliation && (
              <ul>
                {analysis.reconciliation.map((check) => (
                  <li key={check.code}>
                    {reconciliationLabel(check.code, t)}:{' '}
                    {check.within_tolerance
                      ? t('容差內', 'Within tolerance')
                      : t('不相符', 'Mismatch')}{' '}
                    · {t('差額', 'Difference')}: {numeric(check.difference, 10)}{' '}
                    {check.unit === 'percentage_points'
                      ? t('百分點', 'percentage points')
                      : t('淨值單位', 'NAV units')}
                  </li>
                ))}
              </ul>
            )}
            <p>
              {t('報酬絕對容差（百分點）', 'Absolute return tolerance (percentage points)')}:{' '}
              {result.tolerances.return_absolute_percentage_points} ·{' '}
              {t('淨值絕對容差', 'Absolute NAV tolerance')}: {result.tolerances.nav_absolute_units}{' '}
              · {t('相對容差', 'Relative tolerance')}: {result.tolerances.relative}
            </p>
            <p>
              <code>{result.engine_version}</code>
            </p>
          </details>
          <button type="button" onClick={download}>
            {t(
              '下載完整原回條與月報酬分析 JSON',
              'Download complete original receipt and monthly analysis JSON',
            )}
          </button>
          {csvExport?.content && (
            <button type="button" onClick={downloadCsv}>
              {t('下載已觀察月份 CSV', 'Download observed months CSV')}
            </button>
          )}
          {csvExport && (
            <p className="notice">
              {csvExport.invalid
                ? t(
                    'CSV 無法建立：必要欄位缺失、不可用或涵蓋不完整。完整原始 JSON 仍可檢閱。',
                    'CSV cannot be created: required fields are missing, unavailable or incomplete. The full original JSON remains available for inspection.',
                  )
                : t(
                    'CSV 只列已觀察月份，保留部分月份與涵蓋，不包含期間外空格。這是便於閱讀的副本；原始 JSON 才保留完整證據，CSV 不是簽章或標準化證據。',
                    'CSV includes observed months with partial-month labels and coverage, excluding outside-window placeholders. It is a readable convenience; original JSON retains the complete evidence. CSV is not signed or canonical evidence.',
                  )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
