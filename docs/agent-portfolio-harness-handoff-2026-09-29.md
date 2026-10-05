# 2026-09-29 Agent Portfolio Harness 交接

本輪依使用者要求，從 09/20 的 `review.html` 接續五小時 Harness，採動態子代理分工、交叉審查、隔離合成驗收。**目前仍在計時與長測中；本文件不是五小時完成證明。** 最終時間與驗收以 `artifacts/harness-2026-09-29-agent-continuation/state.json`、`events.jsonl` 及各次原始 log 為準。

時間盒：2026-09-29 21:46:48 至 2026-09-30 02:46:48（Asia/Taipei）。前一輪曾因用量中斷，不能把前一輪或本輪的等待時間稱為持續人工開發時間。長測分列 wall time、實際檢查時間、等待時間與失敗數。

## 接續範圍與交付

| 09/20 建議 | 本輪已實作範圍 | 限制 |
| --- | --- | --- |
| 配置偏離與調倉間隔 | `automation-v2`、獨立 `rebalance-trigger-v1`，包含現金的配置偏離、實際成交交易日 cooldown、原子 skipped 與 v1 歷史相容；介面可編輯與檢閱決策 | 缺資料等待不占日次數；已 skipped 不會因改任務而同日重跑 |
| 版本化允許標的清單 | 共用帳戶政策與歷史、精度處理前阻擋增加清單外股數、Agent 原席位不補位、來源綁定與明確重新授權 | 舊持倉可維持／減少，但資料、成本及其他風險限制仍適用 |
| 可處理待辦 | next-open 獨立分頁、完整嘗試次數、精確物件導覽、取消／完成收據、過期詳細資料禁操作 | 沒有批次接受或自動開啟排程 |
| 固定股票池歷史回放 | 可檢閱設計與純 `evaluate_prefix` R0：raw 前綴裁切、訊號、品質、覆蓋、RPS peers、版本化指紋 | 未實作 R1 帳本、配置迴圈、績效或 replay API；不宣稱 point-in-time 來源 |
| 純本機 execution adapter | 合成單筆委託 reducer、preview/save/inspect CLI、不可覆寫 artifacts 收據；未知結果須核對，不盲重送 | 沒有 transport、broker、runtime API、資料庫或 UI；不改現行 paper 帳本 |

方法與操作： [調倉門檻](rebalance-triggers.md)、[標的政策](paper-symbol-policy.md)、[歷史前綴](paper-replay-design.md)、[純合成執行](local-execution-adapter.md)。

## 動態工作分配

第一波由三個子代理分別負責 trigger、allowlist 與 inbox，主代理整合介面、政策授權、schema 與瀏覽器驗收。各單位完成後切换到交叉審查，再分別承接長測工具、純 dry-run、R0 前綴與遷移相容性。共享工作樹，保留所有既有未提交內容。

審查與主路徑修正包括：任務切換後的模擬同意、policy review checkbox 失效、輪詢請求重疊、精確歷史 workflow／queue 選取、跨帳戶導覽時的名稱同步、狀態列文字對比與配置明細鍵盤捲動。R0 額外修復非字串日期、超大整數與沒有原始欄位時的列數／指紋身份。dry-run 額外修復大型 JSON 整數造成非結構化 traceback 的情況。

## 驗收與證據

整合 R0 邊界與 populated migration 後：Python 全套 **1,292 passed／63.78 秒**，Vitest **318 passed／56 檔**；format、build、`git diff --check` 均 exit 0。驗收來源已存於 `validated-source/source-manifest.json`，包含 112 個變更來源檔。原始失敗與修復 log 均保留，不覆寫歷史證據。

- R0 focused prefix／indicator：57 passed。50 檔 × 1,759 sessions，共 87,950 筆合成日線，20 階段的獨立裁切、未來新增／刪除／修改與 dtype 擾動完全一致；34.006 秒，最慢階段 3.271 秒。修復後最大前綴 fingerprint 再次一致。這不是 500,000 筆有效歷史的測量。
- dry-run focused：89 passed。實際 CLI preview → exclusive save → inspect 走通，unknown 與 reconcile 後的 cancelled 分開保存；內容 hash 另以標準庫重算核對。
- populated migration：5 tests 通過。實際舊程式產生的合成帳戶、已成交／待審提案、ledger、pending next-open、fork origin 與冪等回應在升級後保持原指紋，且舊委託只成交一次。來源 hash 保存在測試，測試不依賴 gitignored artifacts。
- schema：獨立舊來源初始化的 schema-only fixture 與 current fresh／upgrade 比對一致；26 表 fingerprint `7c2b901a7ef5ea270f6a4824e1fcbd7b7758c7867af54f1a6200b61b1c4265cc`，前一版標示 migration_required。重啟不改原 input revision identity／counters。
- 瀏覽器：隔離合成 DB 的 8879 工作區完成政策、門檻 skipped、政策重新授權、精確委託取消及終態禁操作。英文桌面展開調倉明細、390px 深色政策頁 Axe 均為 0 violations／0 incomplete。手機寬表內部捲動的遮蔽內容曾無法自動判定，已另在桌面檢查。
- HTML：本機靜態 8878；anchor 與證據檔案存在、沒有外部資源載入。瀏覽器匯出下一輪任務的 source 正確指向本輪；匯出 smoke notes 為合成測試，沒有新增使用者任務。

兩條長測使用凍結來源、封鎖網路、隔離合成資料：`paper-soak-main` 是持續 worker 每輪新 DB，驗證 varied seed 的政策／調倉／委託／只讀不變量與跨程序政策競態；`revision-soak-main` 使用同一 DB 驗證跨程序 snapshot、rollback、crash、commit 與重新初始化。前者不能當成同庫持久性證據；後者沒有驗證真實使用者資料庫。截止前保留安全收束時間。

## 下一輪候選

1. 先審閱 R1 capture／plan 與純配置核心的邊界，再決定是否實作獨立歷史會計；不能把現行 scanner、clock 或已授權 next-open queue 改日期重用。
2. 若需要產品介面檢閱 dry-run，先定只讀 receipt viewer；任何 runtime 保存、帳戶連結、批次委託或外部 adapter 都另立版本與驗收。
3. 以量測決定是否分割 Agent workspace 前端 chunk，保留現有 routing、草稿與政策授權狀態；目前 build 的 >500kB 警告不是本輪新失敗。

沒有 commit、stash、reset、push、部署、外部訂單或付費 provider 呼叫。未讀取真實持股、成本、筆記、備份或憑證。8877 未操作；8879 僅為本輪合成示範。
