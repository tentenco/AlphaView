# 風險斷路器（paper 帳戶）

版本：`alphaview-circuit-breaker-v1`。2026-10-01 Trading Agent Harness 新增。位置：Agent 投資組合 → 配置與提案 → **風險斷路器**（允許標的政策下方）。這是交易代理提示中「日損上限、最大回撤、kill switch」規則在本機 paper 帳戶上的實作：達到上限就拒絕新的模擬成交，並可自動啟用既有的帳戶暫停開關。

## 三個限制

| 檢查 | 觀測值 | 基準 | 觸發條件 |
| --- | --- | --- | --- |
| `daily_loss` 每日虧損上限（0.1–50%） | 最新完成交易日的完整 paper 估值 | 該交易日**之前**最後一筆已擷取且估值完整的 NAV 快照 | 變動 ≤ −上限 |
| `max_drawdown` 最大回撤上限（1–90%） | 同上 | 所有已擷取且估值完整的 NAV 快照中的最高淨值 | 變動 ≤ −上限 |
| `max_fills_per_session` 單日成交筆數上限（1–100） | 提案 `as_of` 等於該交易日的 `simulated_fill` 帳本筆數 | — | 筆數 ≥ 上限 |

未設定（null）的限制為 `disabled`。估值不完整（持股缺當日 USD 收盤價）或沒有可用快照時，該檢查為 `unavailable`，附原因（`valuation_incomplete`、`no_prior_nav_snapshot`、`no_nav_snapshot`）；**不可用永遠不會觸發**，也不會用舊價或其他帳戶的資料補值。快照來自「淨值與成本」的明確擷取或自動化任務完成時的擷取。

## 觸發後的行為

- 任一檢查 `tripped`，即拒絕新的模擬成交（手動接受提案回 409，訊息以 `circuit_breaker_tripped` 開頭；自動化任務的當日嘗試記為 `blocked`／`circuit_breaker_tripped`，不建立提案）。
- `auto_pause: true`（預設）時，第一次觸發會把帳戶 `kill_switch` 設為 1 並提升帳戶版本，寫入一筆不可覆寫的 `tripped` 事件。既有的暫停語意接手：所有手動與自動模擬都停止，待審提案失效。
- `auto_pause: false` 時只拒絕成交、不暫停帳戶；仍寫入 `evaluated` 事件，可在事件表看到觸發證據。
- 帳戶維持暫停直到使用者在帳戶控制列手動「恢復模擬執行」；恢復會寫入 `resumed` 事件。恢復後若條件仍成立，下一次成交或評估會再次觸發。
- 單日成交筆數上限在下一個交易日重新計數，但已暫停的帳戶不會自動恢復。

評估在接受提案前於獨立的短交易中執行，所以即使成交被拒絕，自動暫停與事件都會保存。已完成接受的冪等重送不會重新評估，仍回傳原收據。

## 設定與版本

`GET /api/paper/accounts/{id}/circuit-breakers` 回傳目前政策、`policy_version`（沒有設定紀錄時為 1）、逐檢查狀態與帳戶暫停狀態；只讀，不寫事件。`PUT` 帶 `{policy, expected_version}` 整份替換，版本不符回 409 `policy_changed`；第一次保存後版本為 2，每次保存加一並寫入 `policy_changed` 事件。`POST …/evaluate` 立即評估並套用自動暫停（`trigger: manual`）。`GET …/events?limit=1..100` 依時間倒序列出事件。

介面的表單保留未保存的草稿；當後端版本改變時才重新載入。「立即評估」可能暫停帳戶，畫面會重新載入帳戶狀態。

## 純減倉例外（reduce-only）

預設下，暫停開關與觸發中的斷路器會擋下整份提案，包括只賣不買的減倉。2026-10-01 對標 freqtrade `/stopentry` 與 QuantDinger「出場、停損與緊急動作繞過過濾」後，政策新增 `reduce_only_allowed`（預設關閉，存在既有 `policy_json`，沒有 schema 變更）：

- 每份紙上預覽都會附 `risk_direction`：以同一次估值比較每個標的的目標權重與目前權重，`reducing`（每個標的都不高於目前權重、沒有新標的，因此現金只會增加）、`increasing`、`mixed`、`unchanged`；估值不完整時為 `null`。這是附加中繼資料，接受時的驗算指紋會忽略它，舊提案仍可驗證。
- 開啟後，帳戶暫停或斷路器觸發時，只有 `risk_direction = reducing` 的提案能建立為可執行、通過接受前的斷路器守衛，以及送出執行層；其他方向照舊被擋，409 訊息加註 `reduce_only` 提示。部位停損產生的提案（其餘持倉維持目前權重、觸發者歸零）符合條件。
- 例外不會解除暫停，也不會清除觸發狀態；自動暫停照常發生。手動輸入其餘持倉權重時，略低於目前顯示權重即可維持「純減倉」。

## 這不是什麼

- 只作用於本機 paper 帳戶；沒有實盤帳戶、券商連線、盤中價格或停損單。
- 純減倉例外不是「安全模式」：它只放行賣出，不判斷賣出是否明智，也不放行任何買入或新標的。
- 不是逐部位停損；它看的是整個帳戶的淨值變化與成交次數。
- 基準只來自已擷取的快照。沒有擷取快照的帳戶，每日虧損與回撤檢查永遠不可用；這是刻意的，避免用今天的持倉倒推歷史淨值。
- 觸發不代表策略有錯，只代表超過使用者設定的容忍度；恢復與否由使用者決定。

暫停即清掃（2026-10-01）：`guard_fill` 或手動評估讓帳戶由運作轉為暫停時，交易提交後呼叫 `execution.sweep_after_pause`，對該帳戶未完結的 Alpaca Paper 委託各送一次取消請求（結果附在回應的 `execution_sweep`，券商問題只回報不回滾暫停）；見 `docs/execution.md` 的「委託清掃與樣式覆寫」。

實作：`alphaview/panel/circuit_breakers.py`；接受提案與帳戶控制的掛鉤在 `paper_portfolio.py`，自動化掛鉤在 `agent_automation._execute_locked`；前端 `web/src/PortfolioCircuitBreakers.tsx`；測試 `tests/test_circuit_breakers.py`、`web/src/PortfolioCircuitBreakers.test.tsx`，全部使用合成帳戶與隔離資料庫。
