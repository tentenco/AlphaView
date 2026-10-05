import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchEvidenceNavigation, type ResearchEvidenceTool } from './ResearchEvidenceNavigation'
import { ResearchEvidenceSection } from './ResearchEvidenceSection'

const t = (_zh: string, en: string) => en
const tools: ResearchEvidenceTool[] = [
  { targetId: 'synthetic-rules', label: 'Rules', purpose: 'Inspect standalone rule evidence.' },
  { targetId: 'synthetic-path', label: 'Path', purpose: 'Inspect the saved allocation path.' },
]
let scroll = vi.fn<HTMLElement['scrollIntoView']>()
const originalScroll = HTMLElement.prototype.scrollIntoView
beforeEach(() => {
  scroll = vi.fn<HTMLElement['scrollIntoView']>()
  HTMLElement.prototype.scrollIntoView = scroll
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  )
})

describe('scoped folding controls and disclosure navigation', () => {
  it('collapses only listed managed sections, preserves their draft nodes, and expands without remounting', async () => {
    const ref = createRef<HTMLElement>()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const hash = window.location.hash
    const view = render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="folding"
          tools={[...tools, { targetId: 'synthetic-unmanaged', label: 'Unmanaged' }]}
          collapsible
          t={t}
        />
        <ResearchEvidenceSection id="synthetic-rules" title="Rules section">
          <label>
            Inner draft
            <input defaultValue="synthetic draft" />
          </label>
        </ResearchEvidenceSection>
        <ResearchEvidenceSection id="synthetic-path" title="Path section">
          <details data-testid="inner-method">
            <summary>Method details</summary>Method body
          </details>
        </ResearchEvidenceSection>
        <ResearchEvidenceSection id="synthetic-unlisted" title="Unlisted section">
          <p>Keep its state</p>
        </ResearchEvidenceSection>
        <details id="synthetic-unmanaged" open>
          <summary>Unmanaged section</summary>Keep open
        </details>
      </section>,
    )
    const rules = view.container.querySelector('#synthetic-rules') as HTMLDetailsElement
    const path = view.container.querySelector('#synthetic-path') as HTMLDetailsElement
    const unlisted = view.container.querySelector('#synthetic-unlisted') as HTMLDetailsElement
    const unmanaged = view.container.querySelector('#synthetic-unmanaged') as HTMLDetailsElement
    const method = screen.getByTestId('inner-method') as HTMLDetailsElement
    const input = screen.getByRole('textbox', { name: 'Inner draft' }) as HTMLInputElement
    await userEvent.type(input, ' edited')
    const collapse = screen.getByRole('button', { name: 'Collapse all' })
    expect(collapse.getAttribute('aria-controls')).toBe('synthetic-rules synthetic-path')
    await userEvent.click(collapse)
    expect(rules.open).toBe(false)
    expect(path.open).toBe(false)
    expect(unlisted.open).toBe(true)
    expect(unmanaged.open).toBe(true)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('synthetic draft edited')
    expect(scroll).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(rules.open).toBe(true)
    expect(path.open).toBe(true)
    expect(method.open).toBe(false)
    expect(screen.getByRole('textbox', { name: 'Inner draft' })).toBe(input)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(hash)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('opens only the selected managed section before reduced-motion scrolling and heading focus', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const ref = createRef<HTMLElement>()
    const view = render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="jump-folding"
          tools={tools}
          collapsible
          t={t}
        />
        <ResearchEvidenceSection
          id="synthetic-rules"
          title="Closed rule heading"
          defaultOpen={false}
        >
          <input defaultValue="rule draft" />
        </ResearchEvidenceSection>
        <ResearchEvidenceSection
          id="synthetic-path"
          title="Closed path heading"
          defaultOpen={false}
        >
          <p>Path body</p>
        </ResearchEvidenceSection>
      </section>,
    )
    const rules = view.container.querySelector('#synthetic-rules') as HTMLDetailsElement
    const path = view.container.querySelector('#synthetic-path') as HTMLDetailsElement
    scroll.mockImplementation(function (this: HTMLElement) {
      expect(this).toBe(rules)
      expect(rules.open).toBe(true)
      expect(path.open).toBe(false)
    })
    screen.getByRole('button', { name: 'Rules' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'start', inline: 'nearest' })
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Closed rule heading' }),
    )
    expect(path.open).toBe(false)
    expect(rules.querySelector('input')?.value).toBe('rule draft')
  })

  it('opens every containing managed ancestor inside its workspace, without changing nested siblings or outside details', async () => {
    const ref = createRef<HTMLElement>()
    const view = render(
      <>
        <ResearchEvidenceSection id="synthetic-outside" title="Outside" defaultOpen={false}>
          <p>Outside body</p>
        </ResearchEvidenceSection>
        <section ref={ref}>
          <ResearchEvidenceNavigation
            workspaceRef={ref}
            scopeKey="nested"
            tools={[tools[0]]}
            t={t}
          />
          <ResearchEvidenceSection id="synthetic-parent" title="Outer evidence" defaultOpen={false}>
            <ResearchEvidenceSection
              id="synthetic-middle"
              title="Middle evidence"
              defaultOpen={false}
            >
              <section id="synthetic-rules">
                <h4>Nested rule heading</h4>
              </section>
              <ResearchEvidenceSection
                id="synthetic-nested-sibling"
                title="Nested sibling"
                defaultOpen={false}
              >
                <p>Sibling body</p>
              </ResearchEvidenceSection>
            </ResearchEvidenceSection>
          </ResearchEvidenceSection>
        </section>
      </>,
    )
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Rules' }))
    for (const id of ['synthetic-parent', 'synthetic-middle'])
      expect((view.container.querySelector(`#${id}`) as HTMLDetailsElement).open).toBe(true)
    for (const id of ['synthetic-outside', 'synthetic-nested-sibling'])
      expect((view.container.querySelector(`#${id}`) as HTMLDetailsElement).open).toBe(false)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Nested rule heading' }),
    )
  })

  it('isolates two navigation control sets with disjoint target IDs in the same workspace', async () => {
    const ref = createRef<HTMLElement>()
    const view = render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="rules-only"
          tools={[tools[0]]}
          collapsible
          t={t}
        />
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="path-only"
          tools={[tools[1]]}
          collapsible
          t={t}
        />
        <ResearchEvidenceSection id="synthetic-rules" title="Rules section">
          <p>Rules body</p>
        </ResearchEvidenceSection>
        <ResearchEvidenceSection id="synthetic-path" title="Path section">
          <p>Path body</p>
        </ResearchEvidenceSection>
      </section>,
    )
    const [rulesNav, pathNav] = screen.getAllByRole('navigation')
    const rules = view.container.querySelector('#synthetic-rules') as HTMLDetailsElement
    const path = view.container.querySelector('#synthetic-path') as HTMLDetailsElement
    await userEvent.click(within(rulesNav).getByRole('button', { name: 'Collapse all' }))
    expect(rules.open).toBe(false)
    expect(path.open).toBe(true)
    await userEvent.click(within(pathNav).getByRole('button', { name: 'Collapse all' }))
    await userEvent.click(within(rulesNav).getByRole('button', { name: 'Expand all' }))
    expect(rules.open).toBe(true)
    expect(path.open).toBe(false)
    await userEvent.click(within(pathNav).getByRole('button', { name: 'Path' }))
    expect(path.open).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Path section' }))
  })

  it('isolates repeated IDs across separate workspace refs for both bulk controls and navigation', async () => {
    const first = createRef<HTMLElement>()
    const second = createRef<HTMLElement>()
    render(
      <>
        <section ref={first}>
          <ResearchEvidenceNavigation
            workspaceRef={first}
            scopeKey="one"
            tools={[tools[0]]}
            collapsible
            t={t}
          />
          <ResearchEvidenceSection id="synthetic-rules" title="First workspace rules">
            <p>One</p>
          </ResearchEvidenceSection>
        </section>
        <section ref={second}>
          <ResearchEvidenceNavigation
            workspaceRef={second}
            scopeKey="two"
            tools={[tools[0]]}
            collapsible
            t={t}
          />
          <ResearchEvidenceSection id="synthetic-rules" title="Second workspace rules">
            <p>Two</p>
          </ResearchEvidenceSection>
        </section>
      </>,
    )
    const [firstNav, secondNav] = screen.getAllByRole('navigation')
    const firstTarget = first.current!.querySelector('details')!
    const secondTarget = second.current!.querySelector('details')!
    await userEvent.click(within(firstNav).getByRole('button', { name: 'Collapse all' }))
    expect(firstTarget.open).toBe(false)
    expect(secondTarget.open).toBe(true)
    await userEvent.click(within(secondNav).getByRole('button', { name: 'Collapse all' }))
    await userEvent.click(within(firstNav).getByRole('button', { name: 'Rules' }))
    expect(firstTarget.open).toBe(true)
    expect(secondTarget.open).toBe(false)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'First workspace rules' }),
    )
  })

  it('skips ambiguous and detached managed targets at bulk-click time before observer delivery', async () => {
    const ref = createRef<HTMLElement>()
    const view = render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="stale-folding"
          tools={tools}
          collapsible
          t={t}
        />
        <ResearchEvidenceSection id="synthetic-rules" title="Rules section">
          <p>Rules</p>
        </ResearchEvidenceSection>
        <ResearchEvidenceSection id="synthetic-path" title="Path section">
          <p>Path</p>
        </ResearchEvidenceSection>
      </section>,
    )
    const rules = view.container.querySelector('#synthetic-rules') as HTMLDetailsElement
    const path = view.container.querySelector('#synthetic-path') as HTMLDetailsElement
    const duplicate = rules.cloneNode(true) as HTMLDetailsElement
    act(() => {
      ref.current!.appendChild(duplicate)
      path.remove()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    })
    expect(rules.open).toBe(true)
    expect(duplicate.open).toBe(true)
    expect(path.open).toBe(true)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    )
    expect(scroll).not.toHaveBeenCalled()
  })

  it('disables optional bulk controls when no listed target is a managed disclosure', () => {
    const ref = createRef<HTMLElement>()
    render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="no-managed"
          tools={[tools[0]]}
          collapsible
          t={t}
        />
        <section id="synthetic-rules">
          <h2>Plain target</h2>
        </section>
      </section>,
    )
    expect((screen.getByRole('button', { name: 'Expand all' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Expand all' }).hasAttribute('aria-controls')).toBe(
      false,
    )
    expect((screen.getByRole('button', { name: 'Rules' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})
afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScroll
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function workspace(
  options: {
    second?: boolean
    tabIndex?: number
    outside?: boolean
    scopeKey?: string
    tools?: ResearchEvidenceTool[]
  } = {},
) {
  const ref = createRef<HTMLElement>()
  const view = render(
    <>
      {options.outside && (
        <section id="synthetic-path">
          <h2>Other account path</h2>
        </section>
      )}
      <section ref={ref} data-testid="workspace">
        <label>
          Unsaved draft
          <input defaultValue="synthetic draft" />
        </label>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey={options.scopeKey ?? 'synthetic-account:run1'}
          tools={options.tools ?? tools}
          t={t}
        />
        <section id="synthetic-rules">
          <h2 tabIndex={options.tabIndex}>Rule evidence heading</h2>
        </section>
        {options.second && (
          <section id="synthetic-path">
            <h2>Path evidence heading</h2>
          </section>
        )}
      </section>
    </>,
  )
  return { ref, ...view }
}

describe('scoped research section navigation', () => {
  it('never scrolls, fetches, focuses or persists until an explicit click, then preserves draft and route', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const hash = window.location.hash
    const { ref } = workspace({ second: true })
    const input = screen.getByRole('textbox', { name: 'Unsaved draft' })
    await userEvent.type(input, ' still editing')
    expect(document.activeElement).toBe(input)
    expect(scroll).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Rules' })
    expect(button.getAttribute('aria-controls')).toBe('synthetic-rules')
    await userEvent.click(button)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(ref.current!.querySelector('#synthetic-rules'))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Rule evidence heading' }),
    )
    expect((input as HTMLInputElement).value).toBe('synthetic draft still editing')
    expect(window.location.hash).toBe(hash)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('uses native keyboard Enter and Space, with meaningful focus on the destination heading', async () => {
    workspace({ second: true })
    const user = userEvent.setup()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rules' }))
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Rule evidence heading' }),
    )
    screen.getByRole('button', { name: 'Path' }).focus()
    await user.keyboard(' ')
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Path evidence heading' }),
    )
    expect(scroll).toHaveBeenCalledTimes(2)
  })

  it('uses instant scrolling for reduced motion and removes only its temporary tabindex on blur', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    workspace()
    const heading = screen.getByRole('heading', { name: 'Rule evidence heading' })
    expect(heading.hasAttribute('tabindex')).toBe(false)
    const focus = vi.spyOn(heading, 'focus')
    await userEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'start', inline: 'nearest' })
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(heading.classList.contains('research-evidence-navigation-focus')).toBe(true)
    screen.getByRole('textbox').focus()
    expect(heading.hasAttribute('tabindex')).toBe(false)
    expect(heading.classList.contains('research-evidence-navigation-focus')).toBe(false)
  })

  it.each([0, -1])(
    'preserves original heading tabindex %s through blur and unmount',
    async (tabIndex) => {
      const view = workspace({ tabIndex })
      const heading = screen.getByRole('heading', { name: 'Rule evidence heading' })
      await userEvent.click(screen.getByRole('button', { name: 'Rules' }))
      screen.getByRole('textbox').focus()
      expect(heading.getAttribute('tabindex')).toBe(String(tabIndex))
      await userEvent.click(screen.getByRole('button', { name: 'Rules' }))
      view.unmount()
      expect(heading.getAttribute('tabindex')).toBe(String(tabIndex))
      expect(heading.classList.contains('research-evidence-navigation-focus')).toBe(false)
    },
  )

  it('disables missing targets and does not use a matching target outside the workspace', async () => {
    workspace({ outside: true })
    const button = screen.getByRole('button', { name: 'Path' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.hasAttribute('aria-controls')).toBe(false)
    expect(screen.getByText('This section is not currently shown')).toBeTruthy()
    fireEvent.click(button)
    expect(scroll).not.toHaveBeenCalled()
    expect(
      screen.getByRole('heading', { name: 'Other account path' }).hasAttribute('tabindex'),
    ).toBe(false)
  })

  it('discovers a newly mounted target without auto scrolling or disturbing the current draft focus', async () => {
    const { ref } = workspace()
    const input = screen.getByRole('textbox')
    input.focus()
    const target = document.createElement('section')
    target.id = 'synthetic-path'
    target.innerHTML = '<h2>Late path evidence</h2>'
    act(() => ref.current!.appendChild(target))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Path' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect(document.activeElement).toBe(input)
    expect(scroll).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Path' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Late path evidence' }))
  })

  it('refuses a detached target before the child observer has delivered its update', async () => {
    const { ref } = workspace({ second: true })
    const button = screen.getByRole('button', { name: 'Path' })
    const target = ref.current!.querySelector('#synthetic-path')!
    act(() => {
      target.remove()
      fireEvent.click(button)
    })
    expect(scroll).not.toHaveBeenCalled()
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
    expect(button.hasAttribute('aria-controls')).toBe(false)
  })

  it('does not navigate when a formerly unique ID becomes ambiguous', async () => {
    const { ref } = workspace()
    const duplicate = document.createElement('section')
    duplicate.id = 'synthetic-rules'
    const button = screen.getByRole('button', { name: 'Rules' })
    act(() => {
      ref.current!.appendChild(duplicate)
      fireEvent.click(button)
    })
    expect(scroll).not.toHaveBeenCalled()
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText('Duplicate section identity in this workspace')).toBeTruthy()
  })

  it('clears old target ownership and tabindex on scope change, and cannot use a retained old button', async () => {
    const ref = createRef<HTMLElement>()
    const target = document.createElement('section')
    target.id = 'synthetic-rules'
    target.innerHTML = '<h2>Old scope heading</h2>'
    const root = document.createElement('section')
    root.appendChild(target)
    document.body.appendChild(root)
    ref.current = root
    const view = render(
      <ResearchEvidenceNavigation
        workspaceRef={ref}
        scopeKey="account-one"
        tools={[tools[0]]}
        t={t}
      />,
    )
    const oldButton = screen.getByRole('button', { name: 'Rules' })
    await userEvent.click(oldButton)
    const heading = target.querySelector('h2')!
    expect(heading.getAttribute('tabindex')).toBe('-1')
    const newRoot = document.createElement('section')
    document.body.appendChild(newRoot)
    ref.current = newRoot
    view.rerender(
      <ResearchEvidenceNavigation
        workspaceRef={ref}
        scopeKey="account-two"
        tools={[tools[0]]}
        t={t}
      />,
    )
    expect((screen.getByRole('button', { name: 'Rules' }) as HTMLButtonElement).disabled).toBe(true)
    expect(heading.hasAttribute('tabindex')).toBe(false)
    expect(target.classList.contains('research-evidence-navigation-target')).toBe(false)
    fireEvent.click(oldButton)
    expect(scroll).toHaveBeenCalledTimes(1)
    view.unmount()
    root.remove()
    newRoot.remove()
  })

  it('focuses the scoped container when it has no heading and preserves an existing target class', async () => {
    const ref = createRef<HTMLElement>()
    const view = render(
      <section ref={ref}>
        <ResearchEvidenceNavigation
          workspaceRef={ref}
          scopeKey="fallback"
          tools={[tools[0]]}
          t={t}
        />
        <section id="synthetic-rules" className="research-evidence-navigation-target">
          Synthetic evidence
        </section>
      </section>,
    )
    const target = screen.getByText('Synthetic evidence')
    await userEvent.click(screen.getByRole('button', { name: 'Rules' }))
    expect(document.activeElement).toBe(target)
    view.unmount()
    expect(target.hasAttribute('tabindex')).toBe(false)
    expect(target.classList.contains('research-evidence-navigation-target')).toBe(true)
  })

  it('omits an empty navigation and safely disables unavailable scope without a global lookup', () => {
    const ref = createRef<HTMLElement>()
    const view = render(
      <ResearchEvidenceNavigation workspaceRef={ref} scopeKey="empty" tools={[]} t={t} />,
    )
    expect(screen.queryByRole('navigation')).toBeNull()
    view.rerender(
      <ResearchEvidenceNavigation workspaceRef={ref} scopeKey="missing" tools={[tools[0]]} t={t} />,
    )
    expect((screen.getByRole('button', { name: 'Rules' }) as HTMLButtonElement).disabled).toBe(true)
    expect(scroll).not.toHaveBeenCalled()
  })
})
