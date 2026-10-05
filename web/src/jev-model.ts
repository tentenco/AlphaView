import type { PaperPreview, PaperProposal, PaperTarget } from './paper-model'
import type { AgentConstraints, AgentRun, AgentStrategy } from './portfolio-agent-model'

export type JevPolicy = { pass_threshold: number; max_risk_probability: number }
export type JevStatus = 'completed' | 'blocked' | 'stale' | 'failed'
export type JevGateStatus = 'pass' | 'fail' | 'unavailable'
export type JevConnection = {
  engine_version: string
  question_set_version: string
  provider: string
  product: string
  endpoint: string
  model: string
  configured: boolean
  version: string | null
  connected_at: string | null
  available_models: string[]
  capabilities: string[]
  trading_enabled: false
  price_basis: string
  method: string
}
export type JevQuestion = {
  id: string
  type: 'noul' | 'score'
  gate: 'high' | 'low' | null
  label: string
  english: string
  instructions: string
  criteria: Record<string, string> | string[]
}
export type JevQuestionSet = {
  engine_version: string
  question_set_version: string
  model: string
  language: string
  default_policy: JevPolicy
  max_selected: number
  questions: JevQuestion[]
  state_fields: string[]
  price_basis: string
  method: string
  warnings: string[]
}
export type JevIssue = { code: string; message: string; question_id?: string }
export type JevCheck = {
  question_id: string
  question: string
  label: string
  english: string
  direction: 'high' | 'low'
  value: number | null
  threshold: number
  passed: boolean | null
  reason: string | null
}
export type JevDecision = {
  symbol: string
  key: string
  original_weight_pct: number
  evidence_complete: boolean
  missing: string[]
  status: JevGateStatus
  checks: JevCheck[]
  setup_quality: {
    question_id: string
    score: number
    confidence: number
    probabilities: Record<string, number>
    level_label: string | null
  } | null
  target_weight_pct: number
}
export type JevResult = {
  policy: JevPolicy
  decisions: JevDecision[]
  counts: Record<JevGateStatus, number>
  blocking_reasons: JevIssue[]
  target_weights: PaperTarget[]
  cash_weight_pct: number | null
  proposal_ready: boolean
}
export type JevUsage = { input_tokens: number | null; output_tokens: number | null }
export type JevRunSummary = {
  id: string
  engine_version: string
  question_set_version: string
  source_run_id: string
  status: JevStatus
  stored_status: JevStatus
  created_at: string
  as_of: string
  input_revision: string
  request: { source_run_id: string; policy: JevPolicy; idempotency_key: string }
  policy: JevPolicy
  model: { requested: string; answered: string | null }
  latency_ms: number | null
  usage: JevUsage
  estimated_cost_usd: number | null
  error: (JevIssue & { issues?: JevIssue[] }) | null
  counts: Record<JevGateStatus, number>
  proposal_ready: boolean
  target_weights: PaperTarget[]
  cash_weight_pct: number | null
  current: boolean
  stale_reasons: string[]
}
export type JevRun = JevRunSummary & {
  source: {
    id: string
    engine_version: string
    as_of: string
    input_revision: string
    proposal_fingerprint: string
    scan: AgentRun['scan']
    target_weights: PaperTarget[]
    cash_weight_pct: number
    constraints: AgentConstraints
    strategy_weights: Record<AgentStrategy, number>
    account_context?: { account_id: string }
  }
  state: { as_of: string; price_basis: string; candidates: Record<string, Record<string, unknown>> }
  questions: Record<string, { type: 'noul' | 'score'; instructions: string }>
  request_digest: string
  answers: Record<string, unknown> | null
  result: JevResult
  price_basis: string
  method: string
  warnings: string[]
}
export type JevUsageSummary = {
  listed_runs: number
  evaluated_runs: number
  average_latency_ms: number | null
  average_input_tokens: number | null
  average_estimated_cost_usd: number | null
  total_estimated_cost_usd: number | null
  price_basis: string
}
export type JevHistory = {
  engine_version: string
  question_set_version: string
  model: string
  as_of: string
  input_revision: string
  runs: JevRunSummary[]
  usage_summary: JevUsageSummary
  method: string
}
export type JevOutcome = {
  symbol: string
  gate_status: JevGateStatus
  target_weight_pct: number
  decision_session: string
  latest_session: string | null
  sessions_elapsed: number
  forward_return_pct: number | null
  available: boolean
  reason: string | null
}
export type JevOutcomes = {
  engine_version: string
  run_id: string
  as_of: string
  latest_completed_session: string
  input_revision: string
  items: JevOutcome[]
  method: string
}
export type JevPaperPreview = {
  run_id: string
  engine_version: string
  paper_preview: PaperPreview
  method: string
}
export type JevPaperProposal = {
  run_id: string
  engine_version: string
  paper_proposal: PaperProposal
  method: string
}

export type JevDraft = { sourceRunId: string; passThreshold: string; maxRiskProbability: string }
export const jevDraftKey = (accountId: string) => `alphaview:jev-gate-draft:v1:${accountId}`
export const defaultJevDraft = (): JevDraft => ({
  sourceRunId: '',
  passThreshold: '0.70',
  maxRiskProbability: '0.50',
})
export function validJevDraft(value: unknown): value is JevDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as JevDraft
  const short = (item: unknown) => typeof item === 'string' && item.length <= 32
  return (
    typeof draft.sourceRunId === 'string' &&
    draft.sourceRunId.length <= 300 &&
    short(draft.passThreshold) &&
    short(draft.maxRiskProbability)
  )
}
export type JevPolicyError = 'pass_threshold' | 'max_risk_probability'
/** Thresholds are validated here exactly as the backend bounds them; nothing is clamped. */
export function parseJevPolicy(
  draft: JevDraft,
): { policy: JevPolicy; error: null } | { policy: null; error: JevPolicyError } {
  const pass = draft.passThreshold.trim() ? Number(draft.passThreshold) : NaN
  const risk = draft.maxRiskProbability.trim() ? Number(draft.maxRiskProbability) : NaN
  if (!Number.isFinite(pass) || pass < 0.5 || pass > 0.99)
    return { policy: null, error: 'pass_threshold' }
  if (!Number.isFinite(risk) || risk < 0.01 || risk > 0.5)
    return { policy: null, error: 'max_risk_probability' }
  return { policy: { pass_threshold: pass, max_risk_probability: risk }, error: null }
}
export const jevCost = (usd: number | null | undefined) =>
  usd == null ? '—' : `$${usd.toFixed(6)}`
export const jevProbability = (value: number | null | undefined) =>
  value == null ? '—' : value.toFixed(2)
export const jevSourceEligible = (
  source: { current: boolean; status: string },
  count: number,
  max: number,
) => source.current && source.status === 'proposed' && count >= 1 && count <= max
