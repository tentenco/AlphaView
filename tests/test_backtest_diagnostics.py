import json
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("exchange_calendars")
from alphaview.panel import research, store
from alphaview.panel.sessions import expected_sessions


def history(n=240):
    dates = expected_sessions("2024-01-02", "2025-12-31")[:n]
    return pd.DataFrame({"symbol": "TEST", "date": dates, "open": 100., "high": 101.,
                         "low": 99., "close": 100., "adj_close": 100., "volume": 1_000_000.})


def test_diagnostics_match_two_hand_computed_trades_and_daily_returns():
    raw = history()
    raw.loc[[202, 203], ["close", "adj_close"]] = 110
    raw.loc[204, "open"] = 120
    raw.loc[[207, 208, 209], ["close", "adj_close"]] = 90
    raw.loc[209, "open"] = 90
    raw["high"] = raw[["open", "close"]].max(axis=1) + 1
    raw["low"] = raw[["open", "close"]].min(axis=1) - 1
    prepared = research.indicators(raw)
    prepared["turtle"] = False
    prepared.loc[[200, 205], "turtle"] = True
    prepared["low10"] = 0
    prepared.loc[[203, 208], "low10"] = 200
    with patch.object(store, "history", return_value=raw), patch.object(research, "indicators", return_value=prepared):
        result = research.backtest("TEST", "turtle", initial=1000, fee_bps=100, start_date=raw.iloc[200].date)
    first_units = 1000 / 101
    first_proceeds = first_units * 120 * .99
    second_units = first_proceeds / 101
    final = second_units * 90 * .99
    equity = np.array([1000, 1000, first_units * 100, first_units * 110, first_units * 110,
                       first_proceeds, first_proceeds, second_units * 100, second_units * 90,
                       second_units * 90, *([final] * 31)])
    daily = equity[1:] / equity[:-1] - 1
    assert len(daily) == result["trading_days"] == 40
    assert result["final"] == pytest.approx(final)
    assert result["trades"][0]["net_pnl"] == pytest.approx(first_proceeds - 1000)
    assert result["trades"][1]["net_pnl"] == pytest.approx(final - first_proceeds)
    assert result["trades"][0]["entry_fee"] == pytest.approx(first_units * 100 * .01)
    assert result["trades"][0]["exit_fee"] == pytest.approx(first_units * 120 * .01)
    assert result["win_rate_pct"] == 50
    assert result["profit_factor"] == pytest.approx((first_proceeds - 1000) / (first_proceeds - final))
    assert result["exposure_pct"] == 15
    assert result["annualized_volatility_pct"] == pytest.approx(np.std(daily, ddof=1) * np.sqrt(252) * 100)
    assert result["sharpe_ratio"] == pytest.approx(np.mean(daily) / np.std(daily, ddof=1) * np.sqrt(252))
    elapsed = (pd.Timestamp(raw.iloc[-1].date) - pd.Timestamp(raw.iloc[200].date)).days
    assert result["elapsed_days"] == elapsed
    assert result["cagr_pct"] == pytest.approx(((final / 1000) ** (365.25 / elapsed) - 1) * 100)
    assert result["max_drawdown_pct"] == round((final / first_proceeds - 1) * 100, 2)
    assert result["avg_holding_days"] == np.mean([t["holding_days"] for t in result["trades"]])
    assert result["benchmark_pct"] == 0
    assert result["benchmark_symbol"] == "TEST"
    assert result["warnings"]
    json.dumps(result, allow_nan=False)


def test_date_range_preserves_prior_warmup_and_does_not_open_early():
    raw = history()
    prepared = research.indicators(raw)
    prepared["turtle"] = False
    prepared.loc[[100, 210], "turtle"] = True
    prepared["low10"] = 0
    end = raw.iloc[230].date
    with patch.object(store, "history", return_value=raw), patch.object(research, "indicators", return_value=prepared.iloc[:231]):
        result = research.backtest("TEST", "turtle", fee_bps=0, start_date=raw.iloc[211].date, end_date=end)
    assert result["start"] == raw.iloc[211].date
    assert result["end"] == end
    assert result["open_position"]["date"] == result["start"]
    assert result["final"] == 10_000
    assert result["exposure_pct"] == 100
    assert result["trading_days"] == 20
    assert result["parameters"] == {"initial": 10000., "fee_bps": 0., "start_date": raw.iloc[211].date, "end_date": end}


def test_future_corruption_cannot_change_historical_run_or_fingerprint():
    raw = history()
    end = raw.iloc[220].date
    with patch.object(store, "history", return_value=raw):
        before = research.backtest("TEST", "trend", end_date=end)
        fingerprint = research.backtest_input_fingerprint("TEST", "trend", end_date=end)
    raw.loc[221:, ["close", "adj_close"]] = np.nan
    raw.loc[221:, "open"] = -100
    with patch.object(store, "history", return_value=raw):
        after = research.backtest("TEST", "trend", end_date=end)
    assert before == after
    assert fingerprint == before["input_fingerprint"]


def test_fingerprint_changes_with_used_data_parameters_and_engine(monkeypatch):
    raw = history()
    with patch.object(store, "history", return_value=raw):
        first = research.backtest_input_fingerprint("TEST", "turtle")
        assert research.backtest_input_fingerprint("TEST", "turtle", fee_bps=11) != first
        assert research.backtest_input_fingerprint("TEST", "turtle", initial=20000) != first
        raw.loc[0, "volume"] = 2_000_000
        changed_data = research.backtest_input_fingerprint("TEST", "turtle")
        assert changed_data != first
        monkeypatch.setattr(research, "BACKTEST_ENGINE_VERSION", "test-next-engine")
        assert research.backtest_input_fingerprint("TEST", "turtle") != changed_data


def test_no_trades_and_flat_equity_leave_undefined_metrics_null():
    with patch.object(store, "history", return_value=history()):
        result = research.backtest("TEST", "turtle")
    assert result["cagr_pct"] == result["annualized_volatility_pct"] == 0
    assert result["sharpe_ratio"] is None
    assert result["win_rate_pct"] is None
    assert result["profit_factor"] is None
    assert result["avg_holding_days"] is None
    assert result["exposure_pct"] == 0
    assert any("尚無已平倉" in warning for warning in result["warnings"])


@pytest.mark.parametrize("options", [
    {"initial": 0}, {"initial": -1}, {"initial": float("inf")}, {"initial": True},
    {"fee_bps": -1}, {"fee_bps": 101}, {"fee_bps": float("nan")},
    {"start_date": "20240901"}, {"end_date": "2024-02-30"},
    {"start_date": "2024-09-02", "end_date": "2024-09-01"},
    {"start_date": "2030-01-01"}, {"end_date": "2020-01-01"},
])
def test_invalid_options_or_no_useful_overlap_raise(options):
    with patch.object(store, "history", return_value=history()), pytest.raises(ValueError):
        research.backtest("TEST", "turtle", **options)
