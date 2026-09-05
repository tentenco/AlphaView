import { ScanProvenanceNotice } from './ScanProvenanceNotice'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Play, Filter, Time, Search, Add, Download } from '@carbon/icons-react'
import type { Overview, Scan, Scope } from './types'
import { SignalChanges } from './SignalChanges'
import { api, Badge, dateTime, money, num } from './ui'
import {
  EMPTY_NUMERIC,
  PRESET_KEY,
  decodePresets,
  filterRows,
  matchCount,
  screenerCsv,
  validateNumeric,
  validatePreset,
} from './screener-model'
import type {
  NumericField,
  NumericFilters,
  Preset,
  ScreenerSettings,
  SortKey,
} from './screener-model'

export type UniverseLimit = 250 | 500 | 1000
export const UNIVERSE_LIMIT_KEY = 'alphaview.universe-limit'
const poolLimit = (size: number): UniverseLimit => (size > 500 ? 1000 : size > 250 ? 500 : 250)

export function Screener({
  data,
  onRun,
  busy,
  onOpen,
  onAdded,
  initialScope = 'market',
  initialStrategy = 'all',
}: {
  initialScope?: Scope
  initialStrategy?: string
  data: Overview
  onRun: (scope: Scope, refresh: boolean, universeLimit?: UniverseLimit) => void
  busy: boolean
  onOpen: (s: string, scope: Scope, date?: string) => void
  onAdded: () => Promise<void>
}) {
  const [scope, setScope] = useState<Scope>(initialScope)
  const changedLimit = useRef(false)
  const [universeLimit, setUniverseLimit] = useState<UniverseLimit>(() => {
    const current = poolLimit(
      Math.max(data.market_universe.length, data.market_universe_meta?.requested_limit || 0),
    )
    try {
      const stored = Number(localStorage.getItem(UNIVERSE_LIMIT_KEY))
      return (
        [250, 500, 1000].includes(stored) ? Math.max(stored, current) : current
      ) as UniverseLimit
    } catch {
      return current
    }
  })
  useEffect(() => {
    if (!changedLimit.current)
      setUniverseLimit(
        (value) =>
          Math.max(
            value,
            poolLimit(
              Math.max(
                data.market_universe.length,
                data.market_universe_meta?.requested_limit || 0,
              ),
            ),
          ) as UniverseLimit,
      )
  }, [data.market_universe.length, data.market_universe_meta?.requested_limit])
  const latest = scope === 'market' ? data.market_scan : data.scan
  const dates = scope === 'market' ? data.market_scan_dates : data.scan_dates
  const [dateSelection, setDateSelection] = useState<{ scope: Scope; date: string }>({
    scope: 'market',
    date: '',
  })
  const date = dateSelection.scope === scope ? dateSelection.date : ''
  const setDate = (value: string) => setDateSelection({ scope, date: value })
  const [scan, setScan] = useState<Scan | null>(null)
  const [strategy, setStrategy] = useState(initialStrategy)
  const [only, setOnly] = useState(true)
  const [newOnly, setNewOnly] = useState(true)
  const [query, setQuery] = useState('')
  const [numeric, setNumeric] = useState<NumericFilters>({ ...EMPTY_NUMERIC })
  const [sort, setSort] = useState<SortKey>('matches')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [presets, setPresets] = useState<Preset[]>(() => {
    try {
      return decodePresets(localStorage.getItem(PRESET_KEY))
    } catch {
      return []
    }
  })
  const [presetName, setPresetName] = useState('')
  const [selectedPreset, setSelectedPreset] = useState('')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [readRetry, setReadRetry] = useState(0)
  const [adding, setAdding] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    setScan(null)
    setPage(0)
  }, [scope])
  useEffect(() => {
    if (!date && latest) setDate(latest.as_of)
  }, [latest?.as_of, date, scope])
  useEffect(() => {
    if (!date) {
      setScan(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setError('')
    api<Scan>(`/api/scans?as_of=${date}&scope=${scope}`)
      .then((r) => {
        if (active) {
          if (!r || r.scope !== scope || r.as_of !== date)
            throw new Error('選股紀錄與要求的股票池或日期不一致，請重新載入。')
          setScan(r)
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message)
          setScan(null)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [date, scope, latest?.id, readRetry])
  useEffect(() => {
    setPage(0)
  }, [date, strategy, only, newOnly, query, scope, numeric, sort, direction])
  const held = new Set(data.positions.map((p) => p.symbol))
  const lastJob = data.jobs.find((j) => j.scope === scope)
  const strategies = data.strategies.filter((s) => strategy === 'all' || s.id === strategy)
  const settings: ScreenerSettings = {
    scope,
    strategy,
    only,
    newOnly,
    query,
    numeric,
    sort,
    direction,
  }
  const validationError = validateNumeric(numeric)
  const rows = filterRows(scan?.scope === scope ? scan.result : [], settings, held)
  function reset() {
    setStrategy('all')
    setOnly(true)
    setNewOnly(true)
    setQuery('')
    setNumeric({ ...EMPTY_NUMERIC })
    setSort('matches')
    setDirection('desc')
    setSelectedPreset('')
    setPresetName('')
  }
  function persist(next: Preset[]) {
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next))
      setPresets(next)
      return true
    } catch {
      setMessage('瀏覽器無法儲存設定；目前篩選仍可使用。')
      return false
    }
  }
  function savePreset() {
    const name = presetName.trim()
    if (!name) {
      setMessage('請先輸入篩選設定名稱。')
      return
    }
    const preset: Preset = { version: 1, name, settings }
    const presetError = validatePreset(preset)
    if (presetError) {
      setMessage(presetError)
      return
    }
    if (presets.length >= 30 && !presets.some((p) => p.name === name)) {
      setMessage('最多可儲存 30 組設定，請先刪除不再使用的設定。')
      return
    }
    const next = [...presets.filter((p) => p.name !== name), preset]
    if (persist(next)) {
      setSelectedPreset(name)
      setMessage(`已儲存「${name}」。設定只保存在目前瀏覽器。`)
    }
  }
  function applyPreset(name: string) {
    const preset = presets.find((p) => p.name === name)
    setSelectedPreset(name)
    if (!preset) return
    const s = preset.settings
    setScope(s.scope)
    setStrategy(s.strategy)
    setOnly(s.only)
    setNewOnly(s.newOnly)
    setQuery(s.query)
    setNumeric({ ...s.numeric })
    setSort(s.sort)
    setDirection(s.direction)
    setPresetName(name)
    setMessage(
      `已套用「${name}」${s.scope !== scope ? '，並切換至設定的股票池與最新日期' : '，保留目前檢視日期'}。`,
    )
  }
  function exportRows() {
    if (!scan || scan.scope !== scope || loading || validationError) return
    const csv = screenerCsv(rows, {
      scope,
      asOf: scan.as_of,
      createdAt: scan.created_at,
      snapshotId: scan.id,
      inputRevision: scan.input_revision,
      inputStatus: scan.input_status,
      sources: Object.fromEntries(data.datasets.map((d) => [d.symbol, d.source])),
    })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `AlphaView-${scope}-${scan.as_of}.csv`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(`已匯出全部 ${rows.length} 檔篩選結果（含其他分頁）。`)
  }
  const pages = Math.max(1, Math.ceil(rows.length / 25))
  const visiblePage = Math.min(page, pages - 1)
  const members = scope === 'market' ? data.market_universe.length : data.positions.length
  async function add(symbol: string) {
    setAdding(symbol)
    setMessage('')
    try {
      await api(`/api/watchlist/${symbol}`, { method: 'POST' })
      await onAdded()
      setMessage(`${symbol} 已加入觀察名單，未變更其他持股。`)
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setAdding(null)
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <div className="eyebrow">Daily screener</div>
          <h1>每日選股</h1>
          <p>從市場尋找新標的，也能持續追蹤自己的清單。</p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => onRun(scope, true, scope === 'market' ? universeLimit : undefined)}
          disabled={busy}
        >
          <Play size={16} />
          {busy ? '選股作業進行中…' : scope === 'market' ? '執行市場選股' : '執行清單選股'}
        </button>
      </div>
      <div className="scope-selector">
        <label>
          選股範圍
          <select
            name="scan-scope"
            aria-label="選股範圍"
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="market">美股市場候選</option>
            <option value="portfolio">我的持股與觀察清單 · {data.positions.length} 檔</option>
          </select>
        </label>
        <span className="quiet-label">
          {scope === 'market' ? '市場候選與持股分開管理' : '檢查已加入清單的股票'}
        </span>
      </div>
      {scope === 'market' && (
        <div className="scope-selector">
          <label>
            股票池上限
            <select
              name="universe-limit"
              aria-label="股票池上限"
              value={universeLimit}
              disabled={busy}
              onChange={(event) => {
                const value = Number(event.target.value) as UniverseLimit
                changedLimit.current = true
                setUniverseLimit(value)
                try {
                  localStorage.setItem(UNIVERSE_LIMIT_KEY, String(value))
                } catch {
                  setMessage('股票池上限已套用；瀏覽器無法保留此設定。')
                }
              }}
            >
              <option value={250}>250 檔</option>
              <option value={500}>500 檔</option>
              <option value={1000}>1,000 檔</option>
            </select>
          </label>
          <span className="quiet-label">
            只套用於下次「執行市場選股」；目前股票池 {members} 檔。
          </span>
        </div>
      )}
      <div className="screener-scope">
        <strong>
          {scope === 'market'
            ? `美股候選股票池${members ? ` · ${members} 檔` : ''}`
            : `我的持股與觀察清單 · ${members} 檔`}
        </strong>
        <p>
          {scope === 'market'
            ? `Nasdaq／NYSE 美元股票：市值 ≥ 20 億、股價 ≥ 5、近三個月平均日成交量 ≥ 20 萬股；下次執行按市值取前 ${universeLimit.toLocaleString('en-US')} 檔（含 ADR，實際數量依來源可用標的而定）。執行時更新股票池與日線，再以四種策略篩選。這是市場子集，不是全美股。`
            : '執行清單選股會下載清單內標的的最新日線，再重新計算策略。相同日線重算，結果可能不變。'}
        </p>
      </div>
      {lastJob && lastJob.status !== 'running' && (
        <div
          className={`scan-outcome ${lastJob.status === 'failed' || lastJob.status === 'interrupted' || lastJob.status === 'partial' ? 'failed' : lastJob.status === 'cancelled' ? 'cancelled' : ''}`}
          role="status"
        >
          <div>
            <strong>{lastJob.error || lastJob.progress}</strong>
            <p>
              {dateTime(lastJob.finished_at)} · 最新結果日期 {latest?.as_of || '尚無結果'}
            </p>
          </div>
          {latest && date !== latest.as_of && (
            <button type="button" className="button" onClick={() => setDate(latest.as_of)}>
              查看最新結果
            </button>
          )}
        </div>
      )}
      {!loading &&
        scan?.scope === scope &&
        scan.as_of === date &&
        scan.matches_current_universe === false && (
          <div className="notice" role="status">
            <div>
              <strong>這份選股結果使用的股票池與目前不同。</strong>
              <p>
                {scan.as_of} 保留結果：{scan.scan_member_count ?? scan.universe.length}{' '}
                檔；目前股票池：{scan.current_member_count ?? members}{' '}
                檔。下方仍顯示原股票池的有效結果，歷史日期亦以原結果的成分解讀。
              </p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => onRun(scope, false)}
              >
                以目前股票池重新計算
              </button>
              <p className="footnote">使用已儲存的日線重新計算，不會變更股票池上限或下載新行情。</p>
            </div>
          </div>
        )}
      {!loading && scan?.scope === scope && scan.as_of === date && (
        <ScanProvenanceNotice
          status={scan.input_status}
          busy={busy}
          onRecalculate={() => onRun(scope, false)}
        />
      )}
      <div className="screen-stats">
        <div>
          <strong>{scan?.scan_member_count ?? scan?.universe.length ?? 0}</strong>
          <span>此份結果掃描標的</span>
        </div>
        <div>
          <strong>
            {scan?.result.filter((r) => r.signals.some((s) => s.matched)).length || 0}
          </strong>
          <span>符合策略的標的</span>
        </div>
        <div>
          <strong>{rows.length}</strong>
          <span>目前篩選結果</span>
        </div>
        <div className="scan-timestamp">
          <Time size={16} />
          <span>{dateTime(scan?.created_at)} 計算</span>
        </div>
      </div>
      <div className="toolbar filters">
        <div className="actions">
          <Filter size={16} />
          <select
            name="scan-date"
            aria-label="選股日期"
            value={date}
            disabled={!dates.length}
            onChange={(e) => setDate(e.target.value)}
          >
            {!dates.length && <option value="">尚未執行</option>}
            {dates.map((d) => (
              <option value={d.as_of} key={d.as_of}>
                {d.as_of}
              </option>
            ))}
          </select>
          <select
            name="strategy-filter"
            aria-label="策略篩選"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="all">全部策略</option>
            {data.strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            name="candidate-query"
            maxLength={200}
            aria-describedby="candidate-query-help"
            aria-label="搜尋候選標的"
            placeholder="搜尋代碼或公司…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <p className="footnote" id="candidate-query-help">
        搜尋文字最多 200 個字元；儲存設定時保留完整文字，不會自動截短。
      </p>
      <div className="candidate-filters">
        <label className="checkbox-label">
          <input
            name="matches-only"
            type="checkbox"
            checked={only}
            onChange={(e) => setOnly(e.target.checked)}
          />
          只看符合條件
        </label>
        {scope === 'market' && (
          <label className="checkbox-label">
            <input
              name="new-only"
              type="checkbox"
              checked={newOnly}
              onChange={(e) => setNewOnly(e.target.checked)}
            />
            只看尚未加入清單的新標的
          </label>
        )}
      </div>
      <details className="screener-advanced" open={validationError ? true : undefined}>
        <summary>
          進階篩選與儲存設定
          {Object.values(numeric).some((v) => v.trim()) ? ' · 已套用數值條件' : ''}
        </summary>
        <div className="screener-numeric-grid">
          {(
            [
              ['priceMin', '調整股價下限（USD）'],
              ['priceMax', '調整股價上限（USD）'],
              ['rsiMin', 'RSI 下限'],
              ['rsiMax', 'RSI 上限'],
              ['volumeMin', '最低量比（倍）'],
              ['rpsMin', '最低 RPS'],
              ['matchesMin', '至少符合策略數'],
            ] as [NumericField, string][]
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max={
                  field === 'matchesMin'
                    ? 4
                    : field.startsWith('rsi') || field === 'rpsMin'
                      ? 100
                      : undefined
                }
                step={field === 'matchesMin' ? 1 : 'any'}
                aria-label={label}
                value={numeric[field]}
                placeholder="不限"
                onChange={(e) => setNumeric({ ...numeric, [field]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="footnote">
          數值條件以調整後日線計算；空白代表不限。有套用條件的指標若缺資料，該標的不會列入。策略數以全部四種策略計算。
        </p>
        {validationError && (
          <div className="error-message" role="alert">
            {validationError}
          </div>
        )}
        <div className="screener-presets actions">
          <label>
            已儲存的設定
            <select
              aria-label="已儲存的篩選設定"
              value={selectedPreset}
              onChange={(e) => applyPreset(e.target.value)}
            >
              <option value="">選擇設定…</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {p.settings.scope === 'market' ? '市場' : '我的清單'}
                </option>
              ))}
            </select>
          </label>
          <label>
            設定名稱
            <input
              aria-label="篩選設定名稱"
              value={presetName}
              maxLength={60}
              placeholder="例如：放量強勢股"
              onChange={(e) => setPresetName(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            onClick={savePreset}
            disabled={!!validationError}
          >
            {presets.some((p) => p.name === presetName.trim()) ? '更新同名設定' : '儲存設定'}
          </button>
          <button
            type="button"
            className="button"
            disabled={!selectedPreset}
            onClick={() => {
              if (persist(presets.filter((p) => p.name !== selectedPreset))) {
                setMessage(`已刪除「${selectedPreset}」設定。`)
                setSelectedPreset('')
              }
            }}
          >
            刪除設定
          </button>
        </div>
        <p className="footnote">
          儲存股票池、策略、數值條件、搜尋、排序及勾選狀態；不儲存歷史日期。套用不同股票池時會顯示該股票池最新日期。
        </p>
      </details>
      <div className="toolbar screener-result-tools">
        <div className="actions">
          <label>
            排序
            <select
              aria-label="候選排序"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="matches">符合策略數</option>
              <option value="symbol">股票代碼</option>
              <option value="close">調整收盤價</option>
              <option value="rsi">RSI 14</option>
              <option value="volume_ratio">量比</option>
              <option value="rps">RPS</option>
            </select>
          </label>
          <select
            aria-label="排序方向"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'asc' | 'desc')}
          >
            <option value="desc">由高到低／Z–A</option>
            <option value="asc">由低到高／A–Z</option>
          </select>
          <button type="button" className="text-button" onClick={reset}>
            重設篩選
          </button>
        </div>
        <button
          type="button"
          className="button"
          onClick={exportRows}
          disabled={!rows.length || loading || !!validationError}
        >
          <Download size={16} />
          匯出全部 {rows.length} 檔 CSV
        </button>
      </div>
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {error && (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => setReadRetry((value) => value + 1)}
        >
          重新讀取選股紀錄
        </button>
      )}
      {loading ? (
        <div className="loading-line" role="status">
          正在載入選股紀錄…
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>標的</th>
                <th className="number">調整收盤價</th>
                {strategies.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
                <th className="number">符合策略數</th>
                <th className="number">RPS</th>
                <th className="number">RSI 14</th>
                <th className="number">量比</th>
                {scope === 'market' && <th>觀察名單</th>}
              </tr>
            </thead>
            <tbody>
              {rows.slice(visiblePage * 25, (visiblePage + 1) * 25).map((r) => (
                <tr key={r.symbol}>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onOpen(r.symbol, scope, date)}
                    >
                      <strong>{r.symbol}</strong>
                      <ArrowRight size={14} />
                    </button>
                    <small className="candidate-name" title={r.name}>
                      {r.name || `${r.bars} 個交易日`}
                    </small>
                  </td>
                  <td className="number">{money(r.indicators.close)}</td>
                  {strategies.map((s) => (
                    <td key={s.id}>
                      {r.signals.find((x) => x.strategy === s.id) ? (
                        <Badge signal={r.signals.find((x) => x.strategy === s.id)!} />
                      ) : (
                        <span className="muted">尚無訊號</span>
                      )}
                    </td>
                  ))}
                  <td className="number">{matchCount(r)}</td>
                  <td className="number">{num(r.indicators.rps, 1)}</td>
                  <td className="number">{num(r.indicators.rsi, 1)}</td>
                  <td className="number">
                    {r.indicators.volume_ratio == null ? '—' : `${num(r.indicators.volume_ratio)}×`}
                  </td>
                  {scope === 'market' && (
                    <td>
                      {held.has(r.symbol) ? (
                        <span className="badge neutral">已在清單</span>
                      ) : (
                        <button
                          type="button"
                          className="button"
                          aria-label={`加入 ${r.symbol} 觀察名單`}
                          disabled={busy || adding !== null}
                          onClick={() => add(r.symbol)}
                        >
                          <Add size={14} />
                          {adding === r.symbol ? '加入中…' : '加入觀察'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty-state">
              {scan
                ? '沒有符合目前條件的標的，可取消「只看符合條件」或調整其他篩選。'
                : scope === 'market'
                  ? '按「執行市場選股」下載候選股票資料，尋找持股以外的新機會。'
                  : '尚無選股紀錄，請先更新行情。'}
            </div>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-pagination">
          <span>
            顯示 {visiblePage * 25 + 1}–{Math.min((visiblePage + 1) * 25, rows.length)} /{' '}
            {rows.length} 檔
          </span>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={visiblePage === 0}
              onClick={() => setPage(visiblePage - 1)}
            >
              上一頁
            </button>
            <span>
              {visiblePage + 1} / {pages}
            </span>
            <button
              type="button"
              className="button"
              disabled={visiblePage + 1 >= pages}
              onClick={() => setPage(visiblePage + 1)}
            >
              下一頁
            </button>
          </div>
        </div>
      )}
      <SignalChanges
        scope={scope}
        asOf={date || undefined}
        refreshKey={latest?.id}
        onOpen={onOpen}
      />
      <div className="research-note">
        <div className="note-title">如何閱讀這份清單</div>
        <p>
          擴充或調整股票池會改變 RPS
          排名，即使股價未變也可能產生訊號異動。相對強勢只在本次所選股票池內排名，與個人持股清單的排名不同。「符合條件」是研究訊號，不是買進指令。加入觀察只新增零股持有的追蹤項目。歷史日期使用該次掃描的候選清單重算，不代表當時市場成分，存在存活者與選樣偏差。
        </p>
      </div>
    </>
  )
}
