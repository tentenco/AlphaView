import { describe, expect, it } from 'vitest'
import { allocationComparisonCsv, allocationComparisonFilename } from './allocation-comparison-csv'
import {
  ALLOCATION_METHODS,
  type AgentAllocationComparison,
  type AllocationMethod,
} from './portfolio-agent-model'

function comparison(): AgentAllocationComparison {
  const block = (method: AllocationMethod): AgentAllocationComparison['methods']['equal'] => ({
    status: 'applied',
    targets: [{ symbol: 'SYNTA', weight_pct: 21.33333333 }],
    cash_weight_pct: 78.66666667,
    allocator: {
      engine_version: 'alphaview-allocator-v1',
      method,
      status: 'applied',
      lookback_sessions: method === 'equal' ? null : 60,
      slot_weight_pct: 16,
      invested_budget_pct: 32,
      capped_to_cash_pct: 0,
      per_symbol: [
        {
          symbol: 'SYNTA',
          score: 75,
          sigma_annualized_pct: method === 'equal' ? null : 18.5,
          raw_weight_pct: 21.33333333,
          capped_weight_pct: 21.33333333,
          reason: null,
        },
      ],
      unavailable: [],
    },
  })
  return {
    engine_version: 'alphaview-allocator-v1',
    agent_run_id: 'synthetic-run',
    as_of: '2026-09-18',
    input_revision: 'synthetic:7',
    run_method: 'equal',
    lookback_sessions: 60,
    methods: {
      equal: block('equal'),
      inverse_volatility: block('inverse_volatility'),
      score_tilt: block('score_tilt'),
    },
    method: 'Synthetic what-if method.',
    warnings: ['合成研究限制'],
  }
}

/** Read the exported RFC 4180 records, including quoted commas and embedded newlines. */
function records(csv: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const content = csv.replace(/^\uFEFF/, '')
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === '"') {
      if (quoted && content[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\r')) {
      row.push(cell)
      cell = ''
      if (char === '\r') {
        expect(content[++i]).toBe('\n')
        rows.push(row)
        row = []
      }
    } else cell += char
  }
  expect(quoted).toBe(false)
  const [headers, ...data] = rows
  return data.map((values) => {
    expect(values).toHaveLength(headers.length)
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
  })
}

describe('allocation comparison CSV', () => {
  it('exports each displayed method, symbol and cash with exact precision and response provenance', () => {
    const result = comparison()
    const csv = allocationComparisonCsv(result)
    const rows = records(csv)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(rows).toHaveLength(6)
    for (const method of ALLOCATION_METHODS) {
      expect(
        rows.find((row) => row.allocation_method === method && row.row_type === 'symbol'),
      ).toMatchObject({
        export_kind: 'current_local_bars_what_if',
        engine_version: 'alphaview-allocator-v1',
        allocator_engine_version: 'alphaview-allocator-v1',
        agent_run_id: 'synthetic-run',
        as_of: '2026-09-18',
        input_revision: 'synthetic:7',
        lookback_sessions: '60',
        run_method: 'equal',
        status: 'applied',
        symbol: 'SYNTA',
        weight_pct: '21.33333333',
        score: '75',
        capped_to_cash_pct: '0',
        warnings: '["合成研究限制"]',
      })
      expect(
        rows.find((row) => row.allocation_method === method && row.row_type === 'cash'),
      ).toMatchObject({
        symbol: '',
        weight_pct: '78.66666667',
        sigma_annualized_pct: '',
      })
    }
    expect(rows[0]).toMatchObject({ sigma_annualized_pct: '', allocator_lookback_sessions: '' })
    expect(rows[2].sigma_annualized_pct).toBe('18.5')
  })

  it('keeps unavailable weights blank with risk reasons and coverage evidence intact', () => {
    const result = comparison()
    const block = result.methods.score_tilt
    const reason = {
      code: 'history_incomplete',
      message: '缺少日線',
      required_sessions: 61,
      missing_sessions: 2,
      first_missing: '2026-08-03',
    }
    block.status = 'unavailable'
    block.cash_weight_pct = null
    block.allocator.status = 'unavailable'
    block.allocator.per_symbol[0] = {
      symbol: 'SYNTA',
      score: 75,
      sigma_annualized_pct: null,
      raw_weight_pct: null,
      capped_weight_pct: null,
      reason,
    }
    block.allocator.unavailable = [{ symbol: 'SYNTA', ...reason }]
    const rows = records(allocationComparisonCsv(result))
    expect(rows[4]).toMatchObject({
      status: 'unavailable',
      weight_pct: '',
      sigma_annualized_pct: '',
      raw_weight_pct: '',
      capped_weight_pct: '',
      reason_code: 'history_incomplete',
      reason_message: '缺少日線',
    })
    expect(JSON.parse(rows[4].reason_details)).toEqual(reason)
    expect(JSON.parse(rows[4].unavailable_reasons)).toEqual([{ symbol: 'SYNTA', ...reason }])
    expect(rows[5].weight_pct).toBe('')
  })

  it('does not fill missing metadata, absent symbols or non-finite numbers with zero', () => {
    const result = comparison()
    Object.assign(result, { as_of: undefined, input_revision: undefined })
    result.methods.equal.targets = []
    result.methods.equal.allocator.per_symbol = []
    result.methods.inverse_volatility.targets[0].weight_pct = Number.NaN
    result.methods.inverse_volatility.cash_weight_pct = Number.POSITIVE_INFINITY
    result.methods.inverse_volatility.allocator.per_symbol[0].sigma_annualized_pct =
      Number.NEGATIVE_INFINITY
    const csv = allocationComparisonCsv(result)
    const rows = records(csv)
    expect(rows[0]).toMatchObject({
      as_of: '',
      input_revision: '',
      symbol: 'SYNTA',
      weight_pct: '',
      score: '',
      sigma_annualized_pct: '',
    })
    expect(rows[2]).toMatchObject({ weight_pct: '', sigma_annualized_pct: '' })
    expect(rows[3].weight_pct).toBe('')
    expect(csv).not.toMatch(/NaN|Infinity|undefined/)
  })

  it.each([
    '=SUM(1,2)',
    '+1+2',
    '-1+2',
    '@SUM(1,2)',
    ' \t=SUM(1,2)',
    '\r\n=SUM(1,2)',
    '\tordinary',
    '＝SUM(1,2)',
  ])('neutralizes unsafe spreadsheet text: %j', (unsafe) => {
    const result = comparison()
    result.agent_run_id = unsafe
    result.as_of = unsafe
    result.method = unsafe
    result.methods.equal.allocator.per_symbol[0].symbol = unsafe
    const rows = records(allocationComparisonCsv(result))
    expect(rows[0]).toMatchObject({
      agent_run_id: `'${unsafe}`,
      as_of: `'${unsafe}`,
      method: `'${unsafe}`,
      symbol: `'${unsafe}`,
    })
  })

  it('round-trips quotes, commas and newlines and retains all unavailable methods without symbols', () => {
    const result = comparison()
    result.method = 'A "quoted", synthetic\nmethod.'
    for (const method of ALLOCATION_METHODS) {
      result.methods[method].status = 'unavailable'
      result.methods[method].cash_weight_pct = null
      result.methods[method].targets = []
      result.methods[method].allocator.per_symbol = []
    }
    const rows = records(allocationComparisonCsv(result))
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.allocation_method)).toEqual(ALLOCATION_METHODS)
    expect(rows.every((row) => row.method === result.method && row.weight_pct === '')).toBe(true)
  })

  it('constructs a bounded filename without path or control characters', () => {
    const result = comparison()
    expect(allocationComparisonFilename(result)).toBe(
      'alphaview-allocation-comparison-2026-09-18-synthetic-run-60d.csv',
    )
    result.agent_run_id = '../\\"\r\n' + 'X'.repeat(200)
    result.as_of = '../../'
    const filename = allocationComparisonFilename(result)
    expect(filename).toMatch(/^alphaview-allocation-comparison-unknown-X{64}-60d\.csv$/)
  })
})
