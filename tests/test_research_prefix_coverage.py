"""Synthetic dense-prefix contracts; no external data and no database writes."""
import hashlib
import json
import sqlite3

import numpy as np
import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import research_desk as desk, research_prefix_coverage as dense, sessions, store
from tests.test_research_desk import insert_bars, wave

AS_OF = "2024-12-31"
CONFIG = {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "dense-prefix.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network"))
    store.init_db()
    app = FastAPI()
    app.include_router(dense.router)
    with TestClient(app) as value:
        yield value


def request(**changes):
    return {"symbol": "SYNTA", "config": CONFIG, "test_start": "2023-01-03", "test_end": AS_OF,
            "expected_input_revision": store.input_revision(), "expected_as_of": AS_OF, **changes}


def inspect(client, **changes):
    response = client.post("/api/research-desk/prefix-coverage", json=request(**changes))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    json.dumps(result, allow_nan=False)
    fingerprint = result.pop("evidence_fingerprint")
    assert fingerprint == hashlib.sha256(desk._json(result).encode()).hexdigest()
    result["evidence_fingerprint"] = fingerprint
    return result


@pytest.mark.parametrize("strategy", list(desk.STRATEGIES))
def test_actual_strategies_rebuild_every_selected_cutoff(client, monkeypatch, strategy):
    days = insert_bars("SYNTA", wave(470, period=37))
    original = desk.Series
    builds = []

    def observed(symbol, end):
        built = original(symbol, end)
        builds.append(built)
        return built

    monkeypatch.setattr(desk, "Series", observed)
    result = inspect(client, config={"strategy": strategy}, test_start=days[-50], test_end=days[-1])
    assert result["status"] == "no_difference_detected", result
    assert result["engine_version"] == dense.ENGINE_VERSION
    assert result["coverage"]["required_cutoffs"] == 30
    assert result["coverage"]["compared_cutoffs"] == 30 and result["coverage"]["complete"]
    assert [row["cutoff_date"] for row in result["cutoff_manifest"]] == days[-31:-1]
    assert len(builds) == 31 and len({id(value) for value in builds}) == 31
    assert all(value.dates[0] == days[0] for value in builds)
    assert all(row["fingerprint"] for row in result["cutoff_manifest"])
    assert result["counts"]["compared_session_pairs"] == sum(range(20, 50))
    assert result["window"]["start"] == days[-50]


def test_recursive_rsi_is_rebuilt_from_original_seed_not_window_reset_or_full_slice(client, monkeypatch):
    days = insert_bars("SYNTA", wave(170, period=23))
    original = desk.wilder_rsi
    lengths = []

    def observed(close, period):
        lengths.append(len(close))
        return original(close, period)

    monkeypatch.setattr(desk, "wilder_rsi", observed)
    result = inspect(client, config={"strategy": "rsi_reversion"}, test_start=days[90], test_end=days[139])
    assert result["coverage"]["complete"] and "rsi" in result["fields"]
    assert lengths == [140, *range(110, 140)]


def test_exact_boundary_120_is_computed_and_121_is_unavailable_without_sampling(client, monkeypatch):
    days = insert_bars("SYNTA", wave(200))
    original = desk.Series
    calls = []

    def observed(symbol, end):
        calls.append(end)
        return original(symbol, end)

    monkeypatch.setattr(desk, "Series", observed)
    over = inspect(client, test_start=days[40], test_end=days[180])
    assert over["coverage"]["required_cutoffs"] == 121 and over["status"] == "unavailable"
    assert over["coverage"]["compared_cutoffs"] == 0 and not over["coverage"]["manifest_complete"]
    assert over["cutoff_manifest"] == [] and over["prefixes"] == [] and calls == [days[180]]
    assert over["unavailable"][0]["code"] == "cutoff_limit"
    assert over["limits"]["max_cutoffs"] == 120
    assert over["suggested_window"] == {"test_start": days[81], "test_end": days[180], "signal_sessions": 100}
    calls.clear()
    exact = inspect(client, test_start=days[41], test_end=days[180])
    assert exact["coverage"]["required_cutoffs"] == 120 and exact["coverage"]["complete"]
    assert len(calls) == 121 and len(exact["cutoff_manifest"]) == 120
    narrowed = inspect(client, **{key: over["suggested_window"][key] for key in ("test_start", "test_end")})
    assert narrowed["coverage"]["required_cutoffs"] == 80 and narrowed["coverage"]["complete"]


def test_future_dependent_signal_and_indicator_leaks_have_full_counts_bounded_details(client, monkeypatch):
    days = insert_bars("SYNTA", wave(120, period=23))
    original_signals, original_sma = desk.signals, desk.Series.sma

    def leaked(series, config):
        _, exit_, valid = original_signals(series, config)
        return valid & (series.close < series.close[-1]), exit_, valid

    monkeypatch.setattr(desk, "signals", leaked)
    monkeypatch.setattr(desk.Series, "sma", lambda series, period: original_sma(series, period) + series.close[-1] / 1000)
    result = inspect(client, test_start=days[50], test_end=days[-1])
    assert result["status"] == "differences_found"
    assert result["coverage"]["cutoff_coverage_complete"]
    assert result["counts"]["differences"] > 100
    assert len(result["differences"]) == 100 and result["differences_truncated"]
    assert "previous_sma_fast" in result["fields"] and "previous_sma_slow" in result["fields"]
    assert any(row["field"] == "entry" for row in result["differences"])
    assert all(row["before"] != row["after"] for row in result["differences"])


def test_nonfinite_dependencies_and_invalid_dates_never_become_clean_coverage(client, monkeypatch):
    days = insert_bars("SYNTA", wave(90))
    original = desk.Series.sma

    def missing(series, period):
        value = original(series, period).copy()
        if len(value) > 40:
            value[40] = np.nan
        return value

    monkeypatch.setattr(desk.Series, "sma", missing)
    result = inspect(client, test_start=days[30], test_end=days[-1])
    assert result["status"] == "unavailable" and not result["coverage"]["complete"]
    assert result["coverage"]["cutoff_coverage_complete"]
    assert result["counts"]["unavailable_values"] > 0 and result["counts"]["invalid_signal_sessions"] > 0
    assert result["unavailable_values"][0]["before"] is None


def test_failed_prefix_is_manifested_without_inventing_or_hiding_other_cutoffs(client, monkeypatch):
    days = insert_bars("SYNTA", wave(65))
    original = desk.Series

    def missing(symbol, end):
        if end == days[51]:
            raise desk.DeskError("synthetic_missing_prefix", "Synthetic prefix unavailable")
        return original(symbol, end)

    monkeypatch.setattr(desk, "Series", missing)
    result = inspect(client, test_start=days[30], test_end=days[-1])
    assert result["status"] == "unavailable"
    assert result["coverage"]["required_cutoffs"] == result["coverage"]["attempted_cutoffs"] == 15
    assert result["coverage"]["compared_cutoffs"] == 14 and result["coverage"]["failed_cutoffs"] == 1
    failed = next(row for row in result["cutoff_manifest"] if row["cutoff_date"] == days[51])
    assert failed == {"cutoff_date": days[51], "status": "unavailable", "fingerprint": None, "reason": "synthetic_missing_prefix"}


def test_snapshot_is_query_only_deterministic_and_bounds_dates_to_completed_session(client, monkeypatch):
    days = insert_bars("SYNTA", wave(180))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: days[139])
    original = desk.signals

    def readonly(series, config):
        with store.connect() as db:
            assert db.execute("PRAGMA query_only").fetchone()[0] == 1
            with pytest.raises(sqlite3.OperationalError):
                db.execute("DELETE FROM bars")
        return original(series, config)

    monkeypatch.setattr(desk, "signals", readonly)
    with store.connect() as db:
        before = list(db.iterdump())
    result = inspect(client, test_start=days[90], test_end=days[160], expected_as_of=days[139])
    assert result["effective_end"] == result["window"]["end"] == days[139]
    assert result["window"]["first_eligible_cutoff"] == days[109]
    assert result["window"]["last_eligible_cutoff"] == days[138]
    assert result == inspect(client, test_start=days[90], test_end=days[160], expected_as_of=days[139])
    with store.connect() as db:
        assert list(db.iterdump()) == before


@pytest.mark.parametrize("sessions_count,required", [(20, 0), (21, 1), (22, 2)])
def test_minimum_selected_window_boundaries(client, sessions_count, required):
    days = insert_bars("SYNTA", wave(100))
    result = inspect(client, test_start=days[-sessions_count], test_end=days[-1])
    assert result["coverage"]["required_cutoffs"] == required
    assert result["coverage"]["complete"] == (required > 0)
    assert result["status"] == ("no_difference_detected" if required else "unavailable")


def test_history_bound_precedes_any_series_work_and_missing_history_stays_unknown(client, monkeypatch):
    missing = inspect(client)
    assert missing["status"] == "unavailable" and missing["coverage"]["required_cutoffs"] is None
    insert_bars("SYNTA", wave(31))
    monkeypatch.setattr(dense, "MAX_HISTORY_BARS", 30)
    monkeypatch.setattr(desk, "Series", lambda *a: pytest.fail("No Series before history bound"))
    result = inspect(client)
    assert result["stored_history_bars"] == 31 and result["unavailable"][0]["code"] == "history_limit"
    assert result["coverage"]["required_cutoffs"] is None


@pytest.mark.parametrize("changes", [{"expected_input_revision": "stale"}, {"expected_as_of": "2024-12-30"}])
def test_stale_context_is_409_before_computation(client, monkeypatch, changes):
    monkeypatch.setattr(desk, "Series", lambda *a: pytest.fail("Stale request must not compute"))
    response = client.post("/api/research-desk/prefix-coverage", json=request(**changes))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "prefix_coverage_source_changed"


@pytest.mark.parametrize("changes", [
    {"test_start": None}, {"test_end": None}, {"test_start": ""}, {"test_end": "2024-02-30"},
    {"test_start": "2025-01-01"}, {"symbol": "bad symbol"}, {"expected_input_revision": True},
    {"expected_as_of": "2024-02-30"}, {"max_prefixes": 6}, {"unexpected": 1},
    {"config": {"strategy": "rsi_reversion", "params": {"period": True}}},
    {"config": {"strategy": "buy_hold", "unexpected": 1}},
])
def test_strict_explicit_input_and_forbidden_sampling_option(client, changes):
    response = client.post("/api/research-desk/prefix-coverage", json=request(**changes))
    assert response.status_code == 422, response.text


def test_nonfinite_parameters_rejected_before_any_read():
    with pytest.raises(ValueError):
        dense.PrefixCoverageInput(symbol="SYNTA", config={"strategy": "bollinger_reversion", "params": {"std_mult": float("inf")}},
            test_start="2023-01-03", test_end=AS_OF, expected_as_of=AS_OF, expected_input_revision="synthetic")
