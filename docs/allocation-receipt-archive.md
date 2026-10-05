# 研究收據封存與唯讀預檢

方法版本：`alphaview-allocation-receipt-archive-v1`；封存 schema 版本為 `1`。這個工具提供同帳戶研究收據的完整集合匯出，以及本機封存檔的結構相容性預檢。它不匯入、不刪除、不改 schema，也不把收據提升為可執行來源。

## 完整集合匯出

`GET /api/paper/accounts/{account_id}/allocation-research-receipt-archive` 在同一 `@store.snapshot_read` 唯讀快照中讀取帳戶的全部收據，依保存時間與識別排序；不套用收據歷史畫面的 20 筆分頁，也不包含其他帳戶的收據。

封存包含方法／schema／校驗算法識別、帳戶及版本、最新已完成交易日、輸入版本、匯出讀取時間、保留政策，以及每筆不可變資料列的八個原始欄位：`id`、`account_id`、`run_id`、`created_at`、`engine_version`、`request_json`、`content_fingerprint`、`payload_json`。原始 JSON 欄位保存為字串，不經解析後重寫；損壞的 SQLite BLOB 保存為 base64，且保留原儲存型別、位元組數、逐格 SHA-256、可用狀態與原因。

每筆另列既有收據完整性與讀取時的來源資格。損壞內容不會被省略或變成空白成功紀錄：在上限內的錯誤 JSON、NaN 字面值、原始 BLOB 可作為不透明字串／base64 保留，但完整性標為不可用。來源過期與內容完整性分開；不重算歷史權重、風險或覆蓋，也不補回已遺失的工作流。

範圍與容量：

- 每帳戶最多 50 筆；全域保存上限仍為 500 筆。滿額保存繼續拒絕，匯出不騰出容量，不自動刪除任何紀錄。
- 原始 payload 每格最多 256 KiB、保存請求每格最多 16 KiB、其餘 metadata 每格最多 4 KiB。超限儲存格不讀入完整內容，保留位元組數及 `cell_size_limit`；未取得的內容與逐格 hash 都為 `null`。
- `coverage.complete_set` 只表示所有資料列已列出，不等於所有內容均完整。`raw_complete`、`integrity_available`、`integrity_unavailable` 分別說明完整原文與可驗證內容的筆數。
- 整份編碼後 JSON 最多 32 MiB。資料列超過 50 筆或整份超過大小限制時，拒絕整次匯出，不截斷成看似完整的檔案。

## 校驗格式

`checksum` 是排除外層 `checksum` 欄位後，使用 Python `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)` 所得 UTF-8 內容的 SHA-256；識別為 `python-json-sort-keys-utf8-finite-v1`。這沿用既有收據 canonical JSON 規則，不宣稱是 RFC 8785/JCS。原始 JSON 字串的空白與內容不變，只有外層物件使用此排序規則。

逐格校驗驗證原始 UTF-8 或解碼後 BLOB 位元組。收據另有保存請求 identity、payload 指紋，以及內層研究 evidence 指紋；預檢逐層核對，不以外層 checksum 代替原有關係驗證。

這些 hash 可偵測不一致，**不是簽章或來源真實性證明**。可改寫整個檔案與所有 hash 的人仍可產生另一個自洽檔案；完整集合標示也不是不可偽造的外部證明。下載保留前端已接受的原始伺服器回應文字，避免前端重新序列化改寫未知欄位或數字。

## 唯讀預檢

`POST /api/paper/accounts/{account_id}/allocation-research-receipt-archive/preflight` 接受 `Content-Type: application/json` 的**原始封存 JSON**，沒有包成另一層字串的 request。串流接收超過 32 MiB 即回 413；錯誤媒體型別回 415；不存在帳戶回 404。其餘封存不相容回 200 advisory report，`verdict` 為 `compatible` 或 `blocked`，不是研究通過與否。

在唯讀快照中檢查：

1. UTF-8、JSON 語法、所有層級的重複 key、非有限數字，以及嚴格封存 schema；未知新版本回 `archive_version_unsupported`，不嘗試降級解讀。
2. 外層 checksum、完整集合與筆數、逐格儲存型別／編碼／長度／hash／大小上限。
3. 每筆保存請求 identity、payload 與 evidence 指紋、同帳戶與同來源關係、保存請求的嚴格欄位／範圍及研究請求綁定、可理解的 evidence 形狀。
4. 收據、研究、工作流與掃描方法版本相容性。較新或未知方法即使 hash 自洽也不能判為相容。
5. 封存檔內重複識別、本機是否已有完全相同的八欄紀錄、同識別內容是否衝突。只重複相同本機紀錄可以相容；封存內重複或本機衝突則受阻。其他帳戶的來源不會拿來做 currentness 查詢，也不支援帳戶移植。

原始內容被保留不代表其 integrity 可驗證；被 withheld 的儲存格、損壞 JSON、矛盾或缺少的證據仍為不可用。不存在本機的合法同帳戶紀錄可以回報結構相容，但沒有寫入操作、匯入承諾或授權。回傳錯誤不回顯使用者完整輸入。

## 歷史與目前條件

`archived_currentness` 原樣呈現封存時的標示，`currentness` 由目前本機來源重讀判斷。帳戶版本、輸入、交易日、收據集合的差異另列在 `snapshot_currentness`，不把過期來源誤稱損壞資料，也不把結構相容誤稱目前可執行。

目前帳戶／全域占用、剩餘容量與檔案中尚未在本機的紀錄數只供檢閱。即使回報 `compatible`，`import_authorized`、`delete_authorized`、`execution_source` 都固定為 `false`，沒有任何清理或寫入副作用。

## 介面與草稿

載入元件不發請求。「準備完整帳戶封存」才讀取本機 API，接受完整集合回應後才能下載。「選取本機封存 JSON」只把檔案以嚴格 UTF-8 解碼讀入草稿；超限或編碼錯誤保留原草稿。貼上內容不會自動送出，必須按「唯讀預檢封存檔」才送至本機 API。

連點只啟動一個請求。帳戶、帳戶版本或已知來源識別改變時，撤下舊封存／預檢結果、中止舊請求，**保留未儲存草稿**；修改草稿會撤下並中止依舊草稿進行的預檢。延遲回應不能重新顯示舊結果。損壞標記與檔案字串皆以 React 純文字／textarea 呈現，不作 HTML 執行。

逐筆預檢清單使用共用 `ArchivePreflightRecords`，每頁 25 筆，提供「全部／相容／不可用」與選填的 ID 子字串搜尋。清單顯示符合／全部已回傳筆數、範圍與頁次，保留原陣列順序與每一個重複 ID 列。摘要長 ID 僅縮寫為前 12、後 8 字元，完整原值仍能在 title 與 details 展開內容檢視；未知識別不生成替代 ID。

篩選只看每列原 `compatible`。上方整份受阻／相容結論、全部錯誤、原 coverage、來源計數及帳戶／全域容量都保持完整；即使清單只顯示相容紀錄或零筆，整份失敗也不會消失。原 coverage 的未知筆數仍顯示 `—`，不拿清單筆數補值。

搜尋僅作不分大小寫的字面 ID 比對；篩選／搜尋改變時回到第一頁，新接受的報告物件重設控制，相同報告重繪不清除選擇。原生 details、選單、搜尋與分頁按鈕支援鍵盤，390px 寬控制改為直向。這是呈現層操作，不觸發請求、不更動來源／payload、不去重或改寫 JSON、不寫入 storage／hash；完整下載仍使用原先接受的伺服器文字。

## 這不是什麼

不是資料庫備份或還原，不包含行情、工作流資料表或全部帳戶資料。不是匯入、刪除、容量清理、配置套用、研究判定通過或交易授權；不呼叫行情來源、模型或券商。封存可能包含私人帳戶條件或研究資料，下載僅在使用者明示操作後產生本機檔案。

測試：`tests/test_allocation_receipt_archive.py` 使用合成資料與隔離 `PANEL_DB_PATH`；涵蓋完整集合、同一快照、原字串／BLOB、來源過期、帳戶隔離、hash／schema／版本／重複／容量限制，以及讀取前後資料表及 revision 不變。`web/src/AllocationReceiptArchive.test.tsx` 涵蓋顯式動作、原始回應下載、檔案與貼上、連點、舊回應、身分核對及草稿保留。
