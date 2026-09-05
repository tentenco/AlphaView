import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ScanProvenanceNotice } from './ScanProvenanceNotice'

it('distinguishes unverifiable legacy snapshots from changed inputs and current results', () => {
  const view = render(<ScanProvenanceNotice status="unknown" />)
  expect(screen.getByText('這份舊選股尚無資料版本紀錄，請重新計算。')).toBeTruthy()
  view.rerender(<ScanProvenanceNotice status="stale" />)
  expect(screen.getByText('資料已變更，這份選股需要重算。')).toBeTruthy()
  view.rerender(<ScanProvenanceNotice status="current" />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('offers explicit recalculation without launching work while busy', () => {
  const recalculate = vi.fn()
  const view = render(<ScanProvenanceNotice status="stale" busy onRecalculate={recalculate} />)
  fireEvent.click(screen.getByRole('button', { name: '以目前資料重算' }))
  expect(recalculate).not.toHaveBeenCalled()
  view.rerender(<ScanProvenanceNotice status="stale" onRecalculate={recalculate} />)
  fireEvent.click(screen.getByRole('button', { name: '以目前資料重算' }))
  expect(recalculate).toHaveBeenCalledOnce()
})
