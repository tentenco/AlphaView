# 授權沿革與歷史狀態（由舊 CLAUDE.md 原文搬移，2026-10-02）

這裡是日期紀錄，不是待辦，也不是當次授權；目前有效的範圍摘要在 `AGENTS.md`「授權範圍」。新增授權時在最下方追加一段並同步更新 `AGENTS.md`。

## 沿革說明（舊 CLAUDE.md 開頭原文；「AGENTS.md 指向這裡」已不成立，現在規則以 AGENTS.md 為準）

這份檔案是 Claude Code 與 OpenAI Codex 在此 repo 的共用主要指引，繼承 Codex Agent 在 2026-09-05、09-07、09-15 與 Claude Code 在 09-16 累積的方法與約束。保留檔名以相容 Claude Code；`AGENTS.md` 指向這裡，兩份不要各自演化。讀完本檔後，先讀 `docs/codex-handoff-2026-09-16.md`（最新接手分析與狀態校正）；`docs/handoff-2026-09-16.md` 保留為較早的 Claude 接手快照。當次使用者明確授權決定工作範圍，舊提案不會自行啟動開發或外部動作。

## 授權紀錄

2026-09-20 使用者已授權新增朝 Agent 調倉方向發展的**本機 paper portfolio**。入口 `#agent-portfolio`，規則角色、提案、虛擬現金／持倉、費用與每日任務獨立於真實持股。明確啟用的自動模擬只寫入 paper 帳本，不是實盤授權；真實下單、付費服務與外部發布仍禁止。方法與操作見 `docs/agent-portfolio.md`。09/20 因用量限制中斷的範圍保存在 `docs/agent-portfolio-harness-handoff-2026-09-20.md`，是歷史快照。2026-09-29 接續實作已將調倉門檻掛入任務，新增版本化允許標的政策、next-open 待辦、R0 歷史前綴與純合成 execution dry-run；最新進度、限制與驗收見 `docs/agent-portfolio-harness-handoff-2026-09-29.md` 及本輪 Harness 帳本。

2026-09-21 使用者另行授權透過已登入的 Ego lite 瀏覽器，將 **Alpaca Paper API** 接入此專案。本版提供帳戶、持倉、委託、市場時鐘的唯讀 REST 連線，固定使用 `paper-api.alpaca.markets`，不包含下單或撤單。金鑰僅存 `data/` 下擁有者可讀寫的忽略檔案，不得寫進報告、測試或記憶。現有金鑰重建須先確認是否可使舊金鑰失效；連線實際是否設定，以本機 `/api/alpaca-paper/connection` 為準。見 `docs/alpaca-paper.md`。

2026-09-30 使用者另行授權接入 **TypeSafe Jev**（System One 模型）作為 Agent 工作區的**決策閘**：對已保存規則工作流的入選標的，以固定英文問題取得校準機率，由本機版本化門檻決定哪些標的保留席位、哪些歸零保留現金，再走既有紙上預覽／提案／明確接受。這是一次付費外部呼叫（費用依回傳 token 估算並保存），只送程式分桶的技術事實，不送持股、成本、筆記或任何外部文字；金鑰只存 `data/panel.jev.json`（0600、忽略），不得寫進文件、測試或記憶。沒有實盤、沒有排程自動執行、Jev 來源提案不進次日開盤佇列。方法與限制見 `docs/jev-decision-layer.md`。

2026-10-01 依使用者要求整合 Miles Deutscher 的 MIT 授權 Research Desk 概念為 **回測研究台**（`#research-desk`）：參數化策略、同窗口多策略／多標的比較、買入持有基準、樣本內／外切分、程式化虧損診斷、交易 CSV 與 Pine Script v6 匯出。只讀本機日線，保留次日開盤成交口徑（不採用上游同根收盤成交）；未採用 Binance／Alpaca 行情、CSV K 線匯入與自動下單。方法見 `docs/research-desk.md`。

2026-10-01 使用者以 `/goal` 授權 5 小時 Trading Agent Harness（`artifacts/harness-2026-10-01-trading-agent/`）：對標熱門同類專案、朝可自動調倉交易的 Trading Agent 開發。本輪新增**執行層** `alphaview-execution-v1`（目標 `paper_ledger`／`alpaca_paper`；Alpaca 委託須以確認字串啟用、逐筆確認、金額／筆數／成交量參與率上限、先記錄後送出、unknown 只核對不重送）、**風險斷路器** `alphaview-circuit-breaker-v1`（日損、最大回撤、當日成交筆數 → 自動暫停）、**每日 Agent 報告** `alphaview-agent-report-v1`、**策略→紙上橋接** `alphaview-strategy-bridge-v1`、**部位停損** `alphaview-position-stops-v1`（成本停損、進場後峰值追蹤停損、再進場冷卻；觸發只建立賣至零的提案）。自動化任務加上時間盒授權：到期日為 XNYS 交易日（≤180 日），斷路器觸發或手動暫停即需重新授權，續期須明確確認。對標結果在 `docs/github-trading-agent-benchmark-2026-10-01.md`；每日運作流程見 `docs/paper-operations-runbook.md`，本輪接手摘要見 `docs/trading-agent-harness-handoff-2026-10-01.md`。仍然只到 paper：沒有實盤券商目標，實盤與多人上線的條件列在 `docs/execution.md` 的路線圖，未實作。

## 狀態摘要（2026-09-16 快照）

- 本次 Codex 接手前 HEAD `679dd91`（2026-09-05 主線）。當時工作樹包含 Alpha 工作流、yfinance lazy Mapping 相容、`scan_all`、字級調整，以及 Claude Code 的市場風險溫度計與交接文件。這是歷史快照；目前提交狀態以 `git status`／`git log` 為準，詳細校正見 `docs/codex-handoff-2026-09-16.md`。
- 09-09 `data/panel.db` 曾不明原因變成空庫；09-15 已從 09-05 備份還原並更新持股與行情，原因仍未查明（見接手文件「風險」）。
- 下一個建議交付是隔離備份恢復的 P1-A 預覽契約，優先序與驗收見最新接手文件。三份 `docs/next-harness-*.md` 是歷史提案；其中研究階段與比較收藏已有瀏覽器版本，不能把整份提案視為全部未實作，也不能當作本次授權。
