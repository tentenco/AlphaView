import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import type { WorkflowPathEvidence } from './WorkflowPathValidation'
import { downloadWorkflowEvidenceJson, workflowEvidenceJson } from './workflow-evidence-json'
import { num } from './ui'
import './workflow-path-segments.css'

type Translate = (zh: string, en: string) => string
type Reason = { code: string; symbol?: string; date?: string }
type SegmentMetrics = {
  boundary_value: number
  final_value: number
  net_change: number
  return_pct: number
  max_drawdown_pct: number
  total_fees: number
  traded_notional: number
  turnover_pct: number
  trade_count: number
}
export type PathSegment = {
  segment: number
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  window: {
    boundary_date: string | null
    start: string | null
    end: string | null
    first_path_session: number
    last_path_session: number
    boundary_source: 'initial_cash_at_preceding_close' | 'previous_segment_final_close'
  }
  coverage: {
    required_sessions: number
    observed_sessions: number
    covered_sessions: number
    known_decisions: number
    known_events: number
  }
  metrics: SegmentMetrics | null
  normalized_curve: { date: string; session: number; index_value: number }[]
  decision_indices: number[]
  event_indices: number[]
  curve_indices: number[]
}
export type WorkflowPathSegmentEvidence = {
  engine_version: string
  path_engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  input_revision: string
  as_of: string
  current_at_snapshot: boolean
  status: 'evaluated' | 'unavailable'
  reasons: Reason[]
  baseline: WorkflowPathEvidence
  baseline_evidence_fingerprint: string
  history_fingerprint: string | null
  settings_fingerprint: string
  segmentation_fingerprint: string
  evidence_fingerprint: string
  coverage: {
    required_segments: number
    available_segments: number
    required_path_sessions: number
    observed_path_sessions: number
    covered_path_sessions: number
    path_evaluations: number
  }
  segments: PathSegment[]
  reconciliation: {
    chained_return_pct: number
    full_path_return_pct: number
    return_residual_pp: number
    summed_net_change: number
    full_path_net_change: number
    fees_residual: number
    notional_residual: number
    trade_count_residual: number
  } | null
  method: string
  warnings: string[]
}
const VERSION = 'alphaview-workflow-path-segments-v1'
const metric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const contextKey = (run: AgentRun) =>
  JSON.stringify([run.account_context ?? null, run.request.account_context ?? null])
const sourceMatches = (value: AgentRun, run: AgentRun) =>
  value?.current === true &&
  value.id === run.id &&
  value.status === 'proposed' &&
  value.proposal_fingerprint === run.proposal_fingerprint &&
  value.input_revision === run.input_revision &&
  value.as_of === run.as_of &&
  !!value.request &&
  contextKey(value) === contextKey(run)

function acceptedEvidence(value: unknown, run: AgentRun): value is WorkflowPathSegmentEvidence {
  if (!value || typeof value !== 'object') return false
  const result = value as WorkflowPathSegmentEvidence
  const sameIdentity = (item: WorkflowPathEvidence | WorkflowPathSegmentEvidence) =>
    item?.agent_run_id === run.id &&
    item.proposal_fingerprint === run.proposal_fingerprint &&
    item.input_revision === run.input_revision &&
    item.as_of === run.as_of &&
    item.current_at_snapshot === true
  return (
    result.engine_version === VERSION &&
    sameIdentity(result) &&
    sameIdentity(result.baseline) &&
    !!result.baseline.window &&
    result.baseline_evidence_fingerprint === result.baseline.evidence_fingerprint &&
    ['evaluated', 'unavailable'].includes(result.status) &&
    Array.isArray(result.reasons) &&
    result.reasons.every((reason) => reason && typeof reason.code === 'string') &&
    Array.isArray(result.warnings) &&
    result.warnings.every((warning) => typeof warning === 'string') &&
    result.coverage?.required_segments === 4 &&
    result.coverage.required_path_sessions === 252 &&
    result.coverage.path_evaluations === 1 &&
    (result.status === 'unavailable'
      ? result.coverage.available_segments === 0 &&
        result.coverage.covered_path_sessions === 0 &&
        result.reconciliation === null
      : result.baseline.status === 'evaluated' &&
        result.coverage.available_segments === 4 &&
        result.coverage.covered_path_sessions === 252 &&
        !!result.reconciliation &&
        [
          'chained_return_pct',
          'full_path_return_pct',
          'return_residual_pp',
          'summed_net_change',
          'full_path_net_change',
          'fees_residual',
          'notional_residual',
          'trade_count_residual',
        ].every((key) =>
          Number.isFinite(
            result.reconciliation?.[
              key as keyof NonNullable<WorkflowPathSegmentEvidence['reconciliation']>
            ],
          ),
        )) &&
    Array.isArray(result.segments) &&
    result.segments.length === 4 &&
    result.segments.every(
      (segment, index) =>
        segment?.segment === index + 1 &&
        segment.window?.first_path_session === index * 63 + 1 &&
        segment.window.last_path_session === (index + 1) * 63 &&
        segment.coverage?.required_sessions === 63 &&
        Array.isArray(segment.reasons) &&
        Array.isArray(segment.normalized_curve) &&
        (result.status === 'unavailable'
          ? segment.status === 'unavailable' &&
            segment.metrics === null &&
            segment.coverage.covered_sessions === 0 &&
            segment.normalized_curve.length === 0
          : segment.status === 'evaluated' &&
            !!segment.metrics &&
            [
              'boundary_value',
              'final_value',
              'net_change',
              'return_pct',
              'max_drawdown_pct',
              'total_fees',
              'traded_notional',
              'turnover_pct',
              'trade_count',
            ].every((key) => Number.isFinite(segment.metrics?.[key as keyof SegmentMetrics])) &&
            segment.metrics.boundary_value > 0 &&
            segment.metrics.final_value > 0 &&
            segment.metrics.max_drawdown_pct <= 0 &&
            segment.coverage.covered_sessions === 63 &&
            segment.normalized_curve.length === 64 &&
            segment.normalized_curve.every(
              (point, offset) =>
                point?.session === offset &&
                Number.isFinite(point.index_value) &&
                point.index_value > 0,
            )),
    )
  )
}

const reasonLabel = (code: string, t: Translate) =>
  ({
    baseline_unavailable: t('原路徑不可用', 'Original path unavailable'),
    path_support_incomplete: t(
      '原路徑日期或帳務證據不完整',
      'Original path dates or accounting evidence are incomplete',
    ),
    segment_arithmetic_unavailable: t('分段數值無法可靠計算', 'Segment arithmetic unavailable'),
    decision_evidence_incomplete: t(
      '歷史決策證據不完整',
      'Historical decision evidence incomplete',
    ),
    held_corporate_action_unmodeled: t(
      '持有期間公司行動帳務不可用',
      'Held corporate-action accounting unavailable',
    ),
    valuation_bar_unavailable: t('成交或估值行情不可用', 'Fill or valuation bars unavailable'),
    calendar_unavailable: t('交易日曆不可用', 'Session calendar unavailable'),
    no_history: t('沒有本機日線', 'No local bars'),
  })[code] ?? code

export function WorkflowPathSegments({
  run,
  enabled,
  t,
}: {
  run: AgentRun
  enabled: boolean
  t: Translate
}) {
  const labelId = useId()
  const available =
    enabled &&
    !!run.id &&
    run.saved &&
    run.current !== false &&
    run.status === 'proposed' &&
    run.request.candidate_symbols.length > 0
  const identity = JSON.stringify([
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    contextKey(run),
    available,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const accepted = useRef<{ identity: string; result: WorkflowPathSegmentEvidence } | null>(null)
  if (accepted.current?.identity !== identity) accepted.current = null
  const operation = useRef<AbortController | null>(null)
  const checkingRef = useRef(false)
  const [checking, setChecking] = useState(false)
  const [state, setState] = useState<{
    identity: string
    busy?: boolean
    stale?: boolean
    error?: string
    result?: WorkflowPathSegmentEvidence
    rawJson?: string
  } | null>(null)
  const active = state?.identity === identity ? state : null
  const evidence = available && active?.result && !active.stale ? active.result : null
  const sourceMessage = t(
    '分段來源已變更或無法核對；請重新檢查工作流。',
    'The segment source changed or could not be checked. Recheck the workflow.',
  )

  useEffect(() => {
    setState(null)
    setChecking(false)
    checkingRef.current = false
    return () => {
      operation.current?.abort()
      operation.current = null
      accepted.current = null
    }
  }, [identity])

  useEffect(() => {
    if (!evidence) return
    const controller = new AbortController()
    const check = async () => {
      if (checkingRef.current || operation.current || document.visibilityState === 'hidden') return
      checkingRef.current = true
      setChecking(true)
      try {
        const response = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !sourceMatches((await response.json()) as AgentRun, run))
          throw new Error('stale')
      } catch {
        if (!controller.signal.aborted && latestIdentity.current === identity) {
          accepted.current = null
          setState({ identity, stale: true })
        }
      } finally {
        if (!controller.signal.aborted && latestIdentity.current === identity) {
          checkingRef.current = false
          setChecking(false)
        }
      }
    }
    const timer = window.setInterval(() => void check(), 30000)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      checkingRef.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [evidence, identity])

  async function inspect() {
    if (!available || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    accepted.current = null
    checkingRef.current = false
    setChecking(false)
    setState({ identity, busy: true })
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/path-segments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            expected_proposal_fingerprint: run.proposal_fingerprint,
            expected_input_revision: run.input_revision,
            expected_as_of: run.as_of,
          }),
        },
      )
      const rawJson = await response.text()
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
        )
      const value: unknown = JSON.parse(rawJson)
      if (controller.signal.aborted || latestIdentity.current !== identity) return
      if (!acceptedEvidence(value, run)) throw new Error(sourceMessage)
      workflowEvidenceJson(value, rawJson)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !sourceMatches((await checked.json()) as AgentRun, run))
        throw new Error(sourceMessage)
      if (!controller.signal.aborted && latestIdentity.current === identity) {
        accepted.current = { identity, result: value }
        setState({ identity, result: value, rawJson })
      }
    } catch (error) {
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState({ identity, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }

  function download() {
    if (
      !evidence ||
      accepted.current?.result !== evidence ||
      active?.rawJson === undefined ||
      checkingRef.current ||
      operation.current ||
      latestIdentity.current !== identity
    )
      return
    try {
      downloadWorkflowEvidenceJson(evidence, active.rawJson)
    } catch {
      setState((previous) =>
        previous?.identity === identity
          ? { ...previous, error: t('分段證據下載失敗', 'Segment evidence download failed') }
          : previous,
      )
    }
  }
  const chartValues =
    evidence?.segments.flatMap((segment) =>
      segment.normalized_curve.map((point) => point.index_value),
    ) ?? []
  const low = chartValues.length ? Math.min(100, ...chartValues) : 100
  const high = chartValues.length ? Math.max(100, ...chartValues) : 100
  const y = (value: number) => (high === low ? 80 : 150 - ((value - low) / (high - low)) * 140)

  return (
    <section className="agent-panel workflow-path-segments" aria-labelledby={labelId}>
      <h3 id={labelId}>{t('同一路徑的四段期間', 'Four periods of the same path')}</h3>
      <p className="research-note">
        {t(
          '同一條 252 日路徑依時間切為四段，每段 63 日，部位與現金跨段延續。這不是四個獨立樣本、訓練／測試切分、CPCV 或樣本外證明。',
          'Split one 252-session path into four chronological periods of 63 sessions, carrying positions and cash across boundaries. These are not independent samples, train/test splits, CPCV, or out-of-sample evidence.',
        )}
      </p>
      <p>
        {t(
          '期初採前一收盤資產，第一段採初始資金。報酬連乘、資產增減可相加；回撤包含期初邊界並以負值表示。固定候選與資料修訂的事後偏差仍存在。',
          'Each period begins at the preceding close NAV; the first uses initial cash. Returns compound and NAV changes add. Drawdown includes the boundary and is nonpositive. Fixed-candidate and revised-data hindsight bias remains.',
        )}
      </p>
      {!available && (
        <p className="notice">
          {t('請先取得當期可用的已保存工作流。', 'A current saved workflow is required.')}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={!available || active?.busy}
          onClick={inspect}
        >
          {active?.busy
            ? t('計算固定分段中…', 'Calculating fixed segments…')
            : t('檢查四段歷史路徑', 'Inspect four historical segments')}
        </button>
        {evidence && (
          <button className="button" type="button" disabled={checking} onClick={download}>
            {t('下載完整分段證據 JSON', 'Download complete segment evidence JSON')}
          </button>
        )}
      </div>
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
            {evidence.status === 'evaluated'
              ? t(
                  '四段已拆解，沒有排名或通過判定',
                  'Four segments decomposed; no ranking or pass verdict',
                )
              : t(
                  '原路徑或分段證據不可用，四段指標保留空值',
                  'Path or segment evidence unavailable; all four segment metrics remain missing',
                )}
          </p>
          <p>
            {t('涵蓋交易日', 'Covered sessions')}: {evidence.coverage.covered_path_sessions}/
            {evidence.coverage.required_path_sessions} · {t('可用分段', 'Available segments')}:{' '}
            {evidence.coverage.available_segments}/{evidence.coverage.required_segments}
          </p>
          {!!evidence.reasons.length && (
            <ul className="notice">
              {evidence.reasons.map((reason, index) => (
                <li key={index}>
                  {reason.symbol} {reason.date} {reasonLabel(reason.code, t)}
                </li>
              ))}
            </ul>
          )}
          <dl className="workflow-segment-totals">
            <div>
              <dt>{t('完整路徑報酬（%）', 'Full path return (%)')}</dt>
              <dd>{metric(evidence.reconciliation?.full_path_return_pct)}</dd>
            </div>
            <div>
              <dt>{t('四段連乘報酬（%）', 'Chained segment return (%)')}</dt>
              <dd>{metric(evidence.reconciliation?.chained_return_pct)}</dd>
            </div>
            <div>
              <dt>{t('四段資產增減合計', 'Sum of segment NAV changes')}</dt>
              <dd>{metric(evidence.reconciliation?.summed_net_change)}</dd>
            </div>
          </dl>
          <div className="table-scroll">
            <table>
              <caption>
                {t(
                  '四段期間比較；費用與成交沿用完整原路徑',
                  'Four-period comparison; fees and trades come from the original path',
                )}
              </caption>
              <thead>
                <tr>
                  {[
                    t('期間與涵蓋', 'Period and coverage'),
                    t('報酬（%）', 'Return (%)'),
                    t('最大回撤（%）', 'Maximum drawdown (%)'),
                    t('資產增減', 'NAV change'),
                    t('模擬費用', 'Simulated fees'),
                    t('成交明細筆數', 'Trade legs'),
                    t('雙邊周轉率（%）', 'Two-sided turnover (%)'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evidence.segments.map((segment) => (
                  <tr key={segment.segment}>
                    <th scope="row">
                      {t('第', 'Segment ')}
                      {segment.segment}
                      {t('段', '')}
                      <span>
                        {segment.window.start ?? '—'} → {segment.window.end ?? '—'}
                      </span>
                      <span>
                        {segment.coverage.covered_sessions}/{segment.coverage.required_sessions} ·{' '}
                        {t('已觀察', 'Observed')} {segment.coverage.observed_sessions}
                      </span>
                    </th>
                    <td>{metric(segment.metrics?.return_pct)}</td>
                    <td>{metric(segment.metrics?.max_drawdown_pct)}</td>
                    <td>{metric(segment.metrics?.net_change)}</td>
                    <td>{metric(segment.metrics?.total_fees)}</td>
                    <td>{metric(segment.metrics?.trade_count, 0)}</td>
                    <td>{metric(segment.metrics?.turnover_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="research-note">
            {t(
              '周轉率＝買入加賣出的成交金額 ÷ 該段期初資產；不除以二、不年化。成交筆數計個別買賣明細。各段回撤不相加，報酬也不直接相加。',
              'Turnover = buy plus sell notional / period boundary NAV; no halving or annualization. Trade count means individual buy/sell legs. Neither drawdowns nor simple returns add across periods.',
            )}
          </p>
          <div className="workflow-segment-curves">
            {evidence.segments.map((segment) => (
              <figure key={segment.segment}>
                <figcaption>
                  <strong>
                    {t('第', 'Segment ')}
                    {segment.segment}
                    {t('段', '')}
                  </strong>
                  <span>
                    {t('期初邊界', 'Boundary')}: {segment.window.boundary_date ?? '—'} ·{' '}
                    {metric(segment.metrics?.boundary_value)}
                  </span>
                  <span>
                    {t('期末資產', 'Ending NAV')}: {metric(segment.metrics?.final_value)}
                  </span>
                </figcaption>
                {segment.normalized_curve.length === 64 ? (
                  <svg
                    viewBox="0 0 600 165"
                    role="img"
                    aria-label={`${t('第', 'Segment ')}${segment.segment}${t('段標準化資產曲線', ' normalized equity curve')}`}
                  >
                    <line
                      x1="0"
                      y1={y(100)}
                      x2="600"
                      y2={y(100)}
                      className="workflow-segment-boundary"
                    />
                    <polyline
                      points={segment.normalized_curve
                        .map((point) => `${(point.session / 63) * 600},${y(point.index_value)}`)
                        .join(' ')}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                ) : (
                  <p className="notice">{t('沒有可用的分段曲線', 'Segment curve unavailable')}</p>
                )}
                <p>
                  {t('原路徑交易日', 'Original path sessions')} {segment.window.first_path_session}–
                  {segment.window.last_path_session} · {t('已知決策', 'Known decisions')}{' '}
                  {segment.coverage.known_decisions}
                </p>
              </figure>
            ))}
          </div>
          <p>
            {t(
              '四張圖使用同一尺度，期初邊界標準化為 100；只是顯示換算，不重設實際模擬本金。',
              'All four charts share a scale, with the boundary normalized to 100. This changes display units only; simulated capital is never reset.',
            )}{' '}
            {t('共同範圍', 'Shared range')}: {metric(low)}–{metric(high)}
          </p>
          <details className="agent-method">
            <summary>
              {t('來源、核對差額與限制', 'Sources, reconciliation residuals, and limitations')}
            </summary>
            <p>
              {evidence.baseline.window.signal_start ?? '—'} → {evidence.as_of} ·{' '}
              <code>{evidence.engine_version}</code>
            </p>
            <p>
              {t('原路徑證據指紋', 'Original path evidence fingerprint')}:{' '}
              <code>{evidence.baseline_evidence_fingerprint}</code>
            </p>
            <p>
              {t('分段證據指紋', 'Segment evidence fingerprint')}:{' '}
              <code>{evidence.evidence_fingerprint}</code>
            </p>
            <p>
              {t('連乘核對差額（百分點）', 'Chain residual (percentage points)')}:{' '}
              {metric(evidence.reconciliation?.return_residual_pp, 12)}
            </p>
            <ul>
              {evidence.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p>
              {t(
                '下載包含完整原路徑、分段、日期與覆蓋資訊；當次來源有效不代表離線開啟時仍當期。',
                'The download includes the complete original path, segments, dates, and coverage. Validity at capture does not establish freshness when opened offline.',
              )}
            </p>
          </details>
        </>
      )}
    </section>
  )
}
