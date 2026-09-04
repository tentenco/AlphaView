import { useEffect, useRef, useId } from 'react'
import type { ReactNode } from 'react'
import { Close, Checkmark, ArrowUpRight, ArrowDownRight } from '@carbon/icons-react'
import type { Signal } from './types'

export const num = (value: number | null | undefined, digits = 2) => value == null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
export const money = (value: number | null | undefined) => value == null ? '—' : `$${num(value)}`
export const pct = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${num(value)}%`
export const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未更新'
export function Delta({ value, percent = true }: { value: number | null | undefined; percent?: boolean }) {
  return <span className={value == null || value === 0 ? 'muted' : value > 0 ? 'positive' : 'negative'}>{value != null && value !== 0 && (value > 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />)}{percent ? pct(value) : `${value != null && value > 0 ? '+' : ''}${num(value)}`}</span>
}
export function Badge({ signal }: { signal: Signal }) {
  const labels = { match: '符合條件', watch: '持續觀察', insufficient: '資料不足', stale: '資料過期', data_error: '資料異常' }
  return <details className="signal-badge-details"><summary className={`badge ${signal.status}`} aria-label={`${labels[signal.status]}，查看策略原因`}>{signal.matched ? <Checkmark size={12} /> : <i />}{labels[signal.status]}</summary><p className="signal-badge-reason">{signal.reason || '尚無策略原因說明。'}</p></details>
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = ref.current!; d.showModal(); return () => d.close() }, [])
  return <dialog ref={ref} aria-labelledby={titleId} className={wide ? 'dialog wide' : 'dialog'} onCancel={event => { event.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog-content"><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="關閉視窗" onClick={onClose}><Close size={20} /></button></header>{children}</div>
  </dialog>
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!res.ok) { const error = await res.json().catch(() => ({})); throw new Error(typeof error.detail === 'string' ? error.detail : res.status === 422 ? '欄位格式不正確，請檢查輸入內容' : `伺服器回應異常（${res.status}），請稍後重試`) }
  return res.json()
}
