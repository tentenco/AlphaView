"""Paper-automation readiness gate on synthetic accounts: missing evidence never passes."""
import json
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import backup_preflight, circuit_breakers as breakers, paper_analytics as analytics
from alphaview.panel import paper_portfolio as paper, position_stops as stops, readiness, sessions, store

DAY1 = "2024-01-05"
SYMBOLS = ["SYNTA", "SYNTB"]


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "readiness.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: DAY1)
    store.init_db()
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT OR REPLACE INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)", (symbol, DAY1))
            db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,100,101,99,100,100,1000)", (symbol, DAY1))
        # Other forks may add tables in the same round; the gate only needs the live digest to be registered.
        monkeypatch.setitem(backup_preflight.KNOWN_SCHEMAS, readiness.schema_digest(db), "current")
    app = FastAPI()
    for module in (paper, analytics, breakers, stops, automation, readiness):
        app.include_router(module.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic readiness", "initial_cash": 10000,
                                                          "idempotency_key": "readiness-account"}).json()["account"]
        yield client, account


def _get(client, account_id):
    response = client.get("/api/trading-agent/readiness", params={"account_id": account_id})
    assert response.status_code == 200, response.text
    return response.json()


def _status(result):
    return {check["id"]: check["status"] for check in result["checks"]}


def _mandate(client, account, **changes):
    response = client.post("/api/agent-automation/mandates", json={
        "name": "Synthetic mandate", "account_id": account["id"], "workflow": {"scope": "market", "candidate_symbols": SYMBOLS},
        "enabled": True, "mode": "auto_simulate", **changes})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def _configure(client, account):
    assert client.put(f"/api/paper/accounts/{account['id']}/circuit-breakers", json={
        "policy": {"daily_loss_limit_pct": 5, "max_drawdown_pct": 15, "max_fills_per_session": 10}, "expected_version": 1}).status_code == 200
    assert client.put(f"/api/paper/accounts/{account['id']}/position-stops", json={
        "policy": {"enabled": True, "stop_loss_pct": 10, "cooldown_sessions": 3}, "expected_version": 0}).status_code == 200


def _snapshots(account_id, count, complete=True):
    days = sessions.expected_sessions("2023-10-01", DAY1)[-count:]
    with store.connect() as db:
        for day in days:
            db.execute("""INSERT INTO paper_nav_snapshots(account_id,as_of,account_version,input_revision,engine_version,observed_at,snapshot_json)
                VALUES (?,?,1,'synthetic:1',?,?,?)""", (account_id, day, analytics.ENGINE_VERSION, "2024-01-06T00:00:00Z",
                                                        json.dumps({"as_of": day, "valuation_complete": complete, "equity": 10000 if complete else None})))
    return days


def _decisions(count=20, *, rising=True):
    """One settled long rule-workflow decision per session on the 10-session horizon, all hits (rising) or all misses."""
    history = sessions.expected_sessions("2023-10-01", DAY1)[-(count + 12):-1]
    with store.connect() as db:
        for index, day in enumerate(history):
            price = 100 + index if rising else 200 - index
            db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTA',?,?,?,?,?,?,1000)", (day, price, price + 1, price - 1, price, price))
        for index, day in enumerate(history[:count]):
            result = {"request": {"scope": "market"}, "target_weights": [{"symbol": "SYNTA", "weight_pct": index + 1}]}
            db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)",
                       (f"run-{index}", "synthetic", "alphaview-agent-workflow-v1", day, "synthetic", "proposed", "{}", json.dumps(result)))


def _check(result, identifier):
    return next(check for check in result["checks"] if check["id"] == identifier)


def _attempt(account_id, mandate, status, session):
    with store.connect() as db:
        db.execute("""INSERT INTO agent_automation_attempts(id,mandate_id,session_date,mandate_version,account_id,account_version,mode,trigger_kind,
            status,started_at,finished_at,run_id,engine_version,input_revision) VALUES (?,?,?,?,?,1,'auto_simulate','scheduled',?,?,?,?,?,?)""",
                   (uuid.uuid4().hex, mandate["id"], session, mandate["version"], account_id, status, f"{session}T00:00:00Z",
                    f"{session}T00:00:01Z", uuid.uuid4().hex, automation.ENGINE_VERSION, "synthetic:1"))


def test_fresh_account_is_not_ready_and_lists_every_missing_piece(workspace):
    client, account = workspace
    revision = store.input_revision()
    result = _get(client, account["id"])
    assert result["engine_version"] == readiness.ENGINE_VERSION and result["overall"] == "not_ready"
    assert result["as_of"] == DAY1 and result["input_revision"] == revision and result["execution_target"] is None
    status = _status(result)
    assert status == {"mandate_active": "fail", "jev_gate_declared": "unavailable", "circuit_breakers_configured": "fail",
                      "position_stops_enabled": "fail", "alpaca_paper_orders": "unavailable", "no_stale_unknown_orders": "pass",
                      "recent_attempts_clean": "unavailable", "nav_snapshot_current": "fail", "history_sessions": "fail",
                      "account_not_paused": "pass", "no_tripped_breaker": "pass", "schema_current": "pass",
                      "position_stops_evaluable": "not_applicable", "regime_overlay_configured": "not_applicable",
                      "corporate_actions_clear": "pass", "outcome_hit_rate": "unavailable", "broker_book_reconciled": "unavailable"}
    history = next(check for check in result["checks"] if check["id"] == "history_sessions")
    assert history["observed"] == 0 and history["required"] == readiness.REQUIRED_HISTORY_SESSIONS
    assert _check(result, "outcome_hit_rate")["reason_code"] == "insufficient_settled"
    assert _check(result, "regime_overlay_configured")["reason_code"] == "overlay_disabled"
    assert result["summary"] == {"pass": 5, "fail": 5, "unavailable": 5, "not_applicable": 2}
    assert json.dumps(result, allow_nan=False) and store.input_revision() == revision
    assert client.get("/api/trading-agent/readiness", params={"account_id": "missing"}).status_code == 404
    assert client.get("/api/trading-agent/readiness").status_code == 422


def test_fully_configured_paper_ledger_account_is_paper_ready_never_live(workspace):
    client, account = workspace
    mandate = _mandate(client, account)
    _configure(client, account)
    _snapshots(account["id"], readiness.REQUIRED_HISTORY_SESSIONS)
    _attempt(account["id"], mandate, "simulated", DAY1)
    _decisions(rising=True)
    result = _get(client, account["id"])
    assert result["overall"] == "paper_ready" and result["execution_target"] == "paper_ledger"
    outcome = _check(result, "outcome_hit_rate")
    assert outcome["status"] == "pass" and "agent_targets: settled=20, hit_rate=1.0" in outcome["observed"]
    status = _status(result)
    assert status["alpaca_paper_orders"] == "not_applicable" and status["jev_gate_declared"] == "pass"
    assert status["broker_book_reconciled"] == "not_applicable"
    assert all(value in ("pass", "not_applicable") for value in status.values()), status
    assert next(check for check in result["checks"] if check["id"] == "jev_gate_declared")["observed"] == "declined"
    assert "live" not in result["overall"] and "live_ready" in result["method"]
    # One failed attempt among the recent five flips the gate back.
    _attempt(account["id"], mandate, "failed", "2024-01-04")
    again = _get(client, account["id"])
    assert again["overall"] == "not_ready" and _status(again)["recent_attempts_clean"] == "fail"


def test_incomplete_snapshots_do_not_count_and_short_history_fails(workspace):
    client, account = workspace
    _snapshots(account["id"], 5, complete=False)
    result = _get(client, account["id"])
    status = _status(result)
    assert status["nav_snapshot_current"] == "fail" and status["history_sessions"] == "fail"
    assert next(check for check in result["checks"] if check["id"] == "history_sessions")["observed"] == 0


def test_paused_account_or_tripped_breaker_is_blocked(workspace, monkeypatch):
    client, account = workspace
    paused = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"], "kill_switch": True})
    assert paused.status_code == 200
    result = _get(client, account["id"])
    assert result["overall"] == "blocked" and _status(result)["account_not_paused"] == "fail"
    resumed = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": paused.json()["account"]["version"], "kill_switch": False})
    assert resumed.status_code == 200
    tripped = {"engine_version": breakers.ENGINE_VERSION, "account_id": account["id"], "account_version": 3, "kill_switch": False, "as_of": DAY1,
               "policy": breakers.Policy().model_dump(), "policy_version": 1, "checks": [], "tripped": True, "tripped_codes": ["daily_loss"],
               "unavailable": [], "valuation_complete": True}
    monkeypatch.setattr(breakers, "evaluate", lambda db, account_id, as_of: tripped)
    result = _get(client, account["id"])
    assert result["overall"] == "blocked" and _status(result)["no_tripped_breaker"] == "fail"
    assert next(check for check in result["checks"] if check["id"] == "no_tripped_breaker")["observed"] == "tripped: daily_loss"


def test_alpaca_target_without_connection_fails_and_stale_unknown_orders_fail(workspace):
    client, account = workspace
    _mandate(client, account, execution_target="alpaca_paper")
    with store.connect() as db:
        db.execute("""INSERT INTO execution_submissions(id,account_id,proposal_id,target,status,idempotency_key,request_hash,engine_version,
            as_of,input_revision,account_version,created_at,updated_at,summary_json) VALUES ('sub1',?,'prop1','alpaca_paper','unknown','k1','h1','x',
            '2024-01-04','synthetic:1',1,'2024-01-04T00:00:00Z','2024-01-04T00:00:00Z','{}')""", (account["id"],))
        db.execute("""INSERT INTO execution_orders(id,submission_id,account_id,proposal_id,sequence,symbol,side,qty,order_type,time_in_force,
            reference_price,reference_notional,client_order_id,status) VALUES ('ord1','sub1',?,'prop1',1,'SYNTA','buy','1','market','day','100','100','c1','unknown')""",
                   (account["id"],))
    result = _get(client, account["id"])
    status = _status(result)
    assert result["execution_target"] == "alpaca_paper" and status["alpaca_paper_orders"] == "fail"
    alpaca = next(check for check in result["checks"] if check["id"] == "alpaca_paper_orders")
    assert alpaca["reason_code"] == "not_configured" and alpaca["observed"] == "not configured"
    assert status["no_stale_unknown_orders"] == "fail"
    assert next(check for check in result["checks"] if check["id"] == "no_stale_unknown_orders")["observed"] == 1
    assert result["overall"] == "not_ready"


def test_v2_checks_cover_overlay_corporate_actions_stops_and_outcome_hit_rate(workspace, monkeypatch):
    client, account = workspace
    # Stops enabled with a holding that has no current price: the stop cannot be evaluated for that symbol.
    _configure(client, account)
    proposal = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={
        "expected_version": account["version"], "targets": [{"symbol": "SYNTA", "weight_pct": 30}], "idempotency_key": "readiness-buy"}).json()
    assert client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept", json={
        "expected_version": account["version"], "idempotency_key": "readiness-buy-accept"}).status_code == 200
    held = _get(client, account["id"])
    assert _check(held, "position_stops_evaluable")["status"] == "pass"
    assert _check(held, "corporate_actions_clear")["status"] == "pass"
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTA' AND date=?", (DAY1,))
    unpriced = _get(client, account["id"])
    stops = _check(unpriced, "position_stops_evaluable")
    assert stops["status"] == "fail" and stops["observed"] == "SYNTA" and stops["reason_code"] == "stops_unavailable"
    # Overlay: enabled but incomplete regime fails closed; a computable cap passes.
    def overlay(cap_status):
        ok = cap_status == "ok"
        return lambda db, account_id, as_of: {
            "policy": {"enabled": True, "mode": "block"},
            "cap": {"status": cap_status, "cap_pct": 60.0 if ok else None, "reason": None if ok else "regime_incomplete"},
            "regime": {"zone": "elevated" if ok else None, "score": 55.0 if ok else None, "complete": ok}}
    monkeypatch.setattr(readiness.regime_overlay, "evaluate", overlay("unavailable"))
    failing = _check(_get(client, account["id"]), "regime_overlay_configured")
    assert failing["status"] == "fail" and failing["reason_code"] == "regime_cap_unavailable" and "cap_status=unavailable" in failing["observed"]
    monkeypatch.setattr(readiness.regime_overlay, "evaluate", overlay("ok"))
    assert _check(_get(client, account["id"]), "regime_overlay_configured")["status"] == "pass"
    # Corporate actions: a suspected split since entry with a possibly mixed basis fails; entry unknown everywhere is unavailable.
    flagged = {"holdings": [{"symbol": "SYNTA", "status": "events_since_entry", "entry_session": "2024-01-02"}], "flagged": ["SYNTA"],
               "entry_unknown": [], "events": [{"symbol": "SYNTA", "ex_date": "2024-01-03", "kind": "suspected_split", "since_entry": True,
                                                "data_consistency": {"flag": "possible_mixed_basis", "message": "synthetic"}}]}
    monkeypatch.setattr(readiness.corporate_actions, "account_summary", lambda db, account_id, as_of: flagged)
    corporate = _check(_get(client, account["id"]), "corporate_actions_clear")
    assert corporate["status"] == "fail" and corporate["observed"] == "SYNTA" and corporate["reason_code"] == "mixed_basis_flag"
    unknown = {"holdings": [{"symbol": "SYNTA", "status": "entry_unknown", "entry_session": None}], "flagged": [], "entry_unknown": ["SYNTA"],
               "events": [{"symbol": "SYNTA", "ex_date": "2024-01-03", "kind": "dividend", "since_entry": False, "data_consistency": None}]}
    monkeypatch.setattr(readiness.corporate_actions, "account_summary", lambda db, account_id, as_of: unknown)
    assert _check(_get(client, account["id"]), "corporate_actions_clear")["reason_code"] == "entry_unknown"
    # Outcome hit rate: settled decisions below 20 stay unavailable; 20 settled misses fail without blocking.
    _decisions(count=5, rising=False)
    few = _check(_get(client, account["id"]), "outcome_hit_rate")
    assert few["status"] == "unavailable" and few["reason_code"] == "insufficient_settled" and "agent_targets: settled=5, hit_rate=0.0" in few["observed"]
    with store.connect() as db:
        db.execute("DELETE FROM portfolio_agent_runs")
    _decisions(count=20, rising=False)
    revision = store.input_revision()
    result = _get(client, account["id"])
    low = _check(result, "outcome_hit_rate")
    assert low["status"] == "fail" and low["reason_code"] == "hit_rate_low" and "agent_targets 最近 20 筆已結算決策命中率 0%" in low["reason"]
    assert result["overall"] == "not_ready" and store.input_revision() == revision
    json.dumps(result, allow_nan=False)
