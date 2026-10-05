export type RegimeChangeTrigger = { enabled: boolean; min_band_change: number }
export type RebalanceTrigger = {
  min_weight_drift_pp: number | null
  min_completed_sessions_between_fills: number | null
  regime_change?: RegimeChangeTrigger
}

export type TriggerDraft = {
  driftEnabled: boolean
  drift: string
  cooldownEnabled: boolean
  cooldown: string
  regimeEnabled: boolean
  regimeSteps: string
}

export const disabledRegimeChange: RegimeChangeTrigger = { enabled: false, min_band_change: 1 }
export const disabledTrigger: RebalanceTrigger = {
  min_weight_drift_pp: null,
  min_completed_sessions_between_fills: null,
  regime_change: disabledRegimeChange,
}

export function triggerDraft(policy: RebalanceTrigger = disabledTrigger): TriggerDraft {
  return {
    driftEnabled: policy.min_weight_drift_pp !== null,
    drift: policy.min_weight_drift_pp === null ? '' : String(policy.min_weight_drift_pp),
    cooldownEnabled: policy.min_completed_sessions_between_fills !== null,
    cooldown:
      policy.min_completed_sessions_between_fills === null
        ? ''
        : String(policy.min_completed_sessions_between_fills),
    regimeEnabled: policy.regime_change?.enabled ?? false,
    regimeSteps: String(policy.regime_change?.min_band_change ?? 1),
  }
}

export function isTriggerDraft(value: unknown): value is TriggerDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<TriggerDraft>
  return (
    typeof draft.driftEnabled === 'boolean' &&
    typeof draft.cooldownEnabled === 'boolean' &&
    typeof draft.drift === 'string' &&
    draft.drift.length <= 40 &&
    typeof draft.cooldown === 'string' &&
    draft.cooldown.length <= 40 &&
    typeof draft.regimeEnabled === 'boolean' &&
    typeof draft.regimeSteps === 'string' &&
    draft.regimeSteps.length <= 4
  )
}

export function parseTrigger(draft: TriggerDraft): RebalanceTrigger | null {
  const drift = draft.driftEnabled ? Number(draft.drift) : null
  const cooldown = draft.cooldownEnabled ? Number(draft.cooldown) : null
  const steps = draft.regimeEnabled ? Number(draft.regimeSteps) : 1
  if (draft.regimeEnabled && (!Number.isInteger(steps) || steps < 1 || steps > 3)) return null
  if (
    (draft.driftEnabled &&
      (!draft.drift.trim() ||
        drift === null ||
        !Number.isFinite(drift) ||
        drift < 0 ||
        drift > 100)) ||
    (draft.cooldownEnabled &&
      (!draft.cooldown.trim() ||
        cooldown === null ||
        !Number.isInteger(cooldown) ||
        cooldown < 1 ||
        cooldown > 252))
  )
    return null
  return {
    min_weight_drift_pp: drift,
    min_completed_sessions_between_fills: cooldown,
    regime_change: { enabled: draft.regimeEnabled, min_band_change: steps },
  }
}

export type TriggerEvidence = {
  engine_version: string
  policy: RebalanceTrigger
  outcome: 'disabled' | 'pass' | 'skip' | 'waiting' | 'blocked'
  reason_codes: string[]
  regime_change?: {
    enabled: boolean
    min_band_change: number
    status: 'disabled' | 'unavailable' | 'baseline' | 'unchanged' | 'fired'
    band: string | null
    score: number | null
    previous_band: string | null
    previous_session: string | null
    band_steps: number | null
    regime_version: string | null
    reason: string | null
  } | null
  max_weight_drift_pp: number | null
  max_weight_drift_pp_exact?: string | null
  components: {
    kind: 'symbol' | 'cash'
    symbol: string | null
    current_weight_pct: number
    target_weight_pct: number
    difference_pp: number
  }[]
  last_fill: {
    proposal_id: string
    queue_order_id?: string
    execution_session: string
    recorded_at: string
  } | null
  completed_sessions_since_last_fill: number | null
  completed_sessions_lower_bound?: number | null
  elapsed_sessions_exact: boolean
  checks: {
    code: string
    enabled: boolean
    passed: boolean | null
    actual: number | null
    required: number | null
  }[]
  method: string
}
