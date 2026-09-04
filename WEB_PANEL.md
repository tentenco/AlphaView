# AlphaView Web Panel

繁體中文、單一使用者、本地運行的美股研究面板。視覺參照 Tenten CRM：
窄版導覽、Geist 字體、深色中性底色、`#006b4f` 主操作色、5px 控制項圓角。
此面板專注美股研究，資料儲存在本地。

## 啟動

```sh
uv sync --locked --extra web --extra dev
npm ci --prefix web
npm run build --prefix web
uv run --extra web python -m alphaview.panel serve
```

開啟 **http://127.0.0.1:8876**。預設僅綁定本機，請從專案目錄啟動。
這是個人工作區，尚未提供公開部署所需的登入、多租戶與權限管理。

前端開發使用 `npm run dev --prefix web`（5173），後端照上方啟動。
API 文件：http://127.0.0.1:8876/docs 。

## 初始化與資料

可選擇建立通用的零持股觀察清單：

```sh
uv run --extra web python -m alphaview.panel seed
uv run --extra web python -m alphaview.panel refresh
```

`seed` 不覆寫既有持股，也不包含任何個人股數、成本或帳戶資料。
初始觀察清單為 AAPL、MSFT、GOOGL、AMZN、META、NVDA、TSLA，全部為零股。
你可以在「我的持股」輸入自己的持股與平均成本；既有本機工作區會繼續保留資料。

- 行情：Yahoo Finance / yfinance，最近兩年日線；僅接受 USD。
- SPCX 核對為 SpaceX，只接受名稱含 SpaceX / Space Exploration 的資料，
  並排除 2026-06-12 前的資料，避免誤用同代碼舊 ETF。
- 資料庫：`data/panel.db`；可用 `PANEL_DB_PATH` 指向其他本地路徑。
- 策略、圖表：使用含股息調整日線。持股估值：使用日線收盤價。
- 持股盈虧：股數 ×（收盤價 − 匯入平均成本）。不含交易費、稅與已實現損益。
- 當日盈虧：目前股數 ×（本次與前次日線收盤價之差），不含股息現金流；
  假設兩日持股數不變，可能與券商的調整前收盤、即時/盤後或公司行動口徑不同。
- 市值與當日盈虧僅使用行情資料，不以使用者手動資料作為價格備援。
- 暫不追蹤交易流水，因此持股變動、股數拆分與成本調整需要使用者自行編輯。
- 美東時間 16:15 前排除當日 K 線，避免把尚未完成的交易日當作收盤。
  特殊提早收市日會保守等待到同一時間。
- 更新失敗保留該標的先前行情，資料管理頁標示錯誤；日線日期不同時不混入同日選股。

來源核對：
- [yfinance 官方文件](https://ranaroussi.github.io/yfinance/)
- [Cboe SPCU 標的說明（SpaceX / SPCX）](https://www.cboe.com/us/equities/listings/listed_products/symbols/SPCU/)
- [SPCX 舊 ETF 改名 SPCK 的 SEC 公告](https://www.sec.gov/Archives/edgar/data/1719812/000199937126007611/cist-497_040226.htm)

## 策略與回測

四種日線條件：海龜突破、均線趨勢、RSI 回檔觀察、清單內相對強勢。
完整條件可在策略研究頁查看。

相對強勢只比較**所選股票池**，不代表全美股排名。歷史選股使用該次掃描的清單，
屬於研究重算，不是當時實際持倉或當時全市場的可交易投資組合。
每次掃描儲存最近 60 個交易日的結果，可切換日期查閱。

回測結果也會存入本地資料庫；切換標的與策略時載入最近一次結果，頁面顯示計算時間與期間。行情更新後可再按「執行回測」重新計算。

三種單檔回測：前日收盤訊號、次日開盤成交；全額做多，每次買賣扣 0.1% 費用及滑價。
初始資金 $10,000，指標暖機後開始；不同策略的起始日可能不同，應連同日期比較。

- 海龜退出：前日收盤低於之前 10 日最低價。
- 趨勢退出：前日收盤低於 MA50。
- 回檔退出：前日 RSI ≥ 60 或收盤低於 MA200。
- 末日未平倉按收盤評價，沒有假設末日強制賣出費用。
- 基準為同起始日買入持有，未扣費，使用同一調整價格序列。
- 不模擬融資、借券、稅、流動性限制與盤中停損。
- 資料不足會拒絕回測；不補造數值。

此工具產生研究訊號與模擬結果，沒有券商連線、自動下單或 Feishu 推送。

## 市場選股（新增）

「每日選股」預設使用獨立的**美股市場候選股票池**，不再只掃描持股。
按「執行市場選股」會更新候選清單、下載日線、重新計算四個策略，並顯示完成摘要。

股票池由 Yahoo Equity Screener 即時查詢建立：

- `region=us`，Nasdaq NMS / NYSE NYQ，美元普通股類型（含 ADR）。
- 市值至少 20 億美元、股價至少 5 美元、近三個月平均日成交量至少 20 萬股。
- 按市值遞減取前 250 檔。不同股別可能各占一檔；這不是完整全美股或指數成分。
- 市場清單存於 `market_universe`，與 `positions` 分開。
- 市場與持股掃描有各自的 `scope`、歷史結果與相對強勢排名。
- 更新股票池失敗會標示作業失敗並保留原股票池，不默默退回七檔持股。

預設只顯示符合至少一種條件、尚未加入持股／觀察名單的新標的。
可搜尋公司、按策略與日期篩選、翻頁、打開該日期的個股明細；「加入觀察」
以零股與空成本加入追蹤，不覆寫既有持股。查詢市場不會自動加入任何持股。

歷史市場訊號以當次取得的股票池重算，並非當時真實成分，存在選樣與存活者偏差。
相對強度只對當次同日有效股票池排名，不能直接與七檔清單的排名互相比較。

CLI 亦支援：

```sh
uv run --extra web python -m alphaview.panel refresh --scope market
uv run --extra web python -m alphaview.panel scan --scope market
```

資料管理同時顯示市場候選與自己的清單，提供搜尋與分頁。
[Yahoo / yfinance Screener 查詢文件](https://ranaroussi.github.io/yfinance/reference/api/yfinance.screen.html)

## 日常使用

總覽的「更新行情」下載持股清單並自動掃描；總覽的「執行選股」用已儲存行情重算。每日選股頁的市場／清單選股操作則會先下載相應範圍的行情。
持股可新增、修改或把股數設為 0 移入觀察名單，亦可匯出 CSV。
目前採手動更新，尚未安裝自動排程。同一面板內不允許同時執行兩個資料作業。
請勿在面板更新期間另用 CLI 同時寫入 panel.db。

## 驗證

```sh
uv run --extra web --extra dev pytest -q
npm run build --prefix web
```

測試包含歷史日期不讀取未來 bar、次日開盤成交與成本、資料不足、
資料源失敗保留舊資料、持股估值、輸入驗證、CSV 公式轉義與跨站寫入限制。

設計技能：`ui-design` 的 Build 模式；讀取 `design-guidelines.md`，並套用
colors、dashboards、tables、surfaces、navigation、typography、buttons、
form-controls、responsive-design、flexbox-layout、border-radius、icons、general、
headers、shadows、badges、svg、custom-fonts、dark-mode 規則；字體與色彩以 CRM 參照優先。
