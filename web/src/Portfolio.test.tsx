import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PortfolioTable } from './Portfolio'
import { position } from './test/fixtures'

vi.mock('./Charts', () => ({ Sparkline: () => null }))

describe('portfolio data availability', () => {
  it('displays stale data instead of a normal watch signal', () => {
    render(
      <PortfolioTable
        positions={[
          position('NVDA', [
            { strategy: 'turtle', status: 'stale', matched: false, reason: 'Missing latest bar' },
          ]),
        ]}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('資料過期')).toBeTruthy()
    expect(screen.queryByText('持續觀察')).toBeNull()
  })
  it('keeps insufficient data visible alongside valid matches', () => {
    render(
      <PortfolioTable
        positions={[
          position('NVDA', [
            { strategy: 'turtle', status: 'match', matched: true, reason: 'Breakout' },
            { strategy: 'trend', status: 'insufficient', matched: false, reason: 'Only 59 bars' },
          ]),
        ]}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('1 項符合')).toBeTruthy()
    expect(screen.getByText('資料不足')).toBeTruthy()
  })
  it('treats empty research signals as not scanned without crashing', () => {
    render(<PortfolioTable positions={[position()]} onOpen={vi.fn()} />)
    expect(screen.getByText('尚未掃描')).toBeTruthy()
  })
})

describe('quote availability', () => {
  it('exposes corrupt data and missing quotes while retaining fractional shares', () => {
    const stock = position('DELL', [
      { strategy: 'trend', status: 'data_error', matched: false, reason: 'Invalid daily bar' },
    ])
    stock.shares = 0.1234
    stock.price = null
    stock.market_value = null
    stock.weight = null
    stock.quote_status = 'unavailable'
    stock.quote_reason = 'Invalid latest close'
    render(<PortfolioTable positions={[stock]} onOpen={vi.fn()} />)
    expect(screen.getByText('資料異常')).toBeTruthy()
    expect(screen.queryByText('持續觀察')).toBeNull()
    expect(screen.getByText('報價不可用：Invalid latest close')).toBeTruthy()
    expect(screen.getByText('0.1234')).toBeTruthy()
    expect(screen.queryByText('0.0%')).toBeNull()
  })
  it('hides relative allocation weights when any holding lacks a valuation', () => {
    const known = position('NVDA')
    const missing = position('DELL')
    missing.market_value = null
    missing.weight = null
    const view = render(<PortfolioTable positions={[known, missing]} onOpen={vi.fn()} />)
    expect(view.container.querySelectorAll('.weight-track')).toHaveLength(0)
    expect(screen.queryByText('100.0%')).toBeNull()
  })
})

describe('quote session freshness', () => {
  it('retains stale price with its expected session but suppresses daily changes', () => {
    const stock = position('NVDA')
    Object.assign(stock, {
      quote_status: 'stale',
      quote_reason: '最後報價早於應有交易日',
      expected_session: '2026-09-04',
      price_date: '2026-09-03',
      price: 150,
      change: 9.87,
      change_pct: 6.54,
    })
    render(<PortfolioTable positions={[stock]} onOpen={vi.fn()} />)
    expect(screen.getByText('$150.00')).toBeTruthy()
    expect(
      screen.getByText(/報價過期：最後報價早於應有交易日（應有交易日 2026-09-04）/),
    ).toBeTruthy()
    expect(screen.queryByText(/6.54|9.87|漲跌資料不完整/)).toBeNull()
  })
})
