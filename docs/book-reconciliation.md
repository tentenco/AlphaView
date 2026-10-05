# 帳簿核對：已記錄成交 vs Alpaca Paper 持倉

版本：`alphaview-book-reconciliation-v2`（保留 v1 的歷史定義）。2026-10-01 Harness 依對標（NautilusTrader 的 live reconciliation、Lean 的 brokerage 持倉同步）新增，入口在 Alpaca Paper 頁的「帳簿核對」區，**只在按下核對時讀取**。

## 規則

- 帳簿數量＝所有送往 Alpaca Paper 的執行委託（`execution_orders`，`target='alpaca_paper'`）在最近一次核對時記錄的 `filled_qty` 合計，買入為正、賣出為負；只計入本專案送出的委託。
- 券商數量＝同一個 Paper 帳戶的 `/v2/positions`；先讀 `/v2/account` 驗證帳戶身份，身份不同即整份不可用（`account_changed`）。
- 逐標的狀態：`pending`（仍有未完結委託）、`unknown`（有結果未知的委託）、`unexplained`（券商有部位、帳簿沒有紀錄，例如在 Alpaca 介面手動交易）、`drift`（差異超過 0.000001 股，或帳簿有成交但券商沒有部位）、`matched`。整體狀態取最嚴重者。
- v2：券商明確回傳部位但數量缺少、格式錯誤或非有限值時，該列為 `unavailable`，數量與差異保留空值，附 `broker_quantity_unavailable`；不當作沒有部位或一致。
- 本機模擬帳本（`paper_holdings`）只供對照顯示；它與 Alpaca 是兩套各自結算的紀錄。

## 這不是什麼

- 不是對帳修正：發現差異只會顯示，不會自動下單、不改寫帳簿或模擬帳本。
- 券商持倉與本機帳簿不是同一時刻的原子快照；盤中成交後請重新核對。
- 券商回應不可用（未設定、網路、限流、身份不同）時整份不可用，不以上次結果替代。
- 就緒閘只讀取下述本機收據，不會為了評估就緒而連線券商，也不能偵測擷取後在券商端發生的變動。

## API

`GET /api/alpaca-paper/reconciliation` → `{engine_version, as_of, input_revision, status, broker:{status, fetched_at, error, account_id}, rows:[{symbol, status, broker_qty, broker_position, booked_qty, difference, filled_orders, working_orders, unknown_orders, accounts, local_ledger}], summary, method, warnings}`，`Cache-Control: no-store`。實作 `alphaview/panel/broker_reconciliation.py`；前端 `web/src/AlpacaBookReconciliation.tsx`；測試 `tests/test_book_reconciliation.py`（假券商、合成帳戶）。

## 本機核對收據與就緒閘

2026-10-03 新增 `alphaview-reconciliation-receipt-v1`。數量比對仍使用 `alphaview-book-reconciliation-v2`。按「核對帳簿」會先讀本機來源版本，再明確擷取券商資料並保存最新一份收據。重新核對時畫面清掉前次結果；請求失敗或版本衝突不會留下看似當前一致的舊結果。

收據有效期限固定為 **15 分鐘（900 秒，含第 900 秒）**，並且必須與目前的最新完成交易日、Alpaca 連線版本、券商帳戶身份、行情 `input_revision`、執行帳簿指紋相符。指紋涵蓋所有 Alpaca Paper 執行委託紀錄與展示的本機帳本對照。超時、未來／無效時間或任一來源變更都不可用；同一天也可能失效。

- `GET /api/alpaca-paper/reconciliation/receipt` 只讀本機，回傳當前 CAS 版本、來源識別、有效期限與最新收據及失效原因；**不連線券商、不寫入**。
- `POST /api/alpaca-paper/reconciliation/receipt` 接受 `expected_version`、`expected_connection_version`、`expected_broker_account_id`、`expected_as_of`、`expected_input_revision`、`expected_book_fingerprint`，拒絕額外欄位與非嚴格版本數值。不存在收據時版本為 0。
- 擷取先在一致讀取快照驗證來源、讀取券商，再取得連線設定鎖與 `BEGIN IMMEDIATE` 寫入交易，重新核對所有來源與收據版本。期間改變回 409，整份不保存；原收據仍依當前來源判斷為失效，不作為成功替代。
- 券商讀取失敗、身份不符、缺失／無法判讀的數量會保存為最新的不可用收據，取代更早的成功結果。就緒閘不向前尋找成功收據。
- `broker_reconciliation_receipts` 只保存最新一份版本化、正規化結果；數量與本機帳本對照留在本機資料庫，沒有 API Key 或 Secret。保存收據不改帳戶、委託、持倉、行情版本，也不送單。

既有 `GET /api/alpaca-paper/reconciliation` 保留即時唯讀相容行為，讀取不會自動保存收據。前端在已有收據後每 30 秒只檢查本機收據有效性；新的券商擷取仍須按下核對。

這是最近一次擷取的證據，不是即時券商保證或對帳修正；15 分鐘內也可能在券商外部發生交易。收據對照的是目前設定的單一 Alpaca Paper 帳戶與本專案全部 Alpaca 執行帳簿，不切分成每個本機模擬帳戶的券商持倉。測試 `tests/test_reconciliation_receipts.py` 使用假券商與合成資料。
