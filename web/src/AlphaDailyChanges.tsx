import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Renew } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import type { AlphaSettings } from './alpha-model'
import type { ReplayResult } from './AlphaReplay'
import { api } from './ui'

export function dailyAlphaChanges(result: ReplayResult) {
  const latest = result.timeline.at(-1),
    previous = result.timeline.at(-2)
  if (!latest?.available || !previous?.available) return null
  const entered: string[] = [],
    continuing: string[] = [],
    exited: string[] = [],
    coverage: string[] = []
  for (const item of result.occurrences) {
    const now = item.cells.at(-1),
      before = item.cells.at(-2)
    if (now === true && before === false) entered.push(item.symbol)
    else if (now === true && before === true) continuing.push(item.symbol)
    else if (now === false && before === true) exited.push(item.symbol)
    else if ((now === true && before == null) || (now == null && before === true))
      coverage.push(item.symbol)
  }
  return { entered, continuing, exited, coverage, latest: latest.date, previous: previous.date }
}

export function AlphaDailyChanges({
  data,
  scope,
  settings,
  locale,
  ready,
  scanId,
  onOpen,
}: {
  data: Overview
  scope: Scope
  settings: AlphaSettings
  locale: Locale
  ready: boolean
  scanId: number | undefined
  onOpen: (symbol: string, scope: Scope, date: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [result, setResult] = useState<{ key: string; data: ReplayResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'entered' | 'continuing' | 'exited' | 'coverage'>('entered')
  const [limit, setLimit] = useState(12)
  const controller = useRef<AbortController | null>(null)
  const key = JSON.stringify([
    scope,
    settings.weights,
    settings.threshold,
    settings.minMatches,
    data.revision,
    scanId,
    data.summary.expected_session,
  ])
  const current = result?.key === key && ready ? result.data : null
  const changes = current ? dailyAlphaChanges(current) : null
  const held = new Set(
    data.positions.filter((position) => position.shares > 0).map((position) => position.symbol),
  )
  useEffect(() => () => controller.current?.abort(), [])
  async function load() {
    if (!ready) return
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
          days: 5,
          weights: settings.weights,
          threshold: settings.threshold,
          min_matches: settings.minMatches,
        }),
      })
      if (request.signal.aborted) return
      if (
        response.as_of !== data.summary.expected_session ||
        response.timeline.at(-1)?.scan_id !== scanId
      )
        throw new Error(
          t(
            '快照已變更，請更新頁面後再比較。',
            'The snapshot changed. Refresh the page before comparing.',
          ),
        )
      setResult({ key, data: response })
      setLimit(12)
    } catch (err) {
      if (!request.signal.aborted) setError((err as Error).message)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  const labels = {
    entered: t('新進 Alpha', 'New Alpha'),
    continuing: t('持續符合', 'Continuing'),
    exited: t('退出條件', 'Exited'),
    coverage: t('資料變化', 'Coverage Changes'),
  }
  return (
    <details className="alpha-daily-changes">
      <summary>
        {t('今天有哪些變化？', 'What Changed Today?')}
        <span>{t('與前一個交易日比較', 'Compare with the previous session')}</span>
      </summary>
      <div className="section-heading">
        <p className="footnote">
          {t(
            '用目前權重重新判讀相鄰兩個交易日，不需先保存每日快照。股票池與資料版本必須一致。',
            'Re-evaluate two adjacent sessions with current weights, without saving a daily snapshot first. Universe and data versions must match.',
          )}
        </p>
        <button
          type="button"
          className="button"
          disabled={!ready || busy}
          onClick={() => void load()}
        >
          <Renew size={15} />
          {busy ? t('正在比較…', 'Comparing…') : t('比較今日變化', 'Compare Daily Changes')}
        </button>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {!ready && (
        <p className="footnote">
          {t('先重算目前版本的選股結果。', 'Recalculate current screening results first.')}
        </p>
      )}
      {current && !changes && (
        <p className="notice">
          {t(
            '相鄰交易日缺少有效快照，無法判定新進或退出。請同步重算兩個股票池；資料不足不算策略退出。',
            'An adjacent session has no valid snapshot, so entries and exits cannot be determined. Recalculate both lists. Missing data is not a strategy exit.',
          )}
        </p>
      )}
      {changes && (
        <>
          <p className="footnote">
            {changes.previous} → {changes.latest} ·{' '}
            {t('同股票池、同權重', 'Same universe and weights')}
          </p>
          <div
            className="alpha-change-tabs"
            role="group"
            aria-label={t('每日 Alpha 變化類型', 'Daily Alpha change type')}
          >
            {(['entered', 'continuing', 'exited', 'coverage'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={tab === value}
                onClick={() => {
                  setTab(value)
                  setLimit(12)
                }}
              >
                <b>{changes[value].length}</b>
                {labels[value]}
              </button>
            ))}
          </div>
          <p className="footnote">
            {tab === 'entered'
              ? t(
                  '前一日資料完整但未符合，最新交易日符合 Alpha。',
                  'Fully evaluated but not Alpha on the prior session; Alpha on the latest session.',
                )
              : tab === 'continuing'
                ? t('相鄰兩個交易日都符合 Alpha。', 'Alpha on both adjacent sessions.')
                : tab === 'exited'
                  ? t(
                      '前一日為 Alpha，最新日資料完整但不再符合門檻；不是賣出指令。',
                      'Previously Alpha, now fully evaluated but below the criteria. This is not a sell instruction.',
                    )
                  : t(
                      'Alpha 出現或消失時，另一日缺少完整策略資料；不列入新進或退出。',
                      'Alpha appeared or disappeared while the other session lacked complete strategy data; excluded from entries and exits.',
                    )}
          </p>
          <div className="alpha-change-symbols">
            {changes[tab].slice(0, limit).map((symbol) => (
              <button
                type="button"
                className="button"
                key={symbol}
                onClick={() => onOpen(symbol, scope, changes.latest)}
              >
                {symbol}
                {held.has(symbol) && <small>{t('已持有', 'Held')}</small>}
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          {!changes[tab].length && (
            <p className="footnote">{t('目前沒有這類變化。', 'No changes in this category.')}</p>
          )}
          {changes[tab].length > limit && (
            <button type="button" className="text-button" onClick={() => setLimit(limit + 24)}>
              {t('顯示更多', 'Show More')}
            </button>
          )}
        </>
      )}
    </details>
  )
}
