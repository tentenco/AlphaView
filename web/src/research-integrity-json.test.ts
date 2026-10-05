import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadResearchIntegrityJson } from './research-integrity-json'

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
afterEach(() => vi.unstubAllGlobals())

describe('offline prefix integrity JSON', () => {
  it('preserves raw server JSON bytes including whole floats, signed zero, exponents and Unicode', async () => {
    const raw =
      '{"as_of":"2026-10-01","symbol":"SYNTA","fingerprint":null,"request":{"max_prefixes":6},"future_metadata":{"whole":1.0,"signed_zero":-0.0,"exponent":1e-07,"missing":null,"text":"合成證據\\u0020留存"}}\n'
    const result = JSON.parse(raw)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:raw-integrity')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(window, 'setTimeout').mockReturnValue(1)
    downloadResearchIntegrityJson(result, { max_prefixes: 4 }, raw)
    expect(await readBlob(createObjectURL.mock.calls[0][0])).toBe(raw)
  })

  it('adds the exact frozen request only for a legacy response and safely names and cleans the download', async () => {
    const result = {
      as_of: '../../2026-10-01\n',
      symbol: '../SYNTA<unsafe>/',
      fingerprint: '../' + 'f'.repeat(200),
      missing: null,
      exact: 103.12345678901234,
      warning: '合成抽樣 "quote"\n不是證明',
    }
    const request = {
      symbol: 'SYNTA',
      config: { strategy: 'sma_cross', params: { fast: 5, slow: 20 } },
      test_start: null,
      test_end: '2026-10-01',
      max_prefixes: 6,
    }
    const original = structuredClone(result)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:integrity')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
      expect(this.isConnected).toBe(true)
    })
    let revoke: (() => void) | undefined
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      revoke = callback as () => void
      return 1
    })
    downloadResearchIntegrityJson(result, request)
    expect(JSON.parse(await readBlob(createObjectURL.mock.calls[0][0]))).toEqual({
      ...original,
      request,
    })
    expect(result).toEqual(original)
    expect(filename).toMatch(/^alphaview-prefix-integrity-[a-zA-Z0-9_-]+\.json$/)
    expect(filename.length).toBeLessThan(226)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:integrity')
  })

  it('preserves an existing server request verbatim instead of replacing it with local context', async () => {
    const result = {
      as_of: '2026-10-01',
      symbol: 'SYNTA',
      fingerprint: null,
      request: { test_start: null, max_prefixes: 4, extra_server_context: 'synthetic' },
    }
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:existing-request')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(window, 'setTimeout').mockReturnValue(1)
    downloadResearchIntegrityJson(result, { max_prefixes: 6 })
    expect(JSON.parse(await readBlob(createObjectURL.mock.calls[0][0]))).toEqual(result)
  })

  it('validates legacy raw evidence before adding its frozen request as a legacy representation', async () => {
    const raw = '{"as_of":"2026-10-01","symbol":"SYNTA","fingerprint":null,"legacy_metric":1.0}'
    const result = JSON.parse(raw)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:legacy-raw')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(window, 'setTimeout').mockReturnValue(1)
    const request = { max_prefixes: 6 }
    downloadResearchIntegrityJson(result, request, raw)
    const exported = await readBlob(createObjectURL.mock.calls[0][0])
    expect(exported).not.toBe(raw)
    expect(JSON.parse(exported)).toEqual({ ...result, request })
    expect(result).not.toHaveProperty('request')
  })

  it.each([true, false])(
    'rejects mismatched raw content even for a legacy response (request present: %s)',
    (withRequest) => {
      const result = {
        as_of: '2026-10-01',
        symbol: 'SYNTA',
        fingerprint: null,
        ...(withRequest ? { request: {} } : {}),
      }
      const createObjectURL = vi.fn()
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
      expect(() =>
        downloadResearchIntegrityJson(result, {}, JSON.stringify({ ...result, symbol: 'SYNTB' })),
      ).toThrow('does not match')
      expect(createObjectURL).not.toHaveBeenCalled()
    },
  )

  it('rejects nonfinite raw future metadata before it can be exported as null', () => {
    const raw =
      '{"as_of":"2026-10-01","symbol":"SYNTA","fingerprint":null,"request":{},"future_metadata":{"overflow":1e999}}'
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    expect(() => downloadResearchIntegrityJson(JSON.parse(raw), {}, raw)).toThrow('non-finite')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite %s without creating a download or substituting null',
    (bad) => {
      const createObjectURL = vi.fn()
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
      expect(() =>
        downloadResearchIntegrityJson(
          { as_of: '2026-10-01', symbol: 'SYNTA', fingerprint: null, request: { nested: [bad] } },
          {},
        ),
      ).toThrow('non-finite')
      expect(createObjectURL).not.toHaveBeenCalled()
    },
  )

  it('releases the Blob and removes the link even if the browser rejects clicking it', () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:refused', revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    let revoke: (() => void) | undefined
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      revoke = callback as () => void
      return 1
    })
    expect(() =>
      downloadResearchIntegrityJson(
        { as_of: '2026-10-01', symbol: 'SYNTA', fingerprint: null },
        {},
      ),
    ).toThrow('Synthetic refusal')
    expect(document.querySelector('a[download]')).toBeNull()
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:refused')
  })
})
