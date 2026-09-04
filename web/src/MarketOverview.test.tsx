import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarketOverview } from './MarketOverview'
import { overview } from './test/fixtures'

describe('market overview navigation', () => {
  it('shows an empty snapshot state without fabricating breadth', () => {
    render(
      <MarketOverview
        data={overview()}
        onOpen={vi.fn()}
        onStrategy={vi.fn()}
        onScreener={vi.fn()}
      />,
    )
    expect(screen.getByText(/尚無市場選股快照/)).toBeTruthy()
    expect(screen.queryByText('0.0%')).toBeNull()
  })
  it('preserves old pool context and drills into strategy and dated stock details', async () => {
    const data = overview()
    data.market_scan = {
      id: 12,
      scope: 'market',
      as_of: '2026-09-04',
      created_at: '2026-09-05',
      universe: ['DELL'],
      matches_current_universe: false,
      scan_member_count: 1,
      current_member_count: 500,
      result: [
        {
          symbol: 'DELL',
          name: 'Dell',
          date: '2026-09-04',
          bars: 250,
          indicators: { close: 100, ma50: 90, ma200: 110, rsi: 60, return120: 0.2 },
          signals: [{ strategy: 'trend', status: 'match', matched: true, reason: 'test' }],
        },
      ],
    }
    const onOpen = vi.fn()
    const onStrategy = vi.fn()
    render(
      <MarketOverview data={data} onOpen={onOpen} onStrategy={onStrategy} onScreener={vi.fn()} />,
    )
    expect(screen.getByText(/目前股票池 500 檔/)).toBeTruthy()
    expect(screen.getByText('+20.00%')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /均線趨勢/ }))
    expect(onStrategy).toHaveBeenCalledWith('trend')
    await userEvent.click(screen.getByRole('button', { name: 'DELL' }))
    expect(onOpen).toHaveBeenCalledWith('DELL', 'market', '2026-09-04')
  })
})
