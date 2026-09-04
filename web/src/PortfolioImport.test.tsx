import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortfolioImport } from './PortfolioImport'
import type { ImportPreview } from './PortfolioImport'
import { deferred, response } from './test/fixtures'
const csv = 'symbol,shares,cost\nAAPL,2,100'
const preview = (): ImportPreview => ({
  valid: true,
  errors: [],
  warnings: [],
  rows: [
    {
      symbol: 'AAPL',
      action: 'update',
      before: { name: 'Apple', shares: 1, cost: 90, sector: 'Technology' },
      after: { name: 'Apple', shares: 2, cost: 100, sector: 'Technology' },
    },
  ],
  counts: { add: 0, update: 1, unchanged: 0, total: 1 },
  fingerprint: 'preview-fingerprint',
})
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
async function inspect() {
  fireEvent.change(screen.getByRole('textbox', { name: '或貼上 CSV 內容' }), {
    target: { value: csv },
  })
  await userEvent.click(screen.getByRole('button', { name: '預覽匯入' }))
}
describe('portfolio CSV preview and commit', () => {
  it('requires a valid preview and displays row errors without committing', async () => {
    const invalid = {
      ...preview(),
      valid: false,
      fingerprint: null,
      errors: [{ row: 2, field: 'shares', message: 'Shares must be nonnegative' }],
    }
    const fetcher = vi.fn().mockResolvedValue(response(invalid))
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await inspect()
    expect(await screen.findByText('第 2 列 · shares：Shares must be nonnegative')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '確認匯入 1 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/portfolio/import/preview'])
  })
  it('shows before/after data and invalidates authorization when the CSV changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(preview())))
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    await inspect()
    expect(await screen.findByText('$90.00 → $100.00')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '或貼上 CSV 內容' }), {
      target: { value: csv + '\nDELL,1,90' },
    })
    expect(screen.queryByText('$90.00 → $100.00')).toBeNull()
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('preserves CSV after a stale 409 conflict and requires another preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(preview()))
        .mockResolvedValueOnce(new Response('{}', { status: 409 })),
    )
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    await inspect()
    await userEvent.click(screen.getByRole('button', { name: '確認匯入 1 筆' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('請重新預覽'),
    )
    expect(screen.getByRole('textbox', { name: '或貼上 CSV 內容' })).toHaveProperty('value', csv)
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('commits exactly the preview fingerprint, blocks closing during write, and refreshes after success', async () => {
    const pending = deferred<Response>()
    const onClose = vi.fn()
    const onImported = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(preview()))
      .mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioImport onClose={onClose} onImported={onImported} />)
    await inspect()
    await userEvent.click(screen.getByRole('button', { name: '確認匯入 1 筆' }))
    await userEvent.click(screen.getByRole('button', { name: '關閉視窗' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      csv_text: csv,
      expected_fingerprint: 'preview-fingerprint',
    })
    expect(
      (screen.getByRole('button', { name: '確認匯入 1 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await act(async () => {
      pending.resolve(response({ ...preview(), imported: { added: 0, updated: 1, unchanged: 0 } }))
    })
    expect(onImported).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('does not apply a late preview after input has changed', async () => {
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(old.promise))
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    await inspect()
    fireEvent.change(screen.getByRole('textbox', { name: '或貼上 CSV 內容' }), {
      target: { value: 'symbol,shares,cost\nDELL,0,' },
    })
    await act(async () => {
      old.resolve(response(preview()))
    })
    expect(screen.queryByText('$90.00 → $100.00')).toBeNull()
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('CSV file decoding', () => {
  it('loads UTF-8 CSV input without writing any positions', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    const file = new File([csv], 'positions.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(csv).buffer,
    })
    await userEvent.upload(screen.getByLabelText('選擇 UTF-8 CSV 檔案'), file)
    expect(screen.getByRole('textbox', { name: '或貼上 CSV 內容' })).toHaveProperty('value', csv)
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('rejects invalid UTF-8 rather than silently replacing characters', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<PortfolioImport onClose={vi.fn()} onImported={vi.fn()} />)
    const file = new File(['invalid'], 'positions.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([0xff, 0xff]).buffer,
    })
    await userEvent.upload(screen.getByLabelText('選擇 UTF-8 CSV 檔案'), file)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('讀取 CSV 失敗'),
    )
    expect(
      (screen.getByRole('button', { name: '確認匯入 0 筆' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
