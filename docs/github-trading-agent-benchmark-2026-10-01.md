# AlphaView：熱門開源交易 Agent／量化專案對標與缺口排序

研究日期：2026-10-01（臺灣時間）。GitHub API 查核窗：UTC 2026-09-30 23:13:41–23:14:34（臺灣 2026-10-01 07:13:41–07:14:34）。方法版本：`alphaview-github-benchmark-v2`（接續 `docs/github-agent-portfolio-benchmark-2026-09-20.md` 的 v1）。本文件是設計輸入，不是已交付功能清單，也不是投資建議；沒有安裝、執行任何競品，也沒有驗證任何競品宣稱的報酬。

## 摘要

- **最熱門不等於最成熟。** star 最高的 Agent 類專案 TradingAgents（109,377★）與 ai-hedge-fund（63,812★）都自稱研究或教育用途。TradingAgents 的 README 未描述持久的 paper 帳本；ai-hedge-fund 的 ROADMAP 明列「carried book、paper broker、scheduler、kill-switch、validation gate」為尚未完成。就 paper 帳本、NAV、排程、斷路器、冪等與衝突保護這幾項，AlphaView 目前已超過這兩者所述的狀態。
- **可營運性的成熟參考在別處**：freqtrade（保護機制、前視偏誤檢測）、Lean（Universe→Alpha→Portfolio→Risk→Execution 分層）、Nautilus（必經路徑的 RiskEngine、啟動對帳）、Vibe-Trading（驗證層、grounding gate、fail-closed 實盤閘門）。
- **前三名缺口**都是「證據與完整性」而非新功能：(1) 決策／訊號結果結算帳本，(2) 策略驗證閘，(3) 前視偏誤自我檢測。接著是把已存在卻未接線的市場風險溫度計接進配置，以及流動性感知的成本模型。
- **一個具體的安全缺口**：AlphaView 的 kill switch 與斷路器會整張擋下提案（`circuit_breakers.guard_fill` 回 409、`paper_portfolio.py` 對 kill switch 也整張擋下），連減碼賣單都無法模擬。freqtrade 的 `/stopentry` 與 QuantDinger 的「所有出場繞過 AI 閘門」都採「只擋進場、不擋出場」。
- **OpenBB 倉庫在兩輪查核之間換了擁有者**：`OpenBB-finance/OpenBB` 在 UTC 23:13 起被 API 解析為 `openbq-org/OpenBB`（repo id 323048702，建立日 2020-12-20 與第一輪記錄的原 repo 相同；舊網址 HTTP 301；新 org 建立於 2026-09-11）。原因未知，細節見第 2 節；在確認官方位置前不要從新位置安裝它。
- **授權提醒**：freqtrade、backtrader、Lumibot 為 GPL-3.0，backtesting.py、OpenAlice 為 AGPL-3.0，Nautilus 為 LGPL-3.0，vectorbt 與 pybroker 為 Apache-2.0＋Commons Clause，AI-Trader 與 dexter 沒有 LICENSE 檔。以上只取概念，不複製程式碼。OpenBB 的 LICENSE 已於 2026-09-29 由 AGPL-3.0 改為 Apache-2.0（09-20 版 review 當時記錄為 AGPLv3，與 LICENSE 歷史一致）。

## 1. 方法與查核時間

**資料來源與時間。** star、授權、建立與最近 push 時間皆取自 GitHub REST API（`gh api repos/{owner}/{repo}`，已登入帳號，唯讀）。第一輪（指定與搜尋到的 49 個 repo）在 UTC 2026-09-30 22:13:17–22:20:29；中途因用量上限暫停，恢復後把全部 63 個 repo 在 **UTC 2026-09-30 23:13:41–23:14:34** 重新抓取一次，**本文所有 star 數都是這一次的值**（零失敗，沒有需要沿用舊值的項目）。「較 09-20」欄的基準值取自 09-20 版文件，那些舊值本次未重新驗證，只用來顯示變化量。star 會隨時間變動，僅是當下快照。

**發現方式。** 對 `search/repositories` 依 stars 排序執行 11 組查詢：`trading agent llm`、`ai hedge fund`、`multi-agent trading stock llm`、`algorithmic trading backtesting framework python`、`quantitative trading platform open source`、`topic:algorithmic-trading`、`topic:trading-bot`、`topic:backtesting`、`topic:portfolio-optimization`、`paper trading alpaca llm agent`、`OpenAlice in:name`；再逐一查詢使用者指定的 repo（virattt/ai-hedge-fund、TauricResearch/TradingAgents、freqtrade、OpenBB、FinRL、FinGPT、qlib、nautilus_trader、backtrader、vectorbt、Lean、jesse、hummingbot、backtesting.py、quantstats、lumibot、ccxt、Miles-Deutscher/Backtesting-Engine、FinMem、StockAgent、FinRobot）。共 63 個 repo 進入下表。

**「深度分析」的選取規則（前 8 名）。** 在「可比較」的專案中（Agent 交易／組合、量化回測框架、交易 bot）依 star 由高到低取前 8 個，排除：衍生版（TradingAgents-CN）、僅資料／模型／交易所函式庫（OpenBB、FinGPT、ccxt、Kronos）、停止維護（backtrader 2024-08 後無 push）、授權不明（AI-Trader、dexter）。結果為 **TradingAgents、ai-hedge-fund、freqtrade、qlib、vnpy、Vibe-Trading、NautilusTrader、Lean**（標為 A）。其餘比較相近者列為 B 做簡要分析，其餘為 C 只列入表格。OpenBB 雖是第二高 star，但它是資料平台，不是交易、回測或 bot，所以放在 B。ccxt 只是交易所 API 函式庫，沒有策略、回測、風險或 Agent 邏輯。

**證據範圍。** 每個 A 級專案的依據是：官方 README、LICENSE、git 檔案樹（檔名即證據）、少數原始碼與文件（ai-hedge-fund 的 `risk/limits.py`、`brokers/protocol.py`、`pipeline/execution.py`、`portfolio/validation.py`、ROADMAP／VISION；TradingAgents 的 `rating.py`、`settlement.py`；Vibe-Trading 的 `sdk_order_gate.py`；Nautilus 的 `risk/engine/config.rs` 與文件索引；freqtrade 的 protections／lookahead／recursive 文件；qlib 的 `exchange.py`）。**沒有讀完整文件站**：前次平行研究的子代理成果（部分因用量上限中斷）一律不採用，本文只使用上述我親自讀取並可重現的來源。Vibe-Trading 的 README 約 350 KB，只讀了章節與關鍵段落。

**AlphaView 基線。** 讀了 `CLAUDE.md`；`docs/` 中的 research-desk（關鍵段落）、local-execution-adapter（開頭）、rebalance-triggers／paper-replay-design／agent-portfolio（僅標題）；以及關鍵模組（`circuit_breakers.py`、`rebalance_trigger.py`、`portfolio_agent.py`、`paper_next_open.py`、`paper_scenarios.py`、`jev_decision.py`、`agent_automation.py` 的 schema、`store.py` 的 schema），並對 `alphaview/panel`、`docs`、`scripts` 做關鍵字搜尋。**「未見」是指在這些範圍的關鍵字搜尋沒有命中，不等於逐行審計後確定不存在**；任何缺口在實作前都需要再確認。沒有讀取 `data/` 或 `artifacts/`（除了寫入本案的 `benchmark.json`）。

**star 只衡量關注度。** 它不能證明報酬、設計正確或適合實盤。例如 Vibe-Trading 建立於 2026-04-01，半年內達到 34,388 stars；TradingAgents 建立於 2024-12-28。星數高低不用來評斷功能品質，只用來決定先看誰。

**評分。** 缺口排序的分數 = 價值（1–5，對「會自動 paper 交易、之後要能上線」的 agent 有多重要）× 可行（1–5，在 AlphaView 約束下是否可行：本機資料、無新付費供應者、可版本化、缺值為不可用）。同分時先比價值，再看依賴順序（證據與完整性在前）。這是工程判斷，不是競品作者的主張；S／M／L 只是相對工程量。

**與 09-20 版的主要差異。** 候選從 25 個擴到 63 個；新增「結果結算」「驗證閘」「前視偏誤自我檢測」「授權生命週期」等查核軸；發現 OpenBB 授權變更、TradingAgents 於 v0.5.x 新增 point-in-time 資料與回測網格、ai-hedge-fund 改為 mandate 引擎；並逐項對照 AlphaView 目前程式碼，而不是只對照文件。

## 2. 候選與 star 數

下表依 star 由高到低排序，**不代表全 GitHub 的全球排名**，只是本次搜尋與指定名單的結果。層級：**A** 逐一深入分析（可比較者的前 8 名），**B** 簡要分析，**C** 僅列入。「授權」欄先列 API 回傳值，遇到 `NOASSERTION` 或其他不明確者，再寫「→」後我實際讀 LICENSE／README 得到的結論；`無` 表示 API 找不到 LICENSE 檔。

| # | Repo | Stars | 較 09-20 | 授權（API 值 → 實查） | 類型 | 最近 push (UTC) | 層級 |
| ---: | --- | ---: | ---: | --- | --- | --- | :-: |
| 1 | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 109,377 | +1,746 | Apache-2.0 | 多角色 LLM 交易研究框架 | 2026-09-29 | A |
| 2 | [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 73,697 | +433 | NOASSERTION → Apache-2.0（2026-09-29 自 AGPL-3.0 改授權） | 資料平台（供 Agent／MCP／量化使用） | 2026-09-30 | B |
| 3 | [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 65,814 | +490 | MIT | LLM 股票分析工作台（含推播） | 2026-09-30 | B |
| 4 | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | 63,812 | +253 | MIT | Agent 對沖基金／mandate 引擎 | 2026-09-26 | A |
| 5 | [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | 54,963 | +410 | GPL-3.0 | 加密貨幣交易 bot（回測、超參、保護機制） | 2026-09-29 | A |
| 6 | [microsoft/qlib](https://github.com/microsoft/qlib) | 49,079 | +401 | MIT | AI 量化研究平台 | 2026-09-22 | A |
| 7 | [vnpy/vnpy](https://github.com/vnpy/vnpy) | 45,667 | +222 | MIT | 事件驅動量化交易框架（中國市場為主） | 2026-09-13 | A |
| 8 | [ccxt/ccxt](https://github.com/ccxt/ccxt) | 44,216 | +166 | MIT | 僅為加密貨幣交易所 API 函式庫 | 2026-09-30 | B |
| 9 | [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) | 39,701 | — | MIT | 金融市場基礎模型（非交易系統） | 2026-04-13 | C |
| 10 | [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 34,388 | +690 | MIT | 個人交易 Agent／研究與組合工作區 | 2026-09-30 | A |
| 11 | [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 32,123 | +317 | NOASSERTION → AGPL-3.0（開源版）＋專有 Enterprise 版 | 金融桌面終端 | 2026-09-19 | B |
| 12 | [hsliuping/TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN) | 32,107 | +217 | NOASSERTION → 混合：Apache-2.0 核心＋專有 app／frontend／core | TradingAgents 中文衍生版（A 股） | 2026-09-22 | B |
| 13 | [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | 29,540 | +396 | LGPL-3.0 | 高效能事件驅動引擎（回測與實盤同語意） | 2026-09-30 | A |
| 14 | [virattt/dexter](https://github.com/virattt/dexter) | 27,631 | — | 無 LICENSE 檔（license API 404） | 自主金融研究 Agent | 2026-09-23 | B |
| 15 | [mementum/backtrader](https://github.com/mementum/backtrader) | 23,377 | +93 | GPL-3.0 | Python 回測函式庫（2024-08 後無 push） | 2024-08-19 | B |
| 16 | [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) | 22,645 | +246 | 無 LICENSE 檔（README 徽章標 MIT，license API 404） | Agent 原生交易／跟單平台 | 2026-06-11 | B |
| 17 | [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | 21,832 | +147 | Apache-2.0 | 演算法交易引擎（Algorithm Framework） | 2026-09-30 | A |
| 18 | [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21,303 | +33 | MIT | 金融語言模型（非交易系統） | 2026-09-23 | C |
| 19 | [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading) | 21,150 | — | MIT | 教學書籍程式碼 | 2026-09-28 | C |
| 20 | [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 20,280 | +204 | Apache-2.0 | 加密貨幣造市／執行框架 | 2026-09-28 | B |
| 21 | [quantopian/zipline](https://github.com/quantopian/zipline) | 20,139 | — | Apache-2.0 | 回測庫（2024-02 後無 push） | 2024-02-13 | C |
| 22 | [bbfamily/abu](https://github.com/bbfamily/abu) | 18,735 | — | GPL-3.0 | 阿布量化（2026-01 後無 push） | 2026-01-24 | C |
| 23 | [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) | 18,564 | +39 | MIT | 量化工具集合 | 2026-03-11 | C |
| 24 | [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) | 16,579 | +129 | MIT | Claude Code／Codex 價值投資研究工作流 | 2026-09-27 | C |
| 25 | [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | 16,518 | +184 | MIT | 強化學習交易研究 | 2026-09-28 | B |
| 26 | [microsoft/RD-Agent](https://github.com/microsoft/RD-Agent) | 14,816 | — | MIT | 自動化研發 Agent（與 qlib 搭配） | 2026-09-30 | C |
| 27 | [myhhub/stock](https://github.com/myhhub/stock) | 14,706 | — | Apache-2.0 | A 股選股與回測工具 | 2026-04-02 | C |
| 28 | [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger) | 12,346 | — | Apache-2.0 | 自架 AI 交易 OS（含 Jev 決策閘） | 2026-09-30 | B |
| 29 | [yutiansut/QUANTAXIS](https://github.com/yutiansut/QUANTAXIS) | 11,254 | — | MIT | 本機量化解決方案（A 股為主） | 2026-09-18 | C |
| 30 | [je-suis-tm/quant-trading](https://github.com/je-suis-tm/quant-trading) | 10,844 | — | Apache-2.0 | 量化策略範例集 | 2026-06-20 | C |
| 31 | [StockSharp/StockSharp](https://github.com/StockSharp/StockSharp) | 10,824 | — | NOASSERTION → 未逐條查核 | C# 交易平台 | 2026-09-30 | C |
| 32 | [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio) | 9,389 | +68 | AGPL-3.0 | 個人資產管理（持股追蹤） | 2026-09-30 | C |
| 33 | [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | 9,244 | +112 | NOASSERTION → Apache-2.0＋Commons Clause | 向量化回測與參數掃描 | 2026-09-26 | B |
| 34 | [kernc/backtesting.py](https://github.com/kernc/backtesting.py) | 9,010 | +36 | AGPL-3.0 | 輕量回測函式庫 | 2026-08-05 | B |
| 35 | [jesse-ai/jesse](https://github.com/jesse-ai/jesse) | 8,606 | +68 | MIT | 加密貨幣策略研究／交易框架 | 2026-09-28 | B |
| 36 | [AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) | 8,120 | — | Apache-2.0 | 金融應用 LLM Agent 平台 | 2026-09-28 | C |
| 37 | [ranaroussi/quantstats](https://github.com/ranaroussi/quantstats) | 7,675 | — | Apache-2.0 | 組合績效分析與 tearsheet | 2026-09-27 | B |
| 38 | [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) | 7,200 | — | AGPL-3.0 | AI 交易協調器（Trading as Git） | 2026-09-30 | B |
| 39 | [ricequant/rqalpha](https://github.com/ricequant/rqalpha) | 6,803 | — | NOASSERTION → 未逐條查核 | 中國市場回測與交易框架 | 2026-09-28 | C |
| 40 | [Drakkar-Software/OctoBot](https://github.com/Drakkar-Software/OctoBot) | 6,671 | — | GPL-3.0 | 加密貨幣 bot | 2026-09-30 | C |
| 41 | [The-Swarm-Corporation/AutoHedge](https://github.com/The-Swarm-Corporation/AutoHedge) | 6,222 | — | MIT | Swarm Agent 自主對沖基金 | 2026-05-11 | C |
| 42 | [PyPortfolio/PyPortfolioOpt](https://github.com/PyPortfolio/PyPortfolioOpt) | 6,069 | — | MIT | 組合最佳化函式庫 | 2026-07-07 | B |
| 43 | [Superalgos/Superalgos](https://github.com/Superalgos/Superalgos) | 5,670 | — | Apache-2.0 | 加密貨幣視覺化 bot 平台 | 2026-09-30 | C |
| 44 | [JerBouma/FinanceToolkit](https://github.com/JerBouma/FinanceToolkit) | 5,391 | — | MIT | 財務分析工具包 | 2026-09-29 | C |
| 45 | [dcajasn/Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib) | 4,527 | — | BSD-3-Clause | 組合最佳化／風險函式庫 | 2026-09-30 | B |
| 46 | [zvtvz/zvt](https://github.com/zvtvz/zvt) | 4,318 | — | MIT | 模組化量化框架 | 2026-07-01 | C |
| 47 | [AI4Finance-Foundation/FinRL-Trading](https://github.com/AI4Finance-Foundation/FinRL-Trading) | 3,772 | +45 | Apache-2.0 | FinRL-X：權重導向、Alpaca paper | 2026-09-18 | B |
| 48 | [edtechre/pybroker](https://github.com/edtechre/pybroker) | 3,550 | — | NOASSERTION → Apache-2.0＋Commons Clause | 機器學習友善回測（walk-forward、bootstrap） | 2026-09-28 | B |
| 49 | [pst-group/pysystemtrade](https://github.com/pst-group/pysystemtrade) | 3,536 | — | GPL-3.0 | 系統化趨勢交易（Carver） | 2026-09-30 | C |
| 50 | [pmorissette/bt](https://github.com/pmorissette/bt) | 2,994 | — | MIT | 靈活回測框架 | 2026-09-27 | C |
| 51 | [skfolio/skfolio](https://github.com/skfolio/skfolio) | 2,453 | — | BSD-3-Clause | scikit-learn 風格組合最佳化 | 2026-09-30 | B |
| 52 | [coding-kitties/investing-algorithm-framework](https://github.com/coding-kitties/investing-algorithm-framework) | 2,139 | — | Apache-2.0 | 量化策略開發框架 | 2026-09-30 | C |
| 53 | [olaxbt/ai-market-maker](https://github.com/olaxbt/ai-market-maker) | 2,111 | — | AGPL-3.0 | Agent 對沖基金 OS | 2026-08-20 | C |
| 54 | [Lumiwealth/lumibot](https://github.com/Lumiwealth/lumibot) | 2,100 | — | GPL-3.0 | Python 交易框架＋AI Agent 執行（12 券商） | 2026-09-30 | B |
| 55 | [stefan-jansen/zipline-reloaded](https://github.com/stefan-jansen/zipline-reloaded) | 1,949 | — | Apache-2.0 | zipline 社群維護版 | 2026-01-06 | C |
| 56 | [AI4Finance-Foundation/FinRL-Meta](https://github.com/AI4Finance-Foundation/FinRL-Meta) | 1,947 | — | MIT | RL 資料環境 | 2026-09-28 | C |
| 57 | [ginlix-ai/LangAlpha](https://github.com/ginlix-ai/LangAlpha) | 1,792 | — | Apache-2.0 | 金融市場 Agent（Claude Code 風格） | 2026-09-30 | C |
| 58 | [alpacahq/alpaca-py](https://github.com/alpacahq/alpaca-py) | 1,537 | — | Apache-2.0 | Alpaca 官方 Python SDK | 2026-09-29 | C |
| 59 | [cvxgrp/cvxportfolio](https://github.com/cvxgrp/cvxportfolio) | 1,291 | — | GPL-3.0 | 多期組合最佳化與回測 | 2026-04-27 | C |
| 60 | [pipiku915/FinMem-LLM-StockTrading](https://github.com/pipiku915/FinMem-LLM-StockTrading) | 962 | — | MIT | 分層記憶 LLM 交易 Agent（論文程式碼） | 2024-08-18 | B |
| 61 | [kyky2347/ALTA](https://github.com/kyky2347/ALTA) | 916 | — | Apache-2.0 | 研究導向多 Agent 平台（Shadow 模擬＋需明確授權的券商執行） | 2026-09-13 | C |
| 62 | [MingyuJ666/Stockagent](https://github.com/MingyuJ666/Stockagent) | 706 | — | 無 LICENSE（API: NONE） | LLM 股票交易模擬（論文程式碼） | 2026-06-16 | C |
| 63 | [Miles-Deutscher/Backtesting-Engine](https://github.com/Miles-Deutscher/Backtesting-Engine) | 32 | — | MIT | 本機 Research Desk 回測小工具（使用者指定） | 2026-07-23 | B |

**讀表注意**

- **ccxt**（44,216★）**只是交易所 API 函式庫**：統一的 REST／WebSocket 介面，涵蓋 100 多個加密貨幣交易所與預測市場；沒有策略、回測、風險或 Agent 邏輯，也不處理美股，因此不列入深度分析。freqtrade 的 README 在支援交易所清單最後，以 ccxt 連結作為「可能還有許多其他交易所」的來源。
- **OpenBB**（73,697★）是資料平台：Open Data Platform 把資料「連一次、到處用」地供給 Python、REST、Excel、OpenBB Workspace 與給 AI agent 的 MCP 伺服器；不是回測或交易系統。**授權：LICENSE 在預設分支讀到 Apache-2.0**（版權行 OpenBB Inc.，「All files in this repository are licensed under the Apache License, Version 2.0」），LICENSE 的 commit 歷史為：2024-05-14「Update the license of the code in this repo to AGPL」、2025-02-10「Update LICENSE」、**2026-09-29「V5 (#7489)」改為 Apache-2.0**。我在 09-20 版文件記錄的 AGPLv3 在當時是正確的，現已過時；API 仍顯示 NOASSERTION。Workspace 是另一個託管產品（pro.openbb.co）。
  - **倉庫歸屬變動（已查證的事實，原因未知）**：第一輪查詢（UTC 22:13–22:20）API 回傳 `OpenBB-finance/OpenBB`；第二輪（23:13）起回傳 `openbq-org/OpenBB`，repo id 為 323048702（建立日 2020-12-20，與第一輪記錄的原 repo 相同；我只在搬移後才取得 id），`https://github.com/OpenBB-finance/OpenBB` 現為 HTTP 301 轉向 `https://github.com/openbq-org/OpenBB`，原 `OpenBB-finance` org 的公開 repo 清單已不含 `OpenBB`。`openbq-org` 這個 org 建立於 2026-09-11、沒有名稱或網站，公開 repo 共 8 個（本體加 7 個 2026-09-11 建立的 fork），並在 2026-09-30T23:01:31Z 有一筆 MemberEvent。這可能是正式的組織遷移（例如配合 09-29 的 V5 與授權變更），也可能不是；我無法判斷。**在從新位置安裝或信任它之前，請先由 OpenBB 官方網站確認官方 repo 位置**；本文的 OpenBB star 數（73,697）是該 repo 目前的值。
- **AI-Trader**（22,645★）：README 徽章標示 MIT，但 license API 回 404、倉庫沒有 LICENSE 檔，授權實際上不明確，不能視為可重用。**dexter**（27,631★）同樣沒有 LICENSE 檔。**Stockagent** 亦無。
- **TradingAgents-CN**（32,107★）是 TradingAgents 的中文衍生版，README 明列混合授權：`tradingagents/`、`cli/`、`docs/`、`tests/` 為 Apache-2.0，`app/`、`frontend/`、`core/` 為專有（僅供個人使用、評估與教育，禁止再分發與商業使用）。**Fincept** 為 AGPL-3.0 開源版＋專有 Enterprise 版。
- **Miles-Deutscher/Backtesting-Engine** 只有 32 stars，不是「最熱門」，列入是因為使用者指定；它的 README 標題正是「Research Desk」，是一個本機 TypeScript 回測小工具（Binance 公開 K 線、選用 Alpaca 股票資料、CSV 匯入、均線交叉／RSI／買進持有、預設組、本機歷史；沒有帳戶、資料庫或實盤下單）。AlphaView 的 Research Desk 已遠超過它的功能，沒有需要導入的項目。
- **較 09-20 的變化**：+1,746（TradingAgents）、+690（Vibe-Trading）、+490（daily_stock_analysis）、+410（freqtrade）。09-20 版有舊值可比的 25 個 repo 全部為正成長（已逐一檢查），與兩次查核相隔 11 天一致，這也是對數字的交叉檢查。
- **沒有納入「全球第一」宣稱**：Kronos（39,701★）是金融市場基礎模型（依 repo 描述）、FinGPT（21,303★）是金融語言模型，皆不是交易系統；stefan-jansen/machine-learning-for-trading（21,150★）是教學書籍程式碼。

## 3. 逐一分析

格式：定位 → 資料來源 → 策略模型 → 回測與最佳化 → 風險控制 → 執行與 paper／live 分離 → Agent／LLM 架構 → 報表與 UI → 安全與合規 → 對 AlphaView 的啟示。**「README 未載明」「本次未查核」表示我的查核範圍內沒有證據，不代表該專案沒有。** 所有功能敘述都來自 README、LICENSE、檔案樹或我實際讀過的原始碼與文件，沒有任何一項經過安裝執行驗證。

### 3.1 TauricResearch/TradingAgents（109,377★，Apache-2.0）

- **定位**：LangGraph 多角色 LLM 金融交易研究框架；建立於 2024-12-28；README 版本 v0.5.2（2026-09）；最近 push 2026-09-29。
- **資料來源**：Yahoo Finance（任何 Yahoo 涵蓋的市場，以交易所後綴辨識）、Alpha Vantage、FRED（免費選用）、SEC EDGAR（依申報日還原，「as filed」）、StockTwits／Reddit、Polymarket；選用 Jev（`TYPESAFE_API_KEY`）在情緒分析師讀取前篩掉與公司無關的社群貼文。
- **策略模型**：非規則式。四位分析師（Fundamentals／Sentiment／News／Technical）並行 → Bull／Bear 研究員辯論 → Research Manager → Trader → 積極／保守／中立三方風險辯論（`tradingagents/agents/risk_mgmt/*_debator.py`）→ Portfolio Manager 核准或拒絕。評等為五級 Buy／Overweight／Hold／Underweight／Sell。
- **回測與最佳化**：`run_backtest` 在 ticker×日期網格上重跑整條管線，依評等分組計算「實現 alpha（對區域基準，預設 SPY）」，同一 `run_id` 可續跑；v0.5.x 起「回測只看各分析日當時已發布的資料」，過去日期的 Yahoo 財報與內部人交易因無法證明發布時點而被扣留（withheld）。無參數最佳化；README 未描述交易成本、滑價或部位大小模型。
- **風險控制**：由 LLM 風險辯論加 PM 核准構成；README 與 `risk_mgmt/` 目錄（三個 debator 檔）中**未見確定性的硬上限、止損或回撤鎖**。
- **執行與 paper／live**：README 稱核准的單「送往模擬交易所」；沒有券商整合；明示研究用途、不構成投資建議。
- **Agent／LLM 架構**：LangGraph；`max_debate_rounds`／`max_risk_rounds`；**記憶日誌** `~/.tradingagents/memory/trading_memory.md`：下次同 ticker 執行時，`memory/settlement.py` 取得已實現報酬（raw 與 alpha），待持有視窗完整交易後才結算（視窗未走完或無價格即維持 pending），產生一段反思注入 PM prompt；`--checkpoint` 以每個 ticker 一個 SQLite 做 LangGraph 續跑；Research Manager／Trader／PM 採結構化輸出；`PortfolioContext` 把現金與持倉餵給 trader、風險分析師與 PM——**空的 positions 代表空倉，與「沒有提供」不同，沒提供時永遠不當作空倉**。
- **輸出可靠性**：`agents/rating.py` 的 `extract_rating` 找不到評等就回 `REVIEW`，「看不懂的決策不是 Hold」，避免把從未做出的決定當成持有記入記憶。
- **報表與 UI**：CLI（互動與 `--ticker --date` 無頭模式）、報告目錄、Docker、Ollama 與多家 LLM。
- **安全與合規**：README 明說 LLM 非決定性、結果不保證重現；公司身份在任何 agent 之前由 ticker 決定性解析，價格與指標主張綁定驗證快照（針對先前「不同公司」「捏造價位」回報的修正）。
- **對 AlphaView 的啟示**：決策結算（`settlement.py`）、`REVIEW` 狀態、`PortfolioContext` 的「空≠未提供」語意（與 AlphaView 原則 1 一致）、回測網格。缺口見 G1、G11。

### 3.2 virattt/ai-hedge-fund（63,812★，MIT）

- **定位**：「AI Hedge Fund Team」教育用 POC，README 明說「the system does not actually make any trades」。新版為 `aihf` CLI／TUI，基金以 **mandate YAML** 定義（策略、人員、風險、資本、節奏），mandate 不含 ticker，執行時才指定。
- **資料來源**：Financial Datasets API（需金鑰）；LLM：Anthropic、OpenAI、DeepSeek、Google、xAI、Kimi、TypeSafe（Jev）。
- **策略模型**：`AlphaModel`／`Signal` 介面（conviction ∈ [−1, +1] 加 thesis）；LLM 投資人 persona（Buffett、Munger、Graham、Lynch、Druckenmiller 已完成）與量化模型（PEAD 已完成，動能／均值回歸／價值等仍是規劃）；Strategy = pod（模型＋blend policy＋資本切片）；conviction 加權的目標權重、可選 market-neutral sleeve；多個 pod 淨額成單一帳本後再由 master risk 夾限。
- **回測與最佳化**：`backtest_fund` 以 rebalance cadence 重放 `run_cycle`，對 mandate 基準畫權益曲線；事件研究（CAR）；**回測時遮蔽 ticker、產業與日曆日期**（基本面以 t-0、t-1 標示），README 自承這「降低但不消除」模型記憶洩漏。ROADMAP 把「Validation gate — CPCV、PBO」與「Auto-promotion … human-approved by default」列為未完成。
- **風險控制**：`hedge_fund/risk/limits.py` 只有兩條硬上限 `max_position_pct`、`max_gross_exposure`；`ClampEvent` 逐筆記錄夾限前後值；**被夾掉的曝險不重新分配，留在現金**（與 AlphaView 原則 4 相同）；`portfolio/validation.py` 的 `validate_targets()` 在送單前依訊號重算證據，與紀錄不符就拋錯；設計口號「Conviction requests, risk disposes」。
- **執行與 paper／live**：`Broker` Protocol（`positions`／`cash`／`place_order`），契約是「完整成交或拋例外，不得部分成交或默默丟單」；`build_orders` 由目標權重算差額單（先賣後買、股數向零取整、不足一股的零頭留現金）；SimBroker 已完成，**Paper broker 與 Live（IBKR／Alpaca）為未完成、預設關閉的 opt-in**。每次執行寫 `CycleRecord` 收據，但「讀回」尚未完成，NAV 沒有跨次記憶。
- **報表與 UI**：TUI（Textual）；Web dashboard 仍在 v1 引擎；排程／daemon（market-calendar cron、idempotent ticks、kill-switch）尚未做。
- **安全與合規**：教育用免責聲明；不是為實盤設計。
- **對 AlphaView 的啟示**：AlphaView 在 paper 帳本、NAV、排程與 kill switch 上已超前；可借 `ClampEvent` 稽核軌跡、`validate_targets` 重算、回測遮蔽，以及把 CPCV／PBO 做成自動升級前的驗證閘（G2、G7、G11）。

### 3.3 freqtrade/freqtrade（54,963★，GPL-3.0）

- **定位**：免費開源加密貨幣交易 bot（Python）；SQLite 持久化；Telegram、WebUI、REST 控制；建立於 2017。**僅加密貨幣**。
- **資料來源**：交易所 OHLCV（`download-data`）；現貨與期貨交易所清單見 README。
- **策略模型**：使用者撰寫 Python 策略（指標＋進出場訊號）；FreqAI 自適應機器學習。
- **回測與最佳化**：`backtesting`、`backtesting-analysis`、`hyperopt`（`list-hyperoptloss` 可選 loss function）、`edge`；**`lookahead-analysis`**：鏈接多次回測，比較「完整回測」與截斷資料下指標值與進出場是否改變，並強制關閉快取與保護機制、放大錢包與最大持倉數、固定每筆下單額以避免誤報；**`recursive-analysis`**：以不同 `startup_candle_count` 計算指標，比較最後一列是否一致，偵測遞迴公式導致的回測與實跑差異。
- **風險控制**：`stoploss.md`（固定、移動、交易所端止損）、`minimum_roi`；**保護機制**（`docs/includes/protections.md`，程式在 `freqtrade/plugins/protections/`）：`StoplossGuard`（近 `lookback_period` 內有 `trade_limit` 筆停損 → 鎖定 `stop_duration`，可 `only_per_pair`、`only_per_side`、`unlock_at`）、`MaxDrawdown`（`calculation_mode`: `ratios` 或 `equity`；回撤超過 `max_allowed_drawdown` 即停止交易一段時間）、`LowProfitPairs`、`CooldownPeriod`；**`/stopentry` 停止新進場但保留持倉，`/forceexit` 強制出場**；pairlist 過濾 `VolumePairList`、`PriceFilter`、`SpreadFilter`。
- **執行與 paper／live**：交易所 API；README：「Always start by running a trading bot in Dry-Run」；dry-run 與實盤以設定切換，分離靠流程與警語而非硬隔離。
- **報表與 UI**：FreqUI、Telegram（`/status`、`/profit`、`/daily`、`/performance`）、`plot-dataframe`／`plot-profit`。
- **安全與合規**：README 免責聲明（教育用途、風險自負）；要求時鐘以 NTP 同步。
- **對 AlphaView 的啟示**：保護機制語意（依「最近已平倉交易」統計觸發、有到期時間的鎖定）、進場與出場分離的停止模式、前視偏誤與遞迴自我檢測（G3、G6）。**GPL-3.0：只取概念，不複製程式碼。**

### 3.4 microsoft/qlib（49,079★，MIT）

- **定位**：Microsoft 的 AI 導向量化投資平台，README 稱涵蓋 alpha 搜尋、風險建模、組合最佳化與下單執行；最近 push 2026-09-22。
- **資料來源**：自有資料層與表達式引擎；README 說明官方資料集因資料安全政策暫時停用，改指向社群資料；Yahoo collector 可每日更新日線；`qlib/data/pit.py` 為點時（point-in-time）資料庫。
- **策略模型**：模型庫（LightGBM、Transformer、TRA 等）產生分數，再由 Strategy 轉為交易決策；另有 RL 下單執行與 Nested Decision Framework。
- **回測與最佳化**：`qrun` 以一份 YAML 描述整條工作流（資料集→模型→回測→評估）；分析含累積報酬、多空、IC、Monthly IC，並**分別列出含成本與不含成本的超額報酬年化、Information Ratio、最大回撤**；滾動重訓（Rolling Retraining）與 DDG-DA 處理市場分布漂移；線上服務與自動模型滾動（`qlib/workflow/online`）。
- **風險控制**：偏重績效風險分析；本次查核範圍內未見事前下單閘或止損。`qlib/backtest/exchange.py` 提供 `limit_threshold`、`volume_threshold`、`open_cost`（預設 0.0015）、`close_cost`（0.0025）、`min_cost`（5.0）、`impact_cost`（0.0）、`deal_price`。
- **執行與 paper／live**：以研究為主；本次查核範圍內未見券商整合。
- **Agent／LLM 架構**：RD-Agent（獨立 repo，14,816★，MIT）以 LLM agent 自動化因子挖掘與模型優化。
- **安全與合規**：研究用；資料可得性限制明確寫在 README。
- **對 AlphaView 的啟示**：基準相對與成本前後對照的報表、以 IC 評估訊號、PIT 資料庫概念、成交量與漲跌停限制（G1、G5、G8）。不建議導入其 ML 模型庫。

### 3.5 vnpy/vnpy（45,667★，MIT）

- **定位**：VeighNa，Python 開源量化交易系統開發框架（README 徽章 v4.4.0），使用者自述含私募、券商與期貨公司；偏中國期貨與證券市場。
- **資料來源**：Datafeed 介面（迅投研、RQData、TuShare、Wind、iFinD、Polygon 等）；SQLite 為預設資料庫，另有 MySQL、PostgreSQL、QuestDB、MongoDB 等。
- **策略模型**：CTA 策略、組合策略（Alpha、期權套利）、演算法交易（TWAP、Sniper、Iceberg、BestLimit）；4.0 起的 `vnpy.alpha`（Alpha 158／101 因子集、Lasso／LightGBM／MLP、lab 工作流）。
- **回測與最佳化**：`cta_backtester`（圖形介面回測與參數優化）、`portfolio_strategy` 歷史回測。
- **風險控制**：`risk_manager` 模組（交易流控、下單數量、活動委託、撤單總數等規則的統計與限制，README 稱「前端風控」）；`portfolio_manager` 以子帳戶式組合管理委託成交、倉位追蹤與每日盈虧。
- **執行與 paper／live**：多 Gateway（多為中國期貨與證券，海外有 Interactive Brokers）；**`paper_account` 為純本機仿真，以接口取得的即時行情撮合**並推送委託成交與持倉記錄。
- **報表與 UI**：Qt 桌面（VeighNa Trader）、`web_trader`（REST＋WebSocket）。
- **安全與合規**：README 以文件為主；「VeighNa Fusion」的 AI 投研助手需向合作期貨公司申請，不屬開源範圍。核心 repo 含 `vnpy/trader`、`vnpy/alpha` 等，各 app（如 risk_manager、paper_account）是 README 連結的獨立 repo。
- **對 AlphaView 的啟示**：事前流控規則（訂單頻率、撤單數）、子帳戶概念（對應 AlphaView 多 paper 帳戶）。市場與資料供應者差異大，可直接導入的項目有限。

### 3.6 HKUDS/Vibe-Trading（34,388★，MIT）

- **定位**：HKUDS 的「個人交易 Agent」；建立於 2026-04-01；v0.1.16（2026-09-29，README 稱自上版起 492 個 commit、116 個合併 PR）；涵蓋 A／港／美／加／英／印／韓股、加密貨幣、期貨與外匯。
- **資料來源**：多來源自動 fallback（yfinance、Tushare、BaoStock、Stooq、Longbridge 等，另有選用付費 QVeris）；近期新聞顯示持續修補資料來源問題（Stooq 反爬頁、Tencent `fqkline` 只回視窗最後 500 根等）。
- **策略與 Agent**：README 2026-07-17 新聞稱內建技能增至 88 個、Swarm 團隊（投資、量化、加密、風險）、自然語言生成策略程式再回測、跨市場 composite 回測。
- **回測與驗證**：README 的 Validate 層列出 **Monte Carlo、Bootstrap、Walk-Forward、run cards**，並有 `agent/src/quantlib/crossvalidation.py`；功能描述含「PIT data, validation, and run cards」。
- **風險與閘門**：**`agent/src/live/sdk_order_gate.py` 是 fail-closed 的實盤前 mandate 閘**：無有效 mandate 或 schema 版本未知 → DENY；`consent.expires_at` 已過 → DENY（要求重新授權）；`halt_flag_set`（kill switch）→ DENY 且不呼叫券商；數量單以報價／資料載入器定價，無法定價 → DENY，名目額取「明確名目」與「數量×價格」較大者；讀取持倉與餘額；`check_mandate` → ALLOW／DENY（結構性違規）／PAUSE_FOR_REAUTH（量化違規）；每日下單計數只在「確認成功且 `place_order` 回傳非錯誤封包」時才累加；每個決策寫一筆稽核事件。另有 **grounding gate**（v0.1.16）：模型為每個數字宣告角色（observed／derived／proposed／cited／count），閘門對照本次 session 的工具證據，未通過的數字被剔除而不是整份答案被拒；回測輸出（Sortino、換手、權重、Monte Carlo p 值）也作為報告的依據，run card 只引用存檔 CSV 吻合的指標。
- **執行與 paper／live**：唯讀 Portfolio 頁聚合多券商持倉（**失敗的來源被排除、絕不沿用舊值，快照標為不完整**；每次刷新存為不可變快照於 SQLite）；另有 MT5、eToro 與多個 direct-SDK 連接器（含 alpaca）；2026-09-28 新聞：產生的 broker matrix 保留每個 profile 的 paper／live 權限，並把「宣告的能力」與「執行期驗證」分開標示。
- **Shadow Account**：匯入券商交易紀錄 → 行為診斷（持有天數、勝率、處分效應、過度交易、追漲、錨定）→ 萃取規則 → 回測 → 與實際交易比較。
- **報表與 UI**：Web UI、CLI、TradingView／TDX／MT5 匯出、排程研究（支援 IANA 時區）、MCP 伺服器與外掛、Feishu 等 IM 通道。
- **安全與合規**：README 頂端警告 X 帳號 `VibeTrading_HKU`、Virtuals 專案與代幣合約**不是官方資產**（詐騙警示）；非本機客戶端需 `API_AUTH_KEY`；shell 類工具僅在互動式本機 CLI 啟用，HTTP／SSE 與所有 MCP 傳輸（含 stdio）預設關閉；2026-07-13 新聞稱外部安全稽核的 10 項發現全數關閉；agent 迴圈在 8 次沒有新成功觀察的工具呼叫後停止並要求復原。
- **觀察**：其 changelog 反覆出現回測與資料正確性修補——動能因子讀到當日收盤價（2026-09-30 修）、FMP 與 Tiingo 仍提供原始價導致除息被記成虧損（2026-09-02）、相關矩陣前向填補使停牌日被算成 0% 報酬（2026-07-27）——這正是 AlphaView「缺值不補、不用舊價冒充」原則要防的錯誤類型（G3、G10）。
- **對 AlphaView 的啟示**：驗證層（G2）、fail-closed mandate 閘與授權到期（G7、G12）、grounding gate（G11）、失敗來源排除的快照語意。Shadow Account 需要私人交易紀錄，暫緩。

### 3.7 nautechsystems/nautilus_trader（29,540★，LGPL-3.0）

- **定位**：Rust 原生、production-grade 的事件驅動引擎，研究、確定性模擬與實盤在同一系統；Python 經 PyO3 綁定；開源版範圍是「給個人與小團隊的單節點回測與實盤」。
- **資料來源**：報價 tick、成交 tick、K 線、委託簿與自訂資料，奈秒解析度；以 adapter 連接加密貨幣交易所、券商等。
- **策略模型**：Python 或 Rust 策略與 ExecutionAlgorithm；Actor／MessageBus／Cache 組件。
- **回測與最佳化**：**同一份策略與執行演算法碼可在回測與實盤執行**，文件另有專章「Backtest and live differences」說明模擬可能無法重現的實盤行為；fill model 有 `prob_fill_on_limit`（預設 1.0）、`prob_slippage`（預設 0.0）等機率參數；確定性撮合。
- **風險控制**：**`RiskEngine` 位於 Strategy →（OrderEmulator／ExecutionAlgorithm）→ RiskEngine → ExecutionEngine → ExecutionClient 的必經路徑**；`RiskEngineConfig`（`crates/risk/src/engine/config.rs`）：`bypass`、`max_order_submit`／`max_order_modify` 速率限制（預設各 100 次／秒）、`max_notional_per_order`（依 instrument，以報價幣別）。我沒有讀到回撤鎖或交易狀態機的證據，不在此宣稱。
- **執行與 paper／live**：啟動對帳（`crates/live/src/execution/reconciliation.rs`，使快取的委託與持倉對齊交易所回報）；`crates/adapters/sandbox` 為模擬執行 adapter；可選 Redis 做狀態持久化。
- **安全與合規**：README 有完整 Security 章節（cargo-vet、cargo-deny 授權白名單、fuzz 目標、鎖檔 checksum）；明確不建議在管理真實資金時使用開發版 wheel。
- **對 AlphaView 的啟示**：不可繞過的事前風險路徑、委託速率與單筆名目上限、啟動對帳、回測與實盤差異清單（G5、G7、G12）。Rust 核心與 LGPL 使其不適合作為依賴，只借契約。

### 3.8 QuantConnect/Lean（21,832★，Apache-2.0）

- **定位**：事件驅動的專業級演算法交易平台（C#，支援 Python 演算法）；README 稱每個元件皆可插拔；CLI：`lean research`、`lean backtest`、`lean optimize`、`lean live`。
- **資料與公司行動**：`Common/Data/Market/Split.cs`、`Dividend.cs` 為資料事件；`DataNormalizationMode` 有多個回歸演算法範例。
- **策略模型（Algorithm Framework）**：Universe Selection、Alpha（Insight）、Portfolio Construction、Risk Management、Execution 五個可插拔模型，內建實作如下（以 `Algorithm.Framework/` 檔名為證）：
  - Risk：`MaximumDrawdownPercentPerSecurity`、`MaximumDrawdownPercentPortfolio`、`TrailingStopRiskManagementModel`、`MaximumUnrealizedProfitPercentPerSecurity`、`MaximumSectorExposureRiskManagementModel`。
  - Portfolio：`EqualWeighting`、`ConfidenceWeighted`、`InsightWeighting`、`RiskParity`、`MeanVarianceOptimization`、`BlackLittermanOptimization`、`SectorWeighting`，以及 MinimumVariance、MaximumSharpeRatio 等最佳化器。
  - Execution：`VolumeWeightedAveragePriceExecutionModel`、`StandardDeviationExecutionModel`、`SpreadExecutionModel`。
- **成交模型**：Slippage：`ConstantSlippageModel`、`VolumeShareSlippageModel`、`MarketImpactSlippageModel`；Fill：`EquityFillModel`、`ImmediateFillModel`、`LatestPriceFillModel`；`BuyingPowerModel`。
- **Alpha 評分**：`InsightScore`、`InsightScoreType`、`IInsightScoreFunction`、`InsightManager` 對每個 Insight 評分。
- **執行與 paper／live**：`Brokerages/Paper/PaperBrokerage.cs`；`lean live`。
- **Agent／LLM**：本次查核範圍內未見。
- **對 AlphaView 的啟示**：五個模型契約與 AlphaView 的 Alpha→提案→風險→執行分層近似；風險模型清單、VolumeShare 滑價、Insight 評分、Split／Dividend 事件（G1、G5、G6、G9、G10）。

### 3.9 其他值得一提的專案（B 級，簡要）

- **OpenByteInc/QuantDinger**（12,346★，Apache-2.0）——與 AlphaView 的 Jev 閘最直接可比。README 的「JEV-powered pre-trade decisions」：Jev 閘放在**實盤進場單**之前，回傳型別化的選項、機率與信心；**出場、停損、停利與緊急動作繞過該閘**；供應者失敗時 **fail open** 並記錄（避免 AI 當機卡住既有部位）；閘前先做確定性風控與下單預算檢查；agent 交易預設只限 paper，實盤需 token 與伺服器端授權；長時間策略用 lease、heartbeat 與 fencing token；預設連接埠僅限 loopback。啟示：AlphaView 應明確決定 Jev 失敗時的預設——對**進場**採 fail-closed（標為不可用並擋下），對**出場**永不被諮詢性閘門擋住（G6）。
- **Jev 生態**：TradingAgents（選用社群貼文篩選）、ai-hedge-fund（模型提供者之一）、QuantDinger（進場閘）都整合了 TypeSafe Jev，代表 AlphaView 的 Jev 決策層與主流專案方向一致。
- **TraderAlice/OpenAlice**（7,200★，AGPL-3.0）——「Trading as Git」：agent 只能 stage 提案並 commit 理由，由人審核後才 push 執行，執行標為 beta，建議先用 simulator／paper。與 AlphaView 的「提案＋明確接受」同源。
- **AI4Finance-Foundation/FinRL-Trading（FinRL-X）**（3,772★，Apache-2.0）——權重導向管線（選股→配置→時機→風險疊加）、`trade_executor.py` 事前風險檢查、Alpaca 多帳戶 paper／live；自適應輪動策略含 regime 濾網（26 週趨勢＋VIX、3 日快速 risk-off）、移動與絕對止損、冷卻期。其回測與 paper 績效是 README 自述，未驗證（G4 的主要參考）。FinRL（16,518★）本身偏強化學習研究。
- **Lumiwealth/lumibot**（2,100★，GPL-3.0）——同一份策略碼跑回測、paper、實盤（12 個券商）；AI agent runtime 搭配確定性 Python 閘；回測可重放已存的 agent 決策（與重新呼叫模型不同）；背後有託管商業服務。
- **ZhuLinsen/daily_stock_analysis**（65,814★，MIT）——LLM 決策儀表（評分、趨勢、買賣點位、風險警報、檢查清單）、多市場、15 種內建策略、回測與持股；資料用 AkShare／Baostock／YFinance 等免費源（作者自承穩定性不保證）；推播到企業微信、飛書、Telegram、Discord、Slack、Email——**推播不符 AlphaView 原則**。
- **HKUDS/AI-Trader**（22,645★）——託管式「agent 原生」交易平台：agent 發布訊號、跟單、積分與聲望、Polymarket paper trading；多使用者社群性質，授權不明。
- **virattt/dexter**（27,631★）——自主金融研究 agent，含任務規劃、自我驗證、迴圈偵測與步數上限；需 OpenAI 與 Financial Datasets 金鑰；無 LICENSE。
- **kyky2347/ALTA**（916★，Apache-2.0）——「僅研究用」多 Agent 平台，執行只有 Shadow（內部模擬）與 Broker API 兩種模式，券商下單需「已驗證且明確選定的帳戶」加上獨立授權；README 自述「Research is open-ended; authority is explicit」——LLM 決定調查什麼與如何使用，風控、新鮮度與帳戶隔離由程式強制；「Wait」是一等公民結果；README 也承認六個連接器存在但實盤帳戶驗收尚未成立。與 AlphaView 的立場最接近，但只有 916 stars。
- **hummingbot**（20,280★，Apache-2.0）——加密貨幣造市框架、Strategy V2 controllers、`binance_paper_trade` 模式、Condor（把 LLM 決策接到確定性執行）；**jesse**（8,606★，MIT）——加密貨幣研究框架，Optuna／Ray 最佳化、Jesse MCP；皆與美股日線關聯低。
- **回測與分析函式庫**：backtrader（23,377★，GPL-3.0，2024-08 後無 push，但有 Sharpe／SQN analyzer、滑價與成交量填單、sizers）、vectorbt（9,244★，Commons Clause）、backtesting.py（9,010★，AGPL-3.0，內建 SAMBO 最佳化）、pybroker（3,550★，walk-forward＋bootstrap 指標，Commons Clause）、quantstats（7,675★，Apache-2.0：Monte Carlo、Sortino、Calmar、CVaR、回撤明細、greeks、tail ratio、對基準的 HTML tearsheet）。
- **組合最佳化函式庫**：PyPortfolioOpt（6,069★，MIT）、Riskfolio-Lib（4,527★，BSD-3）、skfolio（2,453★，BSD-3）。
- **論文程式碼**：FinMem（962★，MIT，分層記憶＋角色設計，train／test 兩模式，2024-08 後無 push）、StockAgent（706★，LLM 在模擬市場四階段交易，無 LICENSE）。

## 4. 功能矩陣

欄位是 AlphaView 與 8 個深度分析專案。符號：**●** README／文件／檔案樹可證實有；**◐** 部分或有條件；**○** 在本次查核範圍內未見（不等於不存在）；**？** 本次未查核；**—** 不適用。AlphaView 欄依我對 `alphaview/panel`、`docs` 的讀取與關鍵字搜尋。

| 功能 | AlphaView | TradingAgents | ai-hedge-fund | Vibe-Trading | freqtrade | Lean | Nautilus | qlib | vnpy |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 多角色 LLM Agent（persona／辯論） | ◐ | ● | ● | ● | ○ | ○ | ○ | ◐ | ○ |
| 確定性風險關卡（LLM／訊號不可覆寫） | ● | ○ | ● | ● | ● | ● | ● | ○ | ● |
| 帳戶層級回撤鎖／停損守衛／冷卻 | ● | ○ | ○ | ◐ | ● | ● | ○ | ○ | ◐ |
| 部位層級止損／移動停損 | ◐ | ○ | ○ | ？ | ● | ● | ？ | ○ | ？ |
| 只擋進場、不擋出場（reduce-only／stop-entry） | ○ | ○ | ○ | ？ | ● | ？ | ？ | ○ | ？ |
| 市場 regime → 總曝險調整 | ◐ | ○ | ○ | ？ | ○ | ○ | ○ | ○ | ○ |
| 點時資料／防前視設計 | ◐ | ● | ◐ | ● | ● | ？ | ◐ | ● | ○ |
| 自動前視／遞迴偏誤檢測工具 | ○ | ○ | ○ | ？ | ● | ？ | ？ | ○ | ○ |
| Walk-forward／滾動重訓 | ◐ | ○ | ○ | ● | ？ | ？ | ？ | ● | ○ |
| 過擬合統計（bootstrap／MC／Deflated Sharpe／PBO） | ○ | ○ | ○ | ● | ？ | ？ | ？ | ？ | ？ |
| 決策結果結算／訊號評分（IC、alpha、Brier） | ○ | ● | ◐ | ◐ | ○ | ● | ○ | ● | ○ |
| 風險感知組合建構（inverse-vol／risk parity／MVO） | ○ | ○ | ◐ | ◐ | ○ | ● | ○ | ● | ◐ |
| 流動性／成交量滑價／單筆名目上限 | ○ | ○ | ○ | ◐ | ◐ | ● | ● | ● | ◐ |
| 公司行動（拆併股、股息） | ○ | ○ | ？ | ◐ | — | ● | ？ | ？ | ？ |
| Paper 帳本／NAV 持久化 | ● | ○ | ◐ | ？ | ● | ● | ● | ○ | ● |
| 券商 paper／live 下單路徑 | ○ | ○ | ◐ | ● | ● | ● | ● | ○ | ● |
| 委託狀態機／對帳／冪等 | ◐ | ○ | ◐ | ◐ | ？ | ？ | ● | ○ | ？ |
| 常駐或排程自動化 | ● | ◐ | ◐ | ● | ● | ● | ● | ◐ | ？ |
| LLM 輸出治理（數字溯源、REVIEW、遮蔽） | ◐ | ◐ | ◐ | ● | — | — | — | — | — |
| MCP／Agent 工具介面 | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ |
| 授權可直接重用程式碼 | — | ✓ Apache-2.0 | ✓ MIT | ✓ MIT | ✗ GPL-3.0 | ✓ Apache-2.0 | △ LGPL-3.0 | ✓ MIT | ✓ MIT |

**各格主要證據（AlphaView 欄以外）**

- 多角色 LLM：TradingAgents（分析師、Bull／Bear、三方風險辯論）、ai-hedge-fund（LLM 投資人 persona）、Vibe-Trading（Swarm 團隊）；qlib 只在獨立 repo RD-Agent 有 LLM agent；vnpy 的 AI 投研助手屬商業 Fusion。
- 確定性風險關卡：ai-hedge-fund `risk/limits.py`；Vibe-Trading `live/sdk_order_gate.py`；freqtrade protections；Lean `Algorithm.Framework/Risk/`；Nautilus `crates/risk/src/engine/config.rs`；vnpy `risk_manager`。TradingAgents 的風險層是 LLM 辯論，未見硬上限。
- 帳戶層級鎖：freqtrade `MaxDrawdown`／`StoplossGuard`／`CooldownPeriod`；Lean `MaximumDrawdownPercentPortfolio`；Vibe-Trading 有 kill switch（`halt_flag_set`）但未見回撤鎖。
- 只擋進場：freqtrade `/stopentry`；另外 QuantDinger（不在矩陣內）的 Jev 閘只擋進場、出場繞過。
- regime：AlphaView 有 `market_regime.py` 但只被自己的 API 路由引用；FinRL-X（不在矩陣內）有 slow／fast regime 疊加層。
- 常駐或排程：Vibe-Trading 排程研究（IANA 時區）、freqtrade 常駐 bot、Lean `lean live`、Nautilus live node；TradingAgents 只有可排程的無頭 CLI；ai-hedge-fund ROADMAP 將 scheduler 標為未完成；qlib 有線上服務與自動滾動。
- 點時資料：TradingAgents v0.5.x（EDGAR as filed、過去日期扣留 Yahoo 財報）、qlib `data/pit.py`、freqtrade 的兩個分析指令、Vibe-Trading 功能描述；ai-hedge-fund ROADMAP 標為進行中。
- 過擬合統計：Vibe-Trading README；不在矩陣內的 pybroker（bootstrap 指標、walk-forward）與 quantstats（Monte Carlo）。
- 結果結算：TradingAgents `memory/settlement.py`；Lean `InsightScore.cs`／`InsightManager.cs`；qlib `qrun` 的 IC 報表。
- 組合建構與滑價：Lean 檔名清單；qlib `exchange.py` 參數；Nautilus `max_notional_per_order`；freqtrade pairlist 過濾器。
- 公司行動：Lean `Split.cs`／`Dividend.cs`；Vibe-Trading 變更紀錄只證明它修過股息記帳錯誤。
- Paper：freqtrade dry-run＋SQLite；Lean `PaperBrokerage.cs`；Nautilus sandbox adapter；vnpy `paper_account`；ai-hedge-fund 僅寫收據、讀回未完成。
- 委託狀態機與對帳：Nautilus `crates/live/src/execution/reconciliation.rs`；ai-hedge-fund 的 Broker 契約（完整成交或拋例外）；Vibe-Trading 的每日下單計數鎖與稽核事件。
- MCP：Vibe-Trading MCP 外掛與伺服器；另外 OpenBB（ODP 供 MCP）、jesse（Jesse MCP）也有，不在矩陣內。

**矩陣的讀法**：AlphaView 的強項是「帳本與閘門」（確定性風險關卡、斷路器、paper 帳本、排程與 kill switch、提案與冪等）；明顯的弱項集中在「證據與完整性」（結果結算、驗證統計、前視檢測）與「真實世界摩擦」（流動性、公司行動、reduce-only）。這與第 5 節的排序一致。

## 5. 高價值缺口排序

排序依據：**價值 × 可行**（各 1–5，可用半級），價值指對「會自動 paper 調倉、之後要能上線」的 agent 有多重要；可行指在 AlphaView 約束下（本機資料、無新付費供應者、可版本化、缺值為不可用、不碰實盤）能否落地。同分先比價值再看依賴。以下 12 項都已對照 AlphaView 現況（見第 4 節與各項「為什麼重要」），不是單純列出競品功能。

| 排名 | 缺口 | 價值 | 可行 | 分數 | 工程量 | 最佳參考 |
| ---: | --- | ---: | ---: | ---: | :-: | --- |
| 1 | 決策／訊號結果結算帳本（含 Jev 機率校準） | 5.0 | 4.0 | 20.00 | M | TauricResearch/TradingAgents |
| 2 | 策略驗證閘（walk-forward、bootstrap 信賴區間、Deflated Sharpe／PBO） | 5.0 | 4.0 | 20.00 | M | HKUDS/Vibe-Trading |
| 3 | 前視偏誤／遞迴指標自我檢測（截斷不變性測試） | 4.0 | 5.0 | 20.00 | S | freqtrade/freqtrade |
| 4 | 市場風險溫度計接入配置：regime → 總曝險上限 | 4.0 | 4.5 | 18.00 | M | AI4Finance-Foundation/FinRL-Trading (FinRL-X) |
| 5 | 流動性與成交量感知的成本模型／下單前檢查 | 4.0 | 4.5 | 18.00 | M | QuantConnect/Lean |
| 6 | 部位層級出場規則、reduce-only 模式與停損守衛 | 4.0 | 4.0 | 16.00 | M | QuantConnect/Lean |
| 7 | Paper→Live 就緒閘與授權生命週期（mandate 到期、超限重新授權） | 4.5 | 3.5 | 15.75 | M | HKUDS/Vibe-Trading |
| 8 | 績效分析深度（基準相對指標、Sortino／Calmar、bootstrap 區間、成本前後對照） | 3.0 | 5.0 | 15.00 | S | ranaroussi/quantstats |
| 9 | 風險感知配置器（反波動／分數傾斜，預留 risk parity） | 3.5 | 4.0 | 14.00 | M | QuantConnect/Lean |
| 10 | 公司行動感知的 paper 帳本（拆併股、現金股息） | 4.5 | 3.0 | 13.50 | L | QuantConnect/Lean |
| 11 | LLM 輸出治理（數字溯源閘、review_required、回放遮罩、run receipt） | 3.0 | 4.5 | 13.50 | M | HKUDS/Vibe-Trading |
| 12 | Broker paper-adapter 協定與委託狀態機（需使用者新授權） | 5.0 | 2.0 | 10.00 | L | nautechsystems/nautilus_trader |

**建議導入順序（依賴關係）**

1. **第一波：證據與完整性**——G3（前視自我檢測，S）→ G1（結果結算帳本）→ G2（驗證閘）。其餘功能的效益與風險都要靠這三項量測。
2. **第二波：風險完整性**——G5（流動性）→ G4（regime 接線）→ G6（出場規則與 reduce-only）→ G10（公司行動）。G6 的 reduce-only 是小而關鍵的安全修補，可以提前單獨做。
3. **第三波：上線準備**——G8（分析深度）→ G7（就緒閘與授權到期）→ G9（配置器）→ G11（LLM 治理）。
4. **需新授權**——G12（Broker paper-adapter）。專案目前禁止下單，必須由使用者另行明確授權才可開工；在此之前以 G7 的就緒檢查與既有 `execution_dry_run.py` 為止。

**與 `CLAUDE.md` 原則的相容性檢查**：每一項都要求缺值為「不可用」並附原因（原則 1）、新方法附版本字串且不覆寫舊版（原則 2）、讀取走 `snapshot_read`（原則 3）、被裁掉的權重留作現金而非重分配（原則 4）、不把研究包裝成實盤指示（原則 5）、測試只用合成資料與 `tmp_path`（原則 6）、不新增外部動作或付費依賴（原則 9）。G12 是唯一會碰到原則 5 與 9 邊界的項目，因此獨立標示為需新授權。

### G1. 決策／訊號結果結算帳本（含 Jev 機率校準）

- **是什麼**：對每一筆已保存的決策（掃描挑選、Agent 提案、Jev 問題答案），在持有視窗完整交易後，結算原始報酬與相對基準（例如 SPY 同期）的超額報酬；視窗未走完一律 pending，不用部分視窗；對 Jev 的固定結果機率另算 Brier score 與校準表；依規則／角色／評等分組。
- **為什麼重要**：目前沒有任何機制回答「這套規則、這個角色、這道 Jev 閘門過去到底準不準」。要讓 agent 逐步放權，必須先有這個證據。TradingAgents 把結算做成每次執行前的必經步驟，Lean 對每個 Insight 評分，qlib 用 IC 評估訊號。AlphaView 的 `scans`、`portfolio_agent_runs`、`jev_decision_runs` 都是「當時保存」的紀錄，天然免於 `alpha_replay.py` 那種現行股池回放的倖存者偏誤。
- **誰做得最好（可查證來源）**：
  - TauricResearch/TradingAgents：`tradingagents/memory/settlement.py`——持有視窗完整交易後才結算，計算原始報酬與對區域基準的 alpha，並把反思寫進下一次執行的記憶。
  - QuantConnect/Lean：`Common/Algorithm/Framework/Alphas/InsightScore.cs`、`InsightManager.cs`——對每個 Insight 評分。
  - microsoft/qlib：`qrun` 報表——IC、Monthly IC，以及含成本與不含成本的超額報酬。
- **對應 AlphaView 模組**：新增 `alphaview/panel/decision_ledger.py`（方法版本 `alphaview-decision-outcome-v1`），`@store.snapshot_read` 只讀 `scans`（as_of、result）、`portfolio_agent_runs`、`jev_decision_runs`（answers_json 與 result_json 內的門檻判定）、`bars`；輸出樣本數 N、命中率、平均超額、Brier／log-loss；回傳附 `engine_version`、`as_of`、`input_revision`、`method`，測試確認 `store.input_revision()` 不變；前端在 `AgentPortfolio.tsx` 增「結果追蹤」區。
- **工程量**：M　**價值** 5.0 × **可行** 4.0 = **20.00**
- **授權與限制**：僅描述統計：小樣本顯示 N 與區間，不自動調整閾值，也不把結果回灌模型（避免資料窺探）。已下市或缺價的標的必須單獨計數為 unavailable，不可默默剔除，否則結算樣本仍有倖存者偏誤。TradingAgents、Lean 均為 Apache-2.0，僅取概念，無須複製程式碼。
- **驗收提示**：合成資料測試：視窗未走完為 pending；缺基準價為 unavailable；同輸入重算結果逐位元相同。

### G2. 策略驗證閘（walk-forward、bootstrap 信賴區間、Deflated Sharpe／PBO）

- **是什麼**：Research Desk 目前只做單次樣本內／外切分並提示多重比較。新增「不調參的驗證」：多段前推（anchored／rolling）的穩定性、對超額報酬與 Sharpe 做 bootstrap 信賴區間、以錦標賽實際試驗數計算 Deflated Sharpe，必要時以 CSCV 估 PBO；輸出 pass／warn／fail／unavailable。
- **為什麼重要**：四策略乘參數的錦標賽就是多重檢定，沒有統計閘門時「勝出策略」很可能只是運氣。ai-hedge-fund 把 CPCV／PBO 列為核心未完成項，並主張自動升級須經驗證閘；Vibe-Trading 已提供 Monte Carlo／Bootstrap／Walk-Forward；pybroker 用 bootstrap 求指標區間。
- **誰做得最好（可查證來源）**：
  - HKUDS/Vibe-Trading：README「Validate」層（Monte Carlo、Bootstrap、Walk-Forward、run cards）與 `agent/src/quantlib/crossvalidation.py`。
  - edtechre/pybroker：`strategy.walkforward(...)` 與以 bootstrap 求得的指標（Apache-2.0＋Commons Clause）。
  - virattt/ai-hedge-fund：ROADMAP 的「Validation gate — CPCV、PBO」與「Auto-promotion … human-approved by default」（兩者皆為規劃，尚未實作）。
- **對應 AlphaView 模組**：`research_desk.py` 新增 `alphaview-validation-v1`，結果存入 `research_desk_runs`；`portfolio_agent.py` 只採用 `validation=pass` 的規則（warn 則在提案標示）。`docs/research-desk.md` 現聲明「不做 walk-forward 最佳化，避免把調參包裝成驗證」，新閘門是驗證而非最佳化，需同步更新該段。
- **工程量**：M　**價值** 5.0 × **可行** 4.0 = **20.00**
- **授權與限制**：日線樣本短、信賴區間會很寬，必須顯示「資料不足」而不是硬給結論。pybroker 與 vectorbt 為 Commons Clause，只取概念。
- **驗收提示**：合成報酬序列：已知無優勢的隨機策略在多次試驗下 Deflated Sharpe 不應 pass；樣本不足回 unavailable。

### G3. 前視偏誤／遞迴指標自我檢測（截斷不變性測試）

- **是什麼**：對每個策略與指標做「截斷不變性」測試：用截至 t 的資料算出的訊號，必須等於用完整序列在 t 算出的訊號（look-ahead）；並測試不同暖機長度下 t 的指標值是否收斂（recursive，例如 Wilder RSI、EMA）。
- **為什麼重要**：所有回測與回放的可信度都建立在沒有偷看未來。Vibe-Trading 在 2026-09-30 才修掉一個讀到當日收盤價的動能因子；freqtrade 把這項檢查做成一等公民指令。AlphaView 已有 R0 前綴回放契約（`replay_prefix.py`），但缺少針對指標與策略本身的自動化測試。
- **誰做得最好（可查證來源）**：
  - freqtrade/freqtrade：`lookahead-analysis`、`recursive-analysis` 指令（`freqtrade/optimize/analysis/lookahead.py`、`recursive.py`；GPL-3.0，僅取概念）。
  - HKUDS/Vibe-Trading：變更紀錄 2026-09-30（動能因子讀到當日收盤價）與 2026-09-02（原始價與調整價混用使股息被記成虧損）。
- **對應 AlphaView 模組**：`tests/` 新增合成 bars 的 property 式測試；`research.py`／`research_desk.py` 的每個方法版本附一份 integrity receipt（測試集 hash）；失敗則結果標 `integrity_unverified`；與 `replay_prefix.py` 共用截斷工具。
- **工程量**：S　**價值** 4.0 × **可行** 5.0 = **20.00**
- **授權與限制**：freqtrade 為 GPL-3.0，僅依公開文件描述自行實作。測試只能證偽、不能證明無偏誤；Yahoo 調整價回溯修訂（股息）造成的歷史漂移需另以資料快照處理。
- **驗收提示**：對四策略全部通過；對刻意植入 shift(-1) 的壞指標必定失敗。

### G4. 市場風險溫度計接入配置：regime → 總曝險上限

- **是什麼**：把已存在的 `alphaview-regime-v1` 分數轉成確定性的總曝險上限（例如以分級對應現金下限），加遲滯與最短持續期避免來回；因子不完整時狀態為 unavailable，提案顯示警告並採保守路徑，不得假設 risk-on。
- **為什麼重要**：`market_regime.py` 目前只被 API 路由引用，agent 配置（`portfolio_agent.py`）與自動化完全不看它：儀表做了卻沒接進決策。FinRL-X 把風險疊加層列為管線一級模組；Lean 有組合層風險模型。
- **誰做得最好（可查證來源）**：
  - AI4Finance-Foundation/FinRL-Trading（FinRL-X）：README「Adaptive Multi-Asset Rotation」——slow regime（26 週趨勢＋VIX）、fast risk-off（3 日衝擊）、移動與絕對止損、冷卻期；管線為選股→配置→時機→風險疊加。
  - QuantConnect/Lean：`Algorithm.Framework/Risk/MaximumDrawdownPercentPortfolio`。
  - virattt/ai-hedge-fund：`risk/limits.py`（master risk 夾限合併後的帳本）。
- **對應 AlphaView 模組**：`market_regime.py` 暴露純函式 `exposure_cap(state)`；`portfolio_agent.py` 的配置席位與 `cash_buffer_pct` 吃此上限；`rebalance_trigger.py` 新增「regime 轉換」觸發（仍受 cooldown 約束）；`agent_automation_attempts.result_json` 記錄 regime 版本與輸入 token；先以 `paper_scenarios.py`／`paper_comparison.py` 對照有無 overlay，預設關閉。方法版本 `alphaview-regime-overlay-v1`。
- **工程量**：M　**價值** 4.0 × **可行** 4.5 = **18.00**
- **授權與限制**：對報酬的影響未經證實（FinRL-X 的回測與 paper 成績為其 README 自述，本次未驗證）。缺因子時不得把權重挪給其他因子（原則 4）。
- **驗收提示**：缺任一啟用因子時 overlay 為 unavailable 且提案標示；遲滯使連續兩日在門檻附近不產生往返調倉。

### G5. 流動性與成交量感知的成本模型／下單前檢查

- **是什麼**：加入「單筆下單量 ≤ 近 N 日成交金額中位數的 x%」預檢與最低價、最低成交金額的資格篩；滑價由固定 bps 升級為「基礎 bps＋隨參與率增加的衝擊項」；超限時裁切或阻擋並列原因。
- **為什麼重要**：候選池探索可能納入流動性差的標的，而目前成本模型只有固定 `fee_bps`／`slippage_bps`，對 ADV、participation、liquidity 的英文關鍵字搜尋在 `alphaview/panel` 無命中，`paper_scenarios.py` 的警語也明言情境未模擬流動性，paper 成績會系統性樂觀。`store.bars` 已有 `volume`，不需任何新資料。
- **誰做得最好（可查證來源）**：
  - QuantConnect/Lean：`Common/Orders/Slippage/VolumeShareSlippageModel.cs`、`MarketImpactSlippageModel.cs`；`Algorithm.Framework/Execution/VolumeWeightedAveragePriceExecutionModel`。
  - microsoft/qlib：`qlib/backtest/exchange.py`（`volume_threshold`、`limit_threshold`，預設 `open_cost=0.0015`、`close_cost=0.0025`、`min_cost=5.0`、`impact_cost=0.0`）。
  - nautechsystems/nautilus_trader：`crates/risk/src/engine/config.rs`（每個 instrument 的 `max_notional_per_order`）。
- **對應 AlphaView 模組**：`paper_portfolio.py` 預檢與 `execution_policy` 新欄位（如 `max_participation_pct`、`min_dollar_volume`）；`portfolio_agent.py` 資格階段；`paper_scenarios.py` 做滑價敏感度；語意改變，方法版本升 `alphaview-paper-portfolio-v3`，舊帳本不重算。
- **工程量**：M　**價值** 4.0 × **可行** 4.5 = **18.00**
- **授權與限制**：日線成交量不等於開盤集合競價可成交量，參與率只是粗略門檻；衝擊係數屬假設，須標示並可調。Lean、qlib 授權寬鬆，仍只取概念。
- **驗收提示**：低流動性合成標的被裁切或阻擋；缺 volume 時為 unavailable 而非放行。

### G6. 部位層級出場規則、reduce-only 模式與停損守衛

- **是什麼**：(a) agent 風險階段加入收盤確認的出場規則（固定／移動停損、時間停損、單檔最大回撤），次一交易日開盤執行；(b) 斷路器或 kill switch 觸發後改為 reduce-only：禁止新增買入，仍允許降低風險的賣出（目前整張提案都被擋）；(c) 類 StoplossGuard：近 N 日停損次數達門檻 → 暫停新進場；(d) 有板塊欄位時的選用板塊曝險上限。
- **為什麼重要**：paper agent 的出場只來自「目標清單不再包含該標的」（`portfolio_agent.py` 依排名選股）；對 stop、trailing、exit 的關鍵字搜尋在 `portfolio_agent.py`、`agent_automation.py`、`rebalance_trigger.py` 只命中排程停止旗標，未見價格型出場。`circuit_breakers.guard_fill` 一旦跳脫就回 409、`paper_portfolio.py` 對 kill switch 也整張擋下，連減碼賣單都無法模擬，帳戶只能等人工恢復；對接近上線的系統這是危險設計。freqtrade 的 `/stopentry` 與 QuantDinger 的「出場繞過 AI 閘門」都是「只擋進場、不擋出場」的同一原則。
- **誰做得最好（可查證來源）**：
  - QuantConnect/Lean：`Algorithm.Framework/Risk/` 的 `TrailingStopRiskManagementModel`、`MaximumDrawdownPercentPerSecurity`、`MaximumUnrealizedProfitPercentPerSecurity`、`MaximumSectorExposureRiskManagementModel`。
  - freqtrade/freqtrade：protections `StoplossGuard`／`CooldownPeriod`／`LowProfitPairs`（`docs/includes/protections.md`）、`docs/stoploss.md`、`/stopentry` 指令（GPL-3.0，僅取概念）。
  - OpenByteInc/QuantDinger：README 明載出場、停損、停利與緊急動作繞過 AI 閘門（exits, stop-loss, take-profit, and emergency actions bypass the filter）。
- **對應 AlphaView 模組**：`portfolio_agent.py`（risk 階段）、`paper_next_open.py`（出場單走既有 next-open 佇列）、`circuit_breakers.py`（新 check `stoploss_cluster`；新模式 `reduce_only`）、`paper_portfolio.py`（區分 halt 與 reduce_only）；`research_desk.py` 已有 `stop_loss_pct` 的 close-confirmed 語意可重用。方法版本 `alphaview-position-risk-v1`。
- **工程量**：M　**價值** 4.0 × **可行** 4.0 = **16.00**
- **授權與限制**：日線停損有跳空風險（成交於下一開盤價而非停損價），必須如實顯示。freqtrade 為 GPL-3.0，只取概念；板塊資料缺失時該檢查為 unavailable。
- **驗收提示**：斷路器跳脫後，只含賣出的提案可被接受、含買入的被拒並說明原因；跳空情境以開盤價成交。

### G7. Paper→Live 就緒閘與授權生命週期（mandate 到期、超限重新授權）

- **是什麼**：唯讀「就緒檢查表」：以本機證據逐項給 pass／fail／unavailable（連續完成交易日數與 NAV 快照、斷路器跳脫史、資料覆蓋率、驗證閘結果、結果帳本樣本數與 Brier、kill switch 演練紀錄、execution dry-run 收據）；另讓 `auto_simulate` mandate 帶 `expires_at`，到期自動退回 `proposal_only` 並要求重新確認；量化違規時暫停並要求重新授權。
- **為什麼重要**：使用者的終點是可上線的自動調倉，而現有 `agent_mandates` 的欄位（`enabled`、`mode`、`version`、`selector_limit` 等）沒有到期或重新授權概念，關鍵字搜尋 expir／consent／reauth 也無命中。Vibe-Trading 的 live gate 是完整的 fail-closed 範例；ai-hedge-fund 路線圖主張自動升級須經驗證閘且預設人工核准。
- **誰做得最好（可查證來源）**：
  - HKUDS/Vibe-Trading：`agent/src/live/sdk_order_gate.py`——fail-closed：無有效 mandate → DENY；`consent.expires_at` 已過 → DENY；halt flag → DENY 且不呼叫券商；無法定價 → DENY；量化違規 → PAUSE_FOR_REAUTH；每日計數只在確認成功後累加；每個決策寫一筆稽核事件。
  - virattt/ai-hedge-fund：ROADMAP「Auto-promotion … human-approved by default」。
  - nautechsystems/nautilus_trader：`docs/concepts/live.md`「Backtest and live differences」。
- **對應 AlphaView 模組**：新增 `readiness.py`（`alphaview-readiness-v1`，只讀）；`agent_automation.py` 的 `agent_mandates` 增 `expires_at`／`reauth_required`（schema 遷移需測試，沿用 `tests/test_agent_schema_migration.py` 風格）；UI 放 `AgentPortfolio.tsx`；絕不自動啟用任何功能。
- **工程量**：M　**價值** 4.5 × **可行** 3.5 = **15.75**
- **授權與限制**：就緒檢查是證據彙整，不是獲利保證，也不是實盤授權；實盤連線仍須使用者另行授權（專案目前禁止）。依賴前述驗證閘與結果帳本才有意義。
- **驗收提示**：缺任一證據為 unavailable 而非 pass；mandate 到期後排程不再產生 auto_simulate 成交。

### G8. 績效分析深度（基準相對指標、Sortino／Calmar、bootstrap 區間、成本前後對照）

- **是什麼**：在 `paper_analytics.py` 現有的期間報酬、最大回撤、換手之上，加入同期 SPY 買進持有基準、超額報酬、追蹤誤差、Information Ratio、Sortino、Calmar、回撤區間表、成本前後對照，以及 bootstrap 信賴區間與最小樣本守衛（交易日不足 → 不可用）。
- **為什麼重要**：對 `paper_analytics.py` 的指標名稱搜尋只找到期間報酬、最大回撤、換手；要判斷 agent 是否優於「什麼都不做」必須有基準相對數字。qlib 的報表分開列出含成本與不含成本的超額報酬；quantstats 提供完整指標集。
- **誰做得最好（可查證來源）**：
  - ranaroussi/quantstats：`qs.stats.montecarlo`、`sortino`、`calmar`、`cvar`、`drawdown_details`、`greeks`、`tail_ratio`；`qs.reports.html(stock, "SPY")` tearsheet（Apache-2.0）。
  - microsoft/qlib：`qrun` 風險報表（含成本與不含成本的年化超額報酬、Information Ratio、最大回撤）。
  - HKUDS/Vibe-Trading：run card 只引用存檔 CSV 吻合的指標。
- **對應 AlphaView 模組**：`paper_analytics.py`（方法 `alphaview-paper-analytics-v2`）與 `paper_reports.py`（匯出）；基準價取自 `bars`（SPY 已在股池時），否則 unavailable；前端沿用 `AgentPortfolio.tsx` 報表區。
- **工程量**：S　**價值** 3.0 × **可行** 5.0 = **15.00**
- **授權與限制**：不新增 quantstats 依賴，只參考指標定義。短樣本下指標不穩，須顯示 N；Sharpe 口徑沿用 Research Desk（252 日、零無風險利率）以免兩處不一致。
- **驗收提示**：樣本不足為 unavailable；無基準價時基準相對指標為 unavailable 而非 0。

### G9. 風險感知配置器（反波動／分數傾斜，預留 risk parity）

- **是什麼**：`portfolio_agent.py` 目前是等權席位（`slot = min((100 - cash_buffer)/max_positions, max_position_weight_pct)`）。加入可插拔配置器：等權（預設）、反波動（近 60 交易日日報酬標準差）、分數傾斜；既有上限照舊約束，被裁掉的權重留作現金、不重分配（原則 4）。
- **為什麼重要**：等權忽略個股風險差異。Lean 內建多種組合建構模型，PyPortfolioOpt／Riskfolio-Lib／skfolio 提供成熟演算法。AlphaView 已有情境與帳戶比較基礎建設，可直接量化「換配置器是否真的更好」。
- **誰做得最好（可查證來源）**：
  - QuantConnect/Lean：`Algorithm.Framework/Portfolio/` 的 `RiskParityPortfolioConstructionModel`、`MeanVarianceOptimizationPortfolioConstructionModel`、`MinimumVariancePortfolioOptimizer`。
  - PyPortfolio/PyPortfolioOpt（MIT）、dcajasn/Riskfolio-Lib 與 skfolio/skfolio（BSD-3-Clause）。
  - virattt/ai-hedge-fund：`portfolio/construction.py`（conviction 加權）搭配 `risk/limits.py` 夾限。
- **對應 AlphaView 模組**：`portfolio_agent.py` 配置階段抽成 allocator 介面（方法 `alphaview-allocator-v1`）；以 `paper_scenarios.py`／`paper_comparison.py`／`paper_forks.py` 做對照；`holding_fit.py` 的相關性計算可重用。
- **工程量**：M　**價值** 3.5 × **可行** 4.0 = **14.00**
- **授權與限制**：短窗口共變異數估計雜訊大，第一版只做對角（反波動），不做 MVO；不新增最佳化套件依賴；結果標示為假設情境，不是預期報酬。
- **驗收提示**：波動為零或缺價的標的為 unavailable 並保留現金席位；總權重加現金恆為 100%。

### G10. 公司行動感知的 paper 帳本（拆併股、現金股息）

- **是什麼**：帳本新增 `corporate_action` 事件（split 比率、現金股息金額、ex-date、來源與覆蓋度），對持倉股數與現金冪等套用（以 symbol＋ex_date＋kind 為鍵）；NAV 以含股息的總報酬口徑呈現或明確分開顯示；來源衝突（Yahoo 事件與調整因子不一致）→ 該標的 unavailable 並阻擋新委託。
- **為什麼重要**：`paper_next_open.py` 遇調整因子跨日變動會直接 `corporate_action_unsupported`（「本版不調整股數」），失敗方式是安全地阻擋；但 `paper_portfolio.py` 以未調整收盤估值，關鍵字搜尋未見股息入帳邏輯，NAV 會靜默低估除息標的。長期運行的 agent 遲早持有到拆股或除息。
- **誰做得最好（可查證來源）**：
  - QuantConnect/Lean：`Common/Data/Market/Split.cs`、`Dividend.cs` 與 `DataNormalizationMode`。
  - microsoft/qlib：`qlib/data/pit.py`（點時資料）。
  - HKUDS/Vibe-Trading：變更紀錄 2026-09-02（原始價與調整價混用使股息被記成虧損）。
- **對應 AlphaView 模組**：`paper_portfolio.py`（`paper_ledger` 新事件型別，方法升 v3）、`market.py`（取 Yahoo 的 Dividends／Splits，同一供應者、同樣驗證）、`paper_next_open.py`（以事件驅動取代硬阻擋）、`paper_analytics.py`（NAV 口徑）。
- **工程量**：L　**價值** 4.5 × **可行** 3.0 = **13.50**
- **授權與限制**：Yahoo 公司行動資料品質須以調整因子交叉驗證；特別股息、分拆、併購現金補償先列 unsupported。工程量大，但屬正確性閘門而非加分項。
- **驗收提示**：合成 2:1 拆股與現金股息：股數、現金、NAV 連續且冪等，重送同一事件不重複入帳。

### G11. LLM 輸出治理（數字溯源閘、review_required、回放遮罩、run receipt）

- **是什麼**：(a) 數字溯源閘：模型文字中的每個數值必須對得上程式提供的事實，否則剔除並標記；(b) 無法解析的輸出 → `review_required`，不得當作 hold 或通過；(c) 歷史回放（`alpha_replay.py`、`replay_prefix.py` 類）遮蔽代號與日期以降低模型記憶洩漏；(d) 保存 prompt hash、模型 id、溫度／種子與決策 trace 以便重放。
- **為什麼重要**：本機 Ollama 複核雖是可選的建議，仍需防止捏造數字進入報告（原則 1）。三個專案各自提供了一塊拼圖，且 ai-hedge-fund 自承遮蔽只降低、不消除洩漏。
- **誰做得最好（可查證來源）**：
  - HKUDS/Vibe-Trading：`agent/src/agent/grounding/*`——模型為每個數字宣告角色（observed、derived、proposed、cited、count），閘門對照工具證據並剔除未通過的數字。
  - TauricResearch/TradingAgents：`tradingagents/agents/rating.py`——無法解析的輸出成為 `REVIEW`，絕不當作 Hold。
  - virattt/ai-hedge-fund：README——回測遮蔽 ticker、產業與日期，並承認這只是降低、不是消除記憶洩漏。
- **對應 AlphaView 模組**：`local_agent.py`（`local_agent_runs` 增欄位）、`jev_decision.py`（已是「事實進、機率出、程式判閾值」，補 `review_required` 語意）、`portfolio_agent.py`（報告文字）。
- **工程量**：M　**價值** 3.0 × **可行** 4.5 = **13.50**
- **授權與限制**：閘門只能剔除可偵測的數字，不能保證文字無誤；遮蔽只降低洩漏。三者皆為 MIT／Apache-2.0，概念可用。
- **驗收提示**：含捏造數字的模型輸出被剔除並留下稽核紀錄；不可解析輸出不會進入提案。

### G12. Broker paper-adapter 協定與委託狀態機（需使用者新授權）

- **是什麼**：將 `execution_dry_run.py` 的合成 reducer（submit／cancel／status／fill／reconcile，request_id／event_id／execution_id 去重）升級為 adapter 介面，兩種實作：本機模擬（既有）與 Alpaca Paper（寫入）；每筆委託須使用者明確核准，並受 per-order 名目上限、速率限制與 kill switch 約束，與 `alpaca_paper.py` 的唯讀快照對帳。
- **為什麼重要**：這是「自動調倉」的最後一哩，也最容易出大錯。Nautilus 把 RiskEngine 放在必經路徑並有啟動對帳；ai-hedge-fund 要求完整成交或拋例外；Vibe-Trading 以 fail-closed 閘門包住 place_order；OpenAlice 讓 agent 只能提案、人工才能送出。
- **誰做得最好（可查證來源）**：
  - nautechsystems/nautilus_trader：`crates/risk/src/engine/config.rs`（`bypass`、`max_order_submit`／`max_order_modify` 速率限制預設每秒 100 次、`max_notional_per_order`）、`crates/live/src/execution/reconciliation.rs`、`crates/adapters/sandbox`；下單路徑 Strategy → RiskEngine → ExecutionEngine → ExecutionClient（LGPL-3.0）。
  - virattt/ai-hedge-fund：`hedge_fund/brokers/protocol.py`（`place_order` 完整成交或拋例外）。
  - HKUDS/Vibe-Trading：`agent/src/live/sdk_order_gate.py` 以 fail-closed 閘門包住含 alpaca 的 direct-SDK 連接器。
  - TraderAlice/OpenAlice：「Trading as Git」——agent 只能 stage 並 commit 理由，人工核准才 push（AGPL-3.0）。
- **對應 AlphaView 模組**：`execution_dry_run.py` → `broker_adapter.py`（`alphaview-broker-adapter-v1`）；`alpaca_paper.py`（固定 paper host）；`paper_next_open.py`（佇列）；kill switch 與斷路器為前置條件；永遠 paper host，實盤另議。
- **工程量**：L　**價值** 5.0 × **可行** 2.0 = **10.00**
- **授權與限制**：目前政策禁止：Alpaca 僅唯讀、不含下單或撤單，必須由使用者另行明確授權才可開工。OpenAlice 為 AGPL-3.0、Nautilus 為 LGPL-3.0，僅取設計。
- **驗收提示**：（授權後）重送同一 client_order_id 不產生第二筆委託；本機與券商狀態不一致時 reconcile 報告差異並停止，不自動修正。

## 6. 不建議導入的部分（含原因）

| # | 項目（來源） | 為什麼不導入 |
| ---: | --- | --- |
| 1 | **複製 GPL／AGPL／LGPL／Commons Clause 程式碼**：freqtrade、backtrader、Lumibot（GPL-3.0）；backtesting.py、OpenAlice、Fincept 開源版（AGPL-3.0）；Nautilus（LGPL-3.0）；vectorbt、pybroker（Apache-2.0＋Commons Clause）；TradingAgents-CN 的專有層 | 授權傳染或禁止銷售，AlphaView 也不應新增這些依賴。只取概念與公開演算法，自行依 AlphaView 的風格與方法版本實作。AI-Trader、dexter、Stockagent 沒有 LICENSE 檔，預設保留所有權利，不可重用。即使是 MIT／Apache-2.0 的專案（TradingAgents、ai-hedge-fund、Vibe-Trading、Lean、qlib、vnpy），也因架構與資料語意不同而只取概念。 |
| 2 | **加密貨幣交易所、造市與高頻**：ccxt、hummingbot、jesse、freqtrade 的交易所層、Nautilus 的 Rust 核心與 adapters | 與美股日線、單人、本機的範圍無關，只增加供應鏈與攻擊面。ccxt 只是交易所連線函式庫。 |
| 3 | **強化學習與深度學習 alpha**：FinRL、qlib 模型庫、vnpy.alpha 的 ML、Kronos | 需要新的運算與資料、過擬合風險高、難以版本化與解釋；qlib README 也說官方資料集暫停、需靠社群資料。在 G2 驗證閘存在之前，不該引入更多可調參數。 |
| 4 | **讓 LLM 辯論 persona 成為決策權威**：TradingAgents、ai-hedge-fund、AutoHedge | TradingAgents 的 README 自承輸出非決定性、不保證重現；ai-hedge-fund 自承回測遮蔽只能降低記憶洩漏。AlphaView 應維持「LLM 只建議、程式閘門決定」。 |
| 5 | **付費或外部資料與服務**：Financial Datasets API、Alpha Vantage、StockTwits／Reddit 情緒、QVeris、Polygon 等 | 違反「不新增資料供應者、批次不呼叫付費 API」；任何第二資料源先依 `docs/data-provider-evaluation.md` 的授權與驗收條件評估。Jev 目前是既有例外（每次執行一次有界 POST），不擴大用途。 |
| 6 | **推播與通知**：Telegram、Feishu、企業微信、Email、Discord、Slack（freqtrade、daily_stock_analysis、Vibe-Trading） | 違反「沒有 Email／推播伺服器」。 |
| 7 | **券商實盤連線與 MCP 下單**：Vibe-Trading 的 MT5／eToro／direct-SDK、Lumibot 12 個券商、OpenAlice 的 Unified Trading Account、hummingbot | 實盤禁止。唯一候選是 G12，且限 Alpaca Paper 固定 host、需要使用者新授權。 |
| 8 | **社群、跟單與聲望機制**：AI-Trader | 多使用者託管服務，與單人本機不同，授權也不明。 |
| 9 | **整套引擎替換**：Lean（C#／.NET）、Nautilus（Rust）、vnpy（中國市場 Gateway） | 重寫成本遠大於收益；AlphaView 的價值在本機、可稽核、版本化的日線研究。只借契約：五模型分層、必經路徑的 RiskEngine、啟動對帳。 |
| 10 | **自然語言生成策略程式並直接執行**：Vibe-Trading 的 generated backtest code 以本機 subprocess 執行 | 執行生成碼的風險高：該專案自己需要外部安全稽核（10 項發現）並預設關閉 shell 工具。AlphaView 維持宣告式策略預設組與 Pine Script 匯出。 |
| 11 | **Shadow Account**（匯入真實交易紀錄做行為診斷）：Vibe-Trading | 需要私人交易紀錄與匯入格式；`CLAUDE.md` 原則 6 要求私人資料隔離。等有明確的本機交易帳本與隔離設計再評估。 |
| 12 | **暫緩而非拒絕**：MCP 伺服器（Vibe-Trading、OpenBB、jesse）、財報與事件日曆過濾（earnings blackout）、多資產／放空／槓桿／選擇權 | MCP 價值中等但增加攻擊面（Vibe-Trading 需 `API_AUTH_KEY` 並預設關閉 shell 工具），應在 G11 與 G7 之後再評估，且限唯讀加提案；事件日曆需可靠資料源，須先走資料供應者評估；其餘超出目前長多、日線、美股範圍。 |
| 13 | **把 star 當品質證據** | star 只衡量關注度。例如 Vibe-Trading 半年達 34,388 stars，但其 changelog 顯示資料與回測正確性問題仍在密集修補；TradingAgents 的 README 自承是研究鷹架而非有固定報酬的策略。 |

## 7. 來源連結

**查核限制與未驗證項目（先讀這段）**

- **star 數**：本文所有 star 數都在 UTC 2026-09-30 23:13:41–23:14:34 由 GitHub API 驗證（63 個 repo，零失敗），沒有「無法驗證」的 star 數。「較 09-20」欄的舊值取自 `docs/github-agent-portfolio-benchmark-2026-09-20.md`，本次未重新驗證。star 會隨時間變動。
- **授權**：rqalpha、StockSharp 的 API 值為 NOASSERTION，本次未逐條查核；其餘見第 2 節表格。
- **功能與績效**：沒有安裝或執行任何競品；FinRL-X、TradingAgents、Vibe-Trading 等 README 中的績效或能力宣稱**全部未驗證**。
- **文件深度**：Vibe-Trading README（約 350 KB）只讀章節與關鍵段落；Lean、Nautilus、vnpy、qlib 僅依 README、檔案樹與少量原始碼；矩陣中標 **？** 的格子是本次未查核，不是「沒有」。
- **AlphaView 基線**：關鍵字搜尋加關鍵模組閱讀，不是逐行審計；實作前需要再確認。
- **子代理**：前次平行研究的子代理成果一律不採用。

**倉庫（GitHub，皆以 `blob/HEAD` 指向預設分支）**

- TradingAgents：<https://github.com/TauricResearch/TradingAgents>、[README](https://github.com/TauricResearch/TradingAgents/blob/HEAD/README.md)、[memory/settlement.py](https://github.com/TauricResearch/TradingAgents/blob/HEAD/tradingagents/memory/settlement.py)、[agents/rating.py](https://github.com/TauricResearch/TradingAgents/blob/HEAD/tradingagents/agents/rating.py)
- ai-hedge-fund：<https://github.com/virattt/ai-hedge-fund>、[ROADMAP](https://github.com/virattt/ai-hedge-fund/blob/HEAD/ROADMAP.md)、[VISION](https://github.com/virattt/ai-hedge-fund/blob/HEAD/VISION.md)、[risk/limits.py](https://github.com/virattt/ai-hedge-fund/blob/HEAD/hedge_fund/risk/limits.py)、[brokers/protocol.py](https://github.com/virattt/ai-hedge-fund/blob/HEAD/hedge_fund/brokers/protocol.py)、[pipeline/execution.py](https://github.com/virattt/ai-hedge-fund/blob/HEAD/hedge_fund/pipeline/execution.py)、[portfolio/validation.py](https://github.com/virattt/ai-hedge-fund/blob/HEAD/hedge_fund/portfolio/validation.py)
- freqtrade：<https://github.com/freqtrade/freqtrade>、[protections](https://github.com/freqtrade/freqtrade/blob/HEAD/docs/includes/protections.md)、[lookahead-analysis](https://github.com/freqtrade/freqtrade/blob/HEAD/docs/lookahead-analysis.md)、[recursive-analysis](https://github.com/freqtrade/freqtrade/blob/HEAD/docs/recursive-analysis.md)、[stoploss](https://github.com/freqtrade/freqtrade/blob/HEAD/docs/stoploss.md)
- qlib：<https://github.com/microsoft/qlib>、[backtest/exchange.py](https://github.com/microsoft/qlib/blob/HEAD/qlib/backtest/exchange.py)、[data/pit.py](https://github.com/microsoft/qlib/blob/HEAD/qlib/data/pit.py)；RD-Agent：<https://github.com/microsoft/RD-Agent>
- vnpy：<https://github.com/vnpy/vnpy>、[README](https://github.com/vnpy/vnpy/blob/HEAD/README.md)
- Vibe-Trading：<https://github.com/HKUDS/Vibe-Trading>、[sdk_order_gate.py](https://github.com/HKUDS/Vibe-Trading/blob/HEAD/agent/src/live/sdk_order_gate.py)、[grounding/](https://github.com/HKUDS/Vibe-Trading/tree/HEAD/agent/src/agent/grounding)、[crossvalidation.py](https://github.com/HKUDS/Vibe-Trading/blob/HEAD/agent/src/quantlib/crossvalidation.py)
- NautilusTrader：<https://github.com/nautechsystems/nautilus_trader>、[RiskEngineConfig](https://github.com/nautechsystems/nautilus_trader/blob/HEAD/crates/risk/src/engine/config.rs)、[reconciliation.rs](https://github.com/nautechsystems/nautilus_trader/blob/HEAD/crates/live/src/execution/reconciliation.rs)、[live.md](https://github.com/nautechsystems/nautilus_trader/blob/HEAD/docs/concepts/live.md)、[fill-models.md](https://github.com/nautechsystems/nautilus_trader/blob/HEAD/docs/concepts/backtesting/fill-models.md)
- Lean：<https://github.com/QuantConnect/Lean>、[Risk 模型](https://github.com/QuantConnect/Lean/tree/HEAD/Algorithm.Framework/Risk)、[Portfolio 模型](https://github.com/QuantConnect/Lean/tree/HEAD/Algorithm.Framework/Portfolio)、[Execution 模型](https://github.com/QuantConnect/Lean/tree/HEAD/Algorithm.Framework/Execution)、[Slippage](https://github.com/QuantConnect/Lean/tree/HEAD/Common/Orders/Slippage)、[InsightScore](https://github.com/QuantConnect/Lean/blob/HEAD/Common/Algorithm/Framework/Alphas/InsightScore.cs)、[Split](https://github.com/QuantConnect/Lean/blob/HEAD/Common/Data/Market/Split.cs)、[PaperBrokerage](https://github.com/QuantConnect/Lean/blob/HEAD/Brokerages/Paper/PaperBrokerage.cs)
- OpenBB（API 目前解析為 <https://github.com/openbq-org/OpenBB>，見第 2 節）：<https://github.com/OpenBB-finance/OpenBB>、[LICENSE](https://github.com/OpenBB-finance/OpenBB/blob/HEAD/LICENSE)、[授權變更 commit bbf1ab20](https://github.com/OpenBB-finance/OpenBB/commit/bbf1ab20)
- 其他：[QuantDinger](https://github.com/OpenByteInc/QuantDinger)、[OpenAlice](https://github.com/TraderAlice/OpenAlice)、[FinRL-Trading](https://github.com/AI4Finance-Foundation/FinRL-Trading)、[FinRL](https://github.com/AI4Finance-Foundation/FinRL)、[Lumibot](https://github.com/Lumiwealth/lumibot)、[daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis)、[AI-Trader](https://github.com/HKUDS/AI-Trader)、[dexter](https://github.com/virattt/dexter)、[ALTA](https://github.com/kyky2347/ALTA)、[hummingbot](https://github.com/hummingbot/hummingbot)、[jesse](https://github.com/jesse-ai/jesse)、[backtrader](https://github.com/mementum/backtrader)、[vectorbt](https://github.com/polakowo/vectorbt)（[LICENSE.md](https://github.com/polakowo/vectorbt/blob/HEAD/LICENSE.md)）、[backtesting.py](https://github.com/kernc/backtesting.py)、[pybroker](https://github.com/edtechre/pybroker)、[quantstats](https://github.com/ranaroussi/quantstats)、[ccxt](https://github.com/ccxt/ccxt)、[TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN)、[Fincept](https://github.com/Fincept-Corporation/FinceptTerminal)、[FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading)、[StockAgent](https://github.com/MingyuJ666/Stockagent)、[Backtesting-Engine（Research Desk）](https://github.com/Miles-Deutscher/Backtesting-Engine)、[PyPortfolioOpt](https://github.com/PyPortfolio/PyPortfolioOpt)、[Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib)、[skfolio](https://github.com/skfolio/skfolio)

**GitHub API 端點（唯讀）**：`https://api.github.com/repos/{owner}/{repo}`（stars、授權、建立與 push 時間）、`/repos/{owner}/{repo}/license`、`/repos/{owner}/{repo}/readme`、`/repos/{owner}/{repo}/contents/{path}`、`/repos/{owner}/{repo}/git/trees/HEAD?recursive=1`、`/repos/OpenBB-finance/OpenBB/commits?path=LICENSE`、`/search/repositories`（11 組查詢見第 1 節）。

**AlphaView 內部依據**：`CLAUDE.md`、`docs/github-agent-portfolio-benchmark-2026-09-20.md`、`docs/research-desk.md`、`docs/local-execution-adapter.md`、`docs/rebalance-triggers.md`、`docs/paper-replay-design.md`、`docs/agent-portfolio.md`（後三者僅讀標題）；模組 `alphaview/panel/{circuit_breakers,rebalance_trigger,portfolio_agent,paper_next_open,paper_portfolio,paper_scenarios,paper_analytics,jev_decision,agent_automation,market_regime,research_desk,store}.py`。

**機器可讀摘要**：`artifacts/harness-2026-10-01-trading-agent/benchmark.json`（僅含公開的彙總事實，不含任何私人資料）。
