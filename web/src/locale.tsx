import { useLayoutEffect } from 'react'

export type Locale = 'zh-TW' | 'en'

export const LOCALE_STORAGE_KEY = 'alphaview-locale'

export function readLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === 'en' ? 'en' : 'zh-TW'
  } catch {
    return 'zh-TW'
  }
}

export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale
  document.documentElement.dataset.locale = locale
  document.title = locale === 'en' ? 'AlphaView · US Stock Research' : 'AlphaView · 美股研究版'
}

export function saveLocale(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // The active page can still change language when browser storage is unavailable.
  }
}

const translations: Record<string, string> = {
  'Alpha 實驗室': 'Alpha Lab',
  你的選股研究工作台: 'Your stock research workspace',
  '掌握持股變化，找到下一個值得研究的機會。':
    'Track your holdings and find the next opportunity worth researching.',
  '從市場尋找新標的，也能持續追蹤自己的清單。':
    'Discover new market candidates and keep following your own list.',
  '以最近一次市場選股快照，觀察股票池的趨勢與資料覆蓋。':
    'Review trend breadth and data coverage from the latest market screen.',
  '持股、成本與觀察名單，集中管理。':
    'Manage holdings, cost basis, and your watchlist in one place.',
  '理解規則，再用歷史資料驗證想法。': 'Understand the rules, then test ideas with historical data.',
  '選擇 2–5 檔已知標的，以相同起點比較調整收盤價的百分比變化。':
    'Compare adjusted-price performance for 2–5 known stocks from a shared starting point.',
  '查看行情來源、更新進度與每個標的的資料品質。':
    'Review data sources, update progress, and data quality for every symbol.',
  '資料來源 Yahoo Finance · 日線行情，非即時串流。策略用於研究，不會自動下單。':
    'Source: Yahoo Finance daily data, not a real-time feed. Strategies are for research and never place orders.',
  '面板目前為單一使用者的本地工作區，沒有券商串接或自動下單。新加入的股票在下載行情前不會有報價。':
    'This is a single-user local workspace with no broker connection or automated orders. New stocks have no quote until data is downloaded.',
  '各指標使用自己的有效樣本數，缺值不補為零。':
    'Each metric uses its own valid sample; missing values are never filled with zero.',
  '僅以「符合條件」或「持續觀察」的有效當期資料作為分母。':
    'Only current valid Match or Watch observations are included in the denominator.',
  '部分持股缺少當期有效估值，暫不顯示配置比例。':
    'Allocation is hidden because some holdings lack a current valid valuation.',
  '先到「我的持股」新增觀察標的，再更新行情查看走勢。':
    'Add a symbol under My Portfolio, then refresh data to view its trend.',
  '更新行情後，即可查看歷史走勢': 'Refresh market data to view price history',
  '尚無市場選股快照。請先執行市場選股，完成後即可查看股票池概況。':
    'No market-screen snapshot yet. Run a market screen to view the universe overview.',
  '尚無選股紀錄，請先更新行情。': 'No screening history yet. Refresh market data first.',
  '按「執行市場選股」下載候選股票資料，尋找持股以外的新機會。':
    'Run Market Screen to download candidate data and discover opportunities beyond your holdings.',
  '沒有符合目前條件的標的，可取消「只看符合條件」或調整其他篩選。':
    'No symbols match the current filters. Turn off Matches Only or adjust the filters.',
  '目前沒有實際持倉。加入股數後即可分析；觀察名單不列入持倉風險。':
    'There are no active holdings. Add shares to run the analysis; watchlist entries are excluded from portfolio risk.',
  '至少需要兩檔實際持倉才能比較成對相關性。':
    'At least two active holdings are required for pairwise correlation.',
  '可用標的不足兩檔，暫不繪製比較圖。請查看下方缺少資料的原因，或選擇其他期間／標的。':
    'Fewer than two symbols have usable data. Review the reasons below or choose another period or symbol.',
  '選擇持股或市場候選標的，查看歷史報酬與回撤。':
    'Choose a holding or market candidate to review historical return and drawdown.',
  '設定資金、成本與日期，比較策略與買入持有。':
    'Set capital, costs, and dates to compare a strategy with buy and hold.',
  '訊號於收盤確認，次日開盤模擬成交；10 bps 相當於單邊成本 0.1%。':
    'Signals are confirmed at the close and simulated at the next open; 10 bps equals a 0.1% one-way cost.',
  '依預期交易日檢查日線新鮮度與資料缺口。':
    'Check daily-data freshness and gaps against the expected trading session.',
  '目前沒有需要處理的資料。': 'No data currently requires attention.',
  '尚無可檢查標的。': 'No symbols are available to check.',
  '檢查資料用量，手動清理同範圍、同日期被較新結果取代的選股快照。':
    'Review storage use and manually remove screen snapshots replaced by newer results for the same scope and date.',
  '本機伺服器必須持續運行。美股交易日收盤 15 分鐘後，針對最新已完成交易日自動嘗試一次；部分完成、失敗或取消也計入該次嘗試。電腦喚醒後僅補最新交易日，不補跑所有遺漏日期。停用排程不會取消正在執行的作業。':
    'The local server must remain running. AlphaView attempts one update 15 minutes after the latest US market close. Partial, failed, or cancelled runs count as that attempt. After wake, only the latest session is retried. Disabling the schedule does not cancel an active job.',
  '必要欄位：symbol, shares, cost。選填：name, sector。觀察名單的 shares 設為 0，cost 可留空。匯出報表中的計算欄位會由預覽說明是否忽略。':
    'Required columns: symbol, shares, cost. Optional: name, sector. Use zero shares and a blank cost for watchlist entries. The preview identifies ignored computed columns.',
  '先預覽每一筆變更，再確認寫入。匯入採合併方式，CSV 未提及的持股會保留；最多 100 筆、300,000 個字元。':
    'Preview every change before importing. Import merges rows and keeps holdings omitted from the CSV; maximum 100 rows and 300,000 characters.',
  個人工作區: 'Personal workspace',
  個人研究工作區: 'Personal research workspace',
  投資研究工作台: 'Investment research workspace',
  本地工作區: 'Local workspace',
  本地研究模式: 'Local research mode',
  主要導覽: 'Primary navigation',
  切換導覽: 'Toggle navigation',
  關閉導覽: 'Close navigation',
  'AlphaView 首頁': 'AlphaView home',
  投資總覽: 'Overview',
  市場概況: 'Market Overview',
  每日選股: 'Daily Screener',
  我的持股: 'My Portfolio',
  策略研究: 'Strategy Research',
  標的比較: 'Stock Comparison',
  資料管理: 'Data Management',
  使用說明: 'Help',
  搜尋標的: 'Search symbols',
  搜尋股票代碼或名稱: 'Search ticker or company name',
  '搜尋代碼或公司…': 'Search ticker or company…',
  搜尋股票池: 'Search universe',
  搜尋持股: 'Search holdings',
  搜尋候選標的: 'Search candidates',
  搜尋資料品質標的: 'Search data-quality symbols',
  搜尋比較標的: 'Search comparison symbols',
  切換為深色模式: 'Switch to dark mode',
  切換為淺色模式: 'Switch to light mode',
  關閉視窗: 'Close dialog',
  更新行情: 'Refresh Data',
  更新中: 'Updating',
  '更新中…': 'Updating…',
  更新: 'Update',
  重新整理: 'Refresh',
  重新檢查: 'Run Check Again',
  重新讀取選股紀錄: 'Reload Screen History',
  重新計算風險概況: 'Recalculate Risk Overview',
  重新嘗試比較: 'Retry Comparison',
  執行選股: 'Run Screen',
  執行市場選股: 'Run Market Screen',
  執行清單選股: 'Run List Screen',
  執行回測: 'Run Backtest',
  '回測中…': 'Backtesting…',
  正在執行回測: 'Running backtest',
  前往市場選股: 'Open Market Screener',
  以目前股票池重新計算: 'Recalculate with Current Universe',
  以目前資料重算: 'Recalculate with Current Data',
  查看技術指標: 'View Technical Indicators',
  查看最新結果: 'View Latest Results',
  查看進度: 'View Progress',
  管理持股: 'Manage Portfolio',
  新增標的: 'Add Symbol',
  新增: 'Add',
  編輯: 'Edit',
  儲存: 'Save',
  '儲存中…': 'Saving…',
  取消: 'Cancel',
  重試: 'Retry',
  刪除設定: 'Delete Preset',
  重設篩選: 'Reset Filters',
  清除選取: 'Clear Selection',
  上一頁: 'Previous',
  下一頁: 'Next',
  全部: 'All',
  全部策略: 'All Strategies',
  全部標的: 'All Symbols',
  全部紀錄: 'All Records',
  市場: 'Market',
  我的清單: 'My List',
  市場股票池: 'Market Universe',
  市場候選股票池: 'Market Candidate Universe',
  我的持股與觀察清單: 'My Portfolio and Watchlist',
  持股與觀察名單: 'Holdings and Watchlist',
  觀察名單: 'Watchlist',
  '新增美股持股或觀察標的。持股數設為 0 即列入觀察名單。':
    'Add a US stock holding or watchlist symbol. Set shares to zero to add it to the watchlist.',
  股票代碼: 'Ticker',
  公司名稱: 'Company',
  '名稱／產業': 'Name / Sector',
  標的: 'Symbol',
  策略: 'Strategy',
  策略訊號: 'Strategy Signals',
  策略覆蓋: 'Strategy Coverage',
  策略篩選: 'Strategy Filter',
  策略回測: 'Strategy Backtest',
  策略報酬: 'Strategy Return',
  策略淨值: 'Strategy Equity',
  策略新符合與退出: 'New Matches and Exits',
  海龜突破: 'Turtle Breakout',
  均線趨勢: 'Moving-Average Trend',
  回檔觀察: 'RSI Pullback',
  相對強勢: 'Relative Strength',
  符合條件: 'Match',
  持續觀察: 'Watch',
  資料不足: 'Insufficient Data',
  資料過期: 'Stale Data',
  資料異常: 'Data Error',
  缺少資料: 'Missing Data',
  正常: 'Healthy',
  需要處理: 'Needs Attention',
  符合: 'Match',
  未符合: 'No Match',
  新符合策略: 'New Match',
  持續符合: 'Still Matching',
  條件退出: 'Exited',
  股票池新增: 'Added to Universe',
  股票池移除: 'Removed from Universe',
  來源資訊不足: 'Source Information Missing',
  尚無訊號: 'No Signal',
  尚無資料: 'No Data',
  尚無結果: 'No Results',
  尚無報價: 'No Quote',
  尚未更新: 'Not Updated',
  尚未執行: 'Not Run Yet',
  尚未掃描: 'Not Screened Yet',
  等待行情: 'Waiting for Data',
  等待更新: 'Waiting for Update',
  執行中: 'Running',
  '執行中…': 'Running…',
  已完成: 'Completed',
  部分完成: 'Partially Completed',
  已取消: 'Cancelled',
  失敗: 'Failed',
  日期: 'Date',
  選股日期: 'Screen Date',
  應有交易日: 'Expected Session',
  最新交易日: 'Latest Session',
  美股日線: 'US Daily Data',
  歷史日線: 'Daily History',
  行情來源: 'Data Source',
  行情來源紀錄: 'Data Sources',
  資料狀態: 'Data Status',
  資料品質檢查: 'Data Quality Check',
  品質狀態: 'Quality Status',
  檢查結果: 'Check Result',
  檢查標的: 'Symbols Checked',
  日線筆數: 'Daily Bars',
  缺口: 'Gaps',
  無效: 'Invalid',
  收盤價: 'Close',
  調整收盤價: 'Adjusted Close',
  當日漲跌: 'Daily Change',
  價格變化: 'Price Change',
  市場走勢: 'Market Trend',
  '近 30 日收盤趨勢': '30-Day Closing Trend',
  '30 日走勢': '30-Day Trend',
  股票池趨勢廣度: 'Universe Trend Breadth',
  快照股票池: 'Snapshot Universe',
  當期可用日線: 'Current Valid Data',
  '資料異常／缺少': 'Errors / Missing',
  過期資料: 'Stale Data',
  '高於 MA50': 'Above MA50',
  '高於 MA200': 'Above MA200',
  '120 日報酬': '120-Day Return',
  '120 日報酬 · 前五檔': '120-Day Return · Top 5',
  持股總市值: 'Portfolio Value',
  當日損益: 'Daily P&L',
  未實現損益: 'Unrealized P&L',
  符合策略的標的: 'Strategy Matches',
  持股配置: 'Allocation',
  持股策略觀察: 'Portfolio Signals',
  持股: 'Holding',
  持倉: 'Position',
  持股數: 'Shares',
  目前持股數: 'Current Shares',
  平均成本: 'Average Cost',
  '平均成本（USD）': 'Average Cost (USD)',
  市值: 'Market Value',
  市值占比: 'Weight',
  權重: 'Weight',
  占比: 'Weight',
  相對持股成本: 'vs. Cost Basis',
  對比前一交易日: 'vs. Previous Session',
  持倉集中度與相關性: 'Portfolio Concentration and Correlation',
  持倉資料覆蓋: 'Portfolio Data Coverage',
  持倉成對相關性: 'Pairwise Holding Correlation',
  相關性分析期間: 'Correlation Period',
  相關係數: 'Correlation',
  共同樣本數: 'Shared Samples',
  可估值市值小計: 'Valued Market-Value Subtotal',
  最大單一持倉占比: 'Largest Position Weight',
  前三大持倉合計占比: 'Top-3 Combined Weight',
  分析期間: 'Analysis Period',
  '60 個交易日': '60 Sessions',
  '120 個交易日': '120 Sessions',
  '252 個交易日': '252 Sessions',
  比較標的: 'Comparison Symbols',
  標的一: 'Symbol 1',
  標的二: 'Symbol 2',
  比較調整收盤價: 'Compare Adjusted Prices',
  '正在比較…': 'Comparing…',
  標的價格比較: 'Stock Price Comparison',
  價格比較結果與資料覆蓋: 'Price Comparison and Data Coverage',
  比較摘要: 'Comparison Summary',
  共同起點: 'Shared Start',
  共同觀察期間: 'Shared Observation Period',
  期末調整價: 'Ending Adjusted Price',
  可用日報酬數: 'Valid Daily Returns',
  '匯出比較摘要 CSV': 'Export Summary CSV',
  '匯出每日比較 CSV': 'Export Daily Comparison CSV',
  交易策略: 'Trading Strategy',
  研究標的: 'Research Symbol',
  '起始資金（USD）': 'Starting Capital (USD)',
  '單邊交易成本（bps）': 'One-Way Trading Cost (bps)',
  '開始日期（選填）': 'Start Date (Optional)',
  '結束日期（選填）': 'End Date (Optional)',
  歷史回測: 'Historical Backtest',
  '歷史績效不代表未來結果。': 'Past performance does not predict future results.',
  買入持有: 'Buy and Hold',
  含費用報酬: 'Return After Costs',
  '年化報酬 CAGR': 'Annualized Return (CAGR)',
  年化波動: 'Annualized Volatility',
  'Sharpe 比率': 'Sharpe Ratio',
  最大回撤: 'Maximum Drawdown',
  已平倉勝率: 'Closed-Trade Win Rate',
  獲利因子: 'Profit Factor',
  持倉時間占比: 'Exposure',
  平均持有天數: 'Average Holding Days',
  交易紀錄: 'Trades',
  進場日期: 'Entry Date',
  出場日期: 'Exit Date',
  未平倉: 'Open',
  已平倉交易: 'Closed Trades',
  按末日收盤評價: 'Marked at Final Close',
  研究筆記: 'Research Notes',
  '研究筆記（本機儲存）': 'Research Notes (Stored Locally)',
  研究內容: 'Research Notes',
  研究標籤: 'Research Tags',
  儲存研究筆記: 'Save Research Notes',
  尚未儲存筆記: 'Not Saved',
  行情更新與策略掃描: 'Data Refresh and Strategy Scan',
  指定標的重試與掃描: 'Retry Selected Symbols and Scan',
  續跑行情更新: 'Resume Data Refresh',
  續跑行情更新與掃描: 'Resume Data Refresh and Scan',
  續跑更新: 'Resume Update',
  '收盤後自動更新（本機）': 'After-Close Auto Update (Local)',
  啟用收盤後自動更新: 'Enable After-Close Auto Update',
  儲存排程設定: 'Save Schedule Settings',
  排程股票池: 'Scheduled Universe',
  排程市場股票池上限: 'Scheduled Market-Universe Limit',
  排程執行紀錄: 'Schedule Run History',
  本機工作區備份: 'Local Workspace Backup',
  下載本機備份: 'Download Local Backup',
  本機儲存空間: 'Local Storage',
  重新整理用量: 'Refresh Usage',
  檢視各類資料用量: 'Review Storage by Data Type',
  各類資料用量: 'Storage by Data Type',
  資料類別: 'Data Type',
  筆數: 'Rows',
  內容大小: 'Content Size',
  資料庫檔案: 'Database File',
  資料庫可重用空間: 'Reusable Database Space',
  可清理重複快照: 'Removable Duplicate Snapshots',
  檢視清理範圍: 'Review Cleanup Scope',
  確認清理重複快照: 'Confirm Snapshot Cleanup',
  '匯入 CSV': 'Import CSV',
  '匯入持股 CSV': 'Import Portfolio CSV',
  '選擇 UTF-8 CSV 檔案': 'Choose UTF-8 CSV File',
  '或貼上 CSV 內容': 'Or Paste CSV Content',
  預覽匯入: 'Preview Import',
  確認匯入: 'Confirm Import',
  關閉匯入: 'Close Import',
  設定名稱: 'Preset Name',
  已儲存的設定: 'Saved Presets',
  '選擇設定…': 'Choose a preset…',
  儲存設定: 'Save Preset',
  更新同名設定: 'Update Existing Preset',
  進階篩選與儲存設定: 'Advanced Filters and Saved Presets',
  只看符合條件: 'Matches Only',
  只看尚未加入清單的新標的: 'New Symbols Only',
  只看有問題的資料: 'Issues Only',
  候選排序: 'Candidate Sort',
  排序: 'Sort',
  排序方向: 'Sort Direction',
  '由高到低／Z–A': 'High to Low / Z–A',
  '由低到高／A–Z': 'Low to High / A–Z',
  '調整股價下限（USD）': 'Minimum Adjusted Price (USD)',
  '調整股價上限（USD）': 'Maximum Adjusted Price (USD)',
  'RSI 下限': 'Minimum RSI',
  'RSI 上限': 'Maximum RSI',
  '最低量比（倍）': 'Minimum Relative Volume',
  '最低 RPS': 'Minimum RPS',
  至少符合策略數: 'Minimum Matching Strategies',
  不限: 'Any',
  股票池上限: 'Universe Limit',
  '250 檔': '250 stocks',
  '500 檔': '500 stocks',
  '1,000 檔': '1,000 stocks',
  量比: 'Relative Volume',
  成交量比: 'Relative Volume',
  符合策略數: 'Matching Strategies',
  '匯出 CSV': 'Export CSV',
  加入觀察: 'Add to Watchlist',
  '加入中…': 'Adding…',
  已在清單: 'Already Listed',
  如何閱讀這份清單: 'How to Read This List',
  每日訊號異動: 'Daily Signal Changes',
  '正在比較每日訊號…': 'Comparing Daily Signals…',
  異動類型: 'Change Type',
  '前期 → 本期': 'Previous → Current',
  原因: 'Reason',
  股票池成分: 'Universe Membership',
  選取: 'Select',
  選取本頁問題標的: 'Select Issues on This Page',
  '送出重試中…': 'Submitting Retry…',
  取消作業: 'Cancel Job',
  '取消中…': 'Cancelling…',
  作業紀錄: 'Job History',
  執行紀錄: 'Run History',
  狀態: 'Status',
  作業: 'Job',
  行情更新方式: 'Refresh Method',
  '手動／排程': 'Manual / Scheduled',
  '透過 yfinance 下載': 'Downloaded through yfinance',
  走勢標的: 'Trend Symbol',
  '，查看策略原因': ', view strategy rationale',
  我的觀察清單: 'My Watchlist',
  從你的清單中尋找符合條件的標的: 'Find matching symbols in your list',
  '留意單一標的集中度。': 'review single-stock concentration.',
  占持股: 'accounts for',
  '%，': '% of the portfolio; ',
  每檔等權計數: 'Equal-weight symbol count',
  日期一致且收盤價有效: 'Matching date with a valid close',
  不列入當期統計: 'Excluded from current statistics',
  有效樣本: 'Valid Sample',
  統計範圍與解讀: 'Scope and Interpretation',
  '這是所選市場子集的等權標的計數，不代表全美股或市值加權指數，也不是買賣建議。均線分母限當期有效收盤價與正值均線；RSI 分母限 0–100 的有效數值。資料異常、過期與缺值均排除。股票池變更會改變廣度及 RPS 排名，跨快照比較時應先核對成分。':
    'These are equal-weight counts for the selected market subset, not all US stocks or a market-cap-weighted index, and they are not trading advice. Moving-average denominators include only current valid closes and positive averages; RSI includes only valid values from 0–100. Errors, stale data, and missing values are excluded. Universe changes affect breadth and RPS, so verify membership before comparing snapshots.',
  選股範圍: 'Screening Scope',
  美股市場候選: 'US Market Candidates',
  市場候選與持股分開管理: 'Market candidates are managed separately from holdings',
  '只套用於下次「執行市場選股」；目前股票池':
    'Applies to the next Market Screen only; current universe:',
  最新結果日期: 'Latest Result Date',
  此份結果掃描標的: 'Symbols in This Screen',
  目前篩選結果: 'Current Filtered Results',
  '搜尋文字最多 200 個字元；儲存設定時保留完整文字，不會自動截短。':
    'Search text is limited to 200 characters. Saved presets retain the complete text and never truncate it.',
  '比較同股票池相鄰兩個已儲存日期，找出策略狀態的變化。':
    'Compare two adjacent saved dates in the same universe to find strategy-status changes.',
  重新讀取異動: 'Reload Changes',
  無法比較: 'Unavailable',
  '標的／變更': 'Symbol / Change',
  '前期符合，本期已不符合。': 'Matched previously but no longer matches.',
  '前期未符合，本期符合。': 'Did not match previously and now matches.',
  '前期：': 'Previous: ',
  '本期：': 'Current: ',
  符合全部條件: 'All conditions match',
  尚未符合全部條件: 'Not all conditions match yet',
  收盤未高於: 'Close is not above ',
  'MA50 未高於 MA200': 'MA50 is not above MA200',
  '股票池內 RPS': 'Same-universe RPS',
  '同日有效比較標的不足 3 檔': 'Fewer than 3 valid comparison symbols on this session',
  '策略所需指標無法計算為有限數值，暫不產生訊號':
    'Required indicators are not finite; no signal is produced',
  '整個工作區 · ': 'Whole Workspace · ',
  '尚未突破前 20 日高點': 'Has not broken the prior 20-day high',
  未形成上漲陽線: 'No bullish candle',
  低於: 'below',
  '不在 30–45 區間': 'outside the 30–45 range',
  收盤尚未轉為上漲: 'The close has not turned higher',
  '收盤低於 120 日高點的 90%': 'Close is below 90% of the 120-day high',
  比較快照: 'Compare snapshots',
  '擴充或調整股票池會改變 RPS 排名，即使股價未變也可能產生訊號異動。相對強勢只在本次所選股票池內排名，與個人持股清單的排名不同。「符合條件」是研究訊號，不是買進指令。加入觀察只新增零股持有的追蹤項目。歷史日期使用該次掃描的候選清單重算，不代表當時市場成分，存在存活者與選樣偏差。':
    'Expanding or changing the universe can change RPS and signals even when prices do not move. Relative Strength ranks only within the selected universe and differs from personal-list ranks. A Match is a research signal, not a buy order. Add to Watchlist creates a zero-share tracking entry. Historical dates recalculate the current candidate set and carry selection and survivorship bias.',
  '持股 / 均價': 'Shares / Average Cost',
  尚未持有: 'Not Held',
  '幣別 USD · 成本由使用者輸入，可隨時編輯。損益由顯示的平均成本計算，可能因四捨五入與原平台略有差異。':
    'Currency: USD. Cost basis is user-entered and editable. P&L uses the displayed average cost and may differ slightly from the source platform due to rounding.',
  '僅分析目前股數大於零的持倉，使用已儲存的調整日線。':
    'Analyzes current positions with shares above zero using saved adjusted daily data.',
  資料基準日: 'Data Date',
  觀察期間: 'Observation Period',
  估值覆蓋: 'Valuation Coverage',
  目前持倉檔數: 'Current Positions',
  依當期可用報價: 'Based on current valid quotes',
  完整持倉估值為分母: 'Uses complete portfolio valuation as denominator',
  不足三檔時合計現有持倉: 'Uses all holdings when fewer than three',
  '這是目前持股的集中度與歷史日報酬相關性，不是歷史投資組合績效或未來風險預測。':
    'This shows current concentration and historical daily-return correlation, not portfolio performance or a future-risk forecast.',
  '各配對可能使用不同共同日期；不可直接當成完整共變異數矩陣或 VaR。':
    'Pairs may use different shared dates and cannot be treated as a full covariance matrix or VaR.',
  '報價／報酬資料': 'Quote / Return Data',
  說明: 'Notes',
  部分日期可用: 'Some Dates Available',
  成對日報酬相關係數: 'Pairwise Daily-Return Correlation',
  有效樣本期間: 'Valid Sample Period',
  上一組相關性: 'Previous Correlation Group',
  下一組相關性: 'Next Correlation Group',
  '這是目前持倉的資料診斷，不是歷史投資組合績效、損失預測或買賣建議；過去相關性可能改變。':
    'This is a diagnostic of current holdings, not historical portfolio performance, a loss forecast, or trading advice. Past correlations can change.',
  '收盤突破前 20 日高點，配合上漲陽線與成交量確認。':
    'Close breaks the prior 20-day high with a bullish candle and volume confirmation.',
  '至少 21 日': 'At Least 21 Days',
  '收盤 > 前 20 日最高價（不含當日）': 'Close > prior 20-day high (excluding today)',
  '收盤 > 開盤且高於前日收盤': 'Close > open and prior close',
  '成交量 ≥ 前 20 日均量（不含當日）': 'Volume ≥ prior 20-day average (excluding today)',
  '以價格突破、陽線與相對成交量確認訊號。':
    'Confirms the signal with a price breakout, bullish candle, and relative volume.',
  '單一標的 · 僅做多': 'Single Symbol · Long Only',
  '此回測使用較早的日線或計算版本，請重新執行以取得最新結果。':
    'This backtest uses an older data or calculation version. Run it again for current results.',
  '前一日收盤確認訊號，次日開盤成交；單一標的、全額投入、僅做多；每次買賣扣 0.1% 費用與滑價。使用含股息調整日線；未平倉按末日收盤評價。基準為相同起日買入持有（未扣費）。不使用截圖成本作為回測起點。':
    'Signals are confirmed at the prior close and executed at the next open. The simulation is single-symbol, fully invested, and long-only, with 0.1% fees and slippage per side. It uses dividend-adjusted daily data; open positions are marked at the final close. The benchmark is fee-free buy and hold from the same start date. Screenshot cost basis is not used.',
  已選: 'Selected',
  收合股票池: 'Collapse Universe',
  從個人清單與市場股票池選擇: 'Choose from My List and Market Universe',
  檔可選: 'stocks available',
  已儲存於本地資料庫: 'Saved in the Local Database',
  已建選股日期: 'Saved Screen Dates',
  '保留最近 60 個交易日的檢視': 'Keeps the Latest 60 Sessions',
  可在下方設定收盤後自動更新: 'Configure After-Close Updates Below',
  '沿用目前清單，補抓尚未通過當期檢查的行情，完成後重算選股。':
    'Keep the current list, fetch quotes that have not passed the current check, then rerun the screen.',
  '已成功且通過當期檢查的行情直接沿用，其餘每檔重新下載一次。此操作不更換市場成分或股票池上限；若要找新成分，請至每日選股執行市場選股。':
    'Current successful data is reused; every remaining symbol is downloaded once. This does not change market membership or the universe limit. Run a Market Screen from Daily Screener to discover new members.',
  '預設停用；勾選啟用並儲存後才會開始排程。':
    'Disabled by default. Enable and save to start scheduling.',
  已停用: 'Disabled',
  市場股票池上限: 'Market-Universe Limit',
  設定未變更: 'No Setting Changes',
  '最新可排程交易日：': 'Latest Schedulable Session: ',
  '下次檢查目標：': 'Next Check Target: ',
  '設定更新：': 'Settings Updated: ',
  '尚無自動排程執行紀錄。': 'No automatic schedule runs yet.',
  '包含持股與成本、已儲存研究筆記、日線與研究紀錄，以及有效的篩選設定和股票池上限。':
    'Includes holdings and cost basis, saved research notes, daily data, research history, valid filter presets, and the universe limit.',
  'ZIP 檔案未加密，僅下載至本機；不包含尚未儲存的筆記草稿。不會自動備份或還原，也不會讀取其他網站設定。':
    'The ZIP is unencrypted and downloaded locally. It excludes unsaved note drafts, does not run automatic backup or restore, and does not read other-site settings.',
  '正在讀取儲存用量…': 'Loading Storage Usage…',
  最後成功更新: 'Last Successful Update',
  備註: 'Notes',
  已同步: 'Synced',
  更新失敗: 'Update Failed',
  可計算全部單檔策略: 'All Single-Stock Strategies Available',
  資料與計算方式: 'Data and Calculation Method',
  '股數與平均成本由使用者輸入，僅儲存在本地工作區。日線下載最近兩年資料，每次成功更新後完整替換該標的日線，以反映除權息調整。尚未收盤的當日 K 線不納入掃描；來源暫時不可用時保留先前資料並標示錯誤。':
    'Shares and average cost are user-entered and stored only in the local workspace. Daily history covers the latest two years and is replaced after each successful refresh to reflect corporate-action adjustments. Unclosed daily bars are excluded; previous data is retained and flagged when the source is unavailable.',
  檔持股: 'holdings',
  檔觀察: 'watchlist symbols',
  個策略: 'strategies',
  項符合: 'matches',
  檔符合: 'matches',
  '檔；目前股票池': 'stocks; current universe',
  '檔。': 'stocks.',
  檔: 'stocks',
  美股候選股票池: 'US Market Candidate Universe',
  美股候選: 'US Market Candidates',
  'Nasdaq／NYSE 美元股票：市值 ≥ 20 億、股價 ≥ 5、近三個月平均日成交量 ≥ 20 萬股；下次執行按市值取前':
    'Nasdaq/NYSE USD stocks: market cap ≥ $2B, price ≥ $5, and three-month average daily volume ≥ 200K; the next run selects the top',
  '含 ADR，實際數量依來源可用標的而定':
    'including ADRs; actual count depends on source availability',
  '執行時更新股票池與日線，再以四種策略篩選。這是市場子集，不是全美股。':
    'The run refreshes universe membership and daily data, then applies four strategies. This is a market subset, not all US stocks.',
  '部分完成：': 'Partially Completed: ',
  '更新失敗、': 'update failures, ',
  '資料異常已排除、': 'data errors excluded, ',
  '缺少行情；請查看資料管理；': 'missing quotes. Review Data Management. ',
  '有效歷史尚未達部分策略觀察期，並非更新失敗':
    'valid histories have not reached some strategy lookback periods; these are not update failures',
  匯出全部: 'Export All',
  顯示: 'Showing',
  '目前沒有可用的 120 日報酬樣本。': 'No valid 120-day return samples are available.',
  排除: 'Excluded',
  異常: 'Errors',
  缺少: 'Missing',
  計算: 'calculated',
  快照: 'snapshot',
  占: 'accounts for ',
  最近: 'latest',
  個交易日: 'sessions',
  '可用／': 'Available / ',
  可用: 'Available',
  '估值採目前股數與最新完成交易日的未調整收盤價；相關性採調整收盤價的相鄰 XNYS 交易日日報酬。缺日或無效日線不補值，過期標的不納入；每對至少 40 筆共同觀測。':
    'Valuation uses current shares and unadjusted closes from the latest completed session. Correlation uses adjacent XNYS daily returns from adjusted closes. Missing or invalid sessions are not filled, stale symbols are excluded, and each pair requires at least 40 shared observations.',
  '每組使用共同且相鄰交易日的有效日報酬，至少需要':
    'Each pair uses valid daily returns from shared adjacent sessions and requires at least',
  '筆；單檔樣本足夠仍不代表兩檔有足夠共同樣本，各組分別判定。係數介於 −1 與 1，缺值不補零，未列自我相關。':
    'observations. Adequate single-symbol history does not guarantee enough shared samples. Each pair is evaluated separately; coefficients range from −1 to 1, missing values are not zero-filled, and self-correlation is omitted.',
  至: 'to',
  至少: 'At least',
  日: 'days',
  次: 'times',
  起始資金: 'Starting Capital',
  筆已平倉: 'closed',
  另有: 'plus',
  筆: 'records',
  '選股完成：掃描': 'Screen complete: scanned',
  '與上次結果相同；': 'unchanged from the prior result; ',
  請查看資料管理: 'review Data Management',
  尚未啟用: 'Not Enabled',
  '正在檢查資料品質…': 'Checking Data Quality…',
  '資料源標的資訊格式無效；未替換原有資料':
    'The source returned invalid symbol metadata; existing data was preserved',
  市場候選: 'Market Candidates',
  'AlphaView · 美股研究版': 'AlphaView · US Stock Research',
  第: 'Page ',
  '檔，以調整收盤價計算；屬歷史排序。':
    'stocks, calculated from adjusted closes; historical ranking.',
  筆紀錄: 'records',
  紀錄: 'records',
  變化: 'Change',
  前期: 'Previous',
  本期: 'Current',
  已不: 'no longer ',
  組: 'pairs',
  未調整收盤價: 'Unadjusted Close',
  完成交易日: 'completed session',
  交易日日報酬: 'session daily returns',
  無效日線: 'invalid daily data',
  缺日: 'missing sessions',
  不補值: 'are not filled',
  過期標的不納入: 'stale symbols are excluded',
  共同觀測: 'shared observations',
  每對: 'each pair',
  相鄰: 'adjacent',
  相關性採: 'correlation uses',
  估值採: 'valuation uses',
  策略掃描: 'Strategy Scan',
  已排除: 'excluded',
  續跑保留: 'resume reused',
  已通過日線: 'passed daily-data validation',
  '持股數與平均成本由使用者輸入，僅儲存在本地工作區。日線下載最近兩年資料，每次成功更新後完整替換該標的日線，以反映除權息調整。尚未收盤的當日 K 線不納入掃描；來源暫時不可用時保留先前資料並標示錯誤。':
    'Shares and average cost are user-entered and stored only in the local workspace. Daily history covers the latest two years and is replaced after each successful refresh to reflect corporate-action adjustments. Unclosed daily bars are excluded; previous data is retained and flagged when the source is unavailable.',
  'SPCX 僅使用 SpaceX 上市後的資料，避免混入曾使用同代碼的 ETF。相對強度依所選股票池分開計算；市場候選不會自動成為持股。':
    'SPCX uses only data after the SpaceX listing to avoid mixing in the former ETF that used the same ticker. Relative Strength is calculated separately for each selected universe, and market candidates never become holdings automatically.',
  讀取設定中: 'Loading Settings',
  '載入排程設定中…': 'Loading Schedule Settings…',
  重新讀取排程設定: 'Reload Schedule Settings',
  異動: 'Changes',
  '股票池擴充或成分調整可能改變 RPS 排名，即使股價未變亦可能出現訊號異動。同日重跑不當成新交易日；資料不足、過期或異常不當成策略退出。股票池成分變動另列，計數不代表交易建議。':
    'Universe expansion or membership changes can alter RPS and signals even when prices do not move. Rerunning the same date is not a new trading session; insufficient, stale, or invalid data does not count as a strategy exit. Membership changes are listed separately, and counts are not trading advice.',
  '估值採目前股數與最新已完成交易日的未調整收盤價；相關性採調整收盤價的相鄰 XNYS 交易日日報酬。缺日或無效日線不補值，過期標的不納入；每對至少 40 筆共同觀測。':
    'Valuation uses current shares and the unadjusted close from the latest completed session. Correlation uses adjacent XNYS daily returns from adjusted closes. Missing or invalid sessions are not filled, stale symbols are excluded, and each pair requires at least 40 shared observations.',
  與: 'and',
  頁: '',
}

const orderedTranslations = Object.entries(translations).sort(([a], [b]) => b.length - a.length)
const textRecords = new WeakMap<Text, { source: string; applied: string }>()
const attributeRecords = new WeakMap<Element, Map<string, { source: string; applied: string }>>()
const translatedAttributes = ['aria-label', 'aria-description', 'placeholder', 'title'] as const

export function translateText(value: string, locale: Locale = 'en') {
  if (locale === 'zh-TW' || !/\p{Script=Han}/u.test(value)) return value
  let result = value
    .replace(/需要 (\d+) 日；目前 (\d+) 日/g, 'Requires $1 sessions; $2 available')
    .replace(/需要 (\d+) 個交易日；目前無資料/g, 'Requires $1 sessions; no data available')
  for (const [source, translation] of orderedTranslations) {
    if (result.includes(source)) result = result.split(source).join(translation)
  }
  return result
    .replace(/(\d[\d,.]*)\s*檔/g, '$1 stocks')
    .replace(/(\d[\d,.]*)\s*個交易日/g, '$1 sessions')
    .replace(/(\d[\d,.]*)\s*個策略/g, '$1 strategies')
    .replace(/第\s*(\d+)\s*\/\s*(\d+)\s*頁/g, 'Page $1 / $2')
    .replaceAll('，', ', ')
    .replaceAll('；', '; ')
    .replaceAll('：', ': ')
    .replaceAll('。', '.')
    .replaceAll('（', ' (')
    .replaceAll('）', ')')
    .replaceAll('、', ', ')
}

function translateTextNode(node: Text, locale: Locale) {
  if (node.parentElement?.closest('[translate="no"]')) return
  const current = node.data
  let record = textRecords.get(node)
  if (!record || current !== record.applied) record = { source: current, applied: current }
  const next = translateText(record.source, locale)
  record.applied = next
  textRecords.set(node, record)
  if (current !== next) node.data = next
}

function translateAttributes(element: Element, locale: Locale) {
  if (element.closest('[translate="no"]')) return
  let records = attributeRecords.get(element)
  if (!records) {
    records = new Map()
    attributeRecords.set(element, records)
  }
  for (const attribute of translatedAttributes) {
    const current = element.getAttribute(attribute)
    if (current == null) continue
    let record = records.get(attribute)
    if (!record || current !== record.applied) record = { source: current, applied: current }
    const next = translateText(record.source, locale)
    record.applied = next
    records.set(attribute, record)
    if (current !== next) element.setAttribute(attribute, next)
  }
}

function translateTree(root: Node, locale: Locale) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, locale)
    return
  }
  if (!(root instanceof Element)) return
  translateAttributes(root, locale)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text, locale)
    else translateAttributes(node as Element, locale)
    node = walker.nextNode()
  }
}

export function LocaleBridge({ locale }: { locale: Locale }) {
  useLayoutEffect(() => {
    applyLocale(locale)
    saveLocale(locale)
    const root = document.body
    if (!root) return
    translateTree(root, locale)
    queueMicrotask(() => translateTree(root, locale))
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateTree(mutation.target, locale)
        if (mutation.type === 'attributes') translateAttributes(mutation.target as Element, locale)
        for (const node of mutation.addedNodes) translateTree(node, locale)
      }
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...translatedAttributes],
    })
    return () => observer.disconnect()
  }, [locale])
  return null
}
