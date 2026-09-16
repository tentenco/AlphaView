import { beforeEach, describe, expect, it } from 'vitest'
import { overview, position } from './test/fixtures'
import { positionScenario } from './scenario-model'
import { DEFAULT_ALPHA_SETTINGS, type AlphaCandidate } from './alpha-model'
import {
  createSnapshot,
  previousComparable,
  snapshotChanges,
  saveJournalSnapshot,
  readJournal,
} from './alpha-journal'
import { researchBrief } from './alpha-brief'

const candidates = (rows: [string, number, boolean][]) =>
  rows.map(([symbol, score, alpha]) => ({
    symbol,
    score,
    alpha,
    matched: alpha ? 2 : 1,
  })) as AlphaCandidate[]
describe('daily research workflow', () => {
  beforeEach(() => localStorage.clear())
  it('compares only earlier snapshots with the same normalized settings and universe', () => {
    const prior = createSnapshot('market', '2026-09-03', ['B', 'A'], [], [], DEFAULT_ALPHA_SETTINGS)
    const current = createSnapshot('market', '2026-09-04', ['A', 'B'], [], [], {
      ...DEFAULT_ALPHA_SETTINGS,
      weights: { turtle: 50, trend: 50, pullback: 50, rps: 50 },
    })
    expect(previousComparable([prior], current)).toEqual(prior)
    expect(previousComparable([prior], { ...current, universe: ['A', 'B', 'C'] })).toBeNull()
    expect(previousComparable([prior], { ...current, date: prior.date })).toBeNull()
    expect(previousComparable([prior], { ...current, configuration: 'different' })).toBeNull()
  })
  it('distinguishes entries and exits from coverage changes', () => {
    const prior = createSnapshot(
      'market',
      '2026-09-03',
      ['A', 'B', 'C', 'D'],
      candidates([
        ['A', 75, true],
        ['B', 50, true],
        ['C', 25, false],
      ]),
      [],
      DEFAULT_ALPHA_SETTINGS,
    )
    const current = createSnapshot(
      'market',
      '2026-09-04',
      ['A', 'B', 'C', 'D'],
      candidates([
        ['C', 75, true],
        ['D', 50, true],
        ['A', 25, false],
      ]),
      [],
      DEFAULT_ALPHA_SETTINGS,
    )
    const changes = snapshotChanges(current, prior)
    expect(changes.entered.map((row) => row.symbol)).toEqual(['C'])
    expect(changes.exited.map((row) => row.symbol)).toEqual(['A'])
    expect(changes.newCoverage.map((row) => row.symbol)).toEqual(['D'])
    expect(changes.unavailable.map((row) => row.symbol)).toEqual(['B'])
    expect(changes.movement.get('C')).toEqual({ score: 50, rank: 2 })
  })
  it('updates same-day saves and bounds browser history', () => {
    const snapshot = createSnapshot(
      'market',
      '2026-09-04',
      ['A'],
      candidates([['A', 50, true]]),
      [],
      DEFAULT_ALPHA_SETTINGS,
    )
    const first = saveJournalSnapshot([], snapshot)
    const next = saveJournalSnapshot(first, { ...snapshot, rows: [] })
    expect(next).toHaveLength(1)
    expect(readJournal()[0].rows).toEqual([])
    expect(
      saveJournalSnapshot(
        Array.from({ length: 20 }, (_, i) => ({ ...snapshot, id: String(i) })),
        snapshot,
      ),
    ).toHaveLength(20)
  })
  it('models extra capital and whole shares without treating unused cash as stocks', () => {
    const data = overview()
    data.summary.expected_session = '2026-09-04'
    data.positions = [
      { ...position('AAA'), shares: 10, price: 100 },
      { ...position('BBB'), shares: 10, price: 100 },
    ]
    const result = positionScenario(data, { symbol: 'AAA', capital: 550, price: 100, decline: 20 })!
    expect(result).toMatchObject({
      shares: 5,
      invested: 500,
      unused: 50,
      total: 2000,
      nextTotal: 2500,
      loss: 300,
      impact: 12,
      afterWeight: 60,
      beforeWeight: 50,
      afterShock: 2200,
    })
    data.positions[1].quote_status = 'stale'
    expect(
      positionScenario(data, { symbol: 'AAA', capital: 550, price: 100, decline: 20 }),
    ).toBeNull()
  })
  it('exports an escaped standalone brief with scoring settings', () => {
    const row = {
      ...candidates([['AAA', 50, true]])[0],
      name: '<img src=x onerror=alert(1)>',
      relation: 'new',
      contributions: [],
    } as AlphaCandidate
    const html = researchBrief({
      locale: 'en',
      date: '2026-09-04',
      scope: 'market',
      total: 1,
      usable: 1,
      settings: DEFAULT_ALPHA_SETTINGS,
      rows: [row],
      alerts: [],
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(html).toContain('Minimum Strategy Matches')
    expect(html).toContain('alphaview-alpha-v1')
  })
})
