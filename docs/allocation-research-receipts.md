# Immutable allocation research receipts

Receipt method: `alphaview-allocation-research-receipt-v1`. The underlying
comparison remains `alphaview-allocation-research-v1`; its arithmetic and active
allocator are unchanged. A receipt preserves server-rebuilt rank-sum and
full-covariance ERC evidence for later local review. This is not a proposal,
allocation approval, performance validation, or execution source. There is no
apply, promote, order, or broker route from a receipt.

## Save contract

`POST /api/paper/accounts/{account_id}/allocation-research-receipts` accepts only:

```json
{
  "run_id": "<saved workflow id>",
  "expected_account_version": 1,
  "expected_proposal_fingerprint": "<64 hexadecimal characters>",
  "expected_input_revision": "<captured input revision>",
  "expected_as_of": "YYYY-MM-DD",
  "lookback_sessions": 60,
  "expected_evidence_fingerprint": "<64 hexadecimal characters>"
}
```

Version and lookback are strict integers; the comparison's existing 20–120
lookback bound applies. Unknown fields, including client-supplied result data,
are rejected. The router retains validation-error field location, message and
type but omits input/context echoes. This narrowly prevents invalid NaN/Infinity
inputs from making FastAPI's validation response itself invalid JSON; rejection
remains HTTP 422. No global exception handling changes.

Within one query-only read snapshot, the server captures the complete account
version, kill switch, limits, execution policy and symbol policy, and the exact
saved workflow record fingerprint. It checks the workflow's policy binding,
then calls the existing comparison with the supplied source identity. The
server-produced evidence fingerprint must match what was reviewed; otherwise
409 leaves no receipt. Missing history or unavailable covariance may still be
saved when the trusted comparison reports unavailable: original nulls,
coverage and reasons are retained.

After the expensive comparison leaves the read snapshot, publication enters
`BEGIN IMMEDIATE`. It rechecks input revision, latest completed session,
research/workflow/scan method versions, full account context and exact saved
workflow record. Any change rejects publication with 409. The account context
is recorded for review, and does not change research weights or certify that
those weights meet account trading limits. A workflow already bound to an
account must retain its existing policy binding; an unbound workflow is labeled
as a review association only.

## Identity, bounds and replay

Canonical finite JSON with sorted keys produces SHA-256 fingerprints. Receipt
identity includes the account and all save-request fields; the stored payload
has its own content fingerprint and retains the comparison's evidence
fingerprint. These hashes detect inconsistent local records; they are not
signatures or proof of authorship against an actor able to rewrite the database
and its hashes.

An identical request returns its original immutable receipt, including after
its source becomes stale. It does not recalculate or overwrite the historical
payload. A concurrent duplicate is checked again inside the publication
transaction. Currentness is computed separately at read/replay time, so it can
change while the saved values and content fingerprint stay identical.

Bounds are 50 receipts per account, 500 globally and 256 KiB of UTF-8 payload per
receipt. Both the publication check and table CHECK enforce the size bound.
Capacity returns 409, excessive size returns 422; neither truncates results nor
deletes history. There is no automatic retention deletion or delete endpoint.
Identical replay remains available at capacity. The table is
`allocation_research_receipts`, initialized only through normal store schema
initialization; reads never create or migrate tables.

## Historical reads and interface

`GET /api/paper/accounts/{account_id}/allocation-research-receipts` supports
`limit=1..20` and `offset=0..500`, ordered by saved time then identity descending.
`GET /api/paper/accounts/{account_id}/allocation-research-receipts/{id}` returns
the selected account's full receipt. Both use `@store.snapshot_read`, return
`Cache-Control: no-store`, and do not rebuild covariance or weights. The list
reports total/returned counts and retention bounds.

Reads verify payload, request identity and nested evidence fingerprints.
Malformed, oversized or inconsistent evidence remains listed, but is labeled
unavailable; its result payload is withheld. A missing source, changed policy,
changed input/session/method or changed workflow record is reported separately
as stale. If the current context cannot be parsed, currentness is unavailable
rather than current. A historical method version does not prevent viewing
intact saved evidence.

The interface loads account history only on demand, even when the current
workflow cannot run a new comparison. Saving requires a current verified
comparison. Historical detail reuses the evidence renderer for exact saved
weights, signed risk contributions, matrices, coverage and null displays. It
labels saved account/policy versions, workflow association, content fingerprint
and the currentness of that read. It does not update historical values in the
background.

Only one receipt request is in flight per component. Repeated clicks are
blocked; account switches/unmount abort requests, and late responses cannot
replace another account's history. A changed source/version suppresses a late
save response or error. Conflict errors preserve existing reviewed history and
comparison inputs. The API remains the authority for publication checks.

## Verification

Synthetic temporary SQLite databases and blocked network transports cover
server reconstruction, strict/finite input, account and source identity,
post-snapshot publication races, concurrent deduplication, hard capacity/size
bounds, read-only historical access, stale replay, unavailable evidence and
corruption. Focused interface tests exercise exact save payloads, duplicate
clicks, stale historical review, pagination, unavailable/damaged evidence,
conflict preservation and late-response/account-switch guards. Browser and
schema migration checks are part of the parent Harness acceptance.

## Selected receipt JSON export

The historical detail has an explicit local JSON download. It serializes the
selected server response envelope directly, including its immutable payload,
content fingerprint, currentness at that read, replay marker when present,
unknown additional fields and nulls. It does not fetch a newer response, project
only currently displayed fields, recompute evidence, or alter database state.
The filename contains the selected receipt identity. Object URLs are revoked
after the download using the existing paper-download lifecycle convention.

Export requires available verified evidence and matching receipt/account/run,
source fingerprint/revision, session and lookback identities. Damaged,
unverifiable or incomplete evidence cannot be exported. An intact receipt whose
research result is unavailable remains exportable with its original coverage,
reasons and nulls; evidence integrity and calculability are separate conditions.

Changing the active workflow or making it stale does not change the selected
historical receipt or its saved currentness label. Selecting another historical
receipt changes the download to that exact selection. Switching accounts clears
the selection and disables access to the prior account's download. The exported
currentness describes the earlier read, not a new currentness check and not an
instruction to apply weights or trade.

## Comparing two saved receipts

Comparison method: `alphaview-allocation-research-receipt-comparison-v1`.
`POST /api/paper/accounts/{account_id}/allocation-research-receipts/compare` is an
idempotent, pure-read endpoint under `@store.snapshot_read`. Its strict body is:

```json
{
  "baseline_id": "<receipt identity>",
  "selected_id": "<different receipt identity>",
  "expected_baseline_content_fingerprint": "<64 hexadecimal characters>",
  "expected_selected_content_fingerprint": "<64 hexadecimal characters>"
}
```

Both records must belong to the named account. The existing verified receipt
reader checks their payload/request/evidence fingerprints; the expected content
fingerprints must also match. Identical selections and invalid inputs return
422, missing or cross-account receipts return 404, and corrupt or mismatched
evidence returns 409. No record is inserted, updated or deleted, and research,
provider and broker functions are never called. Only the two selected receipt
payloads are loaded, each within the existing 256 KiB bound.

The response records both identities, saved source dates, lookbacks, input and
method versions, saved account/policy versions, coverage counts, and currentness
at this read. Stale receipts remain inspectable and comparable; their saved
values are never replaced with current data. The comparison reports rank-sum
and ERC raw/capped weights, invested budget, cash, caps/rounding retained in
cash, annualized volatility, signed risk contributions and risk shares before
and after caps. Each metric contains `baseline`, `selected`, `delta` and an
explicit unavailability `reason` when needed. Deltas mean selected minus
baseline in percentage points, not relative returns or performance changes.

Numeric deltas require both receipts to use the understood
`alphaview-allocation-research-v1` method, the same selected-symbol set and the
same 20–120 session lookback, with complete required dates/returns for every
symbol in both saved coverage records. Different source dates are allowed and
shown explicitly. Different method versions, lookbacks, symbols or incomplete
coverage preserve the two original values but produce null deltas with reasons.
Within compatible receipts, the relevant method and risk stage must be
calculated, and both individual values must be finite. Missing assets, fields
or misaligned risk arrays remain unavailable; zero stays zero and signed risk
contributions retain their sign. Risk arrays are matched by each receipt's own
symbol order, not by the displayed table position. No weights are redistributed.

A bounded comparison-only shape check accepts at most 30 symbols and 30 entries
per weights/risk/coverage list. It rejects unsupported nested containers with
`receipt_comparison_shape_unavailable` (409) before arithmetic. This also applies
to checksum-valid future-method payloads whose structure is unknown. Historical
GET remains unchanged and can return the intact original record. A future
method retaining the understood structure may be shown side by side, with all
deltas unavailable. The comparison adds no schema and does not reinterpret the
existing research method.

The interface chooses a baseline from the currently loaded account-history
page and compares it explicitly with the selected verified historical detail.
Empty, identical or unverifiable selections are disabled. History pagination
clears a baseline absent from the new page. Account, baseline, selected receipt,
content fingerprint or refreshed currentness changes clear the previous result
and abort an in-flight request; late results cannot replace a new selection.
Repeated clicks start only one comparison. Conflicts preserve the selected
identities for an explicit retry. The selected-receipt JSON export continues to
download its original envelope independently of comparison results.

This is descriptive arithmetic over saved evidence. It does not estimate
performance, establish an optimal portfolio, validate trading suitability,
apply a new allocation, or create a proposal/order. A changed value can arise
from different dates or saved constraints; it is not evidence of improvement.

## Accepted comparison JSON export

An explicit download beside the comparison action preserves the complete
accepted comparison-response envelope. This includes both source identities
and their currentness at comparison time, incompatible-condition reasons,
original values and null deltas, and additional fields unknown to the current
interface. Serialization does not select only displayed rows or rename fields.
The filename includes both complete receipt identities. No API request,
recalculation or persistence occurs; the local Blob/anchor lifecycle revokes its
object URL after download, as for other paper research exports.

The button exists only for a completed response that passed the comparison's
account, receipt, content-fingerprint, method and integrity checks. Starting a
replacement request clears the previous download immediately. Errors or changes
to account, baseline, selected receipt, content fingerprint, refreshed
currentness, verification availability or loaded history context clear it too;
late responses cannot restore a download for old selections. Incompatible but
verified comparisons remain exportable with all of their unavailable reasons
and null differences. This export records that accepted response, not a fresh
currentness check or an instruction to apply or execute either allocation.
