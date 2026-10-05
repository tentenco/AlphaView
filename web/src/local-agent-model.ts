export type LocalAgentMode = 'analysis' | 'conservative'
export type LocalAgentStatus =
  'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'stale' | 'interrupted'
export type LocalAgentDraft = {
  sourceRunId: string
  model: string
  mode: LocalAgentMode
}
export type LocalAgentRequest = {
  source_run_id: string
  model: string
  mode: LocalAgentMode
  idempotency_key: string
}
export type LocalAgentModel = {
  name: string
  digest: string
  size: number
  modified_at: string | null
  details: Record<string, unknown>
  status: 'installed'
  capabilities?: string[]
  show_digest?: string
  server_version?: string | null
  cloud_disabled?: boolean
}
export type LocalAgentCatalog = {
  engine_version: string
  endpoint: string
  available: boolean
  server_version: string | null
  cloud_disabled: boolean | null
  models: LocalAgentModel[]
  rejected_models: { name: string; reason: string }[]
  reason: string | null
  max_selected: number
  inference_timeout_seconds: number
  modes: LocalAgentMode[]
  method: string
}
export type LocalAgentFact = {
  id: string
  kind: string
  value: number | string | Record<string, number>
  symbol: string | null
  as_of: string
  scan_id: number
}
export type LocalAgentIssue = { code: string; message: string }
export type LocalAgentResult = {
  raw_content: string
  output_digest: string
  output: Record<string, unknown> | null
  role_views: {
    role: 'research_analyst' | 'allocation_reviewer' | 'risk_reviewer'
    assessment: 'supported' | 'caution' | 'insufficient'
    findings: { code: string; evidence_ids: string[]; text: string; evidence: LocalAgentFact[] }[]
  }[]
  decisions: {
    symbol: string
    action: 'retain' | 'halve' | 'exclude'
    reason_code: string
    evidence_ids: string[]
    text: string
    evidence: LocalAgentFact[]
    original_weight_pct: number | null
    target_weight_pct: number | null
  }[]
  target_weights: PaperTarget[]
  cash_weight_pct: number | null
  proposal_ready: boolean
  validation: { valid: boolean; issues: LocalAgentIssue[] }
  metrics?: Record<string, number | null> | null
}
export type LocalAgentRunSummary = {
  id: string
  engine_version: string
  source_run_id: string
  status: LocalAgentStatus
  stored_status: LocalAgentStatus
  phase: 'source_check' | 'local_inference' | 'output_validation' | 'finished'
  cancel_requested: boolean
  created_at: string
  started_at: string | null
  finished_at: string | null
  as_of: string
  input_revision: string
  request: LocalAgentRequest
  model: LocalAgentModel
  error: LocalAgentIssue | null
  proposal_ready: boolean
  target_weights: PaperTarget[]
  cash_weight_pct: number | null
  single_model_pass: boolean
  current: boolean
  stale_reasons: string[]
}
export type LocalAgentRun = LocalAgentRunSummary & {
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
  }
  facts: LocalAgentFact[]
  result: LocalAgentResult | null
  prompt_version: string
  prompt_digest: string
  schema_digest: string
  options: Record<string, number>
  method: string
  warnings: string[]
}
export type LocalAgentHistory = {
  engine_version: string
  as_of: string
  input_revision: string
  runs: LocalAgentRunSummary[]
  method: string
}
export type LocalAgentIntegrity = {
  engine_version: 'alphaview-local-agent-integrity-v1'
  analysis_id: string
  source_run_id: string
  as_of: string
  input_revision: string
  status: 'verified' | 'failed' | 'unavailable'
  verified: boolean
  checks: {
    code: string
    status: 'passed' | 'failed' | 'unavailable'
    reason: LocalAgentIssue | null
    mismatched_fields?: string[]
  }[]
  citation_coverage: {
    claims: number
    claims_with_valid_references: number
    citations: number
    known_citations: number
    unknown_ids: string[]
    duplicate_citations: number
    coverage_pct: number | null
  } | null
  validation_issues: string[]
  source_currentness: { current: boolean; stale_reasons: string[] }
  proposal_eligible: boolean
  authorization_fingerprint: string | null
  method: string
}
export type LocalAgentPaperPreview = {
  analysis_id: string
  engine_version: string
  paper_preview: PaperPreview
  method: string
}
export type LocalAgentPaperProposal = {
  analysis_id: string
  engine_version: string
  paper_proposal: PaperProposal
  method: string
}
export const localAgentDraftKey = (accountId: string) =>
  `alphaview:local-agent-draft:v1:${accountId}`
export const defaultLocalAgentDraft = (): LocalAgentDraft => ({
  sourceRunId: '',
  model: '',
  mode: 'analysis',
})
export function validLocalAgentDraft(value: unknown): value is LocalAgentDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as LocalAgentDraft
  return (
    typeof draft.sourceRunId === 'string' &&
    draft.sourceRunId.length <= 300 &&
    typeof draft.model === 'string' &&
    draft.model.length <= 300 &&
    ['analysis', 'conservative'].includes(draft.mode)
  )
}
export const localAgentActive = (status: LocalAgentStatus) =>
  status === 'queued' || status === 'running'

export type LocalAgentAttempt = { input: string; idempotencyKey: string }
export const localAgentAttemptKey = (accountId: string) =>
  `alphaview:local-agent-attempt:v1:${accountId}`
/** Keep an ambiguous launch retry tied to the same request across a tab refresh. */
export function readLocalAgentAttempt(accountId: string): LocalAgentAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(localAgentAttemptKey(accountId)) || 'null')
    if (
      value &&
      typeof value.input === 'string' &&
      value.input.length <= 2000 &&
      typeof value.idempotencyKey === 'string' &&
      /^[A-Za-z0-9._:-]{8,100}$/.test(value.idempotencyKey)
    )
      return value as LocalAgentAttempt
  } catch {
    // The live component still keeps its retry key when storage is unavailable.
  }
  return null
}
export function storeLocalAgentAttempt(accountId: string, attempt: LocalAgentAttempt | null) {
  try {
    if (attempt) sessionStorage.setItem(localAgentAttemptKey(accountId), JSON.stringify(attempt))
    else sessionStorage.removeItem(localAgentAttemptKey(accountId))
  } catch {
    // Session storage is optional; the in-memory retry identity is authoritative.
  }
}
import type { PaperPreview, PaperProposal, PaperTarget } from './paper-model'
import type { AgentConstraints, AgentRun, AgentStrategy } from './portfolio-agent-model'
