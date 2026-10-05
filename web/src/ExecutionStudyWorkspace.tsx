import { useId, useRef } from 'react'
import type { PaperProposal } from './paper-model'
import { ExecutionVolumeStudy } from './ExecutionVolumeStudy'
import { ExecutionLimitStudy } from './ExecutionLimitStudy'
import { ExecutionGTDStudy } from './ExecutionGTDStudy'
import { ResearchEvidenceSection } from './ResearchEvidenceSection'
import { ResearchEvidenceNavigation } from './ResearchEvidenceNavigation'
import './ExecutionStudyWorkspace.css'

type Props = {
  accountId: string
  proposal: PaperProposal
  currentAccountVersion: number
  currentInputRevision: string
  currentAsOf: string
  enabled?: boolean
  t: (zh: string, en: string) => string
}

export function ExecutionStudyWorkspace(props: Props) {
  return <Workspace key={JSON.stringify([props.accountId, props.proposal.id])} {...props} />
}

function Workspace(props: Props) {
  const { accountId, proposal, t } = props
  const id = useId()
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const tools = [
    {
      targetId: `${id}-volume`,
      label: t('日成交量容量', 'Daily volume capacity'),
      purpose: t('固定股數與單日容量情境', 'Frozen quantities and one-session capacity'),
    },
    {
      targetId: `${id}-day`,
      label: t('DAY 開盤限價', 'DAY opening limit'),
      purpose: t('選用限價與單日情境到期', 'Optional limits and one-session scenario expiry'),
    },
    {
      targetId: `${id}-gtd`,
      label: t('GTD 多日開盤', 'GTD multi-session opening'),
      purpose: t(
        '固定限價、逐日餘量與指定日期到期',
        'Fixed limits, daily remainder and chosen expiry',
      ),
    },
  ]
  return (
    <div className="execution-study-workspace">
      <ResearchEvidenceSection
        id={`${id}-workspace`}
        title={t('執行情境研究（唯讀）', 'Execution scenario research (read only)')}
        defaultOpen={false}
      >
        <p className="execution-study-workspace-description">
          {t(
            '選用日成交量容量、DAY 開盤限價或 GTD 多日開盤情境，檢閱保存提案的固定股數。這些事後研究不送單，也不改變提案的接受資格。',
            'Optionally inspect frozen proposal quantities with daily-volume capacity, DAY opening limits or GTD multi-session opening scenarios. These ex-post studies do not send orders or change proposal acceptance eligibility.',
          )}
        </p>
        <div ref={workspaceRef} className="execution-study-workspace-tools">
          <ResearchEvidenceNavigation
            workspaceRef={workspaceRef}
            scopeKey={JSON.stringify([accountId, proposal.id])}
            tools={tools}
            collapsible
            t={t}
          />
          <ResearchEvidenceSection id={tools[0].targetId} title={tools[0].label}>
            <ExecutionVolumeStudy {...props} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection id={tools[1].targetId} title={tools[1].label}>
            <ExecutionLimitStudy {...props} />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection id={tools[2].targetId} title={tools[2].label}>
            <ExecutionGTDStudy {...props} />
          </ResearchEvidenceSection>
        </div>
      </ResearchEvidenceSection>
    </div>
  )
}
