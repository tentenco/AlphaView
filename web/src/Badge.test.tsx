import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Badge } from './ui'

const signal = { strategy: 'trend', status: 'insufficient' as const, matched: false, reason: 'Only 59 of the required 200 daily bars are available.' }
describe('strategy reasons', () => {
  it('reveals the reason when tapped or clicked and can collapse it again', async () => {
    render(<Badge signal={signal}/>)
    const trigger = screen.getByLabelText('資料不足，查看策略原因')
    const disclosure = trigger.closest('details')!
    expect(disclosure.open).toBe(false)
    await userEvent.click(trigger)
    expect(disclosure.open).toBe(true)
    expect(screen.getByText(signal.reason)).toBeTruthy()
    await userEvent.click(trigger)
    expect(disclosure.open).toBe(false)
  })
  it('includes the native disclosure trigger in keyboard tab order', async () => {
    render(<Badge signal={signal}/>)
    const trigger = screen.getByLabelText('資料不足，查看策略原因')
    await userEvent.tab()
    expect(document.activeElement).toBe(trigger)
    // jsdom does not implement the browser's native Enter/Space activation for summary.
    // The actual browser check covers activation; this verifies keyboard reachability.
    expect(trigger.tagName).toBe('SUMMARY')
  })
})
