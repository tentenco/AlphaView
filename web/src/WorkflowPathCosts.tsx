import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import type { WorkflowPathEvidence } from './WorkflowPathValidation'
import { downloadWorkflowEvidenceJson } from './workflow-evidence-json'
import { num } from './ui'
import { WorkflowPathReceipts } from './WorkflowPathReceipts'
import './workflow-path-costs.css'

type Translate = (zh: string, en: string) => string
type CostReason = { code: string; symbol?: string; date?: string; details?: CostReason[] }
type CostScenario = {
  fee_bps: number
  slippage_bps: number
  is_baseline: boolean
  status: 'evaluated' | 'unavailable'
  reasons: CostReason[]
  metrics: WorkflowPathEvidence['metrics']
  costs: {
    fees: number
    slippage: number
    total: number
    raw_notional: number
    execution_notional: number
  } | null
  differences: {
    final_value: number
    return_pp: number
    max_drawdown_pp: number
    explicit_cost: number
  } | null
  curve: WorkflowPathEvidence['curve']
  events: {
    signal_date: string
    trade_date: string
    fee: number
    slippage_cost: number
    cash: number
    trades: {
      symbol: string
      side: string
      shares: number
      raw_open: number
      fill_price: number
      raw_notional: number
      execution_notional: number
      fee: number
      slippage_cost: number
    }[]
  }[]
}
export type WorkflowPathCostEvidence = {
  engine_version: string
  path_engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  input_revision: string
  as_of: string
  current_at_snapshot: boolean
  request: { fee_bps: number[]; slippage_bps: number[] }
  baseline: WorkflowPathEvidence
  baseline_evidence_fingerprint: string
  history_fingerprint: string | null
  decision_fingerprint: string
  scenario_fingerprint: string
  evidence_fingerprint: string
  status: 'evaluated' | 'incomplete' | 'unavailable'
  coverage: {
    required_scenarios: number
    available_scenarios: number
    unavailable_scenarios: number
    decision_sets_computed: number
  }
  scenarios: CostScenario[]
  method: string
  warnings: string[]
}

const metric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
function rates(text: string): number[] | null {
  const items = text.split(/[,，]/).map((part) => part.trim())
  if (items.length > 3 || items.some((part) => !part)) return null
  const values = items.map(Number)
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) &&
    new Set(values).size === values.length
    ? values
    : null
}
const reasonLabel = (code: string, t: Translate) =>
  ({
    baseline_unavailable: t('基準路徑不可用', 'Baseline path unavailable'),
    decision_evidence_incomplete: t(
      '歷史決策證據不完整',
      'Historical decision evidence incomplete',
    ),
    held_corporate_action_unmodeled: t(
      '持有期間調整因子變動，無法重建公司行動帳務',
      'A held adjustment factor changed; corporate-action accounting cannot be reconstructed',
    ),
    valuation_bar_unavailable: t('成交或估值行情不可用', 'Fill or valuation bars unavailable'),
    nonfinite_accounting: t('模擬帳務數值不可用', 'Simulation accounting values unavailable'),
    invalid_cost_scenario: t('成本情境或目標權重無效', 'Invalid cost scenario or target weights'),
    no_history: t('沒有本機日線', 'No local bars'),
    history_limit: t('超過本機歷史筆數上限', 'Local history exceeds the limit'),
  })[code] ?? code
const reasonText = (items: CostReason[], t: Translate): string =>
  items
    .map((item) =>
      [
        item.symbol,
        item.date,
        reasonLabel(item.code, t),
        item.details?.length ? reasonText(item.details, t) : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(' · ')

export function WorkflowPathCosts({
  account,
  run,
  enabled,
  t,
}: {
  account?: { id: string; version: number } | null
  run: AgentRun
  enabled: boolean
  t: Translate
}) {
  const labelId = useId()
  const feeId = useId()
  const slipId = useId()
  const hintId = useId()
  const [feeDraft, setFeeDraft] = useState('0, 10, 25')
  const [slipDraft, setSlipDraft] = useState('0, 5, 10')
  const [selected, setSelected] = useState(0)
  const fees = rates(feeDraft)
  const slippage = rates(slipDraft)
  const available = enabled && run.saved && run.current !== false && run.status === 'proposed'
  const identity = JSON.stringify([
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    available,
    feeDraft,
    slipDraft,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const operation = useRef<AbortController | null>(null)
  const [checking, setChecking] = useState(false)
  const [state, setState] = useState<{
    identity: string
    busy?: boolean
    stale?: boolean
    error?: string
    result?: WorkflowPathCostEvidence
    rawJson?: string
  } | null>(null)
  const active = state?.identity === identity ? state : null
  const evidence = available && active?.result && !active.stale ? active.result : null
  const scenario = evidence?.scenarios[selected]
  const sourceMessage = t(
    '成本比較來源已變更或無法核對；請重新檢查工作流。',
    'The cost comparison source changed or could not be checked. Recheck the workflow.',
  )
  const currentRun = (value: AgentRun) =>
    value.current === true &&
    value.id === run.id &&
    value.proposal_fingerprint === run.proposal_fingerprint &&
    value.input_revision === run.input_revision &&
    value.as_of === run.as_of

  useEffect(() => {
    setState(null)
    setChecking(false)
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [identity])

  useEffect(() => {
    if (!evidence) return
    const controller = new AbortController()
    let running = false
    const check = async () => {
      if (running || operation.current || document.visibilityState === 'hidden') return
      running = true
      setChecking(true)
      try {
        const response = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !currentRun((await response.json()) as AgentRun))
          throw new Error('stale')
      } catch {
        if (!controller.signal.aborted && latestIdentity.current === identity)
          setState((previous) =>
            previous?.identity === identity ? { ...previous, stale: true } : previous,
          )
      } finally {
        running = false
        if (!controller.signal.aborted && latestIdentity.current === identity) setChecking(false)
      }
    }
    const timer = window.setInterval(() => void check(), 30000)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [evidence, identity])

  async function compare() {
    if (!available || !fees || !slippage || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setChecking(false)
    setState({ identity, busy: true })
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/path-costs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            expected_proposal_fingerprint: run.proposal_fingerprint,
            expected_input_revision: run.input_revision,
            expected_as_of: run.as_of,
            fee_bps: fees,
            slippage_bps: slippage,
          }),
        },
      )
      const rawJson = await response.text()
      const value = JSON.parse(rawJson)
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
        )
      if (controller.signal.aborted || latestIdentity.current !== identity) return
      if (
        value.agent_run_id !== run.id ||
        value.proposal_fingerprint !== run.proposal_fingerprint ||
        value.input_revision !== run.input_revision ||
        value.as_of !== run.as_of ||
        value.current_at_snapshot !== true ||
        JSON.stringify(value.request?.fee_bps) !== JSON.stringify(fees) ||
        JSON.stringify(value.request?.slippage_bps) !== JSON.stringify(slippage)
      )
        throw new Error(sourceMessage)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !currentRun((await checked.json()) as AgentRun))
        throw new Error(sourceMessage)
      if (!controller.signal.aborted && latestIdentity.current === identity) {
        setSelected(
          Math.max(
            0,
            value.scenarios.findIndex((item: CostScenario) => item.is_baseline),
          ),
        )
        setState({ identity, result: value as WorkflowPathCostEvidence, rawJson })
      }
    } catch (error) {
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState({ identity, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }

  function download() {
    if (!evidence || !active?.rawJson || checking || operation.current) return
    try {
      downloadWorkflowEvidenceJson(evidence, active.rawJson)
    } catch {
      setState((previous) =>
        previous?.identity === identity
          ? { ...previous, error: t('成本證據下載失敗', 'Cost evidence download failed') }
          : previous,
      )
    }
  }
  const values = scenario?.curve.map((point) => point.value) ?? []
  const finiteCurve = values.length > 1 && values.every(Number.isFinite)
  const low = finiteCurve ? Math.min(100000, ...values) : 0
  const high = finiteCurve ? Math.max(100000, ...values) : 0
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 600},${150 - ((value - low) / (high - low || 1)) * 140}`,
    )
    .join(' ')
  const label = (item: CostScenario) =>
    `${metric(item.fee_bps)} / ${metric(item.slippage_bps)}${item.is_baseline ? t('（原基準）', ' (original baseline)') : ''}`

  return (
    <section className="agent-panel workflow-path-costs" aria-labelledby={labelId}>
      <h3 id={labelId}>{t('同一路徑的成本情境', 'Cost scenarios on the same path')}</h3>
      <p className="research-note">
        {t(
          '只計算一次歷史決策，各情境保留相同候選、日期與目標百分比。成本會改變模擬股數及後續本金；這不是成本最佳化、成交保證或交易指示。',
          'Compute historical decisions once, keeping the same candidates, dates, and target percentages. Costs change simulated quantities and future capital; this is not cost optimization, a fill guarantee, or trading guidance.',
        )}
      </p>
      <p>
        {t(
          '基準固定為單邊費用 10 bps、滑價 0，原路徑證據完整保留。買入加價、賣出減價，費用按滑價後成交金額計算；1 bps = 0.01%。',
          'The fixed baseline is 10 bps one-way fees and zero slippage, with the original evidence retained. Buys pay more and sells receive less; fees use the slipped execution notional. 1 bps = 0.01%.',
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void compare()
        }}
      >
        <div className="workflow-cost-inputs">
          <label htmlFor={feeId}>
            {t('單邊費用（bps）', 'One-way fees (bps)')}
            <input
              id={feeId}
              value={feeDraft}
              onChange={(event) => setFeeDraft(event.target.value)}
              aria-describedby={hintId}
              aria-invalid={!fees}
            />
          </label>
          <label htmlFor={slipId}>
            {t('單邊滑價（bps）', 'One-way slippage (bps)')}
            <input
              id={slipId}
              value={slipDraft}
              onChange={(event) => setSlipDraft(event.target.value)}
              aria-describedby={hintId}
              aria-invalid={!slippage}
            />
          </label>
        </div>
        <p id={hintId}>
          {t(
            '每欄填 1–3 個不重複的 0–100 數字，以逗號分隔；最多 9 組情境。',
            'Enter 1–3 unique values from 0 to 100 per field, separated by commas; at most 9 scenarios.',
          )}
        </p>
        {(!fees || !slippage) && (
          <p className="error-message" role="alert">
            {t(
              '請檢查成本假設：不可空白、重複、超出範圍或超過 3 個值。',
              'Check the assumptions: no empty, duplicate, out-of-range, or more than 3 values.',
            )}
          </p>
        )}
        {!available && (
          <p className="notice">
            {t('請先取得當期可用的已保存工作流。', 'A current saved workflow is required.')}
          </p>
        )}
        <div className="actions">
          <button
            className="button"
            type="submit"
            disabled={!available || !fees || !slippage || active?.busy}
          >
            {active?.busy
              ? t('比較成本中…', 'Comparing costs…')
              : t('比較成本情境', 'Compare cost scenarios')}
          </button>
          {evidence && (
            <button className="button" type="button" onClick={download} disabled={checking}>
              {t('下載成本證據 JSON', 'Download cost evidence JSON')}
            </button>
          )}
        </div>
      </form>
      {active?.error && (
        <p className="error-message" role="alert">
          {active.error}
        </p>
      )}
      {active?.stale && (
        <p className="notice" role="status">
          {sourceMessage}
        </p>
      )}
      {evidence && (
        <>
          <p role="status">
            {t('可用成本情境', 'Available cost scenarios')}: {evidence.coverage.available_scenarios}
            /{evidence.coverage.required_scenarios} ·{' '}
            {t(
              '歷史決策只計算一次，沒有最佳情境或通過結論。',
              'Decisions computed once; no best scenario or pass verdict.',
            )}
          </p>
          <p>
            {evidence.baseline.window.start} → {evidence.baseline.window.end} ·{' '}
            {t('原基準期末資產', 'Original baseline final equity')}:{' '}
            {metric(evidence.baseline.metrics?.final_value)}
          </p>
          <p>
            {t(
              '期末資產差含部位與複利效果，不等於累計費用與滑價差額。缺口保留「—」，不補值。',
              'Final equity differences include quantity and compounding effects, so they need not equal fee and slippage differences. Gaps remain “—”, without substitution.',
            )}
          </p>
          <div className="table-scroll">
            <table>
              <caption>{t('固定決策的成本比較', 'Cost comparison with fixed decisions')}</caption>
              <thead>
                <tr>
                  {[
                    t('費用 / 滑價（bps）', 'Fee / slippage (bps)'),
                    t('結果', 'Result'),
                    t('報酬（%）', 'Return (%)'),
                    t('最大回撤（%）', 'Maximum drawdown (%)'),
                    t('累計費用', 'Total fees'),
                    t('累計滑價', 'Total slippage'),
                    t('期末資產', 'Final equity'),
                    t('資產差（對原基準）', 'Equity difference vs baseline'),
                    t('報酬差（百分點）', 'Return difference (pp)'),
                  ].map((heading) => (
                    <th scope="col" key={heading}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evidence.scenarios.map((item) => (
                  <tr key={`${item.fee_bps}:${item.slippage_bps}`}>
                    <th scope="row">{label(item)}</th>
                    <td>
                      {item.status === 'evaluated'
                        ? t('已計算', 'Calculated')
                        : reasonText(item.reasons, t)}
                    </td>
                    <td>{metric(item.metrics?.return_pct)}</td>
                    <td>{metric(item.metrics?.max_drawdown_pct)}</td>
                    <td>{metric(item.costs?.fees, 4)}</td>
                    <td>{metric(item.costs?.slippage, 4)}</td>
                    <td>{metric(item.metrics?.final_value)}</td>
                    <td>{metric(item.differences?.final_value)}</td>
                    <td>{metric(item.differences?.return_pp, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="workflow-cost-select">
            {t('查看情境明細（費用 / 滑價 bps）', 'Inspect scenario details (fee / slippage bps)')}
            <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
              {evidence.scenarios.map((item, index) => (
                <option value={index} key={`${item.fee_bps}:${item.slippage_bps}`}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
          {scenario && (
            <>
              {!!scenario.reasons.length && (
                <p className="notice">{reasonText(scenario.reasons, t)}</p>
              )}
              <p>
                {t('累計明列成本', 'Total explicit costs')}: {metric(scenario.costs?.total, 4)} ·{' '}
                {t('明列成本差（對原基準）', 'Explicit cost difference vs baseline')}:{' '}
                {metric(scenario.differences?.explicit_cost, 4)} ·{' '}
                {t('回撤差（百分點）', 'Drawdown difference (pp)')}:{' '}
                {metric(scenario.differences?.max_drawdown_pp, 4)}
              </p>
              {finiteCurve && (
                <figure className="workflow-cost-chart">
                  <svg
                    viewBox="0 0 600 165"
                    role="img"
                    aria-label={t(
                      '所選成本情境的資產路徑',
                      'Equity path of selected cost scenario',
                    )}
                  >
                    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  <figcaption>
                    {label(scenario)} · {t('資產值範圍', 'Equity range')}: {metric(low)} –{' '}
                    {metric(high)}
                  </figcaption>
                </figure>
              )}
              {!!scenario.events.length && (
                <details className="agent-method">
                  <summary>
                    {t('所選情境的逐筆模擬成交', 'Simulated fills for selected scenario')}
                  </summary>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {[
                            t('成交日', 'Fill date'),
                            t('標的', 'Symbol'),
                            t('方向', 'Side'),
                            t('模擬股數', 'Simulated shares'),
                            t('未調整開盤', 'Raw open'),
                            t('模擬成交價', 'Simulated fill price'),
                            t('成交金額', 'Execution notional'),
                            t('費用', 'Fee'),
                            t('滑價成本', 'Slippage cost'),
                          ].map((heading) => (
                            <th scope="col" key={heading}>
                              {heading}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {scenario.events.flatMap((event) =>
                          event.trades.map((trade) => (
                            <tr key={`${event.trade_date}:${trade.symbol}`}>
                              <td>{event.trade_date}</td>
                              <th scope="row">{trade.symbol}</th>
                              <td>
                                {trade.side === 'buy'
                                  ? t('模擬買入', 'Simulated buy')
                                  : t('模擬賣出', 'Simulated sell')}
                              </td>
                              <td>{metric(trade.shares, 6)}</td>
                              <td>{metric(trade.raw_open, 4)}</td>
                              <td>{metric(trade.fill_price, 4)}</td>
                              <td>{metric(trade.execution_notional, 4)}</td>
                              <td>{metric(trade.fee, 4)}</td>
                              <td>{metric(trade.slippage_cost, 4)}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
          <details className="agent-method">
            <summary>
              {t('成本方法、來源與限制', 'Cost method, provenance, and limitations')}
            </summary>
            <p>
              {evidence.engine_version} · {evidence.path_engine_version} · {evidence.as_of}
            </p>
            <p>
              {t('輸入版本', 'Input revision')}: {evidence.input_revision}
            </p>
            {[
              [
                t('原基準證據指紋', 'Original baseline evidence fingerprint'),
                evidence.baseline_evidence_fingerprint,
              ],
              [t('歷史指紋', 'History fingerprint'), evidence.history_fingerprint ?? '—'],
              [t('共同決策指紋', 'Shared decision fingerprint'), evidence.decision_fingerprint],
              [t('成本假設指紋', 'Cost assumption fingerprint'), evidence.scenario_fingerprint],
              [t('成本證據指紋', 'Cost evidence fingerprint'), evidence.evidence_fingerprint],
            ].map(([heading, value]) => (
              <p key={heading}>
                {heading}: <code>{value}</code>
              </p>
            ))}
            <p>{evidence.method}</p>
            <ul>
              {evidence.warnings.map((warning) => (
                <li key={warning}>{t(warning, warning)}</li>
              ))}
            </ul>
            <p>
              {t(
                '畫面資產與報酬保留 2 位小數、成本與百分點差額保留 4 位；下載證據保存完整精度與原基準。',
                'The screen uses 2 decimals for equity and returns, and 4 for costs and percentage-point differences. Downloaded evidence retains full precision and the original baseline.',
              )}
            </p>
          </details>
        </>
      )}
      <WorkflowPathReceipts
        account={account ?? null}
        run={run}
        kind="path_costs"
        evidence={evidence}
        request={
          evidence
            ? {
                expected_proposal_fingerprint: run.proposal_fingerprint,
                expected_input_revision: run.input_revision,
                expected_as_of: run.as_of,
                fee_bps: evidence.request.fee_bps,
                slippage_bps: evidence.request.slippage_bps,
              }
            : null
        }
        enabled={available && !checking && !active?.busy}
        t={t}
      />
    </section>
  )
}
