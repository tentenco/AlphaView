"""regime_change rebalance gate on synthetic accounts: baseline, fired, unchanged and waiting; never fires without a score."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent, rebalance_trigger as triggers
from alphaview.panel import regime_overlay as overlay
from alphaview.panel import scan_provenance, sessions, store

DAYS = ["2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"]
SYMBOLS = ["SYNTA", "SYNTB"]
WEIGHTS = {"buffett": 15, "shiller": 25, "yield_curve": 25, "technical": 0, "sentiment": 15}


def readings(buffett, shiller, ten, two, sentiment):
    return {"buffett_ratio": {"value": buffett, "as_of": None}, "shiller_pe": {"value": shiller, "as_of": None},
            "yield_10y": {"value": ten, "as_of": None}, "yield_2y": {"value": two, "as_of": None},
            "fear_greed": {"value": sentiment, "as_of": None}}


EXTREME = readings(250, 45, 3, 4, 90)
CALM = readings(100, 20, 4, 2, 50)


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
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "regime-trigger.db"))
    clock = {"session": DAYS[0]}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    seed(DAYS[0])
    app = FastAPI()
    for module in (automation, paper, breakers, overlay):
        app.include_router(module.router)
    with TestClient(app) as client:
        yield client, clock


def account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000, "idempotency_key": "regime-trigger-account"})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def set_readings(client, acct, inputs):
    version = client.get(f"/api/paper/accounts/{acct['id']}/regime-overlay").json()["policy_version"]
    body = {"policy": {"enabled": False, "mode": "block", "regime": {"benchmark": "VOO", "weights": WEIGHTS, "inputs": inputs}},
            "expected_version": version}
    response = client.put(f"/api/paper/accounts/{acct['id']}/regime-overlay", json=body)
    assert response.status_code == 200, response.text


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Regime task", "account_id": acct["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "enabled": True, "mode": "proposal_only",
        "rebalance_trigger": {"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None,
                              "regime_change": {"enabled": True, "min_band_change": 1}}, **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": False}).json()


def advance(clock, day):
    clock["session"] = day
    seed(day)


def test_policy_accepts_optional_regime_gate_and_bounds_it(setup):
    client, _ = setup
    acct = account(client)
    item = mandate(client, acct)
    assert item["rebalance_trigger"]["regime_change"] == {"enabled": True, "min_band_change": 1}
    assert triggers.enabled(item["rebalance_trigger"])
    assert not triggers.enabled({"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None, "regime_change": {"enabled": False, "min_band_change": 1}})
    # min_band_change defaults to 1, so {"enabled": true} alone is a valid request; types and bounds are strict.
    short = client.patch(f"/api/agent-automation/mandates/{item['id']}", json={
        "expected_version": item["version"],
        "rebalance_trigger": {"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None, "regime_change": {"enabled": True}}})
    assert short.status_code == 200 and short.json()["mandate"]["rebalance_trigger"]["regime_change"] == {"enabled": True, "min_band_change": 1}
    item = short.json()["mandate"]
    for bad in ({"enabled": True, "min_band_change": 0}, {"enabled": True, "min_band_change": 4}, {"enabled": "yes", "min_band_change": 1},
                {"enabled": True, "min_band_change": 1.5}, {"enabled": True, "min_band_change": 1, "extra": 1}):
        response = client.patch(f"/api/agent-automation/mandates/{item['id']}", json={
            "expected_version": item["version"],
            "rebalance_trigger": {"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None, "regime_change": bad}})
        assert response.status_code == 422, bad


def test_unavailable_score_waits_then_baseline_fired_and_unchanged_follow_the_band(setup):
    client, clock = setup
    acct = account(client)
    item = mandate(client, acct)
    waiting = run(client, item)
    assert waiting["status"] == "waiting" and "市場風險溫度計不完整" in waiting["reason"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0] == 0
    set_readings(client, acct, CALM)
    first = run(client, item)
    assert first["status"] == "skipped" and first["attempt"]["reason_code"] == "regime_baseline_recorded"
    regime = first["attempt"]["result"]["rebalance_trigger"]["regime_change"]
    assert regime["status"] == "baseline" and regime["band"] == "calm" and regime["previous_band"] is None
    assert first["attempt"]["result"]["rebalance_trigger"]["checks"][-1] == {"code": "regime_change", "enabled": True, "passed": False, "actual": None, "required": 1}
    advance(clock, DAYS[1])
    unchanged = run(client, item)
    assert unchanged["status"] == "skipped" and unchanged["attempt"]["reason_code"] == "regime_unchanged"
    regime = unchanged["attempt"]["result"]["rebalance_trigger"]["regime_change"]
    assert regime["status"] == "unchanged" and regime["previous_band"] == "calm" and regime["previous_session"] == DAYS[0] and regime["band_steps"] == 0
    set_readings(client, acct, EXTREME)
    advance(clock, DAYS[2])
    fired = run(client, item)
    assert fired["status"] == "proposed", fired
    evidence = fired["attempt"]["result"]["rebalance_trigger"]
    assert evidence["outcome"] == "pass" and evidence["regime_change"]["status"] == "fired"
    assert evidence["regime_change"]["band"] == "extreme" and evidence["regime_change"]["previous_band"] == "calm" and evidence["regime_change"]["band_steps"] == 3
    assert fired["attempt"]["paper_proposal_id"]
    advance(clock, DAYS[3])
    again = run(client, item)
    assert again["status"] == "skipped" and again["attempt"]["reason_code"] == "regime_unchanged"
    json.dumps(again, allow_nan=False)


def test_min_band_change_requires_enough_steps_and_other_gates_still_apply(setup):
    client, clock = setup
    acct = account(client)
    set_readings(client, acct, CALM)
    item = mandate(client, acct, rebalance_trigger={"min_weight_drift_pp": 100, "min_completed_sessions_between_fills": None,
                                                     "regime_change": {"enabled": True, "min_band_change": 2}})
    baseline = run(client, item)["attempt"]["result"]["rebalance_trigger"]
    assert baseline["reason_codes"] == ["drift_below_threshold", "regime_baseline_recorded"]
    set_readings(client, acct, EXTREME)
    advance(clock, DAYS[1])
    result = run(client, item)
    assert result["status"] == "skipped"
    evidence = result["attempt"]["result"]["rebalance_trigger"]
    assert evidence["regime_change"]["status"] == "fired" and evidence["regime_change"]["band_steps"] == 3
    assert evidence["reason_codes"] == ["drift_below_threshold"]


def test_evidence_policy_normalizes_legacy_two_key_rows(setup):
    client, _ = setup
    acct = account(client)
    item = mandate(client, acct, rebalance_trigger={"min_weight_drift_pp": 0, "min_completed_sessions_between_fills": None})
    with store.connect() as db:
        db.execute("UPDATE agent_mandates SET rebalance_trigger_json=? WHERE id=?",
                   ('{"min_completed_sessions_between_fills":null,"min_weight_drift_pp":0}', item["id"]))
    result = run(client, item)
    assert result["status"] == "proposed", result
    assert result["attempt"]["result"]["rebalance_trigger"]["policy"]["regime_change"] == {"enabled": False, "min_band_change": 1}
    assert result["attempt"]["result"]["rebalance_trigger"]["regime_change"]["status"] == "disabled"
    detail = client.get(f"/api/agent-automation/mandates/{item['id']}").json()["mandate"]
    assert detail["rebalance_trigger"]["regime_change"] == {"enabled": False, "min_band_change": 1}
