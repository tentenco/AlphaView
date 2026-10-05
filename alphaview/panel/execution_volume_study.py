"""Read-only, ex-post daily volume capacity scenarios for saved paper orders."""
import json
import math
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_DOWN, localcontext
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, HTTPException, Path
from pydantic import Field, field_validator, model_validator

from . import paper_portfolio as paper, sessions, store
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-execution-volume-study-v1"
SUPPORTED_PAPER_VERSION = "alphaview-paper-portfolio-v2"
MAX_ORDERS = 100
MAX_SOURCE_BYTES = 2_000_000
Identifier = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
METHOD = (
    "Advisory ex-post DAY capacity scenario for at most 100 frozen saved paper-v2 orders. "
    "Signal at the saved session close; reference price is the exact next XNYS session's unadjusted open. "
    "Only evaluate after that session completes. Capacity = exact execution-day volume * explicit "
    "participation_pct / 100, rounded down to the saved share precision. Scenario quantity = min(frozen "
    "quantity, capacity); the remainder expires at that session's close with no carry or redistribution. "
    "The entire day's volume was not known at the open: this is NOT an opening-fill feasibility claim. "
    "Use no intraday chronology, limit-order inference, price impact, fees, cash or portfolio performance. "
    "Missing/invalid exact-day evidence stays unavailable. Explicit zero volume gives zero capacity. "
    "Signal raw close must still match the saved reference. Changed adj_close/close factor by more than "
    "1e-6 relative makes that order unavailable; no split or dividend conversion."
)
WARNINGS = [
    "全日成交量在次日開盤時尚未知；容量與參考金額是事後假設，不代表開盤可成交。",
    "固定保存股數與 DAY 期限；未分配的容量不轉給其他標的，剩餘股數僅在情境中到期。",
    "不推斷日內限價觸及順序、不計價格衝擊、費用、現金可負擔性或組合績效。",
    "這不是實際成交、券商狀態、委託授權或交易建議；不建立提案、不寫帳本、不送單。",
]


class StudyInput(paper.StrictInput):
    expected_account_version: int = Field(ge=1, strict=True)
    expected_input_revision: str = Field(min_length=1, max_length=100)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_proposal_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    participation_pct: float = Field(ge=0, le=100, strict=True)

    @model_validator(mode="before")
    @classmethod
    def finite_body(cls, value):
        # Avoid FastAPI's default validation envelope trying to serialize an echoed inf/NaN.
        try:
            json.dumps(value, allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise _problem("nonfinite_input") from exc
        return value

    @field_validator("expected_as_of")
    @classmethod
    def actual_date(cls, value):
        date.fromisoformat(value)
        return value


def _problem(code, status=422):
    return HTTPException(status, {"code": code, "message": code})


def _number(value, *, zero=False):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        result = Decimal(str(value))
        # Bounds prevent malformed stored exponents exhausting Decimal/JSON conversions.
        if not result.is_finite() or result < 0 or (not zero and result == 0) or result > Decimal("1e24"):
            return None
        return result
    except (ValueError, InvalidOperation):
        return None


def _finite(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _reject_constant(value):
    raise ValueError(f"Nonfinite saved JSON: {value}")


def _source(db, account_id, proposal_id, current):
    row = paper._get_proposal(db, account_id, proposal_id)
    try:
        if len(row["preview_json"].encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValueError("Source limit")
        preview = json.loads(row["preview_json"], parse_constant=_reject_constant)
        if not isinstance(preview, dict) or preview.get("account_id") != account_id:
            raise ValueError("Source account")
        if type(preview.get("account_version")) is not int or preview["account_version"] < 1:
            raise ValueError("Source version")
        if not isinstance(preview.get("input_revision"), str) or not preview["input_revision"]:
            raise ValueError("Source revision")
        day = preview.get("as_of")
        date.fromisoformat(day)
        cal = sessions.calendar(date.fromisoformat(day).year)
        if not cal.is_session(day):
            raise ValueError("Non-session source")
        next_session = cal.next_session(pd.Timestamp(day)).date().isoformat()
        orders = preview.get("orders")
        precision = preview.get("execution_policy", {}).get("share_precision")
        if not isinstance(orders, list) or len(orders) > MAX_ORDERS:
            raise ValueError("Order limit")
        if type(precision) is not int or not 0 <= precision <= 6:
            raise ValueError("Share precision")
        seen = set()
        step = Decimal(1).scaleb(-precision)
        for order in orders:
            symbol = order.get("symbol")
            if not isinstance(symbol, str) or paper.TargetWeight(symbol=symbol, weight_pct=0).symbol != symbol:
                raise ValueError("Symbol")
            quantity = _number(order.get("shares_exact"))
            if (symbol in seen or order.get("side") not in ("buy", "sell") or quantity is None
                    or not isinstance(order.get("shares_exact"), str)):
                raise ValueError("Order identity")
            if quantity.quantize(step) != quantity or _number(order.get("shares")) != quantity:
                raise ValueError("Order precision")
            if _number(order.get("reference_price")) is None:
                raise ValueError("Reference price")
            seen.add(symbol)
        fingerprint = paper._hash({"id": row["id"], "account_id": row["account_id"],
                                   "status": row["status"], "created_at": row["created_at"],
                                   "accepted_at": row["accepted_at"], "preview": preview})
    except (ValueError, TypeError, KeyError, AttributeError, InvalidOperation, OverflowError) as exc:
        raise _problem("saved_proposal_unavailable") from exc
    stale = []
    for field, code in (("account_version", "account_changed"), ("input_revision", "inputs_changed"),
                        ("as_of", "session_changed")):
        if preview.get(field) != current[field]:
            stale.append(code)
    if preview.get("engine_version") != SUPPORTED_PAPER_VERSION:
        stale.append("paper_method_unsupported")
    reason = ("paper_method_unsupported" if preview.get("engine_version") != SUPPORTED_PAPER_VERSION else
              "blocked_source_proposal" if preview.get("executable") is not True or row["status"] == "blocked" else
              "no_saved_orders" if not orders else None)
    source = {"id": proposal_id, "account_id": account_id, "engine_version": preview.get("engine_version"),
              "created_at": row["created_at"], "status": row["status"], "as_of": day,
              "input_revision": preview.get("input_revision"), "account_version": preview.get("account_version"),
              "proposal_fingerprint": fingerprint, "current": not stale, "stale_reasons": stale,
              "available": reason is None, "reason": reason, "share_precision": precision,
              "orders": [{key: order[key] for key in ("symbol", "side", "shares", "shares_exact", "reference_price")}
                         for order in orders], "skipped_orders_count": len(preview.get("skipped_orders", []))}
    return source, next_session


def _context(db, account_id, proposal_id):
    account = paper._account(db, account_id)
    current = {"account_version": account["version"], "input_revision": store.input_revision(db),
               "as_of": sessions.latest_completed_session()}
    source, execution_session = _source(db, account_id, proposal_id, current)
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, **current, "source": source,
            "execution_session": execution_session, "session_completed": execution_session <= current["as_of"],
            "time_in_force": "DAY", "mode": "advisory_ex_post", "method": METHOD, "warnings": list(WARNINGS)}


def _bar_evidence(db, symbol, session):
    row = db.execute("SELECT date,open,high,low,close,adj_close,volume FROM bars WHERE symbol=? AND date=?",
                     (symbol, session)).fetchone()
    if row is None:
        return None
    # Preserve invalid fields as null plus their identities, never JSON NaN or invented zero.
    numeric = {key: _finite(row[key]) for key in ("open", "high", "low", "close", "adj_close", "volume")}
    return {"date": row["date"], **numeric, "invalid_fields": [key for key, value in numeric.items() if value is None]}


def _row(db, order, context, participation):
    source = context["source"]
    symbol = order["symbol"]
    signal = _bar_evidence(db, symbol, source["as_of"])
    observed = _bar_evidence(db, symbol, context["execution_session"]) if context["session_completed"] else None
    dataset = db.execute("SELECT currency,source FROM datasets WHERE symbol=?", (symbol,)).fetchone()
    row = {**order, "status": "unavailable", "reason": None, "raw_open": None, "session_volume": None,
           "capacity_shares": None, "capacity_shares_exact": None, "scenario_shares": None,
           "scenario_shares_exact": None, "expired_shares": None, "expired_shares_exact": None,
           "fill_fraction_pct": None, "reference_notional": None, "reference_notional_exact": None,
           "evidence": {"signal_bar": signal, "execution_bar": observed,
                        "dataset": dict(dataset) if dataset else None}}
    reason = source["reason"]
    if reason is None and not context["session_completed"]:
        reason = "execution_session_not_completed"
    if reason is None and (dataset is None or dataset["currency"] != "USD"):
        reason = "usd_identity_unavailable"
    if reason is None and signal is None:
        reason = "missing_signal_bar"
    if reason is None and observed is None:
        reason = "missing_execution_bar"
    if reason is None:
        if _number(signal["close"]) is None or _number(signal["adj_close"]) is None:
            reason = "invalid_signal_basis"
        elif Decimal(str(signal["close"])) != Decimal(str(order["reference_price"])):
            reason = "signal_reference_changed"
        elif _number(observed["open"]) is None:
            reason = "invalid_execution_open"
        elif _number(observed["volume"], zero=True) is None:
            reason = "invalid_execution_volume"
        elif _number(observed["close"]) is None or _number(observed["adj_close"]) is None:
            reason = "invalid_execution_basis"
        elif not valid_bar(observed):
            reason = "invalid_execution_bar"
        else:
            before = Decimal(str(signal["adj_close"])) / Decimal(str(signal["close"]))
            after = Decimal(str(observed["adj_close"])) / Decimal(str(observed["close"]))
            if abs(after - before) > abs(before) * Decimal("0.000001"):
                reason = "adjustment_factor_changed"
    row["reason"] = reason
    if reason:
        return row
    quantity = Decimal(order["shares_exact"])
    step = Decimal(1).scaleb(-source["share_precision"])
    volume, price = Decimal(str(observed["volume"])), Decimal(str(observed["open"]))
    capacity = (volume * participation / 100).quantize(step, rounding=ROUND_DOWN)
    scenario = min(quantity, capacity)
    expired = quantity - scenario
    notional = (scenario * price).quantize(Decimal("0.00000001"))
    row.update(status="full" if expired == 0 else "unfilled_expired" if scenario == 0 else "partial_expired",
               raw_open=float(price), session_volume=float(volume), fill_fraction_pct=float(scenario / quantity * 100),
               reference_notional=float(notional), reference_notional_exact=str(notional))
    for name, value in (("capacity_shares", capacity), ("scenario_shares", scenario), ("expired_shares", expired)):
        row[name], row[f"{name}_exact"] = float(value), str(value)
    return row


@router.get("/api/paper/accounts/{account_id}/proposals/{proposal_id}/volume-study/context")
@store.snapshot_read
def study_context(account_id: Identifier, proposal_id: Identifier):
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        return _context(db, account_id, proposal_id)


@router.post("/api/paper/accounts/{account_id}/proposals/{proposal_id}/volume-study")
@store.snapshot_read
def study(account_id: Identifier, proposal_id: Identifier, body: StudyInput):
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        context = _context(db, account_id, proposal_id)
        for field in ("account_version", "input_revision", "as_of"):
            if getattr(body, f"expected_{field}") != context[field]:
                raise _problem("study_context_changed", 409)
        if body.expected_proposal_fingerprint != context["source"]["proposal_fingerprint"]:
            raise _problem("saved_proposal_changed", 409)
        rows = [_row(db, order, context, Decimal(str(body.participation_pct))) for order in context["source"]["orders"]]
        available = sum(row["status"] != "unavailable" for row in rows)
        bars_fingerprint = paper._hash([{"symbol": row["symbol"], "evidence": row["evidence"]} for row in rows])
        return {**context, "request": body.model_dump(), "bars_fingerprint": bars_fingerprint,
                "status": "unavailable" if not available else "complete" if available == len(rows) else "incomplete",
                "coverage": {"required": len(rows), "available": available, "unavailable": len(rows) - available},
                "orders": rows, "reason": context["source"]["reason"] if not rows else None}
