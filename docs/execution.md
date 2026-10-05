# 執行層與上線就緒路線圖

版本：`alphaview-execution-v1`；Alpaca 委託政策 `alphaview-alpaca-paper-orders-v1`。2026-10-01 使用者授權朝「可自動調倉交易的 Trading Agent」開發，本層是那條路的最後一段：把一份已通過檢查的紙上提案送到**執行目標**。入口：`#agent-portfolio` → 選擇帳戶 → **交易代理**。

目前只有兩個目標，都是 paper：

| 目標 | 行為 | 需要 |
| --- | --- | --- |
| `paper_ledger` | 與手動「接受並模擬執行」完全相同：原子寫入本機模擬帳本 | 帳戶版本一致、未暫停、提案仍當期 |
| `alpaca_paper` | 依提案逐筆送出 **DAY 委託**（預設市價；可改為限價，見下節）到 `paper-api.alpaca.markets`（先賣後買） | Alpaca Paper 連線已設定、以確認字串 `ENABLE PAPER ORDERS` 啟用委託、每次送出勾選確認 |

沒有實盤券商目標。傳輸層只接受 Paper 主機與固定路徑；`api.alpaca.markets` 或任何其他主機都會被拒絕。

## 流程與保護

1. **提案必須仍然有效**：與手動接受相同的檢查——最新完成交易日、行情 `input_revision`、帳戶版本、暫停開關、預覽重新驗算的雜湊一致。任何一項改變都是 409，不會用過期的參考價送單。
2. **風險斷路器**先跑：`circuit_breakers.guard_fill` 在自己的短交易內評估日損、最大回撤與當日成交筆數；觸發時帳戶自動暫停並拒絕送出（見 `docs/circuit-breakers.md`）。
3. **前置交易檢查全部 fail-closed**：每次最多 N 筆、每筆參考金額上限、股數在九位小數下不可為零、股數不得超過決策日本機成交量的參與率上限（成交量缺失＝不能檢查＝不送出；不縮單、不重新分配）。
4. **先記錄、再送出**：submission 與每筆 order 先寫入 `execution_submissions`／`execution_orders`（狀態 `pending`），提案改為 `submitted_external`（避免同一提案再被本機接受），交易提交後才開始送單。
5. **逐筆送出、冪等**：`client_order_id = av-<proposal16>-<symbol>`。第一筆傳輸失敗（逾時、網路、5xx）時該筆為 `unknown`，其餘標 `skipped` 不送；重複的 `idempotency_key` 只回放紀錄，永遠不重送。
6. **核對**：`reconcile` 以券商編號或 client id 查詢；`404` 不當作「未送出」的證明（保持 unknown）；狀態由所有委託推導（`unknown` 優先，其次仍在工作，其次終態混合）。
7. **取消**：只對 `accepted`／`partially_filled` 且已有券商編號的委託送 `DELETE`，需附目前狀態（`expected_status`）防止舊畫面誤操作；取消請求成功後為 `cancel_requested`，再核對取得終態。

Alpaca 的成交**不會回寫本機模擬帳本**：兩本帳各自獨立，畫面與每日報告分開顯示；請以核對結果為準。

**無人值守**：伺服器每 120 秒自動核對仍在工作或未知的 Alpaca 送出紀錄（每輪最多 10 筆，只在委託已啟用時執行；只查詢，不送單、不取消）。自動化任務把 `execution_target` 設為 `alpaca_paper` 且模式為自動時，排程通過全部限制與斷路器後會直接送出 Alpaca Paper 委託，任務嘗試狀態為 `submitted`；預設仍是本機帳本。

## 委託型態與限價帶

2026-10-01 Harness 依對標（Lean 的委託型別與 VWAP 執行模型、Nautilus 的委託狀態機、qlib 的 `limit_threshold`）新增**連線層級的委託型態**，存於 Alpaca 連線設定的 `order_style`（與 `order_caps` 並列；舊設定檔沒有此欄位時視為市價）：

| 欄位 | 值 | 說明 |
| --- | --- | --- |
| `type` | `market`（預設）／`limit` | 整個連線共用，每次送出時固定 |
| `limit_band_bps` | 0–500，預設 50 | 限價帶：買單限價＝參考價 ×（1 + 帶/10000），賣單＝參考價 ×（1 − 帶/10000） |
| `time_in_force` | `day` | 只支援當日有效 |

限價以 Decimal 計算、四捨五入到美分（價格低於 1 美元時保留四位小數，依 Alpaca 規則）；每筆限價在送出前記錄於送出紀錄的 `summary.limit_prices`（以 `client_order_id` 為鍵），委託列顯示 `limit_price`。提案任一筆**缺有限正參考價**時整個送出以 422 `reference_unavailable` 拒絕，不會降級成市價單，也不會送出其餘委託。送出的 payload 為 `type=limit`、`limit_price=<字串>`；市價流程完全不變。

限價單可能整天未成交而到期，或只部分成交後到期／取消：核對時保留券商回報的 `filled_qty`／`filled_avg_price`，該委託為終態；送出紀錄狀態由「委託狀態＋已成交數量」推導——到期或取消前已有成交的委託視為**終態部分成交**，整筆送出為 `mixed`（終態，不再自動核對），明細附 `partial_fills` 計數。本層仍不估算成交機率、不自動改價或重送；限價帶不是滑價模型。

**操作待辦**：`/api/portfolio-agent/inbox` 的 `execution_events` 由 Alpaca 委託紀錄推導（成交、部分成交、到期、取消、拒單、結果未知各一種事件，鍵為 `execution:<order_id>:<kind>`），重讀不重複、不另存資料表；`counts.execution_attention` 計拒單、未知與部分成交的數量。

## 委託清掃與樣式覆寫

**暫停即清掃**（對標 Nautilus／Lean：停機必須處理在途委託，不只是擋新單）：殺手開關開啟（帳戶控制）或斷路器把帳戶暫停（`guard_fill`、手動評估）後，在暫停**提交之後**、交易之外呼叫 `execution.cancel_working(account_id, reason)`：帳戶所有送往 Alpaca Paper、仍為 `pending`／`accepted`／`partially_filled` 的委託各處理一次——從未送出的 `pending` 直接標 `skipped`（不呼叫券商）；有券商識別的各送**一次** DELETE，成功為 `cancel_requested`，券商無法連線則該筆改為 `unknown` 交給核對迴圈，**不會再送第二次**；券商拒絕取消記錄 `cancel_rejected` 但狀態不變。清掃結果記錄在每筆受影響送出紀錄的 `summary.kill_switch_sweep`（時間、原因、逐筆動作），帳戶控制回應附 `execution_sweep`，斷路器狀態附同名欄位。券商問題只回報、不會把暫停回滾；第二次清掃找不到未完結委託時回 `nothing_to_do`。交易代理分頁在有未終態送出紀錄時提供「取消所有未完結委託」按鈕（需勾選確認），同樣規則。

**樣式覆寫**：送出時可帶 `order_style_override: {type: market|limit, limit_band_bps?}` 只對這一筆送出改寫連線層級的委託型態；省略限價帶則沿用連線設定的帶。送出紀錄記錄 `summary.order_style`（實際採用）與 `order_style_source: connection|override`；覆寫不改連線設定，也不能繞過「委託能力需以確認字串啟用」。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/execution/targets` | 可用目標、上限、實盤不可用的原因 |
| `POST /api/execution/accounts/{id}/proposals/{proposal}/submit` | `{target, expected_account_version, idempotency_key, acknowledge_external, order_style_override?}`；201 回傳 submission（`summary.order_style_source`） |
| `POST /api/execution/accounts/{id}/cancel-working` | `{expected_account_version, reason}`；對未完結 Alpaca 委託各送一次取消請求，回傳逐筆動作與計數（冪等） |
| `GET /api/execution/accounts/{id}/submissions?limit=` | 歷史（摘要） |
| `GET /api/execution/submissions/{id}` | 完整明細含每筆委託與券商回應摘要 |
| `POST /api/execution/submissions/{id}/reconcile` | 向 Alpaca 核對未終態委託 |
| `POST /api/execution/orders/{id}/cancel` | `{expected_status}` |
| `POST /api/execution/reconcile-open` | 立即執行一次無人值守核對（與背景迴圈相同） |
| `POST /api/alpaca-paper/orders-policy` | `{expected_version, orders_enabled, confirmation?, max_order_notional_usd, max_orders_per_submission, max_volume_participation_pct, order_type=market\|limit, limit_band_bps}`；重新設定金鑰會自動回到停用與市價 |

錯誤為 `{code, message}`。所有寫入以帳戶版本與 `expected_version` 保護；讀取端點共用 SQLite 快照；執行紀錄不改變行情 `input_revision`。

## 這不是什麼

- 不是實盤交易，也沒有實盤開關。Alpaca Paper 的成交價、部分成交與拒單規則由 Alpaca 決定，與本機模擬的參考價、費用模型不同。
- 沒有智慧下單（限價只是「參考價 ± 固定帶」的單一價格；沒有分批、TWAP、改價或追價）、沒有盤中監控、沒有自動重送。未知結果需要人核對。
- 暫停清掃只送取消請求，不保證在成交前到達；已成交的部分不會被撤回，清掃後仍要核對。
- 沒有多券商；`execution_orders` 的狀態字彙是本機正規化後的結果，不是 Alpaca 原始狀態的完整鏡像（原始狀態保留在 `broker` 欄位）。
- 送到 Alpaca 的委託不會產生本機帳本的成交、成本或損益。

## 上線就緒路線圖（尚未實作，作為決策清單）

2026-10-01 補充：paper 無人值守的就緒閘 `alphaview-readiness-v1`（`docs/readiness.md`）已實作，只判定 blocked／paper_ready／not_ready，刻意沒有 `live_ready`；純減倉例外（`docs/circuit-breakers.md`）讓停損出場可在暫停時送出；任務授權的到期與重新授權（`docs/mandate-lifecycle.md`）已實作，帳簿核對見 `docs/book-reconciliation.md`。下表其餘項目仍未實作。

要把這條 paper 管線變成「可以正式上線、讓大家使用」的產品，以下每一項都是獨立的工程與合規決策，任何一項未完成都不應對外提供實盤：

| 項目 | 目前狀態 | 需要的工作 |
| --- | --- | --- |
| 實盤券商轉接 | 無；傳輸層拒絕非 Paper 主機 | 獨立 `alpaca_live` 目標、獨立金鑰檔與確認字串、每日金額硬上限、雙人／二次確認、交易時段檢查、更完整的委託型別與部分成交處理 |
| 使用者與權限 | 單一使用者、loopback | 帳號系統、每人獨立資料庫或租戶隔離、API 認證與速率限制、審計日誌、TrustedHost 與 CORS 重新設計 |
| 金鑰保管 | 本機 0600 檔案 | 作業系統金鑰圈或 KMS、加密靜態儲存、輪替與撤銷流程、絕不進備份 |
| 監控與告警 | 本機待辦與每日報告 | 委託狀態異常、核對失敗、斷路器觸發、資料過期的通知管道；健康檢查與 SLO |
| 資料 | Yahoo 日線、可能過期 | 具授權的即時或延遲行情、公司行動處理、供應商健康狀態；見 `docs/data-provider-evaluation.md` |
| 法規與免責 | 研究工具聲明 | 依所在司法管轄區確認是否構成投資建議或代客操作、風險揭露、使用條款；「創造獲利」不能作為產品承諾 |
| 驗證 | 合成測試、mock 券商 | 以真實 Paper 帳戶做端到端演練（含部分成交、拒單、逾時）、回測與 paper 一致性長測、演練失敗案例 |
| 發布 | 本機 `serve` | 打包、版本、遷移策略、回滾、灰度與停損計畫 |

在這些完成前，本專案維持：paper 執行、逐筆確認、本機資料、不承諾報酬。

實作：`alphaview/panel/execution.py`、`alphaview/panel/alpaca_paper.py`（`_request`、`orders-policy`）、前端 `web/src/PortfolioTradingAgent.tsx`、`execution-model.ts`；測試 `tests/test_execution.py`、`tests/test_execution_limit.py`（限價、終態部分成交、待辦事件）、`web/src/PortfolioTradingAgent.test.tsx`（合成帳戶、假券商，不呼叫真實 Alpaca）。

## 自動化斷路器的暫停清掃

2026-10-03：自動化任務在 `agent_automation._execute_locked` 觸發斷路器並**首次暫停帳戶**時，也接入同一個 `circuit_breakers._sweep_if_paused` 流程。帳戶暫停、版本遞增與任務重新授權旗標先提交，之後才經既有執行層取消該帳戶尚在工作的 Alpaca Paper 委託；清掃結果保存於嘗試紀錄的 `result.circuit_breaker.execution_sweep`，以及受影響送出紀錄的 `summary.kill_switch_sweep`。本次自動化仍為 `blocked`，不建立新提案或送出新委託。

清掃以帳戶為範圍，因此本機帳本或僅產生提案的任務若觸發帳戶暫停，也會處理該帳戶先前已送出的 Alpaca Paper 委託。只有 `paused_now=true` 才自動清掃；帳戶本來已暫停，或 `auto_pause=false` 時，不追加取消請求。委託能力未啟用時保留取消失敗原因且不呼叫券商；取消傳輸結果未知時保留 `unknown`，交由核對確認，不自動重送。同一交易日的任務重試仍回放既有嘗試。

這不是新的交易授權，也不是自動平倉：不開放實盤，不繞過 Alpaca Paper 的委託啟用條件，不取消已成交紀錄。具有有效任務授權、純減倉政策且未觸發斷路器的既有 Alpaca Paper 純減倉流程仍只送賣單，本機模擬帳本不因外部送出而改寫。

驗證：`tests/test_automation_sweep.py` 使用獨立合成資料庫與假券商，涵蓋暫停先提交、各任務目標、重試冪等、傳輸未知、委託能力停用、關閉自動暫停，以及已授權純減倉送出；沒有 schema 或計算方法變更。

## 已保存的清掃原因檢閱

2026-10-03：交易代理的單筆 Alpaca Paper 執行明細讀取既有 `summary.kill_switch_sweep`，在重新整理後仍可查看最近清掃的時間、觸發原因與逐筆原狀態、動作、錯誤碼、訊息及已記錄的 HTTP 狀態。左側委託狀態仍採目前的 `orders[].status`；例如歷史 `accepted → cancel_requested` 可以與後來的 `filled` 同時顯示，不能把取消請求當成已取消。

原因選單只篩選**所選送出紀錄的全部委託**，分開列出目前記錄的錯誤和最近清掃的原因，附匹配數及顯示數。同一委託可具有多項原因，計數不可相加當作總數。這不涵蓋帳戶所有歷史紀錄；上方既有歷史清單仍只載入最近 20 筆。切換送出紀錄或帳戶後重設篩選，篩選本身沒有請求或寫入，也不會觸發核對、取消或重送。

`skipped` 先標示「略過（未送出）」，只有保存的 `swept`、`not_sent`、`limit_price_missing` 或身分一致的清掃紀錄才能補充原因；不再由 `skipped` 猜成「前一筆未知」。舊紀錄缺少收據、欄位不完整、身分不符、同一委託有重複項目，都明確列為證據不可用；無法對應的項目另列數量。最近清掃未包含的委託顯示沒有對應紀錄，不補造清掃動作。

這不是新的清掃政策、券商即時查詢、完整事件歷程或交易建議。既有欄位只保存每筆送出紀錄最近一次受影響清掃，後續清掃可能取代它；檢閱功能不改 API、schema、方法版本、授權或既有委託操作。

驗證：`npm test --prefix web -- execution-review.test.ts PortfolioTradingAgent.test.tsx` 使用合成資料，涵蓋保存後重載、原因匹配、狀態與歷史動作分離、缺損／重複證據、切換明細、帳戶切換的延遲回應，以及篩選不增加請求或送出動作。
