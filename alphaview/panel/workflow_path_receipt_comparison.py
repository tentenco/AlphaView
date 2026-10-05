"""Read-only comparison of complete immutable path receipts, without rebuilding paths."""
from datetime import date
import math
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query
from fastapi.responses import Response
from pydantic import Field, model_validator

from . import paper_portfolio as paper, sessions, store, workflow_path_receipts as receipts

ENGINE_VERSION = "alphaview-workflow-path-receipt-comparison-v1"
MAX_BYTES = 5 * 1024 * 1024
BASE = "/api/paper/accounts/{account_id}/workflow-path-receipts"
AccountId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
METRICS = ("initial_cash", "final_value", "return_pct", "max_drawdown_pct", "total_fees", "traded_notional", "trade_count")
COSTS = ("fees", "slippage", "total", "raw_notional", "execution_notional")
METHOD = (
    "Compare two distinct verified immutable receipts of the same kind and account, including different saved workflows. "
    "Read original payloads only: never rebuild paths, fetch history, align overlapping dates, rebase, drop dates or fill gaps. "
    "Quantitative differences require identical saved receipt/evidence/path/workflow/scan/allocator versions, path method "
    "text, raw history fingerprint, candidate and RPS universes, complete exact valued-date window, initial cash and "
    "baseline fee/slippage basis, with finite complete required metrics. Workflow settings may differ and are displayed. "
    "Cost scenarios pair only identical fee/slippage assumptions; unmatched, unavailable or invalid pairs have null deltas. "
    "Deltas are selected minus baseline; return and drawdown deltas are percentage points. Differences are descriptive, "
    "not causal attribution to any setting. Source currentness is a separate observation: stale historical evidence may "
    "remain comparable. This is not a winner, rank, statistical pass, eligibility gate, execution source or trading advice. "
    "No account, workflow, receipt, provider, model or broker mutation. Export includes both complete original payloads."
)
router = APIRouter(route_class=receipts._FiniteRoute)


class CompareInput(paper.StrictInput):
    baseline_receipt_id: str = Field(pattern=receipts.HASH)
    selected_receipt_id: str = Field(pattern=receipts.HASH)
    expected_baseline_fingerprint: str = Field(pattern=receipts.HASH)
    expected_selected_fingerprint: str = Field(pattern=receipts.HASH)

    @model_validator(mode="after")
    def distinct(self):
        if self.baseline_receipt_id == self.selected_receipt_id:
            raise ValueError("Select two distinct immutable receipts")
        return self


def _problem(code, status=409):
    return receipts._problem(code, code, status)


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _baseline(payload):
    value = payload["evidence"]
    return value if payload["kind"] == "path_validation" else value["baseline"]


def _metrics(value, names=METRICS):
    return isinstance(value, dict) and all(_finite(value.get(key)) for key in names)


def _dates(value):
    curve = value.get("curve")
    if not isinstance(curve, list) or not curve:
        return None
    dates = []
    for row in curve:
        if not isinstance(row, dict) or not isinstance(row.get("date"), str) or not _finite(row.get("value")) or row["value"] <= 0:
            return None
        try:
            if date.fromisoformat(row["date"]).isoformat() != row["date"]:
                return None
        except ValueError:
            return None
        dates.append(row["date"])
    return dates if all(first < second for first, second in zip(dates, dates[1:])) else None


def _universe(value, *, empty=False):
    return (isinstance(value, list) and (empty or bool(value)) and all(isinstance(item, str) and item for item in value)
            and len(value) == len(set(value)))


def _day(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _basis(left, right):
    baselines = [_baseline(left), _baseline(right)]
    checks = []
    def check(code, a, b, valid=True):
        checks.append({"code": code, "matches": bool(valid and a == b), "baseline": a, "selected": b})
    versions = [{"receipt": item["engine_version"], **item["source_context"]["versions"]} for item in (left, right)]
    check("method_versions", *versions, all(set(value) == {"receipt", "evidence", "path", "workflow", "scan", "allocator"}
        and all(isinstance(item, str) and item for item in value.values()) for value in versions))
    check("pricing_method", *(item.get("method") for item in baselines), all(isinstance(item.get("method"), str) and item["method"] for item in baselines))
    history = [item.get("history_fingerprint") for item in baselines]
    import re
    check("raw_history", *history, all(isinstance(item, str) and re.fullmatch(receipts.HASH, item) for item in history))
    for key, empty in (("candidate_symbols", False), ("rps_universe", True)):
        values = [item.get(key) for item in baselines]
        check(key, *values, all(_universe(item, empty=empty) for item in values))
    windows, dates = [item.get("window") for item in baselines], [_dates(item) for item in baselines]
    valid_windows = all(isinstance(window, dict) and set(window) == {"signal_start", "start", "end", "sessions"}
        and type(window["sessions"]) is int and window["sessions"] > 0 and values is not None
        and len(values) == window["sessions"] and values[0] == window["start"] and values[-1] == window["end"]
        and _day(window["signal_start"]) and window["signal_start"] < window["start"] and window["end"] == item.get("as_of")
        for window, values, item in zip(windows, dates, baselines))
    check("exact_window", *windows, valid_windows)
    summaries = [{"count": len(value), "first": value[0], "last": value[-1], "fingerprint": receipts._hash(value)} if value else None for value in dates]
    check("exact_valued_dates", *summaries, all(value is not None for value in dates))
    coverage_valid = []
    for item, values in zip(baselines, dates):
        coverage = item.get("coverage", {})
        coverage_valid.append(item.get("status") == "evaluated" and item.get("reasons") == [] and values is not None
            and type(coverage.get("required_path_sessions")) is int and coverage["required_path_sessions"] == len(values)
            and type(coverage.get("valued_path_sessions")) is int and coverage["valued_path_sessions"] == len(values)
            and type(coverage.get("required_decisions")) is int and coverage["required_decisions"] > 0
            and type(coverage.get("available_decisions")) is int and type(coverage.get("evaluated_decisions")) is int
            and coverage.get("available_decisions") == coverage.get("evaluated_decisions") == coverage["required_decisions"]
            and len(item.get("decisions", [])) == coverage["required_decisions"])
    check("complete_coverage", *coverage_valid, all(coverage_valid))
    bases = []
    basis_valid = True
    for item in baselines:
        settings, metrics = item.get("settings", {}), item.get("metrics")
        basis = {key: settings.get(key) for key in ("initial_cash", "fee_bps", "slippage_bps")}
        basis_valid = basis_valid and _metrics(metrics) and all(_finite(value) for value in basis.values())
        basis_valid = basis_valid and basis["initial_cash"] > 0 and basis["fee_bps"] >= 0 and basis["slippage_bps"] >= 0
        basis_valid = basis_valid and metrics["initial_cash"] == basis["initial_cash"]
        bases.append(basis)
    check("initial_cash_and_baseline_costs", *bases, basis_valid)
    check("required_metrics", *[_metrics(item.get("metrics")) for item in baselines], all(_metrics(item.get("metrics")) for item in baselines))
    return checks


def _differences(left, right, prefix=""):
    if left == right:
        return []
    if isinstance(left, dict) and isinstance(right, dict):
        return [row for key in sorted(left.keys() | right.keys())
            for row in _differences(left.get(key), right.get(key), f"{prefix}.{key}" if prefix else key)]
    return [{"field": prefix, "baseline": left, "selected": right}]


def _deltas(left, right, names=METRICS):
    values = {key: right[key] - left[key] for key in names}
    return values if all(_finite(value) for value in values.values()) else None


def _scenario_pairs(left, right, basis_reasons):
    maps, invalid = [], False
    for payload in (left, right):
        mapping = {}
        for item in payload["evidence"].get("scenarios", []):
            if not isinstance(item, dict) or not all(_finite(item.get(key)) and 0 <= item[key] <= 100 for key in ("fee_bps", "slippage_bps")):
                invalid = True
                continue
            key = (item["fee_bps"], item["slippage_bps"])
            if key in mapping:
                invalid = True
            mapping[key] = item
        request = payload["request"]
        if set(mapping) != {(fee, slip) for fee in request["fee_bps"] for slip in request["slippage_bps"]}:
            invalid = True
        maps.append(mapping)
    if invalid:
        return [], ["duplicate_or_invalid_cost_pair"]
    pairs = []
    for fee, slip in sorted(maps[0].keys() | maps[1].keys()):
        a, b = maps[0].get((fee, slip)), maps[1].get((fee, slip))
        reasons = list(basis_reasons)
        if a is None or b is None:
            reasons.append("unpaired_cost_assumption")
        else:
            for item, payload in ((a, left), (b, right)):
                if item.get("status") != "evaluated" or item.get("reasons") != []:
                    reasons.append("scenario_unavailable")
                if not _metrics(item.get("metrics")) or not _metrics(item.get("costs"), COSTS):
                    reasons.append("scenario_metrics_unavailable")
                if _dates(item) is None or _dates(item) != _dates(_baseline(payload)):
                    reasons.append("scenario_dates_unavailable")
                if _metrics(item.get("metrics")) and item["metrics"]["initial_cash"] != _baseline(payload).get("settings", {}).get("initial_cash"):
                    reasons.append("scenario_initial_cash_mismatch")
        metrics = _deltas(a["metrics"], b["metrics"]) if not reasons else None
        costs = _deltas(a["costs"], b["costs"], COSTS) if not reasons else None
        if not reasons and (metrics is None or costs is None):
            reasons.append("nonfinite_delta")
            metrics = costs = None
        pairs.append({"fee_bps": fee, "slippage_bps": slip, "paired": a is not None and b is not None,
            "baseline_status": a.get("status") if a else None, "selected_status": b.get("status") if b else None,
            "metric_deltas": metrics, "cost_deltas": costs, "reasons": sorted(set(reasons))})
    return pairs, []


def _read(db, account_id, identifier, fingerprint):
    row = db.execute("SELECT * FROM workflow_path_receipts WHERE account_id=? AND id=?", (account_id, identifier)).fetchone()
    if row is None:
        raise _problem("comparison_receipt_scope_missing", 404)
    payload, issue = receipts._decode(row)
    if payload is None:
        raise _problem("comparison_receipt_unverifiable")
    if row["content_fingerprint"] != fingerprint:
        raise _problem("comparison_receipt_changed")
    return row, payload


@router.get(BASE)
@store.snapshot_read
def index(account_id: AccountId, kind: Literal["path_validation", "path_costs"] | None = None,
          limit: str = Query(default="20", pattern=r"^[1-9]\d?$"), offset: str = Query(default="0", pattern=r"^(0|[1-9]\d{0,2})$")):
    size, start = int(limit), int(offset)
    if size > 50 or start > receipts.MAX_TOTAL:
        raise _problem("comparison_index_bounds", 422)
    with store.connect() as db:
        account = paper._account(db, account_id)
        where, args = " WHERE account_id=?", [account_id]
        if kind is not None:
            where, args = where + " AND kind=?", [*args, kind]
        total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts" + where, args).fetchone()[0]
        if total > receipts.MAX_TOTAL:
            raise _problem("comparison_index_capacity", 422)
        rows = db.execute("SELECT * FROM workflow_path_receipts" + where + " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (*args, size, start)).fetchall()
        return receipts._reply({"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
            "kind": kind, "items": [receipts._view(db, row, detail=False) for row in rows],
            "pagination": {"limit": size, "offset": start, "total": total, "returned": len(rows)},
            "checked_as_of": sessions.latest_completed_session(), "checked_input_revision": store.input_revision(db), "method": METHOD})


@router.post(BASE + "/compare")
@store.snapshot_read
def compare(account_id: AccountId, body: CompareInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        first, left = _read(db, account_id, body.baseline_receipt_id, body.expected_baseline_fingerprint)
        second, right = _read(db, account_id, body.selected_receipt_id, body.expected_selected_fingerprint)
        if left["kind"] != right["kind"]:
            raise _problem("comparison_kind_mismatch", 422)
        checks = _basis(left, right)
        reasons = [item["code"] for item in checks if not item["matches"]]
        pairs, pair_reasons = _scenario_pairs(left, right, reasons) if left["kind"] == "path_costs" else ([], [])
        reasons.extend(pair_reasons)
        deltas = _deltas(_baseline(left)["metrics"], _baseline(right)["metrics"]) if not reasons else None
        if not reasons and deltas is None:
            reasons.append("nonfinite_delta")
        comparison = {"historically_comparable": not reasons, "reasons": reasons, "basis_checks": checks,
            "settings_differences": _differences(_baseline(left).get("settings"), _baseline(right).get("settings")),
            "source_context_differences": _differences(left["source_context"], right["source_context"]),
            "baseline_metric_deltas": deltas, "scenario_pairs": pairs,
            "direction": "selected_minus_baseline", "percentage_delta_unit": "percentage_points",
            "causal_attribution": False, "eligibility_authority": False}
        value = {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
            "kind": left["kind"], "request": body.model_dump(), "comparison": comparison,
            "baseline": {"summary": receipts._view(db, first, detail=False), "original_receipt": left},
            "selected": {"summary": receipts._view(db, second, detail=False), "original_receipt": right},
            "checked_as_of": sessions.latest_completed_session(), "checked_input_revision": store.input_revision(db),
            "currentness_note": "Separate observation at comparison time; retained historical values are not refreshed.",
            "max_export_bytes": MAX_BYTES, "method": METHOD}
        encoded = receipts._json(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("comparison_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
