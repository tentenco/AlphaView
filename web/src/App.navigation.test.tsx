import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { overview, response } from './test/fixtures'

vi.mock('./AgentPortfolio', () => ({
  AgentPortfolio: () => (
    <section aria-label="Synthetic portfolio route">Portfolio route ready</section>
  ),
}))
vi.mock('./Charts', () => ({ PriceChart: () => <div>Chart ready</div>, Sparkline: () => null }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(overview())))
})
afterEach(() => {
  vi.unstubAllGlobals()
  history.replaceState(null, '', '#overview')
})

describe('portfolio route with local navigation parameters', () => {
  it('opens the portfolio page directly and keeps routing on hash history changes', async () => {
    history.replaceState(null, '', '#agent-portfolio?account=synthetic-account&tab=risk')
    render(<App />)
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(await screen.findByRole('region', { name: 'Synthetic portfolio route' })).toBeTruthy()
    await act(async () => {
      history.replaceState(null, '', '#overview')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.queryByRole('region', { name: 'Synthetic portfolio route' })).toBeNull()
    await act(async () => {
      history.replaceState(null, '', '#agent-portfolio?view=inbox&tab=plan')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await vi.dynamicImportSettled()
    })
    expect(await screen.findByRole('region', { name: 'Synthetic portfolio route' })).toBeTruthy()
  })
})
