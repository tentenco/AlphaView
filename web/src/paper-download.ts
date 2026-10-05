/** Explicit local download. Private paper data is never sent outside this app. */
export async function downloadPaperFile(url: string, filename: string) {
  const response = await fetch(url)
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(
      typeof error.detail === 'string' ? error.detail : `Download failed (${response.status})`,
    )
  }
  const blob = await response.blob()
  const objectURL = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectURL
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(objectURL), 10000)
}
