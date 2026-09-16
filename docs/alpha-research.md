# Alpha Picks 與 Alpha 實驗室

Alpha Picks 是快速研究首頁；Alpha 實驗室用來檢視歷史訊號與假設配置。兩者都讀取本機行情和選股快照，不會下單。

## 每日使用

1. 開啟 `http://127.0.0.1:8876/#alpha`，先確認選股日期與資料覆蓋。市場探索使用美股候選池；我的清單使用持股與觀察名單。
2. 四張策略卡列出各策略符合條件的前三檔，按跨策略分數排序。下方 Alpha 清單提供持有／觀察／新標的、RSI、RPS 與分數拆解。
3. 「權重與提醒」可設定相對權重、Alpha 分數及最低符合策略數。套用前會預覽候選新增與移出數量。
4. 星號保留研究清單，不改動股數。選擇 2–5 檔可以進入同期間比較；「加入觀察」建立零股觀察項目。
5. 「試算」以額外資金、假設成交價與個股跌幅，計算整股數量、集中度與股票持倉總額影響。未使用資金與帳戶現金不計入分母；不修改持倉。
6. 查看右側提醒，或從頂部鈴鐺進入。檢閱只表示已看過；新交易日、門檻或嚴重程度改變會再次提醒。
7. 保存今日快照，或下載每日 HTML 摘要。HTML 可以離線閱讀、列印為 PDF；CSV 匯出目前篩選的全部結果，包含權重、門檻與快照 ID。

## 更快檢視與追蹤

卡片適合深入看幾檔候選；表格適合一次掃讀更多排名。兩種檢視共享篩選、星號與比較選擇。展開分數可看各策略得分及原始條件原因。

「四策略交集」可點選兩個策略，直接查看同時符合者；交集統計以雙方皆有資料的標的計算，不受權重調整影響。

「今天有哪些變化」讀取相鄰兩個交易日的現有快照，以目前權重區分新進、持續符合、退出與資料覆蓋變化。缺資料不當作退出；不用先手動保存每日快照。

星號候選可在「研究進度」設為待研究、研究中、持續觀察或封存，補上一句追蹤理由與下次複查日期。日期依瀏覽器本地日曆判斷，不會自動發送通知。記錄最多 200 筆，即使移除星號或離開股票池也會保留；個股詳細筆記仍沿用工作區資料庫。未儲存草稿暫存在目前分頁，正式保存後才納入研究備份。

「加入觀察」會改變工作區輸入版本。首頁的「同步重算兩個股票池」使用已儲存行情重算市場和個人清單，不下載新行情；其中一個範圍失敗時，另一個完整結果仍會保留，並標示部分完成。

## 桌面提醒與保存比較

桌面提醒預設關閉。使用者可以在持倉提醒區按鈕啟用瀏覽器通知，選擇只收高嚴重度或所有風險條件。只對目前有效、未檢閱且尚未送出的條件發送；資料缺漏不發成風險通知。需要本機頁面開啟及瀏覽器／作業系統許可，不提供關閉頁面後的伺服器推播。

價格比較頁可保存最多 20 組 2–5 檔與觀察期間。「保存目前選擇」與「保存已計算結果的設定」分開，避免把未提交的選擇和舊結果混在一起。載入組合不自動重算，可恢復載入前選擇；移除後可立即復原。不在目前股票池的成員保留並提示替換，不自動補入其他股票。

## Alpha 研究備份

資料管理的「Alpha 研究資料搬家」匯出瀏覽器內的權重與命名方案、星號、研究進度、比較組合、已檢閱提醒、每日快照、實驗摘要與候選檢視。匯入先預覽各類筆數及權重差異，再明確套用；預覽後資料改變會要求重新預覽。匯入是取代這些類別，不是合併。較舊備份沒有新增類別時，套用會清空該類資料。

這份 JSON 不含行情、持倉與詳細筆記；那些資料使用工作區 ZIP 備份。也不包含桌面通知許可、尚未儲存的分頁草稿或其他網站資料。

## 進階研究工具

- **權重方案：**在首頁編輯區或實驗室命名保存最多 12 組權重與 Alpha 門檻；不包含持倉提醒設定。載入先進編輯區，可恢復前一組權重。首頁需按套用才更新排名。
- **權重方案比較：**實驗室可同時比較最多四組內建或自訂方案。每組使用相同日期與股票池，列出候選數與各股是否符合，依符合方案數與代碼排序。這是規則敏感度，不是績效優劣排名。
- **RSI／RPS 分布圖：**與候選篩選共用資料，圓點大小表示 Alpha 分數，顏色表示持有關係。點選圖形或用下方選單查看；沒有有效 RSI／RPS 的候選不繪製，仍可在其他檢視研究。
- **個別價格提醒：**在權重與提醒中為實際持倉設定 USD 收盤上限或下限。只有最新已完成交易日的有效未調整收盤價可觸發；不檢查盤中觸價、不下單。拆股後需自行檢視價格門檻。變更先進設定草稿，套用後才啟用。
- **候選與持倉走勢比較：**候選分數展開區或比較選擇列可分析 1–5 檔與最多 100 檔持倉的成對日報酬相關性。使用 60／120 交易日、至少 40 筆共同有效相鄰日報酬；缺日不補值。每對日期可能不同，不能當成完整共變異數矩陣。全部持倉當期報價有效才顯示權重；CSV 保留來源版本與樣本日期。
- **研究交接包：**複製最多五檔候選的權重、指標、符合原因與來源快照，貼給研究 Agent。剪貼簿不可用時下載 Markdown；不包含股數、成本、個人筆記或完整持倉清單，也不會自動傳送到任何 AI 服務。

首頁的範圍、篩選、比較選擇，以及實驗室的權重與參數會暫存在目前分頁。重新開啟後保留編輯設定，但不把先前的計算結果當成目前結果。這些分頁草稿不在研究備份中。匯入研究備份後，實驗室若已有自己的分頁設定，需按「重新讀取首頁權重」才會改用匯入權重。

桌面左下角可展開導覽文字；使用說明提供各研究流程入口。進階圖表與實驗內容按需載入，不影響先看首頁候選。

## 分數定義

`分數 = 100 × 符合策略權重總和 ÷ 全部啟用策略權重總和`

- 預設海龜突破、均線趨勢、回檔觀察、相對強勢各 25%；至少兩項符合且分數至少 50 才是 Alpha Pick。
- 零權重策略不計分、不計入最低符合數；缺資料不把權重分配給其他策略。
- 全部啟用策略都要有可用資料，才能成為 Alpha Pick。資料過期、版本不明、股票池不符或異常日線排除於排序。
- 同分依符合策略數、同股票池 RPS、股票代碼排序。市場與個人清單的 RPS 不混用。
- 分數是規則共識，並非預期報酬或勝率。部分策略條件互斥，策略間也可能相關；高分仍可能伴隨持倉風險。
- 方法版本：`alphaview-alpha-v1`。前端即時排名與後端回放使用相同口徑。

提醒包含集中度、單日跌幅、低於 MA200／MA50、RSI 高檔及獨立資料提醒。集中度需要全部持倉的當期有效報價；均線與 RSI 使用同日個人選股快照。高 Alpha 分數不會抵銷風險提醒。

## 快照與回放的差異

手動快照記錄保存時的分數與設定，最多保留最近 20 次。同日同設定會更新；只比較相同股票池、相同正規化權重與門檻的較早交易日。新覆蓋資料、資料消失與真正訊號進出分開顯示。

Alpha 實驗室的訊號回放則把目前選擇的權重套用到已存的歷史選股，提供 5／10／20／60 交易日的 Alpha 數量、每日前 30 名及持續度矩陣。缺快照、版本已過期或股票池不一致時保留空缺。連續天數遇到缺資料就中斷；符合天數分母是該股啟用策略都有有效資料的交易日。

回放是目前股票池與目前快取資料的回看，不是當時完整市場成分，也不代表當時已實際採用這組權重。下市股缺漏、選樣偏差與歷史資料修訂會影響結果。

## 組合實驗

開啟 `http://127.0.0.1:8876/#alpha-lab`。可先修改實驗權重，再選擇：

| 參數 | 可選範圍 |
| --- | --- |
| 最近交易日數 | 10、20、40 |
| 最多持有檔數 | 3、5、10 |
| 配置調整間隔 | 1、5、10、20 交易日 |
| 起始資金 | 大於零，最多 USD 1,000,000,000 |
| 單邊成本 | 0–100 bps；預設 10 bps = 0.1% |

模型在前一交易日收盤確認 Alpha 排序，下一交易日以調整開盤價交易。取前 N 檔符合者，按成本後資產等權重配置；不足 N 檔只配置符合者，零檔則持有現金。非配置日保持原持有單位。

調整只交易新舊目標的淨差額。若配置股票不變、價格與權重也沒變，就不會為了重置等權重而先全賣再買。模型求解成本後可投資總額：`可投資額 + 成本率 × 淨交易金額總和 = 開盤資產值`。採可分割的調整單位，並非券商實際股數。

現金利息為零；期末持倉以調整收盤價估值，不強制賣出。回撤以起始資金與歷次日末資產高點計算，不是日內最大回撤。必要成交或估值缺價會阻塞整份模擬，不偷偷換股、沿用其他日期訊號或填補價格。

基準買入第一個配置日的相同清單，支付相同起始買入成本，之後持有；第一天沒有候選時是現金基準。這不是 SPY 或大盤基準。若原始組合後續缺價，基準獨立標為不可用，不能補成完整曲線。

結果包含區間報酬、日末回撤、總成本、資產曲線、每次訊號與交易日期、淨調整明細、期末配置、每日數值及來源快照。JSON 匯出保留完整結果。方法版本是 `alphaview-alpha-basket-v1`。

這是短期間、目前股票池的假設研究，不是使用者實際投資組合績效。沒有交易與現金流帳本，也沒有歷史全市場成分資料；結果不能當作樣本外驗證或未來收益保證。

## 保存實驗

實驗摘要可命名保存，最多 20 筆。比較表可只顯示相同資料版本、期間、持股數、成本、資金與調整間隔的實驗，協助隔離權重變更。

載入已存設定不會自動執行，也不改寫首頁權重。實驗室權重只有在按下「套用到 Alpha Picks」時才更新首頁；原本的持倉提醒門檻會保留。

權重、檢閱狀態、研究星號、快照和實驗摘要存於此瀏覽器。清除瀏覽器資料會刪除這些內容；資料庫行情與持倉則仍位於本機 SQLite。

## API

以下研究 API 都是唯讀計算，使用一致的 SQLite 讀取快照：

- `POST /api/alpha/replay`：`scope`、`days`、`weights`、`threshold`、`min_matches`。
- `POST /api/alpha/basket`：以上參數加 `top`、`rebalance`、`initial`、`fee_bps`。
- `POST /api/alpha/holding-fit`：`symbols`（1–5 檔）與 `window`（60／120）。

`POST /api/jobs` 的 `kind: "scan_all"` 會從本機日線重新發布兩個股票池的完整選股批次；這個作業會寫入選股紀錄，但不下載行情。

完整欄位與範圍可在本機 `/docs` 查看。不會因呼叫而下載新行情、重寫持倉或建立交易。

## English quick guide

Use **Alpha Picks** for today's cross-strategy ranking, held/watch/new labels, score explanations, local shortlist, comparisons, alerts, and offline daily briefs. **Weights & Alerts** previews additions and removals before saving.

Use **Alpha Lab** to experiment with separate weights, replay recent daily screens, or simulate a hypothetical equal-weight basket. Signals execute at the next session's adjusted open; only net allocation differences incur the specified one-way cost. Missing required prices block the run. The benchmark holds the initially selected basket, not a market index.

Save named experiment summaries to compare conditions, and export full JSON for daily values and allocation logs. Experiment settings affect the homepage only after **Apply to Alpha Picks**. These are current-universe research tools, not actual portfolio performance or point-in-time whole-market backtests.

The dashboard also offers **What Changed Today**, a strategy-overlap matrix, card/table views, and **Research Progress** with stages and review dates. **Saved Comparison Groups** preserves explicit draft or calculated-result settings. **Recalculate Both Lists** refreshes market and personal scans from cached quotes without downloading. Browser research can be exported and previewed for import under Data Management. Desktop notifications are opt-in and require the app page to remain open.

**Weight Comparison** shows same-session rule agreement across up to four named profiles. **Compare with Holdings** reports pairwise daily-return correlations and sample coverage. Custom price alerts use current unadjusted closing prices of actual holdings only. **Copy Research Handoff** creates dated context for an external research agent without sending anything automatically. Dashboard selections and lab parameters persist per tab; calculated results must be run again after reopening.

## 候選進階篩選與行事曆

Alpha 候選可依分數、符合策略數、RPS、量比或代碼排序，另可設定最低分數、最低 RPS 與最高 RSI。條件留白表示不限；套用後僅縮小目前選取的清單，缺少必要指標者不通過。排序與條件保存在目前分頁，CSV 包含這些條件與指標值。首頁總 Alpha 數與策略快速卡片仍顯示完整股票池結果，避免把個人篩選誤認為策略變更。

研究進度的「匯出全部複查日期」會建立本機 ICS，包含所有已儲存且未封存的複查日期及追蹤理由，不受當前階段篩選影響，也不包含草稿。事件使用原定日期（包含逾期項目）、全天事件與隔日排他結束日期；文字換行與 UTF-8 摺行依 [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html) 處理。請自行匯入行事曆並設定提醒。這是單次匯出，後續修改不會同步；重新匯入或修改日期時，請檢查行事曆是否產生重複事件。

**Advanced Indicator Filters** narrow the selected candidate list by minimum Alpha score, minimum RPS, and maximum RSI. Blank means unrestricted; missing required indicators are excluded. Sorting and applied conditions persist in the current tab and accompany CSV exports. **Export All Review Dates** downloads saved, nonarchived reviews as all-day ICS events, including personal tracking reasons. Import into your calendar and configure reminders there; this is an export, not ongoing synchronization.

研究快照展開後可查看保存當時的持倉提醒、數值、門檻、嚴重度與資料日，也能下載單份快照 JSON。歷史提醒不是目前風險狀態；提醒不再出現可能是持倉、設定或資料改變，不直接宣稱風險解除。每日 HTML 摘要另外記錄來源快照、輸入版本與所有自訂收盤提醒設定。

實驗筆記本可以將已存摘要設為「差異基準」。有本次有效結果且資料輸入版本、模型版本、起訖日、股票池、期間、前 N 檔、調整間隔、資金與成本一致時，才顯示本次減去基準的報酬差（百分點）、回撤差（百分點）及總成本差（USD）。權重、Alpha 門檻與最低符合數可以不同，並列出前後設定。回撤採負值，所以正差值表示本次較淺；成本正差值則表示花費較多。它不會自動選出最佳權重。

Saved experiments can serve as a **Comparison Baseline**. Differences are shown only for matching data, model, dates, scope, and allocation conditions; selection weights and thresholds remain explicitly visible. Return and drawdown changes use percentage points, while costs use USD. This does not automatically optimize weights or establish future performance.
