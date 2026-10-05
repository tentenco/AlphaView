import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import {
  COMPARISON_DRAFT_KEY,
  comparisonChartData,
  defaultComparisonDraft,
  isComparisonDraft,
  parseComparisonDraft,
  type AccountComparison,
  type ComparisonError,
  type ComparisonPoint,
  type PaperAccountSummary,
  type PaperComparisonReport,
} from './paper-comparison'
import { useSessionState } from './session-state'
import { api, money, num } from './ui'
import './paper-comparison.css'

type Props = { accounts: PaperAccountSummary[]; locale: Locale }
type Translate = (zh: string, en: string) => string
const percent = (value: number | null) => (value == null ? '—' : `${num(value)}%`)
function statusLabel(status: ComparisonPoint['status'], t: Translate) {
  return {
    complete: t('完整觀測', 'Complete'),
    incomplete: t('已擷取，但缺價格', 'Captured, missing prices'),
    not_captured: t('未擷取', 'Not captured'),
    unsupported_method: t('方法版本不支援', 'Unsupported method'),
  }[status]
}
function validationLabel(error: ComparisonError, t: Translate) {
  return {
    count: t('請選擇 2 至 5 個模擬帳戶。', 'Select 2–5 paper accounts.'),
    unknown: t(
      '選取的帳戶已不在清單中，請重新選擇。',
      'A selected account is no longer available. Select accounts again.',
    ),
    dates: t('請輸入有效的固定起日與截止日。', 'Enter valid fixed start and end dates.'),
    order: t(
      '起日必須早於截止日，至少比較兩個交易日。',
      'The start must precede the end; compare at least two trading sessions.',
    ),
  }[error]
}
function requestError(message: string, t: Translate) {
  if (!/[\u3400-\u9fff]/.test(message)) return message
  return t(
    message,
    'Use completed XNYS trading sessions for both dates, with at most 1,260 sessions. Refresh the account list if a selected account is no longer available.',
  )
}

export function PortfolioAccountComparison({ accounts, locale }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(
    COMPARISON_DRAFT_KEY,
    defaultComparisonDraft,
    isComparisonDraft,
  )
  const [validation, setValidation] = useState<ComparisonError | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    source: string
    draft: string
    report: PaperComparisonReport
  } | null>(null)
  const request = useRef<AbortController | null>(null)
  const source = JSON.stringify(accounts.map((account) => [account.id, account.version]))
  const currentDraft = JSON.stringify(draft)
  const stale =
    !!result &&
    (result.source !== source ||
      result.report.accounts.some(
        (row) =>
          accounts.find((account) => account.id === row.account_id)?.version !==
          row.current_account_version,
      ))
  const report = result && !stale ? result.report : null
  const changed = !!result && result.draft !== currentDraft
  const unknownSelection = draft.accountIds.some(
    (id) => !accounts.some((account) => account.id === id),
  )
  useEffect(() => {
    setBusy(false)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [source])

  function toggleAccount(id: string, checked: boolean) {
    setDraft((value) => ({
      ...value,
      accountIds: checked
        ? [...value.accountIds, id]
        : value.accountIds.filter((item) => item !== id),
    }))
  }
  async function compare(event: FormEvent) {
    event.preventDefault()
    if (request.current) return
    const parsed = parseComparisonDraft(draft, accounts)
    setValidation(parsed.error)
    setError('')
    if (parsed.error) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const data = await api<PaperComparisonReport>('/api/paper/nav/compare', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(parsed.request),
      })
      if (!controller.signal.aborted) setResult({ source, draft: currentDraft, report: data })
    } catch (err) {
      if (!controller.signal.aborted) {
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className="paper-account-comparison">
      <section
        className="agent-panel"
        aria-label={t('帳戶比較設定', 'Account comparison settings')}
      >
        <div className="eyebrow">{t('帳戶比較', 'ACCOUNT COMPARISON')}</div>
        <h2>{t('在同一段時間，比較已保存的淨值', 'Compare captured NAV over the same period')}</h2>
        <p>
          {t(
            '選擇 2 至 5 個模擬帳戶與固定起訖交易日。每個帳戶使用相同日期；缺少觀測時保留空值，不改用各自不同的起點或截止日。',
            'Choose 2–5 paper accounts and fixed trading-session dates. Every account uses the same interval; missing observations stay empty instead of shifting the start or end.',
          )}
        </p>
        {accounts.length < 2 ? (
          <p className="notice">
            {t(
              '先建立至少兩個獨立模擬帳戶，再擷取各帳戶的淨值觀測，即可比較。',
              'Create at least two independent paper accounts, then capture NAV observations for each to begin comparing.',
            )}
          </p>
        ) : null}
        <form onSubmit={(event) => void compare(event)} noValidate>
          <fieldset className="comparison-account-picker">
            <legend>
              {t('選擇帳戶', 'Choose accounts')} <span>{draft.accountIds.length}/5</span>
            </legend>
            <div className="comparison-account-options">
              {accounts.map((account) => (
                <label key={account.id}>
                  <input
                    type="checkbox"
                    checked={draft.accountIds.includes(account.id)}
                    disabled={
                      !draft.accountIds.includes(account.id) && draft.accountIds.length >= 5
                    }
                    onChange={(event) => toggleAccount(account.id, event.target.checked)}
                  />
                  <span>{account.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {unknownSelection && (
            <p className="notice">
              {t('草稿含已移除的帳戶。', 'The draft includes a removed account.')}{' '}
              <button
                type="button"
                className="button"
                onClick={() =>
                  setDraft((value) => ({
                    ...value,
                    accountIds: value.accountIds.filter((id) =>
                      accounts.some((account) => account.id === id),
                    ),
                  }))
                }
              >
                {t('移除失效選項', 'Remove unavailable selections')}
              </button>
            </p>
          )}
          <div className="comparison-date-fields">
            <label className="agent-field">
              {t('固定起日', 'Fixed start date')}
              <input
                type="date"
                value={draft.start}
                onChange={(event) => setDraft((value) => ({ ...value, start: event.target.value }))}
              />
            </label>
            <label className="agent-field">
              {t('固定截止日', 'Fixed end date')}
              <input
                type="date"
                value={draft.end}
                onChange={(event) => setDraft((value) => ({ ...value, end: event.target.value }))}
              />
            </label>
          </div>
          <p>
            {t(
              '起訖都必須是已完成的 XNYS 交易日，最多 1,260 個交易日；週末或休市日會要求更正，不自動移動日期。',
              'Both endpoints must be completed XNYS sessions, up to 1,260 sessions. Weekend or holiday dates require correction and are never moved automatically.',
            )}
          </p>
          {validation && (
            <p role="alert" className="error-message">
              {validationLabel(validation, t)}
            </p>
          )}
          {error && (
            <p role="alert" className="error-message">
              {requestError(error, t)}
            </p>
          )}
          <div className="actions">
            <button className="button primary" type="submit" disabled={busy || accounts.length < 2}>
              {busy
                ? t('比較中…', 'Comparing…')
                : t('比較已保存的觀測', 'Compare captured observations')}
            </button>
            <span className="comparison-readonly">
              {t(
                '唯讀，不新增擷取或模擬成交。',
                'Read-only; no capture or simulated fill is created.',
              )}
            </span>
          </div>
        </form>
      </section>
      {stale && (
        <p className="notice" role="status">
          {t(
            '帳戶清單或版本已變更，請重新整理帳戶後再比較。草稿已保留。',
            'The account list or version changed. Refresh accounts and compare again; your draft is preserved.',
          )}
        </p>
      )}
      {report && (
        <section
          className="agent-panel"
          aria-label={t('帳戶比較結果', 'Account comparison results')}
        >
          <div className="comparison-result-heading">
            <div>
              <div className="eyebrow">{t('共同觀察區間', 'SHARED OBSERVATION PERIOD')}</div>
              <h2>
                {report.period.start} — {report.period.end}
              </h2>
            </div>
            <span>
              {report.period.session_count} {t('個交易日', 'sessions')}
            </span>
          </div>
          {changed && (
            <p className="notice">
              {t(
                '下方仍為上次送出的帳戶與日期；目前草稿尚未重新計算。',
                'These are the last submitted accounts and dates. The current draft has not been recalculated.',
              )}
            </p>
          )}
          {!report.comparable && (
            <p className="notice">
              {t(
                '至少一個帳戶在指定區間缺少完整觀測，跨帳戶差異暫不可用。起訖日期維持不變。',
                'At least one account lacks a complete observation window. Cross-account differences are unavailable; the requested dates stay unchanged.',
              )}
            </p>
          )}
          {report.accounts.some((account) => account.coverage.captured_sessions === 0) && (
            <p className="notice">
              {t('尚無擷取的帳戶', 'Accounts without captures')}:{' '}
              {report.accounts
                .filter((account) => account.coverage.captured_sessions === 0)
                .map((account) => account.name)
                .join(' · ')}
              .{' '}
              {t(
                '請逐一選擇帳戶，開啟「淨值與成本」並按「擷取目前紙上淨值」。從現在開始累積；不會補造過去淨值。',
                'Select each account, open “NAV & costs”, and choose “Capture current paper NAV”. Build observations from now; past NAV is never invented.',
              )}
            </p>
          )}
          {!report.common_start_complete ? (
            <p className="comparison-chart-empty">
              {t(
                '指定起日尚未有所有帳戶的完整淨值，無法建立共同基準 100。請查看下方缺口；不會改用較晚起點。',
                'Not every account has a complete NAV at the requested start, so a shared baseline of 100 is unavailable. Review the gaps below; the start is not moved later.',
              )}
            </p>
          ) : (
            <NormalizedChart report={report} t={t} />
          )}
          <div
            className="comparison-summary-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('同期間指標', 'Same-period metrics')}
          >
            <table className="comparison-summary-table">
              <thead>
                <tr>
                  <th>{t('指標', 'Metric')}</th>
                  {report.accounts.map((account) => (
                    <th key={account.account_id}>
                      {account.name}
                      <small>
                        {account.coverage.complete_sessions}/{account.coverage.expected_sessions}{' '}
                        {t('完整觀測', 'complete')}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  [t('起日淨值', 'Start NAV'), (row: AccountComparison) => money(row.start_equity)],
                  [t('截止日淨值', 'End NAV'), (row: AccountComparison) => money(row.end_equity)],
                  [
                    t('淨值變化', 'NAV change'),
                    (row: AccountComparison) => money(row.equity_change),
                  ],
                  [
                    t('區間報酬', 'Period return'),
                    (row: AccountComparison) => percent(row.return_pct),
                  ],
                  [
                    t('觀測最大回落', 'Observed maximum drawdown'),
                    (row: AccountComparison) => percent(row.max_drawdown_pct),
                  ],
                ].map(([label, format]) => (
                  <tr key={label as string}>
                    <th scope="row">{label as string}</th>
                    {report.accounts.map((account) => (
                      <td key={account.account_id}>
                        {(format as (row: AccountComparison) => string)(account)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {t(
              '區間報酬、淨值變化與最大回落需要整段每日觀測完整。不同本金的美元變化差，不能直接當成策略優劣。',
              'Period return, NAV change and maximum drawdown require a complete daily window. Dollar changes across different initial balances do not establish which strategy is better.',
            )}
          </p>
          {report.comparable && report.comparisons.length > 0 && (
            <div
              className="comparison-pairs"
              aria-label={t('同期間差異', 'Same-period differences')}
            >
              <h3>{t('差異：前者減後者', 'Differences: first minus second')}</h3>
              {report.comparisons.map((pair) => (
                <div key={`${pair.left_id}:${pair.right_id}`}>
                  <span>
                    {report.accounts.find((row) => row.account_id === pair.left_id)?.name} −{' '}
                    {report.accounts.find((row) => row.account_id === pair.right_id)?.name}
                  </span>
                  <strong>
                    {num(pair.return_difference_pp)} {t('百分點', 'pp')}
                  </strong>
                  <small>
                    {t('美元淨值變化差', 'USD NAV-change difference')}{' '}
                    {money(pair.equity_change_difference)}
                  </small>
                </div>
              ))}
            </div>
          )}
          {report.accounts.map((account) => (
            <AccountDetails key={account.account_id} account={account} t={t} />
          ))}
          <details className="agent-method">
            <summary>{t('比較口徑與限制', 'Comparison method and limitations')}</summary>
            <p>
              {t(
                report.method,
                'Only immutable captured NAV is compared over the exact requested XNYS interval. Each day uses its latest capture; gaps and unsupported methods remain empty. Baseline 100 requires a complete common starting observation. Interval statistics require complete daily data, and cross-account differences require every account to be comparable. Account order is preserved; there is no ranking.',
              )}
            </p>
            <p>
              {t(
                '這是虛擬帳戶的已保存觀測，不是回測、實際投資績效或未來報酬預測。不同帳戶可有不同成本與曝險。',
                'These are saved paper-account observations, not a backtest, actual investment returns or a forecast. Accounts may have different costs and exposures.',
              )}
            </p>
            <small>
              {report.engine_version} · {report.input_revision} ·{' '}
              {t('最新已完成交易日', 'Latest completed session')} {report.as_of}
            </small>
          </details>
        </section>
      )}
    </div>
  )
}

function AccountDetails({ account, t }: { account: AccountComparison; t: Translate }) {
  const [all, setAll] = useState(false)
  const rows = [...(all ? account.series : account.series.slice(-12))].reverse()
  return (
    <details className="comparison-account-detail">
      <summary>
        {account.name} · {account.coverage.complete_sessions}/{account.coverage.expected_sessions}{' '}
        {t('完整觀測', 'complete observations')}
      </summary>
      {!account.performance_available && (
        <p className="notice">
          {account.coverage.captured_sessions === 0
            ? t(
                '此期間尚無擷取。請在上方選擇此帳戶，開啟「淨值與成本」，按「擷取目前紙上淨值」；持續累積觀測後再比較。擷取從現在開始，不會補造過去淨值。',
                'No captures exist in this interval. Select this account above, open “NAV & costs”, then choose “Capture current paper NAV”. Build observations over time and compare again. Captures begin now; past NAV is never invented.',
              )
            : t(
                '指定區間含未擷取、缺價格或不支援方法的日期；區間統計保留空值。',
                'The selected interval contains uncaptured sessions, missing prices or unsupported methods. Period statistics remain unavailable.',
              )}
        </p>
      )}
      {account.coverage.missing_sessions.length > 0 && (
        <p>
          {t('缺口日期', 'Gap dates')}: {account.coverage.missing_sessions.slice(0, 12).join(' · ')}
          {account.coverage.missing_sessions.length > 12
            ? ` · +${account.coverage.missing_sessions.length - 12}`
            : ''}
        </p>
      )}
      <div
        className="comparison-summary-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${account.name} ${t('每日觀測', 'daily observations')}`}
      >
        <table>
          <thead>
            <tr>
              <th>{t('交易日', 'Session')}</th>
              <th>{t('淨值', 'NAV')}</th>
              <th>{t('基準 100', 'Baseline 100')}</th>
              <th>{t('狀態', 'Status')}</th>
              <th>{t('觀測來源', 'Observation source')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((point) => (
              <tr key={point.as_of}>
                <td>{point.as_of}</td>
                <td>{money(point.equity)}</td>
                <td>{num(point.normalized100)}</td>
                <td>
                  {statusLabel(point.status, t)}
                  {!!point.quote_coverage?.missing.length && (
                    <small>{point.quote_coverage.missing.join(' · ')}</small>
                  )}
                </td>
                <td>
                  {point.snapshot_id == null ? (
                    '—'
                  ) : (
                    <details>
                      <summary>#{point.snapshot_id}</summary>
                      <small>
                        {point.observed_at}
                        <br />
                        {t('帳戶版本', 'Account version')} {point.account_version}
                        <br />
                        {point.input_revision}
                        <br />
                        {point.paper_engine_version}
                        <br />
                        {point.analytics_engine_version}
                      </small>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {account.series.length > 12 && (
        <button type="button" className="button" onClick={() => setAll((value) => !value)}>
          {all
            ? t('只顯示最近 12 日', 'Show latest 12 sessions')
            : t(
                `顯示全部 ${account.series.length} 日`,
                `Show all ${account.series.length} sessions`,
              )}
        </button>
      )}
    </details>
  )
}

function NormalizedChart({ report, t }: { report: PaperComparisonReport; t: Translate }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(260, entry.contentRect.width))
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const data = comparisonChartData(report)
  if (!data.domain) return null
  const height = width < 420 ? 250 : 290
  const left = 48,
    right = width - 18,
    top = 24,
    bottom = height - 40
  const x = (index: number) =>
    left + (index / Math.max(1, report.period.session_count - 1)) * (right - left)
  const y = (value: number) =>
    bottom - ((value - data.domain![0]) / (data.domain![1] - data.domain![0])) * (bottom - top)
  const ticks = [data.domain[0], 100, data.domain[1]]
  return (
    <div className="comparison-normalized-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>
          {t('共同起日基準 100 淨值比較', 'NAV comparison with a shared baseline of 100')}
        </title>
        <desc id={`${id}-description`}>
          {t(
            '每個帳戶在相同起日設為 100。缺口不連線；逐日數值與來源列於下方帳戶明細。',
            'Each account starts at 100 on the same requested date. Gaps break lines; daily values and provenance are in the account details below.',
          )}
        </desc>
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={left}
              x2={right}
              y1={y(tick)}
              y2={y(tick)}
              className={tick === 100 ? 'comparison-baseline' : 'comparison-grid'}
            />
            <text x={left - 8} y={y(tick) + 4} textAnchor="end" className="comparison-axis">
              {num(tick, 1)}
            </text>
          </g>
        ))}
        {[0, report.period.session_count - 1].map((index) => (
          <text
            key={index}
            x={x(index)}
            y={bottom + 24}
            textAnchor={index === 0 ? 'start' : 'end'}
            className="comparison-axis"
          >
            {index === 0 ? report.period.start : report.period.end}
          </text>
        ))}
        {data.series.map((account, index) => (
          <g key={account.accountId} className={`comparison-series comparison-color-${index}`}>
            {account.segments.map((segment, part) => (
              <g key={part}>
                {segment.length > 1 && (
                  <polyline
                    data-comparison-segment={account.accountId}
                    points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')}
                  />
                )}
                {segment.map((point) => (
                  <circle
                    key={point.as_of}
                    cx={x(point.index)}
                    cy={y(point.value)}
                    r={report.period.session_count > 60 ? 2 : 3}
                  >
                    <title>
                      {account.name} · {point.as_of} · {num(point.value)}
                    </title>
                  </circle>
                ))}
              </g>
            ))}
          </g>
        ))}
      </svg>
      <div className="comparison-chart-legend">
        {data.series.map((account, index) => (
          <span key={account.accountId}>
            <i className={`comparison-color-${index}`} />
            {account.name}
            {account.gaps.length > 0 && (
              <small>
                {' '}
                · {account.gaps.length} {t('個缺口', 'gaps')}
              </small>
            )}
          </span>
        ))}
      </div>
      <p>
        {t(
          '所有帳戶起日 = 100；空缺日期不連線。將指標移到觀測點可查看日期與數值。',
          'Every account starts at 100; missing sessions break the line. Hover over a point for its date and value.',
        )}
      </p>
    </div>
  )
}
