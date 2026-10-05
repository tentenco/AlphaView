"""Paper circuit breakers on synthetic accounts: captured snapshots only, never invented baselines."""
import json
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_analytics as analytics, paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store

DAY1, DAY2, DAY3 = "2024-01-05", "2024-01-08", "2024-01-09"


def _price(db, price, day, symbol="SYNTH"):
    db.execute("INSERT OR REPLACE INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)", (symbol, day))
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, price, price * 1.01, price * .99, price, price))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "breakers.db"))
    clock = {"session": DAY1}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    store.init_db()
    with store.connect() as db:
        _price(db, 100, DAY1)
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(analytics.router)
    app.include_router(breakers.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic breaker", "initial_cash": 10000,
                                                          "idempotency_key": "breaker-account"}).json()["account"]
        yield client, account, clock


def _get(client, account_id):
    response = client.get(f"/api/paper/accounts/{account_id}/circuit-breakers")
    assert response.status_code == 200, response.text
    return response.json()


def _put(client, account_id, policy, expected_version=1):
    return client.put(f"/api/paper/accounts/{account_id}/circuit-breakers", json={"policy": policy, "expected_version": expected_version})


def _propose(client, account, key, weight=30):
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={
        "expected_version": account["version"], "targets": [{"symbol": "SYNTH", "weight_pct": weight}], "idempotency_key": f"breaker-{key}"})
    assert response.status_code == 200, response.text
    return response.json()


def _accept(client, account, proposal, key):
    return client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept",
                       json={"expected_version": account["version"], "idempotency_key": f"breaker-{key}"})


def _buy(client, account, key="plan", weight=30):
    proposal = _propose(client, account, key, weight)
    response = _accept(client, account, proposal, key + "-accept")
    assert response.status_code == 200, response.text
    return response.json()["account"]["account"]


def _capture(client, account):
    response = client.post(f"/api/paper/accounts/{account['id']}/nav/capture", json={"expected_version": account["version"]})
    assert response.status_code == 200, response.text
    return response.json()


def _account(client, account_id):
    return client.get(f"/api/paper/accounts/{account_id}").json()["account"]


def _events(client, account_id):
    return client.get(f"/api/paper/accounts/{account_id}/circuit-breakers/events").json()["events"]


def _fills():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0]


def test_default_policy_is_off_and_put_is_versioned(workspace):
    client, account, _ = workspace
    revision = store.input_revision()
    status = _get(client, account["id"])
    assert status["engine_version"] == breakers.ENGINE_VERSION and status["policy_version"] == 1
    assert status["policy"] == {"daily_loss_limit_pct": None, "max_drawdown_pct": None, "max_fills_per_session": None, "auto_pause": True,
                                "reduce_only_allowed": False}
    assert [check["status"] for check in status["checks"]] == ["disabled", "disabled", "disabled"]
    assert status["tripped"] is False and status["unavailable"] == [] and status["kill_switch"] is False
    assert json.dumps(status, allow_nan=False) and store.input_revision() == revision
    assert _events(client, account["id"]) == []
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}, expected_version=2).status_code == 409
    for bad in ({"daily_loss_limit_pct": 0.05}, {"max_drawdown_pct": 95}, {"max_fills_per_session": 0}, {"unknown": 1},
                {"max_fills_per_session": 2.5}):
        assert _put(client, account["id"], bad).status_code == 422, bad
    saved = _put(client, account["id"], {"daily_loss_limit_pct": 5, "auto_pause": False})
    assert saved.status_code == 200, saved.text
    assert saved.json()["policy_version"] == 2 and saved.json()["policy"]["daily_loss_limit_pct"] == 5
    assert saved.json()["policy"]["auto_pause"] is False and saved.json()["policy"]["max_drawdown_pct"] is None
    assert [event["kind"] for event in _events(client, account["id"])] == ["policy_changed"]
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}).status_code == 409
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}, expected_version=2).json()["policy_version"] == 3
    assert store.input_revision() == revision


def test_daily_loss_trip_pauses_account_and_refuses_new_fills(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}).status_code == 200
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, 80, DAY2)
    revision = store.input_revision()
    status = _get(client, account["id"])
    daily = next(check for check in status["checks"] if check["code"] == "daily_loss")
    assert daily["status"] == "tripped" and -7 < daily["observed"] < -5 and daily["limit"] == 5
    assert daily["detail"]["reference_as_of"] == DAY1 and status["tripped"] is True
    assert status["kill_switch"] is False and _account(client, account["id"])["version"] == account["version"]  # reads never pause
    assert store.input_revision() == revision and json.dumps(status, allow_nan=False)
    account = _account(client, account["id"])
    proposal = _propose(client, account, "second", weight=20)
    fills = _fills()
    refused = _accept(client, account, proposal, "second-accept")
    assert refused.status_code == 409 and "circuit_breaker_tripped" in refused.text and "每日虧損上限" in refused.text
    paused = _account(client, account["id"])
    assert paused["kill_switch"] is True and paused["version"] == account["version"] + 1 and _fills() == fills
    kinds = [event["kind"] for event in _events(client, account["id"])]
    assert kinds[0] == "evaluated" and "tripped" in kinds and kinds.count("tripped") == 1
    tripped = next(event for event in _events(client, account["id"]) if event["kind"] == "tripped")
    assert tripped["reason_code"] == "daily_loss" and tripped["account_version_before"] == account["version"]
    assert tripped["account_version_after"] == paused["version"] and tripped["evidence"]["trigger"] == "accept"
    again = _accept(client, paused, proposal, "third-accept")
    assert again.status_code == 409 and _account(client, account["id"])["version"] == paused["version"]
    evaluated = client.post(f"/api/paper/accounts/{account['id']}/circuit-breakers/evaluate").json()
    assert evaluated["tripped"] and evaluated["already_paused"] and not evaluated["paused_now"]
    assert evaluated["kill_switch"] is True and evaluated["method"] and evaluated["input_revision"] == revision


def test_drawdown_uses_peak_captured_nav_and_manual_evaluate_pauses(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, 130, DAY2)
    _capture(client, _account(client, account["id"]))
    assert _put(client, account["id"], {"max_drawdown_pct": 3}).status_code == 200
    clock["session"] = DAY3
    with store.connect() as db:
        _price(db, 110, DAY3)
    status = _get(client, account["id"])
    drawdown = next(check for check in status["checks"] if check["code"] == "max_drawdown")
    assert drawdown["status"] == "tripped" and drawdown["detail"]["reference_as_of"] == DAY2 and drawdown["observed"] < -3
    assert next(check for check in status["checks"] if check["code"] == "daily_loss")["status"] == "disabled"
    result = client.post(f"/api/paper/accounts/{account['id']}/circuit-breakers/evaluate").json()
    assert result["paused_now"] is True and result["kill_switch"] is True
    assert _account(client, account["id"])["kill_switch"] is True
    assert [event["kind"] for event in _events(client, account["id"])][:2] == ["evaluated", "tripped"]
    assert next(event for event in _events(client, account["id"]) if event["kind"] == "tripped")["evidence"]["trigger"] == "manual"


def test_fill_cap_counts_only_the_session_and_pause_outlives_it(workspace):
    client, account, clock = workspace
    assert _put(client, account["id"], {"max_fills_per_session": 1}).status_code == 200
    account = _buy(client, account)
    status = _get(client, account["id"])
    cap = next(check for check in status["checks"] if check["code"] == "max_fills_per_session")
    assert cap["status"] == "tripped" and cap["observed"] == 1 and cap["limit"] == 1
    proposal = _propose(client, account, "more", weight=20)
    assert _accept(client, account, proposal, "more-accept").status_code == 409
    assert _account(client, account["id"])["kill_switch"] is True and _fills() == 1
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, 100, DAY2)
    later = _get(client, account["id"])
    assert next(check for check in later["checks"] if check["code"] == "max_fills_per_session")["observed"] == 0
    assert later["tripped"] is False and later["kill_switch"] is True


def test_unavailable_evidence_never_trips_or_pauses(workspace):
    client, account, clock = workspace
    assert _put(client, account["id"], {"daily_loss_limit_pct": 1, "max_drawdown_pct": 1}).status_code == 200
    status = _get(client, account["id"])
    assert [check["status"] for check in status["checks"]] == ["unavailable", "unavailable", "disabled"]
    assert status["unavailable"] == ["daily_loss", "max_drawdown"] and status["tripped"] is False
    assert {check["reason"] for check in status["checks"][:2]} == {"no_prior_nav_snapshot", "no_nav_snapshot"}
    account = _buy(client, account)
    _capture(client, account)
    clock["session"] = DAY2  # no DAY2 price: valuation incomplete
    status = _get(client, account["id"])
    assert all(check["status"] == "unavailable" and check["reason"] == "valuation_incomplete" for check in status["checks"][:2])
    assert status["checks"][0]["detail"]["missing"] == ["SYNTH"] and status["valuation_complete"] is False
    evaluated = client.post(f"/api/paper/accounts/{account['id']}/circuit-breakers/evaluate").json()
    assert evaluated["tripped"] is False and evaluated["paused_now"] is False
    assert _account(client, account["id"])["kill_switch"] is False


def test_auto_pause_off_refuses_fills_without_pausing(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5, "auto_pause": False}).status_code == 200
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, 80, DAY2)
    account = _account(client, account["id"])
    proposal = _propose(client, account, "off", weight=20)
    refused = _accept(client, account, proposal, "off-accept")
    assert refused.status_code == 409 and "auto_pause" in refused.text
    after = _account(client, account["id"])
    assert after["kill_switch"] is False and after["version"] == account["version"]
    kinds = [event["kind"] for event in _events(client, account["id"])]
    assert "tripped" not in kinds and kinds[0] == "evaluated"
    assert _events(client, account["id"])[0]["evidence"]["tripped"] is True


def test_resume_is_recorded_and_replayed_accepts_still_work(workspace):
    client, account, clock = workspace
    account = _buy(client, account, key="first")
    _capture(client, account)
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}).status_code == 200
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, 80, DAY2)
    # A replay of the finished accept returns the stored receipt instead of tripping the breaker.
    replay = client.post(f"/api/paper/accounts/{account['id']}/proposals/{_events_proposal(client, account)}/accept",
                         json={"expected_version": 1, "idempotency_key": "breaker-first-accept"})
    assert replay.status_code == 200 and replay.json()["proposal"]["status"] == "simulated"
    assert _account(client, account["id"])["kill_switch"] is False
    paused = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"], "kill_switch": True})
    assert paused.status_code == 200
    resumed = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"] + 1, "kill_switch": False})
    assert resumed.status_code == 200
    events = _events(client, account["id"])
    assert events[0]["kind"] == "resumed" and events[0]["account_version_before"] == account["version"] + 1
    assert events[0]["account_version_after"] == account["version"] + 2
    assert client.get(f"/api/paper/accounts/{account['id']}/circuit-breakers/events?limit=0").status_code == 422
    assert client.get("/api/paper/accounts/unknown/circuit-breakers").status_code == 404


def _events_proposal(client, account):
    return client.get(f"/api/paper/accounts/{account['id']}").json()["proposals"][0]["id"]


@pytest.fixture
def automation_client(tmp_path, monkeypatch):
    as_of = "2024-01-04"
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation-breakers.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: as_of)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    store.init_db()
    symbols = ["SYNTA", "SYNTB"]
    with store.connect() as db:
        for symbol in symbols:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            _price(db, 100, as_of, symbol)
        rows = [{"symbol": symbol, "date": as_of, "bars": 240, "indicators": {"close": 100},
                 "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch", "matched": index < 2, "reason": "Synthetic"}
                             for index, strategy in enumerate(agent.STRATEGY_IDS)]} for symbol in symbols]
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (as_of, json.dumps(symbols), json.dumps(rows), scan_provenance.current_token(db)))
    app = FastAPI()
    app.include_router(automation.router)
    app.include_router(paper.router)
    app.include_router(breakers.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic automation", "initial_cash": 10000,
                                                          "idempotency_key": "automation-breaker"}).json()["account"]
        mandate = client.post("/api/agent-automation/mandates", json={"name": "Synthetic mandate", "account_id": account["id"],
                              "workflow": {"scope": "market", "candidate_symbols": symbols}, "enabled": True, "mode": "auto_simulate"})
        assert mandate.status_code == 201, mandate.text
        yield client, account, mandate.json()["mandate"]


def _tripped_evaluation(account_id, as_of, auto_pause=True):
    with store.connect() as db:
        version = paper._account(db, account_id)["version"]
    check = {"code": "daily_loss", "label": "每日虧損上限", "enabled": True, "observed": -8.0, "limit": 5, "status": "tripped", "reason": None, "detail": {}}
    return {"engine_version": breakers.ENGINE_VERSION, "account_id": account_id, "account_version": version, "kill_switch": False,
            "as_of": as_of, "policy": {"daily_loss_limit_pct": 5, "max_drawdown_pct": None, "max_fills_per_session": None, "auto_pause": auto_pause},
            "policy_version": 2, "checks": [check], "tripped": True, "tripped_codes": ["daily_loss"], "unavailable": [], "valuation_complete": True}


def test_automation_run_is_blocked_and_account_paused_when_breaker_trips(automation_client, monkeypatch):
    client, account, mandate = automation_client
    monkeypatch.setattr(breakers, "evaluate", lambda db, account_id, as_of: _tripped_evaluation(account_id, as_of))
    result = automation.tick()["results"][0]
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "circuit_breaker_tripped"
    assert result["attempt"]["result"]["circuit_breaker"]["paused_now"] is True
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
        row = db.execute("SELECT kill_switch,version FROM paper_accounts WHERE id=?", (account["id"],)).fetchone()
    assert row["kill_switch"] == 1 and row["version"] == account["version"] + 1
    events = client.get(f"/api/paper/accounts/{account['id']}/circuit-breakers/events").json()["events"]
    assert {event["kind"] for event in events} == {"tripped", "evaluated"}
    assert next(event for event in events if event["kind"] == "tripped")["evidence"]["trigger"] == "automation"
    assert client.get(f"/api/agent-automation/mandates/{mandate['id']}").json()["mandate"]["status"] == "paused"


def test_automation_proceeds_when_breaker_passes(automation_client):
    client, account, _ = automation_client
    assert _put(client, account["id"], {"daily_loss_limit_pct": 5}).status_code == 200  # no snapshot yet: unavailable, never trips
    result = automation.tick()["results"][0]
    assert result["status"] == "simulated"
    events = client.get(f"/api/paper/accounts/{account['id']}/circuit-breakers/events").json()["events"]
    # The automation step and the accept guard each evaluate once; both see the unavailable baseline.
    assert [event["kind"] for event in events] == ["evaluated", "evaluated", "policy_changed"]
    assert [event["evidence"]["trigger"] for event in events[:2]] == ["accept", "automation"]
    assert all(event["evidence"]["unavailable"] == ["daily_loss"] and not event["evidence"]["tripped"] for event in events[:2])
