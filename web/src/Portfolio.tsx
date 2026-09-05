import { useState } from 'react'
import { Add, Download, Edit, Search, ArrowsVertical } from '@carbon/icons-react'
import type { Position } from './types'
import { api, Badge, Delta, Modal, money, num } from './ui'
import { Sparkline } from './Charts'
import { PortfolioImport } from './PortfolioImport'
import { PortfolioRisk } from './PortfolioRisk'

export function PortfolioTable({
  positions,
  onOpen,
  onEdit,
  compact = false,
  weightsComplete = positions
    .filter((position) => position.shares > 0)
    .every((position) => position.market_value != null && position.weight != null),
}: {
  positions: Position[]
  onOpen: (s: string) => void
  onEdit?: (p: Position) => void
  compact?: boolean
  weightsComplete?: boolean
}) {
  const [sort, setSort] = useState<'symbol' | 'weight' | 'change_pct'>('symbol')
  const sorted = [...positions].sort((a, b) =>
    sort === 'symbol'
      ? a.symbol.localeCompare(b.symbol)
      : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity),
  )
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>
              <button type="button" className="th-button" onClick={() => setSort('symbol')}>
                標的 <ArrowsVertical size={12} />
              </button>
            </th>
            <th className="number">收盤價</th>
            <th className="number">
              <button type="button" className="th-button" onClick={() => setSort('change_pct')}>
                當日漲跌 <ArrowsVertical size={12} />
              </button>
            </th>
            <th>30 日走勢</th>
            {!compact && (
              <>
                <th className="number">持股 / 均價</th>
                <th className="number">未實現損益</th>
                <th className="number">
                  <button type="button" className="th-button" onClick={() => setSort('weight')}>
                    權重 <ArrowsVertical size={12} />
                  </button>
                </th>
              </>
            )}
            <th>策略訊號</th>
            {onEdit && (
              <th>
                <span className="sr-only">編輯</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const signals = p.research_context?.available === false ? [] : p.research?.signals || []
            const matches = signals.filter((s) => s.matched)
            const unavailable =
              signals.find((s) => s.status === 'data_error') ||
              signals.find((s) => s.status === 'stale') ||
              signals.find((s) => s.status === 'insufficient')
            const availablePrices = p.sparkline.filter((point) => point.close != null)
            return (
              <tr key={p.symbol}>
                <td>
                  <button type="button" className="symbol-button" onClick={() => onOpen(p.symbol)}>
                    <span className={`symbol-mark symbol-${p.symbol.toLowerCase()}`}>
                      {p.symbol === 'GOOGL'
                        ? 'G'
                        : p.symbol === 'NVDA'
                          ? 'N'
                          : p.symbol === 'META'
                            ? '∞'
                            : p.symbol[0]}
                    </span>
                    <span>
                      <strong>{p.symbol}</strong>
                      <small>{p.name}</small>
                    </span>
                  </button>
                </td>
                <td className="number">
                  <strong>{money(p.price)}</strong>
                  <small>{p.price_date || '尚無報價'}</small>
                  {p.quote_status && p.quote_status !== 'ok' && (
                    <small className="negative quote-warning">
                      {p.quote_status === 'unavailable'
                        ? '報價不可用'
                        : p.quote_status === 'stale'
                          ? '報價過期'
                          : '漲跌資料不完整'}
                      {p.quote_reason && `：${p.quote_reason}`}
                      {p.expected_session &&
                        !p.quote_reason?.includes(p.expected_session) &&
                        `（應有交易日 ${p.expected_session}）`}
                    </small>
                  )}
                </td>
                <td className="number">
                  <Delta
                    value={
                      p.quote_status === 'stale' || p.quote_status === 'unavailable'
                        ? null
                        : p.change_pct
                    }
                  />
                  <small>
                    <Delta
                      value={
                        p.quote_status === 'stale' || p.quote_status === 'unavailable'
                          ? null
                          : p.change
                      }
                      percent={false}
                    />
                  </small>
                </td>
                <td>
                  <Sparkline
                    data={p.sparkline}
                    positive={
                      (availablePrices.at(-1)?.close ?? 0) >= (availablePrices[0]?.close ?? 0)
                    }
                  />
                </td>
                {!compact && (
                  <>
                    <td className="number">
                      {p.shares ? (
                        num(p.shares, Number.isInteger(p.shares) ? 0 : 4)
                      ) : (
                        <span className="muted">觀察名單</span>
                      )}
                      <small>{p.shares ? money(p.cost) : '尚未持有'}</small>
                    </td>
                    <td className="number">
                      <Delta value={p.pnl} percent={false} />
                      <small>
                        <Delta value={p.pnl_pct} />
                      </small>
                    </td>
                    <td className="number">
                      {p.shares && weightsComplete ? `${num(p.weight, 1)}%` : '—'}
                      {p.shares > 0 && weightsComplete && (
                        <div className="weight-track">
                          <i style={{ width: `${p.weight}%` }} />
                        </div>
                      )}
                    </td>
                  </>
                )}
                <td>
                  {p.research_context?.available === false ? (
                    <span className="badge insufficient">選股需重算</span>
                  ) : matches.length ? (
                    <span className="badge match">
                      <i />
                      {matches.length} 項符合
                    </span>
                  ) : signals.length && !unavailable ? (
                    <Badge
                      signal={{
                        strategy: '',
                        status: 'watch',
                        matched: false,
                        reason: '尚未符合策略條件',
                      }}
                    />
                  ) : !signals.length ? (
                    <span className="badge insufficient">尚未掃描</span>
                  ) : null}
                  {unavailable && <Badge signal={unavailable} />}
                </td>
                {onEdit && (
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`編輯 ${p.symbol}`}
                      onClick={() => onEdit(p)}
                    >
                      <Edit size={16} />
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {positions.length === 0 && (
        <div className="empty-state">沒有符合的標的，試試其他搜尋或篩選條件。</div>
      )}
    </div>
  )
}

export function Portfolio({
  positions,
  onOpen,
  onEdit,
  onAdd,
  onImported,
  riskRefreshKey,
}: {
  positions: Position[]
  onOpen: (s: string) => void
  onEdit: (p: Position) => void
  onAdd: () => void
  onImported?: () => Promise<void>
  riskRefreshKey?: string
}) {
  const [importing, setImporting] = useState(false)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const filtered = positions.filter(
    (p) =>
      (filter === 'all' || (filter === 'holdings' ? p.shares > 0 : p.shares === 0)) &&
      `${p.symbol} ${p.name}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <>
      {importing && onImported && (
        <PortfolioImport onClose={() => setImporting(false)} onImported={onImported} />
      )}
      <div className="page-title">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1>我的持股</h1>
          <p>持股、成本與觀察名單，集中管理。</p>
        </div>
        <div className="actions">
          {onImported && (
            <button type="button" className="button" onClick={() => setImporting(true)}>
              匯入 CSV
            </button>
          )}
          <a className="button" href="/api/export">
            <Download size={16} />
            匯出 CSV
          </a>
          <button type="button" className="button primary" onClick={onAdd}>
            <Add size={16} />
            新增標的
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="tabs">
          {[
            ['all', '全部標的'],
            ['holdings', '持股'],
            ['watch', '觀察名單'],
          ].map(([id, title]) => (
            <button
              type="button"
              className={filter === id ? 'active' : ''}
              key={id}
              onClick={() => setFilter(id)}
            >
              {title}
              <span className="count">
                {
                  positions.filter(
                    (p) => id === 'all' || (id === 'holdings' ? p.shares > 0 : p.shares === 0),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            name="portfolio-search"
            aria-label="搜尋持股"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋代碼或公司…"
          />
        </label>
      </div>
      <PortfolioTable
        weightsComplete={positions
          .filter((position) => position.shares > 0)
          .every((position) => position.market_value != null && position.weight != null)}
        positions={filtered}
        onOpen={onOpen}
        onEdit={onEdit}
      />
      <p className="footnote">
        幣別 USD ·
        成本由使用者輸入，可隨時編輯。損益由顯示的平均成本計算，可能因四捨五入與原平台略有差異。
      </p>
      <PortfolioRisk refreshKey={riskRefreshKey} onOpen={onOpen} />
    </>
  )
}

export function PositionEditor({
  position,
  onClose,
  onSaved,
}: {
  position: Position | null
  onClose: () => void
  onSaved: () => void
}) {
  const [symbol, setSymbol] = useState(position?.symbol || '')
  const [name, setName] = useState(position?.name || '')
  const [shares, setShares] = useState(String(position?.shares ?? 0))
  const [cost, setCost] = useState(position?.cost == null ? '' : String(position.cost))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={position ? `編輯 ${position.symbol}` : '新增標的'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            await api(`/api/positions/${symbol}`, {
              method: 'PUT',
              body: JSON.stringify({
                symbol,
                name,
                shares: Number(shares),
                cost: cost === '' ? null : Number(cost),
                sector: position?.sector || '自訂清單',
                expected_updated_at: position?.updated_at ?? null,
              }),
            })
            onSaved()
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="muted">新增美股持股或觀察標的。持股數設為 0 即列入觀察名單。</p>
        <div className="form-grid">
          <label>
            股票代碼
            <input
              name="symbol"
              value={symbol}
              required
              pattern="[A-Z][A-Z0-9.\-]{0,9}"
              disabled={!!position}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="例如 AAPL"
            />
          </label>
          <label>
            公司名稱
            <input
              name="company-name"
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            持股數
            <input
              name="shares"
              type="number"
              min="0"
              max="1000000000"
              step="any"
              required
              value={shares}
              onChange={(e) => setShares(e.target.value)}
            />
          </label>
          <label>
            平均成本（USD）
            <input
              name="cost"
              type="number"
              min="0"
              max="1000000000"
              step="any"
              required={Number(shares) > 0}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <div role="alert" className="error-message">
            {error}
          </div>
        )}
        <p className="footnote">新增後請按「更新行情」下載日線並重新計算選股。</p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? '儲存中…' : '儲存標的'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
