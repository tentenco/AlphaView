"""Synthetic adapter evidence only: no Yahoo connection or real account reads."""
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import corporate_action_evidence as evidence
from alphaview.panel import corporate_actions, market, sessions, store

DAYS = sessions.expected_sessions("2026-09-01", "2026-09-04")


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic-evidence.db"))
    monkeypatch.setattr(market, "latest_completed_session", lambda: DAYS[-1])
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: DAYS[-1])
    store.init_db()
    # Explicit until root adds the migration hook; remains idempotent afterward.
    with store.connect() as db:
        evidence.init_schema(db)


def frame(dividend=2.0, split=0.0, days=DAYS):
    rows = len(days)
    return pd.DataFrame({"Open": [100.] * rows, "High": [101.] * rows, "Low": [99.] * rows,
        "Close": [100.] * rows, "Adj Close": [98.] * (rows - 1) + [100.], "Volume": [1000.] * rows,
        "Dividends": [0.] * (rows - 1) + [dividend], "Stock Splits": [0.] * (rows - 1) + [split]}, index=pd.to_datetime(days))


def ticker(data, history=None):
    return SimpleNamespace(history=history or (lambda **kwargs: data.copy()),
                           get_history_metadata=lambda: {"currency": "USD", "longName": "Synthetic", "exchangeName": "NMS"})


def fetch(data, symbol="SYNTA"):
    with patch("yfinance.Ticker", return_value=ticker(data)):
        return market.fetch_symbol(symbol)


def read(symbol="SYNTA"):
    with store.read_snapshot(), store.connect() as db:
        inferred, _ = corporate_actions.detect(db, symbol)
        return evidence.summary(db, symbol, inferred, None, DAYS[-1])


def database_state():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY 1")]
                for table in ("bars", "datasets", "corporate_action_evidence", "corporate_action_coverage", "panel_revisions")}


def test_market_capture_uses_existing_one_history_call_and_keeps_factor_method_separate():
    calls = []
    def history(**kwargs):
        calls.append(kwargs)
        return frame()
    with patch("yfinance.Ticker", return_value=ticker(None, history)):
        market.fetch_symbol("SYNTA")
    assert calls == [{"period": "2y", "interval": "1d", "auto_adjust": False, "actions": True,
                      "raise_errors": True, "timeout": 20}]
    value = read()
    assert value["source_completeness"] == "unknown" and value["status"] == "available"
    assert value["coverage"]["columns"]["Dividends"] == {"present": True, "checked": 4, "zero": 3, "events": 1, "unavailable": 0}
    assert value["events"][0]["raw_value"] == "2.0" and value["events"][0]["value"] == 2.0
    assert value["adapter_version"]
    assert value["comparisons"] == [{"ex_date": DAYS[-1], "kind": "cash_dividend", "status": "same_date_and_kind",
                                      "amount_comparison": "inconclusive_adjustment_basis"}]
    app = FastAPI(); app.include_router(corporate_actions.router)
    result = TestClient(app).get("/api/corporate-actions", params={"symbols": "SYNTA"}).json()
    assert result["engine_version"] == "alphaview-corporate-actions-v1"
    assert result["provider_evidence"][0]["engine_version"] == evidence.ENGINE_VERSION
    assert abs(result["events"][0]["implied_cash_per_share"] - 2) < 1e-8
    assert value["captured_input_revision"] == store.input_revision()
    json.dumps(result, allow_nan=False)


def test_identical_event_is_idempotent_and_adding_zero_day_only_advances_capture(monkeypatch):
    fetch(frame(days=DAYS[:-1]))
    first = read()
    # Extend only zero coverage after the existing event, without another event.
    expanded = frame(); expanded["Dividends"] = [0., 0., 2., 0.]
    fetch(expanded)
    fetch(expanded)
    latest = read()
    assert latest["evidence_revision"] == first["evidence_revision"] == 1
    assert latest["capture_version"] == 3 and latest["coverage"]["rows"] == 4
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM corporate_action_evidence").fetchone()[0] == 1
        payload = json.loads(db.execute("SELECT payload_json FROM corporate_action_evidence").fetchone()[0])
    assert len(payload["events"]) == 1  # No growing daily-zero blob.


def test_changed_event_preserves_original_exact_value_and_removal_is_explicit():
    fetch(frame(dividend=1.23456789012345, split=2.0))
    with store.connect() as db:
        original = tuple(db.execute("SELECT * FROM corporate_action_evidence").fetchone())
    fetch(frame(dividend=1.98765432109876, split=0.0))
    result = read()
    assert result["evidence_revision"] == 2 and result["previous_evidence_revision"] == 1
    assert result["events"][0]["raw_value"] == "1.98765432109876"
    assert [(row["kind"], row["status"]) for row in result["changes"]] == [
        ("cash_dividend", "changed"), ("stock_split", "not_reported_in_latest_capture")]
    with store.connect() as db:
        assert tuple(db.execute("SELECT * FROM corporate_action_evidence WHERE revision=1").fetchone()) == original


@pytest.mark.parametrize("value,reason", [(None, "missing_value"), (float("nan"), "non_finite_value"),
    (float("inf"), "non_finite_value"), (-1, "negative_value"), ("2.5", "non_numeric_value"), (True, "non_numeric_value")])
def test_invalid_actions_are_unknown_not_zero_and_do_not_corrupt_valid_prices(value, reason):
    data = frame(); data["Dividends"] = pd.Series([0., 0., 0., value], index=data.index, dtype=object)
    fetch(data)
    result = read()
    assert result["status"] == "partial" and result["coverage"]["unavailable_cells"] == 1
    assert result["events"][0]["value"] is None and result["events"][0]["reason"] == reason
    assert result["comparisons"][0]["status"] == "inconclusive"
    assert len(store.history("SYNTA")) == 4
    json.dumps(result, allow_nan=False)


def test_missing_columns_and_never_captured_symbols_are_unknown():
    fetch(frame().drop(columns=["Dividends", "Stock Splits"]))
    result = read()
    assert result["events"] == [] and result["status"] == "partial"
    assert result["coverage"]["unavailable_cells"] == 8
    assert not result["coverage"]["columns"]["Dividends"]["present"]
    assert result["comparisons"][0]["status"] == "inconclusive"
    assert read("UNKNOWN")["reason"] == "not_captured"


def test_atomic_failure_after_replacing_bars_restores_every_table_and_revision():
    fetch(frame())
    before = database_state()
    with store.connect() as db:
        db.execute("CREATE TRIGGER reject_synthetic_evidence BEFORE INSERT ON corporate_action_evidence BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    changed = frame(3.0); changed["Close"] = 100.5
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        fetch(changed)
    assert database_state() == before


def test_provider_failure_keeps_evidence_and_bars_but_marks_latest_source_error():
    fetch(frame())
    with store.connect() as db:
        before = [tuple(row) for row in db.execute("SELECT * FROM corporate_action_evidence")]
    with patch("yfinance.Ticker", return_value=ticker(None, lambda **kwargs: (_ for _ in ()).throw(RuntimeError("synthetic offline")))):
        result = market.refresh(symbols=["SYNTA"])
    assert result[0]["status"] == "error"
    value = read()
    assert value["status"] == "stale" and "source_update_failed" in value["freshness_reasons"]
    with store.connect() as db:
        assert [tuple(row) for row in db.execute("SELECT * FROM corporate_action_evidence")] == before
    assert len(store.history("SYNTA")) == 4


def test_direct_bar_change_exposes_stale_evidence_without_amount_comparison():
    fetch(frame())
    with store.connect() as db:
        db.execute("UPDATE bars SET adj_close=97 WHERE symbol='SYNTA' AND date=?", (DAYS[0],))
    value = read()
    assert value["status"] == "stale" and value["freshness_reasons"] == ["bars_changed"]
    assert all(row["status"] == "inconclusive" for row in value["comparisons"])


def test_different_symbol_concurrent_commit_retries_without_refetch(monkeypatch):
    barrier = threading.Barrier(2)
    local = threading.local()
    attempts, fetches = [], []
    original = evidence._commit_snapshot
    lock = threading.Lock()
    def snapshot(symbol, identity):
        revision = original(symbol, identity)
        with lock: attempts.append(symbol)
        if not getattr(local, "waited", False):
            local.waited = True
            barrier.wait(timeout=5)
        return revision
    def make_ticker(symbol):
        with lock: fetches.append(symbol)
        return ticker(frame())
    monkeypatch.setattr(evidence, "_commit_snapshot", snapshot)
    with patch("yfinance.Ticker", side_effect=make_ticker), ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(market.fetch_symbol, ["SYNTA", "SYNTB"]))
    assert len(results) == 2 and sorted(fetches) == ["SYNTA", "SYNTB"]
    assert len(attempts) == 3  # The losing global CAS retries only its short commit snapshot.
    assert read("SYNTA")["status"] == read("SYNTB")["status"] == "available"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM bars").fetchone()[0] == 8
        assert db.execute("SELECT count(*) FROM corporate_action_coverage").fetchone()[0] == 2


def test_same_symbol_slow_response_cannot_overwrite_new_capture():
    entered, release = threading.Event(), threading.Event()
    def slow_history(**kwargs):
        entered.set()
        assert release.wait(5)
        return frame(1.0)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with patch("yfinance.Ticker", return_value=ticker(None, slow_history)):
            pending = pool.submit(market.fetch_symbol, "SYNTA")
            assert entered.wait(5)
            with patch("yfinance.Ticker", return_value=ticker(frame(3.0))):
                market.fetch_symbol("SYNTA")
            release.set()
            with pytest.raises(ValueError, match="同一標的"):
                pending.result()
    assert read()["events"][0]["value"] == 3.0 and read()["capture_version"] == 1


def test_commit_contention_is_bounded_and_never_changes_this_symbol(monkeypatch):
    fetch(frame())
    original, attempts = evidence._commit_snapshot, []
    def conflict(symbol, identity):
        revision = original(symbol, identity)
        with store.connect() as db:
            db.execute("INSERT OR REPLACE INTO datasets(symbol,status) VALUES ('OTHER','ok')")
        attempts.append(revision)
        return revision
    monkeypatch.setattr(evidence, "_commit_snapshot", conflict)
    with pytest.raises(ValueError, match="持續變更"):
        fetch(frame(4.0))
    assert len(attempts) == 3 and read()["events"][0]["value"] == 2.0


def test_rows_and_field_sizes_are_bounded_before_any_replacement():
    fetch(frame())
    before = database_state()
    data = frame(); data["Dividends"] = "x" * 257
    with pytest.raises(ValueError, match="長度"):
        fetch(data)
    assert database_state() == before
    huge = pd.DataFrame({"date": [DAYS[0]] * 801})
    with pytest.raises(ValueError, match="800"):
        evidence.prepare(huge, "synthetic")


def test_api_window_filters_both_evidence_and_comparison_without_mutating_revision():
    fetch(frame())
    revision = store.input_revision()
    app = FastAPI(); app.include_router(corporate_actions.router)
    result = TestClient(app).get("/api/corporate-actions", params={"symbols": "SYNTA", "end": DAYS[-2]}).json()
    assert result["provider_evidence"][0]["events"] == []
    assert result["provider_evidence"][0]["comparisons"] == []
    assert store.input_revision() == revision


@pytest.mark.parametrize("operation", ["refresh", "resume"])
def test_stale_publication_failure_cannot_mark_newer_valid_dataset_as_source_error(operation):
    fetch(frame())
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('SYNTA','Synthetic',0,'test','test')")
        db.execute("UPDATE datasets SET status='error',error='synthetic retry' WHERE symbol='SYNTA'")
    def old_history(**kwargs):
        fetch(frame(3.0))  # A newer successful capture commits while the old download is in flight.
        return frame(1.0)
    with patch("yfinance.Ticker", return_value=ticker(None, old_history)):
        result = market.refresh(symbols=["SYNTA"]) if operation == "refresh" else market.resume_refresh()["market"]
    assert result[0]["status"] == "error" and "同一標的" in result[0]["error"]
    value = read()
    assert value["status"] == "available" and value["events"][0]["value"] == 3.0
    assert value["capture_version"] == 2
    with store.connect() as db:
        row = db.execute("SELECT status,error FROM datasets WHERE symbol='SYNTA'").fetchone()
    assert tuple(row) == ("ok", None)
