# Trading Agent Harness 接手文件（2026-10-03）

本輪由使用者授權持續五小時，從台北時間 00:44:46 到 05:44:46。先檢查 10/01 Conclusion 的 14 項建議，再依可獨立驗收的範圍接續開發。完整狀態與證據在 `artifacts/harness-2026-10-03-continuation/`；已在原訂05:44:46停止新功能並設斷點，等待使用者檢閱；不自動接續下一輪。

## 開始與接續

- 根代理負責 API、父元件、翻譯、schema 登錄、文件、瀏覽器與最終關卡；三個 worker 分別負責互不重疊的單元，完成後動態換下一件事。
- 工作樹原本已有大量未提交內容。開始、整合與各次覆寫前都有來源備份；沒有 commit、stash、reset、push 或部署。來源快照包含工作樹既有改動，不可把所有檔案都當成本輪新增。
- 所有測試與瀏覽器使用隔離合成資料，外部券商測試採假 adapter。沒有對使用者帳戶送出委託，也沒有在開發中批次呼叫付費服務或模型。
- 新的獨立要求採 FIFO；這份文件建立時佇列為空。05:44:46 截止後停止新功能，不因待辦尚多自動續跑。

## 交付範圍

| 工作 | 主要位置 | 語意與限制 |
| --- | --- | --- |
| 診斷脈絡接續紙上提案 | `strategy_bridge.py`、`ResearchDeskPaperBridge.tsx` | bridge-v2 沿用風險、期間與驗證參數；發布前核對來源 |
| 授權過期前置阻擋、暫停後清掃 | `agent_automation.py` | 過期不跑研究／Jev；清掃沿用既有執行層，不增加送單權限 |
| 風險分頁與草稿衝突 | `AgentPortfolio.tsx`、三個風險設定面板 | 首次開啟才掛載；未保存輸入不被輪詢或早到回應覆蓋 |
| 待辦檢閱與來源 | `inbox_acknowledgements.py`、`portfolio_inbox.py`、`PortfolioInbox.tsx` | 版本化檢閱回條；內容變更重新待閱；來源篩選不降低全域風險計數 |
| 歷史前綴完整性 | `research_integrity.py`、`ResearchDeskIntegrity.tsx` | 最多6個切點／2000日線，抽樣一致不是完整因果證明 |
| 本機模型離線證據 | `local_agent.py`、`PortfolioLocalAgent.tsx` | 重驗保存事實／引用／規則；歷史一致與當期資格分開，原文預設不進 DOM |
| 帳簿核對回條與就緒 v3 | `broker_reconciliation.py`、`readiness.py` | 明確核對才讀券商；就緒唯讀本機回條，期限或來源變更即失效 |
| 固定股數成本敏感度 | `paper_cost_sensitivity.py`、`PortfolioCostSensitivity.tsx` | 最多25格，成交量用精確當日值；不改股數或執行政策 |
| 低命中率人工審閱 | `decision_ledger.py`、`agent_automation.py` | 已結束樣本足夠且命中率過低，當次改 proposal_only；原授權保留 |
| 帳戶與分頁連結 | `portfolio-navigation.ts`、`App.tsx` | hash 可回到帳戶／檢視／分頁，無效值明示回退 |
| 單項規則驗證與 JSON | `workflow_validation.py`、`WorkflowValidation.tsx` | 未支援規則列入缺口；不是組合驗證或提案閘 |
| 配置比較 CSV | `allocation-comparison-csv.ts` | 匯出已顯示回應，空值不補零、防公式注入 |
| 排名與等風險貢獻研究 | `allocation_research.py`、`AllocationResearch.tsx` | 固定標的與預算；完整共變異，退化／缺值／不收斂不可用；上限餘額留現金 |
| 公司行動來源證據 | `corporate_action_evidence.py`、`market.py` | adapter 回傳證據與日線原子保存，修訂不可變；來源完整性未知，不改帳本 |
| 保存工作流差異 | `workflow_comparison.py`、`SavedWorkflowComparison.tsx` | 同一快照讀兩份保存紀錄，不重算、不推斷績效或因果 |
| 不可變研究收據、比較與 JSON | `allocation_research_receipts.py`、`AllocationResearchReceipts.tsx` | 伺服器重建、完整 CAS、內容指紋與精確重播；歷史過期仍可讀，不重算 |
| 公司行動單標的更新 | `corporate_action_refresh.py`、`PortfolioCorporateActions.tsx` | 沿用既有 jobs 與供應者；帶版本、重送鍵、取消與失敗狀態，不改帳本 |
| 保存清掃紀錄與原因篩選 | `execution-review.ts`、`PortfolioTradingAgent.tsx` | 歷史動作與目前委託分開，不因篩選讀券商或送出委託 |
| 不可變逐次清掃歷程 | `execution_sweep_history.py`、`ExecutionSweepHistory.tsx` | 新事件與最近摘要同交易提交；範圍篩選與完整JSON，不回填舊摘要，歷史動作與目前成交分開 |
| 頁面載入改善 | `App.tsx`、`AgentPortfolio.tsx` | Alpha／市場／選股／比較／備份與 Agent 重頁按需載入，草稿仍保留 |
| 本機 HTML 檢閱 | `scripts/render_trading_agent_review.py` | 上輪14項對照、完成證據、來源差異、10張嵌入畫面；下一輪9候選與27條驗收可下載Markdown／所選JSON |

## Schema 與版本

本輪新增待辦檢閱、券商核對回條、公司行動證據／覆蓋資料表。新增配置研究回條與清掃歷程後，目前41表簽章為 `4e1f1eee546a88e99bfe65455c11516ab8b129d2e84bacd4c0c332f05895675b`。`backup_preflight.KNOWN_SCHEMAS`、遷移測試與歷史 fixture 的 drop 清單已一起更新；35／36／37／39／40表與09/20歷史版的相容性以測試證據為準。單標的重檢重用 jobs，不再加 schema。

新方法字串與端點登錄在 `docs/agent/project-map.md`。舊保存結果不覆寫、不冒用新方法版本；獨立研究工具不改 `alphaview-allocator-v1`、紙上執行規則或公司行動推算 v1。

## 驗收與斷點

各 worker 的主要主張由根代理重跑聚焦測試。實際瀏覽器包含390px、空值、重複點擊、重新整理、版本衝突與合成假券商失敗情境。五道關卡已執行並全部通過，根代理讀完完整輸出；記錄保存到 `gate-logs/`。

- `uv run --extra web --extra dev pytest -q`：1928 passed, 2 warnings in 69.56s (0:01:09)。
- `npm test --prefix web`：Tests  729 passed (729)。
- `npm run format:check --prefix web`：All matched files use Prettier code style!。
- `npm run build --prefix web`：✓ built in 1.42s。
- `git diff --check`：exit 0。

最終接續入口為 `state.json`、`events.jsonl`、`gates.json`、`STOP`、`source-manifest.json`、`source-checkpoint.zip` 與 `review.html#conclusion`。原始碼快照不是完整 checkout，也不是私人資料庫備份。未保存的使用者資料不在文件或測試中。

## 仍未交付

完整公司行動入帳、CPCV／PBO 與組合驗證閘、成交量衝擊執行模型、限價到期重訂、第二家券商與跨版本研究相容性仍需後續設計。這些不因本輪有相關研究工具而視為完成；逐項狀態以檢閱頁「上輪 Conclusion 逐項對照」為準。

這不是實盤就緒證明、投資建議或外部操作授權。本輪交付只到本機研究、模擬帳本與既有 Alpaca Paper 邊界。
