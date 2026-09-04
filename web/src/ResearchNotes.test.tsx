import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ResearchNotes } from './ResearchNotes'
import type { ResearchNote } from './ResearchNotes'
import { deferred, response } from './test/fixtures'
const saved = (symbol = 'DELL', note = 'Existing research', version = 1): ResearchNote => ({
  symbol,
  note,
  tags: ['earnings'],
  updated_at: '2026-09-05T00:00:00Z',
  version,
})

describe('local research journal', () => {
  it('saves user content and trimmed tags with the loaded version', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(saved()))
      .mockResolvedValueOnce(
        response({ ...saved('DELL', 'New research', 2), tags: ['growth', 'earnings'] }),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchNotes symbol="DELL" />)
    const note = await screen.findByRole('textbox', { name: '研究內容' })
    await userEvent.clear(note)
    await userEvent.type(note, 'New research')
    const tags = screen.getByRole('textbox', { name: '研究標籤' })
    await userEvent.clear(tags)
    await userEvent.type(tags, ' growth, earnings ')
    await userEvent.click(screen.getByRole('button', { name: '儲存研究筆記' }))
    expect(await screen.findByText('研究筆記已儲存。')).toBeTruthy()
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      note: 'New research',
      tags: ['growth', 'earnings'],
      version: 1,
    })
    expect(
      (screen.getByRole('button', { name: '儲存研究筆記' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('preserves draft on 409 and reloads only after explicitly discarding it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(saved()))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockResolvedValueOnce(response(saved('DELL', 'Other window research', 2)))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchNotes symbol="DELL" />)
    const note = await screen.findByRole('textbox', { name: '研究內容' })
    await userEvent.clear(note)
    await userEvent.type(note, 'My unsaved draft')
    await userEvent.click(screen.getByRole('button', { name: '儲存研究筆記' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('草稿仍保留'),
    )
    expect((note as HTMLTextAreaElement).value).toBe('My unsaved draft')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: '捨棄草稿並載入最新版本' }))
    expect(await screen.findByDisplayValue('Other window research')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains edits on parent rerender and cancel restores the saved draft', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(saved()))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchNotes symbol="DELL" />)
    await userEvent.type(await screen.findByRole('textbox', { name: '研究內容' }), ' local edits')
    view.rerender(<ResearchNotes symbol="DELL" />)
    expect((screen.getByRole('textbox', { name: '研究內容' }) as HTMLTextAreaElement).value).toBe(
      'Existing research local edits',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: '取消變更' }))
    expect((screen.getByRole('textbox', { name: '研究內容' }) as HTMLTextAreaElement).value).toBe(
      'Existing research',
    )
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
  })

  it('enforces tag count and length before sending a save', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(saved()))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchNotes symbol="DELL" />)
    const tags = await screen.findByRole('textbox', { name: '研究標籤' })
    await userEvent.clear(tags)
    await userEvent.type(tags, 'a,b,c,d,e,f')
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '最多可設定 5 個標籤。')
    expect(
      (screen.getByRole('button', { name: '儲存研究筆記' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await userEvent.clear(tags)
    await userEvent.type(tags, 'a'.repeat(25))
    expect(screen.getByRole('alert')).toHaveProperty('textContent', '每個標籤最多 24 個字元。')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('ignores responses from a previous symbol and aborts a pending save when unmounted', async () => {
    const old = deferred<Response>()
    const posted = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(saved('NVDA')))
      .mockReturnValueOnce(posted.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchNotes symbol="DELL" />)
    view.rerender(<ResearchNotes symbol="NVDA" />)
    await screen.findByRole('textbox', { name: '研究內容' })
    await act(async () => {
      old.resolve(response(saved('DELL', 'Old symbol text')))
    })
    expect(screen.queryByDisplayValue('Old symbol text')).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: '研究內容' }), ' edit')
    await userEvent.click(screen.getByRole('button', { name: '儲存研究筆記' }))
    view.unmount()
    expect((fetcher.mock.calls[2][1] as RequestInit).signal?.aborted).toBe(true)
    await act(async () => {
      posted.resolve(response(saved('NVDA', 'Saved edit', 2)))
    })
    expect(screen.queryByText('研究筆記已儲存。')).toBeNull()
  })

  it('preserves a draft after save failure and supports an explicit retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(saved()))
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValueOnce(response(saved('DELL', 'Existing research edit', 2))),
    )
    render(<ResearchNotes symbol="DELL" />)
    await userEvent.type(await screen.findByRole('textbox', { name: '研究內容' }), ' edit')
    await userEvent.click(screen.getByRole('button', { name: '儲存研究筆記' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline')
    expect((screen.getByRole('textbox', { name: '研究內容' }) as HTMLTextAreaElement).value).toBe(
      'Existing research edit',
    )
    await userEvent.click(screen.getByRole('button', { name: '儲存研究筆記' }))
    expect(await screen.findByText('研究筆記已儲存。')).toBeTruthy()
  })
})
