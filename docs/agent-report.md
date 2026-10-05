# Trading Agent 日報

版本：`alphaview-agent-report-v1`。2026-10-01 Trading Agent Harness 新增：針對**一個模擬帳戶、一個已完成交易日**，把「成交、損益、勝率、最大單筆虧損、成本、Jev 延遲與費用」以及自動化、斷路器與資料新鮮度整理成一頁，可下載為自含的靜態 HTML 或成交 CSV。所有數字都來自既有本機紀錄，沒有推估、沒有補值。

## 讀取內容

| 區塊 | 來源 | 不可用時 |
| --- | --- | --- |
| 帳戶 | `paper_accounts` + `paper._valuation(db, account, session)` | 缺價時 `equity` 為 null，`coverage.missing` 列出缺價代碼 |
| 淨值 | `paper_nav_snapshots`（`alphaview-paper-analytics-v1`）：所選交易日或之前最後一筆，與更早一筆相比 | 未擷取、非所選日、估值不完整都給 `session_change_reason`；區間報酬與最大回撤沿用 `paper_analytics._daily_series`，區間有缺口就為 null |
| 當日成交 | `paper_ledger.kind='simulated_fill'`，以提案 `preview_json.as_of` 等於所選交易日歸屬 | 沒有成交時各合計為 0 |
| 區間統計 | 最近 N 個 XNYS 交易日內的提案成交；勝率 = 已實現損益 > 0 的賣出 ÷ 全部賣出；最大單筆盈虧為單筆賣出的已實現損益 | 沒有賣出時勝率、最大盈虧為 null 並附原因 |
| 自動化 | `agent_automation_attempts` 當日嘗試、狀態計數、啟用任務數、待審提案數、next-open 佇列狀態計數 | 表不存在時該欄為 null |
| Jev | `jev_decision_runs.as_of` 等於所選日：次數、狀態計數、pass/fail/unavailable 合計、平均延遲、估算費用（輸入 token × $0.042／百萬，2026-09-30 公開價目） | 沒有紀錄表時 `available: false` |
| 斷路器 | 若存在 `circuit_breakers.evaluate(db, account_id, session)` 則呼叫 | 模組不存在或評估失敗時 `available: false` 與原因 |
| 資料新鮮度 | 每檔持股的 `bars` 最大日期是否早於所選交易日 | 早於或缺資料即列入 `stale_symbols` |

所選交易日不可晚於最新完成交易日（422）；非 XNYS 交易日可查詢但會提醒該日沒有成交或快照可歸屬。

## API

| 端點 | 參數 |
| --- | --- |
| `GET /api/trading-agent/report` | `account_id`（必填）、`session`（YYYY-MM-DD，預設最新完成交易日）、`window_sessions`（1–252，預設 20） |
| `GET /api/trading-agent/report.html` | 同上；回傳自含靜態 HTML（僅內嵌 CSS、無腳本、無外部資源、支援深淺色），`Content-Disposition: attachment` |
| `GET /api/trading-agent/report.csv` | 同上；當日成交 CSV，含 BOM 與公式字元防護 |

三個端點都在 `store.snapshot_read` 下讀取，回傳或內嵌 `engine_version`、`as_of`、`session`、`input_revision`、`generated_at`、`method`、`warnings`，不改變任何資料。

## 介面

`web/src/AgentDailyReport.tsx` 匯出 `AgentDailyReport({ account, locale })`：交易日與區間選擇、指標卡（淨值、當日變動、區間報酬與回撤、成交、已實現損益、勝率、最大虧損、Jev、自動化、待審、資料新鮮度）、斷路器狀態、當日成交表、自動化嘗試、提醒與方法，以及 HTML／CSV 下載按鈕。下載內容可能包含使用者的虛擬組合，請視同本機私人資料。

## 這不是什麼

- **紙上成交不是實盤交易**，已實現損益是模擬帳本數字，不是券商結算。
- **淨值只有已擷取的快照**；沒有擷取的交易日就沒有變動可報，不會用持倉倒推。
- **Jev 費用是估算**，依回傳 token 與公開價目計算，不是帳單。
- 勝率與最大盈虧以單筆賣出成交計算，不是完整的進出場配對；樣本很小時不代表策略可靠度。
- 報表不預測未來報酬，也不是投資建議。

實作：`alphaview/panel/agent_report.py`；測試 `tests/test_agent_report.py`、`web/src/AgentDailyReport.test.tsx`，全部使用合成帳戶與隔離資料庫。

## 營運狀態區塊（2026-10-01 補充）

報告加入 `operations`：就緒閘整體狀態與未通過／不可用的檢查、任務授權生命週期計數與需注意的任務（到期、需重新授權、即將到期）、部位停損是否啟用與觸發標的、市場風險覆蓋的區間／分數／上限／目前曝險。四塊各自獨立不可用（模組缺失或評估失敗時附原因），HTML 匯出同步列出；這些都是所選交易日的唯讀評估，不是當日實際動作紀錄。

## 決策品質與提案來源（2026-10-01 補充）

報告加入 `decision_quality`（決策結果帳本在 10 個交易日地平線、60 日窗口的 `agent_targets` 與 `jev_gate` 家族：已結算／待定數、命中率、平均超額、樣本不足旗標與原因，加上 Jev `setup_quality` 分數對實現報酬的 Spearman 秩相關）與 `provenance_counts`（所選交易日提案依來源與閘門標籤的計數，見 `docs/proposal-provenance.md`）。兩者都是唯讀推導，帳本缺資料時整塊附原因不可用；HTML 匯出同步列出。
