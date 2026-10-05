# AlphaView Agent Harness

The development harness combines a time-boxed agent workflow with source changes, independent review, deterministic regression tests, actual browser checks, and an ongoing read-only runtime soak. The timer is a deadline guard; it does not claim to perform development by itself.

## Current run

- Start: 2026-09-04 22:47:25 UTC / 2026-09-05 06:47:25 Asia/Taipei.
- Deadline: 2026-09-05 03:47:25 UTC / 11:47:25 Asia/Taipei.
- Duration: 5 hours.
- Scope: AlphaView branding and GitHub publication; three representative competitor benchmarks; verified correctness and useful research-workflow improvements.

Agent assignments change after each bounded implementation or review task. File ownership is explicit. Review findings are reproduced before implementation; changes are checked with isolated databases and relevant UI tests. Browser interactions verify the built application rather than relying only on a build result.

## Local receipts

Runtime files stay under `artifacts/harness-2026-09-05/`, excluded from Git:

- `state.json`: deadline, completed work, current work, evidence, known limitations and next tasks.
- `events.jsonl`: timestamped development and verification receipts.
- `review.html`: standalone local review report, regenerated from state and events.
- `soak.jsonl`: read-only health/overview timings and consistency checks; no personal positions.
- `STOP`: written when the deadline is reached. Agents must stop starting new changes and checkpoint.
- `panel-before.db`: local pre-migration database backup; never publish it.

```sh
python3 scripts/harness.py status
python3 scripts/harness.py report
```

The active watchdog checks the deadline and writes the stop marker and a final available report even if interactive work is interrupted. Agents reserve the end of the run for regression checks, publication status, known limitations and the next-run backlog. A report marked `running` or `deadline_reached` is not a claim that all work has been completed.

## Verification gates

```sh
uv run --extra web --extra dev pytest -q
npm test --prefix web
npm run build --prefix web
git diff --check
```

Tests use temporary databases and mocked provider data. Runtime checks may use the local real dataset, with no invented quote fallback. Do not delete or overwrite real holdings for a browser test. New candidate research is separate from portfolio changes.

## Next-run review

Review `review.html` and approve the next priorities based on value and data readiness. Candidate features requiring new provider access or public deployment need their own scope and verification. Do not treat the comparison document's initial gap list as the final implementation status.

## 並行開發期間的長測來源

`scripts/polling_revision_soak.py` 的 CLI 會先複製 Python 應用程式與測試 runner 到暫存目錄，父程序與後續 spawn 子程序均載入同一份副本。來源清單與 SHA-256 留在輸出資料夾，並記錄當時 Git commit 與是否有未提交修改。長測只使用合成 SQLite 資料並停用網路；暫存副本隨程序結束清除。

這避免開發中修改 API 回應格式，造成長測父子程序比較不同版本的回應。既有失敗紀錄必須保留；新的通過紀錄不能抹除先前的逾時或其他失敗。未保存比較 payload 的歷史失敗，不得僅憑事後重現就宣稱原因已完全確定。

Pipe 回傳必須先排空再等待 reader 子程序結束，否則資料超過作業系統緩衝大小時，子程序等待送出、父程序等待結束而互相卡住。本輪以真實子程序重現首次與固定來源長測的精確失敗輪次，並加入 64 KiB 狀態回傳回歸測試；緩衝大小是平台特性，不能假定所有系統都是本機測得的 512 bytes。每個子程序仍有期限與 finally kill／reap，避免測試本身無限等待。

## 2026-10-01 Trading Agent Harness 的做法（Claude Code）

- 主代理只做整合：schema 簽章、`AGENTS.md`／`docs/agent/project-map.md`／`docs/agent-portfolio.md`／`README.md`／`WEB_PANEL.md`、`state.json`、`events.jsonl`、檢閱頁與五道關卡；功能單元交給 fork 子代理平行開發（本輪 A–O 共 15 個），每個 fork 只跑自己的測試與鄰近套件，回報「交付／測試數／檔案／延後／主代理要加的文件行」。
- 平行寫同一檔案的規則：只能在明確錨點後追加（`api.py` 的 router include、`paper_portfolio._build_preview` 的 hook 區），改既有語意的單元一次只派一個 fork；**同一輪只允許一個 fork 改 SQLite schema**，由它更新簽章登錄（`backup_preflight.KNOWN_SCHEMAS`、`tests/test_agent_schema_migration.py`）。
- 速率限制中斷：fork 被 429 殺掉時以 SendMessage 原地恢復（transcript 仍在），恢復前先查磁碟上的半成品；中斷寫進 `state.json.interruptions` 並順延 deadline。
- 中途跑一次全套回歸（不是每個單元都跑），只為抓跨 fork 的相互影響；本輪抓到一個對附加中繼資料的 byte-identical 假設。
- 事件格式 `{at, unit, status: done|interruption, owner, evidence[], note}`；`scripts/render_trading_agent_review.py` 直接把完成事件做成交付表，`scripts/run_harness_gates.py` 產生 `gates.json`。
