"""Four chronological slices of one saved-setting path, never independent validation folds."""
import hashlib
import json
import math

from fastapi import APIRouter, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from . import sessions, store, workflow_path_validation as path

ENGINE_VERSION = "alphaview-workflow-path-segments-v1"
SEGMENTS, SEGMENT_SESSIONS = 4, 63
METHOD = (
    "Chronological decomposition of exactly one alphaview-workflow-path-validation-v1 trajectory. "
    "Retain the entire original path evidence unchanged. Divide its 252 valued closes into four fixed, "
    "nonoverlapping 63-session slices; do not rerun selection, reset cash/positions, train or optimize. "
    "The first boundary is initial cash at the signal_start preceding close; later boundaries are the "
    "preceding slice's final raw-close NAV. Segment return is 100*(end/boundary-1); net change is "
    "end-boundary. Segment growth factors multiply to the full path growth factor, and net changes "
    "sum to the full path change, subject only to floating-point arithmetic. Drawdown is nonpositive: "
    "min(0,100*(NAV/running_peak-1)), with running_peak initialized to boundary NAV. Assign saved "
    "decisions and execution events by their trade_date, including the first and last slice dates. "
    "Count individual buy/sell trade legs, sum saved event fees, and sum absolute saved trade notionals. "
    "Turnover_pct is 100*two-sided traded_notional/boundary_NAV, with no halving or annualization. "
    "Normalized curves include the preceding-close boundary at index 100 followed by 63 closes; this "
    "is a display normalization, not a new account. Unavailable baseline or incomplete support retains "
    "all four targeted slices with null metrics, zero covered sessions, known observed counts and reasons. "
    "No extra history load, Sharpe, PBO, CPCV, ranking, pass verdict, independent folds, out-of-sample "
    "claim, proposal, write, provider, model or broker call."
)
WARNINGS = [
    "四段來自同一條連續路徑，部位與現金跨段延續；不是四個獨立樣本、訓練／測試切分或 CPCV。",
    "候選清單、設定與目前修訂日線仍含事後選擇偏差；切成四段不會產生樣本外證明。",
    "各段最大回撤包含期初邊界資產，採負值或零；不等於完整路徑的最大回撤，不能相加。",
    "周轉率使用買入加賣出的總成交額除以該段期初資產，不除以二、不年化；成交筆數是個別買賣明細。",
    "各段報酬須連乘，不能直接相加；淨資產增減、費用與成交金額可相加。沒有最佳期間排名或通過判定。",
]


class _FiniteRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def validate(request):
            try:
                return await handler(request)
            except RequestValidationError as error:
                return JSONResponse({"detail": [{key: item[key] for key in ("loc", "msg", "type")}
                    for item in error.errors()]}, status_code=422, headers={"Cache-Control": "no-store"})
        return validate


router = APIRouter(route_class=_FiniteRoute)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _number(value, *, positive=False):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and (value > 0 if positive else value >= 0)


def _finite(value):
    if isinstance(value, dict):
        return all(_finite(item) for item in value.values())
    if isinstance(value, (tuple, list)):
        return all(_finite(item) for item in value)
    return not isinstance(value, float) or math.isfinite(value)


def _calendar(baseline):
    window = baseline["window"]
    if not window.get("signal_start") or not window.get("end"):
        return []
    dates = sessions.expected_sessions(window["signal_start"], window["end"])
    return dates if (len(dates) == SEGMENTS * SEGMENT_SESSIONS + 1
        and dates[0] == window["signal_start"] and dates[1] == window["start"]
        and dates[-1] == window["end"] and window["sessions"] == 252) else []


def _empty_segment(index, calendar, baseline):
    start, end = index * SEGMENT_SESSIONS, (index + 1) * SEGMENT_SESSIONS
    dates = calendar[start + 1:end + 1] if calendar else []
    observed = {row.get("date") for row in baseline["curve"] if isinstance(row, dict) and row.get("date") in dates}
    decision_indices = [offset for offset, row in enumerate(baseline["decisions"]) if row.get("trade_date") in dates]
    event_indices = [offset for offset, row in enumerate(baseline["events"]) if row.get("trade_date") in dates]
    return {"segment": index + 1, "status": "unavailable", "reasons": [],
        "window": {"boundary_date": calendar[start] if calendar else None, "start": dates[0] if dates else None,
            "end": dates[-1] if dates else None, "first_path_session": start + 1, "last_path_session": end,
            "boundary_source": "initial_cash_at_preceding_close" if index == 0 else "previous_segment_final_close"},
        "coverage": {"required_sessions": SEGMENT_SESSIONS, "observed_sessions": len(observed), "covered_sessions": 0,
            "known_decisions": len(decision_indices), "known_events": len(event_indices)},
        "decision_indices": decision_indices, "event_indices": event_indices, "curve_indices": [start, end],
        "metrics": None, "normalized_curve": []}


def _support(baseline, calendar):
    curve, events, metrics = baseline["curve"], baseline["events"], baseline["metrics"]
    if (not calendar or len(curve) != 252 or [row.get("date") for row in curve] != calendar[1:]
            or baseline["coverage"]["valued_path_sessions"] != 252 or not isinstance(metrics, dict)
            or not _number(metrics.get("initial_cash"), positive=True)
            or metrics["initial_cash"] != baseline["settings"]["initial_cash"]
            or any(not _number(row.get("value"), positive=True) for row in curve)):
        return False
    prior = dict(zip(calendar[1:], calendar[:-1]))
    if len({event["trade_date"] for event in events}) != len(events):
        return False
    for event in events:
        if (event["trade_date"] not in prior or event["signal_date"] != prior[event["trade_date"]]
                or not _number(event.get("fee"))
                or any(not _number(trade.get("fee")) or not _number(trade.get("notional")) for trade in event["trades"])
                or not math.isclose(event["fee"], math.fsum(trade["fee"] for trade in event["trades"]), rel_tol=1e-10, abs_tol=1e-10)):
            return False
    if any(row.get("trade_date") not in prior or row.get("signal_date") != prior[row["trade_date"]] for row in baseline["decisions"]):
        return False
    expected = {"final_value": curve[-1]["value"], "return_pct": (curve[-1]["value"] / metrics["initial_cash"] - 1) * 100,
        "total_fees": math.fsum(event["fee"] for event in events),
        "traded_notional": math.fsum(trade["notional"] for event in events for trade in event["trades"]),
        "trade_count": sum(len(event["trades"]) for event in events)}
    return all(isinstance(metrics.get(key), (int, float)) and not isinstance(metrics[key], bool)
        and math.isclose(metrics[key], value, rel_tol=1e-10, abs_tol=1e-10) for key, value in expected.items())


def _fill_segment(segment, baseline):
    start, end = segment["curve_indices"]
    boundary = baseline["metrics"]["initial_cash"] if start == 0 else baseline["curve"][start - 1]["value"]
    curve = baseline["curve"][start:end]
    peak, drawdown = boundary, 0.0
    for row in curve:
        peak = max(peak, row["value"])
        drawdown = min(drawdown, (row["value"] / peak - 1) * 100)
    events = [baseline["events"][index] for index in segment["event_indices"]]
    notional = math.fsum(trade["notional"] for event in events for trade in event["trades"])
    final = curve[-1]["value"]
    metrics = {"boundary_value": boundary, "final_value": final, "net_change": final - boundary,
        "return_pct": (final / boundary - 1) * 100, "max_drawdown_pct": drawdown,
        "total_fees": math.fsum(event["fee"] for event in events), "traded_notional": notional,
        "turnover_pct": notional / boundary * 100, "trade_count": sum(len(event["trades"]) for event in events)}
    normalized = [{"date": segment["window"]["boundary_date"], "session": 0, "index_value": 100.0}]
    normalized.extend({"date": row["date"], "session": index + 1, "index_value": row["value"] / boundary * 100}
        for index, row in enumerate(curve))
    if not _finite(metrics) or not _finite(normalized):
        raise ValueError("Nonfinite segment arithmetic")
    segment.update(status="evaluated", metrics=metrics, normalized_curve=normalized)
    segment["coverage"]["covered_sessions"] = SEGMENT_SESSIONS


def decompose(baseline):
    calendar = _calendar(baseline)
    segments = [_empty_segment(index, calendar, baseline) for index in range(SEGMENTS)]
    reasons = ([{"code": "baseline_unavailable"}, *baseline["reasons"]] if baseline["status"] != "evaluated" else [])
    if not reasons and not _support(baseline, calendar):
        reasons = [{"code": "path_support_incomplete"}]
    reconciliation = None
    if not reasons:
        try:
            for segment in segments:
                _fill_segment(segment, baseline)
            metrics = [segment["metrics"] for segment in segments]
            chained = (math.prod(1 + item["return_pct"] / 100 for item in metrics) - 1) * 100
            full = baseline["metrics"]
            reconciliation = {"chained_return_pct": chained, "full_path_return_pct": full["return_pct"],
                "return_residual_pp": chained - full["return_pct"],
                "summed_net_change": math.fsum(item["net_change"] for item in metrics),
                "full_path_net_change": full["final_value"] - full["initial_cash"],
                "fees_residual": math.fsum(item["total_fees"] for item in metrics) - full["total_fees"],
                "notional_residual": math.fsum(item["traded_notional"] for item in metrics) - full["traded_notional"],
                "trade_count_residual": sum(item["trade_count"] for item in metrics) - full["trade_count"]}
            if not _finite(reconciliation) or not math.isclose(chained, full["return_pct"], rel_tol=1e-10, abs_tol=1e-10):
                raise ValueError("Segment chain mismatch")
        except (ValueError, OverflowError, ZeroDivisionError):
            reasons = [{"code": "segment_arithmetic_unavailable"}]
            reconciliation = None
    if reasons:
        for segment in segments:
            segment.update(status="unavailable", reasons=list(reasons), metrics=None, normalized_curve=[])
            segment["coverage"]["covered_sessions"] = 0
    return segments, reasons, reconciliation


def evaluate(identifier, body):
    baseline = path.evaluate(identifier, body)
    if not _finite(baseline):
        raise HTTPException(422, {"code": "path_segments_nonfinite_source", "message": "原路徑包含非有限值，不能形成分段證據"})
    segments, reasons, reconciliation = decompose(baseline)
    if sessions.latest_completed_session() != baseline["as_of"]:
        raise HTTPException(409, {"code": "workflow_path_segments_stale", "message": "分段期間交易日已變更；請重新檢查工作流"})
    segmentation = {"segments": SEGMENTS, "sessions_per_segment": SEGMENT_SESSIONS,
        "boundary": "preceding_close_nav", "drawdown_sign": "nonpositive", "turnover": "two_sided_notional_over_boundary_nav"}
    result = {"engine_version": ENGINE_VERSION, "path_engine_version": baseline["engine_version"],
        "agent_run_id": identifier, "proposal_fingerprint": baseline["proposal_fingerprint"],
        "input_revision": baseline["input_revision"], "as_of": baseline["as_of"], "current_at_snapshot": True,
        "mode": "advisory_only", "request": body.model_dump(), "baseline": baseline,
        "baseline_evidence_fingerprint": baseline["evidence_fingerprint"], "history_fingerprint": baseline["history_fingerprint"],
        "settings_fingerprint": baseline["settings_fingerprint"], "segmentation": segmentation,
        "segmentation_fingerprint": _hash({"engine_version": ENGINE_VERSION, **segmentation}),
        "status": "unavailable" if reasons else "evaluated", "reasons": reasons,
        "coverage": {"required_segments": SEGMENTS, "available_segments": sum(row["status"] == "evaluated" for row in segments),
            "required_path_sessions": SEGMENTS * SEGMENT_SESSIONS,
            "observed_path_sessions": sum(row["coverage"]["observed_sessions"] for row in segments),
            "covered_path_sessions": sum(row["coverage"]["covered_sessions"] for row in segments), "path_evaluations": 1},
        "segments": segments, "reconciliation": reconciliation, "method": METHOD, "warnings": list(WARNINGS)}
    result["evidence_fingerprint"] = _hash(result)
    return result


@router.post("/api/portfolio-agent/runs/{identifier}/path-segments")
@store.snapshot_read
def inspect_segments(identifier: str, body: path.PathValidationInput):
    return JSONResponse(evaluate(identifier, body), headers={"Cache-Control": "no-store"})
