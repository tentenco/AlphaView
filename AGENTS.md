# AGENTS.md

Codex 與 Claude Code 共用（`CLAUDE.md` 只匯入本檔）。這裡每一行都應該改變你的做法；查位置與指令看 `docs/agent/project-map.md`，授權沿革看 `docs/agent/authorization-log.md`。

## 1. 動手前先計畫
- 長任務（跨多檔、改計算語意、Harness）：先用 2–3 句說你認為我要什麼，等我說好再開始；我已用 `/goal` 或「不要停」授權時，說完直接開始
- 把步驟寫進根目錄 `PLAN.md`，每步附「怎麼證明它有效」；Harness 改寫 `artifacts/harness-<日期>/state.json` 與 `events.jsonl`
- 同一步失敗兩次：停下來，記下失敗原因，重新計畫
- 中途暫停或用量中斷：留下 `PLAN.md`／`state.json`，讓新 session 能接手；規劃文件不算已完成

## 2. 最小可行的改動
- 只做這個任務；不弄壞已經能用的東西。舊提案與 handoff 是歷史，不會自行啟動開發
- 取捨時衡量 UX（使用者）、DX（下一個開發者）、AX（下一個 agent）
- 沒人要求就不加依賴、不改名、不重構；`main.py` 與 `alphaview/{core,data,strategy,notify}`（A 股 CLI）不要動
- 刪除或覆寫前先備份；工作樹大多未提交，git 救不回來。不 commit、不 stash、不 reset，除非我要求

## 3. 把工作分給 subagent
- Explorer 只讀、worker 改檔、reviewer 只回報不改檔
- 每個 subagent 一件事、一個完成條件、一份 5 行報告
- 可以平行，但兩個 agent 不能同時改同一檔；共用檔（`api.py`、`paper_portfolio._build_preview`）只在指定錨點後追加
- 同一輪只准一個 subagent 改 SQLite schema；主代理負責本檔、`docs/agent/`、schema 簽章與驗收
- 採用報告前先驗證它的關鍵主張（自己跑它說通過的測試）

## 4. 自己的 bug 自己負責
- 先用我給的步驟重現；重現不了就告訴我你還需要什麼
- 修根因，再跑同樣的步驟
- 不可為了讓錯誤消失而把它消音：不 skip 測試、不放寬斷言、不 `except: pass`

## 5. 驗證後才說完成
- 跑完這五道並親自讀輸出：`uv run --extra web --extra dev pytest -q`、`npm test --prefix web`、`npm run format:check --prefix web`、`npm run build --prefix web`、`git diff --check`
- UI：打開它並試著弄壞：空輸入、連點送出、重新整理、390px 寬
- 沒跑的檢查要明說；沒跑不等於通過
- 用 2–3 行回報：選了什麼、放棄了什麼、為什麼

## 6. 每次糾正都寫下來
- 我糾正你時，在 Lessons 最上方加一行「當 X，就 Y」
- 同樣的錯犯兩次：代表那條 lesson 寫不清楚，重寫它
- 改 Lessons 以上的任何內容前先問我

## 硬邊界（違反任何一條都要先停下來問）
- **不捏造資料**：缺值、過期、非有限值保留為「不可用」並附原因與覆蓋計數；不填補、不用舊價、UI 顯示 `—` 不顯示 0。（唯一例外：市場風險的手動總經讀數過期時標 `stale` 仍參與計算，見 `docs/market-regime.md`）
- **權重不重新分配**：缺一個啟用因子就是不完整，不把權重挪給別的因子，也不退回預設
- **方法版本**：改變計算語意就升版本字串，不覆寫、不重用；清單在 `docs/agent/project-map.md`
- **一致快照**：唯讀端點用 `@store.snapshot_read`；發布在 `BEGIN IMMEDIATE` 內核對 `input_revision`，資料變了就不發布、不留半批
- **時間口徑**：一律用 `sessions.latest_completed_session()`；策略用調整價、估值用未調整收盤；前日收盤訊號、次日開盤成交
- **私人資料**：持股股數、成本、筆記、金鑰、真實備份只在 `data/`、`artifacts/`；不得出現在文件、測試、commit、報告、記憶。測試只用合成資料＋`PANEL_DB_PATH` 指到 `tmp_path`
- **寫入帶版本**（409 衝突）；背景輪詢不可清掉使用者未儲存的草稿
- **研究不是實盤**：畫面與文件不得寫成操作指示；每個新功能配一段「這不是什麼」
- **不做外部動作**：不 `git push`、不部署、不寄信、不裝新資料供應商、不公開服務（只綁 loopback）
- **埠號**：8876 是面板、8878 是靜態檢閱頁；8877 屬於別的專案，不要停

## 授權範圍（目前有效；紀錄在 `docs/agent/authorization-log.md`）
- 只到 **paper**：本機模擬帳本與 Alpaca Paper（固定 `paper-api.alpaca.markets`）。沒有實盤券商目標，就緒閘永遠不會是 `live_ready`
- Alpaca Paper 委託只能經執行層、在我以確認字串啟用後送出；開發與測試一律用假券商，不對我的帳戶送任何委託
- TypeSafe Jev 是付費外部呼叫：只走產品內既有流程、只送程式分桶的技術事實；開發時不批次呼叫
- 新的券商、資料源、付費服務、對外發布都需要我當次明確授權

## Lessons
<!-- 最新的放最上面；不再適用就刪掉。 -->
- 當我問「preview url」，就啟動 8876（需要時含 8878）、確認回 200 再回覆，並說明背景程序 2 小時上限
- 當跑 Harness，就把時間花在新功能上，不做額外稽核；五道關卡在設斷點前跑一次
- 當新增或修改 SQLite 資料表／欄位，就重算 schema 簽章並更新 `backup_preflight.KNOWN_SCHEMAS`、`tests/test_agent_schema_migration.py` 與 `tests/test_backup_preflight.py` 的 drop 清單
- 當在保存的預覽裡加新 key，就把它加進 `paper.PREVIEW_METADATA`，否則舊提案的 byte-identical 重播會失敗
- 當測試在掃描之後才寫入 bars／positions，就重新蓋掃描 token；輸入 revision 一變，提案與任務就過期
- 當關卡在機器滿載時失敗（其他專案佔滿 CPU），就單獨重跑該套件再判斷，並如實記錄兩次結果
- 當 subagent 被用量限制中斷，就用 SendMessage 原地恢復，並先檢查磁碟上的半成品
