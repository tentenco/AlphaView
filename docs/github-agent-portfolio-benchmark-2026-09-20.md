# AlphaView：GitHub Agent 與 Portfolio 功能對標

研究日期：2026-09-20。GitHub API 查核區間為 02:44:53–02:48:21 UTC（臺灣 10:44:53–10:48:21）。方法版本：`alphaview-github-benchmark-v1`。此文件是本輪 Harness 的設計輸入；不是已交付功能清單。實際交付以本輪本機 review 與驗收紀錄為準。

最值得導入的是一條完整的本機路徑：**組合政策 → 目標配置 → 調倉預覽 → 風險關卡 → Agent 提案 → Paper 帳本 → 決策歷程**。AlphaView 已有選股、資料版本、風險與回測基礎，下一階段價值在於讓研究結果成為可持續追蹤的組合狀態。

## 研究方法與人氣範圍

本次查詢 GitHub 官方 REST API 的四個 topics：`trading-agents`、`algorithmic-trading`、`portfolio-management`、`quantitative-finance`，各依 stars 取前 10 筆；再用 `trading in:name,description stars:>20000 fork:false` 與 `portfolio agent in:readme stars:>30000 fork:false` 補充搜尋。加入既有候選、官方 README 指向的後繼專案，排除資源清單、通用 Agent 工具與明顯無關結果，形成 25 個候選。

下表僅將這份甄選清單依 stars 排序，**不代表全 GitHub 的全球排名**。Stars 衡量關注度，不能證明報酬、設計正確性或適合實盤。近期 `updated_at` 可能只反映 repo metadata 活動，所以同時保留 `pushed_at`；push 也不等於正式版本發布。功能查核採官方 README、ROADMAP、LICENSE 與官方架構文件，未安裝或執行競品。

原始數值、精確 UTC 時間、API URL、搜尋結果、README SHA-256 與功能優先序保存在本機 `artifacts/harness-2026-09-20-agent-portfolio/github-benchmark.json`。各 repo 的來源端點為 `https://api.github.com/repos/{owner}/{repo}`。不同請求間 stars 可能增加，表格統一使用各 repo metadata 那一次的值。

| 甄選序 | 官方 GitHub Repo | Stars | Forks | API／原文授權標示 | Metadata 更新 / 最近 push（UTC） | 類型 |
| --- | --- | ---: | ---: | --- | --- | --- |
| 1 | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 107,631 | 20,592 | Apache-2.0 | 2026-09-20 / 2026-09-18 | 多角色 LLM 投研 |
| 2 | [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB) | 73,264 | 7,579 | API: NOASSERTION；LICENSE: AGPLv3 | 2026-09-20 / 2026-09-19 | 資料供應介面 |
| 3 | [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 65,324 | 54,644 | MIT | 2026-09-20 / 2026-09-19 | 股票分析工作台 |
| 4 | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | 63,559 | 11,142 | MIT | 2026-09-20 / 2026-09-18 | Agent 基金研究 |
| 5 | [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | 54,553 | 11,310 | GPL-3.0 | 2026-09-20 / 2026-09-19 | 加密貨幣執行系統 |
| 6 | [microsoft/qlib](https://github.com/microsoft/qlib) | 48,678 | 7,703 | MIT | 2026-09-20 / 2026-09-17 | 量化研究平台 |
| 7 | [vnpy/vnpy](https://github.com/vnpy/vnpy) | 45,445 | 12,479 | MIT | 2026-09-20 / 2026-09-13 | 事件驅動交易框架 |
| 8 | [ccxt/ccxt](https://github.com/ccxt/ccxt) | 44,050 | 8,846 | MIT | 2026-09-20 / 2026-09-19 | 交易所 API 函式庫 |
| 9 | [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 33,698 | 5,501 | MIT | 2026-09-20 / 2026-09-19 | Agent 研究與組合工作區 |
| 10 | [hsliuping/TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN) | 31,890 | 6,670 | API: NOASSERTION；README: 混合授權 | 2026-09-20 / 2026-07-24 | 中文多角色投研 |
| 11 | [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 31,806 | 4,513 | API: NOASSERTION；LICENSE: AGPLv3 | 2026-09-20 / 2026-09-19 | 金融桌面終端 |
| 12 | [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | 29,144 | 3,847 | LGPL-3.0 | 2026-09-20 / 2026-09-20 | 事件驅動執行引擎 |
| 13 | [mementum/backtrader](https://github.com/mementum/backtrader) | 23,284 | 5,284 | GPL-3.0 | 2026-09-19 / 2024-08-19 | 回測函式庫 |
| 14 | [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) | 22,399 | 3,412 | API 未識別 | 2026-09-19 / 2026-06-11 | Agent 交易研究 |
| 15 | [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | 21,685 | 5,253 | Apache-2.0 | 2026-09-20 / 2026-09-18 | 演算法交易引擎 |
| 16 | [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | 21,270 | 3,014 | MIT | 2026-09-19 / 2026-09-14 | 金融語言模型 |
| 17 | [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) | 20,076 | 4,945 | Apache-2.0 | 2026-09-20 / 2026-09-18 | 加密貨幣執行框架 |
| 18 | [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot) | 18,525 | 2,601 | API/LICENSE: MIT；README 另有 CC 圖示 | 2026-09-20 / 2026-03-11 | 量化工具集合 |
| 19 | [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) | 16,450 | 2,456 | MIT | 2026-09-20 / 2026-09-19 | 投研技能工作流 |
| 20 | [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | 16,334 | 3,507 | MIT | 2026-09-20 / 2026-07-13 | 強化學習研究 |
| 21 | [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio) | 9,321 | 1,318 | AGPL-3.0 | 2026-09-20 / 2026-09-19 | 個人資產管理 |
| 22 | [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | 9,132 | 1,171 | API: NOASSERTION；Apache 2.0 + Commons Clause | 2026-09-19 / 2026-09-17 | 向量化回測 |
| 23 | [kernc/backtesting.py](https://github.com/kernc/backtesting.py) | 8,974 | 1,533 | AGPL-3.0 | 2026-09-19 / 2026-08-05 | 回測函式庫 |
| 24 | [jesse-ai/jesse](https://github.com/jesse-ai/jesse) | 8,538 | 1,239 | MIT | 2026-09-20 / 2026-09-17 | 加密貨幣策略框架 |
| 25 | [AI4Finance-Foundation/FinRL-Trading](https://github.com/AI4Finance-Foundation/FinRL-Trading) | 3,727 | 1,095 | Apache-2.0 | 2026-09-20 / 2026-09-18 | 權重導向策略與執行 |

授權表保留 API 無法識別的情況。OpenBB 與 Fincept 的 LICENSE 原文標示 AGPLv3；VectorBT 額外含 Commons Clause；TradingAgents-CN README 區分開源與專有部分；Qbot 的 LICENSE 與 README 圖示未完全一致。這些項目適合先參考設計，不能只看 repo stars 就直接複製程式。此次未引入任何競品程式碼或套件。[OpenBB LICENSE](https://github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE)、[Fincept LICENSE](https://github.com/Fincept-Corporation/FinceptTerminal/blob/main/LICENSE)、[VectorBT LICENSE](https://github.com/polakowo/vectorbt/blob/master/LICENSE.md)、[TradingAgents-CN 授權說明](https://github.com/hsliuping/TradingAgents-CN#-许可证详情)、[Qbot LICENSE](https://github.com/UFund-Me/Qbot/blob/main/LICENSE)。

## 最值得參考的設計

| 參考專案 | 官方文件可確認的能力 | 對 AlphaView 的具體用途 | 導入界線 |
| --- | --- | --- | --- |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents/blob/main/README.md) | 專業分析角色、bull/bear 討論、portfolio context、結構化決策、持久 decision log、SQLite checkpoint | 顯示每個角色的輸入、結果與阻塞原因；每次提案綁定持股／現金快照；續跑保留已完成步驟 | 多角色可以先採本機規則引擎；若沒有真的呼叫模型，介面必須寫清楚。角色共識不越過政策上限。 |
| [AI Hedge Fund](https://github.com/virattt/ai-hedge-fund/blob/main/ROADMAP.md) | Mandate、可插拔 AlphaModel／Signal、strategy pods、target weights、單次 CycleRecord；ROADMAP 明列完成與未完成 | 將策略、配置、風險、執行、帳本分層；一個 mandate 可比較多種策略而不改 UI 契約 | 文件仍將 carried book、paper broker、scheduler 列為未完成／計畫。不能把「persistent fund」願景當成成熟功能。 |
| [LEAN Algorithm Framework](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/overview) | Universe、Alpha、PortfolioTarget、Risk、Execution 各自有責任與介面 | 既有 Alpha Picks 保留為訊號層；另增 target portfolio 與風險層，避免分數直接變成訂單 | 借用模組契約，無須搬入整套 C# 引擎。 |
| [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading/blob/main/README.md) | Agent teams、持久研究記憶、run cards、Shadow Account、唯讀多券商組合快照；README 說明來源失敗會標記不完整 | 組合快照、資料來源與方法版本可追溯；「研究 → 提案 → 模擬 → 比較」放在同一工作區 | 本輪不接券商；多幣別與多帳戶留待清楚契約。Shadow Account 比較必須先有交易記錄。 |
| [Freqtrade](https://github.com/freqtrade/freqtrade/blob/develop/README.md)、[Protections](https://www.freqtrade.io/en/stable/plugins/#protections) | SQLite persistence、dry-run、策略回測；可配置 cooldown、drawdown、停止條件 | Paper account 可持續累積；手動／自動執行共用風險 gate；保留停止原因 | 加密貨幣交易所規則不能直接套美股；日線資料無法提供即時 fill 保證。 |
| [vn.py](https://github.com/vnpy/vnpy/blob/master/README.md) | Event engine、獨立 paper account、portfolio manager、risk manager、gateway | 將 order、fill、position、cash 事件分開；保留紙上成交與組合更新的因果鏈 | 先使用本機 adapter；不安裝 gateway、不開啟實盤連線。 |
| [Ghostfolio](https://github.com/ghostfolio/ghostfolio/blob/main/README.md) | 交易 CRUD／匯入匯出、多帳戶、組合風險與 ROAI 績效 | Portfolio 頁由靜態持股延伸為明確交易與現金流帳本；帳本成為績效來源 | 不從當前成本倒推歷史交易；ROAI、TWR、MWR 不是同一口徑。 |
| [FinRL-X](https://github.com/AI4Finance-Foundation/FinRL-Trading/blob/master/README.md) | 以 target weight vector 串起選股、配置、時機、風險；支援多種 allocator 與 paper／live 路徑 | 先建立共同權重契約，日後再增加等權、波動度或其他 allocator；用同一輸出比較策略 | 不必先訓練 RL。原 FinRL README 已將新架構指向此 repo，應區分後繼與原研究專案。 |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader/blob/develop/README.md) | deterministic event-driven runtime、正規化 domain model、相同研究／執行語意、adapter | Paper fill 與未來 broker fill 使用共同狀態模型，先把重試與事件身份定義好 | 不為日線單人工作區重建高頻引擎；不在本輪引入 Rust 依賴。 |
| [OpenBB](https://github.com/OpenBB-finance/OpenBB/blob/develop/README.md) | Open Data Platform 將資料供應接口提供給 Python、REST、MCP 與工作台 | 以一致 schema 表達來源、時點、coverage、缺值原因，未來再加供應者 | 開源 ODP 與商業 Workspace 不同；免費 repo 不代表所有資料免費。 |
| [Qlib](https://github.com/microsoft/qlib/blob/main/README.md) | data → model → portfolio → backtest 的研究鏈；自動研究 workflow 與模型比較 | 提案與策略版本應可重跑、可比較；保存每輪輸入與結果以支持後續研究 | 現在不需要擴成 ML 平台；未完成歷史成分／點時資料前，不宣稱無偏差全市場研究。 |

[daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis/blob/main/README.md) 的手動分析、任務進度、歷史報告與持股工作台值得借用資訊架構；其推播、多來源、15 種策略不是本輪必須全部導入。[Fincept](https://github.com/Fincept-Corporation/FinceptTerminal/blob/main/README.md) 可參考模組工作台與 paper trading，但官方明確區分免費版本與 Enterprise，不能將商業版的即時執行與控制功能全部算入開源成果。CCXT、Hummingbot、Jesse 偏加密貨幣執行；FinGPT、FinRL 偏模型研究；Backtrader、VectorBT、Backtesting.py 偏回測，故此次不以它們取代 AlphaView 現有產品架構。

## AlphaView 開工基線與缺口

基線依 `CLAUDE.md`、09-16 handoff，以及本輪開始時的 `store.py`、`api.py`、`App.tsx` 檢查。以下描述是**開發前狀態**，不是 Harness 結束時狀態。

| 工作流程 | 開工已有 | 本輪高價值增量 |
| --- | --- | --- |
| 研究產生 | 四策略、Alpha 排序、風險溫度計、候選持倉相關性 | 把研究 evidence 串成組合提案與角色步驟 |
| 組合現況 | 持股數量／成本、當前估值、集中度 | 明確現金、目標配置、漂移、調倉預覽 |
| 風險與政策 | 描述性風險研究與資料 coverage | 可配置的組合限制與逐條阻塞原因 |
| 模擬與績效 | 單股回測、Alpha replay／basket 實驗 | 跨多次執行持續累積的 paper account／NAV |
| 作業與追溯 | jobs、scheduler、snapshot、input revision、方法版本 | Agent run receipt、提案失效判定、paper order／fill 身份 |
| 使用者控制 | 本機單人、draft 保留、寫入衝突保護 | review → 明確 paper 執行 → 暫停／停止的主路徑 |

## 8 個高價值功能與導入順序

下面的價值、成本與排序是針對 AlphaView 現況的工程判斷，不是競品作者的主張。S／M／L 只表示相對工程量，不是工時承諾。

| 順序 | 功能 | 使用者可看到的結果 | 主要依賴 | 工程量 |
| --- | --- | --- | --- | --- |
| P1 | **版本化組合政策與目標配置** | 儲存 long-only／USD mandate：現金下限、單股上限、最大換手、最小成交額、允許標的及目標權重 | 既有本機 store／revision | M |
| P2 | **漂移與調倉預覽** | Current／target weights、drift、股數差額、整股／碎股政策、估計成本與剩餘現金 | P1＋可用價格 | M |
| P3 | **獨立風險關卡** | 每條政策的 pass／block／unavailable；持股、價格或政策改變時，舊提案失效 | P1、P2 | M |
| P4 | **具角色與證據的本機 Agent 工作流** | Data → Research → Portfolio → Risk → Review；每個角色的狀態、理由、來源與阻塞原因 | P1–P3 | M |
| P5 | **獨立 paper 帳戶與帳本** | 紙上現金、持股、orders、fills 可跨重啟延續；提案只執行一次，保留方法版本與費用 | P3、P4 | L |
| P6 | **決策歷程與 receipt** | 重看 run、policy、input revision、價格日、提案 hash、風險結論與 paper 結果；可重試／續跑 | P4；P5 擴展 fill 紀錄 | M |
| P7 | **本機 cadence、暫停與停止** | 每個完成交易日產生一次提案；顯示下次執行、halt reason；啟用 paper 自動執行需有明確模式 | P5、P6 | M |
| P8 | **Paper NAV 與策略對照** | 看紙上淨值、coverage、成本、換手及不同政策的結果；同一日期／同一資料的基準可比較 | P5、P6 | M |

第一波應完成 P1–P4 與 P6 的提案紀錄，形成「可產生、可解釋、可保存」的操作路徑。第二波接 P5，將提案變成可持續模擬的狀態。第三波才開 P7–P8。這樣每波都有可用功能；任何未完成步驟都要在 review 中保持未完成，不以文件或靜態按鈕代替實作。

### 應共用的資料契約

```text
PortfolioSnapshot
  ├─ positions / cash / valuation_as_of / coverage / input_revision
  └─ Policy(version, limits, allowed_symbols, cadence)
       ↓
ResearchEvidence(role, status, sources, engine_version)
       ↓
TargetPortfolio(weights + explicit cash weight)
       ↓
RebalancePlan(plan_id, input_hash, policy_version, proposed_deltas, cost_model)
       ↓
RiskVerdict(checks, blockers, warnings)
       ↓
PaperOrders → PaperFills → PaperLedger → NAVSnapshot
       └─ RunReceipt retains each stage and the relevant method versions
```

目標權重不等於成交權重。整股取整、費用、價格變動會產生剩餘現金；畫面應直接顯示。缺價、缺持股來源或缺啟用的必要因子時，結果保持不完整，不能把缺的權重挪給其他標的。現有 Alpha 分數是規則共識，不應自動被解釋為預期報酬或投資權重。

LLM 可以產生提案理由、整理證據或提出候選配置；數值轉換、額度、現金、訂單狀態與執行資格應由確定性的程式判定。第一版若只有規則角色，名稱應明示 `local-rule` 或等義說明；不能顯示成已連接模型的自主 Agent。

Paper fill 應明確標記採用的資料時點與成交假設。沿用日線研究可使用下一完成交易日的未調整開盤價與明確費用模型；尚無該日資料則保持 pending。若產品選擇「最新已完成收盤價的即時紙上情境」方法，應使用獨立方法版本，不能把它報成真實市場成交或既有次日開盤回測績效。

## 本輪與下輪的分界

本輪功能可完全使用本機資料與 deterministic paper adapter，不需要付費模型、外部通知、券商憑證或實盤訂單。使用者的最終方向是 Agent 調倉交易；此次對標提供通往該方向的產品分層，不自行更改專案禁止實盤外部動作的規則。

下一輪 review 應依實際完成狀態挑選以下最小工作單位：

1. 若已完成預覽但未完成帳本：先交付完整 paper account、原子 fill、現金核對與重試去重。
2. 若已有 paper 帳本：接一條收盤 cadence，保存相同政策下的連續 NAV；缺行情停止並保留原因。
3. 若已有持續 paper 執行：增加固定配置與 Agent 配置的同期間比較，保留交易成本與 coverage。
4. 若需要真正的語言模型：先加入明確 provider adapter、結構化輸出與來源引用；採用本機模型需使用者既有環境可用，不能偷偷切換到付費供應者。
5. 後續券商方向：先定義唯讀帳戶契約與 reconciliation，再評估獨立 sandbox adapter。實盤寫入、憑證設定及交易授權另行決定。

驗收只涵蓋新功能會改變的現金、持倉、訂單、提案與使用路徑，並在最後統一跑專案既定關卡。無需重複已通過的全面檢查；也不能因為偏重新增功能而省略會造成錯誤現金或重複 paper fills 的必要驗證。

## 查核限制

沒有驗證任何競品宣稱的投資報酬、模型能力或實盤穩定性；沒有將 README 願景視為已驗收行為。沒有開啟或輸出私人持股、成本、筆記或真實備份。研究只新增本文件與本機 JSON，沒有改動產品、資料庫、排程或外部帳戶。
