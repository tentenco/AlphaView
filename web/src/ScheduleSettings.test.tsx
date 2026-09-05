import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ScheduleSettings } from './ScheduleSettings'
import type { ScheduleConfig } from './ScheduleSettings'
import { response } from './test/fixtures'
const config = (): ScheduleConfig => ({
  enabled: false,
  scope: 'market',
  universe_limit: 250,
  version: 0,
  updated_at: '2026-09-05T00:00:00Z',
  latest_eligible_session: '2026-09-04',
  next_due_at: null,
  poll_interval_seconds: 60,
  last_attempt: null,
})
describe('opt-in end-of-day scheduling', () => {
  it('stays disabled without automatic writes and preserves an existing larger pool on first enable', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(config()))
      .mockResolvedValueOnce(
        response({ ...config(), enabled: true, universe_limit: 1000, version: 1 }),
      )
    vi.stubGlobal('fetch', fetcher)
    render(<ScheduleSettings defaultUniverseLimit={1000} />)
    const enabled = await screen.findByRole('checkbox', { name: '啟用收盤後自動更新' })
    expect(enabled).toHaveProperty('checked', false)
    expect(screen.getByRole('combobox', { name: '排程市場股票池上限' })).toHaveProperty(
      'value',
      '1000',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    await userEvent.click(enabled)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: '儲存排程設定' }))
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      enabled: true,
      scope: 'market',
      universe_limit: 1000,
      version: 0,
    })
    expect(await screen.findByText('收盤後排程已啟用。')).toBeTruthy()
  })
  it('keeps a previously saved smaller limit rather than overwriting an explicit preference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ ...config(), version: 3, universe_limit: 250 })),
    )
    render(<ScheduleSettings defaultUniverseLimit={1000} />)
    expect(await screen.findByRole('combobox', { name: '排程市場股票池上限' })).toHaveProperty(
      'value',
      '250',
    )
  })
  it('preserves unsaved values and their version when job-status refresh returns a newer config', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(config()))
      .mockResolvedValueOnce(response({ ...config(), version: 2, scope: 'portfolio' }))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ScheduleSettings refreshKey="job:running" />)
    await userEvent.click(await screen.findByRole('checkbox', { name: '啟用收盤後自動更新' }))
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '排程市場股票池上限' }),
      '500',
    )
    view.rerender(<ScheduleSettings refreshKey="job:completed" />)
    await screen.findByText('變更尚未儲存')
    expect(screen.getByRole('checkbox', { name: '啟用收盤後自動更新' })).toHaveProperty(
      'checked',
      true,
    )
    expect(screen.getByRole('combobox', { name: '排程市場股票池上限' })).toHaveProperty(
      'value',
      '500',
    )
    await userEvent.click(screen.getByRole('button', { name: '儲存排程設定' }))
    const post = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT')!
    expect(JSON.parse(post[1].body).version).toBe(0)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('你的設定仍保留'),
    )
    expect(screen.getByRole('combobox', { name: '排程市場股票池上限' })).toHaveProperty(
      'value',
      '500',
    )
  })
  it('reloads conflicting settings only after explicitly discarding changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(config()))
        .mockResolvedValueOnce(new Response('{}', { status: 409 }))
        .mockResolvedValueOnce(response({ ...config(), version: 2, scope: 'portfolio' })),
    )
    render(<ScheduleSettings />)
    await userEvent.click(await screen.findByRole('checkbox', { name: '啟用收盤後自動更新' }))
    await userEvent.click(screen.getByRole('button', { name: '儲存排程設定' }))
    await userEvent.click(await screen.findByRole('button', { name: '捨棄變更並載入最新設定' }))
    expect(await screen.findByRole('combobox', { name: '排程股票池' })).toHaveProperty(
      'value',
      'portfolio',
    )
    expect(screen.getByRole('checkbox', { name: '啟用收盤後自動更新' })).toHaveProperty(
      'checked',
      false,
    )
  })
  it('shows the last automatic attempt and explains one-attempt and disabling semantics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          ...config(),
          last_attempt: {
            session_date: '2026-09-04',
            job_id: 'job1',
            scope: 'market',
            universe_limit: 500,
            claimed_at: '2026-09-05T00:15:00Z',
            status: 'partial',
            finished_at: '2026-09-05T00:20:00Z',
            error: '2 symbols failed',
          },
        }),
      ),
    )
    render(<ScheduleSettings />)
    expect(await screen.findByText('最近自動嘗試：2026-09-04 · 部分完成')).toBeTruthy()
    expect(screen.getByText('2 symbols failed')).toBeTruthy()
    expect(screen.getByText(/停用排程不會取消正在執行的作業/)).toBeTruthy()
    expect(screen.getByText(/電腦喚醒後僅補最新交易日/)).toBeTruthy()
  })
})
