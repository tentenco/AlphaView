import { ArrowRight } from '@carbon/icons-react'
import type { Locale } from './locale'

export function AlphaHelp({
  locale,
  onNavigate,
}: {
  locale: Locale
  onNavigate: (
    page: 'alpha' | 'alpha-lab' | 'screener' | 'portfolio' | 'comparison' | 'data',
  ) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const destinations = [
    {
      page: 'alpha' as const,
      title: t('找今天值得研究的標的', 'Find Today’s Research Candidates'),
      detail: t(
        '從市場探索開始。看四策略共識、今天的變化，再用卡片、表格或分布圖選出候選。進階篩選可限制 RPS、RSI 與 Alpha 分數。',
        'Start with Market Discovery. Review strategy agreement and daily changes, then use cards, the table, or the map to explore candidates. Advanced filters narrow RPS, RSI, and Alpha score.',
      ),
    },
    {
      page: 'portfolio' as const,
      title: t('確認持倉與成本', 'Review Holdings and Cost Basis'),
      detail: t(
        '維護實際股數與成本。Alpha 首頁會把已持有股票標示出來，並整理集中度、均線與自訂價格提醒。',
        'Maintain actual shares and cost basis. Alpha Picks labels held stocks and collects concentration, moving-average, and custom-price alerts.',
      ),
    },
    {
      page: 'alpha-lab' as const,
      title: t('研究權重與歷史訊號', 'Explore Weights and Historical Signals'),
      detail: t(
        '使用獨立的實驗權重，回放 Alpha 訊號或執行假設組合。保存實驗後，可以同條件比較。',
        'Use separate experiment weights to replay Alpha signals or simulate a hypothetical basket. Save experiments for comparisons under matching conditions.',
      ),
    },
    {
      page: 'comparison' as const,
      title: t('比較與保存候選組合', 'Compare and Save Candidate Groups'),
      detail: t(
        '選擇 2–5 檔，以共同起點比較價格變化。命名保存設定，下次載入後明確重新計算。',
        'Choose 2–5 tickers and compare price changes from a common anchor. Save named settings, then explicitly recalculate when reopening.',
      ),
    },
  ]
  return (
    <div className="alpha-help" translate="no">
      <p>
        {t(
          '每天先確認資料日期，再找機會、看持倉提醒。研究可以保留，交易決定由你掌握。',
          'Start each day by checking the data date, then explore candidates and review holding alerts. Keep your research organized while making your own trading decisions.',
        )}
      </p>
      <div className="alpha-help-paths">
        {destinations.map((item) => (
          <button type="button" key={item.page} onClick={() => onNavigate(item.page)}>
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
            <ArrowRight size={18} />
          </button>
        ))}
      </div>
      <details>
        <summary>{t('Alpha 分數怎麼看？', 'How Should I Read the Alpha Score?')}</summary>
        <p>
          {t(
            '符合的策略權重加總後除以全部啟用權重。預設各 25%，至少兩項符合且達 50 分。缺資料不會提高其他策略權重。高分表示規則交集，不是勝率或報酬預測。',
            'Matching strategy weights are divided by all enabled weights. Defaults are 25% each, at least two matches, and 50 points. Missing data never boosts another strategy’s weight. A higher score means more rule agreement, not a higher win probability or return forecast.',
          )}
        </p>
      </details>
      <details>
        <summary>
          {t('星號、觀察名單和持股有什麼不同？', 'How Do Stars, Watchlists, and Holdings Differ?')}
        </summary>
        <p>
          {t(
            '星號是瀏覽器內的研究清單，可安排研究階段和複查日期，不改選股範圍。已儲存的複查日期可匯出 ICS 至自己的行事曆。觀察名單是零股的個人選股項目；加入後需重算股票池。股數大於零才是實際持倉。',
            'Stars form a browser research shortlist with stages and review dates; they do not change the screening universe. Export saved review dates as ICS for your calendar. Watchlist entries are zero-share symbols in your personal screening list; adding one requires recalculation. Positive shares represent actual holdings.',
          )}
        </p>
      </details>
      <details>
        <summary>
          {t('資料過期或沒有結果時怎麼辦？', 'What If Data Is Stale or There Are No Results?')}
        </summary>
        <p>
          {t(
            '如果只是清單或設定改變，可在 Alpha 首頁同步重算兩個股票池。若行情日期落後，從每日選股更新行情；資料管理會列出缺漏與失敗原因。沒有符合策略的標的也可能是正常結果。',
            'If lists changed, recalculate both lists in Alpha Picks. If quote dates are behind, update quotes from the screener. Data Management lists gaps and failures. Having no matching candidates can also be a valid result.',
          )}
        </p>
        <div className="actions">
          <button type="button" className="button" onClick={() => onNavigate('screener')}>
            {t('每日選股', 'Daily Screener')}
          </button>
          <button type="button" className="button" onClick={() => onNavigate('data')}>
            {t('資料管理', 'Data Management')}
          </button>
        </div>
      </details>
      <details>
        <summary>{t('怎麼保留或搬移研究？', 'How Can I Keep or Move My Research?')}</summary>
        <p>
          {t(
            '每日摘要可下載為離線 HTML。資料管理提供 Alpha 研究 JSON 備份與匯入預覽，保存權重方案、星號、進度、比較、快照和實驗摘要。行情、持倉與詳細筆記使用工作區 ZIP 備份。',
            'Download daily briefs as offline HTML. Data Management provides Alpha research JSON backup and import preview for weight profiles, stars, progress, comparison groups, snapshots, and experiment summaries. Quotes, holdings, and detailed notes use the workspace ZIP backup.',
          )}
        </p>
      </details>
      <p className="footnote">
        {t(
          '⌘ K / Ctrl K 搜尋標的 · Escape 關閉目前對話框 · 頂部可切換繁中／英文與淺色／深色。桌面通知需要自行啟用，且頁面需保持開啟。',
          '⌘ K / Ctrl K searches symbols · Escape closes the active dialog · Switch language and theme in the header. Desktop notifications are opt-in and require the page to remain open.',
        )}
      </p>
    </div>
  )
}
