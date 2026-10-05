import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import { num } from './ui'
import type { PaperAccount } from './paper-model'
import { AllocationResearchReceipts } from './AllocationResearchReceipts'

type Translate = (zh: string, en: string) => string
type Risk = {
  status: 'calculated' | 'unavailable'
  reason: string | null
  volatility_annualized_pct: number | null
  contributions_annualized_pct: (number | null)[]
  risk_shares_pct: (number | null)[]
  max_equal_risk_share_error: number | null
}
type Scenario = {
  status: 'calculated' | 'unavailable'
  reason: string | null
  weights: { symbol: string; raw_weight_pct: number; capped_weight_pct: number }[]
  invested_before_pct: number | null
  invested_after_pct: number | null
  cash_before_pct: number | null
  cash_after_pct: number | null
  capped_or_rounded_to_cash_pct: number | null
  risk_before: Risk | null
  risk_after: Risk | null
}
export type AllocationResearchEvidence = {
  engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  input_revision: string
  as_of: string
  evidence_fingerprint: string
  status: 'calculated' | 'unavailable'
  reasons: { code: string; symbol?: string }[]
  request: { lookback_sessions: number }
  selected_symbols: string[]
  ranking: { rank: number; symbol: string; score: number; matched_count: number }[]
  invested_budget_pct: number
  position_cap_pct: number
  window: { price_dates: string[]; return_dates: string[]; lookback_sessions: number }
  coverage: {
    required_symbols: number
    complete_symbols: number
    required_closes: number
    valid_closes: number
    required_return_sessions: number
    common_return_sessions: number
    per_symbol: {
      symbol: string
      required_closes: number
      valid_closes: number
      valid_returns: number
      missing_dates: string[]
      invalid_dates: string[]
      status: string
    }[]
  }
  covariance_annualized: number[][] | null
  correlation: number[][] | null
  matrix_diagnostics: {
    min_eigenvalue: number | null
    max_eigenvalue: number | null
    eigenvalue_ratio: number | null
    condition_number: number | null
    required_eigenvalue_ratio_gt: number
  } | null
  solver: {
    converged: boolean
    sweeps: number
    max_sweeps: number
    max_risk_share_error: number | null
    risk_share_tolerance: number
    reason: string | null
  } | null
  methods: { rank_sum: Scenario; equal_risk_contribution: Scenario }
  method: string
  sources: { title: string; url: string; section: string }[]
}
const metric = (value: number | null | undefined, precision = 4) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, precision) : '—'
const scientific = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toExponential(4) : '—'
const reasonLabel = (code: string, t: Translate) =>
  ({
    calendar_unavailable: t('交易日曆不可用', 'Session calendar unavailable'),
    history_incomplete: t('缺少必要日期的調整收盤', 'Required adjusted closes are missing'),
    invalid_adjusted_close: t('調整收盤無效或非有限', 'Adjusted closes are invalid or nonfinite'),
    zero_invested_budget: t('保存的投入預算為零', 'Saved invested budget is zero'),
    zero_variance: t('至少一個標的的樣本變異為零', 'At least one symbol has zero sample variance'),
    nonfinite_covariance: t('共變異矩陣含非有限值', 'Covariance contains nonfinite values'),
    singular_or_ill_conditioned_covariance: t(
      '共變異矩陣奇異或數值條件不足',
      'Covariance is singular or ill-conditioned',
    ),
    covariance_eigendecomposition_failed: t(
      '共變異特徵值無法計算',
      'Covariance eigenvalues could not be calculated',
    ),
    solver_nonconvergence: t('求解未在限定次數內收斂', 'Solver did not converge within its limit'),
    solver_nonfinite: t('求解產生不可用數值', 'Solver produced unavailable values'),
    nonpositive_portfolio_variance: t('組合變異不是正數', 'Portfolio variance is not positive'),
  })[code] ?? code

export function AllocationResearch({
  account,
  run,
  enabled,
  t,
}: {
  account: PaperAccount
  run: AgentRun
  enabled: boolean
  t: Translate
}) {
  const id = useId()
  const [lookback, setLookback] = useState('60')
  const [state, setState] = useState<{
    identity: string
    result?: AllocationResearchEvidence
    error?: string
    busy?: boolean
    stale?: boolean
  } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const available = enabled && run.saved && run.status === 'proposed' && run.current !== false
  const validLookback = /^\d+$/.test(lookback) && Number(lookback) >= 20 && Number(lookback) <= 120
  const identity = JSON.stringify([
    account.id,
    account.version,
    run.id,
    run.proposal_fingerprint,
    run.input_revision,
    run.as_of,
    available,
    lookback,
  ])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const visible = state?.identity === identity ? state : null
  const result = visible?.result
  const sourceMessage = t(
    '工作流來源已變更或無法核對；請重新檢查工作流。',
    'The workflow source changed or could not be checked. Recheck the workflow.',
  )
  const currentRun = (value: AgentRun) =>
    value.current === true &&
    value.status === 'proposed' &&
    value.id === run.id &&
    value.proposal_fingerprint === run.proposal_fingerprint &&
    value.input_revision === run.input_revision &&
    value.as_of === run.as_of
  useEffect(() => {
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [identity])
  useEffect(() => {
    if (!result || visible?.stale) return
    const controller = new AbortController()
    let checking = false
    const check = async () => {
      if (checking || operation.current || document.visibilityState === 'hidden') return
      checking = true
      try {
        const response = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok || !currentRun((await response.json()) as AgentRun))
          throw new Error(sourceMessage)
      } catch {
        if (!controller.signal.aborted && currentIdentity.current === identity)
          setState((previous) =>
            previous?.identity === identity
              ? { ...previous, stale: true, error: sourceMessage }
              : previous,
          )
      } finally {
        checking = false
      }
    }
    const timer = window.setInterval(() => void check(), 30000)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [identity, result, visible?.stale])
  async function compare() {
    if (!available || !validLookback || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setState({ identity, busy: true })
    try {
      const response = await fetch(
        `/api/portfolio-agent/runs/${encodeURIComponent(run.id)}/allocation-research`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
          body: JSON.stringify({
            expected_proposal_fingerprint: run.proposal_fingerprint,
            expected_input_revision: run.input_revision,
            expected_as_of: run.as_of,
            lookback_sessions: Number(lookback),
          }),
        },
      )
      const value = await response.json()
      if (controller.signal.aborted || currentIdentity.current !== identity) return
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? sourceMessage
            : typeof value.detail?.message === 'string'
              ? value.detail.message
              : t(
                  '配置研究無法完成，請重新檢查來源。',
                  'Allocation research could not complete. Recheck the source.',
                ),
        )
      if (
        value.agent_run_id !== run.id ||
        value.proposal_fingerprint !== run.proposal_fingerprint ||
        value.input_revision !== run.input_revision ||
        value.as_of !== run.as_of ||
        value.request?.lookback_sessions !== Number(lookback)
      )
        throw new Error(sourceMessage)
      const checked = await fetch(`/api/portfolio-agent/runs/${encodeURIComponent(run.id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!checked.ok || !currentRun((await checked.json()) as AgentRun))
        throw new Error(sourceMessage)
      if (!controller.signal.aborted && currentIdentity.current === identity)
        setState({ identity, result: value as AllocationResearchEvidence })
    } catch (error) {
      if (!controller.signal.aborted && currentIdentity.current === identity)
        setState({ identity, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  return (
    <section
      className="agent-panel"
      aria-label={t('排名與風險貢獻研究', 'Rank and risk contribution research')}
    >
      <h2>{t('排名與風險貢獻研究', 'Rank and risk contribution research')}</h2>
      <p className="research-note">
        {t(
          '比較保存工作流的相同入選標的與已投入預算，計算排名加權及完整共變異矩陣下的等風險貢獻。這不是組合績效驗證，不改主動配置或提案。',
          'Compares rank weighting and full-covariance equal risk contribution for the saved workflow’s same selected symbols and invested budget. This does not validate portfolio performance or change the active allocation or proposal.',
        )}
      </p>
      <p>
        {t(
          '需要每個日期完整的調整收盤；不刪除缺值、不以反波動替代。單檔上限與取位餘額留現金，不重分配。',
          'Requires complete adjusted closes on every date; no dropped missing values or inverse-volatility fallback. Position caps and rounding leave excess cash without redistribution.',
        )}
      </p>
      <label htmlFor={id} className="agent-field">
        {t('研究回看交易日（20–120）', 'Research lookback sessions (20–120)')}
        <input
          id={id}
          type="number"
          min="20"
          max="120"
          step="1"
          value={lookback}
          onChange={(event) => setLookback(event.target.value)}
        />
      </label>
      {!validLookback && (
        <p role="alert">{t('請輸入 20 到 120 的整數。', 'Enter an integer from 20 to 120.')}</p>
      )}
      {!available && (
        <p>
          {t(
            '需先開啟來源仍有效的已保存工作流。',
            'Open a saved workflow whose source is still current.',
          )}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          disabled={!available || !validLookback || !!visible?.busy}
          onClick={() => void compare()}
        >
          {visible?.busy
            ? t('計算配置研究…', 'Calculating allocation research…')
            : t('比較排名與等風險貢獻', 'Compare rank and equal risk contribution')}
        </button>
        {visible?.busy && (
          <button
            className="text-button"
            onClick={() => {
              operation.current?.abort()
              operation.current = null
              setState(null)
            }}
          >
            {t('取消研究', 'Cancel research')}
          </button>
        )}
      </div>
      {visible?.error && (
        <p role="alert" className="error-message">
          {visible.error}
        </p>
      )}
      {result && !visible?.stale && <AllocationResearchEvidenceView result={result} t={t} />}
      <AllocationResearchReceipts
        key={account.id}
        account={account}
        run={run}
        evidence={result ?? null}
        canSave={available && !!result && !visible?.stale}
        t={t}
        renderEvidence={(saved) => <AllocationResearchEvidenceView result={saved} t={t} />}
      />
    </section>
  )
}

export function AllocationResearchEvidenceView({
  result,
  t,
}: {
  result: AllocationResearchEvidence
  t: Translate
}) {
  return (
    <>
      <p>
        {t('來源交易日', 'Source session')}: {result.as_of} · {t('固定投入', 'Frozen investment')}:{' '}
        {metric(result.invested_budget_pct)}% · {t('單檔上限', 'Position cap')}:{' '}
        {metric(result.position_cap_pct)}%
      </p>
      <p>
        {t('完整標的', 'Complete symbols')}: {result.coverage.complete_symbols}/
        {result.coverage.required_symbols} · {t('有效收盤', 'Valid closes')}:{' '}
        {result.coverage.valid_closes}/{result.coverage.required_closes} ·{' '}
        {t('共同報酬日期', 'Common return dates')}: {result.coverage.common_return_sessions}/
        {result.coverage.required_return_sessions}
      </p>
      {result.status === 'unavailable' && (
        <p role="status">
          {t(
            '比較不可用；未產生替代配置。',
            'Comparison unavailable; no substitute allocation was produced.',
          )}
        </p>
      )}
      {!!result.reasons.length && (
        <ul>
          {result.reasons.map((reason, index) => (
            <li key={index}>
              {reason.symbol ? `${reason.symbol}: ` : ''}
              {reasonLabel(reason.code, t)}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>{t('日期覆蓋與固定排名', 'Date coverage and frozen ranks')}</summary>
        <p>
          {result.window.price_dates[0] ?? '—'} – {result.window.price_dates.at(-1) ?? '—'} ·{' '}
          {result.ranking
            .map((row) => `${row.rank}. ${row.symbol} (${row.score}, ${row.matched_count})`)
            .join(' · ')}
        </p>
        {result.coverage.per_symbol.map((row) => (
          <p key={row.symbol}>
            {row.symbol}: {row.valid_closes}/{row.required_closes} ·{' '}
            {t('缺少日期', 'Missing dates')}: {row.missing_dates.join(', ') || '—'} ·{' '}
            {t('無效日期', 'Invalid dates')}: {row.invalid_dates.join(', ') || '—'}
          </p>
        ))}
      </details>
      {(['rank_sum', 'equal_risk_contribution'] as const).map((name) => (
        <ResearchScenario key={name} name={name} value={result.methods[name]} t={t} />
      ))}
      {result.solver && (
        <p>
          {t('求解迭代', 'Solver sweeps')}: {result.solver.sweeps}/{result.solver.max_sweeps} ·{' '}
          {t('最大等風險比例誤差', 'Maximum equal-risk share error')}:{' '}
          {scientific(result.solver.max_risk_share_error)} ·{' '}
          {t('收斂容許值', 'Convergence tolerance')}:{' '}
          {scientific(result.solver.risk_share_tolerance)}
        </p>
      )}
      <p className="research-note">
        {t(
          '風險貢獻可以是負數，表示此樣本中的抵銷效果；不代表不會虧損。現金在模型中視為零風險，沒有估計報酬、費用或流動性。套用上限後不保證仍是等風險貢獻。',
          'Risk contributions can be negative, indicating offsetting effects in this sample, not protection from losses. Cash is modeled as zero risk; returns, fees and liquidity are not estimated. Caps can break equal risk contribution.',
        )}
      </p>
      <details>
        <summary>{t('共變異與相關矩陣', 'Covariance and correlation matrices')}</summary>
        <p>
          {t('矩陣順序', 'Matrix order')}: {result.selected_symbols.join(', ')} ·{' '}
          {t(
            '樣本共變異以 252 年化；相關係數無單位。',
            'Sample covariance is annualized by 252; correlation is unitless.',
          )}
        </p>
        {result.matrix_diagnostics && (
          <p>
            {t('最小／最大特徵值比', 'Minimum/maximum eigenvalue ratio')}:{' '}
            {scientific(result.matrix_diagnostics.eigenvalue_ratio)} ·{' '}
            {t('條件數', 'Condition number')}:{' '}
            {scientific(result.matrix_diagnostics.condition_number)}
          </p>
        )}
        <Matrix
          title={t('年化共變異', 'Annualized covariance')}
          values={result.covariance_annualized}
          symbols={result.selected_symbols}
          t={t}
        />
        <Matrix
          title={t('相關係數', 'Correlation')}
          values={result.correlation}
          symbols={result.selected_symbols}
          t={t}
        />
      </details>
      <details>
        <summary>{t('研究方法與來源', 'Research method and sources')}</summary>
        <p>{result.method}</p>
        <p>
          {result.engine_version} · {result.input_revision}
        </p>
        <p className="workflow-json">{result.evidence_fingerprint}</p>
        <ul>
          {result.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>{' '}
              · {source.section}
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}

function ResearchScenario({
  name,
  value,
  t,
}: {
  name: 'rank_sum' | 'equal_risk_contribution'
  value: Scenario
  t: Translate
}) {
  return (
    <section
      aria-label={
        name === 'rank_sum'
          ? t('排名加權', 'Rank sum')
          : t('完整共變異等風險貢獻', 'Full-covariance ERC')
      }
    >
      <h3>
        {name === 'rank_sum'
          ? t('排名加權', 'Rank sum')
          : t('完整共變異等風險貢獻', 'Full-covariance ERC')}
      </h3>
      {value.status === 'unavailable' ? (
        <p>
          {t('不可用', 'Unavailable')}: {reasonLabel(value.reason ?? '', t)}
        </p>
      ) : (
        <>
          <p>
            {t('現金：上限前 → 上限後', 'Cash: before → after caps')}:{' '}
            {metric(value.cash_before_pct)}% → {metric(value.cash_after_pct)}% ·{' '}
            {t('留在現金的額度', 'Excess retained as cash')}:{' '}
            {metric(value.capped_or_rounded_to_cash_pct)}%
          </p>
          <p>
            {t(
              '年化樣本波動：上限前 → 上限後',
              'Annualized sample volatility: before → after caps',
            )}
            : {metric(value.risk_before?.volatility_annualized_pct)}% →{' '}
            {metric(value.risk_after?.volatility_annualized_pct)}%
          </p>
          {value.risk_after?.reason && <p>{reasonLabel(value.risk_after.reason, t)}</p>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('標的', 'Symbol')}</th>
                  <th>{t('原始權重 %', 'Raw weight %')}</th>
                  <th>{t('上限後權重 %', 'Capped weight %')}</th>
                  <th>{t('風險貢獻前／後（百分點）', 'Risk contribution before / after (pp)')}</th>
                  <th>{t('風險占比前／後 %', 'Risk share before / after %')}</th>
                </tr>
              </thead>
              <tbody>
                {value.weights.map((row, index) => (
                  <tr key={row.symbol}>
                    <th scope="row">{row.symbol}</th>
                    <td>{metric(row.raw_weight_pct)}</td>
                    <td>{metric(row.capped_weight_pct)}</td>
                    <td>
                      {metric(value.risk_before?.contributions_annualized_pct[index])} /{' '}
                      {metric(value.risk_after?.contributions_annualized_pct[index])}
                    </td>
                    <td>
                      {metric(value.risk_before?.risk_shares_pct[index])} /{' '}
                      {metric(value.risk_after?.risk_shares_pct[index])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function Matrix({
  title,
  values,
  symbols,
  t,
}: {
  title: string
  values: number[][] | null
  symbols: string[]
  t: Translate
}) {
  return (
    <div>
      <h4>{title}</h4>
      {values ? (
        <div className="table-scroll">
          <table className="data-table" aria-label={title}>
            <thead>
              <tr>
                <th>{t('標的', 'Symbol')}</th>
                {symbols.map((symbol) => (
                  <th key={symbol}>{symbol}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {values.map((row, index) => (
                <tr key={symbols[index]}>
                  <th scope="row">{symbols[index]}</th>
                  {row.map((value, column) => (
                    <td key={symbols[column]}>{scientific(value)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t('不可用', 'Unavailable')} —</p>
      )}
    </div>
  )
}
