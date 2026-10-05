"""Regime exposure overlay on synthetic paper accounts: caps from stored readings, block/scale modes, no invented cap."""
import json
from datetime import datetime, timezone

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import circuit_breakers as breakers
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import regime_overlay as overlay
from alphaview.panel import scan_provenance, sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]
WEIGHTS = {"buffett": 15, "shiller": 25, "yield_curve": 25, "technical": 0, "sentiment": 15}


def readings(buffett, shiller, ten, two, sentiment):
    return {"buffett_ratio": {"value": buffett, "as_of": None}, "shiller_pe": {"value": shiller, "as_of": None},
            "yield_10y": {"value": ten, "as_of": None}, "yield_2y": {"value": two, "as_of": None},
            "fear_greed": {"value": sentiment, "as_of": None}}


EXTREME = readings(250, 45, 3, 4, 90)      # 93.75 -> extreme -> cap 40
ELEVATED = readings(190, 36, 3.2, 3.0, 50)  # 74.375 -> elevated -> cap 60
CALM = readings(100, 20, 4, 2, 50)          # 27.8125 -> calm -> cap 100


def scan_row(symbol):
    return {"symbol": symbol, "date": AS_OF, "bars": 240, "indicators": {"close": 100},
            "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch", "matched": index < 2, "reason": "Synthetic"}
                        for index, strategy in enumerate(agent.STRATEGY_IDS)]}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "overlay.db"))
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
    app = FastAPI()
    for module in (paper, overlay, breakers, automation, agent):
        app.include_router(module.router)
    with TestClient(app) as result:
        yield result


def account(client, suffix="one"):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 10000, "idempotency_key": "synthetic-" + suffix})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def set_policy(client, acct, inputs, *, mode="block", enabled=True, weights=WEIGHTS, benchmark="VOO", version=None):
    if version is None:
        version = client.get(f"/api/paper/accounts/{acct['id']}/regime-overlay").json()["policy_version"]
    body = {"policy": {"enabled": enabled, "mode": mode, "regime": {"benchmark": benchmark, "weights": weights, "inputs": inputs}},
            "expected_version": version}
    response = client.put(f"/api/paper/accounts/{acct['id']}/regime-overlay", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def preview(client, acct, targets):
    response = client.post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": acct["version"], "targets": targets})
    assert response.status_code == 200, response.text
    return response.json()


def fill(client, acct, targets, key):
    proposal = client.post(f"/api/paper/accounts/{acct['id']}/proposals", json={"expected_version": acct["version"], "targets": targets, "idempotency_key": key}).json()
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept", json={"expected_version": acct["version"], "idempotency_key": key + "-accept"})
    assert accepted.status_code == 200, accepted.text
    return accepted.json()["account"]["account"]


def mandate(client, acct, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic overlay mandate", "account_id": acct["id"],
        "workflow": {"scope": "market", "candidate_symbols": SYMBOLS,
                     "constraints": {"max_positions": 2, "cash_buffer_pct": 0, "max_position_weight_pct": 25}}, **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def run(client, item, allow=False):
    return client.post(f"/api/agent-automation/mandates/{item['id']}/run", json={"expected_version": item["version"], "allow_auto_simulate": allow})


def test_cap_table_is_monotone_and_never_assumed_without_a_score():
    caps = [overlay.exposure_cap({"score": score, "zone": zone, "regime_version": "alphaview-regime-v1", "regime_as_of": AS_OF})
            for score, zone in ((10, "calm"), (45, "watch"), (65, "elevated"), (90, "extreme"))]
    assert [cap["cap_pct"] for cap in caps] == [100, 80, 60, 40] and all(cap["status"] == "ok" for cap in caps)
    missing = overlay.exposure_cap({"score": None, "zone": None, "missing": ["technical"], "regime_as_of": AS_OF})
    assert missing["cap_pct"] is None and missing["status"] == "unavailable" and missing["reason"] == "regime_incomplete"
    assert overlay.scale_targets([{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}], overlay.EXPOSURE_CAPS["extreme"]) == [
        {"symbol": "SYNTA", "weight_pct": 20.0}, {"symbol": "SYNTB", "weight_pct": 20.0}]
    assert overlay.scale_targets([{"symbol": "SYNTA", "weight_pct": 30}], overlay.EXPOSURE_CAPS["extreme"]) == [{"symbol": "SYNTA", "weight_pct": 30}]


def test_policy_is_versioned_readonly_to_read_and_survives_breaker_saves(client):
    acct = account(client)
    before = store.input_revision()
    initial = client.get(f"/api/paper/accounts/{acct['id']}/regime-overlay")
    assert initial.status_code == 200, initial.text
    state = initial.json()
    assert state["policy"] == {"enabled": False, "mode": "block", "regime": overlay.RegimeSettings().model_dump()} and state["policy_version"] == 0
    assert state["cap"]["status"] == "unavailable" and state["exposure_status"] == "no_cap" and state["current_exposure_pct"] == 0
    saved = set_policy(client, acct, EXTREME)
    assert saved["policy_version"] == 1 and saved["cap"] == {**saved["cap"], "band": "extreme", "cap_pct": 40, "status": "ok"}
    assert saved["regime"]["score"] == pytest.approx(93.75) and saved["engine_version"] == overlay.ENGINE_VERSION
    stale = client.put(f"/api/paper/accounts/{acct['id']}/regime-overlay", json={"policy": saved["policy"], "expected_version": 0})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "policy_changed"
    breaker = client.put(f"/api/paper/accounts/{acct['id']}/circuit-breakers", json={
        "policy": {"daily_loss_limit_pct": 5, "max_drawdown_pct": None, "max_fills_per_session": None, "auto_pause": True}, "expected_version": 1})
    assert breaker.status_code == 200, breaker.text
    assert "regime_overlay" not in breaker.json()["policy"] and breaker.json()["policy"]["daily_loss_limit_pct"] == 5
    after = client.get(f"/api/paper/accounts/{acct['id']}/regime-overlay").json()
    assert after["policy"]["enabled"] and after["policy_version"] == 1 and after["cap"]["band"] == "extreme"
    assert client.get(f"/api/paper/accounts/{acct['id']}/circuit-breakers").json()["policy"]["daily_loss_limit_pct"] == 5
    json.dumps(after, allow_nan=False)
    assert store.input_revision() == before
    bad = client.put(f"/api/paper/accounts/{acct['id']}/regime-overlay", json={
        "policy": {"enabled": True, "mode": "block", "regime": {"benchmark": "VOO", "weights": WEIGHTS, "inputs": readings(5000, 20, 4, 2, 50)}},
        "expected_version": 1})
    assert bad.status_code == 422


def test_block_mode_refuses_exposure_above_the_cap_but_lets_reductions_through(client):
    acct = account(client)
    set_policy(client, acct, EXTREME, mode="block")
    blocked = preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 25}])
    assert [item["code"] for item in blocked["violations"]] == ["regime_exposure_cap"] and not blocked["executable"]
    assert "40%" in blocked["violations"][0]["message"] and "extreme" in blocked["violations"][0]["message"]
    assert preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 20}, {"symbol": "SYNTB", "weight_pct": 20}])["executable"]
    set_policy(client, acct, CALM, mode="block")
    acct = fill(client, acct, [{"symbol": "SYNTA", "weight_pct": 22.5}, {"symbol": "SYNTB", "weight_pct": 22.5}], "synthetic-open")
    state = set_policy(client, acct, EXTREME, mode="block")
    assert state["current_exposure_pct"] == pytest.approx(45) and state["exposure_status"] == "above_cap"
    reduction = preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 21}, {"symbol": "SYNTB", "weight_pct": 21}])
    assert reduction["executable"], reduction["violations"]
    increase = preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 23}, {"symbol": "SYNTB", "weight_pct": 23}])
    assert [item["code"] for item in increase["violations"]] == ["regime_exposure_cap"]
    set_policy(client, acct, EXTREME, enabled=False)
    assert preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 25}])["executable"]


def test_incomplete_regime_fails_closed_in_block_mode_and_is_recorded_in_scale_mode(client):
    acct = account(client)
    technical = {**WEIGHTS, "technical": 20}
    state = set_policy(client, acct, EXTREME, mode="block", weights=technical)
    assert state["cap"]["status"] == "unavailable" and state["regime"]["missing"] == ["technical"]
    blocked = preview(client, acct, [{"symbol": "SYNTA", "weight_pct": 10}])
    assert [item["code"] for item in blocked["violations"]] == ["regime_unavailable"]
    set_policy(client, acct, EXTREME, mode="scale", weights=technical)
    item = mandate(client, acct)
    result = run(client, item)
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "proposed"
    attempt = result.json()["attempt"]
    evidence = attempt["result"]["regime_overlay"]
    assert evidence["status"] == "unavailable" and evidence["warnings"] == ["regime_overlay_unavailable"] and not evidence["applied"]
    assert "regime_overlay_unavailable" in attempt["reason"]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["targets"] == [{"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 25}]


def test_scale_mode_shrinks_automation_targets_and_binds_the_evidence_to_acceptance(client):
    acct = account(client)
    set_policy(client, acct, EXTREME, mode="scale")
    item = mandate(client, acct)
    result = run(client, item)
    assert result.status_code == 200, result.text
    attempt = result.json()["attempt"]
    evidence = attempt["result"]["regime_overlay"]
    assert evidence["status"] == "scaled" and evidence["applied"] and evidence["cap"]["band"] == "extreme"
    assert evidence["targets_before"] == [{"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 25}]
    assert evidence["targets_after"] == [{"symbol": "SYNTA", "weight_pct": 20.0}, {"symbol": "SYNTB", "weight_pct": 20.0}]
    assert (evidence["invested_before_pct"], evidence["invested_after_pct"]) == (50, 40)
    assert "→40.00%" in attempt["reason"]
    proposal = client.get(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}").json()
    assert proposal["targets"] == evidence["targets_after"] and "市場風險覆蓋" in proposal["rationale"]
    with store.connect() as db:
        row = db.execute("SELECT result_json FROM agent_automation_attempts WHERE id=?", (attempt["id"],)).fetchone()
        tampered = json.loads(row["result_json"])
        tampered["regime_overlay"]["targets_after"] = [{"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 15}]
        db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (json.dumps(tampered), attempt["id"]))
    refused = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                          json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept-1"})
    assert refused.status_code == 409 and "市場風險覆蓋" in refused.text
    with store.connect() as db:
        db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (row["result_json"], attempt["id"]))
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept-2"})
    assert accepted.status_code == 200, accepted.text
    holdings = {row["symbol"]: row for row in accepted.json()["account"]["holdings"]}
    assert holdings["SYNTA"]["shares"] == pytest.approx(20) and holdings["SYNTB"]["shares"] == pytest.approx(20)


def test_run_bridge_scales_targets_and_reports_the_overlay(client):
    acct = account(client)
    set_policy(client, acct, ELEVATED, mode="scale")
    created = client.post("/api/portfolio-agent/runs", json={"scope": "market", "candidate_symbols": SYMBOLS,
                                                            "constraints": {"max_positions": 2, "cash_buffer_pct": 0, "max_position_weight_pct": 40}})
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    bridged = client.post(f"/api/portfolio-agent/runs/{run_id}/paper-preview", json={"account_id": acct["id"], "expected_account_version": acct["version"]})
    assert bridged.status_code == 200, bridged.text
    body = bridged.json()
    assert body["regime_overlay"]["status"] == "scaled" and body["regime_overlay"]["cap"]["cap_pct"] == 60
    assert body["paper_preview"]["targets"] == [{"symbol": "SYNTA", "weight_pct": 30.0}, {"symbol": "SYNTB", "weight_pct": 30.0}]
    assert "上限 60%" in body["paper_preview"]["rationale"]
    set_policy(client, acct, ELEVATED, enabled=False)
    plain = client.post(f"/api/portfolio-agent/runs/{run_id}/paper-preview", json={"account_id": acct["id"], "expected_account_version": acct["version"]}).json()
    assert plain["regime_overlay"]["status"] == "disabled" and plain["paper_preview"]["targets"][0]["weight_pct"] == 40
