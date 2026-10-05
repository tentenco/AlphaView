"""Describe all fixed-horizon overlapping windows in one immutable saved path."""
import math

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field

from . import paper_portfolio as paper, sessions, store
from . import workflow_path_receipts as receipts, workflow_path_receipt_comparison as comparison

ENGINE_VERSION = "alphaview-workflow-path-rolling-v1"
MAX_BYTES = 3 * 1024 * 1024
SESSIONS = 252
HORIZONS = (21, 63, 126)
RETURN_ABS_TOLERANCE_PP, NAV_ABS_TOLERANCE, REL_TOLERANCE = 1e-9, 1e-6, 1e-10
TOLERANCES = {"return_absolute_percentage_points": RETURN_ABS_TOLERANCE_PP,
    "nav_absolute_units": NAV_ABS_TOLERANCE, "relative": REL_TOLERANCE}
METHOD = (
    "Read one verified immutable path-validation receipt, without rebuilding a path or reading current market history. "
    "Require strict receipt self-basis and exactly 252 finite positive saved NAV observations on consecutive historical "
    "XNYS sessions, all completed by the single checked completed session. The preceding saved signal date is index zero "
    "and holds original initial cash. For each fixed horizon of 21, 63 and 126 observation sessions, enumerate every "
    "chronological start index 1 through 252-horizon+1. Boundary index is start-1; end index is start+horizon-1. "
    "Total return is (ending NAV / preceding boundary NAV - 1) * 100; NAV change is ending minus boundary NAV. "
    "The first window uses initial cash; later windows use the immediately preceding saved NAV, never first-window NAV. "
    "Return all 232, 190 and 127 windows with their boundary/start/end indices, dates and NAV. Mechanical lowest/highest "
    "returns retain every exact computed numeric tie, in chronological window-number order; display rounding is not a "
    "tie rule and no winner is selected. Reconcile full-path final NAV and total return to the saved metrics with "
    "absolute 1e-6 NAV units, 1e-9 percentage points and relative 1e-10 tolerance. Any invalid basis, calendar, value, "
    "arithmetic or reconciliation makes the entire analysis unavailable; never skip, fill, sort, repair or rebase rows. "
    "Windows overlap and describe one historical path, not independent samples, a forecast, statistical confidence, "
    "a statistical pass, annualized performance, a benchmark, allocation choice, eligibility gate or trading instruction. "
    "No new cost adjustment; saved NAV already reflects its recorded baseline assumptions. Currentness is observed "
    "separately; stale verified historical receipts remain inspectable. No account/receipt mutation, provider, model "
    "or broker call. Preserve the complete original receipt and refuse exports above 3 MiB without partial results."
)
router = APIRouter(route_class=receipts._FiniteRoute)


class RollingInput(paper.StrictInput):
    receipt_id: str = Field(pattern=receipts.HASH)
    expected_fingerprint: str = Field(pattern=receipts.HASH)
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)


def _problem(code, status=409):
    return receipts._problem(code, code, status)


def rolling(points):
    """Every fixed window uses the point immediately before its first valued session."""
    if not isinstance(points, list) or len(points) != SESSIONS + 1:
        raise ValueError("rolling_exact_session_count_required")
    if any(not isinstance(row, dict) or not comparison._day(row.get("date"))
           or not comparison._finite(row.get("nav")) or row["nav"] <= 0 for row in points):
        raise ValueError("rolling_curve_values_unavailable")
    if any(first["date"] >= second["date"] for first, second in zip(points, points[1:])):
        raise ValueError("rolling_curve_dates_unavailable")
    dates = [point["date"] for point in points]
    try:
        calendar = sessions.expected_sessions(dates[0], dates[-1])
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError("rolling_historical_calendar_unavailable") from error
    if dates != calendar:
        raise ValueError("rolling_exact_historical_calendar_mismatch")
    horizons = []
    for horizon in HORIZONS:
        windows = []
        for start in range(1, SESSIONS - horizon + 2):
            boundary_index, end_index = start - 1, start + horizon - 1
            boundary, first, end = points[boundary_index], points[start], points[end_index]
            gross, change = end["nav"] / boundary["nav"], end["nav"] - boundary["nav"]
            returned = (gross - 1) * 100
            if gross <= 0 or not all(comparison._finite(value) for value in (gross, change, returned)):
                raise ValueError("rolling_arithmetic_unavailable")
            windows.append({"window_number": start, "horizon_sessions": horizon,
                "boundary_index": boundary_index, "start_index": start, "end_index": end_index,
                "boundary_date": boundary["date"], "observed_start": first["date"], "observed_end": end["date"],
                "boundary_kind": "initial_cash" if boundary_index == 0 else "preceding_saved_nav",
                "boundary_nav": boundary["nav"], "start_nav": first["nav"], "end_nav": end["nav"],
                "gross_return": gross, "return_pct": returned, "nav_change": change})
        lowest = min(row["return_pct"] for row in windows)
        highest = max(row["return_pct"] for row in windows)
        horizons.append({"horizon_sessions": horizon, "expected_window_count": SESSIONS - horizon + 1,
            "window_count": len(windows), "windows": windows,
            "lowest": {"return_pct": lowest, "window_numbers": [row["window_number"] for row in windows if row["return_pct"] == lowest]},
            "highest": {"return_pct": highest, "window_numbers": [row["window_number"] for row in windows if row["return_pct"] == highest]}})
    initial, final = points[0]["nav"], points[-1]["nav"]
    gross, returned, change = final / initial, (final / initial - 1) * 100, final - initial
    if gross <= 0 or not all(comparison._finite(value) for value in (gross, returned, change)):
        raise ValueError("rolling_arithmetic_unavailable")
    return {"horizons": horizons,
        "historical_calendar": {"exchange": "XNYS", "signal_date": dates[0], "as_of": dates[-1],
            "valued_sessions": SESSIONS, "initial_cash_anchor_index": 0},
        "summary": {"valued_sessions": SESSIONS, "total_window_count": sum(row["window_count"] for row in horizons),
            "initial_cash": initial, "final_value": final, "direct_return_pct": returned, "nav_change": change,
            "first_observed_date": dates[1], "last_observed_date": dates[-1],
            "overlapping_windows": True, "independent_samples": False}}


def analyze(payload, checked_as_of=None):
    evidence = payload["evidence"]
    checks = comparison._basis(payload, payload)
    reasons = ["rolling_basis_" + item["code"] for item in checks if not item["matches"]]
    unavailable = {"status": "unavailable", "reasons": reasons, "horizons": None, "summary": None,
        "basis_checks": [{"code": item["code"], "available": item["matches"]} for item in checks],
        "historical_calendar": None, "reconciliation": None}
    if reasons:
        return unavailable
    if evidence["metrics"]["final_value"] <= 0:
        reasons.append("rolling_saved_final_nav_unavailable")
        return unavailable
    if evidence["window"]["sessions"] != SESSIONS or len(evidence["curve"]) != SESSIONS:
        reasons.append("rolling_exact_session_count_required")
        return unavailable
    checked_as_of = checked_as_of if checked_as_of is not None else sessions.latest_completed_session()
    if not comparison._day(checked_as_of) or evidence["as_of"] > checked_as_of:
        reasons.append("rolling_sessions_not_completed")
        return unavailable
    points = [{"date": evidence["window"]["signal_start"], "nav": evidence["metrics"]["initial_cash"]},
        *({"date": row["date"], "nav": row["value"]} for row in evidence["curve"])]
    try:
        result = rolling(points)
    except ValueError as error:
        reasons.append(str(error))
        return unavailable
    observed, saved = result["summary"], evidence["metrics"]
    reconciliation = []
    for code, computed, recorded, unit, tolerance in (
        ("final_nav_matches_saved", observed["final_value"], saved["final_value"], "nav_units", NAV_ABS_TOLERANCE),
        ("direct_return_matches_saved", observed["direct_return_pct"], saved["return_pct"], "percentage_points", RETURN_ABS_TOLERANCE_PP),
    ):
        delta = computed - recorded
        reconciliation.append({"code": code, "computed": computed, "reference": recorded,
            "difference": delta if comparison._finite(delta) else None, "unit": unit,
            "within_tolerance": math.isclose(computed, recorded, abs_tol=tolerance, rel_tol=REL_TOLERANCE)})
    unavailable.update(reconciliation=reconciliation, historical_calendar=result["historical_calendar"])
    if not all(row["within_tolerance"] for row in reconciliation):
        reasons.append("rolling_saved_metrics_mismatch")
        return unavailable
    return {**unavailable, **result, "status": "evaluated"}


@router.post(comparison.BASE + "/rolling")
@store.snapshot_read
def inspect_rolling(account_id: comparison.AccountId, body: RollingInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        if account["version"] != body.expected_account_version:
            raise _problem("rolling_account_changed")
        row, payload = comparison._read(db, account_id, body.receipt_id, body.expected_fingerprint)
        if payload["kind"] != "path_validation":
            raise _problem("rolling_path_receipt_required", 422)
        checked_as_of = sessions.latest_completed_session()
        result = {"engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
            "account_id": account_id, "account_version": account["version"], "request": body.model_dump(),
            "original_receipt": payload, "receipt_summary": receipts._view(db, row, detail=False),
            "analysis": analyze(payload, checked_as_of), "checked_as_of": checked_as_of,
            "checked_input_revision": store.input_revision(db), "tolerances": TOLERANCES,
            "max_export_bytes": MAX_BYTES, "execution_authority": False, "method": METHOD,
            "currentness_note": "Separate observation when inspected; saved rolling windows are not refreshed or made eligible."}
        if sessions.latest_completed_session() != checked_as_of:
            raise _problem("rolling_observation_session_changed")
        encoded = receipts._json(result)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("rolling_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
