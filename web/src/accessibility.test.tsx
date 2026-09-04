import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Strategies, StockModal } from './Research'
import { Screener } from './Screener'
import { DataQuality } from './DataQuality'
import { PositionEditor } from './Portfolio'
import { overview, position, backtest, response } from './test/fixtures'

vi.mock('./Charts', () => ({
  PriceChart: () => null,
  EquityChart: () => null,
  Sparkline: () => null,
}))
beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
})
async function accessible(container: HTMLElement) {
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    // jsdom has no real layout/canvas. Contrast, chart visuals, native focus trapping,
    // and responsive overflow are verified separately in the real browser.
    rules: { 'color-contrast': { enabled: false } },
  })
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.html),
    })),
  ).toEqual([])
}

describe('automated accessible names and structure', () => {
  it('checks backtest controls and computed diagnostic results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(backtest()))),
    )
    const view = render(<Strategies data={overview()} />)
    await screen.findByText(/Fresh result/)
    await accessible(view.container)
  })

  it('checks stock dialog with editable research notes and expanded signal reason', async () => {
    const stock = position('NVDA', [
      {
        strategy: 'trend',
        status: 'insufficient',
        matched: false,
        reason: 'Requires more price history.',
      },
    ])
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(
              url.startsWith('/api/notes/')
                ? { symbol: 'NVDA', note: '', tags: [], version: 0, updated_at: null }
                : { position: stock, history: [], strategies: overview().strategies },
            ),
          ),
        ),
    )
    const view = render(<StockModal symbol="NVDA" onClose={vi.fn()} />)
    await screen.findByRole('textbox', { name: '研究內容' })
    await userEvent.click(screen.getByLabelText('資料不足，查看策略原因'))
    await accessible(view.container)
  })

  it('checks screener advanced filters, preset controls, table and signal changes', async () => {
    const data = overview()
    const scan = {
      scope: 'market' as const,
      id: 1,
      as_of: '2026-09-04',
      created_at: '2026-09-05',
      universe: ['DELL'],
      result: [
        {
          symbol: 'DELL',
          name: 'Dell',
          date: '2026-09-04',
          bars: 250,
          indicators: { close: 100, rsi: 55, volume_ratio: 2, rps: 90 },
          signals: [
            {
              strategy: 'trend',
              status: 'match' as const,
              matched: true,
              reason: 'Trend rules satisfied',
            },
          ],
        },
      ],
    }
    data.market_scan = scan
    data.market_scan_dates = [{ as_of: scan.as_of }]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.startsWith('/api/scans')
              ? scan
              : {
                  scope: 'market',
                  status: 'ready',
                  current_date: scan.as_of,
                  previous_date: '2026-09-03',
                  counts: {
                    entered: 1,
                    exited: 0,
                    continued: 0,
                    unavailable: 0,
                    universe_added: 0,
                    universe_removed: 0,
                  },
                  events: [
                    {
                      kind: 'entered',
                      symbol: 'DELL',
                      name: 'Dell',
                      strategy: 'trend',
                      previous_status: 'watch',
                      current_status: 'match',
                      reason: 'Now matches',
                      previous_reason: null,
                      current_reason: null,
                    },
                  ],
                },
          ),
        ),
      ),
    )
    const view = render(
      <Screener
        data={data}
        busy={false}
        onRun={vi.fn()}
        onOpen={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    await screen.findByText('Now matches')
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    await accessible(view.container)
  })

  it('checks quality batch controls and expanded gap diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          response({
            as_of: '2026-09-04',
            expected_session: '2026-09-04',
            checked_at: '2026-09-05',
            counts: { total: 1, ok: 0, stale: 1, error: 0, missing: 0 },
            items: [
              {
                symbol: 'DELL',
                name: 'Dell',
                status: 'stale',
                reason: 'Missing session',
                last_date: '2026-09-03',
                bars: 249,
                gap_dates: ['2026-09-04'],
                invalid_dates: [],
                source: 'Yahoo Finance',
              },
            ],
          }),
        ),
      ),
    )
    const view = render(
      <DataQuality busy={false} onOpen={vi.fn()} onRetry={vi.fn().mockResolvedValue(undefined)} />,
    )
    await userEvent.click(await screen.findByText(/查看異常日期/))
    await accessible(view.container)
  })

  it('checks the position editor form and dialog label', async () => {
    const view = render(<PositionEditor position={null} onClose={vi.fn()} onSaved={vi.fn()} />)
    await accessible(view.container)
  })
})
