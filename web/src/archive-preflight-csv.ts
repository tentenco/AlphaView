/** Readable projection only: it never substitutes for original archive JSON. */
export const PREFLIGHT_CSV_FORMAT = 'archive_preflight_readable_v1'
export const MAX_PREFLIGHT_CSV_BYTES = 32 * 1024 * 1024
const MAX_NODES = 250_000
const MAX_DEPTH = 64
const engines = new Set([
  'alphaview-allocation-receipt-archive-v1',
  'alphaview-research-integrity-archive-v1',
  'alphaview-workflow-path-receipt-archive-v1',
  'alphaview-execution-study-receipt-archive-v1',
])
const reportFields = [
  'engine_version',
  'account_id',
  'account_version',
  'symbol',
  'as_of',
  'input_revision',
  'checked_at',
  'verdict',
  'compatible',
  'archive_checksum',
  'policy',
  'reasons',
  'coverage',
  'archive_context',
  'snapshot_currentness',
  'capacity',
  'records',
]
const recordFields = [
  'id',
  'content_fingerprint',
  'ordinal',
  'diagnostic_status',
  'kind',
  'run_id',
  'proposal_id',
  'compatible',
  'reasons',
  'duplicate',
  'integrity',
  'archived_currentness',
  'currentness',
]
type RowType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'missing'
function fail(): never {
  throw new Error('archive_preflight_csv_invalid_or_limit')
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
function cell(value: string | number) {
  if (typeof value === 'number') return `"${Object.is(value, -0) ? '-0' : String(value)}"`
  if (/[\uD800-\uDFFF]/u.test(value)) fail()
  const safe = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')

/** Includes the entire accepted report, including blocked and zero-record results. */
export function archivePreflightCsv(report: unknown): string {
  if (
    !object(report) ||
    typeof report.engine_version !== 'string' ||
    !engines.has(report.engine_version) ||
    typeof report.verdict !== 'string' ||
    !['compatible', 'blocked'].includes(report.verdict) ||
    typeof report.compatible !== 'boolean' ||
    !Array.isArray(report.records) ||
    report.records.length > 500
  )
    fail()
  const rows: string[] = []
  const encoder = new TextEncoder()
  let bytes = 3
  let nodes = 0
  const ancestors = new Set<object>()
  const add = (values: (string | number)[]) => {
    if (values.some((value) => typeof value === 'string' && value.length > MAX_PREFLIGHT_CSV_BYTES))
      fail()
    const line = values.map(cell).join(',') + '\r\n'
    bytes += encoder.encode(line).byteLength
    if (bytes > MAX_PREFLIGHT_CSV_BYTES || ++nodes > MAX_NODES) fail()
    rows.push(line)
  }
  add(['export_format', 'section', 'record_index', 'field_path', 'value_type', 'value'])
  const emit = (
    section: string,
    index: string | number,
    path: string,
    type: RowType,
    value: string | number,
  ) => add([PREFLIGHT_CSV_FORMAT, section, index, path, type, value])
  emit(
    'export',
    '',
    '/purpose',
    'string',
    'readable_copy_not_original_archive_not_import_or_authority',
  )
  emit('export', '', '/record_index_base', 'number', 0)
  emit('export', '', '/field_path_format', 'string', 'JSON Pointer; ~0 means ~ and ~1 means /')
  emit(
    'export',
    '',
    '/container_and_missing_markers',
    'string',
    'Container rows mark type only; missing means absent, not an inferred reason',
  )
  emit('export', '', '/record_count', 'number', report.records.length)
  function walk(
    value: unknown,
    section: string,
    index: string | number,
    path: string,
    depth: number,
  ) {
    if (depth > MAX_DEPTH) fail()
    if (value === null) return emit(section, index, path, 'null', 'null')
    if (typeof value === 'string') return emit(section, index, path, 'string', value)
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail()
      return emit(section, index, path, 'number', value)
    }
    if (typeof value === 'boolean') return emit(section, index, path, 'boolean', String(value))
    if (!Array.isArray(value) && !object(value)) fail()
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail()
    ancestors.add(value)
    emit(section, index, path, Array.isArray(value) ? 'array' : 'object', '')
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) fail()
      for (let n = 0; n < value.length; n++) {
        if (!Object.hasOwn(value, n)) fail()
        walk(value[n], section, index, `${path}/${n}`, depth + 1)
      }
    } else {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) fail()
        walk(descriptor.value, section, index, `${path}/${pointer(key)}`, depth + 1)
      }
    }
    ancestors.delete(value)
  }
  // Validate the complete tree once through the same traversal, including the
  // report container, without sorting or transforming any original record.
  if (Object.getOwnPropertySymbols(report).length) fail()
  ancestors.add(report)
  emit('report', '', '', 'object', '')
  for (const key of Object.keys(report)) {
    const descriptor = Object.getOwnPropertyDescriptor(report, key)
    if (!descriptor || !('value' in descriptor)) fail()
    if (key !== 'records') walk(descriptor.value, 'report', '', `/${pointer(key)}`, 1)
  }
  for (const key of reportFields) {
    if (!Object.hasOwn(report, key)) emit('report', '', `/${pointer(key)}`, 'missing', '')
  }
  emit('report', '', '/records', 'array', '')
  if (
    Object.keys(report.records).length !== report.records.length ||
    Object.getOwnPropertySymbols(report.records).length
  )
    fail()
  ancestors.add(report.records)
  for (let index = 0; index < report.records.length; index++) {
    if (!Object.hasOwn(report.records, index)) fail()
    const record: unknown = report.records[index]
    if (!object(record)) fail()
    walk(record, 'record', index, `/records/${index}`, 1)
    for (const key of recordFields) {
      if (!Object.hasOwn(record, key))
        emit('record', index, `/records/${index}/${pointer(key)}`, 'missing', '')
    }
  }
  return '\uFEFF' + rows.join('')
}

export function downloadArchivePreflightCsv(content: string, report: object) {
  const value = report as Record<string, unknown>
  const safe = (input: unknown) =>
    typeof input === 'string'
      ? input
          .replace(/[^A-Za-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64) || 'unknown'
      : 'unknown'
  const filename = `alphaview-preflight-${safe(value.engine_version)}-${safe(value.account_id ?? value.symbol)}-${safe(value.as_of)}.csv`
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}
