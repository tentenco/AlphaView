import { describe, expect, it } from 'vitest'
import {
  configKey,
  defaultDeskDraft,
  deskPercent,
  parameterGrid,
  parseDeskDraft,
  parseSymbols,
  validDeskDraft,
  type DeskDraft,
} from './research-desk-model'
import { catalog } from './test/research-desk-catalog'

const ready = (changes: Partial<DeskDraft> = {}): DeskDraft => ({
  ...defaultDeskDraft(),
  symbols: 'mu, googl',
  configs: [
    { strategy: 'buy_hold', params: {} },
    { strategy: 'sma_cross', params: { fast: '20', slow: '50' } },
  ],
  ...changes,
})

describe('research desk model', () => {
  it('parses a complete draft into the backend request with article defaults', () => {
    const parsed = parseDeskDraft(ready(), catalog)
    expect(parsed.error).toBeNull()
    expect(parsed.request).toEqual({
      symbols: ['MU', 'GOOGL'],
      configs: [
        { strategy: 'buy_hold', params: {} },
        { strategy: 'sma_cross', params: { fast: 20, slow: 50 } },
      ],
      risk: {
        initial_cash: 100000,
        fee_bps: 10,
        slippage_bps: 0,
        position_pct: 100,
        stop_loss_pct: null,
        take_profit_pct: null,
      },
      start_date: null,
      end_date: null,
      oos_pct: 30,
      rank_by: 'excess_return',
      save: true,
    })
  })

  it('rejects out-of-bound or inconsistent values without clamping', () => {
    const cases: [Partial<DeskDraft>, string][] = [
      [{ symbols: '' }, 'symbols'],
      [{ symbols: 'MU MU' }, 'duplicate_symbols'],
      [{ symbols: 'A B C D E F G H I J K' }, 'symbols'],
      [{ configs: [] }, 'configs'],
      [{ configs: [{ strategy: 'sma_cross', params: { fast: '50', slow: '20' } }] }, 'relation'],
      [{ configs: [{ strategy: 'sma_cross', params: { fast: '2.5', slow: '20' } }] }, 'param'],
      [
        {
          configs: [
            { strategy: 'rsi_reversion', params: { period: '14', entry: '60', exit: '70' } },
          ],
        },
        'param',
      ],
      [
        {
          configs: [
            { strategy: 'buy_hold', params: {} },
            { strategy: 'buy_hold', params: {} },
          ],
        },
        'duplicate_configs',
      ],
      [{ oosPct: '5' }, 'oos'],
      [{ startDate: '2025-06-01', endDate: '2025-01-01' }, 'dates'],
      [{ risk: { ...defaultDeskDraft().risk, fee_bps: '101' } }, 'risk'],
      [{ risk: { ...defaultDeskDraft().risk, stop_loss_pct: '0.2' } }, 'risk'],
      [{ risk: { ...defaultDeskDraft().risk, position_pct: '' } }, 'risk'],
    ]
    for (const [changes, code] of cases)
      expect(parseDeskDraft(ready(changes), catalog).error?.code).toBe(code)
    expect(parseDeskDraft(ready({ oosPct: '0' }), catalog).request?.oos_pct).toBe(0)
    const stops = parseDeskDraft(
      ready({ risk: { ...defaultDeskDraft().risk, stop_loss_pct: '8', take_profit_pct: '' } }),
      catalog,
    )
    expect(stops.request?.risk.stop_loss_pct).toBe(8)
    expect(stops.request?.risk.take_profit_pct).toBeNull()
  })

  it('builds only valid parameter-grid combinations', () => {
    const grid = parameterGrid('sma_cross', { fast: [10, 20, 50], slow: [50, 100, 200] }, catalog)
    expect(grid.map((config) => `${config.params.fast}/${config.params.slow}`)).toEqual([
      '10/50',
      '10/100',
      '10/200',
      '20/50',
      '20/100',
      '20/200',
      '50/100',
      '50/200',
    ])
    expect(new Set(grid.map(configKey)).size).toBe(grid.length)
  })

  it('validates session drafts and formats values without inventing numbers', () => {
    expect(validDeskDraft(ready())).toBe(true)
    expect(validDeskDraft({ ...ready(), rankBy: 'return' })).toBe(false)
    expect(validDeskDraft({ ...ready(), configs: Array(25).fill(ready().configs[0]) })).toBe(false)
    expect(validDeskDraft(null)).toBe(false)
    expect(parseSymbols(' mu，googl;tsla ')).toEqual(['MU', 'GOOGL', 'TSLA'])
    expect(deskPercent(null)).toBe('—')
    expect(deskPercent(12.345)).toBe('+12.35%')
    expect(deskPercent(-3)).toBe('-3.00%')
  })
})
