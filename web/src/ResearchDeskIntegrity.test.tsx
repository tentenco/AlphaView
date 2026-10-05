import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchDeskIntegrity, type DeskIntegrityResult } from './ResearchDeskIntegrity'
import * as integrityDownload from './research-integrity-json'

afterEach(() => vi.unstubAllGlobals())
const t = (_zh: string, en: string) => en
const config = { strategy: 'sma_cross', params: { fast: 5, slow: 20 } } as const
const props = {
  symbol: 'SYNTA',
  config,
  testStart: '2024-01-02',
  testEnd: '2024-03-01',
  inputRevision: 'synthetic:1',
  fingerprint: 'synthetic-bars',
  t,
}
const result = (): DeskIntegrityResult => ({
  engine_version: 'alphaview-research-integrity-v1',
  as_of: '2024-03-01',
  input_revision: props.inputRevision,
  symbol: props.symbol,
  config,
  fingerprint: props.fingerprint,
  request: {
    symbol: props.symbol,
    config,
    test_start: props.testStart,
    test_end: props.testEnd,
    max_prefixes: 6,
  },
  status: 'no_difference_detected',
  fields: ['entry', 'exit', 'valid', 'close', 'sma_fast', 'sma_slow'],
  prefixes: [
    {
      cutoff_date: '2024-01-30',
      compared_start: '2024-01-02',
      compared_sessions: 20,
      difference_count: 0,
      unavailable_values: 0,
      invalid_signal_sessions: 0,
      status: 'no_difference_detected',
    },
  ],
  counts: {
    prefixes: 1,
    compared_session_pairs: 20,
    differences: 0,
    unavailable_values: 0,
    invalid_signal_sessions: 0,
  },
  differences: [],
  differences_truncated: false,
  unavailable: [],
  unavailable_values: [],
  unavailable_values_truncated: false,
  method: 'Synthetic sampled prefix comparison.',
})
const response = (body: unknown, status = 200, raw = JSON.stringify(body)) => ({
  ok: status === 200,
  status,
  json: async () => body,
  text: async () => raw,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Research Desk prefix integrity', () => {
  it('runs only on demand, binds the diagnosis and explains the sampling limit', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(result()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchDeskIntegrity {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/does not prove absence of future-data leakage/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect(
      await screen.findByRole('heading', { name: 'No differences in sampled prefixes' }),
    ).toBeTruthy()
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      symbol: props.symbol,
      config,
      test_start: props.testStart,
      test_end: props.testEnd,
      max_prefixes: 6,
    })
    expect(fetcher.mock.calls[0][0]).toBe('/api/research-desk/integrity')
    expect(
      within(screen.getByRole('table', { name: 'Results by cutoff' })).getByText('2024-01-30'),
    ).toBeTruthy()
  })

  it('renders exact differing values and missing coverage without calling it a pass', async () => {
    const data = result()
    data.status = 'differences_found'
    data.counts.differences = 1
    data.counts.unavailable_values = 1
    data.prefixes[0] = {
      ...data.prefixes[0],
      status: 'differences_found',
      difference_count: 1,
      unavailable_values: 1,
    }
    data.differences = [
      { prefix_end: '2024-01-30', date: '2024-01-25', field: 'entry', before: true, after: false },
    ]
    data.unavailable_values = [
      {
        prefix_end: '2024-01-30',
        date: '2024-01-26',
        field: 'sma_fast',
        before: null,
        after: 103.25,
        code: 'nonfinite_output',
      },
    ]
    data.unavailable = [
      { code: 'incomplete_signal_coverage', message: 'Synthetic missing coverage.' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(data)),
    )
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect(await screen.findByRole('heading', { name: 'Prefix differences detected' })).toBeTruthy()
    const table = within(screen.getByRole('table', { name: 'Signal and indicator details' }))
    expect(table.getByText('true')).toBeTruthy()
    expect(table.getByText('false')).toBeTruthy()
    expect(table.getByText('—')).toBeTruthy()
    expect(table.getByText('103.25')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'No differences in sampled prefixes' })).toBeNull()
  })

  it('shows unavailable history with no comparison rows', async () => {
    const data = {
      ...result(),
      status: 'unavailable',
      fingerprint: null,
      prefixes: [],
      counts: { ...result().counts, prefixes: 0, compared_session_pairs: 0 },
      unavailable: [{ code: 'insufficient_history', message: 'Synthetic insufficient history.' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(data)),
    )
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect(await screen.findByRole('heading', { name: 'Comparison unavailable' })).toBeTruthy()
    expect(screen.getByText(/Synthetic insufficient history/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('prevents duplicate launches and discards a cancelled response', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchDeskIntegrity {...props} />)
    const button = screen.getByRole('button', { name: 'Compare historical prefixes' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Comparing…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel comparison' }))
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(result())))
    expect(screen.queryByRole('heading', { name: 'No differences in sampled prefixes' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Compare historical prefixes' })).toBeTruthy()
  })

  it('aborts on diagnosis changes and rejects late old results', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const next = {
      ...result(),
      symbol: 'SYNTB',
      request: { ...result().request!, symbol: 'SYNTB' },
      fingerprint: 'other-bars',
      prefixes: [{ ...result().prefixes[0], cutoff_date: '2024-02-20' }],
    }
    const fetcher = vi
      .fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
      .mockImplementationOnce((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
      .mockImplementationOnce(async () => response(next))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    view.rerender(<ResearchDeskIntegrity {...props} symbol="SYNTB" fingerprint="other-bars" />)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect(await screen.findByText('2024-02-20')).toBeTruthy()
    await act(async () => delayed.resolve(response(result())))
    expect(screen.queryByText('2024-01-30')).toBeNull()
    expect(screen.getByText('2024-02-20')).toBeTruthy()
    view.rerender(<ResearchDeskIntegrity {...props} inputRevision="synthetic:2" />)
    expect(screen.queryByRole('heading', { name: 'No differences in sampled prefixes' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    { input_revision: 'synthetic:2' },
    { fingerprint: 'revised-bars' },
    { symbol: 'SYNTB' },
    { config: { strategy: 'buy_hold', params: {} } },
    { request: { ...result().request!, test_end: '2024-02-01' } },
  ])('rejects mismatched source identity %o', async (changes) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...result(), ...changes })),
    )
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Run the strategy diagnosis again',
    )
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('reports server errors and aborts an in-flight request on unmount', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi
      .fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
      .mockImplementationOnce(async () =>
        response({ detail: { message: 'Synthetic server failure.' } }, 503),
      )
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic server failure.')
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    view.unmount()
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(result())))
  })

  it('downloads the entire displayed response with exact precision, request, bounds and gaps without another POST', async () => {
    const server = {
      ...result(),
      desk_engine_version: 'alphaview-research-desk-v1',
      window: { start: null, end: props.testEnd, history_sessions: 100 },
      limits: { max_history_bars: 2000, numeric_rtol: 1e-10, numeric_atol: 1e-12 },
      warnings: ['SYNTHETIC samples are not proof'],
      differences: [
        {
          prefix_end: '2024-01-30',
          date: '2024-01-25',
          field: 'close',
          before: 103.12345678901234,
          after: 103.12345679901234,
        },
      ],
      unavailable_values: [
        {
          prefix_end: '2024-01-30',
          date: '2024-01-25',
          field: 'sma_fast',
          before: null,
          after: 0,
          code: 'nonfinite_output',
        },
      ],
      future_metadata: { preserve: [null, -0, '合成證據 留存'], whole: 1, exponent: 1e-7 },
    }
    const raw =
      JSON.stringify(server)
        .replace('[null,0,', '[null,-0.0,')
        .replace('"whole":1,', '"whole":1.0,')
        .replace('1e-7', '1e-07')
        .replace('合成證據 留存', '合成證據\\u0020留存') + '\n'
    const fetcher = vi.fn(async () => response(server, 200, raw))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchDeskIntegrity {...props} />)
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    const button = await screen.findByRole('button', {
      name: 'Download current prefix evidence JSON',
    })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:full-integrity')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const timeout = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) =>
      delay === 10000 ? 1 : timeout(callback, delay),
    )
    fireEvent.click(button)
    const blob = createObjectURL.mock.calls[0][0]
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(text).toBe(raw)
    expect(JSON.parse(text)).toEqual(server)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/does not prove absence of leakage/)).toBeTruthy()
  })

  it.each([
    { symbol: 'SYNTB' },
    { config: { ...config, params: { fast: 6, slow: 20 } } },
    { testStart: '2024-01-03' },
    { testEnd: '2024-02-28' },
    { inputRevision: 'synthetic:2' },
    { fingerprint: 'revised-bars' },
    { contextIdentity: 'new-run-or-form' },
    { enabled: false },
  ])(
    'removes export permanently when context changes %o, including when the old props return',
    async (changes) => {
      const fetcher = vi.fn(async () => response(result()))
      vi.stubGlobal('fetch', fetcher)
      const view = render(<ResearchDeskIntegrity {...props} />)
      await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
      await screen.findByRole('button', { name: 'Download current prefix evidence JSON' })
      view.rerender(<ResearchDeskIntegrity {...props} {...changes} />)
      expect(
        screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
      ).toBeNull()
      view.rerender(<ResearchDeskIntegrity {...props} />)
      expect(
        screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
      ).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('hides export during a rerun and keeps it hidden on failure without losing the error', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(result()))
      .mockReturnValueOnce(delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    await screen.findByRole('button', { name: 'Download current prefix evidence JSON' })
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
    await act(async () => delayed.resolve(response({ detail: 'Synthetic failed rerun' }, 503)))
    expect((await screen.findByRole('alert')).textContent).toBe('Synthetic failed rerun')
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
  })

  it('reports a browser download error without rerunning or discarding the visible evidence', async () => {
    const fetcher = vi.fn(async () => response(result()))
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(integrityDownload, 'downloadResearchIntegrityJson').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Download current prefix evidence JSON' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('could not be downloaded')
    expect(screen.getByRole('heading', { name: 'No differences in sampled prefixes' })).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects nonfinite raw future metadata before showing results or enabling receipts and downloads', async () => {
    const raw = JSON.stringify(result()).replace(/}$/, ',"future_metadata":{"overflow":1e999}}')
    const fetcher = vi.fn(async () => response(result(), 200, raw))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchDeskIntegrity {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Compare historical prefixes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('non-finite')
    expect(screen.queryByRole('heading', { name: 'No differences in sampled prefixes' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Download current prefix evidence JSON' }),
    ).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
