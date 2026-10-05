"""Read-only, open-only limit scenarios; daily bars cannot prove limit-order fills."""
from decimal import Decimal, localcontext

from fastapi import APIRouter
from pydantic import Field, field_validator

from . import execution_volume_study as volume, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-execution-limit-study-v1"
MAX_LIMIT_PRICE = 1_000_000_000_000
METHOD = (
    "Advisory ex-post, single-session DAY open-only limit scenario for frozen saved paper-v2 orders. "
    "Signal at saved close; compare only the exact next completed XNYS session's unadjusted open. "
    "A supplied buy limit requires open <= limit; a sell limit requires open >= limit, including equality. "
    "An omitted limit means no price restriction in this scenario. If the open meets the condition, "
    "scenario quantity is min(frozen shares, exact full-day volume * participation_pct / 100 rounded down "
    "to saved share precision). Otherwise scenario quantity is zero. The scenario ignores every later "
    "intraday opportunity and expires the entire remainder at that close; it carries nothing forward. "
    "Full-day volume was unknown at the open and is only an ex-post capacity proxy, NOT opening liquidity. "
    "Daily high/low are used only for bar-quality checks, never touch chronology or fill inference. "
    "Actual intraday limit outcome is unknown for every row, including an open that meets a limit. "
    "Raw open is the reference price; no fees, slippage, queue priority, price impact, cash or portfolio performance. "
    "Missing evidence is unavailable, never replaced with zero. Factor changes make evidence unavailable; "
    "no split/dividend adjustment or share redistribution. This is not an execution model or authorization."
)
WARNINGS = [
    "只檢查原始開盤價；盤中可能觸價或成交的順序與結果一律未知，不由日線高低價推斷。",
    "全日成交量在開盤時尚未知，只作事後容量代理，不代表開盤可成交或限價能成交。",
    "未符合開盤限價的零股數只是本情境假設；不代表真實 DAY 委託整日未成交。",
    "剩餘股數只在情境中於收盤到期；不續單、不轉配權重、不修改提案或實際執行。",
]


class LimitInput(paper.StrictInput):
    symbol: str = Field(min_length=1, max_length=30)
    limit_price: float = Field(gt=0, le=MAX_LIMIT_PRICE, strict=True)

    @field_validator("symbol")
    @classmethod
    def exact_symbol(cls, value):
        if paper.TargetWeight(symbol=value, weight_pct=0).symbol != value:
            raise ValueError("Use the exact saved symbol")
        return value


class StudyInput(volume.StudyInput):
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    limits: list[LimitInput] = Field(default_factory=list, max_length=volume.MAX_ORDERS)

    @field_validator("limits")
    @classmethod
    def unique_limits(cls, value):
        if len({item.symbol for item in value}) != len(value):
            raise ValueError("Each saved symbol may have at most one limit")
        return sorted(value, key=lambda item: item.symbol)


def _context(db, account_id, proposal_id):
    return {**volume._context(db, account_id, proposal_id), "engine_version": ENGINE_VERSION,
            "capacity_engine_version": volume.ENGINE_VERSION, "method": METHOD, "warnings": list(WARNINGS),
            "scenario_window": "open_only", "intraday_outcome": "unknown_from_daily_bars",
            "limit_price_bounds": {"exclusive_min": 0, "max": MAX_LIMIT_PRICE},
            "costs_included": False}


def _row(db, order, context, participation, limits):
    row = volume._row(db, order, context, participation)
    limit = limits.get(order["symbol"])
    row.update(limit_price=float(limit) if limit is not None else None,
               limit_price_exact=str(limit) if limit is not None else None,
               limit_supplied=limit is not None, open_condition="unavailable",
               intraday_outcome="unknown_from_daily_bars")
    if row["status"] == "unavailable":
        return row
    if limit is None:
        row["open_condition"] = "not_applied"
        return row
    price = Decimal(str(row["raw_open"]))
    meets = price <= limit if order["side"] == "buy" else price >= limit
    row["open_condition"] = "satisfied" if meets else "not_satisfied"
    if not meets:
        step = Decimal(1).scaleb(-context["source"]["share_precision"])
        zero = Decimal(0).quantize(step)
        quantity = Decimal(order["shares_exact"])
        row.update(status="not_marketable_at_open_expired", reason="open_does_not_meet_limit",
                   scenario_shares=0.0, scenario_shares_exact=str(zero), expired_shares=float(quantity),
                   expired_shares_exact=str(quantity), fill_fraction_pct=0.0,
                   reference_notional=0.0, reference_notional_exact="0.00000000")
    return row


@router.get("/api/paper/accounts/{account_id}/proposals/{proposal_id}/limit-study/context")
@store.snapshot_read
def study_context(account_id: volume.Identifier, proposal_id: volume.Identifier):
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        return _context(db, account_id, proposal_id)


@router.post("/api/paper/accounts/{account_id}/proposals/{proposal_id}/limit-study")
@store.snapshot_read
def study(account_id: volume.Identifier, proposal_id: volume.Identifier, body: StudyInput):
    with store.connect() as db, localcontext() as arithmetic:
        arithmetic.prec = 80
        context = _context(db, account_id, proposal_id)
        for field in ("account_version", "input_revision", "as_of"):
            if getattr(body, f"expected_{field}") != context[field]:
                raise volume._problem("study_context_changed", 409)
        if body.expected_proposal_fingerprint != context["source"]["proposal_fingerprint"]:
            raise volume._problem("saved_proposal_changed", 409)
        known = {order["symbol"] for order in context["source"]["orders"]}
        if any(item.symbol not in known for item in body.limits):
            raise volume._problem("limit_symbol_not_in_saved_orders")
        limits = {item.symbol: Decimal(str(item.limit_price)) for item in body.limits}
        rows = [_row(db, order, context, Decimal(str(body.participation_pct)), limits)
                for order in context["source"]["orders"]]
        if sessions.latest_completed_session() != context["as_of"]:
            raise volume._problem("study_context_changed", 409)
        available = sum(row["status"] != "unavailable" for row in rows)
        bars_fingerprint = paper._hash([{"symbol": row["symbol"], "evidence": row["evidence"]} for row in rows])
        return {**context, "request": body.model_dump(), "bars_fingerprint": bars_fingerprint,
                "status": "unavailable" if not available else "complete" if available == len(rows) else "incomplete",
                "coverage": {"required": len(rows), "available": available, "unavailable": len(rows) - available},
                "orders": rows, "reason": context["source"]["reason"] if not rows else None}
