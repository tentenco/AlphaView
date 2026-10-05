# 策略→紙上橋接（Research Desk → paper 提案）

版本：`alphaview-strategy-bridge-v2`（v1 保留為歷史提案版本）。2026-10-03 起，驗證沿用診斷期間與風險設定；訊號仍取最新完成交易日。把回測研究台的一組策略設定，在**最新完成交易日**的收盤上讀出訊號，直接變成指定紙上帳戶的完整目標配置與提案——也就是文章說的「回測之後用同一套規則去 paper trade」。入口：回測研究台 → 排行「為什麼？」→ 診斷面板底部「做成紙上提案」。

## 決策規則

對每個代碼在最新完成交易日讀 `entry`、`exit`、`valid`（與研究台回測同一個 `signals()`）：

| 情況 | 決策 | 權重 |
| --- | --- | --- |
| 沒有本機日線、日線無效或最後一根不是最新完成交易日 | `unavailable` | 0（附原因；不用舊收盤代替） |
| 帳戶已持有且出場訊號成立 | `exit` | 0 |
| 帳戶已持有且沒有出場訊號 | `hold` | slot |
| 未持有、進場訊號成立且指標已定義 | `enter` | slot |
| 其他（含指標暖機中） | `flat` | 0 |

`slot = min(max_weight_pct, floor(100 / 代碼數 × 1e8) / 1e8)`；歸零或不可用的席位保留現金，不重新分配。目標涵蓋每個請求的代碼（0 表示賣出至零），因此帳戶裡未列入請求的持倉在提案中也會被賣到零——請先檢視紙上預覽。

## 與回測的差異（這不是什麼）

- 回測在訊號日後的下一個開盤成交；橋接的提案要等使用者在 Agent 投資組合明確接受，接受時以當時的參考價模擬。未接受的提案在下一個交易日就會過期。
- 停損／停利狀態不會跨日保存；每天只看當日訊號與持倉。
- 允許標的、現金、單檔上限、暫停開關等限制由紙上模組檢查，以 `paper_preview.violations` 呈現，不在橋接層重複。
- 不是自動交易：橋接只產生提案；要自動化，請用自動化任務（其規則工作流是四策略共識，不是研究台的參數化策略）。

## 驗證閘（2026-10-01 補充）

建立提案前，橋接會以 `alphaview-validation-v1` 對同一組設定逐標的驗證（走動式一致性、固定種子 bootstrap、機率化／去膨脹 Sharpe；`folds` 預設 4，可選 2–8，`trials` 預設 1），再依 `validation.mode` 決定：

| 模式 | 行為 |
| --- | --- |
| `require_pass`（預設） | 任一標的 `fail`，或全部標的都不可用 → 預覽回 `would_refuse: true`，`paper-proposal` 回 422 `validation_failed`（附 `failing`、`unavailable`、`overridable`）。`fail` 可以用 `validation.acknowledge_fail: true` 明確覆寫（閘門狀態 `overridden`，並寫進提案理由）；全部不可用不能覆寫。`warn` 與部分不可用照常建立，附警告。 |
| `warn_only` | 只把逐標的判定與警告附在結果與理由上，不擋。 |
| `off` | 不驗證；理由記 `validation=off`。 |

判定摘要（版本、模式、閘門、整體、計數、folds、trials、`input_revision`、是否覆寫、逐標的 verdict，以及 request 中的風險和期間）以 `validation={…}` 附在提案 `rationale` 內，超過紙上理由長度時只省略逐標的明細。閘門只能證偽：通過或 warn 不代表未來有效；它與紙上限制（`paper_preview.violations`）是兩個獨立關卡。

## API

| 端點 | 說明 |
| --- | --- |
| `POST /api/research-desk/paper-preview` | `{account_id, expected_account_version, symbols[1–10], config, max_weight_pct=20, risk, test_start, test_end, folds=4, trials=1, validation={mode, acknowledge_fail}}` → 逐代碼決策、證據、目標、驗證閘結果（`validation`、`would_refuse`）與紙上預覽（唯讀，不會因驗證拒絕） |
| `POST /api/research-desk/paper-proposal` | 同上加 `idempotency_key`；驗證閘擋下時 422 `validation_failed`；201 回傳 `paper_proposal`；相同 key 回放 |

實作 `alphaview/panel/strategy_bridge.py`；前端 `web/src/ResearchDeskPaperBridge.tsx`；測試 `tests/test_strategy_bridge.py`（14）、`tests/test_strategy_bridge_validation.py`（驗證閘）與 `web/src/ResearchDeskPaperBridge.test.tsx`，全部使用合成日線與隔離資料庫。

## 診斷設定與一致快照（v2）

從診斷頁開啟橋接時，帶入該次診斷的 `risk`、有效起日與請求迄日。API 未提供這些欄位時維持研究台預設；提供時使用同一組設定做逐標的驗證，並把設定保存在提案理由中。變更期間或風險後，必須重新預覽才可保存；相同冪等 key 配不同設定回 409。

這些設定只控制歷史驗證，不會把歷史日期當作當前訊號，也不會覆寫紙上帳戶的成交費用或限制。訊號、驗證與紙上預覽共用同一個唯讀快照；保存前在紙上模組的寫入交易內核對 `input_revision`，資料已改變就拒絕發布。舊提案不重算或改寫。
