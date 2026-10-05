import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioAutomation } from './PortfolioAutomation'
import type { PaperAccount } from './paper-model'

const account: PaperAccount = {
  id: 'synthetic-account',
  name: 'Synthetic account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 1,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-20T03:00:00Z',
  updated_at: '2026-09-20T03:00:00Z',
}
const workflow = {
  scope: 'market',
  candidate_symbols: ['SYNTA'],
  strategy_weights: { turtle: 25, trend: 25, pullback: 25, rps: 25 },
  constraints: {
    min_score: 50,
    min_matches: 1,
    max_positions: 5,
    max_position_weight_pct: 25,
    cash_buffer_pct: 20,
  },
}
const mandate = {
  id: 'synthetic-mandate',
  name: 'Saved rules',
  account_id: account.id,
  account_name: account.name,
  workflow,
  enabled: false,
  mode: 'auto_simulate',
  version: 1,
  status: 'disabled',
  reason: null,
  latest_eligible_session: '2026-09-18',
  next_due_at: null,
  last_checked_at: null,
  last_attempt: null,
  current_attempt: null,
}
function install(mandates: unknown[] = [mandate], attempts: unknown[] = []) {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (body) requests.push({ url: input, body })
      let result: unknown
      if (input === '/api/agent-automation/state')
        result = {
          mandates,
          as_of: '2026-09-18',
          poll_interval_seconds: 60,
          method: 'Synthetic method',
          warnings: [],
        }
      else if (input.includes('/attempts')) result = { attempts }
      else if (input.endsWith('/run'))
        result = { status: 'waiting', reason: 'Synthetic source wait' }
      else if (input === '/api/agent-automation/mandates') result = { mandate }
      else if (input.startsWith('/api/portfolio-agent/runs?'))
        result = {
          runs: [
            {
              id: 'synthetic-run',
              created_at: '2026-09-20T03:00:00Z',
              scope: 'market',
              coverage: { requested: 1 },
            },
          ],
        }
      else if (input === '/api/portfolio-agent/runs/synthetic-run') result = { request: workflow }
      else result = {}
      return { ok: true, json: async () => result }
    }),
  )
  return requests
}
afterEach(() => sessionStorage.clear())

describe('local paper automation controls', () => {
  const outcomeGuard = {
    engine_version: 'alphaview-automation-outcome-guard-v1',
    as_of: '2026-09-18',
    status: 'low',
    manual_review: true,
    downgraded: true,
    requested_mode: 'auto_simulate',
    effective_mode: 'proposal_only',
    relevant_families: ['agent_targets'],
    low_families: ['agent_targets'],
    horizon_sessions: 10,
    window_sessions: 252,
    required_settled: 20,
    low_threshold: 0.4,
    flags: [{ family: 'agent_targets', n_settled: 20, hit_rate: 0.2, status: 'low' }],
  }
  const outcomeAttempt = {
    id: 'synthetic-attempt',
    session_date: '2026-09-18',
    mandate_version: 1,
    account_version: 1,
    status: 'proposed',
    mode: 'proposal_only',
    trigger_kind: 'schedule',
    started_at: '2026-09-19T00:00:00Z',
    finished_at: '2026-09-19T00:00:01Z',
    run_id: 'synthetic-run',
    paper_proposal_id: 'synthetic-proposal',
    reason: null,
    result: { outcome_guard: outcomeGuard },
  }

  it('shows review-only evidence in the current task and saved attempt history', async () => {
    install(
      [{ ...mandate, enabled: true, status: 'proposed', current_attempt: outcomeAttempt }],
      [outcomeAttempt],
    )
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await waitFor(() =>
      expect(screen.getAllByText(/Outcome evidence · Relevant source family/)).toHaveLength(2),
    )
    expect(screen.getAllByText(/This attempt requires manual review/)).toHaveLength(2)
    expect(
      screen.getAllByText(/Rule-workflow target changes · Settled 20 · Hit rate 20/),
    ).toHaveLength(2)
    expect(screen.getAllByText(/source families across the workspace/)).toHaveLength(2)
    expect(screen.getAllByText(/Frozen for session 2026-09-18/)).toHaveLength(2)
  })

  it('distinguishes unavailable evidence from a low hit rate without filling in zero', async () => {
    const attempt = {
      ...outcomeAttempt,
      result: {
        outcome_guard: { ...outcomeGuard, status: 'unavailable', flags: [], low_families: [] },
      },
    }
    install([{ ...mandate, current_attempt: attempt }])
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await screen.findByText('Outcome evidence · Outcome evidence unavailable')
    expect(screen.getByText(/Hit rate —. Unavailable evidence is not classified/)).toBeTruthy()
    expect(screen.queryByText(/Hit rate 0/)).toBeNull()
    expect(screen.queryByText(/Relevant source family has a low hit rate/)).toBeNull()
  })

  it('keeps zero settled observations distinct from a zero-percent hit rate', async () => {
    const attempt = {
      ...outcomeAttempt,
      result: {
        outcome_guard: {
          ...outcomeGuard,
          status: 'insufficient',
          manual_review: false,
          downgraded: false,
          effective_mode: 'auto_simulate',
          low_families: [],
          flags: [
            { family: 'agent_targets', n_settled: 0, hit_rate: null, status: 'insufficient' },
          ],
        },
      },
    }
    install([{ ...mandate, current_attempt: attempt }])
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    const summary = await screen.findByText('Outcome evidence · Insufficient settled samples')
    await userEvent.click(summary)
    expect(screen.getByText(/Rule-workflow target changes · Settled 0 · Hit rate —/)).toBeTruthy()
    expect(screen.getByText(/Insufficient samples alone do not downgrade/)).toBeTruthy()
    expect(screen.queryByText(/This attempt requires manual review/)).toBeNull()
  })

  it('does not overlap state polls while a slower request is still pending', async () => {
    install()
    const fetcher = vi.mocked(fetch)
    const fallback = fetcher.getMockImplementation()!
    let stateReads = 0
    let finish: ((value: Response) => void) | undefined
    let poll: (() => void) | undefined
    const setInterval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay !== 15000) return setInterval(callback, delay)
      poll = () => {
        if (typeof callback === 'function') callback()
      }
      return 123
    })
    fetcher.mockImplementation((url, init) => {
      if (String(url) === '/api/agent-automation/state' && ++stateReads === 1)
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      return fallback(url, init)
    })
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await waitFor(() => expect(finish && poll).toBeTruthy())
    poll!()
    poll!()
    expect(stateReads).toBe(1)
    finish!({
      ok: true,
      json: async () => ({
        mandates: [{ ...mandate, version: 2, name: 'Latest synthetic rules' }],
      }),
    } as Response)
    await screen.findByRole('heading', { name: 'Latest synthetic rules' })
    poll!()
    await waitFor(() => expect(stateReads).toBe(2))
  })

  it.each(['task', 'account'] as const)(
    'invalidates manual simulation consent after a %s version change',
    async (changed) => {
      const mandates = [{ ...mandate }]
      const requests = install(mandates)
      const view = render(
        <PortfolioAutomation
          account={account}
          locale="en"
          onAccountChanged={() => {}}
          selectionNonce={1}
        />,
      )
      const consent = (await screen.findByRole('checkbox', {
        name: 'Allow this manual attempt to simulate after passing all limits.',
      })) as HTMLInputElement
      await userEvent.click(consent)
      mandates[0] = {
        ...mandate,
        version: changed === 'task' ? 2 : 1,
        name: 'Updated synthetic rules',
      }
      view.rerender(
        <PortfolioAutomation
          account={{ ...account, version: changed === 'account' ? 2 : 1 }}
          locale="en"
          onAccountChanged={() => {}}
          selectionNonce={2}
        />,
      )
      await screen.findByRole('heading', { name: 'Updated synthetic rules' })
      expect(consent.checked).toBe(false)
      await userEvent.click(screen.getByRole('button', { name: 'Run today’s rebalance check' }))
      await waitFor(() =>
        expect(requests[0]?.body).toEqual({
          expected_version: changed === 'task' ? 2 : 1,
          allow_auto_simulate: false,
        }),
      )
    },
  )

  it('requires a new review when the policy changes again after acknowledgement', async () => {
    const policy = {
      engine_version: 'alphaview-paper-symbol-policy-v1',
      version: 2,
      mode: 'allowlist',
      symbols: ['SYNTA'],
    }
    const mandates = [
      {
        ...mandate,
        symbol_policy_authorization: {
          status: 'stale',
          authorized_policy_version: 1,
          current_policy: policy,
          reason: 'Synthetic policy change',
        },
      },
    ]
    const requests = install(mandates)
    const view = render(
      <PortfolioAutomation
        account={account}
        locale="en"
        onAccountChanged={() => {}}
        selectionNonce={1}
      />,
    )
    const consent = (await screen.findByRole('checkbox', {
      name: /I reviewed this policy/,
    })) as HTMLInputElement
    await userEvent.click(consent)
    expect(
      (screen.getByRole('button', { name: 'Apply reviewed symbol policy' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    mandates[0] = {
      ...mandates[0],
      symbol_policy_authorization: {
        ...mandates[0].symbol_policy_authorization,
        current_policy: { ...policy, version: 3, symbols: ['SYNTB'] },
      },
    }
    view.rerender(
      <PortfolioAutomation
        account={{ ...account, version: 2 }}
        locale="en"
        onAccountChanged={() => {}}
        selectionNonce={2}
      />,
    )
    await screen.findByText('Symbols allowed for new exposure: SYNTB')
    expect(consent.checked).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Apply reviewed symbol policy' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('manual launch remains proposal-only until separately opted into simulation', async () => {
    const requests = install()
    const user = userEvent.setup()
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Run today’s rebalance check' }))
    await waitFor(() =>
      expect(requests[0]?.body).toEqual({ expected_version: 1, allow_auto_simulate: false }),
    )
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Allow this manual attempt to simulate after passing all limits.',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Run and auto simulate now' }))
    await waitFor(() => expect(requests[1]?.body.allow_auto_simulate).toBe(true))
  })

  it('creating an auto-simulation task requires acknowledgement and saves disabled', async () => {
    const requests = install([])
    const user = userEvent.setup()
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await user.type(await screen.findByLabelText('Task name'), 'Synthetic mandate')
    await user.selectOptions(screen.getByLabelText('Rules from saved run'), 'synthetic-run')
    await user.selectOptions(screen.getByLabelText('Execution mode'), 'auto_simulate')
    await screen.findByText('Candidate universe')
    expect(
      (screen.getByRole('button', { name: 'Save task with schedule off' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: /I understand this mode/ }))
    await user.click(screen.getByRole('button', { name: 'Save task with schedule off' }))
    await waitFor(() =>
      expect(requests[0]?.body).toMatchObject({
        enabled: false,
        mode: 'auto_simulate',
        account_id: account.id,
        workflow: {
          ...workflow,
          account_context: { account_id: account.id, expected_policy_version: 1 },
        },
        rebalance_trigger: {
          min_weight_drift_pp: null,
          min_completed_sessions_between_fills: null,
        },
      }),
    )
    expect(requests.some((request) => request.url.includes('/accept'))).toBe(false)
  })

  it('account pause disables manual execution and another account’s tasks stay hidden', async () => {
    const requests = install([
      mandate,
      { ...mandate, id: 'other', account_id: 'other-account', name: 'Other account task' },
    ])
    render(
      <PortfolioAutomation
        account={{ ...account, kill_switch: true }}
        locale="en"
        onAccountChanged={() => {}}
      />,
    )
    const button = await screen.findByRole('button', { name: 'Run today’s rebalance check' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Other account task')).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('saves both enabled thresholds and rejects incomplete trigger drafts', async () => {
    const requests = install([])
    const user = userEvent.setup()
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await user.type(await screen.findByLabelText('Task name'), 'Synthetic gated task')
    await user.selectOptions(screen.getByLabelText('Rules from saved run'), 'synthetic-run')
    await screen.findByText('Candidate universe')
    await user.click(screen.getByRole('checkbox', { name: 'Require a minimum allocation drift' }))
    const save = screen.getByRole('button', {
      name: 'Save task with schedule off',
    }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(
      screen.getByLabelText('Minimum largest allocation drift (percentage points)'),
      '5.5',
    )
    await user.click(screen.getByRole('checkbox', { name: 'Require a rebalance interval' }))
    expect(save.disabled).toBe(true)
    await user.type(screen.getByLabelText('Minimum completed sessions between fills'), '3')
    await user.click(save)
    await waitFor(() =>
      expect(requests[0]?.body.rebalance_trigger).toEqual({
        min_weight_drift_pp: 5.5,
        min_completed_sessions_between_fills: 3,
        regime_change: { enabled: false, min_band_change: 1 },
      }),
    )
  })

  it('opens the exact requested task instead of the first account task', async () => {
    install([mandate, { ...mandate, id: 'second-mandate', name: 'Exact inbox task' }])
    render(
      <PortfolioAutomation
        account={account}
        locale="en"
        onAccountChanged={() => {}}
        selectedMandateId="second-mandate"
        selectionNonce={1}
      />,
    )
    const title = await screen.findByRole('heading', { name: 'Exact inbox task' })
    expect(
      within(title.closest('section')!).getByRole('button', {
        name: 'Run today’s rebalance check',
      }),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Saved rules' })).toBeNull()
  })

  it('requires review before explicitly rebinding a task to the new symbol policy', async () => {
    const requests = install([
      {
        ...mandate,
        symbol_policy_authorization: {
          status: 'stale',
          authorized_policy_version: 1,
          current_policy: {
            engine_version: 'alphaview-paper-symbol-policy-v1',
            version: 2,
            mode: 'allowlist',
            symbols: ['SYNTA'],
          },
          reason: 'Synthetic policy update',
        },
      },
    ])
    const user = userEvent.setup()
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    const apply = (await screen.findByRole('button', {
      name: 'Apply reviewed symbol policy',
    })) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Run today’s rebalance check' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: /I reviewed this policy/ }))
    await user.click(apply)
    await waitFor(() =>
      expect(requests[0]?.body).toEqual({
        expected_version: 1,
        workflow: {
          ...workflow,
          account_context: { account_id: account.id, expected_policy_version: 2 },
        },
      }),
    )
  })

  it('a missing requested task does not show another task’s execution controls', async () => {
    install()
    const user = userEvent.setup()
    render(
      <PortfolioAutomation
        account={account}
        locale="en"
        onAccountChanged={() => {}}
        selectedMandateId="missing-mandate"
        selectionNonce={1}
      />,
    )
    await screen.findByText('The requested task is unavailable. Refresh the inbox.')
    expect(screen.queryByRole('button', { name: 'Run today’s rebalance check' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByText('The requested task is unavailable. Refresh the inbox.')
    expect(screen.queryByRole('button', { name: 'Run today’s rebalance check' })).toBeNull()
  })

  it('renews a task that requires re-authorization only with an explicit acknowledgement', async () => {
    const requests = install([
      {
        ...mandate,
        enabled: true,
        status: 'blocked',
        lifecycle: 'reauth_required',
        reauth_required: true,
        reauth_reason: 'circuit_breaker_tripped:max_fills_per_session',
        expires_on: null,
        sessions_remaining: null,
        lifecycle_message: 'Synthetic re-authorization message',
      },
    ])
    const user = userEvent.setup()
    render(<PortfolioAutomation account={account} locale="en" onAccountChanged={() => {}} />)
    await screen.findByText('Synthetic re-authorization message')
    expect(
      (screen.getByRole('button', { name: 'Run today’s rebalance check' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Re-authorize / renew' }))
    expect(
      (screen.getByRole('button', { name: 'Confirm renewal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.change(screen.getByLabelText('New expiry (session date; blank = none)'), {
      target: { value: '2026-10-15' },
    })
    await user.click(screen.getByRole('checkbox', { name: /I re-authorize this task/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm renewal' }))
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/renew'))).toBe(true),
    )
    const renew = requests.find((request) => request.url.endsWith('/renew'))!
    expect(renew.url).toBe(`/api/paper/accounts/${account.id}/mandates/${mandate.id}/renew`)
    expect(renew.body).toEqual({ expected_version: 1, expires_on: '2026-10-15', acknowledge: true })
  })
})
