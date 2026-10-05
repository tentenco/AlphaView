# 回測研究台（Research Desk）

版本：`alphaview-research-desk-v1`，Pine 匯出 `alphaview-pine-export-v1`。2026-10-01 依使用者要求，參考 Miles Deutscher 的兩篇 X 文章與其 MIT 授權的 [Research Desk](https://github.com/Miles-Deutscher/Backtesting-Engine)（commit `a8f49c0`）整合到 AlphaView。入口：側欄 **回測研究台**（`#research-desk`）。

這不是交易工具、報酬預測或投資建議。它只讀取本機已下載的日線，不連 Binance、Alpaca、TradingView 或任何模型。

## 概念來源與取捨

文章提出的流程：先蒐集值得測試的策略、把想法寫成可計算的進出場規則、以「單邊 0.1% 手續費、下一根 K 棒開盤成交、10 萬美元起始資金」回測、看淨損益／勝率／最大回撤／獲利因子／交易筆數、大量比較並和買入持有對照（「十二個經典策略只有一個勝過買入持有」），接著匯出交易紀錄追問「為什麼虧、哪些情況虧最多、怎麼降低回撤而不過度擬合」，最後在 TradingView 用 Pine Script 交叉驗證。

| 來源 | 在 AlphaView 的對應 | 取捨 |
| --- | --- | --- |
| Repo：均線交叉、RSI 均值回歸、買入持有 | 參數化策略 `sma_cross`、`rsi_reversion`、`buy_hold` | Repo 在訊號同一根 K 棒收盤成交；本版改為前一日收盤確認、次日開盤成交，避免使用當根收盤同時決策又成交 |
| 文章：經典策略大量比較 | 經典組合 11 組（含通道突破、布林回歸與每日選股的海龜／趨勢／回檔規則）、均線參數網格、最多 24 組 × 10 檔 | 文章所稱「400–500 個預載策略」不在公開 repo 中，本版不宣稱有此數量 |
| 文章：與買入持有比較、跨標的測試 | 每檔同窗口的買入持有基準、超額報酬、勝過基準的檔數 | 基準用相同成本、100% 投入、不設停損 |
| 文章：不要過度擬合 | 時間序切分樣本內／樣本外，只用樣本內排名；樣本外轉弱、樣本不足、多數未勝過基準提示；多重比較警告 | 沒有 walk-forward 最佳化，避免把調參包裝成驗證 |
| 文章：匯出 CSV 請 Claude 分析 | 程式化診斷（進場時趨勢、RSI、波動率三分位、大盤 MA200 狀態、持有期、出場原因的虧損占比）、最深回撤、可測試的假設；交易 CSV 可另交給 Claude | 本機不呼叫 LLM；假設是依交易紀錄算出的觀察，不是建議 |
| 文章：Pine Script v6 + TradingView | 每個策略可匯出 Pine Script v6，沿用相同成本、部位比例、收盤確認停損與次日開盤成交 | 未在 TradingView 內編譯驗證；TradingView 資料與除權息設定不同，數字不會完全一致 |
| Repo：自訂策略預設、History | `research_desk_presets`（版本衝突 409）、`research_desk_runs`（保存每次比較） | 存在本機 SQLite，隨工作區備份；不存瀏覽器 localStorage |
| Repo：Binance、Alpaca 行情、CSV K 線匯入 | 未採用 | 新資料來源須先依 `docs/data-provider-evaluation.md` 評估授權與驗收；使用者上傳的 K 線無法驗證來源，違反不捏造資料原則 |
| 文章：接交易所 MCP 自動下單 | 未採用 | 本專案不做實盤；Alpaca 仍為唯讀 |

## 使用流程

1. **測試設定**：輸入 1–10 個代碼（可「帶入我的持股代碼」，只帶代碼，不帶股數與成本）、選填起訖日、樣本外比例（0／20／30／40%）、排名依據，以及資金、單邊手續費、滑價、每次投入比例、收盤停損／停利。
2. **策略組合**：載入經典組合、加入均線參數網格，或從清單逐一加入後調整參數。每組可「存為預設」，之後從「我的策略預設」加入策略或套用成本設定。
3. **執行策略比較**：排行顯示樣本內超額報酬（對買入持有）、勝過基準的檔數、樣本外超額、合併交易筆數、勝率、獲利因子、平均最大回撤與提醒標籤。
4. **為什麼？**：選一個代碼後按該列的「為什麼？」，在比較時的同一窗口重跑單一策略，看淨值曲線、各狀態的虧損占比、最深回撤、交易紀錄與可測試的假設。
5. **匯出**：下載交易 CSV（每筆交易含進場時的狀態）或匯出 Pine Script v6 到 TradingView 交叉檢查。
6. **研究紀錄**：每次比較自動保存；行情更新後標示「請重新執行核對」，不覆寫舊結果。

## 策略與參數

| ID | 規則（訊號在收盤確認） | 參數範圍 |
| --- | --- | --- |
| `buy_hold` | 第一個測試日開盤買入並持有 | — |
| `sma_cross` | 快線上穿慢線買入、下穿賣出（前一日快線 ≤ 慢線才算穿越） | fast 2–200、slow 5–400，fast < slow |
| `rsi_reversion` | Wilder RSI ≤ 進場值買入、≥ 出場值賣出 | period 2–50、entry 5–50、exit 50–95，entry < exit |
| `donchian_breakout` | 收盤 > 前 N 日最高價買入、< 前 M 日最低價賣出 | entry 5–200、exit 2–100 |
| `bollinger_reversion` | 收盤 < 均線 − k × 母體標準差買入、≥ 均線賣出 | period 5–100、k 0.5–4 |
| `alphaview_turtle` | 每日選股的海龜進場；收盤 < 前 10 日最低價出場（同回測 v5） | — |
| `alphaview_trend` | 每日選股的均線趨勢進場；收盤 < MA50 出場 | — |
| `alphaview_pullback` | 每日選股的回檔進場；RSI ≥ 60 或收盤 < MA200 出場 | — |

RSI 與每日選股使用同一個 Wilder 初始化（前 N 次漲跌的簡單平均），測試確認完全一致。參數驗證不夾限、不自動修正；整數參數拒絕小數，未知參數拒絕。

## 模擬口徑

- 日線以 `adj_close / close` 調整開高低收；資料須通過 `validate_bars`，無效或非交易日的日線使整檔標為不可用並列原因。
- 每個交易日 i 只讀 i−1 的收盤訊號，在 i 的開盤成交。只做多、一次一個部位、不加碼；出場當日不再進場。
- 進場預算 = 現金 × 投入比例；名目 = 預算 ÷（1 + 手續費率），成交價 = 開盤 ×（1 + 滑價）。出場成交價 = 開盤 ×（1 − 滑價），再扣手續費。
- 停損／停利以收盤相對進場成交價判斷，次日開盤出場；跳空可能使實際虧損大於設定值。
- 期末未平倉的部位按最後收盤評價並標示為持有中，不假設賣出。
- 同一次比較中，每檔代碼所有設定共用同一窗口，從最長暖機期之後開始（若有指定起日則取較晚者）。樣本外比例 > 0 時依時間切成兩段，各自從空手開始；少於 20 日的段不建立，該檔以完整期間排名並提示。
- 超額報酬 = 策略報酬 − 同檔同窗口買入持有報酬（百分點）。合併獲利因子 = 各檔毛利總和 ÷ 毛損總和；合併勝率 = 總獲利筆數 ÷ 總平倉筆數。
- 指標：報酬、CAGR（日曆天 / 365.25）、最大回撤（相對歷史最高淨值）、Sharpe（每日報酬、252 日、零無風險利率）、最高／最低淨值、勝率、獲利因子、平均每筆報酬、最大單筆盈虧、最大連續虧損、平均持有日、在市時間。非有限值一律為 null，畫面顯示 `—`。

提醒標籤：`low_sample`（合併平倉 < 30 筆）、`no_trades`、`beats_benchmark_minority`（勝過基準的檔數未過半）、`out_of_sample_decay`（樣本內超額 > 0 但樣本外 ≤ 0）、`benchmark_strategy`。

## 診斷

條件在**訊號日**讀取：收盤對 MA200、14 日 RSI 區間（<30／30–50／50–70／>70）、20 日年化波動率在測試窗口內的三分位、基準（預設 SPY）收盤對其 MA200。基準日線缺少該日或不足 200 日時為「無法判斷」，不以鄰近日期代替。每個維度列出筆數、勝率、損益與虧損占比；最深回撤列出高點、低點、收復日與天數。

假設規則（全部是可再測試的觀察）：平倉少於 30 筆、單一狀態占虧損 ≥ 60% 且至少 3 筆（趨勢、波動、大盤）、勝率 ≥ 50% 但獲利因子 < 1、未設停損且最大單筆虧損 ≤ −15%、落後基準且在市時間 < 50%、最大回撤比基準更深。改動規則請另存一組設定，回到排行比較樣本外結果。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/research-desk/catalog` | 策略、參數範圍、經典組合、預設成本、上限、方法與出處（離線） |
| `POST /api/research-desk/tournament` | `{symbols, configs, risk, start_date?, end_date?, oos_pct, rank_by, save}`；唯讀快照計算，`save` 時另寫入研究紀錄 |
| `POST /api/research-desk/diagnose` | `{symbol, config, risk, test_start?, test_end?, benchmark_symbol}` |
| `POST /api/research-desk/validate` | `{symbol, config, risk, test_start?, test_end?, folds=4, trials=1}` → `alphaview-validation-v1` 驗證閘（走動式分段、bootstrap、機率化／去膨脹 Sharpe、verdict） |
| `POST /api/research-desk/validate-batch` | `{symbols[1–10], config, risk, test_start?, test_end?, folds, trials}` → 同一設定逐標的驗證與跨標的彙總（任一 fail → fail；全部 pass → pass；不可用不計入分母） |
| `POST /api/research-desk/trades.csv` | 同上，回傳 CSV（公式字元防護、未平倉列標 `open_marked_to_market`） |
| `POST /api/research-desk/pine` | `{config, risk, start_date?}` → Pine Script v6 |
| `GET/POST /api/research-desk/presets`、`PUT/DELETE /presets/{id}` | 預設 CRUD，寫入帶 `expected_version` |
| `GET /api/research-desk/runs?limit=50`、`/runs/{id}` | 研究紀錄與保存結果；以 `input_revision` 判斷行情是否已變 |

錯誤回傳 `{code, message}`，參數驗證錯誤為 FastAPI 422。所有計算使用 `store.read_snapshot()`，不改變行情 `input_revision`；結果可 `json.dumps(..., allow_nan=False)`。

## 驗證閘（`alphaview-validation-v1`）

2026-10-01 對標 Vibe-Trading 的 Validate 層與 pybroker 的 walk-forward／bootstrap 新增，入口在診斷頁下方。它對**同一組固定參數**做三項只能證偽的檢定，不做任何最佳化：

- **走動式分段一致性**：把暖機後的測試區間依交易日等分成 K 段（2–8，預設 4），每段獨立由空手起算、不延續部位；一致性＝有成交段中報酬為正的比例，沒有成交的段不計入分母；有成交段少於 2 段則不可用。
- **Bootstrap 區間**：固定種子 20261001 對已平倉交易報酬重抽 2000 次，回報平均交易報酬的 95% 百分位區間與平均 ≤ 0 的比例；少於 10 筆平倉交易不可用。
- **機率化／去膨脹 Sharpe**：依 Bailey & López de Prado 以日報酬偏態與峰度修正 Sharpe 估計誤差，計算 Sharpe 高於基準值的機率；`trials`（比較過的設定數，1–500）大於 1 時基準改為該數量下的期望最大 Sharpe，各嘗試變異數以本策略估計值代替（簡化假設，已在方法說明）。少於 30 個日報酬或波動為零不可用。

判定：`pass` 需三項皆可用且一致性 ≥ 0.75、區間下界 > 0、機率 ≥ 0.95；`fail` 為一致性 < 0.5、區間上界 ≤ 0 或機率 < 0.5；其餘含任一項不可用皆為 `warn`。通過不代表未來有效，`trials` 漏報會高估去膨脹 Sharpe。策略→紙上橋接在建立提案前會跑同一個閘（`require_pass`／`warn_only`／`off`，fail 只能明確覆寫，見 `docs/strategy-bridge.md`）。實作 `alphaview/panel/research_validation.py`、前端 `web/src/ResearchDeskValidation.tsx`、測試 `tests/test_research_validation.py`。

## 這不是什麼

歷史模擬會受資料品質、成本、滑價、流動性、倖存者偏差（本機只有目前存活的標的、約兩年日線）與過度擬合影響。比較的設定越多，樣本內第一名越可能是運氣。任何回測結果都不能保證未來表現，也不是交易指示。

實作：`alphaview/panel/research_desk.py`；前端 `web/src/ResearchDesk.tsx`、`ResearchDeskDiagnosis.tsx`、`research-desk-model.ts`；測試 `tests/test_research_desk.py`、`web/src/ResearchDesk.test.tsx`、`research-desk-model.test.ts`，全部使用合成日線與隔離資料庫。
