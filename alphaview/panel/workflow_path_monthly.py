"""Describe calendar-month outcomes from one complete immutable saved path."""
from calendar import monthrange
from itertools import groupby
import math

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field

from . import paper_portfolio as paper, sessions, store
from . import workflow_path_receipts as receipts, workflow_path_receipt_comparison as comparison

ENGINE_VERSION = "alphaview-workflow-path-monthly-v1"
MAX_BYTES = 3 * 1024 * 1024
SESSIONS = 252
RETURN_ABS_TOLERANCE_PP, NAV_ABS_TOLERANCE, REL_TOLERANCE = 1e-9, 1e-6, 1e-10
TOLERANCES = {"return_absolute_percentage_points": RETURN_ABS_TOLERANCE_PP,
    "nav_absolute_units": NAV_ABS_TOLERANCE, "relative": REL_TOLERANCE}
METHOD = (
    "Read one verified immutable path-validation receipt without rebuilding a path or reading current market history. "
    "Require strict receipt self-basis and the exact 252 finite positive saved NAV observations on the historical XNYS "
    "calendar. Initial cash is the preceding saved signal-date boundary, not a valued month observation. Group all "
    "observations chronologically by calendar month, without dropping, sorting, intersecting, rebasing or filling. "
    "Each month starts from the preceding observed NAV boundary and ends at its last saved observation: return is "
    "(end NAV / boundary NAV - 1) * 100; NAV change is end NAV minus boundary NAV. Chain gross monthly returns; "
    "do not add percentage returns. Compare observed dates with every XNYS session in that calendar month: a month "
    "is complete only when its first and last trading sessions and every session between are observed. Partial first "
    "or last months have valid observed returns and explicit coverage; they are not represented as full months. "
    "Month completeness uses the saved historical calendar, never the current date. Year grids contain 12 months; "
    "months outside the saved observation window have null values and a reason, never zero returns. Reconcile final "
    "NAV and direct/chained total return with the saved metrics, and sum monthly NAV changes against end minus initial "
    "cash. Tolerances are absolute 1e-9 percentage points for return, absolute 1e-6 NAV units, and relative 1e-10. "
    "Invalid basis, dates, arithmetic or reconciliation makes the entire analysis unavailable; retain the full original. "
    "Currentness is a separate observation; stale verified historical receipts remain inspectable. This is not "
    "annualization, a benchmark, ranking, forecast, statistical pass, eligibility gate, execution source or trading "
    "instruction. No account/receipt mutation, provider, model or broker call."
)
router = APIRouter(route_class=receipts._FiniteRoute)


class MonthlyInput(paper.StrictInput):
    receipt_id: str = Field(pattern=receipts.HASH)
    expected_fingerprint: str = Field(pattern=receipts.HASH)
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)


def _problem(code, status=409):
    return receipts._problem(code, code, status)


def _expected(first, last):
    try:
        return sessions.expected_sessions(first, last)
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError("monthly_historical_calendar_unavailable") from error


def monthly(points):
    """Bounded deterministic aggregation; first point is the original preceding cash boundary."""
    if not isinstance(points, list) or not 2 <= len(points) <= SESSIONS + 1:
        raise ValueError("monthly_curve_size_unavailable")
    if any(not isinstance(row, dict) or not comparison._day(row.get("date"))
            or not comparison._finite(row.get("nav")) or row["nav"] <= 0 for row in points):
        raise ValueError("monthly_curve_values_unavailable")
    if any(first["date"] >= second["date"] for first, second in zip(points, points[1:])):
        raise ValueError("monthly_curve_dates_unavailable")
    dates = [point["date"] for point in points]
    if dates != _expected(dates[0], dates[-1]):
        raise ValueError("monthly_exact_historical_calendar_mismatch")
    rows, boundary = [], points[0]
    for key, grouped in groupby(points[1:], key=lambda point: point["date"][:7]):
        values = list(grouped)
        year, month = (int(part) for part in key.split("-"))
        expected = _expected(f"{key}-01", f"{key}-{monthrange(year, month)[1]:02d}")
        observed = [row["date"] for row in values]
        if not expected or observed != [day for day in expected if observed[0] <= day <= observed[-1]]:
            raise ValueError("monthly_month_calendar_mismatch")
        reasons = []
        if observed[0] != expected[0]: reasons.append("month_starts_after_first_session")
        if observed[-1] != expected[-1]: reasons.append("month_ends_before_last_session")
        end = values[-1]
        gross, change = end["nav"] / boundary["nav"], end["nav"] - boundary["nav"]
        return_pct = (gross - 1) * 100
        if gross <= 0 or not all(comparison._finite(value) for value in (gross, change, return_pct)):
            raise ValueError("monthly_arithmetic_unavailable")
        rows.append({"month": key, "year": year, "month_number": month,
            "status": "partial" if reasons else "complete", "reasons": reasons,
            "observed_start": observed[0], "observed_end": observed[-1],
            "expected_first_session": expected[0], "expected_last_session": expected[-1],
            "observed_sessions": len(observed), "expected_sessions": len(expected),
            "unobserved_month_sessions": len(expected) - len(observed),
            "boundary_date": boundary["date"], "boundary_nav": boundary["nav"],
            "boundary_kind": "initial_cash" if not rows else "preceding_saved_nav", "end_nav": end["nav"],
            "gross_return": gross, "return_pct": return_pct, "nav_change": change})
        boundary = end
    initial, final = points[0]["nav"], points[-1]["nav"]
    try:
        chained_gross = math.prod(row["gross_return"] for row in rows)
        summed_change = math.fsum(row["nav_change"] for row in rows)
        direct_gross = final / initial
        direct_return, chained_return = (direct_gross - 1) * 100, (chained_gross - 1) * 100
        chained_final = initial * chained_gross
    except (ValueError, OverflowError) as error:
        raise ValueError("monthly_arithmetic_unavailable") from error
    if (chained_gross <= 0 or direct_gross <= 0 or chained_final <= 0
            or not all(comparison._finite(value) for value in (chained_gross, summed_change,
                direct_return, chained_return, chained_final))):
        raise ValueError("monthly_arithmetic_unavailable")
    lookup = {row["month"]: row for row in rows}
    years = []
    for year in range(rows[0]["year"], rows[-1]["year"] + 1):
        cells = []
        for month in range(1, 13):
            key = f"{year:04d}-{month:02d}"
            row = lookup.get(key)
            cells.append({"month": key, "month_number": month,
                "status": row["status"] if row else "outside_window",
                "reasons": row["reasons"] if row else ["outside_saved_window"],
                **{field: row[field] if row else None for field in
                    ("return_pct", "nav_change", "observed_sessions", "expected_sessions", "observed_start", "observed_end")}})
        years.append({"year": year, "months": cells})
    summary = {"observed_month_count": len(rows), "complete_month_count": sum(row["status"] == "complete" for row in rows),
        "partial_month_count": sum(row["status"] == "partial" for row in rows), "valued_sessions": len(points) - 1,
        "initial_cash": initial, "final_value": final, "nav_change": final - initial,
        "summed_monthly_nav_change": summed_change, "direct_return_pct": direct_return,
        "chained_return_pct": chained_return, "chained_final_value": chained_final,
        "first_observed_date": dates[1], "last_observed_date": dates[-1]}
    return {"months": rows, "years": years, "summary": summary,
        "historical_calendar": {"exchange": "XNYS", "signal_date": dates[0], "as_of": dates[-1],
            "valued_sessions": len(points) - 1, "initial_cash_anchor_index": 0}}


def analyze(payload):
    evidence = payload["evidence"]
    checks = comparison._basis(payload, payload)
    reasons = ["monthly_basis_" + item["code"] for item in checks if not item["matches"]]
    unavailable = {"status": "unavailable", "reasons": reasons, "months": None, "years": None, "summary": None,
        "basis_checks": [{"code": item["code"], "available": item["matches"]} for item in checks],
        "historical_calendar": None, "reconciliation": None}
    if reasons:
        return unavailable
    if evidence["window"]["sessions"] != SESSIONS or len(evidence["curve"]) != SESSIONS:
        reasons.append("monthly_exact_session_count_required")
        return unavailable
    points = [{"date": evidence["window"]["signal_start"], "nav": evidence["metrics"]["initial_cash"]},
        *({"date": row["date"], "nav": row["value"]} for row in evidence["curve"])]
    try:
        result = monthly(points)
    except ValueError as error:
        reasons.append(str(error))
        return unavailable
    observed, saved = result["summary"], evidence["metrics"]
    reconciliation = []
    def check(code, computed, recorded, unit):
        tolerance = RETURN_ABS_TOLERANCE_PP if unit == "percentage_points" else NAV_ABS_TOLERANCE
        delta = computed - recorded
        reconciliation.append({"code": code, "computed": computed, "reference": recorded,
            "difference": delta if comparison._finite(delta) else None, "unit": unit,
            "within_tolerance": math.isclose(computed, recorded, abs_tol=tolerance, rel_tol=REL_TOLERANCE)})
    check("final_nav_matches_saved", observed["final_value"], saved["final_value"], "nav_units")
    check("direct_return_matches_saved", observed["direct_return_pct"], saved["return_pct"], "percentage_points")
    check("chained_return_matches_saved", observed["chained_return_pct"], saved["return_pct"], "percentage_points")
    check("chained_return_matches_direct", observed["chained_return_pct"], observed["direct_return_pct"], "percentage_points")
    check("monthly_nav_changes_match_total", observed["summed_monthly_nav_change"], observed["nav_change"], "nav_units")
    check("chained_final_nav_matches_final", observed["chained_final_value"], observed["final_value"], "nav_units")
    unavailable.update(reconciliation=reconciliation, historical_calendar=result["historical_calendar"])
    if not all(row["within_tolerance"] for row in reconciliation):
        reasons.append("monthly_saved_metrics_mismatch")
        return unavailable
    return {**unavailable, **result, "status": "evaluated"}


@router.post(comparison.BASE + "/monthly")
@store.snapshot_read
def inspect_monthly(account_id: comparison.AccountId, body: MonthlyInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        if account["version"] != body.expected_account_version:
            raise _problem("monthly_account_changed")
        row, payload = comparison._read(db, account_id, body.receipt_id, body.expected_fingerprint)
        if payload["kind"] != "path_validation":
            raise _problem("monthly_path_receipt_required", 422)
        checked_as_of = sessions.latest_completed_session()
        result = {"engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
            "account_id": account_id, "account_version": account["version"], "request": body.model_dump(),
            "original_receipt": payload, "receipt_summary": receipts._view(db, row, detail=False),
            "analysis": analyze(payload), "checked_as_of": checked_as_of, "checked_input_revision": store.input_revision(db),
            "tolerances": TOLERANCES, "max_export_bytes": MAX_BYTES, "execution_authority": False, "method": METHOD,
            "currentness_note": "Separate observation when inspected; saved monthly outcomes are not refreshed or made eligible."}
        if sessions.latest_completed_session() != checked_as_of:
            raise _problem("monthly_observation_session_changed")
        encoded = receipts._json(result)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("monthly_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
