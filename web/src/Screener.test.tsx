import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Screener } from './Screener'
import { EMPTY_NUMERIC, PRESET_KEY } from './screener-model'
import { deferred, overview, response } from './test/fixtures'
import type { Scan, Scope } from './types'
vi.mock('./SignalChanges', () => ({ SignalChanges: () => <div data-testid="signal-changes"/> }))
function scan(scope: Scope, asOf: string, symbol: string): Scan {
  return { id: scope === 'market' ? 1 : 2, scope, as_of: asOf, created_at: '2026-09-05T00:00:00Z', universe: [symbol], result: [{ symbol, name: `${symbol} company`, date: asOf, bars: 250, indicators: { close: 100, rsi: 50, rps: 90, volume_ratio: 2 }, signals: [{ strategy: 'trend', matched: true, status: 'match', reason: 'ok' }] }] }
}
function data() {
  const d = overview(); d.market_scan = scan('market', '2026-09-04', 'DELL'); d.market_scan_dates = [{ as_of: '2026-09-04' }]; d.scan = scan('portfolio', '2026-09-03', 'NVDA'); d.scan_dates = [{ as_of: '2026-09-03' }]; return d
}
const props = () => ({ data: data(), busy: false, onRun: vi.fn(), onOpen: vi.fn(), onAdded: vi.fn().mockResolvedValue(undefined) })
beforeEach(() => localStorage.clear())
describe('screener interaction lifecycle', () => {
  it('applies a preset from another scope without requesting the previous scope date or displaying late responses', async () => {
    localStorage.setItem(PRESET_KEY, JSON.stringify([{ version: 1, name: 'My trend', settings: { scope: 'portfolio', strategy: 'trend', only: true, newOnly: true, query: '', numeric: { ...EMPTY_NUMERIC, rsiMin: '45' }, sort: 'rps', direction: 'desc' } }]))
    const market = deferred<Response>(); const portfolio = deferred<Response>()
    const fetcher = vi.fn().mockImplementation((url: string) => url.includes('scope=market') ? market.promise : portfolio.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<Screener {...props()}/>)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '已儲存的篩選設定' }), 'My trend')
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/scans?as_of=2026-09-04&scope=market', '/api/scans?as_of=2026-09-03&scope=portfolio'])
    await act(async () => { portfolio.resolve(response(scan('portfolio', '2026-09-03', 'NVDA'))) })
    expect(await screen.findByRole('button', { name: 'NVDA' })).toBeTruthy()
    await act(async () => { market.resolve(response(scan('market', '2026-09-04', 'DELL'))) })
    expect(screen.queryByRole('button', { name: 'DELL' })).toBeNull()
    expect((screen.getByRole('combobox', { name: '選股範圍' }) as HTMLSelectElement).value).toBe('portfolio')
    expect((screen.getByRole('spinbutton', { name: 'RSI 下限' }) as HTMLInputElement).value).toBe('45')
  })
  it('shows API loading failures without keeping stale rows', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    render(<Screener {...props()}/>)
    expect(await screen.findByText('正在載入選股紀錄…')).toBeTruthy()
    await act(async () => { pending.resolve(new Response(JSON.stringify({ detail: '資料來源暫時不可用' }), { status: 503 })) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '資料來源暫時不可用')
    expect(screen.queryByRole('button', { name: 'DELL' })).toBeNull()
    expect((screen.getByRole('button', { name: /匯出全部/ }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('rejects a mismatched API result instead of showing another scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(scan('portfolio', '2026-09-04', 'NVDA'))))
    render(<Screener {...props()}/>)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '選股紀錄與要求的股票池或日期不一致，請重新載入。')
    expect(screen.queryByRole('button', { name: 'NVDA' })).toBeNull()
  })
  it('saves valid filters and resets them while preserving the current scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(scan('market', '2026-09-04', 'DELL'))))
    render(<Screener {...props()}/>)
    await screen.findByRole('button', { name: 'DELL' })
    await userEvent.click(screen.getByText('進階篩選與儲存設定'))
    await userEvent.type(screen.getByRole('spinbutton', { name: '最低量比（倍）' }), '1.5')
    await userEvent.type(screen.getByRole('textbox', { name: '篩選設定名稱' }), '放量')
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }))
    expect(JSON.parse(localStorage.getItem(PRESET_KEY)!)[0].settings.numeric.volumeMin).toBe('1.5')
    await userEvent.click(screen.getByRole('button', { name: '重設篩選' }))
    expect((screen.getByRole('spinbutton', { name: '最低量比（倍）' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('combobox', { name: '選股範圍' }) as HTMLSelectElement).value).toBe('market')
  })
  it('downloads every filtered result across pages rather than only visible rows', async () => {
    const result = scan('market', '2026-09-04', 'DELL')
    result.result = Array.from({ length: 31 }, (_, i) => ({ ...result.result[0], symbol: `NEW${String(i).padStart(2, '0')}` }))
    result.universe = result.result.map(r => r.symbol)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result)))
    const createObjectURL = vi.fn().mockReturnValue('blob:test-export')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      render(<Screener {...props()}/>)
      await screen.findByRole('button', { name: 'NEW00' })
      expect(screen.queryByRole('button', { name: 'NEW30' })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: '匯出全部 31 檔 CSV' }))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      const csv = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
      expect(csv).toContain('"NEW30"')
      expect(csv.trim().split('\r\n')).toHaveLength(32)
      expect(click).toHaveBeenCalledTimes(1)
    } finally { click.mockRestore() }
  })

})
