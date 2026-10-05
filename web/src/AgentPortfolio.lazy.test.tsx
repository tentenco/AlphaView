import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPortfolio } from './AgentPortfolio'
import type { PaperAccount, PaperSnapshot } from './paper-model'

const chunks = vi.hoisted(() => {
  const gate = () => {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { ready: false, promise, release: () => resolve() }
  }
  return { gate, workflow: gate(), trading: gate(), workflowImports: 0, tradingImports: 0 }
})
vi.mock('./PortfolioAgentWorkflow', async (importOriginal) => {
  chunks.workflowImports++
  const module = await importOriginal<typeof import('./PortfolioAgentWorkflow')>()
  return {
    ...module,
    PortfolioAgentWorkflow: (props: Parameters<typeof module.PortfolioAgentWorkflow>[0]) => {
      if (!chunks.workflow.ready) throw chunks.workflow.promise
      return <module.PortfolioAgentWorkflow {...props} />
    },
  }
})
vi.mock('./PortfolioTradingAgent', async (importOriginal) => {
  chunks.tradingImports++
  const module = await importOriginal<typeof import('./PortfolioTradingAgent')>()
  return {
    ...module,
    PortfolioTradingAgent: (props: Parameters<typeof module.PortfolioTradingAgent>[0]) => {
      if (!chunks.trading.ready) throw chunks.trading.promise
      return <module.PortfolioTradingAgent {...props} />
    },
  }
})
vi.mock('./PortfolioFork', () => ({ PortfolioFork: () => null }))
vi.mock('./PortfolioSymbolPolicy', () => ({ PortfolioSymbolPolicy: () => null }))
vi.mock('./AgentDailyReport', () => ({ AgentDailyReport: () => null }))
vi.mock('./AgentDecisionOutcomes', () => ({ AgentDecisionOutcomes: () => null }))
vi.mock('./AgentReadiness', () => ({ AgentReadiness: () => null }))

const account: PaperAccount = {
  id: 'synthetic-lazy-account',
  name: 'Synthetic lazy account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T00:00:00Z',
  updated_at: '2026-09-29T00:00:00Z',
}
const other = { ...account, id: 'synthetic-lazy-other', name: 'Synthetic other account' }
const snapshot = (account: PaperAccount): PaperSnapshot => ({
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account,
  holdings: [],
  coverage: { required: 0, priced: 0, missing: [] },
  valuation_complete: true,
  equity: 10000,
  holdings_value: 0,
  cash_weight_pct: 100,
  unrealized_pnl: 0,
  realized_pnl: 0,
  total_return_pct: 0,
  ledger: [],
  proposals: [],
  method: 'Synthetic snapshot.',
  warnings: [],
})
function mockApi() {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw new Error(`Unexpected mutation: ${url}`)
    let value: unknown
    if (url === '/api/paper/accounts') value = { accounts: [account, other] }
    else if (url === `/api/paper/accounts/${account.id}`) value = snapshot(account)
    else if (url === `/api/paper/accounts/${other.id}`) value = snapshot(other)
    else if (url === '/api/portfolio-agent/runs?limit=20') value = { runs: [] }
    else if (url === '/api/execution/targets')
      value = {
        targets: [
          {
            id: 'paper_ledger',
            label: 'Local ledger',
            english: 'Local ledger',
            available: true,
            external: false,
            reason: null,
          },
          {
            id: 'alpaca_paper',
            label: 'Alpaca Paper',
            english: 'Alpaca Paper',
            available: false,
            external: true,
            reason: 'not_configured',
          },
        ],
        live_trading: { available: false },
        warnings: [],
      }
    else if (url === '/api/alpaca-paper/connection')
      value = {
        configured: false,
        orders_enabled: false,
        order_caps: null,
        order_style: null,
        enable_confirmation: 'ENABLE PAPER ORDERS',
        capabilities: [],
      }
    else if (
      /^\/api\/execution\/accounts\/synthetic-lazy-(account|other)\/submissions\?limit=20$/.test(
        url,
      )
    )
      value = { submissions: [] }
    else throw new Error(`Unexpected synthetic read: ${url}`)
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const release = async (kind: 'workflow' | 'trading') => {
  await act(async () => {
    chunks[kind].ready = true
    chunks[kind].release()
  })
}
afterEach(() => {
  chunks.workflow.ready = true
  chunks.workflow.release()
  chunks.trading.ready = true
  chunks.trading.release()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  history.replaceState(null, '', location.pathname)
})

it('defers both modules from allocation, keeps real drafts and does not mount a late trading tab', async () => {
  const fetcher = mockApi()
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  const targets = await screen.findByRole('textbox', { name: 'Target weights' })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  expect(chunks.workflowImports).toBe(0)
  expect(chunks.tradingImports).toBe(0)
  await userEvent.type(targets, 'SYN 25')
  await userEvent.click(screen.getByRole('tab', { name: 'Agent workflow' }))
  expect(await screen.findByText('Loading Agent workflow…')).toBeTruthy()
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  expect(chunks.workflowImports).toBe(1)
  expect(chunks.tradingImports).toBe(0)
  await release('workflow')
  await userEvent.type(await screen.findByLabelText('Candidate symbols'), 'SYNWORK')
  await userEvent.click(screen.getByRole('tab', { name: 'Trading agent' }))
  expect(await screen.findByText('Loading Trading agent…')).toBeTruthy()
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  expect(chunks.tradingImports).toBe(1)
  await userEvent.click(screen.getByRole('tab', { name: 'Allocation & proposals' }))
  await release('trading')
  expect(screen.queryByRole('region', { name: 'Trading agent pipeline' })).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/execution/'))).toBe(false)
  expect(
    (screen.getByRole('textbox', { name: 'Target weights' }) as HTMLTextAreaElement).value,
  ).toBe('SYN 25')
  await userEvent.click(screen.getByRole('tab', { name: 'Agent workflow' }))
  expect(((await screen.findByLabelText('Candidate symbols')) as HTMLTextAreaElement).value).toBe(
    'SYNWORK',
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Trading agent' }))
  await screen.findByRole('region', { name: 'Trading agent pipeline' })
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/submissions?limit=20'))).toBe(true),
  )
  expect(chunks.workflowImports).toBe(1)
  expect(chunks.tradingImports).toBe(1)
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

it.each([
  ['agent', 'Agent workflow', 'Agent workflow settings'],
  ['trading-agent', 'Trading agent', 'Trading agent pipeline'],
])(
  'opens the exact %s deep link after its module resolves without rewriting the hash',
  async (tab, name, region) => {
    chunks.workflow.ready = true
    chunks.workflow.release()
    chunks.trading.ready = true
    chunks.trading.release()
    const hash = `#agent-portfolio?account=${other.id}&view=account&tab=${tab}`
    history.replaceState(null, '', hash)
    const push = vi.spyOn(history, 'pushState')
    mockApi()
    render(<AgentPortfolio locale="en" revision="synthetic:1" />)
    await screen.findByRole(tab === 'agent' ? 'form' : 'region', { name: region })
    expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true')
    expect(
      (screen.getByRole('combobox', { name: 'Paper account' }) as HTMLSelectElement).value,
    ).toBe(other.id)
    expect(location.hash).toBe(hash)
    expect(push).not.toHaveBeenCalled()
    push.mockRestore()
  },
)

it('discards a pending tab on account change while restoring each account workflow draft', async () => {
  chunks.workflow = chunks.gate()
  const fetcher = mockApi()
  history.replaceState(null, '', `#agent-portfolio?account=${account.id}&tab=agent`)
  render(<AgentPortfolio locale="en" revision="synthetic:1" />)
  await screen.findByText('Loading Agent workflow…')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Paper account' }), other.id)
  await screen.findByRole('textbox', { name: 'Target weights' })
  await release('workflow')
  expect(screen.queryByRole('form', { name: 'Agent workflow settings' })).toBeNull()
  expect(fetcher.mock.calls.some(([url]) => url === '/api/portfolio-agent/runs?limit=20')).toBe(
    false,
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Agent workflow' }))
  await userEvent.type(await screen.findByLabelText('Candidate symbols'), 'SYNOTHER')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Paper account' }), account.id)
  await userEvent.click(await screen.findByRole('tab', { name: 'Agent workflow' }))
  expect(((await screen.findByLabelText('Candidate symbols')) as HTMLTextAreaElement).value).toBe(
    '',
  )
  await userEvent.type(screen.getByLabelText('Candidate symbols'), 'SYNFIRST')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Paper account' }), other.id)
  await userEvent.click(await screen.findByRole('tab', { name: 'Agent workflow' }))
  expect(((await screen.findByLabelText('Candidate symbols')) as HTMLTextAreaElement).value).toBe(
    'SYNOTHER',
  )
})
