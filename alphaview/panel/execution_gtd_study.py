"""Read-only multi-session open-only capacity scenarios; never broker execution."""
from datetime import date
from decimal import Decimal, localcontext

import pandas as pd
from fastapi import APIRouter, Response
from pydantic import Field, field_validator

from . import execution_limit_study as limit, execution_volume_study as volume, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-execution-gtd-study-v1"
MAX_SESSIONS = 5
METHOD = (
    "Advisory ex-post GTD open-only scenario for frozen saved paper-v2 quantities, one unique order per symbol. "
    "Choose an explicit GTD date among the next five XNYS sessions after the saved signal close. For each "
    "completed session while shares remain, a buy limit requires raw open <= fixed limit and a sell requires "
    "raw open >= fixed limit; equality qualifies and an omitted limit imposes no price restriction. "
    "Daily capacity is exact full-day volume * participation_pct / 100 rounded down to saved share precision. "
    "Scenario quantity is min(known remaining shares, capacity), or zero when the open fails the limit. "
    "Carry only the known hypothetical remainder to the next exact session. Full-day volume was unknown at "
    "the open: it is an ex-post proxy, NOT opening liquidity or actual fill feasibility. High/low never imply "
    "intraday chronology, and actual intraday outcomes remain unknown. The first missing/invalid bar, source "
    "basis change or uncompleted session stops that order's progression; later quantities remain unknown, "
    "not zero. Preserve separately labelled observed-prefix quantities; final quantities and expiry remain "
    "unavailable. A fully consumed hypothetical order needs no later bars and is scenario_full, without "
    "verifying expiry. A positive remainder expires only after every required session is completed and "
    "available through GTD. Adjustment factors are compared to the signal day; no split/dividend conversion. "
    "No costs, cash checks, shared capacity, redistribution, portfolio performance, persistence or trading authority."
)
WARNINGS = [
    "Full-day volume is an ex-post capacity proxy, not opening liquidity. Actual intraday fills are unknown.",
    "A zero open-only scenario quantity does not establish that a real order remained unfilled all day.",
    "Missing evidence stops subsequent quantities for that order; an observed prefix is not a known final total.",
    "Scenario expiry requires all active-order sessions through the chosen GTD date to be completed and available.",
    "A hypothetical order consumed earlier is scenario_full even if GTD is future; expiry is not verified or claimed.",
    "This does not send or change an order, proposal, holding or authorization; it is not an execution model.",
]


class StudyInput(limit.StudyInput):
    gtd_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("gtd_date")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value


def _context(db, account_id, proposal_id):
    context = volume._context(db, account_id, proposal_id)
    calendar = sessions.calendar(date.fromisoformat(context["source"]["as_of"]).year)
    previous = pd.Timestamp(context["source"]["as_of"])
    dates = []
    for _ in range(MAX_SESSIONS):
        previous = calendar.next_session(previous)
        day = previous.date().isoformat()
        dates.append({"date": day, "completed": day <= context["as_of"]})
    return {**context, "engine_version": ENGINE_VERSION, "capacity_engine_version": volume.ENGINE_VERSION,
            "limit_engine_version": limit.ENGINE_VERSION, "time_in_force": "GTD",
            "scenario_window": "open_only", "intraday_outcome": "unknown_from_daily_bars",
            "costs_included": False, "allowed_expiry_sessions": dates, "max_sessions": MAX_SESSIONS,
            "method": METHOD, "warnings": list(WARNINGS)}


def _amount(target, key, value):
    target[key] = float(value) if value is not None else None
    target[f"{key}_exact"] = str(value) if value is not None else None


def _order(db, order, context, horizon, participation, limits):
    remaining = Decimal(order["shares_exact"])
    total, notional = Decimal(0), Decimal(0)
    row = {**order, "status": "unavailable", "reason": None,
           "limit_price": float(limits[order["symbol"]]) if order["symbol"] in limits else None,
           "limit_price_exact": str(limits[order["symbol"]]) if order["symbol"] in limits else None,
           "intraday_outcome": "unknown_from_daily_bars", "sessions": [],
           "observed_prefix_end": None, "expiry_verified": False,
           "expiry_state": "unknown", "completed_in_scenario_at": None}
    for key in ("observed_prefix_scenario_shares", "last_known_remaining_shares", "observed_prefix_reference_notional",
                "final_scenario_shares", "expired_shares", "final_reference_notional"):
        _amount(row, key, None)
    stopped = None
    evaluated = 0
    for session in horizon:
        step = {"date": session["date"], "session_completed": session["completed"], "status": "unavailable",
                "reason": None, "open_condition": "unavailable", "raw_open": None, "session_volume": None,
                "evidence": None, "intraday_outcome": "unknown_from_daily_bars"}
        for key in ("remaining_before", "capacity_shares", "scenario_shares", "remaining_after", "reference_notional"):
            _amount(step, key, None)
        if remaining == 0 and stopped is None:
            step.update(status="not_required_scenario_full", reason="no_scenario_remainder")
        elif stopped is not None:
            step.update(status="blocked_by_unknown", reason="prior_evidence_unavailable")
        else:
            _amount(step, "remaining_before", remaining)
            available = limit._row(db, {**order, "shares": float(remaining), "shares_exact": str(remaining)},
                                   {**context, "execution_session": session["date"], "session_completed": session["completed"]},
                                   participation, limits)
            step.update(evidence=available["evidence"], reason=available["reason"],
                        raw_open=available["raw_open"], session_volume=available["session_volume"],
                        open_condition=available["open_condition"])
            if available["status"] == "unavailable":
                stopped = available["reason"]
                step["status"] = "future_unknown" if stopped == "execution_session_not_completed" else "unavailable"
            else:
                quantity = Decimal(available["scenario_shares_exact"])
                remaining -= quantity
                total += quantity
                notional += Decimal(available["reference_notional_exact"])
                evaluated += 1
                step["status"] = "evaluated"
                for key in ("capacity_shares", "scenario_shares", "reference_notional"):
                    step[key], step[f"{key}_exact"] = available[key], available[f"{key}_exact"]
                _amount(step, "remaining_after", remaining)
                row["observed_prefix_end"] = session["date"]
                if remaining == 0:
                    row["completed_in_scenario_at"] = session["date"]
        row["sessions"].append(step)
    if evaluated:
        _amount(row, "observed_prefix_scenario_shares", total)
        _amount(row, "last_known_remaining_shares", remaining)
        _amount(row, "observed_prefix_reference_notional", notional)
    if stopped is not None:
        row["reason"] = stopped
    elif remaining == 0:
        row.update(status="scenario_full", expiry_state="not_applicable_scenario_full")
        _amount(row, "final_scenario_shares", total)
        _amount(row, "final_reference_notional", notional)
    else:
        # The loop can reach this branch only after every active session had
        # completed, valid evidence. An unknown/future session stops it above.
        row.update(status="partial_expired" if total > 0 else "unfilled_expired",
                   expiry_verified=True, expiry_state="scenario_expired_at_gtd_close")
        _amount(row, "final_scenario_shares", total)
        _amount(row, "final_reference_notional", notional)
        _amount(row, "expired_shares", remaining)
    row["coverage"] = {"required_sessions": len(horizon), "evaluated_sessions": evaluated,
                       "not_required_sessions": sum(s["status"] == "not_required_scenario_full" for s in row["sessions"]),
                       "unknown_sessions": sum(s["status"] in ("unavailable", "future_unknown", "blocked_by_unknown") for s in row["sessions"]),
                       "complete": stopped is None}
    return row


@router.get("/api/paper/accounts/{account_id}/proposals/{proposal_id}/gtd-study/context")
@store.snapshot_read
def study_context(account_id: volume.Identifier, proposal_id: volume.Identifier, response: Response):
    response.headers["Cache-Control"] = "no-store"
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        return _context(db, account_id, proposal_id)


@router.post("/api/paper/accounts/{account_id}/proposals/{proposal_id}/gtd-study")
@store.snapshot_read
def study(account_id: volume.Identifier, proposal_id: volume.Identifier, body: StudyInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        context = _context(db, account_id, proposal_id)
        for field in ("account_version", "input_revision", "as_of"):
            if getattr(body, f"expected_{field}") != context[field]:
                raise volume._problem("study_context_changed", 409)
        if body.expected_proposal_fingerprint != context["source"]["proposal_fingerprint"]:
            raise volume._problem("saved_proposal_changed", 409)
        allowed = context["allowed_expiry_sessions"]
        if body.gtd_date not in {item["date"] for item in allowed}:
            raise volume._problem("gtd_date_not_in_next_five_sessions")
        orders = context["source"]["orders"]
        known = {order["symbol"] for order in orders}
        if len(known) != len(orders):
            raise volume._problem("saved_proposal_unavailable")
        if any(item.symbol not in known for item in body.limits):
            raise volume._problem("limit_symbol_not_in_saved_orders")
        horizon = [item for item in allowed if item["date"] <= body.gtd_date]
        limits = {item.symbol: Decimal(str(item.limit_price)) for item in body.limits}
        rows = [_order(db, order, context, horizon, Decimal(str(body.participation_pct)), limits) for order in orders]
        if sessions.latest_completed_session() != context["as_of"]:
            raise volume._problem("study_context_changed", 409)
        complete = sum(row["coverage"]["complete"] for row in rows)
        result = {**context, "request": body.model_dump(), "gtd_date": body.gtd_date,
                  "gtd_session_completed": body.gtd_date <= context["as_of"], "horizon": horizon,
                  "status": "complete" if rows and complete == len(rows) else "unavailable",
                  "coverage": {"required_orders": len(rows), "complete_orders": complete,
                               "unavailable_orders": len(rows) - complete,
                               "observed_prefix_orders": sum(row["observed_prefix_end"] is not None for row in rows)},
                  "orders": rows, "reason": context["source"]["reason"] if not rows else None}
        result["bars_fingerprint"] = paper._hash([{ "symbol": row["symbol"], "sessions": [
            {"date": step["date"], "evidence": step["evidence"]} for step in row["sessions"]]} for row in rows])
        result["evidence_fingerprint"] = paper._hash(result)
        return result
