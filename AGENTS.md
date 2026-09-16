# Agent instructions

The canonical agent guide for this repository is `CLAUDE.md`. Read it first; this file only repeats the invariants that every agent (Codex, Claude Code, or others) must keep even when it reads nothing else.

Then read `docs/codex-handoff-2026-09-16.md` for the Claude Code → Codex handoff, reconciled implementation status, and next-task acceptance criteria. Older handoffs and `next-harness-*` files are dated evidence/proposals, not an active task queue. Current explicit user authorization governs the scope; do not start proposed features just by reading them.

- Local-first single-user research workspace. Never push, deploy, email, place orders, or call paid providers.
- Never invent market data. Unavailable stays unavailable with a reason and coverage counts.
- Every calculation carries a method version string; changing semantics means a new version, never an overwrite.
- No weight redistribution when data is missing; missing inputs make a score incomplete, not smaller.
- Personal holdings, cost basis, notes, and real backups live only in `data/` and `artifacts/` (gitignored). They must not appear in docs, tests, commits, reports, or memory.
- Tests use synthetic data and an isolated database via `PANEL_DB_PATH`.
- Verification before claiming done: `uv run --extra web --extra dev pytest -q`, `npm test --prefix web`, `npm run format:check --prefix web`, `npm run build --prefix web`, `git diff --check`.
- Do not commit, stash, or reset unless the user asks. Preserve any existing uncommitted work; use `git status` for the current state, not the counts in dated handoffs.
- Port 8876 is the app, 8878 the static review server; port 8877 belongs to an unrelated project and must not be stopped.
