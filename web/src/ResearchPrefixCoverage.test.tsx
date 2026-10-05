import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchPrefixCoverage, type PrefixCoverageResult } from './ResearchPrefixCoverage'

const props = {
  symbol: 'SYNTA',
  config: { strategy: 'sma_cross' as const, params: { fast: 5, slow: 20 } },
  testStart: '2024-01-02',
  testEnd: '2024-02-29',
  inputRevision: 'synthetic:1',
  asOf: '2024-12-31',
  contextIdentity: 'synthetic-account-and-run',
  t: (_zh: string, en: string) => en,
}
const request = {
  symbol: props.symbol,
  config: props.config,
  test_start: props.testStart,
  test_end: props.testEnd,
  expected_input_revision: props.inputRevision,
  expected_as_of: props.asOf,
}
const result = (): PrefixCoverageResult => ({
  engine_version: 'alphaview-research-prefix-coverage-v1',
  as_of: props.asOf,
  input_revision: props.inputRevision,
  symbol: props.symbol,
  config: props.config,
  request,
  fingerprint: 'f'.repeat(64),
  evidence_fingerprint: 'e'.repeat(64),
  status: 'no_difference_detected',
  effective_end: props.testEnd,
  window: {
    start: props.testStart,
    end: props.testEnd,
    sessions: 42,
    warmup_start: '2023-01-03',
    history_sessions: 291,
    first_eligible_cutoff: '2024-01-30',
    last_eligible_cutoff: '2024-02-28',
  },
  suggested_window: { test_start: '2023-10-05', test_end: props.testEnd, signal_sessions: 100 },
  coverage: {
    required_cutoffs: 22,
    attempted_cutoffs: 22,
    compared_cutoffs: 22,
    failed_cutoffs: 0,
    manifest_complete: true,
    cutoff_coverage_complete: true,
    complete: true,
  },
  counts: {
    compared_session_pairs: 671,
    compared_values: 5368,
    differences: 0,
    unavailable_values: 0,
    invalid_signal_sessions: 0,
  },
  limits: { max_cutoffs: 120, max_history_bars: 2000, max_details: 100 },
  cutoff_manifest: [
    { cutoff_date: '2024-01-30', status: 'compared', fingerprint: 'a'.repeat(64), reason: null },
  ],
  differences: [],
  differences_truncated: false,
  unavailable_values: [],
  unavailable_values_truncated: false,
  unavailable: [],
  method: 'SYNTHETIC independent rebuild method.',
  warnings: ['SYNTHETIC fixture, not a causal proof.'],
})
const response = (body: unknown, status = 200, raw = JSON.stringify(body)) => ({
  ok: status === 200,
  status,
  text: async () => raw,
})
const buttonName = 'Compare every eligible cutoff'
const downloadName = 'Download dense prefix JSON'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dense prefix coverage', () => {
  it('runs only on demand with explicit dates and source binding, never sampling or granting authority', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response(result()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchPrefixCoverage {...props} />)
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(/It is not a causal proof/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('heading', { name: 'No differences in the selected cutoffs' })
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(request)
    expect(fetcher.mock.calls[0][0]).toBe('/api/research-desk/prefix-coverage')
    expect(screen.getByText(/Compared \/ required cutoffs/).textContent).toContain('22 / 22')
    expect(screen.getByText(/this is not strategy validation/)).toBeTruthy()
  })

  it('disables empty or reversed dates and has no default hidden request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchPrefixCoverage {...props} testStart={null} />)
    const button = screen.getByRole('button', { name: buttonName })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Signal start date'), {
      target: { value: '2024-03-01' },
    })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('shows cap counts without false coverage and applies derived dates without fetching', async () => {
    const capped = {
      ...result(),
      status: 'unavailable',
      coverage: {
        ...result().coverage,
        required_cutoffs: 121,
        attempted_cutoffs: 0,
        compared_cutoffs: 0,
        complete: false,
        cutoff_coverage_complete: false,
        manifest_complete: false,
      },
      cutoff_manifest: [],
      unavailable: [{ code: 'cutoff_limit', message: '121 cutoffs exceed 120; no sampling.' }],
    }
    const fetcher = vi.fn(async () => response(capped))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('heading', { name: 'Dense coverage unavailable' })
    expect(screen.getByText(/Compared \/ required cutoffs/).textContent).toContain('0 / 121')
    expect(screen.getByText(/Coverage is incomplete/)).toBeTruthy()
    expect(screen.getByText(/no silent omissions or sampling occurred/)).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: /Use the last up to 100 signal dates/ }),
    )
    expect(screen.getByLabelText('Signal start date')).toHaveProperty('value', '2023-10-05')
    expect(screen.getByLabelText('Signal end date')).toHaveProperty('value', props.testEnd)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains null values, failed-cutoff reasons and bounded-detail warnings', async () => {
    const evidence = result()
    evidence.status = 'unavailable'
    evidence.coverage.complete = false
    evidence.coverage.required_cutoffs = null
    evidence.cutoff_manifest[0] = {
      cutoff_date: '2024-01-30',
      status: 'unavailable',
      fingerprint: null,
      reason: 'date_mismatch',
    }
    evidence.unavailable_values = [
      {
        prefix_end: '2024-01-30',
        date: props.testStart,
        field: 'rsi',
        before: null,
        after: null,
        code: 'nonfinite_output',
      },
    ]
    evidence.unavailable_values_truncated = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(evidence)),
    )
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('heading', { name: 'Dense coverage unavailable' })
    expect(screen.getByText(/Compared \/ required cutoffs/).textContent).toContain('22 / —')
    expect(screen.getByText('date_mismatch')).toBeTruthy()
    expect(screen.getByText('nonfinite_output')).toBeTruthy()
    expect(screen.getByText(/Details are truncated/)).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
  })

  it('downloads exact full raw JSON bytes and releases the blob without another POST', async () => {
    const raw = JSON.stringify(result()).replace(
      /}$/,
      ',"future_metadata":{"whole":1.0,"zero":-0.0,"exponent":1e-07,"text":"合成\\u0020證據","missing":null}}\n',
    )
    const fetcher = vi.fn(async () => response(result(), 200, raw))
    vi.stubGlobal('fetch', fetcher)
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    const button = await screen.findByRole('button', { name: downloadName })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:dense')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    let revoke: (() => void) | undefined
    const timeout = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation((callback, delay) => {
      if (delay !== 10000) return timeout(callback, delay)
      revoke = callback as () => void
      return 1
    })
    fireEvent.click(button)
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    expect(text).toBe(raw)
    expect(filename).toMatch(/^alphaview-prefix-coverage-[a-zA-Z0-9_-]+\.json$/)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:dense')
  })

  it.each([
    { inputRevision: 'synthetic:2' },
    { asOf: '2025-01-02' },
    { contextIdentity: 'other-account' },
    { enabled: false },
    { symbol: 'SYNTB' },
    { config: { ...props.config, params: { fast: 6, slow: 20 } } },
  ])('discards raw evidence permanently on context/lifecycle change %o', async (changes) => {
    const fetcher = vi.fn(async () => response(result()))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('button', { name: downloadName })
    view.rerender(<ResearchPrefixCoverage {...props} {...changes} />)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    view.rerender(<ResearchPrefixCoverage {...props} />)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidates edited dates permanently even when the original draft returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(result())),
    )
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    await screen.findByRole('button', { name: downloadName })
    fireEvent.change(screen.getByLabelText('Signal start date'), {
      target: { value: '2024-01-03' },
    })
    fireEvent.change(screen.getByLabelText('Signal start date'), {
      target: { value: props.testStart },
    })
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
  })

  it('guards rapid clicks, aborts on lifecycle changes and ignores late raw responses', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchPrefixCoverage {...props} />)
    const button = screen.getByRole('button', { name: buttonName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    view.rerender(<ResearchPrefixCoverage {...props} enabled={false} />)
    view.rerender(<ResearchPrefixCoverage {...props} />)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(result())))
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
  })

  it('cancels an active request and aborts another when unmounted', async () => {
    const delayed = deferred<ReturnType<typeof response>>()
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => delayed.promise)
    vi.stubGlobal('fetch', fetcher)
    const view = render(<ResearchPrefixCoverage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel comparison' }))
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    view.unmount()
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
    await act(async () => delayed.resolve(response(result())))
  })

  it.each([
    {
      body: { detail: { message: 'source changed' } },
      code: 409,
      message: 'Refresh the strategy diagnosis',
    },
    { body: { ...result(), input_revision: 'synthetic:2' }, code: 200, message: 'does not match' },
    {
      body: { ...result(), request: { ...request, test_start: '2024-01-03' } },
      code: 200,
      message: 'does not match',
    },
  ])('rejects stale or mismatched response %#', async ({ body, code, message }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(body, code)),
    )
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
  })

  it('rejects nonfinite future metadata instead of exporting null', async () => {
    const raw = JSON.stringify(result()).replace(/}$/, ',"future_metadata":{"overflow":1e999}}')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(result(), 200, raw)),
    )
    render(<ResearchPrefixCoverage {...props} />)
    await userEvent.click(screen.getByRole('button', { name: buttonName }))
    expect((await screen.findByRole('alert')).textContent).toContain('non-finite')
    expect(screen.queryByRole('button', { name: downloadName })).toBeNull()
  })
})
