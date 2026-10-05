import type { PaperPreview, PaperProposal, PaperTarget } from './paper-model'

export const AGENT_STRATEGIES = ['turtle', 'trend', 'pullback', 'rps'] as const
export type AgentStrategy = (typeof AGENT_STRATEGIES)[number]
export const ALLOCATION_METHODS = ['equal', 'inverse_volatility', 'score_tilt'] as const
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number]
export type AgentConstraints = {
  min_score: number
  min_matches: number
  max_positions: number
  max_position_weight_pct: number
  cash_buffer_pct: number
  /** Added with alphaview-allocator-v1; runs saved earlier have neither key (equal slots). */
  allocation_method?: AllocationMethod
  volatility_lookback_sessions?: number
}
export type AgentWorkflowInput = {
  scope: 'market' | 'portfolio'
  candidate_symbols: string[]
  strategy_weights: Record<AgentStrategy, number>
  constraints: AgentConstraints
  account_context?: { account_id: string; expected_policy_version: number }
}
export type AgentWorkflowDraft = {
  scope: AgentWorkflowInput['scope']
  symbols: string
  weights: Record<AgentStrategy, string>
  constraints: { [Key in keyof AgentConstraints]: string }
}
export const defaultAgentDraft = (): AgentWorkflowDraft => ({
  scope: 'market',
  symbols: '',
  weights: { turtle: '25', trend: '25', pullback: '25', rps: '25' },
  constraints: {
    min_score: '50',
    min_matches: '1',
    max_positions: '5',
    max_position_weight_pct: '25',
    cash_buffer_pct: '20',
    allocation_method: 'equal',
    volatility_lookback_sessions: '60',
  },
})
/** Constraint keys every stored draft must carry; the allocator keys were added later and default when absent. */
const REQUIRED_DRAFT_CONSTRAINTS = [
  'min_score',
  'min_matches',
  'max_positions',
  'max_position_weight_pct',
  'cash_buffer_pct',
] as const
export const agentDraftKey = (accountId: string) => `portfolio-agent-draft-${accountId}-v1`

export function validAgentDraft(value: unknown): value is AgentWorkflowDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as AgentWorkflowDraft
  const shortString = (item: unknown) => typeof item === 'string' && item.length <= 32
  return (
    ['market', 'portfolio'].includes(draft.scope) &&
    typeof draft.symbols === 'string' &&
    draft.symbols.length <= 6000 &&
    !!draft.weights &&
    AGENT_STRATEGIES.every((strategy) => shortString(draft.weights[strategy])) &&
    !!draft.constraints &&
    REQUIRED_DRAFT_CONSTRAINTS.every((key) => shortString(draft.constraints[key])) &&
    (draft.constraints.allocation_method === undefined ||
      shortString(draft.constraints.allocation_method)) &&
    (draft.constraints.volatility_lookback_sessions === undefined ||
      shortString(draft.constraints.volatility_lookback_sessions))
  )
}

export type AgentDraftError =
  'symbols' | 'duplicate' | 'weights' | 'weight_sum' | 'constraints' | 'matches'
export function parseAgentDraft(
  draft: AgentWorkflowDraft,
): { input: AgentWorkflowInput; error: null } | { input: null; error: AgentDraftError } {
  const symbols = draft.symbols
    .trim()
    .toUpperCase()
    .split(/[\s,，;；]+/)
    .filter(Boolean)
  if (
    symbols.length < 1 ||
    symbols.length > 100 ||
    symbols.some((s) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))
  )
    return { input: null, error: 'symbols' }
  if (new Set(symbols).size !== symbols.length) return { input: null, error: 'duplicate' }
  const number = (text: string) => (text.trim() ? Number(text) : NaN)
  const weights = Object.fromEntries(
    AGENT_STRATEGIES.map((id) => [id, number(draft.weights[id])]),
  ) as Record<AgentStrategy, number>
  if (Object.values(weights).some((n) => !Number.isFinite(n) || n < 0 || n > 100))
    return { input: null, error: 'weights' }
  if (Math.abs(Object.values(weights).reduce((sum, n) => sum + n, 0) - 100) > 1e-8)
    return { input: null, error: 'weight_sum' }
  const method = (draft.constraints.allocation_method ?? 'equal') as AllocationMethod
  const lookbackText = draft.constraints.volatility_lookback_sessions ?? '60'
  const constraints = {
    ...(Object.fromEntries(
      REQUIRED_DRAFT_CONSTRAINTS.map((key) => [key, number(draft.constraints[key])]),
    ) as Omit<AgentConstraints, 'allocation_method' | 'volatility_lookback_sessions'>),
    allocation_method: method,
    volatility_lookback_sessions: number(lookbackText),
  }
  if (
    !ALLOCATION_METHODS.includes(method) ||
    !Number.isInteger(constraints.volatility_lookback_sessions) ||
    constraints.volatility_lookback_sessions < 20 ||
    constraints.volatility_lookback_sessions > 120 ||
    REQUIRED_DRAFT_CONSTRAINTS.some((key) => !Number.isFinite(constraints[key])) ||
    constraints.min_score < 0 ||
    constraints.min_score > 100 ||
    !Number.isInteger(constraints.min_matches) ||
    constraints.min_matches < 1 ||
    constraints.min_matches > 4 ||
    !Number.isInteger(constraints.max_positions) ||
    constraints.max_positions < 1 ||
    constraints.max_positions > 30 ||
    constraints.max_position_weight_pct <= 0 ||
    constraints.max_position_weight_pct > 100 ||
    constraints.cash_buffer_pct < 0 ||
    constraints.cash_buffer_pct >= 100
  )
    return { input: null, error: 'constraints' }
  if (constraints.min_matches > Object.values(weights).filter((n) => n > 0).length)
    return { input: null, error: 'matches' }
  return {
    input: {
      scope: draft.scope,
      candidate_symbols: symbols,
      strategy_weights: weights,
      constraints,
    },
    error: null,
  }
}

export type AgentReason = {
  code: string
  message: string
  strategy?: string
  [key: string]: unknown
}
export type AgentCoverage = {
  requested: number
  complete: number
  eligible: number
  selected: number
  rejected: number
}
export type AgentRiskCheck = {
  code: string
  passed: boolean
  observed: number | null
  limit: number | null
}
export type AgentCandidate = {
  symbol: string
  status: 'selected' | 'unselected' | 'rejected'
  score: number | null
  coverage_pct: number
  matched_count: number
  reasons: AgentReason[]
  contributions: {
    strategy: AgentStrategy
    weight: number
    enabled: boolean
    available: boolean
    matched: boolean
    points: number | null
    status: string
    reason: string
  }[]
  evidence: { quote_date: string | null; reference_close: number | null }
}
export type AgentRunSummary = {
  id: string
  created_at: string
  engine_version: string
  as_of: string
  status: 'proposed' | 'blocked'
  scope: AgentWorkflowInput['scope']
  coverage: AgentCoverage
  target_weights: PaperTarget[]
  cash_weight_pct: number | null
  current: boolean
  stale_reasons: string[]
  account_context?: {
    account_id: string
    symbol_policy: { engine_version: string; version: number; mode: string; symbols: string[] }
  }
}
export type AgentRun = Omit<AgentRunSummary, 'scope' | 'current' | 'stale_reasons'> & {
  workflow_kind: 'deterministic_rules'
  mode: 'paper_preview_only'
  input_revision: string
  saved: boolean
  current?: boolean
  stale_reasons?: string[]
  request: AgentWorkflowInput
  scan: { id: number; as_of: string; engine_version: string; input_status: string } | null
  candidates: AgentCandidate[]
  allocation: { slot_weight_pct: number; unused_slots: number; method?: AllocationMethod }
  allocator?: AgentAllocator
  risk_checks: AgentRiskCheck[]
  blocking_reasons: AgentReason[]
  steps: {
    role: 'research_analyst' | 'allocation_planner' | 'risk_reviewer' | 'proposal'
    engine: 'deterministic_rules'
    engine_version: string
    status: 'completed' | 'blocked'
    summary: string
    evidence: Record<string, unknown>
  }[]
  method: string
  warnings: string[]
  proposal_fingerprint: string
}
export type AgentHistory = {
  runs: AgentRunSummary[]
  as_of: string
  input_revision: string
  engine_version: string
  method: string
}
export type AgentPaperPreview = { agent_run_id: string; paper_preview: PaperPreview }
export type AgentPaperProposal = { agent_run_id: string; paper_proposal: PaperProposal }
export type AgentAllocatorRow = {
  symbol: string
  score: number | null
  sigma_annualized_pct: number | null
  raw_weight_pct: number | null
  capped_weight_pct: number | null
  reason: { code: string; message: string; [key: string]: unknown } | null
}
export type AgentAllocator = {
  engine_version: string
  method: AllocationMethod
  status: 'applied' | 'unavailable'
  lookback_sessions: number | null
  slot_weight_pct: number
  invested_budget_pct: number
  capped_to_cash_pct: number
  per_symbol: AgentAllocatorRow[]
  unavailable: { symbol: string; code: string; message: string; [key: string]: unknown }[]
}
export type AgentAllocationComparison = {
  engine_version: string
  agent_run_id: string
  as_of: string
  input_revision: string
  run_method: AllocationMethod
  lookback_sessions: number
  methods: Record<
    AllocationMethod,
    {
      status: 'applied' | 'unavailable'
      targets: { symbol: string; weight_pct: number }[]
      cash_weight_pct: number | null
      allocator: AgentAllocator
    }
  >
  method: string
  warnings: string[]
}
