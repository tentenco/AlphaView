# 部位停損與追蹤停損

版本：`alphaview-position-stops-v1`。2026-10-01 Harness 依對標（FinRL-Trading 的絕對停損／追蹤停損／再進場冷卻）新增。入口：Agent 投資組合 → 配置與提案 → **部位停損與追蹤停損**。

## 規則

對每個虛擬持倉在最新完成交易日評估：

- 平均成本 = 成本基礎 ÷ 股數（含當時手續費）。
- 進場日 = 讓該部位由零轉正的最後一次成交所屬提案的 `as_of`；沒有這種紀錄（例如分支開帳）時進場日未知。
- 峰值 = 進場日之後（不含）到當日（含）的最高本機原始收盤。
- `stop_loss`：收盤 ≤ 平均成本 ×（1 − stop_loss_pct/100）。
- `trailing_stop`：峰值高於平均成本，且收盤 ≤ 峰值 ×（1 − trailing_stop_pct/100）。
- 當期價格缺失、進場日未知或峰值不可用 → 該檢查 `unavailable`，不觸發。

觸發後可「建立停損提案」：其他持倉維持目前權重（市值 ÷ 淨值，向下取八位小數），觸發的標的目標為零；任何持倉缺價則拒絕建立（不用舊價）。提案仍需明確接受。建立提案時同時記錄冷卻期（第 N 個之後的交易日）；冷卻期內，任何會在該標的**新建倉**的目標在紙上預覽都是 `stop_cooldown` 違規；可在面板手動移除。

## 這不是什麼

- 不是盤中停損，也不自動賣出；跳空會使實際虧損大於設定。
- 追蹤停損只看本機日線的收盤峰值；沒有進場紀錄就不可用。
- 冷卻在建立提案時記錄，拒絕提案不會自動解除。
- 停損不會傳給 Alpaca；Alpaca 的委託仍由執行層逐筆確認。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/paper/accounts/{id}/position-stops` | 政策、版本、逐持倉評估、冷卻清單（唯讀快照） |
| `PUT /api/paper/accounts/{id}/position-stops` | `{policy:{enabled, stop_loss_pct?, trailing_stop_pct?, cooldown_sessions}, expected_version}` |
| `POST /api/paper/accounts/{id}/position-stops/proposal` | `{expected_account_version, idempotency_key}`；有觸發才建立（否則 409） |
| `DELETE /api/paper/accounts/{id}/position-stops/cooldowns/{symbol}` | 移除冷卻 |

實作 `alphaview/panel/position_stops.py`；紙上預覽的冷卻檢查在 `paper_portfolio._build_preview`；前端 `web/src/PortfolioPositionStops.tsx`；測試 `tests/test_position_stops.py`、`web/src/PortfolioPositionStops.test.tsx`（合成資料）。
