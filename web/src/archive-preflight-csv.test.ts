import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  archivePreflightCsv,
  downloadArchivePreflightCsv,
  MAX_PREFLIGHT_CSV_BYTES,
} from './archive-preflight-csv'

// Independent RFC4180 reader: assertions inspect records/cells, not substrings
// that could conceal quoting errors or dropped records.
function parse(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  for (let i = 1; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && char === ',') {
      row.push(cell)
      cell = ''
    } else if (!quoted && char === '\r' && csv[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += char
  }
  expect(quoted).toBe(false)
  expect(row).toEqual([])
  return rows
}
const base = (records: unknown[] = []) => ({
  engine_version: 'alphaview-allocation-receipt-archive-v1',
  account_id: 'synthetic',
  as_of: '2026-10-01',
  verdict: 'blocked',
  compatible: false,
  reasons: ['archive_records_incompatible'],
  coverage: { checked: records.length, unavailable: null },
  capacity: { account_remaining: 0, import_authorized: false },
  snapshot_currentness: { current: null, reasons: ['unknown'] },
  records,
})
const field = (rows: string[][], path: string) => rows.find((row) => row[3] === path)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('complete preflight readable CSV', () => {
  it.each([
    ['allocation', 'alphaview-allocation-receipt-archive-v1', { content_fingerprint: 'fp' }],
    [
      'integrity',
      'alphaview-research-integrity-archive-v1',
      { ordinal: 1, diagnostic_status: 'unavailable' },
    ],
    [
      'workflow',
      'alphaview-workflow-path-receipt-archive-v1',
      { ordinal: 2, kind: 'path_costs', run_id: 'saved-run' },
    ],
    [
      'execution',
      'alphaview-execution-study-receipt-archive-v1',
      { ordinal: 3, kind: 'open_gtd', proposal_id: 'saved-proposal' },
    ],
  ])(
    'retains %s family provenance, blocked verdict, capacities and original record fields',
    (_name, engine, extra) => {
      const report = {
        ...base([
          {
            id: null,
            compatible: false,
            duplicate: 'unknown',
            reasons: ['bad'],
            integrity: { available: false, reason: 'corrupt' },
            archived_currentness: { current: true },
            currentness: { current: false },
            ...extra,
          },
        ]),
        engine_version: engine,
      }
      const original = JSON.stringify(report)
      const rows = parse(archivePreflightCsv(report))
      expect(field(rows, '/engine_version')?.slice(4)).toEqual(['string', engine])
      expect(field(rows, '/verdict')?.slice(4)).toEqual(['string', 'blocked'])
      expect(field(rows, '/compatible')?.slice(4)).toEqual(['boolean', 'false'])
      expect(field(rows, '/capacity/account_remaining')?.slice(4)).toEqual(['number', '0'])
      expect(field(rows, '/records/0/integrity/reason')?.slice(4)).toEqual(['string', 'corrupt'])
      for (const [key, value] of Object.entries(extra))
        expect(field(rows, `/records/0/${key}`)?.[5]).toBe(String(value))
      expect(JSON.stringify(report)).toBe(original)
    },
  )

  it('keeps all 500 original rows including duplicate, missing and empty IDs without sorting', () => {
    const records = Array.from({ length: 500 }, (_, index) =>
      Object.freeze({
        id: index === 0 ? null : index === 1 ? '' : 'duplicate',
        compatible: index % 2 === 0,
        ordinal: 500 - index,
        reasons: [],
      }),
    )
    Object.freeze(records)
    const rows = parse(archivePreflightCsv(Object.freeze(base(records))))
    const ordinals = rows.filter((row) => row[3].endsWith('/ordinal'))
    expect(ordinals).toHaveLength(500)
    expect(ordinals.map((row) => row[2])).toEqual(records.map((_, index) => String(index)))
    expect(ordinals.map((row) => row[5])).toEqual(records.map((record) => String(record.ordinal)))
    expect(field(rows, '/records/0/id')?.slice(4)).toEqual(['null', 'null'])
    expect(field(rows, '/records/1/id')?.slice(4)).toEqual(['string', ''])
    expect(field(rows, '/records/499/proposal_id')?.slice(4)).toEqual(['missing', ''])
  })

  it('zero-record rejection exports reasons and unknown metadata, never a header-only success', () => {
    const rows = parse(archivePreflightCsv({ ...base(), capacity: null, archive_context: null }))
    expect(field(rows, '/record_count')?.slice(4)).toEqual(['number', '0'])
    expect(field(rows, '/records')?.slice(4)).toEqual(['array', ''])
    expect(field(rows, '/reasons/0')?.[5]).toBe('archive_records_incompatible')
    expect(field(rows, '/capacity')?.slice(4)).toEqual(['null', 'null'])
    expect(field(rows, '/account_version')?.slice(4)).toEqual(['missing', ''])
    expect(field(rows, '/snapshot_currentness/current')?.slice(4)).toEqual(['null', 'null'])
    expect(rows.some((row) => row[1] === 'record')).toBe(false)
  })

  it('round-trips UTF8, escaped JSON Pointer paths, nested arrays, empty containers and numeric signs', () => {
    const report = {
      ...base(),
      future: {
        'slash/key~': [0, -0, false, '', null, {}, [], '中文,"引號"\r\n下一行', -2.5, 1e-9],
      },
    }
    const csv = archivePreflightCsv(report),
      rows = parse(csv)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(field(rows, '/future/slash~1key~0/1')?.slice(4)).toEqual(['number', '-0'])
    expect(field(rows, '/future/slash~1key~0/2')?.slice(4)).toEqual(['boolean', 'false'])
    expect(field(rows, '/future/slash~1key~0/3')?.slice(4)).toEqual(['string', ''])
    expect(field(rows, '/future/slash~1key~0/5')?.slice(4)).toEqual(['object', ''])
    expect(field(rows, '/future/slash~1key~0/6')?.slice(4)).toEqual(['array', ''])
    expect(field(rows, '/future/slash~1key~0/7')?.[5]).toBe('中文,"引號"\r\n下一行')
    expect(field(rows, '/future/slash~1key~0/8')?.slice(4)).toEqual(['number', '-2.5'])
    expect(field(rows, '/future/slash~1key~0/9')?.[5]).toBe('1e-9')
  })

  it.each(['=SUM(1,2)', ' +2', '-3', '@call', '\ttext', '\ntext', '＝1', '＠call'])(
    'guards spreadsheet text %j without treating it as a number',
    (value) => {
      const rows = parse(archivePreflightCsv({ ...base(), future: value }))
      expect(field(rows, '/future')?.slice(4)).toEqual(['string', `'${value}`])
    },
  )

  it.each([NaN, Infinity, undefined, 1n, () => 1, new Date(), new Map(), Symbol('x')])(
    'rejects unsupported/nonfinite data without a partial CSV: %s',
    (value) => {
      expect(() => archivePreflightCsv({ ...base(), future: value })).toThrow(
        'archive_preflight_csv_invalid_or_limit',
      )
    },
  )

  it('rejects unknown method, cycles, sparse arrays, over-500 sets, deep trees and excessive nodes', () => {
    expect(() => archivePreflightCsv({ ...base(), engine_version: 'future' })).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => archivePreflightCsv({ ...base(), future: cyclic })).toThrow()
    expect(() => archivePreflightCsv({ ...base(), future: Array(2) })).toThrow()
    expect(() =>
      archivePreflightCsv(
        base(Array.from({ length: 501 }, () => ({ id: null, compatible: false }))),
      ),
    ).toThrow()
    let deep: unknown = null
    for (let i = 0; i < 66; i++) deep = { next: deep }
    expect(() => archivePreflightCsv({ ...base(), future: deep })).toThrow()
    expect(() =>
      archivePreflightCsv({ ...base(), future: Array.from({ length: 250001 }, () => 0) }),
    ).toThrow()
  })

  it('refuses an oversized encoded export instead of truncating it', () => {
    expect(() =>
      archivePreflightCsv({ ...base(), future: 'x'.repeat(MAX_PREFLIGHT_CSV_BYTES) }),
    ).toThrow()
  })

  it('downloads locally with a safe filename and cleans the anchor and object URL', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:csv'),
      revokeObjectURL = vi.fn(),
      fetcher = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    let filename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download
    })
    downloadArchivePreflightCsv('full content', {
      engine_version: '../unsafe',
      account_id: '../../id',
      as_of: '2026/10/01',
    })
    expect(filename).toMatch(/^[A-Za-z0-9_-]+\.csv$/)
    expect(document.querySelector('a[download]')).toBeNull()
    expect(createObjectURL.mock.calls[0]).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })
})
