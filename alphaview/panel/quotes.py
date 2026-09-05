"""Read cached observed quotes without falling back or emitting non-finite JSON."""
import math


def finite(value, positive=False):
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) and (not positive or value > 0) else None


def total(values):
    """A subtotal is unavailable if arithmetic overflows; never substitute zero."""
    try:
        return finite(math.fsum(values))
    except (OverflowError, ValueError):
        return None


def valuation(frame, shares, cost, expected_session=None):
    from .sessions import latest_completed_session
    expected_session = expected_session or latest_completed_session()
    last = frame.iloc[-1] if len(frame) else None
    previous = frame.iloc[-2] if len(frame) > 1 else None
    price = finite(last.close, positive=True) if last is not None else None
    future = last is not None and str(last.date) > expected_session
    if future:
        price = None
    previous_price = finite(previous.close, positive=True) if previous is not None else None
    change = finite(price - previous_price) if price is not None and previous_price is not None else None
    change_pct = finite(change / previous_price * 100) if change is not None else None
    reason = None
    status = "ok"
    if price is None:
        status, reason = "unavailable", "尚無收盤行情" if last is None else "最新收盤價無效；未改用較舊價格估值"
    elif str(last.date) < expected_session:
        status, reason = "stale", f"最新收盤行情為 {last.date}，尚未更新至 {expected_session}；當日漲跌暫不可用"
        change = change_pct = None
    elif previous_price is None:
        status, reason = "partial", "前一筆收盤價缺少或無效，無法計算日漲跌"
    elif change is None or change_pct is None:
        status, reason = "partial", "日漲跌計算超出有效數值範圍"
    elif previous is not None:
        from .sessions import expected_sessions
        try:
            sessions = expected_sessions(str(previous.date), str(last.date))
        except (TypeError, ValueError):
            sessions = []
        if len(sessions) != 2 or sessions != [str(previous.date), str(last.date)]:
            change = change_pct = None
            status, reason = "partial", "前後行情不是相鄰交易日，無法當作單日漲跌"
    if future:
        status, reason = "unavailable", f"日線日期 {last.date} 尚未通過收盤檢查；應有交易日 {expected_session}"
    shares = finite(shares)
    cost = finite(cost) if cost is not None else None
    value = finite(price * shares) if price is not None and shares is not None else None
    cost_value = finite(shares * cost) if shares is not None and cost is not None else None
    pnl = finite(value - cost_value) if value is not None and cost_value is not None and shares > 0 else None
    pnl_pct = finite(pnl / cost_value * 100) if pnl is not None and cost_value else None
    if price is not None and shares is not None and shares > 0 and value is None:
        status, reason = "partial", "持股估值超出有效數值範圍"
    return {"price": price, "price_date": str(last.date) if last is not None else None,
            "change": change, "change_pct": change_pct, "market_value": value,
            "cost_value": cost_value, "pnl": pnl, "pnl_pct": pnl_pct,
            "quote_status": status, "quote_reason": reason, "expected_session": expected_session,
            "sparkline": [{"date": str(row.date), "close": finite(row.close, positive=True) if str(row.date) <= expected_session else None}
                          for row in frame.tail(30).itertuples()]}
