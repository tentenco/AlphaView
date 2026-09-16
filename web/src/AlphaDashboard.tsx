import { lazy, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Checkmark,
  Download,
  Filter,
  Settings,
  WarningAlt,
  Renew,
  Star,
  StarFilled,
  Compare,
} from '@carbon/icons-react'
import type { Overview, Scope } from './types'
import { translateText, type Locale } from './locale'
import { money, num, api } from './ui'
import {
  ALPHA_SETTINGS_KEY,
  ALPHA_VERSION,
  STRATEGY_IDS,
  WEIGHT_PRESETS,
  DEFAULT_ALPHA_SETTINGS,
  readAlphaSettings,
  rankAlpha,
  portfolioAlerts,
  validAlphaSettings,
  type AlphaCandidate,
  type AlphaSettings,
  type StrategyId,
  type RiskKind,
} from './alpha-model'
import './alpha.css'
import { PositionScenario } from './PositionScenario'
import { ResearchJournal } from './ResearchJournal'
import { AlphaRankingTable } from './AlphaRankingTable'
import { DesktopAlertSettings } from './DesktopAlertSettings'
import { AlphaOverlap } from './AlphaOverlap'
import { ResearchTracker } from './ResearchTracker'
import { AlphaDailyChanges } from './AlphaDailyChanges'
import { WeightProfiles } from './WeightProfiles'
import { PriceAlertEditor } from './PriceAlertEditor'
import { AlphaOpportunityMap } from './AlphaOpportunityMap'
import { DeferredContent } from './DeferredContent'
import { DASHBOARD_SESSION_KEY, readDashboardSession } from './dashboard-session'
import { CandidateFilters } from './CandidateFilters'
import { EMPTY_CRITERIA, refineCandidates, type CandidateSort } from './candidate-filters'
import { researchHandoff } from './research-handoff'
const CandidateHoldingFit = lazy(() =>
  import('./CandidateHoldingFit').then((module) => ({ default: module.CandidateHoldingFit })),
)
import { researchBrief } from './alpha-brief'
import { ACK_KEY, readReviewed, notifyAlphaPreferences } from './alpha-preferences'

const names: Record<StrategyId, [string, string]> = {
  turtle: ['海龜突破', 'Turtle Breakout'],
  trend: ['均線趨勢', 'Trend Following'],
  pullback: ['回檔觀察', 'RSI Pullback'],
  rps: ['相對強勢', 'Relative Strength'],
}
const alertNames: Record<RiskKind, [string, string]> = {
  concentration: ['持倉集中度偏高', 'Position concentration'],
  daily_drop: ['單日跌幅達門檻', 'Daily loss threshold reached'],
  below_ma200: ['收盤低於 MA200', 'Close below MA200'],
  below_ma50: ['收盤低於 MA50', 'Close below MA50'],
  overbought: ['RSI 處於高檔', 'Elevated RSI'],
  data_gap: ['當期報價無法確認', 'Current quote unavailable'],
  signal_gap: ['持倉訊號需要更新', 'Portfolio signals need updating'],
  price_below: ['收盤達到自訂下限', 'Close at or below your threshold'],
  price_above: ['收盤達到自訂上限', 'Close at or above your threshold'],
}
const SHORTLIST_KEY = 'alphaview-alpha-shortlist-v1'
const VIEW_KEY = 'alphaview-alpha-view-v1'
function readShortlist(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SHORTLIST_KEY) || '[]')
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (item): item is string =>
                typeof item === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(item),
            ),
          ),
        ].slice(0, 100)
      : []
  } catch {
    return []
  }
}

export function AlphaDashboard({
  data,
  locale,
  busy,
  onOpen,
  onScreener,
  onData,
  onRun,
  onAdded,
  onCompare,
  onLab,
  onNotice,
}: {
  data: Overview
  locale: Locale
  busy: boolean
  onOpen: (symbol: string, scope?: Scope, asOf?: string) => void
  onScreener: (scope: Scope, strategy: string) => void
  onData: () => void
  onRun: (scope: Scope) => void
  onAdded: () => Promise<void>
  onCompare: (symbols: string[]) => void
  onLab: () => void
  onNotice?: (message: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const title = (id: StrategyId) => names[id][locale === 'en' ? 1 : 0]
  const [initialSession] = useState(readDashboardSession)
  const [settings, setSettings] = useState<AlphaSettings>(readAlphaSettings)
  const [draft, setDraft] = useState<AlphaSettings>(settings)
  const [configure, setConfigure] = useState(false)
  const [scope, setScope] = useState<Scope>(initialSession.scope)
  const [filter, setFilter] = useState(initialSession.filter)
  const [relation, setRelation] = useState(initialSession.relation)
  const [criteria, setCriteria] = useState(initialSession.criteria)
  const [sort, setSort] = useState<CandidateSort>(initialSession.sort)
  const [query, setQuery] = useState(initialSession.query)
  const [intersection, setIntersection] = useState<StrategyId[]>(initialSession.intersection)
  const [page, setPage] = useState(initialSession.page)
  const [expanded, setExpanded] = useState<string | null>(initialSession.expanded)
  const [reviewed, setReviewed] = useState<string[]>(readReviewed)
  const [showReviewed, setShowReviewed] = useState(false)
  const [message, setLocalMessage] = useState('')
  function setMessage(value: string) {
    setLocalMessage(value)
    onNotice?.(value)
  }
  const [adding, setAdding] = useState<string | null>(null)
  const [shortlist, setShortlist] = useState<string[]>(readShortlist)
  const [compare, setCompare] = useState<string[]>(initialSession.compare)
  useEffect(() => {
    try {
      sessionStorage.setItem(
        DASHBOARD_SESSION_KEY,
        JSON.stringify({
          scope,
          filter,
          relation,
          query,
          intersection,
          page,
          expanded,
          compare,
          criteria,
          sort,
        }),
      )
    } catch {
      /* Selection still works in the current page. */
    }
  }, [scope, filter, relation, query, intersection, page, expanded, compare, criteria, sort])
  const [view, setView] = useState<'cards' | 'table' | 'map'>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY)
      return saved === 'table' || saved === 'map' ? saved : 'cards'
    } catch {
      return 'cards'
    }
  })
  const [scenario, setScenario] = useState<string | null>(null)
  const [fitSymbols, setFitSymbols] = useState<string[]>([])
  const [alertLimit, setAlertLimit] = useState(12)
  const ranking = useMemo(() => rankAlpha(data, scope, settings), [data, scope, settings])
  const draftRanking = useMemo(
    () => (configure && validAlphaSettings(draft) ? rankAlpha(data, scope, draft) : null),
    [data, scope, draft, configure],
  )
  const alerts = useMemo(() => portfolioAlerts(data, settings), [data, settings])
  const activeAlerts = alerts.filter((alert) => !reviewed.includes(alert.id))
  const focusAlerts = activeAlerts
    .filter(
      (alert, index, list) =>
        alert.severity !== 'data' &&
        list.findIndex((item) => item.symbol === alert.symbol && item.severity !== 'data') ===
          index,
    )
    .slice(0, 3)
  const shownAlerts = showReviewed ? alerts : activeAlerts
  const baseRows = ranking.rows.filter(
    (row) =>
      intersection.every((id) =>
        row.contributions.some((part) => part.id === id && part.matched),
      ) &&
      (filter === 'all' || filter === 'alpha'
        ? filter === 'all' || row.alpha
        : filter === 'shortlist'
          ? shortlist.includes(row.symbol)
          : row.contributions.some((part) => part.id === filter && part.matched)) &&
      (relation === 'all' || row.relation === relation) &&
      `${row.symbol} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const rows = refineCandidates(baseRows, criteria, sort)
  const pageSize = view === 'table' ? 25 : 12
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1))
  const visible = rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize)
  const shownDate = ranking.scan?.as_of || '—'
  const weightSum = STRATEGY_IDS.reduce((sum, id) => sum + draft.weights[id], 0)
  const settingsChanged = JSON.stringify(draft) !== JSON.stringify(settings)
  const knownSymbols = new Set(
    [...data.positions, ...data.market_universe].map((item) => item.symbol),
  )
  const comparisonSymbols = compare.filter((symbol) => knownSymbols.has(symbol))
  function changeView(next: 'cards' | 'table' | 'map') {
    setView(next)
    setPage(0)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* The view still changes for this session. */
    }
  }
  function openScenario(symbol: string) {
    setScenario(symbol)
    requestAnimationFrame(() =>
      document
        .querySelector('.alpha-scenario')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  }
  function openHoldingFit(symbols: string[]) {
    setFitSymbols(symbols)
    requestAnimationFrame(() =>
      document
        .querySelector('.alpha-holding-fit-slot')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  }
  function toggleShortlist(symbol: string) {
    if (!shortlist.includes(symbol) && shortlist.length >= 100) {
      setMessage(
        t(
          '研究清單最多保留 100 檔，請先移除部分標的。',
          'Your research shortlist holds up to 100 symbols. Remove an entry first.',
        ),
      )
      return
    }
    const next = shortlist.includes(symbol)
      ? shortlist.filter((item) => item !== symbol)
      : [...shortlist, symbol]
    setShortlist(next)
    try {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(next))
    } catch {
      setMessage(
        t(
          '本次已套用，研究清單無法保存到瀏覽器。',
          'Applied for this session; browser storage is unavailable.',
        ),
      )
    }
  }
  function toggleCompare(symbol: string) {
    setCompare((previous) =>
      previous.includes(symbol)
        ? previous.filter((item) => item !== symbol)
        : previous.length < 5
          ? [...previous, symbol]
          : previous,
    )
  }
  function saveSettings() {
    if (!validAlphaSettings(draft)) return
    setSettings(draft)
    setConfigure(false)
    setPage(0)
    try {
      localStorage.setItem(ALPHA_SETTINGS_KEY, JSON.stringify(draft))
      notifyAlphaPreferences()
      setMessage(t('權重與提醒門檻已儲存。', 'Weights and alert thresholds saved.'))
    } catch {
      setMessage(t('已套用；瀏覽器無法儲存設定。', 'Applied; browser storage is unavailable.'))
    }
  }
  function acknowledge(id: string) {
    const next = reviewed.includes(id)
      ? reviewed.filter((item) => item !== id)
      : [...reviewed, id].slice(-500)
    setReviewed(next)
    try {
      localStorage.setItem(ACK_KEY, JSON.stringify(next))
      notifyAlphaPreferences()
    } catch {
      setMessage(
        t(
          '已更新檢閱狀態，僅保留於本次頁面。',
          'Review status updated for this page session only.',
        ),
      )
    }
  }
  async function addWatch(row: AlphaCandidate) {
    if (adding) return
    setAdding(row.symbol)
    try {
      await api(`/api/watchlist/${encodeURIComponent(row.symbol)}`, { method: 'POST' })
      await onAdded()
      setMessage(
        t(
          `${row.symbol} 已加入觀察名單。清單變更後需要重新執行選股，才能使用目前版本的排名；星號研究清單則不會改變選股範圍。`,
          `${row.symbol} added to your watchlist. Run the screener again to rank the updated workspace. Starring a research candidate keeps the scan universe unchanged.`,
        ),
      )
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setAdding(null)
    }
  }
  function exportCsv() {
    const escape = (value: unknown) =>
      `"${String(value ?? '')
        .replace(/^[=+@\-\t\r]/, "'$&")
        .replaceAll('"', '""')}"`
    const lines = [
      [
        'symbol',
        'company',
        'date',
        'scope',
        'score',
        'coverage_pct',
        'alpha_pick',
        'relation',
        ...STRATEGY_IDS.map((id) => `${id}_points`),
        ...STRATEGY_IDS.map((id) => `${id}_weight_pct`),
        'alpha_threshold',
        'minimum_matches',
        'scan_id',
        'engine_version',
        'rsi',
        'rps',
        'volume_ratio',
        'sort',
        'filter_min_score',
        'filter_min_rps',
        'filter_max_rsi',
      ],
      ...rows.map((row) => [
        row.symbol,
        row.name,
        shownDate,
        scope,
        row.score.toFixed(4),
        row.coverage.toFixed(4),
        row.alpha,
        row.relation,
        ...row.contributions.map((part) => part.points.toFixed(4)),
        ...STRATEGY_IDS.map((id) =>
          ((settings.weights[id] / ranking.totalWeight) * 100).toFixed(4),
        ),
        settings.threshold,
        settings.minMatches,
        ranking.scan?.id,
        ALPHA_VERSION,
        row.row.indicators.rsi,
        row.row.indicators.rps,
        row.row.indicators.volume_ratio,
        sort,
        criteria.minScore,
        criteria.minRps,
        criteria.maxRsi,
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + lines.map((line) => line.map(escape).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `alphaview-alpha-${scope}-${shownDate}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(
      t(`已匯出 ${rows.length} 檔研究排序。`, `Exported ${rows.length} ranked candidates.`),
    )
  }
  function exportBrief() {
    if (!ranking.ready) return
    const html = researchBrief({
      locale,
      date: shownDate,
      scope,
      total: ranking.total,
      usable: ranking.usable,
      settings,
      rows: ranking.rows,
      alerts,
      source: ranking.scan
        ? { scanId: ranking.scan.id, inputRevision: ranking.scan.input_revision }
        : undefined,
    })
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `alphaview-brief-${scope}-${shownDate}.html`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(
      t(
        '完整 Alpha 研究摘要已下載，可離線開啟或列印成 PDF。',
        'The full Alpha research brief was downloaded. Open it offline or print it to PDF.',
      ),
    )
  }
  async function copyResearch(symbols: string[]) {
    try {
      const markdown = researchHandoff({ data, scope, settings, symbols, locale })
      try {
        await navigator.clipboard.writeText(markdown)
        setMessage(
          t(
            '研究交接包已複製，可貼給你的 Agent 接續分析。',
            'Research handoff copied. Paste it into your agent to continue researching.',
          ),
        )
      } catch {
        const url = URL.createObjectURL(
          new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
        )
        const link = document.createElement('a')
        link.href = url
        link.download = `alphaview-research-${shownDate}.md`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage(
          t(
            '瀏覽器無法複製，已改為下載研究交接 Markdown。',
            'Clipboard access was unavailable; the research handoff was downloaded as Markdown.',
          ),
        )
      }
    } catch {
      setMessage(
        t(
          '目前沒有可交接的有效研究資料，請先更新選股。',
          'No current research is available for this handoff. Recalculate screening first.',
        ),
      )
    }
  }
  const relationName = (row: AlphaCandidate) =>
    row.relation === 'held'
      ? t('已持有', 'Held')
      : row.relation === 'watchlist'
        ? t('觀察中', 'Watching')
        : t('新標的', 'New')
  return (
    <div className="alpha-workspace" translate="no">
      <div className="page-title alpha-title">
        <div>
          <div className="eyebrow">SIGNALS INTO FOCUS</div>
          <h1>
            Alpha Picks<span className="alpha-live">{t('研究雷達', 'Research Radar')}</span>
          </h1>
          <p>
            {t(
              '先看共識，再看風險。把今天值得研究的標的放在一起。',
              'Start with agreement. Check the risk. Find what deserves a closer look today.',
            )}
          </p>
        </div>
        <div className="actions">
          <button className="button" disabled={!ranking.ready} onClick={exportBrief}>
            <Download size={16} />
            {t('每日摘要', 'Daily Brief')}
          </button>
          <button
            className="button"
            onClick={() => {
              setDraft(settings)
              setConfigure(!configure)
            }}
            aria-expanded={configure}
          >
            <Settings size={16} />
            {t('權重與提醒', 'Weights & Alerts')}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => onRun(scope)}
            title={t(
              '使用已儲存行情，同步重算市場與個人清單；不下載新行情。',
              'Recalculate market and personal lists from saved quotes. No new quotes are downloaded.',
            )}
          >
            <Renew size={15} />
            {t('同步重算兩個股票池', 'Recalculate Both Lists')}
          </button>
        </div>
      </div>
      <div className="alpha-context">
        <div className="tabs" aria-label={t('研究範圍', 'Research scope')}>
          <button
            className={scope === 'market' ? 'active' : ''}
            onClick={() => {
              setScope('market')
              setPage(0)
            }}
          >
            {t('市場探索', 'Market Discovery')}
          </button>
          <button
            className={scope === 'portfolio' ? 'active' : ''}
            onClick={() => {
              setScope('portfolio')
              setPage(0)
            }}
          >
            {t('我的清單', 'My List')}
          </button>
        </div>
        <span>
          {t('選股日期', 'Screen date')} {shownDate} · {t('應有交易日', 'Expected session')}{' '}
          {data.summary.expected_session || '—'}
        </span>
      </div>
      <nav className="alpha-mobile-jumps" aria-label={t('本頁快速導覽', 'Quick Page Navigation')}>
        {[
          [t('候選名單', 'Candidates'), '.alpha-rankings'],
          [t('持倉提醒', 'Holding Alerts'), '.alpha-alerts'],
          [t('研究進度', 'Progress'), '.alpha-tracker'],
        ].map(([label, selector]) => (
          <button
            type="button"
            className="text-button"
            key={selector}
            onClick={() => {
              const target = document.querySelector(selector)
              if (target instanceof HTMLDetailsElement) target.open = true
              target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            {label} ↓
          </button>
        ))}
      </nav>
      {configure && (
        <section className="alpha-settings" aria-label={t('Alpha 設定', 'Alpha settings')}>
          <div className="section-heading">
            <div>
              <h2>{t('建立你的研究偏好', 'Shape your research priorities')}</h2>
              <p>
                {t(
                  '調整相對權重，系統會自動換算成 100 分。',
                  'Set relative weights; the total is normalized to 100 points.',
                )}
              </p>
            </div>
            <div className="actions">
              {Object.entries(WEIGHT_PRESETS).map(([id, weights]) => (
                <button
                  key={id}
                  className="button"
                  onClick={() => setDraft({ ...draft, weights: { ...weights } })}
                >
                  {id === 'balanced'
                    ? t('均衡', 'Balanced')
                    : id === 'momentum'
                      ? t('動能', 'Momentum')
                      : t('回檔', 'Pullback')}
                </button>
              ))}
            </div>
          </div>
          <WeightProfiles
            configuration={{
              weights: draft.weights,
              threshold: draft.threshold,
              minMatches: draft.minMatches,
            }}
            locale={locale}
            onLoad={(configuration) => setDraft({ ...draft, ...configuration })}
          />
          <div className="alpha-weight-grid">
            {STRATEGY_IDS.map((id, index) => (
              <label key={id}>
                <span>
                  <i style={{ background: `var(--series-${index})` }} />
                  {title(id)}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.weights[id]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      weights: { ...draft.weights, [id]: Number(event.target.value) },
                    })
                  }
                />
                <small>
                  {num(weightSum > 0 ? (draft.weights[id] / weightSum) * 100 : 0, 1)}{' '}
                  {t('正規化權重 %', 'normalized weight %')}
                </small>
              </label>
            ))}
          </div>
          <div className="alpha-thresholds">
            {(
              [
                ['threshold', t('Alpha 分數門檻', 'Alpha score threshold'), 1, 100],
                ['minMatches', t('至少符合策略數', 'Minimum strategy matches'), 1, 4],
                ['concentration', t('集中度提醒 %', 'Concentration alert %'), 1, 100],
                ['dailyDrop', t('單日跌幅提醒 %', 'Daily decline alert %'), 1, 50],
                ['overbought', t('RSI 高檔提醒', 'Elevated RSI alert'), 50, 100],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  value={draft[key]}
                  onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
                />
              </label>
            ))}
          </div>
          <p className="footnote">
            {t(
              '零權重策略不計分、不列入最低策略數。所有啟用策略都需要有效資料才能成為 Alpha Pick。RSI 回檔與趨勢策略可能互斥，因此不需要四個策略全部符合。',
              'Zero-weight strategies do not contribute to score or minimum matches. All enabled strategies need valid data for Alpha eligibility. Pullback and momentum conditions can conflict; matching all four is not required.',
            )}
          </p>
          <PriceAlertEditor
            rules={draft.priceRules || []}
            positions={data.positions}
            locale={locale}
            onChange={(priceRules) => setDraft({ ...draft, priceRules })}
          />
          {draftRanking?.ready && (
            <div className="alpha-weight-preview">
              <strong>
                {t('設定預覽', 'Settings Preview')} · {ranking.alpha.length} →{' '}
                {draftRanking.alpha.length} Alpha Picks
              </strong>
              <span>
                {t('新增', 'Added')}{' '}
                {
                  draftRanking.alpha.filter(
                    (row) => !ranking.alpha.some((item) => item.symbol === row.symbol),
                  ).length
                }{' '}
                · {t('移出', 'Removed')}{' '}
                {
                  ranking.alpha.filter(
                    (row) => !draftRanking.alpha.some((item) => item.symbol === row.symbol),
                  ).length
                }
              </span>
              <small>
                {t('前五名', 'Top Five')}:{' '}
                {draftRanking.alpha
                  .slice(0, 5)
                  .map((row) => `${row.symbol} ${num(row.score, 0)}`)
                  .join(' · ') || '—'}
              </small>
            </div>
          )}
          {STRATEGY_IDS.filter((id) => draft.weights[id] > 0).length < draft.minMatches && (
            <p role="status">
              {t(
                '啟用的策略數少於最低符合數，這組設定不會產生 Alpha Pick。',
                'Fewer strategies are enabled than the minimum match count; these settings will produce no Alpha Picks.',
              )}
            </p>
          )}
          {!validAlphaSettings(draft) && (
            <p role="alert">
              {t(
                '請輸入範圍內的數值，權重合計須大於零。',
                'Enter values within the allowed ranges and a total weight above zero.',
              )}
            </p>
          )}
          <div className="actions">
            <button
              className="button primary"
              disabled={!validAlphaSettings(draft)}
              onClick={saveSettings}
            >
              {t('套用並儲存', 'Apply & Save')}
            </button>
            <button
              className="button"
              onClick={() => {
                setDraft({
                  ...DEFAULT_ALPHA_SETTINGS,
                  weights: { ...DEFAULT_ALPHA_SETTINGS.weights },
                })
              }}
            >
              {t('預設值', 'Defaults')}
            </button>
            <button className="text-button" onClick={() => setConfigure(false)}>
              {t('取消', 'Cancel')}
            </button>
            {settingsChanged && <small>{t('尚未套用', 'Not applied yet')}</small>}
          </div>
        </section>
      )}
      {message && !onNotice && (
        <div className="notice" role="status">
          {message}
          <button className="text-button" onClick={() => setMessage('')}>
            {t('關閉', 'Dismiss')}
          </button>
        </div>
      )}
      {!ranking.ready && (
        <div className="notice alpha-unavailable">
          <WarningAlt size={18} />
          <div>
            <strong>
              {t('先更新研究資料，再看 Alpha 排序', 'Refresh research data to see Alpha rankings')}
            </strong>
            <p>
              {t(
                '目前快照缺少有效版本、日期已過期或股票池已變更。可重算已儲存的行情；若行情過期，請到每日選股更新。',
                'The snapshot has unknown provenance, an old date, or changed membership. Recalculate saved data, or refresh quotes in Daily Screener if they are stale.',
              )}
            </p>
            <button className="text-button" onClick={() => onScreener(scope, 'all')}>
              {t('開啟每日選股', 'Open Daily Screener')} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="alpha-stats">
        <div>
          <small>{t('跨策略共識', 'Cross-strategy agreement')}</small>
          <strong>
            {ranking.ready ? ranking.alpha.length : '—'}
            <span>Alpha Picks</span>
          </strong>
          <p>
            {t(
              `門檻 ${settings.threshold} 分 · 至少 ${settings.minMatches} 項策略`,
              `${settings.threshold}+ points · ${settings.minMatches}+ strategies`,
            )}
          </p>
        </div>
        <div>
          <small>{t('其中已持有', 'Already in your portfolio')}</small>
          <strong>
            {ranking.ready ? ranking.alpha.filter((row) => row.relation === 'held').length : '—'}
            <span>{t('持倉', 'holdings')}</span>
          </strong>
          <p>{t('高分持倉仍需查看獨立風險提醒', 'Strong signals still need a risk review')}</p>
        </div>
        <div>
          <small>{t('需要檢閱', 'Needs your review')}</small>
          <strong>
            {activeAlerts.filter((alert) => alert.severity !== 'data').length}
            <span>{t('風險提醒', 'risk alerts')}</span>
          </strong>
          <p>
            {t(
              `${activeAlerts.filter((alert) => alert.severity === 'data').length} 項資料提醒`,
              `${activeAlerts.filter((alert) => alert.severity === 'data').length} data notices`,
            )}
          </p>
        </div>
        <div>
          <small>{t('研究資料覆蓋', 'Research coverage')}</small>
          <strong>
            {ranking.ready ? ranking.usable : '—'}
            <span>/ {ranking.total}</span>
          </strong>
          <p>{t('異常與過期資料排除於排序之外', 'Invalid and stale rows are excluded')}</p>
        </div>
      </div>
      {focusAlerts.length > 0 && (
        <section className="alpha-focus-strip" aria-label={t('今日持倉焦點', 'Holding Focus')}>
          <strong>{t('持倉焦點', 'Holding Focus')}</strong>
          <div>
            {focusAlerts.map((alert) => (
              <button
                type="button"
                key={alert.id}
                className={alert.severity}
                onClick={() => onOpen(alert.symbol, 'portfolio')}
              >
                <b>{alert.symbol}</b>
                <span>
                  {alertNames[alert.kind][locale === 'en' ? 1 : 0]}
                  {alert.value !== null
                    ? ` · ${alert.kind.startsWith('price_') ? money(alert.value) : num(alert.value, 1) + (alert.kind === 'overbought' ? '' : '%')}`
                    : ''}
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              document
                .querySelector('.alpha-alerts')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {t('查看全部提醒', 'View All Alerts')}
            <ArrowRight size={14} />
          </button>
        </section>
      )}
      <p className="footnote alpha-strategy-caption" id="alpha-strategy-method">
        {t(
          '各策略先列符合規則的前三檔，依跨策略 Alpha 分數、符合數、RPS 與代碼排序。0% 權重的策略仍可觀察，但不貢獻分數。',
          'Each strategy shows its first three matching candidates, ordered by cross-strategy Alpha score, match count, RPS, then ticker. A 0% strategy remains visible but contributes no score.',
        )}
      </p>
      <section
        className="alpha-strategy-board"
        aria-describedby="alpha-strategy-method"
        aria-label={t('四策略快速檢視', 'Four-strategy quick view')}
      >
        {STRATEGY_IDS.map((id, index) => {
          const candidates = ranking.rows.filter((row) =>
            row.contributions.some((part) => part.id === id && part.matched),
          )
          return (
            <article
              key={id}
              style={{ '--strategy-color': `var(--series-${index})` } as React.CSSProperties}
            >
              <header>
                <span>0{index + 1}</span>
                <small>
                  {num((settings.weights[id] / ranking.totalWeight) * 100, 0)}%{' '}
                  {t('權重', 'weight')}
                </small>
              </header>
              <h2>{title(id)}</h2>
              <p>
                {ranking.ready ? candidates.length : '—'} {t('檔符合', 'matches')}
              </p>
              <div className="alpha-mini-list">
                {candidates.slice(0, 3).map((row) => (
                  <button key={row.symbol} onClick={() => onOpen(row.symbol, scope, shownDate)}>
                    <strong>{row.symbol}</strong>
                    <span>
                      {num(row.score, 0)}
                      <small>/100</small>
                    </span>
                  </button>
                ))}
              </div>
              {!candidates.length && (
                <small>{t('等待符合條件的標的', 'Waiting for matching candidates')}</small>
              )}
              <button
                className="text-button"
                onClick={() => {
                  setFilter(id)
                  setIntersection([])
                  setRelation('all')
                  setQuery('')
                  setPage(0)
                }}
              >
                {t('查看排序', 'View Rankings')}
                <ArrowRight size={14} />
              </button>
            </article>
          )
        })}
      </section>
      <AlphaDailyChanges
        data={data}
        scope={scope}
        settings={settings}
        locale={locale}
        ready={ranking.ready}
        scanId={ranking.scan?.id}
        onOpen={onOpen}
      />
      <AlphaOverlap
        rows={ranking.rows}
        locale={locale}
        selected={intersection}
        onSelect={(strategies) => {
          setIntersection(strategies)
          setFilter('all')
          setRelation('all')
          setQuery('')
          setPage(0)
          requestAnimationFrame(() =>
            document
              .querySelector('.alpha-rankings')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          )
        }}
      />
      {scenario && (
        <PositionScenario
          key={scenario}
          data={data}
          locale={locale}
          symbol={scenario}
          onClose={() => setScenario(null)}
        />
      )}
      {fitSymbols.length > 0 && (
        <div className="alpha-holding-fit-slot">
          <DeferredContent
            name={locale === 'en' ? 'Holding Comparison' : '持倉比較'}
            locale={locale}
          >
            <CandidateHoldingFit
              symbols={fitSymbols}
              data={data}
              locale={locale}
              onClose={() => setFitSymbols([])}
              onOpen={(symbol) => onOpen(symbol, 'portfolio')}
            />
          </DeferredContent>
        </div>
      )}
      <div className="alpha-main-grid">
        <section className="alpha-rankings">
          <div className="section-heading">
            <div>
              <div className="eyebrow">YOUR RESEARCH SHORTLIST</div>
              <h2>{t('值得進一步研究', 'Worth a Closer Look')}</h2>
            </div>
            <div className="actions">
              <div
                className="alpha-view-switch"
                role="group"
                aria-label={t('候選檢視', 'Candidate View')}
              >
                <button
                  type="button"
                  aria-pressed={view === 'cards'}
                  onClick={() => changeView('cards')}
                >
                  {t('卡片', 'Cards')}
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'table'}
                  onClick={() => changeView('table')}
                >
                  {t('表格', 'Table')}
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'map'}
                  onClick={() => changeView('map')}
                >
                  {t('分布圖', 'Map')}
                </button>
              </div>
              <button
                className="text-button"
                onClick={exportCsv}
                disabled={!ranking.ready || !rows.length}
              >
                <Download size={15} />
                {t('匯出', 'Export')}
              </button>
            </div>
          </div>
          <div className="alpha-filters">
            <Filter size={15} />
            <select
              aria-label={t('研究排序篩選', 'Ranking filter')}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setPage(0)
              }}
            >
              <option value="alpha">Alpha Picks</option>
              <option value="all">{t('全部排序', 'All Ranked')}</option>
              <option value="shortlist">
                {t('研究清單', 'Shortlist')} ({shortlist.length})
              </option>
              {STRATEGY_IDS.map((id) => (
                <option key={id} value={id}>
                  {title(id)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('持倉關係', 'Portfolio relationship')}
              value={relation}
              onChange={(e) => {
                setRelation(e.target.value)
                setPage(0)
              }}
            >
              <option value="all">{t('全部標的', 'All Symbols')}</option>
              <option value="new">{t('新標的', 'New')}</option>
              <option value="held">{t('已持有', 'Held')}</option>
              <option value="watchlist">{t('觀察中', 'Watching')}</option>
            </select>
            <select
              className="alpha-sort-select"
              aria-label={t('候選排序方式', 'Candidate Sort Order')}
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as CandidateSort)
                setPage(0)
              }}
            >
              <option value="score">{t('Alpha 分數高至低', 'Alpha Score: High to Low')}</option>
              <option value="matches">
                {t('符合策略數多至少', 'Strategy Matches: Most First')}
              </option>
              <option value="rps">{t('RPS 高至低', 'RPS: High to Low')}</option>
              <option value="volume">{t('量比高至低', 'Volume Ratio: High to Low')}</option>
              <option value="symbol">{t('股票代碼 A–Z', 'Ticker A–Z')}</option>
            </select>
            <input
              aria-label={t('搜尋 Alpha 標的', 'Search Alpha candidates')}
              placeholder={t('搜尋代碼或公司', 'Ticker or company')}
              value={query}
              maxLength={200}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
            />
          </div>
          <CandidateFilters
            criteria={criteria}
            locale={locale}
            onApply={(next) => {
              setCriteria(next)
              setPage(0)
            }}
          />
          {Object.values(criteria).some((value) => value !== null) && (
            <p className="footnote">
              {t(
                `指標篩選後 ${rows.length} / ${baseRows.length} 檔。`,
                `${rows.length} of ${baseRows.length} candidates remain after indicator filters.`,
              )}
            </p>
          )}
          {intersection.length > 0 && (
            <div className="alpha-intersection-filter">
              <span>
                {t('策略交集', 'Strategy Intersection')}: {intersection.map(title).join(' × ')}
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setIntersection([])
                  setPage(0)
                }}
              >
                {t('清除交集', 'Clear Intersection')} ×
              </button>
            </div>
          )}
          {filter === 'shortlist' && (
            <p className="footnote">
              {t(
                '研究清單保留你標記的代碼，不改動持倉。下方僅顯示目前範圍內有有效研究資料的標的。',
                'Your shortlist saves starred tickers without changing holdings. Only symbols with valid research in the current scope appear below.',
              )}
              {shortlist.filter((symbol) => !ranking.rows.some((row) => row.symbol === symbol))
                .length > 0 && (
                <span>
                  {' '}
                  {t('目前範圍未列出：', 'Not listed in this scope: ')}
                  {shortlist
                    .filter((symbol) => !ranking.rows.some((row) => row.symbol === symbol))
                    .map((symbol) => (
                      <button
                        className="text-button alpha-missing-star"
                        key={symbol}
                        onClick={() => toggleShortlist(symbol)}
                        aria-label={t(`移除研究清單 ${symbol}`, `Remove ${symbol} from shortlist`)}
                      >
                        {symbol} ×
                      </button>
                    ))}
                </span>
              )}
            </p>
          )}
          {comparisonSymbols.length > 0 && (
            <div className="alpha-compare-tray">
              <div>
                <Compare size={16} />
                {comparisonSymbols.map((symbol) => (
                  <button
                    key={symbol}
                    onClick={() => toggleCompare(symbol)}
                    aria-label={t(`移除比較 ${symbol}`, `Remove comparison ${symbol}`)}
                  >
                    {symbol} ×
                  </button>
                ))}
              </div>
              <button
                className="button primary"
                disabled={comparisonSymbols.length < 2}
                onClick={() => onCompare(comparisonSymbols)}
              >
                {t(
                  `比較 ${comparisonSymbols.length} 檔`,
                  `Compare ${comparisonSymbols.length} Stocks`,
                )}
                <ArrowRight size={14} />
              </button>
              <button
                type="button"
                className="button"
                onClick={() => openHoldingFit(comparisonSymbols)}
              >
                {t('和持倉比較', 'Compare with Holdings')}
              </button>
              <small>{t('最多 5 檔', 'Up to 5 stocks')}</small>
              <button
                type="button"
                className="text-button"
                disabled={!ranking.ready}
                onClick={() => void copyResearch(comparisonSymbols)}
              >
                {t('複製研究交接包', 'Copy Research Handoff')}
              </button>
            </div>
          )}
          {view === 'map' && (
            <AlphaOpportunityMap
              rows={rows}
              locale={locale}
              shortlist={shortlist}
              onStar={toggleShortlist}
              onOpen={(row) => onOpen(row.symbol, scope, shownDate)}
            />
          )}
          {view === 'table' && (
            <AlphaRankingTable
              rows={visible}
              locale={locale}
              offset={currentPage * pageSize}
              shortlist={shortlist}
              compare={comparisonSymbols}
              alerts={alerts}
              expanded={expanded}
              busy={busy}
              adding={adding}
              actions={{
                open: (row) => onOpen(row.symbol, scope, shownDate),
                star: toggleShortlist,
                compare: toggleCompare,
                expand: (symbol) => setExpanded(expanded === symbol ? null : symbol),
                scenario: openScenario,
                watch: (row) => void addWatch(row),
                fit: (symbol) => openHoldingFit([symbol]),
                handoff: (symbol) => void copyResearch([symbol]),
              }}
            />
          )}
          {view === 'cards' && (
            <div className="alpha-ranked-list">
              {visible.map((row, index) => (
                <article
                  key={row.symbol}
                  className={row.alpha ? 'alpha-candidate is-alpha' : 'alpha-candidate'}
                >
                  <div className="alpha-candidate-head">
                    <span className="alpha-rank">
                      {String(currentPage * 12 + index + 1).padStart(2, '0')}
                    </span>
                    <button
                      className="alpha-symbol"
                      onClick={() => onOpen(row.symbol, scope, shownDate)}
                    >
                      <strong>
                        {row.symbol}
                        <ArrowRight size={14} />
                      </strong>
                      <small>{row.name}</small>
                    </button>
                    <span className={`alpha-relation ${row.relation}`}>{relationName(row)}</span>
                    <div className="alpha-score">
                      <strong>{num(row.score, 0)}</strong>
                      <small>/100</small>
                    </div>
                  </div>
                  <div
                    className="alpha-score-track"
                    aria-label={t('加權分數來源', 'Weighted score contributions')}
                  >
                    {row.contributions.map((part, i) => (
                      <span
                        key={part.id}
                        title={`${title(part.id)}: ${num(part.points, 1)}`}
                        style={{ width: `${part.points}%`, background: `var(--series-${i})` }}
                      />
                    ))}
                  </div>
                  <div className="alpha-candidate-meta">
                    <span>
                      {row.matched} {t('項共識', 'in agreement')} ·{' '}
                      {money(row.row.indicators.close)}
                    </span>
                    <span>
                      {t('RSI', 'RSI')} {num(row.row.indicators.rsi, 1)} · RPS{' '}
                      {num(row.row.indicators.rps, 1)}
                    </span>
                  </div>
                  <div className="alpha-candidate-actions">
                    <button
                      className="text-button"
                      aria-expanded={expanded === row.symbol}
                      onClick={() => setExpanded(expanded === row.symbol ? null : row.symbol)}
                    >
                      {t('為什麼入選', 'Why This Rank')}
                    </button>
                    <button className="text-button" onClick={() => openScenario(row.symbol)}>
                      {t('試算', 'Scenario')}
                    </button>
                    <button
                      className="icon-button alpha-star"
                      aria-label={
                        shortlist.includes(row.symbol)
                          ? t(`移除研究清單 ${row.symbol}`, `Unstar ${row.symbol}`)
                          : t(`加入研究清單 ${row.symbol}`, `Star ${row.symbol}`)
                      }
                      aria-pressed={shortlist.includes(row.symbol)}
                      onClick={() => toggleShortlist(row.symbol)}
                    >
                      {shortlist.includes(row.symbol) ? (
                        <StarFilled size={15} />
                      ) : (
                        <Star size={15} />
                      )}
                    </button>
                    <label className="alpha-compare-check">
                      <input
                        type="checkbox"
                        aria-label={t(`比較 ${row.symbol}`, `Compare ${row.symbol}`)}
                        checked={comparisonSymbols.includes(row.symbol)}
                        disabled={
                          !comparisonSymbols.includes(row.symbol) && comparisonSymbols.length >= 5
                        }
                        onChange={() => toggleCompare(row.symbol)}
                      />
                      {t('比較', 'Compare')}
                    </label>
                    {alerts.some(
                      (alert) => alert.symbol === row.symbol && alert.severity !== 'data',
                    ) && (
                      <span className="alpha-risk-flag">
                        <WarningAlt size={13} />
                        {t('持倉需留意', 'Holding alert')}
                      </span>
                    )}
                    {row.relation === 'new' && (
                      <button
                        className="text-button"
                        disabled={!!adding || busy}
                        onClick={() => void addWatch(row)}
                      >
                        {adding === row.symbol ? t('加入中…', 'Adding…') : t('加入觀察', 'Watch')}
                      </button>
                    )}
                  </div>
                  {expanded === row.symbol && (
                    <div className="alpha-breakdown">
                      {row.contributions.map((part) => (
                        <div key={part.id}>
                          <span>{title(part.id)}</span>
                          <span>
                            {part.weight === 0
                              ? t('停用', 'Disabled')
                              : !part.available
                                ? t('資料不足', 'Unavailable')
                                : part.matched
                                  ? t('符合', 'Match')
                                  : t('未符合', 'No Match')}
                          </span>
                          <b>+{num(part.points, 1)}</b>
                          <small className="alpha-rule-reason">
                            {translateText(part.reason, locale)}
                          </small>
                        </div>
                      ))}
                      <p>
                        {t(
                          `有效權重覆蓋 ${num(row.coverage, 0)}%。未通過的策略不加分；缺值不重分配權重。`,
                          `${num(row.coverage, 0)}% weighted data coverage. Unmatched strategies add no points; missing data never redistributes weights.`,
                        )}
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => openHoldingFit([row.symbol])}
                      >
                        {t('和現有持倉比較走勢', 'Compare Returns with Holdings')}
                        <ArrowRight size={14} />
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void copyResearch([row.symbol])}
                      >
                        {t('複製研究交接包', 'Copy Research Handoff')}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {!rows.length && (
            <div className="alpha-empty">
              <h3>{t('目前沒有符合這組條件的標的', 'No candidates match these conditions')}</h3>
              <p>
                {t(
                  '可以查看全部排序，或調整策略與持倉篩選。沒有 Alpha Pick 也是有用的結果。',
                  'View all rankings or adjust strategy and ownership filters. Having no Alpha Pick is a valid outcome.',
                )}
              </p>
              <button
                className="button"
                onClick={() => {
                  setFilter('all')
                  setIntersection([])
                  setRelation('all')
                  setQuery('')
                  setCriteria({ ...EMPTY_CRITERIA })
                  setPage(0)
                }}
              >
                {t('查看全部排序', 'View All Rankings')}
              </button>
            </div>
          )}
          {rows.length > 0 && view !== 'map' && (
            <div className="alpha-pagination">
              <span>
                {currentPage * pageSize + 1}–
                {Math.min(rows.length, currentPage * pageSize + pageSize)} / {rows.length}
              </span>
              <div className="actions">
                <button
                  className="button"
                  disabled={!currentPage}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t('上一頁', 'Previous')}
                </button>
                <button
                  className="button"
                  disabled={(currentPage + 1) * pageSize >= rows.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t('下一頁', 'Next')}
                </button>
              </div>
            </div>
          )}
        </section>
        <aside className="alpha-alerts">
          <div className="section-heading">
            <div>
              <div className="eyebrow">PORTFOLIO ATTENTION</div>
              <h2>
                {t('持倉提醒', 'Holding Alerts')}
                <span>{activeAlerts.length}</span>
              </h2>
            </div>
            <WarningAlt size={20} />
          </div>
          <p>
            {t(
              '每次行情更新後重新檢視。這些是觀察條件，不代表預測損失或賣出指令。',
              'Re-evaluated when workspace data refreshes. These are review conditions, not loss forecasts or sell orders.',
            )}
          </p>
          <label className="alpha-review-toggle">
            <input
              type="checkbox"
              checked={showReviewed}
              onChange={(e) => setShowReviewed(e.target.checked)}
            />
            {t('顯示已檢閱提醒', 'Show Reviewed Alerts')}
          </label>
          {shownAlerts.slice(0, alertLimit).map((alert) => (
            <article key={alert.id} className={`alpha-alert ${alert.severity}`}>
              <div>
                <button
                  className="text-button"
                  onClick={() =>
                    alert.severity === 'data' ? onData() : onOpen(alert.symbol, 'portfolio')
                  }
                >
                  <strong>{alert.symbol}</strong>
                  <ArrowRight size={13} />
                </button>
                <small>{alert.date || '—'}</small>
              </div>
              <h3>{alertNames[alert.kind][locale === 'en' ? 1 : 0]}</h3>
              {alert.value != null && (
                <p>
                  {alert.kind.startsWith('price_')
                    ? money(alert.value)
                    : num(alert.value, 1) + (alert.kind === 'overbought' ? ' RSI' : '%')}
                  {alert.threshold != null &&
                  alert.kind !== 'below_ma200' &&
                  alert.kind !== 'below_ma50'
                    ? ` · ${t('門檻', 'Threshold')} ${alert.kind.startsWith('price_') ? money(alert.threshold) : alert.threshold}`
                    : ''}
                </p>
              )}
              <button className="text-button" onClick={() => acknowledge(alert.id)}>
                <Checkmark size={13} />
                {reviewed.includes(alert.id)
                  ? t('恢復待檢閱', 'Mark Unreviewed')
                  : t('已檢閱', 'Mark Reviewed')}
              </button>
            </article>
          ))}
          {!shownAlerts.length && (
            <div className="alpha-empty">
              <Checkmark size={23} />
              <p>{t('目前沒有待檢閱的提醒。', 'No alerts are waiting for review.')}</p>
            </div>
          )}
          {shownAlerts.length > alertLimit && (
            <button className="button" onClick={() => setAlertLimit(alertLimit + 12)}>
              {t(
                `顯示更多（剩餘 ${shownAlerts.length - alertLimit} 項）`,
                `Show More (${shownAlerts.length - alertLimit} remaining)`,
              )}
            </button>
          )}
          <p className="footnote">
            {t(
              '檢閱僅代表你已看過。下一交易日或門檻變更會再次提醒；此提醒中心只在本機介面運作。',
              'Reviewed means you have seen the condition. A new session or changed threshold creates a fresh alert. This alert center operates inside the local app.',
            )}
          </p>
          <DesktopAlertSettings locale={locale} />
        </aside>
      </div>
      <ResearchJournal
        data={data}
        scope={scope}
        settings={settings}
        locale={locale}
        onOpen={onOpen}
      />
      <ResearchTracker
        shortlist={shortlist}
        candidates={ranking.rows}
        locale={locale}
        onOpen={(symbol) => onOpen(symbol, scope, shownDate)}
      />
      <div className="alpha-lab-link">
        <div>
          <strong>{t('從共識到驗證', 'From Agreement to Evaluation')}</strong>
          <p>
            {t(
              '在 Alpha 實驗室回放歷史訊號，或模擬定期等權重配置。',
              'Replay historical signals or simulate periodic equal-weight allocation in Alpha Lab.',
            )}
          </p>
        </div>
        <button className="button" onClick={onLab}>
          {t('開啟 Alpha 實驗室', 'Open Alpha Lab')}
          <ArrowRight size={15} />
        </button>
      </div>
      <details className="alpha-method">
        <summary>{t('分數如何計算？', 'How is the score calculated?')}</summary>
        <p>
          {t(
            '得分 = 100 × 符合策略權重總和 ÷ 四策略啟用權重總和。預設四策略各 25%，至少兩項符合且 ≥ 50 分為 Alpha Pick。所有啟用策略都須可計算。',
            'Score = 100 × matched strategy weights / all enabled strategy weights. Defaults are 25% per strategy, at least two matches, and a score of 50 or more. Every enabled strategy must have valid data.',
          )}
        </p>
        <p>
          {t(
            '排序依分數、符合策略數、同股票池 RPS、股票代碼。高分表示規則交集，不是預期報酬、勝率或個人化投資建議。調整權重不會重跑回測；策略可能高度相關。',
            'Ranked by score, match count, same-universe RPS, then ticker. Scores reflect rule agreement, not expected return, win probability, or personalized advice. Weight changes do not run a backtest; strategies may be highly correlated.',
          )}
        </p>
        <p>
          {t(
            '市場與個人清單分開計分，RPS 不混用。只有版本有效、日期一致且沒有資料異常的標的可進入排序。',
            'Market and personal lists are scored separately; their RPS ranks are not mixed. Only current, date-aligned, valid research enters rankings.',
          )}{' '}
          {ALPHA_VERSION}
        </p>
      </details>
    </div>
  )
}
