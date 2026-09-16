"""Pairwise candidate/holding return comparisons from local daily data."""
import math
import time
from datetime import date, timedelta
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import sessions, store
from .risk import MIN_OBSERVATIONS, valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-holding-fit-v1"


class FitInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symbols: list[str] = Field(min_length=1, max_length=5)
    window: Literal[60, 120] = 60

    @model_validator(mode="after")
    def unique_symbols(self):
        if len(set(self.symbols)) != len(self.symbols):
            raise ValueError("候選代碼不可重複")
        return self


def correlate(left, right):
    shared = sorted(left.keys() & right.keys())
    detail = {"observations": len(shared), "start": shared[0] if shared else None,
              "end": shared[-1] if shared else None, "correlation": None, "reason": None}
    if len(shared) < MIN_OBSERVATIONS:
        return {**detail, "reason": "insufficient_shared_returns"}
    a = np.array([left[day] for day in shared], dtype=float)
    b = np.array([right[day] for day in shared], dtype=float)
    if not np.isfinite(a).all() or not np.isfinite(b).all():
        return {**detail, "reason": "invalid_returns"}
    a, b = a / max(float(np.abs(a).max()), 1), b / max(float(np.abs(b).max()), 1)
    a, b = a - a.mean(), b - b.mean()
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 0 or not math.isfinite(denominator):
        return {**detail, "reason": "constant_returns"}
    return {**detail, "correlation": float(np.clip(np.dot(a, b) / denominator, -1, 1))}


@router.post("/api/alpha/holding-fit")
@store.snapshot_read
def holding_fit(body: FitInput):
    started = time.monotonic()
    expected = sessions.latest_completed_session()
    dates = sessions.expected_sessions((date.fromisoformat(expected) - timedelta(days=250)).isoformat(), expected)[-(body.window+1):]
    with store.connect() as db:
        known = {row[0] for row in db.execute("SELECT symbol FROM positions UNION SELECT symbol FROM market_universe UNION SELECT symbol FROM datasets")}
        if any(symbol not in known for symbol in body.symbols):
            raise HTTPException(404, "候選不在目前工作區")
        positions = [dict(row) for row in db.execute("SELECT symbol,name,shares FROM positions WHERE shares>0 ORDER BY symbol LIMIT 101")]
        if len(positions) > 100:
            raise HTTPException(422, "最多分析 100 檔持倉")
        revision = store.input_revision(db)
        symbols = list(dict.fromkeys([*body.symbols, *[position["symbol"] for position in positions]]))
        series, quality = {}, {}
        for symbol in symbols:
            if time.monotonic() - started > 10:
                raise HTTPException(503, "持倉走勢比較逾時，請稍後重試")
            bars = db.execute("SELECT * FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date", (symbol, dates[0], expected)).fetchall()
            current = next((bar for bar in reversed(bars) if bar["date"] == expected), None)
            ready = current is not None and valid_bar(current)
            observed = {bar["date"]: float(bar["adj_close"]) for bar in bars if valid_bar(bar)}
            returns = {}
            if ready:
                for previous, day in zip(dates, dates[1:]):
                    if previous in observed and day in observed:
                        value = observed[day] / observed[previous] - 1
                        if math.isfinite(value):
                            returns[day] = value
            series[symbol] = returns
            quality[symbol] = {"current": ready, "return_count": len(returns),
                               "close": float(current["close"]) if ready else None,
                               "reason": None if ready else "current_quote_unavailable"}
    values = []
    for position in positions:
        close = quality[position["symbol"]]["close"]
        shares = position["shares"]
        value = shares * close if isinstance(shares, (int, float)) and math.isfinite(shares) and close is not None else None
        values.append(value if value is not None and math.isfinite(value) and value > 0 else None)
    try:
        total = math.fsum(value for value in values if value is not None)
    except OverflowError:
        total = 0
    complete = bool(values) and all(value is not None for value in values) and math.isfinite(total) and total > 0
    holdings = [{"symbol": position["symbol"], "name": position["name"],
                 "weight_pct": values[index] / total * 100 if complete else None,
                 **quality[position["symbol"]]} for index, position in enumerate(positions)]
    candidates = []
    for symbol in body.symbols:
        pairs = []
        for holding in holdings:
            if symbol == holding["symbol"]:
                continue
            pair = correlate(series[symbol], series[holding["symbol"]])
            if not quality[symbol]["current"] or not holding["current"]:
                pair.update(correlation=None, reason="current_quote_unavailable")
            pairs.append({"holding": holding["symbol"], "weight_pct": holding["weight_pct"], **pair})
        candidates.append({"symbol": symbol, "already_held": any(p["symbol"] == symbol for p in positions),
                           **quality[symbol], "pairs": pairs})
    return {"engine_version": ENGINE_VERSION, "input_revision": revision, "as_of": expected,
            "window": body.window, "min_observations": MIN_OBSERVATIONS, "holding_count": len(holdings),
            "valuation_complete": complete, "holdings": holdings, "candidates": candidates,
            "method": "Pairwise Pearson correlation of adjacent-session adjusted-close returns. At least 40 shared observations; gaps are not filled. Each pair may use a different sample. Current unadjusted closes and current shares determine holding weights only when all quotes are valid. No portfolio covariance, allocation recommendation, or future-risk forecast."}
