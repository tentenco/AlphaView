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
