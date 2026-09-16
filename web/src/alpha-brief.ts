import {
  ALPHA_VERSION,
  STRATEGY_IDS,
  type AlphaSettings,
  type AlphaCandidate,
  type RiskAlert,
} from './alpha-model'
import type { Locale } from './locale'
import type { Scope } from './types'

export function researchBrief(input: {
  locale: Locale
  date: string
  scope: Scope
  total: number
  usable: number
  settings: AlphaSettings
  rows: AlphaCandidate[]
  alerts: RiskAlert[]
  source?: { scanId: number; inputRevision?: string | number | null }
}) {
  const { locale, date, scope, total, usable, settings, rows, alerts, source } = input
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const esc = (value: unknown) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  const fmt = (value: number) =>
    value.toLocaleString(locale === 'en' ? 'en-US' : 'zh-TW', { maximumFractionDigits: 2 })
  const names = {
    turtle: t('海龜突破', 'Turtle Breakout'),
    trend: t('均線趨勢', 'Trend Following'),
    pullback: t('回檔觀察', 'RSI Pullback'),
    rps: t('相對強勢', 'Relative Strength'),
  }
  const riskNames = {
    concentration: t('集中度', 'Concentration'),
    daily_drop: t('單日跌幅', 'Daily Decline'),
    below_ma200: t('低於 MA200', 'Below MA200'),
    below_ma50: t('低於 MA50', 'Below MA50'),
    overbought: t('RSI 高檔', 'Elevated RSI'),
    data_gap: t('報價待更新', 'Quotes Need Updating'),
    signal_gap: t('訊號待更新', 'Signals Need Updating'),
    price_below: t('達到自訂收盤下限', 'At or Below Your Closing-Price Threshold'),
    price_above: t('達到自訂收盤上限', 'At or Above Your Closing-Price Threshold'),
  }
  const weights = STRATEGY_IDS.reduce((sum, id) => sum + settings.weights[id], 0)
  const selected = rows.filter((row) => row.alpha)
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-Hant'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AlphaView · ${esc(date)} ${t('研究摘要', 'Research Brief')}</title><style>
  :root{font-family:system-ui,sans-serif;background:#f5f6f4;color:#202922}*{box-sizing:border-box}body{max-width:1100px;margin:auto;padding:48px 24px}h1{font-size:42px;letter-spacing:-.04em;margin:12px 0}h2{margin-top:40px}p{line-height:1.7;color:#526058}small{color:#657368}.eyebrow{letter-spacing:.14em;font-size:12px;color:#36745a}.stats{display:flex;flex-wrap:wrap;gap:32px;margin:32px 0;border-block:1px solid #d9dfd9;padding:24px 0}.stats b{display:block;font-size:32px}.table{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:12px;border-bottom:1px solid #d9dfd9;font-size:14px}th{font-size:12px;color:#657368}.weights{display:flex;flex-wrap:wrap;gap:12px}.weights span{padding:12px;border:1px solid #d9dfd9;border-radius:6px}.alerts{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.alert{padding:16px;border:1px solid #d9dfd9;border-left:3px solid #b07930}.alert.high{border-left-color:#b63b39}.alert.data{border-left-color:#687b83}footer{margin-top:48px;padding-top:20px;border-top:1px solid #d9dfd9}a{color:#217553}@media print{body{padding:0;background:white}h2,tr,.alert{break-inside:avoid}.table{overflow:visible}table{white-space:normal}}
  </style><header><div class="eyebrow">ALPHAVIEW / DAILY RESEARCH</div><h1>${t('每日研究摘要', 'Daily Research Brief')}</h1><p>${esc(date)} · ${scope === 'market' ? t('市場探索', 'Market Discovery') : t('個人清單', 'Personal List')}<br>${t('保存時間', 'Generated')} ${esc(new Date().toISOString())}</p>${source ? `<p>${t('來源快照', 'Source Snapshot')} #${esc(source.scanId)} · ${t('輸入版本', 'Input Version')} ${esc(source.inputRevision ?? '—')}</p>` : ''}</header>
  <div class="stats"><div><b>${selected.length}</b>Alpha Picks</div><div><b>${selected.filter((row) => row.relation === 'held').length}</b>${t('已持有 Alpha', 'Held Alpha Picks')}</div><div><b>${usable}/${total}</b>${t('有效研究資料', 'Valid Research Rows')}</div><div><b>${alerts.filter((alert) => alert.severity !== 'data').length}</b>${t('持倉提醒條件', 'Holding Review Conditions')}</div></div>
  <h2>${t('當時使用的研究設定', 'Research Settings Used')}</h2><div class="weights">${STRATEGY_IDS.map((id) => `<span>${names[id]} <b>${fmt((settings.weights[id] / weights) * 100)}%</b></span>`).join('')}</div><p>${t('Alpha 門檻', 'Alpha Threshold')}: ${settings.threshold}/100 · ${t('至少符合策略數', 'Minimum Strategy Matches')}: ${settings.minMatches}<br>${t('集中度門檻', 'Concentration Threshold')} ${settings.concentration}% · ${t('單日跌幅門檻', 'Daily Decline Threshold')} ${settings.dailyDrop}% · RSI ${settings.overbought}</p>
  ${settings.priceRules?.length ? `<h3>${t('個股收盤提醒設定', 'Custom Closing-Price Rules')}</h3><p>${t('這是當時保存的設定；僅對實際持倉的有效當期收盤價檢查，沒有持倉的設定不會觸發提醒。', 'These are saved settings, evaluated only against valid current closes of actual holdings. Rules for symbols without a position are inactive.')}</p><div class="table"><table><thead><tr><th>${t('代碼', 'Symbol')}</th><th>${t('收盤下限 USD', 'Closing Floor USD')}</th><th>${t('收盤上限 USD', 'Closing Ceiling USD')}</th></tr></thead><tbody>${settings.priceRules.map((rule) => `<tr><td>${esc(rule.symbol)}</td><td>${rule.below === null ? '—' : fmt(rule.below)}</td><td>${rule.above === null ? '—' : fmt(rule.above)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <h2>Alpha Picks</h2>${!selected.length ? `<p>${t('當時沒有符合 Alpha 條件的標的。', 'No symbols met the Alpha criteria at this time.')}</p>` : `<div class="table"><table><thead><tr>${[t('代碼', 'Symbol'), t('公司', 'Company'), t('關係', 'Relationship'), t('分數', 'Score'), ...STRATEGY_IDS.map((id) => names[id])].map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${selected.map((row) => `<tr><td><b>${esc(row.symbol)}</b></td><td>${esc(row.name)}</td><td>${row.relation === 'held' ? t('持有', 'Held') : row.relation === 'watchlist' ? t('觀察中', 'Watching') : t('新標的', 'New')}</td><td>${fmt(row.score)}</td>${row.contributions.map((part) => `<td>${part.weight === 0 ? '—' : part.available ? (part.matched ? '✓' : '·') : '?'} +${fmt(part.points)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
  <h2>${t('持倉提醒', 'Holding Alerts')}</h2><div class="alerts">${alerts.map((alert) => `<article class="alert ${esc(alert.severity)}"><b>${esc(alert.symbol)} · ${riskNames[alert.kind]}</b><p>${alert.value === null ? '' : alert.kind.startsWith('price_') ? '$' + fmt(alert.value) : fmt(alert.value) + (alert.kind === 'overbought' ? ' RSI' : '%')} ${alert.threshold !== null ? ` / ${t('門檻', 'threshold')} ${alert.kind.startsWith('price_') ? '$' : ''}${fmt(alert.threshold)}` : ''}<br>${esc(alert.date || '—')}</p></article>`).join('') || `<p>${t('當時沒有觸發提醒條件。', 'No review conditions were triggered at that time.')}</p>`}</div>
  <h2>${t('閱讀方式', 'How to Read This Brief')}</h2><p>${t('分數 = 100 × 符合策略權重 ÷ 全部啟用權重。缺值不會提高其他策略的得分；所有啟用策略均需有效資料，才可列為 Alpha Pick。排序依分數、符合策略數、同股票池 RPS 與代碼。', 'Score = 100 × matching strategy weights / all enabled weights. Missing data never boosts other strategies; all enabled strategies need valid data for Alpha eligibility. Rankings use score, match count, same-universe RPS, then ticker.')}</p><p>${t('這是一份當時資料的靜態紀錄，不會自動更新。分數表示規則交集，並非預期報酬或勝率。提醒是研究條件，不會下單，也不代表賣出建議。市場與個人清單的 RPS 分開計算。', 'This is a static record and does not update automatically. Scores reflect rule agreement, not expected return or win probability. Alerts are research conditions; they do not place orders or recommend selling. Market and personal RPS are calculated separately.')}</p><footer><small>${esc(ALPHA_VERSION)} · Powered by <a href="https://tentenai.com">Tentenai.com</a></small></footer></html>`
}
