"""Dense, bounded prefix diagnostics over one explicit Research Desk signal window."""
import hashlib

import numpy as np
from fastapi import APIRouter, HTTPException, Response
from pydantic import Field, model_validator

from . import research_desk as desk, research_integrity as integrity, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-research-prefix-coverage-v1"
MAX_HISTORY_BARS = 2000
MAX_CUTOFFS = 120
MIN_COMPARED_SESSIONS = 20
METHOD = (
    "One explicit signal-date window, one local symbol and one fixed Research Desk configuration. "
    "Build the trusted Series and signals from the original history start through the earlier of test_end "
    "and the latest completed XNYS session. Compare every eligible cutoff from the first selected "
    "post-warmup signal date plus 19 sessions through the penultimate history date. Rebuild each "
    "prefix independently from the original history start, including recursive Wilder RSI; compare "
    "only dates in the selected signal window. Entry, exit and validity compare exactly; actual numeric "
    "dependencies use rtol=1e-10 and atol=1e-12. At most 2000 stored bars and 120 cutoffs; exceeding "
    "either bound returns unavailable without sampling. Before means full-history output and after "
    "means rebuilt-prefix output. Detail rows are capped at 100 per category with full counts. "
    "Exhaustive coverage applies only to these eligible cutoffs, this configuration and current history. "
    "This is not a proof of causality or absence of all future-data leaks, a backtest or trading authority."
)
WARNINGS = [
    "Complete cutoff coverage is limited to this explicit window, fixed configuration and saved local history; it is not a causal proof.",
    "Cutoffs with fewer than 20 compared signal dates are outside the eligible set; earlier warmup data is retained for every rebuild.",
    "Adjusted bars are current local observations, not a reconstruction of historical data availability; revisions, survivor bias and execution are outside this diagnostic.",
    "A session compared under several cutoffs is counted repeatedly and is not an independent statistical sample.",
]


class PrefixCoverageInput(desk.agent.StrictInput):
    symbol: str = Field(min_length=1, max_length=10)
    config: desk.StrategyConfig
    test_start: str = Field(pattern=desk.DATE)
    test_end: str = Field(pattern=desk.DATE)
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_as_of: str = Field(pattern=desk.DATE)

    @model_validator(mode="after")
    def valid_request(self):
        desk._symbol(self.symbol)
        for value in (self.test_start, self.test_end, self.expected_as_of):
            desk._valid_date(value)
        if self.test_start > self.test_end:
            raise ValueError("開始日期不可晚於結束日期")
        return self


def _outputs(series, config):
    fields = integrity._outputs(series, config)
    # The crossover also consumes yesterday's SMAs. Observe these dependencies
    # only in this new method; the original sampled method remains unchanged.
    if config["strategy"] == "sma_cross":
        fields.update(previous_sma_fast=desk._shift(fields["sma_fast"]),
                      previous_sma_slow=desk._shift(fields["sma_slow"]))
    return fields


def _finish(result, code=None, message=None):
    if code:
        result["unavailable"].append({"code": code, "message": message})
    counts = result["counts"]
    counts["prefixes"] = len(result["prefixes"])
    for output, source in (("compared_session_pairs", "compared_sessions"),
                           ("compared_values", "compared_values"), ("differences", "difference_count"),
                           ("unavailable_values", "unavailable_values"),
                           ("invalid_signal_sessions", "invalid_signal_sessions")):
        counts[output] = sum(row[source] for row in result["prefixes"])
    result["differences_truncated"] = counts["differences"] > len(result["differences"])
    result["unavailable_values_truncated"] = counts["unavailable_values"] > len(result["unavailable_values"])
    coverage = result["coverage"]
    coverage["compared_cutoffs"] = len(result["prefixes"])
    coverage["failed_cutoffs"] = sum(row["status"] == "unavailable" for row in result["cutoff_manifest"])
    coverage["cutoff_coverage_complete"] = (coverage["required_cutoffs"] is not None
        and coverage["required_cutoffs"] > 0 and coverage["compared_cutoffs"] == coverage["required_cutoffs"])
    if counts["unavailable_values"] or counts["invalid_signal_sessions"]:
        result["unavailable"].append({"code": "incomplete_signal_coverage",
                                      "message": "Nonfinite dependencies or invalid signal dates remain unavailable."})
    coverage["complete"] = coverage["cutoff_coverage_complete"] and not result["unavailable"]
    result["status"] = ("differences_found" if counts["differences"] else
                        "no_difference_detected" if coverage["complete"] else "unavailable")
    result["evidence_fingerprint"] = hashlib.sha256(desk._json(result).encode()).hexdigest()
    return result


@router.post("/api/research-desk/prefix-coverage")
@store.snapshot_read
def inspect_prefix_coverage(body: PrefixCoverageInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    as_of, revision = sessions.latest_completed_session(), store.input_revision()
    if body.expected_input_revision != revision or body.expected_as_of != as_of:
        raise HTTPException(409, {"code": "prefix_coverage_source_changed",
            "message": "Local source revision or completed session changed. Refresh the diagnosis first."},
            headers={"Cache-Control": "no-store"})
    request = body.model_dump()
    effective_end = min(body.test_end, as_of)
    result = {"engine_version": ENGINE_VERSION, "desk_engine_version": desk.ENGINE_VERSION,
              "comparison_engine_version": integrity.ENGINE_VERSION,
              "as_of": as_of, "input_revision": revision, "current_at_snapshot": True,
              "symbol": body.symbol, "config": request["config"], "request": request,
              "fingerprint": None, "effective_end": effective_end, "window": None,
              "suggested_window": None, "fields": [], "cutoff_manifest": [], "prefixes": [],
              "differences": [], "unavailable_values": [], "unavailable": [],
              "coverage": {"required_cutoffs": None, "attempted_cutoffs": 0, "compared_cutoffs": 0,
                           "failed_cutoffs": 0, "manifest_complete": False,
                           "cutoff_coverage_complete": False, "complete": False},
              "counts": {"prefixes": 0, "compared_session_pairs": 0, "compared_values": 0,
                         "differences": 0, "unavailable_values": 0, "invalid_signal_sessions": 0},
              "limits": {"max_history_bars": MAX_HISTORY_BARS, "max_cutoffs": MAX_CUTOFFS,
                         "min_compared_sessions": MIN_COMPARED_SESSIONS,
                         "max_details": integrity.MAX_DETAILS,
                         "numeric_rtol": integrity.RTOL, "numeric_atol": integrity.ATOL},
              "method": METHOD, "warnings": list(WARNINGS)}
    with store.connect() as db:
        count = db.execute("SELECT count(*) FROM bars WHERE symbol=?", (body.symbol,)).fetchone()[0]
    result["stored_history_bars"] = count
    if count > MAX_HISTORY_BARS:
        return _finish(result, "history_limit", f"{count} stored bars exceed the {MAX_HISTORY_BARS}-bar limit; no Series was built.")
    try:
        full = desk.Series(body.symbol, effective_end)
        result["fingerprint"] = full.fingerprint
        before = _outputs(full, request["config"])
        result["fields"] = list(before)
        valid = np.flatnonzero(before["valid"])
        if not len(valid):
            result["coverage"]["required_cutoffs"] = 0
            result["coverage"]["manifest_complete"] = True
            return _finish(result, "insufficient_history", "No post-warmup signal date is available.")
        warmup_first = int(valid[0])
        first = max(warmup_first, next((i for i, day in enumerate(full.dates)
                                       if day >= body.test_start), len(full.dates)))
        selected_sessions = max(len(full.dates) - first, 0)
        required = max(selected_sessions - MIN_COMPARED_SESSIONS, 0)
        result["coverage"]["required_cutoffs"] = required
        result["window"] = {"start": full.dates[first] if first < len(full.dates) else None,
                            "end": full.dates[-1], "sessions": selected_sessions,
                            "warmup_start": full.dates[0], "history_sessions": len(full.dates),
                            "first_eligible_cutoff": full.dates[first + MIN_COMPARED_SESSIONS - 1] if required else None,
                            "last_eligible_cutoff": full.dates[-2] if required else None}
        # The suggestion is derived from actual retained dates. Applying it is a
        # separate user action and the next request still contains explicit dates.
        suggestion_first = max(warmup_first, len(full.dates) - 100)
        if len(full.dates) - suggestion_first >= MIN_COMPARED_SESSIONS + 1:
            result["suggested_window"] = {"test_start": full.dates[suggestion_first],
                                          "test_end": full.dates[-1],
                                          "signal_sessions": len(full.dates) - suggestion_first}
        if required > MAX_CUTOFFS:
            return _finish(result, "cutoff_limit", f"{required} eligible cutoffs exceed the {MAX_CUTOFFS}-cutoff limit; narrow the signal dates. No prefixes were sampled or rebuilt.")
        result["coverage"]["manifest_complete"] = True
        if not required:
            return _finish(result, "insufficient_history", "At least 20 compared signal dates and one later date are required.")
        result["cutoff_manifest"] = [{"cutoff_date": full.dates[i], "status": "pending",
                                      "fingerprint": None, "reason": None}
                                     for i in range(first + MIN_COMPARED_SESSIONS - 1, len(full.dates) - 1)]
        for item in result["cutoff_manifest"]:
            result["coverage"]["attempted_cutoffs"] += 1
            try:
                prefix = desk.Series(body.symbol, item["cutoff_date"])
                last = full.dates.index(item["cutoff_date"]) + 1
                if prefix.dates != full.dates[:last]:
                    raise desk.DeskError("date_mismatch", "Prefix dates do not match the corresponding full-history dates.")
                after = _outputs(prefix, request["config"])
                item.update(status="compared", fingerprint=prefix.fingerprint)
                result["prefixes"].append(integrity._compare(result, full, before, prefix, after, first))
            except desk.DeskError as error:
                item.update(status="unavailable", reason=error.code)
                result["unavailable"].append({"code": error.code, "message": error.message,
                                              "cutoff_date": item["cutoff_date"]})
    except desk.DeskError as error:
        return _finish(result, error.code, error.message)
    return _finish(result)
