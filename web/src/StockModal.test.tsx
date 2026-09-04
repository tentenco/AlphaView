import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StockModal } from './Research'
import { overview, position, response } from './test/fixtures'

vi.mock('./Charts', () => ({ PriceChart: () => null, EquityChart: () => null }))
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open') } })
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.startsWith('/api/notes/')
    ? { symbol: 'NVDA', note: '', tags: [], updated_at: null, version: 0 }
    : { position: position(), history: [], strategies: overview().strategies }))))
})
describe('stock dialog unsaved research', () => {
  it('keeps the modal open until unsaved notes are explicitly discarded', async () => {
    const close = vi.fn()
    render(<StockModal symbol="NVDA" onClose={close}/>)
    await userEvent.type(await screen.findByRole('textbox', { name: '研究內容' }), 'Unsaved research')
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByText('研究筆記尚未儲存，是否捨棄變更並關閉？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '繼續編輯筆記' }))
    expect(screen.queryByText('研究筆記尚未儲存，是否捨棄變更並關閉？')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    await userEvent.click(screen.getByRole('button', { name: '捨棄變更並關閉' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('intercepts native Escape cancellation for dirty notes but closes clean notes directly', async () => {
    const close = vi.fn()
    render(<StockModal symbol="NVDA" onClose={close}/>)
    await userEvent.type(await screen.findByRole('textbox', { name: '研究內容' }), 'Draft')
    const event = new Event('cancel', { cancelable: true, bubbles: false })
    act(() => { screen.getByRole('dialog').dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(close).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '繼續編輯筆記' }))
    await userEvent.click(screen.getByRole('button', { name: '取消變更' }))
    fireEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
