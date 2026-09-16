import type { Overview } from './types'
import { finite } from './alpha-model'

export type ScenarioInput = { symbol: string; capital: number; price: number; decline: number }
export function positionScenario(data: Overview, input: ScenarioInput) {
  const holdings = data.positions.filter((position) => position.shares > 0)
  const expected = data.summary.expected_session
  const complete =
    !!expected &&
    holdings.every(
      (position) =>
        position.price_date === expected &&
        finite(position.price) &&
        position.price > 0 &&
        !['stale', 'unavailable'].includes(position.quote_status || ''),
    )
  const valid =
    finite(input.capital) &&
    input.capital >= 0 &&
    input.capital <= 1e12 &&
    finite(input.price) &&
    input.price > 0 &&
    input.price <= 1e9 &&
    finite(input.decline) &&
    input.decline >= 0 &&
    input.decline <= 100
  if (!complete || !valid) return null
  const total = holdings.reduce((sum, position) => sum + position.shares * position.price!, 0)
  const held = holdings.find((position) => position.symbol === input.symbol)
  const heldValue = held ? held.shares * held.price! : 0
  const shares = Math.floor(input.capital / input.price)
  const invested = shares * input.price
  const nextTotal = total + invested
  const positionValue = heldValue + invested
  const loss = (positionValue * input.decline) / 100
  return {
    total,
    heldValue,
    shares,
    invested,
    unused: input.capital - invested,
    nextTotal,
    beforeWeight: total > 0 ? (heldValue / total) * 100 : 0,
    afterWeight: nextTotal > 0 ? (positionValue / nextTotal) * 100 : 0,
    loss,
    impact: nextTotal > 0 ? (loss / nextTotal) * 100 : 0,
    afterShock: nextTotal - loss,
  }
}
