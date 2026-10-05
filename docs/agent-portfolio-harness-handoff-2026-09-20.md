# Agent Portfolio Harness 斷點交接

本輪原訂 2026-09-20 10:42:57–15:42:57（Asia/Taipei）執行五小時，重點為 GitHub 對標與新增本機 Agent 投資組合功能。因 Agent 用量限制中斷，系統記錄中斷前執行 5,334 秒（約 89 分鐘），**未跑滿五小時**。本機 watcher 保存到期 STOP；使用者 22:56 要求接續後，只收束原有接線、修正整合問題、驗收與整理交付，未開新功能波次。

基線 HEAD 為 `1bf6b12217342c376f9abba2127b2d73fc0393ce`，開工時工作樹乾淨。此次不 commit、stash、reset、push 或部署；所有原始碼留在工作樹。接手時以當下 `git status` 為準。

## 已交付範圍

入口為 `#agent-portfolio`。方法與 API 以 [Agent Portfolio](agent-portfolio.md)、[本機模型](local-agent.md)、[次日開盤模擬](paper-next-open.md)、[CLI](portfolio-agent-cli.md) 為準。

| 使用者路徑 | 已完成內容 |
| --- | --- |
| 獨立模擬帳戶 | 自訂虛擬現金、完整目標權重、精確股數與現金、版本化限制、暫停、預覽／保存／明確接受、原子帳本與去重 |
| 規則 Agent | 四個可追溯角色、當期候選池、固定槽位配置、證據及排除原因、保存 run、轉成待審 paper 提案 |
| 持續運行 | 任務預設關閉、固定或每日重選候選、每完成交易日一次、只產提案或明確啟用自動模擬、等待／阻塞原因 |
| 本機模型 | 現有 Ollama 模型清單、禁止 cloud、一次真實推論的三觀點、已驗證 fact 引用、分析／保守模式、持久作業與取消、來源與模型指紋、paper bridge |
| next-open 委託 | 開盤前凍結股數／來源／上限，等待指定日完成後 raw open，整批風險重驗與模擬、取消、原授權重試、歷史修正失效、記錄日與假設執行日分列 |
| 績效與研究 | 不可覆寫 NAV、成本統計、最多五方案情境比較、固定期間跨帳戶比較；缺口不補值、不產不完整期間績效 |
| 日常操作 | 跨帳戶提案／排程待辦、獨立實驗分支、JSON／CSV 帳本與提案收據、本機 JSON CLI |

GitHub 研究包含 25 個甄選候選、6 組官方 API 搜尋及 26 份官方設計來源。這是候選清單的人氣排序，不是全 GitHub 排名；參考分層與流程，沒有複製競品程式。見 [對標文件](github-agent-portfolio-benchmark-2026-09-20.md)。

## 明確未完成的斷點

**調倉偏離與間隔門檻尚未交付。** `agent_automation.py` 仍為 `alphaview-agent-automation-v1`，沒有新增政策欄位、schema、觸發計算或 skipped 流程。`web/src/PortfolioRebalanceTrigger.tsx` 與 `rebalance-trigger.ts` 是未掛載草稿，不能直接接上目前 API。詳細設計在本輪 artifact `rebalance-trigger-design.md`。

後續實作需用新 automation-v2 與獨立 trigger-v1：兩個可關閉門檻為包含現金的最大配置偏離百分點，以及同任務／帳戶實際成交後的已完成交易日數；同時啟用採 AND。缺資料等待且不占當日次數，未達門檻保存 skipped 且不建提案；保留 v1 歷史。next-open 成交間隔依指定 execution session，不能按 signal day 或記錄時間計算。紙上模組的條件式 `validated_target_weights` hook 只是預備契約，現行 automation-v1 不會啟動。

固定股票池歷史逐日重算／回放未開始設計或實作。既有 next-open 未來授權不能直接當成任意歷史回放；本機日線可能經事後修訂，今日股票池也不能代表歷史成分。

## 維持的產品邊界

- 所有執行皆本機 paper，沒有券商、真實下單、付費 API、通知或外部發布；不複製真實持股到示範帳戶。
- 普通 paper-v2 使用最新完成日的 raw close；next-open-v1 是事前授權、指定日完成後的 raw open 情境，不是當時真實成交。
- 沒有部分成交、流動性、稅、公司行動帳務模型。next-open 偵測疑似調整因子變化會阻擋，不自行猜測拆股。
- 目前跨帳戶 inbox 整理提案與排程；next-open 佇列於單一帳戶分頁查看。帳戶 JSON 匯出不是全部任務、模型、NAV、queue 或完整工作區備份。
- 排程需本機服務運行，不自行下載、不補跑所有錯過日期。本機模型作業中斷會留下狀態，不假裝自動續跑。
- 新 schema 共 25 個表，獨立 fresh／upgrade 合成 fixture 的 fingerprint 相同：`8a1f5650abe50f8d7df39196c8797646795777169cb33e4612cdde0ee64d1ad4`。備份預檢明確認得新 schema；未知 schema 仍拒絕。

## 本機檢閱與接續

產物位於 `artifacts/harness-2026-09-20-agent-portfolio/`：`review.html`、`state.json`、`events.jsonl`、`STOP`、截圖、驗收 log、`source-checkpoint.zip` 與 `source-manifest.json`。Source checkpoint 只有變更原始碼，不含真實 DB、模型、node_modules 或完整 checkout；保留未掛載草稿，需搭配本文件判讀。

靜態檢閱為 `http://127.0.0.1:8878/review.html`；合成示範為 `http://127.0.0.1:8879/#agent-portfolio`，使用 artifact 中的獨立 `ui-demo.db`。8876 保留正式本機應用、8877 是其他專案，不得停止。此輪沒有以新程式初始化真實 `data/panel.db`。

示範含四個明確標記的合成標的、20 個合成交易日的 NAV，以及缺口帳戶。歷史示範透過實際 paper 結算／NAV 函式生成，不能用來宣稱市場績效。本機 `qwen3.5:4b` 已完成一次 analysis 與一次 conservative 瀏覽器路徑；來源全為合成資料。

下輪候選為：完成調倉門檻、版本化允許標的清單、可處理的本機事件待辦、固定股票池歷史前綴回放、純本機 execution adapter 狀態契約。HTML 支援勾選與下載任務 JSON；**候選清單不自行構成下一輪開發授權**。

最終驗收：pytest **1,043 通過**（2 個既有 warnings）、Vitest **286 通過／51 檔**、Prettier、TypeScript／Vite build、`git diff --check` 均通過。Vite 主 chunk 546.39 kB 是既有警告，未調高門檻掩蓋。英文深色／390px 次日委託頁已檢查，修正控制列按鈕換行後頁寬為 390px。完整結果記錄在同目錄 `state.json` 與 `final-*.log`。曾發現 next-open scheduler 啟停回傳值及空佇列搶鎖整合問題，修正後才重新驗收；不得引用較早失敗的 log 為最終結果，也不得將 focused tests 代替全專案關卡。
