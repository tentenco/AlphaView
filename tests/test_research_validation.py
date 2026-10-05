"""Validation gate on synthetic bars: folds, bootstrap and Sharpe tests are deterministic and never pass when a test is missing."""
import json
import math

import numpy as np
import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import research_desk as rd, research_validation as rv, sessions, store
from tests.test_research_desk import insert_bars, wave

AS_OF = "2024-12-31"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "validation.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network request"))
    store.init_db()
    app = FastAPI()
    app.include_router(rd.router)
    app.include_router(rv.router)
    with TestClient(app) as value:
        yield value


def validate(client, **changes):
    body = {"symbol": "SYNTA", "config": {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}, **changes}
    response = client.post("/api/research-desk/validate", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_validation_is_deterministic_read_only_and_consistent_with_the_desk(client):
    insert_bars("SYNTA", wave(480, period=30))
    revision = store.input_revision()
    result = validate(client)
    json.dumps(result, allow_nan=False)
    assert result["engine_version"] == "alphaview-validation-v1" and result["desk_engine_version"] == rd.ENGINE_VERSION
    diagnosis = client.post("/api/research-desk/diagnose", json={"symbol": "SYNTA", "config": result["config"]}).json()
    assert result["summary"]["return_pct"] == diagnosis["summary"]["return_pct"]
    assert result["summary"]["closed_trades"] == diagnosis["summary"]["closed_trades"]
    walk = result["walk_forward"]
    assert walk["available"] and len(walk["folds"]) == 4
    assert sum(fold["sessions"] for fold in walk["folds"]) == result["window"]["sessions"]
    assert walk["folds"][0]["start"] == result["window"]["start"] and walk["folds"][-1]["end"] == result["window"]["end"]
    assert walk["consistency"] == pytest.approx(walk["positive_folds"] / walk["traded_folds"])
    boot = result["bootstrap"]
    assert boot["available"] and boot["seed"] == rv.BOOTSTRAP_SEED and boot["ci95_lower_pct"] <= boot["mean_trade_return_pct"] <= boot["ci95_upper_pct"]
    assert validate(client)["bootstrap"] == boot
    sharpe = result["sharpe"]
    assert sharpe["available"] and sharpe["kind"] == "probabilistic" and 0 <= sharpe["probability"] <= 1
    assert sharpe["sharpe_annualized"] == pytest.approx(sharpe["sharpe_daily"] * math.sqrt(252), rel=1e-3)
    assert result["verdict"]["status"] in ("pass", "warn", "fail") and result["verdict"]["rule"]
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM research_desk_runs").fetchone()[0] == 0


def test_more_trials_deflate_the_sharpe_probability(client):
    insert_bars("SYNTA", wave(480, period=30))
    assert validate(client, trials=50)["sharpe"]["kind"] == "deflated"
    noise = np.random.default_rng(1).standard_normal(250)
    run = {"initial": 100.0, "values": list(100 * np.cumprod(1 + 0.0005 + 0.01 * noise))}
    single, many = rv._sharpe_test(run, 1), rv._sharpe_test(run, 50)
    assert single["benchmark_sharpe_daily"] == 0 and many["benchmark_sharpe_daily"] > 0
    assert 0 < many["probability"] < single["probability"] < 1
    assert single["sharpe_daily"] == many["sharpe_daily"]


def test_missing_tests_can_only_warn_and_short_history_is_reported(client):
    insert_bars("SYNTA", wave(75))
    result = validate(client, folds=8)
    assert not result["walk_forward"]["available"] and result["walk_forward"]["reason"] == "insufficient_history"
    assert result["verdict"]["status"] != "pass"
    assert any("walk_forward" in reason for reason in result["verdict"]["reasons"])
    json.dumps(result, allow_nan=False)


def test_verdict_rules_on_hand_built_blocks():
    walk = {"available": True, "consistency": 1.0}
    boot = {"available": True, "ci95_lower_pct": 0.5, "ci95_upper_pct": 2.0}
    sharpe = {"available": True, "probability": 0.99}
    assert rv._verdict(walk, boot, sharpe)["status"] == "pass"
    assert rv._verdict({"available": True, "consistency": 0.4}, boot, sharpe)["status"] == "fail"
    assert rv._verdict(walk, {"available": True, "ci95_lower_pct": -1.0, "ci95_upper_pct": -0.1}, sharpe)["status"] == "fail"
    assert rv._verdict(walk, boot, {"available": True, "probability": 0.2})["status"] == "fail"
    warn = rv._verdict(walk, {"available": False, "reason": "insufficient_trades"}, sharpe)
    assert warn["status"] == "warn" and warn["reasons"] == ["bootstrap 不可用：insufficient_trades"]
    assert rv._verdict(walk, {"available": True, "ci95_lower_pct": -0.2, "ci95_upper_pct": 1.0}, sharpe)["status"] == "warn"


def test_bootstrap_and_sharpe_blocks_refuse_small_or_flat_samples():
    assert rv._bootstrap([{"return_pct": 1.0}] * 9) == {"available": False, "reason": "insufficient_trades", "closed_trades": 9,
                                                        "required": 10, "samples": 2000, "seed": rv.BOOTSTRAP_SEED}
    flat = {"initial": 100.0, "values": [100.0] * 40}
    assert rv._sharpe_test(flat, 1)["reason"] == "zero_volatility"
    short = {"initial": 100.0, "values": list(np.linspace(100, 110, 20))}
    assert rv._sharpe_test(short, 1)["reason"] == "insufficient_sessions"
    json.dumps(rv._sharpe_test({"initial": 100.0, "values": list(100 * np.cumprod(1 + 0.01 * np.sin(np.arange(60))))}, 3), allow_nan=False)


@pytest.mark.parametrize("body", [{"folds": 1}, {"folds": 9}, {"trials": 0}, {"trials": 501}, {"unknown": 1},
                                  {"test_start": "2024-06-01", "test_end": "2024-01-01"}])
def test_request_bounds_are_strict(client, body):
    insert_bars("SYNTA", wave(100))
    response = client.post("/api/research-desk/validate", json={"symbol": "SYNTA", "config": {"strategy": "buy_hold"}, **body})
    assert response.status_code == 422, response.text


def test_batch_validates_each_symbol_independently_and_summarises(client):
    insert_bars("SYNTA", wave(480, period=30))
    insert_bars("SYNTB", wave(25))
    revision = store.input_revision()
    response = client.post("/api/research-desk/validate-batch", json={"symbols": ["SYNTA", "SYNTB"],
                           "config": {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}, "trials": 3})
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    by_symbol = {item["symbol"]: item for item in result["items"]}
    assert by_symbol["SYNTA"]["status"] == "evaluated" and by_symbol["SYNTA"]["verdict"] in ("pass", "warn", "fail")
    assert by_symbol["SYNTB"]["status"] == "unavailable" and by_symbol["SYNTB"]["code"] == "insufficient_history"
    assert result["counts"]["unavailable"] == 1 and sum(result["counts"].values()) == 2
    assert result["overall"] == by_symbol["SYNTA"]["verdict"] and result["trials"] == 3
    single = client.post("/api/research-desk/validate", json={"symbol": "SYNTA", "config": result["config"], "trials": 3}).json()
    assert by_symbol["SYNTA"]["reasons"] == single["verdict"]["reasons"]
    assert store.input_revision() == revision
    for body in ({"symbols": ["SYNTA", "SYNTA"]}, {"symbols": []}, {"symbols": ["bad symbol"]}, {"symbols": ["SYNTA"], "symbol": "SYNTA", "extra": 1}):
        assert client.post("/api/research-desk/validate-batch", json={"config": {"strategy": "buy_hold"}, **body}).status_code == 422
