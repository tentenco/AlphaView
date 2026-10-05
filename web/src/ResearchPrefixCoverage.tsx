import { useEffect, useRef, useState } from 'react'
import type { DeskConfig } from './research-desk-model'
import type { Translate } from './ResearchDesk'
import { workflowEvidenceJson } from './workflow-evidence-json'
import './research-prefix-coverage.css'

type Status = 'no_difference_detected' | 'differences_found' | 'unavailable'
type Detail = {
  prefix_end: string
  date: string
  field: string
  before: number | boolean | null
  after: number | boolean | null
  code?: string
}
type Request = {
  symbol: string
  config: DeskConfig
  test_start: string
  test_end: string
  expected_input_revision: string
  expected_as_of: string
}
export type PrefixCoverageResult = {
  engine_version: string
  as_of: string
  input_revision: string
  symbol: string
  config: DeskConfig
  request: Request
  fingerprint: string | null
  evidence_fingerprint: string
  status: Status
  effective_end: string
  window: {
    start: string | null
    end: string
    sessions: number
    warmup_start: string
    history_sessions: number
    first_eligible_cutoff: string | null
    last_eligible_cutoff: string | null
  } | null
  suggested_window: { test_start: string; test_end: string; signal_sessions: number } | null
  coverage: {
    required_cutoffs: number | null
    attempted_cutoffs: number
    compared_cutoffs: number
    failed_cutoffs: number
    manifest_complete: boolean
    cutoff_coverage_complete: boolean
    complete: boolean
  }
  counts: {
    compared_session_pairs: number
    compared_values: number
    differences: number
    unavailable_values: number
    invalid_signal_sessions: number
  }
  limits: { max_cutoffs: number; max_history_bars: number; max_details: number }
  cutoff_manifest: {
    cutoff_date: string
    status: 'compared' | 'unavailable'
    fingerprint: string | null
    reason: string | null
  }[]
  differences: Detail[]
  differences_truncated: boolean
  unavailable_values: Detail[]
  unavailable_values_truncated: boolean
  unavailable: { code: string; message: string; cutoff_date?: string }[]
  method: string
  warnings: string[]
}
type Props = {
  symbol: string
  config: DeskConfig
  testStart?: string | null
  testEnd?: string | null
  inputRevision: string
  asOf: string
  contextIdentity?: string
  enabled?: boolean
  t: Translate
}
const configKey = (config: DeskConfig) =>
  JSON.stringify([
    config.strategy,
    Object.entries(config.params).sort(([a], [b]) => a.localeCompare(b)),
  ])
const dateValid = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date
const cell = (value: number | boolean | null) => (value === null ? '—' : String(value))

export function ResearchPrefixCoverage({
  symbol,
  config,
  testStart,
  testEnd,
  inputRevision,
  asOf,
  contextIdentity = '',
  enabled = true,
  t,
}: Props) {
  const sourceIdentity = JSON.stringify([
    symbol,
    configKey(config),
    testStart,
    testEnd,
    inputRevision,
    asOf,
    contextIdentity,
  ])
  const [dates, setDates] = useState({ start: testStart ?? '', end: testEnd ?? asOf })
  const identity = JSON.stringify([sourceIdentity, dates, enabled])
  const latest = useRef(identity)
  latest.current = identity
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy: boolean
    result: PrefixCoverageResult | null
    raw: string | null
    error: string
  }>({ identity, busy: false, result: null, raw: null, error: '' })
  const current = state.identity === identity && enabled ? state : null
  const busy = current?.busy ?? false
  const result = current?.result ?? null
  const validDates = dateValid(dates.start) && dateValid(dates.end) && dates.start <= dates.end
  useEffect(() => {
    setDates({ start: testStart ?? '', end: testEnd ?? asOf })
  }, [sourceIdentity])
  useEffect(() => {
    setState({ identity, busy: false, result: null, raw: null, error: '' })
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [identity])
  function cancel() {
    pending.current?.abort()
    pending.current = null
    setState({ identity, busy: false, result: null, raw: null, error: '' })
  }
  async function inspect() {
    if (!enabled || pending.current || !validDates) return
    const controller = new AbortController()
    pending.current = controller
    const matches = () =>
      !controller.signal.aborted && pending.current === controller && latest.current === identity
    const request: Request = JSON.parse(
      JSON.stringify({
        symbol,
        config,
        test_start: dates.start,
        test_end: dates.end,
        expected_input_revision: inputRevision,
        expected_as_of: asOf,
      }),
    )
    setState({ identity, busy: true, result: null, raw: null, error: '' })
    try {
      const response = await fetch('/api/research-desk/prefix-coverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal: controller.signal,
      })
      const raw = await response.text()
      const data = JSON.parse(raw)
      if (!matches()) return
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? t(
                '資料版本或完成交易日已變更，請先更新策略診斷。',
                'The source revision or completed session changed. Refresh the strategy diagnosis first.',
              )
            : typeof data?.detail?.message === 'string'
              ? data.detail.message
              : t('密集前綴比較失敗。', 'Dense prefix comparison failed.'),
        )
      workflowEvidenceJson(data, raw)
      const received = data as PrefixCoverageResult
      if (
        received.engine_version !== 'alphaview-research-prefix-coverage-v1' ||
        received.symbol !== symbol ||
        received.input_revision !== inputRevision ||
        received.as_of !== asOf ||
        configKey(received.config) !== configKey(config)
      )
        throw new Error(
          t(
            '回應來源與目前研究設定不符。',
            'The response source does not match the current research context.',
          ),
        )
      workflowEvidenceJson(request, JSON.stringify(received.request))
      if (!['no_difference_detected', 'differences_found', 'unavailable'].includes(received.status))
        throw new Error(t('無法辨識比較結果。', 'Unrecognized comparison result.'))
      setState({ identity, busy: false, result: received, raw, error: '' })
    } catch (error) {
      if (matches())
        setState({
          identity,
          busy: false,
          result: null,
          raw: null,
          error: error instanceof Error ? error.message : String(error),
        })
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }
  function download() {
    if (!result || !current?.raw || pending.current || !enabled || latest.current !== identity)
      return
    try {
      const raw = workflowEvidenceJson(result, current.raw)
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `alphaview-prefix-coverage-${safe(symbol)}-${safe(result.as_of)}-${safe(result.evidence_fingerprint)}.json`
      try {
        document.body.appendChild(anchor)
        anchor.click()
      } finally {
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      }
    } catch {
      setState({
        ...current,
        error: t(
          '無法下載密集前綴證據，請重新比較。',
          'Dense prefix evidence could not be downloaded. Run the comparison again.',
        ),
      })
    }
  }
  const statuses: Record<Status, string> = {
    no_difference_detected: t('選定切點未檢出差異', 'No differences in the selected cutoffs'),
    differences_found: t('選定切點檢出差異', 'Differences in the selected cutoffs'),
    unavailable: t('密集覆蓋不可用', 'Dense coverage unavailable'),
  }
  const details = (title: string, rows: Detail[], truncated: boolean) => (
    <details>
      <summary>
        {title} · {rows.length}
      </summary>
      {truncated && (
        <p>
          {t(
            '明細已截斷；完整數量見覆蓋計數。',
            'Details are truncated; coverage counts retain the full totals.',
          )}
        </p>
      )}
      <div className="prefix-coverage-table">
        <table aria-label={title}>
          <thead>
            <tr>
              {[
                t('切點', 'Cutoff'),
                t('訊號日期', 'Signal date'),
                t('欄位', 'Field'),
                t('完整歷史', 'Full history'),
                t('重建前綴', 'Rebuilt prefix'),
                t('原因', 'Reason'),
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{row.prefix_end}</td>
                <td>{row.date}</td>
                <td>{row.field}</td>
                <td>{cell(row.before)}</td>
                <td>{cell(row.after)}</td>
                <td>{row.code ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
  return (
    <section
      className="desk-validation research-prefix-coverage"
      aria-label={t('密集前綴覆蓋', 'Dense prefix coverage')}
    >
      <h3>
        {t('逐一檢查選定區間的歷史前綴', 'Inspect every eligible prefix in a selected window')}
      </h3>
      <p>
        {t(
          '每個切點保留至少 20 個比較訊號日期，且移除至少一筆較晚資料。最多 120 個切點、2,000 筆本機日線；超出就停止，不改成抽樣。',
          'Each cutoff retains at least 20 compared signal dates and excludes at least one later bar. Up to 120 cutoffs and 2,000 local bars; exceeding a bound stops the diagnostic without sampling.',
        )}
      </p>
      <p className="research-note">
        {t(
          '全數覆蓋只適用於此區間、設定與目前歷史的合格切點，不是因果性或沒有未來資料洩漏的證明，也不是回測或交易授權。',
          'Complete coverage applies only to eligible cutoffs in this window, configuration and current history. It is not a causal proof, proof of no future-data leakage, a backtest or trading authority.',
        )}
      </p>
      <fieldset disabled={!enabled || busy} className="prefix-coverage-dates">
        <legend>{t('明確的訊號日期區間', 'Explicit signal-date window')}</legend>
        <label>
          {t('訊號開始日期', 'Signal start date')}
          <input
            type="date"
            value={dates.start}
            onChange={(event) => setDates({ ...dates, start: event.target.value })}
          />
        </label>
        <label>
          {t('訊號結束日期', 'Signal end date')}
          <input
            type="date"
            value={dates.end}
            onChange={(event) => setDates({ ...dates, end: event.target.value })}
          />
        </label>
      </fieldset>
      {!validDates && (
        <p>
          {t('請填入有效且由早到晚的兩個日期。', 'Enter two valid dates in chronological order.')}
        </p>
      )}
      <p className="desk-meta">
        {symbol} · {config.strategy} · {t('完成交易日', 'Completed session')}: {asOf} ·{' '}
        {inputRevision}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={!enabled || busy || !validDates}
          onClick={() => void inspect()}
        >
          {busy
            ? t('逐切點比較中…', 'Comparing every cutoff…')
            : t('比較所有合格切點', 'Compare every eligible cutoff')}
        </button>
        {busy && (
          <button type="button" className="button-secondary" onClick={cancel}>
            {t('取消比較', 'Cancel comparison')}
          </button>
        )}
        {result && (
          <button type="button" className="button-secondary" onClick={download}>
            {t('下載密集前綴 JSON', 'Download dense prefix JSON')}
          </button>
        )}
      </div>
      {current?.error && <p role="alert">{current.error}</p>}
      {result && (
        <div className="prefix-coverage-result">
          <h4>{statuses[result.status]}</h4>
          <p>
            {t('已比較切點／所需切點', 'Compared / required cutoffs')}:{' '}
            {result.coverage.compared_cutoffs} / {result.coverage.required_cutoffs ?? '—'} ·{' '}
            {t('上限', 'Limit')}: {result.limits.max_cutoffs}
          </p>
          <p>
            {result.coverage.complete
              ? t(
                  '合格切點與必要值皆已比較；這不是策略通過驗證。',
                  'All eligible cutoffs and required values were compared; this is not strategy validation.',
                )
              : t(
                  '覆蓋不完整或不可用；請查看缺口原因。',
                  'Coverage is incomplete or unavailable; inspect the reasons.',
                )}
          </p>
          <p>
            {t('訊號日期比較次數', 'Signal-date comparison pairs')}:{' '}
            {result.counts.compared_session_pairs} · {t('差異', 'Differences')}:{' '}
            {result.counts.differences} · {t('不可用值', 'Unavailable values')}:{' '}
            {result.counts.unavailable_values} ·{' '}
            {t('無效訊號日期次數', 'Invalid signal-date occurrences')}:{' '}
            {result.counts.invalid_signal_sessions}
          </p>
          {result.window && (
            <p>
              {t('實際比較日期', 'Actual comparison dates')}: {result.window.start ?? '—'} →{' '}
              {result.window.end} · {t('暖機保留起日', 'Retained warmup starts')}:{' '}
              {result.window.warmup_start}
            </p>
          )}
          {result.unavailable.length > 0 && (
            <ul>
              {result.unavailable.map((reason, index) => (
                <li key={index}>
                  {reason.cutoff_date && `${reason.cutoff_date}: `}
                  {reason.code} — {reason.message}
                </li>
              ))}
            </ul>
          )}
          {result.suggested_window && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                const suggestion = result.suggested_window!
                setDates({ start: suggestion.test_start, end: suggestion.test_end })
                cancel()
              }}
            >
              {t(
                '使用最後最多 100 個訊號日期（不執行）',
                'Use the last up to 100 signal dates (do not run)',
              )}{' '}
              · {result.suggested_window.test_start} → {result.suggested_window.test_end}
            </button>
          )}
          <details>
            <summary>
              {t('完整切點清單與來源指紋', 'Cutoff manifest and source fingerprints')}
            </summary>
            {!result.coverage.manifest_complete && (
              <p>
                {t(
                  '切點清單未產生；未默默省略或抽樣。',
                  'The cutoff manifest was not generated; no silent omissions or sampling occurred.',
                )}
              </p>
            )}
            <div className="prefix-coverage-table">
              <table aria-label={t('切點清單', 'Cutoff manifest')}>
                <thead>
                  <tr>
                    <th>{t('切點', 'Cutoff')}</th>
                    <th>{t('狀態', 'Status')}</th>
                    <th>{t('歷史指紋', 'History fingerprint')}</th>
                    <th>{t('原因', 'Reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cutoff_manifest.map((row) => (
                    <tr key={row.cutoff_date}>
                      <td>{row.cutoff_date}</td>
                      <td>{row.status}</td>
                      <td className="prefix-coverage-fingerprint">{row.fingerprint ?? '—'}</td>
                      <td>{row.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {details(
            t('差異明細', 'Difference details'),
            result.differences,
            result.differences_truncated,
          )}
          {details(
            t('缺值明細', 'Unavailable-value details'),
            result.unavailable_values,
            result.unavailable_values_truncated,
          )}
          <details>
            <summary>{t('方法、來源與限制', 'Method, source and limitations')}</summary>
            <p>{result.method}</p>
            <p>{result.engine_version}</p>
            <p className="prefix-coverage-fingerprint">{result.fingerprint ?? '—'}</p>
            <p className="prefix-coverage-fingerprint">{result.evidence_fingerprint}</p>
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  )
}
