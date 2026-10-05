import { useEffect, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchEvidenceSection } from './ResearchEvidenceSection'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native research evidence disclosure', () => {
  it('defaults open, and folding preserves mounted child state, draft value and node identity', async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function Draft() {
      const [draft, setDraft] = useState('synthetic draft')
      const [count, setCount] = useState(0)
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return (
        <div>
          <label>
            Saved evidence draft
            <input value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Local count {count}
          </button>
        </div>
      )
    }
    const view = render(
      <ResearchEvidenceSection id="synthetic-section" title="Path evidence">
        <Draft />
      </ResearchEvidenceSection>,
    )
    const details = view.container.querySelector('details')!
    const summary = details.querySelector('summary')!
    const input = screen.getByRole('textbox', { name: 'Saved evidence draft' }) as HTMLInputElement
    const childNode = input.parentElement
    expect(details.open).toBe(true)
    expect(details.getAttribute('data-research-evidence-section')).toBe('')
    await userEvent.type(input, ' still editing')
    await userEvent.click(screen.getByRole('button', { name: 'Local count 0' }))
    await userEvent.click(summary)
    expect(details.open).toBe(false)
    expect(details.querySelector('input')).toBe(input)
    expect(input.parentElement).toBe(childNode)
    expect(input.value).toBe('synthetic draft still editing')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    view.rerender(
      <ResearchEvidenceSection id="synthetic-section" title="Updated title" defaultOpen={false}>
        <Draft />
      </ResearchEvidenceSection>,
    )
    expect(details.open).toBe(false)
    await userEvent.click(summary)
    expect(details.open).toBe(true)
    expect(screen.getByRole('button', { name: 'Local count 1' })).toBeTruthy()
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input.value).toBe('synthetic draft still editing')
    view.rerender(
      <ResearchEvidenceSection id="synthetic-section" title="Updated again" defaultOpen={false}>
        <Draft />
      </ResearchEvidenceSection>,
    )
    expect(details.open).toBe(true)
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  })

  it('uses defaultOpen only on initial mount and keeps closed children mounted', async () => {
    const mounted = vi.fn()
    function Body() {
      useEffect(mounted, [])
      return <p>Mounted body</p>
    }
    const view = render(
      <ResearchEvidenceSection id="synthetic-closed" title="Closed evidence" defaultOpen={false}>
        <Body />
      </ResearchEvidenceSection>,
    )
    const details = view.container.querySelector('details')!
    const child = details.querySelector('p')!
    expect(details.open).toBe(false)
    expect(child.textContent).toBe('Mounted body')
    expect(mounted).toHaveBeenCalledTimes(1)
    view.rerender(
      <ResearchEvidenceSection id="synthetic-closed" title="Still closed" defaultOpen>
        <Body />
      </ResearchEvidenceSection>,
    )
    expect(details.open).toBe(false)
    expect(details.querySelector('p')).toBe(child)
    await userEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(mounted).toHaveBeenCalledTimes(1)
  })

  it('keeps a native first summary tabbable and lets keyboard activation pass to the browser', async () => {
    const view = render(
      <ResearchEvidenceSection id="synthetic-keyboard" title="Keyboard evidence">
        <p>Evidence body</p>
      </ResearchEvidenceSection>,
    )
    const details = view.container.querySelector('details')!
    const summary = details.firstElementChild as HTMLElement
    expect(summary.tagName).toBe('SUMMARY')
    expect(summary.hasAttribute('role')).toBe(false)
    expect(summary.hasAttribute('tabindex')).toBe(false)
    expect(summary.querySelector('h3')?.textContent).toBe('Keyboard evidence')
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement).toBe(summary)
    expect(fireEvent.keyDown(summary, { key: 'Enter', code: 'Enter' })).toBe(true)
    expect(fireEvent.keyUp(summary, { key: 'Enter', code: 'Enter' })).toBe(true)
    // jsdom/user-event do not synthesize summary activation for Enter or Space.
    // A native keyboard-generated click has detail 0 and uses this same default action.
    fireEvent.click(summary, { detail: 0 })
    expect(details.open).toBe(false)
    expect(fireEvent.keyDown(summary, { key: ' ', code: 'Space' })).toBe(true)
    expect(fireEvent.keyUp(summary, { key: ' ', code: 'Space' })).toBe(true)
    fireEvent.click(summary, { detail: 0 })
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(summary)
  })

  it('does not fetch, persist, write the hash or submit a surrounding form when toggled', async () => {
    const fetcher = vi.fn()
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const hash = window.location.hash
    const view = render(
      <form onSubmit={submit}>
        <ResearchEvidenceSection id="synthetic-no-effects" title="Read evidence">
          <input defaultValue="still mounted" />
        </ResearchEvidenceSection>
      </form>,
    )
    const summary = view.container.querySelector('summary')!
    await userEvent.click(summary)
    await userEvent.click(summary)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(hash)
  })
})
