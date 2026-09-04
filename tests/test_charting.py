import json

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("exchange_calendars")
from alphaview.panel import charting
from alphaview.panel.sessions import expected_sessions


def bars(n=240):
    prices = np.linspace(100, 180, n)
    return pd.DataFrame({"symbol": "TEST", "date": expected_sessions("2024-01-02", "2025-12-31")[:n],
                         "open": prices - .5, "high": prices + 1, "low": prices - 1,
                         "close": prices, "adj_close": prices * .95, "volume": 1_000_000.})


def test_missing_session_is_null_and_stops_indicators_without_inventing_prices():
    raw = bars()
    missing_day = raw.iloc[220].date
    missing = raw.drop(index=220)
    result = charting.history(missing)
    points = {point["date"]: point for point in result["history"]}
    assert points[missing_day] == {"date": missing_day, "close": None, "ma20": None,
                                   "ma50": None, "ma200": None, "rsi": None, "volume": None}
    before = points[raw.iloc[219].date]
    assert before["ma200"] is not None and before["rsi"] is not None
    after = points[raw.iloc[221].date]
    assert after["close"] == raw.iloc[221].adj_close
    assert after["volume"] == raw.iloc[221].volume
    assert all(after[key] is None for key in charting.METRICS)
    assert len(result["history"]) == len(raw)
    assert len(missing) == 239


def test_bad_ohlc_preserves_inspectable_close_but_not_derived_metrics():
    raw = bars()
    raw.loc[220, "open"] = 0
    result = charting.history(raw)
    assert result["quality"]["status"] == "data_error"
    point = result["history"][220]
    assert point["close"] == raw.iloc[220].adj_close
    assert all(point[key] is None for key in charting.METRICS)
    assert all(result["history"][-1][key] is None for key in charting.METRICS)


def test_future_issue_never_changes_earlier_chart_prefix():
    raw = bars()
    clean = charting.history(raw.iloc[:220])
    raw.loc[220, "open"] = -1
    bad = charting.history(raw)
    assert bad["history"][:220] == clean["history"]
    assert clean["quality"]["status"] == "ok"


@pytest.mark.parametrize("column,value", [("close", np.inf), ("close", 0), ("adj_close", np.nan), ("adj_close", "broken")])
def test_invalid_price_becomes_json_null(column, value):
    raw = bars()
    raw[column] = raw[column].astype(object)
    raw.loc[230, column] = value
    result = charting.history(raw)
    assert result["history"][230]["close"] is None
    json.dumps(result, allow_nan=False)


def test_invalid_volume_and_duplicate_session_never_choose_arbitrary_data():
    raw = bars()
    raw.loc[230, "volume"] = -1
    raw = pd.concat([raw, raw.iloc[[231]]], ignore_index=True)
    result = charting.history(raw)
    assert result["history"][230]["volume"] is None
    assert result["history"][231]["close"] is None
    assert result["history"][231]["volume"] is None
    assert len(result["history"]) == 240


def test_unknown_date_suppresses_metrics_but_keeps_valid_timeline():
    raw = bars()
    raw.loc[239, "date"] = "not-a-date"
    result = charting.history(raw)
    assert len(result["history"]) == 239
    assert result["quality"]["issues"][0]["date"] is None
    assert all(point["ma20"] is None and point["rsi"] is None for point in result["history"])


def test_empty_history_is_safe():
    result = charting.history(bars().iloc[:0])
    assert result["history"] == []
    assert result["quality"]["status"] == "no_data"
