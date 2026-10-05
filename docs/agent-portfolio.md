# Agent 投資組合：本機模擬與可追溯工作流

2026-09-29 更新。入口為 `#agent-portfolio`。這個工作區把研究結果接到獨立的虛擬帳戶：研究角色產生目標權重，帳戶風險限制決定是否能模擬，執行結果保存到本機帳本。它不連券商、不持有實盤憑證，也不改動「我的持股」中的真實數量與成本。

## 從第一個帳戶開始

1. 在 **Agent 投資組合** 建立帳戶，輸入名稱與初始虛擬現金。帳戶以 USD 計價，不從現有持股倒推或複製歷史交易。
2. 設定單股權重上限、總換手上限與現金下限。費用、滑價、股數精度與最小變動金額是獨立的執行設定。
3. 在 **配置與提案** 每行輸入一個代碼與百分比，先預覽，再保存提案。目標代表完整組合：未列出的既有虛擬持倉目標為零；未配置的比例保留現金。
4. 檢查價格覆蓋、每筆股數、成本、現金餘額及限制原因。保存不會更新持倉；勾選接受說明並按 **接受並模擬執行**，才會原子地更新持倉與現金帳本。
5. 到 **持倉與帳本** 查看結果，或下載完整帳本 CSV、帳戶 JSON、單一提案決策收據。下載內容可能包含使用者的虛擬組合，請視同本機私人資料。

同一執行請求的重試只記帳一次。行情、交易日、帳戶設定或方法版本改變時，舊提案仍可閱讀，但不能直接執行。暫停開關會阻止手動及自動模擬；解除暫停也會產生新的帳戶版本，需重新預覽。

## Agent 角色與配置規則

規則工作流是可重現的本機引擎，獨立於下方可選的本機模型分析。四個角色依序保存自己的輸入證據與結果：

| 角色 | 責任 |
| --- | --- |
| 研究分析 | 驗證最新完成交易日的選股快照、引擎／輸入版本、股票池與每個啟用策略 |
| 配置規劃 | 以固定策略權重計算共識，依分數、符合數與代碼排序 |
| 風險審閱 | 檢查配置上限、現金緩衝與證據完整性 |
| 組合提案 | 保存完整目標權重、現金比例、來源與指紋；交給獨立 paper 風險層再驗算 |

四策略權重必須合計 100。分數是符合策略的權重總和，不是報酬預測。任一啟用策略不可用時，候選分數保持不可用，不把缺失權重分給其他策略。

每個配置槽位的權重為：`min((100 − 現金緩衝) / 最大標的數, 單股上限)`，向下保留八位小數。候選不足時，其他標的的權重不增加，空槽保留現金。完整資料卻沒有合格候選時，工作流保存為 blocked，不產生清空帳戶的目標。

已保存工作流可再次開啟，查看逐候選理由、角色 trace、價格日期與來源版本。以該工作流建立 paper 提案前，會再次驗證來源，再由帳戶層檢查完整持倉、現金、成本與限制。

## 可選的本機模型分析

**本機模型分析** 可將當期有效的規則工作流交給已安裝且停用雲端的 Ollama 模型。一次本機推論提供研究、配置與風險三種觀點，並列出每個判斷所引用的事實。分析模式保留原配置；保守模式只能保留、減半或排除原固定槽位，釋出比例留在現金。程式拒絕不存在的引用、標的或數值，沒有通過驗證的結果保持 blocked。

工作流保存真實進度、取消狀態、模型與來源指紋、prompt/schema版本；推論時不占用資料庫寫入 transaction。模型不讀取真實持股／成本／筆記，也沒有交易工具。保存 paper 提案後仍走同一套帳戶限制與明確接受。設定與方法見 [本機模型分析](local-agent.md)。

## 本機自動化任務

2026-10-01 補充：調倉門檻可加 `regime_change`（市場風險 band 變動階數，分數不完整則等待）；暫停帳戶在純減倉例外下，自動化只會把目標夾到不高於現有權重（減碼）或略過，不會新建倉；任務授權有到期日與重新授權（見 [授權生命週期](mandate-lifecycle.md)）。每次嘗試結果附 `outcome_warning`（決策結果帳本 10 日命中率），命中率過低時提案理由加警示，不阻擋。

在 **自動化任務** 選擇已保存工作流，將規則保存為具名稱與版本的任務。可追蹤固定候選清單，或每天從當期完整選股池重新挑選。動態模式沿用已存的策略權重與門檻，不會重用舊日候選名單。初始排程關閉；同一帳戶最多只能有一個啟用任務。

- **只產生提案**：每個最新完成交易日保存一次待審閱提案，使用者另行接受。
- **自動模擬**：使用者明確選擇後，排程可在通過全部限制時更新獨立虛擬帳戶。手動執行預設仍只產生提案；需再勾選本次允許模擬。
- **Jev 決策閘**（2026-10-01）：任務可啟用 `jev_gate {enabled, pass_threshold, max_risk_probability}`。規則工作流保存後、建立提案前，先以該工作流為來源執行一次 Jev 決策（付費呼叫），通過的標的保留席位、未通過歸零保留現金；沒有標的通過、回應未通過驗證或未設定 Jev 連線時本輪 `blocked`，不退回未過濾目標。證據（決策 run、政策、計數、目標）存在嘗試紀錄，提案接受時會再經 `jev_decision.validate_source` 重驗。
- **自動執行目標**（2026-10-01）：自動模式的任務可把 `execution_target` 設為 `alpaca_paper`，通過全部限制與風險斷路器後改送 Alpaca Paper 市價 DAY 委託（需先在交易代理分頁以確認字串啟用委託）；成交不回寫本機帳本，由背景核對迴圈更新狀態。預設仍為本機模擬帳本。

本機伺服器每 60 秒檢查一次，使用 XNYS 收盤後 15 分鐘的最新完成交易日。關機或休眠後只考慮最新交易日，不補跑中間日期。此排程不抓取行情；資料更新沿用既有資料管理功能。

來源尚未完整、快照過期或帳戶暫停時，任務等待，不消耗當日嘗試。完整研究沒有合格候選、風險限制阻塞、已取得執行權後失敗或中斷，均保留一次嘗試；同交易日不自動重試。改名、改規則或啟停不會重設當日次數。

SQLite 唯一索引與工作區鎖限制重複執行。任務版本與停止狀態會在 paper 寫入交易內重驗；已保存的自動化提案也綁定任務版本。中斷恢復只核對已保存收據，不猜測是否應再成交一次。

每份提案的 API 回傳附 `provenance {source, tags}`（由保存證據推導，不存入預覽；見 [提案來源](proposal-provenance.md)），前端提案檢閱有「為什麼是這份提案」。

## 模擬價格、成本與績效

`alphaview-paper-portfolio-v2` 只使用本地最新已完成交易日、確認為 USD 的有效未調整收盤價。買入模擬價為參考價乘以 `1 + slippage_bps/10000`，賣出為 `1 − slippage_bps/10000`；每筆再依模擬名目金額計費。買入成本包含費用，售出已實現損益扣除費用；採移動平均成本。

股數向下取指定精度，零位為整股；金額保留八位小數。小於最小變動金額的動作會列為 skipped，保留原持倉。完成取整、跳過與扣費後，仍檢查實際配置與現金限制。現金不足不會自動縮單或重新分配權重。

總換手是買賣參考名目金額合計除以模擬前淨值，完整換出再換入可能接近 200%；不是單邊換手。紙上參考價不等於可成交價格。此模組不建模稅務、股息、拆併股、成交量／流動性或盤中路徑，也不是既有次日開盤回測。

`alphaview-paper-analytics-v1` 的每日淨值來自顯式擷取或任務完成時擷取的帳戶快照，不從目前持倉倒推歷史。每筆快照不可覆寫，同日序列採最後擷取；缺價與未擷取日期留空。日報酬只連接相鄰且完整的交易日；觀察區間有缺口時，區間報酬與最大回落保持不可用。最大回落是相對此前已觀測最高淨值的最大非負跌幅。

帳戶目前只有初始虛擬現金，沒有後續外部資金流；累計報酬為完整淨值除以初始現金減一。費用、滑價及各次換手率加總是帳戶建立以來的累積值，不是年化值，也不受畫面觀察窗口篩選影響。

`alphaview-paper-metrics-v1`（2026-10-01 對標 quantstats／qlib 風險報表新增）在同一份淨值報告附上進階指標，只從完整且相鄰的每日觀測推導：年化報酬與波動（252 交易日、無風險利率 0）、Sharpe、Sortino（以 0 為目標的下方偏差）、Calmar、最長水下期間、目前回落；基準相對指標（預設 SPY，可用 `?benchmark=` 改成股池內其他標的）採同區間本機未調整收盤的價格報酬，任一日缺基準價則整個基準區塊不可用；成本區塊列出累計成本占初始資金的拖累與淨／毛累計報酬。日報酬少於 20 筆標示 `low_sample`；每個空值附原因碼，不顯示 0。快照的引擎版本不變，舊觀測不需重算。

## 配置情境與帳戶比較

**情境比較** 在同一份帳戶／行情快照內，將目前持倉與最多五個完整目標方案並列。先按既定成本與交易精度模擬配置，再套用使用者填寫的全體價格震盪；個股震盪覆寫全體假設。全現金方案需明確選擇。未通過 paper 限制的方案保持 blocked，不計算假裝已成功調倉的情境。

畫面分別列出執行成本、震盪損益及包含成本的總變動，並檢查情境前後的集中度與現金比例。這是單次假設價格變動，不是概率、VaR、未來價格預測或交易策略回測。方法為 `alphaview-paper-scenarios-v1`。

**帳戶比較** 接受 2–5 個虛擬帳戶與使用者明確指定的相同起訖交易日。只有全部帳戶都在指定起點有完整正淨值，才建立共同基準 100。期間任何日期未擷取、缺價格或方法不支援都保留缺口，不能移動起點、補值或從今日持倉倒推過去。任一帳戶區間不完整時，不產生跨帳戶報酬差異。方法為 `alphaview-paper-nav-comparison-v1`。

**所有帳戶待辦** 集中顯示未結案提案與任務狀態，明確區分來源過期、暫停與限制受阻。總數取完整資料，清單分頁。點選提案回到帳戶逐筆檢閱；沒有批次接受或自動啟用。next-open 委託有獨立分頁，重複等待按委託合併但保留完整嘗試次數；可跳至精確委託、重查／取消及完成收據。重新載入會取回指定物件的最新狀態，包含已離開目前清單頁的提案／委託。唯讀聚合方法為 `alphaview-portfolio-inbox-v2`。

## 從相同起點建立實驗分支

**從目前帳戶建立實驗分支** 先預覽來源的完整當期估值，再以使用者填寫的名稱建立新帳戶。分支保留來源的精確股數與虛擬現金，以當期未調整收盤價重建成本基礎，已實現損益從零開始。起始資金等於現金加上逐部位取八位小數的開帳金額。

`opening_mark` 是實驗起點的部位開帳，不是假裝發生的買入，不收手續費或滑價。來源保持不變；新帳戶複製風險限制、執行政策與暫停狀態，但不複製歷史 NAV、提案、任務或待處理委託。來源缺價或預覽後資料改變就阻擋建立，重試同一請求只建立一次。方法為 `alphaview-paper-fork-v1`，來源紀錄存在 `paper_account_origins`。

## 指定下一交易日開盤的模擬委託

「次日開盤模擬委託」以仍有效的已保存提案為來源，要求在指定日開盤前填寫成本與買入扣款上限、明確授權。股數與日期固定，指定日完成且價格齊全後才整批驗算／模擬；缺價等待、受阻可明確重試或取消。完整方法、限制與 API 見 [次日開盤模擬](paper-next-open.md)。

自動化任務已提供可關閉的配置偏離與成交間隔門檻；缺資料等待不占當日次數，未達門檻保存 skipped 而不建提案。計算與授權見 [調倉門檻](rebalance-triggers.md)。帳戶共用的 [允許標的政策](paper-symbol-policy.md) 也適用規則、本機模型與次日開盤路徑。

## 其他本機 Agent 的接入

`scripts/portfolio_agent_cli.py` 提供 stdlib-only JSON 工具介面，僅允許 loopback HTTP，不使用環境 proxy、重新導向、認證資訊或外部服務。`capabilities` 是離線可讀的動作清單；`run` 預設唯讀，只有 `--save` 保存工作流。接受提案需要 `--paper` 與帳戶、提案、版本和 idempotency key。完整使用方式見 [Agent CLI](portfolio-agent-cli.md)。

## API 與模組

| 範圍 | 路徑 | 模組 |
| --- | --- | --- |
| 帳戶與限制 | `/api/paper/accounts`、`/{id}/controls` | `paper_portfolio.py` |
| 目標與接受 | `/{id}/preview`、`/{id}/proposals`、`/{id}/proposals/{proposal}/accept` | `paper_portfolio.py` |
| 規則 Agent | `/api/portfolio-agent/preview`、`/runs`、`/runs/{id}` | `portfolio_agent.py` |
| Agent→paper | `/api/portfolio-agent/runs/{id}/paper-preview`、`/paper-proposal` | `portfolio_agent.py` |
| 候選池 | `/api/portfolio-agent/candidates` | `portfolio_candidates.py` |
| 跨帳戶待辦 | `/api/portfolio-agent/inbox`（含 `execution_events`／`execution_event_counts`：Alpaca 委託事件，`execution_limit=`；`attention[]` 與 `counts.attention_total／attention_critical／attention_warn`，方法版本仍為 v2） | `portfolio_inbox.py`；見 [需要處理清單](portfolio-inbox-attention.md) |
| 情境比較 | `/api/paper/accounts/{id}/scenarios/compare` | `paper_scenarios.py` |
| 帳戶比較 | `/api/paper/nav/compare` | `paper_comparison.py` |
| 本機模型 | `/api/local-agent/models`、`/runs`、`/runs/{id}/cancel`、`/paper-preview`、`/paper-proposal` | `local_agent.py` |
| 實驗分支 | `/api/paper/accounts/{id}/fork/preview`、`/fork`、`/origin` | `paper_forks.py` |
| 自動化 | `/api/agent-automation/state`、`/mandates`、`/mandates/{id}/run`、`/attempts` | `agent_automation.py` |
| 每日淨值與進階指標 | `/api/paper/accounts/{id}/nav?window_sessions=&benchmark=`、`/nav/capture`、`/nav/snapshots` | `paper_analytics.py`、`paper_metrics.py`（`metrics` 區塊） |
| 下載 | `/api/paper/accounts/{id}/export?format=json|csv`、`/proposals/{proposal}/receipt` | `paper_reports.py` |
| Jev 決策閘 | `/api/jev/connection`、`/questions`、`/runs`、`/runs/{id}/outcomes`、`/runs/{id}/paper-preview`、`/paper-proposal` | `jev_decision.py`；見 [Jev 決策閘](jev-decision-layer.md) |
| 執行層 | `/api/execution/targets`、`/accounts/{id}/proposals/{proposal}/submit`、`/accounts/{id}/submissions`、`/submissions/{id}`、`/reconcile`、`/orders/{id}/cancel`；`/api/alpaca-paper/orders-policy` | `execution.py`、`alpaca_paper.py`；見 [執行層](execution.md) |
| 風險斷路器 | `/api/paper/accounts/{id}/circuit-breakers`、`/evaluate`、`/events` | `circuit_breakers.py`；見 [風險斷路器](circuit-breakers.md) |
| 市場風險覆蓋 | `/api/paper/accounts/{id}/regime-overlay`（GET/PUT） | `regime_overlay.py`；見 [市場風險覆蓋](regime-overlay.md) |
| 委託清掃 | `POST /api/execution/accounts/{id}/cancel-working`（`expected_account_version`、`reason`）；殺手開關與斷路器暫停後自動執行一次 | `execution.py`；見 [執行層](execution.md) 委託清掃與樣式覆寫 |
| 任務續期／重新授權 | `POST /api/paper/accounts/{id}/mandates/{mid}/renew`（`expected_version`、`expires_on?`、`acknowledge`） | `agent_automation.py`；見 [授權生命週期](mandate-lifecycle.md) |
| 風險感知配置 | `constraints.allocation_method`／`volatility_lookback_sessions`；`POST /api/portfolio-agent/runs/{id}/allocations` | `allocator.py`；見 [風險感知配置器](allocator.md) |
| 公司行動偵測 | `GET /api/corporate-actions?symbols=`、`GET /api/paper/accounts/{id}/corporate-actions` | `corporate_actions.py`；見 [公司行動偵測](corporate-actions.md) |
| 帳簿核對 | `GET /api/alpaca-paper/reconciliation` | `broker_reconciliation.py`；見 [帳簿核對](book-reconciliation.md) |
| 無人值守就緒閘 | `GET /api/trading-agent/readiness?account_id=` | `readiness.py`；見 [就緒閘](readiness.md)；只有 blocked／paper_ready／not_ready |
| 決策結果帳本 | `GET /api/trading-agent/outcomes`（horizon 5／10／20、window、可選 account_id）、`GET /api/trading-agent/outcomes.csv`（同參數，attachment／no-store） | `decision_ledger.py`；見 [決策結果帳本](decision-outcomes.md) |
| 部位停損 | `/api/paper/accounts/{id}/position-stops`（GET／PUT）、`/position-stops/proposal`、`/position-stops/cooldowns/{symbol}` | `position_stops.py`；見 [部位停損](position-stops.md) |
| 每日 Agent 報告 | `/api/trading-agent/report`（`.html`／`.csv`） | `agent_report.py`；見 [每日報告](agent-report.md) ；含 `operations`（就緒閘／授權／停損／覆蓋）、`decision_quality`（10 日命中率、setup_quality 秩相關）與 `provenance_counts` |
| 策略→紙上橋接 | `/api/research-desk/paper-preview`、`/paper-proposal` | `strategy_bridge.py`；見 [策略橋接](strategy-bridge.md) ；`trials`、`validation={mode, acknowledge_fail}`，422 `validation_failed` |

方法版本另含 `alphaview-portfolio-agent-v1`、`alphaview-agent-automation-v2`、`alphaview-rebalance-trigger-v1`、`alphaview-paper-symbol-policy-v1`、`alphaview-paper-export-v1`、`alphaview-jev-decision-v1`。Paper 寫入有自己的帳戶／任務版本，不變更行情 `input_revision`；所有唯讀計算共享一致的 SQLite snapshot。完整 JSON schema 可在本機 `/docs` 檢查。

匯出 JSON 的 `content_sha256` 可檢查內容完整性，不是簽章或券商證明。帳戶匯出不是整個工作區備份，也不提供匯入／覆寫功能。完整帳本單次下載上限 50,000 筆、JSON 提案上限 5,000 筆，超過會明確拒絕，不輸出不完整檔案。

## 設計來源

對標的專案、查核時間、人氣數值與取捨見 [GitHub Agent 與 Portfolio 功能對標](github-agent-portfolio-benchmark-2026-09-20.md)。本輪參考分層與操作流程，沒有匯入競品程式碼、券商 adapter 或外部模型依賴。
