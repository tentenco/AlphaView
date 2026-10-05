# 封存預檢完整 CSV

格式識別：`archive_preflight_readable_v1`。這是已接受預檢報告的閱讀格式，不是新的研究方法，也不改變各封存的既有方法版本、校驗規則或相容性判定。

## 使用位置與下載範圍

四種封存區完成 **唯讀預檢封存檔／Preflight archive read-only** 後，在 **逐筆預檢紀錄／Individual preflight records** 按 **下載全部預檢紀錄CSV／Download all preflight records CSV**。

| 封存區 | 所屬位置與範圍 | 原封存說明 |
| --- | --- | --- |
| 研究收據封存與預檢／Research receipt archive and preflight | Agent 工作流的「配置與回條」；所選帳戶的配置研究收據 | [配置研究收據封存](allocation-receipt-archive.md) |
| 前綴診斷封存與預檢／Prefix diagnostic archive and preflight | 回測研究台的單股診斷區；所選股票的前綴診斷收據 | [前綴診斷收據封存](research-integrity-archive.md) |
| 路徑收據封存與預檢／Workflow path receipt archive and preflight | Agent 工作流的「路徑回條封存」；所選帳戶的路徑與成本回條 | [路徑收據封存](workflow-path-receipt-archive.md) |
| 執行研究收據封存與預檢／Execution study receipt archive and preflight | 「配置與提案」的執行研究回條封存；所選帳戶的執行研究回條 | [執行研究收據封存](execution-study-receipt-archive.md) |

下載保留當次已接受報告的全部欄位、全部原序紀錄及重複識別。不套用相容性篩選、ID 搜尋、每頁 25 筆分頁或 details 展開狀態，也不排序、去重或只留相容紀錄。受阻報告仍可下載；零筆報告仍保留整份判定、原因、涵蓋、容量與來源脈絡等已回傳內容。

「全部」指預檢 API 已回傳的完整報告。它不補回報告原本未包含的封存 payload、儲存格原文或未知計數，也不以 `records.length` 取代 `coverage` 的原始宣告。

## 六個固定欄位

CSV 採長格式，同一筆預檢紀錄會展開成多列。

| 欄位 | 意義 |
| --- | --- |
| `export_format` | 每列固定為 `archive_preflight_readable_v1`。 |
| `section` | `export` 是閱讀說明；`report` 是整份報告；`record` 是逐筆紀錄。 |
| `record_index` | `record` 列使用原 `records` 陣列的索引，從 0 起算；其他 section 留空。重複或未知 ID 仍各占自己的索引。 |
| `field_path` | 對應原報告的 JSON Pointer 路徑，例如 `/records/0/compatible`。鍵名中的 `~` 編為 `~0`、`/` 編為 `~1`；根物件路徑留空。`export` 區路徑只用於閱讀說明。 |
| `value_type` | `object`、`array`、`string`、`number`、`boolean`、`null` 或 `missing`。 |
| `value` | 原已解析值的文字表示；容器與 `missing` 留空，由型別區分。 |

順序為閱讀說明、整份報告中繼資料、再依原陣列順序展開每筆紀錄。物件依已解析物件的鍵順序展開，不額外排序；陣列依原順序展開。物件與陣列本身各有一列型別標記，因此空物件、空陣列也會保留。

整份報告包括實際存在的 `engine_version`、帳戶或股票身分、交易日、輸入版本、檢查時間、封存校驗值、政策、整份 verdict、原因、coverage、封存脈絡、snapshot currentness 與容量。各筆紀錄同樣保留身分、種類、相容性、原因、重複狀態、完整性及封存時／目前的來源狀態。其他已回傳欄位也會遞迴保留，不只輸出畫面摘要。

## 缺值與型別

| 原內容 | CSV 表示與讀法 |
| --- | --- |
| 有限數值 | `number`；保留已解析數值，負零寫成 `-0`，不四捨五入成畫面顯示值。 |
| 布林值 | `boolean`，值為 `true` 或 `false`。 |
| 空字串 | `string`，值留空；不同於 `null`、缺欄或空容器。 |
| JSON `null` | 型別與值都寫成 `null`，不改成 0 或推定原因。 |
| 空物件／空陣列 | 分別以 `object`／`array` 標記，值留空，沒有子列。 |
| 共用檢閱欄位未出現在報告或紀錄 | 增列 `missing`，值留空；只表示欄位缺席，不推論是不適用、損壞或未知。 |

`missing` 僅針對共用檢閱欄位清單補標記。整份報告清單包含版本、帳戶／股票、日期、輸入版本、檢查時間、判定、校驗值、政策、原因、涵蓋、脈絡、來源狀態、容量與紀錄；逐筆清單包含 ID、指紋、序號、診斷狀態、種類、工作流／提案、相容性、原因、重複、完整性與來源狀態。某個家族沒有另一家族的欄位時，也只標缺席。任意未知欄位不會被憑空建立。

研究的 `unavailable`、整份 `blocked`、來源過期及容量未知仍依報告原值保留。下載不重新判定研究結果；CSV 中真正已知的零值可以是 0，缺值不補零。

## 編碼、上限與來源生命週期

檔案使用 UTF-8 BOM、CRLF 換行，所有儲存格以雙引號包住，內部雙引號成對跳脫。字串若以試算表公式觸發字元開頭，含空白／控制字元後的 `=`、`+`、`-`、`@` 及對應全形字元，會加前置單引號；以 tab 或換行開頭的字串也同樣處理。數值欄位的負數仍保留數值型別。這個保護可能使文字外觀增加單引號，不應用 CSV 重建原封存位元組或核對原 hash。

檔名為 `alphaview-preflight-<方法>-<帳戶或股票>-<交易日>.csv`；各部分只保留適用於檔名的字元並限制長度，缺失時使用 `unknown`。檔名處理不改 CSV 內的原報告欄位。

下載需對應目前顯示的同一報告物件及其完整 `records` 陣列。帳戶、股票、來源脈絡或封存草稿變更而使既有預檢撤下時，其 CSV 也隨之撤下；舊請求不能恢復舊下載。搜尋與分頁只改前端檢閱狀態。

若報告種類或身分不符、存在非有限數值或不能表示為 JSON 的內容、循環參照／稀疏陣列、孤立 UTF-16 surrogate，或超過任一上限，整份 CSV 不提供下載，不省略錯誤欄位來產生部分檔案：

- 最多 500 筆預檢紀錄。
- 完整 CSV 最多 32 MiB，含 BOM、引號、分隔與換行。
- 遞迴展開深度最多 64；輸出列最多 250,000，含標題與型別標記。

產生或下載失敗會顯示不可用訊息。這些是 CSV 轉換界限，不改原封存上限、資料庫保存容量或原預檢判定。

## 與原封存 JSON 的差異

CSV 來自瀏覽器已解析的預檢報告，數字文字、物件鍵序及公式保護後的字串不保證與伺服器原文相同。預檢報告也不是原封存的完整內容副本。需要原封存的儲存格、原始 JSON 字串、原始數字文字或校驗依據時，請保留既有封存 JSON 下載。

這不是匯入檔、資料庫備份、還原、刪除、修復、容量清理或新的研究回條。CSV 按鈕只在瀏覽器產生本機下載，不呼叫新 API、不重算研究、不寫入資料庫，也不更改原 JSON 或 hash。結構相容不代表研究成功、來源仍當期或交易授權；下載不改 `import_authorized`、`delete_authorized` 或 `execution_source` 等既有政策。

使用流程見[研究證據使用指南](research-evidence-guide.md)。
