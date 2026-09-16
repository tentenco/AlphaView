# AlphaView：Claude Code → OpenAI Codex 接手文件

查核日期：2026-09-16。本次任務是整理可繼承的專案知識與開發起點，未啟動歷史提案中的產品功能。使用者另已要求 `github commit and push all`，依 FIFO 在交接分析交付後執行；這不授權部署、付費資料源、通知或資料庫還原。

## 1. 接手結論與資訊優先序

Codex 可以透過版本庫文件接手，不必取得 Claude 的完整對話。`AGENTS.md` 是入口，`CLAUDE.md` 保留為兩個 Agent 共用的規則來源；本文件補上經程式核對的實作狀態與待辦差異，避免維護另一份重複的規則全集。

本次證據是 repository 文件、目前程式、Git 狀態與重新執行的驗收。沒有讀取 Claude 私有對話、實際持股／筆記或真實備份內容；舊文件提到的行情數字及恢復事故屬歷史紀錄，未在本輪重新驗證。

閱讀與判斷順序：

1. 當次使用者指示、`AGENTS.md`、`CLAUDE.md`：確定授權與不可破壞的約束。
2. 本文件：辨認已交付、部分完成、尚未開發，以及下一個可交辦單位。
3. `README.md`、`WEB_PANEL.md`、`LOCAL_SETUP.md`：產品流程、操作與環境。
4. 當次變更涉及的專題文件與程式／測試：核對真正行為。
5. 舊 handoff、Harness state／receipts、`next-harness-*`：追查決策來源；日期較舊的清單不自動成為現在的待辦。

文件與程式不一致時記錄落差，不把已有程式視為所有提案驗收已完成，也不為迎合舊規劃重寫功能。若需要讀取 `artifacts/` 的歷史證據，僅在本機查看必要項目，不把其中私人內容寫入文件或記憶。

## 2. 產品與資料流

AlphaView 是本機、單一使用者、美股日線研究工作區。主要開發範圍是 `alphaview/panel/` 與 `web/src/`。`main.py` 與 `alphaview/{core,data,strategy,notify}` 是獨立 A 股 CLI；其資料庫、`.env` 與飛書路徑不屬於 Web 面板。

```text
Yahoo / yfinance
  → market.py：標的身份、完成交易日、OHLC／調整價與品質驗證
  → store.py：SQLite、本機行情、輸入 revision
  → research.py：指標、四策略、掃描、單股回測
  → scan_provenance.py / scan_context.py：引擎＋輸入版本與有效性
  → api.py / 獨立研究 router
  → App.tsx：Alpha Picks、Alpha Lab、持股、比較、市場概況、資料管理

市場風險：瀏覽器手動總經讀數＋本機基準 ETF 日線
  → POST /api/market/regime → 逐因子狀態與綜合分數
```

研究 GET／POST 的讀寫性質由實作決定：回放、組合實驗、持倉相關性、風險溫度計的 POST 都是唯讀計算；`POST /api/jobs` 的 `scan_all` 會寫入兩個股票池的掃描，但不下載行情。不要用 HTTP method 推斷是否會更新資料。

| 責任 | 程式入口 | 方法／驗收入口 |
| --- | --- | --- |
| SQLite、讀取快照、輸入變更、寫入鎖 | `store.py`、`locking.py`、`jobs.py` | `tests/test_read_snapshot_reports.py`、`test_polling_revisions.py`、`test_scan_job_coverage.py` |
| 日線擷取與缺值／身份判定 | `market.py`、`sessions.py` | `docs/data-provider-evaluation.md`、`tests/test_universe_metadata_validation.py`、`test_sessions.py` |
| 指標／掃描與回測 | `research.py`、`scan_provenance.py`、`scan_context.py` | `docs/scan-provenance.md`、`tests/test_indicator_audit.py`、`test_research_metamorphic.py` |
| Alpha 排名與歷史實驗 | `web/src/alpha-model.ts`、`alpha_replay.py`、`alpha_basket.py`、`holding_fit.py` | `docs/alpha-research.md`、相應 `test_alpha_*`／`test_holding_fit.py` |
| 市場風險溫度計 | `market_regime.py`、`web/src/MarketRegime.tsx`、`market-regime.ts` | `docs/market-regime.md`、後端與前端同名測試 |
| 備份與唯讀預檢 | `backups.py`、`backup_preflight.py`、`scripts/check_backup.py` | `docs/backup-preflight.md`、`tests/test_backup_preflight.py` |
| 研究追蹤／收藏／匯入 | `web/src/research-tracker.ts`、`comparison-bookmarks.ts`、`alpha-transfer.ts` | `docs/alpha-research.md`、相應前端測試 |
| 互動、字級、翻譯 | `web/src/App.tsx`、`styles.css`、`locale.tsx` | `docs/alpha-ux-decisions.md`；新文案檢查繁中與英文，版面檢查 390px |

表內未加目錄的後端模組均位於 `alphaview/panel/`。

## 3. 已實作與尚未完成的差別

| 項目 | 09-16 查核結論 | 接手時注意 |
| --- | --- | --- |
| Alpha Picks、權重方案、篩選、提醒、研究摘要 | 已有實作與測試 | 不重建首頁；Alpha 是規則共識，不是預期報酬 |
| Alpha 回放／組合實驗／候選持倉相關性 | 已註冊 API 與前端 | 目前股票池的歷史研究，不是實際帳戶績效；組合基準是初始同一籃子，不是 SPY |
| yfinance lazy metadata 相容、`scan_all`、字級調整 | 已在工作樹 | 保留既有變更；`scan_all` 允許各股票池完整批次獨立成功，不能把部分成功誤報成全失敗 |
| Claude 的市場風險溫度計 v1 | 已掛到市場概況、具 API 與測試 | 不再列為待開發；首頁／提醒整合、設定搬家仍待辦 |
| 研究階段與複查日期／ICS | 已有瀏覽器版本 | 追蹤在 localStorage，草稿在 sessionStorage；並非工作區 DB 同步或財報行事曆 |
| 比較收藏 | 已有瀏覽器版本 | 保留明確載入與重算；舊 P2-B 的 DB 持久化及完整改名／衝突契約仍需逐項審查 |
| 工作區 ZIP 備份與預檢 | 已完成匯出、唯讀驗證與已知 schema 辨識 | `restored: false`；沒有可用的正式恢復流程 |
| 隔離 ZIP 恢復（P1-A/B/C） | 尚未實作 | 09-15 手動恢復不代表已交付可重用工具 |
| raw／repair 版本審閱與採用 | 只有隔離診斷，沒有正式版本選擇／採用 | 不能把 repair 通過結構驗證視為價格正確；不能直接寫入現用日線 |
| 有預算的分類重試／第二供應者 | 已有手動 retry、resume、cancel；後續政策與 adapter 未交付 | 不重做現有重試按鈕；新來源與付費呼叫另定範圍 |
| 外部市場績效基準 | 尚未完成獨立驗證與掛接 | 風險技術因子讀取 VOO／SPY／QQQ 不等於已有經驗證的大盤回測基準 |
| 交易／現金流帳本、歷史全市場成分、財報事件來源 | 尚未實作 | 不能從當前股數／成本倒推帳本；研究複查 ICS 也不代表財報日曆 |

## 4. 儲存與啟動時容易誤解的地方

- SQLite 保存行情、持股、詳細研究筆記與工作區狀態。瀏覽器研究 JSON 是另一種匯出，不能代替 DB 備份；瀏覽器存放的個人研究內容同樣不得進 Git 或可分享報告。
- `alpha-transfer.ts` 包含 Alpha 權重、追蹤、比較收藏等 allowlist。市場風險設定使用 `alphaview-market-regime-v1`，尚未納入該匯出，也不在工作區 ZIP 中。單一備份不能宣稱還原完整 UI 狀態。
- `store.ROOT` 取自模組檔案路徑；未設定 `PANEL_DB_PATH` 時，DB 預設路徑固定在 checkout 的 `data/panel.db`，**單純改 cwd 不會改變這個預設**。相對 `PANEL_DB_PATH`、另一份 checkout／套件位置則需另外核對。舊 handoff 的 cwd 猜測不能當成空庫事故根因。
- `serve` 會執行 `init_db()`，API lifespan 也會初始化、回收中斷作業並啟動 scheduler。開服務不只是唯讀檢查；開發驗收先用獨立 `PANEL_DB_PATH`，不要為測試初始化、seed 或重抓真正工作區。
- 8876 是應用、8878 是靜態 review。開始前用 `lsof` 核對 listener；8877 屬於其他專案。本次查核時 8876／8878 沒有 listener，這不是以後 session 的保證。

## 5. 文件落差與方法邊界

1. 原交接寫「三組變更」，同時又列 Claude 新增的第四組；80 路徑、77 檔都是歷史口徑。本次文件修改前實測為 **16 個已追蹤修改＋76 個未追蹤路徑，共 92 個**，基線 HEAD `679dd91`。commit 後以 Git 為準，勿按舊數字補回或丟棄檔案。
2. `next-harness-workspace.md` 的「全部未完成」已加日期校正；研究階段與比較收藏的瀏覽器實作保留，後續只補核實的缺口。
3. 市場風險的手動讀數過期時仍計分並列 `stale_inputs`；過期技術日線不可用。這是 v1 文件與測試的明確行為，不能擅自統一成另一種算法；缺少啟用因子仍使綜合分數不可用，不重分配權重。
4. `LOCAL_SETUP.md` 的驗證段落已與共用五道關卡對齊；早期 `docs/HARNESS.md` 保留歷史執行紀錄，不用它較短的清單取代目前驗收。
5. Vite 主程式 chunk 超過 500 kB 是現存警告；若後續處理，應以拆分與實際載入驗證，不只是調高警告門檻。
6. `.gitignore` 查核時僅逐項忽略部分 `data/` 副檔名，而非整個目錄。後續提交準備已補上整個 `data/` 目錄的排除；提交仍需核對 staged 清單，不以「文件寫了 gitignored」取代實際檢查。

## 6. 下一輪建議工作順序

以下是建議，需依使用者下一次選定的開發範圍執行。本次分析沒有啟動這些實作。

1. **P1-A：隔離備份的恢復計畫預覽。** 先鎖定支援 schema、預覽契約與合成 fixtures；再做 P1-B staging 遷移與 P1-C 獨立工作區啟動檢查。參考 `docs/next-harness-workspace.md`。
2. **資料版本唯讀審閱。** 重用 raw／repair 診斷，保存 provider、內容 hash、抓取時間與父版本；先展示差異，之後才另做顯式採用。參考 `docs/next-harness-data.md`。
3. **分類重試與外部基準驗證。** 在可追溯來源基礎上改善覆蓋；不把目前可讀的 ETF 當成已核准的績效基準。
4. **既有研究流程接續。** 選定市場風險設定搬家、首頁背景區間，或 Alpha 瀏覽器偏好與工作區同步中的一項；不要重做研究追蹤與比較收藏。
5. **帳本與事件來源。** 先依 `docs/next-harness-methodology.md` 決定成本、現金流及公司行動口徑，再討論歷史績效；財報日曆先評估來源。

第一個建議交付 P1-A 的最小驗收：

- 重用 `backup_preflight.check_backup` 的 ZIP 上限、精確 schema 辨識與 allowlist，不自行 `extractall` 或執行備份 schema SQL。
- 預覽綁定備份 hash、工具／遷移版本與新目標路徑；輸入變動或目標已存在時拒絕舊計畫。
- current、已登錄 legacy、未知 schema、壞 ZIP、路徑穿越、超限、STOP／逾時都有合成案例與明確結果。
- 預覽前後原 ZIP 與目前工作區不變；不啟動排程、不連網、不輸出私人資料值；未知 schema 保持不支援。
- P1-A 的完成標準是可驗證的計畫與測試，不能宣稱已還原。真正的 staging 與正式切換分別按後續範圍驗收。

## 7. 驗收與下次開工提示

本次重新執行結果：pytest **575 通過**；Vitest **226 通過／43 檔**；Prettier、TypeScript／Vite build 與 `git diff --check` 通過。Vite 主 chunk 為 545.90 kB，保留超過 500 kB 的已知警告。pytest 有 TestClient 相容性棄用提示，以及重複 ZIP 成員的拒絕測試所產生的警告，沒有失敗。完整檢查命令：

```sh
uv run --extra web --extra dev pytest -q
npm test --prefix web
npm run format:check --prefix web
npm run build --prefix web
git diff --check
```

驗收只證明目前合成資料測試與建置狀態，不證明即時行情可用、真實 DB 可恢復或已完成手動瀏覽器驗收。本次未啟動真實工作區，未重新下載行情。

可貼給下一次 Codex session 的交辦提示：

> 先讀 AGENTS.md、CLAUDE.md、docs/codex-handoff-2026-09-16.md，再讀此次任務相關的方法文件。以 git status／git log 與程式測試核對狀態，保留未提交變更。只執行我在本次訊息指定的交付範圍；不要自動開始舊 Harness 或所有 next-harness 提案。行情缺失保持不可用，方法改動要升版，測試用隔離 PANEL_DB_PATH，私人資料不得進 Git／文件／記憶。完成後跑共用五道關卡，涉及 UI 時檢查主要操作路徑，回報成果、證據、限制及下一個最小工作單位。
