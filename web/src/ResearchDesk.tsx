import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import { useSessionState } from './session-state'
import { dateTime, num } from './ui'
import {
  configDraft,
  configKey,
  DESK_DRAFT_KEY,
  defaultDeskDraft,
  deskPercent,
  deskRatio,
  parameterGrid,
  parseConfig,
  parseDeskDraft,
  validDeskDraft,
  type DeskCatalog,
  type DeskConfig,
  type DeskDiagnosis,
  type DeskDraft,
  type DeskDraftError,
  type DeskFlag,
  type DeskLeaderRow,
  type DeskPine,
  type DeskPreset,
  type DeskRankBy,
  type DeskResult,
  type DeskRunSummary,
  type DeskStrategyId,
} from './research-desk-model'
import { ResearchDeskDiagnosis } from './ResearchDeskDiagnosis'
import './research-desk.css'

export type Translate = (zh: string, en: string) => string
const ENGLISH: Record<string, string> = {
  no_history: 'This symbol has no local daily history. Refresh market data first.',
  invalid_history: 'The local daily history failed validation. Refresh market data.',
  insufficient_history: 'Not enough history after the warm-up period for this test.',
  no_usable_symbols:
    'No symbol has enough valid local history. Refresh data or use strategies with a shorter warm-up.',
  numeric_range: 'The simulation left the valid numeric range. Check the daily prices.',
  preset_not_found: 'That preset no longer exists.',
  preset_changed: 'The preset changed in another window. Reload before saving.',
  preset_limit: 'The preset limit has been reached.',
  run_not_found: 'That saved run no longer exists.',
}
export async function deskRequest<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.code)
      throw new Error(t(String(detail.message), ENGLISH[detail.code] || String(detail.message)))
    if (Array.isArray(detail) && typeof detail[0]?.msg === 'string')
      throw new Error(
        t(
          detail[0].msg.replace(/^Value error, /, ''),
          'The request did not pass validation. Check the highlighted settings.',
        ),
      )
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
export async function deskDownload(url: string, body: unknown, filename: string, t: Translate) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    throw new Error(
      value?.detail?.message
        ? t(value.detail.message, ENGLISH[value.detail.code] || value.detail.message)
        : t('下載失敗', 'Download failed'),
    )
  }
  const blob = await response.blob()
  const link = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = link
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(link), 10000)
}

const FLAG_LABELS: Record<DeskFlag, [string, string]> = {
  benchmark_strategy: ['基準', 'Benchmark'],
  low_sample: ['樣本不足', 'Small sample'],
  no_trades: ['沒有交易', 'No trades'],
  beats_benchmark_minority: ['多數未勝過基準', 'Trails benchmark on most symbols'],
  out_of_sample_decay: ['樣本外轉弱', 'Out-of-sample decay'],
}
const RANK_LABELS: Record<DeskRankBy, [string, string]> = {
  excess_return: ['超額報酬（對買入持有）', 'Excess return vs buy-and-hold'],
  sharpe: ['Sharpe 比率', 'Sharpe ratio'],
  profit_factor: ['合併獲利因子', 'Pooled profit factor'],
  max_drawdown: ['最大回撤（越淺越好）', 'Max drawdown (shallower is better)'],
}
function draftError(error: DeskDraftError, t: Translate, catalog: DeskCatalog, draft: DeskDraft) {
  if (error.code === 'param' || error.code === 'relation') {
    const config = draft.configs[error.index]
    const spec = catalog.strategies.find((item) => item.id === config?.strategy)
    const name = spec ? t(spec.label, spec.english) : ''
    if (error.code === 'relation')
      return t(
        `第 ${error.index + 1} 組「${name}」：快線須小於慢線、RSI 進場值須小於出場值。`,
        `Config ${error.index + 1} (${name}): the fast period must be below the slow period and the RSI entry below the exit.`,
      )
    const rule = spec?.params.find((item) => item.name === error.name)
    return t(
      `第 ${error.index + 1} 組「${name}」的${rule?.label ?? error.name}必須介於 ${rule?.min}–${rule?.max}${rule?.kind === 'int' ? ' 的整數' : ''}。`,
      `Config ${error.index + 1} (${name}): ${rule?.english ?? error.name} must be ${rule?.kind === 'int' ? 'an integer ' : ''}between ${rule?.min} and ${rule?.max}.`,
    )
  }
  const messages: Record<string, [string, string]> = {
    symbols: [
      `請輸入 1–${catalog.limits.symbols} 個大寫股票代碼。`,
      `Enter 1–${catalog.limits.symbols} uppercase ticker symbols.`,
    ],
    duplicate_symbols: ['代碼不可重複。', 'Symbols must be unique.'],
    configs: [
      `請加入 1–${catalog.limits.configs} 組策略設定。`,
      `Add 1–${catalog.limits.configs} strategy configurations.`,
    ],
    duplicate_configs: ['策略設定不可重複。', 'Strategy configurations must be unique.'],
    risk: [
      '資金 1,000–1e9、手續費與滑價 0–100 bps、部位 1–100%、停損 0.5–50%、停利 1–500%。',
      'Cash 1,000–1e9, fee and slippage 0–100 bps, position 1–100%, stop 0.5–50%, target 1–500%.',
    ],
    oos: ['樣本外比例必須為 0 或 10–50%。', 'The out-of-sample share must be 0 or 10–50%.'],
    dates: [
      '日期格式為 YYYY-MM-DD，且開始不可晚於結束。',
      'Use YYYY-MM-DD with start on or before end.',
    ],
  }
  const [zh, en] = messages[error.code]
  return t(zh, en)
}
const signed = (value: number | null | undefined) =>
  value == null ? '' : value > 0 ? 'desk-positive' : value < 0 ? 'desk-negative' : ''

type Props = { locale: Locale; holdings: string[] }

export function ResearchDesk({ locale, holdings }: Props) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [draft, setDraft] = useSessionState(DESK_DRAFT_KEY, defaultDeskDraft, validDeskDraft)
  const [catalog, setCatalog] = useState<DeskCatalog | null>(null)
  const [presets, setPresets] = useState<DeskPreset[]>([])
  const [runs, setRuns] = useState<DeskRunSummary[]>([])
  const [runTotal, setRunTotal] = useState(0)
  const [result, setResult] = useState<DeskResult | null>(null)
  const [diagnosis, setDiagnosis] = useState<DeskDiagnosis | null>(null)
  const [pine, setPine] = useState<DeskPine | null>(null)
  const [selected, setSelected] = useState<{ index: number; symbol: string } | null>(null)
  const [addStrategy, setAddStrategy] = useState<DeskStrategyId>('sma_cross')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [refresh, setRefresh] = useState(0)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.allSettled([
      deskRequest<DeskCatalog>('/api/research-desk/catalog', t, { signal: controller.signal }),
      deskRequest<{ presets: DeskPreset[] }>('/api/research-desk/presets', t, {
        signal: controller.signal,
      }),
      deskRequest<{ runs: DeskRunSummary[]; total: number }>(
        '/api/research-desk/runs?limit=50',
        t,
        {
          signal: controller.signal,
        },
      ),
    ]).then(([catalogResult, presetResult, runResult]) => {
      if (controller.signal.aborted) return
      const errors: string[] = []
      const reason = (item: PromiseRejectedResult) =>
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value)
      else errors.push(reason(catalogResult))
      if (presetResult.status === 'fulfilled') setPresets(presetResult.value.presets)
      else errors.push(reason(presetResult))
      if (runResult.status === 'fulfilled') {
        setRuns(runResult.value.runs)
        setRunTotal(runResult.value.total)
      } else errors.push(reason(runResult))
      setLoadErrors(errors)
    })
    return () => controller.abort()
    // Labels re-render with the locale; the catalog, presets and history need no refetch for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  async function perform(action: string, work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(action)
    setError('')
    setNotice('')
    try {
      await work(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setBusy(null)
    }
  }
  const parsed = catalog ? parseDeskDraft(draft, catalog) : null
  const limit = catalog?.limits.configs ?? 24
  const strategyLabel = (id: DeskStrategyId) => {
    const spec = catalog?.strategies.find((item) => item.id === id)
    return spec ? t(spec.label, spec.english) : id
  }
  function setConfigs(configs: DeskDraft['configs']) {
    setDraft({ ...draft, configs: configs.slice(0, limit) })
  }
  function appendConfigs(configs: DeskConfig[]) {
    if (!catalog) return
    const existing = new Set(
      draft.configs.flatMap((item) => {
        const value = parseConfig(item, catalog)
        return value.config ? [configKey(value.config)] : []
      }),
    )
    const additions = configs.filter((config) => !existing.has(configKey(config)))
    const room = limit - draft.configs.length
    setConfigs([...draft.configs, ...additions.slice(0, Math.max(room, 0)).map(configDraft)])
    if (additions.length > room)
      setNotice(
        t(
          `已達 ${limit} 組上限，略過 ${additions.length - Math.max(room, 0)} 組。`,
          `Reached the ${limit}-config limit; skipped ${additions.length - Math.max(room, 0)}.`,
        ),
      )
  }
  function addOne() {
    if (!catalog) return
    const spec = catalog.strategies.find((item) => item.id === addStrategy)
    if (!spec) return
    setConfigs([
      ...draft.configs,
      {
        strategy: spec.id,
        params: Object.fromEntries(spec.params.map((rule) => [rule.name, String(rule.default)])),
      },
    ])
  }
  function run(event: FormEvent) {
    event.preventDefault()
    if (!parsed?.request) return
    const request = parsed.request
    void perform('run', async (signal) => {
      const data = await deskRequest<DeskResult>('/api/research-desk/tournament', t, {
        method: 'POST',
        signal,
        body: JSON.stringify(request),
      })
      if (signal.aborted) return
      setResult(data)
      setDiagnosis(null)
      setPine(null)
      setSelected(null)
      setRefresh((value) => value + 1)
    })
  }
  function diagnose(row: DeskLeaderRow, symbol: string) {
    if (!result) return
    const status = result.symbols.find((item) => item.symbol === symbol)
    if (!status?.windows) return
    setSelected({ index: row.config_index, symbol })
    void perform('diagnose', async (signal) => {
      const data = await deskRequest<DeskDiagnosis>('/api/research-desk/diagnose', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          symbol,
          config: row.config,
          risk: result.request.risk,
          test_start: status.windows!.full.start,
          test_end: result.request.end_date,
        }),
      })
      if (!signal.aborted) {
        setDiagnosis(data)
        setPine(null)
      }
    })
  }
  function exportPine() {
    if (!diagnosis || !result) return
    void perform('pine', async (signal) => {
      const data = await deskRequest<DeskPine>('/api/research-desk/pine', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          config: diagnosis.config,
          risk: result.request.risk,
          start_date: diagnosis.window.start,
        }),
      })
      if (!signal.aborted) setPine(data)
    })
  }
  function exportCsv() {
    if (!diagnosis || !result) return
    void perform('csv', async () => {
      await deskDownload(
        '/api/research-desk/trades.csv',
        {
          symbol: diagnosis.symbol,
          config: diagnosis.config,
          risk: result.request.risk,
          test_start: diagnosis.window.start,
          test_end: result.request.end_date,
        },
        `research-desk-${diagnosis.symbol}-${diagnosis.config.strategy}.csv`,
        t,
      )
    })
  }
  function savePreset(index: number) {
    if (!catalog || !parsed) return
    const value = parseConfig(draft.configs[index], catalog, index)
    if (!value.config || !parsed.request) {
      setError(
        t('請先修正策略或成本設定再保存。', 'Fix the strategy or cost settings before saving.'),
      )
      return
    }
    const config = value.config
    const risk = parsed.request.risk
    const spec = catalog.strategies.find((item) => item.id === config.strategy)
    const name =
      `${spec?.label ?? config.strategy} ${Object.values(config.params).join('/')}`.trim()
    void perform('preset', async (signal) => {
      await deskRequest<DeskPreset>('/api/research-desk/presets', t, {
        method: 'POST',
        signal,
        body: JSON.stringify({ name, config, risk }),
      })
      if (signal.aborted) return
      setNotice(t(`已保存預設「${name}」。`, `Saved preset “${name}”.`))
      setRefresh((value) => value + 1)
    })
  }
  function deletePreset(preset: DeskPreset) {
    void perform('preset', async (signal) => {
      await deskRequest(`/api/research-desk/presets/${encodeURIComponent(preset.id)}`, t, {
        method: 'DELETE',
        signal,
        body: JSON.stringify({ expected_version: preset.version }),
      })
      if (!signal.aborted) setRefresh((value) => value + 1)
    })
  }
  function applyPresetRisk(preset: DeskPreset) {
    const risk = preset.risk
    setDraft({
      ...draft,
      risk: {
        initial_cash: String(risk.initial_cash),
        fee_bps: String(risk.fee_bps),
        slippage_bps: String(risk.slippage_bps),
        position_pct: String(risk.position_pct),
        stop_loss_pct: risk.stop_loss_pct == null ? '' : String(risk.stop_loss_pct),
        take_profit_pct: risk.take_profit_pct == null ? '' : String(risk.take_profit_pct),
      },
    })
  }
  function openRun(id: string) {
    void perform('history', async (signal) => {
      const data = await deskRequest<DeskResult>(
        `/api/research-desk/runs/${encodeURIComponent(id)}`,
        t,
        { signal },
      )
      if (signal.aborted) return
      setResult(data)
      setDiagnosis(null)
      setPine(null)
      setSelected(null)
    })
  }
  function reuse(request: DeskResult['request']) {
    setDraft({
      symbols: request.symbols.join(' '),
      startDate: request.start_date ?? '',
      endDate: request.end_date ?? '',
      oosPct: String(request.oos_pct),
      rankBy: request.rank_by,
      risk: {
        initial_cash: String(request.risk.initial_cash),
        fee_bps: String(request.risk.fee_bps),
        slippage_bps: String(request.risk.slippage_bps),
        position_pct: String(request.risk.position_pct),
        stop_loss_pct: request.risk.stop_loss_pct == null ? '' : String(request.risk.stop_loss_pct),
        take_profit_pct:
          request.risk.take_profit_pct == null ? '' : String(request.risk.take_profit_pct),
      },
      configs: request.configs.map(configDraft),
    })
    setNotice(t('已載入這次的設定。', 'Loaded that run’s settings.'))
  }
  const riskField = (key: keyof DeskDraft['risk'], zh: string, en: string, hint?: string) => (
    <label>
      {t(zh, en)}
      <input
        inputMode="decimal"
        value={draft.risk[key]}
        placeholder={hint}
        onChange={(event) =>
          setDraft({ ...draft, risk: { ...draft.risk, [key]: event.target.value } })
        }
      />
    </label>
  )

  return (
    <div className="research-desk" translate="no">
      <div className="page-title">
        <div>
          <div className="eyebrow">RESEARCH DESK / STRATEGY TOURNAMENT</div>
          <h1>{t('回測研究台', 'Research Desk')}</h1>
          <p>
            {t(
              '把交易想法寫成可計算的規則，在同一段本機日線上一次比較多組策略、對照買入持有，再追問它為什麼虧損。',
              'Turn trading ideas into computable rules, compare many strategies on the same local daily bars against buy-and-hold, then ask why they lost.',
            )}
          </p>
        </div>
        <span className="desk-mode">
          {t('本機日線 · 僅供研究', 'Local daily bars · research only')}
        </span>
      </div>
      <ol className="desk-flow" aria-label={t('研究流程', 'Research flow')}>
        {[
          ['選策略與參數', 'Pick strategies and parameters'],
          ['同窗口比較', 'Compare on one window'],
          ['樣本外核對', 'Check out of sample'],
          ['診斷虧損', 'Diagnose losses'],
          ['匯出 CSV／Pine', 'Export CSV / Pine'],
        ].map(([zh, en], index) => (
          <li key={en}>
            <i>{index + 1}</i>
            {t(zh, en)}
          </li>
        ))}
      </ol>
      {loadErrors.map((message, index) => (
        <p className="error-message" role="alert" key={index}>
          {message}
        </p>
      ))}

      <form onSubmit={run}>
        <section className="desk-panel" aria-label={t('測試設定', 'Test settings')}>
          <h2>{t('測試設定', 'Test settings')}</h2>
          <div className="desk-form-grid">
            <label style={{ gridColumn: '1 / -1' }}>
              {t(
                '代碼（空白或逗號分隔，最多 10 檔）',
                'Symbols (space or comma separated, up to 10)',
              )}
              <input
                value={draft.symbols}
                placeholder="MU GOOGL TSLA"
                onChange={(event) => setDraft({ ...draft, symbols: event.target.value })}
              />
            </label>
            <label>
              {t('開始日期（選填）', 'Start date (optional)')}
              <input
                type="date"
                value={draft.startDate}
                onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
              />
            </label>
            <label>
              {t('結束日期（選填）', 'End date (optional)')}
              <input
                type="date"
                value={draft.endDate}
                onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
              />
            </label>
            <label>
              {t('樣本外比例', 'Out-of-sample share')}
              <select
                value={draft.oosPct}
                onChange={(event) => setDraft({ ...draft, oosPct: event.target.value })}
              >
                {['0', '20', '30', '40'].map((value) => (
                  <option key={value} value={value}>
                    {value === '0' ? t('不保留', 'None') : `${value}%`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('排名依據（樣本內）', 'Rank by (in sample)')}
              <select
                value={draft.rankBy}
                onChange={(event) =>
                  setDraft({ ...draft, rankBy: event.target.value as DeskRankBy })
                }
              >
                {(Object.keys(RANK_LABELS) as DeskRankBy[]).map((key) => (
                  <option key={key} value={key}>
                    {t(...RANK_LABELS[key])}
                  </option>
                ))}
              </select>
            </label>
            {riskField('initial_cash', '起始資金（USD）', 'Starting cash (USD)')}
            {riskField('fee_bps', '單邊手續費（bps）', 'Fee per side (bps)')}
            {riskField('slippage_bps', '單邊滑價（bps）', 'Slippage per side (bps)')}
            {riskField('position_pct', '每次投入淨值（%）', 'Equity per entry (%)')}
            {riskField(
              'stop_loss_pct',
              '收盤停損（%，選填）',
              'Close stop-loss (%, optional)',
              '—',
            )}
            {riskField(
              'take_profit_pct',
              '收盤停利（%，選填）',
              'Close take-profit (%, optional)',
              '—',
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={!holdings.length}
              onClick={() =>
                setDraft({
                  ...draft,
                  symbols: holdings.slice(0, catalog?.limits.symbols ?? 10).join(' '),
                })
              }
            >
              {t('帶入我的持股代碼', 'Use my holdings')}
            </button>
          </div>
          <p className="desk-meta">
            {t(
              '預設沿用文章的回測假設：單邊 0.1% 手續費、訊號出現後的下一根 K 棒開盤成交、10 萬美元起始資金。只使用本機已下載的日線；持股股數與成本不會用在回測中。',
              'Defaults follow the articles’ assumptions: 0.1% commission per side, fills at the next bar’s open, $100,000 starting capital. Only locally downloaded daily bars are used; your share counts and costs are never part of a backtest.',
            )}
          </p>
        </section>

        <section className="desk-panel" aria-label={t('策略組合', 'Strategy set')}>
          <h2>
            {t('策略組合', 'Strategy set')} ({draft.configs.length}/{limit})
          </h2>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={!catalog}
              onClick={() => catalog && setConfigs(catalog.classic_set.map(configDraft))}
            >
              {t('載入經典策略組合', 'Load the classic strategy set')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!catalog}
              onClick={() =>
                catalog &&
                appendConfigs(
                  parameterGrid('sma_cross', { fast: [10, 20, 50], slow: [50, 100, 200] }, catalog),
                )
              }
            >
              {t('加入均線參數網格', 'Add an SMA parameter grid')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!draft.configs.length}
              onClick={() => setConfigs([])}
            >
              {t('清空', 'Clear')}
            </button>
          </div>
          <ol className="desk-configs">
            {draft.configs.map((config, index) => {
              const spec = catalog?.strategies.find((item) => item.id === config.strategy)
              return (
                <li key={index}>
                  <div>
                    <strong>
                      {index + 1}. {strategyLabel(config.strategy)}
                    </strong>
                    <small>{spec ? t(spec.summary, spec.summary_en) : ''}</small>
                  </div>
                  <div className="desk-param-grid">
                    {spec?.params.map((rule) => (
                      <label key={rule.name}>
                        {t(rule.label, rule.english)}
                        <input
                          inputMode="decimal"
                          value={config.params[rule.name] ?? String(rule.default)}
                          onChange={(event) => {
                            const configs = [...draft.configs]
                            configs[index] = {
                              ...config,
                              params: { ...config.params, [rule.name]: event.target.value },
                            }
                            setConfigs(configs)
                          }}
                        />
                      </label>
                    ))}
                    {!spec?.params.length && (
                      <small>{t('固定規則，無參數', 'Fixed rules, no parameters')}</small>
                    )}
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="button"
                      disabled={!!busy}
                      onClick={() => savePreset(index)}
                    >
                      {t('存為預設', 'Save preset')}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setConfigs(draft.configs.filter((_, item) => item !== index))}
                      aria-label={t(`移除第 ${index + 1} 組`, `Remove config ${index + 1}`)}
                    >
                      {t('移除', 'Remove')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="desk-add">
            <label>
              {t('加入策略', 'Add a strategy')}
              <select
                value={addStrategy}
                onChange={(event) => setAddStrategy(event.target.value as DeskStrategyId)}
              >
                {catalog?.strategies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.label, item.english)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button"
              disabled={!catalog || draft.configs.length >= limit}
              onClick={addOne}
            >
              {t('加入', 'Add')}
            </button>
          </div>
          {!!presets.length && (
            <>
              <h3>{t('我的策略預設', 'My saved strategies')}</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('名稱', 'Name'),
                        t('策略', 'Strategy'),
                        t('成本與部位', 'Costs and sizing'),
                        t('操作', 'Actions'),
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {presets.map((preset) => (
                      <tr key={preset.id}>
                        <td>{preset.name}</td>
                        <td>{t(preset.label, preset.label_en)}</td>
                        <td>
                          {preset.risk.fee_bps} bps · {preset.risk.position_pct}%
                          {preset.risk.stop_loss_pct != null
                            ? ` · ${t('停損', 'stop')} ${preset.risk.stop_loss_pct}%`
                            : ''}
                        </td>
                        <td>
                          <div className="actions" style={{ margin: 0 }}>
                            <button
                              type="button"
                              className="button"
                              disabled={draft.configs.length >= limit}
                              onClick={() => appendConfigs([preset.config])}
                            >
                              {t('加入策略', 'Add strategy')}
                            </button>
                            <button
                              type="button"
                              className="button"
                              onClick={() => applyPresetRisk(preset)}
                            >
                              {t('套用成本設定', 'Apply costs')}
                            </button>
                            <button
                              type="button"
                              className="button"
                              disabled={!!busy}
                              onClick={() => deletePreset(preset)}
                            >
                              {t('刪除', 'Delete')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {parsed?.error && draft.configs.length > 0 && catalog && (
            <p className="error-message" role="alert">
              {draftError(parsed.error, t, catalog, draft)}
            </p>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="button primary" disabled={!parsed?.request || !!busy}>
              {busy === 'run' ? t('比較中…', 'Comparing…') : t('執行策略比較', 'Run tournament')}
            </button>
          </div>
        </section>
      </form>

      {result && (
        <Leaderboard
          key={result.run_id || JSON.stringify(result.request)}
          result={result}
          selected={selected}
          busy={!!busy}
          onDiagnose={diagnose}
          onReuse={() => reuse(result.request)}
          t={t}
        />
      )}
      {diagnosis && result && (
        <ResearchDeskDiagnosis
          diagnosis={diagnosis}
          symbols={result.symbols.map((item) => item.symbol)}
          pine={pine}
          busy={busy}
          integrityContextIdentity={JSON.stringify([
            draft,
            result.run_id,
            result.request,
            selected,
          ])}
          onPine={exportPine}
          onCsv={exportCsv}
          t={t}
          locale={locale}
        />
      )}

      <section className="desk-panel" aria-label={t('研究紀錄', 'Run history')}>
        <h2>{t('研究紀錄', 'Run history')}</h2>
        {!runs.length ? (
          <p>{t('尚無已保存的比較。', 'No saved tournaments yet.')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('時間', 'Time'),
                    t('代碼', 'Symbols'),
                    t('設定數', 'Configs'),
                    t('樣本內前三名', 'Top three in sample'),
                    t('狀態', 'Status'),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button
                        type="button"
                        className="button"
                        disabled={!!busy}
                        onClick={() => openRun(row.id)}
                      >
                        {dateTime(row.created_at)}
                      </button>
                    </td>
                    <td>
                      {row.symbols.join(' ')} ({row.symbols_ok}/{row.symbols.length})
                    </td>
                    <td>{row.configs_tested}</td>
                    <td>{row.top.map((item) => t(item.label, item.label_en)).join(' · ')}</td>
                    <td>
                      {row.current
                        ? t('資料未變', 'Inputs unchanged')
                        : t('行情已更新，請重新執行核對', 'Data changed; rerun to verify')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runTotal > runs.length && (
          <p className="desk-meta">
            {t(
              `顯示最近 ${runs.length} 筆，共 ${runTotal} 筆。`,
              `Showing the latest ${runs.length} of ${runTotal}.`,
            )}
          </p>
        )}
      </section>

      <div className="research-note">
        <h3>{t('這不是什麼', 'What this is not')}</h3>
        <p>
          {t(
            '這是歷史模擬，不是預測、投資建議或下單工具。每日線、只做多、一次一個部位；訊號在收盤確認、下一個交易日開盤成交，停損停利也以收盤確認。沒有盤中路徑、流動性、稅務或借券；本機日線約兩年且只有目前存活的標的，存在倖存者偏差。',
            'This is a historical simulation, not a forecast, advice or an order tool. Daily bars, long only, one position at a time; signals confirm on the close and fill at the next session’s open, and stops also confirm on the close. There is no intraday path, liquidity, tax or borrow model; local history covers about two years of currently listed symbols, so survivorship bias applies.',
          )}
        </p>
        <p>
          {t(
            '一次比較越多組參數，樣本內第一名越可能只是運氣。請看樣本外結果、跨標的是否一致與交易筆數，而不是單一最高報酬。',
            'The more configurations you compare, the more likely the in-sample winner is luck. Judge by out-of-sample results, consistency across symbols and trade counts, not a single top return.',
          )}
        </p>
        {catalog && (
          <p>
            {t('概念與策略範本參考', 'Concepts and strategy templates adapted from')}{' '}
            <a href={catalog.attribution.url} target="_blank" rel="noreferrer">
              {catalog.attribution.project}
            </a>{' '}
            ({catalog.attribution.license}) · {catalog.engine_version}
          </p>
        )}
      </div>
    </div>
  )
}

function Leaderboard({
  result,
  selected,
  busy,
  onDiagnose,
  onReuse,
  t,
}: {
  result: DeskResult
  selected: { index: number; symbol: string } | null
  busy: boolean
  onDiagnose: (row: DeskLeaderRow, symbol: string) => void
  onReuse: () => void
  t: Translate
}) {
  const okSymbols = result.symbols.filter((item) => item.status === 'ok')
  const [symbol, setSymbol] = useState(okSymbols[0]?.symbol ?? '')
  const hasOos = okSymbols.some((item) => item.out_of_sample_available)
  const staleLabels: Record<string, string> = {
    inputs_changed: t('之後行情已更新', 'Market data changed afterwards'),
    engine_changed: t('研究台方法已更新', 'The Research Desk method changed'),
  }
  return (
    <section className="desk-panel" aria-label={t('策略排行', 'Strategy leaderboard')}>
      <div className="page-title" style={{ marginBottom: 0 }}>
        <div>
          <h2>{t('策略排行', 'Strategy leaderboard')}</h2>
          <p className="desk-meta">
            {t('排名依據', 'Ranked by')} {t(...RANK_LABELS[result.rank_by])} ·{' '}
            {t('樣本內', 'in sample')} · {result.configs_tested} {t('組設定', 'configs')} ×{' '}
            {okSymbols.length} {t('檔', 'symbols')} · {t('最新完成交易日', 'Latest session')}{' '}
            {result.as_of}
            {result.run_id ? ` · ${t('紀錄', 'Run')} ${result.run_id.slice(0, 10)}` : ''}
          </p>
        </div>
        <button type="button" className="button" onClick={onReuse}>
          {t('載入這次的設定', 'Load these settings')}
        </button>
      </div>
      {result.current === false && (
        <p className="notice" role="status">
          {t('這是保存的結果：', 'Saved result: ')}
          {(result.stale_reasons || []).map((reason) => staleLabels[reason] || reason).join('、')}
        </p>
      )}
      <p className="desk-meta">
        {t('買入持有平均報酬：樣本內', 'Mean buy-and-hold return: in sample')}{' '}
        {deskPercent(result.benchmark_summary.in_sample)}
        {hasOos
          ? ` · ${t('樣本外', 'out of sample')} ${deskPercent(result.benchmark_summary.out_of_sample)}`
          : ''}{' '}
        · {t('完整期間', 'full period')} {deskPercent(result.benchmark_summary.full)}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                '#',
                t('策略', 'Strategy'),
                t('樣本內超額', 'In-sample excess'),
                t('勝過基準', 'Beats benchmark'),
                t('樣本外超額', 'Out-of-sample excess'),
                t('樣本外勝過', 'Beats (OOS)'),
                t('交易筆數', 'Trades'),
                t('勝率', 'Win rate'),
                t('獲利因子', 'Profit factor'),
                t('平均最大回撤', 'Mean max drawdown'),
                t('提醒', 'Flags'),
                t('診斷', 'Diagnose'),
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.leaderboard.map((row) => {
              const is = row.in_sample
              const oos = row.out_of_sample
              return (
                <tr
                  key={row.config_index}
                  className={selected?.index === row.config_index ? 'is-selected' : ''}
                >
                  <td>{row.rank}</td>
                  <th scope="row">{t(row.label, row.label_en)}</th>
                  <td className={signed(is?.mean_excess_return_pct)}>
                    {deskPercent(is?.mean_excess_return_pct)}
                  </td>
                  <td>{is ? `${is.beats_benchmark}/${is.symbols}` : '—'}</td>
                  <td className={signed(oos?.mean_excess_return_pct)}>
                    {deskPercent(oos?.mean_excess_return_pct)}
                  </td>
                  <td>{oos ? `${oos.beats_benchmark}/${oos.symbols}` : '—'}</td>
                  <td>{is?.pooled_closed_trades ?? '—'}</td>
                  <td>
                    {is?.pooled_win_rate_pct == null ? '—' : `${num(is.pooled_win_rate_pct, 1)}%`}
                  </td>
                  <td>{deskRatio(is?.pooled_profit_factor)}</td>
                  <td>{deskPercent(is?.mean_max_drawdown_pct)}</td>
                  <td>
                    <span className="desk-flags">
                      {row.flags.map((flag) => (
                        <span
                          key={flag}
                          className={`desk-flag${flag === 'benchmark_strategy' ? '' : ' is-warning'}`}
                        >
                          {t(...FLAG_LABELS[flag])}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !symbol}
                      onClick={() => onDiagnose(row, symbol)}
                      aria-label={t(
                        `診斷 ${row.label}（${symbol}）`,
                        `Diagnose ${row.label_en} (${symbol})`,
                      )}
                    >
                      {t('為什麼？', 'Why?')}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="desk-add" style={{ marginTop: 16 }}>
        <label>
          {t('診斷的代碼', 'Symbol to diagnose')}
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {okSymbols.map((item) => (
              <option key={item.symbol} value={item.symbol}>
                {item.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details>
        <summary>{t('各代碼的測試期間與狀態', 'Test windows and status by symbol')}</summary>
        <ul className="desk-hypotheses">
          {result.symbols.map((item) => (
            <li key={item.symbol}>
              <strong>{item.symbol}</strong>{' '}
              {item.status === 'ok' && item.windows
                ? `${item.windows.full.start} → ${item.windows.full.end} (${item.windows.full.sessions} ${t('日', 'sessions')})${
                    item.windows.out_of_sample
                      ? ` · ${t('樣本外自', 'out of sample from')} ${item.windows.out_of_sample.start}`
                      : ` · ${item.out_of_sample_reason || t('未保留樣本外', 'no out-of-sample part')}`
                  }${item.history_stale ? ` · ${t('日線未到最新交易日', 'history ends before the latest session')}` : ''}`
                : `${t('無法測試', 'Unavailable')}: ${item.error?.message ?? ''}`}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>{t('提醒與方法', 'Warnings and method')}</summary>
        <ul className="desk-hypotheses">
          {result.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
        <p className="desk-meta">{result.method}</p>
      </details>
    </section>
  )
}
