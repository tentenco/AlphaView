"""Reduce-only automation on a paused synthetic account: targets may only shrink, never grow; authority still comes first."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent, reduce_only
from alphaview.panel import scan_provenance, sessions, store

DAY1, DAY2 = "2024-01-04", "2024-01-05"
SYMBOLS = ["SYNTA", "SYNTB"]


def seed(day):
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT OR IGNORE INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, day))
            db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        rows = [{"symbol": symbol, "date": day, "bars": 240, "indicators": {"close": 100},
                 "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch", "matched": index < 2, "reason": "Synthetic"}
                             for index, strategy in enumerate(agent.STRATEGY_IDS)]} for symbol in SYMBOLS]
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (day, json.dumps(SYMBOLS), json.dumps(rows), scan_provenance.current_token(db)))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation-reduce-only.db"))
    clock = {"session": DAY1}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    seed(DAY1)
    app = FastAPI()
    for module in (automation, paper, breakers):
        app.include_router(module.router)
    with TestClient(app) as client:
        yield client, clock


def account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000, "idempotency_key": "reduce-only-account"})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def current(client, acct):
    return client.get(f"/api/paper/accounts/{acct['id']}").json()["account"]


def buy(client, acct, targets, key):
    created = client.post(f"/api/paper/accounts/{acct['id']}/proposals",
                          json={"expected_version": acct["version"], "targets": targets, "idempotency_key": f"reduce-only-{key}"})
    assert created.status_code == 200, created.text
    proposal = created.json()
    assert proposal["status"] == "proposed", proposal
    response = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": f"reduce-only-{key}-accept"})
    assert response.status_code == 200, response.text
    return response.json()["account"]["account"]


def pause(client, acct):
    response = client.patch(f"/api/paper/accounts/{acct['id']}/controls", json={"expected_version": acct["version"], "kill_switch": True})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def allow_reduce_only(client, acct):
    response = client.put(f"/api/paper/accounts/{acct['id']}/circuit-breakers", json={"policy": {"reduce_only_allowed": True}, "expected_version": 1})
    assert response.status_code == 200, response.text


def mandate(client, acct, symbols, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic mandate", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": symbols},
        "enabled": True, "mode": "auto_simulate", **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": True}).json()


def holdings(client, acct):
    return {row["symbol"]: row["shares"] for row in client.get(f"/api/paper/accounts/{acct['id']}").json()["holdings"]}


def fills():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0]


def test_clamp_never_grows_and_drops_new_symbols():
    current = {"SYNTA": paper._decimal("30.5"), "SYNTB": paper._decimal("20")}
    result = reduce_only.clamp([{"symbol": "SYNTA", "weight_pct": 45.0}, {"symbol": "SYNTB", "weight_pct": 10.0}, {"symbol": "SYNTC", "weight_pct": 25.0}], current)
    assert result == {"targets_after": [{"symbol": "SYNTA", "weight_pct": 30.5}, {"symbol": "SYNTB", "weight_pct": 10.0}],
                      "dropped_symbols": ["SYNTC"], "changed": True}
    unchanged = reduce_only.clamp([{"symbol": "SYNTA", "weight_pct": 45.0}, {"symbol": "SYNTB", "weight_pct": 20.0}], current)
    assert unchanged["changed"] is False and unchanged["targets_after"] == [{"symbol": "SYNTA", "weight_pct": 30.5}, {"symbol": "SYNTB", "weight_pct": 20.0}]
    sold = reduce_only.clamp([{"symbol": "SYNTB", "weight_pct": 20.0}], current)
    assert sold["changed"] is True and sold["targets_after"] == [{"symbol": "SYNTB", "weight_pct": 20.0}]


def test_paused_account_without_the_flag_is_still_not_ready(setup):
    client, _ = setup
    acct = buy(client, account(client), [{"symbol": "SYNTA", "weight_pct": 30}], "open")
    acct = pause(client, acct)
    item = mandate(client, acct, ["SYNTB"])
    result = run(client, item)
    assert result["status"] == "paused" and "attempt" not in result
    assert fills() == 1 and holdings(client, acct) == {"SYNTA": 30}


def test_paused_account_with_the_flag_runs_a_reducing_proposal_and_simulates_it(setup):
    client, _ = setup
    acct = account(client)
    acct = buy(client, acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}], "open")
    allow_reduce_only(client, acct)
    acct = pause(client, acct)
    item = mandate(client, acct, ["SYNTB"])
    assert item["lifecycle"] == "active"
    before = store.input_revision()
    result = run(client, item)
    assert result["status"] == "simulated", result
    attempt = result["attempt"]
    evidence = attempt["result"]["reduce_only"]
    assert evidence["engine_version"] == "alphaview-reduce-only-v1" and evidence["status"] == "reduced" and evidence["reason"] == "kill_switch"
    assert {row["symbol"] for row in evidence["targets_before"]} == {"SYNTB"}
    assert evidence["gated_targets"] == evidence["targets_before"]
    assert [row["symbol"] for row in evidence["targets_after"]] == ["SYNTB"]
    assert evidence["targets_after"][0]["weight_pct"] <= float(evidence["current_weights"]["SYNTB"])
    assert "純減倉模式" in attempt["reason"]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["risk_direction"] == "reducing" and proposal["status"] == "simulated"
    after = holdings(client, acct)
    assert "SYNTA" not in after and after["SYNTB"] <= 20
    assert current(client, acct)["kill_switch"] is True
    assert store.input_revision() == before
    json.dumps(result, allow_nan=False)


def test_nothing_to_reduce_is_a_recorded_skip_without_a_proposal(setup):
    client, _ = setup
    acct = buy(client, account(client), [{"symbol": "SYNTA", "weight_pct": 10}], "open")
    allow_reduce_only(client, acct)
    acct = pause(client, acct)
    item = mandate(client, acct, SYMBOLS)
    result = run(client, item)
    assert result["status"] == "skipped" and result["attempt"]["reason_code"] == "reduce_only_no_change"
    evidence = result["attempt"]["result"]["reduce_only"]
    assert evidence["status"] == "no_change" and evidence["dropped_symbols"] == ["SYNTB"]
    assert result["attempt"]["paper_proposal_id"] is None
    assert fills() == 1 and holdings(client, acct) == {"SYNTA": 10}
    assert run(client, item)["status"] == "already_attempted"


def test_expired_mandate_still_refuses_before_any_reduction(setup):
    client, clock = setup
    acct = buy(client, account(client), [{"symbol": "SYNTA", "weight_pct": 30}], "open")
    allow_reduce_only(client, acct)
    acct = pause(client, acct)
    item = mandate(client, acct, ["SYNTB"], expires_on=DAY1)
    clock["session"] = DAY2
    seed(DAY2)
    result = run(client, item)
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "mandate_expired"
    assert "reduce_only" not in (result["attempt"]["result"] or {})
    assert fills() == 1 and holdings(client, acct) == {"SYNTA": 30}


def test_bound_proposal_cannot_carry_more_than_the_clamped_targets(setup):
    client, _ = setup
    acct = buy(client, account(client), [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}], "open")
    allow_reduce_only(client, acct)
    acct = pause(client, acct)
    item = mandate(client, acct, ["SYNTB"], mode="proposal_only")
    result = run(client, item)
    assert result["status"] == "proposed", result
    attempt = result["attempt"]
    body = {"expected_version": acct["version"], "targets": [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}],
            "idempotency_key": "reduce-only-bypass", "automation_source": {
                "mandate_id": item["id"], "mandate_version": item["version"], "attempt_id": attempt["id"]}}
    response = client.post(f"/api/paper/accounts/{acct['id']}/proposals", json=body)
    assert response.status_code == 409
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "reduce-only-manual-accept"})
    assert accepted.status_code == 200, accepted.text
    assert "SYNTA" not in holdings(client, acct)
