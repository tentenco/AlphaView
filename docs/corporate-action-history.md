# 公司行動保存版本與差異

`alphaview-corporate-action-history-v1` 讓使用者在選定紙上帳戶的風險頁，瀏覽目前持有標的的公司行動保存版本、檢視原始儲存格，或比較兩份保存內容。它只讀取既有 `corporate_action_evidence`，不抓取新來源、不建立新資料表、不調整帳本。

## 範圍與版本

按「載入持有標的範圍」後選擇標的，再載入保存版本。每次 API 讀取都重新檢查該帳戶是否仍有有限、正數的目前持倉；另一帳戶沒有持有該標的就不能透過這組端點讀取其歷史。公司行動本身仍是共用標的資料，不是某個帳戶專有事件。回應不帶持股股數、成本或現金。

最多列出 100 個持倉範圍；超過上限明確拒絕，不默默截斷。異常股數顯示範圍不可用，不能當作有效的空帳戶。這個範圍檢查只決定當次讀取權限，不證明事件發生時持有，也不確認公司行動權利。

一個 evidence revision 代表不同的 adapter-returned payload。相同內容再次擷取會重用原 revision，所以「保存版本數」不是擷取次數。列表每頁 20 筆，API 最多 50 筆，offset 最大 5000；介面到達上限會說明更早版本未列出。兩份選取可跨頁保留，勾選順序決定基準與比較對象；最多兩份，可明確清除選取。

## 歷史覆蓋範圍永遠未知

既有 `corporate_action_coverage` 只保存**最新**擷取範圍、欄位計數與日期窗口，沒有每個 evidence revision 的歷史 coverage。此功能不讀取這張最新 coverage 表來推測舊版本涵蓋的期間。

每個版本及比較都回傳 `historical_coverage: null`、原因 `historical_capture_coverage_not_stored`，來源完整性固定為 `unknown`。原 payload 的 `columns_present` 只表示該份內容有哪些 adapter 欄位；不代表所有日期或事件完整。

保存內容略過已知的日常零值儲存格，因此某日期、種類不在 payload 中，可能是保存時沒有該欄、超出未知的歷史範圍、回傳零、供應者修訂，或其他未能確定的情況。**不能**把缺少的事件解讀為未發生、金額零、公司取消事件或實際權利被撤銷。`saved_event_count: 0` 只表示保存的事件列為零，不表示真實事件為零。

## 完整性與原始內容

讀取時核對 canonical JSON 內容指紋、支援的 evidence v1 方法、完整 payload／事件欄位格式、有限數值、固定未知原因、欄位與事件種類關係，以及唯一 `(ex_date, kind)`。上限為每份 1 MB、1,600 個事件。重複 JSON key、缺欄、未知方法、非有限 JSON、矛盾欄位或損壞 metadata 都標示不可用，回傳 null payload，不沿用另一個舊版本。

標的、revision 與首次擷取時間是既有資料列 metadata。程式核對標的範圍、版本與時間格式；**payload 本身沒有 symbol，也沒有 first_fetched_at，所以內容 hash 不能單獨綁定標的或首次擷取時間**。這不是數位簽章；一致重寫資料與指紋的攻擊不在它能證明的範圍內。

可用版本保留完整 `payload` 與逐字 `payload_json`。每個儲存格的 `raw_type`、`raw_value`、`value`、`reason` 都保留。字串 `"2.50"` 不會被轉成可用金額；`None`／非有限值的數值仍為 null。畫面顯示原始文字與型別，數值不採固定小數位截斷。

「下載此版本原始保存 JSON」下載該份儲存的原文，不是重新序列化的近似副本。檔名帶清理後的帳戶、標的及 revision；JSON 本身保留原格式而不插入聲稱屬於來源的額外身分欄位。「下載此比較證據 JSON」保存整份目前比較回應，包含帳戶範圍、請求、兩份原始內容、指紋、差異與未知原因。下載不重新查詢、計算或發布任何內容，Blob URL 使用後回收。

## 比較語意

比較以兩份 payload 的 `(ex_date, kind)` 聯集為準，只列出有差異的事件。兩邊完整原事件與欄位值均保留。

| 差異代碼 | 只描述的事實 |
| --- | --- |
| `added` | 比較對象的保存內容有此事件，基準內容沒有。 |
| `removed_from_saved_payload` | 基準保存內容有此事件，比較對象沒有；不表示實際取消。 |
| `changed` | 兩邊都有事件，原始值、可用數值或未知原因改變。 |
| `raw_type_changed` | 原始型別不同；可同時有 `changed`。 |

不存在的一邊為 null，並附 `event_absent_from_saved_payload`；每個欄位也保留該邊的缺少／不可用原因，不填零。只有兩邊事件都有可用有限數值、原始型別相同且 adapter 版本相同時，才提供 `selected.value - baseline.value` 的數值差；其他情況為 null 並附原因。這只是相容保存值的算術差，不是帳戶權利、損益或經調整後的經濟效果。

若事件內容相同、只有 adapter／欄位 metadata 改變，事件差異列可以是 0；兩份完整 metadata 仍保留，不能由此推論來源完整或沒有其他事件。任一版本不可驗證時，整個比較顯示 unavailable、差異列與計數為 null，沒有部分假比較。

## API 與一致快照

基底為 `/api/paper/accounts/{account_id}/corporate-actions/history`：

- `GET /context`：目前持有標的、帳戶版本、完成交易日與 input revision。
- `GET /{symbol}?limit=20&offset=0`：保存版本摘要與分頁資訊，不帶完整 payload。
- `GET /{symbol}/{revision}`：單一完整版本與保存原文。
- `POST /{symbol}/compare`：唯讀比較，請求必須有 `expected_account_version`、`baseline_revision`、`selected_revision`、`expected_baseline_fingerprint`、`expected_selected_fingerprint`。

所有端點使用 `@store.snapshot_read`；不初始化 schema、不寫資料、不改 input revision。版本需為兩個不同的正整數，拒絕布林、字串版本、非有限 JSON、額外欄位與越界。帳戶版本或預期內容指紋不符回 409；不持有標的或找不到版本回 404。比較資料來自同一個 SQLite 讀取快照。目前帳戶／交易日／revision metadata 與歷史保存值分開呈現。

介面只有按需讀取，沒有背景輪詢或來源更新。切換帳戶、標的、選取或生命週期會清除舊 detail／comparison／download，進行中的操作會中止；連點不重複送出。兩份選取可跨頁保留，409 或範圍身分不一致時須重新載入範圍。

## 這不是什麼

這不是來源完整性證明、Yahoo wire payload、事件取消判定、完整公司行動重播、權利確認、股息應收、拆股入帳或操作指示。它不改持倉、成本、現金、提案、委託、績效或權限，也不呼叫供應者、模型或券商。

合成測試涵蓋 immutable payload／原文、型別與數值差、缺事件／缺欄／缺 coverage、metadata 與內容損壞、嚴格版本和頁數上限、每次 held-scope 檢查、只讀快照、跨帳戶拒絕，以及 UI 的跨頁選取、連點／切換中止、不可用證據和精確 JSON 下載。
