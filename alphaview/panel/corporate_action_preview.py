"""Conditional, read-only split arithmetic over reconciled local paper holdings.

Provider captures are evidence of returned events, never proof of complete
corporate-action history or legal entitlement. Dividend cash is never inferred.
"""
import json
import math
from datetime import date
from decimal import Decimal, DecimalException, InvalidOperation, localcontext

from fastapi import APIRouter

from . import corporate_action_evidence as evidence
from . import corporate_actions, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-corporate-action-ledger-preview-v1"
SUPPORTED_FILL_METHODS = {"alphaview-paper-portfolio-v2", "alphaview-paper-next-open-v1"}
METHOD = (
    "只讀目前虛擬持倉、同帳戶已模擬成交與保存的供應者證據。完整重建股數與移動平均成本並核對目前帳本；"
    "拆併股僅在來源當期、進場至查詢日的拆股欄與交易日覆蓋完整、比例有效，且首個適用事件當日及之後沒有成交時，"
    "依來源事件日期串接假設股數＝前筆股數×回傳倍率，總成本固定、每股成本＝總成本／假設股數。"
    "同日進場、來源缺漏、未知成交時點或帳本不符均不計算；不以推算調整因子替代來源事件。"
    "僅為所列來源事件的條件式算術；來源完整性未知，不證明歷史價格口徑或實際權利。"
    "股息缺少權利、登記日與付款日證據，應收現金一律不可用，不以目前持股乘每股股息。"
)
WARNINGS = [
    "這不是帳本入帳、股息應收、券商核對或操作指示；不改股數、成本、現金、提案、績效或任何權限。",
    "供應者回傳事件的來源完整性未知；條件式拆股算術不證明所有公司行動已涵蓋，也不修復歷史成交價格口徑。",
    "不處理事件後交易、零股處分、現金補償、稅費、股息再投資、分拆或合併；不抓取來源、不呼叫模型或券商。",
]


def _decimal(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        converted = float(number)
        return number if number.is_finite() and math.isfinite(converted) and (number == 0 or converted != 0) else None
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _number(value):
    number = _decimal(value)
    return float(number) if number is not None else None


def _day(value):
    try:
        return value if isinstance(value, str) and date.fromisoformat(value).isoformat() == value else None
    except ValueError:
        return None


def _expected_sessions(first, last):
    try:
        return sessions.expected_sessions(first, last)
    except (ValueError, OverflowError):
        # An unsupported calendar range has an unknown denominator, not zero.
        return None


def _trace(db, account_id, holding, as_of):
    """Reconcile all local fills; a fork or an untrusted row is not historical proof."""
    rows = db.execute("""SELECT l.*,p.account_id AS proposal_account,p.status AS proposal_status,p.preview_json
        FROM paper_ledger l LEFT JOIN paper_proposals p ON p.id=l.proposal_id
        WHERE l.account_id=? AND l.symbol=? ORDER BY l.id""", (account_id, holding["symbol"])).fetchall()
    quantity, basis, entry, previous_day = Decimal(0), Decimal(0), None, None
    active_fills, reasons, checked = [], [], 0
    for row in rows:
        checked += 1
        delta, cash, pnl = (_decimal(row[key]) for key in ("shares_delta", "cash_delta", "realized_pnl"))
        if delta is None or cash is None or pnl is None or delta == 0:
            reasons.append("ledger_value_unavailable")
            break
        if row["kind"] != "simulated_fill" or row["proposal_account"] != account_id or row["proposal_status"] != "simulated":
            reasons.append("fill_provenance_unavailable")
            break
        try:
            preview = json.loads(row["preview_json"])
        except (TypeError, ValueError):
            preview = None
        if not isinstance(preview, dict) or preview.get("account_id") != account_id or preview.get("engine_version") not in SUPPORTED_FILL_METHODS:
            reasons.append("fill_provenance_unavailable")
            break
        effective = _day(preview.get("as_of"))
        if preview["engine_version"] == "alphaview-paper-next-open-v1" and _day(preview.get("effective_session")) != effective:
            effective = None
        if (effective is None or effective > as_of or (previous_day and effective < previous_day)
                or not _expected_sessions(effective, effective)):
            reasons.append("fill_session_unavailable")
            break
        orders = preview.get("orders")
        matching = [order for order in orders if isinstance(order, dict) and order.get("symbol") == holding["symbol"]] if isinstance(orders, list) else []
        if (len(matching) != 1 or matching[0].get("side") != ("buy" if delta > 0 else "sell")
                or _decimal(matching[0].get("shares_exact")) != abs(delta)
                or _decimal(matching[0].get("cash_delta_exact")) != cash):
            reasons.append("fill_provenance_unavailable")
            break
        before = quantity
        if delta > 0:
            if cash >= 0 or pnl != 0:
                reasons.append("ledger_cost_mismatch")
                break
            basis -= cash
        else:
            if -delta > quantity or cash < 0:
                reasons.append("ledger_balance_invalid")
                break
            try:
                removed = basis if -delta == quantity else paper._money(basis * (-delta) / quantity)
            except DecimalException:
                reasons.append("ledger_value_unavailable")
                break
            if cash - pnl != removed:
                reasons.append("ledger_cost_mismatch")
                break
            basis -= removed
        quantity += delta
        if before == 0 and quantity > 0:
            entry, active_fills = effective, []
        active_fills.append({"ledger_id": row["id"], "proposal_id": row["proposal_id"], "effective_session": effective})
        if quantity == 0:
            entry, active_fills = None, []
        previous_day = effective
    current_shares, current_cost = _decimal(holding["shares"]), _decimal(holding["cost_basis"])
    if current_shares is None or current_cost is None or current_shares <= 0 or current_cost < 0:
        reasons.append("holding_value_unavailable")
    elif quantity != current_shares or basis != current_cost:
        reasons.append("ledger_holding_mismatch")
    if not rows or entry is None:
        reasons.append("entry_session_unknown")
    return {"status": "unavailable" if reasons else "reconciled", "reasons": list(dict.fromkeys(reasons)),
            "entry_session": entry if not reasons else None, "rows_checked": checked, "rows_total": len(rows),
            "active_fills": active_fills if not reasons else []}


def _source_checks(db, symbol, source, entry, as_of):
    reasons = []
    coverage = source.get("coverage", {})
    split_column = coverage.get("columns", {}).get("Stock Splits", {})
    if source["status"] in ("stale", "unavailable"):
        reasons.append("source_not_current")
    if not split_column.get("present"):
        reasons.append("split_column_unavailable")
    if entry is None:
        return reasons, {"required_sessions": None, "captured_sessions": None, "unknown_split_cells": None}
    first, last = _day(coverage.get("first")), _day(coverage.get("last"))
    if first is None or last is None or first > entry or last < as_of:
        reasons.append("holding_period_not_covered")
    expected = _expected_sessions(entry, as_of)
    required = set(expected) if expected is not None else None
    captured = {row[0] for row in db.execute("SELECT date FROM bars WHERE symbol=? AND date>=? AND date<=?", (symbol, entry, as_of))}
    if required is None:
        reasons.append("holding_sessions_unavailable")
    elif not required or entry not in required or not required.issubset(captured):
        reasons.append("holding_sessions_missing")
    unknown = sum(event["kind"] == "stock_split" and event["ex_date"] >= entry and event.get("reason") is not None
                  for event in source["events"])
    if unknown:
        reasons.append("split_cells_unavailable")
    return reasons, {"required_sessions": len(required) if required is not None else None,
                     "captured_sessions": len(required & captured) if required is not None else None,
                     "unknown_split_cells": unknown if split_column.get("present") else None}


def _effect(shares, basis):
    average = basis / shares
    values = {"shares": _number(shares), "cost_basis": _number(basis), "average_cost": _number(average)}
    if any(value is None for value in values.values()):
        return None
    return {**values, "shares_exact": str(shares), "cost_basis_exact": str(basis), "average_cost_exact": str(average)}


def _holding(db, account_id, holding, as_of):
    symbol = holding["symbol"]
    trace = _trace(db, account_id, holding, as_of)
    inferred, inference_coverage = corporate_actions.detect(db, symbol, None, as_of)
    source = evidence.summary(db, symbol, inferred, None, as_of)
    saved = db.execute("SELECT fingerprint,first_fetched_at FROM corporate_action_evidence WHERE symbol=? AND revision=?",
                       (symbol, source.get("evidence_revision"))).fetchone()
    source = {**source, "fingerprint": saved["fingerprint"] if saved else None,
              "first_fetched_at": saved["first_fetched_at"] if saved else None}
    entry = trace["entry_session"]
    source_reasons, coverage = _source_checks(db, symbol, source, entry, as_of)
    reasons = list(trace["reasons"]) + source_reasons
    applicable = [event for event in source["events"] if event["kind"] == "stock_split" and (entry is None or event["ex_date"] >= entry)]
    valid_splits = [event for event in applicable if event.get("reason") is None and _decimal(event.get("value")) is not None and event["value"] > 0 and event["value"] != 1]
    if len(valid_splits) != len(applicable):
        reasons.append("split_ratio_unavailable")
    if any(_day(event["ex_date"]) is None or not _expected_sessions(event["ex_date"], event["ex_date"]) for event in applicable):
        reasons.append("split_event_session_unavailable")
    if applicable and trace["active_fills"]:
        first_event = min(event["ex_date"] for event in applicable)
        if any(fill["effective_session"] >= first_event for fill in trace["active_fills"]):
            reasons.append("fill_on_or_after_split")
    reasons = list(dict.fromkeys(reasons))
    shares, basis = _decimal(holding["shares"]), _decimal(holding["cost_basis"])
    current = _effect(shares, basis) if shares is not None and shares > 0 and basis is not None and basis >= 0 else None
    calculated, final, events = 0, None, []
    running = shares
    for event in source["events"]:
        row = {"ex_date": event["ex_date"], "kind": event["kind"], "source_value": event.get("value"),
               "raw_value": event.get("raw_value"), "raw_type": event.get("raw_type"),
               "source_reason": event.get("reason"), "record_date": None, "pay_date": None,
               "cash_entitlement": None, "before": None, "after": None, "shares_delta": None}
        if event["kind"] == "cash_dividend":
            row.update(status="unavailable", entitlement="unknown", reasons=["dividend_entitlement_unknown", "record_and_pay_dates_unknown"])
        elif entry is not None and event["ex_date"] < entry:
            row.update(status="outside_holding_period", entitlement="not_evaluated", reasons=["event_before_current_entry"])
        elif reasons:
            row.update(status="unavailable", entitlement="unknown", reasons=reasons)
        else:
            next_shares = running * _decimal(event["value"])
            before, after, delta = _effect(running, basis), _effect(next_shares, basis), _number(next_shares - running)
            if before is None or after is None or delta is None or next_shares <= 0:
                reasons = ["calculation_nonfinite"]
                row.update(status="unavailable", entitlement="unknown", reasons=reasons)
            else:
                row.update(status="conditional", entitlement="local_pre_event_holding_only", reasons=[], before=before, after=after, shares_delta=delta)
                calculated += 1
                running, final = next_shares, after
        events.append(row)
    # Never leave a partially calculated chain looking like a usable total.
    if reasons:
        calculated, final = 0, None
        for event in events:
            if event["status"] == "conditional":
                event.update(status="unavailable", entitlement="unknown", reasons=reasons, before=None, after=None, shares_delta=None)
    status = "unavailable" if reasons else "conditional" if calculated else "no_applicable_split_reported"
    return {"symbol": symbol, "status": status, "reasons": reasons, "ledger": trace,
            "current": current, "conditional_after": final, "events": events,
            "coverage": {**coverage, "reported_events": len(events), "applicable_splits": len(applicable),
                         "calculated_splits": calculated, "unavailable_events": sum(event["status"] == "unavailable" for event in events)},
            "source": source, "inference_coverage": inference_coverage,
            "unposted": True, "source_completeness": "unknown"}


@router.get("/api/paper/accounts/{account_id}/corporate-actions/ledger-preview")
@store.snapshot_read
def ledger_preview(account_id: str):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        account = paper._account(db, account_id)
        as_of = sessions.latest_completed_session()
        holdings = [_holding(db, account_id, holding, as_of) for holding in paper._holdings(db, account_id)]
        return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
                "as_of": as_of, "input_revision": store.input_revision(db), "read_at": store.now(),
                "status": "empty" if not holdings else "review_only", "holdings": holdings,
                "coverage": {"holdings": len(holdings), "conditional_holdings": sum(row["status"] == "conditional" for row in holdings),
                             "unavailable_holdings": sum(row["status"] == "unavailable" for row in holdings),
                             "reported_events": sum(row["coverage"]["reported_events"] for row in holdings),
                             "calculated_splits": sum(row["coverage"]["calculated_splits"] for row in holdings)},
                "ledger_mutated": False, "source_completeness": "unknown", "method": METHOD, "warnings": list(WARNINGS)}
