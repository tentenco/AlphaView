"""Honest chart timelines: retain sourced prices, expose gaps, stop bad indicators."""
import math

import pandas as pd

from . import market, research

METRICS = ("ma20", "ma50", "ma200", "rsi")


def _number(value, positive=False):
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(value) or (positive and value <= 0):
        return None
    return value


def history(frame):
    """Return adjusted-close chart points and raw-source quality diagnostics.

    A null gap is an explicit missing observation, never a replacement price.
    Derived indicators stop at the first known issue, because rolling windows
    and recursive RSI can depend on it thereafter. Prices with independently
    valid close/adjusted-close fields remain inspectable for source diagnosis.
    """
    quality = market.history_quality(frame)
    if frame.empty or not {"date", "close", "adj_close", "volume"}.issubset(frame.columns):
        return {"history": [], "quality": quality}
    raw = frame.copy()
    raw["date"] = raw["date"].astype(str)
    valid_dates = raw.date.str.fullmatch(r"\d{4}-\d{2}-\d{2}") & pd.to_datetime(
        raw.date, format="%Y-%m-%d", errors="coerce").notna()
    raw = raw[valid_dates].sort_values("date").reset_index(drop=True)
    issues = quality["issues"]
    unknown_issue = any(issue["date"] is None for issue in issues)
    cutoff = min((issue["date"] for issue in issues if issue["date"]), default=None)
    clean = raw.iloc[:0] if unknown_issue else raw[raw.date < cutoff] if cutoff else raw
    derived = {}
    if len(clean) and {"open", "high", "low"}.issubset(clean.columns):
        calculated = research.indicators(clean)
        derived = {row.date: {key: _number(getattr(row, key)) for key in METRICS}
                   for row in calculated.itertuples()}
    duplicate_dates = set(raw.loc[raw.date.duplicated(keep=False), "date"])
    non_session_dates = {issue["date"] for issue in issues if issue["reason"] == "非美股交易日卻有日線"}
    gap_dates = {issue["date"] for issue in issues if issue["reason"] == "缺少交易日日線，技術指標視窗不完整"}
    points = {}
    for row in raw.itertuples():
        close = _number(row.close, positive=True)
        adjusted_close = _number(row.adj_close, positive=True)
        volume = _number(row.volume)
        ambiguous = row.date in duplicate_dates or row.date in non_session_dates
        points[row.date] = {"date": row.date,
                            "close": adjusted_close if close is not None and not ambiguous else None,
                            **{key: derived.get(row.date, {}).get(key) for key in METRICS},
                            "volume": volume if volume is not None and volume >= 0 and not ambiguous else None}
    for gap in gap_dates:
        points[gap] = {"date": gap, "close": None, **{key: None for key in METRICS}, "volume": None}
    return {"history": [points[day] for day in sorted(points)], "quality": quality}
