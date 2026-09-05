"""Independent economic-equivalence and execution-boundary research checks.

These fixtures exercise real indicator generation and strategy signals. They do
not certify a provider's corporate-action factors: equivalent inputs are known
by construction, while provider repair remains a separately reviewed operation.
"""
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

from alphaview.panel import research, store
from alphaview.panel.sessions import expected_sessions


def history():
    dates = expected_sessions("2024-01-02", "2025-12-31")[:250]
    # Alternating advances and retreats provide real crossings and repeated
    # closes, without relying on manufactured boolean strategy columns.
    close = 100 + np.arange(250) * .15 + np.sin(np.arange(250) / 7) * 9
    opening = close - .5
    return pd.DataFrame({"symbol": "TEST", "date": dates, "open": opening,
                         "high": close + .2, "low": opening - .2,
                         "close": close, "adj_close": close,
                         "volume": np.where(np.arange(250) % 3 == 0, 2e6, 1e6)})


def equivalent_split_history(raw):
    result = raw.copy()
    # The source reports pre-split raw OHLC in old units, but adj_close already
    # expresses the entire series in the final share unit. Hold volume fixed so
    # this tests price adjustment rather than guessing source volume semantics.
    result.loc[:219, ["open", "high", "low", "close"]] *= 2
    return result


def test_equivalent_split_representation_preserves_all_indicator_values():
    raw = history()
    ordinary = research.indicators(raw)
    split = research.indicators(equivalent_split_history(raw))
    pd.testing.assert_frame_equal(ordinary, split)
    assert ordinary.attrs["data_quality"]["valid"]


@pytest.mark.parametrize("strategy", ["turtle", "trend", "pullback"])
def test_equivalent_split_representation_preserves_economic_backtest(strategy):
    raw = history()
    with patch.object(store, "history", return_value=raw):
        ordinary = research.backtest("TEST", strategy)
    with patch.object(store, "history", return_value=equivalent_split_history(raw)):
        split = research.backtest("TEST", strategy)
    assert ordinary["trades"]  # Every strategy fixture executes a complete trade.
    # Raw-input fingerprints correctly differ even when the economic result is
    # equivalent: a later source revision must still invalidate saved research.
    assert ordinary.pop("input_fingerprint") != split.pop("input_fingerprint")
    assert ordinary == split


def test_real_breakout_waits_for_next_open_and_includes_overnight_gap():
    raw = history()
    raw[["open", "close", "adj_close"]] = 100.
    raw["high"], raw["low"], raw["volume"] = 101., 99., 1e6
    # First real breakout at close 22, followed by a 25% opening gap. There is
    # no signal at close 21, so the engine cannot own the jump from 100 to 125.
    raw.loc[22, ["close", "adj_close", "high"]] = [105., 105., 106.]
    raw.loc[23:, ["open", "close", "adj_close", "high", "low"]] = [125., 125., 125., 126., 124.]
    with patch.object(store, "history", return_value=raw):
        result = research.backtest("TEST", "turtle", fee_bps=0)
    entry = result["open_position"]
    assert entry["date"] == raw.iloc[23].date
    assert entry["price"] == 125
    assert entry["units"] == 80
    assert result["final"] == 10000
    assert result["trades"] == []
    assert all(point["value"] == 10000 for point in result["curve"])
    assert result["benchmark_pct"] == 25


def test_real_final_session_signal_does_not_create_unexecutable_position():
    raw = history()
    raw[["open", "close", "adj_close"]] = 100.
    raw["high"], raw["low"], raw["volume"] = 101., 99., 1e6
    raw.loc[249, ["close", "adj_close", "high"]] = [105., 105., 106.]
    assert research.indicators(raw).iloc[-1].turtle
    with patch.object(store, "history", return_value=raw):
        result = research.backtest("TEST", "turtle", fee_bps=0)
    assert result["trades"] == []
    assert result["open_position"] is None
    assert result["final"] == 10000


@pytest.mark.parametrize("strategy", ["turtle", "trend", "pullback"])
def test_actual_signal_backtest_equity_prefix_is_causal(strategy):
    raw = history()
    with patch.object(store, "history", return_value=raw):
        full = research.backtest("TEST", strategy)
        prefix = research.backtest("TEST", strategy, end_date=raw.iloc[229].date)
    assert full["trades"]  # Causality is exercised with actual executed signals.
    assert prefix["curve"] == full["curve"][:len(prefix["curve"])]
    assert prefix["trades"] == [trade for trade in full["trades"]
                                 if trade["exit_date"] <= prefix["end"]]
    assert prefix["final"] == prefix["curve"][-1]["value"]
