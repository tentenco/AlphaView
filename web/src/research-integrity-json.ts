import { workflowEvidenceJson } from './workflow-evidence-json'

/** Current responses retain raw bytes; legacy responses use an augmented representation. */
export function downloadResearchIntegrityJson(
  result: { as_of: string; symbol: string; fingerprint: string | null; request?: unknown },
  submittedRequest: unknown,
  rawJson?: string,
) {
  const acceptedJson = workflowEvidenceJson(result, rawJson)
  const json = Object.prototype.hasOwnProperty.call(result, 'request')
    ? acceptedJson
    : workflowEvidenceJson({ ...result, request: submittedRequest })
  const safe = (text: string) =>
    text
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `alphaview-prefix-integrity-${safe(result.symbol)}-${safe(result.as_of)}-${safe(result.fingerprint ?? 'unavailable')}.json`
  try {
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}
