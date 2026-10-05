import { useState } from 'react'
import { EquityChart } from './Charts'
import type { Locale } from './locale'
import { ResearchDeskPaperBridge } from './ResearchDeskPaperBridge'
import { ResearchDeskValidation } from './ResearchDeskValidation'
import { ResearchDeskIntegrity } from './ResearchDeskIntegrity'
import { ResearchPrefixCoverage } from './ResearchPrefixCoverage'
import { ResearchIntegrityArchive } from './ResearchIntegrityArchive'
import { money, num } from './ui'
import {
  deskPercent,
  deskRatio,
  type DeskConditionDimension,
  type DeskDiagnosis,
  type DeskPine,
} from './research-desk-model'
import type { Translate } from './ResearchDesk'

const DIMENSIONS: [DeskConditionDimension, string, string][] = [
  ['trend', '進場時的趨勢（收盤對 MA200）', 'Trend at entry (close vs 200-day SMA)'],
  ['rsi_zone', '進場時的 RSI 區間', 'RSI zone at entry'],
  ['volatility', '進場時的波動率（三分位）', 'Volatility at entry (terciles)'],
  ['benchmark', '進場時的大盤狀態', 'Benchmark regime at entry'],
  ['holding', '持有時間', 'Holding period'],
  ['exit_reason', '出場原因', 'Exit reason'],
]
const BUCKETS: Record<string, [string, string]> = {
  above_ma200: ['高於 MA200', 'Above 200-day SMA'],
  below_ma200: ['低於 MA200', 'Below 200-day SMA'],
  unavailable: ['無法判斷', 'Unavailable'],
  oversold: ['超賣（<30）', 'Oversold (<30)'],
  weak: ['偏弱（30–50）', 'Weak (30–50)'],
  strong: ['偏強（50–70）', 'Strong (50–70)'],
  overbought: ['超買（>70）', 'Overbought (>70)'],
  low: ['低波動', 'Low'],
  mid: ['中波動', 'Middle'],
  high: ['高波動', 'High'],
  short: ['≤5 日', '≤5 sessions'],
  medium: ['6–20 日', '6–20 sessions'],
  long: ['>20 日', '>20 sessions'],
  signal: ['規則出場', 'Rule exit'],
  stop_loss: ['停損', 'Stop-loss'],
  take_profit: ['停利', 'Take-profit'],
}
const label = (value: string, t: Translate) => (BUCKETS[value] ? t(...BUCKETS[value]) : value)
const tone = (value: number | null | undefined) =>
  value == null ? '' : value > 0 ? 'desk-positive' : value < 0 ? 'desk-negative' : ''

export function ResearchDeskDiagnosis({
  diagnosis,
  symbols,
  pine,
  busy,
  integrityContextIdentity,
  onPine,
  onCsv,
  t,
  locale,
}: {
  diagnosis: DeskDiagnosis
  symbols?: string[]
  pine: DeskPine | null
  busy: string | null
  integrityContextIdentity?: string
  onPine: () => void
  onCsv: () => void
  t: Translate
  locale: Locale
}) {
  const [copied, setCopied] = useState(false)
  const s = diagnosis.summary
  const b = diagnosis.benchmark
  const metrics: [string, string, string, string?][] = [
    [t('淨損益', 'Net P/L'), money(s.net_profit), deskPercent(s.return_pct)],
    [
      t('買入持有', 'Buy and hold'),
      deskPercent(b.return_pct),
      `${t('超額', 'Excess')} ${deskPercent(s.excess_return_pct)}`,
    ],
    [
      t('最大回撤', 'Max drawdown'),
      deskPercent(s.max_drawdown_pct),
      `${t('基準', 'Benchmark')} ${deskPercent(b.max_drawdown_pct)}`,
    ],
    [
      t('最高／最低淨值', 'Peak / low equity'),
      money(s.peak_equity),
      `${t('最低', 'Low')} ${money(s.lowest_equity)}`,
    ],
    [
      t('已平倉交易', 'Closed trades'),
      String(s.closed_trades),
      s.open_position ? t('期末仍持有（按收盤評價）', 'Open at end (marked to close)') : '',
    ],
    [
      t('勝率', 'Win rate'),
      s.win_rate_pct == null ? '—' : `${num(s.win_rate_pct, 1)}%`,
      `${t('平均每筆', 'Average trade')} ${deskPercent(s.avg_trade_return_pct)}`,
    ],
    [
      t('獲利因子', 'Profit factor'),
      deskRatio(s.profit_factor),
      `${t('最大連虧', 'Longest losing streak')} ${s.max_consecutive_losses}`,
    ],
    [
      t('在市時間', 'Time in market'),
      s.exposure_pct == null ? '—' : `${num(s.exposure_pct, 1)}%`,
      `Sharpe ${deskRatio(s.sharpe_ratio)}`,
    ],
  ]
  async function copy() {
    if (!pine) return
    try {
      await navigator.clipboard.writeText(pine.code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  function downloadPine() {
    if (!pine) return
    const link = URL.createObjectURL(new Blob([pine.code], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = link
    anchor.download = pine.filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(link), 10000)
  }
  return (
    <section className="desk-panel" aria-label={t('策略診斷', 'Strategy diagnosis')}>
      <h2>
        {t('為什麼會這樣？', 'Why did it perform this way?')} ·{' '}
        {t(diagnosis.label, diagnosis.label_en)} · {diagnosis.symbol}
      </h2>
      <p className="desk-meta">
        {diagnosis.window.start} → {diagnosis.window.end} ({diagnosis.window.sessions}{' '}
        {t('個交易日', 'sessions')}) · {t('基準', 'Benchmark regime')} {diagnosis.benchmark_symbol}{' '}
        · {t('資料指紋', 'Data fingerprint')} {diagnosis.fingerprint.slice(0, 12)}
      </p>
      <div className="desk-metrics">
        {metrics.map(([name, value, detail]) => (
          <div key={name}>
            <span>{name}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <EquityChart data={diagnosis.curve} />
      <h3>{t('可測試的假設', 'Hypotheses to test')}</h3>
      {diagnosis.hypotheses.length ? (
        <ul className="desk-hypotheses">
          {diagnosis.hypotheses.map((note) => (
            <li key={note.code}>{t(note.text, note.text_en)}</li>
          ))}
        </ul>
      ) : (
        <p>
          {t(
            '沒有明顯集中的虧損來源。仍請以樣本外區間與其他代碼驗證。',
            'No concentrated loss source stands out. Still validate out of sample and on other symbols.',
          )}
        </p>
      )}
      <p className="desk-meta">
        {t(
          '以上是由程式依交易紀錄算出的觀察，不是建議。改動規則時請另存一組設定，回到排行比較樣本外結果，避免針對歷史調參。',
          'These are program-computed observations from the trade log, not advice. When changing a rule, add it as another configuration and compare out-of-sample results instead of tuning to history.',
        )}
      </p>
      <div className="desk-conditions">
        {DIMENSIONS.map(([dimension, zh, en]) => (
          <div key={dimension} className="table-scroll">
            <h3>{t(zh, en)}</h3>
            {diagnosis.conditions[dimension].length ? (
              <table>
                <thead>
                  <tr>
                    {[
                      t('狀態', 'Condition'),
                      t('筆數', 'Trades'),
                      t('勝率', 'Win rate'),
                      t('損益', 'P/L'),
                      t('虧損占比', 'Share of losses'),
                    ].map((heading) => (
                      <th scope="col" key={heading}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {diagnosis.conditions[dimension].map((row) => (
                    <tr key={row.bucket}>
                      <th scope="row">{label(row.bucket, t)}</th>
                      <td>{row.trades}</td>
                      <td>{row.win_rate_pct == null ? '—' : `${num(row.win_rate_pct, 0)}%`}</td>
                      <td className={tone(row.total_pnl)}>{money(row.total_pnl)}</td>
                      <td>{row.loss_share_pct == null ? '—' : `${num(row.loss_share_pct, 0)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>{t('沒有已平倉交易。', 'No closed trades.')}</p>
            )}
          </div>
        ))}
      </div>
      <h3>{t('最深的回撤', 'Deepest drawdowns')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                t('高點', 'Peak'),
                t('低點', 'Trough'),
                t('回撤', 'Depth'),
                t('跌到低點', 'Sessions to trough'),
                t('收復', 'Recovered'),
              ].map((heading) => (
                <th scope="col" key={heading}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {diagnosis.drawdowns.map((row) => (
              <tr key={`${row.peak_date}-${row.trough_date}`}>
                <td>{row.peak_date}</td>
                <td>{row.trough_date}</td>
                <td className="desk-negative">{deskPercent(row.depth_pct)}</td>
                <td>{row.sessions_to_trough}</td>
                <td>
                  {row.recovery_date
                    ? `${row.recovery_date} (${row.sessions_to_recovery})`
                    : t('尚未收復', 'Not yet')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>
        {t('交易紀錄', 'Trade log')} ({diagnosis.trades.length})
      </h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                t('訊號日', 'Signal'),
                t('進場', 'Entry'),
                t('出場', 'Exit'),
                t('原因', 'Reason'),
                t('報酬', 'Return'),
                t('損益', 'P/L'),
                t('持有', 'Held'),
                t('趨勢', 'Trend'),
                'RSI',
              ].map((heading) => (
                <th scope="col" key={heading}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {diagnosis.trades.map((trade) => (
              <tr key={trade.entry_date}>
                <td>{trade.signal_date}</td>
                <td>
                  {trade.entry_date} · {num(trade.entry_price)}
                </td>
                <td>
                  {trade.exit_date} · {num(trade.exit_price)}
                </td>
                <td>{label(trade.exit_reason, t)}</td>
                <td className={tone(trade.return_pct)}>{deskPercent(trade.return_pct)}</td>
                <td className={tone(trade.net_pnl)}>{money(trade.net_pnl)}</td>
                <td>{trade.holding_sessions}</td>
                <td>{label(trade.conditions.trend, t)}</td>
                <td>{trade.rsi_at_signal == null ? '—' : num(trade.rsi_at_signal, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diagnosis.open_position && (
        <p className="desk-meta">
          {t('期末仍持有：', 'Still open at the end: ')} {diagnosis.open_position.entry_date} ·{' '}
          {t('未實現', 'unrealized')} {deskPercent(diagnosis.open_position.unrealized_return_pct)}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={!!busy} onClick={onCsv}>
          {busy === 'csv' ? t('下載中…', 'Downloading…') : t('下載交易 CSV', 'Download trades CSV')}
        </button>
        <button type="button" className="button" disabled={!!busy} onClick={onPine}>
          {busy === 'pine'
            ? t('產生中…', 'Generating…')
            : t('匯出 Pine Script v6', 'Export Pine Script v6')}
        </button>
      </div>
      <p className="desk-meta">
        {t(
          'CSV 含每筆交易與進場當下的市場狀態，可交給 Claude 追問「為什麼表現不好、哪些情況虧最多、如何降低回撤而不過度擬合」。',
          'The CSV lists every trade with its entry conditions, ready to hand to Claude with questions such as why it underperformed, which conditions lost most, and how to cut drawdown without overfitting.',
        )}
      </p>
      {pine && (
        <div aria-label={t('Pine Script', 'Pine Script')}>
          <ul className="desk-hypotheses">
            {pine.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <pre className="desk-code">{pine.code}</pre>
          <div className="actions">
            <button type="button" className="button" onClick={() => void copy()}>
              {copied ? t('已複製', 'Copied') : t('複製程式碼', 'Copy code')}
            </button>
            <button type="button" className="button" onClick={downloadPine}>
              {t('下載 .pine', 'Download .pine')}
            </button>
          </div>
        </div>
      )}
      <details>
        <summary>{t('提醒與方法', 'Warnings and method')}</summary>
        <ul className="desk-hypotheses">
          {diagnosis.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
        <p className="desk-meta">{diagnosis.method}</p>
      </details>
      <ResearchDeskValidation
        key={`validate:${diagnosis.symbol}:${JSON.stringify(diagnosis.config)}`}
        symbol={diagnosis.symbol}
        config={diagnosis.config}
        risk={diagnosis.request?.risk}
        testStart={diagnosis.window.start}
        testEnd={diagnosis.request?.test_end ?? diagnosis.window.end}
        symbols={symbols}
        t={t}
      />
      <ResearchDeskIntegrity
        symbol={diagnosis.symbol}
        config={diagnosis.config}
        testStart={diagnosis.window.start}
        testEnd={diagnosis.request?.test_end ?? diagnosis.window.end}
        inputRevision={diagnosis.input_revision}
        fingerprint={diagnosis.fingerprint}
        contextIdentity={integrityContextIdentity}
        enabled={!busy}
        t={t}
      />
      <ResearchPrefixCoverage
        symbol={diagnosis.symbol}
        config={diagnosis.config}
        testStart={diagnosis.window.start}
        testEnd={diagnosis.request?.test_end ?? diagnosis.window.end}
        inputRevision={diagnosis.input_revision}
        asOf={diagnosis.as_of}
        contextIdentity={integrityContextIdentity}
        enabled={!busy}
        t={t}
      />
      <ResearchIntegrityArchive
        symbol={diagnosis.symbol}
        contextIdentity={integrityContextIdentity}
        enabled={!busy}
        t={t}
      />
      <ResearchDeskPaperBridge
        key={`${diagnosis.symbol}:${JSON.stringify([diagnosis.config, diagnosis.request?.risk, diagnosis.window.start, diagnosis.request?.test_end ?? diagnosis.window.end])}`}
        config={diagnosis.config}
        risk={diagnosis.request?.risk}
        testStart={diagnosis.window.start}
        testEnd={diagnosis.request?.test_end ?? diagnosis.window.end}
        label={t(diagnosis.label, diagnosis.label_en)}
        defaultSymbols={[diagnosis.symbol]}
        locale={locale}
      />
    </section>
  )
}
