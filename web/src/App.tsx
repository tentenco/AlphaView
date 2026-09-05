import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ChartLine,
  Checkmark,
  Dashboard,
  DataBase,
  Document,
  Filter,
  Help,
  Menu,
  Play,
  Portfolio as PortfolioIcon,
  Renew,
  Search,
  ChartEvaluation,
  WarningAlt,
} from '@carbon/icons-react'
import type { Overview, Position, StockDetail, Scope } from './types'
import { api, dateTime, Delta, Modal, money, num } from './ui'
import { Portfolio, PortfolioTable, PositionEditor } from './Portfolio'
import { StockModal, Strategies } from './Research'
import { Screener } from './Screener'
import type { UniverseLimit } from './Screener'
import { DataQuality } from './DataQuality'
import { MarketOverview } from './MarketOverview'
import { WorkspaceBackup } from './WorkspaceBackup'
import { ScheduleSettings } from './ScheduleSettings'
import { StorageMaintenance } from './StorageMaintenance'
import { PriceChart } from './Charts'

type Page = 'overview' | 'market' | 'screener' | 'portfolio' | 'strategies' | 'data'
const nav = [
  { id: 'overview', title: '投資總覽', icon: Dashboard },
  { id: 'market', title: '市場概況', icon: ChartEvaluation },
  { id: 'screener', title: '每日選股', icon: Filter },
  { id: 'portfolio', title: '我的持股', icon: PortfolioIcon },
  { id: 'strategies', title: '策略研究', icon: ChartLine },
  { id: 'data', title: '資料管理', icon: DataBase },
] as const

function Home({
  data,
  onOpen,
  navigate,
  onRun,
  busy,
}: {
  data: Overview
  onOpen: (s: string) => void
  navigate: (p: Page, screen?: { scope: Scope; strategy: string }) => void
  onRun: () => void
  busy: boolean
}) {
  const [symbol, setSymbol] = useState(data.positions[0]?.symbol || '')
  const [chart, setChart] = useState<StockDetail | null>(null)
  const [range, setRange] = useState(63)
  const [chartError, setChartError] = useState('')
  useEffect(() => {
    if (!data.positions.some((position) => position.symbol === symbol))
      setSymbol(data.positions[0]?.symbol || '')
  }, [symbol, data.positions.map((position) => position.symbol).join(',')])
  useEffect(() => {
    let active = true
    setChart(null)
    setChartError('')
    if (!symbol) return
    api<StockDetail>(`/api/stocks/${symbol}`)
      .then((r) => {
        if (active) setChart(r)
      })
      .catch((e) => {
        if (active) setChartError(e.message)
      })
    return () => {
      active = false
    }
  }, [symbol, data.datasets.find((d) => d.symbol === symbol)?.fetched_at])
  const s = data.summary
  const date = s.dates.at(-1)
  const holding = [...data.positions]
    .filter((p) => p.shares > 0)
    .sort((a, b) => (b.weight ?? -Infinity) - (a.weight ?? -Infinity))
  const allocationComplete = holding.every(
    (position) => position.market_value != null && position.weight != null,
  )
  const matches = data.scan?.result.filter((r) => r.signals.some((s) => s.matched)) || []
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">Your market, in focus</div>
          <h1>投資總覽</h1>
          <p>掌握持股變化，找到下一個值得研究的機會。</p>
        </div>
        <div className="date-label">
          <span className="status-dot" />
          {date || '等待行情'}
          <span className="muted">美股日線</span>
        </div>
      </div>
      {(s.partial || s.mixed_dates || s.day_change_partial) && (
        <div className="notice">
          <WarningAlt size={16} />
          <div>
            {s.partial && (
              <p>
                估值資料未完整，總市值與損益僅計入可用資料；報價覆蓋 {s.priced_count} /{' '}
                {s.holding_count} 檔持股。
              </p>
            )}
            {s.mixed_dates && <p>各持股報價日期不同，總值為各自最新可用收盤價合計。</p>}
            {s.day_change_partial && (
              <p>
                當日損益資料未完整或交易日不一致，暫不合計；可比較 {s.day_change_covered_count ?? 0}{' '}
                / {s.holding_count} 檔持股。
              </p>
            )}
          </div>
        </div>
      )}
      <div className="metrics-wrap">
        <div className="metrics">
          <div>
            <p>
              持股總市值 <span>USD</span>
            </p>
            <h2>{money(s.market_value)}</h2>
            <small>
              {s.holding_count} 檔持股 · {s.watch_count} 檔觀察
            </small>
          </div>
          <div>
            <p>當日損益</p>
            <h2>
              <Delta value={s.day_change_partial ? null : s.day_change} percent={false} />
            </h2>
            <small>
              <Delta value={s.day_change_partial ? null : s.day_change_pct} /> 對比前一交易日
            </small>
          </div>
          <div>
            <p>未實現損益</p>
            <h2>
              <Delta value={s.pnl} percent={false} />
            </h2>
            <small>
              <Delta value={s.pnl_pct} /> 相對持股成本
            </small>
          </div>
          <div>
            <p>符合策略的標的</p>
            <h2>
              {s.matched_count}
              <span className="stat-denominator"> / {data.positions.length}</span>
            </h2>
            <small>
              {data.strategies.length} 個策略 ·{' '}
              {data.scan ? dateTime(data.scan.created_at) : '尚未掃描'}
            </small>
          </div>
        </div>
      </div>
      <div className="overview-grid">
        <section className="market-chart">
          <div className="section-heading">
            <div className="actions">
              <h2>市場走勢</h2>
              <select
                name="chart-symbol"
                aria-label="走勢標的"
                disabled={!data.positions.length}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              >
                {data.positions.map((p) => (
                  <option key={p.symbol} value={p.symbol}>
                    {p.symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="segments">
              {[
                [21, '1M'],
                [63, '3M'],
                [126, '6M'],
                [252, '1Y'],
              ].map(([n, label]) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => setRange(Number(n))}
                  className={range === n ? 'active' : ''}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-headline">
            <strong>{money(chart?.position.price)}</strong>
            <Delta value={chart?.position.change_pct} />
            <small>{chart?.position.name || symbol}</small>
          </div>
          {!symbol ? (
            <div className="chart-empty">先到「我的持股」新增觀察標的，再更新行情查看走勢。</div>
          ) : chartError ? (
            <div className="error-message" role="alert">
              {chartError}
            </div>
          ) : chart ? (
            <PriceChart data={chart.history.slice(-range)} average={false} />
          ) : (
            <div className="chart-empty">載入走勢中…</div>
          )}
          <div className="chart-footer">
            <span>
              <i className="legend-dot" />
              調整收盤價 · USD
            </span>
            <button
              type="button"
              className="text-button"
              disabled={!symbol}
              onClick={() => onOpen(symbol)}
            >
              查看技術指標 <ArrowRight size={14} />
            </button>
          </div>
        </section>
        <section className="allocation">
          <div className="section-heading">
            <h2>持股配置</h2>
            <span className="muted">{allocationComplete ? '市值占比' : '報價未完整'}</span>
          </div>
          {allocationComplete ? (
            <div className="allocation-bar">
              {holding.map((p, i) => (
                <div
                  key={p.symbol}
                  title={`${p.symbol} ${num(p.weight, 1)}%`}
                  style={{ width: `${p.weight}%`, background: `var(--allocation-${i % 6})` }}
                />
              ))}
            </div>
          ) : (
            <p className="footnote">部分持股無可用估值，暫不顯示配置比例。</p>
          )}
          <div className="allocation-list">
            {holding.map((p, i) => (
              <button type="button" key={p.symbol} onClick={() => onOpen(p.symbol)}>
                <i style={{ background: `var(--allocation-${i % 6})` }} />
                <strong>{p.symbol}</strong>
                <span>{money(p.market_value)}</span>
                <b>{allocationComplete ? `${num(p.weight, 1)}%` : '—'}</b>
              </button>
            ))}
          </div>
          {allocationComplete && (holding[0]?.weight ?? 0) > 40 && (
            <div className="allocation-note">
              <WarningAlt size={16} />
              <p>
                {holding[0].symbol} 占持股 {num(holding[0].weight, 1)}%，留意單一標的集中度。
              </p>
            </div>
          )}
        </section>
      </div>
      <section className="daily-section">
        <div className="section-heading">
          <div>
            <h2>
              持股策略觀察 <span className="count">{matches.length}</span>
            </h2>
            <p>{data.scan?.as_of || '尚未執行'} · 從你的清單中尋找符合條件的標的</p>
          </div>
          <button type="button" className="button primary" onClick={onRun} disabled={busy}>
            <Play size={16} />
            {busy ? '執行中…' : '執行選股'}
          </button>
        </div>
        <div className="signal-summary">
          {data.strategies.map((strategy, i) => {
            const matched =
              data.scan?.result.filter(
                (r) => r.signals.find((s) => s.strategy === strategy.id)?.matched,
              ) || []
            return (
              <button
                type="button"
                key={strategy.id}
                onClick={() => navigate('screener', { scope: 'portfolio', strategy: strategy.id })}
              >
                <div className="signal-top">
                  <span className="strategy-number">0{i + 1}</span>
                  <ArrowRight size={16} />
                </div>
                <h3>{strategy.name}</h3>
                <div className="signal-bottom">
                  <strong>
                    {matched.length}
                    <small> 檔符合</small>
                  </strong>
                  <span>{matched.map((r) => r.symbol).join(' · ') || '持續觀察'}</span>
                </div>
              </button>
            )
          })}
        </div>
      </section>
      <section className="watchlist-section">
        <div className="section-heading">
          <h2>我的觀察清單</h2>
          <button type="button" className="text-button" onClick={() => navigate('portfolio')}>
            管理持股 <ArrowRight size={16} />
          </button>
        </div>
        <PortfolioTable positions={data.positions} onOpen={onOpen} compact />
      </section>
      <p className="footnote">
        資料來源 Yahoo Finance · 日線行情，非即時串流。策略用於研究，不會自動下單。
      </p>
    </>
  )
}

function DataPage({
  data,
  onRefresh,
  busy,
  onRetry,
  onOpen,
}: {
  data: Overview
  onRefresh: () => void
  busy: boolean
  onRetry: (symbols: string[]) => Promise<void>
  onOpen: (symbol: string) => void
}) {
  const total = data.datasets.reduce((n, d) => n + d.bar_count, 0)
  const [datasetQuery, setDatasetQuery] = useState('')
  const [datasetPage, setDatasetPage] = useState(0)
  const allMembers = [
    ...data.positions,
    ...data.market_universe.filter((m) => !data.positions.some((p) => p.symbol === m.symbol)),
  ]
  const filteredMembers = allMembers.filter((p) =>
    `${p.symbol} ${p.name}`.toLowerCase().includes(datasetQuery.toLowerCase()),
  )
  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / 25))
  const currentPage = Math.min(datasetPage, totalPages - 1)

  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">Data workspace</div>
          <h1>資料管理</h1>
          <p>查看行情來源、更新進度與每個標的的資料品質。</p>
        </div>
        <button type="button" className="button primary" onClick={onRefresh} disabled={busy}>
          <Renew size={16} className={busy ? 'spin' : ''} />
          {busy ? '更新中…' : '更新我的清單'}
        </button>
      </div>
      <div className="metrics-wrap">
        <div className="metrics compact">
          <div>
            <p>歷史日線</p>
            <h2>{num(total, 0)}</h2>
            <small>已儲存於本地資料庫</small>
          </div>
          <div>
            <p>行情來源</p>
            <h2 className="text-medium">Yahoo Finance</h2>
            <small>透過 yfinance 下載</small>
          </div>
          <div>
            <p>已建選股日期</p>
            <h2>{data.scan_dates.length}</h2>
            <small>保留最近 60 個交易日的檢視</small>
          </div>
          <div>
            <p>行情更新方式</p>
            <h2 className="text-medium">手動／排程</h2>
            <small>可在下方設定收盤後自動更新</small>
          </div>
        </div>
      </div>
      <ScheduleSettings
        defaultUniverseLimit={
          Math.max(data.market_universe.length, data.market_universe_meta?.requested_limit || 0) >
          500
            ? 1000
            : Math.max(
                  data.market_universe.length,
                  data.market_universe_meta?.requested_limit || 0,
                ) > 250
              ? 500
              : 250
        }
        refreshKey={data.jobs.map((job) => `${job.id}:${job.status}`).join(',')}
      />
      <WorkspaceBackup />
      <StorageMaintenance />
      <DataQuality busy={busy} onRetry={onRetry} onOpen={onOpen} />
      <div className="section-heading">
        <h2>
          標的資料狀態 <span className="count">{allMembers.length}</span>
        </h2>
        <label className="search-field">
          <Search size={16} />
          <input
            name="dataset-query"
            aria-label="搜尋資料標的"
            value={datasetQuery}
            onChange={(e) => {
              setDatasetQuery(e.target.value)
              setDatasetPage(0)
            }}
            placeholder="搜尋代碼或公司…"
          />
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>標的</th>
              <th>狀態</th>
              <th className="number">日線筆數</th>
              <th>最新交易日</th>
              <th>最後成功更新</th>
              <th>備註</th>
            </tr>
          </thead>
          <tbody>
            {filteredMembers.slice(currentPage * 25, (currentPage + 1) * 25).map((p) => {
              const d = data.datasets.find((x) => x.symbol === p.symbol)
              return (
                <tr key={p.symbol}>
                  <td>
                    <strong>{p.symbol}</strong>
                    <small>{p.name}</small>
                  </td>
                  <td>
                    <span className={`badge ${d?.status === 'ok' ? 'match' : 'insufficient'}`}>
                      <i />
                      {d?.status === 'ok'
                        ? '已同步'
                        : d?.status === 'error'
                          ? '更新失敗'
                          : '等待更新'}
                    </span>
                  </td>
                  <td className="number">{d?.bar_count || 0}</td>
                  <td>{d?.last_date || '—'}</td>
                  <td>{dateTime(d?.fetched_at)}</td>
                  <td className="data-note">
                    {d?.error ||
                      ((d?.bar_count || 0) < 200
                        ? '未滿 200 日，部分策略不適用'
                        : '可計算全部單檔策略')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="table-pagination">
        <span>
          {filteredMembers.length} 檔 · 第 {currentPage + 1} / {totalPages} 頁
        </span>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={currentPage === 0}
            onClick={() => setDatasetPage(currentPage - 1)}
          >
            上一頁
          </button>
          <button
            type="button"
            className="button"
            disabled={currentPage + 1 >= totalPages}
            onClick={() => setDatasetPage(currentPage + 1)}
          >
            下一頁
          </button>
        </div>
      </div>
      <section className="jobs-section">
        <div className="section-heading">
          <h2>執行紀錄</h2>
        </div>
        {data.jobs.length ? (
          <div className="job-list">
            {data.jobs.map((job) => (
              <div key={job.id}>
                <span className={`job-icon ${job.status}`}>
                  <Checkmark size={16} />
                </span>
                <div>
                  <strong>
                    {job.scope === 'market' ? '市場候選 · ' : '我的清單 · '}
                    {job.kind === 'retry'
                      ? '指定標的重試與掃描'
                      : job.kind === 'refresh'
                        ? '行情更新與策略掃描'
                        : '策略掃描'}
                  </strong>
                  <small>{job.error || job.progress}</small>
                </div>
                <span className="badge neutral">
                  {
                    (
                      {
                        completed: '已完成',
                        running: '執行中',
                        failed: '失敗',
                        partial: '部分完成',
                        interrupted: '已中斷',
                        cancelled: '已取消',
                      } as Record<string, string>
                    )[job.status]
                  }
                </span>
                <time>{dateTime(job.started_at)}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">尚無透過面板執行的作業紀錄。</p>
        )}
      </section>
      <div className="research-note">
        <h3>資料與計算方式</h3>
        <p>
          持股數與平均成本由使用者輸入，僅儲存在本地工作區。日線下載最近兩年資料，每次成功更新後完整替換該標的日線，以反映除權息調整。尚未收盤的當日
          K 線不納入掃描；來源暫時不可用時保留先前資料並標示錯誤。
        </p>
        <p>
          SPCX 僅使用 SpaceX 上市後的資料，避免混入曾使用同代碼的
          ETF。相對強度依所選股票池分開計算；市場候選不會自動成為持股。
        </p>
      </div>
    </>
  )
}

export default function App() {
  const initial = location.hash.slice(1) as Page
  const [page, setPage] = useState<Page>(nav.some((n) => n.id === initial) ? initial : 'overview')
  const [screenInitial, setScreenInitial] = useState<{ scope: Scope; strategy: string }>({
    scope: 'market',
    strategy: 'all',
  })
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const [stockScope, setStockScope] = useState<Scope>('portfolio')
  const [stockDate, setStockDate] = useState<string | undefined>()
  const openStock = (symbol: string, scope: Scope = 'portfolio', date?: string) => {
    setOpened(symbol)
    setStockScope(scope)
    setStockDate(date)
  }
  const [editor, setEditor] = useState<Position | null | undefined>(undefined)
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [help, setHelp] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [starting, setStarting] = useState(false)
  const pendingJob = useRef<string | null>(null)
  const [toast, setToast] = useState('')
  const mounted = useRef(true)
  const overviewRequest = useRef(0)
  const overviewController = useRef<AbortController | null>(null)
  const overviewPending = useRef(false)
  const lastOverviewAttempt = useRef(-Infinity)
  const overviewFailed = useRef(false)
  const load = useCallback(async (replace = true) => {
    if (!replace && overviewPending.current) return
    overviewController.current?.abort()
    const controller = new AbortController()
    overviewController.current = controller
    const current = ++overviewRequest.current
    overviewPending.current = true
    lastOverviewAttempt.current = Date.now()
    try {
      const result = await api<Overview>('/api/overview', { signal: controller.signal })
      if (mounted.current && current === overviewRequest.current) {
        overviewFailed.current = false
        setData(result)
        setError('')
      }
    } catch (err) {
      if (mounted.current && current === overviewRequest.current && !controller.signal.aborted) {
        overviewFailed.current = true
        setError((err as Error).message)
      }
    } finally {
      if (current === overviewRequest.current) overviewPending.current = false
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      overviewController.current?.abort()
      overviewRequest.current++
      overviewPending.current = false
    }
  }, [load])
  const hasActiveJob = data?.jobs.some((item) => item.status === 'running') ?? false
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const visible = () => document.visibilityState !== 'hidden'
    function schedule() {
      clearTimeout(timer)
      if (disposed || !visible()) return
      timer = setTimeout(
        () => void refresh(),
        !overviewFailed.current && hasActiveJob ? 4000 : 30000,
      )
    }
    async function refresh() {
      clearTimeout(timer)
      if (disposed || !visible()) return
      await load(false)
      schedule()
    }
    function resume() {
      if (!visible()) {
        clearTimeout(timer)
        return
      }
      // A visibility event and window focus commonly arrive together.
      if (overviewPending.current || Date.now() - lastOverviewAttempt.current < 1000) {
        schedule()
        return
      }
      void refresh()
    }
    schedule()
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
    }
  }, [hasActiveJob, load])
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 5000)
      return () => clearTimeout(timer)
    }
  }, [toast])
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobile(false)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (!document.querySelector('dialog[open]')) setSearch(true)
      }
    }
    window.addEventListener('keydown', listener)
    const hash = () => {
      const p = location.hash.slice(1)
      if (nav.some((n) => n.id === p)) setPage(p as Page)
    }
    window.addEventListener('hashchange', hash)
    return () => {
      window.removeEventListener('keydown', listener)
      window.removeEventListener('hashchange', hash)
    }
  }, [])
  const navigate = (p: Page, screen?: { scope: Scope; strategy: string }) => {
    if (p === 'screener') setScreenInitial(screen || { scope: 'market', strategy: 'all' })
    location.hash = p
    setPage(p)
    setMobile(false)
    window.scrollTo({ top: 0 })
  }
  useEffect(() => {
    const finished = data?.jobs.find((j) => j.id === pendingJob.current && j.status !== 'running')
    if (finished) {
      pendingJob.current = null
      setToast(finished.error || finished.progress)
    }
  }, [data?.jobs])
  const job = data?.jobs.find((j) => j.status === 'running')
  const busy = starting || !!job
  async function run(kind: string, scope: Scope = 'portfolio', universeLimit?: UniverseLimit) {
    setStarting(true)
    try {
      const started = await api<{ id: string }>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          scope,
          ...(kind === 'refresh' && scope === 'market' && universeLimit
            ? { universe_limit: universeLimit }
            : {}),
        }),
      })
      pendingJob.current = started.id
      setToast(kind === 'refresh' ? '行情更新已開始，完成後自動計算每日選股。' : '選股計算已開始。')
      await load()
    } catch (err) {
      setToast((err as Error).message)
    } finally {
      setStarting(false)
    }
  }
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState('')
  const cancelPending = useRef(false)
  useEffect(() => {
    if (
      cancellingId &&
      !data?.jobs.some((item) => item.id === cancellingId && item.status === 'running')
    )
      setCancellingId(null)
  }, [data?.jobs, cancellingId])
  async function cancelJob() {
    if (!job || cancelPending.current || cancellingId === job.id || Boolean(job.cancel_requested))
      return
    const id = job.id
    cancelPending.current = true
    setCancellingId(id)
    setCancelError('')
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      if (mounted.current) {
        pendingJob.current = id
        await load()
      }
    } catch (err) {
      if (mounted.current) {
        setCancellingId(null)
        setCancelError(`取消作業失敗：${(err as Error).message}`)
      }
    } finally {
      cancelPending.current = false
    }
  }
  const searchable = data
    ? [
        ...data.positions.map((p) => ({ ...p, scope: 'portfolio' as Scope })),
        ...data.market_universe
          .filter((m) => !data.positions.some((p) => p.symbol === m.symbol))
          .map((m) => ({ ...m, scope: 'market' as Scope })),
      ]
    : []
  const searchResults = searchable.filter((p) =>
    `${p.symbol} ${p.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-group">
          <button
            type="button"
            className="icon-button mobile-toggle"
            aria-label="切換導覽"
            aria-expanded={mobile}
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <a href="#overview" className="brand" aria-label="AlphaView 首頁">
            <ChartEvaluation size={23} />
            <span>
              Alpha<span className="brand-x">View</span>
            </span>
          </a>
          <span className="header-divider" />
          <span className="workspace-label">投資研究工作台</span>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="search-trigger"
            aria-label="搜尋標的"
            onClick={() => {
              if (!document.querySelector('dialog[open]')) setSearch(true)
            }}
          >
            <Search size={16} />
            <span>搜尋標的</span>
            <kbd>⌘ K</kbd>
          </button>
          <span className="header-divider" />
          <span className="local-label">
            <i />
            本地工作區
          </span>
          <div className="profile" title="個人研究工作區">
            AV
          </div>
        </div>
      </header>
      <aside className={`icon-rail ${mobile ? 'open' : ''}`}>
        <nav aria-label="主要導覽">
          {nav.map((item) => (
            <button
              type="button"
              className={page === item.id ? 'active' : ''}
              aria-current={page === item.id ? 'page' : undefined}
              aria-label={item.title}
              title={item.title}
              onClick={() => navigate(item.id)}
              key={item.id}
            >
              <item.icon size={20} />
              <span>{item.title}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <button
            type="button"
            aria-label="使用說明"
            title="使用說明"
            onClick={() => setHelp(true)}
          >
            <Help size={20} />
            <span>使用說明</span>
          </button>
          <div className="rail-indicator" title="本地研究模式" />
        </div>
      </aside>
      {mobile && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="關閉導覽"
          onClick={() => setMobile(false)}
        />
      )}
      <main className="main">
        <div className="breadcrumb">
          個人工作區 <span>/</span> <strong>{nav.find((n) => n.id === page)?.title}</strong>
          {page !== 'data' && page !== 'screener' && page !== 'market' && (
            <button
              type="button"
              className="text-button"
              onClick={() => run('refresh')}
              disabled={busy}
            >
              <Renew size={14} className={busy ? 'spin' : ''} />
              {busy ? '更新中' : '更新行情'}
            </button>
          )}
        </div>
        {job && (
          <div className="job-banner" role="status">
            <Renew size={16} className="spin" />
            <span>{job.progress}</span>
            <button
              type="button"
              className="button"
              disabled={cancellingId === job.id || Boolean(job.cancel_requested)}
              onClick={() => void cancelJob()}
            >
              {cancellingId === job.id || Boolean(job.cancel_requested) ? '取消中…' : '取消作業'}
            </button>
            {(cancellingId === job.id || Boolean(job.cancel_requested)) && (
              <small>等待目前步驟停止，先前完整選股結果會保留。</small>
            )}
            <button type="button" className="text-button" onClick={() => navigate('data')}>
              查看進度 <ArrowRight size={14} />
            </button>
          </div>
        )}
        {cancelError && (
          <div className="error-message" role="alert">
            {cancelError}
          </div>
        )}
        {error && (
          <div className="error-message" role="alert">
            {error}
            <button type="button" className="text-button" onClick={() => void load()}>
              重試
            </button>
          </div>
        )}
        {!data ? (
          <div className="initial-loading">
            <ChartEvaluation size={32} />
            <h2>載入你的研究工作區</h2>
            <p>正在讀取持股與策略資料…</p>
          </div>
        ) : (
          <>
            {page === 'overview' && (
              <Home
                data={data}
                onOpen={openStock}
                navigate={navigate}
                onRun={() => run('scan')}
                busy={busy}
              />
            )}{' '}
            {page === 'market' && (
              <MarketOverview
                data={data}
                onOpen={openStock}
                onScreener={() => navigate('screener', { scope: 'market', strategy: 'all' })}
                onStrategy={(strategy) => navigate('screener', { scope: 'market', strategy })}
              />
            )}
            {page === 'portfolio' && (
              <Portfolio
                onImported={() => load()}
                riskRefreshKey={JSON.stringify([
                  data.positions.map((p) => [p.symbol, p.shares, p.name, p.price_date, p.price]),
                  data.datasets.map((d) => [d.symbol, d.fetched_at, d.status]),
                ])}
                positions={data.positions}
                onOpen={openStock}
                onEdit={setEditor}
                onAdd={() => setEditor(null)}
              />
            )}{' '}
            {page === 'screener' && (
              <Screener
                key={`${screenInitial.scope}-${screenInitial.strategy}`}
                initialScope={screenInitial.scope}
                initialStrategy={screenInitial.strategy}
                data={data}
                onRun={(scope, refresh, limit) => run(refresh ? 'refresh' : 'scan', scope, limit)}
                busy={busy}
                onOpen={openStock}
                onAdded={() => load()}
              />
            )}{' '}
            {page === 'strategies' && <Strategies data={data} />}{' '}
            {page === 'data' && (
              <DataPage
                data={data}
                onRefresh={() => run('refresh')}
                busy={busy}
                onOpen={(symbol) =>
                  openStock(
                    symbol,
                    data.positions.some((p) => p.symbol === symbol) ? 'portfolio' : 'market',
                  )
                }
                onRetry={async (symbols) => {
                  const started = await api<{ id: string }>('/api/jobs', {
                    method: 'POST',
                    body: JSON.stringify({ kind: 'retry', scope: 'market', symbols }),
                  })
                  pendingJob.current = started.id
                  await load()
                }}
              />
            )}
          </>
        )}
        <footer className="app-footer">
          <span>
            AlphaView <span className="muted">/ Research panel</span>
          </span>
          <span>
            Powered by{' '}
            <a href="https://tentenai.com" target="_blank" rel="noreferrer">
              Tentenai.com
            </a>
          </span>
        </footer>
      </main>
      {opened && (
        <StockModal
          key={opened}
          symbol={opened}
          scope={stockScope}
          asOf={stockDate}
          onClose={() => setOpened(null)}
        />
      )}{' '}
      {editor !== undefined && (
        <PositionEditor
          position={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined)
            void load()
            setToast('持股已儲存。新增標的可更新行情取得資料。')
          }}
        />
      )}{' '}
      {search && (
        <Modal title="搜尋標的" onClose={() => setSearch(false)}>
          <label className="search-field large">
            <Search size={20} />
            <input
              autoFocus
              name="global-search"
              aria-label="搜尋股票代碼或名稱"
              placeholder="股票代碼或公司名稱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="search-results">
            {searchResults.slice(0, 50).map((p) => (
              <button
                type="button"
                key={p.symbol}
                onClick={() => {
                  setSearch(false)
                  openStock(p.symbol, p.scope)
                }}
              >
                <strong>{p.symbol}</strong>
                <span>{p.name}</span>
                <ArrowRight size={16} />
              </button>
            ))}
            {data && !searchResults.length && (
              <p className="muted">持股與市場候選中沒有符合的標的。</p>
            )}
          </div>
        </Modal>
      )}{' '}
      {help && (
        <Modal title="你的選股研究工作台" onClose={() => setHelp(false)}>
          <div className="help-content">
            <p>
              先在「我的持股」管理代碼、股數與成本，再按「更新行情」下載日線。更新完成後會自動計算最近
              60 個交易日的策略條件。
            </p>
            <p>
              「每日選股」可切換日期與策略；點擊標的查看技術指標。「策略研究」提供三種單檔歷史回測，逐筆檢查交易與回撤。
            </p>
            <p>
              面板目前為單一使用者的本地工作區，沒有券商串接或自動下單。新加入的股票在下載行情前不會有報價。
            </p>
            <button
              type="button"
              className="button"
              onClick={() => {
                setHelp(false)
                navigate('data')
              }}
            >
              <Document size={16} />
              查看資料來源與狀態
            </button>
          </div>
        </Modal>
      )}{' '}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
