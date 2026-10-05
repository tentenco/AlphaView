# 公司行動偵測（股息／拆併股）

版本：`alphaview-corporate-actions-v1`。2026-10-01 Harness 依對標（Lean 的 Split／Dividend 事件、qlib 的 point-in-time 資料、Vibe-Trading「原始價 vs 調整價把股息記成虧損」的事故）新增的**偵測**第一步：只讀本機 `bars`，不呼叫供應者，不調整模擬帳本。入口：Agent 投資組合 → 風險控制。2026-10-03 增加獨立的 `alphaview-corporate-action-evidence-v1` 供應者回傳證據；原有推算公式與預覽提醒維持 v1。

## 偵測規則

- 調整因子 `f_t = adj_close_t / close_t`；沒有公司行動時固定。相鄰交易日相對變化超過 1e-6 → 以 `t` 為除權息日的事件。
- **疑似拆併股**：原始收盤比 `close_t / close_{t-1}` 落在常見比例（2、3、4、5、10、20、3/2 及其倒數）±3% 內；股數倍率＝原始價格比的倒數（價格減半 → ×2）。
- **股息（推算）**：其餘情況以 `D = close_{t-1} × (1 − f_{t-1} / f_t)` 推算每股現金。推導：Yahoo 在除息日把較早的列乘上 `(1 − D / close_{t-1})` 回溯調整，因此 `f_{t-1} = f_t × (1 − D / close_{t-1})`。只有 `D` 為有限值且介於前一日收盤的 0–25% 才列為股息。
- **無法分類**：`D` 超出範圍或非有限（例如資料修訂使因子下降），附原因碼。
- **不可用**：任一價格非有限或非正，該組交易日標示不可用、計入覆蓋計數，不略過。

## 虛擬帳戶摘要與預覽提醒

- 進場日沿用部位停損的定義：讓部位由零轉正的最後一次成交所屬提案的 `as_of`；沒有紀錄的持倉標示 `entry_unknown`，不猜測。
- 只有除權息日**晚於**進場日的事件列入 `events_since_entry`；另列最後一次成交之後的事件 `events_after_last_fill`。
- 紙上預覽對進場後有事件的持倉附上 `notices`（`corporate_action_since_entry`），是提醒不是違規；`notices` 與 `risk_direction` 同屬 `PREVIEW_METADATA`，不進入提案指紋，舊提案照常驗證。

## 資料一致性

行情更新（`market.refresh` → `market.fetch_symbol`）每次以供應者最近兩年重新調整的日線整批覆蓋該標的。若事件發生在最近一次更新之後，或本機資料是從備份還原的舊快照，表中可能同時存在拆併股前後口徑的列；疑似拆併股事件都附 `data_consistency.possible_mixed_basis`，請更新行情後重新偵測。`market.history_quality` 的覆蓋檢查不含此項，重新擷取也不在本版實作。

## 這不是什麼

- 推算層不是供應者公司行動資料；拆併股比例與股息金額由調整價反推，資料修訂可能被誤判為事件。另列的回傳證據不保證來源完整。
- 不會自動調整模擬帳本的股數或現金，也不改變任何帳本方法版本。
- 特別股息、分拆、併購現金補償分不出來。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/corporate-actions?symbols=A,B&start=&end=` | 1–50 個代碼；`events`、`coverage`（檢查的交易日數、首尾日期、不可用組數） |
| `GET /api/paper/accounts/{id}/corporate-actions` | 持倉摘要（進場日、最後成交日、進場後事件、狀態）、`flagged`、`entry_unknown`、逐事件 `since_entry`／`after_last_fill` |

兩者皆 `@store.snapshot_read`，回傳 `engine_version`、`as_of`、`input_revision`、`method`、`warnings`。實作 `alphaview/panel/corporate_actions.py`；預覽提醒在 `paper_portfolio._build_preview`；前端 `web/src/PortfolioCorporateActions.tsx`；測試 `tests/test_corporate_actions.py`、`web/src/PortfolioCorporateActions.test.tsx`（合成資料）。


## 供應者回傳證據（2026-10-03）

版本：`alphaview-corporate-action-evidence-v1`，與推算 v1 分開。既有行情更新的單次 `Ticker.history(period="2y", interval="1d", auto_adjust=False, actions=True)` 回傳中，保存 `Dividends` 與 `Stock Splits`；不增加資料源、呼叫或依賴，不開啟價格修復，不擴大兩年日線範圍。正常「行情更新」才擷取；有效快取的續跑仍可略過下載，舊資料沒有證據就顯示未擷取，不自行補抓。

[yfinance 官方 history 實作](https://github.com/ranaroussi/yfinance/blob/main/yfinance/scrapers/history.py) 會合併事件、正規化／補零，`actions=False` 則移除事件欄。因此保存的是 **yfinance 回傳值**，不是 Yahoo 原始 HTTP 封包，也不是 point-in-time 的當時已知資料。另見 [官方股票資料介面](https://ranaroussi.github.io/yfinance/reference/yfinance.stock.html)。本地記錄實際使用的 yfinance 版本，來源完整性固定為 `unknown`。

- 保存非零事件與不可用儲存格的日期、種類、原值字串與型別；數值不四捨五入。原始回傳字串不當作數字解析。`None`、NaN、無限值、負數、布林與非數字保留原因；計算值為 `null`，UI 顯示不可用，原值供檢查。
- 欄位缺失代表所有對應列未知；未收到欄位不補零。收到的零值只計入「回傳零值」覆蓋數，不是沒有公司行動的保證。覆蓋另列首末日、日線列數、各欄已檢查／非零事件／零值／不可用數。
- 同一天可有現金股息和拆股，兩筆獨立保留。只比較日期與事件種類，不把沒有因子變化的回傳拆股判定為錯誤。Yahoo 歷史收盤可能已反映拆股；回傳股息與推算金額的調整口徑無法確認，因此金額比較一律 `inconclusive_adjustment_basis`，不宣告相等或衝突。
- 每次最多 800 列、兩欄；單一證據與覆蓋 JSON 合計最多 1 MB，單一原值最多 256 字元，超限整次拒絕。只保存非零／不可用事件；不累積每天的零值列。

### 原子發布與修訂

`corporate_action_evidence` 是不可覆寫的事件內容修訂，保留來源、adapter 版本與首次擷取時間。`corporate_action_coverage` 是最新覆蓋指標，包含自己的遞增 `version`、目前／前次不同的證據修訂、日線指紋、擷取時間與發布後的 `input_revision`。相同事件內容重複下載只增加擷取版本，不增加事件修訂；新增一個回傳零值日也只更新覆蓋。事件數值修正或消失產生新修訂，舊 JSON 保留。若來源回到已保存內容，重用該內容修訂，擷取版本仍遞增。

下載前記下此標的的日線、資料集與證據頭身份。取得、驗證來源後，以短唯讀快照取得當前全域 `input_revision`；在 `BEGIN IMMEDIATE` 中核對全域 revision 與下載前的標的身份，再一次提交日線替換、資料集狀態、不可變證據與覆蓋頭。其他標的在短快照與取得寫鎖之間更新時，只重試提交前檢查，最多 3 次，不重抓網路；同一標的在下載中已變更則拒絕舊回應。這保留原本多標的平行下載，同時遵守發布前的全域 revision 檢查。

任何中途資料庫失敗回滾整批。既有供應者／驗證錯誤仍標示 dataset error 並保留舊日線與證據；舊回應的發布衝突只讓該任務回報 error，不覆寫較新的成功資料集狀態。證據讀取不寫 revision，也不觸發網路。

### 檢閱方式

兩個既有 GET API 增加 `provider_evidence`，保留原本 `events`（推算）與 `coverage`。帳戶 API 僅列目前持倉；查詢 start/end 同時篩選事件、來源修訂差異與比較列。供應者證據只在顯式 API 讀取時組合，不加入 paper 預覽的熱路徑。

風險控制下方並列推算與回傳證據，顯示來源、擷取時間、adapter 版本、事件修訂與覆蓋數。`重新讀取本機證據` 只重讀本機 GET API，支援中止舊請求，不呼叫券商或行情來源。若本機日線已改、最近更新失敗、擷取時間不合、覆蓋未到查詢交易日，保存的事件仍可檢閱，但醒目標示 stale 且比較不下結論。

「與前次不同證據修訂的差異」顯示來源原值的變化。只有新舊覆蓋重疊日期才列出消失事件，避免把兩年視窗之外的事件誤稱撤回；本次未回傳也不等於來源已確認撤回。這裡仍沒有完整公司行動帳本、原始供應者歷史修訂資料、股數／成本／現金調整、複利股息再投資或舊提案重算。

### 下載完整本機證據 JSON

「下載公司行動證據 JSON」直接序列化畫面已接受的帳戶 GET 完整回應，不另外讀取 API、不啟動行情供應者或作業。保留推算事件、持倉摘要、帳戶與輸入版本、讀取交易日、`provider_evidence` 修訂／覆蓋／來源原值、`null` 與前端尚未認識的欄位；數值不套用 UI 四捨五入。這是已解析回應的 JSON，不是原始 HTTP 封包的逐位元組副本。

下載包含**此次讀取時計算的狀態**與**不可變來源修訂中的歷史值**；來源更新失敗、過期、缺欄或未擷取的成功 GET 回應仍可完整下載，原樣保留 `stale`／`partial`／`unavailable`、原因及未知值，不改標為當期或完整。下載不是完整公司行動帳本、所有修訂歷史、Yahoo 原始歷史封包或已調整股數／現金的證明，也不會重新判斷下載當下的資料新鮮度。

前端核對回應的帳戶 ID 與版本，身份不符不顯示或匯出；切換帳戶／版本、重新讀取等待中會立即清掉舊下載，並中止及忽略舊回應。HTTP／網路讀取失敗不保留舊結果作為成功下載。檔名中的帳戶與交易日清理特殊字元並限制長度，內容原值不改寫；非有限數值拒絕序列化，不會暗中轉為 `null`。JSON 可包含虛擬持倉等私人資料，僅由使用者明示下載至本機。

測試：`tests/test_corporate_action_evidence.py` 使用合成 DataFrame 與假 Ticker，涵蓋修訂冪等、缺欄／非有限值、同／異標的並行、提交重試上限、整批回滾、兩種刷新流程的過期回應保護與範圍過濾。原有推算、metadata、resume 測試保持通過；前端涵蓋完整數值、未知覆蓋、stale、文字逸出、唯讀重新讀取與帳戶切換中止請求。

## 單一持倉標的更新與重檢（2026-10-03）

版本：`alphaview-corporate-action-refresh-v1`。風險控制卡片的「更新兩年行情並重檢 · SYMBOL」是明示的來源更新：使用既有 Yahoo adapter 下載該標的最近兩年日線，再從保存的日線與回傳證據重檢。載入頁面、重新整理頁面及「重新讀取本機證據」只讀本機，不啟動來源更新。

此入口也支援**只有虛擬帳戶持有**、不在實際持股／觀察清單或市場股票池中的標的。它不新增股票池成員，不修改實際持股，也不修改 paper 股數、成本、現金、提案或 NAV；既有 `/api/jobs` 的 retry 股票池限制完全保留。資料版本更新會照既有規則讓依賴舊行情的研究結果或提案過期。

| 端點 | 行為 |
| --- | --- |
| `POST /api/paper/accounts/{id}/corporate-actions/refresh` | 單一 `symbol`、`expected_account_version`、`expected_input_revision`、`expected_as_of`、`idempotency_key`；202 回傳 job |
| `GET /api/paper/accounts/{id}/corporate-actions/refresh` | 唯讀取得此帳戶最近一次重檢作業，重新整理後只恢復狀態 |
| `GET /api/paper/accounts/{id}/corporate-actions/refresh/{job_id}` | 唯讀取得特定作業；核對原始帳戶與 request fingerprint |
| `POST /api/jobs/{job_id}/cancel` | 沿用既有合作式取消 |

POST 在 `BEGIN IMMEDIATE` 內核對帳戶版本、全域輸入 revision、`sessions.latest_completed_session()` 與目前仍有正股數的 paper holding；缺值與格式錯誤不填補。worker 開始來源呼叫前再次核對同一組條件。重複相同 key＋內容回到原 job，即使原作業已更新 revision 也不重抓；同 key 不同內容回 409。其他 workspace 作業持有既有 `RUN_LOCK` 時回 409，不建立幽靈作業，卡片保留目前證據。前端同步 ref 防連點，回應遺失後重試沿用同一 key。

不增加 schema：工作來源、原始 request fingerprint、更新前與更新後摘要都保存在既有 jobs.result。job ID 由帳戶與 key 派生；查詢仍驗證**完整保存的帳戶與 request context**，不把 ID 前綴當成授權。使用 jobs 原本的 launch、跨程序鎖、失敗解鎖、取消與中斷恢復；內部 `corporate_action_refresh` kind 不開放給通用 JobInput。此作業不執行全股票池策略掃描。

來源失敗會保留舊 bars，作業標 failed；本機重檢仍說明「未證明異常修復」。取消需等目前下載結束，已原子提交的完整行情可以保留，取消不承諾回復舊價。重檢摘要在另一個短快照中產生，發布時再次核對 input revision、帳戶版本、是否持有、交易日；競態最多重算本機摘要 3 次，不再抓來源。下載途中帳戶或交易日改變時，回條明示 `changed_not_validated`，不宣稱已驗證目前持倉。

**這不是完整歷史修復。** 最近兩年重抓與重新偵測成功，不代表資料修訂、拆股口徑、股息缺漏或帳本異常已解決；只提供可檢閱的新證據與前後計數，不自動調整任何帳本。

前端提供作業狀態與取消，終態後重新讀取本機證據；帳戶切換會中止舊請求並忽略過期回應。未知儲存格顯示雙語原因，時間沿用面板 `dateTime` 格式。390px 卡片標題改堆疊、方法版本可換行，事件表保留容器內橫向捲動。

測試：`tests/test_corporate_action_refresh.py` 驗證只在 paper 持有的標的、三種 CAS、重送／並行重送、現有 retry 邊界、來源失敗、下載中帳戶變更、取消前後、thread launch 失敗與重啟中斷；所有 Ticker 都是假來源。`PortfolioCorporateActions.test.tsx` 驗證沒有自動 POST、連點、409 保留資料、回應遺失後相同 key、輪詢／取消、重新整理恢復與帳戶切換取消請求。
