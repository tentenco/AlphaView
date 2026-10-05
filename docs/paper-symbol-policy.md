# 本機 paper 允許標的政策

`alphaview-paper-symbol-policy-v1` 是獨立於 paper-v2 股數／成本計算的帳戶政策。它限制新增虛擬曝險，不是券商可交易清單、資產推薦或交易連線。

帳戶提供 `symbol_policy = {engine_version, version, mode, symbols}`。`unrestricted` 為既有帳戶預設，symbols 必須為空；`allowlist` 接受最多 100 個唯一股票代碼，轉大寫並排序。空 allowlist 明確禁止增加任何標的的股數。

## 操作與歷史

在「配置與提案」的允許標的政策區檢閱新增／移除項目再保存。PATCH `/api/paper/accounts/{id}/controls` 帶 `expected_version` 與完整 `{symbol_policy:{mode,symbols}}`。政策改變會提升帳戶版本及政策版本，追加 `paper_symbol_policy_history`；GET `/{id}/symbol-policy/history` 唯讀檢閱歷史。輪詢不覆蓋草稿；版本不同時需明確載入最新設定。

政策改回舊清單也屬新版本，不能使舊提案重新有效。既有初始 unrestricted 的舊 paper-v2 收據／next-open 指紋維持相容；新增政策不改寫歷史。實驗分支複製當時有效清單並建立新帳戶自己的政策歷史，不複製來源帳戶的授權身份。

## 共同限制

手動提案、規則 Agent、本機模型 bridge、情境比較及 next-open 共用政策驗證。清單外現有持倉可以維持或減少股數，不能增加；判定使用精度捨去及最低交易金額處理前的目標股數，避免微小增加被跳過委託後繞過限制。其餘現金、風險、資料、成本與完整估值要求仍適用。

規則 Agent 先建立原排序的固定席位，再排除不允許的標的。剩餘席位不增權重，不以較低順位補位；排除份額保留現金。若沒有有效配置仍保持 blocked，不能因此生成清倉提案。

## 工作流與自動化授權

帳戶工作流請求可帶：

```json
{"account_context":{"account_id":"synthetic-account","expected_policy_version":2}}
```

保存的 run 凍結完整政策；政策變更使來源過期，綁定的工作流不能 bridge 到另一帳戶。舊未綁定工作流仍由目前帳戶的 paper 檢查阻止不允許目標。保存提案時在寫入鎖內再驗政策，不能利用預览後政策變更通過。

任務公開 `symbol_policy_authorization`，包括已授權版本、目前政策及 current／stale。新版政策要以帶目前 `expected_policy_version` 的完整 workflow PATCH 明確採用。介面要求檢閱後勾選再套用；普通改名、門檻調整與啟用不會偷偷換綁。新任務清楚顯示即將採用的目前清單。

所有內容只影響本機 paper 工作區。沒有實盤下單、Alpaca 下單、行情下載或外部政策服務。
