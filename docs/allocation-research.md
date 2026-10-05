# Saved-workflow allocation research

Method: `alphaview-allocation-research-v1`. This is a separate, read-only comparison
of rank-sum weighting and full-covariance equal risk contribution (ERC). It does
not add methods to `alphaview-allocator-v1`, change saved targets, create proposals
or provide a route to execute a comparison.

## Frozen source and request

`POST /api/portfolio-agent/runs/{identifier}/allocation-research` uses
`@store.snapshot_read` and returns `Cache-Control: no-store`. Its strict input is:

```json
{
  "expected_proposal_fingerprint": "<64 hexadecimal characters>",
  "expected_input_revision": "<captured input revision>",
  "expected_as_of": "YYYY-MM-DD",
  "lookback_sessions": 60
}
```

Only `lookback_sessions` is optional. It must be an integer from 20 through 120;
unknown fields, coercible strings and nonfinite values are rejected. The source
must be a saved, currently proposed workflow with matching fingerprint, input
revision and latest completed-session date. Stale identity returns 409; blocked
or inconsistent selections cannot be compared.

Every selected symbol participates; callers cannot omit a missing asset. The
maximum is the workflow's existing 30-symbol limit. The order is the workflow's
established score descending, matched-rule count descending, then symbol
ascending. Budget `B` is the **sum of saved final target weights**, not the
allocator's earlier intended budget. Previously unused or capped cash therefore
stays outside this comparison. The position cap comes from the saved constraints.
Zero budget returns unavailable; a one-symbol portfolio can be calculated if it
has usable positive variance.

## Common history and matrices

For `L` return sessions ending on `sessions.latest_completed_session()`, every
symbol must have all `L+1` expected XNYS-session adjusted closes, each finite and
positive. Daily returns are `log(P[t]) − log(P[t−1])`. The report includes exact
price dates, missing and invalid dates per symbol, valid-close counts and the
number of complete common return dates. Those counts describe missing coverage;
they do not select a reduced intersection for calculation.

The sample covariance uses denominator `L−1` on the same dates for every pair,
then multiplies by 252. Correlation divides each covariance by its two sample
standard deviations. No pairwise deletion, imputation, covariance shrinkage or
eigenvalue repair is applied. Zero variance, nonfinite covariance, failed
eigendecomposition, or a minimum/maximum eigenvalue ratio at or below `1e-10`
makes the comparison unavailable. The cutoff is this method's numerical guard,
not a forecast-quality threshold. Available matrix and condition diagnostics are
still shown when the covariance is singular.

Bounds are 3,630 required closes, 900 entries per matrix, and at most 5,000 solver
sweeps. A request loads only its bounded date window. NumPy is already used by the
project; this feature adds no dependency, schema or provider.

## Weight and risk arithmetic

Rank-sum weighting fixes raw weight for rank `r` to
`B × (n − r + 1) / (n × (n + 1) / 2)`. It is a specified positive linear rank
schedule, with rank 1 highest. It uses the general rank-weighting construction
discussed in [Malkiel and Jun (2009), equation 4](https://www.princeton.edu/~ceps/workingpapers/188malkiel.pdf).
Their historical return results are not evidence about these workflow rankings.

For ERC, let `C` be the full correlation matrix and `b_i=1/n`. Minimize
`0.5 × yᵀ C y − Σ b_i log(y_i)` with positive `y`; convert to weights proportional
to `y_i / σ_i`. This objective and normalization follow
[Griveau-Billion, Richard and Roncalli (2013), appendix A.3.2](https://arxiv.org/pdf/1311.4057).
This implementation derives each positive coordinate root directly: with
`a=C_ii` and `c=Σ[j≠i] C_ij y_j`, solve `a y_i² + c y_i − b_i=0`.
The equivalent stable root avoids cancellation when `c≥0`.

The deterministic solver starts with positive ones and stops only when the
maximum deviation of raw risk shares from `1/n` is at most `1e-8`. Its sweep count,
residual and tolerance are returned. Nonconvergence publishes no iterate as an
allocation. There is no inverse-volatility fallback; both comparison methods
remain unavailable if the common matrix or solver cannot support the comparison.

With weights `w` expressed as fractions of the entire portfolio and annualized
covariance `Σ`, sample volatility is `sqrt(wᵀΣw)`. Asset volatility contribution
is `w_i(Σw)_i / sqrt(wᵀΣw)` and its risk share is
`w_i(Σw)_i / (wᵀΣw)`. Volatility and contributions are displayed in percentage
points; risk shares are percentages. Contributions remain signed: negative
values indicate covariance offsets in this sample and are never clipped to zero.
Cash is modeled as zero risk, with no return estimate.

Each raw weight is independently capped, then rounded down to eight decimal
places using the existing allocator helper. All excess and rounding remain cash;
other weights do not increase. The report shows weights, cash, volatility,
contributions and risk shares before and after caps. Capped ERC is not claimed to
remain equal risk. A zero-risk post-cap portfolio has null risk metrics and an
explicit reason, even if its weight arithmetic was available.

## UI lifecycle

The component accepts `run`, `enabled` and `t`. Its button initiates a calculation;
there are no background calculations or apply controls. Repeated clicks are
guarded, cancellation aborts the request, and changed run identity or lookback
invalidates old results. Lookback drafts survive source-status updates.

Before displaying a response, the UI verifies its exact saved identity and
lookback, then reads the workflow again to catch an intervening source change.
While evidence is displayed, visibility and 30-second source checks can mark it
inactive; they do not rerun research. Calculation evidence describes one consistent
snapshot, not a promise that the live workspace can never change afterward.
Matrices scroll within their disclosure section on narrow screens.

## What this is not

This is allocation arithmetic on a historical sample, not a strategy or portfolio
performance validation, return forecast, recommendation or change to an active
allocation. The comparison omits transaction costs, liquidity, estimation error
and future changes in correlation. Lower sample volatility or equal sample risk
contributions do not establish superior returns or prevent losses. Saved
workflows and all existing proposal authorization checks remain unchanged.
