import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadWorkflowEvidenceJson, workflowEvidenceJson } from './workflow-evidence-json'

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('offline workflow evidence JSON', () => {
  it('preserves exact accepted server text, numeric spelling, nulls and future fields', async () => {
    const raw =
      '{ "as_of":"2026-10-01", "agent_run_id":"synthetic", "float":1.0, "negative_zero":-0.0, "exponent":1e-07, "future":{"unknown":null,"中文":"保留"}}\n'
    const accepted = JSON.parse(raw)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:exact')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadWorkflowEvidenceJson(accepted, raw)
    expect(await readBlob(createObjectURL.mock.calls[0][0])).toBe(raw)
    expect(workflowEvidenceJson(accepted, raw)).toBe(raw)
    expect(Object.is(accepted.negative_zero, -0)).toBe(true)
  })

  it.each([
    ['changed value', { a: 2 }, '{"a":1.0}'],
    ['missing null', {}, '{"a":null}'],
    ['unknown field', { a: 1 }, '{"a":1,"future":false}'],
    ['array order', { a: [1, 2] }, '{"a":[2,1]}'],
    ['negative zero changed', { a: 0 }, '{"a":-0.0}'],
    ['nonfinite accepted', { a: Infinity }, '{"a":1}'],
    ['nonfinite raw', { a: 1 }, '{"a":1e999}'],
    ['invalid JSON', { a: 1 }, '{"a":NaN}'],
  ])('rejects %s before creating a download', (_label, accepted, raw) => {
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    expect(() => workflowEvidenceJson(accepted, raw as string)).toThrow()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('compares object keys independently of order while preserving raw text', () => {
    expect(workflowEvidenceJson({ b: [null, false], a: 1 }, '{"a":1.0,"b":[null,false]}')).toBe(
      '{"a":1.0,"b":[null,false]}',
    )
  })
  it('round-trips full server evidence, Unicode, missing values and unknown metadata with a safe bounded filename', async () => {
    const result = {
      as_of: '../../2026-10-01\n',
      agent_run_id: '../unsafe:<run>/' + 'a'.repeat(200),
      engine_version: 'alphaview-workflow-validation-v1',
      desk_engine_version: 'alphaview-research-desk-v1',
      validation_engine_version: 'alphaview-validation-v1',
      agent_engine_version: 'alphaview-portfolio-agent-v1',
      input_revision: 'synthetic:2',
      proposal_fingerprint: 'p'.repeat(64),
      rule_fingerprint: 'r'.repeat(64),
      evidence_fingerprint: 'e'.repeat(64),
      mode: 'advisory_only',
      current_at_snapshot: true,
      request: {
        symbols: ['SYNTA'],
        risk: { initial_cash: 100000, fee_bps: 10, slippage_bps: 0, stop_loss_pct: null },
        folds: 4,
        trials: 5,
      },
      coverage: {
        required_pairs: 8,
        requested_pairs: 4,
        evaluated_pairs: 3,
        fully_available_pairs: 0,
        unavailable_pairs: 1,
        uninspected_pairs: 4,
      },
      enabled_rules: [
        { rule: 'turtle', weight: 25, config: { strategy: 'alphaview_turtle', params: {} } },
      ],
      items: [
        {
          symbol: 'SYNTA',
          rule: 'rps',
          closed_trades: null,
          probability: null,
          ci95: null,
          history_fingerprint: null,
          reasons: ['合成缺口 "quoted"\n第二行', '=not a spreadsheet formula'],
          unavailable_tests: [{ test: 'bootstrap', reason: 'insufficient_trades' }],
        },
      ],
      warnings: ['這不是組合驗證'],
      future_metadata: { preserve: ['unknown', null, 0] },
    }
    const original = structuredClone(result)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:workflow-evidence')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
      expect(this.href).toBe('blob:workflow-evidence')
      expect(this.isConnected).toBe(true)
    })
    let revoke: (() => void) | undefined
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      revoke = callback as () => void
      return 1
    })
    downloadWorkflowEvidenceJson(result)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(JSON.parse(await readBlob(blob))).toEqual(original)
    expect(result).toEqual(original)
    expect(filename).toMatch(/^alphaview-workflow-evidence-[a-zA-Z0-9_-]+\.json$/)
    expect(filename.length).toBeLessThan(165)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:workflow-evidence')
  })

  it('cleans up the anchor and blob URL when the browser refuses the download', () => {
    const createObjectURL = vi.fn(() => 'blob:refused')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Synthetic refusal')
    })
    let revoke: (() => void) | undefined
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      revoke = callback as () => void
      return 1
    })
    expect(() =>
      downloadWorkflowEvidenceJson({ as_of: '2026-10-01', agent_run_id: 'synthetic' }),
    ).toThrow('Synthetic refusal')
    expect(document.querySelector('a[download]')).toBeNull()
    revoke?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:refused')
  })

  it.each([NaN, Infinity, -Infinity])(
    'refuses nonfinite evidence instead of silently turning %s into null',
    (value) => {
      const createObjectURL = vi.fn()
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
      const result = {
        as_of: '2026-10-01',
        agent_run_id: 'synthetic',
        items: [{ probability: value }],
      }
      expect(() => downloadWorkflowEvidenceJson(result)).toThrow('non-finite')
      expect(createObjectURL).not.toHaveBeenCalled()
    },
  )
})
