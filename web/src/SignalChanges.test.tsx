import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SignalChanges } from './SignalChanges'
import type { ChangeReport } from './SignalChanges'
import { deferred, response } from './test/fixtures'
function report(extra: Partial<ChangeReport> = {}): ChangeReport {
  return {
    scope: 'market',
    status: 'ready',
    current_date: '2026-09-04',
    previous_date: '2026-09-03',
    current_snapshot_id: 2,
    previous_snapshot_id: 1,
    current_created_at: '2026-09-05',
    previous_created_at: '2026-09-04',
    current_symbols: 2,
    previous_symbols: 2,
    counts: {
      entered: 1,
      exited: 0,
      continued: 0,
      unavailable: 0,
      universe_added: 0,
      universe_removed: 1,
    },
    events: [
      {
        kind: 'entered',
        symbol: 'NEW',
        name: 'New stock',
        strategy: 'trend',
        previous_status: 'watch',
        current_status: 'match',
        previous_reason: 'low volume',
        current_reason: 'match',
        reason: 'New match',
      },
      {
        kind: 'universe_removed',
        symbol: 'OLD',
        name: 'Old stock',
        strategy: null,
        previous_status: null,
        current_status: null,
        previous_reason: null,
        current_reason: null,
        reason: 'Removed from universe',
      },
    ],
    ...extra,
  }
}
describe('signal change review', () => {
  it('filters membership separately and opens a removed symbol on its previous snapshot date', async () => {
    const open = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(report())))
    render(<SignalChanges scope="market" asOf="2026-09-04" onOpen={open} />)
    expect(await screen.findByRole('button', { name: 'NEW' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'OLD' })).toBeNull()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '異動類型' }),
      'universe_removed',
    )
    await userEvent.click(screen.getByRole('button', { name: 'OLD' }))
    expect(open).toHaveBeenCalledWith('OLD', 'market', '2026-09-03')
  })
  it('shows first snapshot without inventing new entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response(report({ status: 'first_snapshot', previous_date: null, events: [] })),
        ),
    )
    render(<SignalChanges scope="market" onOpen={vi.fn()} />)
    expect(await screen.findByText(/第一份可用紀錄/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '異動類型' })).toBeNull()
  })
  it('ignores late responses when the scope changes', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<SignalChanges scope="market" asOf="2026-09-04" onOpen={vi.fn()} />)
    view.rerender(<SignalChanges scope="portfolio" asOf="2026-09-04" onOpen={vi.fn()} />)
    expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    await act(async () =>
      second.resolve(
        response(report({ scope: 'portfolio', events: [], status: 'first_snapshot' })),
      ),
    )
    await screen.findByText(/第一份可用紀錄/)
    await act(async () => first.resolve(response(report())))
    expect(screen.queryByRole('button', { name: 'NEW' })).toBeNull()
  })
  it('shows a read error and allows retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('Network unavailable'))
        .mockResolvedValueOnce(response(report({ status: 'no_snapshot', current_date: null }))),
    )
    render(<SignalChanges scope="market" onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Network unavailable')
    await userEvent.click(screen.getByRole('button', { name: '重新讀取異動' }))
    expect(await screen.findByText(/所選日期尚無選股紀錄/)).toBeTruthy()
  })
})
