import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ResumeUpdate } from './ResumeUpdate'

describe('resume update', () => {
  it('only submits the chosen scope on request and prevents duplicate starts', async () => {
    let finish!: () => void
    const onResume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<ResumeUpdate marketCount={999} portfolioCount={7} busy={false} onResume={onResume} />)
    expect(onResume).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('續跑股票池'), { target: { value: 'portfolio' } })
    fireEvent.click(screen.getByRole('button', { name: '續跑更新' }))
    fireEvent.click(screen.getByRole('button', { name: '啟動中…' }))
    expect(onResume).toHaveBeenCalledExactlyOnceWith('portfolio')
    await act(async () => {
      finish()
    })
    expect((screen.getByRole('button', { name: '續跑更新' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('blocks empty pools and concurrent jobs without changing the selection', () => {
    const onResume = vi.fn()
    const view = render(
      <ResumeUpdate marketCount={0} portfolioCount={0} busy={false} onResume={onResume} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '續跑更新' }))
    expect(onResume).not.toHaveBeenCalled()
    view.rerender(
      <ResumeUpdate marketCount={999} portfolioCount={7} busy={true} onResume={onResume} />,
    )
    expect((screen.getByLabelText('續跑股票池') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '續跑更新' }))
    expect(onResume).not.toHaveBeenCalled()
  })

  it('retains the selected pool after a failure and permits an explicit retry', async () => {
    const onResume = vi
      .fn()
      .mockRejectedValueOnce(new Error('工作區忙碌'))
      .mockResolvedValueOnce(undefined)
    render(<ResumeUpdate marketCount={999} portfolioCount={7} busy={false} onResume={onResume} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '續跑更新' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('工作區忙碌')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '續跑更新' }))
    })
    expect(onResume).toHaveBeenCalledTimes(2)
    expect(onResume).toHaveBeenLastCalledWith('market')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
