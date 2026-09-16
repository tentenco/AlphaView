"""Hypothetical Alpha basket research, using prior-session signals and net trades."""
import math
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from . import scan_provenance, sessions, store
from .alpha_replay import ReplayInput, rank_rows
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-alpha-basket-v1"


class BasketInput(ReplayInput):
    days: Literal[10, 20, 40] = 20
    top: Literal[3, 5, 10] = 5
    rebalance: Literal[1, 5, 10, 20] = 5
    initial: float = Field(default=10000, gt=0, le=1e9)
    fee_bps: float = Field(default=10, ge=0, le=100)


class MissingPrice(ValueError):
    pass


def rebalance_at_open(units, cash, selected, prices, fee):
    """Solve target invested value after costs, then trade only net differences."""
    held_values = {symbol: amount * prices[symbol] for symbol, amount in units.items()}
    equity = cash + sum(held_values.values())
    if not selected:
        orders = [{"symbol": symbol, "side": "sell", "notional": value, "cost": value * fee}
                  for symbol, value in held_values.items() if value > 0]
        costs = sum(order["cost"] for order in orders)
        return {}, equity - costs, orders, costs
    count = len(selected)
    def turnover(invested):
        target = invested / count
        return sum(abs(target - held_values.get(symbol, 0)) for symbol in selected) + sum(
            value for symbol, value in held_values.items() if symbol not in selected)
    low, high = 0.0, equity
    for _ in range(80):
        midpoint = (low + high) / 2
        if midpoint + fee * turnover(midpoint) > equity:
            high = midpoint
        else:
            low = midpoint
    invested = low
    target = invested / count
    next_units = {symbol: target / prices[symbol] for symbol in selected}
    orders = []
    for symbol in sorted(set(units) | set(selected)):
        difference = (target if symbol in selected else 0) - held_values.get(symbol, 0)
        if abs(difference) > max(1e-8, equity * 1e-12):
            orders.append({"symbol": symbol, "side": "buy" if difference > 0 else "sell",
                           "notional": abs(difference), "cost": abs(difference) * fee})
    costs = fee * turnover(invested)
    return next_units, max(0.0, equity - invested - costs), orders, costs


def simulate(calendar, selections, prices, *, initial, fee_bps, interval):
    """Pure accounting kernel. Selections are indexed by the PREVIOUS session."""
    units, cash, events, curve = {}, initial, [], []
    baseline_units, baseline_cash, baseline_error = {}, initial, None
    costs, turnover, exposure_days = 0.0, 0.0, 0
    fee = fee_bps / 10000
    def price(symbol, day, field):
        value = prices.get(symbol, {}).get(day, {}).get(field)
        if not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
            raise MissingPrice(f"{symbol} {day} 缺少有效調整{field}價格；未跨越缺口或替換標的")
        return value
    for index, day in enumerate(calendar[1:]):
        if index % interval == 0:
            signal_day = calendar[index]
            if signal_day not in selections:
                raise MissingPrice(f"{signal_day} 缺少有效選股快照；未沿用其他日期訊號")
            selected = selections[signal_day]
            opening = {symbol: price(symbol, day, "open") for symbol in set(units) | set(selected)}
            units, cash, orders, cost = rebalance_at_open(units, cash, selected, opening, fee)
            costs += cost
            turnover += sum(order["notional"] for order in orders)
            events.append({"signal_date": signal_day, "trade_date": day, "selected": selected,
                           "orders": orders, "cost": cost, "cash": cash})
            if index == 0:
                baseline_units, baseline_cash = dict(units), cash
        holding_value = sum(amount * price(symbol, day, "close") for symbol, amount in units.items())
        value = cash + holding_value
        if not math.isfinite(value) or value <= 0:
            raise MissingPrice(f"{day} 模擬資產值超出有效計算範圍")
        exposure_days += int(bool(units))
        baseline = None
        if baseline_error is None:
            try:
                baseline = baseline_cash + sum(amount * price(symbol, day, "close") for symbol, amount in baseline_units.items())
                if not math.isfinite(baseline) or baseline <= 0:
                    raise MissingPrice("初始組合基準超出有效計算範圍")
            except MissingPrice as exc:
                baseline_error = str(exc)
        curve.append({"date": day, "value": value, "cash": cash, "exposure_pct": holding_value / value * 100,
                      "benchmark": baseline})
    if baseline_error:
        for point in curve:
            point["benchmark"] = None
    peak, drawdown = initial, 0.0
    for point in curve:
        peak = max(peak, point["value"])
        drawdown = min(drawdown, (point["value"] / peak - 1) * 100)
    final = curve[-1]["value"] if curve else initial
    benchmark = curve[-1]["benchmark"] if curve else None
    return {"initial": initial, "final": final, "return_pct": (final / initial - 1) * 100,
            "benchmark_pct": (benchmark / initial - 1) * 100 if benchmark is not None else None,
            "benchmark_error": baseline_error, "max_drawdown_pct": drawdown,
            "total_cost": costs, "traded_notional": turnover,
            "exposure_days": exposure_days, "sessions": len(curve), "curve": curve, "events": events,
            "final_holdings": [{"symbol": symbol, "adjusted_units": amount,
                                "value": amount * price(symbol, calendar[-1], "close")} for symbol, amount in units.items()],
            "final_cash": cash}


@router.post("/api/alpha/basket")
@store.snapshot_read
def basket(body: BasketInput):
    expected = sessions.latest_completed_session()
    calendar = sessions.expected_sessions((date.fromisoformat(expected) - timedelta(days=150)).isoformat(), expected)[-(body.days + 1):]
    if len(calendar) != body.days + 1:
        raise HTTPException(422, "交易日曆未涵蓋模擬所需期間")
    universe = sorted(member["symbol"] for member in store.universe(body.scope))
    token = scan_provenance.current_token()
    selections, sources, candidate_symbols = {}, [], set()
    for index in range(0, body.days, body.rebalance):
        day = calendar[index]
        snapshot = store.latest_scan(day, scope=body.scope)
        if not snapshot or snapshot.get("input_revision") != token or sorted(set(snapshot["universe"])) != universe:
            raise HTTPException(422, f"{day} 缺少當期資料版本與相同股票池的選股快照；請重算每日選股")
        ranked = rank_rows(snapshot["result"], universe, day, body.weights.model_dump(), body.threshold, body.min_matches)
        # An empty universe/data set is not evidence of a valid cash signal.
        if not any(row["coverage"] >= 100 - 1e-9 for row in ranked) and universe:
            raise HTTPException(422, f"{day} 沒有可用研究資料，不能當成沒有 Alpha 訊號")
        chosen = [row["symbol"] for row in ranked if row["alpha"]][:body.top]
        selections[day] = chosen
        sources.append({"date": day, "scan_id": snapshot["id"], "usable": len(ranked), "total": len(universe), "selected": chosen})
        candidate_symbols.update(chosen)
    if not universe:
        raise HTTPException(422, "股票池為空，請先建立研究股票池")
    prices = {}
    with store.connect() as db:
        for symbol in candidate_symbols:
            rows = db.execute("SELECT * FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date",
                              (symbol, calendar[1], expected)).fetchall()
            prices[symbol] = {}
            for row in rows:
                if valid_bar(row):
                    factor = row["adj_close"] / row["close"]
                    prices[symbol][row["date"]] = {"open": row["open"] * factor, "close": row["adj_close"]}
    try:
        result = simulate(calendar, selections, prices, initial=body.initial, fee_bps=body.fee_bps, interval=body.rebalance)
    except MissingPrice as exc:
        raise HTTPException(422, str(exc)) from exc
    return {**result, "engine_version": ENGINE_VERSION, "input_revision": token, "settings": body.model_dump(),
            "start": calendar[1], "end": expected, "sources": sources,
            "method": "Current-universe retrospective simulation. Prior-session close signals; next-session adjusted open net rebalancing into equal weights; fractional adjusted units; explicit one-way cost; cash earns zero; no terminal liquidation. Baseline buys the first selected basket at the same opening and entry cost, then holds. Not actual portfolio performance or point-in-time market selection."}
