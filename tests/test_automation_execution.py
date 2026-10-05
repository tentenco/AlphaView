"""Automation mandates that route their proposal to Alpaca Paper through the execution layer (fake broker)."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import alpaca_paper as alpaca
from alphaview.panel import execution
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store
from tests.test_execution import FakeBroker, connect

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation-execution.db"))
    monkeypatch.delenv("ALPHAVIEW_ALPACA_CREDENTIALS_PATH", raising=False)
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        rows = [{"symbol": symbol, "date": AS_OF, "bars": 240, "indicators": {"close": 100},
                 "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch", "matched": index < 2, "reason": "Synthetic"}
                             for index, strategy in enumerate(agent.STRATEGY_IDS)]} for symbol in SYMBOLS]
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (AS_OF, json.dumps(SYMBOLS), json.dumps(rows), scan_provenance.current_token(db)))
    broker = FakeBroker()
    monkeypatch.setattr(alpaca, "_request", broker.request)
    app = FastAPI()
    app.include_router(automation.router)
    app.include_router(paper.router)
    app.include_router(execution.router)
    with TestClient(app) as client:
        yield {"client": client, "broker": broker}


def account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000, "idempotency_key": "synthetic-account"})
    assert response.status_code == 200
    return response.json()["account"]


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic Alpaca mandate", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "mode": "auto_simulate", "execution_target": "alpaca_paper", **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item, allow=True):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": allow})


def fills():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0]


def test_default_target_is_the_local_ledger_and_patch_is_validated(setup):
    client = setup["client"]
    acct = account(client)
    plain = client.post("/api/agent-automation/mandates", json={"name": "Plain", "account_id": acct["id"],
                        "workflow": {"scope": "market", "candidate_symbols": SYMBOLS}}).json()["mandate"]
    assert plain["execution_target"] == "paper_ledger"
    changed = client.patch(f"/api/agent-automation/mandates/{plain['id']}", json={"expected_version": plain["version"], "execution_target": "alpaca_paper"})
    assert changed.status_code == 200 and changed.json()["mandate"]["execution_target"] == "alpaca_paper"
    assert changed.json()["mandate"]["version"] == plain["version"] + 1
    bad = client.patch(f"/api/agent-automation/mandates/{plain['id']}", json={"expected_version": plain["version"] + 1, "execution_target": "alpaca_live"})
    assert bad.status_code == 422
    listed = client.get("/api/agent-automation/mandates").json()
    assert all("execution_target" in item for item in listed["mandates"])


def test_auto_mandate_routes_to_alpaca_paper_without_touching_the_local_ledger(setup):
    client, broker = setup["client"], setup["broker"]
    connect()
    acct = account(client)
    item = mandate(client, acct)
    response = run(client, item)
    assert response.status_code == 200, response.text
    attempt = response.json()["attempt"]
    assert response.json()["status"] == "submitted" and attempt["reason_code"] == "alpaca_paper_submitted"
    result = attempt["result"]
    assert result["execution_target"] == "alpaca_paper" and result["execution_status"] == "submitted" and result["order_count"] == 2
    assert attempt["paper_status"] == "submitted_external" and fills() == 0
    assert [call[0] for call in broker.calls] == ["POST", "POST"]
    submission = client.get(f"/api/execution/submissions/{result['execution_submission_id']}").json()
    assert submission["proposal_id"] == attempt["paper_proposal_id"] and submission["target"] == "alpaca_paper"
    assert {order["symbol"] for order in submission["orders"]} == set(SYMBOLS)
    # Same session, same mandate: nothing is sent twice.
    again = run(client, item)
    assert again.json()["status"] == "already_attempted" and len(broker.calls) == 2


def test_alpaca_target_without_enabled_orders_invalidates_the_attempt_and_sends_nothing(setup):
    client, broker = setup["client"], setup["broker"]
    connect(enabled=False)
    acct = account(client)
    item = mandate(client, acct)
    response = run(client, item)
    assert response.json()["status"] == "invalidated"
    attempt = response.json()["attempt"]
    assert attempt["reason_code"] == "execution_revalidation_failed" and "尚未啟用" in attempt["reason"]
    assert broker.calls == [] and fills() == 0
    with store.connect() as db:
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (attempt["paper_proposal_id"],)).fetchone()[0] == "proposed"
        assert db.execute("SELECT count(*) FROM execution_submissions").fetchone()[0] == 0


def test_proposal_only_mandates_ignore_the_execution_target(setup):
    client, broker = setup["client"], setup["broker"]
    connect()
    acct = account(client)
    item = mandate(client, acct, mode="proposal_only")
    response = run(client, item, allow=False)
    assert response.json()["status"] == "proposed" and broker.calls == [] and fills() == 0
