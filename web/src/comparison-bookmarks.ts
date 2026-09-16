export const COMPARISON_BOOKMARKS_KEY = 'alphaview-comparison-bookmarks-v1'
export type ComparisonSetup = { symbols: string[]; window: 60 | 120 | 252 }
export type ComparisonBookmark = ComparisonSetup & {
  id: string
  name: string
  savedAt: string
  source: null | { inputRevision: string; engine: string; asOf: string; start: string; end: string }
}
export function validComparisonSetup(value: unknown): value is ComparisonSetup {
  if (!value || typeof value !== 'object') return false
  const p = value as ComparisonSetup
  return (
    [60, 120, 252].includes(p.window) &&
    Array.isArray(p.symbols) &&
    p.symbols.length >= 2 &&
    p.symbols.length <= 5 &&
    p.symbols.every(
      (symbol) => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol),
    ) &&
    new Set(p.symbols).size === p.symbols.length
  )
}
export function validComparisonBookmark(value: unknown): value is ComparisonBookmark {
  if (!validComparisonSetup(value)) return false
  const p = value as ComparisonBookmark
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    p.id.length <= 100 &&
    typeof p.name === 'string' &&
    p.name.trim().length > 0 &&
    p.name.length <= 60 &&
    typeof p.savedAt === 'string' &&
    Number.isFinite(Date.parse(p.savedAt)) &&
    (p.source === null ||
      (!!p.source &&
        typeof p.source === 'object' &&
        ['inputRevision', 'engine', 'asOf', 'start', 'end'].every(
          (key) => typeof p.source![key as keyof NonNullable<typeof p.source>] === 'string',
        )))
  )
}
export function readComparisonBookmarks(
  storage: Pick<Storage, 'getItem'> = localStorage,
): ComparisonBookmark[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(COMPARISON_BOOKMARKS_KEY) || '[]')
    return Array.isArray(value)
      ? value
          .filter(validComparisonBookmark)
          .filter((item, index, rows) => rows.findIndex((row) => row.id === item.id) === index)
          .slice(-20)
      : []
  } catch {
    return []
  }
}
export function addComparisonBookmark(
  item: ComparisonBookmark,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
) {
  if (!validComparisonBookmark(item)) throw new Error('invalid_bookmark')
  const current = readComparisonBookmarks(storage)
  if (current.some((row) => row.id === item.id)) throw new Error('bookmark_exists')
  if (current.length >= 20) throw new Error('bookmark_limit')
  const next = [...current, item]
  storage.setItem(COMPARISON_BOOKMARKS_KEY, JSON.stringify(next))
  return next
}
