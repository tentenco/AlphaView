# 自動化任務的授權生命週期（到期與重新授權）

2026-10-01 Harness 依對標（Vibe-Trading `sdk_order_gate.py` 的 fail-closed 授權：`consent.expires_at` 過期即拒絕、量化越界即 `PAUSE_FOR_REAUTH`）為本機自動化任務加上**時間盒授權**，當時沿用 `alphaview-agent-automation-v2`。2026-10-03 的結果證據降級另升為 `alphaview-agent-automation-v3`；以下到期與續期規則不變。舊任務的到期日為空（不設到期）。

## 規則

- `expires_on`：任務可行動的**最後一個 XNYS 交易日**（含）。建立或修改時驗證：格式 `YYYY-MM-DD`、必須是交易日、不早於最新已完成交易日、最多 180 個交易日之後。留空表示不設到期。
- `sessions_remaining`：從最新已完成交易日算起，到到期日為止還剩幾個交易日；到期日就是今天時為 0。
- `reauth_required`／`reauth_reason`：以下事件會把該帳戶**所有已啟用**任務標成需重新授權（不改任務版本、不停用）：
  - 風險斷路器在任何非唯讀評估中觸發（`circuit_breaker_tripped:<check>`），不論是否自動暫停；
  - 使用者手動開啟帳戶暫停開關（`kill_switch_enabled`）。
  只關閉暫停開關**不會**恢復授權；唯一的恢復方式是明確續期。
- 每次嘗試在候選選擇、規則研究與行情完整性檢查**之前**，於 `BEGIN IMMEDIATE` 內檢查生命週期：到期 → 嘗試記錄為 `blocked`／`mandate_expired`；需重新授權 → `blocked`／`mandate_reauth_required`。即使沒有當期行情或選股快照，仍會顯示授權阻擋原因。手動執行同樣受限。
- 被生命週期擋下時，當日嘗試與任務狀態一併保存；不選候選、不做研究、不呼叫 Jev、不建立提案、不模擬、不送委託，也不補建 NAV 快照。嘗試的 `run_id` 為空字串，表示沒有建立研究工作流；當日名額已消耗，重複手動執行或排程回傳同一筆紀錄。
- 研究完成後、保存規則工作流的寫入交易內會再次檢查授權，避免研究期間發生的撤銷被漏掉；提案建立與接受仍保留原有交易內重新核對。授權預檢不替代版本、輸入快照、帳戶或風險檢查。
- 自動化來源的紙上提案在接受時也重新檢查生命週期；任務到期或需重新授權後，先前的自動化提案不能再被接受（409）。

## 狀態

| `lifecycle` | 意義 |
| --- | --- |
| `active` | 已啟用、未到期、不需重新授權 |
| `expiring_soon` | 剩餘 ≤ 3 個交易日（含今天到期） |
| `expired` | 最新已完成交易日已超過到期日（優先於其他狀態） |
| `reauth_required` | 斷路器觸發或手動暫停後尚未續期 |
| `inactive` | 排程未啟用（且未到期、不需重新授權） |

`GET /api/agent-automation/mandates`／`/{id}` 回傳 `expires_on`、`sessions_remaining`、`reauth_required`、`reauth_reason`、`lifecycle`、`lifecycle_message` 與最近 5 筆 `lifecycle_events`（`reauth_required`、`renewed`，含時間與原因）。就緒閘 `alphaview-readiness-v1` 的 `mandate_active` 在 `expired`／`reauth_required` 時為 `fail`（`reason_code` 同名），`expiring_soon` 仍為 `pass` 但附原因。

## 重新授權／續期

`POST /api/paper/accounts/{account_id}/mandates/{mandate_id}/renew`，body `{expected_version, expires_on?, acknowledge: true}`：

- `acknowledge` 必須為 `true`（明確的人為動作），否則 422；版本不符 409；任務不屬於該帳戶 404；`expires_on` 的驗證同建立。
- 清除 `reauth_required`／`reauth_reason`，寫入新的到期日（`null` = 不設到期），任務版本 +1，並在 `lifecycle_events` 記錄 `renewed`（含前一個到期日與被清除的原因）。
- 和修改任務一樣，版本變更會讓進行中或待接受的自動化提案失效（`mandate_renewed`），本交易日不再次自動執行。
- 已記錄的生命週期阻擋也不會因續期而重試同一交易日；下一個已完成交易日具備有效授權與完整資料時，恢復原有流程。舊版本的手動執行仍回傳 409。

前端：Agent 投資組合 → 本機自動化 → 建立任務時可填「授權到期日」；任務卡片顯示生命週期標籤、到期日與剩餘交易日，以及「重新授權／續期」表單（日期 + 確認勾選）。到期或需重新授權時，立即執行按鈕停用。

## 單次結果降級與任務授權

v3 的 [結果證據守衛](decision-outcomes.md#自動化結果證據與人工審閱) 只改變當次嘗試的有效模式。相關來源家族至少 20 筆已結算、命中率低於 40%，或本輪證據無法評估時，自動執行改為人工審閱；其他檢查通過後才保存提案，不自動模擬或送出 Paper 委託。

這不會停用任務、改寫 `mode`、設定 `reauth_required` 或變更版本。任務的到期與重新授權規則仍先執行；沒有有效授權便不做結果評估與研究。使用者明確接受提案仍須通過既有版本、授權、資料與風險檢查。續期不重跑已降級的同日嘗試，下一個交易日才重新評估。原有 v1／v2 嘗試不補寫或重解釋 v3 證據。

## 這不是什麼

- 不是實盤授權；一切仍只在本機紙上帳本與明確啟用的 Alpaca Paper。
- 到期不會自動平倉或撤單；它只停止**新的**自動行動。已送出的 Alpaca Paper 委託仍由執行層核對。
- 重新授權只清除旗標與延後到期，不會檢查或重設斷路器；斷路器觸發中的帳戶仍會在下一次嘗試被擋。
- 續期的到期日由使用者申報，系統不會建議期限。

實作：`alphaview/panel/agent_automation.py`（`lifecycle`、`_claim_lifecycle_block`、`require_reauth`、`renew_mandate`、`_validate_expiry`）、`circuit_breakers.enforce` 與 `paper_portfolio.update_controls` 的掛鉤、`readiness.py`；前端 `web/src/PortfolioAutomation.tsx`；測試 `tests/test_mandate_lifecycle.py`、`tests/test_mandate_preflight.py`、`web/src/PortfolioAutomation.test.tsx`（合成資料）。Schema 以 ALTER 新增 `agent_mandates.expires_on`、`reauth_required`、`reauth_reason`、`lifecycle_json`，簽章已登記於 `backup_preflight.KNOWN_SCHEMAS`；2026-10-03 的提早預檢沿用既有 schema 與計算方法。
