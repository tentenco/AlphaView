import { ALLOCATION_METHODS, type AgentAllocationComparison } from './portfolio-agent-model'

function csvCell(value: string | number | null | undefined) {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return '""'
  const text = String(value)
  // Quoting alone does not prevent spreadsheet formula execution, including after whitespace.
  const safe =
    typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text)
      ? `'${text}`
      : text
  return `"${safe.replaceAll('"', '""')}"`
}

/** Export the displayed what-if response without recalculating or substituting saved-run data. */
export function allocationComparisonCsv(result: AgentAllocationComparison) {
  const headers = [
    'export_kind',
    'engine_version',
    'agent_run_id',
    'as_of',
    'input_revision',
    'run_method',
    'lookback_sessions',
    'allocation_method',
    'status',
    'allocator_engine_version',
    'allocator_status',
    'allocator_lookback_sessions',
    'slot_weight_pct',
    'invested_budget_pct',
    'capped_to_cash_pct',
    'row_type',
    'symbol',
    'weight_pct',
    'score',
    'sigma_annualized_pct',
    'raw_weight_pct',
    'capped_weight_pct',
    'reason_code',
    'reason_message',
    'reason_details',
    'unavailable_reasons',
    'method',
    'warnings',
  ]
  const rows: (string | number | null | undefined)[][] = [headers]
  const symbols = Array.from(
    new Set(
      ALLOCATION_METHODS.flatMap((method) =>
        result.methods[method].allocator.per_symbol.map((row) => row.symbol),
      ),
    ),
  )
  for (const method of ALLOCATION_METHODS) {
    const block = result.methods[method]
    const allocator = block.allocator
    const provenance = [
      'current_local_bars_what_if',
      result.engine_version,
      result.agent_run_id,
      result.as_of,
      result.input_revision,
      result.run_method,
      result.lookback_sessions,
      method,
      block.status,
      allocator.engine_version,
      allocator.status,
      allocator.lookback_sessions,
      allocator.slot_weight_pct,
      allocator.invested_budget_pct,
      allocator.capped_to_cash_pct,
    ]
    const context = [
      JSON.stringify(allocator.unavailable),
      result.method,
      JSON.stringify(result.warnings),
    ]
    for (const symbol of symbols) {
      const evidence = allocator.per_symbol.find((row) => row.symbol === symbol)
      const target = block.targets.find((row) => row.symbol === symbol)
      rows.push([
        ...provenance,
        'symbol',
        symbol,
        block.status === 'applied' ? target?.weight_pct : null,
        evidence?.score,
        evidence?.sigma_annualized_pct,
        evidence?.raw_weight_pct,
        evidence?.capped_weight_pct,
        evidence?.reason?.code,
        evidence?.reason?.message,
        evidence?.reason ? JSON.stringify(evidence.reason) : null,
        ...context,
      ])
    }
    // A separate cash row preserves unavailable methods even when there are no symbol rows.
    rows.push([
      ...provenance,
      'cash',
      null,
      block.cash_weight_pct,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      ...context,
    ])
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

export function allocationComparisonFilename(result: AgentAllocationComparison) {
  const safe = (value: unknown) =>
    String(value ?? '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  return `alphaview-allocation-comparison-${safe(result.as_of)}-${safe(result.agent_run_id)}-${safe(result.lookback_sessions)}d.csv`
}

export function downloadAllocationComparisonCsv(result: AgentAllocationComparison) {
  const blob = new Blob([allocationComparisonCsv(result)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = allocationComparisonFilename(result)
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}
