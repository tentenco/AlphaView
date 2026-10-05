import { useEffect, useRef, useState } from 'react'
import './ResearchEvidenceCapacity.css'

type Translate = (zh: string, en: string) => string
type Scope = {
  scope: 'account' | 'workspace'
  count: number | null
  limit: number | null
  remaining: number | null
  over_limit: boolean | null
  reason: string | null
}
const families = [
  'allocation_research_receipts',
  'research_integrity_receipts',
  'workflow_path_receipts',
  'execution_study_receipts',
] as const
type Family = (typeof families)[number]
type Capacity = {
  engine_version: string
  account_id: string
  account_version: number
  as_of: string
  input_revision: string
  families: { family: Family; account: Scope; workspace: Scope }[]
  integrity: { assessed: false; available: null; reason: 'not_assessed' }
  policy: {
    read_only: true
    save_authorized: false
    delete_authorized: false
    export_frees_capacity: false
  }
}
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function validScope(value: unknown, scope: Scope['scope'], inapplicable = false): value is Scope {
  if (!record(value) || value.scope !== scope) return false
  if (inapplicable)
    return (
      value.count === null &&
      value.limit === null &&
      value.remaining === null &&
      value.over_limit === null &&
      value.reason === 'workspace_scoped_family'
    )
  if (!nonnegative(value.count)) return false
  if (value.limit === null)
    return (
      value.remaining === null && value.over_limit === null && value.reason === 'limit_unavailable'
    )
  return (
    nonnegative(value.limit) &&
    value.remaining === Math.max(0, value.limit - value.count) &&
    value.over_limit === value.count > value.limit &&
    value.reason === null
  )
}
function accepted(value: unknown, accountId: string, accountVersion: number): value is Capacity {
  if (
    !record(value) ||
    value.engine_version !== 'alphaview-research-evidence-capacity-v1' ||
    value.account_id !== accountId ||
    value.account_version !== accountVersion ||
    typeof value.as_of !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.as_of) ||
    typeof value.input_revision !== 'string' ||
    !value.input_revision ||
    !record(value.policy) ||
    value.policy.read_only !== true ||
    value.policy.save_authorized !== false ||
    value.policy.delete_authorized !== false ||
    value.policy.export_frees_capacity !== false ||
    !record(value.integrity) ||
    value.integrity.assessed !== false ||
    value.integrity.available !== null ||
    value.integrity.reason !== 'not_assessed' ||
    !Array.isArray(value.families) ||
    value.families.length !== families.length
  )
    return false
  return value.families.every(
    (item, index) =>
      record(item) &&
      item.family === families[index] &&
      validScope(item.account, 'account', item.family === 'research_integrity_receipts') &&
      validScope(item.workspace, 'workspace'),
  )
}
function familyName(family: Family, t: Translate) {
  switch (family) {
    case 'allocation_research_receipts':
      return t('配置研究回條', 'Allocation research receipts')
    case 'research_integrity_receipts':
      return t('研究完整性診斷回條', 'Research integrity diagnostic receipts')
    case 'workflow_path_receipts':
      return t('工作流程路徑回條', 'Workflow path receipts')
    case 'execution_study_receipts':
      return t('執行研究回條', 'Execution study receipts')
  }
}

export function ResearchEvidenceCapacity({
  accountId,
  accountVersion,
  enabled = true,
  t,
}: {
  accountId: string
  accountVersion: number
  enabled?: boolean
  t: Translate
}) {
  const key = JSON.stringify([accountId, accountVersion, enabled])
  const latest = useRef(key)
  latest.current = key
  const operation = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    key: string
    busy?: boolean
    error?: string
    value?: Capacity
  }>({ key })
  const current = state.key === key ? state : null
  const validAccount =
    /^[a-f0-9]{32}$/.test(accountId) && nonnegative(accountVersion) && accountVersion > 0
  useEffect(() => {
    setState({ key })
    const hide = () => {
      operation.current?.abort()
      operation.current = null
      setState({ key })
    }
    window.addEventListener('pagehide', hide)
    return () => {
      operation.current?.abort()
      operation.current = null
      window.removeEventListener('pagehide', hide)
    }
  }, [key])

  async function refresh() {
    if (!enabled || !validAccount || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setState({ key, busy: true })
    try {
      const response = await fetch(
        `/api/paper/accounts/${encodeURIComponent(accountId)}/research-evidence-capacity`,
        {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        },
      )
      if (controller.signal.aborted || latest.current !== key) return
      if (!response.ok)
        throw new Error(
          t('無法讀取回條容量', 'Could not read receipt capacity') + ` (${response.status})`,
        )
      const value: unknown = await response.json()
      if (controller.signal.aborted || latest.current !== key) return
      if (!accepted(value, accountId, accountVersion))
        throw new Error(
          t(
            '容量回應的帳戶、版本或範圍不符，請重新讀取。',
            'Capacity response account, version or scope mismatch. Read again.',
          ),
        )
      setState({ key, value })
    } catch (error) {
      if (!controller.signal.aborted && latest.current === key)
        setState({ key, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  return (
    <section
      className="research-evidence-capacity"
      aria-label={t('研究回條容量', 'Research receipt capacity')}
    >
      <h4>{t('研究回條容量', 'Research receipt capacity')}</h4>
      <p className="research-note">
        {t(
          '依儲存筆數計算；損壞或無法驗證的回條也佔容量。完整性未評估，匯出不會騰出容量。',
          'Counts stored rows, including corrupt or unverifiable receipts. Integrity is not assessed; exporting does not free capacity.',
        )}
      </p>
      <button
        type="button"
        disabled={!enabled || !validAccount || !!current?.busy}
        onClick={() => void refresh()}
      >
        {t('讀取回條容量', 'Read receipt capacity')}
      </button>
      {current?.busy && <p role="status">{t('正在讀取回條容量…', 'Reading receipt capacity…')}</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.value && (
        <div aria-label={t('回條容量讀取結果', 'Receipt capacity result')}>
          <p className="research-evidence-capacity-context">
            {t('讀取時帳戶版本', 'Account version when read')}: {current.value.account_version} ·{' '}
            {t('最新完成交易日', 'Latest completed session')}: {current.value.as_of}
            <br />
            {t('輸入版本', 'Input revision')}: <code>{current.value.input_revision}</code>
          </p>
          <p className="research-note">
            {t(
              '此摘要是明確讀取時的快照；保存回條後可再次讀取。',
              'This summary is a snapshot from the explicit read; read again after saving receipts.',
            )}
          </p>
          {current.value.families.map((family) => (
            <article
              key={family.family}
              className="research-evidence-capacity-family"
              aria-label={familyName(family.family, t)}
            >
              <h5>{familyName(family.family, t)}</h5>
              <div className="research-evidence-capacity-scopes">
                {[family.account, family.workspace].map((scope) => (
                  <section
                    key={scope.scope}
                    aria-label={
                      scope.scope === 'account'
                        ? t('此帳戶', 'This account')
                        : t('全工作區', 'Whole workspace')
                    }
                  >
                    <h6>
                      {scope.scope === 'account'
                        ? t('此帳戶', 'This account')
                        : t('全工作區', 'Whole workspace')}
                    </h6>
                    <dl>
                      <div>
                        <dt>{t('已存筆數', 'Stored count')}</dt>
                        <dd>{scope.count ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('筆數上限', 'Count limit')}</dt>
                        <dd>{scope.limit ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('剩餘筆數', 'Remaining count')}</dt>
                        <dd>{scope.remaining ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('超過筆數上限', 'Above count limit')}</dt>
                        <dd>
                          {scope.over_limit === null
                            ? '—'
                            : scope.over_limit
                              ? t('是', 'Yes')
                              : t('否', 'No')}
                        </dd>
                      </div>
                    </dl>
                    {scope.reason && (
                      <p className="research-note">
                        {scope.reason === 'workspace_scoped_family'
                          ? t(
                              '此類回條屬於工作區；沒有帳戶歸屬或帳戶上限。',
                              'This receipt family belongs to the workspace; it has no account association or account limit.',
                            )
                          : t(
                              '此範圍的筆數上限不可用，剩餘容量未知。',
                              'The count limit for this scope is unavailable; remaining capacity is unknown.',
                            )}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="research-note">
        {t(
          '剩餘名額不是保存許可；新保存仍由原本端點核對來源、版本、大小與容量。這裡不檢查內容完整性，也不刪除、匯入或清理回條。',
          'Remaining slots do not grant permission to save; existing endpoints still check sources, versions, size and capacity. This view does not assess content integrity, delete, import or clean up receipts.',
        )}
      </p>
    </section>
  )
}
