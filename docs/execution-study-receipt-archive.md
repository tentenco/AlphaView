# 執行研究收據封存與唯讀預檢

方法：`alphaview-execution-study-receipt-archive-v1`；格式：`1`。封存同一 paper 帳戶跨所有提案的 `volume_day`、`limit_day`、`open_gtd` 保存收據，包括完整、部分涵蓋、不可用、損壞及未知方法的紀錄。沒有重新計算情境、讀取行情或修改原始證據。

## API 與範圍

- `GET /api/paper/accounts/{account_id}/execution-study-receipt-archive`
- `POST /api/paper/accounts/{account_id}/execution-study-receipt-archive/preflight`

帳戶識別須為 32 位小寫十六進位且帳戶存在。POST 傳送原始 UTF-8 JSON，媒體型別為 `application/json`。兩個端點皆為 `@store.snapshot_read`，在 query-only 一致快照讀取帳戶、版本、收據集合及容量，沒有 schema 初始化或資料寫入。`as_of` 採 `sessions.latest_completed_session()`；讀取期間交易日變更回傳 409。

集合不受個別研究面板的 kind、proposal 或歷史分頁影響。成員由帳戶欄位精確儲存位元組判斷；同值 BLOB 帳戶欄位仍保留，但非文字儲存型別使收據不可驗證。不得把異帳戶收據當作相容，也不核對異帳戶來源。

## 原始欄位與校驗

固定九欄：`id`、`account_id`、`proposal_id`、`kind`、`created_at`、`engine_version`、`request_json`、`content_fingerprint`、`payload_json`。每格保留儲存型別、編碼、位元組長度、SHA-256 和內容。

| SQLite 儲存型別 | 表示 |
| --- | --- |
| 有效 UTF-8 TEXT | 原文，不重新序列化其中 JSON |
| 無效 UTF-8 TEXT、BLOB | 原位元組 base64，仍區分 TEXT／BLOB |
| INTEGER | 有號 64 位元標準十進位字串 |
| REAL | 大端序 IEEE754 64 位元 base64 |
| NULL | 明確 null、零位元組 |

REAL 中的非有限位元模式只保留為不透明內容，不轉為 JSON 數字或可用研究數值。損壞 JSON、缺值、重複鍵、未知欄位與方法原文皆保留，不補零、不修復、不刪除。原始完整收據中的研究回應仍保有 `1.0`、負零、指數、Unicode 和 null 的精確文字。

逐格雜湊核對原位元組；`row_checksum` 核對型別化列；`set_fingerprint` 核對排序後的列校驗值多重集合；`checksum` 核對除其自身以外的完整封存。Canonical JSON 是 sorted keys、UTF-8、有限數值、無多餘空白。前端下載整份伺服器回應原文，不經 JSON.stringify。校驗值不是簽章，也不是來源真實性的證明；外部檔案自稱完整集合，不足以證明歷史從未被整批刪除。

## 預檢判定

預檢核對嚴格 JSON、重複鍵、非有限數值、孤立 surrogate、精確封存 schema／版本／政策、儲存格編碼、校驗值、完整集合計數、重複 ID、帳戶／提案／kind 綁定、規範化保存請求、完整原始收據封裝、原始 HTTP 證據 SHA-256、GTD 嵌入指紋及受支援的方法版本與方法文字。

證據形狀包括固定委託身分／股數精度、日期、原始 bars 欄位及指紋、DAY 覆蓋、GTD 精確 horizon／逐日狀態／覆蓋，以及明確 null 與未知值。這些檢查核對保存的格式和身分，不重新推算成交量容量、情境股數、行情或實際成交。未知／損壞原始內容即使與本機完全相同，仍不相容；重新計算封存校驗值不會使不支援的證據變有效。

`compatible` 只表示目前封存方法能核對保存內容。原始研究的 `complete`、`incomplete`、`unavailable` 分別保留，不改成研究通過。完整保存的不可用研究與無委託提案可以結構相容。歷史收據即使帳戶、輸入、提案或交易日已改變，仍可能相容；每筆封存時／預檢時 currentness 和整份快照差異分開呈現，不重建舊值。

本機重複狀態分為完全相同、尚無、同識別內容衝突、無法核對。容量列出現在用量、剩餘量、缺少紀錄數，以及計入唯一缺少 ID 後的預估用量。未知 ID 導致預估 null，UI 顯示 `—`。不存在的紀錄只供唯讀容量推估，不會匯入。

## 限制

每帳戶 50 筆、全域 250 筆；原始 payload 2 MiB、保存請求 16 KiB；完整封存和 POST 原始內容 32 MiB。GET 超過集合大小或筆數上限回傳 413，不產生部分檔案；超限原始收據本身仍可作不透明內容封存，但不可驗證。POST 媒體型別錯誤為 415；帳戶缺少／格式錯誤為 404／422；資料形狀或相容性問題為 200 `verdict: blocked` 並列原因。沒有自動清除、刪除、匯入或還原端點。

## 介面

`ExecutionStudyReceiptArchive` props：`accountId`、`accountVersion`、`enabled?`（預設 true）、`t`。根介面在帳戶範圍只掛載一次。明確「準備」才 GET，明確「下載」才保存原始文字；選檔或貼上只改本機草稿，按預檢才 POST。檔案先檢查 32 MiB 和嚴格 UTF-8，原始重複 JSON 鍵仍交伺服器判定。

帳戶、版本或 enabled 生命週期變化會取消請求並撤下舊下載／判定；未送出草稿保留，回到舊條件不復活舊結果。草稿或檔案變更取消既有預檢，晚回應不得覆蓋新草稿。同步鎖阻擋連點，空草稿不能提交。檔名只保留安全字元，Blob URL 延後釋放；窄畫面控制和長識別換行。

逐筆清單使用 `ArchivePreflightRecords`，每頁 25 筆、相容性篩選與 ID 搜尋。完整 verdict、原因、coverage、來源計數、帳戶與全域容量始終留在篩選外。即使篩選只剩相容或零筆，整份受阻判定仍可見。每筆原始研究狀態、kind、proposal 和 currentness 不因篩選改寫，所有清單操作無額外 API 或持久化。

## 這不是什麼

這不是預覽匯入（尚未實作）、備份還原、刪除、研究重算、研究通過、實際成交、開盤流動性證明、盤中限價路徑、券商狀態或交易授權。全日量依然只是事後代理，GTD 未知後續依然未知；封存不改變任何提案、帳本、委託、權重或執行資格。
