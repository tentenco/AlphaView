# AlphaView — 共用 Agent 專案指引

這份檔案是 Claude Code 與 OpenAI Codex 在此 repo 的共用主要指引，繼承 Codex Agent 在 2026-09-05、09-07、09-15 與 Claude Code 在 09-16 累積的方法與約束。保留檔名以相容 Claude Code；`AGENTS.md` 指向這裡，兩份不要各自演化。讀完本檔後，先讀 `docs/codex-handoff-2026-09-16.md`（最新接手分析與狀態校正）；`docs/handoff-2026-09-16.md` 保留為較早的 Claude 接手快照。當次使用者明確授權決定工作範圍，舊提案不會自行啟動開發或外部動作。

## 專案是什麼

AlphaView（原 Sequoia-X）是**本機優先、單一使用者**的美股研究工作區：市場候選池探索、四策略每日選股、Alpha 跨策略加權排序、持股監控、回測、標的比較、市場風險溫度計，全部跑在 `127.0.0.1:8876`。行情來自 Yahoo Finance / yfinance 日線，存在本機 SQLite（`data/panel.db`）。**不是**即時行情終端、不下單、不推播、不公開部署。

`main.py` 與 `alphaview/{core,data,strategy,notify}` 是保留的獨立 A 股 CLI（baostock + 飛書），Web 面板不使用它們；除非使用者明確要求，不要動。

## 目錄與核心模組

```text
alphaview/panel/     FastAPI 後端：行情擷取、SQLite、選股引擎、回測、研究 API
web/src/             React 19 + TypeScript + Vite 前端；vitest 測試
tests/               pytest；每個測試用 PANEL_DB_PATH 指到 tmp_path 的隔離資料庫
docs/                產品方法、決策紀錄、下一輪提案（多為繁中）
scripts/             Harness 帳本、長測、備份預檢、隔離行情診斷、檢閱頁產生器
artifacts/           本機 receipts、截圖、備份、review.html（gitignore；含私人資料）
```

| 責任 | 位置 |
| --- | --- |
| 資料庫 schema、讀取快照、revision 計數 | `alphaview/panel/store.py`（`snapshot_read`、`input_revision`） |
| 行情擷取、股票池探索、日線驗證 | `market.py`（`fetch_symbol`、`discover_universe`、`history_quality`） |
| 指標、四策略、掃描發布、回測 | `research.py`（`indicators`、`evaluate`、`scan`、`backtest`） |
| 掃描版本與輸入 token | `scan_provenance.py`、`scan_context.py` |
| 交易日曆（XNYS、收盤後 15 分鐘） | `sessions.py` |
| 背景作業、工作區鎖、排程 | `jobs.py`、`locking.py`、`scheduler.py` |
| Alpha 回放／組合實驗／候選持倉相關性 | `alpha_replay.py`、`alpha_basket.py`、`holding_fit.py` |
| 市場風險溫度計（多因子崩盤風險） | `market_regime.py`；前端 `web/src/MarketRegime.tsx`、`market-regime.ts` |
| 備份、預檢、儲存清理、風險診斷 | `backups.py`、`backup_preflight.py`、`storage_maintenance.py`、`risk.py` |
| 前端排序與提醒模型 | `web/src/alpha-model.ts`、`AlphaDashboard.tsx`；頁面路由在 `App.tsx`（hash 路由） |
| 繁中→英文翻譯 | `web/src/locale.tsx`：以 DOM 文字替換，**新增中文字串要在 `translations` 加對應英文** |

## 常用指令

```sh
uv sync --locked --extra web --extra dev && npm ci --prefix web
uv run --extra web python -m alphaview.panel serve        # http://127.0.0.1:8876（/docs 有 API）
npm run dev --prefix web                                   # 5173，proxy /api 到 8876
npm run build --prefix web                                 # 正式建置（serve 讀 web/dist）
```

**驗收關卡（宣稱完成前全部要過）：**

```sh
uv run --extra web --extra dev pytest -q
npm test --prefix web
npm run format:check --prefix web
npm run build --prefix web
git diff --check
```

2026-09-16 基準（含市場風險溫度計）：pytest 575 通過、vitest 226 通過（43 檔）。Vite 主 chunk 超過 500 kB 的警告是已知效能待辦，不是失敗。

## 不可違反的原則（Codex 三輪工作的核心方法）

1. **不捏造資料。** 缺值、過期、異常、非有限數值都保留為「不可用」並附原因與覆蓋計數；不用前值填補、不用舊價冒充最新價、不用模擬資料替代真實來源。UI 顯示 `—` 與理由，不顯示 0。
   市場風險 v1 的手動總經讀數有已記錄的不同口徑：保留輸入日期，過期時標示 `stale` 但仍參與計算；技術因子的過期日線則不可用。見 `docs/market-regime.md`。若要改成過期手動值也阻塞分數，屬方法語意變更，需另定範圍、升版及測試。
2. **每種計算都有方法版本字串。** `alphaview-scan-v1`、`alphaview-backtest-v5`、`alphaview-alpha-v1`、`alphaview-alpha-basket-v1`、`alphaview-comparison-v1`、`alphaview-holding-fit-v1`、`alphaview-regime-v1`。改變語意就升版（規則見 `docs/scan-provenance.md`），舊結果標示需重算，不覆寫、不重用版本號。
3. **來源可追溯、發布原子化。** 讀取用 `store.snapshot_read` 取得一致快照；掃描在 `BEGIN IMMEDIATE` 內核對 `input_revision` 未變才整批發布；中途資料改變就不發布，不留半批。
4. **權重不重新分配。** Alpha 分數與市場風險分數在缺資料時不把權重挪給其他因子；缺一個啟用因子就是「不完整／不可用」，並列出缺什麼。
5. **研究不是交易。** 訊號、分數、風險區間只是規則共識；文案不得出現下單、買 Put、減碼等操作指示。沒有券商、沒有 Email／推播伺服器、不公開部署（TrustedHost 只允許 loopback）。
6. **保護使用者私人資料。** 持股股數、成本、筆記、真實備份 ZIP 只存在 `data/`、`artifacts/`（皆 gitignore）。文件、測試、commit、報告、記憶檔**不得**出現實際股數或成本；測試一律合成資料＋`tmp_path` 資料庫。瀏覽器測試不可覆寫真實持股。
7. **編輯衝突保護與草稿保留。** 寫入帶版本（409 衝突），跨分頁用 storage 事件；背景輪詢或行情更新不可清掉使用者未儲存的草稿。
8. **時間口徑。** 一律以 `sessions.latest_completed_session()`（XNYS 收盤後 15 分鐘）判定「最新已完成交易日」；策略用調整價、估值用未調整收盤；回測是前日收盤訊號、次日開盤成交。
9. **不做外部動作。** 不 `git push`、不部署、不寄信、不呼叫付費 API、不安裝新資料供應商；接第二資料源前先看 `docs/data-provider-evaluation.md` 的授權與驗收條件。
10. **commit 由使用者決定。** 接手時以 `git status` 核對並保留現有工作；未經要求不要 commit、不要 stash、不要 reset。舊 handoff 的未提交清單只是當時快照。

## 寫作與 UI 慣例

- 介面與文件以繁體中文為主，英文由 `locale.tsx` 翻譯表產生；React 元件內用 `t(zh, en)` 或直接寫中文並補翻譯表。
- 每個新功能配一段「這不是什麼」的說明（範圍、分母、偏差、限制），沿用 `research-note`／`alpha-method` 樣式。
- 沿用 `styles.css` 的 tokens（`--text`、`--muted`、`--line`、`--positive`、`--negative`、`--amber`、`--type-*`）；淺色預設、深色可切；手機 390px 不得橫向溢出；表單可鍵盤完成。
- 後端新端點：pydantic `extra="forbid"`、`allow_inf_nan=False`、範圍限制；唯讀端點加 `@store.snapshot_read`；回傳附 `engine_version`、`as_of`、`input_revision`、`method` 說明；測試必須確認 `store.input_revision()` 不變、`json.dumps(result, allow_nan=False)` 可序列化。
- Prettier：無分號、單引號、printWidth 100。Python 沒有 formatter 關卡，但沿用既有風格（短函式、明確錯誤訊息為繁中）。

## Harness（時間盒開發）工作法

Codex 的兩輪 Harness 都以固定時限、事件帳本與本機檢閱頁交付：

- 產物放 `artifacts/harness-<日期>/`：`state.json`（完成／進行中／證據／限制／下一輪）、`events.jsonl`、`review.html`、截圖、`STOP` 標記、`source-checkpoint.zip`（`scripts/checkpoint_harness.py`）。
- `scripts/harness.py status|report`（09-05 版）、`scripts/render_alpha_review.py`（09-07 版）產生離線 HTML；報告只用本機資源，不連網。
- 到期即停止新功能，保留斷點、整理已通過與未驗收項；**規劃文件不能當作已完成**。
- 靜態檢閱頁用 `python3 -m http.server 8878 --bind 127.0.0.1 --directory artifacts/harness-…`。**8877 屬於另一個專案，不要停掉。**

若使用者要求新一輪 Harness，先開新目錄、寫 `state.json` 的 deadline 與 scope，再開始改碼；每完成一個可驗收單位就追加一筆 event。

## 目前狀態摘要（2026-09-16）

- 本次 Codex 接手前 HEAD `679dd91`（2026-09-05 主線）。當時工作樹包含 Alpha 工作流、yfinance lazy Mapping 相容、`scan_all`、字級調整，以及 Claude Code 的市場風險溫度計與交接文件。這是歷史快照；目前提交狀態以 `git status`／`git log` 為準，詳細校正見 `docs/codex-handoff-2026-09-16.md`。
- 09-09 `data/panel.db` 曾不明原因變成空庫；09-15 已從 09-05 備份還原並更新持股與行情，原因仍未查明（見接手文件「風險」）。
- 下一個建議交付是隔離備份恢復的 P1-A 預覽契約，優先序與驗收見最新接手文件。三份 `docs/next-harness-*.md` 是歷史提案；其中研究階段與比較收藏已有瀏覽器版本，不能把整份提案視為全部未實作，也不能當作本次授權。

## 參考文件

`README.md`（英文產品說明，描述已實作行為）· `WEB_PANEL.md`（繁中使用指南）· `docs/alpha-research.md`（Alpha 計算口徑與 API）· `docs/alpha-ux-decisions.md` · `docs/scan-provenance.md` · `docs/candidate-comparison.md` · `docs/backup-preflight.md` · `docs/data-provider-evaluation.md` · `docs/competitor-benchmark.md` · `docs/market-regime.md` · `docs/HARNESS.md` · `docs/alpha-harness-handoff.md`
