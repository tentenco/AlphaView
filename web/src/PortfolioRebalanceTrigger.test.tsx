import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RebalanceTriggerEditor, RebalanceTriggerTrace } from './PortfolioRebalanceTrigger'
import { disabledTrigger, type TriggerEvidence } from './rebalance-trigger'

const t = (_zh: string, en: string) => en
afterEach(() => sessionStorage.clear())

describe('rebalance trigger review', () => {
  it('preserves a dirty draft on a version change and requires explicit reload', async () => {
    const user = userEvent.setup()
    const mandate = { id: 'synthetic-task', version: 1, rebalance_trigger: disabledTrigger }
    const props = { mandate, t, onChanged: vi.fn() }
    const { rerender } = render(<RebalanceTriggerEditor {...props} />)
    await user.click(screen.getByText('Rebalance thresholds and interval'))
    await user.click(screen.getByRole('checkbox', { name: 'Require a minimum allocation drift' }))
    const drift = screen.getByLabelText(
      'Minimum largest allocation drift (percentage points)',
    ) as HTMLInputElement
    await user.type(drift, '7')
    rerender(<RebalanceTriggerEditor {...props} mandate={{ ...mandate, version: 2 }} />)
    expect(drift.value).toBe('7')
    expect(
      (screen.getByRole('button', { name: 'Save rebalance settings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Load latest settings' }))
    expect(
      screen.queryByLabelText('Minimum largest allocation drift (percentage points)'),
    ).toBeNull()
  })

  it('updates the whole policy with the draft version and keeps the disabled key explicit', async () => {
    const requests: unknown[] = []
    const policy = {
      min_weight_drift_pp: 0,
      min_completed_sessions_between_fills: null,
      regime_change: { enabled: false, min_band_change: 1 },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)))
        return {
          ok: true,
          json: async () => ({ mandate: { version: 2, rebalance_trigger: policy } }),
        }
      }),
    )
    const onChanged = vi.fn()
    const user = userEvent.setup()
    render(
      <RebalanceTriggerEditor
        mandate={{ id: 'synthetic-task', version: 1, rebalance_trigger: disabledTrigger }}
        t={t}
        onChanged={onChanged}
      />,
    )
    await user.click(screen.getByText('Rebalance thresholds and interval'))
    await user.click(screen.getByRole('checkbox', { name: 'Require a minimum allocation drift' }))
    await user.type(
      screen.getByLabelText('Minimum largest allocation drift (percentage points)'),
      '0',
    )
    await user.click(screen.getByRole('button', { name: 'Save rebalance settings' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(requests).toEqual([{ expected_version: 1, rebalance_trigger: policy }])
  })

  it('shows skip reasons, cash drift and a lower bound without inventing an exact interval', async () => {
    const evidence: TriggerEvidence = {
      engine_version: 'alphaview-rebalance-trigger-v1',
      policy: disabledTrigger,
      outcome: 'skip',
      reason_codes: ['drift_below_threshold'],
      max_weight_drift_pp: 1,
      components: [
        {
          kind: 'cash',
          symbol: null,
          current_weight_pct: 21,
          target_weight_pct: 20,
          difference_pp: 1,
        },
      ],
      last_fill: {
        proposal_id: 'synthetic-fill',
        execution_session: '2026-09-01',
        recorded_at: '2026-09-01T21:00:00Z',
      },
      completed_sessions_since_last_fill: null,
      completed_sessions_lower_bound: 5,
      elapsed_sessions_exact: false,
      checks: [],
      method: 'Synthetic method',
    }
    render(<RebalanceTriggerTrace evidence={evidence} t={t} />)
    await userEvent.click(screen.getByText(/Rebalance decision/))
    expect(screen.getByText('Allocation drift is below the threshold')).toBeTruthy()
    expect(screen.getByText('Cash')).toBeTruthy()
    expect(screen.getByText('≥ 5')).toBeTruthy()
  })
})
