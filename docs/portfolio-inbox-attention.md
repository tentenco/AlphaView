# 所有帳戶待辦：需要處理清單（attention）

2026-10-01 Harness 補完操作者動態，2026-10-03 新增版本化「已檢閱」收據，當時待辦方法為 `alphaview-portfolio-inbox-v2`。本輪加入未結案提案的來源篩選，方法升為 `alphaview-portfolio-inbox-v3`；既有嚴重度與全域總數不變，檢閱收據仍為 `alphaview-inbox-acknowledgement-v1`。入口：Agent 投資組合 → 所有帳戶待辦 → 頂部「需要處理」。

## 來源與嚴重度

事件由同一讀取快照的既有紀錄推導；每筆有穩定鍵，重讀不重複。只有檢閱收據另行保存，不保存事件完整內容或筆記。

| 來源 | kind | 嚴重度 | 導向 |
| --- | --- | --- | --- |
| 任務授權生命週期（`agent_automation.lifecycle`） | `mandate_expired`、`mandate_reauth_required` | critical | 自動化分頁（mandate_id） |
| 同上 | `mandate_expiring_soon` | warn | 自動化分頁 |
| 帳戶殺手開關 | `account_paused` | warn | 配置與提案 |
| 斷路器（`circuit_breakers.evaluate`） | `circuit_breaker_tripped` | critical | 風險與資料 |
| 暫停時的委託清掃（`execution_submissions.summary_json.kill_switch_sweep`） | `kill_switch_sweep` | warn | 交易代理（proposal_id） |
| 部位停損（`position_stops.evaluate`） | `position_stop_tripped` | warn | 風險與資料 |
| 公司行動偵測（`corporate_actions.account_summary`，只看進場後事件） | `corporate_action_mixed_basis`（疑似拆併股且日線基礎可能混用） | critical | 風險與資料 |
| 同上 | `corporate_action_since_entry` | info | 風險與資料 |
| Alpaca 委託紀錄 | `execution_rejected`、`execution_unknown_outcome`、`stale_unknown_order`（送出交易日早於最新完成交易日仍未知） | critical | 交易代理（proposal_id、order_id） |
| 任一來源模組評估失敗 | `source_unavailable` | info | 無 |

排序：critical → warn → info；同嚴重度內以時間新到舊（沒有時間者最後）。委託類只取最近 200 筆候選。

## 檢閱狀態

按「標示已檢閱」只記錄已看過這份內容。預設仍顯示全部事項；「只看未檢閱」方便逐項閱讀。原有緊急、注意與總數仍包含已檢閱事件，不因檢閱而歸零。可以切回全部事項，再按「標示未檢閱」撤銷。篩選與進行中的保存狀態不會被背景輪詢清掉。

收據以事件鍵保存 SHA-256 內容指紋、帳戶識別、布林狀態、版本與時間。指紋包含完整推導事件（嚴重度、標題、描述、時間、帳戶、導向等），排除收據欄位；不是只比對事件鍵。同鍵內容變更會自動顯示未檢閱，舊收據版本仍保留，下一次寫入必須帶上目前版本。不存在收據時版本為 0。

寫入在 `BEGIN IMMEDIATE` 內以同一連線重新推導事件，核對帳戶、事件指紋與收據版本。事件已消失、內容改變、帳戶不符或另一視窗更新收據均回 409，不寫半筆收據。相同內容、版本與期望狀態的重複請求不增加版本。`source_unavailable` 永遠保留為未檢閱，也不能透過寫入 API 標示已檢閱。

## 這不是什麼

- 已檢閱不代表已處理、風險解除、恢復授權或可以交易；風險檢查與嚴重度維持原有狀態。
- 不是通知系統：不推播、不寄信；重新整理仍重新推導事件。
- `source_unavailable` 只表示該來源這次無法評估，不代表沒有事項。
- 不會替使用者處理任何事：每筆只導向對應分頁，接受、續期、恢復都仍是明確操作。

## API

`GET /api/portfolio-agent/inbox` 以唯讀快照回傳 `attention: [{key, kind, severity, account_id, account_name, at, title_zh, title_en, detail, navigation, event_fingerprint, acknowledgement}]`。`acknowledgement` 包含 `engine_version`、`can_acknowledge`、`acknowledged`、`version`、`acknowledged_at`、`updated_at`。新增 `counts.attention_unreviewed／attention_unreviewed_critical／attention_unreviewed_warn`；原本三個風險總數保留。

`POST /api/portfolio-agent/inbox/attention/acknowledgement` 接受嚴格輸入 `{event_key, account_id, acknowledged, expected_version, expected_fingerprint}`，不接受額外欄位。回應包含收據方法版本、`as_of`、`input_revision`、`changed` 與更新後的 `event`。成功或衝突後前端重新整理；409 說明會保留，不顯示假的保存成功。

資料表為 `inbox_attention_receipts`。寫入只改收據，不增加行情 `input_revision`，不更動帳戶版本、提案、委託或自動化狀態。實作 `alphaview/panel/inbox_acknowledgements.py`、`portfolio_inbox.py` 與 `web/src/PortfolioInbox.tsx`；測試 `tests/test_inbox_acknowledgements.py`、`tests/test_portfolio_inbox_attention.py`、`web/src/PortfolioInbox.test.tsx`（合成帳戶與來源）。

## 未結案提案的來源篩選

`GET /api/portfolio-agent/inbox?source=...` 接受 `all`（預設）、`automation`、`local_agent`、`jev`、`position_stops`、`strategy_bridge`、`rules_workflow` 或 `unknown`。其他值回 422。篩選只影響 `proposed`／`blocked` 提案，不作用於風險事項、檢閱收據、次日開盤委託、執行事件、自動化狀態或最近結果。

分類重用 `paper.provenance`（`alphaview-proposal-provenance-v1`）既有規則，不新增自然語言推論：

- 自動化、本機模型與 Jev 使用保存的來源欄位，`evidence_kind=structured`。此標籤是保存的來源種類；授權是否仍有效由原有的新鮮度與來源驗證另外判斷。
- 部位停損、策略橋接與規則工作流沿用既有固定程式前綴，`evidence_kind=program_marker`，畫面明確稱為「來源標記」。這些理由前綴可以複製，不能驗證作者，也不構成交易授權。
- 沒有明確來源證據時，本頁把既有分類器的 `manual` 預設值映射為 `unknown`，原因為 `no_explicit_source_marker`；不把歷史未標記提案推定為手動。多個結構化來源同時存在則為 `conflicting_source_markers`。兩種情況都顯示「來源不明」。任意自由文字不會因此被認定為自動化來源。

同一唯讀快照逐筆分類完整未結案清單，計算每個來源的總數，篩選後才按建立時間及提案識別由新到舊分頁。只有目前頁面的提案做詳細的新鮮度檢查。每筆 `provenance` 附分類器版本、`source`、`tags`、`evidence_kind` 和未知原因；原有 `source` 相容欄位保留，不用來執行新的篩選。

`proposal_sources` 包含 `selected`、全域 `total`、每類 `counts` 與 `provenance_engine_version`。`pagination.total` 是選定來源的完整符合筆數；`counts.open_proposals` 與帳戶各自的未結案總數始終是全域值。空結果明確顯示「這個來源目前沒有未結案提案」，不暗示全部帳戶沒有待辦。

前端切換來源會重設提案頁碼、取消舊讀取，等待期間隱藏不相符的提案；延遲回應不能覆蓋新篩選。背景重新整理保留來源與檢閱篩選。進行中的檢閱收據寫入仍以原事件指紋及版本完成，之後才讀取新來源的提案；不清除或重寫風險狀態。

這是資訊整理功能，不是作者認證、風險解除或提案接受流程。來源標籤不能繞過接受時的帳戶、行情、來源授權與風險重查。沒有新增 schema，也不新增任何執行動作。
