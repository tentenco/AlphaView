import { useEffect, useRef, useState } from 'react'
import type { Translate } from './ResearchDesk'
import type { DeskConfig } from './research-desk-model'
import { downloadResearchIntegrityJson } from './research-integrity-json'
import { workflowEvidenceJson } from './workflow-evidence-json'
import { ResearchIntegrityReceipts } from './ResearchIntegrityReceipts'

type IntegrityRequest = {
  symbol: string
  config: DeskConfig
  test_start: string | null
  test_end: string | null
  max_prefixes: number
}
type IntegrityStatus = 'no_difference_detected' | 'differences_found' | 'unavailable'
type Difference = {
  prefix_end: string
  date: string
  field: string
  before: number | boolean | null
  after: number | boolean | null
}
export type DeskIntegrityResult = {
  evidence_fingerprint?: string
  engine_version: string
  as_of: string
  input_revision: string
  symbol: string
  config: DeskConfig
  fingerprint: string | null
  request?: IntegrityRequest
  status: IntegrityStatus
  fields: string[]
  prefixes: {
    cutoff_date: string
    compared_start: string
    compared_sessions: number
    difference_count: number
    unavailable_values: number
    invalid_signal_sessions: number
    status: IntegrityStatus
  }[]
  counts: {
    prefixes: number
    compared_session_pairs: number
    differences: number
    unavailable_values: number
    invalid_signal_sessions: number
  }
  differences: Difference[]
  differences_truncated: boolean
  unavailable: { code: string; message: string }[]
  unavailable_values: (Difference & { code: string })[]
  unavailable_values_truncated: boolean
  method: string
}
type Props = {
  symbol: string
  config: DeskConfig
  testStart?: string | null
  testEnd?: string | null
  inputRevision: string
  fingerprint: string
  /** Parent draft/run identity; changes permanently discard previous evidence. */
  contextIdentity?: string
  enabled?: boolean
  t: Translate
}
const configIdentity = (config: DeskConfig) =>
  JSON.stringify([
    config.strategy,
    Object.entries(config.params).sort(([a], [b]) => a.localeCompare(b)),
  ])
const STATUS: Record<IntegrityStatus, [string, string]> = {
  no_difference_detected: ['抽樣前綴未檢出差異', 'No differences in sampled prefixes'],
  differences_found: ['檢出前綴差異', 'Prefix differences detected'],
  unavailable: ['無法完成比較', 'Comparison unavailable'],
}
const value = (item: number | boolean | null) => (item === null ? '—' : String(item))

export function ResearchDeskIntegrity({
  symbol,
  config,
  testStart,
  testEnd,
  inputRevision,
  fingerprint,
  contextIdentity = '',
  enabled = true,
  t,
}: Props) {
  const identity = JSON.stringify([
    symbol,
    configIdentity(config),
    testStart ?? null,
    testEnd ?? null,
    inputRevision,
    fingerprint,
    contextIdentity,
    enabled,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy: boolean
    result: DeskIntegrityResult | null
    rawJson: string | null
    request: IntegrityRequest | null
    error: string
  }>({ identity, busy: false, result: null, rawJson: null, request: null, error: '' })
  const current = enabled && state.identity === identity ? state : null
  const busy = current?.busy ?? false
  const result = current?.result ?? null
  useEffect(() => {
    setState({ identity, busy: false, result: null, rawJson: null, request: null, error: '' })
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [identity])

  async function run() {
    if (!enabled || pending.current || busy) return
    const controller = new AbortController()
    pending.current = controller
    const matches = () =>
      !controller.signal.aborted &&
      pending.current === controller &&
      latestIdentity.current === identity
    setState({ identity, busy: true, result: null, rawJson: null, request: null, error: '' })
    const request: IntegrityRequest = JSON.parse(
      JSON.stringify({
        symbol,
        config,
        test_start: testStart ?? null,
        test_end: testEnd ?? null,
        max_prefixes: 6,
      }),
    )
    try {
      const response = await fetch('/api/research-desk/integrity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(request),
      })
      const rawJson = await response.text()
      const data = JSON.parse(rawJson)
      if (!matches()) return
      if (!response.ok) {
        const detail = data?.detail
        throw new Error(
          typeof detail === 'string'
            ? detail
            : typeof detail?.message === 'string'
              ? detail.message
              : t('前綴比較失敗，請稍後重試。', 'Prefix comparison failed. Please try again.'),
        )
      }
      workflowEvidenceJson(data, rawJson)
      const received = data as DeskIntegrityResult
      if (
        received.symbol !== symbol ||
        configIdentity(received.config) !== configIdentity(config) ||
        received.input_revision !== inputRevision ||
        (received.fingerprint !== null && received.fingerprint !== fingerprint) ||
        (received.request !== undefined &&
          (received.request === null ||
            received.request.symbol !== request.symbol ||
            configIdentity(received.request.config) !== configIdentity(request.config) ||
            received.request.test_start !== request.test_start ||
            received.request.test_end !== request.test_end ||
            received.request.max_prefixes !== request.max_prefixes))
      ) {
        throw new Error(
          t(
            '資料或診斷設定已變更，請重新執行策略診斷後再比較前綴。',
            'Data or diagnosis changed. Run the strategy diagnosis again before comparing prefixes.',
          ),
        )
      }
      setState({ identity, busy: false, result: received, rawJson, request, error: '' })
    } catch (error) {
      if (matches()) {
        setState({
          identity,
          busy: false,
          result: null,
          rawJson: null,
          request: null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }

  function download() {
    if (
      !enabled ||
      busy ||
      pending.current ||
      !result ||
      !current?.request ||
      current.rawJson === null ||
      latestIdentity.current !== identity
    )
      return
    try {
      downloadResearchIntegrityJson(result, current.request, current.rawJson)
      setState({ ...current, error: '' })
    } catch {
      setState({
        ...current,
        error: t(
          '無法下載這份前綴證據，請重新比較後再試。',
          'This prefix evidence could not be downloaded. Compare the prefixes again and retry.',
        ),
      })
    }
  }

  function cancel() {
    pending.current?.abort()
    pending.current = null
    setState({ identity, busy: false, result: null, rawJson: null, request: null, error: '' })
  }

  return (
    <section
      className="desk-validation"
      aria-label={t('歷史前綴完整性', 'Historical prefix integrity')}
    >
      <div className="section-heading">
        <div>
          <h3>{t('未來資料會改寫過去訊號嗎？', 'Does future data change past signals?')}</h3>
          <p>
            {t(
              '針對此標的與固定設定，移除較晚日線後重新計算，比較進場、出場、有效性及相關指標。每次最多 6 個切點、2,000 筆本機日線。',
              'For this symbol and fixed configuration, remove later bars and rebuild entry, exit, validity and related indicators. At most 6 cutoffs and 2,000 local bars per request.',
            )}
          </p>
        </div>
      </div>
      <p className="desk-meta">
        {t(
          '未檢出差異僅表示抽樣範圍內一致；不證明沒有未來資料洩漏、不證明獲利，也不是交易指示。',
          'No detected differences means consistency within these samples only. It does not prove absence of future-data leakage or profitability, and is not trading advice.',
        )}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={busy || !enabled}
          onClick={() => void run()}
        >
          {busy ? t('正在比較…', 'Comparing…') : t('比較歷史前綴', 'Compare historical prefixes')}
        </button>
        {busy && (
          <button type="button" className="button" onClick={cancel}>
            {t('取消比較', 'Cancel comparison')}
          </button>
        )}
      </div>
      {current?.error && (
        <p className="error-message" role="alert">
          {current.error}
        </p>
      )}
      {result && (
        <div aria-live="polite">
          <h4>{t(...STATUS[result.status])}</h4>
          <button type="button" className="button" disabled={busy || !enabled} onClick={download}>
            {t('下載目前前綴證據 JSON', 'Download current prefix evidence JSON')}
          </button>
          <p className="desk-meta">
            {t(
              '下載保留這次設定、來源與抽樣缺口；離線檔案不是無洩漏證明，也不保證日後資料仍相同。',
              'The download preserves this configuration, source and sampling gaps. An offline file does not prove absence of leakage or guarantee unchanged data later.',
            )}
          </p>
          <p className="desk-meta">
            {t('已比較切點', 'Cutoffs compared')}: {result.counts.prefixes} ·{' '}
            {t(
              '訊號日期比較次數（各切點可能重疊）',
              'Signal-date comparisons (cutoffs may overlap)',
            )}
            : {result.counts.compared_session_pairs} · {t('差異', 'Differences')}:{' '}
            {result.counts.differences}
          </p>
          {result.unavailable.length > 0 && (
            <ul className="desk-hypotheses">
              {result.unavailable.map((reason, index) => (
                <li key={index}>
                  {reason.message} ({reason.code})
                </li>
              ))}
            </ul>
          )}
          {result.prefixes.length > 0 && (
            <div className="table-scroll">
              <table aria-label={t('各切點比較結果', 'Results by cutoff')}>
                <thead>
                  <tr>
                    <th>{t('保留至', 'Retained through')}</th>
                    <th>{t('比較日期數', 'Dates compared')}</th>
                    <th>{t('差異數', 'Differences')}</th>
                    <th>{t('缺值／無效日期', 'Missing values / invalid dates')}</th>
                    <th>{t('結果', 'Result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.prefixes.map((prefix) => (
                    <tr key={prefix.cutoff_date}>
                      <td>{prefix.cutoff_date}</td>
                      <td>{prefix.compared_sessions}</td>
                      <td>{prefix.difference_count}</td>
                      <td>
                        {prefix.unavailable_values} / {prefix.invalid_signal_sessions}
                      </td>
                      <td>{t(...STATUS[prefix.status])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(result.differences.length > 0 || result.unavailable_values.length > 0) && (
            <details open>
              <summary>{t('差異與缺值明細', 'Difference and missing-value details')}</summary>
              <p className="desk-meta">
                {t(
                  '每類最多顯示 100 筆；上方計數包含全部。— 表示不可用。',
                  'Up to 100 details per category; counts above include all. — means unavailable.',
                )}
              </p>
              <div className="table-scroll">
                <table aria-label={t('訊號與指標明細', 'Signal and indicator details')}>
                  <thead>
                    <tr>
                      <th>{t('切點／訊號日期', 'Cutoff / signal date')}</th>
                      <th>{t('欄位', 'Field')}</th>
                      <th>{t('完整歷史', 'Full history')}</th>
                      <th>{t('截短後重算', 'Rebuilt prefix')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...result.differences, ...result.unavailable_values].map((detail, index) => (
                      <tr key={index}>
                        <td>
                          {detail.prefix_end} / {detail.date}
                        </td>
                        <td>{detail.field}</td>
                        <td>{value(detail.before)}</td>
                        <td>{value(detail.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <details className="desk-method">
            <summary>{t('比較範圍與方法', 'Comparison scope and method')}</summary>
            <p className="desk-meta">{result.fields.join(', ')}</p>
            <p className="desk-meta">{result.method}</p>
            <p className="desk-meta" style={{ overflowWrap: 'anywhere' }}>
              {result.engine_version} · {result.as_of} · {result.input_revision}
              <br />
              {result.fingerprint ?? '—'}
            </p>
          </details>
        </div>
      )}
      <ResearchIntegrityReceipts
        symbol={symbol}
        evidence={result}
        request={current?.request ?? null}
        contextIdentity={identity}
        enabled={enabled && !busy}
        t={t}
      />
    </section>
  )
}
