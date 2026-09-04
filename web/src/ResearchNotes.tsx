import { useEffect, useId, useRef, useState } from 'react'
import { api, dateTime } from './ui'

export type ResearchNote = { symbol: string; note: string; tags: string[]; updated_at: string | null; version: number }

export function ResearchNotes({ symbol, onDirtyChange }: { symbol: string; onDirtyChange?: (dirty: boolean) => void }) {
  const id = useId()
  const [saved, setSaved] = useState<ResearchNote | null>(null)
  const [note, setNote] = useState('')
  const [tags, setTags] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const tagList = tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
  const currentSaved = saved?.symbol === symbol ? saved : null
  const dirty = currentSaved !== null && (note !== currentSaved.note || JSON.stringify(tagList) !== JSON.stringify(currentSaved.tags))
  const validation = note.length > 6000 ? '筆記最多 6,000 個字元。' : tagList.length > 5 ? '最多可設定 5 個標籤。' : tagList.some(tag => tag.length > 24) ? '每個標籤最多 24 個字元。' : ''
  useEffect(() => {
    controller.current?.abort()
    const pending = new AbortController(); controller.current = pending
    const current = ++request.current
    setLoading(true); setSaving(false); setError(''); setMessage(''); setConflict(false)
    api<ResearchNote>(`/api/notes/${encodeURIComponent(symbol)}`, { signal: pending.signal })
      .then(result => {
        if (current !== request.current || pending.signal.aborted) return
        setSaved(result); setNote(result.note); setTags(result.tags.join(', '))
      })
      .catch(err => { if (current === request.current && !pending.signal.aborted) setError((err as Error).message) })
      .finally(() => { if (current === request.current) setLoading(false) })
    return () => { pending.abort(); if (current === request.current) request.current++ }
  }, [symbol, reload])
  useEffect(() => () => { controller.current?.abort(); request.current++ }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange?.(false) }, [onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  async function save() {
    if (saving || loading || !dirty || validation || !currentSaved) return
    controller.current?.abort()
    const pending = new AbortController(); controller.current = pending
    const current = ++request.current
    setSaving(true); setError(''); setMessage(''); setConflict(false)
    try {
      // Read the status directly: a version conflict must preserve the local draft.
      const response = await fetch(`/api/notes/${encodeURIComponent(symbol)}`, {
        method: 'PUT', signal: pending.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, tags: tagList, version: currentSaved.version }),
      })
      if (current !== request.current || pending.signal.aborted) return
      if (response.status === 409) {
        setConflict(true); setError('這份筆記已在其他視窗更新。你的草稿仍保留，請複製需要的文字，再決定是否載入最新版本。')
        return
      }
      const result = await response.json().catch(() => null)
      if (current !== request.current || pending.signal.aborted) return
      if (!response.ok) throw new Error(typeof result?.detail === 'string' ? result.detail : `筆記儲存失敗（${response.status}），請重試。`)
      setSaved(result); setNote(result.note); setTags(result.tags.join(', ')); setMessage('研究筆記已儲存。')
    } catch (err) {
      if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
    } finally { if (current === request.current) setSaving(false) }
  }
  return <section className="research-note" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><div><h3 id={`${id}-title`}>研究筆記（本機儲存）</h3><p>{symbol} · 記錄自己的研究依據與待確認事項。</p></div><span className="quiet-label">{dirty ? '有尚未儲存的變更' : currentSaved?.updated_at ? `${dateTime(currentSaved.updated_at)} 儲存` : '尚未儲存筆記'}</span></div>
    {loading && <p role="status">載入研究筆記中…</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
    {!loading && !currentSaved && <button type="button" className="button" onClick={() => setReload(value => value + 1)}>重新載入筆記</button>}
    {currentSaved && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor={`${id}-note`}>研究內容</label><textarea id={`${id}-note`} name="research-note" rows={6} maxLength={6000} value={note} disabled={loading || saving} aria-describedby={`${id}-count`} onChange={event => { setNote(event.target.value); setMessage('') }} style={{ width: '100%', display: 'block', marginTop: 8, padding: 10, background: 'var(--background)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', font: 'inherit', resize: 'vertical' }}/>
      <p id={`${id}-count`} className="footnote">{note.length.toLocaleString('en-US')} / 6,000 字元 · 筆記由你輸入，不會自動產生投資結論。</p>
      <label htmlFor={`${id}-tags`}>研究標籤</label><input id={`${id}-tags`} name="research-tags" value={tags} disabled={loading || saving} aria-describedby={`${id}-tag-help`} onChange={event => { setTags(event.target.value); setMessage('') }} placeholder="例如：財報追蹤, 等待突破" style={{ display: 'block', width: '100%', marginTop: 8 }}/><p id={`${id}-tag-help`} className="footnote">以逗號分隔，最多 5 個標籤，每個最多 24 個字元。</p>
      {validation && <p role="alert" className="negative">{validation}</p>}
      <div className="dialog-actions"><button type="button" className="button" disabled={!dirty || loading || saving} onClick={() => { setNote(currentSaved.note); setTags(currentSaved.tags.join(', ')); setMessage('已取消本次變更。'); setError(''); setConflict(false) }}>取消變更</button><button type="submit" className="button primary" disabled={!dirty || loading || saving || !!validation || conflict}>{saving ? '儲存筆記中…' : '儲存研究筆記'}</button></div>
      {conflict && <button type="button" className="button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>捨棄草稿並載入最新版本</button>}
    </form>}
    {message && <p role="status">{message}</p>}
  </section>
}
