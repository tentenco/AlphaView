import { useState } from 'react'
import { Save, Download } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { BasketResult } from './AlphaBasket'
import { STRATEGY_IDS } from './alpha-model'
import { money, num } from './ui'
import { useSessionState } from './session-state'

export const EXPERIMENT_KEY = 'alphaview-basket-experiments-v1'
export type SavedExperiment = {
  id: string
  name: string
  savedAt: string
  result: Pick<
    BasketResult,
    | 'start'
    | 'end'
    | 'settings'
    | 'engine_version'
    | 'input_revision'
    | 'return_pct'
    | 'benchmark_pct'
    | 'max_drawdown_pct'
    | 'total_cost'
    | 'sessions'
  >
}
export function readExperiments(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SavedExperiment[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(EXPERIMENT_KEY) || '[]')
    return Array.isArray(raw)
      ? raw
          .filter((item): item is SavedExperiment => {
            if (!item || typeof item !== 'object') return false
            const value = item as SavedExperiment
            const r = value.result
            return (
              typeof value.id === 'string' &&
              typeof value.name === 'string' &&
              value.name.length <= 60 &&
              typeof value.savedAt === 'string' &&
              !!r &&
              typeof r.start === 'string' &&
              typeof r.end === 'string' &&
              typeof r.engine_version === 'string' &&
              typeof r.input_revision === 'string' &&
              [r.return_pct, r.max_drawdown_pct, r.total_cost, r.sessions].every(
                (n) => typeof n === 'number' && Number.isFinite(n),
              ) &&
              (r.benchmark_pct === null ||
                (typeof r.benchmark_pct === 'number' && Number.isFinite(r.benchmark_pct))) &&
              !!r.settings &&
              typeof r.settings === 'object' &&
              ['market', 'portfolio'].includes(r.settings.scope) &&
              [10, 20, 40].includes(r.settings.days) &&
              [3, 5, 10].includes(r.settings.top) &&
              [1, 5, 10, 20].includes(r.settings.rebalance) &&
              Number.isFinite(r.settings.initial) &&
              r.settings.initial > 0 &&
              r.settings.initial <= 1e9 &&
              Number.isFinite(r.settings.fee_bps) &&
              r.settings.fee_bps >= 0 &&
              r.settings.fee_bps <= 100 &&
              !!r.settings.weights &&
              STRATEGY_IDS.every(
                (id) =>
                  Number.isFinite(r.settings.weights[id]) &&
                  r.settings.weights[id] >= 0 &&
                  r.settings.weights[id] <= 100,
              ) &&
              STRATEGY_IDS.reduce((sum, id) => sum + r.settings.weights[id], 0) > 0 &&
              Number.isFinite(r.settings.threshold) &&
              r.settings.threshold >= 1 &&
              r.settings.threshold <= 100 &&
              Number.isInteger(r.settings.min_matches) &&
              r.settings.min_matches >= 1 &&
              r.settings.min_matches <= 4
            )
          })
          .slice(-20)
      : []
  } catch {
    return []
  }
}
export function comparable(a: SavedExperiment['result'], b: SavedExperiment['result']) {
  return (
    a.input_revision === b.input_revision &&
    a.engine_version === b.engine_version &&
    a.start === b.start &&
    a.end === b.end &&
    ['scope', 'days', 'top', 'rebalance', 'initial', 'fee_bps'].every(
      (key) =>
        a.settings[key as keyof typeof a.settings] === b.settings[key as keyof typeof b.settings],
    )
  )
}
export function ExperimentNotebook({
  current,
  locale,
  onRestore,
}: {
  current: BasketResult | null
  locale: Locale
  onRestore: (settings: BasketResult['settings']) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [saved, setSaved] = useState(readExperiments)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [onlyComparable, setOnlyComparable] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [baselineId, setBaselineId] = useSessionState<string | null>(
    'alphaview-experiment-baseline-v1',
    () => null,
    (value): value is string | null =>
      value === null || (typeof value === 'string' && value.length <= 200),
  )
  const baseline = saved.find((item) => item.id === baselineId)
  const canCompare = Boolean(baseline && current && comparable(baseline.result, current))
  const rows = saved
    .filter((item) => !onlyComparable || !current || comparable(item.result, current))
    .reverse()
  function save() {
    if (!current) return
    const {
      start,
      end,
      settings,
      engine_version,
      input_revision,
      return_pct,
      benchmark_pct,
      max_drawdown_pct,
      total_cost,
      sessions,
    } = current
    const entry: SavedExperiment = {
      id: crypto.randomUUID(),
      name: name.trim() || t(`實驗 ${saved.length + 1}`, `Experiment ${saved.length + 1}`),
      savedAt: new Date().toISOString(),
      result: {
        start,
        end,
        settings,
        engine_version,
        input_revision,
        return_pct,
        benchmark_pct,
        max_drawdown_pct,
        total_cost,
        sessions,
      },
    }
    const next = [...saved, entry].slice(-20)
    try {
      localStorage.setItem(EXPERIMENT_KEY, JSON.stringify(next))
      setSaved(next)
      setName('')
      setMessage(t('實驗摘要已保存到此瀏覽器。', 'Experiment summary saved in this browser.'))
    } catch {
      setMessage(t('無法保存，請檢查瀏覽器儲存空間。', 'Unable to save; check browser storage.'))
    }
  }
  function exportComparisons() {
    const escape = (value: unknown) =>
      '"' +
      String(value ?? '')
        .replace(/^[=+@\-\t\r]/, "'$&")
        .replaceAll('"', '""') +
      '"'
    const data = [
      [
        'name',
        'saved_at',
        'scope',
        'start',
        'end',
        'sessions',
        'top',
        'rebalance',
        'initial_usd',
        'fee_bps',
        ...STRATEGY_IDS.map((id) => `${id}_weight`),
        'alpha_threshold',
        'min_matches',
        'return_pct',
        'benchmark_pct',
        'max_drawdown_pct',
        'total_cost_usd',
        'input_revision',
        'engine_version',
        'comparable_with_current',
        'current_return_minus_saved_pp',
        'current_drawdown_minus_saved_pp',
        'current_cost_minus_saved_usd',
      ],
      ...rows.map((item) => {
        const r = item.result,
          matches = Boolean(current && comparable(r, current))
        return [
          item.name,
          item.savedAt,
          r.settings.scope,
          r.start,
          r.end,
          r.sessions,
          r.settings.top,
          r.settings.rebalance,
          r.settings.initial,
          r.settings.fee_bps,
          ...STRATEGY_IDS.map((id) => r.settings.weights[id]),
          r.settings.threshold,
          r.settings.min_matches,
          r.return_pct,
          r.benchmark_pct,
          r.max_drawdown_pct,
          r.total_cost,
          r.input_revision,
          r.engine_version,
          current ? matches : null,
          matches ? current!.return_pct - r.return_pct : null,
          matches ? current!.max_drawdown_pct - r.max_drawdown_pct : null,
          matches ? current!.total_cost - r.total_cost : null,
        ]
      }),
    ]
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + data.map((row) => row.map(escape).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'alphaview-saved-experiment-comparisons.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(
      t(
        `已匯出目前篩選的 ${rows.length} 組摘要與可比較差值。`,
        `Exported ${rows.length} filtered summaries with comparable differences.`,
      ),
    )
  }
  function remove(id: string) {
    const next = saved.filter((item) => item.id !== id)
    try {
      localStorage.setItem(EXPERIMENT_KEY, JSON.stringify(next))
      setSaved(next)
    } catch {
      setMessage(t('無法刪除已存摘要。', 'Unable to remove the saved summary.'))
    }
  }
  return (
    <section className="alpha-experiments">
      <div className="section-heading">
        <div>
          <div className="eyebrow">EXPERIMENT NOTEBOOK</div>
          <h2>{t('保留你的研究比較', 'Keep Your Research Comparisons')}</h2>
          <p>
            {t(
              '保存不同權重的實驗摘要；條件與資料版本也一起記錄。',
              'Save summaries from different weights, together with their conditions and data version.',
            )}
          </p>
        </div>
      </div>
      <div className="alpha-experiment-save">
        <input
          aria-label={t('實驗名稱', 'Experiment name')}
          placeholder={t(
            '例如：均衡權重，每 5 日調整',
            'e.g. Balanced weights, rebalance every 5 sessions',
          )}
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="button" disabled={!current} onClick={save}>
          <Save size={15} />
          {t('保存本次實驗', 'Save This Experiment')}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      <label className="alpha-review-toggle">
        <input
          type="checkbox"
          disabled={!current}
          checked={onlyComparable}
          onChange={(e) => setOnlyComparable(e.target.checked)}
        />
        {t(
          '只顯示與本次相同資料、期間、持股數、成本與調整間隔的實驗',
          'Only the same data, dates, basket size, cost, and rebalance interval as this run',
        )}
      </label>
      <div className="actions">
        <button
          type="button"
          className="text-button"
          disabled={!rows.length}
          onClick={exportComparisons}
        >
          <Download size={15} />
          {t('匯出已存實驗比較 CSV', 'Export Saved Experiment Comparisons CSV')}
        </button>
      </div>
      {baseline && (
        <section className="alpha-experiment-baseline">
          <div className="section-heading">
            <h3>{t('本次與已存實驗的差異', 'Current Run vs Saved Experiment')}</h3>
            <button type="button" className="text-button" onClick={() => setBaselineId(null)}>
              {t('清除比較基準', 'Clear Comparison Baseline')}
            </button>
          </div>
          <p>
            {t('比較基準', 'Comparison baseline')}: <strong>{baseline.name}</strong> ·{' '}
            {baseline.result.start} → {baseline.result.end}
          </p>
          {canCompare && current ? (
            <>
              <div className="alpha-experiment-deltas">
                {[
                  [
                    t('報酬差值', 'Return Difference'),
                    current.return_pct - baseline.result.return_pct,
                    t('百分點', 'percentage points'),
                  ],
                  [
                    t('回撤差值', 'Drawdown Difference'),
                    current.max_drawdown_pct - baseline.result.max_drawdown_pct,
                    t('百分點', 'percentage points'),
                  ],
                  [
                    t('總成本差值', 'Total Cost Difference'),
                    current.total_cost - baseline.result.total_cost,
                    'USD',
                  ],
                ].map(([label, value, unit]) => (
                  <div key={String(label)}>
                    <small>{label}</small>
                    <strong>
                      {Number(value) > 0 ? '+' : ''}
                      {num(Number(value), 2)}
                    </strong>
                    <span>{unit}</span>
                  </div>
                ))}
              </div>
              <p className="footnote">
                {t(
                  '差值＝本次減去比較基準。回撤使用負值，正的回撤差值表示本次較淺；正的成本差值表示花費較多。這是相同期間的歷史觀察，不是未來優劣排名。',
                  'Differences equal current minus baseline. Drawdowns are negative, so a positive drawdown difference means a shallower drawdown; a positive cost difference means higher costs. These are same-period historical observations, not a ranking of future performance.',
                )}
              </p>
              <div className="alpha-table-scroll">
                <table className="alpha-persistence">
                  <thead>
                    <tr>
                      <th>{t('選股設定', 'Selection Settings')}</th>
                      <th>{t('比較基準', 'Baseline')}</th>
                      <th>{t('本次', 'Current')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STRATEGY_IDS.map((id) => {
                      const normalized = (weights: typeof current.settings.weights) =>
                        (weights[id] / STRATEGY_IDS.reduce((sum, key) => sum + weights[key], 0)) *
                        100
                      return (
                        <tr key={id}>
                          <td>
                            {id === 'turtle'
                              ? t('海龜突破', 'Turtle')
                              : id === 'trend'
                                ? t('均線趨勢', 'Trend')
                                : id === 'pullback'
                                  ? t('回檔觀察', 'Pullback')
                                  : t('相對強勢', 'Relative Strength')}
                          </td>
                          <td>{num(normalized(baseline.result.settings.weights), 1)}%</td>
                          <td>{num(normalized(current.settings.weights), 1)}%</td>
                        </tr>
                      )
                    })}
                    <tr>
                      <td>{t('Alpha 門檻', 'Alpha Threshold')}</td>
                      <td>{baseline.result.settings.threshold}</td>
                      <td>{current.settings.threshold}</td>
                    </tr>
                    <tr>
                      <td>{t('至少符合策略數', 'Minimum Matches')}</td>
                      <td>{baseline.result.settings.min_matches}</td>
                      <td>{current.settings.min_matches}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="notice">
              {!current
                ? t(
                    '請先執行本次實驗，才能比較差異。',
                    'Run the current experiment before comparing differences.',
                  )
                : t(
                    '資料版本、日期、模型版本或配置條件不同，暫不計算差異。可載入基準設定後，只調整選股權重與門檻，再重新執行。',
                    'Data version, dates, model, or allocation conditions differ, so differences are not calculated. Load the baseline settings, change only selection weights or thresholds, and rerun.',
                  )}
            </p>
          )}
        </section>
      )}
      <div className="alpha-persistence-scroll">
        <table className="alpha-persistence alpha-experiment-table">
          <thead>
            <tr>
              {[
                t('實驗', 'Experiment'),
                t('範圍／期間', 'Scope / Window'),
                t('組合報酬', 'Basket Return'),
                t('初始組合基準', 'Initial Basket'),
                t('回撤', 'Drawdown'),
                t('成本', 'Cost'),
                t('操作', 'Actions'),
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td>
                  <button
                    className="text-button"
                    onClick={() => setSelected(selected === item.id ? null : item.id)}
                    aria-expanded={selected === item.id}
                  >
                    {item.name}
                  </button>
                </td>
                <td>
                  {item.result.settings.scope === 'market'
                    ? t('市場', 'Market')
                    : t('個人', 'Personal')}{' '}
                  · {item.result.sessions} {t('日', 'sessions')}
                </td>
                <td>{num(item.result.return_pct, 2)}%</td>
                <td>{num(item.result.benchmark_pct, 2)}%</td>
                <td>{num(item.result.max_drawdown_pct, 2)}%</td>
                <td>{money(item.result.total_cost)}</td>
                <td>
                  <div className="actions">
                    <button
                      className="text-button"
                      onClick={() => {
                        onRestore(item.result.settings)
                        setMessage(
                          t(
                            '設定已載入實驗區；請重新執行取得目前資料的結果。',
                            'Settings loaded into the experiment. Run again for results on current data.',
                          ),
                        )
                      }}
                    >
                      {t('載入設定', 'Load Settings')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-pressed={baselineId === item.id}
                      onClick={() => setBaselineId(item.id)}
                    >
                      {t('設為差異基準', 'Use as Comparison Baseline')}
                    </button>
                    <button className="text-button" onClick={() => remove(item.id)}>
                      {t('刪除', 'Delete')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p>{t('尚無符合條件的已存實驗。', 'No saved experiments match these conditions.')}</p>
      )}
      {saved
        .filter((item) => item.id === selected)
        .map((item) => (
          <div className="alpha-experiment-detail" key={item.id}>
            <strong>{item.name}</strong>
            <p>
              {item.result.start} → {item.result.end} · {t('前', 'Top')} {item.result.settings.top}{' '}
              · {t('間隔', 'Interval')} {item.result.settings.rebalance} ·{' '}
              {item.result.settings.fee_bps} bps · {money(item.result.settings.initial)}
            </p>
            <p>
              {STRATEGY_IDS.map((id) => `${id}: ${item.result.settings.weights[id]}`).join(' · ')} ·
              Alpha ≥ {item.result.settings.threshold} · {item.result.settings.min_matches}{' '}
              {t('項策略', 'matches')}
            </p>
            <small>
              {item.savedAt} · {item.result.engine_version}
            </small>
          </div>
        ))}
      <p className="footnote">
        {t(
          '最多保留 20 筆摘要，完整逐日資料請用「匯出完整實驗」。載入設定不會自動執行，也不改寫首頁權重。不同期間與股票池的結果不宜直接當作權重優劣排名。',
          'Keeps up to 20 summaries; use Export Full Experiment for complete daily data. Loading settings neither runs the model nor changes homepage weights. Results from different dates or universes should not be ranked as evidence that one weighting scheme is better.',
        )}
      </p>
    </section>
  )
}
