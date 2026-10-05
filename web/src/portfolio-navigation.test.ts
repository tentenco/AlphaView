import { describe, expect, it } from 'vitest'
import {
  PORTFOLIO_TABS,
  PORTFOLIO_VIEWS,
  parsePortfolioHash,
  portfolioHash,
  resolvePortfolioRoute,
} from './portfolio-navigation'

describe('local portfolio fragments', () => {
  it('round trips each allowed view and tab with the account identifier', () => {
    for (const view of PORTFOLIO_VIEWS)
      for (const tab of PORTFOLIO_TABS) {
        const route = { accountId: 'synthetic-account', view, tab }
        expect(parsePortfolioHash(portfolioHash(route))).toEqual({ ...route, invalid: [] })
      }
  })

  it.each([
    'account=',
    'account=../secret',
    'account=%2Fapi%2Fpaper',
    `account=${'a'.repeat(101)}`,
    'account=one&account=two',
    'account=%E0%A4%A',
    'tab=unknown',
    `tab=${'a'.repeat(1000)}`,
    'tab=risk&tab=plan',
    'view=unknown',
    'view=inbox&view=account',
  ])('rejects malformed or ambiguous selection: %s', (query) => {
    const route = parsePortfolioHash(`#agent-portfolio?${query}`)!
    const resolved = resolvePortfolioRoute(route, ['synthetic-first'], '')
    expect(resolved.notice).toBe('invalid')
    expect(resolved.accountId).toBe('synthetic-first')
  })

  it('uses the existing valid account only when the fragment omits or cannot resolve one', () => {
    const known = ['synthetic-first', 'synthetic-second']
    const absent = parsePortfolioHash('#agent-portfolio?tab=risk')!
    expect(resolvePortfolioRoute(absent, known, 'synthetic-second')).toMatchObject({
      accountId: 'synthetic-second',
      tab: 'risk',
      notice: null,
    })
    const stale = parsePortfolioHash('#agent-portfolio?account=synthetic-deleted&tab=risk')!
    expect(resolvePortfolioRoute(stale, known, 'synthetic-second')).toMatchObject({
      accountId: 'synthetic-second',
      notice: 'stale-account',
    })
    expect(resolvePortfolioRoute(stale, [], 'synthetic-second')).toMatchObject({
      accountId: null,
      notice: 'stale-account',
    })
  })

  it('preserves the legacy Alpaca entry only without an explicit view', () => {
    expect(parsePortfolioHash('#agent-portfolio', true)?.view).toBe('alpaca')
    expect(parsePortfolioHash('#agent-portfolio?view=account', true)?.view).toBe('account')
    expect(parsePortfolioHash('#agent-portfolio?view=wrong', true)?.view).toBe('account')
    expect(parsePortfolioHash('#other?tab=risk')).toBeNull()
  })

  it('does not serialize unknown fields, proposals, or private drafts', () => {
    const route = {
      accountId: 'synthetic-account',
      view: 'account' as const,
      tab: 'plan' as const,
      proposal_id: 'synthetic-proposal',
      targets: 'SYNTA 20',
      name: 'Synthetic private draft',
    }
    expect(portfolioHash(route)).toBe(
      '#agent-portfolio?account=synthetic-account&view=account&tab=plan',
    )
  })
})
