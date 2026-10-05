import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortfolioSymbolPolicy } from './PortfolioSymbolPolicy'
import type { PaperSnapshot, PaperSymbolPolicy } from './paper-model'

const policy: PaperSymbolPolicy = {
  engine_version: 'alphaview-paper-symbol-policy-v1',
  version: 1,
  mode: 'unrestricted',
  symbols: [],
}
const snapshot = {
  account: { id: 'synthetic-policy', version: 1, symbol_policy: policy },
} as PaperSnapshot
function mockFetch(updated?: PaperSnapshot) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'PATCH') return new Response(JSON.stringify(updated), { status: 200 })
    return new Response(
      JSON.stringify({ items: [{ policy, created_at: '2026-09-29T00:00:00Z' }] }),
      { status: 200 },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('symbol policy controls', () => {
  it('previews explicit empty restriction and saves using the account version', async () => {
    const updated = {
      account: {
        ...snapshot.account,
        version: 2,
        symbol_policy: { ...policy, version: 2, mode: 'allowlist' },
      },
    } as PaperSnapshot
    const fetchMock = mockFetch(updated)
    const onUpdated = vi.fn()
    const user = userEvent.setup()
    render(<PortfolioSymbolPolicy snapshot={snapshot} locale="en" onUpdated={onUpdated} />)
    expect(
      (screen.getByRole('button', { name: 'Save symbol policy' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await user.selectOptions(screen.getByLabelText('Symbol scope'), 'allowlist')
    expect(
      screen.getByText(
        'An empty list blocks all share increases; existing holdings may be reduced.',
      ),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save symbol policy' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated))
    const request = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      expected_version: 1,
      symbol_policy: { mode: 'allowlist', symbols: [] },
    })
  })

  it('normalizes allowed entries and rejects duplicate symbols', async () => {
    const fetchMock = mockFetch({
      account: {
        ...snapshot.account,
        version: 2,
        symbol_policy: { ...policy, version: 2, mode: 'allowlist', symbols: ['SYNTA', 'SYNTB'] },
      },
    } as PaperSnapshot)
    const user = userEvent.setup()
    render(<PortfolioSymbolPolicy snapshot={snapshot} locale="en" onUpdated={vi.fn()} />)
    await user.selectOptions(screen.getByLabelText('Symbol scope'), 'allowlist')
    const input = screen.getByLabelText('Allowed symbols (one per line, up to 100)')
    await user.type(input, ' syntb\nsynta\nSYNTA')
    expect(
      (screen.getByRole('button', { name: 'Save symbol policy' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('duplicated')
    await user.clear(input)
    await user.type(input, ' syntb\nsynta')
    expect(screen.getByLabelText('Policy change preview').textContent).toContain('SYNTA, SYNTB')
    await user.click(screen.getByRole('button', { name: 'Save symbol policy' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true),
    )
    const request = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')
    expect(JSON.parse(String(request?.[1]?.body)).symbol_policy.symbols).toEqual(['SYNTA', 'SYNTB'])
  })

  it('preserves an edited draft on polling version change and requires explicit reload', async () => {
    mockFetch()
    const user = userEvent.setup()
    const onUpdated = vi.fn()
    const { rerender } = render(
      <PortfolioSymbolPolicy snapshot={snapshot} locale="en" onUpdated={onUpdated} />,
    )
    await user.selectOptions(screen.getByLabelText('Symbol scope'), 'allowlist')
    await user.type(screen.getByLabelText('Allowed symbols (one per line, up to 100)'), 'SYNTA')
    rerender(
      <PortfolioSymbolPolicy
        snapshot={{ ...snapshot, account: { ...snapshot.account, version: 2 } }}
        locale="en"
        onUpdated={onUpdated}
      />,
    )
    expect(
      (screen.getByLabelText('Allowed symbols (one per line, up to 100)') as HTMLTextAreaElement)
        .value,
    ).toBe('SYNTA')
    expect(screen.getByRole('status').textContent).toContain('draft is preserved')
    expect(
      (screen.getByRole('button', { name: 'Save symbol policy' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Load current symbol policy' }))
    expect((screen.getByLabelText('Symbol scope') as HTMLSelectElement).value).toBe('unrestricted')
  })

  it('shows revision history and reviewed removals in Traditional Chinese', async () => {
    mockFetch()
    const user = userEvent.setup()
    render(
      <PortfolioSymbolPolicy
        snapshot={{
          ...snapshot,
          account: {
            ...snapshot.account,
            symbol_policy: { ...policy, mode: 'allowlist', symbols: ['SYNTA', 'SYNTB'] },
          },
        }}
        locale="zh-TW"
        onUpdated={vi.fn()}
      />,
    )
    await user.clear(screen.getByLabelText('允許的標的（每行一個，最多 100 個）'))
    await user.type(screen.getByLabelText('允許的標的（每行一個，最多 100 個）'), 'SYNTB')
    expect(screen.getByLabelText('政策變更預覽').textContent).toContain('移除清單項目: SYNTA')
    await user.click(screen.getByText('政策版本紀錄'))
    await waitFor(() => expect(screen.getByText(/v1 ·/)).toBeTruthy())
    expect(screen.getByText('alphaview-paper-symbol-policy-v1')).toBeTruthy()
  })
})
