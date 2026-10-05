import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchEvidenceCapacity } from './ResearchEvidenceCapacity'

const accountId = 'a'.repeat(32)
const props = { accountId, accountVersion: 3, t: (_zh: string, en: string) => en }
const url = `/api/paper/accounts/${accountId}/research-evidence-capacity`
const read = () => screen.getByRole('button', { name: 'Read receipt capacity' })
const result = () => screen.queryByLabelText('Receipt capacity result')
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
function scope(kind: 'account' | 'workspace', count: number, limit: number) {
  return {
    scope: kind,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    over_limit: count > limit,
    reason: null,
  }
}
function fixture() {
  return {
    engine_version: 'alphaview-research-evidence-capacity-v1',
    account_id: accountId,
    account_version: 3,
    as_of: '2026-10-01',
    input_revision: 'synthetic:42',
    families: [
      {
        family: 'allocation_research_receipts',
        account: scope('account', 0, 50),
        workspace: scope('workspace', 2, 500),
      },
      {
        family: 'research_integrity_receipts',
        account: {
          scope: 'account',
          count: null,
          limit: null,
          remaining: null,
          over_limit: null,
          reason: 'workspace_scoped_family',
        },
        workspace: scope('workspace', 0, 500),
      },
      {
        family: 'workflow_path_receipts',
        account: scope('account', 50, 50),
        workspace: scope('workspace', 250, 250),
      },
      {
        family: 'execution_study_receipts',
        account: scope('account', 51, 50),
        workspace: scope('workspace', 251, 250),
      },
    ],
    integrity: { assessed: false, available: null, reason: 'not_assessed' },
    policy: {
      read_only: true,
      save_authorized: false,
      delete_authorized: false,
      export_frees_capacity: false,
    },
  }
}
function cells(family: string, label: string) {
  const article = screen.getByRole('article', { name: family })
  const area = within(article).getByRole('region', { name: label })
  return {
    area,
    count: within(area).getByText('Stored count').nextElementSibling?.textContent,
    limit: within(area).getByText('Count limit').nextElementSibling?.textContent,
    remaining: within(area).getByText('Remaining count').nextElementSibling?.textContent,
    over: within(area).getByText('Above count limit').nextElementSibling?.textContent,
  }
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ResearchEvidenceCapacity', () => {
  it('waits for explicit keyboard action and renders known zero, separate scopes, full and over-limit values', async () => {
    vi.mocked(fetch).mockResolvedValue(response(fixture()))
    render(<ResearchEvidenceCapacity {...props} />)
    expect(fetch).not.toHaveBeenCalled()
    expect(result()).toBeNull()
    await userEvent.tab()
    expect(document.activeElement).toBe(read())
    await userEvent.keyboard('{Enter}')
    await screen.findByLabelText('Receipt capacity result')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(cells('Allocation research receipts', 'This account')).toMatchObject({
      count: '0',
      limit: '50',
      remaining: '50',
      over: 'No',
    })
    expect(cells('Allocation research receipts', 'Whole workspace')).toMatchObject({
      count: '2',
      limit: '500',
      remaining: '498',
      over: 'No',
    })
    expect(cells('Research integrity diagnostic receipts', 'This account')).toMatchObject({
      count: '—',
      limit: '—',
      remaining: '—',
      over: '—',
    })
    expect(cells('Research integrity diagnostic receipts', 'Whole workspace')).toMatchObject({
      count: '0',
      limit: '500',
      remaining: '500',
      over: 'No',
    })
    expect(screen.getByText(/no account association or account limit/)).toBeTruthy()
    expect(cells('Workflow path receipts', 'This account')).toMatchObject({
      count: '50',
      remaining: '0',
      over: 'No',
    })
    expect(cells('Execution study receipts', 'This account')).toMatchObject({
      count: '51',
      remaining: '0',
      over: 'Yes',
    })
    expect(cells('Execution study receipts', 'Whole workspace')).toMatchObject({
      count: '251',
      remaining: '0',
      over: 'Yes',
    })
    expect(
      screen.getByText(/Integrity is not assessed; exporting does not free capacity/),
    ).toBeTruthy()
    expect(screen.getByText(/Remaining slots do not grant permission to save/)).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('link')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves unknown limits as dashes with their reason while keeping known counts', async () => {
    const value = fixture()
    Object.assign(value.families[0].workspace, {
      limit: null,
      remaining: null,
      over_limit: null,
      reason: 'limit_unavailable',
    })
    vi.mocked(fetch).mockResolvedValue(response(value))
    render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    await screen.findByLabelText('Receipt capacity result')
    expect(cells('Allocation research receipts', 'Whole workspace')).toMatchObject({
      count: '2',
      limit: '—',
      remaining: '—',
      over: '—',
    })
    expect(screen.getByText(/remaining capacity is unknown/)).toBeTruthy()
  })

  it('guards duplicate clicks and clears old output immediately on a refresh failure', async () => {
    let reject!: (error: Error) => void
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(fixture()))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise
          }),
      )
    render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    await screen.findByLabelText('Receipt capacity result')
    fireEvent.click(read())
    fireEvent.click(read())
    expect(result()).toBeNull()
    expect(read()).toHaveProperty('disabled', true)
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => reject(new Error('Synthetic read failure')))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Synthetic read failure')
    expect(result()).toBeNull()
    expect(read()).toHaveProperty('disabled', false)
  })

  it('clears errors after a successful explicit retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(fixture()))
    render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not read receipt capacity (503)',
    )
    fireEvent.click(read())
    await screen.findByLabelText('Receipt capacity result')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['account', 'version', 'disabled', 'pagehide', 'unmount'] as const)(
    'aborts and rejects a late response after %s changes',
    async (change) => {
      let finish!: (value: Response) => void
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const view = render(<ResearchEvidenceCapacity {...props} />)
      fireEvent.click(read())
      const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
      if (change === 'account')
        view.rerender(<ResearchEvidenceCapacity {...props} accountId={'b'.repeat(32)} />)
      if (change === 'version')
        view.rerender(<ResearchEvidenceCapacity {...props} accountVersion={4} />)
      if (change === 'disabled')
        view.rerender(<ResearchEvidenceCapacity {...props} enabled={false} />)
      if (change === 'pagehide') fireEvent(window, new Event('pagehide'))
      if (change === 'unmount') view.unmount()
      expect(signal?.aborted).toBe(true)
      await act(async () => finish(response(fixture())))
      expect(result()).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('does not let an older account response replace a newer account result', async () => {
    let finish!: (value: Response) => void
    const nextId = 'b'.repeat(32)
    const next = { ...fixture(), account_id: nextId, input_revision: 'synthetic:new' }
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce(response(next))
    const view = render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    view.rerender(<ResearchEvidenceCapacity {...props} accountId={nextId} />)
    fireEvent.click(read())
    await screen.findByText('synthetic:new')
    await act(async () => finish(response(fixture())))
    expect(screen.getByText('synthetic:new')).toBeTruthy()
    expect(screen.queryByText('synthetic:42')).toBeNull()
  })

  it.each([
    'account',
    'version',
    'family',
    'partial',
    'scope',
    'count',
    'remaining',
    'over',
    'null_reason',
    'integrity',
    'policy',
  ] as const)('rejects a malformed %s response without showing partial totals', async (change) => {
    const value = fixture()
    if (change === 'account') value.account_id = 'b'.repeat(32)
    if (change === 'version') value.account_version++
    if (change === 'family') value.families[1].family = value.families[0].family
    if (change === 'partial') value.families.pop()
    if (change === 'scope') value.families[0].workspace.scope = 'account'
    if (change === 'count') value.families[0].workspace.count = -1
    if (change === 'remaining') value.families[0].workspace.remaining = 499
    if (change === 'over') value.families[0].workspace.over_limit = true
    if (change === 'null_reason')
      Object.assign(value.families[0].workspace, {
        limit: null,
        remaining: null,
        over_limit: null,
        reason: null,
      })
    if (change === 'integrity') value.integrity.assessed = true
    if (change === 'policy') value.policy.save_authorized = true
    vi.mocked(fetch).mockResolvedValue(response(value))
    render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Capacity response account, version or scope mismatch. Read again.',
    )
    expect(result()).toBeNull()
  })

  it('does not fetch with an empty account or invalid version', () => {
    const view = render(<ResearchEvidenceCapacity {...props} accountId="" />)
    fireEvent.click(read())
    expect(read()).toHaveProperty('disabled', true)
    view.rerender(<ResearchEvidenceCapacity {...props} accountVersion={0} />)
    fireEvent.click(read())
    expect(read()).toHaveProperty('disabled', true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('clears a previously accepted summary on account-version change without automatic polling', async () => {
    vi.mocked(fetch).mockResolvedValue(response(fixture()))
    const view = render(<ResearchEvidenceCapacity {...props} />)
    fireEvent.click(read())
    await screen.findByLabelText('Receipt capacity result')
    view.rerender(<ResearchEvidenceCapacity {...props} accountVersion={4} />)
    await waitFor(() => expect(result()).toBeNull())
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
