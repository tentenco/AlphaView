# Trading Agent Harness 接手文件（2026-10-01）

本文件是 2026-10-01 五小時 Trading Agent Harness（`artifacts/harness-2026-10-01-trading-agent/`，含 `state.json`、`events.jsonl`、`benchmark.json`、`gates.json`、`review.html`、`STOP`、`source-checkpoint.zip`）的接手摘要。使用者以 `/goal` 授權兩個方向：對標 GitHub 熱門同類專案並逐步導入高價值功能；朝可自動調倉交易的 Trading Agent 產品前進。範圍仍然只到 **paper**（本機模擬帳本與 Alpaca Paper），沒有實盤、沒有公開部署、不承諾獲利。

## 工作方式

- 主 Agent 負責整合、文件、schema 簽章與驗收；以 fork 子代理平行開發獨立單元（本輪 A、B、C、D、E、F、G、H、I、J、K、L、M），每個單元自己的測試綠燈後回報，由主 Agent 合併文件並記錄 `events.jsonl`。
- 06:27–07:12 因速率限制中斷（已記錄於 `state.json.interruptions`，期限順延 2700 秒至 11:57:05+08:00）。
- 中途一次全套回歸（pytest 1435 通過、vitest 360 通過）發現並修正一個 byte-identical 回放測試對附加中繼資料 `risk_direction` 的假設。

## 交付清單（依方法版本）

| 單元 | 方法版本 | 位置 |
| --- | --- | --- |
| 執行層：本機帳本／Alpaca Paper 委託、上限、核對、取消、背景核對 | `alphaview-execution-v1`、`alphaview-alpaca-paper-orders-v1` | `execution.py`、`alpaca_paper.py`、`PortfolioTradingAgent.tsx`、`docs/execution.md` |
| 委託型態：市價／限價帶、終態部分成交、待辦委託事件 | （執行層附加） | `execution.limit_price`、`portfolio_inbox.py`、`PortfolioInbox.tsx` |
| 風險斷路器＋純減倉例外 | `alphaview-circuit-breaker-v1` | `circuit_breakers.py`、`docs/circuit-breakers.md` |
| 部位停損／追蹤停損／冷卻 | `alphaview-position-stops-v1` | `position_stops.py`、`docs/position-stops.md` |
| 市場風險覆蓋（總曝險上限） | `alphaview-regime-overlay-v1` | `regime_overlay.py`、`docs/regime-overlay.md` |
| 每日 Agent 報告 | `alphaview-agent-report-v1` | `agent_report.py`、`docs/agent-report.md` |
| 決策結果帳本與 Jev 校準 | `alphaview-decision-outcome-v1` | `decision_ledger.py`、`docs/decision-outcomes.md` |
| 策略→紙上橋接 | `alphaview-strategy-bridge-v1` | `strategy_bridge.py`、`docs/strategy-bridge.md` |
| 策略驗證閘 | `alphaview-validation-v1` | `research_validation.py`、`docs/research-desk.md` |
| 進階績效指標 | `alphaview-paper-metrics-v1` | `paper_metrics.py`、`docs/agent-portfolio.md` |
| 風險感知配置器 | `alphaview-allocator-v1` | `allocator.py`、`docs/allocator.md` |
| 無人值守就緒閘 | `alphaview-readiness-v1` | `readiness.py`、`docs/readiness.md` |
| 任務授權生命週期（到期、重新授權） | （自動化附加；schema 簽章 `9f8db7b3…`） | `agent_automation.py`、`docs/mandate-lifecycle.md` |
| 帳簿核對（Alpaca） | `alphaview-book-reconciliation-v1` | `broker_reconciliation.py`、`docs/book-reconciliation.md` |
| 公司行動偵測 | `alphaview-corporate-actions-v1` | `corporate_actions.py`、`docs/corporate-actions.md` |
| 自動化：mandate Jev 門檻、執行目標、regime_change 觸發、純減倉自動化 | （自動化附加） | `agent_automation.py`、`rebalance_trigger.py`、`docs/rebalance-triggers.md` |
| 對標報告 | `alphaview-github-benchmark-v2` | `docs/github-trading-agent-benchmark-2026-10-01.md`、`benchmark.json` |
| 運作手冊 | — | `docs/paper-operations-runbook.md` |

每個單元都有「這不是什麼」段落；缺資料一律不可用、不退回預設；版本字串已登錄在 `docs/agent/project-map.md`（2026-10-02 起由 `CLAUDE.md` 搬移）。

## 驗收

五道關卡在停止前各跑一次，結果在 `artifacts/harness-2026-10-01-trading-agent/gates.json` 與 `review.html` 的「驗收」區；數字以該檔為準。

## 風險與限制

- 所有 Alpaca 動作只對 Paper 主機；測試用假券商，從未對使用者的 Alpaca 帳戶送出真實 paper 委託。
- 多個 fork 平行修改 `api.py`、`paper_portfolio.py`、`circuit_breakers.py`，合併後靠全套測試驗證；若接手時發現行為不一致，先看 `events.jsonl` 的單元順序。
- `data/` 內的私人資料（持股、金鑰）未被任何單元讀取或寫入；文件與測試只有合成資料。
- Harness 期間預覽伺服器（8876）曾因 2 小時上限停止；停止前以新建置重啟一次。

## 下一輪

見 `state.json.next_tasks` 與 `review.html` 的「下一輪」區。
