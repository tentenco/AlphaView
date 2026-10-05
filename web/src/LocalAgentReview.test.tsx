import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAgentReview, type ReviewContext, type ReviewEvent } from './LocalAgentReview'
import type { LocalAgentRun } from './local-agent-model'
import type { PaperAccount } from './paper-model'

const t = (_zh: string, en: string) => en
const account = {
  id: 'synthetic-account',
  name: 'SYNTHETIC review account',
  version: 1,
  limits: {},
} as PaperAccount
const run = {
  id: 'synthetic-analysis',
  source_run_id: 'synthetic-workflow',
  engine_version: 'alphaview-local-agent-v1',
  current: true,
  stale_reasons: [],
  status: 'completed',
  as_of: '2026-10-01',
  input_revision: 'synthetic:1',
  prompt_digest: 'p',
  schema_digest: 's',
  result: { output_digest: 'output-1' },
  target_weights: [],
} as unknown as LocalAgentRun
const version = 'alphaview-local-agent-review-v1'
function context(): ReviewContext {
  const program = {
    integrity_version: 'alphaview-local-agent-integrity-v1',
    evidence_status: 'verified' as const,
    verified: true,
    source_currentness: { current: true, stale_reasons: [] },
    proposal_eligible: true,
    paper_preview_required: true as const,
    validation_issues: [],
    uncertainty_codes: [],
  }
  return {
    engine_version: version,
    account_id: account.id,
    analysis_id: run.id,
    binding_fingerprint: 'a'.repeat(64),
    binding: {
      engine_version: version,
      account_id: account.id,
      account_version: 1,
      analysis_id: run.id,
      analysis_engine_version: run.engine_version,
      source_run_id: run.source_run_id,
      as_of: '2026-10-01',
      input_revision: 'synthetic:1',
      analysis_content_fingerprint: 'b'.repeat(64),
      rule_content_fingerprint: 'c'.repeat(64),
      program,
    },
    program,
    can_review: true,
    unavailable_reason: null,
    version: 0,
    latest: null,
    effective_state: 'review_required',
    review_current: false,
    review_reason: 'no_review',
  }
}
function event(value = context(), n = 1): ReviewEvent {
  return {
    id: `synthetic-event-${n}`,
    engine_version: version,
    account_id: account.id,
    analysis_id: run.id,
    version: n,
    created_at: '2026-10-01T22:00:00Z',
    binding_fingerprint: value.binding_fingerprint,
    content_fingerprint: 'd'.repeat(64),
    integrity: { available: true, reason: null },
    receipt: {
      id: `synthetic-event-${n}`,
      engine_version: version,
      account_id: account.id,
      analysis_id: run.id,
      version: n,
      created_at: '2026-10-01T22:00:00Z',
      binding_fingerprint: value.binding_fingerprint,
      binding: value.binding,
      state: 'reviewed',
      reason_codes: [],
    },
  }
}
function saved(value = context()): ReviewContext {
  return {
    ...value,
    version: 1,
    latest: event(value),
    effective_state: 'reviewed',
    review_current: true,
    review_reason: null,
  }
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const load = () => userEvent.click(screen.getByRole('button', { name: 'Load review status' }))
const save = () => screen.getByRole('button', { name: 'Save review annotation' })
function mockApi(value = context()) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    (() => {
      if (init?.method !== 'POST') return response(value)
      const body = JSON.parse(String(init.body))
      const result = saved(value)
      result.effective_state = body.state
      result.latest!.receipt!.state = body.state
      result.latest!.receipt!.reason_codes = body.reason_codes
      return response(result)
    })(),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('independent local model human review', () => {
  it('loads only on demand, records versioned fixed reasons, never calls model or proposal endpoints', async () => {
    const fetcher = mockApi()
    render(<LocalAgentReview account={account} run={run} t={t} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/Reviewed is not verified or approved/)).toBeTruthy()
    await load()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Human judgment' }),
      'reviewed',
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Model limitations' }))
    await userEvent.click(save())
    await screen.findByText(/Review annotation saved/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, options] = fetcher.mock.calls[1]
    expect(url).toBe(`/api/paper/accounts/${account.id}/local-agent/${run.id}/review`)
    expect(options?.method).toBe('POST')
    expect(JSON.parse(String(options?.body))).toEqual({
      expected_version: 0,
      expected_account_version: 1,
      expected_input_revision: 'synthetic:1',
      expected_as_of: '2026-10-01',
      expected_binding_fingerprint: 'a'.repeat(64),
      state: 'reviewed',
      reason_codes: ['model_limitations'],
      idempotency_key: expect.any(String),
    })
    expect(screen.getByText(/Current human status: Reviewed/)).toBeTruthy()
  })

  it('keeps failed program evidence visible after reviewed, with no eligibility override', async () => {
    const value = context()
    Object.assign(value.program, {
      evidence_status: 'failed',
      verified: false,
      proposal_eligible: false,
      uncertainty_codes: ['result_replay_mismatch'],
    })
    mockApi(value)
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    await userEvent.selectOptions(screen.getByRole('combobox'), 'reviewed')
    await userEvent.click(save())
    await screen.findByText(/Review annotation saved/)
    expect(screen.getByText(/Independent program evidence: Failed/)).toBeTruthy()
    expect(screen.getByText(/Program proposal eligibility: Ineligible/)).toBeTruthy()
    expect(screen.getByText('result_replay_mismatch')).toBeTruthy()
  })

  it('requires a concern for rejection and preserves dirty draft through manual refresh', async () => {
    const fetcher = mockApi()
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    await userEvent.selectOptions(screen.getByRole('combobox'), 'rejected')
    expect((save() as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Allocation concern' }))
    await load()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('rejected')
    expect(
      (screen.getByRole('checkbox', { name: 'Allocation concern' }) as HTMLInputElement).checked,
    ).toBe(true)
    await userEvent.click(save())
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).reason_codes).toEqual([
      'allocation_concern',
    ])
  })

  it('guards double submission synchronously and keeps the exact idempotency key after an uncertain network result', async () => {
    const fetcher = mockApi()
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    await userEvent.selectOptions(screen.getByRole('combobox'), 'reviewed')
    let reject!: (error: Error) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    fireEvent.click(save())
    fireEvent.click(save())
    expect(fetcher).toHaveBeenCalledTimes(2)
    const firstBody = fetcher.mock.calls[1][1]?.body
    await act(async () => reject(new Error('synthetic connection loss')))
    await screen.findByRole('alert')
    expect(screen.queryByText(/Review annotation saved/)).toBeNull()
    await userEvent.click(save())
    await screen.findByText(/Review annotation saved/)
    expect(fetcher.mock.calls[2][1]?.body).toBe(firstBody)
  })

  it('clears actionable context on 409 without false success', async () => {
    const fetcher = mockApi()
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    fetcher.mockResolvedValueOnce(response({ detail: { code: 'review_context_changed' } }, 409))
    await userEvent.click(save())
    expect((await screen.findByRole('alert')).textContent).toContain('review_context_changed')
    expect(screen.queryByRole('button', { name: 'Save review annotation' })).toBeNull()
    expect(screen.queryByText(/Review annotation saved/)).toBeNull()
  })

  it.each(['account', 'account-version', 'source', 'output', 'lifecycle'] as const)(
    'invalidates prior loaded evidence on %s change and never auto-fetches',
    async (change) => {
      const fetcher = mockApi(saved())
      const view = render(<LocalAgentReview account={account} run={run} t={t} />)
      await load()
      expect(screen.getByText(/Current human status: Reviewed/)).toBeTruthy()
      const nextAccount =
        change === 'account'
          ? { ...account, id: 'other-synthetic-account' }
          : change === 'account-version'
            ? { ...account, version: 2 }
            : account
      const nextRun =
        change === 'source'
          ? { ...run, input_revision: 'synthetic:2' }
          : change === 'output'
            ? { ...run, result: { ...run.result!, output_digest: 'output-2' } }
            : run
      view.rerender(
        <LocalAgentReview
          account={nextAccount}
          run={nextRun}
          enabled={change !== 'lifecycle'}
          t={t}
        />,
      )
      expect(screen.queryByText(/Current human status/)).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
      if (change === 'lifecycle') {
        view.rerender(<LocalAgentReview account={account} run={run} enabled t={t} />)
        expect(screen.queryByText(/Current human status/)).toBeNull()
      }
    },
  )

  it('aborts an old account request and ignores a response arriving after navigation', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<ReturnType<typeof response>>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    const signal = fetcher.mock.calls[0][1]?.signal
    view.rerender(
      <LocalAgentReview account={{ ...account, id: 'synthetic-other' }} run={run} t={t} />,
    )
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve(response(saved())))
    expect(screen.queryByText(/Current human status/)).toBeNull()
  })

  it('rejects a different-account response before showing actionable evidence', async () => {
    mockApi({ ...context(), account_id: 'wrong-synthetic-account' })
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'review_response_identity_mismatch',
    )
    expect(screen.queryByRole('button', { name: 'Save review annotation' })).toBeNull()
  })

  it('shows source-changed review_required even when history was reviewed', async () => {
    mockApi({
      ...saved(),
      binding_fingerprint: 'e'.repeat(64),
      effective_state: 'review_required',
      review_current: false,
      review_reason: 'source_changed',
    })
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    expect(screen.getByText(/Current human status: Review required/)).toBeTruthy()
    expect(screen.getByText(/Source or account context changed/)).toBeTruthy()
  })

  it('shows corrupt history as unavailable without falling back or enabling overwrite', async () => {
    const value = saved()
    value.latest = {
      ...value.latest!,
      integrity: { available: false, reason: 'review_event_unverifiable' },
      receipt: null,
    }
    Object.assign(value, {
      effective_state: 'review_required',
      review_current: false,
      review_reason: 'review_history_unavailable',
    })
    mockApi(value)
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    expect(screen.getByText(/latest history event cannot be verified/)).toBeTruthy()
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
    expect(screen.getByText(/Independent program evidence: Verified/)).toBeTruthy()
  })

  it('keeps active analyses unreviewable', async () => {
    mockApi({ ...context(), can_review: false, unavailable_reason: 'analysis_still_active' })
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await load()
    expect(screen.getByText('analysis_still_active')).toBeTruthy()
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
  })

  it('loads history only on demand, paginates, and displays saved context with no currentness inference', async () => {
    const first = Array.from({ length: 20 }, (_, index) => event(context(), 21 - index))
    first[0] = {
      ...first[0],
      integrity: { available: false, reason: 'review_event_unverifiable' },
      receipt: null,
    }
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const offset = String(url).includes('offset=20') ? 20 : 0
      return response({
        engine_version: version,
        account_id: account.id,
        analysis_id: run.id,
        items: offset ? [event()] : first,
        pagination: { limit: 20, offset, total: 21, returned: offset ? 1 : 20 },
      })
    })
    vi.stubGlobal('fetch', fetcher)
    render(<LocalAgentReview account={account} run={run} t={t} />)
    await userEvent.click(screen.getByRole('button', { name: 'Load review history' }))
    expect(await screen.findByText(/Immutable review history/)).toBeTruthy()
    expect(screen.getByText(/Historical states describe their saved context only/)).toBeTruthy()
    expect(screen.getByText(/Historical evidence unavailable/)).toBeTruthy()
    expect(screen.getAllByText('Inspect saved review context')).toHaveLength(19)
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getAllByText('Inspect saved review context')).toHaveLength(1))
    expect(String(fetcher.mock.calls[1][0])).toContain('/reviews?limit=20&offset=20')
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    const article = screen.getByRole('article')
    expect(within(article).getByText(/v1 · Reviewed/)).toBeTruthy()
    expect(screen.queryByText(/Current human status/)).toBeNull()
  })
})

it('does not confirm a save when the returned annotation differs from the submitted judgment', async () => {
  const fetcher = mockApi()
  render(<LocalAgentReview account={account} run={run} t={t} />)
  await load()
  await userEvent.selectOptions(screen.getByRole('combobox'), 'rejected')
  await userEvent.click(screen.getByRole('checkbox', { name: 'Evidence uncertainty' }))
  fetcher.mockResolvedValueOnce(response(saved()))
  await userEvent.click(save())
  expect((await screen.findByRole('alert')).textContent).toContain(
    'review_response_identity_mismatch',
  )
  expect(screen.queryByText(/Review annotation saved/)).toBeNull()
  expect(screen.queryByText(/Current human status/)).toBeNull()
})

it('does not render contradictory program eligibility as validated evidence', async () => {
  const value = context()
  value.program.proposal_eligible = false
  mockApi(value)
  render(<LocalAgentReview account={account} run={run} t={t} />)
  await load()
  expect((await screen.findByRole('alert')).textContent).toContain(
    'review_response_identity_mismatch',
  )
  expect(screen.queryByText(/Independent program evidence: Verified/)).toBeNull()
})
