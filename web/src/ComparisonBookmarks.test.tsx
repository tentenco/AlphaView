import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComparisonBookmarks } from './ComparisonBookmarks'
import { readComparisonBookmarks } from './comparison-bookmarks'
import type { ComparisonResult } from './Comparison'

beforeEach(() => localStorage.clear())
it('saves submitted result settings separately from edited draft and restores the previous draft', async () => {
  const load = vi.fn()
  const result = {
    window: 60,
    series: [{ symbol: 'NVDA' }, { symbol: 'META' }],
    input_revision: 'inputs-1',
    comparison_engine_version: 'test-v1',
    as_of: '2026-09-04',
    anchor_date: '2026-06-01',
    end_date: '2026-09-04',
  } as ComparisonResult
  render(
    <ComparisonBookmarks
      draft={{ symbols: ['MU', 'GOOGL'], window: 252 }}
      result={result}
      locale="en"
      busy={false}
      members={['NVDA', 'META', 'MU', 'GOOGL']}
      onLoad={load}
    />,
  )
  fireEvent.click(screen.getByText('Saved Comparison Groups'))
  fireEvent.change(screen.getByLabelText('Group Name'), { target: { value: 'Submitted pair' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Calculated Result Settings' }))
  await waitFor(() => expect(readComparisonBookmarks()).toHaveLength(1))
  expect(readComparisonBookmarks()[0]).toMatchObject({
    symbols: ['NVDA', 'META'],
    window: 60,
    source: { inputRevision: 'inputs-1' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Load Settings' }))
  expect(load).toHaveBeenLastCalledWith({ symbols: ['NVDA', 'META'], window: 60 })
  fireEvent.click(screen.getByRole('button', { name: 'Restore Previous Selection' }))
  expect(load).toHaveBeenLastCalledWith({ symbols: ['MU', 'GOOGL'], window: 252 })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(readComparisonBookmarks()).toHaveLength(0))
  fireEvent.click(screen.getByRole('button', { name: 'Undo Removal of “Submitted pair”' }))
  await waitFor(() => expect(readComparisonBookmarks()).toHaveLength(1))
})
