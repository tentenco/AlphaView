import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import { num } from './ui'
import { WorkflowPathReceipts } from './WorkflowPathReceipts'
import { downloadWorkflowEvidenceJson } from './workflow-evidence-json'
import './workflow-path-validation.css'

type Translate = (zh: string, en: string) => string
type Reason = { code: string; symbol?: string; date?: string; message?: string }
export type WorkflowPathEvidence = {
  engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  as_of: string
  input_revision: string
  settings_fingerprint: string
  history_fingerprint: string | null
  evidence_fingerprint: string
  status: 'evaluated' | 'unavailable'
  current_at_snapshot: boolean
  candidate_symbols: string[]
  rps_universe: string[]
  reasons: Reason[]
  window: { start: string; end: string; signal_start: string; sessions: number }
  coverage: {
    required_decisions: number
    evaluated_decisions: number
    available_decisions: number
    required_path_sessions: number
    valued_path_sessions: number
  }
  metrics: {
    initial_cash: number
    final_value: number
    return_pct: number
    max_drawdown_pct: number
    total_fees: number
    traded_notional: number
    trade_count: number
  } | null
  curve: { date: string; value: number; cash: number; exposure_pct: number }[]
  decisions: {
    signal_date: string
    trade_date: string
    status: 'rebalance' | 'hold_no_candidates' | 'unavailable'
    targets: { symbol: string; weight_pct: number }[]
    cash_weight_pct: number | null
    reasons: Reason[]
  }[]
  events: {
    signal_date: string
    trade_date: string
    fee: number
    cash: number
    trades: {
      symbol: string
      side: string
      shares: number
      raw_open: number
      notional: number
      fee: number
    }[]
  }[]
  method: string
  warnings: string[]
}
const metric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const reasonLabel = (code: string, t: Translate) =>
  ({
    calendar_unavailable: t('交易日曆不可用', 'Session calendar unavailable'),
    candidate_limit: t('候選超過 30 檔上限', 'More than the 30-candidate limit'),
    peer_limit: t(
      '完整 RPS 股票池超過 100 檔上限',
      'The complete RPS universe exceeds 100 symbols',
    ),
    no_history: t('沒有本機日線', 'No local bars'),
    history_limit: t('超過 3000 筆本機日線上限', 'More than the 3000-bar local history limit'),
    saved_rps_universe_missing: t('保存的 RPS 股票池不可用', 'Saved RPS universe unavailable'),
    saved_rps_universe_invalid: t('保存的 RPS 股票池不完整', 'Saved RPS universe is incomplete'),
    insufficient_rps_peers: t('RPS 比較標的不足 3 檔', 'RPS needs at least three peers'),
    rps_peer_unavailable: t('必要 RPS 比較標的不可用', 'Required RPS peer unavailable'),
    decision_evidence_incomplete: t(
      '歷史決策證據不完整',
      'Historical decision evidence is incomplete',
    ),
    enabled_strategy_unavailable: t('啟用策略訊號不可用', 'Enabled strategy signal unavailable'),
    candidate_data_error: t('候選日線品質未通過', 'Candidate bars failed quality checks'),
    candidate_history_unavailable: t(
      '候選缺少當日日線',
      'Candidate bars are missing for this date',
    ),
    adjusted_close_unavailable: t('調整收盤不可用', 'Adjusted close unavailable'),
    current_quote_unavailable: t('當日未調整行情不可用', 'Raw bars unavailable for this date'),
    allocation_unavailable: t('歷史配置所需資料不可用', 'Historical allocator inputs unavailable'),
    valuation_bar_unavailable: t(
      '持倉估值或成交行情不可用',
      'Holding valuation or fill bars unavailable',
    ),
    held_corporate_action_unmodeled: t(
      '持有期間調整因子變動，無法重建公司行動帳務',
      'A held adjustment factor changed; corporate-action accounting cannot be reconstructed',
    ),
    invalid_adjustment_factor: t('調整因子無效', 'Invalid adjustment factor'),
    nonfinite_accounting: t('模擬帳務數值不可用', 'Simulation accounting values unavailable'),
    invalid_target_weights: t('歷史目標權重無效', 'Invalid historical target weights'),
  })[code] ?? code

export function WorkflowPathValidation({
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
  const available = enabled && run.saved && run.current !== false && run.status === 'proposed'
  const identity = JSON.stringify([
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    available,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const [state, setState] = useState<{
    identity: string
    result?: WorkflowPathEvidence
    rawJson?: string
    busy?: boolean
    stale?: boolean
    error?: string
  } | null>(null)
  const [checking, setChecking] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const active = state?.identity === identity ? state : null
  const evidence = active?.result && !active.stale && available ? active.result : null
  const sourceMessage = t(
    '路徑來源已變更或無法核對；請重新檢查工作流。',
    'The path source changed or could not be checked. Recheck the workflow.',
  )
  const currentRun = (value: AgentRun) =>
    value.current === true &&
    value.id === run.id &&
    value.proposal_fingerprint === run.proposal_fingerprint &&
    value.input_revision === run.input_revision &&
    value.as_of === run.as_of

  useEffect(() => {
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

  async function validate() {
    if (!available || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setChecking(false)
    setState({ identity, busy: true })
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/path-validation`,
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
      let value
      try {
        value = JSON.parse(rawJson)
      } catch {
        value = {}
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : typeof value.detail?.message === 'string'
              ? value.detail.message
              : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
        )
      if (controller.signal.aborted || latestIdentity.current !== identity) return
      if (
        value.agent_run_id !== run.id ||
        value.proposal_fingerprint !== run.proposal_fingerprint ||
        value.input_revision !== run.input_revision ||
        value.as_of !== run.as_of ||
        value.current_at_snapshot !== true
      )
        throw new Error(sourceMessage)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !currentRun((await checked.json()) as AgentRun))
        throw new Error(sourceMessage)
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState({ identity, result: value as WorkflowPathEvidence, rawJson })
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
      active?.rawJson === undefined ||
      checking ||
      operation.current ||
      latestIdentity.current !== identity
    )
      return
    try {
      downloadWorkflowEvidenceJson(evidence, active.rawJson)
    } catch {
      setState((previous) =>
        previous?.identity === identity
          ? { ...previous, error: t('路徑證據下載失敗', 'Path evidence download failed') }
          : previous,
      )
    }
  }
  const values = evidence?.curve.map((point) => point.value) ?? []
  const finiteCurve = values.length > 1 && values.every(Number.isFinite)
  const low = finiteCurve ? Math.min(100000, ...values) : 0
  const high = finiteCurve ? Math.max(100000, ...values) : 0
  const range = high - low || 1
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 600},${150 - ((value - low) / range) * 140}`,
    )
    .join(' ')
  const reasons = (items: Reason[]) => (
    <ul>
      {items.map((item, index) => (
        <li key={`${item.code}:${item.symbol ?? ''}:${index}`}>
          {item.symbol} {item.date} {reasonLabel(item.code, t)}
        </li>
      ))}
    </ul>
  )
  return (
    <section className="agent-panel workflow-path-validation" aria-labelledby={labelId}>
      <h3 id={labelId}>{t('保存設定的歷史路徑', 'Historical path of saved settings')}</h3>
      <p className="research-note">
        {t(
          '以全部保存候選重新選股，固定回看 252 個交易日、每 21 日決策、次日開盤成交。候選清單與股票池含事後選擇偏差，這不是歷史當時股票池的策略回測。',
          'Reselect from every saved candidate over 252 sessions, decide every 21 sessions, and fill at the next open. The fixed candidates and universe carry hindsight bias; this is not a point-in-time universe strategy backtest.',
        )}
      </p>
      <p>
        {t(
          '模擬資金 100,000 · 單邊費用 10 bps · 滑價 0 · 原設定配置器 · 未調整收盤估值。沒有符合候選時保留原部位；持有期間調整因子變動則停止計算。',
          'Initial cash 100,000 · one-way fees 10 bps · zero slippage · saved allocator · raw-close valuation. No eligible candidate leaves holdings unchanged; a held adjustment-factor change stops the calculation.',
        )}
      </p>
      <p>
        {t('保存候選', 'Saved candidates')}: {run.request.candidate_symbols.join(' · ')}
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
          onClick={validate}
        >
          {active?.busy
            ? t('計算歷史路徑中…', 'Calculating historical path…')
            : t('檢查保存設定的歷史路徑', 'Inspect historical path of saved settings')}
        </button>
        {evidence && (
          <button className="button" type="button" disabled={checking} onClick={download}>
            {t('下載路徑證據 JSON', 'Download path evidence JSON')}
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
              ? t('路徑已計算，沒有通過／失敗結論', 'Path calculated; no pass/fail verdict')
              : t('路徑不可用，績效保留空值', 'Path unavailable; performance remains missing')}
          </p>
          <p>
            {evidence.window.start} → {evidence.window.end} · {t('完整決策', 'Complete decisions')}{' '}
            {evidence.coverage.available_decisions}/{evidence.coverage.required_decisions} ·{' '}
            {t('估值交易日', 'Valued sessions')} {evidence.coverage.valued_path_sessions}/
            {evidence.coverage.required_path_sessions}
          </p>
          {!!evidence.reasons.length && reasons(evidence.reasons)}
          <dl className="workflow-path-metrics">
            {[
              [t('模擬報酬（%）', 'Simulated return (%)'), metric(evidence.metrics?.return_pct)],
              [
                t('最大回撤（%）', 'Maximum drawdown (%)'),
                metric(evidence.metrics?.max_drawdown_pct),
              ],
              [t('期末模擬資產', 'Final simulated equity'), metric(evidence.metrics?.final_value)],
              [t('累計模擬費用', 'Total simulated fees'), metric(evidence.metrics?.total_fees)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {finiteCurve && (
            <figure className="workflow-path-chart">
              <svg
                viewBox="0 0 600 165"
                role="img"
                aria-label={t('模擬資產路徑', 'Simulated equity path')}
              >
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <figcaption>
                {t('資產值範圍', 'Equity range')}: {metric(low)} – {metric(high)}
              </figcaption>
            </figure>
          )}
          <div className="table-scroll">
            <table>
              <caption>{t('逐次歷史決策', 'Historical decisions')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('訊號 → 成交日', 'Signal → fill date')}</th>
                  <th scope="col">{t('結果與缺口', 'Result and gaps')}</th>
                  <th scope="col">{t('目標權重', 'Target weights')}</th>
                  <th scope="col">{t('目標現金（%）', 'Target cash (%)')}</th>
                </tr>
              </thead>
              <tbody>
                {evidence.decisions.map((decision) => (
                  <tr key={decision.signal_date}>
                    <th scope="row">
                      {decision.signal_date} → {decision.trade_date}
                    </th>
                    <td>
                      {decision.status === 'rebalance'
                        ? t('重新配置', 'Rebalance')
                        : decision.status === 'hold_no_candidates'
                          ? t('無符合候選，保留原部位', 'No eligible candidates; retain holdings')
                          : t('不可用', 'Unavailable')}
                      {!!decision.reasons.length && reasons(decision.reasons)}
                    </td>
                    <td>
                      {decision.targets.length
                        ? decision.targets
                            .map((target) => `${target.symbol} ${metric(target.weight_pct)}%`)
                            .join(' · ')
                        : '—'}
                    </td>
                    <td>{metric(decision.cash_weight_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!evidence.events.length && (
            <details className="agent-method">
              <summary>{t('逐筆模擬成交', 'Simulated fills')}</summary>
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
                        t('費用', 'Fee'),
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.events.flatMap((event) =>
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
                          <td>{metric(trade.fee, 4)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <details className="agent-method">
            <summary>{t('路徑來源與限制', 'Path provenance and limitations')}</summary>
            <p>
              {evidence.engine_version} · {evidence.as_of}
            </p>
            <p>
              {t('輸入版本', 'Input revision')}: {evidence.input_revision}
            </p>
            <p>
              {t('完整 RPS 股票池', 'Complete RPS universe')}:{' '}
              {evidence.rps_universe.join(' · ') || '—'}
            </p>
            <p>
              {t('設定指紋', 'Settings fingerprint')}: <code>{evidence.settings_fingerprint}</code>
            </p>
            <p>
              {t('歷史指紋', 'History fingerprint')}:{' '}
              <code>{evidence.history_fingerprint ?? '—'}</code>
            </p>
            <p>
              {t('路徑證據指紋', 'Path evidence fingerprint')}:{' '}
              <code>{evidence.evidence_fingerprint}</code>
            </p>
            <p>{evidence.method}</p>
            <ul>
              {evidence.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      <p className="research-note">
        {t(
          '這不是完整自動化績效、樣本外證明或提案閘門。不含模型、停損、市場風險覆蓋與實際成交限制；下載只保存當次證據，不保證日後仍當期。',
          'This is not full automation performance, out-of-sample proof, or a proposal gate. Models, stops, regime overlays, and execution constraints are excluded. Downloads preserve this observation and do not guarantee future freshness.',
        )}
      </p>
      <WorkflowPathReceipts
        account={account ?? null}
        run={run}
        kind="path_validation"
        evidence={evidence}
        request={
          evidence
            ? {
                expected_proposal_fingerprint: run.proposal_fingerprint,
                expected_input_revision: run.input_revision,
                expected_as_of: run.as_of,
              }
            : null
        }
        enabled={available && !checking && !active?.busy}
        t={t}
      />
    </section>
  )
}
