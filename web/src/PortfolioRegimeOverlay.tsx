import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import {
  BENCHMARKS,
  FACTOR_IDS,
  MANUAL_KEYS,
  MANUAL_RANGES,
  isoDate,
  readRegimeSettings,
  type Benchmark,
  type FactorId,
  type ManualKey,
  type RegimeFactor,
} from './market-regime'
import { num } from './ui'

type Translate = (zh: string, en: string) => string
type Reading = { value: number; as_of: string | null }
export type OverlayPolicy = {
  enabled: boolean
  mode: 'block' | 'scale'
  regime: {
    benchmark: Benchmark
    weights: Record<FactorId, number>
    inputs: Record<ManualKey, Reading | null>
  }
}
export type OverlayState = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  policy: OverlayPolicy
  policy_version: number
  cap: {
    cap_pct: number | null
    band: string | null
    score: number | null
    status: 'ok' | 'unavailable'
    reason: string | null
    missing: string[]
    stale_inputs: string[]
    regime_version: string
    regime_as_of: string
  }
  caps_table: Record<string, number>
  regime: {
    benchmark: Benchmark
    score: number | null
    zone: string | null
    complete: boolean
    missing: string[]
    stale_inputs: string[]
    factors: RegimeFactor[]
  }
  current_exposure_pct: number | null
  exposure_missing: string[]
  exposure_status: 'above_cap' | 'within_cap' | 'unavailable' | 'no_cap'
  input_revision: string
  method: string
  warnings: string[]
}
type Draft = {
  enabled: boolean
  mode: 'block' | 'scale'
  benchmark: Benchmark
  weights: Record<FactorId, string>
  inputs: Record<ManualKey, { value: string; as_of: string }>
}
type PolicyEditor = {
  draft: Draft
  baseline: Draft
  policyVersion: number
  accountVersion: number
}
type Props = { account: PaperAccount; locale: Locale }

const FACTOR_LABELS: Record<FactorId, [string, string]> = {
  buffett: ['巴菲特', 'Buffett'],
  shiller: ['Shiller PE', 'Shiller PE'],
  yield_curve: ['殖利率曲線', 'Yield curve'],
  technical: ['技術（基準 vs MA200）', 'Technical (benchmark vs MA200)'],
  sentiment: ['情緒', 'Sentiment'],
}
const INPUT_LABELS: Record<ManualKey, [string, string]> = {
  buffett_ratio: ['巴菲特指標（%）', 'Buffett ratio (%)'],
  shiller_pe: ['Shiller PE', 'Shiller PE'],
  yield_10y: ['10 年期殖利率（%）', '10y yield (%)'],
  yield_2y: ['2 年期殖利率（%）', '2y yield (%)'],
  fear_greed: ['恐懼貪婪指數', 'Fear & Greed'],
}
const BAND_LABELS: Record<string, [string, string]> = {
  calm: ['平靜', 'Calm'],
  watch: ['觀察', 'Watch'],
  elevated: ['偏高', 'Elevated'],
  extreme: ['極端', 'Extreme'],
}
const ENGLISH: Record<string, string> = {
  policy_changed: 'The overlay policy changed in another window. Reload before saving.',
}

function toDraft(policy: OverlayPolicy): Draft {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    benchmark: policy.regime.benchmark,
    weights: Object.fromEntries(
      FACTOR_IDS.map((id) => [id, String(policy.regime.weights[id])]),
    ) as Draft['weights'],
    inputs: Object.fromEntries(
      MANUAL_KEYS.map((key) => {
        const reading = policy.regime.inputs[key]
        return [key, { value: reading ? String(reading.value) : '', as_of: reading?.as_of || '' }]
      }),
    ) as Draft['inputs'],
  }
}

/** Returns the policy or the first invalid field name; blanks mean "not entered". */
export function fromDraft(draft: Draft): OverlayPolicy | { invalid: string } {
  const weights = {} as Record<FactorId, number>
  for (const id of FACTOR_IDS) {
    const weight = Number(draft.weights[id])
    if (draft.weights[id].trim() === '' || !Number.isFinite(weight) || weight < 0 || weight > 100)
      return { invalid: `weight:${id}` }
    weights[id] = weight
  }
  if (FACTOR_IDS.reduce((sum, id) => sum + weights[id], 0) <= 0) return { invalid: 'weight:total' }
  const inputs = {} as Record<ManualKey, Reading | null>
  for (const key of MANUAL_KEYS) {
    const { value, as_of } = draft.inputs[key]
    if (value.trim() === '') {
      inputs[key] = null
      continue
    }
    const parsed = Number(value)
    const [min, max] = MANUAL_RANGES[key]
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return { invalid: key }
    if (as_of.trim() !== '' && !isoDate(as_of.trim())) return { invalid: `${key}:as_of` }
    inputs[key] = { value: parsed, as_of: as_of.trim() || null }
  }
  return {
    enabled: draft.enabled,
    mode: draft.mode,
    regime: { benchmark: draft.benchmark, weights, inputs },
  }
}

async function request<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (
      detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      typeof detail.code === 'string'
    )
      throw Object.assign(
        new Error(t(String(detail.message), ENGLISH[detail.code] || String(detail.message))),
        {
          name: detail.code === 'policy_changed' ? 'PolicyConflict' : 'Error',
        },
      )
    if (Array.isArray(detail) && detail[0]?.msg) throw new Error(String(detail[0].msg))
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}

export function PortfolioRegimeOverlay({ account, locale }: Props) {
  return <RegimeOverlayPanel key={account.id} account={account} locale={locale} />
}

function RegimeOverlayPanel({ account, locale }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [state, setState] = useState<OverlayState | null>(null)
  const [editor, setEditor] = useState<PolicyEditor | null>(null)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState<'save' | 'reload' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  const draft = editor?.draft ?? null
  const dirty = !!editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline)
  const changed =
    conflict ||
    (!!editor &&
      (editor.accountVersion !== account.version ||
        (!!state && editor.policyVersion !== state.policy_version)))
  function setDraft(next: Draft | ((current: Draft | null) => Draft | null)) {
    setEditor((current) => {
      if (!current) return current
      const value = typeof next === 'function' ? next(current.draft) : next
      return value ? { ...current, draft: value } : current
    })
  }
  function receive(
    value: OverlayState,
    source: 'refresh' | 'save' | 'reload' = 'refresh',
    submitted: Draft | null = null,
  ) {
    setState((current) =>
      current &&
      (current.policy_version > value.policy_version ||
        current.account_version > value.account_version)
        ? current
        : value,
    )
    setEditor((current) => {
      if (
        current &&
        (current.policyVersion > value.policy_version ||
          current.accountVersion > value.account_version)
      )
        return current
      const next = toDraft(value.policy)
      const incoming = {
        draft: next,
        baseline: next,
        policyVersion: value.policy_version,
        accountVersion: value.account_version,
      }
      if (!current) return incoming
      const untouched = JSON.stringify(current.draft) === JSON.stringify(submitted)
      if (source === 'save') return { ...incoming, draft: untouched ? next : current.draft }
      if (source === 'reload') return untouched ? incoming : current
      return JSON.stringify(current.draft) === JSON.stringify(current.baseline) ? incoming : current
    })
  }
  useEffect(() => {
    const controller = new AbortController()
    request<OverlayState>(
      `/api/paper/accounts/${encodeURIComponent(account.id)}/regime-overlay`,
      t,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return
        receive(value)
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version])
  const parsed = draft ? fromDraft(draft) : null
  const policy = parsed && !('invalid' in parsed) ? parsed : null
  function update(change: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...change } : current))
  }
  function importFromRegimePage() {
    const settings = readRegimeSettings()
    setDraft((current) =>
      current
        ? {
            ...current,
            ...toDraft({
              enabled: current.enabled,
              mode: current.mode,
              regime: {
                benchmark: settings.benchmark,
                weights: settings.weights,
                inputs: settings.inputs,
              },
            }),
          }
        : current,
    )
    setNotice(
      t(
        '已載入市場風險頁的設定（尚未儲存）。',
        'Loaded the market-risk page settings (not saved yet).',
      ),
    )
  }
  async function perform(action: 'save' | 'reload', work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
        if (err instanceof Error && err.name === 'PolicyConflict') setConflict(true)
      }
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || !policy || changed) return
    void perform('save', async (signal) => {
      const value = await request<OverlayState>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/regime-overlay`,
        t,
        {
          method: 'PUT',
          signal,
          body: JSON.stringify({ policy, expected_version: editor.policyVersion }),
        },
      )
      if (signal.aborted) return
      receive(value, 'save', draft)
      setConflict(false)
      setNotice(t('市場風險覆蓋已保存。', 'Regime overlay saved.'))
    })
  }
  function reloadCurrent() {
    void perform('reload', async (signal) => {
      const value = await request<OverlayState>(
        `/api/paper/accounts/${encodeURIComponent(account.id)}/regime-overlay`,
        t,
        { signal },
      )
      if (signal.aborted) return
      receive(value, 'reload', draft)
      setConflict(false)
    })
  }
  const cap = state?.cap
  const capReason =
    cap?.reason === 'regime_incomplete'
      ? t('風險分數不完整', 'Risk score incomplete')
      : cap?.reason || t('不可用', 'Unavailable')
  const factorLabel = (id: string) =>
    id in FACTOR_LABELS
      ? t(...FACTOR_LABELS[id as FactorId])
      : id in INPUT_LABELS
        ? t(...INPUT_LABELS[id as ManualKey])
        : id
  const band = cap?.band ? t(...BAND_LABELS[cap.band]) : '—'
  const exposureLabel = state
    ? {
        above_cap: t('高於上限', 'Above cap'),
        within_cap: t('在上限內', 'Within cap'),
        unavailable: t('曝險無法估值', 'Exposure unavailable'),
        no_cap: t('沒有上限（風險分數不可用）', 'No cap (score unavailable)'),
      }[state.exposure_status]
    : ''
  return (
    <section
      className="agent-panel regime-overlay-panel"
      aria-label={t('市場風險覆蓋', 'Regime overlay')}
    >
      <div className="section-heading">
        <div>
          <h2>{t('市場風險覆蓋（總曝險上限）', 'Regime overlay (total exposure cap)')}</h2>
          <p>
            {t(
              '以帳戶保存的市場風險溫度計讀數算出當日分數區間，對應總投入權重上限：block 擋下超過上限的提案，scale 在建立提案前等比例縮小 Agent 目標。分數不完整就沒有上限。',
              'The stored market-risk readings give a band on the latest session, and the band caps total invested weight: block refuses proposals above the cap, scale shrinks Agent targets before the proposal. No score, no cap.',
            )}
          </p>
        </div>
        {state && (
          <strong className={cap?.status === 'ok' ? '' : 'muted'}>
            {state.policy.enabled
              ? cap?.status === 'ok'
                ? t(`上限 ${num(cap.cap_pct, 0)}%`, `Cap ${num(cap.cap_pct, 0)}%`)
                : t('上限不可用', 'Cap unavailable')
              : t('未啟用', 'Off')}
          </strong>
        )}
      </div>
      {state && (
        <dl className="agent-metrics">
          <div>
            <dt>{t('風險分數／區間', 'Score / band')}</dt>
            <dd>
              {state.regime.score == null ? '—' : num(state.regime.score, 1)} · {band}
            </dd>
          </div>
          <div>
            <dt>{t('總曝險上限', 'Exposure cap')}</dt>
            <dd>{cap?.cap_pct == null ? `— (${capReason})` : `${num(cap.cap_pct, 0)}%`}</dd>
          </div>
          <div>
            <dt>{t('目前投入權重', 'Current invested weight')}</dt>
            <dd>
              {state.current_exposure_pct == null ? '—' : `${num(state.current_exposure_pct, 2)}%`}{' '}
              · {exposureLabel}
            </dd>
          </div>
          <div>
            <dt>{t('缺少／過期因子', 'Missing / stale factors')}</dt>
            <dd>
              {state.regime.missing.length
                ? state.regime.missing.map(factorLabel).join(', ')
                : t('無缺', 'none')}
              {state.regime.stale_inputs.length
                ? ` · ${t('過期', 'Stale')}: ${state.regime.stale_inputs.map(factorLabel).join(', ')}`
                : ''}
            </dd>
          </div>
        </dl>
      )}
      {draft && (
        <form onSubmit={save}>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {t('啟用市場風險覆蓋', 'Enable regime overlay')}
          </label>
          <div className="agent-form-grid">
            <label>
              {t('模式', 'Mode')}
              <select
                value={draft.mode}
                onChange={(event) => update({ mode: event.target.value as Draft['mode'] })}
              >
                <option value="block">
                  {t(
                    'block：超過上限的提案視為違規',
                    'block: proposals above the cap are violations',
                  )}
                </option>
                <option value="scale">
                  {t(
                    'scale：自動化目標等比例縮到上限',
                    'scale: automation targets are shrunk to the cap',
                  )}
                </option>
              </select>
            </label>
            <label>
              {t('技術因子基準', 'Technical benchmark')}
              <select
                value={draft.benchmark}
                onChange={(event) => update({ benchmark: event.target.value as Benchmark })}
              >
                {BENCHMARKS.map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </select>
            </label>
            {FACTOR_IDS.map((id) => (
              <label key={id}>
                {t(`權重：${FACTOR_LABELS[id][0]}`, `Weight: ${FACTOR_LABELS[id][1]}`)}
                <input
                  inputMode="decimal"
                  value={draft.weights[id]}
                  onChange={(event) =>
                    update({ weights: { ...draft.weights, [id]: event.target.value } })
                  }
                />
              </label>
            ))}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('手動讀數', 'Manual reading')}</th>
                  <th scope="col">{t('數值（留空＝未輸入）', 'Value (blank = not entered)')}</th>
                  <th scope="col">{t('讀數日期', 'Reading date')}</th>
                </tr>
              </thead>
              <tbody>
                {MANUAL_KEYS.map((key) => (
                  <tr key={key}>
                    <th scope="row">{t(...INPUT_LABELS[key])}</th>
                    <td>
                      <input
                        aria-label={t(...INPUT_LABELS[key])}
                        inputMode="decimal"
                        value={draft.inputs[key].value}
                        onChange={(event) =>
                          update({
                            inputs: {
                              ...draft.inputs,
                              [key]: { ...draft.inputs[key], value: event.target.value },
                            },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t(
                          `${INPUT_LABELS[key][0]}日期`,
                          `${INPUT_LABELS[key][1]} date`,
                        )}
                        placeholder="YYYY-MM-DD"
                        value={draft.inputs[key].as_of}
                        onChange={(event) =>
                          update({
                            inputs: {
                              ...draft.inputs,
                              [key]: { ...draft.inputs[key], as_of: event.target.value },
                            },
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed && 'invalid' in parsed && (
            <p className="error-message" role="alert">
              {t(`欄位不合法：${parsed.invalid}`, `Invalid field: ${parsed.invalid}`)}
            </p>
          )}
          <div className="actions">
            <button className="button primary" disabled={!editor || !policy || !!busy || changed}>
              {busy === 'save' ? t('保存中…', 'Saving…') : t('保存覆蓋設定', 'Save overlay')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={importFromRegimePage}
            >
              {t('載入市場風險頁設定', 'Load market-risk page settings')}
            </button>
          </div>
        </form>
      )}
      {changed && (
        <p className="notice" role="status">
          {t(
            '帳戶或設定已在編輯期間變更；你的草稿已保留。請載入目前設定後再儲存。',
            'The account or policy changed while you were editing. Your draft is preserved. Load the current policy before saving.',
          )}
        </p>
      )}
      {dirty && <p className="notice">{t('有未儲存的修改。', 'You have unsaved changes.')}</p>}
      <div className="actions">
        <button type="button" className="button" disabled={!!busy} onClick={reloadCurrent}>
          {busy === 'reload' ? t('載入中…', 'Loading…') : t('載入目前設定', 'Load current policy')}
        </button>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {state && (
        <details className="agent-method">
          <summary>{t('這不是什麼', 'What this is not')}</summary>
          <ul>
            {state.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
            <li>
              {t('band→cap：', 'band→cap: ')}
              {Object.entries(state.caps_table)
                .map(([key, value]) => `${key} ${num(value, 0)}%`)
                .join(' · ')}
            </li>
          </ul>
          <p>{state.method}</p>
        </details>
      )}
    </section>
  )
}
