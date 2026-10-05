"""Daily mandates with an optional Jev gate between the rules run and the paper proposal (mocked Jev)."""
import copy
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import jev_decision as jev
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store
from tests.test_jev_decision import KEY as JEV_KEY, indicators, response as jev_response

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]


def scan_row(symbol):
    return {"symbol": symbol, "name": "Synthetic", "date": AS_OF, "bars": 240, "indicators": indicators(),
            "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch", "matched": index < 2, "reason": "Synthetic"}
                        for index, strategy in enumerate(agent.STRATEGY_IDS)]}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation-jev.db"))
    monkeypatch.delenv("ALPHAVIEW_JEV_CREDENTIALS_PATH", raising=False)
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (AS_OF, json.dumps(SYMBOLS), json.dumps([scan_row(symbol) for symbol in SYMBOLS]), scan_provenance.current_token(db)))
    calls = []
    state = {"response": jev_response(), "models": {"models": [{"name": "jev-latest", "description": "Synthetic", "release_date": "2026"}]}}

    def fake_call(config, method, path, payload=None):
        calls.append((method, path, copy.deepcopy(payload)))
        value = state["response"] if path == jev.EVALUATE_PATH else state["models"]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value), 231
    monkeypatch.setattr(jev, "_call", fake_call)
    app = FastAPI()
    app.include_router(automation.router)
    app.include_router(paper.router)
    app.include_router(jev.router)
    with TestClient(app) as client:
        yield {"client": client, "calls": calls, "state": state}


def connect_jev(setup):
    result = setup["client"].post("/api/jev/connection", json={"api_key": JEV_KEY})
    assert result.status_code == 200, result.text


def account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000, "idempotency_key": "synthetic-account"})
    assert response.status_code == 200
    return response.json()["account"]


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic gated mandate", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "jev_gate": {"enabled": True, "pass_threshold": 0.7, "max_risk_probability": 0.5}, **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item, allow=False):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": allow})


def evaluate_calls(setup):
    return [call for call in setup["calls"] if call[1] == jev.EVALUATE_PATH]


def test_gate_pass_keeps_rule_targets_and_binds_evidence_to_the_proposal(setup):
    client = setup["client"]
    connect_jev(setup)
    acct = account(client)
    item = mandate(client, acct)
    assert item["jev_gate"] == {"enabled": True, "pass_threshold": 0.7, "max_risk_probability": 0.5}
    result = run(client, item)
    assert result.status_code == 200, result.text
    attempt = result.json()["attempt"]
    assert result.json()["status"] == "proposed" and len(evaluate_calls(setup)) == 1
    gate = attempt["result"]["jev_gate"]
    assert gate["status"] == "pass" and gate["counts"] == {"pass": 2, "fail": 0, "unavailable": 0}
    assert gate["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 16}, {"symbol": "SYNTB", "weight_pct": 16}]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["targets"] == gate["target_weights"] and proposal["automation_source"]["attempt_id"] == attempt["id"]
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept"})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["proposal"]["status"] == "simulated"


def test_gate_failure_zeroes_the_symbol_without_redistribution(setup):
    client = setup["client"]
    connect_jev(setup)
    setup["state"]["response"] = jev_response(**{"SYNTB:buying_pressure": {"type": "noul", "noul": 0.4}})
    acct = account(client)
    item = mandate(client, acct)
    attempt = run(client, item).json()["attempt"]
    gate = attempt["result"]["jev_gate"]
    assert gate["counts"] == {"pass": 1, "fail": 1, "unavailable": 0}
    assert gate["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 16}, {"symbol": "SYNTB", "weight_pct": 0.0}]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["targets"] == gate["target_weights"] and [order["symbol"] for order in proposal["orders"]] == ["SYNTA"]


def test_gate_blocked_or_unavailable_creates_no_proposal(setup):
    client = setup["client"]
    acct = account(client)
    item = mandate(client, acct)
    blocked = run(client, item).json()
    assert blocked["status"] == "blocked" and blocked["attempt"]["reason_code"] == "jev_gate_unavailable"
    assert blocked["attempt"]["paper_proposal_id"] is None and evaluate_calls(setup) == []
    connect_jev(setup)
    setup["state"]["response"] = jev_response(**{f"{symbol}:uptrend_intact": {"type": "noul", "noul": 0.2} for symbol in SYMBOLS})
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
        db.execute("UPDATE scans SET input_revision=?", (scan_provenance.current_token(db),))
    second = client.post("/api/agent-automation/mandates", json={
        "name": "Second gated mandate", "account_id": acct["id"],
        "workflow": {"scope": "market", "candidate_symbols": SYMBOLS}, "jev_gate": {"enabled": True}}).json()["mandate"]
    result = run(client, second).json()
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "jev_gate_blocked"
    assert result["attempt"]["result"]["jev_gate"]["counts"]["pass"] == 0 and result["attempt"]["paper_proposal_id"] is None
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0


def test_tampered_gate_evidence_invalidates_the_proposal(setup):
    client = setup["client"]
    connect_jev(setup)
    acct = account(client)
    item = mandate(client, acct)
    attempt = run(client, item).json()["attempt"]
    with store.connect() as db:
        result = json.loads(db.execute("SELECT result_json FROM agent_automation_attempts WHERE id=?", (attempt["id"],)).fetchone()[0])
        result["jev_gate"]["target_weights"][0]["weight_pct"] = 24
        db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (json.dumps(result), attempt["id"]))
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept"})
    assert accepted.status_code == 409


def test_gate_policy_is_validated_and_default_off(setup):
    client = setup["client"]
    acct = account(client)
    plain = client.post("/api/agent-automation/mandates", json={"name": "Plain", "account_id": acct["id"],
                        "workflow": {"scope": "market", "candidate_symbols": SYMBOLS}}).json()["mandate"]
    assert plain["jev_gate"]["enabled"] is False
    result = run(client, plain).json()
    assert result["status"] == "proposed" and evaluate_calls(setup) == []
    assert "jev_gate" not in (result["attempt"]["result"] or {})
    bad = client.patch(f"/api/agent-automation/mandates/{plain['id']}", json={"expected_version": plain["version"], "jev_gate": {"enabled": True, "pass_threshold": 0.2}})
    assert bad.status_code == 422
    good = client.patch(f"/api/agent-automation/mandates/{plain['id']}", json={"expected_version": plain["version"], "jev_gate": {"enabled": True, "pass_threshold": 0.8, "max_risk_probability": 0.3}})
    assert good.status_code == 200 and good.json()["mandate"]["jev_gate"]["pass_threshold"] == 0.8
    # The ungated proposal from before the policy change is invalidated by the mandate version bump.
    listed = client.get(f"/api/agent-automation/mandates/{plain['id']}/attempts").json()
    assert listed["attempts"][0]["status"] == "invalidated"
