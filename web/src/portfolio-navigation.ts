export const PORTFOLIO_TABS = [
  'plan',
  'risk',
  'agent',
  'local-model',
  'jev',
  'trading-agent',
  'scenarios',
  'automation',
  'next-open',
  'performance',
  'ledger',
] as const
export type WorkspaceTab = (typeof PORTFOLIO_TABS)[number]
export const PORTFOLIO_VIEWS = ['account', 'inbox', 'comparison', 'alpaca'] as const
export type PortfolioView = (typeof PORTFOLIO_VIEWS)[number]
export type PortfolioRoute = {
  accountId: string | null
  view: PortfolioView
  tab: WorkspaceTab
}
export type PortfolioRouteRequest = PortfolioRoute & {
  invalid: ('account' | 'view' | 'tab')[]
}

export const validPortfolioAccountId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)

/** The fragment stays in this browser; no form values or object-selection IDs belong here. */
export function parsePortfolioHash(
  hash: string,
  legacyAlpaca = false,
): PortfolioRouteRequest | null {
  const [page, ...query] = hash.replace(/^#/, '').split('?')
  if (page !== 'agent-portfolio') return null
  const params = new URLSearchParams(query.join('?'))
  const invalid: PortfolioRouteRequest['invalid'] = []
  const single = (key: 'account' | 'view' | 'tab') => {
    const values = params.getAll(key)
    if (values.length > 1) {
      invalid.push(key)
      return null
    }
    return values[0] ?? null
  }
  const rawAccount = single('account')
  const rawView = single('view')
  const rawTab = single('tab')
  const accountId = rawAccount !== null && validPortfolioAccountId(rawAccount) ? rawAccount : null
  if (rawAccount !== null && accountId === null) invalid.push('account')
  const view = PORTFOLIO_VIEWS.find((item) => item === rawView)
  const tab = PORTFOLIO_TABS.find((item) => item === rawTab)
  if (rawView !== null && !view) invalid.push('view')
  if (rawTab !== null && !tab) invalid.push('tab')
  return {
    accountId,
    view: view ?? (legacyAlpaca && !params.has('view') ? 'alpaca' : 'account'),
    tab: tab ?? 'plan',
    invalid,
  }
}

export function portfolioHash(route: PortfolioRoute): string {
  const params = new URLSearchParams()
  if (route.accountId && validPortfolioAccountId(route.accountId))
    params.set('account', route.accountId)
  params.set('view', PORTFOLIO_VIEWS.includes(route.view) ? route.view : 'account')
  params.set('tab', PORTFOLIO_TABS.includes(route.tab) ? route.tab : 'plan')
  return `#agent-portfolio?${params.toString()}`
}

export function resolvePortfolioRoute(
  request: PortfolioRouteRequest,
  accountIds: readonly string[],
  remembered: string,
): PortfolioRoute & { notice: 'invalid' | 'stale-account' | null } {
  const stale = !!request.accountId && !accountIds.includes(request.accountId)
  const fallback = accountIds.includes(remembered) ? remembered : accountIds[0] || null
  return {
    accountId: request.accountId && !stale ? request.accountId : fallback,
    view: request.view,
    tab: request.tab,
    notice: request.invalid.length ? 'invalid' : stale ? 'stale-account' : null,
  }
}
