# 保存的前綴診斷回條

回條方法版本：`alphaview-research-integrity-receipt-v1`。計算仍使用既有 `alphaview-research-integrity-v1`；新增的 `evidence_fingerprint` 只綁定完整診斷回應，不改比較或數值語意。

在 Research Desk 的歷史前綴比較區，可以明確按「保存這次前綴回條」。伺服器重新執行相同請求，確認與畫面已檢閱的來源和證據完全一致後，保存一份不可變紀錄。保存不重新挑選切點、不縮減比較視窗，也不接受使用者提供的結論或指標。

## 什麼被保存

每份回條保留保存識別、UTC 時間、回條方法、完整正規化請求、來源欄位與**完整伺服器診斷**。來源包含標的、交易日、工作區 input revision、Desk 歷史指紋、診斷與研究引擎版本、請求指紋和證據指紋。

診斷內原有的切點、比較日期、指標欄位、布林與數值差異、缺值、計數、截斷旗標、範圍、容差、成本上限及警語都保持原樣。`no_difference_detected`、`differences_found` 和 `unavailable` 均可保存；保存「不可用」的診斷不會將缺歷史指紋或數值填為零。

內容以 UTF-8 canonical JSON 保存：鍵排序、固定分隔符、不輸出非有限數字。外層內容 SHA-256 綁定保存識別與 UTC 時間，讀取時也要求這兩個欄位與資料列 metadata 相同。修改回條內容、請求、來源或 metadata，使一致性無法核對時，讀取回報不可用；不重新算一份取代舊資料。

## 保存、衝突與重試

`POST /api/research-desk/integrity-receipts`，嚴格接受：

```json
{
  "request": {
    "symbol": "SYNTA",
    "config": {"strategy": "rsi_reversion", "params": {"period": 14, "entry": 30, "exit": 55}},
    "test_start": null,
    "test_end": null,
    "max_prefixes": 6
  },
  "expected_input_revision": "畫面讀取的工作區輸入版本",
  "expected_as_of": "YYYY-MM-DD",
  "expected_evidence_fingerprint": "完整診斷回應的 SHA-256"
}
```

日期、策略與參數沿用 `IntegrityInput` 的完整驗證。額外欄位（包含自行填入的 `verdict`）、非有限參數與錯誤型別回 422；不回送無法有限 JSON 序列化的原始錯誤值。

1. 以回條方法版本與正規化保存請求產生確定性的識別。相同請求已有可驗證回條時，直接重播那份原始內容，回 200／`replayed=true`。
2. 新紀錄先在一致唯讀快照核對期望的 input revision 與完成交易日，呼叫既有前綴診斷，核對完整請求、完整證據 hash、交易日及 revision。
3. 結束昂貴的唯讀計算後，開啟 `BEGIN IMMEDIATE`。再次檢查有無同一份回條，以及 revision、交易日、回條／診斷／研究引擎版本是否仍一致；任何差異回 409，不留下半份紀錄。
4. 經過容量與內容大小檢查才做一次 INSERT，回 201／`replayed=false`。兩個同時到達的相同請求只保存一份，另一個重播。

精確重試先找已存在的回條，因此即使工作區或交易日後來變更，也能取得原始歷史，並附上「目前來源已非當期」。若該識別的既有內容損壞，重試回 409；不覆寫或以新計算修補它。較晚重新計算、取得新來源或不同請求的診斷會產生不同識別。

## 歷史內容與目前來源分開

- `GET /api/research-desk/integrity-receipts?symbol=SYNTA&limit=20&offset=0`：每頁最多 20 筆，可省略 symbol 查看工作區；offset 上限 500。
- `GET /api/research-desk/integrity-receipts/{id}`：完整保存回條及本次讀取的來源資格。
- 上述讀取端點使用 `@store.snapshot_read`、`Cache-Control: no-store`，不重建指標或重新執行診斷。

`integrity.available` 描述保存內容能否通過 hash、canonical bytes、請求、標的／設定、來源與 metadata 的交叉核對。`currentness.current` 則獨立比較本次讀取的工作區 revision、最新完成交易日及方法版本；只有內容無法核對時為 `null`。現在過期不抹掉歷史的診斷值。

工作區 revision 是全域來源脈絡。`workspace_inputs_changed` **不表示此標的日線必然改變**；例如另一檔標的新增日線，也會使工作區 revision 改變。本功能沒有把這個全域差異偽裝成該標的歷史指紋差異，也不在每次歷史讀取重算指標。

畫面另列保存的策略、參數與比較區間。如果讀取的回條與目前比較請求不同，明示設定差異，且不將歷史設定套回表單。來源資格只描述此次讀取，不保證之後仍當期；沒有背景輪詢或自動重新計算來清除使用者草稿。

## 原始 JSON 下載

`GET /api/research-desk/integrity-receipts/{id}/evidence.json` 回傳 SQLite 已保存的完整 `payload_json` **原始 UTF-8 位元組**，包含回條 id、時間、請求、來源與完整診斷；不額外重算、不重新格式化。

可帶 `expected_content_fingerprint` 核對已讀取內容，若不同回 409；回應 `ETag` 帶保存內容指紋。畫面使用此檢查並直接把原始文字下載為 Blob，不經 JavaScript `JSON.stringify` 改寫浮點數表示或欄位順序。下載前檢查 JSON 和有限數值，檔名安全化、移除暫存連結並釋放 Blob URL。

歷史來源過期仍可下載可驗證的原始回條，因為下載的是當時紀錄。內容損壞則停用；下載不會把歷史資格更新成「當期」。取消等待或切換來源會中止瀏覽器等待，不保證伺服器已開始的保存計算停止。

## 保留政策與資料表

新增 `research_integrity_receipts`，欄位為 `id`、`symbol`、`created_at`、`engine_version`、`request_json`、`content_fingerprint`、`payload_json`；建立 `(symbol, created_at, id)` 索引。只在 host schema 初始化時建立，不在讀取或保存路徑執行 DDL，沒有對 input revision 的觸發器。

工作區最多 500 份、每份 payload 最多 256 KiB；SQLite 也以實際 UTF-8 byte 長度加 CHECK。到上限就拒絕新紀錄，精確重試仍可讀取。沒有自動刪除、覆寫、匯入或本功能的刪除端點。回條是工作區研究資料，不綁定任何交易帳戶，不含實際持股、成本或金鑰。

## 這不是什麼

保存回條只讓既有**抽樣診斷**可持久檢閱，沒有增加比較涵蓋或證明力。「抽樣前綴未檢出差異」不證明因果性、沒有所有可能的未來資料洩漏、可以獲利或達到交易就緒。原診斷對未抽樣切點、暖機、資料修訂、歷史當時可取得的調整價、選樣與成交模型的限制均保留；沒有新增提案閘、模型、行情供應商或券商呼叫。

實作：`alphaview/panel/research_integrity_receipts.py`、`web/src/ResearchIntegrityReceipts.tsx`。隔離合成測試涵蓋 recursive RSI 診斷、刻意注入未來指標偏移、原始位元組重播、無歷史保存、全域 revision 與單一標的資料的區別、讀寫交界變更、同時重試、metadata 篡改、損壞回條、容量上限及無自動刪除。畫面測試涵蓋明確保存／讀取、重複點擊、過期與損壞標示、來源切換、原始 JSON 下載及未自動套用設定。
