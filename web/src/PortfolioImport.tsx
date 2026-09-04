import { useEffect, useRef, useState } from 'react'
import { api, Modal, money, num } from './ui'

export type ImportPosition = { name: string; shares: number; cost: number | null; sector: string }
export type ImportPreview = {
  valid: boolean
  errors: { row: number; field: string; message: string }[]
  warnings: string[]
  rows: {
    symbol: string
    action: 'add' | 'update' | 'unchanged'
    before: ImportPosition | null
    after: ImportPosition
  }[]
  counts: { add: number; update: number; unchanged: number; total: number }
  fingerprint: string | null
  imported?: { added: number; updated: number; unchanged: number }
}
const MAX_TEXT = 300000
export function PortfolioImport({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => Promise<void>
}) {
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | 'file' | null>(null)
  const [error, setError] = useState('')
  const [imported, setImported] = useState(false)
  const [page, setPage] = useState(0)
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const committing = useRef(false)
  useEffect(
    () => () => {
      controller.current?.abort()
      request.current++
    },
    [],
  )
  function change(value: string) {
    controller.current?.abort()
    request.current++
    setCsv(value)
    setPreview(null)
    setError('')
    setBusy(null)
    setPage(0)
    setImported(false)
  }
  async function readFile(file?: File) {
    if (!file || committing.current) return
    controller.current?.abort()
    const current = ++request.current
    setBusy('file')
    setPreview(null)
    setError('')
    setImported(false)
    try {
      if (file.size > MAX_TEXT * 4) throw new Error('CSV 檔案過大，最多 300,000 個字元。')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (text.length > MAX_TEXT) throw new Error('CSV 內容最多 300,000 個字元。')
      if (current === request.current) {
        setCsv(text.replace(/^\uFEFF/, ''))
        setPage(0)
      }
    } catch (err) {
      if (current === request.current) setError(`讀取 CSV 失敗：${(err as Error).message}`)
    } finally {
      if (current === request.current) setBusy(null)
    }
  }
  async function inspect() {
    if (busy || !csv.trim() || imported) return
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    const current = ++request.current
    setBusy('preview')
    setError('')
    setPreview(null)
    setPage(0)
    try {
      const result = await api<ImportPreview>('/api/portfolio/import/preview', {
        method: 'POST',
        signal: pending.signal,
        body: JSON.stringify({ csv_text: csv }),
      })
      if (current === request.current) setPreview(result)
    } catch (err) {
      if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
    } finally {
      if (current === request.current) setBusy(null)
    }
  }
  async function finish() {
    await onImported()
    onClose()
  }
  async function commit() {
    if (busy || committing.current || imported || !preview?.valid || !preview.fingerprint) return
    committing.current = true
    const current = ++request.current
    const pending = new AbortController()
    controller.current = pending
    setBusy('commit')
    setError('')
    try {
      const response = await fetch('/api/portfolio/import', {
        method: 'POST',
        signal: pending.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_text: csv, expected_fingerprint: preview.fingerprint }),
      })
      if (current !== request.current) return
      if (response.status === 409) {
        setPreview(null)
        setError('持股已在預覽後變更，請重新預覽再確認匯入。CSV 內容仍保留。')
        return
      }
      const result = await response.json().catch(() => null)
      if (current !== request.current) return
      if (!response.ok) {
        if (response.status === 422) setPreview(null)
        const validation = result?.detail?.errors
          ?.map(
            (item: { row: number; field: string; message: string }) =>
              `第 ${item.row} 列 · ${item.field}：${item.message}`,
          )
          .join('；')
        throw new Error(
          typeof result?.detail === 'string'
            ? result.detail
            : validation || `匯入失敗（${response.status}），請重新預覽。`,
        )
      }
      setPreview(result)
      setImported(true)
      try {
        await finish()
      } catch (err) {
        setError(`資料已匯入，但重新整理失敗：${(err as Error).message}`)
      }
    } catch (err) {
      if (current === request.current && !pending.signal.aborted) setError((err as Error).message)
    } finally {
      committing.current = false
      if (current === request.current) setBusy(null)
    }
  }
  const pages = Math.max(1, Math.ceil((preview?.rows.length || 0) / 25))
  return (
    <Modal
      title="匯入持股 CSV"
      onClose={() => {
        if (busy !== 'commit') onClose()
      }}
      wide
    >
      <p className="footnote">
        先預覽每一筆變更，再確認寫入。匯入採合併方式，CSV 未提及的持股會保留；最多 100 筆、300,000
        個字元。
      </p>
      <label>
        選擇 UTF-8 CSV 檔案
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="選擇 UTF-8 CSV 檔案"
          disabled={busy === 'commit' || imported}
          onChange={(event) => {
            void readFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </label>
      <label htmlFor="portfolio-csv">或貼上 CSV 內容</label>
      <textarea
        id="portfolio-csv"
        rows={8}
        value={csv}
        maxLength={MAX_TEXT}
        disabled={busy === 'commit' || busy === 'file' || imported}
        onChange={(event) => change(event.target.value)}
        style={{
          display: 'block',
          width: '100%',
          marginTop: 8,
          padding: 10,
          background: 'var(--background)',
          color: 'var(--text)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          font: 'inherit',
          resize: 'vertical',
        }}
      />
      <p className="footnote">
        必要欄位：symbol, shares, cost。選填：name, sector。觀察名單的 shares 設為 0，cost
        可留空。匯出報表中的計算欄位會由預覽說明是否忽略。
      </p>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <p role="status">
          {busy === 'commit'
            ? '正在寫入持股，完成前請勿關閉視窗。'
            : busy === 'file'
              ? '讀取 CSV 中…'
              : '正在預覽，尚未修改持股…'}
        </p>
      )}
      {preview && (
        <>
          <div className="screen-stats">
            <div>
              <strong>{preview.counts.add}</strong>
              <span>新增</span>
            </div>
            <div>
              <strong>{preview.counts.update}</strong>
              <span>更新</span>
            </div>
            <div>
              <strong>{preview.counts.unchanged}</strong>
              <span>不變</span>
            </div>
          </div>
          {preview.warnings.map((warning, index) => (
            <p className="notice" key={index}>
              {warning}
            </p>
          ))}
          {preview.errors.length > 0 && (
            <div className="error-message" role="alert">
              <ul>
                {preview.errors.map((item, index) => (
                  <li key={index}>
                    第 {item.row} 列 · {item.field}：{item.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>標的／變更</th>
                  <th>股數：原值 → 新值</th>
                  <th>成本：原值 → 新值</th>
                  <th>名稱／產業</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(page * 25, (page + 1) * 25).map((row) => (
                  <tr key={row.symbol}>
                    <td>
                      {row.symbol}
                      <small>
                        {{ add: '新增', update: '更新', unchanged: '不變' }[row.action]}
                      </small>
                    </td>
                    <td>
                      {row.before ? num(row.before.shares, 4) : '—'} → {num(row.after.shares, 4)}
                    </td>
                    <td>
                      {money(row.before?.cost)} → {money(row.after.cost)}
                    </td>
                    <td>
                      {row.before?.name || '—'} → {row.after.name}
                      <small>
                        {row.before?.sector || '—'} → {row.after.sector}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="table-pagination">
              <span>
                第 {page + 1} / {pages} 頁
              </span>
              <div className="actions">
                <button
                  className="button"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一頁預覽
                </button>
                <button
                  className="button"
                  disabled={page + 1 === pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一頁預覽
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy === 'commit'} onClick={onClose}>
          關閉匯入
        </button>
        {imported ? (
          <button
            type="button"
            className="button primary"
            onClick={() =>
              void finish().catch((err) => setError(`重新整理失敗：${(err as Error).message}`))
            }
          >
            重新整理持股
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button"
              disabled={!!busy || !csv.trim()}
              onClick={() => void inspect()}
            >
              預覽匯入
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!!busy || !preview?.valid || !preview.fingerprint}
              onClick={() => void commit()}
            >
              確認匯入 {preview?.counts.total || 0} 筆
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
