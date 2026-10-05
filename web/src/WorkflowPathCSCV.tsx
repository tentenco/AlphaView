import { useEffect, useId, useRef, useState } from 'react'
import { workflowEvidenceJson } from './workflow-evidence-json'
import { num } from './ui'
import './workflow-path-cscv.css'

type Translate = (zh: string, en: string) => string
type Receipt = {
  id: string
  account_id: string
  run_id: string
  kind: string
  created_at: string
  content_fingerprint: string
  status?: string
  as_of?: string
  integrity: { available: boolean; reason?: string | null }
  currentness: { current: boolean | null; reasons: string[] }
}
type TrialRequest = { receipt_id: string; expected_fingerprint: string }
type Request = { expected_account_version: number; trials: TrialRequest[] }
type Fractions = {
  at_or_below_median: number
  strictly_below_median: number
  exactly_at_median: number
}
type Metric = { count: number; mean: number; sample_sd: number; ratio: number }
type Selected = {
  receipt_id: string
  weight: number
  is_ratio: number
  oos_ratio: number
  oos_average_rank: number
  omega: number
  logit: number
}
type Split = {
  split: number
  is_blocks: number[]
  oos_blocks: number[]
  status: 'evaluated' | 'unavailable'
  reasons: string[]
  scores: { receipt_id: string; is: Metric | null; oos: Metric | null; reasons: string[] }[]
  is_maxima: Selected[]
  fractions: Fractions | null
  is_tie_count: number | null
  oos_has_ties: boolean | null
}
export type WorkflowCSCVResult = {
  engine_version: string
  account_id: string
  account_version: number
  request: Request
  status: 'evaluated' | 'unavailable'
  reasons: { code: string; receipt_id?: string }[]
  coverage: {
    required_trials: number
    verified_trials: number
    required_sessions: number
    available_sessions: number
    required_splits: number
    available_splits: number
  }
  trials: {
    receipt_id: string
    content_fingerprint: string
    configuration_fingerprint: string
    summary: Receipt
    original_receipt: {
      receipt_id: string
      kind: string
      account_context: { account_id: string }
      [key: string]: unknown
    }
  }[]
  comparability: {
    basis_checks: { receipt_id: string; checks: { code: string; matches: boolean }[] }[]
    duplicate_configuration_groups: { configuration_fingerprint: string; receipt_ids: string[] }[]
    settings_differences: {
      receipt_id: string
      differences: { field: string; baseline: unknown; selected: unknown }[]
    }[]
  }
  blocks: {
    block: number
    first_row: number
    last_row: number
    start: string | null
    end: string | null
  }[]
  return_matrix: { dates: string[]; columns: string[]; values: number[][] } | null
  splits: Split[]
  aggregate:
    (Fractions & { split_weight: number; is_tied_splits: number; oos_tied_splits: number }) | null
  rank_metric: {
    name: string
    sample_ddof: number
    risk_free_daily: number
    annualized: boolean
    higher_is_better: boolean
  }
  tie_method: string
  diagnostic_scope: string
  execution_authority: boolean
  recommended_configuration: null
  checked_as_of: string
  checked_input_revision: string
  evidence_fingerprint: string
  method: string
  warnings: string[]
}
const VERSION = 'alphaview-workflow-path-cscv-v1'
const LIMIT = 16 * 1024 * 1024
const hash = /^[a-f0-9]{64}$/
const metric = (value: number | null | undefined, digits = 4) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const percent = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? `${num(value * 100, 2)}%` : '—'
const fractionValid = (value: Fractions | null) =>
  !!value &&
  [value.at_or_below_median, value.strictly_below_median, value.exactly_at_median].every(
    (item) => Number.isFinite(item) && item >= 0 && item <= 1,
  )
const metricValid = (value: Metric | null) =>
  !!value &&
  value.count === 126 &&
  [value.mean, value.sample_sd, value.ratio].every(Number.isFinite) &&
  value.sample_sd > 0
const sameRequest = (left: Request, right: Request) =>
  left?.expected_account_version === right.expected_account_version &&
  Array.isArray(left.trials) &&
  left.trials.length === right.trials.length &&
  left.trials.every(
    (item, index) =>
      item.receipt_id === right.trials[index].receipt_id &&
      item.expected_fingerprint === right.trials[index].expected_fingerprint,
  )
const verified = (item: Receipt) =>
  item?.kind === 'path_validation' &&
  item.integrity?.available === true &&
  hash.test(item.id) &&
  hash.test(item.content_fingerprint)
function resultValid(value: WorkflowCSCVResult, accountId: string, request: Request) {
  const ids = request.trials.map((item) => item.receipt_id)
  if (!(
    value?.engine_version === VERSION &&
    hash.test(value.evidence_fingerprint) &&
    value.account_id === accountId &&
    value.account_version === request.expected_account_version &&
    sameRequest(value.request, request) &&
    ['evaluated', 'unavailable'].includes(value.status) &&
    value.diagnostic_scope === 'selected_saved_trials_only' &&
    value.execution_authority === false &&
    value.rank_metric?.name === 'daily_mean_over_sample_sd' &&
    value.rank_metric.sample_ddof === 1 &&
    value.rank_metric.risk_free_daily === 0 &&
    value.rank_metric.annualized === false &&
    value.rank_metric.higher_is_better === true &&
    value.tie_method === 'exact_is_maxima_equal_weight__oos_ascending_average_rank' &&
    value.recommended_configuration === null &&
    Array.isArray(value.reasons) &&
    value.reasons.every((item) => typeof item.code === 'string') &&
    Array.isArray(value.warnings) &&
    value.warnings.every((item) => typeof item === 'string') &&
    value.coverage?.required_trials === ids.length &&
    value.coverage.verified_trials === ids.length &&
    value.coverage.required_sessions === 252 &&
    value.coverage.required_splits === 20 &&
    Array.isArray(value.trials) &&
    value.trials.length === ids.length &&
    value.trials.every(
      (item, index) =>
        item?.receipt_id === ids[index] &&
        item.content_fingerprint === request.trials[index].expected_fingerprint &&
        verified(item.summary) &&
        item.summary.id === ids[index] &&
        item.summary.account_id === accountId &&
        item.summary.content_fingerprint === request.trials[index].expected_fingerprint &&
        item.original_receipt?.receipt_id === ids[index] &&
        item.original_receipt.kind === 'path_validation' &&
        item.original_receipt.account_context?.account_id === accountId,
    ) &&
    Array.isArray(value.blocks) &&
    value.blocks.length === 6 &&
    Array.isArray(value.splits) &&
    value.splits.length === 20 &&
    value.coverage.available_splits ===
      value.splits.filter((item) => item.status === 'evaluated').length &&
    Array.isArray(value.comparability?.basis_checks) &&
    Array.isArray(value.comparability.settings_differences) &&
    Array.isArray(value.comparability.duplicate_configuration_groups)
  ))
    return false
  if (
    !value.blocks.every(
      (item, index) =>
        item?.block === index + 1 &&
        item.first_row === index * 42 &&
        item.last_row === (index + 1) * 42 - 1 &&
        (item.start === null || typeof item.start === 'string') &&
        (item.end === null || typeof item.end === 'string'),
    ) ||
    value.comparability.basis_checks.length !== ids.length ||
    !value.comparability.basis_checks.every(
      (group, index) =>
        group?.receipt_id === ids[index] &&
        Array.isArray(group.checks) &&
        group.checks.length > 0 &&
        group.checks.every(
          (item) => item && typeof item.code === 'string' && typeof item.matches === 'boolean',
        ),
    ) ||
    value.comparability.settings_differences.length !== ids.length ||
    !value.comparability.settings_differences.every(
      (group, index) =>
        group?.receipt_id === ids[index] &&
        Array.isArray(group.differences) &&
        group.differences.every((item) => item && typeof item.field === 'string'),
    ) ||
    !value.comparability.duplicate_configuration_groups.every(
      (group) =>
        group &&
        hash.test(group.configuration_fingerprint) &&
        Array.isArray(group.receipt_ids) &&
        group.receipt_ids.length >= 2 &&
        group.receipt_ids.every((id) => ids.includes(id)),
    ) ||
    value.coverage.available_sessions !== (value.return_matrix === null ? 0 : 252)
  )
    return false
  if (
    !value.splits.every(
      (split, index) =>
        split?.split === index + 1 &&
        Array.isArray(split.is_blocks) &&
        split.is_blocks.length === 3 &&
        Array.isArray(split.oos_blocks) &&
        split.oos_blocks.length === 3 &&
        [...split.is_blocks, ...split.oos_blocks].slice().sort().join(',') === '1,2,3,4,5,6' &&
        Array.isArray(split.scores) &&
        split.scores.length === ids.length &&
        split.scores.every(
          (item, offset) => item?.receipt_id === ids[offset] && Array.isArray(item.reasons),
        ) &&
        Array.isArray(split.reasons) &&
        Array.isArray(split.is_maxima) &&
        (split.status === 'unavailable'
          ? split.fractions === null && split.is_maxima.length === 0
          : split.status === 'evaluated' &&
            fractionValid(split.fractions) &&
            split.scores.every((item) => metricValid(item.is) && metricValid(item.oos)) &&
            split.is_maxima.length > 0 &&
            split.is_maxima.every(
              (item) =>
                ids.includes(item.receipt_id) &&
                [
                  item.weight,
                  item.is_ratio,
                  item.oos_ratio,
                  item.oos_average_rank,
                  item.omega,
                  item.logit,
                ].every(Number.isFinite) &&
                item.weight > 0 &&
                item.weight <= 1 &&
                item.omega > 0 &&
                item.omega < 1,
            )),
    )
  )
    return false
  if (new Set(value.splits.map((item) => item.is_blocks.join(','))).size !== 20) return false
  if (
    value.return_matrix &&
    !(
      value.return_matrix.dates.length === 252 &&
      value.return_matrix.columns.join(',') === ids.join(',') &&
      value.return_matrix.values.length === 252 &&
      value.return_matrix.values.every(
        (row) => Array.isArray(row) && row.length === ids.length && row.every(Number.isFinite),
      )
    )
  )
    return false
  return value.status === 'unavailable'
    ? value.aggregate === null
    : fractionValid(value.aggregate) &&
        value.aggregate?.split_weight === 0.05 &&
        [value.aggregate.is_tied_splits, value.aggregate.oos_tied_splits].every(
          (item) => Number.isInteger(item) && item >= 0 && item <= 20,
        ) &&
        value.coverage.available_splits === 20 &&
        value.coverage.available_sessions === 252 &&
        !!value.return_matrix
}
const reason = (code: string, t: Translate) =>
  ({
    method_versions: t('保存方法版本不同或缺漏', 'Saved method versions differ or are missing'),
    pricing_method: t('估值方法不同或缺漏', 'Pricing methods differ or are missing'),
    raw_history: t('原始歷史指紋不同或缺漏', 'Raw history fingerprints differ or are missing'),
    candidate_symbols: t('候選股票池不相符', 'Candidate universes do not match'),
    rps_universe: t('RPS 股票池不相符', 'RPS universes do not match'),
    exact_window: t('完整估值期間不相符', 'Complete valuation windows do not match'),
    exact_valued_dates: t('逐日日期不相符或不完整', 'Daily dates do not match or are incomplete'),
    complete_coverage: t('原路徑涵蓋不完整', 'Original path coverage is incomplete'),
    initial_cash_and_baseline_costs: t(
      '原始資金或成本假設不同',
      'Original capital or cost assumptions differ',
    ),
    required_metrics: t('必要指標不可用', 'Required metrics unavailable'),
    duplicate_trial_configuration: t(
      '完整設定重複，不能當成不同試驗',
      'Complete configurations repeat and cannot count as distinct trials',
    ),
    required_252_sessions: t(
      '需要完整相同的 252 交易日',
      'Exactly 252 matching sessions are required',
    ),
    daily_return_unavailable: t(
      '每日報酬無法以有限值表示',
      'Daily returns cannot be represented as finite values',
    ),
    return_matrix_unavailable: t('同步報酬矩陣不可用', 'Synchronous return matrix unavailable'),
    split_metric_unavailable: t(
      '至少一組切分的排名指標不可用',
      'At least one split has an unavailable rank metric',
    ),
    trial_metric_unavailable: t(
      '試驗指標的標準差為零或算術不可用',
      'Trial metric has zero standard deviation or unavailable arithmetic',
    ),
    is_metric_unavailable: t('IS 指標不可用', 'IS metric unavailable'),
    oos_metric_unavailable: t('OOS 指標不可用', 'OOS metric unavailable'),
  })[code] ?? code

export function WorkflowPathCSCV({
  accountId,
  accountVersion,
  t,
}: {
  accountId: string | null
  accountVersion: number | null
  t: Translate
}) {
  const labelId = useId()
  const identity = JSON.stringify([accountId, accountVersion])
  const latest = useRef(identity)
  latest.current = identity
  const operation = useRef<AbortController | null>(null)
  const accepted = useRef<{ identity: string; key: string; result: WorkflowCSCVResult } | null>(
    null,
  )
  const checkingRef = useRef(false)
  const [checking, setChecking] = useState(false)
  const [splitIndex, setSplitIndex] = useState(0)
  const [state, setState] = useState<{
    identity: string
    items?: Receipt[]
    selected: string[]
    busy?: 'load' | 'calculate'
    result?: WorkflowCSCVResult
    raw?: string
    error?: string
    stale?: boolean
  }>({ identity, selected: [] })
  const active = state.identity === identity ? state : null
  const items = active?.items ?? []
  const selected = active?.selected ?? []
  const key = JSON.stringify(
    selected.map((id) => [id, items.find((item) => item.id === id)?.content_fingerprint]),
  )
  const latestKey = useRef(key)
  latestKey.current = key
  if (accepted.current?.identity !== identity || accepted.current?.key !== key)
    accepted.current = null
  const result = active?.result ?? null
  const available =
    !!accountId &&
    typeof accountVersion === 'number' &&
    Number.isInteger(accountVersion) &&
    accountVersion > 0
  const base = `/api/paper/accounts/${encodeURIComponent(accountId ?? '')}/workflow-path-receipts`
  const sourceMessage = t(
    '所選回條或帳戶版本已變更，或目前無法核對；請重新載入回條。',
    'The selected receipts or account version changed, or cannot be checked. Reload the receipts.',
  )
  const trialName = (id: string) =>
    `${t('試驗', 'Trial')} ${(result?.request.trials ?? selected.map((receipt_id) => ({ receipt_id }))).findIndex((item) => item.receipt_id === id) + 1}`
  useEffect(() => {
    setState({ identity, selected: [] })
    setSplitIndex(0)
    setChecking(false)
    checkingRef.current = false
    return () => {
      operation.current?.abort()
      operation.current = null
      accepted.current = null
    }
  }, [identity])
  async function read(response: Response) {
    const raw = await response.text()
    if (new TextEncoder().encode(raw).length > LIMIT)
      throw new Error(
        t(
          '完整回應超過 16 MiB，未截斷或下載。',
          'The complete response exceeds 16 MiB; nothing was truncated or downloaded.',
        ),
      )
    if (!response.ok) {
      let detail: {
        code?: unknown
        receipt_ids?: unknown
        coverage?: Record<string, unknown>
      } | null = null
      if (response.status === 409) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (
            parsed &&
            typeof parsed === 'object' &&
            'detail' in parsed &&
            parsed.detail &&
            typeof parsed.detail === 'object'
          )
            detail = parsed.detail
        } catch {
          detail = null
        }
      }
      if (detail?.code === 'cscv_trial_configuration_unavailable') {
        let message = t(
          '所選保存試驗缺少必要設定資訊；整份選取已拒絕，未計算部分 CSCV 結果。',
          'A selected saved trial is missing required configuration information. The whole selection was rejected; no partial CSCV result was calculated.',
        )
        const coverage = detail.coverage
        const ids = detail.receipt_ids
        if (
          coverage &&
          Array.isArray(ids) &&
          ids.length > 0 &&
          new Set(ids).size === ids.length &&
          ids.every((id) => typeof id === 'string' && hash.test(id) && selected.includes(id)) &&
          [
            'required_trials',
            'verified_trials',
            'available_configurations',
            'unavailable_configurations',
          ].every(
            (field) =>
              typeof coverage[field] === 'number' &&
              Number.isInteger(coverage[field]) &&
              Number(coverage[field]) >= 0 &&
              Number(coverage[field]) <= 8,
          ) &&
          coverage.required_trials === selected.length &&
          coverage.required_trials === coverage.verified_trials &&
          coverage.unavailable_configurations === ids.length &&
          Number(coverage.available_configurations) +
            Number(coverage.unavailable_configurations) ===
            coverage.required_trials
        ) {
          message += ` ${t('可用設定', 'Available configurations')} ${coverage.available_configurations} / ${coverage.required_trials}; ${t('不可用設定', 'unavailable')} ${coverage.unavailable_configurations}.`
        }
        throw new Error(message)
      }
      throw new Error(
        response.status === 409
          ? sourceMessage
          : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
      )
    }
    const value = JSON.parse(raw)
    workflowEvidenceJson(value, raw)
    return { value, raw }
  }
  async function index(signal: AbortSignal) {
    const { value } = await read(
      await fetch(`${base}?kind=path_validation&limit=50`, { cache: 'no-store', signal }),
    )
    if (
      value.account_id !== accountId ||
      value.account_version !== accountVersion ||
      value.kind !== 'path_validation' ||
      !Array.isArray(value.items) ||
      value.items.length > 50 ||
      value.pagination?.returned !== value.items.length ||
      value.pagination?.total !== value.items.length ||
      value.items.some(
        (item: Receipt) =>
          item?.account_id !== accountId ||
          [item.id, item.run_id, item.created_at, item.content_fingerprint].some(
            (field) => typeof field !== 'string',
          ) ||
          item.kind !== 'path_validation' ||
          !item.integrity ||
          !item.currentness,
      )
    )
      throw new Error(sourceMessage)
    return value.items as Receipt[]
  }
  const matching = (next: Receipt[], request: Request) =>
    request.trials.every((trial) =>
      next.some(
        (item) =>
          verified(item) &&
          item.id === trial.receipt_id &&
          item.content_fingerprint === trial.expected_fingerprint,
      ),
    )
  useEffect(() => {
    if (!result) return
    const controller = new AbortController()
    const check = async () => {
      if (checkingRef.current || operation.current || document.visibilityState === 'hidden') return
      checkingRef.current = true
      setChecking(true)
      try {
        if (!matching(await index(controller.signal), result.request))
          throw new Error(sourceMessage)
      } catch {
        if (
          !controller.signal.aborted &&
          latest.current === identity &&
          latestKey.current === key
        ) {
          accepted.current = null
          setState((old) => ({ ...old, result: undefined, raw: undefined, stale: true }))
        }
      } finally {
        if (!controller.signal.aborted && latest.current === identity) {
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
  }, [result, identity, key])
  async function load() {
    if (!available || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    accepted.current = null
    setState((old) => ({
      ...(old.identity === identity ? old : { identity, selected: [] }),
      identity,
      busy: 'load',
      result: undefined,
      raw: undefined,
      error: undefined,
      stale: false,
    }))
    try {
      const values = await index(controller.signal)
      if (!controller.signal.aborted && latest.current === identity)
        setState({ identity, items: values, selected: [] })
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity)
        setState((old) => ({
          ...old,
          busy: undefined,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  function toggle(id: string) {
    if (operation.current || !items.some((item) => item.id === id && verified(item))) return
    const next = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : selected.length < 8
        ? [...selected, id]
        : selected
    accepted.current = null
    setSplitIndex(0)
    setState((old) => ({
      ...old,
      selected: next,
      result: undefined,
      raw: undefined,
      error: undefined,
      stale: false,
    }))
  }
  async function inspect() {
    if (
      !available ||
      operation.current ||
      selected.length < 3 ||
      selected.length > 8 ||
      selected.some((id) => !items.some((item) => item.id === id && verified(item)))
    )
      return
    const controller = new AbortController()
    operation.current = controller
    accepted.current = null
    checkingRef.current = false
    setChecking(false)
    const request: Request = {
      expected_account_version: accountVersion!,
      trials: selected.map((id) => ({
        receipt_id: id,
        expected_fingerprint: items.find((item) => item.id === id)!.content_fingerprint,
      })),
    }
    setState((old) => ({
      ...old,
      busy: 'calculate',
      result: undefined,
      raw: undefined,
      error: undefined,
      stale: false,
    }))
    try {
      const { value, raw } = await read(
        await fetch(`${base}/cscv`, {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      )
      if (controller.signal.aborted || latest.current !== identity || latestKey.current !== key)
        return
      if (!resultValid(value, accountId!, request))
        throw new Error(
          t(
            '診斷回應與所選回條或固定方法不相符。',
            'The diagnostic response does not match the selected receipts or fixed method.',
          ),
        )
      if (!matching(await index(controller.signal), request)) throw new Error(sourceMessage)
      if (!controller.signal.aborted && latest.current === identity && latestKey.current === key) {
        accepted.current = { identity, key, result: value }
        setState((old) => ({ ...old, busy: undefined, result: value, raw }))
        setSplitIndex(0)
      }
    } catch (error) {
      if (!controller.signal.aborted && latest.current === identity && latestKey.current === key)
        setState((old) => ({
          ...old,
          busy: undefined,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  function download() {
    if (
      !result ||
      !active?.raw ||
      accepted.current?.result !== result ||
      latest.current !== identity ||
      latestKey.current !== key ||
      operation.current ||
      checkingRef.current
    )
      return
    try {
      const raw = workflowEvidenceJson(result, active.raw)
      const object = URL.createObjectURL(
        new Blob([raw], { type: 'application/json;charset=utf-8' }),
      )
      const anchor = document.createElement('a')
      anchor.href = object
      anchor.download = `alphaview-selected-trial-cscv-${result.evidence_fingerprint.slice(0, 16)}.json`
      document.body.appendChild(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(object), 10000)
      }
    } catch {
      setState((old) => ({
        ...old,
        error: t('CSCV 證據下載失敗', 'CSCV evidence download failed'),
      }))
    }
  }
  const split = result?.splits[splitIndex]
  return (
    <section className="agent-panel workflow-path-cscv" aria-labelledby={labelId}>
      <h3 id={labelId}>
        {t('選取試驗的 CSCV 排名穩定性', 'CSCV rank stability of selected trials')}
      </h3>
      <p className="research-note">
        {t(
          '選擇 3–8 筆同帳戶、不同完整設定的已保存路徑回條，檢視 IS 並列最高者在互補 OOS 的相對名次。只描述所選試驗；未保存或捨棄的探索試驗未知。',
          'Select 3–8 saved path receipts from the same account with different complete configurations. Inspect the relative OOS ranks of IS maxima. This describes selected trials only; unsaved or discarded discovery trials are unknown.',
        )}
      </p>
      <p>
        {t(
          '固定 252 日、六個 42 日區塊、全部二十組 126／126 日互補切分。排名指標為每日平均淨報酬 ÷ 樣本標準差（ddof 1），無風險利率為零、不年化。',
          'Fixed at 252 sessions, six 42-session blocks and all twenty complementary 126/126-session splits. Rank metric: daily mean net return / sample standard deviation (ddof 1), zero risk-free rate, no annualization.',
        )}
      </p>
      <p className="notice">
        {t(
          '這不是完整搜尋的 PBO、獨立樣本、CPCV、purging／embargo、樣本外證明、推薦配置或執行閘門。',
          'This is not complete-search PBO, independent samples, CPCV, purging/embargo, out-of-sample proof, a recommended configuration or an execution gate.',
        )}
      </p>
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={!available || !!active?.busy}
          onClick={load}
        >
          {active?.busy === 'load'
            ? t('載入保存試驗中…', 'Loading saved trials…')
            : t('載入此帳戶的路徑回條', 'Load path receipts for this account')}
        </button>
      </div>
      {active?.error && (
        <p role="alert" className="error-message">
          {active.error}
        </p>
      )}
      {active?.stale && (
        <p role="status" className="notice">
          {sourceMessage}
        </p>
      )}
      {active?.items && (
        <>
          <p>
            {t('已選取', 'Selected')}: {selected.length}/8 ·{' '}
            {t(
              '至少三筆；完整設定重複時保留原件並停止合計。',
              'At least three; repeated complete configurations retain originals and disable the aggregate.',
            )}
          </p>
          {!items.length && (
            <p>
              {t(
                '此帳戶沒有已保存的歷史路徑回條。',
                'This account has no saved historical path receipts.',
              )}
            </p>
          )}
          <fieldset className="cscv-receipt-list" disabled={!!active.busy}>
            <legend>{t('選取保存試驗', 'Select saved trials')}</legend>
            {items.map((item, index) => (
              <label key={item.id || `unverifiable-${index}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={
                    !verified(item) || (!selected.includes(item.id) && selected.length >= 8)
                  }
                  onChange={() => toggle(item.id)}
                />
                <span>
                  {item.created_at || '—'} · {t('工作流', 'Workflow')} {item.run_id.slice(0, 10)}
                  <small>
                    {t('回條', 'Receipt')} {item.id.slice(0, 12) || '—'} ·{' '}
                    {verified(item)
                      ? t('原件可驗證', 'Original verified')
                      : t('原件不可驗證', 'Original unverifiable')}{' '}
                    ·{' '}
                    {item.currentness.current === true
                      ? t('來源相符', 'Sources match')
                      : item.currentness.current === false
                        ? t('歷史來源已非當期', 'Historical sources are no longer current')
                        : t('來源狀態未知', 'Source status unknown')}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={!available || !!active.busy || selected.length < 3 || selected.length > 8}
              onClick={inspect}
            >
              {active.busy === 'calculate'
                ? t('計算固定切分中…', 'Calculating fixed splits…')
                : t('檢查選取試驗的 CSCV', 'Inspect selected-trial CSCV')}
            </button>
            {result && (
              <button
                className="button"
                type="button"
                disabled={checking || !!active.busy}
                onClick={download}
              >
                {t('下載完整 CSCV 證據 JSON', 'Download complete CSCV evidence JSON')}
              </button>
            )}
          </div>
        </>
      )}
      {result && (
        <>
          <p role="status">
            {result.status === 'evaluated'
              ? t(
                  '二十組切分已計算；不產生通過判定或推薦配置',
                  'All twenty splits evaluated; no pass verdict or recommended configuration',
                )
              : t(
                  'CSCV 合計不可用；全部所選試驗與二十組切分仍保留',
                  'CSCV aggregate unavailable; all selected trials and twenty splits are retained',
                )}
          </p>
          <p>
            {t('可用同步交易日', 'Available synchronous sessions')}:{' '}
            {result.coverage.available_sessions}/252 · {t('可用切分', 'Available splits')}:{' '}
            {result.coverage.available_splits}/20 · {t('原件已驗證', 'Originals verified')}:{' '}
            {result.coverage.verified_trials}/{result.coverage.required_trials}
          </p>
          {!!result.reasons.length && (
            <ul className="notice">
              {result.reasons.map((item, index) => (
                <li key={index}>
                  {item.receipt_id ? `${trialName(item.receipt_id)}: ` : ''}
                  {reason(item.code, t)}
                </li>
              ))}
            </ul>
          )}
          <dl className="cscv-fractions">
            <div>
              <dt>{t('低於或等於中位數（≤ 0）', 'At or below median (≤ 0)')}</dt>
              <dd>{percent(result.aggregate?.at_or_below_median)}</dd>
            </div>
            <div>
              <dt>{t('嚴格低於中位數（< 0）', 'Strictly below median (< 0)')}</dt>
              <dd>{percent(result.aggregate?.strictly_below_median)}</dd>
            </div>
            <div>
              <dt>{t('恰等於中位數（= 0）', 'Exactly at median (= 0)')}</dt>
              <dd>{percent(result.aggregate?.exactly_at_median)}</dd>
            </div>
          </dl>
          <p className="notice">
            {t(
              '三個比例需一起閱讀：全部同分時依序為 100%、0%、100%，第一個數字本身不能證明過度擬合。每組切分權重 1/20；IS 並列最高者均分該組權重。',
              'Read all three fractions together: all ties produce 100%, 0%, 100%, so the first number alone does not establish overfitting. Each split has weight 1/20; exact IS maxima share that split equally.',
            )}
          </p>
          <p>
            {t('IS 並列最高的切分', 'Splits with tied IS maxima')}:{' '}
            {metric(result.aggregate?.is_tied_splits, 0)}/20 ·{' '}
            {t('OOS 有同分的切分', 'Splits with OOS ties')}:{' '}
            {metric(result.aggregate?.oos_tied_splits, 0)}/20
          </p>
          <div className="cscv-blocks">
            {result.blocks.map((block) => (
              <div key={block.block}>
                <strong>
                  {t('區塊', 'Block')} {block.block}
                </strong>
                <span>
                  {block.start ?? '—'} → {block.end ?? '—'}
                </span>
                <small>
                  {t('矩陣列', 'Matrix rows')} {block.first_row + 1}–{block.last_row + 1}
                </small>
              </div>
            ))}
          </div>
          <div className="table-scroll">
            <table>
              <caption>
                {t(
                  '全部二十組互補切分；比例包含明示的同分權重',
                  'All twenty complementary splits; fractions include explicit tie weights',
                )}
              </caption>
              <thead>
                <tr>
                  {[
                    t('切分', 'Split'),
                    t('IS 區塊', 'IS blocks'),
                    t('OOS 區塊', 'OOS blocks'),
                    t('IS 並列最高者', 'IS maxima'),
                    t('低於或等於', 'At or below'),
                    t('嚴格低於', 'Strictly below'),
                    t('恰等於', 'Exactly at'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.splits.map((item) => (
                  <tr key={item.split}>
                    <th scope="row">
                      {item.split}
                      {item.status === 'unavailable' && <span>{t('不可用', 'Unavailable')}</span>}
                    </th>
                    <td>{item.is_blocks.join(', ')}</td>
                    <td>{item.oos_blocks.join(', ')}</td>
                    <td>
                      {item.is_maxima.map((value) => trialName(value.receipt_id)).join(', ') || '—'}
                    </td>
                    <td>{percent(item.fractions?.at_or_below_median)}</td>
                    <td>{percent(item.fractions?.strictly_below_median)}</td>
                    <td>{percent(item.fractions?.exactly_at_median)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>
              {t(
                '檢查各切分分數、同分權重與 logit',
                'Inspect split scores, tie weights and logits',
              )}
            </summary>
            <label className="cscv-split-select">
              {t('選擇切分', 'Select split')}
              <select
                value={splitIndex}
                onChange={(event) => setSplitIndex(Number(event.target.value))}
              >
                {result.splits.map((item, index) => (
                  <option key={item.split} value={index}>
                    {item.split}: IS {item.is_blocks.join(', ')} / OOS {item.oos_blocks.join(', ')}
                  </option>
                ))}
              </select>
            </label>
            {split && (
              <>
                {!!split.reasons.length && (
                  <p className="notice">
                    {split.reasons.map((code) => reason(code, t)).join(' · ')}
                  </p>
                )}
                <div className="table-scroll">
                  <table>
                    <caption>
                      {t(
                        '各試驗每日平均／樣本標準差',
                        'Trial daily mean / sample standard deviation',
                      )}
                    </caption>
                    <thead>
                      <tr>
                        {[
                          t('試驗', 'Trial'),
                          t('IS 平均', 'IS mean'),
                          t('IS 樣本標準差', 'IS sample SD'),
                          t('IS 指標', 'IS metric'),
                          t('OOS 平均', 'OOS mean'),
                          t('OOS 樣本標準差', 'OOS sample SD'),
                          t('OOS 指標', 'OOS metric'),
                        ].map((label) => (
                          <th key={label}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {split.scores.map((item) => (
                        <tr key={item.receipt_id}>
                          <th>
                            {trialName(item.receipt_id)}
                            {!!item.reasons.length && (
                              <span>{item.reasons.map((code) => reason(code, t)).join(' · ')}</span>
                            )}
                          </th>
                          <td>{metric(item.is?.mean, 8)}</td>
                          <td>{metric(item.is?.sample_sd, 8)}</td>
                          <td>{metric(item.is?.ratio)}</td>
                          <td>{metric(item.oos?.mean, 8)}</td>
                          <td>{metric(item.oos?.sample_sd, 8)}</td>
                          <td>{metric(item.oos?.ratio)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="table-scroll">
                  <table>
                    <caption>
                      {t('本切分 IS 最高者的 OOS 名次', 'OOS ranks of this split’s IS maxima')}
                    </caption>
                    <thead>
                      <tr>
                        {[
                          t('試驗', 'Trial'),
                          t('本組權重', 'Within-split weight'),
                          t('OOS 平均名次', 'OOS average rank'),
                          t('相對名次 ω', 'Relative rank ω'),
                          t('Logit λ', 'Logit λ'),
                        ].map((label) => (
                          <th key={label}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {split.is_maxima.map((item) => (
                        <tr key={item.receipt_id}>
                          <th>{trialName(item.receipt_id)}</th>
                          <td>{metric(item.weight, 6)}</td>
                          <td>{metric(item.oos_average_rank, 2)}</td>
                          <td>{metric(item.omega, 6)}</td>
                          <td>{metric(item.logit, 6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </details>
          <details>
            <summary>
              {t(
                '原件、比較基礎與設定差異',
                'Originals, comparison basis and configuration differences',
              )}
            </summary>
            <p>
              {t(
                '歷史原件可比較不代表來源仍當期；不要求舊回條重新計算。不同完整設定可產生完全相同的報酬，依同分規則保留。',
                'Historically comparable originals do not imply current sources; old receipts are not recalculated. Different complete configurations may produce identical returns and remain under the tie rule.',
              )}
            </p>
            {result.trials.map((item) => (
              <div className="cscv-trial" key={item.receipt_id}>
                <h4>{trialName(item.receipt_id)}</h4>
                <p>
                  {t('回條指紋', 'Receipt fingerprint')}: <code>{item.content_fingerprint}</code>
                </p>
                <p>
                  {t('設定指紋', 'Configuration fingerprint')}:{' '}
                  <code>{item.configuration_fingerprint}</code>
                </p>
                <p>
                  {item.summary.currentness.current === true
                    ? t('診斷快照的來源相符', 'Sources matched in the diagnostic snapshot')
                    : t(
                        '歷史來源已非當期或目前無法核對',
                        'Historical sources are stale or could not be checked',
                      )}
                </p>
              </div>
            ))}
            {result.comparability.duplicate_configuration_groups.map((group) => (
              <p className="notice" key={group.configuration_fingerprint}>
                {t('完整設定重複', 'Repeated complete configuration')}:{' '}
                {group.receipt_ids.map(trialName).join(', ')}
              </p>
            ))}
            {result.comparability.basis_checks.map((group) => (
              <p key={group.receipt_id}>
                {trialName(group.receipt_id)}:{' '}
                {group.checks.every((item) => item.matches)
                  ? t('保存比較基礎相符', 'Saved comparison basis matches')
                  : group.checks
                      .filter((item) => !item.matches)
                      .map((item) => reason(item.code, t))
                      .join(' · ')}
              </p>
            ))}
            {result.comparability.settings_differences.map((group) => (
              <div key={group.receipt_id}>
                <h4>{trialName(group.receipt_id)}</h4>
                {group.differences.length ? (
                  <pre>{JSON.stringify(group.differences, null, 2)}</pre>
                ) : (
                  <p>
                    {t('與第一筆完整設定相同', 'Complete configuration matches the first trial')}
                  </p>
                )}
              </div>
            ))}
          </details>
          <details>
            <summary>
              {t('方法、限制與完整下載', 'Method, limitations and complete download')}
            </summary>
            <p>
              <code>{result.engine_version}</code>
            </p>
            <p>
              {t('完整證據指紋', 'Complete evidence fingerprint')}:{' '}
              <code>{result.evidence_fingerprint}</code>
            </p>
            <p>{result.method}</p>
            <ul>
              {result.warnings.map((warning) => (
                <li key={warning}>{t(warning, warning)}</li>
              ))}
            </ul>
            <p>
              {t(
                '下載保留完整原回條、同步矩陣、全部切分與原始 JSON 精度；不另外讀取價格或重跑工作流。',
                'The download retains complete original receipts, the synchronous matrix, every split and original JSON precision. It does not read prices or rerun workflows.',
              )}
            </p>
            <a
              href="https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf"
              target="_blank"
              rel="noreferrer"
            >
              {t(
                '方法來源：Bailey 等，Algorithm 2.3 與 §3.1',
                'Method source: Bailey et al., Algorithm 2.3 and §3.1',
              )}
            </a>
          </details>
        </>
      )}
    </section>
  )
}
