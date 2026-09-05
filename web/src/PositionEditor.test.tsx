import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PositionEditor } from './Portfolio'
import type { Position } from './types'

beforeEach(() => {
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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('sends the loaded version and preserves draft after a conflicting edit', async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ detail: '資料已變更，請重新開啟編輯' }),
  })
  vi.stubGlobal('fetch', fetcher)
  const onSaved = vi.fn()
  render(
    <PositionEditor
      position={
        {
          symbol: 'TEST',
          name: 'Synthetic',
          shares: 1,
          cost: 10,
          sector: 'Test',
          updated_at: 'revision-1',
        } as Position
      }
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  )
  fireEvent.change(screen.getByRole('spinbutton', { name: '持股數' }), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存標的' }))
  expect((await screen.findByRole('alert')).textContent).toContain('資料已變更')
  expect((screen.getByRole('spinbutton', { name: '持股數' }) as HTMLInputElement).value).toBe('3')
  expect(onSaved).not.toHaveBeenCalled()
  expect(JSON.parse(fetcher.mock.calls[0][1].body).expected_updated_at).toBe('revision-1')
})

it('marks a new symbol as create-only', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetcher)
  const onSaved = vi.fn()
  render(<PositionEditor position={null} onClose={vi.fn()} onSaved={onSaved} />)
  fireEvent.change(screen.getByRole('textbox', { name: '股票代碼' }), { target: { value: 'TEST' } })
  fireEvent.change(screen.getByRole('textbox', { name: '公司名稱' }), {
    target: { value: 'Synthetic' },
  })
  fireEvent.click(screen.getByRole('button', { name: '儲存標的' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
  expect(JSON.parse(fetcher.mock.calls[0][1].body).expected_updated_at).toBeNull()
})
