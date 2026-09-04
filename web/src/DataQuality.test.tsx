import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataQuality } from './DataQuality'
import type { DataQualityResult, QualityItem, QualityStatus } from './DataQuality'
import { deferred, response } from './test/fixtures'

const item = (symbol: string, status: QualityStatus = 'stale'): QualityItem => ({
  symbol, name: `${symbol} company`, status, last_date: '2026-09-03', bars: 249,
  reason: `${symbol} diagnostic`, gap_dates: ['2026-08-31'], invalid_dates: [], source: 'Yahoo Finance',
})
function quality(items = [item('DELL'), item('NVDA', 'ok')]): DataQualityResult {
  return { as_of: '2026-09-04', expected_session: '2026-09-04', checked_at: '2026-09-05T00:00:00Z',
    counts: { total: items.length, ok: items.filter(i => i.status === 'ok').length,
      stale: items.filter(i => i.status === 'stale').length, error: items.filter(i => i.status === 'error').length,
      missing: items.filter(i => i.status === 'missing').length }, items }
}
const props = () => ({ onOpen: vi.fn(), onRetry: vi.fn().mockResolvedValue(undefined), busy: false })

describe('data quality coverage', () => {
  it('shows expected session, filters issues, exposes gap dates and opens the selected symbol', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(quality()))))
    const callbacks = props()
    render(<DataQuality {...callbacks}/>)
    expect(await screen.findByText(/預期交易日：2026-09-04/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'NVDA' })).toBeNull()
    await userEvent.click(screen.getByText(/查看異常日期/))
    expect(screen.getByText('缺口：2026-08-31')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'DELL' }))
    expect(callbacks.onOpen).toHaveBeenCalledWith('DELL')
    await userEvent.click(screen.getByRole('checkbox', { name: '只看有問題的資料' }))
    expect(screen.getByRole('button', { name: 'NVDA' })).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: '選取 NVDA 重試' }) as HTMLInputElement).disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox', { name: '搜尋資料品質標的' }), 'nvda')
    expect(screen.queryByRole('button', { name: 'DELL' })).toBeNull()
  })

  it('retries selected issues and refreshes coverage after the callback completes', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(quality())))
    vi.stubGlobal('fetch', fetcher)
    const callbacks = props()
    render(<DataQuality {...callbacks}/>)
    await userEvent.click(await screen.findByRole('checkbox', { name: '選取 DELL 重試' }))
    await userEvent.click(screen.getByRole('button', { name: '重試選取資料（1）' }))
    expect(callbacks.onRetry).toHaveBeenCalledWith(['DELL'])
    expect(await screen.findByText('已送出 1 檔資料重試，完成後將重新檢查。')).toBeTruthy()
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect((screen.getByRole('checkbox', { name: '選取 DELL 重試' }) as HTMLInputElement).checked).toBe(false)
  })

  it('limits cross-page batch selections to 100 symbols', async () => {
    const items = Array.from({ length: 110 }, (_, i) => item(`STOCK${i}`))
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(quality(items)))))
    const callbacks = props()
    render(<DataQuality {...callbacks}/>)
    await screen.findByRole('button', { name: 'STOCK0' })
    for (let page = 0; page < 4; page++) {
      await userEvent.click(screen.getByRole('checkbox', { name: '選取本頁問題標的' }))
      await userEvent.click(screen.getByRole('button', { name: '下一頁' }))
    }
    expect((screen.getByRole('checkbox', { name: '選取 STOCK100 重試' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: '選取本頁問題標的' }) as HTMLInputElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: '選取本頁問題標的' }))
    await userEvent.click(screen.getByRole('button', { name: '重試選取資料（100）' }))
    expect(callbacks.onRetry.mock.calls[0][0]).toHaveLength(100)
    expect(new Set(callbacks.onRetry.mock.calls[0][0]).size).toBe(100)
  })

  it('keeps selections after a failed retry and blocks retries during a global job', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(quality()))))
    const callbacks = props(); callbacks.onRetry.mockRejectedValue(new Error('Service unavailable'))
    const view = render(<DataQuality {...callbacks}/>)
    await userEvent.click(await screen.findByRole('checkbox', { name: '選取 DELL 重試' }))
    await userEvent.click(screen.getByRole('button', { name: '重試選取資料（1）' }))
    expect(await screen.findByText('重試失敗：Service unavailable')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: '選取 DELL 重試' }) as HTMLInputElement).checked).toBe(true)
    view.rerender(<DataQuality {...callbacks} busy/>)
    expect((screen.getByRole('button', { name: '重試選取資料（1）' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {})
  })

  it('recovers from a load failure and ignores superseded responses', async () => {
    const old = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(quality([item('FRESH', 'error')])))
    vi.stubGlobal('fetch', fetcher)
    const callbacks = props()
    const view = render(<DataQuality {...callbacks}/>)
    view.rerender(<DataQuality {...callbacks} busy/>)
    expect(await screen.findByRole('button', { name: 'FRESH' })).toBeTruthy()
    await act(async () => { old.resolve(response(quality([item('OLD')]))) })
    expect(screen.queryByRole('button', { name: 'OLD' })).toBeNull()
    expect(screen.getByRole('button', { name: 'FRESH' })).toBeTruthy()
  })

  it('offers reload after an endpoint failure without pretending the data is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(response(quality([]))))
    render(<DataQuality {...props()}/>)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline')
    expect(screen.queryByText('目前沒有需要處理的資料。')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(await screen.findByText('尚無可檢查標的。')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
