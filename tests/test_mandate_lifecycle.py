"""Time-boxed mandate authorization on synthetic accounts: expiry and breaches block attempts until a human renews."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import readiness, scan_provenance, sessions, store

DAY1, DAY2, DAY3 = "2024-01-04", "2024-01-05", "2024-01-08"
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
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "mandate-lifecycle.db"))
    clock = {"session": DAY1}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    seed(DAY1)
    app = FastAPI()
    for module in (automation, paper, breakers, readiness):
        app.include_router(module.router)
    with TestClient(app) as client:
        yield client, clock


def account(client, suffix="one"):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000,
                                                       "idempotency_key": "synthetic-account-" + suffix})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic mandate", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "enabled": True, "mode": "auto_simulate", **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def get(client, item):
    return client.get(f"/api/agent-automation/mandates/{item['id']}").json()["mandate"]


def run(client, item, allow=True):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": allow})


def fills():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0]


def readiness_check(client, acct, identifier):
    result = client.get("/api/trading-agent/readiness", params={"account_id": acct["id"]}).json()
    return next(check for check in result["checks"] if check["id"] == identifier)


def test_lifecycle_view_is_pure_and_ordered():
    base = {"enabled": 1, "expires_on": None, "reauth_required": 0, "reauth_reason": None}
    assert automation.lifecycle(base, DAY1)["lifecycle"] == "active"
    assert automation.lifecycle({**base, "enabled": 0}, DAY1)["lifecycle"] == "inactive"
    soon = automation.lifecycle({**base, "expires_on": DAY3}, DAY1)
    assert soon["lifecycle"] == "expiring_soon" and soon["sessions_remaining"] == 2 and soon["blocked_code"] is None
    expired = automation.lifecycle({**base, "expires_on": DAY1, "enabled": 0}, DAY2)
    assert expired["lifecycle"] == "expired" and expired["sessions_remaining"] == 0 and expired["blocked_code"] == "mandate_expired"
    reauth = automation.lifecycle({**base, "reauth_required": 1, "reauth_reason": "kill_switch_enabled"}, DAY1)
    assert reauth["lifecycle"] == "reauth_required" and reauth["blocked_code"] == "mandate_reauth_required"
    assert "kill_switch_enabled" in reauth["message"]
    far = automation.lifecycle({**base, "expires_on": "2024-03-01"}, DAY1)
    assert far["lifecycle"] == "active" and far["sessions_remaining"] > automation.EXPIRING_SOON_SESSIONS
    json.dumps(far, allow_nan=False)


def test_expiry_is_validated_against_the_session_calendar(setup):
    client, _ = setup
    acct = account(client)
    for value, fragment in (("2024-01-03", "不可早於"), ("2024-01-06", "交易日"), ("2024-13-01", None), ("2025-01-06", "180"), ("20240105", None)):
        response = client.post("/api/agent-automation/mandates", json={
            "name": "Bounded", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS}, "expires_on": value})
        assert response.status_code == 422, (value, response.text)
        if fragment:
            assert fragment in response.text
    item = mandate(client, acct, expires_on=DAY2)
    assert item["expires_on"] == DAY2 and item["lifecycle"] == "expiring_soon" and item["sessions_remaining"] == 1
    assert item["lifecycle_message"] and item["reauth_required"] is False and item["lifecycle_events"] == []
    revision = store.input_revision()
    listed = client.get("/api/agent-automation/state").json()
    assert listed["mandates"][0]["lifecycle"] == "expiring_soon" and store.input_revision() == revision
    far = client.patch(f"/api/agent-automation/mandates/{item['id']}", json={"expected_version": item["version"], "expires_on": "2024-06-28"})
    assert far.status_code == 200, far.text
    assert far.json()["mandate"]["lifecycle"] == "active" and far.json()["mandate"]["version"] == item["version"] + 1
    bad = client.patch(f"/api/agent-automation/mandates/{item['id']}", json={"expected_version": item["version"] + 1, "expires_on": "2024-01-02"})
    assert bad.status_code == 422
    json.dumps(far.json(), allow_nan=False)


def test_expired_mandate_records_a_blocked_attempt_without_touching_the_ledger(setup):
    client, clock = setup
    acct = account(client)
    item = mandate(client, acct, expires_on=DAY1)
    assert item["sessions_remaining"] == 0 and item["lifecycle"] == "expiring_soon"
    first = run(client, item)
    assert first.json()["status"] == "simulated", first.text
    before = fills()
    assert before > 0
    clock["session"] = DAY2
    seed(DAY2)
    state = get(client, item)
    assert state["lifecycle"] == "expired" and state["sessions_remaining"] == 0 and "到期" in state["reason"]
    response = run(client, state)
    assert response.json()["status"] == "blocked", response.text
    attempt = response.json()["attempt"]
    assert attempt["reason_code"] == "mandate_expired" and attempt["result"]["mandate_lifecycle"]["lifecycle"] == "expired"
    assert attempt["paper_proposal_id"] is None and fills() == before
    assert run(client, state).json()["status"] == "already_attempted"
    assert readiness_check(client, acct, "mandate_active")["reason_code"] == "expired"
    json.dumps(response.json(), allow_nan=False)


def test_breach_requires_an_acknowledged_renewal_before_automation_resumes(setup):
    client, clock = setup
    acct = account(client)
    assert client.put(f"/api/paper/accounts/{acct['id']}/circuit-breakers", json={
        "policy": {"max_fills_per_session": 1}, "expected_version": 1}).status_code == 200
    item = mandate(client, acct)
    assert run(client, item).json()["status"] == "simulated"
    assert fills() == 2
    tripped = client.post(f"/api/paper/accounts/{acct['id']}/circuit-breakers/evaluate").json()
    assert tripped["tripped"] and tripped["kill_switch"]
    state = get(client, item)
    assert state["reauth_required"] and state["lifecycle"] == "reauth_required"
    assert state["reauth_reason"] == "circuit_breaker_tripped:max_fills_per_session"
    assert state["lifecycle_events"][-1]["kind"] == "reauth_required" and state["version"] == item["version"]
    assert "重新授權" in state["lifecycle_message"]
    snapshot = client.get(f"/api/paper/accounts/{acct['id']}").json()
    resumed = client.patch(f"/api/paper/accounts/{acct['id']}/controls", json={"expected_version": snapshot["account"]["version"], "kill_switch": False})
    assert resumed.status_code == 200, resumed.text
    clock["session"] = DAY2
    seed(DAY2)
    response = run(client, get(client, item))
    assert response.json()["status"] == "blocked" and response.json()["attempt"]["reason_code"] == "mandate_reauth_required"
    assert fills() == 2
    renew_url = f"/api/paper/accounts/{acct['id']}/mandates/{item['id']}/renew"
    assert client.post(renew_url, json={"expected_version": item["version"], "acknowledge": False}).status_code == 422
    assert client.post(renew_url, json={"expected_version": item["version"] + 5, "acknowledge": True}).status_code == 409
    assert client.post(f"/api/paper/accounts/other/mandates/{item['id']}/renew", json={"expected_version": item["version"], "acknowledge": True}).status_code == 404
    assert client.post(renew_url, json={"expected_version": item["version"], "acknowledge": True, "expires_on": "2024-01-06"}).status_code == 422
    assert get(client, item)["reauth_required"]
    renewed = client.post(renew_url, json={"expected_version": item["version"], "expires_on": DAY3, "acknowledge": True})
    assert renewed.status_code == 200, renewed.text
    fresh = renewed.json()["mandate"]
    assert fresh["version"] == item["version"] + 1 and not fresh["reauth_required"] and fresh["reauth_reason"] is None
    assert fresh["lifecycle"] == "expiring_soon" and fresh["expires_on"] == DAY3 and fresh["sessions_remaining"] == 1
    assert fresh["lifecycle_events"][-1]["kind"] == "renewed"
    assert fresh["lifecycle_events"][-1]["cleared_reason"].startswith("circuit_breaker_tripped")
    assert readiness_check(client, acct, "mandate_active")["reason_code"] == "expiring_soon"
    clock["session"] = DAY3
    seed(DAY3)
    response = run(client, fresh)
    assert response.json()["attempt"]["reason_code"] not in ("mandate_expired", "mandate_reauth_required")
    json.dumps(response.json(), allow_nan=False)


def test_manual_pause_flags_reauthorization_and_readiness_reports_it(setup):
    client, _ = setup
    acct = account(client)
    item = mandate(client, acct)
    assert readiness_check(client, acct, "mandate_active")["status"] == "pass"
    paused = client.patch(f"/api/paper/accounts/{acct['id']}/controls", json={"expected_version": acct["version"], "kill_switch": True})
    assert paused.status_code == 200, paused.text
    state = get(client, item)
    assert state["reauth_required"] and state["reauth_reason"] == "kill_switch_enabled" and state["lifecycle"] == "reauth_required"
    check = readiness_check(client, acct, "mandate_active")
    assert check["status"] == "fail" and check["reason_code"] == "reauth_required"
    # Resuming the account does not restore the mandate's authority; only a renewal does.
    snapshot = client.get(f"/api/paper/accounts/{acct['id']}").json()
    assert client.patch(f"/api/paper/accounts/{acct['id']}/controls", json={"expected_version": snapshot["account"]["version"], "kill_switch": False}).status_code == 200
    assert get(client, item)["reauth_required"]
    renewed = client.post(f"/api/paper/accounts/{acct['id']}/mandates/{item['id']}/renew",
                          json={"expected_version": item["version"], "acknowledge": True})
    assert renewed.status_code == 200 and renewed.json()["mandate"]["lifecycle"] == "active"
    assert renewed.json()["mandate"]["expires_on"] is None
    assert readiness_check(client, acct, "mandate_active")["status"] == "pass"
