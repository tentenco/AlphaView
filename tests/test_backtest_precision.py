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
    expected = initial / 1.001
    assert result["final"] == result["curve"][-1]["value"]
    assert result["final"] == pytest.approx(expected)
    assert result["final"] != round(expected, 2)
    assert result["return_pct"] == round((result["final"] / initial - 1) * 100, 2) == -0.1
    assert result["benchmark_pct"] == round((result["curve"][-1]["benchmark"] / initial - 1) * 100, 2)


@pytest.mark.parametrize("initial,fee_bps", [(10000., 100), (10000., 0), (1e-6, 10)])
def test_flat_round_trip_charges_executed_notional_and_preserves_tiny_amounts(initial, fee_bps):
    raw = history()
    prepared = research.indicators(raw)
    prepared["turtle"] = False
    prepared.loc[200, "turtle"] = True
    prepared["low10"] = 0
    prepared.loc[201, "low10"] = 200
    with patch.object(store, "history", return_value=raw), patch.object(research, "indicators", return_value=prepared):
        result = research.backtest("TEST", "turtle", initial=initial, fee_bps=fee_bps, start_date=raw.iloc[200].date)
    fee = fee_bps / 10000
    # A flat-price round trip sells the same notional purchased, net of sell cost.
    expected_final = initial * (1 - fee) / (1 + fee)
    trade, = result["trades"]
    assert result["final"] == pytest.approx(expected_final, rel=1e-12, abs=0)
    assert trade["entry_fee"] == pytest.approx(initial * fee / (1 + fee), rel=1e-12, abs=0)
    assert trade["exit_fee"] == pytest.approx(trade["entry_fee"], rel=1e-12, abs=0)
    assert trade["net_pnl"] == result["final"] - initial
    assert -trade["net_pnl"] == pytest.approx(trade["entry_fee"] + trade["exit_fee"], rel=1e-12, abs=0)
    assert result["final"] == result["curve"][-1]["value"]
    assert result["max_drawdown_pct"] == result["return_pct"]
    if fee_bps:
        assert trade["entry_fee"] > 0 and trade["exit_fee"] > 0 and trade["net_pnl"] < 0
    else:
        assert trade["entry_fee"] == trade["exit_fee"] == trade["net_pnl"] == 0
    if initial == 10000 and fee_bps == 100:
        assert result["final"] == pytest.approx(9801.980198019803)
    assert result["engine_version"] == "alphaview-backtest-v5"


def test_tiny_open_position_preserves_entry_fee_and_budget_conservation():
    raw = history()
    prepared = research.indicators(raw)
    prepared["turtle"] = False
    prepared.loc[200, "turtle"] = True
    prepared["low10"] = 0
    initial = 1e-6
    with patch.object(store, "history", return_value=raw), patch.object(research, "indicators", return_value=prepared):
        result = research.backtest("TEST", "turtle", initial=initial, fee_bps=10, start_date=raw.iloc[200].date)
    entry = result["open_position"]
    assert entry["fee"] > 0
    assert entry["fee"] == pytest.approx(entry["units"] * entry["price"] * .001, rel=1e-12, abs=0)
    assert entry["units"] * entry["price"] + entry["fee"] == pytest.approx(initial, rel=1e-12, abs=0)
    assert result["final"] + entry["fee"] == pytest.approx(initial, rel=1e-12, abs=0)
