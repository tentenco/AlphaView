import { useState } from 'react'
import type { Translate } from './ResearchDesk'
import {
  deskPercent,
  deskRatio,
  type DeskConfig,
  type DeskRisk,
  type DeskValidation,
  type DeskValidationBatch,
} from './research-desk-model'

type Props = {
  symbol: string
  config: DeskConfig
  risk?: DeskRisk
  testStart?: string | null
  testEnd?: string | null
  symbols?: string[]
  t: Translate
}
const STATUS: Record<DeskValidation['verdict']['status'], [string, string, string]> = {
  pass: ['通過', 'Pass', 'desk-positive'],
  warn: ['保留', 'Warn', ''],
  fail: ['未通過', 'Fail', 'desk-negative'],
}
const REASONS: Record<string, [string, string]> = {
  insufficient_history: ['測試期間不足以切段', 'Not enough history to split into folds'],
  insufficient_traded_folds: ['有成交的段數不足', 'Too few folds with trades'],
  insufficient_trades: ['平倉交易少於 10 筆', 'Fewer than 10 closed trades'],
  insufficient_sessions: ['日報酬少於 30 筆', 'Fewer than 30 daily returns'],
  zero_volatility: ['日報酬無波動', 'Daily returns have zero volatility'],
  invalid_moments: ['偏態／峰度使估計無效', 'Skew/kurtosis make the estimate invalid'],
}
const reason = (code: string | null | undefined, t: Translate) =>
  code ? (REASONS[code] ? t(...REASONS[code]) : code) : ''
async function request<T = DeskValidation>(
  url: string,
  body: unknown,
  t: Translate,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (
      detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      typeof detail.message === 'string'
    )
      throw new Error(detail.message)
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}

export function ResearchDeskValidation({
  symbol,
  config,
  risk,
  testStart,
  testEnd,
  symbols,
  t,
}: Props) {
  const [folds, setFolds] = useState('4')
  const [trials, setTrials] = useState('1')
  const [result, setResult] = useState<DeskValidation | null>(null)
  const [batch, setBatch] = useState<DeskValidationBatch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const foldCount = Number(folds)
  const trialCount = Number(trials)
  const valid =
    Number.isInteger(foldCount) &&
    foldCount >= 2 &&
    foldCount <= 8 &&
    Number.isInteger(trialCount) &&
    trialCount >= 1 &&
    trialCount <= 500
  function run() {
    if (!valid || busy) return
    const controller = new AbortController()
    setBusy(true)
    setError('')
    request(
      '/api/research-desk/validate',
      {
        symbol,
        config,
        ...(risk ? { risk } : {}),
        test_start: testStart ?? null,
        test_end: testEnd ?? null,
        folds: foldCount,
        trials: trialCount,
      },
      t,
      controller.signal,
    )
      .then((value) => setResult(value))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const batchSymbols = (symbols ?? []).filter((item, index, list) => list.indexOf(item) === index)
  function runBatch() {
    if (!valid || busy || batchSymbols.length < 2) return
    const controller = new AbortController()
    setBusy(true)
    setError('')
    request<DeskValidationBatch>(
      '/api/research-desk/validate-batch',
      {
        symbols: batchSymbols,
        config,
        ...(risk ? { risk } : {}),
        test_start: testStart ?? null,
        test_end: testEnd ?? null,
        folds: foldCount,
        trials: trialCount,
      },
      t,
      controller.signal,
    )
      .then((value) => setBatch(value))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const verdict = result ? STATUS[result.verdict.status] : null
  return (
    <section className="desk-validation" aria-label={t('策略驗證閘', 'Strategy validation gate')}>
      <div className="section-heading">
        <div>
          <h3>{t('策略驗證閘', 'Strategy validation gate')}</h3>
          <p>
            {t(
              '同一組固定參數：走動式分段一致性、交易報酬 bootstrap 區間、機率化／去膨脹 Sharpe。只能證偽，不做最佳化。',
              'Same fixed parameters: walk-forward fold consistency, bootstrap interval of trade returns, probabilistic / deflated Sharpe. It can only falsify; nothing is optimised.',
            )}
          </p>
        </div>
        {verdict && (
          <strong className={`desk-validation-verdict ${verdict[2]}`}>
            {t(verdict[0], verdict[1])} · {result?.engine_version}
          </strong>
        )}
      </div>
      <div className="actions">
        <label>
          {t('分段數（2–8）', 'Folds (2–8)')}
          <input
            inputMode="numeric"
            value={folds}
            onChange={(event) => setFolds(event.target.value)}
          />
        </label>
        <label>
          {t('比較過的設定數（1–500）', 'Configurations compared (1–500)')}
          <input
            inputMode="numeric"
            value={trials}
            onChange={(event) => setTrials(event.target.value)}
          />
        </label>
        <button type="button" className="button primary" disabled={!valid || busy} onClick={run}>
          {busy ? t('驗證中…', 'Validating…') : t('執行驗證閘', 'Run validation gate')}
        </button>
        {batchSymbols.length > 1 && (
          <button type="button" className="button" disabled={!valid || busy} onClick={runBatch}>
            {t(
              `驗證錦標賽全部 ${batchSymbols.length} 個標的`,
              `Validate all ${batchSymbols.length} tournament symbols`,
            )}
          </button>
        )}
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {batch && (
        <div className="desk-validation-batch">
          <p>
            <strong>{t('跨標的彙總', 'Cross-symbol summary')}</strong>:{' '}
            {batch.overall === 'unavailable'
              ? t('全部不可用', 'All unavailable')
              : t(STATUS[batch.overall][0], STATUS[batch.overall][1])}{' '}
            · pass {batch.counts.pass} · warn {batch.counts.warn} · fail {batch.counts.fail} ·{' '}
            {t('不可用', 'unavailable')} {batch.counts.unavailable}
            {batch.pass_share != null
              ? ` · ${t('通過比例', 'pass share')} ${deskRatio(batch.pass_share)}`
              : ''}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('標的', 'Symbol'),
                    t('判定', 'Verdict'),
                    t('區間', 'Window'),
                    t('交易', 'Trades'),
                    t('報酬', 'Return'),
                    t('一致性', 'Consistency'),
                    t('95% 區間', '95% interval'),
                    t('Sharpe 機率', 'Sharpe prob.'),
                    t('原因', 'Reasons'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batch.items.map((item) => (
                  <tr key={item.symbol}>
                    <th scope="row">{item.symbol}</th>
                    {item.status === 'evaluated' ? (
                      <>
                        <td className={STATUS[item.verdict][2]}>
                          {t(STATUS[item.verdict][0], STATUS[item.verdict][1])}
                        </td>
                        <td>
                          {item.window.start} – {item.window.end}
                        </td>
                        <td>{item.closed_trades}</td>
                        <td>{deskPercent(item.return_pct)}</td>
                        <td>{deskRatio(item.consistency)}</td>
                        <td>
                          {item.ci95
                            ? `${deskPercent(item.ci95[0])} – ${deskPercent(item.ci95[1])}`
                            : '—'}
                        </td>
                        <td>{deskRatio(item.probability)}</td>
                        <td>
                          {[
                            ...item.reasons,
                            ...item.unavailable.map(
                              (name) => `${name}: ${t('不可用', 'unavailable')}`,
                            ),
                          ].join('；') || '—'}
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{t('不可用', 'Unavailable')}</td>
                        <td colSpan={7}>{item.message}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {result && (
        <>
          {!!result.verdict.reasons.length && (
            <ul className="desk-hypotheses">
              {result.verdict.reasons.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div className="agent-preview-stats">
            <span>
              {t('分段一致性', 'Fold consistency')}{' '}
              <strong>
                {result.walk_forward.available
                  ? `${result.walk_forward.positive_folds}/${result.walk_forward.traded_folds} (${deskRatio(result.walk_forward.consistency)})`
                  : reason(result.walk_forward.reason, t)}
              </strong>
            </span>
            <span>
              {t('平均交易報酬 95% 區間', 'Mean trade return, 95% interval')}{' '}
              <strong>
                {result.bootstrap.available
                  ? `${deskPercent(result.bootstrap.ci95_lower_pct)} – ${deskPercent(result.bootstrap.ci95_upper_pct)} (N=${result.bootstrap.closed_trades})`
                  : reason(result.bootstrap.reason, t)}
              </strong>
            </span>
            <span>
              {result.sharpe.kind === 'deflated'
                ? t('去膨脹 Sharpe 機率', 'Deflated Sharpe probability')
                : t('機率化 Sharpe', 'Probabilistic Sharpe')}{' '}
              <strong>
                {result.sharpe.available
                  ? `${deskRatio(result.sharpe.probability)} (Sharpe ${deskRatio(result.sharpe.sharpe_annualized)}, ${t('試驗', 'trials')} ${result.sharpe.trials})`
                  : reason(result.sharpe.reason, t)}
              </strong>
            </span>
          </div>
          {!!result.walk_forward.folds.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      t('段', 'Fold'),
                      t('區間', 'Window'),
                      t('交易日', 'Sessions'),
                      t('報酬', 'Return'),
                      t('交易', 'Trades'),
                      t('勝率', 'Win rate'),
                      t('最大回撤', 'Max DD'),
                      t('狀態', 'Status'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.walk_forward.folds.map((fold) => (
                    <tr key={fold.index}>
                      <th scope="row">{fold.index}</th>
                      <td>
                        {fold.start} – {fold.end}
                      </td>
                      <td>{fold.sessions}</td>
                      <td
                        className={
                          fold.status === 'positive'
                            ? 'desk-positive'
                            : fold.status === 'negative'
                              ? 'desk-negative'
                              : ''
                        }
                      >
                        {deskPercent(fold.return_pct)}
                      </td>
                      <td>{fold.closed_trades}</td>
                      <td>{deskPercent(fold.win_rate_pct)}</td>
                      <td>{deskPercent(fold.max_drawdown_pct)}</td>
                      <td>
                        {fold.status === 'no_trades'
                          ? t('無成交', 'No trades')
                          : fold.status === 'positive'
                            ? t('正報酬', 'Positive')
                            : t('負報酬', 'Negative')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="desk-method">
            <summary>{t('判定規則、方法與限制', 'Rule, method and limits')}</summary>
            <p className="desk-meta">{result.verdict.rule}</p>
            <p className="desk-meta">{result.method}</p>
            <ul className="desk-hypotheses">
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
