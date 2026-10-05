# 市場風險覆蓋（總曝險上限）

版本：`alphaview-regime-overlay-v1`。2026-10-01 Harness 依對標（FinRL-X 的 risk overlay、Lean `MaximumDrawdownPercentPortfolio`）新增：把市場風險溫度計（`alphaview-regime-v1`）接進 Agent 配置，成為**總投入權重上限**。入口：Agent 投資組合 → 配置與提案 → **市場風險覆蓋（總曝險上限）**。

## 規則

- 帳戶自行保存一份市場風險設定（基準、因子權重、五個手動總經讀數與日期）；面板可一鍵載入市場風險頁存在瀏覽器的設定，但以帳戶保存的版本為準。
- 最新完成交易日重算 `alphaview-regime-v1` 分數：手動讀數沿用 regime v1 口徑（過期標 `stale` 仍計入），技術因子權重 > 0 時讀本機基準日線，缺任何啟用因子就沒有分數。
- band → cap（v1 固定表，換表即升版）：

| band | 分數 | 總投入權重上限 |
| --- | --- | --- |
| calm | < 40 | 100% |
| watch | 40–59.99 | 80% |
| elevated | 60–79.99 | 60% |
| extreme | ≥ 80 | 40% |

- **block**：紙上預覽中，目標總投入權重 > 上限就是違規 `regime_exposure_cap`；例外是「減碼提案」——目標總權重低於帳戶目前已估值的投入權重時放行（仍可高於上限）。分數不可用 → 違規 `regime_unavailable`（fail closed）。所有走 `_build_preview` 的路徑（提案、接受時驗算、次日開盤、情境、執行層）一致。
- **scale**：自動化任務與「Agent run → 紙上」橋接在建立提案前，把目標乘以 `cap / 目標總權重`、向下取八位小數（總權重 ≤ 上限），證據記在 `agent_automation_attempts.result_json.regime_overlay`（cap、band、分數、縮放前後目標與總權重、regime 版本、交易日、行情 token）；提案 rationale 與嘗試 reason 附註縮放結果。分數不可用 → 不縮放，證據 `status=unavailable`、`warnings=["regime_overlay_unavailable"]`，reason 文字標示，不阻擋。
- 接受自動化提案時重新驗證：以儲存的 cap 重算縮放結果，與證據及提案目標不符即 409。
- 政策儲存在 `paper_circuit_breakers.policy_json` 內的 `regime_overlay` 物件（沒有 schema 變更），有自己的版本號；斷路器面板儲存不會覆蓋它，反之亦然。

## 這不是什麼

- 不是預測，也不是實盤指令；只把研究用的風險分數變成紙上限制。
- 不會自動賣出、不會把既有持倉降到上限以下；block 只擋新提案，scale 只縮 Agent 目標。
- 缺因子時不假設任何上限，不把權重挪給其他因子。
- 手動讀數是使用者輸入值，過期仍計入（regime v1 口徑）；要改成阻塞屬 regime 方法變更。
- 尚未把「band 變化」做成調倉觸發（`rebalance_trigger` 的 `regime_change`），列為下一輪。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/paper/accounts/{id}/regime-overlay` | 政策、版本、當日分數／band／cap、目前投入權重與狀態、caps 表（唯讀快照，附 `engine_version`、`as_of`、`input_revision`、`method`、`warnings`） |
| `PUT /api/paper/accounts/{id}/regime-overlay` | `{policy:{enabled, mode: block\|scale, regime:{benchmark, weights, inputs}}, expected_version}`；版本不符 409 `policy_changed` |

`POST /api/portfolio-agent/runs/{id}/paper-preview`／`paper-proposal` 回應多了 `regime_overlay` 證據。實作 `alphaview/panel/regime_overlay.py`；預覽 hook 在 `paper_portfolio._build_preview`；自動化在 `agent_automation._execute_locked` 與 `validate_source`；前端 `web/src/PortfolioRegimeOverlay.tsx`；測試 `tests/test_regime_overlay.py`、`web/src/PortfolioRegimeOverlay.test.tsx`（合成資料）。
