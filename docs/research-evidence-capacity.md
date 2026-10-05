# 研究回條容量總覽

方法版本：`alphaview-research-evidence-capacity-v1`。這是目前儲存筆數的唯讀摘要。使用者按「讀取回條容量」才讀取，沒有背景輪詢。

`GET /api/paper/accounts/{account_id}/research-evidence-capacity` 在同一個 `@store.snapshot_read` 快照讀取帳戶版本、input revision、最新完成交易日及四類回條筆數。回條表只執行 `COUNT(*)`，不解碼或驗證 payload、不掃描研究、不讀行情或呼叫供應商，不執行 DDL 或寫入。每筆儲存紀錄都佔容量，損壞與無法驗證的紀錄也計入；完整性固定標為未評估。

| 回條家族 | 帳戶上限 | 全工作區上限 | 來源 |
| --- | --- | --- | --- |
| 配置研究 | 50 | 500 | `allocation_research_receipts.MAX_ACCOUNT / MAX_TOTAL` |
| 研究完整性診斷 | 不適用 | 500 | `research_integrity_receipts.MAX_TOTAL`；資料表沒有帳戶欄位 |
| 工作流程路徑研究 | 50 | 250 | `workflow_path_receipts.MAX_ACCOUNT / MAX_TOTAL` |
| 執行研究 | 50 | 250 | `execution_study_receipts.MAX_ACCOUNT / MAX_TOTAL` |

API 直接使用現有模組常數，不新增、重寫或放寬保存政策。每類回條有獨立的 `account` 與 `workspace` 物件，欄位為 `scope`、`count`、`limit`、`remaining`、`over_limit`、`reason`。已知零筆顯示 `0`；未知或不適用顯示 `—` 並列原因，不代換為零。研究完整性回條的帳戶欄位全部為 `null`，原因 `workspace_scoped_family`，全工作區筆數仍正常提供。剩餘筆數為 `max(0, limit - count)`；恰好滿額為剩餘 `0`，`over_limit` 只在實際筆數大於上限時為 `true`，不隱藏超限資料。

回應包含帳戶及快照上下文。前端 `ResearchEvidenceCapacity` 接受 `accountId/accountVersion/enabled/t`，核對回應綁定與完整四家族結構；切換帳戶、版本、停用或離開頁面會撤下舊結果並中止待處理讀取。重新讀取開始或出錯時清除舊摘要，避免把先前容量當成本次結果。按鈕僅讀取，沒有匯出、匯入、刪除或清理操作。

## 這不是什麼

容量總覽不是保存許可、回條完整性檢查、儲存位元組大小、備份還原或清理工具，也不判斷提案資格。剩餘名額不保證下一次保存成功；既有保存端點仍會在寫入交易內套用原本的來源、版本、大小與容量限制。匯出只複製回條，不騰出資料庫容量。
