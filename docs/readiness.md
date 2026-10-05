# 無人值守就緒閘（僅 paper）

版本：`alphaview-readiness-v3`（2026-10-03 新增本機券商核對收據檢查；保留先前四項 v2 功能）。2026-10-01 Harness 依對標（Vibe-Trading `sdk_order_gate.py` 的 fail-closed 模式、ai-hedge-fund「晉級預設需人工核准」）新增。入口：Agent 投資組合 → 交易代理分頁最上方。API：`GET /api/trading-agent/readiness?account_id=`（只讀、`snapshot_read`，回傳 `engine_version`、`as_of`、`input_revision`、`method`）。

## 它判斷什麼

以最新完成交易日、同一份讀取快照，逐項檢查本機紀錄：

| 檢查 | 通過條件 | 缺證據時 |
| --- | --- | --- |
| `mandate_active` | 此帳戶有一個啟用中的任務，並記錄其 `execution_target` | 未通過 |
| `jev_gate_declared` | 任務的 Jev 閘已啟用，或明確保持關閉（記錄為 `declined`，不評判） | 沒有任務 → 不可用 |
| `circuit_breakers_configured` | 日損、回撤、單日成交筆數三項上限皆已設定 | 未通過並列出缺項 |
| `position_stops_enabled` | 部位停損已啟用且至少設定一種停損比例 | 未通過 |
| `alpaca_paper_orders` | 目標為 `alpaca_paper` 時：連線已設定、委託已以確認字串啟用、上限存在；目標為 `paper_ledger` 時不適用 | 讀不到設定檔 → 不可用 |
| `broker_book_reconciled`（v3） | `alpaca_paper`：最新保存收據為 `matched`、擷取不超過 15 分鐘，且最新完成交易日、連線版本、券商帳戶、行情版本、執行帳簿指紋均相符 | 沒有收據、過期／失效／券商不可用 → 不可用；漂移、無法解釋、待定、未知 → 未通過；`paper_ledger` → 不適用 |
| `no_stale_unknown_orders` | 沒有更早交易日送出、結果仍為 `unknown` 的委託 | — |
| `recent_attempts_clean` | 最近 5 次自動化嘗試沒有 `failed` | 沒有任何嘗試 → 不可用 |
| `nav_snapshot_current` | 最新完成交易日已有完整淨值快照（每日報告的淨值變動才可用） | 未通過 |
| `history_sessions` | 至少 20 個交易日有完整淨值快照（觀察值為實際天數） | 未通過 |
| `account_not_paused` | 帳戶暫停開關未啟用 | 未通過 → 整體 `blocked` |
| `no_tripped_breaker` | 斷路器沒有觸發（不可用的檢查會另列警告） | 未通過 → 整體 `blocked` |
| `schema_current` | 資料庫 schema 簽章在 `backup_preflight.KNOWN_SCHEMAS` 登記為 `current` | 未登記 → 不可用 |
| `position_stops_evaluable`（v2） | 停損已啟用且每檔持股都可判斷（有當期價格與進場紀錄） | 停損未啟用 → 不適用；有持股無法判斷 → 未通過並列出 |
| `regime_overlay_configured`（v2） | 市場風險覆蓋已啟用且上限可計算（分數完整） | 未啟用 → 不適用（記錄操作者的選擇）；啟用但分數不完整 → 未通過 |
| `corporate_actions_clear`（v2） | 沒有持股在進場後偵測到「疑似拆併股且歷史可能混合基礎」 | 所有持股都沒有進場紀錄 → 不可用 |
| `outcome_hit_rate`（v2） | 決策結果帳本 10 日地平線：規則工作流目標與 Jev 門檻任一家族已結算 ≥ 20 筆且命中率 ≥ 40%（`decision_ledger.hit_rate_flags`） | 已結算不足 20 筆 → 不可用；≥ 20 筆且 < 40% → 未通過 |

整體結果：`blocked`（暫停或觸發）、`paper_ready`（全部通過或不適用）、否則 `not_ready`。v2 的四項檢查（2026-10-01 補充）只影響 `not_ready`，不會造成 `blocked`；`outcome_hit_rate` 與自動化共用同一個判定（`decision_ledger.hit_rate_flags`，家族為工作區層級的規則目標與 Jev 門檻），自動化在同樣條件下只在嘗試結果與提案理由附上 `outcome_hit_rate_low` 警示，不阻擋。**沒有 `live_ready`**：本產品沒有實盤目標，這個閘只能證明 paper 自動化具備無人值守的防護與紀錄。

## 這不是什麼

- 不是績效或策略有效性的判斷；通過只代表防護、紀錄與連線齊備。
- 不會自動改任何設定或晉級任務；每項都要到對應面板手動補齊。
- 缺證據一律「不可用」，不當作通過；不可用的斷路器檢查不會觸發，也不代表安全。
- 不回傳或保存金鑰；Alpaca 檢查只使用連線身份、版本與啟用狀態。

實作：`alphaview/panel/readiness.py`；前端 `web/src/AgentReadiness.tsx`；測試 `tests/test_readiness.py`、`web/src/AgentReadiness.test.tsx`（合成資料與隔離資料庫）。

## v3 核對收據

這項檢查只讀 `broker_reconciliation_receipts` 的最新一份收據與本機連線設定，不會呼叫券商、保存新收據、送單或改動 `input_revision`。新的券商讀取須由使用者到 Alpaca Paper 頁按「核對帳簿」。收據擷取失敗會留下最新的不可用結果，不會退回更早的成功收據；詳見 `docs/book-reconciliation.md`。

15 分鐘（900 秒）與交易日是兩項獨立限制，必須同時滿足；同一天的收據也可能過期。時間在未來或格式無效都不可用。此檢查只影響 `paper_ready`／`not_ready`，不增加 `live_ready` 或自動晉級。前端每 30 秒重新讀取本機就緒狀態，避免過期收據一直顯示就緒；重新讀取失敗時移除先前就緒標示。

這不是即時券商核對：收據對應擷取當時的全專案 Alpaca 執行帳簿，不能排除擷取之後在券商外部發生交易。保存的是已知證據的新鮮度，不是未來交易或績效的保證。
