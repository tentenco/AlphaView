"""Saved-run standalone validation uses synthetic local evidence, never allocation mutation."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import portfolio_agent as agent, research_desk as desk, research_validation as validation
from alphaview.panel import scan_provenance, sessions, store, workflow_validation as workflow
from tests.test_research_desk import insert_bars, wave


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "workflow-validation.db"))
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("No external requests"))
    store.init_db()
    days = insert_bars("SYNTA", wave(620, period=30))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: days[-1])
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTB',?,100,101,99,100,100,1000)", (days[-1],))
        db.execute("INSERT INTO datasets(symbol,currency,status) VALUES ('SYNTB','USD','ok')")
        for symbol in ("SYNTA", "SYNTB"):
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','synthetic',1000000000)", (symbol, "Synthetic"))
    app = FastAPI()
    app.include_router(agent.router)
    app.include_router(workflow.router)
    with TestClient(app) as client:
        yield client, days[-1]


def saved(client, as_of, **changes):
    rows = [{"symbol": symbol, "name": "Synthetic", "date": as_of, "bars": 620,
             "indicators": {"close": 100}, "signals": [
                {"strategy": rule, "status": "match", "matched": True, "reason": "Synthetic signal"}
                for rule in agent.STRATEGY_IDS]} for symbol in ("SYNTA", "SYNTB")]
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (as_of, json.dumps(["SYNTA", "SYNTB"]), json.dumps(rows), scan_provenance.current_token(db)))
    response = client.post("/api/portfolio-agent/runs", json={"candidate_symbols": ["SYNTA", "SYNTB"], **changes})
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "proposed"
    return response.json()


def body(run, **changes):
    return {"symbols": ["SYNTA", "SYNTB"], "trials": 3,
            "expected_proposal_fingerprint": run["proposal_fingerprint"],
            "expected_input_revision": run["input_revision"], "expected_as_of": run["as_of"], **changes}


def url(run):
    return f"/api/portfolio-agent/runs/{run['id']}/validation"


def test_real_validation_maps_saved_enabled_rules_and_keeps_missing_rps_in_full_denominator(workspace):
    client, as_of = workspace
    run = saved(client, as_of)
    revision = store.input_revision()
    response = client.post(url(run), json=body(run))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    value = response.json()
    json.dumps(value, allow_nan=False)
    assert value["engine_version"] == workflow.ENGINE_VERSION and value["validation_engine_version"] == validation.VALIDATION_VERSION
    assert value["mode"] == "advisory_only" and "overall" not in value and "verdict" not in value
    assert value["coverage"]["required_pairs"] == value["coverage"]["requested_pairs"] == 8
    assert value["coverage"]["evaluated_pairs"] == 3 and value["coverage"]["unavailable_pairs"] == 5
    assert len(value["rule_fingerprint"]) == len(value["evidence_fingerprint"]) == 64
    assert value["proposal_fingerprint"] == run["proposal_fingerprint"]
    assert len(sessions.expected_sessions(value["request"]["test_start"], value["request"]["test_end"])) == 252
    assert value["request"]["risk"] == desk.Risk().model_dump() and value["request"]["folds"] == 4
    for item in value["items"]:
        assert item["weight"] == 25 and "return_pct" not in item
        if item["rule"] == "rps":
            assert item["status"] == "unavailable" and item["verdict"] is None
            assert item["config"] is None and item["code"] == "unsupported_cross_sectional_rule"
            assert item["closed_trades"] is None and item["probability"] is None and item["ci95"] is None
        elif item["symbol"] == "SYNTB":
            assert item["status"] == "unavailable" and item["code"] == "insufficient_history"
        else:
            direct = validation.validate(validation.ValidateInput(symbol="SYNTA", config=item["config"],
                test_start=value["request"]["test_start"], test_end=as_of, folds=4, trials=3))
            assert item["config"] == {"strategy": f"alphaview_{item['rule']}", "params": {}}
            assert item["verdict"] == direct["verdict"]["status"]
            assert item["history_fingerprint"] == direct["fingerprint"]
            assert item["consistency"] == (direct["walk_forward"]["consistency"] if direct["walk_forward"]["available"] else None)
    assert store.input_revision() == revision
    current = client.get(f"/api/portfolio-agent/runs/{run['id']}").json()
    assert current["target_weights"] == run["target_weights"] and current["proposal_fingerprint"] == run["proposal_fingerprint"]
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM portfolio_agent_runs").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM paper_proposals").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM research_desk_runs").fetchone()[0] == 0


def test_subset_and_disabled_rules_are_explicit_without_reweighting(workspace):
    client, as_of = workspace
    run = saved(client, as_of, strategy_weights={"turtle": 60, "trend": 40, "pullback": 0, "rps": 0})
    response = client.post(url(run), json=body(run, symbols=["SYNTA"]))
    assert response.status_code == 200
    value = response.json()
    assert value["uninspected_symbols"] == ["SYNTB"]
    assert value["coverage"]["required_pairs"] == 4 and value["coverage"]["requested_pairs"] == 2
    assert value["coverage"]["uninspected_pairs"] == 2
    assert [(item["rule"], item["weight"]) for item in value["items"]] == [("turtle", 60), ("trend", 40)]
    assert sum(item["weight"] for item in value["enabled_rules"]) == 100


def test_raw_history_bound_is_checked_before_series_or_validator(workspace, monkeypatch):
    client, as_of = workspace
    with store.connect() as db:
        for i in range(2500):
            db.execute("INSERT INTO bars VALUES ('SYNTA',?,100,101,99,100,100,1000)",
                       ((date(1950, 1, 1) + timedelta(days=i)).isoformat(),))
    run = saved(client, as_of)
    monkeypatch.setattr(validation, "validate", lambda *a, **k: pytest.fail("Oversized raw history must not be loaded"))
    response = client.post(url(run), json=body(run, symbols=["SYNTA"]))
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 4 and all(item["status"] == "unavailable" for item in items)
    assert {item["code"] for item in items} == {"history_limit", "unsupported_cross_sectional_rule"}


@pytest.mark.parametrize("fault", ["inputs", "session", "fingerprint", "revision", "as_of"])
def test_stale_run_or_expected_provenance_fails_before_validation(workspace, monkeypatch, fault):
    client, as_of = workspace
    run = saved(client, as_of)
    request = body(run)
    if fault == "inputs":
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    elif fault == "session":
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-10-01")
    else:
        request[{"fingerprint": "expected_proposal_fingerprint", "revision": "expected_input_revision", "as_of": "expected_as_of"}[fault]] = (
            "a" * 64 if fault == "fingerprint" else "changed:1" if fault == "revision" else "2024-01-01")
    monkeypatch.setattr(validation, "validate", lambda *a, **k: pytest.fail("Stale input must fail before compute"))
    response = client.post(url(run), json=request)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "workflow_validation_stale"


@pytest.mark.parametrize("change", [
    {"symbols": []}, {"symbols": ["SYNTA"] * 2}, {"symbols": ["SYNTA", "SYNTB", "SYNTC", "SYNTD", "SYNTE", "SYNTF"]},
    {"symbols": ["SYNTC"]}, {"symbols": ["synta"]}, {"trials": True}, {"trials": "1"}, {"trials": 1.5},
    {"trials": 0}, {"trials": 501}, {"folds": 8}, {"risk": {"fee_bps": 0}}, {"expected_proposal_fingerprint": "invalid"},
])
def test_compute_bounds_and_request_are_strict(workspace, monkeypatch, change):
    client, as_of = workspace
    run = saved(client, as_of)
    monkeypatch.setattr(validation, "validate", lambda *a, **k: pytest.fail("Invalid request must fail before compute"))
    response = client.post(url(run), json=body(run, **change))
    assert response.status_code == 422, response.text


def test_snapshot_provenance_cannot_cross_session(workspace, monkeypatch):
    client, as_of = workspace
    run = saved(client, as_of, strategy_weights={"turtle": 100, "trend": 0, "pullback": 0, "rps": 0})
    real = validation.validate
    def moved(body):
        evidence = real(body)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-10-01")
        return evidence
    monkeypatch.setattr(validation, "validate", moved)
    assert client.post(url(run), json=body(run, symbols=["SYNTA"])).status_code == 409


def test_all_rule_evidence_uses_one_snapshot_and_fresh_run_read_marks_concurrent_change(workspace, monkeypatch):
    client, as_of = workspace
    run = saved(client, as_of)
    expected = body(run, symbols=["SYNTA"])
    baseline = client.post(url(run), json=expected).json()
    real = validation.validate
    calls = []
    def validate_with_writer(body):
        result = real(body)
        calls.append(body.config.strategy)
        if len(calls) == 1:
            def mutate():
                with store.connect() as db:
                    db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(mutate).result(timeout=5)
        return result
    monkeypatch.setattr(validation, "validate", validate_with_writer)
    response = client.post(url(run), json=expected)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["current_at_snapshot"] and value["input_revision"] == run["input_revision"]
    assert value["input_revision"] != store.input_revision()
    assert value["items"] == baseline["items"]
    assert calls == ["alphaview_turtle", "alphaview_trend", "alphaview_pullback"]
    assert not client.get(f"/api/portfolio-agent/runs/{run['id']}").json()["current"]
