# 不可變的執行清掃歷史

方法版本：`alphaview-execution-sweep-history-v1`。每次取消清掃對一筆 submission 產生非空結果時，保存一個不可變事件；原本 `summary.kill_switch_sweep` 仍保留最近一次摘要。取消判斷、券商請求次數、目前委託狀態及 `alphaview-execution-v1` 的語意不變。

事件 payload 包含歷史方法版本、account ID、submission ID、原清掃時間、原因與該 submission 的完整 `results`。每列保留原有 order ID、標的、方向、清掃前狀態、當次動作與錯誤；不讀取今日委託狀態來改寫過去。

## 保存與交易邊界

在 `cancel_working` 原本最後的 `BEGIN IMMEDIATE` 交易內，逐 submission 追加事件，然後更新最近摘要。所有受影響 submission 的新事件與摘要共用同一交易；其中任何一筆失敗就一起回滾，沒有半批事件或只有摘要的成功保存。空清掃不產生事件。

事件 ID 與 content fingerprint 都是完整 payload 的 canonical finite JSON SHA-256。相同 ID 只允許所有欄位與 JSON 完全相同的重播；不一致回 409，不覆寫。歷史模組不接受瀏覽器寫入、不另行 commit，也不新增重試、重送或券商呼叫。

取消請求與逐委託狀態更新在既有流程中早於最後摘要交易。若最後保存失敗，先前已發生的取消請求不會倒轉，既有委託狀態仍保留；也不因歷史保存失敗自動重送。這個事件表不能保證涵蓋所有外部請求；它記錄成功提交的本機清掃觀察。

資料表 `execution_sweep_events` 由主程式正常 schema 初始化建立。沒有舊摘要回填、刪除端點、自動清除或保留數量政策。清掃歷史寫入不影響行情 `input_revision`，不寫帳本、持股或提案。

## 唯讀 API

- `GET /api/execution/accounts/{account_id}/sweep-history?limit=20&offset=0`：預設 20、最多 50，offset 0–5000。只接受整數十進位字串；小數、布林字樣、負數、前導零與超界值回 422。可加 `submission_id`，限定該帳戶的一筆 submission；不屬於此帳戶或不存在回 404。另可加 `start_date`、`end_date`（YYYY-MM-DD，UTC 且含首尾當日）與 `reason`（完全符合、最長200字、不接受前後空白或控制字元）。日期需有效且起日不晚於末日。
- `GET /api/execution/accounts/{account_id}/sweep-history/{event_id}`：只讀取該帳戶事件，事件 ID 為 64 字元小寫 hex；另一帳戶或不存在回 404。

兩端點使用 `@store.snapshot_read` 與 `Cache-Control: no-store`，不初始化 schema、不寫資料、不核對券商。列表按照 `created_at DESC,id DESC` 排序，回傳 `items` 與 `pagination: {limit,offset,total,returned}`。summary 有事件／帳戶／submission ID、版本、content fingerprint、`integrity`、原時間與原因、結果筆數及按當次 action 統計的 counts；明細另有完整 `event`。

讀取會核對 JSON、方法版本、SHA-256、欄位身份、原時間、非空結果與逐列識別。內容損壞仍列在歷程中，但 `integrity.available=false`，`event`、時間、原因、筆數與 counts 都是 `null`；不顯示成有效歷史，也不以空集合或零代替缺口。Hash 不是數位簽章，不能防止能同時改寫資料與 hash 的人。

查詢版本 `alphaview-execution-sweep-query-v1` 不更動事件 v1 的保存語意。帶日期／原因時，先驗證事件，再以 payload 的 UTC 時間與原始 reason 篩選，最後分頁；`pagination.total` 只計符合條件的可驗證事件。`filters` 回傳完整查詢，`filter_coverage.unverifiable_excluded` 明示整個帳戶／submission 範圍裡無法判斷的記錄數。無篩選時此計數為 null，損壞事件照常列出。查詢不依靠未驗證的 JSON 或欄位猜測符合與否。

## 畫面檢閱與下載

交易代理的「已保存清掃歷程」預設檢閱整個帳戶。開啟送出明細後，可限定目前選取的送出紀錄；切換會清除舊結果，必須明確重新讀取。每頁20筆，保留總數與5000筆查詢位移上限提示，未選取送出紀錄時不發限定查詢。

開啟可驗證的事件明細後，可下載該次完整JSON回應。下載保留事件、外層完整性／來源欄位、null與未顯示欄位，不再讀取API。切換帳戶、範圍、事件或送出明細，等待回應、讀取錯誤與不可驗證內容都不能匯出舊結果。這是歷史證據副本，沒有匯入、恢復或重送作用。

## 完整範圍批次匯出

`GET /api/execution/accounts/{account_id}/sweep-history/export` 接受同一組 submission／UTC日期／精確原因條件，不接受分頁來截斷結果。`alphaview-execution-sweep-export-v1` 在一致快照內回傳所有符合事件的完整 detail envelope、filters、不可驗證排除數與 coverage；最多250筆、2MiB，超界回413並要求縮小條件，沒有部分檔案。未篩選時損壞事件仍在包內，以null內容及原因呈現；有篩選時無法判斷條件的事件列入排除數。

畫面「匯出此範圍 JSON」明確讀取一次，核对帳戶、條件、事件身份與覆蓋後下載完整回應。條件／帳戶改變中止等待中的請求，連點不重複送出。這是可檢閱副本，不是封存刪除或匯入；既有事件不變，容量政策沒有自動清除。

## 這不是什麼

清掃歷史不是目前券商狀態、成交保證或取消成功證明，也不是交易指示。歷史上的 `cancel_requested` 後來可能成交；目前狀態應看既有委託核對結果。沒有事件不代表以前沒有清掃，只表示此功能開始保存後沒有可讀取事件。此功能沒有重送、再次取消、套用配置或任何執行入口。

測試使用隔離 SQLite 與假券商，驗證兩次清掃及後續成交、精確重播、碰撞拒絕、損壞資料、跨帳戶隔離、嚴格分頁、唯讀快照與整批回滾；既有 execution／sweep 回歸仍需通過。
