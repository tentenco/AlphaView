import { useEffect, useState } from 'react'
import { ArrowRight, Renew } from '@carbon/icons-react'
import type { Scope } from './types'
import { api, dateTime } from './ui'

export type ChangeKind =
  'entered' | 'exited' | 'continued' | 'unavailable' | 'universe_added' | 'universe_removed'
export type ChangeEvent = {
  kind: ChangeKind
  symbol: string
  name: string
  strategy: string | null
  previous_status: string | null
  current_status: string | null
  previous_reason: string | null
  current_reason: string | null
  reason: string
}
export type ChangeReport = {
  scope: Scope
  status: 'ready' | 'first_snapshot' | 'no_snapshot'
  current_date: string | null
  previous_date: string | null
  current_snapshot_id: number | null
  previous_snapshot_id: number | null
  current_created_at: string | null
  previous_created_at: string | null
  current_symbols: number
  previous_symbols: number
  counts: Record<ChangeKind, number>
  events: ChangeEvent[]
}
const LABELS: Record<ChangeKind, string> = {
  entered: '新符合策略',
  exited: '條件退出',
  continued: '持續符合',
  unavailable: '無法比較',
  universe_added: '股票池新增',
  universe_removed: '股票池移除',
}
const STRATEGIES: Record<string, string> = {
  turtle: '海龜突破',
  trend: '均線趨勢',
  pullback: '回檔觀察',
  rps: '相對強勢',
}
const STATUSES: Record<string, string> = {
  match: '符合',
  watch: '未符合',
  stale: '資料過期',
  insufficient: '資料不足',
  data_error: '資料異常',
}

export function SignalChanges({
  scope,
  asOf,
  onOpen,
  refreshKey,
}: {
  scope: Scope
  asOf?: string
  onOpen: (symbol: string, scope: Scope, date?: string) => void
  refreshKey?: number
}) {
  const [report, setReport] = useState<ChangeReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<ChangeKind | 'changes' | 'all'>('changes')
  const [page, setPage] = useState(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setReport(null)
    api<ChangeReport>(
      `/api/signal-changes?scope=${scope}${asOf ? `&as_of=${encodeURIComponent(asOf)}` : ''}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) {
          if (
            result.scope !== scope ||
            (asOf && result.current_date && result.current_date !== asOf)
          )
            throw new Error('異動紀錄與所選範圍或日期不一致。')
          setReport(result)
        }
      })
      .catch((err) => {
        if (active) setError((err as Error).message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [scope, asOf, refreshKey, retry])
  useEffect(() => setPage(0), [filter, scope, asOf, refreshKey])
  const current =
    report?.scope === scope &&
    (!asOf || report.current_date === asOf || report.status === 'no_snapshot')
      ? report
      : null
  const events = (current?.events || []).filter(
    (event) =>
      filter === 'all' ||
      (filter === 'changes'
        ? event.kind === 'entered' || event.kind === 'exited'
        : event.kind === filter),
  )
  const pages = Math.max(1, Math.ceil(events.length / 12))
  const visiblePage = Math.min(page, pages - 1)
  return (
    <section className="signal-changes" aria-labelledby="signal-changes-title">
      <div className="section-heading">
        <div>
          <h2 id="signal-changes-title">每日訊號異動</h2>
          <p>比較同股票池相鄰兩個已儲存日期，找出策略狀態的變化。</p>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => setRetry((n) => n + 1)}
          disabled={loading}
        >
          <Renew size={14} />
          重新讀取異動
        </button>
      </div>
      {loading ? (
        <div className="loading-line" role="status">
          正在比較每日訊號…
        </div>
      ) : error ? (
        <div className="error-message" role="alert">
          {error}
        </div>
      ) : !current || current.status === 'no_snapshot' ? (
        <div className="empty-state">所選日期尚無選股紀錄，執行選股後即可比較。</div>
      ) : current.status === 'first_snapshot' ? (
        <div className="empty-state">
          {current.current_date}{' '}
          是這個股票池第一份可用紀錄，尚無較早日期可比較。現有符合條件的標的不會一律標成新訊號。
        </div>
      ) : (
        <>
          <p className="signal-changes-period">
            {current.previous_date} → {current.current_date} ·{' '}
            {scope === 'market' ? '市場候選股票池' : '我的持股與觀察清單'}
          </p>
          <div className="signal-changes-counts">
            {(Object.keys(LABELS) as ChangeKind[]).map((kind) => (
              <button
                type="button"
                key={kind}
                className={`signal-change-count ${filter === kind ? 'active' : ''}`}
                aria-pressed={filter === kind}
                onClick={() => setFilter(kind)}
              >
                <strong>{current.counts[kind]}</strong>
                <span>{LABELS[kind]}</span>
                <small>{kind.startsWith('universe_') ? '檔標的' : '筆標的／策略'}</small>
              </button>
            ))}
          </div>
          <div className="toolbar">
            <label>
              異動類型
              <select
                aria-label="異動類型"
                value={filter}
                onChange={(e) => setFilter(e.target.value as typeof filter)}
              >
                <option value="changes">策略新符合與退出</option>
                <option value="all">全部紀錄</option>
                {(Object.keys(LABELS) as ChangeKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <span className="quiet-label">{events.length} 筆紀錄</span>
          </div>
          {events.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>標的</th>
                    <th>變化</th>
                    <th>策略</th>
                    <th>前期 → 本期</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(visiblePage * 12, (visiblePage + 1) * 12).map((event) => (
                    <tr key={`${event.kind}-${event.symbol}-${event.strategy || 'membership'}`}>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            onOpen(
                              event.symbol,
                              scope,
                              (event.kind === 'universe_removed'
                                ? current.previous_date
                                : current.current_date) || undefined,
                            )
                          }
                        >
                          <strong>{event.symbol}</strong>
                          <ArrowRight size={14} />
                        </button>
                        <small>{event.name}</small>
                      </td>
                      <td>
                        <span
                          className={`badge ${event.kind === 'entered' ? 'match' : event.kind === 'unavailable' ? 'insufficient' : 'neutral'}`}
                        >
                          {LABELS[event.kind]}
                        </span>
                      </td>
                      <td>
                        {event.strategy
                          ? STRATEGIES[event.strategy] || event.strategy
                          : '股票池成分'}
                      </td>
                      <td>
                        {event.strategy
                          ? `${STATUSES[event.previous_status || ''] || '無紀錄'} → ${STATUSES[event.current_status || ''] || '無紀錄'}`
                          : '—'}
                      </td>
                      <td className="signal-change-reason">
                        <span>{event.reason}</span>
                        {event.previous_reason && <small>前期：{event.previous_reason}</small>}
                        {event.current_reason && <small>本期：{event.current_reason}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              這兩期沒有符合此類型的異動。可切換「全部紀錄」查看持續符合、資料狀態或股票池變動。
            </div>
          )}
          {events.length > 12 && (
            <div className="table-pagination">
              <span>
                第 {visiblePage + 1} / {pages} 頁
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={!visiblePage}
                  onClick={() => setPage(visiblePage - 1)}
                >
                  上一頁異動
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={visiblePage + 1 >= pages}
                  onClick={() => setPage(visiblePage + 1)}
                >
                  下一頁異動
                </button>
              </div>
            </div>
          )}
          <p className="footnote">
            比較快照 #{current.previous_snapshot_id}（{dateTime(current.previous_created_at)}）與 #
            {current.current_snapshot_id}（{dateTime(current.current_created_at)}
            ）。股票池擴充或成分調整可能改變 RPS
            排名，即使股價未變亦可能出現訊號異動。同日重跑不當成新交易日；資料不足、過期或異常不當成策略退出。股票池成分變動另列，計數不代表交易建議。
          </p>
        </>
      )}
    </section>
  )
}
