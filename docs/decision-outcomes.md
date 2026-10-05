# 決策結果帳本（Decision outcome ledger）

版本：`alphaview-decision-outcome-v1`。2026-10-01 Harness 依對標（TradingAgents `memory/settlement.py` 只在持有窗口走完後結算決策；Lean `InsightScore`；qlib IC 報告）新增。入口：Agent 投資組合 → 交易代理分頁 → **決策結果帳本**。只讀既有資料表，沒有新 schema，也不呼叫 Jev。

## 口徑

- **結算時點**：決策交易日之後必須已完成 N 個 XNYS 交易日（N = 5／10／20，由 `sessions.expected_sessions` 判定）才結算；不足的列為 `pending`，永遠不提前計分。
- **價格**：進場＝決策日之後第一個交易日的調整開盤（`open × adj_close ÷ close`），出場＝第 N 個交易日的調整收盤；報酬＝出場 ÷ 進場 − 1。與回測「前日收盤訊號、次日開盤成交」一致。任一根日線缺失或非有限值 → 該決策 `unavailable` 並附原因，不用鄰近價填補。
- **超額**：減去 `SPY` 同一進出場交易日的報酬；本機沒有 SPY 日線時超額為不可用（`benchmark_unavailable`），不改用其他基準。
- **命中**：做多決策（訊號、新增、加碼、通過門檻、紙上買進）以正報酬為命中；減碼／移除／未通過／賣出以負報酬（避開虧損）為命中；零報酬不算命中。
- **窗口**：只納入最近 `window_sessions`（預設 60，5–252）個交易日內的決策。
- 任何統計的已結算樣本少於 5 筆都標 `low_sample`。

## 決策家族

| 家族 | 來源 | 決策單位 |
| --- | --- | --- |
| `scan_signals` | `scans`（同日同範圍只取最後一筆快照；`date` 不等於 `as_of` 的過期列不算） | 每個 `status=match` 的（交易日、標的、策略） |
| `agent_targets` | `portfolio_agent_runs`（`status=proposed`；同日同範圍只取最後一次） | 與前一次同範圍目標比較：新增、加碼、減碼、移除（前一次可在窗口之前） |
| `jev_gate` | `jev_decision_runs`（同日同標的只取最後一次） | 每個標的的門檻結果：通過（做多）、未通過（歸零＝出場）、不可用（不計命中） |
| `paper_fills` | `paper_ledger` 的 `simulated_fill`（需指定 `account_id`） | 每筆買進／賣出，決策日＝提案的 `as_of` |

## Jev 機率校準

只對能以後續日線機械判定的問題校準，把答案分成五個等寬機率區間，列出每區間的 N、平均預測機率與實現頻率，並計算 Brier 分數與整體實現率：

| 問題 | 實現事件（程式定義的代理事件） |
| --- | --- |
| `overextended` | 地平線內前向報酬為負（回檔） |
| `uptrend_intact` | 期末交易日的調整收盤 > MA50 > MA200（需 200 根本機日線，不足則 `history_insufficient`） |

`buying_pressure`（描述當下狀態，沒有未來事件）與 `setup_quality`（等級分數，不是事件機率）列為不可校準並附理由；問題集新增的問題會自動列為不可校準，直到定義實現條件。

## 這不是什麼

- 不是實盤績效紀錄：沒有成交、費用、滑價、部位大小，也不是回測。
- 分母只含本機股池仍有日線的標的，有存活者偏差；下市或移出股池的決策會消失。
- 樣本小時命中率、平均報酬、校準區間與 Brier 都不穩定。
- 代理事件不是模型被問的原句；校準只衡量代理事件，不能證明決策閘可靠。
- 不是投資建議。帳本端點只讀；自動化 v3 會另用下述固定口徑決定本輪是否需要人工審閱，不修改目標權重、Jev 門檻或任務授權。

## 自動化結果證據與人工審閱

`alphaview-agent-automation-v3` 使用 `alphaview-automation-outcome-guard-v1`：最近 252 個交易日內、10 個交易日結算期的來源家族，只要至少 20 筆已結算且命中率**低於** 40%，本輪從 `auto_simulate` 降為 `proposal_only`。19 筆不觸發；20 筆且恰好 40% 也不觸發。帳本本身的計算口徑仍為 `alphaview-decision-outcome-v1`。

- `agent_targets` 永遠相關；`jev_gate` 僅在這項任務啟用 Jev 決策閘時相關。任一相關家族偏低便要求審閱，另一家族較佳不會抵銷。這是**工作區來源家族**統計，沒有宣稱是個別策略、模型或單一任務的命中率。
- 只有有限且一致的證據可判斷低命中率。正常的已結算樣本不足維持原模式；缺失、非有限值、方法或交易日不符、評估失敗則另標 `unavailable`／`outcome_evidence_unavailable`，也要求審閱，但不標成 `low`，不補造命中率。
- 結果在取得當日執行權的 `BEGIN IMMEDIATE` 交易內只計算一次，綁定規則工作流、交易日、`input_revision`、帳戶及版本，保存於 `attempt.result.outcome_guard`；後續 Jev 閘、限制失敗、提案與成交結果保留同一份證據。輸入變更仍由原有快照檢查拒絕整筆發布。
- 降級後，仍需通過原有 Jev 決策閘與風險檢查才建立提案。它不自動接受、不呼叫 Alpaca Paper 執行層，也不跳過付費閘或回退到未過濾目標；測試全部使用假服務。
- `mode`、`enabled`、到期日與 `reauth_required` 都保留任務原設定。只有本輪嘗試的有效模式改變；同一交易日不重跑，續期也不能重設名額。下一交易日重新取得證據。
- 使用者可以明確接受保存的人工審閱提案；接受時重驗凍結證據的綁定與分類，並保留版本、授權、資料與風險守衛，不重算新的歷史樣本。v1／v2 舊嘗試沿用原有接受語意。

任務卡片與歷史列顯示本輪原因、相關家族、已結算數、命中率、結算期與樣本門檻。沒有命中率時顯示 `—`。這項功能不是績效保證，也不會自動恢復已過期或收回的授權。

## API

`GET /api/trading-agent/outcomes?account_id=&horizon_sessions=10&window_sessions=60`（`@store.snapshot_read` 唯讀；`horizon_sessions` 只接受 5／10／20，其餘 422；`account_id` 可省略，未知帳戶 404）。回傳 `engine_version`、`as_of`、`input_revision`、`window`、`price_basis`、`benchmark`、`families[].groups[]`（`n`、`n_settled`、`n_pending`、`n_unavailable`、`hit_rate`、`mean_return_pct`、`mean_excess_pct`、`excess_coverage`、`low_sample`、`reason`）、`calibration`（`questions[]` 含 `bins`、`brier`、`base_rate`、`unavailable`；`unscorable[]`）、`items[]`（最多 500 筆逐決策結果）、`method`、`warnings`。

實作 `alphaview/panel/decision_ledger.py`；前端 `web/src/AgentDecisionOutcomes.tsx`；測試 `tests/test_decision_ledger.py`、`web/src/AgentDecisionOutcomes.test.tsx`（合成資料）。

## 逐筆 CSV 與設定品質分數相關

- `GET /api/trading-agent/outcomes.csv?account_id=&horizon_sessions=&window_sessions=`：與 JSON 相同的查詢參數，一列一個決策（不受 JSON 的 500 筆上限影響）。欄位：家族、決策、標的、決策交易日、方向、地平線、進／出場交易日、狀態、原始報酬、基準與基準報酬、超額與不可用原因、命中、權重前後（規則工作流）、各可校準 Jev 問題的預測機率與實現旗標、`setup_quality` 分數、來源、引擎版本與 `input_revision`。待結算與不可用的列保留空白數值，不是 0；以 `=`、`+`、`-`、`@` 開頭的字串前置 `'` 防止試算表公式；回應為 `attachment` 且 `Cache-Control: no-store`。
- `calibration.score_correlation`：Jev `setup_quality` 分數與地平線實現報酬的 Spearman 等級相關（同分取平均名次），只用已結算的 Jev 決策；N 少於 10 標示 `low_sample`；紀錄中沒有分數為 `question_absent`，已結算少於 2 筆為 `insufficient_settled`，無變異為 `no_variance`。它衡量排序一致性，不是報酬預測。
- `items[]` 的 Jev 決策另附 `realizations`（每個可校準問題的實現旗標與原因）與 `setup_quality_score`。
