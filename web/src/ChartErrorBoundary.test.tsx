import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ChartErrorBoundary } from './ChartErrorBoundary'
it('contains a chart render error and only reloads on explicit user action', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const reload = vi.fn()
  function BrokenChart(): never {
    throw new Error('Malformed chart renderer')
  }
  try {
    render(
      <>
        <ChartErrorBoundary onReload={reload}>
          <BrokenChart />
        </ChartErrorBoundary>
        <table>
          <tbody>
            <tr>
              <td>Actual result remains</td>
            </tr>
          </tbody>
        </table>
      </>,
    )
    expect(screen.getByText('比較圖暫時無法顯示')).toBeTruthy()
    expect(screen.getByText('Actual result remains')).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '重新載入頁面' }))
    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})
