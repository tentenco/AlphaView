from unittest.mock import patch

import pandas as pd
import pytest

from alphaview.panel import research, store
from alphaview.panel.sessions import expected_sessions


def history():
    dates = expected_sessions("2024-01-02", "2025-12-31")[:240]
    return pd.DataFrame({"symbol": "TEST", "date": dates, "open": 100., "high": 101.,
                         "low": 99., "close": 100., "adj_close": 100., "volume": 1000000.})


@pytest.mark.parametrize("initial", [0.001, 0.015, 1, 10000])
def test_flat_no_trade_preserves_positive_capital_and_zero_returns(initial):
    with patch.object(store, "history", return_value=history()):
        result = research.backtest("TEST", "turtle", initial=initial)
    assert result["trades"] == [] and result["open_position"] is None
    assert result["final"] == result["curve"][-1]["value"] == initial
    assert result["return_pct"] == result["benchmark_pct"] == result["cagr_pct"] == 0
    assert all(point["value"] == initial for point in result["curve"])
    assert result["curve"][-1]["benchmark"] == pytest.approx(initial)


def test_trade_curve_final_and_percentage_share_unrounded_accounting():
    raw = history()
    prepared = research.indicators(raw)
    prepared["turtle"] = False
    prepared.loc[200, "turtle"] = True
    prepared["low10"] = 0
    initial = 0.015
    with patch.object(store, "history", return_value=raw), patch.object(research, "indicators", return_value=prepared):
        result = research.backtest("TEST", "turtle", initial=initial, fee_bps=10, start_date=raw.iloc[200].date)
    expected = initial * .999
    assert result["final"] == result["curve"][-1]["value"]
    assert result["final"] == pytest.approx(expected)
    assert result["final"] != round(expected, 2)
    assert result["return_pct"] == round((result["final"] / initial - 1) * 100, 2) == -0.1
    assert result["benchmark_pct"] == round((result["curve"][-1]["benchmark"] / initial - 1) * 100, 2)
