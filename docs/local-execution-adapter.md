# 純本機 execution adapter 演練契約（設計待審）

狀態：**2026-09-29 Harness 純 reducer／獨立 CLI 已實作，89 項 focused tests 通過；Harness 最終全專案驗收另列**。初版只交付本機 JSON 演練與 artifacts 下不可覆寫的收據檔案，不新增 runtime API、資料庫或 UI。後續完成狀態以本輪驗收紀錄為準；本文件不表示已有券商執行能力。

## 交付範圍

輸入一份明確標記為合成的單筆委託 trace，逐步演練 `submit`、`cancel`、`status`、`fill`、`reconcile`，產生可檢閱、可保存、可匯出的不可覆寫收據。回應、成交、逾時與核對快照全部由輸入 fixture 指定，沒有傳輸層、背景執行、真實價格或外部服務。

本版只處理**一份 trace 中的一筆邏輯委託**。多筆委託間的現金預留、順序、帳戶資產、風險額度與淨值不在模型內。它驗證狀態與重送邊界；不能由這份收據推論策略績效、真實可成交性或特定券商相容性。

最小使用路徑是：本機 JSON CLI 提供合成 trace → 唯讀預覽 → 明確保存至 artifacts → 讀回同一收據並核對 hash。介面不提供會呼叫外部服務的委託操作，也不提供「送至 paper／Alpaca」按鈕。

## 與現有模型分開

| 既有模型 | 已有語意 | 本演練的邊界 |
| --- | --- | --- |
| `alphaview-paper-portfolio-v2` | 完整目標權重、raw close、整批帳本結算 | 不呼叫 `_settle_orders`，不讀寫任何 paper 帳戶、持倉、提案、帳本或 NAV |
| `alphaview-paper-next-open-v1` | 凍結股數，指定交易日完成後 raw open，整批成功或等待／受阻 | 不複用 queue 狀態、指定交易日、歷史授權或 fill receipt；本 trace 可部分成交，但不變更 next-open 的整批語意 |
| `alphaview-paper-export-v1` | paper 收據與帳戶匯出，含帳本及實際記錄時間 | 使用獨立格式、檔名、scope 與方法版本；沒有 `executed_in_paper: true` |
| `alphaview-alpaca-paper-connection-v1` | 固定 Paper host 的指定 GET 讀取 | 不 import connector、不讀金鑰、不讀 provider snapshots、不送 HTTP，包含 loopback provider 在內 |

輸入不接受 `paper_account_id`、`proposal_id`、`mandate_id`、`alpaca_order_id`、endpoint、URL、token、headers 或 credential 欄位。所有模型 `extra="forbid"`；adapter 沒有可注入的真實 transport。合成 `client_order_id` 只在單份 trace 內有意義，不能用來取得任何既有委託。

## 方法與識別

預定引擎：`alphaview-execution-dry-run-v1`。預定輸入格式：`alphaview-execution-dry-run-trace-v1`；收據格式：`alphaview-execution-dry-run-receipt-v1`。重播、十進位計算、狀態轉移或去重語意改變時升版。舊收據只讀回保存內容，不使用新方法重算或改寫。

三種身份各有一個用途，不能互相替代：

| 身份 | 範圍與規則 |
| --- | --- |
| `input_sha256` | 正規化 trace 的內容識別；相同 input＋方法版本產生相同結果指紋。收據檔案採 exclusive create，不論內容是否相同都不覆寫既有目標；不另設 runtime 保存冪等資料庫 |
| `request_id` | trace 內 `submit`／`cancel` 的邏輯請求。完全相同的請求＋合成回應再次出現，只回放原結果，不再提交或取消；相同 ID 的內容不同使 trace 無效 |
| `event_id` | trace 內合成回應／成交／核對事件的身份。相同 ID＋相同事件內容是重複通知，不再套用；相同 ID 的內容不同使 trace 無效 |

`fill` 另帶 `execution_id`，代表一次經濟成交。不同 `event_id` 重送相同 `execution_id`、數量、價格與執行時間時，不重複累加。已知 `execution_id` 改任何成交欄位、移到別的 order，或在 reconcile 中提供矛盾內容，使 trace 無效。

已記錄為 blocked 的 submit／cancel 也會保留 `request_id`；同 ID 之後仍是 duplicate，不會因狀態恢復而重新執行。核對後如需取消，使用新的 cancel request ID；新 submit ID 始終不能重送同一邏輯委託。

相同內容換一個 `event_id` 不能令已知成交再入帳；相同委託換一個 `request_id` 也不能繞過重複提交限制。新實驗須建立另一份 trace，而不是在同一 trace 裡重用或替換邏輯委託。

## 輸入及時間

根輸入必須包含 `format_version`、`synthetic_only: true`、`order` 與 `steps`。`order` 包含 `client_order_id`、合成 `symbol`、`side: buy|sell`、`quantity`、`currency: USD`；委託內容在第一次 submit 後不可替換。沒有 order type／time-in-force／限價／市場撮合模型。

- 一份 input 最多 256 KiB，最多 200 個 steps、100 個不同 executions；超限整份拒絕，不截斷。
- 識別值只接受 ASCII 字母、數字與 `._:-`，1–100 字元；symbol 沿用 paper 代碼語法並正規化大寫，最多 20 字元。只做格式驗證，不確認標的真實存在。
- `quantity` 與 fill quantity 必須是正十進位**字串**，最多 6 位小數，最大 `1000000000`；fill `price` 是正十進位字串，最多 8 位小數，最大 `1000000000`。拒絕負數、零、NaN、Infinity、指數記法、JSON 浮點數與超限精度，不自動四捨五入輸入。
- 每一步包含 `observed_at`，為明確 UTC RFC3339（`Z`）時間。依輸入陣列順序處理，時間必須不遞減；相同時間依陣列位置排序，不能由引擎重排事件。
- fill 另有 `executed_at`，必須不早於首次 submit、不晚於本步 `observed_at`。不同成交可以延後送達，`executed_at` 不必隨通知順序遞增。
- `observed_at` 是合成收到事件的時間，`executed_at` 是合成成交時間；保存時的 `created_at` 是實際本機寫入時間。三者分列，不能將 fixture 時間寫成真實成交時間。
- 不讀 `sessions.latest_completed_session()` 或交易日曆。不等待現實時間，不下載行情，不因日期看似過期或跨交易日而補跑／取消／成交。週末 fixture 仍可演練協定，且不得宣稱為有效交易所 session。

純計算結果的 `as_of` 等於最後一步 `observed_at`，並標記 `as_of_kind: synthetic_observation_time`。結果不帶工作區市場 `input_revision`，因為 CLI 完全不讀工作區；決定重播結果的是正規化 trace 的 `input_sha256`。它不能冒充使用真實市場輸入的研究回應。

## 步驟的明確能力

| 操作 | 必填內容與作用 |
| --- | --- |
| `submit` | `request_id` 與 fixture `response: acknowledged／rejected／timeout`；ack／reject 帶 `event_id`，reject 帶固定 reason code。首次 submit 只讀根 order，不接受替代 order 欄位 |
| `cancel` | `request_id` 與 fixture `response: acknowledged／rejected／timeout`；ack／reject 帶 `event_id`。取消只影響未成交餘額，保留所有已知 executions |
| `status` | 只讀取目前 reducer 狀態、已知成交與不確定原因；沒有回應 fixture，也不產生事件或改變 order revision。它不等於向券商查詢 |
| `fill` | `event_id`、`execution_id`、`quantity`、`price`、`executed_at`；追加一次合成成交，按 event／execution 身份去重 |
| `reconcile` | `event_id` 與 fixture `response: snapshot／not_found／timeout`。snapshot 包含同一 client order ID、完整 order fingerprint、狀態及完整 execution 集合。它代表測試輸入宣告的權威快照，不代表真正查到外部委託 |

submit 拒絕 reason code 最小集合為 `synthetic_rejection`、`synthetic_invalid_order`；cancel 拒絕使用 `synthetic_cancel_rejection`。不接受任意供應商錯誤文字或 traceback 作為身份的一部分。狀態說明由本機模板產生。

每一步回傳 `action_result: applied|duplicate|blocked|observed`，`state_before`、`state_after`、`filled_quantity`、`reason_code` 與涉及身份。重複通知與狀態不允許的命令都留下可檢閱步驟；它們不偷偷消失，也不造成額外效果。

結構錯誤、矛盾 event／execution 身份、超額成交、非法快照、時間倒退是**無效 trace**，預覽／保存皆回結構化 input error 與出錯步驟、具體代碼；不保存部分 run。合法 submit rejection、timeout、重複通知、被禁止的重送／取消是正常演練結果，可以保存。

## 狀態與轉移

狀態是 `not_submitted`、`open`、`partially_filled`、`filled`、`cancelled`、`rejected`、`unknown`。另保存 `last_confirmed_state`、`uncertainty_reason`、完整事件及 executions；`unknown` 不抹去先前已確認的數量。

| 目前狀態 | 操作／合成回應 | 結果 |
| --- | --- | --- |
| `not_submitted` | submit acknowledged | `open`，累積成交 0 |
| `not_submitted` | submit rejected | `rejected`，累積成交 0，終態 |
| `not_submitted` | submit timeout | `unknown`，`submit_outcome_unknown`；不能假定未提交 |
| `not_submitted` | cancel／fill／reconcile | cancel 記錄 blocked；沒有委託的 fill／reconcile 為無效 trace |
| `open`／`partially_filled` | 新 fill，累積小於委託量 | `partially_filled` |
| `open`／`partially_filled` | 新 fill，累積等於委託量 | `filled`，終態 |
| `open`／`partially_filled` | cancel acknowledged | `cancelled`，保留已成交量；終態 |
| `open`／`partially_filled` | cancel rejected | 保留目前狀態與成交，記錄取消遭拒；不能宣稱已取消 |
| `open`／`partially_filled` | cancel timeout | `unknown`，`cancel_outcome_unknown`；保留 last confirmed state |
| `unknown` | submit（新 request ID）或 cancel | blocked，`reconciliation_required`；不生成新的外部動作假設 |
| `unknown` | 新 fill，累積小於委託量 | 保持 `unknown`，更新已知成交與 last confirmed state；部分成交不能證明剩餘委託仍在工作或已取消 |
| `unknown` | 新 fill，累積等於委託量 | `filled`；完整成交解決未成交餘額的不確定性，原未知事件仍保留 |
| submit 曾嘗試後的非終態 | submit（新 request ID） | blocked，`already_submitted`；相同邏輯委託不建立第二次提交 |
| 任意狀態 | 已知 request／event／execution 完全相同的重送 | duplicate，狀態與成交不變；先做身份判定，再做狀態判定 |
| 終態 | 新 submit 或 cancel | blocked，`terminal_state` |
| 終態 | 新 fill | 無效 trace，`terminal_fill_conflict`；不默默改寫終態 |
| 任意狀態 | status | observed，狀態與 order revision 不變 |

取消與成交的競爭由輸入順序明確表達：先 partial fill 再 cancel ACK，結果為已部分成交的 cancelled；先 full fill 再 cancel，取消被阻擋；cancel timeout 後 full fill，結果為 filled。本版不處理在 terminal cancel ACK 後才抵達的未知歷史成交；輸入必須在 cancel ACK 前提供這些成交，或在仍屬 unknown 時以完整 reconcile snapshot 解決。遇到這種不支援的通知順序，明確拒絕，不能聲稱支援任意券商事件排序。

## Reconcile 的證據與限制

`snapshot` 必須重述同一個 `client_order_id` 與完整 order fingerprint，提供 `state: open|partially_filled|filled|cancelled|rejected`、`executions` 全集合。輸入 cumulative quantity 不作為權威，總量由 executions 重新計算；若日後增加這個欄位，仍須與重算值完全相等。

1. 快照不能移除或改寫任何已知 execution；必須包含目前已知集合的完整相同內容，可以加入新的 execution。
2. 每個 execution 必須符合相同的 quantity／price／executed_at 規則，不得超量。快照內 execution ID 不可重複。
3. `open` 要求總成交 0；`partially_filled` 要求 `0 < filled < order quantity`；`filled` 要求完全相等；`cancelled` 要求 `filled < order quantity`；`rejected` 要求 0 成交，且先前未確認接受／成交。
4. 合法完整 snapshot 可從 `unknown` 回到已知狀態。已知 `open`／`partially_filled` 也可核對為一致的更新狀態；不得退回較少成交或從已確認接受退回 rejected。
5. `not_found` 只證明 fixture 未找到，不證明從未提交，也不證明已取消。結果保持／進入 `unknown`，保留已知 executions，標記 `not_found_is_not_absence_proof`；禁止換 key 盲目重送。
6. reconcile timeout 同樣保持／進入 `unknown`，標記 `reconcile_outcome_unknown`，不將已知成交歸零。
7. 終態只允許內容完全一致的 snapshot 核對，為 observed；不同終態、新增成交、not_found 或 timeout 都不能修改終態。矛盾 snapshot 為無效 trace；終態查詢失敗只記錄 observed／`terminal_observation_unavailable`。

這是 fixture 宣告的完整快照。輸出始終帶 `authority: synthetic_fixture`，不宣稱已和真實券商對帳，也不從 synthetic not_found 自動產生重送許可。

## 數量與收據不變量

- 委託量固定；任何 prefix 都滿足 `0 ≤ filled_quantity ≤ requested_quantity`。不支援改單、部分撤單、short inventory、replace／新 order generation。
- `unfilled_quantity = requested_quantity − filled_quantity`。此數字在 cancelled 狀態表示未成交的已取消數量，不表示仍可成交。
- `working_quantity`：open／partially_filled 為未成交量；終態為 `0`；unknown 為 `null` 並附不確定原因。`not_submitted` 為 `0`。
- 金額用 Decimal，fill notional 是 quantity × price 的精確乘積；輸出 canonical 十進位字串，不輸出 JSON float 或指數。總 notional 由唯一 executions 相加。平均價格＝總 notional／成交量，顯示至 8 位小數、ROUND_HALF_EVEN；無成交時為 null。方法版本明示平均價顯示的取整，不回饋狀態判定。
- 不計現金餘額、成本基礎、損益、費用、滑價、NAV 或持股數；fill receipt 是協定演練的 execution 計數，不是另一本投資組合帳本。
- `request_id`／`event_id`／`execution_id` 互相去重的 replay 不增加 order revision、成交量或金額。revision 只在真實狀態／已知 execution／不確定性改變時加一；status、blocked、duplicate 不加一。
- 相同正規化 input＋同一方法版本，純 reducer 結果與 hash 必須完全相同。UUID、實際時間、workspace revision 不放進純 reducer hash；保存外層的 ID／時間另列。
- 無效 trace、輸出檔衝突或檔案錯誤不能留下半份 run；有效 trace 可以停在 open、partial 或 unknown，收據不能把它稱作 completed execution。
- `trace_evaluated: true` 只表示步驟已處理；`order_terminal` 與 final state 分列。`unknown` 必須顯示待核對，不能因 trace 結束而自動 filled／cancelled。

## CLI、保存與檢閱

純 reducer 放在 `alphaview/panel/execution_dry_run.py`，只 import 標準庫與 Pydantic；不 import paper、store、market、sessions、scheduler、Alpaca 或 transport。獨立入口為 `scripts/execution_dry_run_cli.py`，不修改既有 Portfolio Agent CLI。

| 命令 | 作用與寫入 |
| --- | --- |
| `preview --input FILE或-` | 嚴格解析 trace、純重播，stdout 回傳結果；不開 DB、不建目錄、不寫檔 |
| `save --input FILE或- --output artifacts/相對路徑.json` | 完整重播後建立不可覆寫 receipt；只允許 repo 的 artifacts 目錄內 |
| `inspect --receipt artifacts/相對路徑.json` | 讀取完整保存內容，核對 envelope／content／input／result hash，stdout 顯示原收據；不重播、不修改檔案 |

`--pretty` 是全域 JSON 顯示選項。stdout 除 help 外始終為單一 JSON object；錯誤回傳固定 code、message 與必要的 step index，不能帶輸入全文、traceback、敏感環境變數或其他檔案內容。輸入拒絕 duplicate JSON keys、NaN、Infinity、JSON 浮點數、超過 32 位的 JSON 整數與超限 bytes。程式不自行重試任何輸出寫入。

保存路徑必須在 repository `artifacts/` 內，拒絕 `..`、symlink 目錄／目標、非一般檔案及非 `.json` 目標。以 owner-only 的同目錄 staging 檔先完整寫入與 fsync，再用不覆寫的原子 link 建立最終檔案；目標已存在則失敗，即使內容相同也不覆寫。中斷最多留下隱藏 staging 檔，不發布部分 receipt。若 exclusive link 已成功但目錄 fsync 失敗，回報 `publication_durability_unknown`；完整目標可能已存在，先 inspect 同一路徑，不改用新檔名盲目重送。必要的 artifacts 子目錄可建立，既有檔案不改權限或刪除。

有效未知狀態可以保存。若要演練後續步驟，建立包含完整歷史與新步驟的新 trace、選擇新的輸出檔；它是獨立演練，不修改先前收據。無效 trace、過大 receipt、目標衝突或檔案錯誤不能留下最終半成品。

receipt envelope 包含 `format_version: alphaview-execution-dry-run-receipt-v1`、引擎、`scope: synthetic_execution_dry_run_only`、`synthetic_only: true`、`network_used: false`、`paper_ledger_written: false`、`broker_connected: false`、真實本機 `created_at`，以及 `content`、`content_sha256`。content 包含正規化 input 與結果；結果有 `input_sha256`、`result_sha256`（hash 時排除自身欄位）。content hash 不包含 envelope 的 created_at，讓相同 trace 的內容可獨立核對。

所有 hash 為 UTF-8 canonical JSON（sorted keys、compact separators、ensure_ascii=false）的 SHA-256。它只證明內容一致，不是簽章、券商執行證明或完整 workspace backup。`inspect` 明確區別 integrity verified 與 current engine supported；舊方法收據可原樣讀回，不能偷偷套用新方法重新計算。

後續 runtime API／DB／UI 需另立設計波次及驗收，本輪不新增表、不更動 store／API wiring 或備份 schema fingerprints。

## 最小驗收案例

全部使用合成 symbol／價格／事件與 tmp_path 的隔離 artifacts 根目錄。用拒絕網路的 spies／monkeypatch、imports 檢查與禁止開啟 DB／credentials 的測試確認隔離；不為驗收讀取真正工作區、paper 持倉或金鑰。CLI 測試透過內部測試參數指定隔離 artifacts root，實際命令不提供改寫根目錄或環境變數開關。

| 類別 | 必須有的結果 |
| --- | --- |
| 基本 | ACK → partial → full；數量／notional／平均價重算正確；中間 status 不改 revision |
| 拒絕與取消 | submit reject；partial 後 cancel ACK；cancel reject 保留可工作狀態；full 後 cancel blocked |
| 不確定 | submit timeout → 改 key submit blocked → not_found 仍 unknown → 完整 snapshot 恢復；cancel timeout → partial 仍 unknown → full 解決 |
| 重送 | request／event 完全相同重送；不同 event 重送同一 execution；每個身分類別的內容衝突拒絕 |
| 核對 | snapshot 不得少已知 execution、改價格、改 order、重複 execution ID、超量或宣稱錯誤終態；未知維持、不盲送 |
| 時間 | arrival 相同時間穩定排序；晚到但合法的 execution timestamp；arrival 倒退與未來 execution 拒絕；週末 fixture 不讀 session calendar |
| 精度與上限 | 邊界量、部分量 exact 相加、平均價取整；float／NaN／Infinity／超位數／過大 payload／step／fill 上限拒絕，不截斷 |
| 保存 | 既有目標一律不覆寫；並行相同目標僅一份完整檔案；無效 trace／中斷 staging 不發布最終檔；symlink／越界／非一般檔拒絕；讀取舊方法收據不重算 |
| 匯出與隔離 | 保存與 inspect content 一致，hash 可獨立重算；沒有 paper／broker 身份、ledger claim、secret 或外部路徑；workspace DB、設定與憑證完全未開啟 |

交付前除 focused tests 外仍跑專案共用五道關卡。若本輪不能完成保存→讀回→匯出主路徑，就只交已審設計與已驗證的純 reducer 範圍，文件必須明確列為未交付完整功能，不把狀態圖視為執行 adapter 已可用。


## 操作範例

以下 trace 全為合成資料，沒有市場 session 或帳戶身份。先把 JSON 保存為 artifacts 下的輸入檔，再預覽與明確保存。輸出目標必須尚未存在。

```json
{
  "format_version": "alphaview-execution-dry-run-trace-v1",
  "synthetic_only": true,
  "order": {
    "client_order_id": "synthetic-example-order",
    "symbol": "SYNTH",
    "side": "buy",
    "quantity": "10",
    "currency": "USD"
  },
  "steps": [
    {
      "action": "submit",
      "observed_at": "2026-09-26T10:00:00Z",
      "request_id": "synthetic-example-submit",
      "response": "timeout"
    },
    {"action": "status", "observed_at": "2026-09-26T10:00:01Z"}
  ]
}
```

```sh
uv run --extra web python scripts/execution_dry_run_cli.py --pretty preview --input artifacts/synthetic-execution-input.json
uv run --extra web python scripts/execution_dry_run_cli.py save --input artifacts/synthetic-execution-input.json --output artifacts/synthetic-execution-receipt.json
uv run --extra web python scripts/execution_dry_run_cli.py --pretty inspect --receipt artifacts/synthetic-execution-receipt.json
```

範例最終 `state: unknown`、`working_quantity: null`、`execution_outcome_available: false`；它不假裝提交遭拒或已取消。`preview.result.order_fingerprint` 是後續合成 reconcile snapshot 必須提供的原委託指紋。CLI exit code：0 成功；2 輸入、協定、完整性或目標衝突；3 明確檔案路徑無法安全讀寫。`--help` 顯示文字，其餘成功及失敗皆輸出單一 JSON。
