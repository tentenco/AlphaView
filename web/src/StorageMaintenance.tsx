import { useEffect, useRef, useState } from 'react'
import { api, num } from './ui'

export type StorageUsage = {
  fingerprint: string
  scan_rows: number
  retained_scan_rows: number
  superseded_scan_rows: number
  superseded_payload_bytes: number
  tables: { name: string; rows: number; payload_bytes: number | null }[]
  database_bytes: number
  wal_bytes: number
  page_size: number
  page_count: number
  freelist_pages: number
  reusable_bytes: number
  cleanup_available: boolean
  warnings: string[]
}
const tableNames: Record<string, string> = {
  positions: '持倉與觀察名單',
  market_universe: '市場股票池',
  market_universe_metadata: '股票池更新資訊',
  bars: '歷史行情',
  datasets: '行情來源紀錄',
  scans: '選股快照',
  backtests: '策略回測',
  research_notes: '研究筆記',
  jobs: '作業紀錄',
  refresh_schedule: '更新排程',
  schedule_attempts: '排程執行紀錄',
}
const bytes = (value: number | null) =>
  value == null
    ? '—'
    : value >= 1048576
      ? `${num(value / 1048576, 2)} MiB`
      : `${num(value / 1024, 1)} KiB`
export function StorageMaintenance() {
  const [data, setData] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const active = useRef(false)
  const commitRequest = useRef<AbortController | null>(null)
  const locked = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      commitRequest.current?.abort()
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setReview(false)
    setError('')
    api<StorageUsage>('/api/storage', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision])
  async function cleanup() {
    if (
      !data ||
      !review ||
      loading ||
      locked.current ||
      !data.cleanup_available ||
      !data.superseded_scan_rows
    )
      return
    locked.current = true
    setBusy(true)
    setError('')
    setMessage('')
    const controller = new AbortController()
    commitRequest.current = controller
    try {
      const result = await api<{
        deleted_rows: number
        deleted_payload_bytes: number
        storage: StorageUsage
      }>('/api/storage/cleanup', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ expected_fingerprint: data.fingerprint, confirm: true }),
      })
      if (!active.current || controller.signal.aborted) return
      setData(result.storage)
      setMessage(
        `已清理 ${result.deleted_rows} 筆重複選股快照（內容 ${bytes(result.deleted_payload_bytes)}）。`,
      )
    } catch (err) {
      if (active.current && !controller.signal.aborted)
        setError(`${(err as Error).message} 請重新整理用量，再檢視清理範圍。`)
    } finally {
      locked.current = false
      if (active.current && !controller.signal.aborted) {
        setBusy(false)
        setReview(false)
      }
    }
  }
  return (
    <section
      className="jobs-section storage-maintenance"
      aria-labelledby="storage-maintenance-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="storage-maintenance-title">本機儲存空間</h2>
          <p>檢查資料用量，手動清理同範圍、同日期被較新結果取代的選股快照。</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={loading || busy}
          onClick={() => {
            setMessage('')
            setRevision((value) => value + 1)
          }}
        >
          重新整理用量
        </button>
      </div>
      {loading && (
        <p role="status" className="loading-line">
          正在讀取儲存用量…
        </p>
      )}
      {error && (
        <div role="alert" className="error-message">
          {error}
        </div>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {data && (
        <>
          <div className="metrics-wrap">
            <div className="metrics compact">
              <div>
                <p>資料庫檔案</p>
                <h2>{bytes(data.database_bytes)}</h2>
                <small>待整合寫入紀錄 {bytes(data.wal_bytes)}</small>
              </div>
              <div>
                <p>全部選股快照</p>
                <h2>{num(data.scan_rows, 0)}</h2>
                <small>保留 {num(data.retained_scan_rows, 0)} 筆各日期最新結果</small>
              </div>
              <div>
                <p>可清理重複快照</p>
                <h2>{num(data.superseded_scan_rows, 0)}</h2>
                <small>內容 {bytes(data.superseded_payload_bytes)}</small>
              </div>
              <div>
                <p>資料庫可重用空間</p>
                <h2>{bytes(data.reusable_bytes)}</h2>
                <small>可供後續寫入使用</small>
              </div>
            </div>
          </div>
          <details>
            <summary>檢視各類資料用量</summary>
            <div className="table-scroll" role="region" aria-label="各類資料用量" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">資料類別</th>
                    <th scope="col">筆數</th>
                    <th scope="col">內容大小</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tables.map((table) => (
                    <tr key={table.name}>
                      <td>{tableNames[table.name] || table.name}</td>
                      <td>{num(table.rows, 0)}</td>
                      <td>{bytes(table.payload_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="footnote">
            只移除同股票池、同日期的舊版選股快照，保留各日期最新一筆。持倉、筆記、行情、回測、作業與排程紀錄全部保留；清理前可先使用本頁「下載本機備份」。
          </p>
          <p className="footnote">
            清理後的空間可供後續寫入重用，資料庫檔案不一定縮小。內容大小僅計算文字內容，不含儲存結構開銷，因此不等於可回收的磁碟空間；檔案大小會隨其他作業變動。
          </p>
          {!review ? (
            <button
              type="button"
              className="button"
              disabled={
                loading ||
                busy ||
                !!error ||
                !data.cleanup_available ||
                data.superseded_scan_rows === 0
              }
              onClick={() => setReview(true)}
            >
              檢視清理範圍
            </button>
          ) : (
            <div className="notice storage-review" role="region" aria-label="確認清理範圍">
              <p>
                即將刪除 {num(data.superseded_scan_rows, 0)} 筆已被取代的選股快照，保留{' '}
                {num(data.retained_scan_rows, 0)} 筆各範圍、各日期最新快照。清理無法在此撤銷。
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setReview(false)}
                >
                  返回，不清理
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || loading}
                  onClick={cleanup}
                >
                  {busy ? '正在清理…' : '確認清理重複快照'}
                </button>
              </div>
            </div>
          )}
          {!data.superseded_scan_rows && <p className="footnote">目前沒有可清理的重複選股快照。</p>}
        </>
      )}
    </section>
  )
}
