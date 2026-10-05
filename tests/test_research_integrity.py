"""Prefix diagnostics on synthetic local history, including deliberately injected future leaks."""
import json
import sqlite3

import numpy as np
import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import research_desk as desk, research_integrity as integrity, sessions, store
from tests.test_research_desk import insert_bars, wave

AS_OF = "2024-12-31"
CONFIG = {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "integrity.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network request"))
    store.init_db()
    app = FastAPI()
    app.include_router(integrity.router)
    with TestClient(app) as value:
        yield value


def inspect(client, **changes):
    response = client.post("/api/research-desk/integrity", json={"symbol": "SYNTA", "config": CONFIG, **changes})
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


@pytest.mark.parametrize("strategy", list(desk.STRATEGIES))
def test_existing_desk_strategies_are_prefix_stable_on_sampled_history(client, strategy):
    days = insert_bars("SYNTA", wave(470, period=37))
    result = inspect(client, config={"strategy": strategy})
    assert result["status"] == "no_difference_detected", result
    assert result["engine_version"] == "alphaview-research-integrity-v1" and result["desk_engine_version"] == desk.ENGINE_VERSION
    assert len(result["prefixes"]) == 6 and result["counts"]["prefixes"] == 6
    assert result["window"]["end"] == days[-1] and result["prefixes"][-1]["cutoff_date"] == days[-2]
    assert all(row["compared_sessions"] >= 20 and row["status"] == "no_difference_detected" for row in result["prefixes"])
    assert result["counts"]["differences"] == 0 and result["counts"]["unavailable_values"] == 0
    assert result["fingerprint"] == desk.Series("SYNTA", AS_OF).fingerprint
    assert set(("entry", "exit", "valid", "close")).issubset(result["fields"])


def test_request_is_deterministic_query_only_and_honors_completed_session_bounds(client, monkeypatch):
    days = insert_bars("SYNTA", wave(490))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: days[300])
    original = desk.signals
    builds = []

    def observed(series, config):
        builds.append(series.dates[-1])
        with store.connect() as db:
            assert db.execute("PRAGMA query_only").fetchone()[0] == 1
            with pytest.raises(sqlite3.OperationalError):
                db.execute("DELETE FROM bars")
        return original(series, config)

    monkeypatch.setattr(desk, "signals", observed)
    revision = store.input_revision()
    first = inspect(client, test_start=days[80], test_end=days[400], max_prefixes=3)
    assert first["effective_end"] == days[300] and first["window"]["end"] == days[300]
    assert first["window"]["start"] == days[80] and len(builds) == 4
    assert all(day <= days[300] for day in builds)
    assert inspect(client, test_start=days[80], test_end=days[400], max_prefixes=3) == first
    assert first["input_revision"] == store.input_revision() == revision
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM research_desk_runs").fetchone()[0] == 0


def test_future_dependent_signal_changes_are_reported_with_exact_dates_and_values(client, monkeypatch):
    insert_bars("SYNTA", wave(150, period=23))
    original = desk.signals

    def leaked(series, config):
        _, exit_, valid = original(series, config)
        return valid & (series.close < series.close[-1]), exit_, valid

    monkeypatch.setattr(desk, "signals", leaked)
    result = inspect(client)
    assert result["status"] == "differences_found" and result["counts"]["differences"] > 0
    assert {row["field"] for row in result["differences"]} == {"entry"}
    for difference in result["differences"]:
        full = desk.Series("SYNTA", AS_OF)
        prefix = desk.Series("SYNTA", difference["prefix_end"])
        index = full.dates.index(difference["date"])
        assert difference["before"] == bool(leaked(full, CONFIG)[0][index])
        assert difference["after"] == bool(leaked(prefix, CONFIG)[0][index])
        assert difference["before"] != difference["after"]


def test_indicator_only_future_leak_is_detected_and_detail_size_is_bounded(client, monkeypatch):
    insert_bars("SYNTA", wave(200, period=29))
    original = desk.Series.sma

    def future_offset(series, period):
        return original(series, period) + series.close[-1] / 1000

    monkeypatch.setattr(desk.Series, "sma", future_offset)
    result = inspect(client)
    assert result["status"] == "differences_found"
    assert result["counts"]["differences"] > integrity.MAX_DETAILS
    assert len(result["differences"]) == integrity.MAX_DETAILS and result["differences_truncated"]
    assert {row["field"] for row in result["differences"]} <= {"sma_fast", "sma_slow"}
    assert all(isinstance(row["before"], float) and row["before"] != row["after"] for row in result["differences"])


def test_nonfinite_eligible_indicators_remain_unavailable_and_never_pass(client, monkeypatch):
    insert_bars("SYNTA", wave(150))
    original = desk.Series.sma

    def missing(series, period):
        values = original(series, period).copy()
        if len(values) > 50:
            values[50] = np.nan
        return values

    monkeypatch.setattr(desk.Series, "sma", missing)
    result = inspect(client)
    assert result["status"] == "unavailable" and result["counts"]["differences"] == 0
    assert result["counts"]["unavailable_values"] > 0 and result["counts"]["invalid_signal_sessions"] > 0
    assert result["unavailable_values"][0]["before"] is None
    assert result["unavailable_values"][0]["code"] == "nonfinite_output"


@pytest.mark.parametrize("bars", [0, 20, 25])
def test_missing_or_short_history_cannot_pass(client, bars):
    if bars:
        insert_bars("SYNTA", wave(bars))
    result = inspect(client)
    assert result["status"] == "unavailable" and result["counts"]["prefixes"] == 0
    assert result["unavailable"][0]["code"] in ("no_history", "insufficient_history")


def test_history_cost_limit_is_checked_before_indicator_work(client, monkeypatch):
    insert_bars("SYNTA", wave(31))
    monkeypatch.setattr(integrity, "MAX_HISTORY_BARS", 30)
    monkeypatch.setattr(desk, "Series", lambda *args: pytest.fail("History bound must precede Series work"))
    result = inspect(client)
    assert result["status"] == "unavailable" and result["unavailable"][0]["code"] == "history_limit"


@pytest.mark.parametrize("changes", [
    {"symbol": ""}, {"symbol": "bad symbol"}, {"max_prefixes": 0}, {"max_prefixes": 7},
    {"max_prefixes": True}, {"max_prefixes": "3"}, {"unexpected": 1}, {"test_end": "2024-02-30"},
    {"test_start": "2024-12-31", "test_end": "2024-01-02"},
    {"config": {"strategy": "sma_cross", "params": {"fast": "nan"}}},
    {"config": {"strategy": "buy_hold", "unexpected": 1}},
])
def test_input_is_strict_bounded_and_forbids_extra_fields(client, changes):
    response = client.post("/api/research-desk/integrity", json={"symbol": "SYNTA", "config": CONFIG, **changes})
    assert response.status_code == 422, response.text


def test_nonfinite_parameters_are_rejected_before_calculation():
    with pytest.raises(ValueError):
        integrity.IntegrityInput(symbol="SYNTA", config={"strategy": "bollinger_reversion", "params": {"std_mult": float("nan")}})
