"""Reduce-only mode: exits may pass a paused account or a tripped breaker; buys never do. Synthetic accounts only."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_analytics as analytics, paper_portfolio as paper, position_stops as stops
from alphaview.panel import sessions, store

DAY1, DAY2 = "2024-01-05", "2024-01-08"


def _price(db, symbol, price, day):
    db.execute("INSERT OR REPLACE INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)", (symbol, day))
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, price, price * 1.01, price * .99, price, price))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "reduce-only.db"))
    clock = {"session": DAY1}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    store.init_db()
    with store.connect() as db:
        for symbol in ("SYNTA", "SYNTB"):
            _price(db, symbol, 100, DAY1)
    app = FastAPI()
    for module in (paper, analytics, breakers, stops):
        app.include_router(module.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic reduce-only", "initial_cash": 10000,
                                                          "idempotency_key": "reduce-only-account"}).json()["account"]
        yield client, account, clock


def _account(client, account_id):
    return client.get(f"/api/paper/accounts/{account_id}").json()["account"]


def _holdings(client, account_id):
    return {row["symbol"]: row["shares"] for row in client.get(f"/api/paper/accounts/{account_id}").json()["holdings"]}


def _propose(client, account, targets, key):
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals",
                           json={"expected_version": account["version"], "targets": targets, "idempotency_key": f"reduce-only-{key}"})
    assert response.status_code == 200, response.text
    return response.json()


def _accept(client, account, proposal, key):
    return client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept",
                       json={"expected_version": account["version"], "idempotency_key": f"reduce-only-{key}"})


def _buy(client, account, targets, key):
    proposal = _propose(client, account, targets, key)
    assert proposal["status"] == "proposed" and proposal["risk_direction"] == "increasing"
    response = _accept(client, account, proposal, key + "-accept")
    assert response.status_code == 200, response.text
    return response.json()["account"]["account"]


def _pause(client, account):
    response = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"], "kill_switch": True})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def _policy(client, account_id, policy, expected_version=1):
    response = client.put(f"/api/paper/accounts/{account_id}/circuit-breakers", json={"policy": policy, "expected_version": expected_version})
    assert response.status_code == 200, response.text
    return response.json()


def test_paused_account_blocks_even_sells_without_the_flag(workspace):
    client, account, _ = workspace
    account = _buy(client, account, [{"symbol": "SYNTA", "weight_pct": 30}], "open")
    account = _pause(client, account)
    revision = store.input_revision()
    proposal = _propose(client, account, [{"symbol": "SYNTA", "weight_pct": 0}], "sell-blocked")
    assert proposal["status"] == "blocked" and proposal["risk_direction"] == "reducing"
    violation = next(item for item in proposal["violations"] if item["code"] == "kill_switch")
    assert "reduce_only 未啟用" in violation["message"]
    refused = _accept(client, account, proposal, "sell-blocked-accept")
    assert refused.status_code == 409 and "reduce_only 未啟用" in refused.text
    assert _holdings(client, account["id"]) == {"SYNTA": 30.0} and store.input_revision() == revision
    assert json.dumps(proposal, allow_nan=False)


def test_reduce_only_admits_a_sell_to_zero_while_paused_and_keeps_the_pause(workspace):
    client, account, _ = workspace
    account = _buy(client, account, [{"symbol": "SYNTA", "weight_pct": 30}], "open")
    account = _pause(client, account)
    saved = _policy(client, account["id"], {"reduce_only_allowed": True})
    assert saved["policy"]["reduce_only_allowed"] is True and saved["policy"]["auto_pause"] is True
    proposal = _propose(client, account, [{"symbol": "SYNTA", "weight_pct": 0}], "exit")
    assert proposal["status"] == "proposed" and proposal["risk_direction"] == "reducing"
    assert [order["side"] for order in proposal["orders"]] == ["sell"]
    accepted = _accept(client, account, proposal, "exit-accept")
    assert accepted.status_code == 200, accepted.text
    after = _account(client, account["id"])
    assert after["kill_switch"] is True and _holdings(client, account["id"]) == {}
    assert accepted.json()["proposal"]["status"] == "simulated"


def test_reduce_only_never_admits_buys_new_symbols_or_no_ops(workspace):
    client, account, _ = workspace
    account = _buy(client, account, [{"symbol": "SYNTA", "weight_pct": 30}], "open")
    account = _pause(client, account)
    _policy(client, account["id"], {"reduce_only_allowed": True})
    cases = {"mixed": [{"symbol": "SYNTA", "weight_pct": 10}, {"symbol": "SYNTB", "weight_pct": 5}],
             "increasing": [{"symbol": "SYNTA", "weight_pct": 40}],
             "unchanged": [{"symbol": "SYNTA", "weight_pct": 30}]}
    for direction, targets in cases.items():
        proposal = _propose(client, account, targets, f"blocked-{direction}")
        assert proposal["status"] == "blocked" and proposal["risk_direction"] == direction, direction
        violation = next(item for item in proposal["violations"] if item["code"] == "kill_switch")
        assert f"risk_direction={direction}" in violation["message"]
        refused = _accept(client, account, proposal, f"blocked-{direction}-accept")
        assert refused.status_code == 409 and "不是純減倉" in refused.text
    assert _holdings(client, account["id"]) == {"SYNTA": 30.0}


def test_stop_proposal_passes_a_tripped_breaker_with_the_flag(workspace):
    client, account, clock = workspace
    account = _buy(client, account, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}], "open")
    assert client.post(f"/api/paper/accounts/{account['id']}/nav/capture", json={"expected_version": account["version"]}).status_code == 200
    _policy(client, account["id"], {"daily_loss_limit_pct": 5, "reduce_only_allowed": True})
    assert client.put(f"/api/paper/accounts/{account['id']}/position-stops", json={
        "policy": {"enabled": True, "stop_loss_pct": 10, "cooldown_sessions": 2}, "expected_version": 0}).status_code == 200
    clock["session"] = DAY2
    with store.connect() as db:
        _price(db, "SYNTA", 80, DAY2)
        _price(db, "SYNTB", 100, DAY2)
    evaluated = client.post(f"/api/paper/accounts/{account['id']}/circuit-breakers/evaluate").json()
    assert evaluated["tripped"] and evaluated["paused_now"] is True
    account = _account(client, account["id"])
    assert account["kill_switch"] is True
    # Selling SYNTA while adding to SYNTB is mixed, so it stays refused while paused and tripped.
    buy = _propose(client, account, [{"symbol": "SYNTB", "weight_pct": 40}], "buy-while-tripped")
    assert buy["status"] == "blocked" and buy["risk_direction"] == "mixed"
    created = client.post(f"/api/paper/accounts/{account['id']}/position-stops/proposal",
                          json={"expected_account_version": account["version"], "idempotency_key": "stop-exit"})
    assert created.status_code == 201, created.text
    proposal = created.json()["paper_proposal"]
    assert created.json()["tripped"] == ["SYNTA"] and proposal["status"] == "proposed" and proposal["risk_direction"] == "reducing"
    accepted = _accept(client, account, proposal, "stop-exit-accept")
    assert accepted.status_code == 200, accepted.text
    assert _holdings(client, account["id"]) == {"SYNTB": 30.0}
    assert _account(client, account["id"])["kill_switch"] is True
    events = client.get(f"/api/paper/accounts/{account['id']}/circuit-breakers/events").json()["events"]
    assert [event["kind"] for event in events].count("tripped") == 1


def test_proposals_stored_before_risk_direction_still_verify(workspace):
    client, account, _ = workspace
    proposal = _propose(client, account, [{"symbol": "SYNTA", "weight_pct": 20}], "legacy")
    with store.connect() as db:
        preview = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0])
        preview.pop("risk_direction")
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (paper._json(preview), proposal["id"]))
    accepted = _accept(client, account, proposal, "legacy-accept")
    assert accepted.status_code == 200, accepted.text
    assert _holdings(client, account["id"]) == {"SYNTA": 20.0}
