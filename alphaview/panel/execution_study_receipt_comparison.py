"""Compare two immutable execution-study receipts; never rerun a study or read prices."""
from decimal import Decimal, InvalidOperation, localcontext
import math

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import Field, model_validator

from . import execution_study_receipts as receipts, paper_portfolio as paper, sessions, store

ENGINE_VERSION = "alphaview-execution-study-receipt-comparison-v1"
MAX_BYTES = 5 * 1024 * 1024
SUPPORTED = {"volume_day": "alphaview-execution-volume-study-v1", "limit_day": "alphaview-execution-limit-study-v1", "open_gtd": "alphaview-execution-gtd-study-v1"}
DAY_METRICS = {"raw_open": "USD_per_share", "session_volume": "shares", "capacity_shares": "shares",
    "scenario_shares": "shares", "expired_shares": "shares", "fill_fraction_pct": "percentage_points", "reference_notional": "USD"}
GTD_METRICS = {"observed_prefix_scenario_shares": "shares", "last_known_remaining_shares": "shares",
    "observed_prefix_reference_notional": "USD", "final_scenario_shares": "shares", "expired_shares": "shares", "final_reference_notional": "USD"}
SESSION_METRICS = {"raw_open": "USD_per_share", "session_volume": "shares", "remaining_before": "shares", "capacity_shares": "shares",
    "scenario_shares": "shares", "remaining_after": "shares", "reference_notional": "USD"}
METHOD = (
    "Read two distinct verified immutable execution-study receipts of the same account, saved proposal and kind. "
    "Never rebuild a study, read price/volume history, align overlapping dates, fill gaps or normalize coverage. "
    "Known-value deltas require identical understood receipt/study/helper versions and method text, exact saved "
    "proposal record and frozen orders/share precision, study evaluation revision/session/account policies, "
    "exact DAY session or GTD horizon, raw-bar fingerprint, and original evidence coverage. Participation and "
    "per-symbol limits may intentionally differ and are displayed. Changed GTD expiry, horizon or observed "
    "coverage is incompatible, including early completion that changes which later bars were required. "
    "If any basis check fails, all deltas are null and both originals remain visible. Otherwise pair finite "
    "known values by exact symbol and exact session; missing/null/unavailable values retain null differences "
    "with reasons, never zero. Use Decimal of the saved numeric representation for selected-minus-baseline "
    "differences, exported as finite JSON numbers with explicit units; original exact decimal strings remain "
    "in the original envelopes. No aggregate, winner, causal attribution, ranking or eligibility authority. "
    "Currentness is a separate observation; stale verified originals may remain comparable. Exports embed "
    "both original complete receipt JSON byte sequences literally, preserving their original hashes. "
    "This is not actual fills, opening liquidity, intraday limit chronology, trading advice or execution authorization."
)
router = APIRouter(route_class=receipts._FiniteRoute)


class CompareInput(paper.StrictInput):
    baseline_receipt_id: str = Field(pattern=receipts.HASH)
    selected_receipt_id: str = Field(pattern=receipts.HASH)
    expected_baseline_fingerprint: str = Field(pattern=receipts.HASH)
    expected_selected_fingerprint: str = Field(pattern=receipts.HASH)
    expected_account_version: int = Field(ge=1, le=2147483647, strict=True)

    @model_validator(mode="after")
    def distinct(self):
        if self.baseline_receipt_id == self.selected_receipt_id:
            raise ValueError("Choose two distinct saved study receipts")
        return self


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _equal(a, b):
    return receipts._json(a) == receipts._json(b)


def _read(db, account, proposal, identifier, expected):
    row = receipts._lookup(db, account, proposal, identifier)
    if row is None: raise receipts._problem("comparison_receipt_scope_missing", 404)
    payload, raw, _issue = receipts._decode(row)
    if payload is None: raise receipts._problem("comparison_receipt_unverifiable")
    if row["content_fingerprint"] != expected: raise receipts._problem("comparison_receipt_changed")
    return row, payload, raw


def _orders(evidence):
    values = evidence.get("orders")
    if not isinstance(values, list) or len(values) > 100:
        return None
    result = {}
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get("symbol"), str) or row["symbol"] in result:
            return None
        result[row["symbol"]] = row
    return result


def _steps(order):
    values = order.get("sessions")
    if not isinstance(values, list) or len(values) > 5:
        return None
    result = {}
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get("date"), str) or row["date"] in result:
            return None
        result[row["date"]] = row
    return result


def _coverage(evidence, kind):
    orders = _orders(evidence)
    if orders is None: return None
    rows = []
    for symbol, order in orders.items():
        row = {"symbol": symbol, "coverage": order.get("coverage")}
        if kind == "open_gtd":
            steps = _steps(order)
            if steps is None: return None
            row["sessions"] = [{"date": day, "session_completed": item.get("session_completed"),
                "evidence_present": isinstance(item.get("evidence"), dict), "status": item.get("status")} for day, item in steps.items()]
        else:
            raw = order.get("evidence")
            row["evidence"] = {key: isinstance(raw.get(key), dict) if isinstance(raw, dict) else False for key in ("signal_bar", "execution_bar", "dataset")}
        rows.append(row)
    return {"totals": evidence.get("coverage"), "rows": rows}


def _shape(evidence, kind):
    """Check saved identities and coverage; never recalculate scenario quantities."""
    try:
        orders, frozen = _orders(evidence), evidence["source"]["orders"]
        if (not orders or not isinstance(frozen, list) or evidence["source"]["engine_version"] != "alphaview-paper-portfolio-v2"
                or list(orders) != [item["symbol"] for item in frozen]):
            return False
        for fixed in frozen:
            row = orders[fixed["symbol"]]
            if any(not _equal(row.get(key), fixed.get(key)) for key in ("side", "shares", "shares_exact", "reference_price")):
                return False
            if kind == "open_gtd":
                steps = _steps(row)
                if steps is None or list(steps) != [day["date"] for day in evidence["horizon"]]:
                    return False
                if row["status"] not in ("scenario_full", "partial_expired", "unfilled_expired", "unavailable"):
                    return False
                if any(step["status"] not in ("evaluated", "unavailable", "future_unknown", "blocked_by_unknown", "not_required_scenario_full") for step in steps.values()):
                    return False
                counts = row["coverage"]
                if (any(type(counts.get(key)) is not int or counts[key] < 0 for key in
                        ("required_sessions", "evaluated_sessions", "not_required_sessions", "unknown_sessions"))
                        or counts["required_sessions"] != len(steps) or type(counts["complete"]) is not bool
                        or counts["evaluated_sessions"] != sum(step["status"] == "evaluated" for step in steps.values())
                        or counts["not_required_sessions"] != sum(step["status"] == "not_required_scenario_full" for step in steps.values())
                        or counts["unknown_sessions"] != sum(step["status"] in ("unavailable", "future_unknown", "blocked_by_unknown") for step in steps.values())):
                    return False
            elif row["status"] not in ("full", "partial_expired", "unfilled_expired", "not_marketable_at_open_expired", "unavailable"):
                return False
        coverage = evidence["coverage"]
        if kind == "open_gtd":
            return (all(type(coverage.get(key)) is int for key in ("required_orders", "complete_orders", "unavailable_orders"))
                    and coverage["required_orders"] == len(orders)
                    and coverage["complete_orders"] == sum(row["coverage"]["complete"] for row in orders.values())
                    and coverage["unavailable_orders"] == len(orders) - coverage["complete_orders"])
        return (all(type(coverage.get(key)) is int for key in ("required", "available", "unavailable"))
                and coverage["required"] == len(orders)
                and coverage["available"] == sum(row["status"] != "unavailable" for row in orders.values())
                and coverage["unavailable"] == len(orders) - coverage["available"])
    except (KeyError, TypeError, ValueError):
        return False


def _basis(left, right):
    checks = []
    a, b, kind = left["evidence"], right["evidence"], left["kind"]
    def check(code, baseline, selected, valid=True):
        checks.append({"code": code, "matches": bool(valid and _equal(baseline, selected)), "baseline": baseline, "selected": selected})
    versions = [payload["source_context"]["versions"] for payload in (left, right)]
    expected = {"receipt": "alphaview-execution-study-receipt-v1", "evidence": SUPPORTED[kind],
        "volume": SUPPORTED["volume_day"], "limit": SUPPORTED["limit_day"] if kind != "volume_day" else None,
        "paper": "alphaview-paper-portfolio-v2"}
    check("method_versions", *versions, all(value == expected for value in versions))
    shapes = [_shape(value, kind) for value in (a, b)]
    check("saved_evidence_shape", *shapes, all(shapes))
    check("study_method", a.get("method"), b.get("method"), all(isinstance(item.get("method"), str) and item["method"] for item in (a, b)))
    check("saved_proposal", *[{key: value["source_context"].get(key) for key in ("record_fingerprint", "proposal_fingerprint")} for value in (left, right)])
    check("evaluation_snapshot", *[{"input_revision": value["source_context"]["input_revision"], "as_of": value["source_context"]["as_of"], "account_context": value["account_context"]} for value in (left, right)])
    frozen = [{key: value["source"].get(key) for key in ("id", "account_id", "engine_version", "as_of", "input_revision", "account_version", "share_precision", "orders")} for value in (a, b)]
    check("frozen_orders_and_units", *frozen, all(isinstance(value["orders"], list) and value["orders"] and type(value["share_precision"]) is int for value in frozen))
    keys = ("execution_session", "session_completed", "time_in_force", "mode") if kind != "open_gtd" else ("gtd_date", "gtd_session_completed", "horizon", "time_in_force", "mode", "max_sessions")
    check("exact_session_horizon", *[{key: value.get(key) for key in keys} for value in (a, b)])
    check("raw_bar_evidence", a.get("bars_fingerprint"), b.get("bars_fingerprint"))
    coverages = [_coverage(value, kind) for value in (a, b)]
    check("saved_coverage", *coverages, all(value is not None for value in coverages))
    check("order_and_day_identity", *[{"symbols": list(_orders(value) or {}), "dates": {symbol: list(_steps(row) or {}) for symbol, row in (_orders(value) or {}).items()} if kind == "open_gtd" else None} for value in (a, b)],
          all(_orders(value) is not None for value in (a, b)))
    return checks


def _metric(a, b, field, unit, compatible):
    left, right = a.get(field) if isinstance(a, dict) else None, b.get(field) if isinstance(b, dict) else None
    reason = None
    if not compatible: reason = "comparison_basis_incompatible"
    elif a is None or field not in a: reason = "baseline_value_missing"
    elif b is None or field not in b: reason = "selected_value_missing"
    elif not _finite(left): reason = "baseline_value_unavailable"
    elif not _finite(right): reason = "selected_value_unavailable"
    delta = None
    if reason is None:
        try:
            with localcontext() as arithmetic:
                arithmetic.prec = 80
                delta = float(Decimal(str(right)) - Decimal(str(left)))
            if not _finite(delta): reason, delta = "nonfinite_difference", None
        except (InvalidOperation, ValueError, OverflowError):
            reason = "nonfinite_difference"
    return {"baseline": left if _finite(left) else None, "selected": right if _finite(right) else None,
            "delta": delta, "reason": reason, "unit": unit}


def _pairs(left, right, compatible):
    kind = left["kind"]
    a, b = _orders(left["evidence"]) or {}, _orders(right["evidence"]) or {}
    result = []
    for symbol in list(a) + [symbol for symbol in b if symbol not in a]:
        first, second = a.get(symbol), b.get(symbol)
        row = {"symbol": symbol, "paired": first is not None and second is not None,
               "baseline_status": first.get("status") if first else None, "selected_status": second.get("status") if second else None,
               "baseline_reason": first.get("reason") if first else "order_missing", "selected_reason": second.get("reason") if second else "order_missing",
               "metrics": {key: _metric(first, second, key, unit, compatible) for key, unit in (GTD_METRICS if kind == "open_gtd" else DAY_METRICS).items()}, "sessions": []}
        if kind == "open_gtd":
            x, y = _steps(first or {}) or {}, _steps(second or {}) or {}
            for day in list(x) + [day for day in y if day not in x]:
                old, new = x.get(day), y.get(day)
                row["sessions"].append({"date": day, "paired": old is not None and new is not None,
                    "baseline_status": old.get("status") if old else None, "selected_status": new.get("status") if new else None,
                    "baseline_reason": old.get("reason") if old else "session_missing", "selected_reason": new.get("reason") if new else "session_missing",
                    "metrics": {key: _metric(old, new, key, unit, compatible) for key, unit in SESSION_METRICS.items()}})
        result.append(row)
    return result


def _assumptions(payload):
    request = payload["request"]
    return {key: request.get(key) for key in ("participation_pct", "limits", "gtd_date")}


def _side(summary, raw):
    return receipts._json({"summary": summary})[:-1] + ',"original_receipt":' + raw + '}'


@router.post(receipts.BASE + "/compare")
@store.snapshot_read
def compare(account_id: receipts.Identifier, proposal_id: receipts.Identifier, body: CompareInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        if account["version"] != body.expected_account_version: raise receipts._problem("comparison_account_changed")
        checked_as_of = sessions.latest_completed_session()
        first, left, _ = _read(db, account_id, proposal_id, body.baseline_receipt_id, body.expected_baseline_fingerprint)
        second, right, _ = _read(db, account_id, proposal_id, body.selected_receipt_id, body.expected_selected_fingerprint)
        if left["kind"] != right["kind"]: raise receipts._problem("comparison_kind_mismatch", 422)
        checks = _basis(left, right)
        reasons = [item["code"] for item in checks if not item["matches"]]
        comparison = {"historically_comparable": not reasons, "reasons": reasons, "basis_checks": checks,
            "assumptions": {"baseline": _assumptions(left), "selected": _assumptions(right)},
            "orders": _pairs(left, right, not reasons), "direction": "selected_minus_baseline",
            "aggregate": None, "causal_attribution": False, "execution_authority": False}
        value = {"engine_version": ENGINE_VERSION, "account_id": account_id, "proposal_id": proposal_id,
            "account_version": account["version"], "kind": left["kind"], "request": body.model_dump(),
            "comparison": comparison, "checked_as_of": checked_as_of, "checked_input_revision": store.input_revision(db),
            "currentness_note": "Separate observation; original research values are never regenerated or made executable.",
            "max_export_bytes": MAX_BYTES, "method": METHOD}
        encoded = receipts._json(value)[:-1] + ',"baseline":' + _side(receipts._view(db, first, False), first["payload_json"]) + ',"selected":' + _side(receipts._view(db, second, False), second["payload_json"]) + '}'
        if sessions.latest_completed_session() != checked_as_of: raise receipts._problem("comparison_observation_session_changed")
        if len(encoded.encode()) > MAX_BYTES: raise receipts._problem("comparison_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store", "ETag": f'"{receipts._sha(encoded)}"'})
