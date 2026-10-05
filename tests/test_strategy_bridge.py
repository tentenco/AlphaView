"""Strategy → paper bridge on synthetic bars and synthetic paper accounts only."""
import json

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_portfolio as paper
from alphaview.panel import research_desk as rd
from alphaview.panel import sessions, store, strategy_bridge as bridge

START = "2023-01-03"
DAYS = sessions.expected_sessions(START, "2026-12-31")[:31]
AS_OF = DAYS[-1]
CONFIG = {"strategy": "donchian_breakout", "params": {"entry_period": 5, "exit_period": 3}}


def insert_bars(symbol, closes):
    with store.connect() as db:
        db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        for day, close in zip(DAYS, closes):
            db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", (symbol, day, close, close * 1.001, close * 0.999, close, close, 1000.0))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network request"))
    store.init_db()
    insert_bars("SYNTA", [100.0] * 30 + [120.0])   # breakout on the last close → enter
    insert_bars("SYNTB", [100.0] * 31)             # flat range → flat, or hold when held
    insert_bars("SYNTC", [100.0] * 30 + [80.0])    # breakdown on the last close → exit when held
    insert_bars("SYNTE", [100.0] * 30)             # last bar one session before AS_OF → stale
    app = FastAPI()
    app.include_router(bridge.router)
    app.include_router(paper.router)
    with TestClient(app) as value:
        yield value


def account(cash=10000):
    return paper.create_account(paper.AccountInput(name="Synthetic bridge", initial_cash=cash, idempotency_key="bridge-account"))["account"]


def hold(acct, targets, key="bridge-seed"):
    proposal = paper.create_proposal(acct["id"], paper.ProposalInput(expected_version=acct["version"], targets=targets, idempotency_key=key))
    assert proposal["status"] == "proposed", proposal["violations"]
    accepted = paper.accept_proposal(acct["id"], proposal["id"], paper.AcceptInput(expected_version=acct["version"], idempotency_key=key + "-accept"))
    return accepted["account"]["account"]


def body(acct, symbols, **changes):
    return {"account_id": acct["id"], "expected_account_version": acct["version"], "symbols": symbols, "config": CONFIG, **changes}


def proposals():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0]


def test_decisions_cover_enter_hold_exit_flat_and_unavailable_without_redistribution(client):
    acct = hold(account(), [{"symbol": "SYNTB", "weight_pct": 10}, {"symbol": "SYNTC", "weight_pct": 10}])
    revision = store.input_revision()
    before = proposals()
    response = client.post("/api/research-desk/paper-preview", json=body(acct, ["SYNTA", "SYNTB", "SYNTC", "SYNTD", "SYNTE"]))
    assert response.status_code == 200, response.text
    result = response.json()
    decisions = {row["symbol"]: row for row in result["decisions"]}
    assert result["slot_weight_pct"] == 20 and result["engine_version"] == bridge.ENGINE_VERSION and result["as_of"] == AS_OF
    assert decisions["SYNTA"]["status"] == "enter" and decisions["SYNTA"]["weight_pct"] == 20 and not decisions["SYNTA"]["held"]
    assert decisions["SYNTA"]["evidence"]["entry"] is True and decisions["SYNTA"]["evidence"]["close"] == 120
    assert decisions["SYNTA"]["evidence"]["indicators"]["upper"] == pytest.approx(100.1)
    assert decisions["SYNTB"]["status"] == "hold" and decisions["SYNTB"]["weight_pct"] == 20 and decisions["SYNTB"]["held"]
    assert decisions["SYNTC"]["status"] == "exit" and decisions["SYNTC"]["weight_pct"] == 0 and decisions["SYNTC"]["evidence"]["exit"] is True
    assert decisions["SYNTD"]["status"] == "unavailable" and decisions["SYNTD"]["reason"]["code"] == "no_history"
    assert decisions["SYNTE"]["status"] == "unavailable" and decisions["SYNTE"]["reason"]["code"] == "history_stale"
    assert all(row["weight_pct"] == 0 for row in decisions.values() if row["status"] in ("exit", "unavailable"))
    assert result["invested_weight_pct"] == 40 and result["counts"] == {"enter": 1, "hold": 1, "exit": 1, "flat": 0, "unavailable": 2}
    assert result["target_weights"] == [{"symbol": s, "weight_pct": w} for s, w in (("SYNTA", 20), ("SYNTB", 20), ("SYNTC", 0), ("SYNTD", 0), ("SYNTE", 0))]
    preview = result["paper_preview"]
    assert preview["executable"] and preview["violations"] == []
    assert {(order["symbol"], order["side"]) for order in preview["orders"]} == {("SYNTA", "buy"), ("SYNTB", "buy"), ("SYNTC", "sell")}
    assert bridge.ENGINE_VERSION in preview["rationale"] and "donchian_breakout" in preview["rationale"]
    assert store.input_revision() == revision and proposals() == before and json.dumps(result, allow_nan=False)


def test_flat_when_unheld_without_signal_and_slot_respects_max_weight(client):
    acct = account()
    result = client.post("/api/research-desk/paper-preview", json=body(acct, ["SYNTA", "SYNTB", "SYNTC"], max_weight_pct=50)).json()
    decisions = {row["symbol"]: row for row in result["decisions"]}
    assert result["slot_weight_pct"] == 33.33333333
    assert decisions["SYNTB"]["status"] == "flat" and decisions["SYNTB"]["reason"]["code"] == "no_entry_signal"
    assert decisions["SYNTC"]["status"] == "flat" and decisions["SYNTC"]["weight_pct"] == 0
    assert decisions["SYNTA"]["weight_pct"] == 33.33333333 and result["invested_weight_pct"] == 33.33333333
    capped = client.post("/api/research-desk/paper-preview", json=body(acct, ["SYNTA"], max_weight_pct=15)).json()
    assert capped["slot_weight_pct"] == 15 and capped["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 15}]
    assert bridge.slot_weight(7, 100) == 14.28571428


def test_warmup_gap_is_flat_not_an_entry(client):
    acct = account()
    result = client.post("/api/research-desk/paper-preview", json={**body(acct, ["SYNTA"]),
                         "config": {"strategy": "sma_cross", "params": {"fast": 20, "slow": 50}}}).json()
    row = result["decisions"][0]
    assert row["status"] == "flat" and row["reason"]["code"] == "signal_not_defined" and row["evidence"]["valid"] is False
    assert result["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 0}]


def test_proposal_is_saved_with_rationale_and_replays_by_idempotency_key(client):
    acct = account()
    before = proposals()
    payload = {**body(acct, ["SYNTA", "SYNTB"]), "idempotency_key": "bridge-proposal-01"}
    response = client.post("/api/research-desk/paper-proposal", json=payload)
    assert response.status_code == 201, response.text
    proposal = response.json()["paper_proposal"]
    assert proposal["status"] == "proposed" and proposals() == before + 1
    assert bridge.ENGINE_VERSION in proposal["rationale"] and f"訊號日 {AS_OF}" in proposal["rationale"]
    assert proposal["targets"] == [{"symbol": "SYNTA", "weight_pct": 20}, {"symbol": "SYNTB", "weight_pct": 0}]
    assert [order["symbol"] for order in proposal["orders"]] == ["SYNTA"]
    replay = client.post("/api/research-desk/paper-proposal", json=payload)
    assert replay.status_code == 201 and replay.json()["paper_proposal"]["id"] == proposal["id"] and proposals() == before + 1
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
    stale = client.post("/api/research-desk/paper-proposal", json={**payload, "idempotency_key": "bridge-proposal-02",
                                                                   "expected_account_version": acct["version"] + 5})
    assert stale.status_code == 409 and proposals() == before + 1


@pytest.mark.parametrize("change", [
    {"config": {"strategy": "sma_cross", "params": {"fast": 50, "slow": 20}}},
    {"config": {"strategy": "unknown"}},
    {"symbols": ["synta"]}, {"symbols": ["SYNTA", "SYNTA"]}, {"symbols": []},
    {"symbols": [f"S{i}" for i in range(11)]}, {"max_weight_pct": 0}, {"expected_account_version": "1"}, {"extra": True},
])
def test_invalid_requests_are_rejected_before_any_paper_work(client, change):
    acct = account()
    before = proposals()
    response = client.post("/api/research-desk/paper-preview", json={**body(acct, ["SYNTA"]), **change})
    assert response.status_code == 422, response.text
    assert proposals() == before
    assert client.post("/api/research-desk/paper-preview", json=body({"id": "missing", "version": 1}, ["SYNTA"])).status_code == 404


def test_paper_limits_surface_as_violations_not_bridge_errors(client):
    acct = account()
    paused = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=acct["version"], kill_switch=True))["account"]
    result = client.post("/api/research-desk/paper-preview", json=body(paused, ["SYNTA"])).json()
    assert result["decisions"][0]["status"] == "enter"
    assert not result["paper_preview"]["executable"]
    assert "kill_switch" in {row["code"] for row in result["paper_preview"]["violations"]}
