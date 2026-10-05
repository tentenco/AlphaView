import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { researchEvidenceSectionSelector } from './ResearchEvidenceSection'
import './research-evidence-navigation.css'

export type ResearchEvidenceTool = { targetId: string; label: string; purpose?: string }
type Props = {
  workspaceRef: RefObject<HTMLElement | null>
  scopeKey: string
  tools: ResearchEvidenceTool[]
  collapsible?: boolean
  t: (zh: string, en: string) => string
}
type Target = { element: HTMLElement | null; reason: 'missing' | 'ambiguous' | null }
const targetClass = 'research-evidence-navigation-target'
const focusClass = 'research-evidence-navigation-focus'

export function ResearchEvidenceNavigation(props: Props) {
  return <Navigation key={props.scopeKey} {...props} />
}
function Navigation({ workspaceRef, tools, t, collapsible = false }: Props) {
  const id = useId()
  const [targets, setTargets] = useState<Target[]>([])
  const live = useRef(false)
  const boundScope = useRef<HTMLElement | null>(null)
  const focusCleanup = useRef<(() => void) | null>(null)
  const targetIds = JSON.stringify(tools.map((tool) => tool.targetId))
  useEffect(() => {
    const scope = workspaceRef.current
    live.current = true
    boundScope.current = scope
    const owned = new Set<HTMLElement>()
    const ids = JSON.parse(targetIds) as string[]
    const discover = () => {
      if (!live.current || workspaceRef.current !== scope) return
      const elements = scope?.isConnected
        ? Array.from(scope.querySelectorAll<HTMLElement>('[id]'))
        : []
      const next: Target[] = ids.map((targetId) => {
        const matches = elements.filter((element) => element.id === targetId)
        return {
          element: matches.length === 1 ? matches[0] : null,
          reason: matches.length > 1 ? 'ambiguous' : matches.length === 0 ? 'missing' : null,
        }
      })
      const current = new Set(next.flatMap((target) => (target.element ? [target.element] : [])))
      for (const element of owned) {
        if (!current.has(element)) {
          element.classList.remove(targetClass)
          owned.delete(element)
        }
      }
      for (const element of current) {
        if (!element.classList.contains(targetClass)) {
          element.classList.add(targetClass)
          owned.add(element)
        }
      }
      setTargets((previous) =>
        previous.length === next.length &&
        previous.every(
          (target, index) =>
            target.element === next[index].element && target.reason === next[index].reason,
        )
          ? previous
          : next,
      )
    }
    discover()
    const observer = scope ? new MutationObserver(discover) : null
    if (scope) observer?.observe(scope, { childList: true, subtree: true })
    return () => {
      live.current = false
      boundScope.current = null
      observer?.disconnect()
      focusCleanup.current?.()
      focusCleanup.current = null
      for (const element of owned) element.classList.remove(targetClass)
    }
  }, [workspaceRef, targetIds])

  function scopedTarget(index: number) {
    const scope = boundScope.current
    const target = targets[index]?.element
    const tool = tools[index]
    if (
      !live.current ||
      !scope ||
      workspaceRef.current !== scope ||
      !scope.isConnected ||
      !target?.isConnected ||
      !scope.contains(target) ||
      !tool ||
      target.id !== tool.targetId
    )
      return null
    // Recheck the scoped identity at click time, before an observer callback can run.
    const matches = Array.from(scope.querySelectorAll<HTMLElement>('[id]')).filter(
      (element) => element.id === tool.targetId,
    )
    return matches.length === 1 && matches[0] === target ? target : null
  }

  function setAllOpen(open: boolean) {
    if (!collapsible) return
    tools.forEach((_, index) => {
      const target = scopedTarget(index)
      if (target?.matches(researchEvidenceSectionSelector))
        (target as HTMLDetailsElement).open = open
    })
  }

  function jump(index: number) {
    const scope = boundScope.current
    const target = scopedTarget(index)
    if (!scope || !target) return
    // Open only the managed chain containing this target, never adjacent evidence.
    // DOM properties update synchronously, before scroll and heading focus are measured.
    for (
      let element: HTMLElement | null = target;
      element && element !== scope;
      element = element.parentElement
    ) {
      if (element.matches(researchEvidenceSectionSelector))
        (element as HTMLDetailsElement).open = true
    }
    focusCleanup.current?.()
    const heading =
      target.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]') ?? target
    const addedTabIndex = !heading.hasAttribute('tabindex')
    const addedFocusClass = !heading.classList.contains(focusClass)
    if (addedTabIndex) heading.setAttribute('tabindex', '-1')
    if (addedFocusClass) heading.classList.add(focusClass)
    const restore = () => {
      if (addedTabIndex && heading.getAttribute('tabindex') === '-1')
        heading.removeAttribute('tabindex')
      if (addedFocusClass) heading.classList.remove(focusClass)
      heading.removeEventListener('blur', restore)
      if (focusCleanup.current === restore) focusCleanup.current = null
    }
    focusCleanup.current = restore
    heading.addEventListener('blur', restore)
    const media = scope.ownerDocument.defaultView?.matchMedia
    const reduced =
      !media ||
      media.call(scope.ownerDocument.defaultView, '(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({
      behavior: reduced ? 'instant' : 'smooth',
      block: 'start',
      inline: 'nearest',
    })
    heading.focus({ preventScroll: true })
  }
  if (!tools.length) return null
  const managedIds = tools.flatMap((tool, index) => {
    const target = targets[index]?.element
    return target?.id === tool.targetId && target.matches(researchEvidenceSectionSelector)
      ? [tool.targetId]
      : []
  })
  return (
    <nav className="research-evidence-navigation" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="research-evidence-navigation-label">
        {t('研究區塊捷徑', 'Research section shortcuts')}
      </p>
      {collapsible && (
        <div
          className="research-evidence-navigation-disclosures"
          role="group"
          aria-label={t('研究區塊展開與收合', 'Expand and collapse research sections')}
        >
          <button
            type="button"
            disabled={!managedIds.length}
            aria-controls={managedIds.length ? managedIds.join(' ') : undefined}
            onClick={() => setAllOpen(true)}
          >
            {t('全部展開', 'Expand all')}
          </button>
          <button
            type="button"
            disabled={!managedIds.length}
            aria-controls={managedIds.length ? managedIds.join(' ') : undefined}
            onClick={() => setAllOpen(false)}
          >
            {t('全部收合', 'Collapse all')}
          </button>
        </div>
      )}
      <ul>
        {tools.map((tool, index) => {
          const target = targets[index]
          const reason = target?.reason ?? 'missing'
          const available = !!target?.element
          const descriptionId = `${id}-${index}-purpose`
          const reasonId = `${id}-${index}-reason`
          return (
            <li key={`${tool.targetId}:${index}`}>
              <button
                type="button"
                disabled={!available}
                aria-label={tool.label}
                aria-controls={available ? tool.targetId : undefined}
                aria-describedby={
                  [tool.purpose ? descriptionId : '', !available ? reasonId : '']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onClick={() => jump(index)}
              >
                <span>{tool.label}</span>
                {tool.purpose && <small id={descriptionId}>{tool.purpose}</small>}
              </button>
              {!available && (
                <small id={reasonId} className="research-evidence-navigation-reason">
                  {reason === 'ambiguous'
                    ? t('此工作區的區塊識別重複', 'Duplicate section identity in this workspace')
                    : t('此區塊目前未顯示', 'This section is not currently shown')}
                </small>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
