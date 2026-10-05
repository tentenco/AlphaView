import { useState } from 'react'
import { api, num } from './ui'
import { useSessionState } from './session-state'
import { disabledTrigger, isTriggerDraft, parseTrigger, triggerDraft } from './rebalance-trigger'
import type { RebalanceTrigger, TriggerDraft, TriggerEvidence } from './rebalance-trigger'
import './rebalance-trigger.css'

type Translate = (zh: string, en: string) => string

export function RebalanceTriggerFields({
  value,
  onChange,
  t,
  disabled = false,
}: {
  value: TriggerDraft
  onChange: (value: TriggerDraft) => void
  t: Translate
  disabled?: boolean
}) {
  return (
    <fieldset className="agent-trigger-fields" disabled={disabled}>
      <legend>{t('何時需要調倉', 'When to rebalance')}</legend>
      <p>
        {t(
          '兩項預設關閉。若同時啟用，兩項都需通過；門檻只控制調倉頻率。',
          'Both are off by default. If enabled together, both must pass. These thresholds only control rebalance frequency.',
        )}
      </p>
      <div className="agent-form-grid">
        <div>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={value.driftEnabled}
              onChange={(event) => onChange({ ...value, driftEnabled: event.target.checked })}
            />
            {t('配置偏離達門檻才調倉', 'Require a minimum allocation drift')}
          </label>
          {value.driftEnabled && (
            <label className="agent-field">
              {t(
                '最大配置偏離下限（百分點）',
                'Minimum largest allocation drift (percentage points)',
              )}
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                required
                value={value.drift}
                onChange={(event) => onChange({ ...value, drift: event.target.value })}
              />
            </label>
          )}
        </div>
        <div>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={value.cooldownEnabled}
              onChange={(event) => onChange({ ...value, cooldownEnabled: event.target.checked })}
            />
            {t('設定調倉間隔', 'Require a rebalance interval')}
          </label>
          {value.cooldownEnabled && (
            <label className="agent-field">
              {t('兩次成交至少相隔幾個已完成交易日', 'Minimum completed sessions between fills')}
              <input
                type="number"
                min="1"
                max="252"
                step="1"
                required
                value={value.cooldown}
                onChange={(event) => onChange({ ...value, cooldown: event.target.value })}
              />
            </label>
          )}
        </div>
      </div>
      <div className="agent-form-grid">
        <div>
          <label className="agent-confirm">
            <input
              type="checkbox"
              checked={value.regimeEnabled}
              onChange={(event) => onChange({ ...value, regimeEnabled: event.target.checked })}
            />
            {t('市場風險 band 變動才調倉', 'Require a market-regime band change')}
          </label>
          {value.regimeEnabled && (
            <label className="agent-field">
              {t('至少變動幾階（1–3）', 'Minimum band steps changed (1–3)')}
              <input
                type="number"
                min="1"
                max="3"
                step="1"
                required
                value={value.regimeSteps}
                onChange={(event) => onChange({ ...value, regimeSteps: event.target.value })}
              />
            </label>
          )}
        </div>
      </div>
      <p className="research-note">
        {t(
          '配置偏離包含現金與所有現有／目標持倉。間隔以此任務在此帳戶的實際模擬成交日計算，週末不算交易日；第一次成交不受間隔限制。市場風險 band 取自此帳戶的市場風險覆蓋設定，與上一筆嘗試記錄的 band 比較；首次只記錄基準，分數不完整時等待、不觸發。',
          'Drift includes cash and every held or targeted symbol. The interval uses this task’s actual paper fill session for this account, excluding non-trading days. The first fill has no interval restriction. The regime band comes from this account’s regime-overlay settings and is compared with the band recorded by the previous attempt; the first observation only records a baseline, and an incomplete score waits instead of firing.',
        )}
      </p>
    </fieldset>
  )
}

export function RebalanceTriggerEditor({
  mandate,
  t,
  onChanged,
}: {
  mandate: { id: string; version: number; rebalance_trigger?: RebalanceTrigger }
  t: Translate
  onChanged: () => void
}) {
  const [draft, setDraft] = useSessionState(
    `automation-trigger-${mandate.id}-v1`,
    () => ({ version: mandate.version, value: triggerDraft(mandate.rebalance_trigger) }),
    (value): value is { version: number; value: TriggerDraft } =>
      !!value &&
      typeof value === 'object' &&
      Number.isInteger((value as { version?: number }).version) &&
      isTriggerDraft((value as { value?: unknown }).value),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const parsed = parseTrigger(draft.value)
  const stale = draft.version !== mandate.version
  const dirty =
    JSON.stringify(parsed) !== JSON.stringify(mandate.rebalance_trigger || disabledTrigger)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!parsed || busy || stale || !dirty) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const response = await api<{
        mandate: { version: number; rebalance_trigger: RebalanceTrigger }
      }>(`/api/agent-automation/mandates/${mandate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expected_version: draft.version, rebalance_trigger: parsed }),
      })
      setDraft({
        version: response.mandate.version,
        value: triggerDraft(response.mandate.rebalance_trigger),
      })
      setSaved(true)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="agent-method">
      <summary>{t('調倉門檻與間隔', 'Rebalance thresholds and interval')}</summary>
      <form onSubmit={save}>
        <RebalanceTriggerFields
          value={draft.value}
          onChange={(value) => {
            setDraft({ ...draft, value })
            setSaved(false)
          }}
          t={t}
          disabled={busy}
        />
        <p>
          {t(
            '未達門檻會保存本日略過紀錄，下一個完成交易日再檢查。修改設定會更新任務版本，舊版待審提案需重新產生。',
            'An unmet threshold records a skipped session and checks again after the next completed session. Saving changes advances the task version; pending proposals from the old version must be regenerated.',
          )}
        </p>
        {stale && (
          <p className="notice">
            {t(
              '任務版本已變更；草稿已保留，請先載入最新設定。',
              'The task version changed. Your draft is preserved; load the latest settings before saving.',
            )}
          </p>
        )}
        {!parsed && (
          <p className="notice">
            {t('請填入啟用門檻的有效數值。', 'Enter a valid value for each enabled threshold.')}
          </p>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="notice">
            {t('調倉設定已保存。', 'Rebalance settings saved.')}
          </p>
        )}
        <div className="actions">
          <button className="button" disabled={busy || stale || !dirty || !parsed}>
            {t('保存調倉設定', 'Save rebalance settings')}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              setDraft({ version: mandate.version, value: triggerDraft(mandate.rebalance_trigger) })
              setSaved(false)
              setError('')
            }}
          >
            {t('載入最新設定', 'Load latest settings')}
          </button>
        </div>
      </form>
    </details>
  )
}

export function RebalanceTriggerTrace({
  evidence,
  t,
}: {
  evidence: TriggerEvidence
  t: Translate
}) {
  const labels = {
    disabled: t('未啟用門檻', 'Thresholds disabled'),
    pass: t('通過門檻', 'Thresholds passed'),
    skip: t('本日略過', 'Skipped this session'),
    waiting: t('等待完整資料', 'Waiting for complete data'),
    blocked: t('受規則或風險限制阻擋', 'Blocked by rules or risk limits'),
  }
  const elapsed = evidence.elapsed_sessions_exact
    ? evidence.completed_sessions_since_last_fill
    : (evidence.completed_sessions_lower_bound ?? evidence.completed_sessions_since_last_fill)
  const reasons: Record<string, [string, string]> = {
    no_change: ['沒有符合執行政策的調整', 'No changes meet the execution policy'],
    drift_below_threshold: ['配置偏離未達門檻', 'Allocation drift is below the threshold'],
    cooldown_active: [
      '距離上次成交的交易日數不足',
      'Too few completed sessions since the last fill',
    ],
    regime_baseline_recorded: [
      '首次記錄市場風險 band 作為基準',
      'Regime band recorded as the baseline',
    ],
    regime_unchanged: ['市場風險 band 未達變動階數', 'Regime band did not change enough'],
    regime_unavailable: [
      '市場風險分數不完整，等待讀數',
      'Regime score incomplete; waiting for readings',
    ],
  }
  return (
    <details className="agent-method">
      <summary>
        {t('調倉判斷', 'Rebalance decision')} · {labels[evidence.outcome] || evidence.outcome}
      </summary>
      <div className="agent-preview-stats">
        <span>
          {t('最大配置偏離', 'Largest allocation drift')}{' '}
          <strong>
            {evidence.max_weight_drift_pp === null
              ? '—'
              : `${num(evidence.max_weight_drift_pp, 4)} ${t('百分點', 'pp')}`}
          </strong>
        </span>
        <span>
          {t('上次成交交易日', 'Last fill session')}{' '}
          <strong>{evidence.last_fill?.execution_session || t('尚無成交', 'No prior fill')}</strong>
        </span>
        <span>
          {t('已相隔交易日', 'Completed sessions elapsed')}{' '}
          <strong>
            {elapsed == null ? '—' : `${evidence.elapsed_sessions_exact ? '' : '≥ '}${elapsed}`}
          </strong>
        </span>
        {evidence.regime_change?.enabled && (
          <span>
            {t('市場風險 band', 'Regime band')}{' '}
            <strong>
              {evidence.regime_change.band ?? t('不可用', 'unavailable')}
              {evidence.regime_change.previous_band
                ? ` (${t('前次', 'prev')} ${evidence.regime_change.previous_band}, ${evidence.regime_change.band_steps ?? '—'} ${t('階', 'steps')})`
                : ''}
            </strong>
          </span>
        )}
      </div>
      {evidence.reason_codes.length > 0 && (
        <ul className="agent-trigger-reasons">
          {evidence.reason_codes.map((code) => (
            <li key={code}>{reasons[code] ? t(...reasons[code]) : code}</li>
          ))}
        </ul>
      )}
      {evidence.components.length > 0 && (
        <div
          className="table-scroll"
          role="region"
          aria-label={t('配置偏離明細', 'Allocation drift components')}
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>{t('配置項目', 'Component')}</th>
                <th>{t('目前權重', 'Current weight')}</th>
                <th>{t('目標權重', 'Target weight')}</th>
                <th>{t('偏離（百分點）', 'Difference (pp)')}</th>
              </tr>
            </thead>
            <tbody>
              {evidence.components.map((component) => (
                <tr key={component.kind === 'cash' ? 'cash' : component.symbol!}>
                  <td>{component.kind === 'cash' ? t('現金', 'Cash') : component.symbol}</td>
                  <td>{num(component.current_weight_pct, 4)}%</td>
                  <td>{num(component.target_weight_pct, 4)}%</td>
                  <td>{num(component.difference_pp, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        {evidence.engine_version === 'alphaview-rebalance-trigger-v1'
          ? t(
              evidence.method,
              'Drift includes cash and all held or targeted symbols at valid completed-session reference prices. Threshold comparison uses Decimal numerators before display rounding; equality passes. Fill intervals count completed XNYS sessions for this task and account, using the specified execution session for next-open fills. Both enabled checks must pass. Missing inputs stay unavailable. These rules control paper rebalance frequency, not expected returns.',
            )
          : evidence.method}
      </p>
      <small>{evidence.engine_version}</small>
    </details>
  )
}
