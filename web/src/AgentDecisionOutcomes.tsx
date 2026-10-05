import { useEffect, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import { num } from './ui'

type Translate = (zh: string, en: string) => string
export type OutcomeGroup = {
  kind: string
  label: string
  english: string
  direction: 'long' | 'exit' | null
  n: number
  n_settled: number
  n_pending: number
  n_unavailable: number
  hit_rate: number | null
  hits: number
  mean_return_pct: number | null
  mean_excess_pct: number | null
  excess_coverage: { n: number; of: number; reason: string | null }
  low_sample: boolean
  reason: string | null
}
export type OutcomeFamily = {
  id: string
  label: string
  english: string
  groups: OutcomeGroup[]
  total: Omit<OutcomeGroup, 'kind' | 'label' | 'english' | 'direction'>
}
export type CalibrationQuestion = {
  id: string
  label: string
  english: string
  realization: { kind: string; label: string; english: string; description: string }
  n: number
  n_pending: number
  unavailable: Record<string, number>
  brier: number | null
  base_rate: number | null
  mean_predicted: number | null
  bins: {
    range: [number, number]
    n: number
    mean_predicted: number | null
    realized_rate: number | null
    low_sample: boolean
  }[]
  low_sample: boolean
}
export type DecisionOutcomes = {
  engine_version: string
  as_of: string
  input_revision: string
  generated_at: string
  horizon_sessions: number
  horizons: number[]
  window: { sessions: number; start: string; end: string }
  account: { id: string; name: string } | null
  price_basis: string
  benchmark: string
  low_sample_threshold: number
  families: OutcomeFamily[]
  calibration: {
    questions: CalibrationQuestion[]
    unscorable: { id: string; label: string; english: string; reason: string }[]
    bins: [number, number][]
    score_correlation?: {
      question: string
      status: 'available' | 'unavailable'
      reason: string | null
      n: number
      n_pending: number
      n_unavailable: number
      spearman: number | null
      low_sample: boolean
      method: string
    }
    note: string
  }
  items: {
    family: string
    kind: string
    symbol: string
    decision_session: string
    outcome: { status: string }
  }[]
  items_truncated: boolean
  items_total: number
  method: string
  warnings: string[]
}
type Props = { account: PaperAccount; locale: Locale }
const WINDOWS = [20, 60, 120, 252]
const REASONS: Record<string, [string, string]> = {
  no_decisions: ['窗口內沒有這類決策', 'No decisions of this kind in the window'],
  no_settled_decisions: ['尚無已結算的決策', 'No settled decisions yet'],
  no_direction: ['無方向的決策不計命中', 'Directionless decisions are not scored'],
  benchmark_unavailable: ['基準日線不可用', 'Benchmark bars unavailable'],
  question_absent: ['紀錄中沒有設定品質分數', 'No setup-quality scores in the records'],
  insufficient_settled: ['已結算的評分決策少於 2 筆', 'Fewer than 2 settled scored decisions'],
  no_variance: ['分數或報酬沒有變異', 'Scores or returns have no variance'],
}

const pct = (value: number | null | undefined, digits = 2) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${num(value, digits)}%`
const rate = (value: number | null | undefined) => (value == null ? '—' : `${num(value * 100, 1)}%`)

export function AgentDecisionOutcomes({ account, locale }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [horizon, setHorizon] = useState(10)
  const [windowSessions, setWindowSessions] = useState(60)
  const [data, setData] = useState<DecisionOutcomes | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const query = new URLSearchParams({
    account_id: account.id,
    horizon_sessions: String(horizon),
    window_sessions: String(windowSessions),
  }).toString()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetch(`/api/trading-agent/outcomes?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const value = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = value?.detail
          throw new Error(
            typeof detail === 'string'
              ? detail
              : detail?.message ||
                  t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
          )
        }
        return value as DecisionOutcomes
      })
      .then((value) => {
        if (controller.signal.aborted) return
        setData(value)
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // Labels re-render with the locale; no refetch is needed for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version, horizon, windowSessions])
  const reason = (code: string | null) => (code ? (REASONS[code] ? t(...REASONS[code]) : code) : '')
  const tone = (value: number | null) =>
    value == null ? '' : value > 0 ? 'positive' : value < 0 ? 'negative' : ''
  return (
    <section
      className="agent-panel agent-report"
      aria-label={t('決策結果帳本', 'Decision outcome ledger')}
    >
      <div className="section-heading">
        <div>
          <h2>{t('決策結果帳本', 'Decision outcome ledger')}</h2>
          <p>
            {t(
              '選股訊號、規則工作流目標變動、Jev 決策閘與紙上成交，只在地平線完整走完後才以本機日線結算；未到期的列為待結算，缺價的列為不可用。',
              'Scan signals, rule-workflow target changes, Jev gate decisions and paper fills are settled from local bars only after the full horizon elapsed; unelapsed ones stay pending and unpriced ones stay unavailable.',
            )}
          </p>
        </div>
        {data && (
          <strong>
            {data.items_total} {t('筆決策', 'decisions')}
          </strong>
        )}
      </div>
      <p className="actions">
        <a className="button" href={`/api/trading-agent/outcomes.csv?${query}`} download>
          {t('下載逐筆決策 CSV', 'Download per-decision CSV')}
        </a>
        <small className="muted">
          {t(
            '同樣的地平線與窗口；待結算與不可用的列保留空白數值，不是 0。',
            'Same horizon and window; pending and unavailable rows keep blank numeric cells, never zeros.',
          )}
        </small>
      </p>
      <div className="agent-form-grid agent-report-controls">
        <label>
          {t('地平線（交易日）', 'Horizon (sessions)')}
          <select value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
            {(data?.horizons ?? [5, 10, 20]).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('決策窗口（交易日）', 'Decision window (sessions)')}
          <select
            value={windowSessions}
            onChange={(event) => setWindowSessions(Number(event.target.value))}
          >
            {WINDOWS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && !data && <p className="agent-report-meta">{t('載入中…', 'Loading…')}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="agent-report-meta">
            {t('窗口', 'Window')} {data.window.start} → {data.window.end} ·{' '}
            {t('最新完成交易日', 'Latest completed session')} {data.as_of} ·{' '}
            {t('基準', 'Benchmark')} {data.benchmark} · {data.engine_version}
          </p>
          {data.families.map((family) => (
            <div key={family.id}>
              <h3>{t(family.label, family.english)}</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('決策', 'Decision'),
                        t('方向', 'Direction'),
                        t('已結算', 'Settled'),
                        t('待結算', 'Pending'),
                        t('不可用', 'Unavailable'),
                        t('命中率', 'Hit rate'),
                        t('平均報酬', 'Mean return'),
                        t('平均超額', 'Mean excess'),
                        t('備註', 'Note'),
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {family.groups.map((group) => (
                      <tr key={group.kind}>
                        <th scope="row">{t(group.label, group.english)}</th>
                        <td>
                          {group.direction === 'long'
                            ? t('做多', 'Long')
                            : group.direction === 'exit'
                              ? t('減碼／出場', 'Reduce / exit')
                              : '—'}
                        </td>
                        <td>{group.n_settled}</td>
                        <td>{group.n_pending}</td>
                        <td>{group.n_unavailable}</td>
                        <td>{rate(group.hit_rate)}</td>
                        <td className={tone(group.mean_return_pct)}>
                          {pct(group.mean_return_pct)}
                        </td>
                        <td className={tone(group.mean_excess_pct)}>
                          {pct(group.mean_excess_pct)}
                          {group.excess_coverage.reason
                            ? ` (${reason(group.excess_coverage.reason)})`
                            : ''}
                        </td>
                        <td>
                          {group.low_sample && group.n_settled > 0
                            ? t('樣本不足', 'Low sample')
                            : reason(group.reason)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <h3>{t('Jev 機率校準', 'Jev probability calibration')}</h3>
          {data.calibration.score_correlation && (
            <p className="agent-report-meta">
              <strong>
                {t('設定品質分數 vs 實現報酬', 'Setup-quality score vs realized return')}
              </strong>{' '}
              ·{' '}
              {data.calibration.score_correlation.status === 'available'
                ? `Spearman ${num(data.calibration.score_correlation.spearman, 4)} · N=${data.calibration.score_correlation.n}${
                    data.calibration.score_correlation.low_sample
                      ? ` (${t('樣本不足', 'low sample')})`
                      : ''
                  }`
                : `${t('不可用', 'Unavailable')}: ${reason(data.calibration.score_correlation.reason)}`}{' '}
              · {t('待結算', 'Pending')} {data.calibration.score_correlation.n_pending} ·{' '}
              {t('不可用', 'Unavailable')} {data.calibration.score_correlation.n_unavailable}
            </p>
          )}
          {data.calibration.questions.map((question) => (
            <div key={question.id}>
              <p className="agent-report-meta">
                <strong>{t(question.label, question.english)}</strong> ·{' '}
                {t('實現事件', 'Realization')}:{' '}
                {t(question.realization.label, question.realization.english)} · N={question.n}
                {question.low_sample ? ` (${t('樣本不足', 'low sample')})` : ''} · Brier{' '}
                {num(question.brier, 4)} · {t('平均預測', 'Mean predicted')}{' '}
                {rate(question.mean_predicted)} · {t('實現率', 'Base rate')}{' '}
                {rate(question.base_rate)} · {t('待結算', 'Pending')} {question.n_pending}
                {Object.keys(question.unavailable).length
                  ? ` · ${t('不可用', 'Unavailable')} ${Object.entries(question.unavailable)
                      .map(([code, count]) => `${code} ${count}`)
                      .join(', ')}`
                  : ''}
              </p>
              <p className="agent-report-meta">{question.realization.description}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('機率區間', 'Probability bin'),
                        'N',
                        t('平均預測', 'Mean predicted'),
                        t('實現頻率', 'Realized rate'),
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {question.bins.map((bin) => (
                      <tr key={bin.range.join('-')}>
                        <th scope="row">
                          {num(bin.range[0], 1)}–{num(bin.range[1], 1)}
                        </th>
                        <td>
                          {bin.n}
                          {bin.low_sample && bin.n > 0 ? ` (${t('樣本不足', 'low sample')})` : ''}
                        </td>
                        <td>{rate(bin.mean_predicted)}</td>
                        <td>{rate(bin.realized_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {!!data.calibration.unscorable.length && (
            <ul className="agent-report-list">
              {data.calibration.unscorable.map((entry) => (
                <li key={entry.id}>
                  <strong>{t(entry.label, entry.english)}</strong> ·{' '}
                  {t('不可校準', 'Not calibrated')}: {entry.reason}
                </li>
              ))}
            </ul>
          )}
          <details className="agent-method">
            <summary>{t('這不是什麼', 'What this is not')}</summary>
            <ul className="agent-report-list">
              {data.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p className="agent-report-meta">{data.price_basis}</p>
            <p className="agent-report-meta">{data.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
