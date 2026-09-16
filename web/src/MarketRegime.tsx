import { useEffect, useRef, useState } from 'react'
import { Launch, Renew } from '@carbon/icons-react'
import type { Locale } from './locale'
import { api, num } from './ui'
import {
  BENCHMARKS,
  DEFAULT_REGIME_SETTINGS,
  FACTOR_IDS,
  MANUAL_KEYS,
  MANUAL_RANGES,
  MANUAL_SOURCES,
  REGIME_VERSION,
  ZONE_BANDS,
  cloneRegimeSettings,
  isoDate,
  readRegimeSettings,
  saveRegimeSettings,
  validRegimeSettings,
  type Benchmark,
  type FactorId,
  type ManualKey,
  type RegimeFactor,
  type RegimeResult,
  type RegimeSettings,
  type RegimeZone,
} from './market-regime'
import './regime.css'

type Draft = {
  benchmark: Benchmark
  weights: Record<FactorId, string>
  inputs: Record<ManualKey, { value: string; as_of: string }>
}
function toDraft(settings: RegimeSettings): Draft {
  return {
    benchmark: settings.benchmark,
    weights: Object.fromEntries(
      FACTOR_IDS.map((id) => [id, String(settings.weights[id])]),
    ) as Draft['weights'],
    inputs: Object.fromEntries(
      MANUAL_KEYS.map((key) => {
        const reading = settings.inputs[key]
        return [key, { value: reading ? String(reading.value) : '', as_of: reading?.as_of || '' }]
      }),
    ) as Draft['inputs'],
  }
}
/** Returns settings or the first invalid field name; blanks mean "not entered". */
export function fromDraft(draft: Draft): RegimeSettings | { invalid: string } {
  const settings = cloneRegimeSettings(DEFAULT_REGIME_SETTINGS)
  settings.benchmark = draft.benchmark
  for (const id of FACTOR_IDS) {
    const weight = Number(draft.weights[id])
    if (draft.weights[id].trim() === '' || !Number.isFinite(weight) || weight < 0 || weight > 100)
      return { invalid: `weight:${id}` }
    settings.weights[id] = weight
  }
  if (FACTOR_IDS.reduce((sum, id) => sum + settings.weights[id], 0) <= 0)
    return { invalid: 'weight:total' }
  for (const key of MANUAL_KEYS) {
    const { value, as_of } = draft.inputs[key]
    if (value.trim() === '') {
      settings.inputs[key] = null
      continue
    }
    const parsed = Number(value)
    const [min, max] = MANUAL_RANGES[key]
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return { invalid: key }
    if (as_of.trim() !== '' && !isoDate(as_of.trim())) return { invalid: `${key}:as_of` }
    settings.inputs[key] = { value: parsed, as_of: as_of.trim() || null }
  }
  return validRegimeSettings(settings) ? settings : { invalid: 'settings' }
}

export function MarketRegime({
  locale,
  revision,
  expectedSession,
}: {
  locale: Locale
  revision?: string
  expectedSession?: string
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [settings, setSettings] = useState<RegimeSettings>(readRegimeSettings)
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const [invalid, setInvalid] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; data: RegimeResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const key = JSON.stringify([settings, revision, expectedSession, attempt])
  const current = result?.key === key ? result.data : null
  useEffect(() => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setBusy(true)
    setError('')
    api<RegimeResult>('/api/market/regime', {
      method: 'POST',
      signal: request.signal,
      body: JSON.stringify({
        weights: settings.weights,
        inputs: settings.inputs,
        benchmark: settings.benchmark,
      }),
    })
      .then((response) => {
        if (!request.signal.aborted) setResult({ key, data: response })
      })
      .catch((err: Error) => {
        if (!request.signal.aborted) setError(err.message)
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false)
      })
    return () => request.abort()
    // The key already encodes every input that should trigger a recalculation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const factorName: Record<FactorId, string> = {
    buffett: t('巴菲特指標', 'Buffett indicator'),
    shiller: t('席勒本益比 CAPE', 'Shiller CAPE'),
    yield_curve: t('10 年減 2 年公債利差', '10Y–2Y Treasury spread'),
    technical: t(
      `${settings.benchmark} 200 日均線乖離`,
      `${settings.benchmark} 200-day MA deviation`,
    ),
    sentiment: t('恐懼與貪婪指數', 'Fear & Greed index'),
  }
  const zoneName: Record<RegimeZone, string> = {
    calm: t('低風險區', 'Calm'),
    watch: t('中性觀察', 'Watch'),
    elevated: t('風險累積', 'Elevated'),
    extreme: t('極高風險', 'Extreme'),
  }
  const zoneNote: Record<RegimeZone, string> = {
    calm: t(
      '綜合分數低於 40。歷史上這個區間多屬正常波動，仍應核對各項輸入的日期。',
      'Composite below 40. Historically ordinary volatility; still check the date of each reading.',
    ),
    watch: t(
      '綜合分數 40–60。估值或技術面至少一項偏高；2007 年 10 月的參考值落在這一區。',
      'Composite 40–60. At least one valuation or technical factor is elevated; the October 2007 reference sits here.',
    ),
    elevated: t(
      '綜合分數 60–80。多個因子同時偏高，接近 2022 年 1 月與 2000 年 3 月的參考值。',
      'Composite 60–80. Several factors are elevated at once, near the January 2022 and March 2000 references.',
    ),
    extreme: t(
      '綜合分數 80 以上，高於三個歷史參考情境。分數描述規則共識，不預測時點。',
      'Composite 80 or above, beyond all three historical references. The score describes rule agreement, not timing.',
    ),
  }
  const yieldStatus: Record<string, string> = {
    deep_inversion: t('深度倒掛', 'Deep inversion'),
    inversion: t('輕度倒掛', 'Inversion'),
    reinversion: t('解掛／平坦', 'Re-steepening / flat'),
    normal: t('正常', 'Normal'),
  }
  function reasonText(factor: RegimeFactor, data: RegimeResult) {
    const benchmark = data.benchmark
    switch (factor.reason) {
      case 'missing_input': {
        const missing = (factor.detail as { missing?: string[] } | null)?.missing
        return factor.id === 'yield_curve' && missing?.length
          ? t(`尚未輸入 ${missing.join('、')}`, `Missing ${missing.join(', ')}`)
          : t('尚未輸入', 'Not entered')
      }
      case 'no_history':
        return t(
          `本機沒有 ${benchmark.symbol} 日線。在「我的持股」以零股加入觀察並更新行情後即可計算。`,
          `No local ${benchmark.symbol} history. Add it as a zero-share watch entry under My Portfolio and refresh data.`,
        )
      case 'stale_history':
        return t(
          `${benchmark.symbol} 日線停留在 ${benchmark.last_date}，不是 ${data.as_of}；請更新行情。`,
          `${benchmark.symbol} history ends ${benchmark.last_date}, not ${data.as_of}; refresh data.`,
        )
      case 'data_error':
        return t(
          `${benchmark.symbol} 日線未通過品質檢查，不計算乖離。`,
          `${benchmark.symbol} history failed quality checks; deviation withheld.`,
        )
      case 'insufficient_history':
        return t(
          `${benchmark.symbol} 不足 200 個有效交易日（目前 ${benchmark.bars}）。`,
          `${benchmark.symbol} has fewer than 200 valid sessions (currently ${benchmark.bars}).`,
        )
      case 'invalid_values':
        return t('乖離無法計算為有限數值。', 'Deviation is not a finite value.')
      default:
        return factor.reason || ''
    }
  }
  function valueText(factor: RegimeFactor) {
    if (factor.value == null) return '—'
    switch (factor.id) {
      case 'buffett':
      case 'technical':
        return `${num(factor.value, 1)}%`
      case 'yield_curve':
        return `${factor.value > 0 ? '+' : ''}${num(factor.value, 2)} pp`
      case 'shiller':
        return num(factor.value, 1)
      default:
        return num(factor.value, 0)
    }
  }
  const manualLabel: Record<ManualKey, string> = {
    buffett_ratio: t('美股總市值 ÷ GDP（%）', 'Total market cap ÷ GDP (%)'),
    shiller_pe: t('Shiller CAPE', 'Shiller CAPE'),
    yield_10y: t('10 年期公債殖利率（%）', '10-year Treasury yield (%)'),
    yield_2y: t('2 年期公債殖利率（%）', '2-year Treasury yield (%)'),
    fear_greed: t('恐懼與貪婪指數（0–100）', 'Fear & Greed index (0–100)'),
  }
  const scenarioLabel: Record<string, string> = {
    '2000-03': t('2000 年 3 月 · 網路泡沫頂部', 'March 2000 · dot-com top'),
    '2007-10': t('2007 年 10 月 · 金融海嘯前', 'October 2007 · pre-crisis'),
    '2022-01': t('2022 年 1 月 · 升息熊市頂部', 'January 2022 · rate-hike top'),
  }
  const invalidText = invalid
    ? invalid === 'weight:total'
      ? t('因子權重合計須大於零。', 'Factor weights must add up to more than zero.')
      : invalid.startsWith('weight:')
        ? t('權重須介於 0 與 100。', 'Weights must be between 0 and 100.')
        : invalid.endsWith(':as_of')
          ? t('日期格式須為 YYYY-MM-DD。', 'Dates must use YYYY-MM-DD.')
          : t('輸入值超出允許範圍。', 'A reading is outside its allowed range.')
    : ''
  const weightTotal = FACTOR_IDS.reduce((sum, id) => sum + (Number(draft.weights[id]) || 0), 0)
  function apply() {
    const parsed = fromDraft(draft)
    if ('invalid' in parsed) {
      setInvalid(parsed.invalid)
      return
    }
    setInvalid('')
    saveRegimeSettings(parsed)
    setSettings(parsed)
  }
  const score = current?.score ?? null
  const zone = current?.zone ?? null

  return (
    <section className="regime" aria-label={t('市場風險溫度計', 'Market risk temperature')}>
      <div className="section-heading">
        <div>
          <div className="eyebrow">MARKET REGIME</div>
          <h2>{t('市場風險溫度計', 'Market Risk Temperature')}</h2>
          <p>
            {t(
              '五個宏觀、估值、利率、技術與情緒因子的加權崩盤風險分數，為 Alpha 候選提供市場背景。',
              'A weighted crash-risk score from five macro, valuation, rates, technical and sentiment factors, giving market context for Alpha candidates.',
            )}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <Renew size={14} />
            {busy ? t('計算中…', 'Calculating…') : t('重新計算', 'Recalculate')}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {!current && !error && (
        <p className="footnote" aria-live="polite">
          {busy ? t('讀取市場風險分數…', 'Loading market risk score…') : ''}
        </p>
      )}
      {current && (
        <>
          <div className="regime-summary">
            <div className="regime-score" data-zone={zone || 'none'}>
              <p>
                {t('綜合崩盤風險分數', 'Composite crash-risk score')} · {current.as_of}
              </p>
              <h3>
                {score == null ? '—' : num(score, 1)}
                <small>/ 100</small>
              </h3>
              {zone ? (
                <span className="regime-zone">{zoneName[zone]}</span>
              ) : (
                <span className="regime-zone regime-missing">
                  {t('不完整：缺', 'Incomplete: missing')}{' '}
                  {current.missing.map((id) => factorName[id]).join(t('、', ', '))}
                </span>
              )}
              {current.stale_inputs.length > 0 && (
                <p className="regime-stale">
                  {t('輸入日期偏舊：', 'Readings past their refresh window: ')}
                  {current.stale_inputs.map((id) => factorName[id]).join(t('、', ', '))}
                </p>
              )}
            </div>
            <div>
              <div
                className="regime-track"
                role="img"
                aria-label={
                  score == null
                    ? t('分數不可用', 'Score unavailable')
                    : t(
                        `分數 ${num(score, 1)}，${zoneName[zone!]}`,
                        `Score ${num(score, 1)}, ${zoneName[zone!]}`,
                      )
                }
              >
                {ZONE_BANDS.map((band) => (
                  <span
                    key={band.zone}
                    data-zone={band.zone}
                    style={{ flexBasis: `${band.to - band.from}%` }}
                  />
                ))}
                {score != null && <i style={{ left: `${Math.min(100, Math.max(0, score))}%` }} />}
              </div>
              <div className="regime-scale">
                <span>0</span>
                <span>40</span>
                <span>60</span>
                <span>80</span>
                <span>100</span>
              </div>
              <p className="regime-explain">
                {zone
                  ? zoneNote[zone]
                  : t(
                      '所有啟用因子都需要有效輸入才會計算綜合分數；缺資料不會把權重挪給其他因子。可在下方輸入數值，或把該因子的權重設為 0。',
                      'Every enabled factor needs a valid reading before the composite is calculated; missing data never shifts weight to other factors. Enter the readings below or set that factor weight to 0.',
                    )}
              </p>
            </div>
          </div>
          <div className="regime-factors">
            {current.factors.map((factor) => (
              <div key={factor.id} data-factor={factor.id}>
                <p>
                  {factorName[factor.id]} · {num(factor.weight_pct, 0)}%
                </p>
                <h4>
                  {valueText(factor)}
                  {factor.status && <small>{yieldStatus[factor.status] || factor.status}</small>}
                </h4>
                {factor.available ? (
                  <>
                    <small className="regime-risk">
                      {t('因子風險', 'Factor risk')} {factor.risk}
                      {!factor.enabled && ` · ${t('權重 0，不計入', 'weight 0, excluded')}`}
                    </small>
                    <small className={factor.stale ? 'regime-stale' : undefined}>
                      {factor.as_of
                        ? `${t('資料日', 'As of')} ${factor.as_of}${
                            factor.age_days != null && factor.age_days > 0
                              ? ` · ${factor.age_days} ${t('天前', 'days ago')}`
                              : ''
                          }`
                        : t('未填日期', 'No date entered')}
                      {factor.stale && ` · ${t('建議更新', 'refresh suggested')}`}
                    </small>
                  </>
                ) : (
                  <small className={factor.enabled ? 'regime-missing' : undefined}>
                    {reasonText(factor, current)}
                  </small>
                )}
              </div>
            ))}
          </div>
          <details className="regime-inputs">
            <summary>{t('輸入宏觀讀數與權重', 'Enter macro readings and weights')}</summary>
            <fieldset>
              <legend>
                {t(
                  '手動讀數：這些序列沒有本機行情來源，請自行查閱並填入日期；留白表示尚未輸入。',
                  'Manual readings: these series have no local data source. Look them up, enter the date, and leave blank if not entered.',
                )}
              </legend>
              <div className="regime-grid">
                {MANUAL_KEYS.map((key) => (
                  <label key={key}>
                    {manualLabel[key]}
                    <input
                      type="number"
                      aria-label={manualLabel[key]}
                      step="any"
                      min={MANUAL_RANGES[key][0]}
                      max={MANUAL_RANGES[key][1]}
                      value={draft.inputs[key].value}
                      aria-invalid={invalid === key || undefined}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputs: {
                            ...draft.inputs,
                            [key]: { ...draft.inputs[key], value: event.target.value },
                          },
                        })
                      }
                    />
                    <input
                      type="date"
                      aria-label={t(
                        `${manualLabel[key]} 資料日期`,
                        `${manualLabel[key]} as-of date`,
                      )}
                      value={draft.inputs[key].as_of}
                      aria-invalid={invalid === `${key}:as_of` || undefined}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputs: {
                            ...draft.inputs,
                            [key]: { ...draft.inputs[key], as_of: event.target.value },
                          },
                        })
                      }
                    />
                    <span className="regime-links">
                      {MANUAL_SOURCES[key].map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.label} <Launch size={12} />
                        </a>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>
                {t(
                  '因子權重：以合計正規化；設為 0 即停用該因子。',
                  'Factor weights are normalized by their total; 0 disables a factor.',
                )}
              </legend>
              <div className="regime-grid">
                {FACTOR_IDS.map((id) => (
                  <label key={id}>
                    {factorName[id]}
                    <input
                      type="number"
                      aria-label={factorName[id]}
                      min={0}
                      max={100}
                      step={1}
                      value={draft.weights[id]}
                      aria-invalid={invalid === `weight:${id}` || undefined}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          weights: { ...draft.weights, [id]: event.target.value },
                        })
                      }
                    />
                    <small>
                      {weightTotal > 0
                        ? `${num(((Number(draft.weights[id]) || 0) / weightTotal) * 100, 1)}% ${t('正規化', 'normalized')}`
                        : t('合計為 0', 'total is 0')}
                    </small>
                  </label>
                ))}
                <label>
                  {t('技術因子基準', 'Technical benchmark')}
                  <select
                    value={draft.benchmark}
                    onChange={(event) =>
                      setDraft({ ...draft, benchmark: event.target.value as Benchmark })
                    }
                  >
                    {BENCHMARKS.map((symbol) => (
                      <option key={symbol} value={symbol}>
                        {symbol}
                      </option>
                    ))}
                  </select>
                  <small>
                    {t(
                      '使用本機日線的調整收盤價與 200 日均線。',
                      'Uses the local adjusted close and 200-day average.',
                    )}
                  </small>
                </label>
              </div>
            </fieldset>
            <div className="regime-form-actions">
              <button type="button" className="button primary" onClick={apply} disabled={busy}>
                {t('套用並重新計算', 'Apply and recalculate')}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setInvalid('')
                  setDraft(toDraft(settings))
                }}
              >
                {t('還原目前設定', 'Reset to saved settings')}
              </button>
              {invalidText && (
                <span role="alert" className="notice">
                  {invalidText}
                </span>
              )}
            </div>
          </details>
          <div className="regime-scenarios">
            <div className="section-heading">
              <div>
                <h3>{t('歷史壓力測試', 'Historical stress test')}</h3>
                <p>
                  {t(
                    '以目前權重重算三個歷史崩盤前夕的參考讀數；讀數是上游專案整理的近似值，不是逐日驗證的資料集。',
                    'The three pre-crash reference readings rescored with your current weights. Readings are approximate values from the upstream project, not a verified daily dataset.',
                  )}
                </p>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{t('情境', 'Scenario')}</th>
                  <th>{t('分數條', 'Score bar')}</th>
                  <th className="number">{t('分數', 'Score')}</th>
                  <th>{t('區間', 'Zone')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="current">
                  <td>{t('目前', 'Now')}</td>
                  <td>
                    <div className="regime-bar" data-zone={zone || 'none'}>
                      <span style={{ width: `${score == null ? 0 : Math.min(100, score)}%` }} />
                    </div>
                  </td>
                  <td className="number">{score == null ? '—' : num(score, 1)}</td>
                  <td>{zone ? zoneName[zone] : t('不完整', 'Incomplete')}</td>
                </tr>
                {current.scenarios.map((scenario) => (
                  <tr key={scenario.id}>
                    <td>{scenarioLabel[scenario.id] || scenario.period}</td>
                    <td>
                      <div className="regime-bar" data-zone={scenario.zone}>
                        <span style={{ width: `${Math.min(100, scenario.score)}%` }} />
                      </div>
                    </td>
                    <td className="number">{num(scenario.score, 1)}</td>
                    <td>{zoneName[scenario.zone]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="alpha-method">
            <summary>{t('計算方式與限制', 'Method and limitations')}</summary>
            <p>
              {t(
                `每個因子依固定門檻對應 0–100 的風險值：巴菲特指標 >200／180／150／120% 為 100／90／75／50，其餘 25；CAPE >40／35／30／25 為 100／90／70／50，其餘 20；10Y−2Y 利差 <−0.5 為 80、<0 為 60、0 至 0.5 的解掛平坦期為 70、其餘 30；均線乖離 >25／20／15／5% 為 100／85／65／40，低於 −10% 為 10，其餘 20；恐懼與貪婪 >80 為 100、>60 為 70、<20 為 0、其餘 40。綜合分數 = Σ（因子風險 × 權重）÷ 權重合計。方法版本 ${REGIME_VERSION}；門檻沿用開源專案 US_Stock_Crash_Monitor。`,
                `Each factor maps to a 0–100 risk through fixed thresholds: Buffett indicator >200/180/150/120% gives 100/90/75/50, otherwise 25; CAPE >40/35/30/25 gives 100/90/70/50, otherwise 20; the 10Y−2Y spread scores 80 below −0.5, 60 below 0, 70 in the 0–0.5 re-steepening band, otherwise 30; MA deviation >25/20/15/5% gives 100/85/65/40, below −10% gives 10, otherwise 20; Fear & Greed >80 gives 100, >60 gives 70, <20 gives 0, otherwise 40. Composite = Σ(factor risk × weight) ÷ total weight. Method version ${REGIME_VERSION}; thresholds follow the open-source US_Stock_Crash_Monitor project.`,
              )}
            </p>
            <p>
              {t(
                '這不是崩盤預測，也不是操作指示。線性加權無法描述非線性的連鎖反應；GDP 等季度資料有滯後；讀數與權重包含使用者判斷。宏觀讀數只存在此瀏覽器，不在工作區 ZIP 備份或 Alpha 研究備份中。均線乖離使用本機基準 ETF 的股息調整收盤價，缺日線時保持不可用，不以其他指數替代。',
                'This is not a crash forecast or an instruction to trade. Linear weighting cannot describe nonlinear chain reactions; quarterly series such as GDP lag; readings and weights include user judgment. Macro readings are stored only in this browser and are excluded from the workspace ZIP and Alpha research backups. The MA deviation uses the local benchmark ETF adjusted close and stays unavailable without local history; no substitute index is used.',
              )}
            </p>
          </details>
        </>
      )}
    </section>
  )
}
