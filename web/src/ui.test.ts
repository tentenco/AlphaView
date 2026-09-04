import { describe, expect, it, vi } from 'vitest'
import { api } from './ui'

describe('API error messages', () => {
  it('reports HTML server failures as outages, not invalid user input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 })))
    await expect(api('/api/overview')).rejects.toThrow('伺服器回應異常（502）')
  })
  it('preserves useful backend error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '行情更新正在執行' }), { status: 409 })))
    await expect(api('/api/jobs')).rejects.toThrow('行情更新正在執行')
  })
  it('uses the field validation message only for validation failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: [{ loc: ['body', 'symbol'] }] }), { status: 422 })))
    await expect(api('/api/positions/BAD')).rejects.toThrow('欄位格式不正確')
  })
})
