import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { num } from './ui'
import {
  downloadPathAnalysisCsv,
  pathAnalysisCsvFilename,
  pathRollingCsv,
} from './path-analysis-csv'
import './workflow-path-rolling.css'

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
export type RollingWindow = {
  window_number: number
  horizon_sessions: number
  boundary_index: number
  start_index: number
  end_index: number
  boundary_date: string
  observed_start: string
  observed_end: string
  boundary_kind: 'initial_cash' | 'preceding_saved_nav'
  boundary_nav: number
  start_nav: number
  end_nav: number
  gross_return: number
  return_pct: number
  nav_change: number
}
type Horizon = {
  horizon_sessions: number
  expected_window_count: number
  window_count: number
  windows: RollingWindow[]
  lowest: { return_pct: number; window_numbers: number[] }
  highest: { return_pct: number; window_numbers: number[] }
}
export type PathRolling = {
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
    horizons: Horizon[] | null
    summary: {
      valued_sessions: number
      total_window_count: number
      initial_cash: number
      final_value: number
      direct_return_pct: number
      nav_change: number
      first_observed_date: string
      last_observed_date: string
      overlapping_windows: true
      independent_samples: false
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
const ENGINE = 'alphaview-workflow-path-rolling-v1'
const LIMIT_BYTES = 3 * 1024 * 1024
const PAGE_SIZE = 25
const HORIZONS = [21, 63, 126]
const hash = /^[a-f0-9]{64}$/
const day = /^\d{4}-\d{2}-\d{2}$/
const finite = (value: unknown): value is number =>
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
  if (code.startsWith('rolling_basis_'))
    return `${basisLabel(code.slice('rolling_basis_'.length), t)}: ${t('不可用或不完整', 'Unavailable or incomplete')}`
  return (
    {
      rolling_exact_session_count_required: t(
        '必須有完整 252 個保存估值交易日。',
        'Exactly 252 saved valuation sessions are required.',
      ),
      rolling_curve_values_unavailable: t(
        '保存淨值缺失、非有限值或非正值。',
        'Saved NAV is missing, nonfinite or nonpositive.',
      ),
      rolling_curve_dates_unavailable: t(
        '保存日期重複或未依時間排序。',
        'Saved dates are duplicated or not chronological.',
      ),
      rolling_historical_calendar_unavailable: t(
        '歷史交易日曆不可用。',
        'Historical session calendar is unavailable.',
      ),
      rolling_exact_historical_calendar_mismatch: t(
        '保存日期未完整符合歷史 XNYS 交易日曆。',
        'Saved dates do not match the complete historical XNYS calendar.',
      ),
      rolling_arithmetic_unavailable: t(
        '視窗運算無法得到有限正值比率。',
        'Window arithmetic cannot produce finite positive ratios.',
      ),
      rolling_saved_metrics_mismatch: t(
        '保存淨值與原整段指標不相符。',
        'Saved NAV does not reconcile with the original full-period metrics.',
      ),
      rolling_saved_final_nav_unavailable: t(
        '原回條期末淨值必須大於零。',
        'The original ending NAV must be positive.',
      ),
      rolling_sessions_not_completed: t(
        '保存路徑包含檢視當下尚未完成的交易日。',
        'The saved path includes sessions not completed when inspected.',
      ),
      rolling_account_changed: t(
        '帳戶版本已變更；請重新檢視。',
        'The account version changed; inspect again.',
      ),
      rolling_path_receipt_required: t(
        '只能選擇保存路徑回條。',
        'Select a saved path-validation receipt.',
      ),
      rolling_observation_session_changed: t(
        '檢視期間已完成交易日變更；請重試。',
        'The completed session changed while inspecting; retry.',
      ),
      rolling_export_size_limit: t(
        '完整回應超過 3 MiB；未截短。',
        'The complete response exceeds 3 MiB; it was not truncated.',
      ),
      comparison_receipt_scope_missing: t(
        '目前帳戶沒有這筆回條。',
        'This receipt is not in the current account.',
      ),
      comparison_receipt_unverifiable: t(
        '原回條無法驗證。',
        'The original receipt cannot be verified.',
      ),
      comparison_receipt_changed: t(
        '回條指紋已變更；請重新載入。',
        'The receipt fingerprint changed; reload the list.',
      ),
    }[code] ?? code
  )
}

function validAnalysis(value: PathRolling['analysis']) {
  if (
    !value ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every((code) => typeof code === 'string') ||
    !Array.isArray(value.basis_checks) ||
    !value.basis_checks.every(
      (check) => check && typeof check.code === 'string' && typeof check.available === 'boolean',
    ) ||
    (value.reconciliation !== null &&
      (!Array.isArray(value.reconciliation) ||
        !value.reconciliation.every(
          (check) =>
            check &&
            typeof check.code === 'string' &&
            typeof check.within_tolerance === 'boolean' &&
            finite(check.computed) &&
            finite(check.reference) &&
            (check.difference === null || finite(check.difference)) &&
            ['percentage_points', 'nav_units'].includes(check.unit),
        )))
  )
    return false
  if (value.status === 'unavailable')
    return value.reasons.length > 0 && value.horizons === null && value.summary === null
  if (
    value.status !== 'evaluated' ||
    value.reasons.length ||
    !value.basis_checks.length ||
    !value.basis_checks.every((check) => check.available) ||
    value.summary?.valued_sessions !== 252 ||
    value.summary.total_window_count !== 549 ||
    value.summary.overlapping_windows !== true ||
    value.summary.independent_samples !== false ||
    ![value.summary.initial_cash, value.summary.final_value].every(
      (nav) => finite(nav) && nav > 0,
    ) ||
    !finite(value.summary.direct_return_pct) ||
    !finite(value.summary.nav_change) ||
    !day.test(value.summary.first_observed_date) ||
    !day.test(value.summary.last_observed_date) ||
    !Array.isArray(value.horizons) ||
    value.horizons.length !== 3
  )
    return false
  return value.horizons.every((horizon, index) => {
    const length = HORIZONS[index],
      count = 253 - length
    if (
      !horizon ||
      horizon.horizon_sessions !== length ||
      horizon.expected_window_count !== count ||
      horizon.window_count !== count ||
      !Array.isArray(horizon.windows) ||
      horizon.windows.length !== count
    )
      return false
    if (
      !horizon.windows.every(
        (row, offset) =>
          row &&
          row.window_number === offset + 1 &&
          row.horizon_sessions === length &&
          row.boundary_index === offset &&
          row.start_index === offset + 1 &&
          row.end_index === offset + length &&
          day.test(row.boundary_date) &&
          day.test(row.observed_start) &&
          day.test(row.observed_end) &&
          row.boundary_date < row.observed_start &&
          row.observed_start <= row.observed_end &&
          row.boundary_kind === (offset === 0 ? 'initial_cash' : 'preceding_saved_nav') &&
          [row.boundary_nav, row.start_nav, row.end_nav, row.gross_return].every(
            (nav) => finite(nav) && nav > 0,
          ) &&
          finite(row.return_pct) &&
          finite(row.nav_change),
      )
    )
      return false
    return ['lowest', 'highest'].every((key) => {
      const extreme = horizon[key as 'lowest' | 'highest']
      if (
        !extreme ||
        !finite(extreme.return_pct) ||
        !Array.isArray(extreme.window_numbers) ||
        !extreme.window_numbers.length
      )
        return false
      const expected = horizon.windows
        .filter((row) => row.return_pct === extreme.return_pct)
        .map((row) => row.window_number)
      return (
        JSON.stringify(expected) === JSON.stringify(extreme.window_numbers) &&
        horizon.windows.every((row) =>
          key === 'lowest'
            ? row.return_pct >= extreme.return_pct
            : row.return_pct <= extreme.return_pct,
        )
      )
    })
  })
}

function HorizonDetails({ value, t }: { value: Horizon; t: Translate }) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState<'all' | 'lowest' | 'highest'>('all')
  const [page, setPage] = useState(0)
  const rows =
    filter === 'all'
      ? value.windows
      : value.windows.filter((row) => value[filter].window_numbers.includes(row.window_number))
  const pageCount = Math.ceil(rows.length / PAGE_SIZE)
  const start = page * PAGE_SIZE
  const shown = rows.slice(start, start + PAGE_SIZE)
  function show(next: typeof filter) {
    setFilter(next)
    setPage(0)
    setExpanded(true)
  }
  return (
    <section
      className="path-rolling-horizon"
      aria-label={`${value.horizon_sessions} ${t('交易日視窗', 'session windows')}`}
    >
      <h4>
        {value.horizon_sessions} {t('個交易日', 'sessions')}
      </h4>
      <p>
        {t('完整視窗', 'Complete windows')}: {value.window_count} / {value.expected_window_count}
      </p>
      <p className="muted">
        {t('首個視窗邊界', 'First window boundary')}: {value.windows[0].boundary_date} ·{' '}
        {numeric(value.windows[0].boundary_nav)} · {t('期初現金', 'Initial cash')}
      </p>
      <dl className="path-rolling-extremes">
        <div>
          <dt>{t('最低總報酬', 'Lowest total return')}</dt>
          <dd>{percent(value.lowest.return_pct)}</dd>
          <dd>
            {value.lowest.window_numbers.length} {t('個並列視窗', 'tied windows')}
          </dd>
        </div>
        <div>
          <dt>{t('最高總報酬', 'Highest total return')}</dt>
          <dd>{percent(value.highest.return_pct)}</dd>
          <dd>
            {value.highest.window_numbers.length} {t('個並列視窗', 'tied windows')}
          </dd>
        </div>
      </dl>
      <div className="actions">
        <button
          type="button"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => (expanded ? setExpanded(false) : show('all'))}
        >
          {expanded
            ? t('收合視窗明細', 'Hide window details')
            : t('展開全部視窗明細', 'Show all window details')}
        </button>
        <button type="button" aria-controls={id} onClick={() => show('lowest')}>
          {t('檢視全部最低並列', 'Inspect all lowest ties')}
        </button>
        <button type="button" aria-controls={id} onClick={() => show('highest')}>
          {t('檢視全部最高並列', 'Inspect all highest ties')}
        </button>
      </div>
      <div id={id}>
        {expanded && (
          <div className="path-rolling-details">
            <label>
              {t('明細範圍', 'Detail set')}
              <select
                value={filter}
                onChange={(event) => show(event.target.value as typeof filter)}
              >
                <option value="all">{t('全部視窗', 'All windows')}</option>
                <option value="lowest">{t('全部最低並列', 'All lowest ties')}</option>
                <option value="highest">{t('全部最高並列', 'All highest ties')}</option>
              </select>
            </label>
            <p aria-live="polite">
              {t('顯示', 'Showing')} {start + 1}–{Math.min(start + PAGE_SIZE, rows.length)} /{' '}
              {rows.length} ·{' '}
              {t('依時間排序，每頁最多 25 筆。', 'Chronological order, at most 25 per page.')}
            </p>
            <div className="table-scroll">
              <table>
                <caption>
                  {value.horizon_sessions} {t('交易日視窗明細', 'session window details')}
                </caption>
                <thead>
                  <tr>
                    <th>{t('視窗', 'Window')}</th>
                    <th>{t('觀察期間', 'Observed interval')}</th>
                    <th>{t('前期邊界', 'Preceding boundary')}</th>
                    <th>{t('期末淨值', 'Ending NAV')}</th>
                    <th>{t('總報酬', 'Total return')}</th>
                    <th>{t('淨值變動', 'NAV change')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.window_number}>
                      <th scope="row">{row.window_number}</th>
                      <td>
                        {row.observed_start} → {row.observed_end}
                      </td>
                      <td>
                        {row.boundary_date}
                        <br />
                        {numeric(row.boundary_nav)}
                        <br />
                        <span className="muted">
                          {row.boundary_kind === 'initial_cash'
                            ? t('期初現金', 'Initial cash')
                            : t('前一保存淨值', 'Preceding saved NAV')}
                        </span>
                      </td>
                      <td>{numeric(row.end_nav)}</td>
                      <td>{percent(row.return_pct)}</td>
                      <td>{numeric(row.nav_change)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="actions"
              role="group"
              aria-label={t('視窗明細分頁', 'Window detail pagination')}
            >
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((old) => Math.max(0, old - 1))}
              >
                {t('上一頁', 'Previous page')}
              </button>
              <span>
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((old) => Math.min(pageCount - 1, old + 1))}
              >
                {t('下一頁', 'Next page')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function WorkflowPathRolling({
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
    result?: PathRolling
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
      return { content: pathRollingCsv(result), invalid: false }
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
      throw new Error(reason('rolling_export_size_limit', t))
    const value = JSON.parse(raw, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new Error(
          t(
            '回應含非有限數值；未接受證據。',
            'The response contains nonfinite numbers; evidence was not accepted.',
          ),
        )
      return item
    })
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
        await fetch(`${base}?kind=path_validation&limit=50`, { signal, cache: 'no-store' }),
      )
      if (
        value.account_id !== accountId ||
        value.kind !== 'path_validation' ||
        !Array.isArray(value.items) ||
        value.items.some(
          (item: Receipt) =>
            !item ||
            item.kind !== 'path_validation' ||
            typeof item.id !== 'string' ||
            typeof item.content_fingerprint !== 'string' ||
            typeof item.created_at !== 'string' ||
            typeof item.run_id !== 'string' ||
            typeof item.integrity?.available !== 'boolean',
        )
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
        await fetch(`${base}/rolling`, {
          method: 'POST',
          signal,
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      )
      if (
        value.engine_version !== ENGINE ||
        value.account_id !== accountId ||
        value.account_version !== accountVersion ||
        Object.entries(request).some(([key, item]) => value.request?.[key] !== item) ||
        value.receipt_summary?.id !== selected.id ||
        value.receipt_summary?.content_fingerprint !== selected.content_fingerprint ||
        value.receipt_summary?.integrity?.available !== true ||
        !value.receipt_summary?.currentness ||
        value.original_receipt?.receipt_id !== selected.id ||
        !value.original_receipt?.evidence ||
        value.execution_authority !== false ||
        !validAnalysis(value.analysis)
      )
        throw new Error(
          t(
            '滾動視窗回應與所選回條不相符或不完整。',
            'Rolling-window response does not match the selected receipt or is incomplete.',
          ),
        )
      return { result: value, raw }
    })
  }
  function download() {
    if (!result || !current?.raw || latest.current !== identity || pending.current) return
    const object = URL.createObjectURL(new Blob([current.raw], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = object
    link.download = `alphaview-path-rolling-${result.request.receipt_id.slice(0, 12)}.json`
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
      pathAnalysisCsvFilename('rolling', result.request.receipt_id),
    )
  }
  const analysis = result?.analysis
  const summary = analysis?.summary
  return (
    <section
      className="workflow-path-rolling"
      aria-label={t('保存路徑滾動視窗', 'Saved path rolling windows')}
    >
      <h3>{t('保存路徑滾動視窗', 'Saved path rolling windows')}</h3>
      <p>
        {t(
          '檢視一筆完整 252 交易日原回條的固定 21、63、126 交易日視窗。每個視窗從首個估值日的前一期淨值計算；第一個視窗使用期初現金。',
          'Inspect fixed 21, 63 and 126-session windows in one complete 252-session original receipt. Each window uses the NAV preceding its first valuation session; the first window uses initial cash.',
        )}
      </p>
      <p className="notice">
        {t(
          '視窗彼此重疊，只描述單一歷史路徑，不能當成獨立樣本、預測或統計信心。最低與最高只是機械式摘要；保留全部並列，不挑選配置、不判定通過、不年化，也不另調成本或授權交易。',
          'Windows overlap and describe one historical path, not independent samples, forecasts or statistical confidence. Lowest and highest are mechanical summaries with all ties retained. They do not choose allocations, determine a pass, annualize, adjust costs or authorize trading.',
        )}
      </p>
      <button type="button" disabled={!accountId || !!busy} onClick={load}>
        {busy
          ? t('讀取中…', 'Reading…')
          : t('載入滾動視窗來源回條', 'Load rolling-window receipts')}
      </button>
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
          <label className="path-rolling-selector">
            {t('滾動視窗來源回條', 'Rolling-window source receipt')}
            <select
              value={current.selected ?? ''}
              disabled={!!busy}
              onChange={(event) => {
                if (pending.current) return
                setState((old) => ({
                  ...old,
                  selected: event.target.value,
                  result: undefined,
                  raw: undefined,
                  error: undefined,
                }))
              }}
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
            {t('檢視保存滾動視窗', 'Inspect saved rolling windows')}
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
              ? t('完整滾動視窗已核對', 'Complete rolling windows verified')
              : t('滾動視窗分析不可用', 'Rolling-window analysis unavailable')}
          </h4>
          <p>
            {result.receipt_summary.currentness.current === true
              ? t('檢視當下來源相符。', 'Sources matched when inspected.')
              : result.receipt_summary.currentness.current === false
                ? t(
                    '歷史來源已非當期；仍保留原滾動視窗。',
                    'Historical sources are no longer current; original rolling windows remain.',
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
          <dl className="path-rolling-summary">
            <div>
              <dt>{t('原回條整段報酬', 'Original full-period return')}</dt>
              <dd>{percent(result.original_receipt.evidence.metrics?.return_pct)}</dd>
            </div>
            <div>
              <dt>{t('淨值核對整段報酬', 'NAV-verified full-period return')}</dt>
              <dd>{percent(summary?.direct_return_pct)}</dd>
            </div>
            <div>
              <dt>{t('保存估值交易日', 'Saved valuation sessions')}</dt>
              <dd>{numeric(summary?.valued_sessions, 0)} / 252</dd>
            </div>
            <div>
              <dt>{t('完整視窗總數', 'Complete window count')}</dt>
              <dd>{numeric(summary?.total_window_count, 0)} / 549</dd>
            </div>
          </dl>
          {summary && (
            <p>
              {summary.first_observed_date} → {summary.last_observed_date} ·{' '}
              {t(
                '全部視窗逐日起點相差一個交易日；不是獨立觀察次數。',
                'Consecutive window starts differ by one session; these are not counts of independent observations.',
              )}
            </p>
          )}
          {analysis.horizons?.map((horizon) => (
            <HorizonDetails key={horizon.horizon_sessions} value={horizon} t={t} />
          ))}
          <details>
            <summary>{t('核對基礎與計算口徑', 'Basis and calculation convention')}</summary>
            <p>
              {t(
                '總報酬 =（期末保存淨值 ÷ 前期邊界淨值 − 1）× 100；淨值變動 = 期末保存淨值 − 前期邊界淨值。起點是首個估值交易日，分母是它前一個交易日的保存淨值。並列依未四捨五入的計算報酬完全相等判定，並保留時間順序。',
                'Total return = (ending saved NAV / preceding boundary NAV − 1) × 100. NAV change = ending saved NAV − boundary NAV. The start is the first valuation session; its preceding saved NAV is the denominator. Ties require exact equality of computed returns before display rounding, with chronological order retained.',
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
                    {check.code === 'final_nav_matches_saved'
                      ? t('期末淨值與原值核對', 'Ending NAV against original')
                      : t('整段報酬與原值核對', 'Full-period return against original')}
                    :{' '}
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
              {result.tolerances?.return_absolute_percentage_points} ·{' '}
              {t('淨值絕對容差', 'Absolute NAV tolerance')}: {result.tolerances?.nav_absolute_units}{' '}
              · {t('相對容差', 'Relative tolerance')}: {result.tolerances?.relative}
            </p>
            <p>
              <code>{result.engine_version}</code>
            </p>
          </details>
          <button type="button" onClick={download}>
            {t(
              '下載完整原回條與滾動視窗 JSON',
              'Download complete original receipt and rolling windows JSON',
            )}
          </button>
          {csvExport?.content && (
            <button type="button" onClick={downloadCsv}>
              {t('下載全部期間與視窗 CSV', 'Download all horizons and windows CSV')}
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
                    'CSV 包含全部期間的完整視窗，不受明細篩選或分頁影響。這是便於閱讀的副本；原始 JSON 才保留完整證據，CSV 不是簽章或標準化證據，重疊視窗不是獨立樣本。',
                    'CSV includes complete windows for every horizon, regardless of detail filters or pages. It is a readable convenience; original JSON retains the complete evidence. CSV is not signed or canonical evidence, and overlapping windows are not independent samples.',
                  )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
