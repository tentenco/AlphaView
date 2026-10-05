"""Inspect chronological drawdown episodes in one immutable saved path receipt."""
import math

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field

from . import paper_portfolio as paper, sessions, store
from . import workflow_path_receipts as receipts, workflow_path_receipt_comparison as comparison

ENGINE_VERSION = "alphaview-workflow-path-drawdowns-v1"
MAX_BYTES = 3 * 1024 * 1024
SESSIONS = 252
ABS_TOLERANCE_PP, REL_TOLERANCE = 1e-9, 1e-10
METHOD = (
    "Read one verified immutable path-validation receipt without rebuilding its path or reading current market history. "
    "Require the strict receipt self-basis and all 252 finite positive NAV observations on the exact saved historical "
    "XNYS calendar. Begin at saved initial cash on the preceding signal date, index zero. Outside an episode, update "
    "the peak on NAV >= peak, retaining the latest plateau date. First NAV below that peak starts an episode with "
    "a frozen peak; retain the first strict minimum as its observed trough. First NAV >= that frozen peak recovers "
    "the episode. Closed duration is recovery index minus peak index; underwater counts exclude the recovery row. "
    "An open terminal episode has no recovery or completed duration: expose observed elapsed and underwater counts "
    "only, without future filling. All durations are XNYS observation-session intervals, not calendar days. Keep "
    "episodes in chronological order. Reconcile minimum negative depth with the saved max_drawdown_pct using "
    "absolute 1e-9 percentage points and relative 1e-10 tolerance. Any invalid basis, curve, calendar or reconciliation "
    "makes the entire analysis unavailable: never drop, sort, interpolate, rebase or repair rows. No episodes means "
    "known zero drawdown/counts; episode durations remain null. Source currentness is a separate observation; stale "
    "verified originals remain inspectable. This is not a forecast, risk ranking, eligibility gate, execution "
    "source or trading instruction. No receipt/account mutation, provider, model or broker call."
)
router = APIRouter(route_class=receipts._FiniteRoute)


class DrawdownInput(paper.StrictInput):
    receipt_id: str = Field(pattern=receipts.HASH)
    expected_fingerprint: str = Field(pattern=receipts.HASH)
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)


def _problem(code, status=409):
    return receipts._problem(code, code, status)


def episodes(points):
    """Pure chronological oracle; first point is the original pre-path cash anchor."""
    if not isinstance(points, list) or not 1 <= len(points) <= SESSIONS + 1:
        raise ValueError("drawdown_curve_size_unavailable")
    if any(not isinstance(row, dict) or not comparison._day(row.get("date"))
           or not comparison._finite(row.get("nav")) or row["nav"] <= 0 for row in points):
        raise ValueError("drawdown_curve_values_unavailable")
    if any(first["date"] >= second["date"] for first, second in zip(points, points[1:])):
        raise ValueError("drawdown_curve_dates_unavailable")
    peak_index, peak = 0, points[0]["nav"]
    active, result, curve = None, [], []
    for index, point in enumerate(points):
        value = point["nav"]
        if active is None and value >= peak:
            peak_index, peak = index, value
        if active is None and value < peak:
            active = {"episode": len(result) + 1, "status": "open", "peak_index": peak_index,
                "peak_date": points[peak_index]["date"], "peak_nav": peak,
                "first_underwater_index": index, "first_underwater_date": point["date"],
                "trough_index": index, "trough_date": point["date"], "trough_nav": value,
                "depth_pct": (value / peak - 1) * 100, "recovery_index": None, "recovery_date": None,
                "recovery_nav": None, "duration_sessions": None, "underwater_sessions": None,
                "to_trough_sessions": index - peak_index, "trough_to_recovery_sessions": None,
                "observed_underwater_sessions": 0, "observed_elapsed_sessions": 0,
                "observed_through_index": index, "observed_through_date": point["date"]}
        episode_id = active["episode"] if active else None
        running_peak = active["peak_nav"] if active else peak
        depth = 0.0 if value >= running_peak else (value / running_peak - 1) * 100
        if not comparison._finite(depth):
            raise ValueError("drawdown_arithmetic_unavailable")
        if active is not None:
            active.update(observed_elapsed_sessions=index - active["peak_index"],
                observed_through_index=index, observed_through_date=point["date"])
            if value < active["peak_nav"]:
                active["observed_underwater_sessions"] += 1
                if value < active["trough_nav"]:
                    active.update(trough_index=index, trough_date=point["date"], trough_nav=value,
                        depth_pct=depth, to_trough_sessions=index - active["peak_index"])
            else:
                active.update(status="recovered", recovery_index=index, recovery_date=point["date"], recovery_nav=value,
                    duration_sessions=index - active["peak_index"], underwater_sessions=active["observed_underwater_sessions"],
                    trough_to_recovery_sessions=index - active["trough_index"])
                result.append(active)
                active = None
                peak_index, peak = index, value
                running_peak = peak
        curve.append({"index": index, "date": point["date"], "nav": value,
            "peak_nav": running_peak, "drawdown_pct": depth, "episode": episode_id})
    if active is not None:
        result.append(active)
    closed = [row for row in result if row["status"] == "recovered"]
    summary = {"episode_count": len(result), "recovered_episode_count": len(closed),
        "open_episode_count": len(result) - len(closed), "unrecovered_at_end": active is not None,
        "max_drawdown_pct": min((row["depth_pct"] for row in result), default=0.0),
        "total_underwater_sessions": sum(row["observed_underwater_sessions"] for row in result),
        "longest_observed_underwater_sessions": max((row["observed_underwater_sessions"] for row in result), default=0),
        "longest_closed_duration_sessions": max((row["duration_sessions"] for row in closed), default=None),
        "longest_observed_elapsed_sessions": max((row["observed_elapsed_sessions"] for row in result), default=None)}
    return {"episodes": result, "curve": curve, "summary": summary}


def analyze(payload):
    evidence = payload["evidence"]
    checks = comparison._basis(payload, payload)
    reasons = ["drawdown_basis_" + item["code"] for item in checks if not item["matches"]]
    unavailable = {"status": "unavailable", "reasons": reasons, "episodes": None, "curve": None, "summary": None,
        "basis_checks": [{"code": item["code"], "available": item["matches"]} for item in checks],
        "reconciliation": None, "historical_calendar": None}
    if reasons:
        return unavailable
    window, values = evidence["window"], evidence["curve"]
    try:
        calendar = sessions.expected_sessions(window["signal_start"], evidence["as_of"])
    except (ValueError, TypeError, OverflowError):
        unavailable["reasons"].append("drawdown_historical_calendar_unavailable")
        return unavailable
    dates = comparison._dates(evidence)
    if (len(calendar) != SESSIONS + 1 or window["sessions"] != SESSIONS or dates != calendar[1:]
            or calendar[0] != window["signal_start"] or calendar[-1] != evidence["as_of"]):
        unavailable["reasons"].append("drawdown_exact_historical_calendar_mismatch")
        return unavailable
    unavailable["historical_calendar"] = {"exchange": "XNYS", "signal_date": calendar[0], "as_of": calendar[-1],
        "valued_sessions": SESSIONS, "initial_cash_anchor_index": 0}
    points = [{"date": calendar[0], "nav": evidence["metrics"]["initial_cash"]},
              *({"date": row["date"], "nav": row["value"]} for row in values)]
    try:
        result = episodes(points)
    except ValueError as error:
        unavailable["reasons"].append(str(error))
        return unavailable
    observed, recorded = result["summary"]["max_drawdown_pct"], evidence["metrics"]["max_drawdown_pct"]
    reconciled = math.isclose(observed, recorded, abs_tol=ABS_TOLERANCE_PP, rel_tol=REL_TOLERANCE)
    difference = observed - recorded
    unavailable["reconciliation"] = {"computed_max_drawdown_pct": observed, "recorded_max_drawdown_pct": recorded,
        "difference_percentage_points": difference if comparison._finite(difference) else None,
        "within_tolerance": reconciled, "absolute_tolerance_percentage_points": ABS_TOLERANCE_PP,
        "relative_tolerance": REL_TOLERANCE}
    if not reconciled:
        unavailable["reasons"].append("drawdown_saved_metric_mismatch")
        return unavailable
    return {**unavailable, **result, "status": "evaluated"}


@router.post(comparison.BASE + "/drawdowns")
@store.snapshot_read
def inspect_drawdowns(account_id: comparison.AccountId, body: DrawdownInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        if account["version"] != body.expected_account_version:
            raise _problem("drawdown_account_changed")
        row, payload = comparison._read(db, account_id, body.receipt_id, body.expected_fingerprint)
        if payload["kind"] != "path_validation":
            raise _problem("drawdown_path_receipt_required", 422)
        checked_as_of = sessions.latest_completed_session()
        result = {"engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
            "account_id": account_id, "account_version": account["version"], "request": body.model_dump(),
            "original_receipt": payload, "receipt_summary": receipts._view(db, row, detail=False),
            "analysis": analyze(payload), "checked_as_of": checked_as_of, "checked_input_revision": store.input_revision(db),
            "currentness_note": "Separate observation when inspected; historical values are not refreshed or made eligible.",
            "max_export_bytes": MAX_BYTES, "execution_authority": False, "method": METHOD}
        if sessions.latest_completed_session() != checked_as_of:
            raise _problem("drawdown_observation_session_changed")
        encoded = receipts._json(result)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("drawdown_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
