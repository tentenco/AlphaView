import type { PaperLimits, PaperPreview, PaperTarget } from './paper-model'

export type ScenarioPosition = {
  symbol: string
  shares: number
  base_price: number | null
  shock_pct: number
  stressed_price: number | null
  base_value: number | null
  stressed_value: number | null
  pnl: number | null
  weight_pct: number | null
  stressed_weight_pct: number | null
}
export type ScenarioCase = {
  name: string
  kind: 'current' | 'plan'
  status: 'available' | 'blocked' | 'unavailable'
  coverage: { required: number; priced: number; missing: string[] }
  base_equity: number | null
  posttrade_equity: number | null
  stressed_equity: number | null
  cash: number | null
  cash_weight_pct: number | null
  stressed_cash_weight_pct: number | null
  cost_total: number | null
  fees_total: number | null
  slippage_total: number | null
  shock_pnl: number | null
  shock_return_pct: number | null
  total_pnl: number | null
  total_return_pct: number | null
  largest_weight_pct: number | null
  stressed_largest_weight_pct: number | null
  worst_position: { symbol: string; pnl: number; shock_pct: number } | null
  positions: ScenarioPosition[]
  policy_breaches: { code: string; message: string; symbol?: string }[]
  preview: PaperPreview | null
}
export type SymbolShock = { symbol: string; shock_pct: number }
export type ScenarioPlan = { name: string; targets: PaperTarget[] }
export type ScenarioRequest = {
  expected_version: number
  global_shock_pct: number
  symbol_shocks: SymbolShock[]
  plans: ScenarioPlan[]
}
export type ScenarioReport = {
  engine_version: string
  paper_engine_version: string
  as_of: string
  input_revision: string
  account_version: number
  shock: { global_shock_pct: number; symbol_shocks: SymbolShock[] }
  limits: PaperLimits
  current: ScenarioCase
  plans: ScenarioCase[]
  method: string
  warnings: string[]
}
export type ScenarioDraft = {
  globalShock: string
  symbolShocks: string
  plans: { id: string; name: string; targets: string; allCash: boolean }[]
}
export const scenarioDraftKey = (id: string) => `alphaview:paper-scenarios:v1:${id}`
export const defaultScenarioDraft = (): ScenarioDraft => ({
  globalShock: '-10',
  symbolShocks: '',
  plans: [
    { id: 'a', name: 'A', targets: '', allCash: false },
    { id: 'b', name: 'B', targets: '', allCash: false },
  ],
})
export function isScenarioDraft(value: unknown): value is ScenarioDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as ScenarioDraft
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
  return (
    text(draft.globalShock, 100) &&
    text(draft.symbolShocks, 6000) &&
    Array.isArray(draft.plans) &&
    draft.plans.length <= 5 &&
    draft.plans.every(
      (p) =>
        p &&
        text(p.id, 100) &&
        text(p.name, 60) &&
        text(p.targets, 6000) &&
        typeof p.allCash === 'boolean',
    ) &&
    new Set(draft.plans.map((p) => p.id)).size === draft.plans.length
  )
}
export type ScenarioError = {
  code:
    | 'shock'
    | 'override_format'
    | 'override_duplicate'
    | 'override_unused'
    | 'plan_count'
    | 'name'
    | 'name_duplicate'
    | 'targets_empty'
    | 'targets_format'
    | 'targets_duplicate'
    | 'targets_sum'
  plan?: number
  symbol?: string
}
const symbolPattern = /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/
const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
const valueOf = (text: string) => (numericPattern.test(text.trim()) ? Number(text) : NaN)
const linesOf = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** Parse explicit user assumptions only; never fill missing prices or rebalance weights. */
export function parseScenarioDraft(
  draft: ScenarioDraft,
  accountVersion: number,
  heldSymbols: string[],
): { request: ScenarioRequest; error: null } | { request: null; error: ScenarioError } {
  const fail = (code: ScenarioError['code'], extra: Omit<ScenarioError, 'code'> = {}) => ({
    request: null,
    error: { code, ...extra },
  })
  const global = valueOf(draft.globalShock)
  if (!Number.isFinite(global) || global < -99 || global > 200) return fail('shock')
  if (draft.plans.length > 5) return fail('plan_count')
  const names = new Set<string>()
  const plans: ScenarioPlan[] = []
  for (let index = 0; index < draft.plans.length; index++) {
    const plan = draft.plans[index]
    const name = plan.name.trim()
    const extra = { plan: index + 1 }
    if (!name || name.length > 60) return fail('name', extra)
    if (names.has(name.toLocaleLowerCase())) return fail('name_duplicate', extra)
    names.add(name.toLocaleLowerCase())
    const targets: PaperTarget[] = []
    if (!plan.allCash) {
      const lines = linesOf(plan.targets)
      if (!lines.length) return fail('targets_empty', extra)
      if (lines.length > 50) return fail('targets_format', extra)
      const symbols = new Set<string>()
      for (const line of lines) {
        const parts = line.split(/[\s,，]+/)
        const symbol = parts[0].toUpperCase()
        const weight = valueOf(parts[1] || '')
        if (
          parts.length !== 2 ||
          !symbolPattern.test(symbol) ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100
        )
          return fail('targets_format', extra)
        if (symbols.has(symbol)) return fail('targets_duplicate', extra)
        symbols.add(symbol)
        targets.push({ symbol, weight_pct: weight })
      }
      if (targets.reduce((sum, row) => sum + row.weight_pct, 0) > 100)
        return fail('targets_sum', extra)
    }
    plans.push({ name, targets })
  }
  const relevant = new Set([
    ...heldSymbols,
    ...plans.flatMap((plan) =>
      plan.targets.filter((row) => row.weight_pct > 0).map((row) => row.symbol),
    ),
  ])
  const lines = linesOf(draft.symbolShocks)
  if (lines.length > 100) return fail('override_format')
  const shocks: SymbolShock[] = []
  const symbols = new Set<string>()
  for (const line of lines) {
    const parts = line.split(/[\s,，]+/)
    const symbol = parts[0].toUpperCase()
    const shock = valueOf(parts[1] || '')
    if (
      parts.length !== 2 ||
      !symbolPattern.test(symbol) ||
      !Number.isFinite(shock) ||
      shock < -99 ||
      shock > 200
    )
      return fail('override_format')
    if (symbols.has(symbol)) return fail('override_duplicate', { symbol })
    if (!relevant.has(symbol)) return fail('override_unused', { symbol })
    symbols.add(symbol)
    shocks.push({ symbol, shock_pct: shock })
  }
  return {
    request: {
      expected_version: accountVersion,
      global_shock_pct: global,
      symbol_shocks: shocks,
      plans,
    },
    error: null,
  }
}
