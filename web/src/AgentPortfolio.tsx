import { lazy, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Add, ArrowRight, Checkmark, Pause, Play, Renew } from '@carbon/icons-react'
import type { Locale } from './locale'
import { api, dateTime, money, num } from './ui'
import { boundedDraftString, useSessionState } from './session-state'
import {
  newPaperKey,
  DEFAULT_PAPER_EXECUTION,
  parsePaperTargets,
  validPaperPolicyDraft,
  type PaperAccount,
  type PaperExecutionPolicy,
  type PaperLimits,
  type PaperPreview,
  type PaperProposal,
  type PaperSnapshot,
} from './paper-model'
import './agent-portfolio.css'
import { downloadPaperFile } from './paper-download'
import { PortfolioAutomation } from './PortfolioAutomation'
import { PortfolioPaperPerformance } from './PortfolioPaperPerformance'
import { PortfolioScenarios } from './PortfolioScenarios'
import { PortfolioInbox, type PortfolioInboxAction } from './PortfolioInbox'
import { PortfolioAccountComparison } from './PortfolioAccountComparison'
import { PortfolioLocalAgent } from './PortfolioLocalAgent'
import { PortfolioJevGate } from './PortfolioJevGate'
import { PortfolioFork } from './PortfolioFork'
import { PortfolioNextOpen } from './PortfolioNextOpen'
import { AlpacaPaper } from './AlpacaPaper'
import { PortfolioSymbolPolicy } from './PortfolioSymbolPolicy'
import { PortfolioCircuitBreakers } from './PortfolioCircuitBreakers'
import { PortfolioPositionStops } from './PortfolioPositionStops'
import { PortfolioRegimeOverlay } from './PortfolioRegimeOverlay'
import { PortfolioCorporateActions } from './PortfolioCorporateActions'
import { CorporateActionLedgerPreview } from './CorporateActionLedgerPreview'
import { CorporateActionHistory } from './CorporateActionHistory'
import { ResearchEvidenceNavigation } from './ResearchEvidenceNavigation'
import { ResearchEvidenceSection } from './ResearchEvidenceSection'
import { ResearchEvidenceCapacity } from './ResearchEvidenceCapacity'
import { ExecutionStudyWorkspace } from './ExecutionStudyWorkspace'
import { ExecutionStudyReceiptArchive } from './ExecutionStudyReceiptArchive'
import { PortfolioCostSensitivity } from './PortfolioCostSensitivity'
import { DeferredContent } from './DeferredContent'
// Workflow utilities also style the risk and proposal review panels.
import './portfolio-agent-workflow.css'
import {
  parsePortfolioHash,
  portfolioHash,
  resolvePortfolioRoute,
  validPortfolioAccountId,
  type PortfolioRoute,
  type PortfolioRouteRequest,
  type PortfolioView,
  type WorkspaceTab,
} from './portfolio-navigation'

const PortfolioAgentWorkflow = lazy(() =>
  import('./PortfolioAgentWorkflow').then((module) => ({ default: module.PortfolioAgentWorkflow })),
)
const PortfolioTradingAgent = lazy(() =>
  import('./PortfolioTradingAgent').then((module) => ({ default: module.PortfolioTradingAgent })),
)

type Translate = (zh: string, en: string) => string
const percent = (value: number | null | undefined) =>
  value == null ? '—' : `${num(Math.abs(value) < 0.05 ? 0 : value, 1)}%`

export function AgentPortfolio({ locale, revision }: { locale: Locale; revision: string }) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const route = useRef(
    parsePortfolioHash(
      location.hash,
      new URLSearchParams(location.search).get('connection') === 'alpaca',
    ) ?? parsePortfolioHash('#agent-portfolio')!,
  )
  const lastHash = useRef(location.hash)
  const [accounts, setAccounts] = useState<PaperAccount[]>([])
  const accountsRef = useRef<PaperAccount[]>([])
  const [accountsReady, setAccountsReady] = useState(false)
  const accountsReadyRef = useRef(false)
  const [selected, setSelected] = useSessionState(
    'paper-selected-account-v1',
    () => '',
    boundedDraftString,
  )
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useSessionState('paper-new-name-v1', () => '', boundedDraftString)
  const [cash, setCash] = useSessionState('paper-new-cash-v1', () => '', boundedDraftString)
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<PortfolioView>(route.current.view)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(route.current.tab)
  const [linkNotice, setLinkNotice] = useState<'invalid' | 'stale-account' | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [navigation, setNavigation] = useState<(PortfolioInboxAction & { nonce: number }) | null>(
    null,
  )
  const navigationNonce = useRef(0)
  const createKey = useRef(newPaperKey())
  const rememberAccount = useCallback((account: PaperAccount) => {
    setAccounts((current) => {
      const next = current.some((item) => item.id === account.id)
        ? current.map((item) => (item.id === account.id ? account : item))
        : [...current, account]
      accountsRef.current = next
      return next
    })
  }, [])
  const applyRoute = useCallback(
    (request: PortfolioRouteRequest, available: PaperAccount[], clearSelection = false) => {
      const resolved = resolvePortfolioRoute(
        request,
        available.map((account) => account.id),
        selectedRef.current,
      )
      selectedRef.current = resolved.accountId || ''
      setSelected(resolved.accountId || '')
      setView(resolved.view)
      setWorkspaceTab(resolved.tab)
      setLinkNotice(resolved.notice)
      if (clearSelection) setNavigation(null)
    },
    [setSelected],
  )
  useEffect(() => {
    const changed = () => {
      if (lastHash.current === location.hash) return
      lastHash.current = location.hash
      const request = parsePortfolioHash(
        location.hash,
        new URLSearchParams(location.search).get('connection') === 'alpaca',
      )
      if (!request) return
      route.current = request
      if (accountsReadyRef.current) applyRoute(request, accountsRef.current, true)
    }
    window.addEventListener('hashchange', changed)
    window.addEventListener('popstate', changed)
    return () => {
      window.removeEventListener('hashchange', changed)
      window.removeEventListener('popstate', changed)
    }
  }, [applyRoute])
  function navigateWorkspace(changes: Partial<PortfolioRoute>) {
    const next = {
      accountId: selectedRef.current || null,
      view,
      tab: workspaceTab,
      ...changes,
    }
    if (next.accountId && !validPortfolioAccountId(next.accountId)) {
      applyRoute({ ...next, accountId: null, invalid: ['account'] }, accountsRef.current, true)
      return
    }
    route.current = { ...next, invalid: [] }
    selectedRef.current = next.accountId || ''
    setSelected(next.accountId || '')
    setView(next.view)
    setWorkspaceTab(next.tab)
    setLinkNotice(null)
    const hash = portfolioHash(next)
    if (location.hash !== hash) history.pushState(null, '', hash)
    lastHash.current = hash
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    api<{ accounts: PaperAccount[] }>('/api/paper/accounts', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        setAccounts(data.accounts)
        accountsRef.current = data.accounts
        accountsReadyRef.current = true
        setAccountsReady(true)
        applyRoute(route.current, data.accounts)
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [refresh, applyRoute])
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (creating || !name.trim() || !cash || Number(cash) <= 0) return
    setCreating(true)
    setError('')
    try {
      const result = await api<PaperSnapshot>('/api/paper/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          initial_cash: Number(cash),
          idempotency_key: createKey.current,
        }),
      })
      navigateWorkspace({ accountId: result.account.id, view: 'account', tab: 'plan' })
      setNavigation(null)
      createKey.current = newPaperKey()
      setCreateOpen(false)
      setRefresh((value) => value + 1)
      setName('')
      setCash('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }
  return (
    <div className="agent-workspace" translate="no">
      <div className="page-title">
        <div>
          <div className="eyebrow">PORTFOLIO AGENT / LOCAL PAPER WORKSPACE</div>
          <h1>{t('Agent 投資組合', 'Portfolio Agent')}</h1>
          <p>
            {t(
              '把研究變成可檢查的配置提案，在獨立模擬帳戶中觀察每一步。',
              'Turn research into reviewable allocation proposals and track every step in a separate paper account.',
            )}
          </p>
        </div>
        <span className="agent-mode">
          {view === 'alpaca' ? 'Alpaca Paper' : t('本機模擬', 'Local paper mode')}
        </span>
      </div>
      {view !== 'alpaca' && (
        <div className="agent-flow" role="group" aria-label={t('工作流程', 'Workflow')}>
          {[
            t('研究', 'Research'),
            t('配置', 'Allocation'),
            t('風險限制', 'Risk limits'),
            t('確認提案', 'Review proposal'),
            t('模擬帳本', 'Paper ledger'),
          ].map((label, index) => (
            <span key={label}>
              <i>{index + 1}</i> {label} {index < 4 && <ArrowRight size={14} />}
            </span>
          ))}
        </div>
      )}
      <div
        className="agent-view-switch"
        role="group"
        aria-label={t('工作區檢視', 'Workspace view')}
      >
        <button
          className="button"
          aria-pressed={view === 'account'}
          onClick={() => navigateWorkspace({ view: 'account' })}
        >
          {t('單一帳戶工作區', 'Account workspace')}
        </button>
        <button
          className="button"
          aria-pressed={view === 'inbox'}
          onClick={() => navigateWorkspace({ view: 'inbox' })}
        >
          {t('所有帳戶待辦', 'All-account inbox')}
        </button>
        <button
          className="button"
          aria-pressed={view === 'comparison'}
          onClick={() => navigateWorkspace({ view: 'comparison' })}
        >
          {t('帳戶比較', 'Compare accounts')}
        </button>
        <button
          className="button"
          aria-pressed={view === 'alpaca'}
          onClick={() => navigateWorkspace({ view: 'alpaca' })}
        >
          Alpaca Paper
        </button>
      </div>
      {view !== 'alpaca' && (
        <div className="agent-account-bar">
          <label>
            {t('模擬帳戶', 'Paper account')}
            <select
              value={selected}
              onChange={(event) => {
                navigateWorkspace({ accountId: event.target.value, view: 'account', tab: 'plan' })
                setNavigation(null)
              }}
              disabled={!accounts.length || loading}
            >
              {!accounts.length && <option value="">{t('尚未建立', 'No account yet')}</option>}
              {selected && !accounts.some((account) => account.id === selected) && (
                <option value={selected}>
                  {t('指定帳戶', 'Selected account')} · {selected.slice(0, 8)}
                </option>
              )}
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={() => setCreateOpen(!createOpen)}>
            <Add size={16} /> {t('新增模擬帳戶', 'New paper account')}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('重新載入模擬帳戶', 'Refresh paper accounts')}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Renew size={18} />
          </button>
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {linkNotice && (
        <p className="notice" role="status">
          {linkNotice === 'stale-account'
            ? t(
                '連結指定的模擬帳戶已不存在或目前不可用，已改用可用帳戶；若沒有帳戶，請先建立。',
                'The linked paper account is missing or unavailable. An available account was selected; create one if none remain.',
              )
            : t(
                '連結的帳戶或頁面參數無效，已使用可用帳戶與有效頁面；保存的草稿未變更。',
                'The linked account or page parameters are invalid. Available account and page defaults were used; saved drafts were preserved.',
              )}
        </p>
      )}
      {view !== 'alpaca' && (createOpen || (!loading && !accounts.length && !error)) && (
        <form className="agent-panel agent-create" onSubmit={create}>
          <div>
            <h2>{t('建立你的第一個模擬帳戶', 'Create a paper account')}</h2>
            <p>
              {t(
                '指定一筆虛擬現金，從零開始。每個帳戶有獨立持倉與帳本，不會複製真實持股。',
                'Start with an explicit virtual cash balance. Each account has separate holdings and a ledger; real holdings are never copied.',
              )}
            </p>
          </div>
          <div className="agent-form-grid">
            <label>
              {t('帳戶名稱', 'Account name')}
              <input
                required
                value={name}
                maxLength={80}
                onChange={(event) => {
                  setName(event.target.value)
                  createKey.current = newPaperKey()
                }}
                placeholder={t('例如：趨勢策略實驗', 'e.g. Trend strategy experiment')}
              />
            </label>
            <label>
              {t('初始虛擬現金（USD）', 'Initial virtual cash (USD)')}
              <input
                required
                type="number"
                min="1"
                max="1000000000"
                step="0.01"
                value={cash}
                onChange={(event) => {
                  setCash(event.target.value)
                  createKey.current = newPaperKey()
                }}
                placeholder="10000"
              />
            </label>
          </div>
          <button className="button primary" disabled={creating}>
            {creating ? t('建立中…', 'Creating…') : t('建立模擬帳戶', 'Create paper account')}
          </button>
        </form>
      )}
      {view !== 'alpaca' && loading && !accountsReady && (
        <p role="status">{t('載入模擬工作區…', 'Loading paper workspace…')}</p>
      )}
      {view === 'inbox' && (
        <PortfolioInbox
          locale={locale}
          revision={`${revision}:${refresh}`}
          onOpen={(action) => {
            navigateWorkspace({ accountId: action.account_id, view: 'account', tab: action.tab })
            setNavigation({ ...action, nonce: ++navigationNonce.current })
          }}
        />
      )}
      {view === 'comparison' && <PortfolioAccountComparison accounts={accounts} locale={locale} />}
      {view === 'alpaca' && <AlpacaPaper locale={locale} />}
      {selected && accountsReady && view === 'account' && (
        <PaperAccountWorkspace
          key={selected}
          accountId={selected}
          locale={locale}
          revision={`${revision}:${refresh}`}
          tab={workspaceTab}
          onTabChange={(tab) => navigateWorkspace({ tab })}
          navigation={navigation?.account_id === selected ? navigation : null}
          onAccountLoaded={rememberAccount}
          onForked={(identifier) => {
            navigateWorkspace({ accountId: identifier, view: 'account', tab: 'plan' })
            setNavigation(null)
            setRefresh((value) => value + 1)
          }}
        />
      )}
      {view !== 'alpaca' && (
        <p className="research-note">
          {t(
            '這是日線參考價的本機模擬。尚未連接券商、即時報價或付費模型，也不會執行真實交易。模擬帳戶不包含稅務、公司行動、股息或真實成交品質。',
            'This is a local daily reference-price simulation. No broker, live quotes, paid models, or real orders are connected. Paper accounts do not model tax, corporate actions, dividends, or actual execution quality.',
          )}
        </p>
      )}
    </div>
  )
}

function PaperAccountWorkspace({
  accountId,
  locale,
  revision,
  tab,
  onTabChange,
  navigation,
  onForked,
  onAccountLoaded,
}: {
  accountId: string
  locale: Locale
  revision: string
  tab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  navigation: (PortfolioInboxAction & { nonce: number }) | null
  onForked: (identifier: string) => void
  onAccountLoaded: (account: PaperAccount) => void
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [snapshot, setSnapshot] = useState<PaperSnapshot | null>(null)
  useEffect(() => {
    if (snapshot) onAccountLoaded(snapshot.account)
  }, [snapshot, onAccountLoaded])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [riskVisited, setRiskVisited] = useState(tab === 'risk')
  const riskWorkspace = useRef<HTMLDivElement>(null)
  const riskPrefix = useId()
  const riskTarget = (name: string) => `${riskPrefix}-${name}`
  useEffect(() => {
    if (tab === 'risk') setRiskVisited(true)
  }, [tab])
  const tabButtons = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement>>>({})
  function selectTab(next: WorkspaceTab, focus = false) {
    if (next === 'risk') setRiskVisited(true)
    onTabChange(next)
    if (focus) tabButtons.current[next]?.focus()
  }
  const [selectedProposal, setSelectedProposal] = useState<PaperProposal | null>(null)
  const [proposalId, setProposalId] = useState('')
  const [proposalKey, setProposalKey] = useState('')
  const [proposalRefresh, setProposalRefresh] = useState(0)
  const [proposalError, setProposalError] = useState('')
  const currentProposalKey = JSON.stringify([
    accountId,
    proposalId,
    revision,
    refresh,
    proposalRefresh,
    navigation?.nonce,
  ])
  const proposalCurrent = proposalKey === currentProposalKey && selectedProposal?.id === proposalId
  const requestNumber = useRef(0)
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  function showProposal(proposal: PaperProposal) {
    setProposalId(proposal.id)
    setSelectedProposal(proposal)
    setProposalRefresh((value) => value + 1)
  }
  useEffect(() => {
    if (!navigation) return
    if (navigation.proposal_id) setProposalId(navigation.proposal_id)
  }, [navigation])
  useEffect(() => {
    if (!proposalId) return
    const controller = new AbortController()
    setProposalError('')
    api<PaperProposal>(
      `/api/paper/accounts/${encodeURIComponent(accountId)}/proposals/${encodeURIComponent(proposalId)}`,
      {
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted) return
        if (value.id !== proposalId || value.account_id !== accountId)
          throw new Error(
            t('提案識別不符，請重新開啟。', 'The proposal identity does not match. Open it again.'),
          )
        setSelectedProposal(value)
        setProposalKey(currentProposalKey)
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setSelectedProposal(null)
          setProposalError((err as Error).message)
        }
      })
    return () => controller.abort()
  }, [accountId, proposalId, currentProposalKey, navigation?.nonce])
  useEffect(() => {
    const controller = new AbortController()
    const request = ++requestNumber.current
    api<PaperSnapshot>(`/api/paper/accounts/${accountId}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || request !== requestNumber.current) return
        setSnapshot(data)
        setError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
    return () => controller.abort()
  }, [accountId, revision, refresh])
  async function controls(
    values: {
      kill_switch?: boolean
      limits?: PaperLimits
      execution_policy?: PaperExecutionPolicy
    },
    expectedVersion?: number,
  ) {
    if (!snapshot || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/paper/accounts/${accountId}/controls`, {
        method: 'PATCH',
        body: JSON.stringify({
          expected_version: expectedVersion ?? snapshot.account.version,
          ...values,
        }),
      })
      reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!snapshot)
    return <p role={error ? 'alert' : 'status'}>{error || t('載入帳戶…', 'Loading account…')}</p>
  const account = snapshot.account
  const panelId = `paper-${accountId}-workspace-panel`
  const tabs = [
    ['plan', t('配置與提案', 'Allocation & proposals')],
    ['risk', t('風險控管', 'Risk controls')],
    ['agent', t('Agent 工作流', 'Agent workflow')],
    ['local-model', t('本機模型分析', 'Local model analysis')],
    ['jev', t('Jev 決策閘', 'Jev decision gate')],
    ['trading-agent', t('交易代理', 'Trading agent')],
    ['scenarios', t('情境比較', 'Scenario comparison')],
    ['automation', t('自動化任務', 'Automation')],
    ['next-open', t('次日開盤模擬委託', 'Next-open paper orders')],
    ['performance', t('淨值與成本', 'NAV & costs')],
    ['ledger', t('持倉與帳本', 'Holdings & ledger')],
  ] as const
  return (
    <>
      <div className="agent-metrics">
        <div>
          <span>{t('模擬總資產', 'Paper equity')}</span>
          <strong>{money(snapshot.equity)}</strong>
          <small>
            {t('完整報價', 'Quote coverage')} {snapshot.coverage.priced}/
            {snapshot.coverage.required}
          </small>
        </div>
        <div>
          <span>{t('可用虛擬現金', 'Virtual cash')}</span>
          <strong>{money(account.cash)}</strong>
          <small>
            {percent(snapshot.cash_weight_pct)} {t('現金比例', 'in cash')}
          </small>
        </div>
        <div>
          <span>{t('模擬累計報酬', 'Paper total return')}</span>
          <strong>{percent(snapshot.total_return_pct)}</strong>
          <small>
            {t('初始資金', 'Initial cash')} {money(account.initial_cash)}
          </small>
        </div>
        <div>
          <span>{t('最新已完成交易日', 'Latest completed session')}</span>
          <strong>{snapshot.as_of || '—'}</strong>
          <small>
            {t('帳戶版本', 'Account version')} {account.version}
          </small>
        </div>
      </div>
      {!snapshot.valuation_complete && (
        <p className="notice">
          {t(
            '部分虛擬持倉缺少當期價格，總資產與配置比例暫不計算。',
            'Current prices are missing for some paper holdings. Equity and allocation remain unavailable.',
          )}
        </p>
      )}
      <div className={`agent-control-bar ${account.kill_switch ? 'is-paused' : ''}`}>
        <div>
          <strong>
            {account.kill_switch
              ? t('模擬執行已暫停', 'Paper execution paused')
              : t('可建立與審閱提案', 'Ready to plan and review')}
          </strong>
          <p>
            {t(
              '每次接受提案都會重新檢查現金、限制與資料版本。',
              'Every accepted proposal rechecks cash, limits, and data versions.',
            )}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await downloadPaperFile(
                  `/api/paper/accounts/${accountId}/export`,
                  'alphaview-paper-account.json',
                )
              } catch (err) {
                setError((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('匯出模擬帳戶', 'Export paper account')}
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => void controls({ kill_switch: !account.kill_switch })}
          >
            {account.kill_switch ? <Play size={16} /> : <Pause size={16} />}
            {account.kill_switch
              ? t('恢復模擬執行', 'Resume paper execution')
              : t('暫停模擬執行', 'Pause paper execution')}
          </button>
        </div>
      </div>
      <PortfolioFork snapshot={snapshot} locale={locale} onCreated={onForked} />
      {error && (
        <p className="error-message" role="alert">
          {error}
          <button className="text-button" onClick={reload}>
            {t('重新載入', 'Reload')}
          </button>
        </p>
      )}
      <div
        className="agent-tabs"
        role="tablist"
        aria-label={t('組合工作區', 'Portfolio workspace')}
      >
        {tabs.map(([id, label], index) => (
          <button
            type="button"
            key={id}
            role="tab"
            id={`${panelId}-${id}-tab`}
            aria-controls={panelId}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            ref={(element) => {
              if (element) tabButtons.current[id] = element
              else delete tabButtons.current[id]
            }}
            className={tab === id ? 'active' : ''}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => {
              let next = index
              if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
              else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = tabs.length - 1
              else return
              event.preventDefault()
              selectTab(tabs[next][0], true)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="agent-tab-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-${tab}-tab`}
        tabIndex={0}
      >
        <div hidden={tab !== 'plan'}>
          <div className="agent-columns">
            <AllocationComposer
              snapshot={snapshot}
              locale={locale}
              onSaved={(proposal) => {
                showProposal(proposal)
                reload()
              }}
            />
            <PolicyEditor
              account={account}
              busy={busy}
              t={t}
              onSave={(limits, execution_policy, expectedVersion) =>
                controls({ limits, execution_policy }, expectedVersion)
              }
            />
          </div>
          <PortfolioSymbolPolicy
            snapshot={snapshot}
            locale={locale}
            onUpdated={(value) => {
              setSnapshot(value)
              reload()
            }}
          />
          <ResearchEvidenceSection
            id={`research-evidence-capacity-${account.id}`}
            title={t('研究回條容量', 'Research receipt capacity')}
            defaultOpen={false}
          >
            <ResearchEvidenceCapacity
              accountId={account.id}
              accountVersion={account.version}
              t={t}
            />
          </ResearchEvidenceSection>
          <ResearchEvidenceSection
            id={`execution-study-receipt-archive-${account.id}`}
            title={t('執行研究回條封存', 'Execution study receipt archive')}
            defaultOpen={false}
          >
            <ExecutionStudyReceiptArchive
              accountId={account.id}
              accountVersion={account.version}
              t={t}
            />
          </ResearchEvidenceSection>
          <section className="agent-panel">
            <div className="section-heading">
              <div>
                <h2>{t('調倉提案', 'Rebalance proposals')}</h2>
                <p>
                  {t(
                    '提案保存後仍需明確接受，才會更新模擬帳本。',
                    'A saved proposal requires explicit acceptance before it updates the paper ledger.',
                  )}
                </p>
              </div>
            </div>
            {!snapshot.proposals.length ? (
              <p className="agent-empty">
                {t(
                  '尚無提案。先輸入目標配置，或執行 Agent 工作流。',
                  'No proposals yet. Enter target weights or run the Agent workflow.',
                )}
              </p>
            ) : (
              <div className="agent-proposal-list">
                {snapshot.proposals.map((proposal) => (
                  <button
                    type="button"
                    className={selectedProposal?.id === proposal.id ? 'selected' : ''}
                    key={proposal.id}
                    onClick={() => showProposal(proposal)}
                  >
                    <span>
                      <strong>
                        {proposal.targets.map((target) => target.symbol).join(' · ') ||
                          t('全現金', 'All cash')}
                      </strong>
                      <small>
                        {dateTime(proposal.created_at)} · {proposal.orders.length}{' '}
                        {t('筆模擬變動', 'paper changes')}
                      </small>
                    </span>
                    <span className="agent-status">
                      {proposalStatus(proposal.status, t)}
                      {proposal.risk_direction && ` · ${riskDirection(proposal.risk_direction, t)}`}
                      {proposal.provenance &&
                        ` · ${[provenanceSource(proposal.provenance.source, t), ...proposal.provenance.tags.map((tag) => provenanceTag(tag, t))].join(' · ')}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {snapshot.proposals_truncated && (
              <p className="notice">
                {t(
                  `此處顯示最近 ${snapshot.proposals.length} 筆，共 ${snapshot.proposal_count} 筆。更早未結案提案可到「所有帳戶待辦」檢閱。`,
                  `Showing the latest ${snapshot.proposals.length} of ${snapshot.proposal_count} proposals. Open the all-account inbox to review older open proposals.`,
                )}
              </p>
            )}
            {proposalId && !proposalCurrent && !proposalError && (
              <p role="status">
                {t('正在核對提案的最新狀態…', 'Checking the latest proposal state…')}
              </p>
            )}
            {proposalError && (
              <p className="error-message" role="alert">
                {proposalError}{' '}
                <button className="text-button" onClick={reload}>
                  {t('重新載入提案', 'Reload proposal')}
                </button>
              </p>
            )}
            {selectedProposal && selectedProposal.id === proposalId && (
              <ProposalReview
                key={selectedProposal.id}
                proposal={selectedProposal}
                snapshot={snapshot}
                locale={locale}
                current={proposalCurrent}
                onChanged={(value) => {
                  showProposal(value)
                  reload()
                }}
              />
            )}
          </section>
        </div>
        <div hidden={tab !== 'risk'} ref={riskWorkspace}>
          {riskVisited && (
            <>
              <div className="section-heading">
                <div>
                  <h2>{t('風險控管', 'Risk controls')}</h2>
                  <p>
                    {t(
                      '集中檢閱模擬帳戶的熔斷、持倉停損、市場風險上限與公司行動提醒。這些設定不代表即時風控，也不會送出實盤委託。',
                      'Review circuit breakers, position stops, market exposure limits, and corporate-action notices for this paper account. These settings are not live risk monitoring and do not place real orders.',
                    )}
                  </p>
                </div>
              </div>
              <ResearchEvidenceNavigation
                collapsible
                workspaceRef={riskWorkspace}
                scopeKey={`${account.id}:risk`}
                tools={[
                  { targetId: riskTarget('actions'), label: t('事件來源', 'Event sources') },
                  { targetId: riskTarget('ledger'), label: t('帳本預覽', 'Ledger preview') },
                  { targetId: riskTarget('history'), label: t('版本比較', 'Revision comparison') },
                ]}
                t={t}
              />
              <PortfolioCircuitBreakers
                account={account}
                locale={locale}
                onAccountChanged={reload}
              />
              <PortfolioPositionStops
                account={account}
                locale={locale}
                onProposal={(proposal) => {
                  showProposal(proposal)
                  selectTab('plan', true)
                  reload()
                }}
              />
              <PortfolioRegimeOverlay account={account} locale={locale} />
              <ResearchEvidenceSection
                id={riskTarget('actions')}
                title={t('事件來源', 'Event sources')}
              >
                <PortfolioCorporateActions account={account} locale={locale} />
              </ResearchEvidenceSection>
              <ResearchEvidenceSection
                id={riskTarget('ledger')}
                title={t('帳本預覽', 'Ledger preview')}
              >
                <CorporateActionLedgerPreview account={account} locale={locale} />
              </ResearchEvidenceSection>
              <ResearchEvidenceSection
                id={riskTarget('history')}
                title={t('版本比較', 'Revision comparison')}
              >
                <CorporateActionHistory accountId={account.id} t={t} />
              </ResearchEvidenceSection>
            </>
          )}
        </div>
        {tab === 'agent' && (
          <DeferredContent name={t('Agent 工作流', 'Agent workflow')} locale={locale}>
            <PortfolioAgentWorkflow
              account={account}
              locale={locale}
              onProposal={(proposal) => {
                showProposal(proposal)
                selectTab('plan', true)
                reload()
              }}
            />
          </DeferredContent>
        )}
        {tab === 'ledger' && <PaperLedger snapshot={snapshot} t={t} />}
        {tab === 'local-model' && (
          <PortfolioLocalAgent
            account={account}
            locale={locale}
            onProposal={(proposal) => {
              showProposal(proposal)
              selectTab('plan', true)
              reload()
            }}
          />
        )}
        {tab === 'trading-agent' && (
          <DeferredContent name={t('交易代理', 'Trading agent')} locale={locale}>
            <PortfolioTradingAgent
              account={account}
              snapshot={snapshot}
              locale={locale}
              onAccountChanged={reload}
            />
          </DeferredContent>
        )}
        {tab === 'jev' && (
          <PortfolioJevGate
            account={account}
            locale={locale}
            onProposal={(proposal) => {
              showProposal(proposal)
              selectTab('plan', true)
              reload()
            }}
          />
        )}
        {tab === 'scenarios' && <PortfolioScenarios snapshot={snapshot} locale={locale} />}
        {tab === 'next-open' && (
          <PortfolioNextOpen
            snapshot={snapshot}
            locale={locale}
            onAccountChanged={() => setRefresh((value) => value + 1)}
            selectedOrderId={navigation?.queue_order_id}
            selectionNonce={navigation?.nonce}
            onProposal={(proposal) => {
              showProposal(proposal)
              selectTab('plan', true)
              setRefresh((value) => value + 1)
            }}
          />
        )}
        {tab === 'performance' && (
          <PortfolioPaperPerformance snapshot={snapshot} locale={locale} onCaptured={reload} />
        )}
        {tab === 'automation' && (
          <PortfolioAutomation
            account={account}
            locale={locale}
            onAccountChanged={reload}
            selectedMandateId={navigation?.mandate_id}
            selectionNonce={navigation?.nonce}
          />
        )}
      </div>
    </>
  )
}

const PROVENANCE_SOURCES: Record<string, [string, string, string, string]> = {
  manual: [
    '手動建立',
    'Manual',
    '由你在配置與提案分頁直接建立。',
    'Created directly by you in the allocation tab.',
  ],
  automation: [
    '自動化任務',
    'Automation',
    '由本機自動化任務的規則工作流產生，綁定該次嘗試。',
    'Produced by a local automation attempt of the rules workflow and bound to it.',
  ],
  rules_workflow: [
    '規則工作流',
    'Rules workflow',
    '從規則工作流頁手動接續到紙上帳戶。',
    'Bridged by hand from the rules-workflow page.',
  ],
  position_stops: [
    '部位停損',
    'Position stops',
    '收盤確認的停損／追蹤停損觸發，只賣到零。',
    'A close-confirmed stop or trailing stop tripped; sells to zero only.',
  ],
  strategy_bridge: [
    '策略橋接',
    'Strategy bridge',
    '由回測研究台的策略設定接續；驗證閘結果記在理由。',
    'Bridged from a Research Desk strategy; the validation verdict is recorded in the rationale.',
  ],
  jev: [
    'Jev 決策閘',
    'Jev gate',
    '由 Jev 決策閘的門檻結果接續，未通過的標的歸零。',
    'Bridged from a Jev gate run; symbols that failed the threshold went to zero.',
  ],
  local_agent: [
    '本機模型分析',
    'Local model',
    '由本機 Ollama 分析接續，綁定該次分析。',
    'Bridged from a local Ollama analysis and bound to it.',
  ],
}
const PROVENANCE_TAGS: Record<string, [string, string, string, string]> = {
  jev_gate: [
    'Jev 門檻',
    'Jev gate',
    '目標經 Jev 校準機率門檻過濾。',
    'Targets were filtered by the Jev calibrated-probability threshold.',
  ],
  regime_overlay: [
    '市場風險覆蓋',
    'Regime overlay',
    '市場風險溫度計的總曝險上限介入（scale 縮放目標／block 阻擋）。',
    'The market-regime exposure cap intervened (scale shrinks targets / block refuses).',
  ],
  reduce_only: [
    '純減倉',
    'Reduce-only',
    '帳戶暫停中，目標被夾到不高於現有權重。',
    'The account was paused; targets were clamped to the current weights.',
  ],
  allocator: [
    '配置方法',
    'Allocator',
    '規則工作流的配置方法（equal／inverse_volatility／score_tilt）。',
    'Allocation method of the rules workflow (equal / inverse_volatility / score_tilt).',
  ],
  validation: [
    '驗證閘',
    'Validation gate',
    '策略驗證閘的判定（pass／warn／overridden／off）。',
    'Verdict of the strategy validation gate (pass / warn / overridden / off).',
  ],
  position_stop: [
    '停損觸發',
    'Stop tripped',
    '由部位停損建立，只賣到零。',
    'Created by position stops; sells to zero only.',
  ],
  corporate_action_notice: [
    '公司行動提醒',
    'Corporate action notice',
    '持倉在進場後偵測到除權息事件，帳本未自動調整。',
    'A corporate action was detected after entry; the ledger was not adjusted automatically.',
  ],
  execution: [
    '已送券商',
    'Sent to broker',
    '提案已送至 Alpaca Paper 執行。',
    'The proposal was sent to Alpaca Paper for execution.',
  ],
}
function provenanceSource(source: string, t: Translate) {
  const entry = PROVENANCE_SOURCES[source]
  return entry ? t(entry[0], entry[1]) : source
}
function provenanceSourceExplain(source: string, t: Translate) {
  const entry = PROVENANCE_SOURCES[source]
  return entry ? t(entry[2], entry[3]) : ''
}
function provenanceTag(tag: string, t: Translate) {
  const [key, value] = tag.split(':')
  const entry = PROVENANCE_TAGS[key]
  return (entry ? t(entry[0], entry[1]) : key) + (value ? ` ${value}` : '')
}
function provenanceExplain(tag: string, t: Translate) {
  const entry = PROVENANCE_TAGS[tag.split(':')[0]]
  return entry ? t(entry[2], entry[3]) : ''
}
function riskDirection(direction: string, t: Translate) {
  const labels: Record<string, [string, string]> = {
    reducing: ['純減倉', 'Risk-reducing'],
    increasing: ['加倉', 'Risk-increasing'],
    mixed: ['混合', 'Mixed'],
    unchanged: ['不變', 'Unchanged'],
  }
  return labels[direction] ? t(...labels[direction]) : direction
}
function proposalStatus(status: string, t: Translate) {
  const labels: Record<string, [string, string]> = {
    proposed: ['待審閱', 'Awaiting review'],
    blocked: ['限制阻塞', 'Blocked'],
    simulated: ['已模擬執行', 'Simulated'],
    submitted_external: ['已送至 Alpaca Paper', 'Sent to Alpaca Paper'],
    rejected: ['已拒絕', 'Rejected'],
  }
  return labels[status] ? t(...labels[status]) : status
}

function PolicyEditor({
  account,
  busy,
  t,
  onSave,
}: {
  account: PaperAccount
  busy: boolean
  t: Translate
  onSave: (
    limits: PaperLimits,
    execution: PaperExecutionPolicy,
    expectedVersion: number,
  ) => Promise<void>
}) {
  const [policyDraft, setPolicyDraft] = useSessionState(
    `paper-policy-${account.id}-v1`,
    () => ({
      limits: account.limits,
      execution: account.execution_policy || DEFAULT_PAPER_EXECUTION,
      version: account.version,
    }),
    validPaperPolicyDraft,
  )
  const { limits, execution, version } = policyDraft
  const setLimits = (value: PaperLimits) =>
    setPolicyDraft((current) => ({ ...current, limits: value }))
  const setExecution = (value: PaperExecutionPolicy) =>
    setPolicyDraft((current) => ({ ...current, execution: value }))
  const unchanged =
    JSON.stringify(limits) === JSON.stringify(account.limits) &&
    JSON.stringify(execution) ===
      JSON.stringify(account.execution_policy || DEFAULT_PAPER_EXECUTION)
  const stale = version !== account.version && !unchanged
  useEffect(() => {
    if (unchanged && version !== account.version)
      setPolicyDraft((current) => ({ ...current, version: account.version }))
  }, [account.version, unchanged, version, setPolicyDraft])
  return (
    <form
      className="agent-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (!stale) void onSave(limits, execution, version)
      }}
    >
      <div className="eyebrow">MANDATE / RISK LIMITS</div>
      <h2>{t('帳戶風險限制', 'Account risk limits')}</h2>
      <p>
        {t(
          '限制獨立於 Agent，不能由研究提案自行放寬。修改限制會使舊提案失效。',
          'Limits are independent of the Agent and cannot be relaxed by a proposal. Changing limits invalidates older proposals.',
        )}
      </p>
      {(
        [
          ['max_position_weight_pct', t('單一標的上限（%）', 'Position cap (%)'), 0.1],
          ['max_turnover_pct', t('單次總換手上限（%）', 'Gross turnover cap (%)'), 0],
          ['min_cash_weight_pct', t('現金比例下限（%）', 'Minimum cash (%)'), 0],
        ] as const
      ).map(([key, label, minimum]) => (
        <label className="agent-field" key={key}>
          {label}
          <input
            type="number"
            required
            min={minimum}
            max={key === 'max_turnover_pct' ? 200 : 100}
            step="0.1"
            value={limits[key]}
            onChange={(event) => setLimits({ ...limits, [key]: Number(event.target.value) })}
          />
        </label>
      ))}
      <details className="agent-method">
        <summary>{t('費用、滑價與最小變動', 'Fees, slippage, and trade size')}</summary>
        <p>
          {t(
            '1 bps = 0.01%。費用與不利滑價會減少模擬現金；低於最小金額的變動會保留原持倉，不挪用權重。',
            '1 bps = 0.01%. Fees and adverse slippage reduce paper cash. Changes below the minimum retain existing holdings without reallocating weights.',
          )}
        </p>
        {(
          [
            ['fee_bps', t('單邊費用（bps）', 'One-way fee (bps)'), 1000],
            ['slippage_bps', t('不利滑價（bps）', 'Adverse slippage (bps)'), 1000],
            [
              'min_trade_notional',
              t('最小變動金額（USD）', 'Minimum trade notional (USD)'),
              1000000,
            ],
          ] as const
        ).map(([field, label, maximum]) => (
          <label className="agent-field" key={field}>
            {label}
            <input
              type="number"
              min="0"
              max={maximum}
              step="0.01"
              required
              value={execution[field]}
              onChange={(event) =>
                setExecution({ ...execution, [field]: Number(event.target.value) })
              }
            />
          </label>
        ))}
        <label className="agent-field">
          {t('股數精度', 'Share precision')}
          <select
            value={execution.share_precision}
            onChange={(event) =>
              setExecution({ ...execution, share_precision: Number(event.target.value) })
            }
          >
            <option value={0}>{t('整股', 'Whole shares')}</option>
            {[1, 2, 3, 4, 5, 6].map((precision) => (
              <option key={precision} value={precision}>
                {precision} {t('位小數', 'decimal places')}
              </option>
            ))}
          </select>
        </label>
      </details>
      {stale && (
        <div className="notice">
          <p>
            {t(
              '帳戶版本已變更；編輯中的限制已保留。請載入目前限制後再修改。',
              'The account version changed; your draft is preserved. Load current limits before editing again.',
            )}
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setPolicyDraft({
                limits: account.limits,
                execution: account.execution_policy || DEFAULT_PAPER_EXECUTION,
                version: account.version,
              })
            }}
          >
            {t('載入目前限制', 'Load current limits')}
          </button>
        </div>
      )}
      <button className="button" disabled={busy || unchanged || stale}>
        {t('儲存限制', 'Save limits')}
      </button>
    </form>
  )
}

function AllocationComposer({
  snapshot,
  locale,
  onSaved,
}: {
  snapshot: PaperSnapshot
  locale: Locale
  onSaved: (proposal: PaperProposal) => void
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(
    `paper-targets-${snapshot.account.id}-v1`,
    () => '',
    (value): value is string => typeof value === 'string' && value.length <= 6000,
  )
  const [rationale, setRationale] = useSessionState(
    `paper-rationale-${snapshot.account.id}-v1`,
    () => '',
    (value): value is string => typeof value === 'string' && value.length <= 2000,
  )
  const [preview, setPreview] = useState<{ result: PaperPreview; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const idempotency = useRef(newPaperKey())
  const parsed = parsePaperTargets(draft)
  const key = JSON.stringify([
    draft,
    rationale,
    snapshot.account.version,
    snapshot.input_revision,
    snapshot.as_of,
  ])
  const current = preview?.key === key ? preview.result : null
  const targetTotal = parsed.targets?.reduce((sum, target) => sum + target.weight_pct, 0)
  const reasons: Record<string, string> = {
    empty: t('請輸入目標配置。', 'Enter target weights.'),
    limit: t('最多 50 個標的。', 'Up to 50 symbols.'),
    format: t(
      '每行輸入股票代碼和 0–100 的百分比，例如 AAPL 20。',
      'Use a symbol and a percentage from 0 to 100 on each line, e.g. AAPL 20.',
    ),
    duplicate: t('每個標的只能出現一次。', 'Each symbol may appear only once.'),
    sum: t('目標權重合計不得超過 100%。', 'Target weights cannot exceed 100%.'),
  }
  async function calculate(save: boolean) {
    if (!parsed.targets || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<PaperPreview | PaperProposal>(
        `/api/paper/accounts/${snapshot.account.id}/${save ? 'proposals' : 'preview'}`,
        {
          method: 'POST',
          body: JSON.stringify({
            expected_version: snapshot.account.version,
            targets: parsed.targets,
            rationale,
            ...(save ? { idempotency_key: idempotency.current } : {}),
          }),
        },
      )
      setPreview({ result, key })
      if (save) {
        onSaved(result as PaperProposal)
        idempotency.current = newPaperKey()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="agent-panel">
      <div className="eyebrow">TARGET ALLOCATION</div>
      <h2>{t('規劃目標配置', 'Plan target allocation')}</h2>
      <p>
        {t(
          '每行輸入代碼與百分比。這是完整組合：未列出的既有虛擬持倉目標為 0%，剩餘保留現金。',
          'Enter a symbol and percentage per line. This is the full portfolio: omitted paper holdings target 0%; the remainder stays in cash.',
        )}
      </p>
      <label className="agent-field">
        {t('目標權重', 'Target weights')}
        <textarea
          rows={5}
          value={draft}
          maxLength={6000}
          placeholder={'AAPL 20\nMSFT 20'}
          onChange={(event) => {
            setDraft(event.target.value)
            idempotency.current = newPaperKey()
          }}
        />
      </label>
      {snapshot.holdings.length > 0 && (
        <div className="actions">
          <button
            type="button"
            className="text-button"
            disabled={!snapshot.valuation_complete}
            onClick={() => {
              setDraft(
                snapshot.holdings
                  .map(
                    (holding) =>
                      `${holding.symbol} ${Math.floor((holding.weight_pct || 0) * 10000) / 10000}`,
                  )
                  .join('\n'),
              )
              idempotency.current = newPaperKey()
            }}
          >
            {t('載入目前配置', 'Load current allocation')}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(snapshot.holdings.map((holding) => `${holding.symbol} 0`).join('\n'))
              idempotency.current = newPaperKey()
            }}
          >
            {t('規劃全現金目標', 'Plan an all-cash target')}
          </button>
        </div>
      )}
      {draft && parsed.error && <p className="error-message">{reasons[parsed.error]}</p>}
      {targetTotal != null && (
        <p className="agent-allocation-summary">
          {t('標的配置', 'Asset allocation')} <strong>{percent(targetTotal)}</strong> ·{' '}
          {t('保留現金', 'Residual cash')} <strong>{percent(100 - targetTotal)}</strong>
        </p>
      )}
      <label className="agent-field">
        {t('提案理由（選填）', 'Rationale (optional)')}
        <input
          value={rationale}
          maxLength={2000}
          onChange={(event) => {
            setRationale(event.target.value)
            idempotency.current = newPaperKey()
          }}
        />
      </label>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          className="button"
          disabled={busy || !parsed.targets}
          onClick={() => void calculate(false)}
        >
          {busy ? t('計算中…', 'Calculating…') : t('預覽調倉', 'Preview rebalance')}
        </button>
        <button
          className="button primary"
          disabled={busy || !current}
          onClick={() => void calculate(true)}
        >
          {t('儲存提案', 'Save proposal')}
        </button>
      </div>
      {preview && !current && (
        <p className="notice">
          {t(
            '輸入、帳戶或行情版本已變更，請重新預覽。草稿已保留。',
            'Inputs, account, or market data changed. Preview again; your draft is preserved.',
          )}
        </p>
      )}
      {current && <PreviewDetails preview={current} t={t} />}
      {current && <PortfolioCostSensitivity preview={current} locale={locale} />}
    </section>
  )
}

function PreviewDetails({ preview, t }: { preview: PaperPreview; t: Translate }) {
  return (
    <div className="agent-preview">
      <div className={`agent-verdict ${preview.executable ? 'allowed' : 'blocked'}`}>
        <Checkmark size={16} />
        {preview.executable
          ? t('通過目前風險限制', 'Current limits passed')
          : t('提案被限制阻塞', 'Proposal blocked')}
      </div>
      <div className="agent-preview-stats">
        <span>
          {t('預估總成本', 'Estimated total cost')} <strong>{money(preview.cost_total)}</strong>
        </span>
        <span>
          {t('總換手', 'Gross turnover')} <strong>{percent(preview.turnover_pct)}</strong>
        </span>
        <span>
          {t('預計現金', 'Projected cash')} <strong>{money(preview.cash_after)}</strong>
        </span>
        <span>
          {t('價格覆蓋', 'Price coverage')}{' '}
          <strong>
            {preview.coverage.priced}/{preview.coverage.required}
          </strong>
        </span>
      </div>
      {preview.violations.length > 0 && (
        <ul className="agent-reasons">
          {preview.violations.map((violation, index) => (
            <li key={`${violation.code}-${index}`}>
              {violation.symbol && <strong>{violation.symbol} </strong>}
              {violation.message}
            </li>
          ))}
        </ul>
      )}
      {preview.orders.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('標的', 'Symbol')}</th>
                <th>{t('模擬變動', 'Paper action')}</th>
                <th>{t('股數', 'Shares')}</th>
                <th>{t('參考／模擬價', 'Reference / fill')}</th>
                <th>{t('費用', 'Fee')}</th>
                <th>{t('目標／預計權重', 'Target / projected')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.orders.map((order) => (
                <tr key={order.symbol}>
                  <td>
                    <strong>{order.symbol}</strong>
                  </td>
                  <td>{order.side === 'buy' ? t('增加', 'Increase') : t('減少', 'Decrease')}</td>
                  <td>{num(order.shares, 6)}</td>
                  <td>
                    {money(order.reference_price)} / {money(order.fill_price)}
                  </td>
                  <td>{money(order.fee)}</td>
                  <td>
                    {percent(order.target_weight_pct)} / {percent(order.projected_weight_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!preview.skipped_orders?.length && (
        <div className="notice">
          <strong>{t('未產生模擬變動', 'Changes not simulated')}</strong>
          {preview.skipped_orders.map((order) => (
            <p key={order.symbol}>
              {order.symbol} · {order.reason}
            </p>
          ))}
        </div>
      )}
      <details className="agent-method">
        <summary>{t('計算口徑與限制', 'Method and limitations')}</summary>
        <p>{preview.method}</p>
        {preview.warnings.map((warning, index) => (
          <p key={index}>{warning}</p>
        ))}
        <small>
          {preview.engine_version} · {preview.as_of}
        </small>
      </details>
    </div>
  )
}

function ProposalReview({
  proposal,
  snapshot,
  locale,
  onChanged,
  current,
}: {
  proposal: PaperProposal
  snapshot: PaperSnapshot
  locale: Locale
  onChanged: (proposal: PaperProposal) => void
  current: boolean
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const idempotency = useRef(newPaperKey())
  const stale =
    proposal.engine_version !== snapshot.engine_version ||
    proposal.account_version !== snapshot.account.version ||
    proposal.input_revision !== snapshot.input_revision ||
    proposal.as_of !== snapshot.as_of
  const canAccept =
    current &&
    proposal.status === 'proposed' &&
    proposal.executable &&
    !stale &&
    !snapshot.account.kill_switch
  async function act(action: 'accept' | 'reject') {
    if (busy || !current || (action === 'accept' && (!canAccept || !confirmed))) return
    setBusy(true)
    setError('')
    try {
      const result = await api<PaperProposal | { proposal: PaperProposal }>(
        `/api/paper/accounts/${snapshot.account.id}/proposals/${proposal.id}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({
            expected_version: snapshot.account.version,
            ...(action === 'accept' ? { idempotency_key: idempotency.current } : {}),
          }),
        },
      )
      setConfirmed(false)
      onChanged('proposal' in result ? result.proposal : result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="agent-proposal-review">
      <h3>
        {t('提案明細', 'Proposal details')}{' '}
        <span className="muted">{proposalStatus(proposal.status, t)}</span>
      </h3>
      <PreviewDetails preview={proposal} t={t} />
      <ExecutionStudyWorkspace
        accountId={snapshot.account.id}
        proposal={proposal}
        currentAccountVersion={snapshot.account.version}
        currentInputRevision={snapshot.input_revision}
        currentAsOf={snapshot.as_of}
        enabled={current}
        t={t}
      />
      {proposal.provenance && (
        <section
          className="agent-provenance"
          aria-label={t('為什麼是這份提案', 'Why this proposal')}
        >
          <h4>{t('為什麼是這份提案', 'Why this proposal')}</h4>
          <ul>
            <li>
              <strong>{provenanceSource(proposal.provenance.source, t)}</strong> ·{' '}
              {provenanceSourceExplain(proposal.provenance.source, t)}
            </li>
            {proposal.provenance.tags.map((tag) => (
              <li key={tag}>
                <strong>{provenanceTag(tag, t)}</strong> · {provenanceExplain(tag, t)}
              </li>
            ))}
            {!proposal.provenance.tags.length && (
              <li>{t('沒有額外的閘門紀錄。', 'No additional gate evidence recorded.')}</li>
            )}
          </ul>
          <small className="muted">
            {proposal.provenance.engine_version} ·{' '}
            {t(
              '標籤只來自提案保存的證據，不補猜。',
              'Tags come only from evidence saved with the proposal; nothing is inferred.',
            )}
          </small>
        </section>
      )}
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={async () => {
          setError('')
          setBusy(true)
          try {
            await downloadPaperFile(
              `/api/paper/accounts/${snapshot.account.id}/proposals/${proposal.id}/receipt`,
              'alphaview-paper-proposal-receipt.json',
            )
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('下載提案決策收據', 'Download proposal receipt')}
      </button>
      {stale && proposal.status === 'proposed' && (
        <p className="notice">
          {t(
            '提案使用的資料或帳戶版本已過期，請重新建立。',
            'The proposal uses an older data or account version. Create a fresh proposal.',
          )}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {canAccept && (
        <label className="agent-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t(
            '我已檢查目標配置與限制，接受以參考收盤價更新虛擬帳本。',
            'I reviewed targets and limits and accept updating the paper ledger at reference close prices.',
          )}
        </label>
      )}
      <div className="actions">
        {proposal.status === 'proposed' && (
          <button
            className="button primary"
            disabled={!canAccept || !confirmed || busy}
            onClick={() => void act('accept')}
          >
            {t('接受並模擬執行', 'Accept and simulate')}
          </button>
        )}
        {['proposed', 'blocked'].includes(proposal.status) && (
          <button className="button" disabled={busy || !current} onClick={() => void act('reject')}>
            {t('拒絕提案', 'Reject proposal')}
          </button>
        )}
      </div>
    </div>
  )
}

function PaperLedger({ snapshot, t }: { snapshot: PaperSnapshot; t: Translate }) {
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  return (
    <>
      <section className="agent-panel">
        <h2>{t('虛擬持倉', 'Paper holdings')}</h2>
        {!snapshot.holdings.length ? (
          <p className="agent-empty">
            {t('此帳戶目前持有全額虛擬現金。', 'This account currently holds only virtual cash.')}
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('標的', 'Symbol')}</th>
                  <th>{t('股數', 'Shares')}</th>
                  <th>{t('參考價格', 'Reference price')}</th>
                  <th>{t('市值', 'Market value')}</th>
                  <th>{t('權重', 'Weight')}</th>
                  <th>{t('未實現損益', 'Unrealized P&L')}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.holdings.map((holding) => (
                  <tr key={holding.symbol}>
                    <td>
                      <strong>{holding.symbol}</strong>
                      {holding.reason && <small>{holding.reason}</small>}
                    </td>
                    <td>{num(holding.shares, 6)}</td>
                    <td>{money(holding.price)}</td>
                    <td>{money(holding.market_value)}</td>
                    <td>{percent(holding.weight_pct)}</td>
                    <td>{money(holding.unrealized_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="agent-panel">
        <div className="section-heading">
          <h2>{t('現金與模擬交易帳本', 'Cash and paper transaction ledger')}</h2>
          <button
            type="button"
            className="button"
            disabled={exporting}
            onClick={async () => {
              setExporting(true)
              setError('')
              try {
                await downloadPaperFile(
                  `/api/paper/accounts/${snapshot.account.id}/export?format=csv`,
                  'alphaview-paper-ledger.csv',
                )
              } catch (err) {
                setError((err as Error).message)
              } finally {
                setExporting(false)
              }
            }}
          >
            {t('匯出完整帳本 CSV', 'Export full ledger CSV')}
          </button>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <p>
          {t(
            '每筆紀錄保存現金變動與對應提案，可追溯模擬決策。',
            'Each record preserves its cash movement and proposal reference for decision traceability.',
          )}
        </p>
        {snapshot.ledger_truncated && (
          <p className="notice">
            {t(
              `顯示最近 ${snapshot.ledger.length} 筆，共 ${snapshot.ledger_count} 筆。完整紀錄可匯出 CSV。`,
              `Showing the latest ${snapshot.ledger.length} of ${snapshot.ledger_count} records. Export CSV for the full ledger.`,
            )}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('時間', 'Time')}</th>
                <th>{t('事件', 'Event')}</th>
                <th>{t('標的', 'Symbol')}</th>
                <th>{t('股數變化', 'Share change')}</th>
                <th>{t('現金變化', 'Cash change')}</th>
                <th>{t('現金結餘', 'Cash balance')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.ledger.map((entry) => (
                <tr key={entry.id}>
                  <td>{dateTime(entry.created_at)}</td>
                  <td>
                    {entry.kind === 'opening_mark'
                      ? t('實驗起始部位', 'Experiment opening position')
                      : entry.kind === 'initial_cash'
                        ? t('初始虛擬資金', 'Initial virtual capital')
                        : entry.kind === 'simulated_fill'
                          ? t('模擬成交', 'Simulated fill')
                          : entry.kind}
                  </td>
                  <td>{entry.symbol || '—'}</td>
                  <td>{num(entry.shares_delta, 6)}</td>
                  <td>{money(entry.cash_delta)}</td>
                  <td>{money(entry.cash_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="research-note">{snapshot.method}</p>
      </section>
    </>
  )
}
