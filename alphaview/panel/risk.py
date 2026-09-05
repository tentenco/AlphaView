"""Bounded, read-only diagnostics of current holdings, not portfolio performance."""
import math
import sqlite3
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from . import sessions, store

router = APIRouter()
MIN_OBSERVATIONS = 40
MAX_SECONDS = 10


def positive(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def valid_bar(row):
    prices = [positive(row[key]) for key in ("open", "high", "low", "close", "adj_close")]
    if any(value is None for value in prices):
        return False
    try:
        volume = float(row["volume"])
    except (TypeError, ValueError, OverflowError):
        return False
    if not math.isfinite(volume) or volume < 0:
        return False
    opening, high, low, close, _ = prices
    tolerance = max(opening, high, low, close, 1) * 1e-7
    return high + tolerance >= max(opening, low, close) and low - tolerance <= min(opening, high, close)


def report(window=60):
    if window not in (60, 120):
        raise ValueError("觀察期間必須為 60 或 120 個交易日")
    deadline = time.monotonic() + MAX_SECONDS

    def check():
        if time.monotonic() > deadline:
            raise HTTPException(503, "風險分析逾時，請稍後重試")

    as_of = sessions.latest_completed_session()
    dates = sessions.expected_sessions((pd.Timestamp(as_of) - pd.Timedelta(days=250)).date().isoformat(), as_of)[-(window + 1):]
    holdings, returns = [], {}
    try:
        with store.connect() as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA busy_timeout=1000")
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            db.execute("BEGIN")
            positions = db.execute("SELECT symbol,name,shares FROM positions WHERE shares>0 ORDER BY symbol LIMIT 101").fetchall()
            if len(positions) > 100:
                raise HTTPException(422, "風險分析最多支援 100 檔持股")
            for position in positions:
                check()
                symbol = position["symbol"]
                rows = db.execute("SELECT * FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date", (symbol, dates[0], as_of)).fetchall()
                latest = db.execute("SELECT * FROM bars WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT 1", (symbol, as_of)).fetchone()
                latest_valid = latest is not None and valid_bar(latest)
                status = "unavailable" if not latest_valid else "ok" if latest["date"] == as_of else "stale"
                value = None
                if status == "ok":
                    shares = positive(position["shares"])
                    value = positive(shares * float(latest["close"])) if shares else None
                    if value is None:
                        status = "unavailable"
                observed = {row["date"]: float(row["adj_close"]) for row in rows if valid_bar(row)}
                series = {}
                if status == "ok":
                    for previous, current in zip(dates, dates[1:]):
                        if previous in observed and current in observed:
                            change = observed[current] / observed[previous] - 1
                            if math.isfinite(change):
                                series[current] = change
                returns[symbol] = series
                reason = "最新交易日日線不可用" if status == "unavailable" else "行情尚未更新至最新已收盤交易日" if status == "stale" else None
                holdings.append({"symbol": symbol, "name": position["name"], "market_value": value,
                                 "weight_pct": None, "quote_status": status, "return_count": len(series),
                                 "history_status": status, "reason": reason})
    except sqlite3.OperationalError as exc:
        code = getattr(exc, "sqlite_errorcode", None)
        base_code = code & 0xFF if isinstance(code, int) else None
        message = str(exc).lower()
        busy = base_code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
        if base_code is None:
            busy = message in ("database is locked", "database table is locked", "database schema is locked")
        if busy:
            raise HTTPException(503, "資料庫忙碌中，請稍後重試風險分析") from exc
        if "interrupt" in message:
            raise HTTPException(503, "風險分析逾時，請稍後重試") from exc
        raise
    check()
    priced = [row["market_value"] for row in holdings if row["market_value"] is not None]
    try:
        total = math.fsum(priced) if priced else None
    except OverflowError:
        total = None
    complete = bool(holdings) and len(priced) == len(holdings) and total is not None and math.isfinite(total)
    if complete:
        for row in holdings:
            row["weight_pct"] = row["market_value"] / total * 100
    weights = sorted((row["weight_pct"] for row in holdings if row["weight_pct"] is not None), reverse=True)
    pairs = []
    for index, left in enumerate(holdings):
        check()
        for right in holdings[index:]:
            shared = sorted(returns[left["symbol"]].keys() & returns[right["symbol"]].keys())
            reason = left["reason"] or right["reason"]
            correlation = None
            if not reason and len(shared) < MIN_OBSERVATIONS:
                reason = f"共同有效日報酬不足 {MIN_OBSERVATIONS} 筆"
            if not reason:
                a = np.array([returns[left["symbol"]][day] for day in shared])
                b = np.array([returns[right["symbol"]][day] for day in shared])
                # Scale before centering to avoid covariance overflow on valid extreme returns.
                a = a / max(float(np.max(np.abs(a))), 1)
                b = b / max(float(np.max(np.abs(b))), 1)
                a, b = a - a.mean(), b - b.mean()
                denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
                if denominator <= 0 or not math.isfinite(denominator):
                    reason = "報酬沒有變動，相關性無法定義"
                else:
                    correlation = float(np.clip(np.dot(a, b) / denominator, -1, 1))
            pairs.append({"left": left["symbol"], "right": right["symbol"], "correlation": correlation,
                          "observations": len(shared), "start": shared[0] if shared else None,
                          "end": shared[-1] if shared else None, "reason": reason})
    warnings = ["這是目前持股的集中度與歷史日報酬相關性，不是歷史投資組合績效或未來風險預測。",
                "各配對可能使用不同共同日期；不可直接當成完整共變異數矩陣或 VaR。"]
    if not complete:
        warnings.append("估值涵蓋不完整或沒有持股；金額僅為有效報價小計，權重與集中度不計算。")
    return {"as_of": as_of, "window": window, "start": dates[1], "end": as_of,
            "min_observations": MIN_OBSERVATIONS, "holding_count": len(holdings), "priced_count": len(priced),
            "valuation_complete": complete, "market_value": total,
            "largest_weight_pct": weights[0] if weights else None,
            "top3_weight_pct": sum(weights[:3]) if weights else None,
            "holdings": holdings, "pairs": pairs, "warnings": warnings,
            "method": "估值採目前股數與最新已完成交易日的未調整收盤價；相關性採調整收盤價的相鄰 XNYS 交易日日報酬。缺日或無效日線不補值，過期標的不納入；每對至少 40 筆共同觀測。"}


@router.get("/api/portfolio/risk")
def portfolio_risk(window: int = 60):
    if window not in (60, 120):
        raise HTTPException(422, "觀察期間必須為 60 或 120 個交易日")
    return report(window)
