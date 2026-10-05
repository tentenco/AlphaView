"""Outcome-ledger flags remain visible when v3 downgrades automated actions to review."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import decision_ledger, paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store

DAY1 = "2024-01-04"
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


def decisions(count=20, *, rising):
    """Settled rule-workflow target decisions before DAY1 (10-session horizon): all hits when rising, all misses otherwise."""
    history = sessions.expected_sessions("2023-10-01", DAY1)[-(count + 12):-1]
    with store.connect() as db:
        for index, day in enumerate(history):
            price = 100 + index if rising else 200 - index
            db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTA',?,?,?,?,?,?,1000)", (day, price, price + 1, price - 1, price, price))
        for index, day in enumerate(history[:count]):
            result = {"request": {"scope": "market"}, "target_weights": [{"symbol": "SYNTA", "weight_pct": index + 1}]}
            db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)",
                       (f"run-{index}", "synthetic", "alphaview-agent-workflow-v1", day, "synthetic", "proposed", "{}", json.dumps(result)))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation-outcome-warning.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: DAY1)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    app = FastAPI()
    for module in (automation, paper, breakers):
        app.include_router(module.router)
    with TestClient(app) as client:
        yield client


def account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000, "idempotency_key": "outcome-account"})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic mandate", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "enabled": True, "mode": "auto_simulate", **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": True}).json()


def test_low_hit_rate_downgrades_the_attempt_and_preserves_the_proposal_for_review(setup):
    client = setup
    # Bars are written before the scan so the scan token stays current for the workflow.
    decisions(20, rising=False)
    seed(DAY1)
    acct = account(client)
    with store.connect() as db:
        flags = decision_ledger.hit_rate_flags(db, acct["id"], DAY1)
    assert flags["low"] == ["agent_targets"] and flags["horizon_sessions"] == 10
    before = store.input_revision()
    result = run(client, mandate(client, acct))
    assert result["status"] == "proposed", result
    attempt = result["attempt"]
    warning = attempt["result"]["outcome_warning"]
    assert warning["status"] == "low" and warning["code"] == "outcome_hit_rate_low"
    flag = next(item for item in warning["flags"] if item["family"] == "agent_targets")
    assert flag == {"family": "agent_targets", "label": "規則工作流目標變動", "english": "Rule-workflow target changes",
                    "n_settled": 20, "hit_rate": 0.0, "status": "low"}
    assert next(item for item in warning["flags"] if item["family"] == "jev_gate")["status"] == "insufficient"
    assert "agent_targets 最近 20 筆已結算決策命中率 0%" in attempt["reason"] and "低於 40%" in attempt["reason"]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["status"] == "proposed" and "命中率 0%" in proposal["rationale"]
    assert attempt["mode"] == "proposal_only"
    assert attempt["result"]["outcome_guard"]["downgraded"] is True
    assert paper.account_snapshot(acct["id"])["account"]["version"] == acct["version"]
    assert store.input_revision() == before
    json.dumps(result, allow_nan=False)


def test_without_enough_settled_decisions_the_warning_is_insufficient_and_silent(setup):
    client = setup
    decisions(5, rising=False)
    seed(DAY1)
    acct = account(client)
    result = run(client, mandate(client, acct, mode="proposal_only"))
    assert result["status"] == "proposed", result
    attempt = result["attempt"]
    warning = attempt["result"]["outcome_warning"]
    assert warning["status"] == "insufficient" and warning["code"] is None
    assert all(item["status"] == "insufficient" for item in warning["flags"])
    assert "命中率" not in attempt["reason"]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert "命中率" not in proposal["rationale"]
    json.dumps(result, allow_nan=False)
