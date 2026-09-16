import { expect, it } from 'vitest'
import { dailyAlphaChanges } from './AlphaDailyChanges'
import type { ReplayResult } from './AlphaReplay'
it('separates signal changes from missing coverage in adjacent sessions', () => {
  const result = {
    timeline: [
      { date: '2026-09-03', available: true },
      { date: '2026-09-04', available: true },
    ],
    occurrences: [
      { symbol: 'NEW', cells: [false, true] },
      { symbol: 'KEEP', cells: [true, true] },
      { symbol: 'EXIT', cells: [true, false] },
      { symbol: 'GAP', cells: [true, null] },
      { symbol: 'COVER', cells: [null, true] },
      { symbol: 'OLD', cells: [false, false] },
    ],
  } as ReplayResult
  expect(dailyAlphaChanges(result)).toEqual({
    entered: ['NEW'],
    continuing: ['KEEP'],
    exited: ['EXIT'],
    coverage: ['GAP', 'COVER'],
    previous: '2026-09-03',
    latest: '2026-09-04',
  })
  result.timeline[0].available = false
  expect(dailyAlphaChanges(result)).toBeNull()
})
