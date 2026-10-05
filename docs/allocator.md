# 風險感知配置器（`alphaview-allocator-v1`）

2026-10-01 Harness 依對標缺口 #9（Lean RiskParity／MinimumVariance、PyPortfolioOpt、ai-hedge-fund 信念加權＋風險夾限）新增，第一版只做**對角**版本：每檔一個波動率、沒有共變異數、沒有最佳化套件。入口：Agent 投資組合 → 本機規則工作流 → 候選與配置限制 → **配置方法**。

## 方法

規則工作流照舊決定入選名單與席位：`slot = min((100 − 現金緩衝) / 最大持倉數, 單檔上限)`，向下取八位小數。配置器只決定**相同總投入**（`slot × 入選數`）如何分配：

| `allocation_method` | 原始權重 | 說明 |
| --- | --- | --- |
| `equal`（預設） | 每檔 `slot` | 與升版前完全相同，舊工作流與自動化模板沒有這個欄位時即為此方法 |
| `inverse_volatility` | ∝ 1/σ | 波動低的標的拿較多 |
| `score_tilt` | ∝ 共識分數 × 1/σ | 分數高且波動低的標的拿較多；分數必須為正 |

- σ 口徑：以工作流的 `as_of` 為最後一日，回看 `volatility_lookback_sessions`（20–120，預設 60）個交易日，用 N+1 個調整收盤算 N 個日對數報酬的樣本標準差，年化 √252，以百分比記錄。
- 單檔仍受 `max_position_weight_pct` 限制；超出上限的部分**留在現金**，不重分配給其他標的（`capped_to_cash_pct`）。現金緩衝檢查與其他風險檢查不變。
- 任一入選標的缺 σ（回看窗口內缺日線、價格非有限、波動為零、分數傾斜遇到非正分數）→ 整個配置 `unavailable`：不產生目標、工作流 `blocked`、阻擋原因 `allocation_unavailable` 列出標的與原因、警告 `allocation_unavailable：…`。**不回退等權**。
- 證據保存在工作流結果 `allocator`（方法、回看、席位、總投入、逐檔 σ／原始權重／上限後權重／原因）與配置角色的 `evidence.allocator`，都在 `proposal_fingerprint` 內；自動化的來源驗證以整份結果雜湊核對，證據被改動就 409。
- 紙上提案理由會標示「風險感知配置（方法，`alphaview-allocator-v1`）」。

## 這不是什麼

- 不是風險平價、最小變異數或均值變異數最佳化；不看相關性。
- 短回看的 σ 估計雜訊大；配置是假設情境，不是預期報酬或風險預測。
- 不改變入選名單、席位數、現金緩衝與單檔上限；也不會為了用滿預算而放大其他標的。
- `allocations` 比較以**目前**本機日線重算，不是保存當時的證據；只有工作流自身的方法能接續紙上提案。

## API 與設定

| 端點／欄位 | 說明 |
| --- | --- |
| `POST /api/portfolio-agent/preview`、`/runs` | `constraints.allocation_method`（`equal`／`inverse_volatility`／`score_tilt`）、`constraints.volatility_lookback_sessions`（20–120） |
| `POST /api/portfolio-agent/runs/{id}/allocations` | `{volatility_lookback_sessions?}` → 三種方法的目標、現金與證據並列（唯讀） |
| 自動化任務 `workflow.constraints` | 同欄位；舊模板缺欄位即 `equal` |

實作 `alphaview/panel/allocator.py`（`portfolio_agent.preview` 呼叫）；前端 `web/src/PortfolioAgentWorkflow.tsx`（表單與證據表）；測試 `tests/test_allocator.py`、`web/src/PortfolioAgentWorkflow.test.tsx`（合成資料）。

## 比較三種配置（前端）

保存的工作流在「候選與原因」上方提供「比較三種配置」按鈕（`web/src/PortfolioAgentWorkflow.tsx` 的 `AllocationComparison`），以目前草稿的回看交易日呼叫 `POST /api/portfolio-agent/runs/{id}/allocations`，把等權、反波動、分數傾斜的權重並列成矩陣（列＝標的，欄＝方法，另列 σ、上限超出留在現金後的現金權重與每個方法的狀態）。方法不可用時該欄顯示原因碼（如 `history_incomplete`），不顯示 0。它是以**目前**本機日線重算的假設情境，不是保存當時的證據，也不能直接接續紙上提案。

## 下載配置比較 CSV

比較結果出現後可按「下載配置比較 CSV」。下載只序列化畫面上的那次回應，不重算、不發出新的 API 請求。修改回看草稿後，CSV 仍使用已顯示結果的回看日數與輸入版本；要採用新草稿，先再次比較。切換帳戶、工作流、帳戶版本或重新整理歷程會清掉舊比較；未完成的請求會中止，遲到的回應不能重新帶回舊下載。

- 每個方法／標的一列，另以 `row_type=cash` 記錄各方法的現金權重；所有列包含 `export_kind=current_local_bars_what_if`、`engine_version`、`agent_run_id`、`as_of`、`input_revision`、工作流方法與比較回看日數。
- 保留原始數值精度、共識分數、年化 σ、原始／上限後權重、配置器方法版本與狀態、投入預算及上限超出現金。不可用方法不匯出目標權重；空值與非有限數值留空，實際的 0 仍為 0。
- `reason_code`／`reason_message` 方便篩選；`reason_details` 與 `unavailable_reasons` 保留 JSON 證據，包含服務端提供的缺日數、要求日數與第一個缺值日期。方法說明與研究限制也保留在 CSV。
- UTF-8 BOM、CRLF 換行與雙引號跳脫供試算表開啟；可能被當成公式的文字加前置單引號。檔名僅保留英數、底線與連字號。

這不是交易指令、券商匯入檔、保存工作流當時的配置證據或新的配置方法。CSV 只保存這次本機比較；現有配置計算與 `alphaview-allocator-v1` 方法語意不變。實作：`web/src/allocation-comparison-csv.ts`；測試只使用合成比較資料。
