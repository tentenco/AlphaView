# Paper cost sensitivity

Method: `alphaview-paper-cost-sensitivity-v1`.

The allocation preview can compare explicit fee and slippage assumptions for its
existing order quantities. The user runs the comparison with a button; it does
not run in the background. The UI requires a complete, executable preview with at
least one order. An invalid preview or an allocation without orders instead
explains why the comparison is unavailable.

## Snapshot and identity

`POST /api/paper/accounts/{account_id}/cost-sensitivity` is a
`@store.snapshot_read` endpoint. It rebuilds one trusted paper preview using the
account's current policy, the complete supplied allocation, and
`sessions.latest_completed_session()`. Valuation uses the existing engine's
exact-session unadjusted USD closes and coverage checks.

The request requires account version, input revision, completed-session date,
paper engine version, and the source orders' symbol, side, shares and reference
price. These must match the rebuilt preview; stale or mismatched identity returns 409. The response includes those identities, the trusted preview fingerprint,
the supplied assumptions, and this independent method version. No fields are
added to saved paper previews.

Each grid axis accepts one to five unique finite numbers between 0 and 1,000 bps,
inclusive. Empty grids, duplicate values, unknown fields and numeric strings are
rejected. The endpoint calculates at most 25 cells and never creates a proposal,
ledger entry, execution order, provider request or policy change.

## Fixed order calculations

Every cell preserves the trusted preview's quantities, share precision and
minimum-trade skips. It does not rerun sizing with a different policy or resize
orders to fit cash. For an order with reference price `P`, shares `Q`, fee rate
`F = fee_bps / 10000` and slippage rate `S = slippage_bps / 10000`:

- The adverse fill price is `P × (1 + S)` for a buy and `P × (1 − S)` for a sell.
- The fee is the fill notional multiplied by `F` for both sides.
- Slippage cost is fill notional minus reference notional for buys, and reference
  notional minus fill notional for sells.
- Buys subtract fill notional and fees from cash; sells add fill notional minus
  fees. Holdings are then valued at the same reference closes.

Fill prices, reference notionals, fill notionals and per-order fees use the paper
engine's existing eight-decimal half-even money rounding. The current-policy
grid cell reproduces the preview's cost and cash arithmetic. A cell reports fees,
slippage, total cost, cost change from the baseline, post-cost cash, equity and
weight checks.

All baseline violations remain present. Cells also check insufficient cash,
nonpositive equity, the minimum cash weight and post-cost position concentration.
A lower assumed cost cannot remove a baseline block. A cell marked `calculated`
only means this comparison detected no blocking constraint; it is not an
execution authorization. Missing valuation and zero planned orders produce
unavailable cells with null costs and an explicit reason.

## Volume coverage

For each planned order, participation is calculated as `shares / volume × 100`
using the local bar on the exact completed-session date. The endpoint does not
look up an older volume. Absent, zero or nonfinite volume produces an unavailable
participation value, reason and coverage count; the UI renders the value as `—`.
An explicit fee/slippage assumption can still be calculated when volume is
unavailable, provided the source preview has usable valuation.

Participation is a daily volume ratio, not an estimate of market impact or
available execution capacity. Volume does not select, fit or alter the supplied
slippage assumptions.

## UI lifecycle

Fee and slippage drafts persist in session storage separately for each account.
Preview, account or draft changes invalidate displayed results and abort the
pending request. Repeated clicks do not send concurrent requests. Cancellation
and late responses cannot replace results for a newer context; responses must
also match the expected preview identity before display. Results are not stored
as proposals or restored as current calculations after a reload.

## What this is not

This is a local research comparison of user-supplied cost assumptions. It is not
a broker quote, fill forecast, liquidity model, new allocation, trade advice or
change to the active execution policy. It does not rank scenarios as recommended
trades. A new preview and the existing authorization and execution checks are
still required for any separate paper action.
