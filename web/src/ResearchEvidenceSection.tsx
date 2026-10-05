import { useRef, type ReactNode } from 'react'
import './research-evidence-section.css'

export type ResearchEvidenceSectionProps = {
  id: string
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}

export const researchEvidenceSectionSelector = 'details[data-research-evidence-section]'

/** Native disclosure only: folding never unmounts or recreates the evidence body. */
export function ResearchEvidenceSection({
  id,
  title,
  children,
  defaultOpen = true,
}: ResearchEvidenceSectionProps) {
  // Keep the first-render prop constant. Native summary interaction and scoped navigation
  // own the DOM open state; unrelated parent renders must not reset the user's choice.
  const initialOpen = useRef(defaultOpen)
  return (
    <details
      id={id}
      className="research-evidence-section"
      data-research-evidence-section=""
      open={initialOpen.current}
    >
      <summary>
        <h3>{title}</h3>
      </summary>
      <div className="research-evidence-section-body">{children}</div>
    </details>
  )
}
