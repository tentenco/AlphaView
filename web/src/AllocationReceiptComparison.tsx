import { useEffect, useId, useRef, useState } from 'react'
import type { ResearchReceipt } from './AllocationResearchReceipts'
import { num } from './ui'

type Translate = (zh: string, en: string) => string
type Change = {
  baseline: number | null
  selected: number | null
  delta: number | null
  reason: string | null
}
type Source = ResearchReceipt & {
  research_engine_version: string
  input_revision: string
  account_version: number | null
  symbol_policy_version: number | null
  selected_symbols: string[]
  coverage: {
    complete_symbols: number | null
    required_symbols: number | null
    common_return_sessions: number | null
    required_return_sessions: number | null
  }
}
type Method = {
  comparable: boolean
  reasons: string[]
  totals: Record<string, Change>
  symbols: ({ symbol: string } & Record<string, Change | string>)[]
}
export type ReceiptComparison = {
  engine_version: string
  account_id: string
  baseline: Source
  selected: Source
  comparability: { compatible: boolean; reasons: string[] }
  methods: { rank_sum: Method; equal_risk_contribution: Method }
}
const hash = /^[a-f0-9]{64}$/
const metric = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, 4) : '—'
const count = (value: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
const reason = (code: string, t: Translate) =>
  ({
    research_method_incompatible: t(
      '研究方法不同或不支援',
      'Research methods differ or are unsupported',
    ),
    lookback_changed: t('回看期間不同', 'Lookback periods differ'),
    selected_symbols_changed: t('選定標的不同', 'Selected symbols differ'),
    coverage_incomplete: t('來源覆蓋不完整', 'Source coverage is incomplete'),
    method_unavailable: t('此配置方法不可用', 'This allocation method is unavailable'),
    incompatible_receipts: t('收據條件不相容', 'Receipt conditions are incompatible'),
    risk_unavailable: t('風險數值不可用', 'Risk values are unavailable'),
    value_unavailable: t('缺少可比較數值', 'A comparable value is missing'),
    delta_nonfinite: t('差額不是有限值', 'The difference is nonfinite'),
  })[code] ?? code

export function AllocationReceiptComparison({
  accountId,
  history,
  selected,
  disabled = false,
  t,
}: {
  accountId: string
  history: ResearchReceipt[]
  selected: ResearchReceipt | null
  disabled?: boolean
  t: Translate
}) {
  const fieldId = useId()
  const [baselineId, setBaselineId] = useState('')
  const [result, setResult] = useState<{ identity: string; value: ReceiptComparison } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const baseline = history.find((value) => value.id === baselineId)
  const valid = (value: ResearchReceipt | null | undefined) =>
    !!value &&
    value.account_id === accountId &&
    value.integrity.available &&
    hash.test(value.id) &&
    hash.test(value.content_fingerprint)
  const canCompare =
    !disabled && valid(baseline) && valid(selected) && baseline?.id !== selected?.id
  const identity = JSON.stringify([
    accountId,
    baseline?.id,
    baseline?.content_fingerprint,
    baseline?.currentness,
    selected?.id,
    selected?.content_fingerprint,
    selected?.currentness,
    disabled,
    canCompare,
  ])
  const identityRef = useRef(identity)
  identityRef.current = identity
  useEffect(() => {
    if (!history.some((value) => value.id === baselineId && value.account_id === accountId))
      setBaselineId('')
  }, [accountId, history, baselineId])
  useEffect(() => {
    setResult(null)
    setError('')
    setBusy(false)
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [identity])
  async function compare() {
    if (!canCompare || !baseline || !selected || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch(
        `/api/paper/accounts/${encodeURIComponent(accountId)}/allocation-research-receipts/compare`,
        {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseline_id: baseline.id,
            selected_id: selected.id,
            expected_baseline_content_fingerprint: baseline.content_fingerprint,
            expected_selected_content_fingerprint: selected.content_fingerprint,
          }),
        },
      )
      const value = (await response.json()) as ReceiptComparison
      if (controller.signal.aborted || identityRef.current !== identity) return
      if (!response.ok)
        throw new Error(
          t(
            '收據無法比較；請重新讀取並核對兩筆歷史紀錄。',
            'Receipts could not be compared. Reload and verify both historical records.',
          ),
        )
      if (
        value.engine_version !== 'alphaview-allocation-research-receipt-comparison-v1' ||
        value.account_id !== accountId ||
        value.baseline.id !== baseline.id ||
        value.selected.id !== selected.id ||
        value.baseline.account_id !== accountId ||
        value.selected.account_id !== accountId ||
        !value.baseline.integrity.available ||
        !value.selected.integrity.available ||
        value.baseline.content_fingerprint !== baseline.content_fingerprint ||
        value.selected.content_fingerprint !== selected.content_fingerprint
      )
        throw new Error(
          t('比較回傳的收據識別不一致。', 'The comparison receipt identities do not match.'),
        )
      setResult({ identity, value })
    } catch (cause) {
      if (!controller.signal.aborted && identityRef.current === identity)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy(false)
      }
    }
  }
  const shown = result?.identity === identity ? result.value : null
  function exportComparison() {
    if (
      !shown ||
      busy ||
      operation.current ||
      !canCompare ||
      error ||
      identityRef.current !== identity
    )
      return
    // Keep the accepted response intact, including future fields and unavailable values.
    const blob = new Blob([JSON.stringify(shown, null, 2) + '\n'], {
      type: 'application/json;charset=utf-8',
    })
    const objectURL = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectURL
    anchor.download = `allocation-research-comparison-${shown.baseline.id}-${shown.selected.id}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(objectURL), 10000)
  }
  const current = (value: Source) =>
    value.currentness.current === null
      ? t('無法核對', 'Unverifiable')
      : value.currentness.current
        ? t('本次核對仍當期', 'Current at this read')
        : t('歷史條件已過期', 'Historical context is stale')
  return (
    <section
      className="allocation-receipt-comparison"
      aria-label={t('歷史收據比較', 'Historical receipt comparison')}
    >
      <h4>{t('歷史收據比較', 'Historical receipt comparison')}</h4>
      <p className="research-note">
        {t(
          '比較同帳戶兩筆保存值，不重新計算、不套用配置。差額是「所選收據減基準收據」的百分點變化，不代表績效改善。不同方法、回看期間、標的或不完整覆蓋不產生差額。',
          'Compares two saved receipts from this account without recalculating or applying weights. Differences are selected minus baseline in percentage points, not performance improvement. Different methods, lookbacks, symbols or incomplete coverage produce no differences.',
        )}
      </p>
      <label className="agent-field" htmlFor={fieldId}>
        {t('基準收據（目前載入頁）', 'Baseline receipt (loaded page)')}
        <select
          id={fieldId}
          value={baselineId}
          onChange={(event) => setBaselineId(event.target.value)}
          disabled={disabled}
        >
          <option value="">{t('選擇基準收據', 'Choose a baseline receipt')}</option>
          {history.map((value) => (
            <option key={value.id} value={value.id} disabled={!valid(value)}>
              {value.as_of ?? '—'} · {value.lookback_sessions ?? '—'} · {value.id.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      <p className="workflow-json">
        {t('比較目標：目前選取的歷史收據', 'Comparison target: selected historical receipt')}:{' '}
        <span title={selected?.id}>{selected?.id.slice(0, 12) ?? '—'}</span>
      </p>
      <div className="actions">
        <button className="button" disabled={!canCompare || busy} onClick={() => void compare()}>
          {busy
            ? t('比較收據…', 'Comparing receipts…')
            : t('比較基準與所選收據', 'Compare baseline and selected receipt')}
        </button>
        {shown && !busy && !error && canCompare && (
          <button className="button" onClick={exportComparison}>
            {t('匯出這次比較 JSON', 'Export this comparison JSON')}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {shown && (
        <div aria-label={t('收據比較結果', 'Receipt comparison result')} role="region">
          {(
            [
              [t('基準收據', 'Baseline receipt'), shown.baseline],
              [t('所選收據', 'Selected receipt'), shown.selected],
            ] as const
          ).map(([label, value]) => (
            <p key={label}>
              <strong>{label}</strong>: {value.as_of ?? '—'} ·{' '}
              {t('回看交易日', 'Lookback sessions')}: {value.lookback_sessions ?? '—'} ·{' '}
              {current(value)}
            </p>
          ))}
          <p>
            {shown.comparability.compatible
              ? t(
                  '條件相容；個別缺值仍不計算差額。',
                  'Conditions are compatible; individual missing values still have no difference.',
                )
              : t(
                  '條件不相容；保留各自保存值，差額不可用。',
                  'Conditions are incompatible; saved values remain visible and differences are unavailable.',
                )}
          </p>
          {!!shown.comparability.reasons.length && (
            <ul>
              {shown.comparability.reasons.map((code) => (
                <li key={code}>{reason(code, t)}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>{t('完整來源、識別與覆蓋', 'Full source, identities and coverage')}</summary>
            <div className="table-scroll">
              <table
                className="data-table"
                aria-label={t('收據來源條件', 'Receipt source context')}
              >
                <thead>
                  <tr>
                    <th>{t('項目', 'Field')}</th>
                    <th>{t('基準收據', 'Baseline receipt')}</th>
                    <th>{t('所選收據', 'Selected receipt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [t('收據識別', 'Receipt identity'), shown.baseline.id, shown.selected.id],
                    [t('來源交易日', 'Source session'), shown.baseline.as_of, shown.selected.as_of],
                    [
                      t('回看交易日', 'Lookback sessions'),
                      shown.baseline.lookback_sessions,
                      shown.selected.lookback_sessions,
                    ],
                    [
                      t('當期核對', 'Currentness'),
                      current(shown.baseline),
                      current(shown.selected),
                    ],
                    [
                      t('當期原因', 'Currentness reasons'),
                      shown.baseline.currentness.reasons.join(', ') || '—',
                      shown.selected.currentness.reasons.join(', ') || '—',
                    ],
                    [
                      t('研究方法版本', 'Research method version'),
                      shown.baseline.research_engine_version,
                      shown.selected.research_engine_version,
                    ],
                    [
                      t('輸入版本', 'Input revision'),
                      shown.baseline.input_revision,
                      shown.selected.input_revision,
                    ],
                    [
                      t('保存時帳戶版本', 'Saved account version'),
                      shown.baseline.account_version,
                      shown.selected.account_version,
                    ],
                    [
                      t('允許標的政策版本', 'Symbol-policy version'),
                      shown.baseline.symbol_policy_version,
                      shown.selected.symbol_policy_version,
                    ],
                    [
                      t('完整標的', 'Complete symbols'),
                      `${count(shown.baseline.coverage.complete_symbols)}/${count(shown.baseline.coverage.required_symbols)}`,
                      `${count(shown.selected.coverage.complete_symbols)}/${count(shown.selected.coverage.required_symbols)}`,
                    ],
                    [
                      t('共同報酬日期', 'Common return dates'),
                      `${count(shown.baseline.coverage.common_return_sessions)}/${count(shown.baseline.coverage.required_return_sessions)}`,
                      `${count(shown.selected.coverage.common_return_sessions)}/${count(shown.selected.coverage.required_return_sessions)}`,
                    ],
                  ].map(([label, before, after]) => (
                    <tr key={String(label)}>
                      <th>{label}</th>
                      <td className="workflow-reason-cell">{before ?? '—'}</td>
                      <td className="workflow-reason-cell">{after ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {(['rank_sum', 'equal_risk_contribution'] as const).map((name) => (
            <MethodChanges key={name} name={name} value={shown.methods[name]} t={t} />
          ))}
          <p className="workflow-json">{shown.engine_version}</p>
        </div>
      )}
    </section>
  )
}
function MethodChanges({ name, value, t }: { name: string; value: Method; t: Translate }) {
  const labels: Record<string, string> = {
    invested_before_pct: t('上限前投入', 'Investment before caps'),
    invested_after_pct: t('上限後投入', 'Investment after caps'),
    cash_before_pct: t('上限前現金', 'Cash before caps'),
    cash_after_pct: t('上限後現金', 'Cash after caps'),
    capped_or_rounded_to_cash_pct: t('上限與取位留現金', 'Caps and rounding to cash'),
    risk_before_volatility_annualized_pct: t('上限前年化波動', 'Annualized volatility before caps'),
    risk_after_volatility_annualized_pct: t('上限後年化波動', 'Annualized volatility after caps'),
    raw_weight_pct: t('原始權重', 'Raw weight'),
    capped_weight_pct: t('上限後權重', 'Capped weight'),
    risk_before_contributions_annualized_pct: t(
      '上限前年化風險貢獻',
      'Annualized risk contribution before caps',
    ),
    risk_after_contributions_annualized_pct: t(
      '上限後年化風險貢獻',
      'Annualized risk contribution after caps',
    ),
    risk_before_risk_shares_pct: t('上限前風險占比', 'Risk share before caps'),
    risk_after_risk_shares_pct: t('上限後風險占比', 'Risk share after caps'),
  }
  const title =
    name === 'rank_sum'
      ? t('排名總和', 'Rank sum')
      : t('完整共變異等風險貢獻', 'Full-covariance ERC')
  const rows = [
    ...Object.entries(value.totals).map(([field, change]) => ({
      label: labels[field] ?? field,
      change,
      priority: field === 'cash_after_pct' ? 0 : 3,
    })),
    ...value.symbols.flatMap((row) =>
      Object.entries(row)
        .filter(([field]) => field !== 'symbol')
        .map(([field, change]) => ({
          label: `${row.symbol} · ${labels[field] ?? field}`,
          change: change as Change,
          priority: field === 'capped_weight_pct' ? 1 : field === 'raw_weight_pct' ? 2 : 3,
        })),
    ),
  ].sort((a, b) => a.priority - b.priority)
  return (
    <details open>
      <summary>{title}</summary>
      {!!value.reasons.length && <p>{value.reasons.map((code) => reason(code, t)).join(' · ')}</p>}
      <div className="table-scroll">
        <table className="data-table" aria-label={title}>
          <thead>
            <tr>
              <th>{t('項目', 'Field')}</th>
              <th>{t('基準值（%）', 'Baseline (%)')}</th>
              <th>{t('所選值（%）', 'Selected (%)')}</th>
              <th>{t('差額（百分點）', 'Difference (pp)')}</th>
              <th>{t('差額狀態', 'Difference status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th className="workflow-reason-cell">{row.label}</th>
                <td>{metric(row.change.baseline)}</td>
                <td>{metric(row.change.selected)}</td>
                <td>{metric(row.change.delta)}</td>
                <td className="workflow-reason-cell">
                  {row.change.reason ? reason(row.change.reason, t) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
