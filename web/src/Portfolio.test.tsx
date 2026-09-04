import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PortfolioTable } from './Portfolio'
import { position } from './test/fixtures'

vi.mock('./Charts', () => ({ Sparkline: () => null }))

describe('portfolio data availability', () => {
  it('displays stale data instead of a normal watch signal', () => {
    render(<PortfolioTable positions={[position('NVDA', [{ strategy: 'turtle', status: 'stale', matched: false, reason: 'Missing latest bar' }])]} onOpen={vi.fn()}/>)
    expect(screen.getByText('資料過期')).toBeTruthy()
    expect(screen.queryByText('持續觀察')).toBeNull()
  })
  it('keeps insufficient data visible alongside valid matches', () => {
    render(<PortfolioTable positions={[position('NVDA', [
      { strategy: 'turtle', status: 'match', matched: true, reason: 'Breakout' },
      { strategy: 'trend', status: 'insufficient', matched: false, reason: 'Only 59 bars' },
    ])]} onOpen={vi.fn()}/>)
    expect(screen.getByText('1 項符合')).toBeTruthy()
    expect(screen.getByText('資料不足')).toBeTruthy()
  })
  it('treats empty research signals as not scanned without crashing', () => {
    render(<PortfolioTable positions={[position()]} onOpen={vi.fn()}/>)
    expect(screen.getByText('尚未掃描')).toBeTruthy()
  })
})
