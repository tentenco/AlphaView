import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StorageMaintenance, type StorageUsage } from './StorageMaintenance'
import { deferred, response } from './test/fixtures'
const usage = (fingerprint = 'one', superseded = 3): StorageUsage => ({
  fingerprint,
  scan_rows: superseded + 2,
  retained_scan_rows: 2,
  superseded_scan_rows: superseded,
  superseded_payload_bytes: 5000,
  tables: [],
  database_bytes: 1048576,
  wal_bytes: 1024,
  page_size: 4096,
  page_count: 256,
  freelist_pages: 1,
  reusable_bytes: 4096,
  cleanup_available: true,
  warnings: [],
})
const review = async () => userEvent.click(screen.getByRole('button', { name: '檢視清理範圍' }))
describe('storage maintenance explicit confirmation', () => {
  it('requires review and confirmation, prevents double commit, then updates usage', async () => {
    const pending = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(usage()))
      .mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<StorageMaintenance />)
    await screen.findByText('全部選股快照')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '確認清理重複快照' })).toBeNull()
    await review()
    await userEvent.click(screen.getByRole('button', { name: '返回，不清理' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    await review()
    await userEvent.dblClick(screen.getByRole('button', { name: '確認清理重複快照' }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe('/api/storage/cleanup')
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      expected_fingerprint: 'one',
      confirm: true,
    })
    expect(screen.getByRole('button', { name: '重新整理用量' })).toHaveProperty('disabled', true)
    await act(async () =>
      pending.resolve(
        response({ deleted_rows: 3, deleted_payload_bytes: 5000, storage: usage('two', 0) }),
      ),
    )
    expect(await screen.findByText(/已清理 3 筆重複選股快照/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '檢視清理範圍' })).toHaveProperty('disabled', true)
  })
  it('preserves conflict context and requires fresh preview before retry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(usage()))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: '資料已更新' }), { status: 409 }),
      )
      .mockResolvedValueOnce(response(usage('new', 4)))
    vi.stubGlobal('fetch', fetcher)
    render(<StorageMaintenance />)
    await screen.findByText('全部選股快照')
    await review()
    await userEvent.click(screen.getByRole('button', { name: '確認清理重複快照' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '資料已更新 請重新整理用量，再檢視清理範圍。',
    )
    expect(screen.getByRole('button', { name: '檢視清理範圍' })).toHaveProperty('disabled', true)
    expect(screen.getByText('全部選股快照')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重新整理用量' }))
    await review()
    expect(await screen.findByText(/即將刪除 4 筆/)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('shows initial read failure without offering cleanup', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: '資料庫忙碌' }), { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    render(<StorageMaintenance />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '資料庫忙碌')
    expect(screen.queryByRole('button', { name: '檢視清理範圍' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('summarizes retention and space limits once without exposing backend jargon', async () => {
    const data = usage()
    data.warnings = ['payload_bytes 是文字位元組數', '不執行 VACUUM']
    data.tables = [{ name: 'research_notes', rows: 2, payload_bytes: 100 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
    render(<StorageMaintenance />)
    await screen.findByText('全部選股快照')
    expect(screen.queryByText(/payload_bytes|VACUUM/)).toBeNull()
    expect(screen.getAllByText(/資料庫檔案不一定縮小/)).toHaveLength(1)
    expect(screen.getByText(/作業與排程紀錄全部保留/)).toBeTruthy()
    await userEvent.click(screen.getByText('檢視各類資料用量'))
    expect(screen.getByText('研究筆記')).toBeTruthy()
    expect(screen.queryByText('research_notes')).toBeNull()
  })
})
