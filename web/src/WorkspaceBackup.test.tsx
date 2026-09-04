import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupPreferences, WorkspaceBackup } from './WorkspaceBackup'
import { EMPTY_NUMERIC, PRESET_KEY } from './screener-model'
import { UNIVERSE_LIMIT_KEY } from './Screener'
import { deferred } from './test/fixtures'
const settings = {
  scope: 'market',
  strategy: 'trend',
  only: true,
  newOnly: true,
  query: '',
  numeric: { ...EMPTY_NUMERIC },
  sort: 'matches',
  direction: 'desc',
}
beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn().mockReturnValue('blob:local-backup'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => vi.useRealTimers())
describe('allowlisted backup preferences', () => {
  it('reads only AlphaView preference keys and strips unknown nested properties', () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === PRESET_KEY
          ? JSON.stringify([
              {
                version: 1,
                name: 'Trend',
                secret: 'do-not-copy',
                settings: {
                  ...settings,
                  secret: 'hidden',
                  numeric: { ...EMPTY_NUMERIC, credential: 'hidden' },
                },
              },
            ])
          : key === UNIVERSE_LIMIT_KEY
            ? '500'
            : 'private',
      ),
    }
    const result = backupPreferences(storage)
    expect(storage.getItem.mock.calls.map((call) => call[0])).toEqual([
      PRESET_KEY,
      UNIVERSE_LIMIT_KEY,
    ])
    expect(result.preferences).toEqual({
      presets: [{ version: 1, name: 'Trend', settings }],
      universe_limit: 500,
    })
    expect(JSON.stringify(result.preferences)).not.toContain('secret')
    expect(JSON.stringify(result.preferences)).not.toContain('credential')
  })
  it('reports skipped invalid settings without blocking a database backup', () => {
    const result = backupPreferences({
      getItem: (key) => (key === PRESET_KEY ? '{broken json' : '750'),
    })
    expect(result.preferences).toEqual({})
    expect(result.warnings).toHaveLength(2)
  })
})
describe('local ZIP download', () => {
  it('sends only approved preferences and revokes the object URL after download time', async () => {
    vi.useFakeTimers()
    localStorage.setItem(PRESET_KEY, JSON.stringify([{ version: 1, name: 'Trend', settings }]))
    localStorage.setItem(UNIVERSE_LIMIT_KEY, '1000')
    localStorage.setItem('auth-token', 'must-not-send')
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="alphaview-backup-test.zip"',
        },
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<WorkspaceBackup />)
    fireEvent.click(screen.getByRole('button', { name: '下載本機備份' }))
    await act(async () => {})
    expect(fetcher.mock.calls[0][0]).toBe('/api/backups')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      preferences: { presets: [{ version: 1, name: 'Trend', settings }], universe_limit: 1000 },
    })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-backup')
  })
  it('rejects an HTML success body and allows a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('<h1>Oops</h1>', { headers: { 'Content-Type': 'text/html' } }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([80, 75]), {
            headers: { 'Content-Type': 'application/zip' },
          }),
        ),
    )
    render(<WorkspaceBackup />)
    await userEvent.click(screen.getByRole('button', { name: '下載本機備份' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '伺服器未回傳 ZIP 備份，未下載檔案。',
    )
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '下載本機備份' }))
    expect(await screen.findByText(/本機備份已開始下載/)).toBeTruthy()
  })
  it('prevents duplicate requests and surfaces backend errors', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<WorkspaceBackup />)
    await userEvent.click(screen.getByRole('button', { name: '下載本機備份' }))
    await userEvent.click(screen.getByRole('button', { name: '準備備份中…' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve(
        new Response(JSON.stringify({ detail: '另一個備份正在執行' }), { status: 409 }),
      )
    })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '另一個備份正在執行')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
