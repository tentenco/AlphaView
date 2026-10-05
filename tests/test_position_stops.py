"""Position stops on synthetic paper accounts: close-confirmed trips, proposals, cooldowns; no real data."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_portfolio as paper
from alphaview.panel import position_stops as stops
from alphaview.panel import sessions, store

DAY1, DAY2, DAY3, DAY4 = "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "stops.db"))
    clock = {"session": DAY1}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    store.init_db()
    with store.connect() as db:
        for symbol in ("SYNTA", "SYNTB"):
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, DAY1))
    app = FastAPI()
    app.include_router(stops.router)
    app.include_router(paper.router)
    with TestClient(app) as client:
        yield {"client": client, "clock": clock}


def bar(symbol, day, close):
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, close, close * 1.01, close * 0.99, close, close))


def account(client):
    return client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 10000, "idempotency_key": "synthetic-account"}).json()["account"]


def fill(client, acct, targets, key):
    proposal = client.post(f"/api/paper/accounts/{acct['id']}/proposals", json={"expected_version": acct["version"], "targets": targets, "idempotency_key": key}).json()
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept", json={"expected_version": acct["version"], "idempotency_key": key + "-accept"})
    assert accepted.status_code == 200, accepted.text
    return accepted.json()["account"]["account"]


def policy(client, acct, version=0, **changes):
    body = {"policy": {"enabled": True, "stop_loss_pct": 10, "trailing_stop_pct": 8, "cooldown_sessions": 2, **changes}, "expected_version": version}
    response = client.put(f"/api/paper/accounts/{acct['id']}/position-stops", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_stop_loss_and_trailing_stop_are_close_confirmed_from_cost_and_peak(setup):
    client, clock = setup["client"], setup["clock"]
    acct = account(client)
    acct = fill(client, acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}], "synthetic-open")
    evaluation = policy(client, acct)
    assert evaluation["policy_version"] == 1 and evaluation["tripped"] == []
    assert [row["entry_session"] for row in evaluation["holdings"]] == [DAY1, DAY1]
    # SYNTA rallies to 130 then falls to 118 (9.2% below peak): trailing stop. SYNTB falls to 89: stop loss.
    bar("SYNTA", DAY2, 130), bar("SYNTB", DAY2, 95)
    bar("SYNTA", DAY3, 118), bar("SYNTB", DAY3, 89)
    clock["session"] = DAY3
    revision = store.input_revision()
    evaluation = client.get(f"/api/paper/accounts/{acct['id']}/position-stops").json()
    rows = {row["symbol"]: row for row in evaluation["holdings"]}
    assert rows["SYNTA"]["status"] == "trailing_stop" and rows["SYNTA"]["peak_close"] == 130
    trailing = next(check for check in rows["SYNTA"]["checks"] if check["code"] == "trailing_stop")
    assert trailing["status"] == "tripped" and trailing["drawdown_from_peak_pct"] == pytest.approx(-9.23, abs=0.01)
    assert rows["SYNTB"]["status"] == "stop_loss" and rows["SYNTB"]["checks"][0]["loss_from_cost_pct"] < -10
    assert sorted(evaluation["tripped"]) == ["SYNTA", "SYNTB"] and store.input_revision() == revision
    assert json.dumps(evaluation, allow_nan=False)


def test_missing_price_or_entry_is_unavailable_never_tripped(setup):
    client, clock = setup["client"], setup["clock"]
    acct = account(client)
    acct = fill(client, acct, [{"symbol": "SYNTA", "weight_pct": 30}], "synthetic-open")
    policy(client, acct)
    clock["session"] = DAY2  # no bar for DAY2 → price unavailable
    evaluation = client.get(f"/api/paper/accounts/{acct['id']}/position-stops").json()
    assert evaluation["holdings"][0]["status"] == "unavailable" and evaluation["tripped"] == [] and evaluation["unavailable"] == ["SYNTA"]
    with store.connect() as db:
        db.execute("UPDATE paper_ledger SET proposal_id=NULL")
    bar("SYNTA", DAY2, 50)
    evaluation = client.get(f"/api/paper/accounts/{acct['id']}/position-stops").json()
    row = evaluation["holdings"][0]
    assert row["status"] == "stop_loss" and row["entry_session"] is None
    assert next(check for check in row["checks"] if check["code"] == "trailing_stop")["status"] == "unavailable"


def test_stop_proposal_zeroes_tripped_keeps_weights_and_enforces_cooldown(setup):
    client, clock = setup["client"], setup["clock"]
    acct = account(client)
    acct = fill(client, acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}], "synthetic-open")
    policy(client, acct)
    nothing = client.post(f"/api/paper/accounts/{acct['id']}/position-stops/proposal", json={"expected_account_version": acct["version"], "idempotency_key": "synthetic-stop"})
    assert nothing.status_code == 409 and nothing.json()["detail"]["code"] == "nothing_tripped"
    bar("SYNTA", DAY2, 100), bar("SYNTB", DAY2, 85)
    clock["session"] = DAY2
    fresh = client.get(f"/api/paper/accounts/{acct['id']}").json()["account"]
    response = client.post(f"/api/paper/accounts/{acct['id']}/position-stops/proposal", json={"expected_account_version": fresh["version"], "idempotency_key": "synthetic-stop"})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["tripped"] == ["SYNTB"] and result["cooldown_until"] > DAY2
    targets = {row["symbol"]: row["weight_pct"] for row in result["targets"]}
    assert targets["SYNTB"] == 0 and 0 < targets["SYNTA"] < 40
    proposal = result["paper_proposal"]
    assert proposal["status"] == "proposed" and [order["symbol"] for order in proposal["orders"]] == ["SYNTB"]
    assert client.post(f"/api/paper/accounts/{acct['id']}/position-stops/proposal", json={"expected_account_version": fresh["version"], "idempotency_key": "synthetic-stop"}).json()["paper_proposal"]["id"] == proposal["id"]
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept", json={"expected_version": fresh["version"], "idempotency_key": "synthetic-stop-accept"})
    assert accepted.status_code == 200, accepted.text
    current = accepted.json()["account"]["account"]
    reentry = client.post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": current["version"], "targets": [{"symbol": "SYNTB", "weight_pct": 10}]}).json()
    assert not reentry["executable"] and [item["code"] for item in reentry["violations"]] == ["stop_cooldown"]
    keep = client.post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": current["version"], "targets": [{"symbol": "SYNTA", "weight_pct": 20}]}).json()
    assert keep["executable"]
    assert client.get(f"/api/paper/accounts/{acct['id']}/position-stops").json()["cooldowns"][0]["symbol"] == "SYNTB"
    cleared = client.request("DELETE", f"/api/paper/accounts/{acct['id']}/position-stops/cooldowns/syntb")
    assert cleared.json()["removed"] is True
    assert client.post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": current["version"], "targets": [{"symbol": "SYNTB", "weight_pct": 10}]}).json()["executable"]


def test_policy_versioning_bounds_and_disabled_state(setup):
    client = setup["client"]
    acct = account(client)
    assert client.get(f"/api/paper/accounts/{acct['id']}/position-stops").json()["policy"] == {"enabled": False, "stop_loss_pct": None, "trailing_stop_pct": None, "cooldown_sessions": 5}
    first = policy(client, acct)
    stale = client.put(f"/api/paper/accounts/{acct['id']}/position-stops", json={"policy": {"enabled": True, "stop_loss_pct": 5}, "expected_version": 0})
    assert stale.status_code == 409
    bad = client.put(f"/api/paper/accounts/{acct['id']}/position-stops", json={"policy": {"enabled": True, "stop_loss_pct": 0.5}, "expected_version": first["policy_version"]})
    assert bad.status_code == 422
    off = client.put(f"/api/paper/accounts/{acct['id']}/position-stops", json={"policy": {"enabled": False}, "expected_version": first["policy_version"]}).json()
    assert off["policy_version"] == 2
    disabled = client.post(f"/api/paper/accounts/{acct['id']}/position-stops/proposal", json={"expected_account_version": acct["version"], "idempotency_key": "synthetic-stop"})
    assert disabled.status_code == 422 and disabled.json()["detail"]["code"] == "stops_disabled"
    assert client.get("/api/paper/accounts/unknown/position-stops").status_code == 404
