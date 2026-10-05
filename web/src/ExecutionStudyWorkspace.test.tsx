import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionStudyWorkspace } from './ExecutionStudyWorkspace'
import * as volume from './ExecutionVolumeStudy'
import * as day from './ExecutionLimitStudy'
import * as gtd from './ExecutionGTDStudy'
import type { PaperProposal } from './paper-model'

const t = (_zh: string, en: string) => en
const proposal = {
  id: 'b'.repeat(32),
  account_id: 'a'.repeat(32),
  account_version: 1,
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2024-01-05',
  input_revision: 'synthetic:1',
  status: 'proposed',
  created_at: '2024-01-06T12:00:00Z',
  accepted_at: null,
  executable: true,
  orders: [
    { symbol: 'SYNTA', side: 'buy', shares: 30, reference_price: 100 },
    { symbol: 'SYNTB', side: 'sell', shares: 20, reference_price: 50 },
  ],
} as PaperProposal
const props = {
  accountId: proposal.account_id,
  proposal,
  currentAccountVersion: 1,
  currentInputRevision: 'synthetic:2',
  currentAsOf: '2024-01-08',
  enabled: true,
  t,
}
const selector = 'details[data-research-evidence-section]'
const originalScroll = HTMLElement.prototype.scrollIntoView

function parts(container: HTMLElement) {
  const [outer, volumeSection, daySection, gtdSection] =
    container.querySelectorAll<HTMLDetailsElement>(selector)
  return {
    outer,
    sections: [volumeSection, daySection, gtdSection],
    drafts: [
      container.querySelector<HTMLInputElement>('.execution-volume-study input')!,
      container.querySelector<HTMLInputElement>('.execution-limit-inputs input')!,
      container.querySelector<HTMLInputElement>('.execution-gtd-study input')!,
    ],
  }
}
function toggle(section: HTMLDetailsElement) {
  fireEvent.click(section.querySelector('summary')!)
}

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScroll
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('optional execution scenario research workspace', () => {
  it('starts closed with all actual studies mounted and forwards the complete source authority unchanged', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const spies = [
      vi.spyOn(volume, 'ExecutionVolumeStudy'),
      vi.spyOn(day, 'ExecutionLimitStudy'),
      vi.spyOn(gtd, 'ExecutionGTDStudy'),
    ]
    const view = render(<ExecutionStudyWorkspace {...props} />)
    const { outer, sections, drafts } = parts(view.container)
    expect(outer.open).toBe(false)
    expect(sections.map((section) => section.open)).toEqual([true, true, true])
    expect(drafts.every((input) => input?.isConnected)).toBe(true)
    for (const spy of spies) expect(spy.mock.calls.at(-1)?.[0]).toEqual(props)
    const refreshed = {
      ...props,
      currentAccountVersion: 2,
      currentInputRevision: 'synthetic:3',
      currentAsOf: '2024-01-09',
      enabled: false,
    }
    view.rerender(<ExecutionStudyWorkspace {...refreshed} />)
    for (const spy of spies) expect(spy.mock.calls.at(-1)?.[0]).toEqual(refreshed)
    expect(parts(view.container).outer).toBe(outer)
    expect(outer.open).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves actual draft nodes and inner choices through repeated outer folding without network or persistence', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const hash = window.location.hash
    const view = render(<ExecutionStudyWorkspace {...props} />)
    const { outer, sections, drafts } = parts(view.container)
    toggle(outer)
    drafts.forEach((input, index) =>
      fireEvent.change(input, { target: { value: String(index + 2) } }),
    )
    toggle(sections[1])
    for (let cycle = 0; cycle < 2; cycle += 1) {
      toggle(outer)
      expect(outer.open).toBe(false)
      expect(drafts.every((input) => input.isConnected)).toBe(true)
      toggle(outer)
      expect(outer.open).toBe(true)
      expect(parts(view.container).drafts).toEqual(drafts)
      expect(drafts.map((input) => input.value)).toEqual(['2', '3', '4'])
      expect(sections.map((section) => section.open)).toEqual([true, false, true])
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(hash)
  })

  it('preserves choices and drafts on source refresh but resets them for a different proposal or account', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionStudyWorkspace {...props} />)
    const { outer, sections, drafts } = parts(view.container)
    toggle(outer)
    toggle(sections[2])
    drafts.forEach((input) => fireEvent.change(input, { target: { value: '7' } }))
    view.rerender(
      <ExecutionStudyWorkspace
        {...props}
        proposal={{ ...proposal, status: 'simulated' }}
        currentAccountVersion={2}
        currentInputRevision="synthetic:3"
        currentAsOf="2024-01-09"
        enabled={false}
      />,
    )
    expect(parts(view.container).outer).toBe(outer)
    expect(parts(view.container).drafts).toEqual(drafts)
    expect(outer.open).toBe(true)
    expect(sections.map((section) => section.open)).toEqual([true, true, false])
    expect(drafts.map((input) => input.value)).toEqual(['7', '7', '7'])

    const nextProposal = { ...proposal, id: 'c'.repeat(32) }
    view.rerender(<ExecutionStudyWorkspace {...props} proposal={nextProposal} />)
    const next = parts(view.container)
    expect(outer.isConnected).toBe(false)
    expect(next.outer.open).toBe(false)
    expect(next.sections.every((section) => section.open)).toBe(true)
    expect(next.drafts.map((input) => input.value)).toEqual(['1', '', '1'])
    toggle(next.outer)
    view.rerender(
      <ExecutionStudyWorkspace {...props} proposal={nextProposal} accountId={'d'.repeat(32)} />,
    )
    expect(next.outer.isConnected).toBe(false)
    expect(parts(view.container).outer.open).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('scopes inner controls to its three tools and supports keyboard navigation without opening another workspace', async () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const view = render(
      <>
        <ExecutionStudyWorkspace {...props} />
        <ExecutionStudyWorkspace {...props} proposal={{ ...proposal, id: 'c'.repeat(32) }} />
      </>,
    )
    const roots = view.container.querySelectorAll<HTMLElement>('.execution-study-workspace')
    const first = parts(roots[0])
    const second = parts(roots[1])
    toggle(first.outer)
    const navigation = within(roots[0]).getByRole('navigation')
    const collapse = within(navigation).getByRole('button', { name: 'Collapse all' })
    expect(collapse.getAttribute('aria-controls')?.split(' ')).toEqual(
      first.sections.map((section) => section.id),
    )
    await userEvent.click(collapse)
    expect(first.outer.open).toBe(true)
    expect(first.sections.every((section) => !section.open)).toBe(true)
    expect(second.outer.open).toBe(false)
    expect(second.sections.every((section) => section.open)).toBe(true)

    within(navigation).getByRole('button', { name: 'DAY opening limit' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(first.sections.map((section) => section.open)).toEqual([false, true, false])
    expect(document.activeElement).toBe(first.sections[1].querySelector('h3'))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'start', inline: 'nearest' })
    await userEvent.click(within(navigation).getByRole('button', { name: 'Expand all' }))
    expect(first.sections.every((section) => section.open)).toBe(true)
    expect(second.outer.open).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps a manually started study alive through folding and still aborts when its source authority changes', async () => {
    const fetcher = vi.fn((_url: string, _options?: RequestInit) => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ExecutionStudyWorkspace {...props} />)
    const { outer, drafts } = parts(view.container)
    toggle(outer)
    await userEvent.click(screen.getByRole('button', { name: 'Study saved proposal capacity' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const signal = fetcher.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)
    toggle(outer)
    expect(signal?.aborted).toBe(false)
    toggle(outer)
    expect(signal?.aborted).toBe(false)
    expect(parts(view.container).drafts[0]).toBe(drafts[0])
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    view.rerender(<ExecutionStudyWorkspace {...props} currentInputRevision="synthetic:3" />)
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Study saved proposal capacity' })).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(outer.open).toBe(true)
  })
})
