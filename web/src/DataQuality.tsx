import { useEffect, useState } from 'react'
import { Renew, Search } from '@carbon/icons-react'
import { api, dateTime, num } from './ui'

export type QualityStatus = 'ok' | 'stale' | 'error' | 'missing'
export type QualityItem = {
  symbol: string
  name: string
  last_date: string | null
  bars: number
  status: QualityStatus
  reason: string
  gap_dates: string[]
  invalid_dates: string[]
  source: string
}
export type DataQualityResult = {
  as_of: string | null
  expected_session: string
  counts: { total: number; ok: number; stale: number; error: number; missing: number }
  items: QualityItem[]
  checked_at: string
}
const statusLabels: Record<QualityStatus, string> = {
  ok: '正常',
  stale: '資料過期',
  error: '資料異常',
  missing: '缺少資料',
}

export function DataQuality({
  onOpen,
  busy,
  onRetry,
}: {
  onOpen: (symbol: string) => void
  busy: boolean
  onRetry: (symbols: string[]) => Promise<void>
}) {
  const [data, setData] = useState<DataQualityResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [onlyIssues, setOnlyIssues] = useState(true)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [retrying, setRetrying] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api<DataQualityResult>('/api/data-quality', { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        setData(result)
        setSelected((previous) =>
          previous.filter((symbol) =>
            result.items.some((item) => item.symbol === symbol && item.status !== 'ok'),
          ),
        )
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision, busy])
  const filtered = (data?.items || []).filter(
    (item) =>
      (!onlyIssues || item.status !== 'ok') &&
      `${item.symbol} ${item.name}`.toLowerCase().includes(query.toLowerCase()),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / 25))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25)
  const retryable = visible.filter((item) => item.status !== 'ok')
  const allVisibleSelected =
    retryable.length > 0 && retryable.every((item) => selected.includes(item.symbol))
  const locked = busy || retrying || loading
  function toggle(symbol: string) {
    setMessage('')
    setSelected((previous) =>
      previous.includes(symbol)
        ? previous.filter((s) => s !== symbol)
        : previous.length < 100
          ? [...previous, symbol]
          : previous,
    )
  }
  async function retry() {
    if (locked || !selected.length) return
    setRetrying(true)
    setMessage('')
    try {
      await onRetry(selected.slice(0, 100))
      setMessage(`已送出 ${selected.length} 檔資料重試，完成後將重新檢查。`)
      setSelected([])
      setRevision((value) => value + 1)
    } catch (err) {
      setMessage(`重試失敗：${(err as Error).message}`)
    } finally {
      setRetrying(false)
    }
  }
  return (
    <section className="data-quality jobs-section" aria-labelledby="data-quality-title">
      <div className="section-heading">
        <div>
          <h2 id="data-quality-title">資料品質檢查</h2>
          <p>依預期交易日檢查日線新鮮度與資料缺口。</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Renew size={16} className={loading ? 'spin' : ''} />
          重新檢查
        </button>
      </div>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="loading-line" role="status">
          正在檢查資料品質…
        </div>
      )}
      {data && (
        <>
          <p className="footnote">
            預期交易日：{data.expected_session} · 最新資料日：{data.as_of || '尚無資料'} ·{' '}
            {dateTime(data.checked_at)} 檢查
          </p>
          <div className="screen-stats">
            <div>
              <strong>{data.counts.total}</strong>
              <span>檢查標的</span>
            </div>
            <div>
              <strong>{data.counts.ok}</strong>
              <span>正常</span>
            </div>
            <div>
              <strong>{data.counts.stale + data.counts.error + data.counts.missing}</strong>
              <span>需要處理</span>
            </div>
          </div>
          <div className="toolbar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(event) => {
                  setOnlyIssues(event.target.checked)
                  setPage(0)
                }}
              />
              只看有問題的資料
            </label>
            <label className="search-field">
              <Search size={16} />
              <input
                aria-label="搜尋資料品質標的"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(0)
                }}
                placeholder="搜尋代碼或公司…"
              />
            </label>
          </div>
          <div className="candidate-filters">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={
                  locked || !retryable.length || (selected.length >= 100 && !allVisibleSelected)
                }
                onChange={() => {
                  setMessage('')
                  setSelected((previous) =>
                    allVisibleSelected
                      ? previous.filter(
                          (symbol) => !retryable.some((item) => item.symbol === symbol),
                        )
                      : [...new Set([...previous, ...retryable.map((item) => item.symbol)])].slice(
                          0,
                          100,
                        ),
                  )
                }}
              />
              選取本頁問題標的
            </label>
            <span className="quiet-label">
              已選 {selected.length} / 100 檔{selected.length === 100 ? ' · 已達單次上限' : ''}
            </span>
            <button
              type="button"
              className="button primary"
              disabled={locked || !selected.length}
              onClick={() => void retry()}
            >
              {retrying ? '送出重試中…' : `重試選取資料（${selected.length}）`}
            </button>
            {selected.length > 0 && (
              <button
                type="button"
                className="text-button"
                disabled={locked}
                onClick={() => setSelected([])}
              >
                清除選取
              </button>
            )}
          </div>
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>選取</th>
                  <th>標的</th>
                  <th>品質狀態</th>
                  <th>最新交易日</th>
                  <th className="number">日線筆數</th>
                  <th>檢查結果</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.symbol}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`選取 ${item.symbol} 重試`}
                        checked={selected.includes(item.symbol)}
                        disabled={
                          locked ||
                          item.status === 'ok' ||
                          (selected.length >= 100 && !selected.includes(item.symbol))
                        }
                        onChange={() => toggle(item.symbol)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpen(item.symbol)}
                      >
                        <strong>{item.symbol}</strong>
                      </button>
                      <small>{item.name}</small>
                    </td>
                    <td>
                      <span
                        className={`badge ${item.status === 'ok' ? 'match' : item.status === 'stale' ? 'stale' : 'insufficient'}`}
                      >
                        {statusLabels[item.status]}
                      </span>
                    </td>
                    <td>{item.last_date || '—'}</td>
                    <td className="number">{num(item.bars, 0)}</td>
                    <td className="data-note">
                      {item.reason}
                      {(item.gap_dates.length > 0 || item.invalid_dates.length > 0) && (
                        <details>
                          <summary>
                            查看異常日期（缺口 {item.gap_dates.length} · 無效{' '}
                            {item.invalid_dates.length}）
                          </summary>
                          {item.gap_dates.length > 0 && <p>缺口：{item.gap_dates.join('、')}</p>}
                          {item.invalid_dates.length > 0 && (
                            <p>無效：{item.invalid_dates.join('、')}</p>
                          )}
                        </details>
                      )}
                      <small>{item.source || '尚無資料來源'}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <div className="empty-state">
                {data.items.length === 0
                  ? '尚無可檢查標的。'
                  : onlyIssues && !query
                    ? '目前沒有需要處理的資料。'
                    : '沒有符合篩選條件的標的。'}
              </div>
            )}
          </div>
          <div className="table-pagination">
            <span>
              {filtered.length} 檔 · 第 {currentPage + 1} / {pages} 頁
            </span>
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一頁
              </button>
              <button
                type="button"
                className="button"
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一頁
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
