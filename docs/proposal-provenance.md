# 提案來源與閘門標籤（proposal provenance）

版本：`alphaview-proposal-provenance-v1`（2026-10-01 Harness）。每份虛擬帳戶提案在 API 回傳時附上 `provenance: {source, tags}`，讓提案卡片與審閱面板說明「這份提案是誰、經過哪些閘門」。這是**讀取時推導**的檢視欄位，不寫入 `preview_json`，不影響提案指紋與回放核對。

## 來源（source）

只依既有欄位判定，不猜測：

| 值 | 證據 |
| --- | --- |
| `automation` | `automation_source`（本機自動化任務） |
| `jev` | `jev_source`（Jev 決策閘橋接） |
| `local_agent` | `local_agent_source`（本機模型分析） |
| `position_stops` | rationale 以 `Position stops alphaview-position-stops-v…` 開頭 |
| `strategy_bridge` | rationale 以 `Research Desk 策略` 開頭（策略→紙上橋接） |
| `rules_workflow` | rationale 以 `本機規則 Agent run` 開頭但沒有 `automation_source`（工作流頁手動接續） |
| `manual` | 以上皆無 |

## 標籤（tags）

每個標籤只在對應證據存在時出現：

- `jev_gate`：rationale 含「目標已經 Jev 決策閘過濾」，或來源為 `jev`。
- `regime_overlay:scale`：rationale 含 `市場風險覆蓋 alphaview-regime-overlay-v…：`（目標已縮放）；`regime_overlay:block`：預覽違規含 `regime_exposure_cap` 或 `regime_unavailable`。
- `reduce_only`：rationale 含 `純減倉模式 alphaview-reduce-only-v…`。
- `allocator:<method>`：rationale 的「風險感知配置（method，…）」或「固定配置」（`equal`）。
- `validation:<gate>`：rationale 結尾的 `validation={…}` 的 `gate`（pass／warn／overridden／blocked）或 `validation=off`。
- `position_stop`：部位停損提案。
- `corporate_action_notice`：預覽 `notices` 含 `corporate_action_since_entry`。
- `execution:alpaca_paper`：提案狀態為 `submitted_external`。

## 這不是什麼

- 不是審計軌跡：標籤來自既有 rationale 與欄位的字串證據，缺少標記的舊提案會顯示較少標籤，不會補猜。
- 不改變任何提案語意、指紋或接受流程；只是檢視。
- 每日報告的 `provenance_counts` 以提案的 `as_of` 歸屬交易日，不是建立時間。

實作 `paper_portfolio.provenance`、`agent_report._provenance_counts`；前端 `AgentPortfolio.tsx`（卡片標籤與「為什麼是這份提案」）；測試 `tests/test_proposal_provenance.py`。
