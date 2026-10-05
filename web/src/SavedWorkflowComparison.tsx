import { useEffect, useRef, useState } from 'react'
import type { AgentRun, AgentRunSummary } from './portfolio-agent-model'

type Translate = (zh: string, en: string) => string
type Value = { known: boolean; value: unknown; reason: string | null }
type Metadata = {
  id: string
  created_at: string
  engine_version: string | null
  as_of: string | null
  input_revision: string | null
  proposal_fingerprint: string | null
  status: string | null
  current: boolean | null
  stale_reasons: string[]
}
type Side = {
  candidate_recorded: boolean
  target_recorded: boolean
  status: Value
  score: Value
  weight_pct: Value
}
export type SavedComparison = {
  engine_version: string
  as_of: string
  input_revision: string
  baseline: Metadata
  comparison: Metadata
  rows: {
    symbol: string
    baseline: Side
    comparison: Side
    score_delta: Value
    weight_delta_pp: Value
  }[]
  selected: {
    baseline: string[] | null
    comparison: string[] | null
    only_in_baseline: string[] | null
    only_in_comparison: string[] | null
  }
  cash: { baseline: Value; comparison: Value; delta_pp: Value }
  settings: {
    field: string
    baseline: Value
    comparison: Value
    status: 'same' | 'changed' | 'unknown'
  }[]
  sources: SavedComparison['settings']
  comparability: {
    score_deltas: boolean
    baseline_allocation: boolean
    comparison_allocation: boolean
    weight_delta_semantics: string
    performance_comparison: false
  }
  coverage: {
    union_symbols: number
    score_deltas_available: number
    weight_deltas_available: number
  }
  method: string
  warnings: string[]
}
const reason = (code: string | null, t: Translate) =>
  ({
    not_recorded: t('未記錄', 'Not recorded'),
    missing_value: t('缺值', 'Missing value'),
    invalid_number: t('數值無效', 'Invalid number'),
    invalid_status: t('狀態無效', 'Invalid status'),
    allocation_unavailable: t('配置不可用', 'Allocation unavailable'),
    missing_side: t('其中一側缺值', 'One side is missing'),
    method_changed: t('分數方法無法比較', 'Score methods are not comparable'),
  })[code ?? ''] ?? t('未知', 'Unknown')
const currentness = (value: boolean | null, t: Translate) =>
  value === null
    ? t('來源身份不完整', 'Source identity incomplete')
    : value
      ? t('比較時來源當期', 'Source current at comparison')
      : t('歷史來源', 'Historical source')
const display = (value: Value) =>
  !value.known || value.value == null
    ? '—'
    : typeof value.value === 'number'
      ? Number.isFinite(value.value)
        ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value.value)
        : '—'
      : typeof value.value === 'string'
        ? value.value
        : JSON.stringify(value.value)
const list = (symbols: string[] | null, t: Translate) =>
  symbols === null ? '—' : symbols.join(' · ') || t('無', 'None')
const status = (value: Value, t: Translate) =>
  !value.known
    ? '—'
    : ({
        selected: t('已選入', 'Selected'),
        unselected: t('未選入', 'Not selected'),
        rejected: t('不符合', 'Rejected'),
      }[String(value.value)] ?? String(value.value))
const fieldLabel = (field: string, t: Translate) =>
  ({
    scope: t('候選範圍', 'Candidate scope'),
    candidate_symbols: t('候選標的', 'Candidate symbols'),
    'strategy_weights.turtle': t('海龜規則權重', 'Turtle rule weight'),
    'strategy_weights.trend': t('趨勢規則權重', 'Trend rule weight'),
    'strategy_weights.pullback': t('回檔規則權重', 'Pullback rule weight'),
    'strategy_weights.rps': t('RPS 規則權重', 'RPS rule weight'),
    'constraints.min_score': t('最低共識分數', 'Minimum consensus score'),
    'constraints.min_matches': t('最低符合規則數', 'Minimum matching rules'),
    'constraints.max_positions': t('最多部位數', 'Maximum positions'),
    'constraints.max_position_weight_pct': t('單一部位上限', 'Single-position cap'),
    'constraints.cash_buffer_pct': t('現金緩衝', 'Cash buffer'),
    'constraints.allocation_method': t('配置方法設定', 'Allocation method setting'),
    'constraints.volatility_lookback_sessions': t('波動回看交易日', 'Volatility lookback sessions'),
    engine_version: t('工作流方法版本', 'Workflow method version'),
    as_of: t('保存交易日', 'Saved session'),
    input_revision: t('保存輸入版本', 'Saved input revision'),
    proposal_fingerprint: t('保存提案指紋', 'Saved proposal fingerprint'),
    'scan.id': t('選股快照識別', 'Scan identity'),
    'scan.as_of': t('選股交易日', 'Scan session'),
    'scan.engine_version': t('選股方法版本', 'Scan method version'),
    'allocator.engine_version': t('配置器版本', 'Allocator version'),
    'allocator.method': t('保存配置方法', 'Saved allocation method'),
    'account_context.account_id': t('綁定帳戶', 'Bound account'),
    'account_context.symbol_policy.engine_version': t(
      '標的政策方法版本',
      'Symbol-policy method version',
    ),
    'account_context.symbol_policy.version': t('標的政策版本', 'Symbol-policy version'),
  })[field] ?? field

function Observation({ value, t }: { value: Value; t: Translate }) {
  return (
    <>
      {display(value)}
      {!value.known && <small>{reason(value.reason, t)}</small>}
    </>
  )
}
function DifferenceTable({ items, t }: { items: SavedComparison['settings']; t: Translate }) {
  const changes = items.filter((item) => item.status !== 'same')
  return changes.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {[
              t('項目', 'Field'),
              t('基準紀錄', 'Baseline record'),
              t('比較紀錄', 'Comparison record'),
              t('差異狀態', 'Difference status'),
            ].map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {changes.map((item) => (
            <tr key={item.field}>
              <th scope="row">{fieldLabel(item.field, t)}</th>
              <td className="workflow-json">
                <Observation value={item.baseline} t={t} />
              </td>
              <td className="workflow-json">
                <Observation value={item.comparison} t={t} />
              </td>
              <td>
                {item.status === 'changed'
                  ? t('不同', 'Different')
                  : t('缺少可比較紀錄', 'Comparable evidence missing')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p>{t('已記錄的值相同。', 'Recorded values are equal.')}</p>
  )
}

export function SavedWorkflowComparison({
  run,
  history,
  t,
}: {
  run: AgentRun
  history: AgentRunSummary[]
  t: Translate
}) {
  const choices = history.filter((item) => item.id !== run.id)
  const [baselineId, setBaselineId] = useState('')
  const [result, setResult] = useState<{ key: string; value: SavedComparison } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  const baseline = choices.find((item) => item.id === baselineId)
  const identity = JSON.stringify([
    run.id,
    run.engine_version,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    run.status,
    run.current,
    run.stale_reasons,
    run.account_context,
    baselineId,
    baseline?.created_at,
    baseline?.engine_version,
    baseline?.as_of,
    baseline?.status,
    baseline?.current,
    baseline?.stale_reasons,
    baseline?.account_context,
  ])
  const identityRef = useRef(identity)
  identityRef.current = identity
  useEffect(() => {
    operation.current?.abort()
    operation.current = null
    setResult(null)
    setError('')
    setBusy(false)
    return () => operation.current?.abort()
  }, [identity])
  async function compare() {
    if (operation.current || !baseline) return
    const controller = new AbortController()
    operation.current = controller
    const key = identity
    setResult(null)
    setError('')
    setBusy(true)
    try {
      const response = await fetch('/api/portfolio-agent/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({ baseline_run_id: baselineId, comparison_run_id: run.id }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok)
        throw new Error(
          typeof value.detail?.message === 'string'
            ? value.detail.message
            : t(`比較失敗（${response.status}）`, `Comparison failed (${response.status})`),
        )
      if (controller.signal.aborted || key !== identityRef.current) return
      if (
        value.baseline?.id !== baselineId ||
        value.comparison?.id !== run.id ||
        value.comparison?.proposal_fingerprint !== run.proposal_fingerprint
      )
        throw new Error(
          t(
            '回應的保存工作流身份不符，請重新載入紀錄。',
            'The saved workflow identity does not match. Reload the records.',
          ),
        )
      setResult({ key, value: value as SavedComparison })
    } catch (err) {
      if (!controller.signal.aborted && key === identityRef.current)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted && key === identityRef.current) setBusy(false)
    }
  }
  const value = result?.key === identity ? result.value : null
  function download() {
    if (
      !value ||
      busy ||
      operation.current ||
      result?.key !== identityRef.current ||
      value.baseline.id !== baselineId ||
      value.comparison.id !== run.id ||
      value.comparison.proposal_fingerprint !== run.proposal_fingerprint
    )
      return
    try {
      // Serialize the complete response, never a projection of the rounded display cells.
      const json = JSON.stringify(
        value,
        (_key, item: unknown) => {
          if (typeof item === 'number' && !Number.isFinite(item))
            throw new Error('Saved comparison contains a non-finite number')
          return item
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
      anchor.download = `alphaview-saved-workflow-comparison-${safe(value.as_of)}-${safe(value.baseline.id)}-${safe(value.comparison.id)}.json`
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
          '無法下載這份保存比較，請重新比較後再試。',
          'This saved comparison could not be downloaded. Compare the records again and retry.',
        ),
      )
    }
  }
  return (
    <section
      className="agent-panel workflow-validation"
      aria-label={t('保存工作流比較', 'Saved workflow comparison')}
    >
      <h2>{t('比較兩份保存工作流', 'Compare two saved workflows')}</h2>
      <p className="research-note">
        {t(
          '只並列保存的規則分數、配置與來源，不重跑策略、不套用配置，也不把差異解釋為績效或因果。',
          'Compares saved rule scores, allocations and sources without rerunning strategies or applying targets. Differences are not performance or causal evidence.',
        )}
      </p>
      <label className="agent-field">
        {t('選擇基準工作流', 'Choose a baseline workflow')}
        <select
          value={baselineId}
          onChange={(event) => setBaselineId(event.target.value)}
          disabled={!choices.length}
        >
          <option value="">{t('請選擇另一份保存紀錄', 'Choose another saved record')}</option>
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.as_of} ·{' '}
              {item.target_weights.map((target) => target.symbol).join(', ') ||
                t('無目標', 'No targets')}{' '}
              · {item.status === 'blocked' ? t('受阻', 'Blocked') : t('已保存', 'Saved')} ·{' '}
              {item.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {!choices.length && (
        <p>
          {t(
            '目前歷程內需要另一份保存工作流才能比較。',
            'Another saved workflow in the loaded history is required.',
          )}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={busy || !baseline} onClick={compare}>
          {busy ? t('比較中…', 'Comparing…') : t('比較保存紀錄', 'Compare saved records')}
        </button>
        <button type="button" className="button" disabled={!value || busy} onClick={download}>
          {t('下載保存比較 JSON', 'Download saved comparison JSON')}
        </button>
      </div>
      <p className="research-note">
        {t(
          '下載保留此次比較的完整回應、缺值與來源當期標示，不會重新讀取資料。',
          'The download preserves this comparison’s full response, missing values and source currentness without reading data again.',
        )}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {value && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('保存身份', 'Saved identity')}</th>
                  <th scope="col">{t('基準紀錄', 'Baseline record')}</th>
                  <th scope="col">{t('比較紀錄', 'Comparison record')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t('交易日與當期狀態', 'Session and currentness')}</th>
                  {[value.baseline, value.comparison].map((item) => (
                    <td key={item.id}>
                      {item.as_of ?? '—'}
                      <small>{currentness(item.current, t)}</small>
                      <small>
                        {item.status === 'proposed'
                          ? t('已產生提案', 'Proposed')
                          : item.status === 'blocked'
                            ? t('受阻', 'Blocked')
                            : (item.status ?? '—')}
                      </small>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t('保存選入標的', 'Saved selected symbols')}</th>
                  <td>{list(value.selected.baseline, t)}</td>
                  <td>{list(value.selected.comparison, t)}</td>
                </tr>
                <tr>
                  <th scope="row">{t('僅在該紀錄選入', 'Selected only in this record')}</th>
                  <td>{list(value.selected.only_in_baseline, t)}</td>
                  <td>{list(value.selected.only_in_comparison, t)}</td>
                </tr>
                <tr>
                  <th scope="row">{t('保存現金 %', 'Saved cash %')}</th>
                  <td>
                    <Observation value={value.cash.baseline} t={t} />
                  </td>
                  <td>
                    <Observation value={value.cash.comparison} t={t} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            {t(
              '現金差值（比較 − 基準，百分點）',
              'Cash delta (comparison − baseline, percentage points)',
            )}
            : <Observation value={value.cash.delta_pp} t={t} />
          </p>
          {!value.comparability.score_deltas && (
            <p className="notice">
              {t(
                '工作流方法版本不同或缺失；分數僅並列原值，不計算分數差值。',
                'Workflow method versions differ or are missing. Saved scores are shown without score deltas.',
              )}
            </p>
          )}
          {(!value.comparability.baseline_allocation ||
            !value.comparability.comparison_allocation) && (
            <p className="notice">
              {t(
                '至少一份工作流的配置受阻或不可用；空目標與缺少現金不視為零。',
                'At least one saved allocation is blocked or unavailable. Empty targets and missing cash are not treated as zero.',
              )}
            </p>
          )}
          <p>
            {t(
              '差值均為比較紀錄減基準；權重差值僅為百分點算術，與配置方法或來源改變的因果無關。',
              'Deltas are comparison minus baseline. Weight deltas are percentage-point arithmetic and do not attribute changes to settings or sources.',
            )}
          </p>
          <p>
            {t('分數差值覆蓋', 'Score-delta coverage')}: {value.coverage.score_deltas_available}/
            {value.coverage.union_symbols} · {t('權重差值覆蓋', 'Weight-delta coverage')}:{' '}
            {value.coverage.weight_deltas_available}/{value.coverage.union_symbols}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('標的', 'Symbol'),
                    t('基準狀態', 'Baseline status'),
                    t('比較狀態', 'Comparison status'),
                    t('基準分數', 'Baseline score'),
                    t('比較分數', 'Comparison score'),
                    t('分數差值', 'Score delta'),
                    t('基準權重 %', 'Baseline weight %'),
                    t('比較權重 %', 'Comparison weight %'),
                    t('權重差值（百分點）', 'Weight delta (pp)'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.rows.map((row) => (
                  <tr key={row.symbol}>
                    <th scope="row">{row.symbol}</th>
                    <td>{status(row.baseline.status, t)}</td>
                    <td>{status(row.comparison.status, t)}</td>
                    {[
                      row.baseline.score,
                      row.comparison.score,
                      row.score_delta,
                      row.baseline.weight_pct,
                      row.comparison.weight_pct,
                      row.weight_delta_pp,
                    ].map((cell, index) => (
                      <td key={index}>
                        <Observation value={cell} t={t} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('保存設定差異', 'Saved settings differences')}</h3>
          <DifferenceTable items={value.settings} t={t} />
          <h3>{t('來源與方法差異', 'Source and method differences')}</h3>
          <DifferenceTable items={value.sources} t={t} />
          <details className="agent-method">
            <summary>{t('比較來源與限制', 'Comparison provenance and limits')}</summary>
            <p>
              {value.engine_version} · {value.as_of} · {value.input_revision}
            </p>
            {[value.baseline, value.comparison].map((item) => (
              <div key={item.id} className="workflow-json">
                <p>
                  {item.id} · {item.engine_version ?? '—'}
                </p>
                <p>{item.input_revision ?? '—'}</p>
                <p>{item.proposal_fingerprint ?? '—'}</p>
                <p>{item.stale_reasons.join(' · ')}</p>
              </div>
            ))}
            <p>{value.method}</p>
            <ul>
              {value.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
