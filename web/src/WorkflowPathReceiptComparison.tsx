import { useEffect, useRef, useState } from 'react'
import { num } from './ui'
import './workflow-path-receipt-comparison.css'

type Translate = (zh: string, en: string) => string
type Kind = 'path_validation' | 'path_costs'
type Metrics = Record<string, number | null>
type Receipt = {
  id: string
  run_id: string
  kind: Kind
  created_at: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
}
type Difference = { field: string; baseline: unknown; selected: unknown }
type Evidence = {
  metrics?: Metrics | null
  baseline?: Evidence
  scenarios?: { fee_bps: number; slippage_bps: number; metrics: Metrics | null }[]
}
type Side = { summary: Receipt; original_receipt: { evidence: Evidence } }
export type PathReceiptComparison = {
  account_id: string
  kind: Kind
  request: {
    baseline_receipt_id: string
    selected_receipt_id: string
    expected_baseline_fingerprint: string
    expected_selected_fingerprint: string
  }
  checked_as_of: string
  checked_input_revision: string
  baseline: Side
  selected: Side
  comparison: {
    historically_comparable: boolean
    reasons: string[]
    basis_checks: { code: string; matches: boolean; baseline: unknown; selected: unknown }[]
    settings_differences: Difference[]
    source_context_differences: Difference[]
    baseline_metric_deltas: Metrics | null
    scenario_pairs: {
      fee_bps: number
      slippage_bps: number
      paired: boolean
      baseline_status: string | null
      selected_status: string | null
      metric_deltas: Metrics | null
      cost_deltas: Metrics | null
      reasons: string[]
    }[]
  }
}
const LIMIT_BYTES = 5 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
const metric = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, 2) : '—'
const valueText = (value: unknown) => (value == null ? '—' : JSON.stringify(value, null, 2))
const reason = (code: string, t: Translate) =>
  ({
    method_versions: t('保存的方法版本不同或缺漏', 'Saved method versions differ or are missing'),
    pricing_method: t('估值與成交方法不同或缺漏', 'Pricing methods differ or are missing'),
    raw_history: t('原始歷史資料指紋不同或缺漏', 'Raw history fingerprints differ or are missing'),
    candidate_symbols: t(
      '候選股票池不同或無法核對',
      'Candidate universes differ or cannot be verified',
    ),
    rps_universe: t('RPS 股票池不同或無法核對', 'RPS universes differ or cannot be verified'),
    exact_window: t('完整估值期間不同或缺漏', 'Complete valuation windows differ or are missing'),
    exact_valued_dates: t(
      '逐日估值日期不同、重複或缺漏',
      'Valued dates differ, repeat or are missing',
    ),
    complete_coverage: t('原路徑涵蓋不完整', 'Original path coverage is incomplete'),
    initial_cash_and_baseline_costs: t(
      '起始資金或基準成本不同',
      'Initial cash or baseline costs differ',
    ),
    required_metrics: t('必要指標不可用', 'Required metrics are unavailable'),
    unpaired_cost_assumption: t(
      '另一回條沒有相同費用／滑價組合',
      'No identical fee/slippage pair in the other receipt',
    ),
    scenario_unavailable: t('此情境原始證據不可用', 'Original scenario evidence is unavailable'),
    scenario_metrics_unavailable: t(
      '情境指標或成本不可用',
      'Scenario metrics or costs are unavailable',
    ),
    scenario_dates_unavailable: t(
      '情境日期不完整或不相符',
      'Scenario dates are incomplete or do not match',
    ),
    scenario_initial_cash_mismatch: t('情境起始資金不相符', 'Scenario initial cash does not match'),
    duplicate_or_invalid_cost_pair: t(
      '成本組合重複、無效或與保存請求不符',
      'Cost pairs are duplicate, invalid or do not match the saved request',
    ),
    nonfinite_delta: t(
      '差額無法以有限值表示',
      'Difference cannot be represented as a finite number',
    ),
  })[code] ?? code
const basisLabel = (code: string, t: Translate) =>
  ({
    method_versions: t('保存方法版本', 'Saved method versions'),
    pricing_method: t('估值與成交方法', 'Pricing method'),
    raw_history: t('原始資料指紋', 'Raw history fingerprint'),
    candidate_symbols: t('候選股票池', 'Candidate universe'),
    rps_universe: t('RPS 股票池', 'RPS universe'),
    exact_window: t('完整估值期間', 'Complete valuation window'),
    exact_valued_dates: t('逐日估值日期', 'Exact valued dates'),
    complete_coverage: t('原路徑涵蓋', 'Original path coverage'),
    initial_cash_and_baseline_costs: t('起始資金與基準成本', 'Initial cash and baseline costs'),
    required_metrics: t('必要指標', 'Required metrics'),
  })[code] ?? code
const observed = (item: Receipt, t: Translate) =>
  item.currentness.current === true
    ? t('比較當下來源相符', 'Sources matched when compared')
    : item.currentness.current === false
      ? t('歷史來源已非當期', 'Historical sources are no longer current')
      : t('當下來源無法核對', 'Sources could not be checked at that observation')

function DifferenceTable({ rows, t }: { rows: Difference[]; t: Translate }) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('欄位', 'Field')}</th>
            <th>{t('基準', 'Baseline')}</th>
            <th>{t('對照', 'Selected')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <th scope="row">
                <code>{row.field}</code>
              </th>
              <td>
                <pre>{valueText(row.baseline)}</pre>
              </td>
              <td>
                <pre>{valueText(row.selected)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p>{t('保存值相同。', 'Saved values match.')}</p>
  )
}

export function WorkflowPathReceiptComparison({
  accountId,
  accountVersion,
  t,
}: {
  accountId: string | null
  accountVersion: number | null
  t: Translate
}) {
  const [kind, setKind] = useState<Kind>('path_validation')
  const identity = JSON.stringify([accountId, accountVersion, kind])
  const latest = useRef(identity)
  latest.current = identity
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy?: boolean
    error?: string
    items?: Receipt[]
    baseline?: string
    selected?: string
    result?: PathReceiptComparison
    raw?: string
  }>({ identity })
  const current = state.identity === identity ? state : null
  const items = current?.items ?? []
  const left = items.find((item) => item.id === current?.baseline)
  const right = items.find((item) => item.id === current?.selected)
  const base = `/api/paper/accounts/${encodeURIComponent(accountId ?? '')}/workflow-path-receipts`
  useEffect(() => {
    setState({ identity })
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [identity])

  async function perform(task: (signal: AbortSignal) => Promise<Partial<typeof state>>) {
    if (!accountId || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setState((old) => ({
      ...(old.identity === identity ? old : {}),
      identity,
      busy: true,
      error: undefined,
    }))
    try {
      const update = await task(controller.signal)
      if (!controller.signal.aborted && latest.current === identity)
        setState((old) => ({ ...old, ...update, identity, busy: false }))
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity)
        setState((old) => ({
          ...old,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }
  async function accepted(response: Response) {
    const raw = await response.text()
    if (new TextEncoder().encode(raw).length > LIMIT_BYTES)
      throw new Error(
        t(
          '回應超過 5 MiB；未截短或下載。',
          'Response exceeds 5 MiB; nothing was truncated or downloaded.',
        ),
      )
    const value = JSON.parse(raw)
    if (!response.ok)
      throw new Error(
        value.detail?.message ??
          value.detail?.code ??
          t('無法讀取保存回條；請重新載入。', 'Could not read saved receipts; load them again.'),
      )
    return { value, raw }
  }
  function load() {
    void perform(async (signal) => {
      const { value } = await accepted(await fetch(`${base}?kind=${kind}&limit=50`, { signal }))
      if (value.account_id !== accountId || value.kind !== kind || !Array.isArray(value.items))
        throw new Error(t('回條範圍不相符。', 'Receipt scope does not match.'))
      return {
        items: value.items,
        baseline: undefined,
        selected: undefined,
        result: undefined,
        raw: undefined,
      }
    })
  }
  function compare() {
    if (
      !left ||
      !right ||
      left.id === right.id ||
      !left.integrity.available ||
      !right.integrity.available
    )
      return
    setState((old) => ({ ...old, result: undefined, raw: undefined }))
    const request = {
      baseline_receipt_id: left.id,
      selected_receipt_id: right.id,
      expected_baseline_fingerprint: left.content_fingerprint,
      expected_selected_fingerprint: right.content_fingerprint,
    }
    void perform(async (signal) => {
      const { value, raw } = await accepted(
        await fetch(`${base}/compare`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      )
      if (
        value.account_id !== accountId ||
        value.kind !== kind ||
        Object.entries(request).some(([key, item]) => value.request?.[key] !== item) ||
        value.baseline?.summary?.id !== left.id ||
        value.selected?.summary?.id !== right.id ||
        value.baseline?.summary?.content_fingerprint !== left.content_fingerprint ||
        value.selected?.summary?.content_fingerprint !== right.content_fingerprint
      ) {
        throw new Error(
          t(
            '比較回應與所選回條不相符。',
            'Comparison response does not match the selected receipts.',
          ),
        )
      }
      return { result: value, raw }
    })
  }
  function select(side: 'baseline' | 'selected', id: string) {
    setState((old) => ({ ...old, [side]: id, result: undefined, raw: undefined, error: undefined }))
  }
  function download() {
    if (!current?.raw || !current.result) return
    const object = URL.createObjectURL(new Blob([current.raw], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = object
    link.download = `alphaview-path-comparison-${current.result.request.baseline_receipt_id.slice(0, 12)}-${current.result.request.selected_receipt_id.slice(0, 12)}.json`
    link.click()
    URL.revokeObjectURL(object)
  }
  const result = current?.result
  const comparison = result?.comparison
  const metrics = (side: Side) =>
    kind === 'path_validation'
      ? side.original_receipt.evidence.metrics
      : side.original_receipt.evidence.baseline?.metrics
  const names = [
    ['final_value', t('期末資產', 'Final value')],
    ['return_pct', t('報酬率（%）／差額（百分點）', 'Return (%) / difference (pp)')],
    ['max_drawdown_pct', t('最大回撤（%）／差額（百分點）', 'Max drawdown (%) / difference (pp)')],
    ['total_fees', t('累計費用', 'Total fees')],
    ['trade_count', t('交易次數', 'Trade count')],
  ]
  return (
    <section
      className="workflow-path-receipt-comparison"
      aria-label={t('比較保存路徑回條', 'Compare saved path receipts')}
    >
      <h3>{t('比較保存路徑回條', 'Compare saved path receipts')}</h3>
      <p>
        {t(
          '在相同保存資料與估值基礎下，對照不同工作流設定的歷史結果。只讀原回條，不重新計算路徑。',
          'Compare historical outcomes from different workflow settings under the same saved data and valuation basis. Original receipts only; paths are not recalculated.',
        )}
      </p>
      <p className="notice">
        {t(
          '差額是描述，不是設定變化的因果證明、排名、通過判定或交易授權。資料、期間或方法不符時保留原值，差額顯示 —。',
          'Differences are descriptive, not proof of causality, ranking, a pass decision or trading authorization. When data, windows or methods differ, original values remain and differences show —.',
        )}
      </p>
      <div className="actions">
        <label>
          {t('回條種類', 'Receipt kind')}
          <select
            value={kind}
            disabled={current?.busy}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            <option value="path_validation">{t('歷史路徑', 'Historical path')}</option>
            <option value="path_costs">{t('成本情境', 'Cost scenarios')}</option>
          </select>
        </label>
        <button type="button" disabled={!accountId || current?.busy} onClick={load}>
          {current?.busy
            ? t('讀取中…', 'Reading…')
            : t('載入此帳戶全部回條', 'Load all receipts for this account')}
        </button>
      </div>
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.items && (
        <>
          <p>
            {t('已載入', 'Loaded')} {items.length}{' '}
            {t(
              '筆；僅可選擇兩筆同種類且可驗證的回條。',
              'receipts; select two distinct verified receipts of the same kind.',
            )}
          </p>
          <div className="receipt-comparison-selectors">
            {(['baseline', 'selected'] as const).map((side) => (
              <label key={side}>
                {side === 'baseline'
                  ? t('基準回條', 'Baseline receipt')
                  : t('對照回條', 'Selected receipt')}
                <select
                  value={current?.[side] ?? ''}
                  disabled={current?.busy}
                  onChange={(event) => select(side, event.target.value)}
                >
                  <option value="">{t('請選擇', 'Choose a receipt')}</option>
                  {items.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={
                        !item.integrity.available ||
                        !hash.test(item.id) ||
                        !hash.test(item.content_fingerprint)
                      }
                    >
                      {item.created_at} · {item.run_id.slice(0, 10)} · {item.id.slice(0, 10)}
                      {item.integrity.available ? '' : ` · ${t('不可驗證', 'Unverifiable')}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={
              current?.busy ||
              !left ||
              !right ||
              left.id === right.id ||
              !left.integrity.available ||
              !right.integrity.available
            }
            onClick={compare}
          >
            {t('比較兩筆保存原件', 'Compare the two saved originals')}
          </button>
          {left && right && left.id === right.id && (
            <p role="status">{t('請選擇不同回條。', 'Choose distinct receipts.')}</p>
          )}
          {items.some((item) => !item.integrity.available) && (
            <p>
              {t(
                '無法驗證的回條保留在清單中，但不能比較。',
                'Unverifiable receipts remain listed but cannot be compared.',
              )}
            </p>
          )}
        </>
      )}
      {result && comparison && (
        <div aria-live="polite">
          <h4>
            {comparison.historically_comparable
              ? t('歷史比較基礎相符', 'Historical comparison basis matches')
              : t(
                  '歷史比較基礎不完整或不相符',
                  'Historical comparison basis is incomplete or differs',
                )}
          </h4>
          <p>
            {t(
              '差額方向：對照 − 基準。沒有優勝者。',
              'Difference direction: selected − baseline. No winner is selected.',
            )}
          </p>
          {!!comparison.reasons.length && (
            <ul>
              {comparison.reasons.map((code) => (
                <li key={code}>{reason(code, t)}</li>
              ))}
            </ul>
          )}
          <div className="receipt-comparison-observations">
            {(['baseline', 'selected'] as const).map((side) => (
              <div key={side}>
                <strong>
                  {side === 'baseline' ? t('基準', 'Baseline') : t('對照', 'Selected')}
                </strong>
                <p>
                  <code>{result[side].summary.run_id}</code>
                </p>
                <p>{observed(result[side].summary, t)}</p>
                <p>{result[side].summary.currentness.reasons.join(' · ')}</p>
              </div>
            ))}
          </div>
          <p className="muted">
            {t(
              '來源狀態是比較當下的觀察，不會自動更新。過期不會改寫保存原值，也不代表目前可執行。',
              'Source status is the observation when compared and does not refresh automatically. Staleness does not rewrite saved values or imply current execution eligibility.',
            )}{' '}
            {result.checked_as_of}
          </p>
          <details>
            <summary>{t('核對比較基礎', 'Inspect comparison basis')}</summary>
            <ul>
              {comparison.basis_checks.map((check) => (
                <li key={check.code}>
                  {basisLabel(check.code, t)}:{' '}
                  {check.matches
                    ? t('相符', 'Matches')
                    : t('不同或不可用', 'Different or unavailable')}
                </li>
              ))}
            </ul>
          </details>
          <h4>{t('原路徑指標', 'Original path metrics')}</h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('指標', 'Metric')}</th>
                  <th>{t('基準', 'Baseline')}</th>
                  <th>{t('對照', 'Selected')}</th>
                  <th>{t('差額', 'Difference')}</th>
                </tr>
              </thead>
              <tbody>
                {names.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td>{metric(metrics(result.baseline)?.[key])}</td>
                    <td>{metric(metrics(result.selected)?.[key])}</td>
                    <td>{metric(comparison.baseline_metric_deltas?.[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>{t('設定差異', 'Setting differences')}</h4>
          <DifferenceTable rows={comparison.settings_differences} t={t} />
          <details>
            <summary>{t('保存來源脈絡差異', 'Saved source context differences')}</summary>
            <DifferenceTable rows={comparison.source_context_differences} t={t} />
          </details>
          {kind === 'path_costs' && (
            <>
              <h4>{t('相同成本假設的配對', 'Pairs with identical cost assumptions')}</h4>
              <p>
                {t(
                  '只配對完全相同的費用／滑價 bps；未配對或不可用的情境不計差額。',
                  'Only identical fee/slippage bps are paired. Unpaired or unavailable scenarios have no difference.',
                )}
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('費用 / 滑價 bps', 'Fee / slippage bps')}</th>
                      <th>{t('期末資產差', 'Final value difference')}</th>
                      <th>{t('報酬差（百分點）', 'Return difference (pp)')}</th>
                      <th>{t('明列成本差', 'Explicit cost difference')}</th>
                      <th>{t('原因', 'Reason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.scenario_pairs.map((pair) => (
                      <tr key={`${pair.fee_bps}:${pair.slippage_bps}`}>
                        <th scope="row">
                          {pair.fee_bps} / {pair.slippage_bps}
                        </th>
                        <td>{metric(pair.metric_deltas?.final_value)}</td>
                        <td>{metric(pair.metric_deltas?.return_pct)}</td>
                        <td>{metric(pair.cost_deltas?.total)}</td>
                        <td>
                          {pair.reasons.map((code) => reason(code, t)).join(' · ') ||
                            t('同假設配對', 'Matched assumptions')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <button type="button" onClick={download}>
            {t('下載此次完整比較 JSON', 'Download this complete comparison JSON')}
          </button>
          <p className="muted">
            {t(
              '下載保留此次回應的完整原件與比較，不重新請求或計算；上限 5 MiB。',
              'Downloads the retained response with both complete originals and comparison, without a new request or calculation; maximum 5 MiB.',
            )}
          </p>
        </div>
      )}
    </section>
  )
}
