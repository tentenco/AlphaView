import { useEffect, useRef, useState } from 'react'
import type { AgentRun, AgentStrategy } from './portfolio-agent-model'
import { num } from './ui'
import { downloadWorkflowEvidenceJson, workflowEvidenceJson } from './workflow-evidence-json'

type Translate = (zh: string, en: string) => string
type EvidenceItem = {
  symbol: string
  rule: AgentStrategy
  weight: number
  status: 'evaluated' | 'unavailable'
  verdict: 'pass' | 'warn' | 'fail' | null
  code: string | null
  reasons: string[]
  window: { start: string; end: string; sessions: number } | null
  closed_trades: number | null
  consistency: number | null
  ci95: [number, number] | null
  probability: number | null
  unavailable_tests: { test: string; reason: string }[]
}
export type WorkflowEvidence = {
  engine_version: string
  validation_engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  rule_fingerprint: string
  evidence_fingerprint: string
  as_of: string
  input_revision: string
  mode: 'advisory_only'
  request: { symbols: string[]; trials: number; test_start: string; test_end: string }
  uninspected_symbols: string[]
  coverage: {
    required_pairs: number
    requested_pairs: number
    evaluated_pairs: number
    fully_available_pairs: number
    unavailable_pairs: number
    uninspected_pairs: number
  }
  items: EvidenceItem[]
  method: string
  warnings: string[]
}
const metric = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, 4) : '—'
const rules = (t: Translate): Record<AgentStrategy, string> => ({
  turtle: t('海龜突破', 'Turtle breakout'),
  trend: t('趨勢追蹤', 'Trend following'),
  pullback: t('強勢回調', 'Pullback'),
  rps: t('相對強度', 'Relative strength'),
})
const missing = (code: string, t: Translate) =>
  ({
    unsupported_cross_sectional_rule: t(
      'RPS 需要跨標的排名，無單一標的驗證',
      'RPS needs cross-sectional ranks; no single-symbol validation',
    ),
    history_limit: t('超過 3000 筆本機日線計算上限', 'More than the 3000-bar local history limit'),
    history_stale: t('缺少當期本機日線', 'Current local bars are missing'),
    no_history: t('沒有本機日線', 'No local bars'),
    insufficient_history: t('暖機或測試期間不足', 'Insufficient warmup or test history'),
    invalid_history: t('本機日線未通過品質檢查', 'Local bars failed quality checks'),
    insufficient_traded_folds: t('有成交的分段不足', 'Too few folds with trades'),
    insufficient_trades: t('平倉交易不足 10 筆', 'Fewer than 10 closed trades'),
    insufficient_sessions: t('日報酬不足 30 日', 'Fewer than 30 daily returns'),
    zero_volatility: t('波動為零，無法估計', 'Zero volatility; cannot estimate'),
    invalid_moments: t('報酬分布無法估計', 'Return moments could not be estimated'),
  })[code] ?? code

export function WorkflowValidation({
  run,
  enabled,
  t,
}: {
  run: AgentRun
  enabled: boolean
  t: Translate
}) {
  const available = run.candidates
    .filter((item) => item.status === 'selected')
    .map((item) => item.symbol)
  const [symbols, setSymbols] = useState(() => available.slice(0, 5))
  const [trials, setTrials] = useState('1')
  const identity = JSON.stringify([
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    run.current,
    enabled,
    available,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const [accepted, setAccepted] = useState<{
    identity: string
    result: WorkflowEvidence
    rawJson: string
  } | null>(null)
  const result = accepted?.identity === identity ? accepted.result : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [sourceChecking, setSourceChecking] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const validTrials = /^\d+$/.test(trials) && Number(trials) >= 1 && Number(trials) <= 500
  const currentRun = (value: AgentRun) =>
    value.current === true &&
    value.id === run.id &&
    value.proposal_fingerprint === run.proposal_fingerprint &&
    value.input_revision === run.input_revision &&
    value.as_of === run.as_of
  const sourceMessage = t(
    '驗證來源已變更或無法核對；這份證據已停用，請重新檢查工作流。',
    'The validation source changed or could not be checked. This evidence is inactive; recheck the workflow.',
  )
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    operation.current?.abort()
    operation.current = null
    setBusy(false)
    resetEvidence()
  }, [identity])
  useEffect(() => {
    if (!result) return
    const controller = new AbortController()
    const token = generation.current
    let running = false
    const check = async () => {
      if (running || operation.current || document.visibilityState === 'hidden') return
      running = true
      setSourceChecking(true)
      try {
        const response = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !currentRun((await response.json()) as AgentRun))
          throw new Error('stale')
      } catch {
        if (!controller.signal.aborted && token === generation.current) {
          setAccepted(null)
          setStale(true)
        }
      } finally {
        running = false
        if (!controller.signal.aborted && token === generation.current) setSourceChecking(false)
      }
    }
    const timer = window.setInterval(() => void check(), 30000)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [result])
  function resetEvidence() {
    generation.current++
    setAccepted(null)
    setError('')
    setStale(false)
    setSourceChecking(false)
  }
  async function validate() {
    if (operation.current || !enabled || !validTrials || !symbols.length) return
    const controller = new AbortController()
    operation.current = controller
    resetEvidence()
    const token = generation.current
    const matches = () =>
      !controller.signal.aborted &&
      operation.current === controller &&
      latestIdentity.current === identity &&
      generation.current === token
    setBusy(true)
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/validation`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            symbols,
            trials: Number(trials),
            expected_proposal_fingerprint: run.proposal_fingerprint,
            expected_input_revision: run.input_revision,
            expected_as_of: run.as_of,
          }),
        },
      )
      const rawJson = await response.text()
      const value = JSON.parse(rawJson)
      if (!matches()) return
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : typeof value.detail?.message === 'string'
              ? value.detail.message
              : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
        )
      workflowEvidenceJson(value, rawJson)
      if (
        value.agent_run_id !== run.id ||
        value.proposal_fingerprint !== run.proposal_fingerprint ||
        value.input_revision !== run.input_revision ||
        value.as_of !== run.as_of
      )
        throw new Error(sourceMessage)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !currentRun((await checked.json()) as AgentRun))
        throw new Error(sourceMessage)
      if (matches()) setAccepted({ identity, result: value as WorkflowEvidence, rawJson })
    } catch (err) {
      if (matches()) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (matches()) setBusy(false)
      if (operation.current === controller) operation.current = null
    }
  }
  const currentResult =
    result &&
    !stale &&
    enabled &&
    run.current !== false &&
    result.agent_run_id === run.id &&
    result.proposal_fingerprint === run.proposal_fingerprint &&
    result.input_revision === run.input_revision &&
    result.as_of === run.as_of
      ? result
      : null
  function download() {
    if (!currentResult || !accepted || busy || operation.current || sourceChecking) return
    try {
      downloadWorkflowEvidenceJson(currentResult, accepted.rawJson)
    } catch {
      setError(
        t(
          '無法下載這份驗證證據，請重新檢查後再試。',
          'This evidence could not be downloaded. Inspect the rules again and retry.',
        ),
      )
    }
  }
  return (
    <section
      className="agent-panel workflow-validation"
      aria-label={t('工作流規則驗證', 'Workflow rule evidence')}
    >
      <h2>{t('工作流規則驗證（僅供研究）', 'Workflow rule evidence (advisory only)')}</h2>
      <p className="research-note">
        {t(
          '逐一檢查已保存工作流的啟用規則，不代表共識分數或配置器通過驗證。不改權重、不擋下提案，也不保存到紙上提案。',
          'Checks the saved workflow’s enabled rules independently. It does not validate the consensus score or allocator, change weights, gate proposals, or become saved proposal evidence.',
        )}
      </p>
      <p>
        {t(
          '固定設定：最近 252 個完成交易日、4 段；每條規則獨立使用 100,000 起始現金、100% 部位、10 bps 費用、0 bps 滑價，無額外停損或停利。每次最多 5 檔，每檔最多 3000 筆本機日線；RPS 保留為不可用。',
          'Fixed settings: latest 252 completed sessions, 4 folds; each rule uses 100,000 starting cash, a 100% position, 10 bps fees, 0 bps slippage, no added stop or take-profit. Up to 5 symbols per request and 3000 local bars per symbol; RPS remains unavailable.',
        )}
      </p>
      <fieldset className="workflow-fieldset" disabled={busy || !enabled}>
        <legend>
          {t('從已選入標的挑選，最多 5 檔', 'Choose up to 5 symbols selected by this run')}
        </legend>
        <div className="actions">
          {available.map((symbol) => (
            <label key={symbol}>
              <input
                type="checkbox"
                checked={symbols.includes(symbol)}
                disabled={!symbols.includes(symbol) && symbols.length >= 5}
                onChange={(event) => {
                  setSymbols((current) =>
                    event.target.checked
                      ? [...current, symbol]
                      : current.filter((item) => item !== symbol),
                  )
                  resetEvidence()
                }}
              />{' '}
              {symbol}
            </label>
          ))}
        </div>
        <label className="agent-field">
          {t('已比較設定次數（trials，1–500）', 'Settings tried (trials, 1–500)')}
          <input
            type="number"
            min="1"
            max="500"
            step="1"
            value={trials}
            onChange={(event) => {
              setTrials(event.target.value)
              resetEvidence()
            }}
          />
        </label>
      </fieldset>
      {!enabled && (
        <p className="notice">
          {t('請先取得當期可用的已保存工作流。', 'A current saved workflow is required.')}
        </p>
      )}
      {symbols.length < available.length && (
        <p className="notice">
          {t('僅檢查部分標的，未檢查：', 'Partial run coverage; not inspected:')}{' '}
          {available.filter((symbol) => !symbols.includes(symbol)).join(' · ')}
        </p>
      )}
      <button
        type="button"
        className="button"
        disabled={busy || !enabled || !validTrials || !symbols.length}
        onClick={validate}
      >
        {busy
          ? t('檢查規則中…', 'Checking rules…')
          : t('檢查選定標的的啟用規則', 'Inspect enabled rules for selected symbols')}
      </button>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {stale && (
        <p className="notice" role="status">
          {sourceMessage}
        </p>
      )}
      {currentResult && (
        <>
          <p>
            {t('標的 × 啟用規則覆蓋', 'Symbol × enabled-rule coverage')}:{' '}
            {currentResult.coverage.evaluated_pairs}/{currentResult.coverage.required_pairs}{' '}
            {t('已計算；所有檢定可用', 'evaluated; all tests available')}:{' '}
            {currentResult.coverage.fully_available_pairs}/{currentResult.coverage.required_pairs}
            {' · '}
            {t('不可用', 'Unavailable')}: {currentResult.coverage.unavailable_pairs}
            {' · '}
            {t('未檢查', 'Not inspected')}: {currentResult.coverage.uninspected_pairs}
          </p>
          <p>
            {currentResult.request.test_start} → {currentResult.request.test_end} · trials{' '}
            {currentResult.request.trials}
          </p>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={busy || sourceChecking}
              onClick={download}
            >
              {t('下載目前驗證 JSON', 'Download current evidence JSON')}
            </button>
          </div>
          <p className="research-note">
            {t(
              '下載保留這次來源與缺口，供離線檢閱；不代表日後仍當期，也不是組合通過驗證。',
              'The download preserves this evidence and its gaps for offline review. It does not establish future freshness or validate the combined portfolio.',
            )}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('標的／規則', 'Symbol / rule'),
                    t('保存權重', 'Saved score weight'),
                    t('單項結論', 'Standalone verdict'),
                    t('平倉筆數', 'Closed trades'),
                    t('分段一致性', 'Fold consistency'),
                    t('平均交易報酬 95% 區間', 'Mean trade return 95% interval'),
                    t('Sharpe 機率', 'Sharpe probability'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {currentResult.items.map((item) => (
                  <tr key={`${item.symbol}:${item.rule}`}>
                    <th scope="row">
                      {item.symbol} · {rules(t)[item.rule]}
                      {item.window && (
                        <small>
                          {item.window.start} → {item.window.end} · {item.window.sessions}{' '}
                          {t('交易日', 'sessions')}
                        </small>
                      )}
                    </th>
                    <td>{metric(item.weight)}%</td>
                    <td className="workflow-reason-cell">
                      {item.verdict
                        ? {
                            pass: t('通過', 'Pass'),
                            warn: t('保留', 'Warn'),
                            fail: t('未通過', 'Fail'),
                          }[item.verdict]
                        : t('不可用', 'Unavailable')}
                      {!!item.unavailable_tests.length && (
                        <ul>
                          {item.unavailable_tests.map((gap) => (
                            <li key={gap.test}>
                              {gap.test}: {missing(gap.reason, t)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {!!item.reasons.length && (
                        <details>
                          <summary>{t('單項理由', 'Rule reasons')}</summary>
                          <ul>
                            {item.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td>{item.closed_trades == null ? '—' : num(item.closed_trades, 0)}</td>
                    <td>{metric(item.consistency)}</td>
                    <td>
                      {item.ci95 ? `${metric(item.ci95[0])}% – ${metric(item.ci95[1])}%` : '—'}
                    </td>
                    <td>{metric(item.probability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="agent-method">
            <summary>{t('來源與限制', 'Provenance and limits')}</summary>
            <p>
              {currentResult.engine_version} · {currentResult.validation_engine_version} ·{' '}
              {currentResult.as_of}
            </p>
            <p>
              {t('輸入版本', 'Input revision')}: {currentResult.input_revision}
            </p>
            <p>
              {t('保存規則指紋', 'Saved rule fingerprint')}:{' '}
              <code className="workflow-json">{currentResult.rule_fingerprint}</code>
            </p>
            <p>
              {t('驗證證據指紋', 'Validation evidence fingerprint')}:{' '}
              <code className="workflow-json">{currentResult.evidence_fingerprint}</code>
            </p>
            <p>{currentResult.method}</p>
            <ul>
              {currentResult.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
