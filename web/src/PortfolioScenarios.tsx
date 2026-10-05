import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { PaperSnapshot } from './paper-model'
import {
  defaultScenarioDraft,
  isScenarioDraft,
  parseScenarioDraft,
  scenarioDraftKey,
  type ScenarioCase,
  type ScenarioDraft,
  type ScenarioError,
  type ScenarioReport,
} from './paper-scenarios'
import { useSessionState } from './session-state'
import { api, money, num } from './ui'
import './paper-scenarios.css'

type Props = { snapshot: PaperSnapshot; locale: Locale }
type Translate = (zh: string, en: string) => string
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value)}%`)
const statusLabel = (status: ScenarioCase['status'], t: Translate) =>
  ({
    available: t('可比較', 'Available'),
    blocked: t('方案受阻', 'Plan blocked'),
    unavailable: t('缺價，無法估值', 'Missing prices'),
  })[status]
const caseName = (row: ScenarioCase, t: Translate) =>
  row.kind === 'current' ? t('目前帳戶', 'Current account') : row.name

function draftError(error: ScenarioError, t: Translate) {
  const labels: Record<ScenarioError['code'], string> = {
    shock: t('全體漲跌幅需為 −99 至 200 之間的數字。', 'Enter a global shock between −99 and 200.'),
    override_format: t(
      '個股情境每行輸入「代碼 漲跌幅」，介於 −99 至 200；最多 100 筆。',
      'Enter one SYMBOL SHOCK per line, between −99 and 200; at most 100 rows.',
    ),
    override_duplicate: t('個股情境代碼不可重複。', 'Symbol overrides must be unique.'),
    override_unused: t(
      '個股情境必須用於目前持倉或至少一個方案的正權重目標。',
      'Each override must appear in current holdings or a positive-weight plan target.',
    ),
    plan_count: t('最多比較五個方案。', 'Compare at most five plans.'),
    name: t('方案名稱需為 1 至 60 字元。', 'Use a plan name of 1–60 characters.'),
    name_duplicate: t('方案名稱不可重複。', 'Plan names must be unique.'),
    targets_empty: t(
      '請輸入完整目標，或明確勾選全現金方案。',
      'Enter full targets or explicitly select an all-cash plan.',
    ),
    targets_format: t(
      '目標每行輸入「代碼 權重」，權重介於 0 至 100；最多 50 筆。',
      'Enter one SYMBOL WEIGHT per line, with weight between 0 and 100; at most 50 rows.',
    ),
    targets_duplicate: t(
      '同一方案的目標代碼不可重複。',
      'Target symbols within a plan must be unique.',
    ),
    targets_sum: t('目標權重總和不可超過 100%。', 'Target weights cannot sum to more than 100%.'),
  }
  return `${error.plan ? `${t('方案', 'Plan')} ${error.plan}: ` : ''}${labels[error.code]}${error.symbol ? ` (${error.symbol})` : ''}`
}

function breachLabel(issue: ScenarioCase['policy_breaches'][number], t: Translate) {
  const english: Record<string, string> = {
    quote_unavailable: 'A required fresh USD closing price is unavailable.',
    kill_switch: 'Paper simulation is paused for this account.',
    max_position_weight: 'A requested position exceeds the account concentration limit.',
    post_policy_max_position_weight:
      'A position exceeds the concentration limit after costs and rounding.',
    base_max_position_weight: 'A position exceeds the concentration limit before the shock.',
    stressed_max_position_weight: 'A position exceeds the concentration limit after the shock.',
    min_cash_weight: 'Cash falls below the account minimum after the proposed trades.',
    base_min_cash_weight: 'Cash weight is below the account minimum before the shock.',
    stressed_min_cash_weight: 'Cash weight is below the account minimum after the shock.',
    max_turnover: 'The proposed trades exceed the account turnover limit.',
    insufficient_cash: 'Available cash cannot fund the proposed trades and costs.',
    nonpositive_equity: 'The account does not have positive equity.',
    holding_limit: 'The projected number of positions exceeds the account limit.',
  }
  return `${issue.symbol ? `${issue.symbol}: ` : ''}${t(issue.message, english[issue.code] || `Account policy check: ${issue.code}`)}`
}

export function PortfolioScenarios(props: Props) {
  return <ScenarioAccount key={props.snapshot.account.id} {...props} />
}

function ScenarioAccount({ snapshot, locale }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const fieldId = useId()
  const [draft, setDraft] = useSessionState(
    scenarioDraftKey(snapshot.account.id),
    defaultScenarioDraft,
    isScenarioDraft,
  )
  const [validation, setValidation] = useState<ScenarioError | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    source: string
    draft: string
    report: ScenarioReport
  } | null>(null)
  const request = useRef<AbortController | null>(null)
  const source = JSON.stringify([
    snapshot.account.id,
    snapshot.account.version,
    snapshot.input_revision,
    snapshot.as_of,
  ])
  const currentDraft = JSON.stringify(draft)
  const stale =
    !!result &&
    (result.source !== source ||
      result.report.account_version !== snapshot.account.version ||
      result.report.input_revision !== snapshot.input_revision ||
      result.report.as_of !== snapshot.as_of)
  const report = result && !stale ? result.report : null
  const changed = !!result && result.draft !== currentDraft

  useEffect(() => {
    setBusy(false)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [source])

  function updatePlan(id: string, values: Partial<ScenarioDraft['plans'][number]>) {
    setDraft((value) => ({
      ...value,
      plans: value.plans.map((plan) => (plan.id === id ? { ...plan, ...values } : plan)),
    }))
  }
  function addPlan() {
    if (draft.plans.length >= 5) return
    let next = 1
    while (draft.plans.some((plan) => plan.name === `P${next}`)) next++
    setDraft((value) => ({
      ...value,
      plans: [
        ...value.plans,
        { id: crypto.randomUUID(), name: `P${next}`, targets: '', allCash: false },
      ],
    }))
  }
  async function calculate(event: FormEvent) {
    event.preventDefault()
    if (request.current) return
    const parsed = parseScenarioDraft(
      draft,
      snapshot.account.version,
      snapshot.holdings.map((row) => row.symbol),
    )
    setValidation(parsed.error)
    setError('')
    if (parsed.error) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const data = await api<ScenarioReport>(
        `/api/paper/accounts/${encodeURIComponent(snapshot.account.id)}/scenarios/compare`,
        { method: 'POST', signal: controller.signal, body: JSON.stringify(parsed.request) },
      )
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
    <div className="paper-scenarios">
      <section className="agent-panel" aria-label={t('情境假設', 'Scenario assumptions')}>
        <div className="eyebrow">{t('情境比較', 'SCENARIO COMPARISON')}</div>
        <h2>{t('比較目前配置與候選方案', 'Compare current holdings with candidate plans')}</h2>
        <p>
          {t(
            '自行指定一次性的價格變動，查看現金、集中度與成本如何影響各配置。這是使用者設定的假設，不是報酬預測或發生機率。',
            'Specify a one-time price change to compare cash, concentration and costs across allocations. These are user-defined assumptions, not forecasts or probabilities.',
          )}
        </p>
        <div className="agent-method">
          {t(
            '本機唯讀試算；所有方案共用同一次行情快照。計算不保存提案或執行交易。',
            'Read-only local calculation; every case uses one market snapshot. Calculating does not save proposals or execute trades.',
          )}
        </div>
        <form onSubmit={calculate}>
          <div className="agent-form-grid">
            <label className="agent-field">
              <span>{t('全體價格漲跌幅 (%)', 'Global price shock (%)')}</span>
              <input
                type="number"
                aria-label={t('全體價格漲跌幅 (%)', 'Global price shock (%)')}
                aria-describedby={`${fieldId}-global-help`}
                min="-99"
                max="200"
                step="any"
                required
                value={draft.globalShock}
                onChange={(event) => setDraft({ ...draft, globalShock: event.target.value })}
              />
              <small id={`${fieldId}-global-help`}>
                {t(
                  '−10 代表所有未覆寫標的下跌 10%。',
                  '−10 means a 10% fall for every symbol without an override.',
                )}
              </small>
            </label>
            <label className="agent-field">
              <span>{t('個股覆寫（選填）', 'Symbol overrides (optional)')}</span>
              <textarea
                aria-label={t('個股覆寫（選填）', 'Symbol overrides (optional)')}
                aria-describedby={`${fieldId}-overrides-help`}
                rows={3}
                maxLength={6000}
                placeholder={'SYNTA -20\nSYNTB 5'}
                value={draft.symbolShocks}
                onChange={(event) => setDraft({ ...draft, symbolShocks: event.target.value })}
              />
              <small id={`${fieldId}-overrides-help`}>
                {t(
                  '每行「代碼 漲跌幅」。個股值取代全體值，不相加。',
                  'One SYMBOL SHOCK per line. Overrides replace the global shock; they are not added.',
                )}
              </small>
            </label>
          </div>
          <div className="scenario-presets" aria-label={t('全體情境快捷', 'Global shock presets')}>
            <span>{t('套用假設', 'Use assumption')}</span>
            {[-10, -20, 10].map((shock) => (
              <button
                className="button"
                type="button"
                key={shock}
                onClick={() => setDraft({ ...draft, globalShock: String(shock) })}
              >
                {shock > 0 ? '+' : ''}
                {shock}%
              </button>
            ))}
            <small>{t('套用後仍需按計算。', 'Press Calculate after selecting a preset.')}</small>
          </div>
          <div className="scenario-plans-heading">
            <h3>
              {t('完整目標方案', 'Full target plans')} <span>{draft.plans.length}/5</span>
            </h3>
            <button
              className="button"
              type="button"
              onClick={addPlan}
              disabled={draft.plans.length >= 5}
            >
              {t('新增方案', 'Add plan')}
            </button>
          </div>
          <p className="scenario-scope">
            {t(
              '每個方案表示完整組合：未列出的既有持倉目標為零，未配置比例保留現金。費用、股數精度與最低交易額沿用帳戶設定；被跳過的交易會保留原持倉。可移除全部方案，只評估目前帳戶。',
              'Each plan describes the entire portfolio: omitted holdings have a zero target and unallocated weight stays in cash. Account fees, share precision and minimum trade size apply; skipped trades retain existing holdings. Remove every plan to evaluate only the current account.',
            )}
          </p>
          <div className="scenario-plan-editors">
            {draft.plans.map((plan, index) => (
              <fieldset className="scenario-plan-editor" key={plan.id}>
                <legend>
                  {t('方案', 'Plan')} {index + 1}
                </legend>
                <label className="agent-field">
                  <span>
                    {t('方案名稱', 'Plan name')} {index + 1}
                  </span>
                  <input
                    value={plan.name}
                    maxLength={60}
                    required
                    onChange={(event) => updatePlan(plan.id, { name: event.target.value })}
                  />
                </label>
                <label className="agent-field">
                  <span>
                    {t('完整目標 (%)', 'Full targets (%)')} {index + 1}
                  </span>
                  <textarea
                    rows={4}
                    maxLength={6000}
                    placeholder={'SYNTA 20\nSYNTB 25'}
                    value={plan.targets}
                    disabled={plan.allCash}
                    onChange={(event) => updatePlan(plan.id, { targets: event.target.value })}
                  />
                </label>
                <label className="scenario-cash-choice">
                  <input
                    type="checkbox"
                    checked={plan.allCash}
                    onChange={(event) => updatePlan(plan.id, { allCash: event.target.checked })}
                  />
                  <span>
                    {t('全現金方案', 'All-cash plan')} {index + 1}
                  </span>
                </label>
                {plan.allCash && (
                  <p className="scenario-scope">
                    {t(
                      '將全部持倉目標設為零；仍計入賣出成本與帳戶限制。',
                      'Sets every holding target to zero; selling costs and account limits still apply.',
                    )}
                  </p>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    setDraft({ ...draft, plans: draft.plans.filter((row) => row.id !== plan.id) })
                  }
                >
                  {t('移除方案', 'Remove plan')} {index + 1}
                </button>
              </fieldset>
            ))}
          </div>
          {validation && (
            <p className="error-message" role="alert">
              {draftError(validation, t)}
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {t(
                error,
                /[\u3400-\u9fff]/.test(error)
                  ? 'Calculation could not complete. Refresh the paper account to use the latest version and market inputs, then retry.'
                  : error,
              )}
            </p>
          )}
          <div className="actions scenario-submit">
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? t('計算中…', 'Calculating…') : t('計算情境比較', 'Calculate comparison')}
            </button>
            <span>{t('草稿保留於本分頁。', 'Drafts stay in this browser tab.')}</span>
          </div>
        </form>
      </section>
      {stale && (
        <p className="notice" role="status">
          {t(
            '帳戶或行情來源已改變，舊結果已隱藏。請重新整理帳戶，再計算同一來源的比較。草稿仍保留。',
            'The account or market source changed, so the old results are hidden. Refresh the paper account, then calculate a comparison from one source. Your draft is preserved.',
          )}
        </p>
      )}
      {report && (
        <section
          className="agent-panel"
          aria-label={t('情境比較結果', 'Scenario comparison results')}
        >
          <h2>{t('同一快照的比較結果', 'Comparison from one snapshot')}</h2>
          {changed && (
            <p className="notice" role="status">
              {t(
                '草稿已修改。以下仍為上次送出的情境，按計算才會更新。',
                'The draft has changed. These are the last submitted assumptions; calculate again to update the results.',
              )}
            </p>
          )}
          <p className="scenario-result-scope">
            {t('全體假設', 'Global assumption')}:{' '}
            <strong>{percent(report.shock.global_shock_pct)}</strong>
            {' · '}
            {t('個股覆寫', 'Overrides')}:{' '}
            {report.shock.symbol_shocks.length
              ? report.shock.symbol_shocks
                  .map((row) => `${row.symbol} ${percent(row.shock_pct)}`)
                  .join(' / ')
              : t('無', 'None')}
            {' · '}
            {t('參考收盤日', 'Reference close')}: {report.as_of}
          </p>
          <ScenarioComparison report={report} t={t} />
          <p className="scenario-scope">
            {t(
              '震盪損益＝情境淨值 − 扣成本後淨值；含成本總變動＝情境淨值 − 目前帳戶淨值。零表示算得零，— 表示無法計算。',
              'Shock P/L = stressed equity − post-cost equity. Total change including costs = stressed equity − current equity. Zero is a calculated zero; — means unavailable.',
            )}
          </p>
          <div className="scenario-case-details">
            {[report.current, ...report.plans].map((row, index) => (
              <CaseDetails key={`${index}:${row.name}`} row={row} t={t} />
            ))}
          </div>
          <details className="agent-method">
            <summary>{t('方法、範圍與來源版本', 'Method, scope and source versions')}</summary>
            <p>
              {t(
                report.method,
                'Apply the user-defined shock once to fresh, locally stored USD closing prices. Plan holdings first pass through the current paper execution policy, including costs, precision and skipped trades. Cash is unchanged by the price shock. Missing required prices remain unavailable; weights are never redistributed.',
              )}
            </p>
            <p>
              {t(
                '集中度與現金門檻同時檢查震盪前後權重。震盪後超限是情境結果，不會改寫帳戶。此計算不模擬價格路徑、流動性、稅、股息、拆併股或融資。',
                'Concentration and cash limits are checked before and after the shock. A post-shock breach is a scenario result and does not change the account. This calculation does not model price paths, liquidity, tax, dividends, corporate actions or financing.',
              )}
            </p>
            <p>
              {t('單股上限', 'Position limit')}: {percent(report.limits.max_position_weight_pct)} ·{' '}
              {t('現金下限', 'Cash minimum')}: {percent(report.limits.min_cash_weight_pct)} ·{' '}
              {t('換手上限', 'Turnover limit')}: {percent(report.limits.max_turnover_pct)}
            </p>
            <p>
              {report.engine_version} · {report.paper_engine_version}
              <br />
              {t('帳戶版本', 'Account version')}: {report.account_version} ·{' '}
              {t('輸入版本', 'Input revision')}: {report.input_revision}
            </p>
          </details>
        </section>
      )}
    </div>
  )
}

function ScenarioComparison({ report, t }: { report: ScenarioReport; t: Translate }) {
  const cases = [report.current, ...report.plans]
  const metrics: { label: string; value: (row: ScenarioCase) => string }[] = [
    { label: t('目前帳戶淨值', 'Current equity'), value: (r) => money(r.base_equity) },
    { label: t('執行成本合計', 'Execution costs'), value: (r) => money(r.cost_total) },
    { label: t('其中：費用', 'Of which: fees'), value: (r) => money(r.fees_total) },
    { label: t('其中：滑價', 'Of which: slippage'), value: (r) => money(r.slippage_total) },
    { label: t('扣成本後淨值', 'Post-cost equity'), value: (r) => money(r.posttrade_equity) },
    { label: t('情境淨值', 'Stressed equity'), value: (r) => money(r.stressed_equity) },
    { label: t('震盪損益', 'Shock P/L'), value: (r) => money(r.shock_pnl) },
    { label: t('震盪報酬', 'Shock return'), value: (r) => percent(r.shock_return_pct) },
    { label: t('含成本總變動', 'Total change incl. costs'), value: (r) => money(r.total_pnl) },
    {
      label: t('含成本總變動率', 'Total return incl. costs'),
      value: (r) => percent(r.total_return_pct),
    },
    { label: t('現金', 'Cash'), value: (r) => money(r.cash) },
    {
      label: t('震盪前現金比例', 'Cash weight before shock'),
      value: (r) => percent(r.cash_weight_pct),
    },
    {
      label: t('震盪後現金比例', 'Cash weight after shock'),
      value: (r) => percent(r.stressed_cash_weight_pct),
    },
    {
      label: t('震盪前最大部位', 'Largest weight before shock'),
      value: (r) => percent(r.largest_weight_pct),
    },
    {
      label: t('震盪後最大部位', 'Largest weight after shock'),
      value: (r) => percent(r.stressed_largest_weight_pct),
    },
  ]
  return (
    <div
      className="table-scroll scenario-comparison-scroll"
      tabIndex={0}
      aria-label={t('情境指標比較表', 'Scenario metrics comparison')}
    >
      <table className="scenario-comparison-table">
        <thead>
          <tr>
            <th scope="col">{t('指標', 'Metric')}</th>
            {cases.map((row, index) => (
              <th scope="col" key={index}>
                {caseName(row, t)}
                <small className={row.status !== 'available' ? 'scenario-unavailable' : ''}>
                  {statusLabel(row.status, t)}
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{t('報價覆蓋', 'Price coverage')}</th>
            {cases.map((row, index) => (
              <td key={index}>
                {row.coverage.required === 0
                  ? t('無報價需求', 'No quotes needed')
                  : `${row.coverage.priced}/${row.coverage.required}`}
              </td>
            ))}
          </tr>
          {metrics.map((metric) => (
            <tr key={metric.label}>
              <th scope="row">{metric.label}</th>
              {cases.map((row, index) => (
                <td key={index}>{metric.value(row)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">{t('最低美元損益部位', 'Lowest dollar P/L position')}</th>
            {cases.map((row, index) => (
              <td key={index}>
                {row.worst_position
                  ? `${row.worst_position.symbol} ${money(row.worst_position.pnl)}`
                  : '—'}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">{t('限制檢查', 'Policy checks')}</th>
            {cases.map((row, index) => (
              <td key={index}>
                {row.policy_breaches.length
                  ? t(
                      `${row.policy_breaches.length} 項原因（見下方）`,
                      `${row.policy_breaches.length} findings (below)`,
                    )
                  : row.status === 'available'
                    ? t('無超限', 'No breaches')
                    : t('不可用', 'Unavailable')}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function CaseDetails({ row, t }: { row: ScenarioCase; t: Translate }) {
  return (
    <details
      className="scenario-case"
      open={row.status !== 'available' || row.policy_breaches.length > 0}
    >
      <summary>
        {caseName(row, t)} · {statusLabel(row.status, t)} ·{' '}
        {t('持倉與限制', 'Positions and limits')}
      </summary>
      {row.status === 'blocked' && (
        <p className="notice">
          {t(
            '方案未通過執行政策，情境淨值及損益不計算。可修改目標或帳戶設定後重新比較。',
            'This plan did not pass execution policy. Stressed equity and P/L are unavailable. Revise targets or account settings and calculate again.',
          )}
        </p>
      )}
      {row.coverage.missing.length > 0 && (
        <p className="scenario-unavailable">
          {t('缺少有效報價', 'Missing valid prices')}: {row.coverage.missing.join(', ')}
        </p>
      )}
      {row.policy_breaches.length > 0 && (
        <ul className="agent-reasons">
          {row.policy_breaches.map((issue, index) => (
            <li key={index}>
              {breachLabel(issue, t)} <code>{issue.code}</code>
            </li>
          ))}
        </ul>
      )}
      {row.preview && (
        <p className="scenario-scope">
          {t('擬執行', 'Proposed trades')}: {row.preview.orders.length} · {t('換手', 'Turnover')}:{' '}
          {percent(row.preview.turnover_pct)} · {t('跳過', 'Skipped')}:{' '}
          {row.preview.skipped_orders?.length ?? 0}
        </p>
      )}
      {!!row.preview?.skipped_orders?.length && (
        <ul className="agent-reasons">
          {row.preview.skipped_orders.map((order, index) => (
            <li key={index}>
              {order.symbol}:{' '}
              {t(
                '未達交易額或股數精度，保留原持倉',
                'Below trade size or share precision; existing position retained',
              )}{' '}
              <code>{order.reason}</code>
            </li>
          ))}
        </ul>
      )}
      {row.positions.length > 0 ? (
        <div
          className="table-scroll"
          tabIndex={0}
          aria-label={`${caseName(row, t)} ${t('情境持倉', 'scenario positions')}`}
        >
          <table>
            <thead>
              <tr>
                {[
                  t('代碼', 'Symbol'),
                  t('股數', 'Shares'),
                  t('參考價', 'Reference price'),
                  t('假設漲跌', 'Assumed shock'),
                  t('情境價', 'Stressed price'),
                  t('情境市值', 'Stressed value'),
                  t('震盪損益', 'Shock P/L'),
                  t('震盪前權重', 'Weight before shock'),
                  t('震盪後權重', 'Weight after shock'),
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row.positions.map((position) => (
                <tr key={position.symbol}>
                  <th scope="row">{position.symbol}</th>
                  <td>{num(position.shares, 6)}</td>
                  <td>{money(position.base_price)}</td>
                  <td>{percent(position.shock_pct)}</td>
                  <td>{money(position.stressed_price)}</td>
                  <td>{money(position.stressed_value)}</td>
                  <td>{money(position.pnl)}</td>
                  <td>{percent(position.weight_pct)}</td>
                  <td>{percent(position.stressed_weight_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : row.status === 'available' ? (
        <p className="scenario-scope">
          {t(
            '此情境為全現金，無股票價格曝險。',
            'This case is all cash, with no equity price exposure.',
          )}
        </p>
      ) : null}
    </details>
  )
}
