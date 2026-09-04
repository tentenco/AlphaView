import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Screener, UNIVERSE_LIMIT_KEY } from './Screener'
import { EMPTY_NUMERIC, PRESET_KEY } from './screener-model'
import { deferred, overview, response } from './test/fixtures'
import type { Scan, Scope } from './types'
vi.mock('./SignalChanges', () => ({ SignalChanges: () => <div data-testid="signal-changes" /> }))
function scan(scope: Scope, asOf: string, symbol: string): Scan {
  return {
    id: scope === 'market' ? 1 : 2,
    scope,
    as_of: asOf,
    created_at: '2026-09-05T00:00:00Z',
    universe: [symbol],
    result: [
      {
        symbol,
        name: `${symbol} company`,
        date: asOf,
        bars: 250,
        indicators: { close: 100, rsi: 50, rps: 90, volume_ratio: 2 },
        signals: [{ strategy: 'trend', matched: true, status: 'match', reason: 'ok' }],
      },
    ],
  }
}
function data() {
  const d = overview()
  d.market_scan = scan('market', '2026-09-04', 'DELL')
  d.market_scan_dates = [{ as_of: '2026-09-04' }]
  d.scan = scan('portfolio', '2026-09-03', 'NVDA')
  d.scan_dates = [{ as_of: '2026-09-03' }]
  return d
}
const props = () => ({
  data: data(),
  busy: false,
  onRun: vi.fn(),
  onOpen: vi.fn(),
  onAdded: vi.fn().mockResolvedValue(undefined),
})
beforeEach(() => localStorage.clear())
describe('screener interaction lifecycle', () => {
  it('applies a preset from another scope without requesting the previous scope date or displaying late responses', async () => {
    localStorage.setItem(
      PRESET_KEY,
      JSON.stringify([
        {
          version: 1,
          name: 'My trend',
          settings: {
            scope: 'portfolio',
            strategy: 'trend',
            only: true,
            newOnly: true,
            query: '',
            numeric: { ...EMPTY_NUMERIC, rsiMin: '45' },
            sort: 'rps',
            direction: 'desc',
          },
        },
      ]),
    )
    const market = deferred<Response>()
    const portfolio = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockImplementation((url: string) =>
        url.includes('scope=market') ? market.promise : portfolio.promise,
      )
    vi.stubGlobal('fetch', fetcher)
    render(<Screener {...props()} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '已儲存的篩選設定' }),
      'My trend',
    )
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      '/api/scans?as_of=2026-09-04&scope=market',
      '/api/scans?as_of=2026-09-03&scope=portfolio',
    ])
    await act(async () => {
      portfolio.resolve(response(scan('portfolio', '2026-09-03', 'NVDA')))
    })
    expect(await screen.findByRole('button', { name: 'NVDA' })).toBeTruthy()
    await act(async () => {
      market.resolve(response(scan('market', '2026-09-04', 'DELL')))
    })
    expect(screen.queryByRole('button', { name: 'DELL' })).toBeNull()
    expect((screen.getByRole('combobox', { name: '選股範圍' }) as HTMLSelectElement).value).toBe(
      'portfolio',
    )
    expect((screen.getByRole('spinbutton', { name: 'RSI 下限' }) as HTMLInputElement).value).toBe(
      '45',
    )
  })
  it('shows API loading failures without keeping stale rows', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    render(<Screener {...props()} />)
    expect(await screen.findByText('正在載入選股紀錄…')).toBeTruthy()
    await act(async () => {
      pending.resolve(
        new Response(JSON.stringify({ detail: '資料來源暫時不可用' }), { status: 503 }),
      )
    })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '資料來源暫時不可用')
    expect(screen.queryByRole('button', { name: 'DELL' })).toBeNull()
    expect((screen.getByRole('button', { name: /匯出全部/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
  it('rejects a mismatched API result instead of showing another scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(scan('portfolio', '2026-09-04', 'NVDA'))),
    )
    render(<Screener {...props()} />)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '選股紀錄與要求的股票池或日期不一致，請重新載入。',
    )
    expect(screen.queryByRole('button', { name: 'NVDA' })).toBeNull()
  })
  it('saves valid filters and resets them while preserving the current scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(scan('market', '2026-09-04', 'DELL'))),
    )
    render(<Screener {...props()} />)
    await screen.findByRole('button', { name: 'DELL' })
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    await userEvent.type(screen.getByRole('spinbutton', { name: '最低量比（倍）' }), '1.5')
    await userEvent.type(screen.getByRole('textbox', { name: '篩選設定名稱' }), '放量')
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }))
    expect(JSON.parse(localStorage.getItem(PRESET_KEY)!)[0].settings.numeric.volumeMin).toBe('1.5')
    await userEvent.click(screen.getByRole('button', { name: '重設篩選' }))
    expect(
      (screen.getByRole('spinbutton', { name: '最低量比（倍）' }) as HTMLInputElement).value,
    ).toBe('')
    expect((screen.getByRole('combobox', { name: '選股範圍' }) as HTMLSelectElement).value).toBe(
      'market',
    )
  })
  it('downloads every filtered result across pages rather than only visible rows', async () => {
    const result = scan('market', '2026-09-04', 'DELL')
    result.result = Array.from({ length: 31 }, (_, i) => ({
      ...result.result[0],
      symbol: `NEW${String(i).padStart(2, '0')}`,
    }))
    result.universe = result.result.map((r) => r.symbol)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result)))
    const createObjectURL = vi.fn().mockReturnValue('blob:test-export')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      render(<Screener {...props()} />)
      await screen.findByRole('button', { name: 'NEW00' })
      expect(screen.queryByRole('button', { name: 'NEW30' })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: '匯出全部 31 檔 CSV' }))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = reject
        reader.readAsText(blob)
      })
      expect(csv).toContain('"NEW30"')
      expect(csv.trim().split('\r\n')).toHaveLength(32)
      expect(click).toHaveBeenCalledTimes(1)
    } finally {
      click.mockRestore()
    }
  })
})

describe('market universe limits', () => {
  it('applies selection only to the next market refresh and preserves the displayed current pool', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            response(url.includes('scope=portfolio') ? data().scan : data().market_scan),
          ),
        ),
    )
    const callbacks = props()
    render(<Screener {...callbacks} />)
    await screen.findByRole('button', { name: 'DELL' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '股票池上限' }), '1000')
    expect(callbacks.onRun).not.toHaveBeenCalled()
    expect(screen.getByText(/目前股票池 2 檔/)).toBeTruthy()
    expect(localStorage.getItem(UNIVERSE_LIMIT_KEY)).toBe('1000')
    await userEvent.click(screen.getByRole('button', { name: '執行市場選股' }))
    expect(callbacks.onRun).toHaveBeenLastCalledWith('market', true, 1000)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '選股範圍' }), 'portfolio')
    expect(screen.queryByRole('combobox', { name: '股票池上限' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '執行清單選股' }))
    expect(callbacks.onRun).toHaveBeenLastCalledWith('portfolio', true, undefined)
  })
  it('preserves a larger requested pool even if the provider returned fewer eligible stocks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(data().market_scan))),
    )
    localStorage.setItem(UNIVERSE_LIMIT_KEY, '250')
    const callbacks = props()
    callbacks.data.market_universe_meta = {
      requested_limit: 1000,
      provider_total: 800,
      raw_count: 800,
      accepted_count: 2,
      pages: 4,
      discovered_at: '2026-09-05',
    }
    render(<Screener {...callbacks} />)
    expect((screen.getByRole('combobox', { name: '股票池上限' }) as HTMLSelectElement).value).toBe(
      '1000',
    )
    await userEvent.click(screen.getByRole('button', { name: '執行市場選股' }))
    expect(callbacks.onRun).toHaveBeenCalledWith('market', true, 1000)
  })
  it('rejects invalid stored limits and infers a safe limit for a legacy larger pool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(data().market_scan))),
    )
    localStorage.setItem(UNIVERSE_LIMIT_KEY, '750')
    const callbacks = props()
    callbacks.data.market_universe = Array.from({ length: 501 }, (_, index) => ({
      symbol: `S${index}`,
      name: 'Company',
      discovered_at: '2026-09-05',
    }))
    render(<Screener {...callbacks} />)
    expect((screen.getByRole('combobox', { name: '股票池上限' }) as HTMLSelectElement).value).toBe(
      '1000',
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '股票池上限' }), '250')
    expect((screen.getByRole('combobox', { name: '股票池上限' }) as HTMLSelectElement).value).toBe(
      '250',
    )
  })
})

describe('preserved scan universe context', () => {
  it('keeps preserved results visible and offers scan-only recalculation for a changed pool', async () => {
    const old = {
      ...data().market_scan!,
      matches_current_universe: false,
      scan_member_count: 250,
      current_member_count: 1000,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(old))),
    )
    const callbacks = props()
    callbacks.data.market_scan = old
    render(<Screener {...callbacks} />)
    expect(await screen.findByRole('button', { name: 'DELL' })).toBeTruthy()
    expect(screen.getByText('這份選股結果使用的股票池與目前不同。')).toBeTruthy()
    expect(screen.getByText(/2026-09-04 保留結果：250 檔；目前股票池：1000 檔/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '以目前股票池重新計算' }))
    expect(callbacks.onRun).toHaveBeenCalledWith('market', false)
    expect(screen.getByRole('button', { name: 'DELL' })).toBeTruthy()
    expect(screen.getByText(/即使股價未變也可能產生訊號異動/)).toBeTruthy()
  })
  it('does not show a changed-pool warning when metadata confirms matching membership', async () => {
    const current = {
      ...data().market_scan!,
      matches_current_universe: true,
      scan_member_count: 1,
      current_member_count: 1,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(current))),
    )
    render(<Screener {...props()} />)
    await screen.findByRole('button', { name: 'DELL' })
    expect(screen.queryByText('這份選股結果使用的股票池與目前不同。')).toBeNull()
  })
})
