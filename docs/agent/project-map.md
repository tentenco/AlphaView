# AlphaView 專案地圖（Agent 參考）

查位置、指令與慣例用的參考，不是規則。規則只在根目錄 `AGENTS.md`；授權沿革在 `docs/agent/authorization-log.md`。新增模組、端點或方法版本時更新這裡。

## 專案是什麼

AlphaView（原 Sequoia-X）是**本機優先、單一使用者**的美股研究工作區：市場候選池探索、四策略每日選股、Alpha 跨策略加權排序、持股監控、回測、標的比較、市場風險溫度計，全部跑在 `127.0.0.1:8876`。行情來自 Yahoo Finance / yfinance 日線，存在本機 SQLite（`data/panel.db`）。**不是**即時行情終端、不下單、不推播、不公開部署。

`main.py` 與 `alphaview/{core,data,strategy,notify}` 是保留的獨立 A 股 CLI（baostock + 飛書），Web 面板不使用它們；除非使用者明確要求，不要動。

## 目錄與核心模組

```text
alphaview/panel/     FastAPI 後端：行情擷取、SQLite、選股引擎、回測、研究 API
web/src/             React 19 + TypeScript + Vite 前端；vitest 測試
tests/               pytest；每個測試用 PANEL_DB_PATH 指到 tmp_path 的隔離資料庫
docs/                產品方法、決策紀錄、下一輪提案（多為繁中）
scripts/             Harness 帳本、長測、備份預檢、隔離行情診斷、檢閱頁產生器
artifacts/           本機 receipts、截圖、備份、review.html（gitignore；含私人資料）
```

| 責任 | 位置 |
| --- | --- |
| 資料庫 schema、讀取快照、revision 計數 | `alphaview/panel/store.py`（`snapshot_read`、`input_revision`） |
| 行情擷取、股票池探索、日線驗證 | `market.py`（`fetch_symbol`、`discover_universe`、`history_quality`） |
| 指標、四策略、掃描發布、回測 | `research.py`（`indicators`、`evaluate`、`scan`、`backtest`） |
| 掃描版本與輸入 token | `scan_provenance.py`、`scan_context.py` |
| 交易日曆（XNYS、收盤後 15 分鐘） | `sessions.py` |
| 背景作業、工作區鎖、排程 | `jobs.py`、`locking.py`、`scheduler.py` |
| Alpha 回放／組合實驗／候選持倉相關性 | `alpha_replay.py`、`alpha_basket.py`、`holding_fit.py` |
| 市場風險溫度計（多因子崩盤風險） | `market_regime.py`；前端 `web/src/MarketRegime.tsx`、`market-regime.ts` |
| 備份、預檢、儲存清理、風險診斷 | `backups.py`、`backup_preflight.py`、`storage_maintenance.py`、`risk.py` |
| 前端排序與提醒模型 | `web/src/alpha-model.ts`、`AlphaDashboard.tsx`；頁面路由在 `App.tsx`（hash 路由） |
| Agent 組合與本機模擬 | `paper_portfolio.py`、`portfolio_agent.py`、`agent_automation.py`、`rebalance_trigger.py`、`paper_analytics.py`（進階指標 `paper_metrics.py`）、`paper_reports.py`；前端 `AgentPortfolio.tsx`（風險控管分頁集中斷路器、停損、覆蓋與公司行動） |
| 本機模型與延後模擬 | `local_agent.py`、`paper_next_open.py`；模型僅 loopback Ollama，委託僅指定日完成後參考價模擬 |
| 組合比較與操作 | `paper_scenarios.py`、`paper_comparison.py`、`paper_forks.py`、`portfolio_inbox.py`（含 `inbox_acknowledgements.py` 的版本化已檢閱回條，以及 `execution_events` 與 `attention` 需要處理清單：任務授權、暫停、斷路器、清掃、停損、公司行動、拒單／未知委託；來源失敗以 `source_unavailable` 標示；見 `docs/portfolio-inbox-attention.md`）、`portfolio_candidates.py` |
| Alpaca Paper 唯讀連線 | `alpaca_paper.py`；前端 `AlpacaPaper.tsx`，與本機模擬帳本分開 |
| 回測研究台（多策略比較） | `research_desk.py`：參數化策略、同窗口錦標賽、樣本內／外、虧損診斷、交易 CSV、Pine v6 匯出、預設與研究紀錄；前端 `ResearchDesk.tsx`、`ResearchDeskDiagnosis.tsx`（`#research-desk`） |
| 執行層與 Alpaca Paper 委託 | `execution.py`（submission／order 紀錄、reconcile、cancel）、`alpaca_paper.py` 的 `_request` 與 `orders-policy`；委託型態 `order_style`（market／limit＋限價帶，`execution.limit_price`，缺參考價 fail-closed）；到期／取消前的部分成交為終態 `mixed`；待辦 `execution_events` 由委託紀錄推導；暫停即清掃 `execution.cancel_working`／`sweep_after_pause`（殺手開關、斷路器暫停後各送一次取消，未送出標 skipped、券商不可達留 unknown）；每次送出可帶 `order_style_override`（`summary.order_style_source`）；前端 `PortfolioTradingAgent.tsx`（交易代理分頁） |
| 風險斷路器、每日報告、策略橋接 | `circuit_breakers.py`、`agent_report.py`、`strategy_bridge.py`；橋接 v2 沿用診斷 risk／test_start／test_end／folds，建立提案前跑 `alphaview-validation-v1` 閘（`validation.mode` require_pass／warn_only／off；fail 只能以 `acknowledge_fail` 明確覆寫並記入 rationale）；前端 `PortfolioCircuitBreakers.tsx`、`AgentDailyReport.tsx`、`ResearchDeskPaperBridge.tsx` |
| 市場風險覆蓋（總曝險上限） | `regime_overlay.py`：regime v1 分數 → band→cap，block 模式在紙上預覽回報 `regime_exposure_cap`／`regime_unavailable` 違規，scale 模式縮放自動化目標並記錄證據；政策存於斷路器 `policy_json`；前端 `PortfolioRegimeOverlay.tsx`；見 `docs/regime-overlay.md` |
| 純減倉例外與就緒閘 | `circuit_breakers.py` 的 `reduce_only_allowed`（`paper_portfolio` 每份預覽附 `risk_direction`，純減倉提案可通過暫停與斷路）；`readiness.py` 只讀就緒閘（只有 blocked／paper_ready／not_ready，沒有 live_ready）；就緒閘 v3：本機核對回條期限與來源、覆蓋上限可計算、持股無疑似混合基礎拆併股、停損對每檔持股可判斷、決策結果命中率（`decision_ledger.hit_rate_flags`：10 日地平線、≥20 筆、<40% 為 fail）；自動化 v3 在相關來源家族低命中率或證據無法評估時，本輪降為人工審閱／`proposal_only`，保存凍結依據；樣本不足不單獨降級；前端 `AgentReadiness.tsx`；見 `docs/readiness.md` |
| 調倉門檻 regime 變動與純減倉自動化 | `rebalance_trigger.py` 的 `regime_change`（本日 band vs 上次嘗試記錄的 band，分數不完整則等待、不觸發）；`reduce_only.py`（`alphaview-reduce-only-v1`）讓暫停帳戶在 `reduce_only_allowed` 下自動化只做減碼或略過；前端 `PortfolioRebalanceTrigger.tsx`；見 `docs/rebalance-triggers.md` |
| 任務授權生命週期 | `agent_automation.py` 的 `expires_on`／`reauth_required`／`lifecycle()`、`require_reauth()`（斷路器觸發、手動暫停即需重新授權）、`/renew` 端點（須 `acknowledge`）；`readiness` 的 `mandate_active` 讀取生命週期；見 `docs/mandate-lifecycle.md` |
| 風險感知配置器 | `allocator.py`：equal／inverse_volatility／score_tilt，σ 回看 20–120 日，總投入不變、上限超出留現金、缺 σ 整個不可用（run 標 blocked，不退回等權）；設定在 `AllocationConstraints`；比較端點 `POST /api/portfolio-agent/runs/{id}/allocations`，前端 `AllocationComparison` 並列三種方法（what-if，不是保存證據）；見 `docs/allocator.md` |
| 提案來源與閘門標籤 | `paper_portfolio.provenance`（`alphaview-proposal-provenance-v1`，讀取時由 rationale／來源欄位／notices／狀態推導，不存入 `preview_json`）；日報 `decision_quality` 與 `provenance_counts`；前端 `AgentPortfolio.tsx`「為什麼是這份提案」；見 `docs/proposal-provenance.md` |
| 公司行動偵測 | `corporate_actions.py`：由本機 adj_close/close 因子變化偵測除權息日（疑似拆併股／推算股息／無法分類／不可用），帳戶摘要用停損的進場日定義；紙上預覽只加 `notices`（`PREVIEW_METADATA`），不調整帳本；前端 `PortfolioCorporateActions.tsx`；見 `docs/corporate-actions.md` |
| 帳簿核對（Alpaca） | `broker_reconciliation.py`：執行層記錄的 Alpaca Paper 成交股數 vs 券商 `/v2/positions`，只顯示 matched／pending／unknown／unexplained／drift／unavailable（v2：無法解析數量不得判為一致），不修正；前端 `AlpacaBookReconciliation.tsx`（Alpaca 頁，按下才讀取）；見 `docs/book-reconciliation.md` |
| 決策結果帳本 | `decision_ledger.py`：訊號／規則目標／Jev 門檻／紙上成交的事後結算與 Jev 機率校準；`outcomes.csv` 逐筆匯出（空白數值不補 0、公式防護）；`calibration.score_correlation` 為 setup_quality 分數 vs 實現報酬的 Spearman；前端 `AgentDecisionOutcomes.tsx`（交易代理分頁）；見 `docs/decision-outcomes.md` |
| 部位停損／追蹤停損／冷卻 | `position_stops.py`（紙上預覽的 `stop_cooldown` 違規在 `paper_portfolio._build_preview`）；前端 `PortfolioPositionStops.tsx`；見 `docs/position-stops.md` |
| Jev 決策閘（TypeSafe System One） | `jev_decision.py`：固定問題集、程式分桶狀態、門檻閘門、費用紀錄、`jev_source` 紙上綁定；前端 `PortfolioJevGate.tsx`、`jev-model.ts` |
| 繁中→英文翻譯 | `web/src/locale.tsx`：以 DOM 文字替換，**新增中文字串要在 `translations` 加對應英文** |

## 常用指令

```sh
uv sync --locked --extra web --extra dev && npm ci --prefix web
uv run --extra web python -m alphaview.panel serve        # http://127.0.0.1:8876（/docs 有 API）
npm run dev --prefix web                                   # 5173，proxy /api 到 8876
npm run build --prefix web                                 # 正式建置（serve 讀 web/dist）
```

驗收關卡的五個指令在 `AGENTS.md` 第 5 節。Vite 會警告超過 500 kB 的 chunk；頁面已採按需載入，當輪大小與警告以最新 build 輸出為準。

## 方法版本字串

改變語意就升版（規則見 `docs/scan-provenance.md`），不覆寫、不重用版本號。目前登錄：

`alphaview-scan-v1`、`alphaview-backtest-v5`、`alphaview-alpha-v1`、`alphaview-alpha-basket-v1`、`alphaview-comparison-v1`、`alphaview-holding-fit-v1`、`alphaview-regime-v1`、`alphaview-jev-decision-v1`（問題集另有 `alphaview-jev-questions-v1`，釘選 `jev-1.13.0`）、`alphaview-research-desk-v1`（Pine 匯出 `alphaview-pine-export-v1`）、`alphaview-execution-v1`、`alphaview-alpaca-paper-orders-v1`、`alphaview-circuit-breaker-v1`、`alphaview-agent-report-v1`、`alphaview-strategy-bridge-v1`、`alphaview-strategy-bridge-v2`、`alphaview-position-stops-v1`、`alphaview-paper-metrics-v1`、`alphaview-validation-v1`、`alphaview-research-integrity-v1`、`alphaview-decision-outcome-v1`、`alphaview-regime-overlay-v1`、`alphaview-readiness-v1`、`alphaview-readiness-v2`、`alphaview-readiness-v3`、`alphaview-book-reconciliation-v1`、`alphaview-book-reconciliation-v2`、`alphaview-reconciliation-receipt-v1`、`alphaview-allocator-v1`、`alphaview-corporate-actions-v1`、`alphaview-reduce-only-v1`（`alphaview-rebalance-trigger-v1` 保持，regime 門檻為可選欄位）、`alphaview-proposal-provenance-v1`、`alphaview-local-agent-integrity-v1`、`alphaview-paper-cost-sensitivity-v1`、`alphaview-agent-automation-v3`、`alphaview-automation-outcome-guard-v1`、`alphaview-portfolio-inbox-v3`、`alphaview-workflow-validation-v1`、`alphaview-allocation-research-v1`、`alphaview-corporate-action-evidence-v1`、`alphaview-corporate-action-refresh-v1`、`alphaview-workflow-comparison-v1`、`alphaview-allocation-research-receipt-v1`、`alphaview-allocation-research-receipt-comparison-v1`、`alphaview-execution-sweep-history-v1`、`alphaview-execution-sweep-query-v1`、`alphaview-execution-sweep-export-v1`、`alphaview-workflow-path-validation-v1`、`alphaview-corporate-action-ledger-preview-v1`、`alphaview-execution-volume-study-v1`、`alphaview-research-integrity-receipt-v1`。

## 寫作與 UI 慣例

- 介面與文件以繁體中文為主，英文由 `locale.tsx` 翻譯表產生；React 元件內用 `t(zh, en)` 或直接寫中文並補翻譯表。
- 每個新功能配一段「這不是什麼」的說明（範圍、分母、偏差、限制），沿用 `research-note`／`alpha-method` 樣式。
- 沿用 `styles.css` 的 tokens（`--text`、`--muted`、`--line`、`--positive`、`--negative`、`--amber`、`--type-*`）；淺色預設、深色可切；手機 390px 不得橫向溢出；表單可鍵盤完成。
- 後端新端點：pydantic `extra="forbid"`、`allow_inf_nan=False`、範圍限制；唯讀端點加 `@store.snapshot_read`；回傳附 `engine_version`、`as_of`、`input_revision`、`method` 說明；測試必須確認 `store.input_revision()` 不變、`json.dumps(result, allow_nan=False)` 可序列化。
- Prettier：無分號、單引號、printWidth 100。Python 沒有 formatter 關卡，但沿用既有風格（短函式、明確錯誤訊息為繁中）。

## Harness（時間盒開發）工作法

Codex 的兩輪 Harness 都以固定時限、事件帳本與本機檢閱頁交付：

- 產物放 `artifacts/harness-<日期>/`：`state.json`（完成／進行中／證據／限制／下一輪）、`events.jsonl`、`review.html`、截圖、`STOP` 標記、`source-checkpoint.zip`（`scripts/checkpoint_harness.py`）。
- `scripts/harness.py status|report`（09-05 版）、`scripts/render_alpha_review.py`（09-07 版）產生離線 HTML；報告只用本機資源，不連網。
- 2026-10-01 版：`scripts/render_trading_agent_review.py <harness-dir>` 由 `state.json`／`events.jsonl`／`benchmark.json`／`gates.json` 產生 `review.html`；`scripts/run_harness_gates.py <harness-dir>` 跑五道關卡並寫 `gates.json`。事件格式：`{at, unit, status, owner, evidence[], note}`。
- 到期即停止新功能，保留斷點、整理已通過與未驗收項；**規劃文件不能當作已完成**。
- 靜態檢閱頁用 `python3 -m http.server 8878 --bind 127.0.0.1 --directory artifacts/harness-…`。**8877 屬於另一個專案，不要停掉。**

若使用者要求新一輪 Harness，先開新目錄、寫 `state.json` 的 deadline 與 scope，再開始改碼；每完成一個可驗收單位就追加一筆 event。

## 參考文件

`README.md`（英文產品說明，描述已實作行為）· `WEB_PANEL.md`（繁中使用指南）· `docs/alpha-research.md`（Alpha 計算口徑與 API）· `docs/alpha-ux-decisions.md` · `docs/scan-provenance.md` · `docs/candidate-comparison.md` · `docs/backup-preflight.md` · `docs/data-provider-evaluation.md` · `docs/competitor-benchmark.md` · `docs/market-regime.md` · `docs/HARNESS.md` · `docs/alpha-harness-handoff.md` · `docs/paper-operations-runbook.md` · `docs/trading-agent-harness-handoff-2026-10-01.md`

本輪補充：`research_integrity.py` 提供固定規則歷史前綴比較（見 `docs/research-integrity.md`）；`local_agent.py` 的 integrity 端點離線重驗保存證據（見 `docs/local-agent.md`）；`paper_cost_sensitivity.py` 固定模擬股數、比較費用／滑價網格與當日成交量覆蓋（見 `docs/paper-cost-sensitivity.md`）。核對回條只存本機，readiness-v3 不呼叫券商（見 `docs/book-reconciliation.md`）。

工作流單項驗證見 `workflow_validation.py`／`WorkflowValidation.tsx` 與 `docs/workflow-validation.md`；固定規則證據不構成組合驗證或提案閘門。待辦來源篩選在 `portfolio_inbox.py`／`PortfolioInbox.tsx`，只採用結構欄位或既有程式標記。`portfolio-navigation.ts` 管理 Agent 投資組合的 account／view／tab hash，App 以問號前的主路徑切換頁面。

`allocation_research.py`／`AllocationResearch.tsx` 提供保存工作流的排名權重與完整共變異等風險貢獻計算，固定標的與投入預算，見 `docs/allocation-research.md`。`corporate_action_evidence.py` 在既有兩年 Yahoo 更新內原子保存 adapter 回傳的公司行動證據與覆蓋狀態；資料修訂保留、缺欄仍未知，不自動調整帳本，見 `docs/corporate-actions.md`。

`corporate_action_refresh.py` 提供持有標的的明確兩年行情更新與本機重新偵測，重用既有 jobs／工作區鎖，請求帶帳戶版本、輸入版本、已完成交易日與冪等識別；不修改股票池、持倉或公司行動帳本。

`workflow_comparison.py`／`SavedWorkflowComparison.tsx` 在一致讀取快照比較兩份保存工作流的候選、選入狀態、目標、設定與來源；不重跑策略、不比較績效、不推斷因果。來源過時與當時記錄分開顯示，見 `docs/workflow-comparison.md`。

`allocation_research_receipts.py`／`AllocationResearchReceipts.tsx` 保存伺服器重新計算並核對來源的排名／ERC 研究回條；不可變歷史與目前來源資格分開，見 `docs/allocation-research-receipts.md`。保存不修改帳戶或主動配置，後續前綴回條與人工註記加入後為43表，schema 簽章已登錄。

研究收據比較端點 `POST /api/paper/accounts/{account_id}/allocation-research-receipts/compare` 只讀兩份同帳戶收據；`AllocationReceiptComparison.tsx` 並列保存權重、風險貢獻與當期資格。不同方法／視窗／標的／覆蓋不算差額，歷史過期不重新計算。

`execution_sweep_history.py` 追加不可變逐次清掃事件，與既有清掃摘要在同一筆最後交易提交；不改取消決策或委託權限。帳戶歷程／明細 `GET /api/execution/accounts/{account_id}/sweep-history` 只讀保存值；畫面可限定送出紀錄並下載所選完整事件JSON，不把舊摘要回填成完整歷程，見 `docs/execution-sweep-history.md`。


`workflow_path_validation.py`／`WorkflowPathValidation.tsx` 計算保存候選清單與設定的252日路徑：每21日以獨立截斷歷史重建規則，次日原始開盤、10bps費用；缺必要證據或持有期間調整因子變動則不可用。它不是當時股票池回測、提案閘或統計pass，見 `docs/workflow-path-validation.md`。

`corporate_action_preview.py`／`CorporateActionLedgerPreview.tsx` 從可核對的本機成交與事件證據產生條件式拆股股數／成本預覽；股息權利與支付日期未知，不改帳本。見 `docs/corporate-action-ledger-preview.md`。

`execution_volume_study.py`／`ExecutionVolumeStudy.tsx` 在已保存提案明細提供固定股數的全日量參與率／部分容量／DAY到期研究。訊號日→次日原始開盤只是參考價，全日量為事後資料，不代表開盤可成交，見 `docs/execution-volume-study.md`。

清掃歷程支援 `start_date`／`end_date`（UTC含當日）與精確 `reason`，驗證後篩選再分頁；`/sweep-history/export` 同快照匯出完整範圍，最多250筆／2MiB，超額拒絕、不截斷、不刪除。

`research_integrity_receipts.py`／`ResearchIntegrityReceipts.tsx` 保存伺服器重算並核對期望指紋的抽樣前綴回條。新表 `research_integrity_receipts` 使 schema 為42表；簽章 `4ff5095a0e505f6415dcdb4f57edebfc215beaa669fd922e67da323949154d76`。讀取歷史與當期資格分離，不把抽樣診斷稱為完整因果證明，見 `docs/research-integrity-receipts.md`。

`allocation_receipt_archive.py`／`AllocationReceiptArchive.tsx` 可匯出同帳戶全部研究收據並做只讀相容性預檢；原始JSON與無法驗證的儲存格都明示覆蓋，不匯入、不刪除。見 `docs/allocation-receipt-archive.md`。

`workflow_path_costs.py`／`WorkflowPathCosts.tsx` 固定同一組歷史決策，比較最多9組費用／滑價假設；完整原基準、曲線與成交明細保存，不選最佳情境。方法 `alphaview-workflow-path-costs-v1`，見 `docs/workflow-path-costs.md`。

`local_agent_review.py`／`LocalAgentReview.tsx` 保存獨立人工註記：review_required、reviewed、rejected。註記不修改模型證據資格或執行權限。新表 `local_agent_review_events` 使當時schema為43表，簽章 `64f9858587f7c7d8f18a86987ac16749d780f6bf018ae97f50b01cde2afd78de`；42表簽章保留為歷史遷移。見 `docs/local-agent-review.md`。

`workflow_path_receipts.py`／`WorkflowPathReceipts.tsx` 保存兩種完整路徑／成本證據；伺服器重算與發布CAS，精確重播歷史，當期資格分離。方法 `alphaview-workflow-path-receipt-v1`；當時44表簽章 `248d5b9375fc6f1af5dac6798de45bb4f952857add4d9f6e70a87fb774c70393`，43表保留為歷史遷移。見 `docs/workflow-path-receipts.md`。

`execution_limit_study.py`／`ExecutionLimitStudy.tsx` 提供單日原始開盤限價與DAY情境餘量研究；日內成交未知，不使用高低價推斷觸價成交。方法 `alphaview-execution-limit-study-v1`，見 `docs/execution-limit-study.md`。

`corporate_action_history.py`／`CorporateActionHistory.tsx` 只讀比較持有標的保存事件的修訂；原始型別與移出保存內容獨立列出，歷史覆蓋保持未知。方法 `alphaview-corporate-action-history-v1`，見 `docs/corporate-action-history.md`。

`workflow_path_segments.py`／`WorkflowPathSegments.tsx` 將同一條原路徑分為4×63交易日；核對邊界NAV、連乘報酬與加總損益，不宣稱獨立fold。方法 `alphaview-workflow-path-segments-v1`，見 `docs/workflow-path-segments.md`。

`workflow_path_attribution.py`／`WorkflowPathAttribution.tsx` 依保存成交與同一原始行情重建逐標的每日損益，核對NAV、現金與費用；貢獻以原始資金為分母，缺值持續傳遞。方法 `alphaview-workflow-path-attribution-v1`，見 `docs/workflow-path-attribution.md`。

`ResearchEvidenceNavigation.tsx` 在目前工作區內定位已存在的研究區塊，支援鍵盤與reduced-motion，不發出請求、不重設草稿。見 `docs/research-evidence-navigation.md`。

`workflow_path_receipt_comparison.py`／`WorkflowPathReceiptComparison.tsx` 比較同帳戶跨工作流的不可變原件；資料、方法、完整期間與成本一致才提供差額，當期資格另列。方法 `alphaview-workflow-path-receipt-comparison-v1`，見 `docs/workflow-path-receipt-comparison.md`。

`research_prefix_coverage.py`／`ResearchPrefixCoverage.tsx` 在明確訊號日期範圍逐切點重建，最多120切點、2000本機日線；超限不退回抽樣，完整涵蓋只指選定設定與合格切點。方法 `alphaview-research-prefix-coverage-v1`，見 `docs/research-prefix-coverage.md`。

`workflow_path_cscv.py`／`WorkflowPathCSCV.tsx` 對3–8份保存路徑原件計算6×42日、20組互補切分的排序診斷；原始選定試驗集、平手政策與三種中位數比例明列。方法 `alphaview-workflow-path-cscv-v1`，不是完整探索試驗的PBO或提案閘，見 `docs/workflow-path-cscv.md`。

`execution_gtd_study.py`／`ExecutionGTDStudy.tsx` 研究最多五個明確交易日的開盤限價、全日量事後容量與逐日餘量；缺資料後保持未知，沒有盤中成交或券商送單。方法 `alphaview-execution-gtd-study-v1`，見 `docs/execution-gtd-study.md`。

`workflow_path_drawdowns.py`／`WorkflowPathDrawdowns.tsx` 從保存的252日完整NAV原件列出高點、谷底及恢復日；觀察末日仍未恢復的完整期間保持未知，並與原件最大回撤對帳。方法 `alphaview-workflow-path-drawdowns-v1`，見 `docs/workflow-path-drawdowns.md`。

`research_integrity_archive.py`／`ResearchIntegrityArchive.tsx` 完整匯出單一標的抽樣前綴回條，保留SQLite原始型別及JSON位元組；只讀預檢核對完整性、相容性與容量。方法 `alphaview-research-integrity-archive-v1`，不匯入、不刪除、不重算指標，見 `docs/research-integrity-archive.md`。

`execution_study_receipts.py` 保存容量、DAY限價及GTD研究原始證據；伺服器重算後核對HTTP原文SHA256，發布CAS，歷史原件與目前資格分開。新表整合後目前45表簽章 `e0421409f585846e07e71027e17b2383e0dbabf469cd3920d3176e1ee6efdb5e`，44表保留歷史遷移。方法 `alphaview-execution-study-receipt-v1`，見 `docs/execution-study-receipts.md`。

`workflow_path_receipt_archive.py`／`WorkflowPathReceiptArchive.tsx` 封存同帳戶跨工作流的完整路徑與成本原件，保留SQLite儲存型別；只讀預檢核對相容性、同ID衝突及容量，不匯入、不刪除、不重算。方法 `alphaview-workflow-path-receipt-archive-v1`，見 `docs/workflow-path-receipt-archive.md`。

`workflow_path_monthly.py`／`WorkflowPathMonthly.tsx` 從保存的252日原件呈現逐月報酬與NAV變化；完整／部分月份按歷史XNYS日曆判斷，期間外格子保留不可用，與完整期間的連乘報酬、損益加總對帳。方法 `alphaview-workflow-path-monthly-v1`，見 `docs/workflow-path-monthly.md`。


執行情境回條比較：`execution_study_receipt_comparison.py`／`ExecutionStudyReceiptComparison.tsx`（`alphaview-execution-study-receipt-comparison-v1`），同基礎逐筆差值與完整原件，無總分或執行資格，見 `docs/execution-study-receipt-comparison.md`。提案內的三種研究透過 `ExecutionStudyWorkspace.tsx` 預設收合但保持掛載，見 `docs/execution-study-workspace.md`。四種封存預檢透過 `ArchivePreflightRecords.tsx` 以25筆分頁及ID搜尋檢閱，全包判定與原件不變。


`workflow_path_rolling.py`／`WorkflowPathRolling.tsx`（`alphaview-workflow-path-rolling-v1`）從完整保存NAV列出21／63／126交易日的重疊窗口，不是獨立樣本或CPCV，見 `docs/workflow-path-rolling.md`。`execution_study_receipt_archive.py`／`ExecutionStudyReceiptArchive.tsx`（`alphaview-execution-study-receipt-archive-v1`）跨提案封存同帳戶三種研究原件並唯讀預檢，不匯入或刪除，見 `docs/execution-study-receipt-archive.md`。

Harness檢閱目錄由 `scripts/harness_review_catalog.py` 產生，搜尋／分類／分頁僅作用於清單呈現；原始完成敘述、驗收證據與列印全量保持。


`workflow_path_trial_inventory.py`／`WorkflowPathTrialInventory.tsx`（`alphaview-workflow-path-trial-inventory-v1`）唯讀列出完整已保存集合、比較基礎與設定重複數；成本原件不當路徑試驗，損壞保留，完整搜尋分母未知。不是完整試驗登錄或PBO分母，見 `docs/workflow-path-trial-inventory.md`。

`research_evidence_capacity.py`／`ResearchEvidenceCapacity.tsx`（`alphaview-research-evidence-capacity-v1`）於同一唯讀快照以COUNT讀四類回條容量，含損壞列；帳戶與工作區上限引用原模組常數，前綴回條只有工作區範圍。面板位於「配置與提案」且預設收合／明確讀取，不掃完整性、不刪除、不授權保存，見 `docs/research-evidence-capacity.md`。

`path-analysis-csv.ts` 提供月報酬／滾動期間的可讀CSV，保留部分月份、所有窗口、來源與邊界；原始JSON仍是完整證據。`ExecutionStudyReceipts.tsx` 明確組合最多50筆完整歷史後本機篩選／搜尋／10筆分頁，跨頁來源漂移拒絕部分清單。`ExecutionStudyReceiptComparison.tsx` 的逐筆明細另有25筆分頁與符號搜尋；完整比較與原件不受清單狀態影響。

產品操作入口與保存語意見 `docs/research-evidence-guide.md`。Harness靜態檢閱頁由 `scripts/render_trading_agent_review.py` 產生，`scripts/harness_review_catalog.py` 提供完成目錄；任務JSON可先預覽再明確還原同run草稿，不會執行下一輪或授權外部操作。


`execution-study-comparison-csv.ts` 匯出完整比較的所有委託及保存逐日欄位，缺值保留空白與明確不可用狀態；顯示篩選不縮減CSV或原始JSON。

下一輪未實作契約見 `docs/trial-registry-contract-draft.md` 與 `docs/portfolio-validation-v2-contract-draft.md`：前者定義事前宣告／固定分母／受控attempt，後者定義事件資訊邊界／split／組合狀態。它們不是已發布引擎、CPCV、完整PBO或提案閘；舊v1回條仍保持原樣。


`archive-preflight-csv.ts`／`ArchivePreflightRecords.tsx` 可匯出四家預檢完整報告的長格式CSV；型別標記區分null／missing／空值，搜尋分頁不縮減，原封存JSON不變。格式 `archive_preflight_readable_v1` 只作閱讀，不是新研究方法或匯入授權，見 `docs/archive-preflight-csv.md`。
