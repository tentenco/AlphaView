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
