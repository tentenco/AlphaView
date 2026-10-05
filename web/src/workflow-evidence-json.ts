function sameJsonValue(accepted: unknown, parsed: unknown): boolean {
  if (typeof accepted === 'number' && !Number.isFinite(accepted))
    throw new Error('Evidence contains a non-finite number')
  if (accepted === null || typeof accepted !== 'object') return Object.is(accepted, parsed)
  if (Array.isArray(accepted))
    return (
      Array.isArray(parsed) &&
      accepted.length === parsed.length &&
      Array.from({ length: accepted.length }, (_, index) => index).every(
        (index) => Object.hasOwn(accepted, index) && sameJsonValue(accepted[index], parsed[index]),
      )
    )
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const prototype = Object.getPrototypeOf(accepted)
  if (prototype !== Object.prototype && prototype !== null) return false
  const acceptedKeys = Object.keys(accepted)
  return (
    acceptedKeys.length === Object.keys(parsed).length &&
    acceptedKeys.every(
      (key) =>
        Object.hasOwn(parsed, key) &&
        sameJsonValue(
          (accepted as Record<string, unknown>)[key],
          (parsed as Record<string, unknown>)[key],
        ),
    )
  )
}

/** Preserve an accepted raw response when provided; legacy callers keep their formatting. */
export function workflowEvidenceJson(result: unknown, rawJson?: string): string {
  if (rawJson !== undefined) {
    const parsed: unknown = JSON.parse(rawJson, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error('Evidence contains a non-finite number')
      return value
    })
    if (!sameJsonValue(result, parsed))
      throw new Error('Raw evidence does not match the accepted result')
    return rawJson
  }
  const json = JSON.stringify(
    result,
    (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error('Evidence contains a non-finite number')
      return value
    },
    2,
  )
  return `${json}\n`
}

/** Download complete accepted evidence without projection, recomputation or an extra verdict. */
export function downloadWorkflowEvidenceJson(
  result: { as_of: string; agent_run_id: string },
  rawJson?: string,
) {
  const json = workflowEvidenceJson(result, rawJson)
  const safe = (value: string) =>
    value
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `alphaview-workflow-evidence-${safe(result.as_of)}-${safe(result.agent_run_id)}.json`
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}
