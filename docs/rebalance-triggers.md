# 自動化調倉門檻

自動化方法為 `alphaview-agent-automation-v2`，門檻計算方法為 `alphaview-rebalance-trigger-v1`。介面在 Agent 投資組合的「自動化任務」，新增任務或展開「調倉門檻與間隔」可設定。這是本機 paper 調倉頻率控制，不是報酬優化或市場風險預測。

## 政策與判斷

`rebalance_trigger` 有兩個可獨立停用的欄位；同時啟用時採 AND。

```json
{
  "min_weight_drift_pp": 5,
  "min_completed_sessions_between_fills": 3
}
```

- 偏離下限接受有限數字 0–100，單位為百分點。
- 間隔接受整數 1–252，單位為已完成 XNYS 交易日。
- `null` 明確停用該項。建立任務未指定政策時兩項均關閉，保留原先執行行為。
- PATCH 替換整個政策，必須同時提供兩個欄位；不接受省略其中一項或頂層 null。

偏離以目前持倉與完整目標的聯集加現金計算。未列入的現有持倉目標為零，目標現金為 100 減目標總權重；不重新分配。使用有效的最新完成日 USD raw close、精確股數及現金，將每項 `abs(100 × 部位價值 − 目標權重 × 總淨值)` 與 `門檻 × 總淨值` 直接比較。等於門檻即通過，不使用畫面四捨五入後的權重。

紀錄保存分子與分母字串；除法後的 `*_exact` 是 50 位有效數字 Decimal 顯示值，循環小數不因此成為數學上的有限精確值。

成交間隔來自同一任務、目前綁定帳戶的最新非零 `simulated_fill`，跨任務版本保留。後來手動接受的提案也算；沒有成交的空提案不重設間隔。next-open 採實際指定的 `execution_session`，不用訊號日期或記錄時間。週末及休市不計數；第一次成交不受間隔限制。超出所需視窗的久遠紀錄只回傳「至少已達所需日數」，不捏造精確天數。

## 市場風險變動門檻（`regime_change`，2026-10-01）

`rebalance_trigger` 的第三個欄位，可省略，預設關閉：

```json
{
  "min_weight_drift_pp": 5,
  "min_completed_sessions_between_fills": 3,
  "regime_change": {"enabled": true, "min_band_change": 1}
}
```

- 讀取此帳戶市場風險覆蓋面板保存的 `alphaview-regime-v1` 設定（基準、權重、手動總經讀數），在最新完成交易日重算分數與 band（calm／watch／elevated／extreme）。
- 與**此任務上一筆嘗試**記錄的 band 比較；變動階數 ≥ `min_band_change`（1–3）才通過。第一次評估只記錄基準（略過，`regime_baseline_recorded`）；未達階數略過（`regime_unchanged`）。
- 分數不完整（缺啟用因子）時整個門檻 **等待**（`regime_unavailable`），不占當日嘗試、不觸發、不略過；補齊讀數後同日可再評估。
- 與其他門檻一樣是 AND：啟用的門檻全部通過才建立提案。證據在 `result.rebalance_trigger.regime_change` 與 `checks` 的 `regime_change`。
- 舊任務保存的兩欄政策仍可載入，讀出時補上預設關閉的 `regime_change`；不是 schema 變更。

## 暫停帳戶的純減倉自動化（`alphaview-reduce-only-v1`）

斷路器政策勾選 `reduce_only_allowed` 後，帳戶暫停（kill switch）時自動化任務仍會評估，但目標被夾住：每個標的目標＝min(規則目標, 目前權重)，未持有的新標的略去，現金只增不減。夾住後沒有任何持倉需要減碼 → 記錄為 `skipped`／`reduce_only_no_change`（占當日嘗試、不建提案）；有減碼 → 建立 `risk_direction=reducing` 的提案，`proposal_only` 等待明確接受、`auto_simulate` 直接模擬。證據在 `result.reduce_only`（原始目標、閘後目標、精確目前權重、夾後目標、略去的標的），綁定提案時重新計算必須一致。

這不是什麼：已到期或需重新授權的任務仍先被擋下（`mandate_expired`／`mandate_reauth_required`）；風險斷路器**正在觸發**時仍 `circuit_breaker_tripped`（觸發會撤銷授權，出場請走手動接受的純減倉例外）；未勾選 `reduce_only_allowed` 的暫停帳戶行為不變（`paused`、不占嘗試）。

## Waiting、skipped 與 blocked

缺必要行情或估值、非正淨值、尚未完成的有效成交日會等待，不占當日執行機會。規則或 paper 風險限制失敗保持 blocked，不偽裝成門檻略過。

未達偏離／間隔，或啟用任一門檻後沒有符合執行政策的委託，會原子保存 `skipped`，包含原因及證據，不建立 paper 提案。略過占用本交易日；修改任務也不會再跑同日。兩門檻都關閉時不增加新的 no-change 略過語意。

執行前在寫入交易中重新核對帳戶、任務、來源、交易日、scan 與最後成交身份。狀態改變時重試等待，不能以過期估值取得當日執行權。v2 paper bridge 必須有 pass／disabled 的凍結證據及原始目標；skipped 的來源不能另組請求繞過。v1 歷史保留原版本，不改寫為 v2。

## API 與版本

既有 `/api/agent-automation/mandates` POST／PATCH 接受此政策；`/attempts` 的 `result.rebalance_trigger` 提供配置、coverage、偏離、成交日、交易日間隔與 checks。手動 run 也遵守門檻，沒有略過限制旗標。CLI 沿用 `automation-create`／`automation-update` JSON。

修改政策提升任務版本，舊版待審提案失效。帳戶允許標的政策另外綁定版本；其變更必須明確檢閱並替換 workflow 的 `account_context` 才重新授權。改名、門檻或 enabled 欄位不會自動重新授權。詳見 [允許標的政策](paper-symbol-policy.md)。
