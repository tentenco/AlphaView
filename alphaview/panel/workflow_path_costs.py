"""Cost scenarios on one frozen set of prefix-derived workflow decisions, never an optimizer."""
import hashlib
import json
import math
from typing import Annotated

from fastapi import APIRouter, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import Field, model_validator

from . import sessions, store, workflow_path_validation as path

ENGINE_VERSION = "alphaview-workflow-path-costs-v1"
MAX_AXIS, MAX_BPS = 3, 100
Rate = Annotated[float, Field(ge=0, le=MAX_BPS, strict=True, allow_inf_nan=False)]
METHOD = (
    "Advisory cost scenarios for one current saved workflow. Compute alphaview-workflow-path-validation-v1 "
    "exactly once, retaining its complete 10 bps fee / zero-slippage baseline unchanged. Freeze its candidate "
    "universe, prefix-derived decisions, target weights, 252-session window and initial cash. Reuse identical "
    "local history in the same read snapshot; never rerun selection or allocation per scenario. At most three "
    "unique finite rates per axis, 0..100 bps, nine explicit pairs. At each raw open, define E as pre-cost "
    "raw-marked equity and delta_i(N)=w_i*N-held_raw_value_i. Solve N + sum(abs(delta_i)*s + "
    "abs(delta_i)*(1+sign(delta_i)*s)*f)=E. Buy fills are raw_open*(1+s), sell fills raw_open*(1-s); "
    "fees apply to executed notional. Target raw values are w_i*N, so costs alter fractional shares and "
    "future capital, not target percentages. Unused weights stay cash. Raw closes mark holdings; cash earns "
    "zero, no terminal liquidation, and no-candidate decisions retain holdings. Baseline evidence gaps, "
    "including held adjustment-factor changes, disable every scenario. A numeric failure disables only "
    "that scenario, without substituted values. Equity differences include compounding and changed "
    "quantities and need not equal summed explicit cost differences. No ranking, training, parameter "
    "search, verdict, liquidity/market-impact model, proposal, write, provider, model or broker call."
)
WARNINGS = [
    "所有情境使用同一組歷史決策與目標百分比；成本會改變模擬股數及後續本金，不重新選股或改配置權重。",
    "滑價是買入加價、賣出減價的固定 bps 假設；不是成交量、流動性或市場衝擊模型。",
    "期末資產差包含部位與複利效果，不等於累計費用與滑價差額。",
    "零成本也只是明確假設，不是可實現的成交保證；不選出最佳情境、不提供通過結論。",
    "原路徑的固定股票池、事後選擇與資料修訂限制仍存在；這不是歷史當時股票池的策略回測。",
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


class CostInput(path.PathValidationInput):
    fee_bps: list[Rate] = Field(default_factory=lambda: [0.0, 10.0, 25.0], min_length=1, max_length=MAX_AXIS)
    slippage_bps: list[Rate] = Field(default_factory=lambda: [0.0, 5.0, 10.0], min_length=1, max_length=MAX_AXIS)

    @model_validator(mode="after")
    def unique_rates(self):
        if len(set(self.fee_bps)) != len(self.fee_bps) or len(set(self.slippage_bps)) != len(self.slippage_bps):
            raise ValueError("每組費用與滑價假設不可重複")
        return self


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _problem(message):
    return HTTPException(409, {"code": "workflow_path_costs_stale", "message": message})


def _finite(value):
    if isinstance(value, dict):
        return all(_finite(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_finite(item) for item in value)
    return not isinstance(value, float) or math.isfinite(value)


def _rebalance(shares, cash, targets, opens, fee, slip):
    """Preserve post-cost raw-NAV weight targets; charge fees on adverse execution notionals."""
    weights = {row["symbol"]: row["weight_pct"] / 100 for row in targets}
    if (len(weights) != len(targets) or any(not path._positive(value) for value in weights.values())
            or math.fsum(weights.values()) > 1 or not 0 <= fee <= MAX_BPS / 10000 or not 0 <= slip <= MAX_BPS / 10000):
        raise path.PathUnavailable("invalid_cost_scenario")
    symbols = sorted(set(shares) | set(weights))
    if any(not path._positive(opens.get(symbol)) for symbol in symbols):
        raise path.PathUnavailable("valuation_bar_unavailable")
    held = {symbol: quantity * opens[symbol] for symbol, quantity in shares.items()}
    equity = cash + math.fsum(held.values())
    if not path._positive(equity):
        raise path.PathUnavailable("nonfinite_accounting")
    def costs(nav):
        result = []
        for symbol in symbols:
            delta = nav * weights.get(symbol, 0) - held.get(symbol, 0)
            gross = abs(delta) * (1 + slip if delta > 0 else 1 - slip)
            result.append(abs(delta) * slip + gross * fee)
        return math.fsum(result)
    low, high = 0.0, equity
    for _ in range(80):
        middle = (low + high) / 2
        if middle + costs(middle) > equity:
            high = middle
        else:
            low = middle
    values = {symbol: low * weight for symbol, weight in weights.items()}
    trades = []
    for symbol in symbols:
        delta = values.get(symbol, 0) - held.get(symbol, 0)
        if delta != 0:
            buying = delta > 0
            factor = 1 + slip if buying else 1 - slip
            raw_notional, execution_notional = abs(delta), abs(delta) * factor
            trade = {"symbol": symbol, "side": "buy" if buying else "sell", "shares": abs(delta) / opens[symbol],
                     "raw_open": opens[symbol], "fill_price": opens[symbol] * factor,
                     "raw_notional": raw_notional, "execution_notional": execution_notional,
                     "fee": execution_notional * fee, "slippage_cost": raw_notional * slip}
            if any(not math.isfinite(value) for value in trade.values() if isinstance(value, (int, float))):
                raise path.PathUnavailable("nonfinite_accounting")
            trades.append(trade)
    fees = math.fsum(trade["fee"] for trade in trades)
    slippage = math.fsum(trade["slippage_cost"] for trade in trades)
    next_cash = equity - math.fsum(values.values()) - fees - slippage
    if not math.isfinite(next_cash) or next_cash < -1e-7:
        raise path.PathUnavailable("nonfinite_accounting")
    next_shares = {symbol: value / opens[symbol] for symbol, value in values.items()}
    if any(not path._positive(value) for value in next_shares.values()):
        raise path.PathUnavailable("nonfinite_accounting")
    return next_shares, max(0.0, next_cash), trades, fees, slippage


def _simulate(calendar, decisions, raw, fee_bps, slippage_bps):
    """Replay only baseline-validated support; no signal or allocator is called here."""
    prices = {symbol: {bar["date"]: bar for bar in bars} for symbol, bars in raw.items()}
    decision_days = {row["trade_date"]: row for row in decisions}
    shares, cash, curve, events = {}, path.INITIAL_CASH, [], []
    fees, slippage, raw_notional, execution_notional = 0.0, 0.0, 0.0, 0.0
    peak, drawdown = path.INITIAL_CASH, 0.0
    def price(symbol, day, field):
        value = prices.get(symbol, {}).get(day, {}).get(field)
        if not path._positive(value):
            raise path.PathUnavailable("valuation_bar_unavailable", symbol=symbol, date=day)
        return value
    for previous, day in zip(calendar, calendar[1:]):
        decision = decision_days.get(day)
        if decision and decision["status"] == "rebalance":
            required = set(shares) | {target["symbol"] for target in decision["targets"]}
            opening = {symbol: price(symbol, day, "open") for symbol in required}
            shares, cash, trades, day_fees, day_slippage = _rebalance(shares, cash, decision["targets"], opening,
                                                                    fee_bps / 10000, slippage_bps / 10000)
            fees += day_fees
            slippage += day_slippage
            raw_notional += math.fsum(trade["raw_notional"] for trade in trades)
            execution_notional += math.fsum(trade["execution_notional"] for trade in trades)
            events.append({"signal_date": previous, "trade_date": day, "trades": trades,
                           "fee": day_fees, "slippage_cost": day_slippage, "cash": cash})
        held_value = math.fsum(amount * price(symbol, day, "close") for symbol, amount in shares.items())
        value = cash + held_value
        if not path._positive(value) or not all(math.isfinite(number) for number in (fees, slippage, raw_notional, execution_notional)):
            raise path.PathUnavailable("nonfinite_accounting", date=day)
        peak = max(peak, value)
        drawdown = min(drawdown, (value / peak - 1) * 100)
        curve.append({"date": day, "value": value, "cash": cash, "exposure_pct": held_value / value * 100})
    final = curve[-1]["value"]
    return {"metrics": {"initial_cash": path.INITIAL_CASH, "final_value": final,
                        "return_pct": (final / path.INITIAL_CASH - 1) * 100, "max_drawdown_pct": drawdown,
                        "total_fees": fees, "traded_notional": raw_notional,
                        "trade_count": sum(len(row["trades"]) for row in events)},
            "costs": {"fees": fees, "slippage": slippage, "total": fees + slippage,
                      "raw_notional": raw_notional, "execution_notional": execution_notional},
            "curve": curve, "events": events,
            "final_holdings": [{"symbol": symbol, "shares": amount, "raw_close": price(symbol, calendar[-1], "close"),
                                "value": amount * price(symbol, calendar[-1], "close")} for symbol, amount in sorted(shares.items())]}


def _baseline_case(baseline):
    metrics = baseline["metrics"]
    events = [{**event, "slippage_cost": 0.0, "trades": [{**trade, "raw_notional": trade["notional"],
        "execution_notional": trade["notional"], "fill_price": trade["raw_open"], "slippage_cost": 0.0}
        for trade in event["trades"]]} for event in baseline["events"]]
    return {"metrics": metrics, "curve": baseline["curve"], "events": events, "final_holdings": baseline["final_holdings"],
            "costs": {"fees": metrics["total_fees"], "slippage": 0.0, "total": metrics["total_fees"],
                      "raw_notional": metrics["traded_notional"], "execution_notional": metrics["traded_notional"]}}


def _case(baseline, calendar, raw, fee, slip):
    is_baseline = fee == path.FEE_BPS and slip == 0
    result = {"fee_bps": fee, "slippage_bps": slip, "is_baseline": is_baseline, "status": "unavailable",
              "reasons": [], "metrics": None, "costs": None, "differences": None, "curve": [], "events": [], "final_holdings": []}
    if baseline["status"] != "evaluated":
        result["reasons"] = [{"code": "baseline_unavailable", "details": baseline["reasons"]}]
        return result
    try:
        computed = _baseline_case(baseline) if is_baseline else _simulate(calendar, baseline["decisions"], raw, fee, slip)
        differences = {"final_value": computed["metrics"]["final_value"] - baseline["metrics"]["final_value"],
            "return_pp": computed["metrics"]["return_pct"] - baseline["metrics"]["return_pct"],
            "max_drawdown_pp": computed["metrics"]["max_drawdown_pct"] - baseline["metrics"]["max_drawdown_pct"],
            "explicit_cost": computed["costs"]["total"] - baseline["metrics"]["total_fees"]}
        if not _finite([computed, differences]):
            raise path.PathUnavailable("nonfinite_accounting")
        result.update(computed, differences=differences, status="evaluated")
    except path.PathUnavailable as error:
        result["reasons"].append(error.reason)
    except (OverflowError, FloatingPointError):
        result["reasons"].append({"code": "nonfinite_accounting"})
    return result


def evaluate(identifier, body):
    source_request = path.PathValidationInput.model_validate(body.model_dump(include=set(path.PathValidationInput.model_fields)))
    baseline = path.evaluate(identifier, source_request)
    calendar, raw = [], None
    if baseline["status"] == "evaluated":
        calendar = sessions.expected_sessions(baseline["window"]["signal_start"], baseline["as_of"])
        symbols = baseline["rps_universe"] or baseline["candidate_symbols"]
        loaded = {"coverage": {}, "reasons": []}
        with store.connect() as db:
            raw = path._load_history(db, symbols, baseline["as_of"], loaded)
        if raw is None or loaded["history_fingerprint"] != baseline["history_fingerprint"]:
            raise _problem("成本情境的本機歷史與基準不一致；請重新檢查路徑")
        if len(calendar) != baseline["window"]["sessions"] + 1:
            raise _problem("成本情境與基準交易日曆不一致；請重新檢查路徑")
    scenarios = [_case(baseline, calendar, raw, fee, slip) for fee in body.fee_bps for slip in body.slippage_bps]
    if sessions.latest_completed_session() != baseline["as_of"]:
        raise _problem("比較成本期間交易日已變更；請重新檢查路徑")
    available = sum(row["status"] == "evaluated" for row in scenarios)
    result = {"engine_version": ENGINE_VERSION, "path_engine_version": baseline["engine_version"],
              "agent_run_id": identifier, "proposal_fingerprint": baseline["proposal_fingerprint"],
              "input_revision": baseline["input_revision"], "as_of": baseline["as_of"], "current_at_snapshot": True,
              "mode": "advisory_only", "request": body.model_dump(), "baseline": baseline,
              "baseline_evidence_fingerprint": baseline["evidence_fingerprint"],
              "history_fingerprint": baseline["history_fingerprint"], "decision_fingerprint": _hash(baseline["decisions"]),
              "scenario_fingerprint": _hash({"engine_version": ENGINE_VERSION, "fee_bps": body.fee_bps, "slippage_bps": body.slippage_bps}),
              "status": "evaluated" if available == len(scenarios) else "unavailable" if not available else "incomplete",
              "coverage": {"required_scenarios": len(scenarios), "available_scenarios": available,
                           "unavailable_scenarios": len(scenarios) - available, "decision_sets_computed": 1},
              "scenarios": scenarios, "method": METHOD, "warnings": list(WARNINGS)}
    result["evidence_fingerprint"] = _hash(result)
    return result


@router.post("/api/portfolio-agent/runs/{identifier}/path-costs")
@store.snapshot_read
def compare_costs(identifier: str, body: CostInput):
    return JSONResponse(evaluate(identifier, body), headers={"Cache-Control": "no-store"})
