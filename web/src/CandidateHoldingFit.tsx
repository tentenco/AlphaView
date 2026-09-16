import { useEffect, useRef, useState } from 'react'
import { Close, Download } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview } from './types'
import { api, num } from './ui'
type FitPair = {
  holding: string
  weight_pct: number | null
  correlation: number | null
  observations: number
  start: string | null
  end: string | null
  reason: string | null
}
type FitResult = {
  engine_version: string
  input_revision: string
  as_of: string
  window: number
  min_observations: number
  holding_count: number
  valuation_complete: boolean
  candidates: {
    symbol: string
    already_held: boolean
    current: boolean
    return_count: number
    pairs: FitPair[]
  }[]
  method: string
}

export function CandidateHoldingFit({
  symbols,
  data,
  locale,
  onClose,
  onOpen,
}: {
  symbols: string[]
  data: Overview
  locale: Locale
  onClose: () => void
  onOpen: (symbol: string) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [windowSize, setWindowSize] = useState(60)
  const [result, setResult] = useState<{ key: string; data: FitResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const key = JSON.stringify([symbols, windowSize, data.revision, data.summary.expected_session])
  const current = result?.key === key ? result.data : null
  useEffect(() => () => controller.current?.abort(), [])
  async function load() {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setBusy(true)
    setError('')
    try {
      const response = await api<FitResult>('/api/alpha/holding-fit', {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({ symbols, window: windowSize }),
      })
      if (request.signal.aborted) return
      if (
        response.as_of !== data.summary.expected_session ||
        response.window !== windowSize ||
        response.candidates.length !== symbols.length ||
        response.candidates.some((candidate) => !symbols.includes(candidate.symbol))
      )
        throw new Error(
          t(
            '比較結果的日期或候選已變更，請更新頁面後重試。',
            'The result date or candidates changed. Refresh the page and retry.',
          ),
        )
      setResult({ key, data: response })
    } catch (err) {
      if (!request.signal.aborted) setError((err as Error).message)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  function exportCsv() {
    if (!current) return
    const escape = (value: unknown) =>
      '"' +
      String(value ?? '')
        .replace(/^[=+@\-\t\r]/, "'$&")
        .replaceAll('"', '""') +
      '"'
    const rows = [
      [
        'candidate',
        'holding',
        'holding_weight_pct',
        'correlation',
        'shared_returns',
        'start',
        'end',
        'reason',
        'as_of',
        'window',
        'input_revision',
        'engine_version',
      ],
      ...current.candidates.flatMap((candidate) =>
        candidate.pairs.map((pair) => [
          candidate.symbol,
          pair.holding,
          pair.weight_pct,
          pair.correlation,
          pair.observations,
          pair.start,
          pair.end,
          pair.reason,
          current.as_of,
          current.window,
          current.input_revision,
          current.engine_version,
        ]),
      ),
    ]
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + rows.map((row) => row.map(escape).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `alphaview-holding-comparison-${current.as_of}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const reason = (value: string | null) =>
    value === 'current_quote_unavailable'
      ? t('當期報價無效或缺少', 'Current quote missing or invalid')
      : value === 'constant_returns'
        ? t('日報酬無變動，無法定義相關性', 'Constant returns; correlation undefined')
        : value === 'invalid_returns'
          ? t('日報酬無效', 'Invalid returns')
          : t('共同有效日報酬不足 40 筆', 'Fewer than 40 shared valid daily returns')
  return (
    <section className="alpha-holding-fit">
      <div className="section-heading">
        <div>
          <div className="eyebrow">CANDIDATES × HOLDINGS</div>
          <h2>{t('和現有持倉有多相似？', 'How Similar to Your Holdings?')}</h2>
          <p>
            {symbols.join(' · ')} ·{' '}
            {t(
              '比較歷史日報酬，不修改持股',
              'Compare historical daily returns without changing holdings',
            )}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('關閉持倉走勢比較', 'Close holding comparison')}
          onClick={onClose}
        >
          <Close size={18} />
        </button>
      </div>
      <p className="footnote">
        {t(
          '相關性接近 +1 表示觀察期間的日報酬較同向，接近 −1 表示較反向；不代表未來風險或分散效果保證。每一對使用各自共同日期，不能直接當成完整共變異數矩陣。',
          'Correlation near +1 indicates more aligned daily returns in the observed sample; near −1 indicates opposing returns. It does not predict future risk or guarantee diversification. Pairs use their own shared dates and do not form a complete covariance matrix.',
        )}
      </p>
      <div className="actions">
        <select
          aria-label={t('持倉走勢比較期間', 'Holding comparison window')}
          value={windowSize}
          disabled={busy}
          onChange={(event) => setWindowSize(Number(event.target.value))}
        >
          <option value={60}>60 {t('交易日', 'sessions')}</option>
          <option value={120}>120 {t('交易日', 'sessions')}</option>
        </select>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? t('正在分析…', 'Analyzing…')
            : t('分析與持倉的相關性', 'Analyze Holding Correlations')}
        </button>
        {current && (
          <button type="button" className="text-button" onClick={exportCsv}>
            <Download size={15} />
            {t('匯出比較', 'Export Comparison')}
          </button>
        )}
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {current && (
        <>
          <p className="footnote">
            {current.as_of} · {current.holding_count} {t('檔實際持倉', 'actual holdings')} ·{' '}
            {t('每對至少', 'At least')} {current.min_observations}{' '}
            {t('筆共同日報酬', 'shared returns per pair')}
          </p>
          {!current.valuation_complete && current.holding_count > 0 && (
            <p className="notice">
              {t(
                '持倉估值覆蓋不完整，權重不顯示。有效的成對相關性仍可檢視。',
                'Portfolio valuation coverage is incomplete; weights are hidden. Valid pairwise correlations remain available.',
              )}
            </p>
          )}
          {current.holding_count === 0 && (
            <p className="notice">
              {t('目前沒有實際持倉可比較。', 'There are no actual holdings to compare.')}
            </p>
          )}
          {current.candidates.map((candidate) => {
            const available = candidate.pairs.filter(
              (pair) =>
                pair.reason === null &&
                typeof pair.correlation === 'number' &&
                Number.isFinite(pair.correlation),
            )
            const highest = [...available].sort(
              (a, b) => b.correlation! - a.correlation! || a.holding.localeCompare(b.holding),
            )[0]
            return (
              <article key={candidate.symbol}>
                <h3>
                  {candidate.symbol}
                  {candidate.already_held && (
                    <small>
                      {t('已持有；不與自己比較', 'Already held; self-comparison excluded')}
                    </small>
                  )}
                </h3>
                <div className="alpha-fit-summary">
                  <div>
                    <small>{t('有效持倉比較', 'Available Holding Pairs')}</small>
                    <strong>
                      {available.length} <span>/ {candidate.pairs.length}</span>
                    </strong>
                  </div>
                  <div>
                    <small>{t('相關值最高的持倉', 'Holding with Highest Correlation')}</small>
                    <strong>
                      {highest ? (
                        <>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpen(highest.holding)}
                          >
                            {highest.holding}
                          </button>{' '}
                          <span>{num(highest.correlation, 3)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </strong>
                    {highest && (
                      <p>
                        {highest.observations} {t('筆共同日報酬', 'shared daily returns')} ·{' '}
                        {highest.start} → {highest.end}
                      </p>
                    )}
                  </div>
                </div>
                {!candidate.current && (
                  <p className="footnote">
                    {t(
                      '此候選當期有效報價不可用，暫不計算相關性。',
                      'The candidate has no valid current quote; correlations are unavailable.',
                    )}
                  </p>
                )}
                {candidate.pairs.length > 0 && (
                  <div className="alpha-table-scroll">
                    <table>
                      <caption>
                        {t(
                          `${candidate.symbol} 與持倉的成對相關性`,
                          `${candidate.symbol} pairwise correlations with holdings`,
                        )}
                      </caption>
                      <thead>
                        <tr>
                          {[
                            t('持倉', 'Holding'),
                            t('目前權重', 'Current Weight'),
                            t('相關性', 'Correlation'),
                            t('共同觀測', 'Shared Returns'),
                            t('觀測日期', 'Observed Dates'),
                            t('狀態', 'Status'),
                          ].map((label) => (
                            <th key={label}>{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {candidate.pairs.map((pair) => (
                          <tr key={pair.holding}>
                            <td>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => onOpen(pair.holding)}
                              >
                                {pair.holding}
                              </button>
                            </td>
                            <td>
                              {pair.weight_pct === null ? '—' : `${num(pair.weight_pct, 1)}%`}
                            </td>
                            <td>{pair.correlation === null ? '—' : num(pair.correlation, 3)}</td>
                            <td>{pair.observations}</td>
                            <td>
                              {pair.start || '—'} → {pair.end || '—'}
                            </td>
                            <td>{pair.reason ? reason(pair.reason) : t('可比較', 'Available')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            )
          })}
          <p className="footnote">
            {t(
              '使用調整收盤價的相鄰交易日日報酬；缺日不補值。持倉權重採目前股數與未調整收盤價。',
              'Uses adjusted-close returns between adjacent trading sessions; gaps are not filled. Holding weights use current shares and unadjusted closes.',
            )}{' '}
            {current.engine_version}
          </p>
        </>
      )}
    </section>
  )
}
