import { useEffect, useRef, useState } from 'react'
import { Play, ArrowRight } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import type { AlphaSettings } from './alpha-model'
import { validAlphaSettings } from './alpha-model'
import { api, num } from './ui'
import { useSessionState } from './session-state'

type ReplayPick = {
  symbol: string
  name: string
  score: number
  matched: number
  coverage: number
  alpha: boolean
  rps: number | null
}
export type ReplayResult = {
  as_of: string
  engine_version: string
  universe_count: number
  timeline: {
    date: string
    available: boolean
    reason: string | null
    scan_id: number | null
    usable: number
    total: number
    alpha_count: number
    picks: ReplayPick[]
  }[]
  occurrences: {
    symbol: string
    count: number
    eligible_sessions: number
    streak: number
    current_alpha: boolean
    latest_score: number | null
    cells: (boolean | null)[]
  }[]
}
export function AlphaReplay({
  data,
  scope,
  settings,
  locale,
  onOpen,
  open = false,
}: {
  data: Overview
  scope: Scope
  settings: AlphaSettings
  locale: Locale
  open?: boolean
  onOpen: (symbol: string, scope: Scope, date: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [days, setDays] = useSessionState(
    'alphaview-replay-days-v1',
    () => 20,
    (v): v is number => typeof v === 'number' && [5, 10, 20, 60].includes(v),
  )
  const [result, setResult] = useState<{ key: string; data: ReplayResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [onlyCurrent, setOnlyCurrent] = useState(true)
  const [limit, setLimit] = useState(20)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const key = JSON.stringify([
    scope,
    days,
    settings.weights,
    settings.threshold,
    settings.minMatches,
    data.revision,
    data.summary.expected_session,
  ])
  const current = result?.key === key ? result.data : null
  const point = current?.timeline.find((item) => item.date === selected) || current?.timeline.at(-1)
  const occurrences =
    current?.occurrences.filter((item) => !onlyCurrent || item.current_alpha) || []
  const max = Math.max(1, ...(current?.timeline.map((item) => item.alpha_count) || []))
  const held = new Set(data.positions.filter((item) => item.shares > 0).map((item) => item.symbol))
  async function load() {
    if (!validAlphaSettings(settings)) return
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setBusy(true)
    setError('')
    try {
      const response = await api<ReplayResult>('/api/alpha/replay', {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({
          scope,
          days,
          weights: settings.weights,
          threshold: settings.threshold,
          min_matches: settings.minMatches,
        }),
      })
      if (request.signal.aborted) return
      setResult({ key, data: response })
      setSelected(response.timeline.at(-1)?.date || '')
      setLimit(20)
    } catch (err) {
      if (!request.signal.aborted) setError((err as Error).message)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  return (
    <details className="alpha-replay" open={open || undefined}>
      <summary>
        <span>{t('策略回放', 'Strategy Replay')}</span>
        <small>{t('看看 Alpha 是否持續出現', 'See whether Alpha signals persist')}</small>
      </summary>
      <div className="alpha-replay-body">
        <div className="section-heading">
          <div>
            <h2>{t('同一組權重，回看不同交易日', 'One Set of Weights, Across Sessions')}</h2>
            <p>
              {t(
                '從已儲存的每日選股重新整理歷史共識，不重新下載行情。',
                'Reconstruct historical rule agreement from stored daily scans, without downloading quotes.',
              )}
            </p>
          </div>
          <div className="actions">
            <select
              aria-label={t('回放交易日數', 'Replay sessions')}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[5, 10, 20, 60].map((value) => (
                <option key={value} value={value}>
                  {value} {t('交易日', 'sessions')}
                </option>
              ))}
            </select>
            <button
              className="button primary"
              disabled={busy || !validAlphaSettings(settings)}
              onClick={() => void load()}
            >
              <Play size={14} />
              {busy ? t('整理中…', 'Loading…') : t('載入回放', 'Load Replay')}
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {result && !current && (
          <p className="notice">
            {t(
              '範圍、權重或資料已變更，請重新載入回放。',
              'Scope, weights, or data changed. Load the replay again.',
            )}
          </p>
        )}
        {current && (
          <>
            <div
              className="alpha-replay-timeline"
              aria-label={t('每日 Alpha 數量', 'Daily Alpha counts')}
            >
              {current.timeline.map((item) => (
                <button
                  key={item.date}
                  className={point?.date === item.date ? 'selected' : ''}
                  title={`${item.date}: ${item.available ? item.alpha_count : t('資料待補', 'Unavailable')}`}
                  aria-label={`${item.date}: ${item.available ? item.alpha_count : t('資料待補', 'Unavailable')} Alpha`}
                  aria-pressed={point?.date === item.date}
                  onClick={() => setSelected(item.date)}
                >
                  <span
                    style={{
                      height: `${item.available ? Math.max(3, (item.alpha_count / max) * 70) : 3}px`,
                    }}
                    className={!item.available ? 'unavailable' : ''}
                  />
                  <small>{item.date.slice(5)}</small>
                </button>
              ))}
            </div>
            {point && (
              <div className="alpha-replay-day">
                <h3>
                  {point.date} ·{' '}
                  {point.available
                    ? `${point.alpha_count} Alpha Picks`
                    : t('快照無法使用', 'Snapshot Unavailable')}
                </h3>
                <p>
                  {point.available
                    ? t(
                        `有效研究資料 ${point.usable}/${point.total}；顯示前 30 名。`,
                        `Valid research rows ${point.usable}/${point.total}; showing the top 30.`,
                      )
                    : point.reason === 'stale_inputs'
                      ? t(
                          '輸入資料已更新，請重算每日選股。',
                          'Inputs changed. Recalculate Daily Screener.',
                        )
                      : point.reason === 'changed_universe'
                        ? t(
                            '歷史快照的股票池不同，請重新掃描。',
                            'The snapshot uses a different universe. Recalculate the scan.',
                          )
                        : t('此交易日尚無快照。', 'No snapshot exists for this session.')}
                </p>
                <div>
                  {point.picks.map((row) => (
                    <button
                      key={row.symbol}
                      className="text-button"
                      onClick={() => onOpen(row.symbol, scope, point.date)}
                    >
                      <b>{row.symbol}</b>
                      <span>{num(row.score, 0)}</span>
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="section-heading">
              <h3>{t('訊號持續度', 'Signal Persistence')}</h3>
              <label className="alpha-review-toggle">
                <input
                  type="checkbox"
                  checked={onlyCurrent}
                  onChange={(e) => {
                    setOnlyCurrent(e.target.checked)
                    setLimit(20)
                  }}
                />
                {t('只看最新交易日 Alpha', 'Only Latest-session Alpha')}
              </label>
            </div>
            <p className="footnote">
              {t(
                '依符合天數、持續天數、最新分數排序。綠色＝Alpha；空白＝未符合；斜線＝資料不足。持續出現不代表未來報酬較高。',
                'Sorted by Alpha sessions, current streak, then latest score. Green = Alpha; empty = no match; hatched = unavailable. Persistence does not imply higher future returns.',
              )}
            </p>
            <div className="alpha-persistence-scroll">
              <table className="alpha-persistence">
                <thead>
                  <tr>
                    <th>{t('標的', 'Symbol')}</th>
                    <th>{t('符合／有效', 'Matches / Valid')}</th>
                    <th>{t('持續', 'Streak')}</th>
                    {current.timeline.map((item) => (
                      <th key={item.date}>
                        <span>{item.date.slice(5)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {occurrences.slice(0, limit).map((item) => (
                    <tr key={item.symbol}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => onOpen(item.symbol, scope, current.as_of)}
                        >
                          {item.symbol}
                        </button>
                        {held.has(item.symbol) && (
                          <small className="alpha-relation held">{t('目前持有', 'Held Now')}</small>
                        )}
                      </td>
                      <td>
                        {item.count}/{item.eligible_sessions}
                      </td>
                      <td>{item.streak}</td>
                      {item.cells.map((cell, index) => (
                        <td key={current.timeline[index].date}>
                          <button
                            className={`alpha-persistence-cell ${cell === true ? 'match' : cell === null ? 'unavailable' : ''}`}
                            aria-label={`${item.symbol} ${current.timeline[index].date}: ${cell === true ? 'Alpha' : cell === null ? t('資料不足', 'Unavailable') : t('未符合', 'No Match')}`}
                            title={`${item.symbol} ${current.timeline[index].date}`}
                            onClick={() => setSelected(current.timeline[index].date)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!occurrences.length && (
              <p>
                {t(
                  '這個篩選下沒有曾符合 Alpha 的標的。',
                  'No symbols met Alpha criteria under this filter.',
                )}
              </p>
            )}
            {occurrences.length > limit && (
              <button className="button" onClick={() => setLimit(limit + 20)}>
                {t('顯示更多', 'Show More')} ({occurrences.length - limit})
              </button>
            )}
          </>
        )}
        <p className="footnote">
          {t(
            '回放使用目前股票池與目前快取的歷史資料。這不是當時市場全部標的，也不是報酬回測；下市股缺漏與歷史資料修訂可能影響結果。權重是套用於過去資料，不代表當時已做出這些選擇。',
            'Replay uses the current universe and currently cached history. It is neither a point-in-time market universe nor a return backtest; missing delisted stocks and data revisions can affect results. These weights are applied retrospectively, not presented as decisions actually made at the time.',
          )}
        </p>
      </div>
    </details>
  )
}
