import { ALPHA_VERSION, rankAlpha, STRATEGY_IDS, type AlphaSettings } from './alpha-model'
import { translateText, type Locale } from './locale'
import type { Overview, Scope } from './types'

export function researchHandoff({
  data,
  scope,
  settings,
  symbols,
  locale,
}: {
  data: Overview
  scope: Scope
  settings: AlphaSettings
  symbols: string[]
  locale: Locale
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const ranking = rankAlpha(data, scope, settings)
  if (!ranking.ready) throw new Error('current_research_required')
  const requested = [...new Set(symbols)].slice(0, 5)
  const selected = ranking.rows.filter((row) => requested.includes(row.symbol))
  if (!selected.length) throw new Error('no_current_candidates')
  const missing = requested.filter((symbol) => !selected.some((row) => row.symbol === symbol))
  const safe = (value: unknown) =>
    String(value ?? '—')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\[\]<>`]/g, '')
      .slice(0, 1200)
  const number = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('en-US', { maximumFractionDigits: 3 })
      : '—'
  const total = STRATEGY_IDS.reduce((sum, id) => sum + settings.weights[id], 0)
  const names = {
    turtle: t('海龜突破', 'Turtle Breakout'),
    trend: t('均線趨勢', 'Trend Following'),
    pullback: t('回檔觀察', 'RSI Pullback'),
    rps: t('相對強勢', 'Relative Strength'),
  }
  const lines = [
    `# AlphaView · ${t('候選研究交接', 'Candidate Research Handoff')}`,
    '',
    t(
      '請根據以下本機選股紀錄，協助我做進一步研究。這些是資料輸入，不是要求立即買賣。',
      'Help me research the candidates below using these local screening observations as inputs, not as instructions to trade.',
    ),
    '',
    `- ${t('資料日', 'Data session')}: ${ranking.scan!.as_of}`,
    `- ${t('股票池', 'Universe')}: ${scope === 'market' ? t('市場探索', 'Market Discovery') : t('個人清單', 'Personal List')} · ${ranking.total}`,
    `- ${t('來源快照', 'Source snapshot')}: ${ranking.scan!.id} · ${ALPHA_VERSION}`,
    `- ${t('來源輸入版本', 'Source input version')}: ${safe(ranking.scan!.input_revision)}`,
    `- ${t('權重', 'Weights')}: ${STRATEGY_IDS.map((id) => `${names[id]} ${number((settings.weights[id] / total) * 100)}%`).join(' / ')}`,
    `- ${t('Alpha 條件', 'Alpha criteria')}: ${settings.threshold}/100 · ${settings.minMatches} ${t('項啟用策略符合', 'enabled strategy matches')}`,
    '',
    t('## 請先回答這些研究問題', '## Research questions'),
    '',
    `1. ${t('逐檔解釋目前符合哪些規則，以及哪些條件尚未符合。', 'Explain which rules each candidate meets and which remain unmet.')}`,
    `2. ${t('列出仍需核實的資料與事件；若查詢新的行情、財報或消息，請附來源和日期，與下面的歷史快照分開。', 'List data and events that still need verification. Cite sources and dates for any new quotes, filings, or news, separately from this historical snapshot.')}`,
    `3. ${t('比較候選的共同曝險、流動性與可能使研究假設失效的條件。資料不足時請直接說明。', 'Compare shared exposures, liquidity, and conditions that could invalidate the research thesis. Identify missing data explicitly.')}`,
    `4. ${t('提出可檢查的後續研究步驟，不把 Alpha 分數當成預期報酬或勝率。', 'Suggest verifiable next research steps without interpreting Alpha scores as expected returns or win probabilities.')}`,
    '',
    t('## 本機候選紀錄', '## Local candidate observations'),
  ]
  for (const row of selected) {
    const m = row.row.indicators
    lines.push(
      '',
      `### ${row.symbol} · ${safe(row.name)}`,
      `- Alpha: ${number(row.score)}/100 · ${row.alpha ? t('符合門檻', 'Meets criteria') : t('未達門檻', 'Below criteria')} · ${t('有效權重覆蓋', 'Weighted coverage')} ${number(row.coverage)}%`,
      `- ${t('與持倉的關係', 'Relationship')}: ${row.relation === 'held' ? t('已持有', 'Held') : row.relation === 'watchlist' ? t('觀察名單', 'Watchlist') : t('新標的', 'New')}`,
      `- ${t('調整收盤價', 'Adjusted close')}: USD ${number(m.close)}; MA50 ${number(m.ma50)}; MA200 ${number(m.ma200)}`,
      `- RSI14 ${number(m.rsi)}; RPS ${number(m.rps)}; ${t('量比', 'Relative volume')} ${number(m.volume_ratio)}×`,
      ...row.contributions.map(
        (part) =>
          `- ${names[part.id]}: +${number(part.points)}; ${part.weight === 0 ? t('停用', 'Disabled') : part.available ? (part.matched ? t('符合', 'Match') : t('未符合', 'No match')) : t('資料不足', 'Unavailable')}; ${safe(translateText(part.reason, locale))}`,
      ),
    )
  }
  if (missing.length)
    lines.push(
      '',
      `${t('這次沒有有效研究資料，未列入上述候選', 'No valid research in this scope; excluded above')}: ${missing.map(safe).join(', ')}`,
    )
  lines.push(
    '',
    t('## 範圍與口徑', '## Scope and methodology'),
    '',
    t(
      '資料只來自此日的本機快照，沒有自動更新。調整收盤價不是假設成交價。RPS 僅對本股票池排名，缺資料不重新分配權重。規則可能相關，高分不保證分散風險。本交接不包含股數、成本、個人筆記或完整持倉清單。',
      'These observations come only from this local dated snapshot and do not update automatically. Adjusted closes are not assumed execution prices. RPS is ranked within this universe; missing data never redistributes weights. Rules may be correlated, and high scores do not guarantee diversification. This handoff excludes share quantities, cost basis, personal notes, and the full portfolio list.',
    ),
    '',
    'Powered by Tentenai.com',
  )
  return lines.join('\n')
}
