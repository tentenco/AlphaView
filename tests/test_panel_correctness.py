"""Regression checks for failed scan batches and malformed market data."""
import json
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("yfinance")
from alphaview.panel import market, research, store


def bars(n=240):
    from alphaview.panel.sessions import expected_sessions
    close = np.linspace(100, 180, n)
    return pd.DataFrame({
        "symbol": "TEST", "date": expected_sessions("2024-01-02", "2025-12-31")[:n],
        "open": close - .5, "high": close + 1, "low": close - 1,
        "close": close, "adj_close": close, "volume": 1_000_000.,
    })


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "correctness.db"))
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('TEST','Test',0,'test',?)",
                   (store.now(),))
        bars().to_sql("bars", db, if_exists="append", index=False)


def test_scan_failure_never_publishes_partial_historical_run(isolated_db):
    research.scan()
    previous = store.latest_scan()
    with store.connect() as db:
        count = db.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
    observations = []

    def interrupted_progress(message):
        observations.append(store.latest_scan())
        if len(observations) == 3:
            raise RuntimeError("simulated cancellation")

    with pytest.raises(RuntimeError, match="simulated cancellation"):
        research.scan(interrupted_progress)
    assert observations == [previous] * 3
    assert store.latest_scan() == previous
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM scans").fetchone()[0] == count


def test_scan_sql_failure_rolls_back_entire_batch(isolated_db):
    research.scan()
    previous = store.latest_scan()
    with store.connect() as db:
        count = db.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
        # Fail on the second inserted date after the first INSERT has succeeded.
        db.execute(f"""CREATE TRIGGER reject_second_scan BEFORE INSERT ON scans
                    WHEN (SELECT COUNT(*) FROM scans) > {count}
                    BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END""")
    with pytest.raises(Exception, match="simulated storage failure"):
        research.scan()
    assert store.latest_scan() == previous
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM scans").fetchone()[0] == count


@pytest.mark.parametrize("column,value", [
    ("open", 0), ("high", 50), ("low", 200), ("close", np.inf),
    ("adj_close", np.nan), ("volume", -1), ("open", "not a price"),
])
def test_bad_provider_batch_preserves_previous_history(isolated_db, column, value):
    original = store.history("TEST")
    incoming = bars(3)
    incoming[column] = incoming[column].astype(object)
    incoming.loc[1, column] = value
    incoming = incoming.set_index(pd.to_datetime(incoming.date)).rename(columns={
        "open": "Open", "high": "High", "low": "Low", "close": "Close",
        "adj_close": "Adj Close", "volume": "Volume",
    }).drop(columns=["date", "symbol"])
    with patch("yfinance.Ticker") as ticker:
        ticker.return_value.history.return_value = incoming
        ticker.return_value.get_history_metadata.return_value = {"currency": "USD", "longName": "Test"}
        results = market.refresh()
    assert results[0]["status"] == "error"
    assert "未替換原有資料" in results[0]["error"]
    pd.testing.assert_frame_equal(store.history("TEST"), original)
    assert store.dataset_rows()[0]["status"] == "error"


@pytest.mark.parametrize("dates", [["2024-01-01", "2024-01-01"], ["2024-01-01", "2024-02-30"]])
def test_duplicate_or_invalid_dates_are_rejected(dates):
    frame = bars(2)
    frame["date"] = dates
    with pytest.raises(ValueError, match="日期無效或重複"):
        market.validate_bars(frame)


def test_zero_volume_session_is_retained_and_unordered_bars_are_sorted():
    frame = bars(3)
    frame.loc[1, "volume"] = 0
    validated = market.validate_bars(frame.iloc[::-1])
    assert list(validated.date) == list(frame.date)
    assert list(validated.volume) == [1_000_000, 0, 1_000_000]


@pytest.mark.parametrize("column,value", [("open", 0), ("close", np.inf), ("adj_close", np.nan)])
def test_backtest_rejects_previously_stored_invalid_prices(column, value):
    frame = bars()
    frame.loc[21, column] = value
    with patch.object(store, "history", return_value=frame), pytest.raises(ValueError, match="日線價格"):
        research.backtest("TEST", "turtle")


def test_valid_backtest_is_strict_json_and_uses_next_open():
    frame = bars()
    prepared = research.indicators(frame)
    prepared["turtle"] = False
    prepared.loc[22, "turtle"] = True
    prepared["low10"] = 0
    with patch.object(store, "history", return_value=frame), patch.object(research, "indicators", return_value=prepared):
        result = research.backtest("TEST", "turtle")
    assert result["open_position"]["date"] == frame.iloc[23].date
    assert result["final"] == pytest.approx(round(10_000 * .999 / frame.iloc[23].open * frame.iloc[-1].close, 2))
    json.dumps(result, allow_nan=False)


def test_quality_allows_float_rounding_but_rejects_real_ohlc_disagreement():
    frame = bars(2)
    frame.loc[1, "low"] = frame.loc[1, "open"] + .000001
    assert market.history_quality(frame)["valid"]
    frame.loc[1, "low"] = frame.loc[1, "open"] + .01
    quality = market.history_quality(frame)
    assert quality["status"] == "data_error"
    assert quality["invalid_count"] == 1
    assert quality["issues"] == [{"date": frame.iloc[1].date, "reason": "最低價高於開盤、最高或收盤價"}]


def test_corrupt_cache_is_quarantined_without_future_leakage_or_rps_inclusion():
    good = bars()
    bad = good.copy()
    bad.loc[239, "low"] = bad.loc[239, "close"] + 20
    prepared = research.indicators(bad)
    earlier = good.iloc[238].date
    assert market.history_quality(bad, as_of=earlier)["valid"]
    assert not market.history_quality(bad, as_of=good.iloc[-1].date)["valid"]
    assert research.evaluate({"TEST": prepared}, earlier) == research.evaluate(
        {"TEST": research.indicators(good)}, earlier)
    result = research.evaluate({"BAD": prepared, "ONE": research.indicators(good), "TWO": research.indicators(good)}, good.iloc[-1].date)
    assert all(s["status"] == "data_error" and not s["matched"] for s in result[0]["signals"])
    assert result[0]["indicators"] == {}
    assert result[0]["quality"]["issues"][0]["date"] == good.iloc[-1].date
    assert all(r["signals"][-1]["status"] == "insufficient" for r in result[1:])
    assert "同日有效比較標的不足 3 檔" in result[1]["signals"][-1]["reason"]


def test_invalid_numeric_cache_does_not_crash_the_scan(isolated_db):
    with store.connect() as db:
        db.execute("UPDATE bars SET open='broken' WHERE date=(SELECT MAX(date) FROM bars)")
    result = research.scan()
    assert result["data_error_symbols"] == ["TEST"]
    assert result["matched_symbols"] == []
    saved = store.latest_scan()
    assert all(s["status"] == "data_error" for s in saved["result"][0]["signals"])
    with store.connect() as db:
        assert db.execute("SELECT open FROM bars ORDER BY date DESC LIMIT 1").fetchone()[0] == "broken"


def test_missing_session_quarantine_is_dated_and_has_no_future_leakage():
    original = bars()
    missing_day = original.iloc[235].date
    missing = original.drop(index=235)
    quality = market.history_quality(missing)
    assert quality["issues"] == [{"date": missing_day, "reason": "缺少交易日日線，技術指標視窗不完整"}]
    earlier = original.iloc[230].date
    assert market.history_quality(missing, as_of=earlier)["valid"]
    before = research.evaluate({"TEST": research.indicators(missing)}, earlier)
    assert before == research.evaluate({"TEST": research.indicators(original)}, earlier)
    latest = research.evaluate({"TEST": research.indicators(missing)}, original.iloc[-1].date)
    assert all(signal["status"] == "data_error" for signal in latest[0]["signals"])
    with patch.object(store, "history", return_value=missing), pytest.raises(ValueError, match="缺少交易日"):
        research.backtest("TEST", "turtle")
    with patch.object(store, "history", return_value=missing):
        assert research.backtest("TEST", "turtle", end_date=earlier)["end"] == earlier


def test_session_quality_never_flags_prelisting_dates_and_can_opt_out():
    short = bars().iloc[230:].copy()
    assert market.history_quality(short)["valid"]
    missing = short.drop(index=235)
    assert market.history_quality(missing, check_sessions=False)["valid"]
    assert not market.history_quality(missing)["valid"]
