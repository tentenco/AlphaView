# AlphaView 日線資料恢復方案評估

查核日期：2026-09-05。範圍是下一輪 Harness 的資料品質工程，不是行情供應商可用性保證。本次只讀取官方文件與現有程式，未申請帳號、購買方案、使用 API 金鑰或修改本地行情。

## 已知問題與判斷界線

主代理本輪檢查回報 95 檔無效／缺資料標的；SPY 身分符合美元 ETF，但 2026-09-04 日線出現非有限值。這是特定抓取結果，不代表 SPY 所有日期都不可用，也不能推論改用其他供應商必定恢復。應保留該次日期、錯誤類型、請求參數及來源，逐類驗證。

目前 `market.fetch_symbol()` 使用 yfinance 的兩年日線、`auto_adjust=False`、`actions=False`，未啟用 repair；驗證美元身分、OHLC、調整收盤價及交易日後，才整批替換該標的。原始資料不合格時保留既有資料，是正確的發布界線。

## 三條路徑

| 路徑 | 能提供什麼 | 邊界與採用條件 |
| --- | --- | --- |
| Yahoo／yfinance 原始重試 | 同來源重新抓取，可恢復暫時失敗或供應者後續修正 | 先分類傳輸錯誤、限流、缺日、非法價格及身分問題；有限次退避，不把確定資料錯誤當成無限重試理由。沒有已查得的保證吞吐或收盤後 15 分鐘供應 SLA。 |
| yfinance `repair=True` | 嘗試修正倍數／貨幣混淆、公司行動調整及缺失價量；部分資料由較短區間重建 | 這是轉換過的同來源資料，並非獨立驗證。需獨立 staging、逐欄差異及轉換版本，使用者明確選擇後才能採用。 |
| Alpha Vantage adjusted daily | 明確提供原始日線 OHLCV、調整收盤價、拆股與股息事件 | `TIME_SERIES_DAILY_ADJUSTED` 是 premium 端點；免費額度不足以支援目前股票池，付費及商業授權需另確認。適合先做少量對照，不應默默補進 Yahoo 序列。 |

## Yahoo 原始資料與 repair 的語意

官方 history 文件列出 `repair=False`、`keepna=False` 預設值，`auto_adjust` 控制所有 OHLC 的自動調整；起日包含、迄日不包含。診斷工具應明確設定 `keepna=True`，留住缺值列供比對；正式驗證不能因隱藏 NaN 而把不完整期間判成完整。[PriceHistory 參數](https://ranaroussi.github.io/yfinance/reference/yfinance.price_history.html)

官方 repair 文件說明會用較短區間重建缺失日線，重建價量可能與 Yahoo 日後修正值不同，也存在誤判。`Repaired?` 並非完整稽核證據：部分僅調整 `Adj Close` 的修正不會將旗標設為真。修正貨幣後應核對 history metadata。因此要保存原始／repair 兩份完整差異，而非只檢查旗標；不能用前值填補取代修復。[Price Repair](https://ranaroussi.github.io/yfinance/advanced/price_repair.html)

套件授權與資料使用權不同：yfinance 為開源工具、非 Yahoo 官方背書，README 將資料 API 定位為個人使用，並要求另閱 Yahoo 資料條款。專業多人 Web Panel 的資料展示權不能由套件 Apache 授權推導。[yfinance 官方專案](https://github.com/ranaroussi/yfinance)

## Alpha Vantage：可實作但需要資格的對照來源

Adjusted daily 回傳原始 OHLCV、調整收盤及拆股／股息資料；`compact` 只有最近 100 筆，不能滿足目前 MA200 暖機，需 `full`。必須使用 API key，端點明列 premium。本次沒有呼叫個股 API，沒有驗證 SPY 或該 95 檔的實際涵蓋。日資料仍須以回傳 metadata 與日期對齊 XNYS，排除未完成時段；文件沒有在這次查核中建立「正式收盤後 15 分鐘必定完整」的承諾。[官方 API 文件](https://www.alphavantage.co/documentation/#dailyadj)

官方方案頁目前列出標準免費額度 25 次／日，premium 沒有每日總額限制，但仍需依所選方案確認每分鐘配額。即使假設每檔只需一個請求，95 檔重試加 SPY 至少 96 次；500／1,000 檔每日更新顯然超過免費額度。此為容量推算，並非實測速度或可用性。不要引用舊文章的 500 次／日說法。[官方方案頁](https://www.alphavantage.co/premium/)

官方條款預設授權私人非商業使用，另有書面約定除外；公司使用或提供其他使用者存取資訊涉及其商業使用定義。付費 API key 不等於已取得面板再分發權，下一輪如要商用需先確認適用合約。[官方使用條款](https://www.alphavantage.co/terms_of_service/)

## 下一輪推薦順序

1. **做可重現的資料診斷，不先更換資料源。** 使用目前錯誤清單分層抽樣：缺日、最新非有限值、OHLC 不一致、身分問題各數檔，加 SPY。保存時間、參數、套件版本、原始回應雜湊及驗證原因。先限制請求預算與總時間，429／暫時網路錯誤採有限退避並可取消。
2. **建立 repair 比較預覽。** 同一標的／同一區間分別取得 raw 與 repair 到隔離儲存區，逐日列出新增、刪除、OHLC／調整價／成交量變更及品質檢查。即使修正通過，也要標示 reconstructed／repair 來源與版本。將變更集指紋與既有資料版本綁定；預覽後資料有變則重做確認。
3. **提供顯式資料集選擇，再接第二供應者。** 表鍵增加 provider、dataset revision、調整方式及抓取時間；掃描與回測指紋涵蓋這些欄位。預設不混合單一標的內不同供應者的 bar；來源切換整個期間、可回復，行情來源清楚顯示。Alpha Vantage 先以使用者另行提供且具適當授權的 key 做少量驗收。
4. **SPY 基準最後掛接。** 身分、調整價與所選回測區間通過後，才新增獨立基準；缺失日期保留不可用，不延用舊值，不把 SPY 不可用變成整個原有同股基準回測不能使用。

驗收至少涵蓋：429／逾時及取消不發布、全 NaN 與部分缺欄、split／dividend 跨日調整、`Repaired?` 假但調整價有變、缺交易日不補值、UTC／美東日期與提早收盤、非 USD 或代碼身分漂移、100 筆不足暖機、跨供應者不靜默拼接、資料版本改變使回測快取失效、使用者取消比較不修改行情。

成功條件是「可追蹤地恢復經驗證的資料，否則維持明確不可用」，不是讓所有畫面都出現數字。以上皆為下一輪設計建議，尚未實作自動 repair、替代資料來源或 SPY 基準。

## 本輪限定診斷：SPY 與 APH

2026-09-05 00:38–00:40 UTC 執行兩次隔離診斷，沒有採用價格、更新應用資料庫或更動專案依賴。第一輪使用專案環境，raw 成功，但 repair 因缺少 `sklearn` 失敗；第二輪以 `uv run --no-project` 暫時提供 yfinance 1.7.0、scikit-learn、exchange-calendars 與 FastAPI。這不是所有 95 檔的恢復測試。

| 標的 | raw 無效日期／非有限或缺值欄位 | repair 結構驗證 | 非 `Repaired?` 欄位變更 |
| --- | --- | --- | --- |
| SPY | 1 日／2 格；2026-09-04 Close、Adj Close | 通過 | 2 格，由不可用變為 769.55 |
| APH | 5 日／22 格；2026-08-28、09-01 至 09-04 | 通過 | 3,008 格；包含歷史價格減半、成交量加倍 |

四份結果各有 502 個日期，raw／repair 之間未新增或移除日期。APH 的例子：2024-09-05 Close 從 61.86000061035156 變成 30.93000030517578，Volume 從 5,158,600 變成 10,317,200。大量改寫不能描述成只補最近缺值。

可於本地忽略目錄查看完整證據：`artifacts/price-repair-20260905T003812Z-8aad3053/` 與 `artifacts/price-repair-20260905T003913Z-ee743a46/`。這些資料不隨 GitHub 發布。JSON 保存每欄差異、品質問題、來源身分、獨立抓取時間及資料雜湊；雜湊對象是正規化的列資料 JSON，非 HTTP 原始回應。非有限值轉為 null 並另列問題。

### APH 公司行動的獨立證據

Amphenol 官方 2026-08-06 新聞稿與 SEC 8-K 都記載董事會核准二拆一，以股票股利形式對 2026-08-17 登記股東預定於 2026-09-02 配發。這項已公布的公司行動，為觀察到的二倍尺度差異提供合理背景；這兩份公告本身不等於事後完成證明，也沒有驗證供應者每根 bar 應採哪個調整因子。[官方 IR 公告](https://investors.amphenol.com/news-and-events/news-details/2026/Amphenol-Announces-Two-for-One-Stock-Split-and-Third-Quarter-2026-Dividend/default.aspx) · [SEC 2026-08-06 8-K](https://www.sec.gov/Archives/edgar/data/820313/000110465926091969/tm2622441d1_8k.htm)

另有一次 2024 年二拆一，2024 年報明確記載 6 月 11 日配發、6 月 12 日開始按拆股後基礎交易。那次事件早於本次兩年診斷起日，不能與 2026 年事件混為一談。[SEC 2024 年報](https://www.sec.gov/Archives/edgar/data/820313/000155837025000714/aph-20241231x10k.htm)

**結論：公司行動公告可以核實；repair 價量正確性尚未證明。** 原始序列也可能已經調整過，單憑存在二拆一就再除以二，可能造成重複調整。需另查交易生效日期、原始與修復序列在事件前後的尺度、調整因子與獨立日線，逐欄核對後再決定是否採用。raw 與 repair 是先後兩次請求，供應者期間更新也可能造成差異。

### 診斷 CLI 重現與停止

`scripts/compare_price_repair.py` 限制最多五檔，每檔子程序最多 180 秒、總下載預算最多 480 秒；以下示例限定兩檔並綁定本輪停止時間與 STOP 檔案：

```sh
uv run --no-project --with yfinance==1.7.0 --with scikit-learn --with exchange-calendars --with fastapi \
  python scripts/compare_price_repair.py SPY APH \
  --stop-at 2026-09-05T03:47:25+00:00 \
  --stop-marker artifacts/harness-2026-09-05/STOP
```

這是重現命令，不代表文件更新時又重新下載。依賴安裝時間不在 CLI 子程序下載預算內；啟動後仍受絕對 `--stop-at` 限制。STOP 檔案存在時不啟動新請求，執行中的 worker 會在父程序下一次檢查時終止並回收。既有輸出目錄／證據檔案不覆寫。

後續執行的產物新增 Python、pandas、NumPy、yfinance 與選用 scikit-learn／SciPy 的實際版本，以及明確雜湊基礎。上述舊產物維持原樣，不追補未在當時記錄的版本資訊。repair 結果仍只供比較，不會寫入 AlphaView 行情或解鎖 SPY 基準。
