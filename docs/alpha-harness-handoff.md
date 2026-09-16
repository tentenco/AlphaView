# AlphaView Alpha workflow handoff

This development interval runs from **2026-09-07 00:52:52 to 03:52:52 Asia/Taipei**. The final breakpoint state and review are local artifacts under `artifacts/harness-2026-09-07/`; check `state.json` for the actual completion status. This document does not start another Harness.

## User review

- App: `http://127.0.0.1:8876/#alpha`
- Static review: `http://127.0.0.1:8878/alpha-review.html`
- The standalone HTML includes screenshots, feature checks, per-feature pass/change feedback, next-task priorities, and a JSON export for the next agent.
- `source-checkpoint.zip` captures changed source files against the commit in `source-manifest.json`. It includes earlier theme and locale edits. It is not a full checkout or a database backup; inspect the manifest before using it.
- `experiment-balanced.json` and `experiment-momentum.json` contain the complete two example basket results. `experiment-requests.json` contains their reproducible request bodies.

If the local review server is no longer running, start it from the project root:

```sh
python3 -m http.server 8878 --bind 127.0.0.1 --directory artifacts/harness-2026-09-07
```

Start the built application with `.venv/bin/python -m alphaview.panel serve`. The main application uses port 8876. Check for an existing listener before starting another instance. Port 8877 belongs to an unrelated local project and must not be stopped for this project.

## Shipped workflow

The default Alpha Picks dashboard ranks a market universe separately from the user's portfolio list. Four strategy weights, minimum matches, and a score threshold determine Alpha eligibility. Card/table/map views, indicator filters, daily changes, strategy intersections, shortlist, current holding alerts, price thresholds, and candidate-to-holding comparisons share the dated research context.

Research continuity includes named weight profiles, saved comparison groups, daily snapshots with historical alert details, staged follow-up with review dates and ICS export, browser JSON backup/import preview, and a dated agent handoff. Alpha Lab holds separate experiment settings, signal replay, basket simulation, weight-profile comparison, saved experiment baselines, and CSV exports. Page-open desktop notifications require an explicit user opt-in.

See [the calculation and usage guide](alpha-research.md) and [interaction decisions](alpha-ux-decisions.md). Core modules:

| Responsibility | Source |
| --- | --- |
| Ranking and current alerts | `web/src/alpha-model.ts`, `AlphaDashboard.tsx` |
| Indicator filters / session context | `candidate-filters.ts`, `dashboard-session.ts`, `session-state.ts` |
| Historical Alpha replay | `alphaview/panel/alpha_replay.py`, `web/src/AlphaReplay.tsx` |
| Hypothetical basket / saved differences | `alphaview/panel/alpha_basket.py`, `AlphaBasket.tsx`, `ExperimentNotebook.tsx` |
| Candidate / holding pairs | `alphaview/panel/holding_fit.py`, `CandidateHoldingFit.tsx` |
| Tracking / calendar | `research-tracker.ts`, `ResearchTracker.tsx`, `research-calendar.ts` |
| Browser portability | `alpha-transfer.ts`, `AlphaPreferencesTransfer.tsx` |
| Local Harness delivery | `scripts/render_alpha_review.py`, `alpha_review_client.js`, `checkpoint_harness.py` |

## Data and research observations

The completed session is **2026-09-04**. The current market universe has **999** accepted members, **902** usable current research rows and **17** balanced-weight Alpha Picks. The existing source issues remain explicit: **13** malformed histories and **84** missing histories are excluded. The new `scan_all` job recalculates both lists from cached quotes; it does not download new data.

The two 20-session, top-5, every-5-session, 10-bps examples have returns of **−11.70%** (balanced) and **−5.03%** (momentum), versus **+2.31%** for their same-initial-basket buy-and-hold reference. These are current-universe historical experiments, not actual account returns or evidence of future outperformance. The homepage weights were not replaced by the experiment weights.

Frontend validation reached **218 passing tests across 41 files**; backend validation reached **510 passing tests**. Production builds and formatting passed; later small changes received the relevant focused checks. The final local state records exact acceptance evidence. A Vite warning about the main chunk exceeding 500 kB remains a performance follow-up, not a failed build.

## Next interval

Use the user's exported Review JSON to choose priorities. High-value proposals in the HTML include a verified earnings/event calendar, recoverable data-provider coverage, longer histories with an independent market benchmark, a transaction/cash-flow ledger, workspace research synchronization, isolated backup restoration, scheduled briefs, and a visual personal-strategy editor.

Preserve the existing local changes. Do not repeat the 3-hour interval automatically or infer external publishing from this handoff. No GitHub push, deployment, email, or brokerage action is part of this interval. The source archive and local research results do not include a database or browser-settings restore operation.
