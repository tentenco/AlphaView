"""Synthetic once-per-session local Agent automation and source-bound paper actions."""
import json
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation
from alphaview.panel import rebalance_trigger
from alphaview.panel import paper_analytics, paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "automation.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        paper_analytics.init_schema(db)
        agent.init_schema(db)
        automation.init_schema(db)
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
    app = FastAPI()
    app.include_router(automation.router)
    app.include_router(paper.router)
    with TestClient(app) as result:
        yield result


def account(client, suffix="one", **kwargs):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic account", "initial_cash": 10000,
                           "idempotency_key": "synthetic-account-" + suffix, **kwargs})
    assert response.status_code == 200
    return response.json()["account"]


def workflow():
    return {"scope": "market", "candidate_symbols": SYMBOLS}


def create(client, **kwargs):
    account_id = kwargs.pop("account_id", None) or account(client)["id"]
    response = client.post("/api/agent-automation/mandates", json={"name": "Synthetic mandate", "account_id": account_id,
                           "workflow": workflow(), **kwargs})
    assert response.status_code == 201, response.text
    return response.json()["mandate"]


def seed_scan(*, as_of=AS_OF, missing=False, matched=True):
    rows = [{"symbol": symbol, "date": as_of, "bars": 240, "indicators": {"close": 100},
             "signals": [{"strategy": strategy, "status": "match" if matched and index < 2 else "watch",
                          "matched": matched and index < 2, "reason": "Synthetic rule"}
                         for index, strategy in enumerate(agent.STRATEGY_IDS) if not (missing and symbol == "SYNTA" and strategy == "rps")]}
            for symbol in SYMBOLS]
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (as_of, json.dumps(SYMBOLS), json.dumps(rows), scan_provenance.current_token(db)))


def counts():
    with store.connect() as db:
        return {"attempts": db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0],
                "runs": db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0],
                "proposals": db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0],
                "fills": db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0],
                "nav": db.execute("SELECT count(*) FROM paper_nav_snapshots").fetchone()[0]}


def manual(client, mandate, allow=False):
    return client.post(f"/api/agent-automation/mandates/{mandate['id']}/run",
                       json={"expected_version": mandate["version"], "allow_auto_simulate": allow})


def update(client, mandate, **changes):
    return client.patch(f"/api/agent-automation/mandates/{mandate['id']}",
                        json={"expected_version": mandate["version"], **changes})


def test_disabled_default_readonly_state_and_optimistic_edit(client):
    mandate = create(client)
    assert mandate["enabled"] is False and mandate["mode"] == "proposal_only"
    assert mandate["status"] == "disabled" and mandate["next_due_at"] is None
    before = store.input_revision()
    with patch.object(automation, "init_schema", side_effect=AssertionError("Read created schema")):
        state = client.get("/api/agent-automation/state").json()
        assert state["mandates"][0]["id"] == mandate["id"]
        assert client.get(f"/api/agent-automation/mandates/{mandate['id']}/attempts").json()["attempts"] == []
    assert automation.tick()["status"] == "disabled"
    changed = update(client, mandate, enabled=True)
    assert changed.status_code == 200 and changed.json()["mandate"]["version"] == 2
    assert update(client, mandate, name="Conflicting rename").status_code == 409
    assert manual(client, mandate).status_code == 409
    assert store.input_revision() == before
    assert counts() == {"attempts": 0, "runs": 0, "proposals": 0, "fills": 0, "nav": 0}
    assert json.dumps(state, allow_nan=False)


def test_one_enabled_mandate_per_account_prevents_competing_automation(client):
    first = create(client, enabled=True)
    second = create(client, account_id=first["account_id"])
    assert update(client, second, enabled=True).status_code == 409
    response = client.post("/api/agent-automation/mandates", json={"name": "Competing", "account_id": first["account_id"],
                           "workflow": workflow(), "enabled": True})
    assert response.status_code == 409
    assert update(client, first, enabled=False).status_code == 200
    assert update(client, second, enabled=True).status_code == 200


@pytest.mark.parametrize("changes", [{"enabled": "true"}, {"mode": "live_trade"}, {"name": "   "},
                                     {"workflow": {"candidate_symbols": []}}, {"extra": True}])
def test_create_validation(client, changes):
    account_id = account(client)["id"]
    assert client.post("/api/agent-automation/mandates", json={"name": "Synthetic", "account_id": account_id,
                       "workflow": workflow(), **changes}).status_code == 422


@pytest.mark.parametrize("changes", [{}, {"enabled": None}, {"mode": None}, {"workflow": None}, {"name": "  "}])
def test_patch_requires_real_valid_changes(client, changes):
    mandate = create(client)
    assert update(client, mandate, **changes).status_code == 422


def test_waiting_does_not_consume_session_then_ready_claims_once(client):
    mandate = create(client, enabled=True)
    assert automation.tick()["results"][0]["status"] == "waiting"
    assert counts()["attempts"] == 0
    detail = client.get(f"/api/agent-automation/mandates/{mandate['id']}").json()["mandate"]
    assert detail["status"] == "waiting" and detail["last_checked_at"]
    assert detail["next_due_at"] == "2024-01-05T01:01:00+00:00"
    seed_scan()
    before = store.input_revision()
    result = automation.tick()["results"][0]
    assert result["status"] == "proposed"
    assert result["attempt"]["result"]["nav_capture"]["status"] == "captured"
    assert automation.tick()["results"][0]["status"] == "already_attempted"
    assert manual(client, mandate).json()["status"] == "already_attempted"
    assert counts() == {"attempts": 1, "runs": 1, "proposals": 1, "fills": 0, "nav": 1}
    assert store.input_revision() == before
    detail = client.get(f"/api/agent-automation/mandates/{mandate['id']}").json()["mandate"]
    assert detail["next_due_at"] == "2024-01-05T21:15:00+00:00"
    assert "result_json" not in detail["last_attempt"]


def test_incomplete_candidate_or_paper_quotes_wait_without_claim(client):
    create(client, enabled=True)
    seed_scan(missing=True)
    assert automation.tick()["results"][0]["status"] == "waiting"
    with store.connect() as db:
        db.execute("UPDATE datasets SET currency=NULL WHERE symbol='SYNTA'")
    seed_scan()
    assert automation.tick()["results"][0]["status"] == "waiting"
    assert counts()["attempts"] == 0
    with store.connect() as db:
        db.execute("UPDATE datasets SET currency='USD'")
    seed_scan()
    assert automation.tick()["results"][0]["status"] == "proposed"


def test_complete_no_signal_is_blocked_without_liquidation(client):
    create(client, enabled=True, mode="auto_simulate")
    seed_scan(matched=False)
    result = automation.tick()["results"][0]
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "agent_blocked"
    assert counts() == {"attempts": 1, "runs": 1, "proposals": 0, "fills": 0, "nav": 1}
    assert automation.tick()["results"][0]["status"] == "already_attempted"


@pytest.mark.parametrize("manual_trigger,allow,expected", [(False, False, "simulated"), (True, False, "proposed"), (True, True, "simulated")])
def test_auto_simulation_requires_explicit_mode_and_manual_opt_in(client, manual_trigger, allow, expected):
    mandate = create(client, enabled=not manual_trigger, mode="auto_simulate")
    seed_scan()
    result = manual(client, mandate, allow).json() if manual_trigger else automation.tick()["results"][0]
    assert result["status"] == expected
    assert result["attempt"]["mode"] == ("auto_simulate" if expected == "simulated" else "proposal_only")
    assert counts()["fills"] == (2 if expected == "simulated" else 0)
    assert counts()["nav"] == 1
    assert result["attempt"]["result"]["nav_capture"]["valuation_complete"]
    snapshot = paper.account_snapshot(mandate["account_id"])
    assert snapshot["account"]["version"] == (2 if expected == "simulated" else 1)


def test_paper_risk_constraints_override_auto_simulation(client):
    account_id = account(client, limits={"max_position_weight_pct": 10})["id"]
    create(client, account_id=account_id, enabled=True, mode="auto_simulate")
    seed_scan()
    result = automation.tick()["results"][0]
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "paper_risk_blocked"
    assert counts()["fills"] == 0 and counts()["proposals"] == 1


def test_kill_switch_waits_without_claim_then_resumes(client, monkeypatch):
    mandate = create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    # A paused-only account with valid mandate authority still waits without a daily claim.
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET kill_switch=1 WHERE id=?", (mandate["account_id"],))
    with patch.object(agent, "preview", side_effect=AssertionError("Paused account reached research")):
        assert automation.tick()["results"][0]["status"] == "paused"
    assert counts() == {"attempts": 0, "runs": 0, "proposals": 0, "fills": 0, "nav": 0}
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET kill_switch=0 WHERE id=?", (mandate["account_id"],))
    paper.update_controls(mandate["account_id"], paper.ControlsInput(expected_version=1, kill_switch=True))
    with patch.object(agent, "preview", side_effect=AssertionError("Revoked mandate reached research")):
        blocked = automation.tick()["results"][0]
    assert blocked["status"] == "blocked" and blocked["attempt"]["reason_code"] == "mandate_reauth_required"
    assert counts() == {"attempts": 1, "runs": 0, "proposals": 0, "fills": 0, "nav": 0}
    paper.update_controls(mandate["account_id"], paper.ControlsInput(expected_version=2, kill_switch=False))
    # A manual pause revokes the standing authority; resuming the account is not enough, a human renews the mandate.
    flagged = client.get(f"/api/agent-automation/mandates/{mandate['id']}").json()["mandate"]
    assert flagged["reauth_required"] and flagged["lifecycle"] == "reauth_required" and flagged["reauth_reason"] == "kill_switch_enabled"
    renewed = client.post(f"/api/paper/accounts/{mandate['account_id']}/mandates/{mandate['id']}/renew",
                          json={"expected_version": flagged["version"], "acknowledge": True})
    assert renewed.status_code == 200 and not renewed.json()["mandate"]["reauth_required"]
    retry = automation.tick()["results"][0]
    assert retry["status"] == "already_attempted" and retry["attempt"]["id"] == blocked["attempt"]["id"]
    assert counts()["attempts"] == 1
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: "2024-01-05")
    with store.connect() as db:
        db.executemany("INSERT INTO bars VALUES (?,'2024-01-05',100,110,90,100,100,1000)", [(symbol,) for symbol in SYMBOLS])
    seed_scan(as_of="2024-01-05")
    assert automation.tick()["results"][0]["status"] == "simulated"
    assert counts() == {"attempts": 2, "runs": 1, "proposals": 1, "fills": 2, "nav": 1}


def test_latest_session_only_no_catchup_and_edits_cannot_repeat_same_session(client, monkeypatch):
    mandate = create(client, enabled=True)
    seed_scan()
    assert automation.tick()["results"][0]["status"] == "proposed"
    changed = update(client, mandate, name="Revised synthetic mandate").json()["mandate"]
    assert changed["current_attempt"]["status"] == "invalidated"
    assert automation.tick()["results"][0]["status"] == "already_attempted"
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: "2024-01-09")
    with store.connect() as db:
        db.executemany("INSERT INTO bars VALUES (?,'2024-01-09',100,110,90,100,100,1000)", [(symbol,) for symbol in SYMBOLS])
    seed_scan(as_of="2024-01-09")
    assert automation.tick()["results"][0]["status"] == "proposed"
    with store.connect() as db:
        assert [row[0] for row in db.execute("SELECT session_date FROM agent_automation_attempts ORDER BY session_date")] == [AS_OF, "2024-01-09"]


def test_changed_mandate_invalidates_later_manual_paper_acceptance(client):
    mandate = create(client, enabled=True)
    seed_scan()
    result = automation.tick()["results"][0]
    proposal_id = result["attempt"]["paper_proposal_id"]
    assert update(client, mandate, enabled=False).status_code == 200
    with pytest.raises(HTTPException) as error:
        paper.accept_proposal(mandate["account_id"], proposal_id,
                              paper.AcceptInput(expected_version=1, idempotency_key="synthetic-manual-accept"))
    assert error.value.status_code == 409
    assert counts()["fills"] == 0


def test_unchanged_manual_proposal_from_disabled_mandate_can_be_accepted(client):
    mandate = create(client)
    seed_scan()
    result = manual(client, mandate).json()
    accepted = paper.accept_proposal(mandate["account_id"], result["attempt"]["paper_proposal_id"],
                                     paper.AcceptInput(expected_version=1, idempotency_key="synthetic-manual-accept"))
    assert accepted["proposal"]["status"] == "simulated"


@pytest.mark.parametrize("phase", ["proposal", "accept"])
def test_mandate_edit_inside_execution_is_rechecked_in_paper_write_transaction(client, monkeypatch, phase):
    mandate = create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    name = "create_proposal_guarded" if phase == "proposal" else "accept_proposal_guarded"
    original = getattr(paper, name)
    def changed(*args, **kwargs):
        automation.update_mandate(mandate["id"], automation.MandatePatch(expected_version=1, enabled=False))
        return original(*args, **kwargs)
    monkeypatch.setattr(paper, name, changed)
    result = automation.tick()["results"][0]
    assert result["status"] == "invalidated"
    assert counts()["fills"] == 0
    assert counts()["proposals"] == (0 if phase == "proposal" else 1)


def test_account_change_before_auto_acceptance_blocks_fill(client, monkeypatch):
    mandate = create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    original = paper.accept_proposal_guarded
    def changed(*args, **kwargs):
        paper.update_controls(mandate["account_id"], paper.ControlsInput(expected_version=1, kill_switch=True))
        return original(*args, **kwargs)
    monkeypatch.setattr(paper, "accept_proposal_guarded", changed)
    result = automation.tick()["results"][0]
    assert result["status"] == "invalidated" and counts()["fills"] == 0


def test_source_change_before_claim_does_not_consume_attempt(client, monkeypatch):
    create(client, enabled=True)
    seed_scan()
    original = automation._ready
    def changed(*args):
        result = original(*args)
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1")
        return result
    monkeypatch.setattr(automation, "_ready", changed)
    assert automation.tick()["results"][0]["status"] == "waiting"
    assert counts()["attempts"] == 0 and counts()["runs"] == 0


def test_multiple_workers_cannot_duplicate_session_claim(client):
    create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    gate = threading.Barrier(2)
    def run():
        gate.wait()
        return automation.tick()
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: run(), range(2)))
    assert sum(any(item["status"] == "simulated" for item in result["results"]) for result in results) == 1
    assert counts()["attempts"] == 1 and counts()["fills"] == 2


def test_automation_lock_is_cross_process_and_separate_from_refresh_lock(client):
    from alphaview.panel import jobs
    code = "from alphaview.panel.agent_automation import RUN_LOCK; print(RUN_LOCK.acquire(blocking=False))"
    assert automation.RUN_LOCK.acquire(blocking=False)
    try:
        child = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        assert child.stdout.strip() == "False"
        assert jobs.RUN_LOCK.acquire(blocking=False)
        jobs.RUN_LOCK.release()
    finally:
        automation.RUN_LOCK.release()
    child = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert child.stdout.strip() == "True"


class SyntheticCrash(BaseException):
    pass


@pytest.mark.parametrize("phase", ["before_proposal", "after_proposal", "after_accept"])
def test_crash_recovery_preserves_durable_outcome_and_never_retries_session(client, monkeypatch, phase):
    create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    name = "accept_proposal_guarded" if phase == "after_accept" else "create_proposal_guarded"
    original = getattr(paper, name)
    def crash(*args, **kwargs):
        if phase != "before_proposal":
            original(*args, **kwargs)
        raise SyntheticCrash("Synthetic process termination")
    monkeypatch.setattr(paper, name, crash)
    with pytest.raises(SyntheticCrash):
        automation.tick()
    assert not automation.RUN_LOCK.locked()
    monkeypatch.setattr(paper, name, original)
    result = automation.tick()["results"][0]
    assert result["status"] == "already_attempted"
    attempt = result["attempt"]
    assert attempt["status"] == ("simulated" if phase == "after_accept" else "interrupted")
    assert bool(attempt["paper_proposal_id"]) == (phase != "before_proposal")
    assert counts()["attempts"] == 1 and counts()["runs"] == 1
    assert counts()["fills"] == (2 if phase == "after_accept" else 0)


def test_post_fill_configuration_change_cannot_hide_completed_simulation(client, monkeypatch):
    mandate = create(client, enabled=True, mode="auto_simulate")
    seed_scan()
    original = paper.accept_proposal_guarded
    def changed(*args, **kwargs):
        result = original(*args, **kwargs)
        automation.update_mandate(mandate["id"], automation.MandatePatch(expected_version=1, enabled=False))
        return result
    monkeypatch.setattr(paper, "accept_proposal_guarded", changed)
    result = automation.tick()["results"][0]
    assert result["status"] == "simulated" and counts()["fills"] == 2


def test_nav_capture_failure_does_not_undo_completed_proposal(client, monkeypatch):
    create(client, enabled=True)
    seed_scan()
    monkeypatch.setattr(paper_analytics, "capture_nav", lambda *args: (_ for _ in ()).throw(HTTPException(409, "Synthetic quote changed")))
    result = automation.tick()["results"][0]
    assert result["status"] == "proposed"
    assert result["attempt"]["result"]["nav_capture"] == {"status": "unavailable", "reason": "Synthetic quote changed"}
    assert counts()["proposals"] == 1


def test_stop_signal_prevents_claim_and_scheduler_lifecycle(client):
    create(client, enabled=True)
    seed_scan()
    assert automation.tick(stopping=lambda: True)["status"] == "stopped"
    assert counts()["attempts"] == 0
    event = threading.Event()
    with patch.object(automation, "tick", side_effect=lambda *args, **kwargs: event.set()):
        scheduler = automation.Scheduler(interval=0.01).start()
        assert event.wait(2)
        with pytest.raises(RuntimeError):
            scheduler.start()
        scheduler.stop()
        assert not scheduler._thread.is_alive()


def test_manual_paper_acceptance_is_visible_in_attempt_and_reconciles_nav(client):
    mandate = create(client, enabled=True)
    seed_scan()
    proposal = automation.tick()["results"][0]["attempt"]
    paper.accept_proposal(mandate["account_id"], proposal["paper_proposal_id"],
                          paper.AcceptInput(expected_version=1, idempotency_key="synthetic-later-accept"))
    detail = client.get(f"/api/agent-automation/mandates/{mandate['id']}").json()["mandate"]
    assert detail["status"] == "simulated" and detail["current_attempt"]["paper_status"] == "simulated"
    assert automation.tick()["results"][0]["attempt"]["status"] == "simulated"
    assert counts()["nav"] == 2


def policy(drift=None, cooldown=None, regime=None):
    # The regime gate is optional in requests and always present (default off) in stored/public policies.
    return {"min_weight_drift_pp": drift, "min_completed_sessions_between_fills": cooldown,
            "regime_change": regime or {"enabled": False, "min_band_change": 1}}


def advance_session(monkeypatch, day):
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: day)
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, day))
    seed_scan(as_of=day)


def test_trigger_default_and_full_nested_patch_contract(client):
    mandate = create(client)
    assert mandate["rebalance_trigger"] == policy()
    changed = update(client, mandate, rebalance_trigger=policy(5, 2)).json()["mandate"]
    assert changed["rebalance_trigger"] == policy(5, 2) and changed["version"] == 2
    for invalid in ({}, {"min_weight_drift_pp": 2}, {"min_completed_sessions_between_fills": 1}, None,
                    policy(True), policy(cooldown=1.5), policy("5"), policy(cooldown="2")):
        assert update(client, changed, rebalance_trigger=invalid).status_code == 422
    restored = update(client, changed, rebalance_trigger=policy()).json()["mandate"]
    assert restored["rebalance_trigger"] == policy()


def test_unmet_drift_is_atomic_skipped_trace_without_proposal_and_consumes_session(client):
    mandate = create(client, enabled=True, mode="auto_simulate", rebalance_trigger=policy(100))
    seed_scan()
    before = store.input_revision()
    result = automation.tick()["results"][0]
    assert result["status"] == "skipped"
    attempt = result["attempt"]
    assert attempt["engine_version"] == "alphaview-agent-automation-v3"
    assert attempt["paper_proposal_id"] is None and attempt["finished_at"]
    evidence = attempt["result"]["rebalance_trigger"]
    assert evidence["outcome"] == "skip" and evidence["reason_codes"] == ["drift_below_threshold"]
    assert evidence["engine_version"] == "alphaview-rebalance-trigger-v1"
    assert counts() == {"attempts": 1, "runs": 1, "proposals": 0, "fills": 0, "nav": 1}
    assert manual(client, mandate, allow=True).json()["status"] == "already_attempted"
    edited = update(client, mandate, rebalance_trigger=policy(0)).json()["mandate"]
    assert manual(client, edited, allow=True).json()["status"] == "already_attempted"
    assert store.input_revision() == before
    json.dumps(result, allow_nan=False)


def test_skipped_source_and_changed_targets_cannot_authorize_manually_assembled_proposal(client):
    mandate = create(client, rebalance_trigger=policy(100))
    seed_scan()
    attempt = manual(client, mandate).json()["attempt"]
    body = {"expected_version": 1, "targets": [{"symbol": "SYNTA", "weight_pct": 20}],
            "idempotency_key": "synthetic-skipped-bypass", "automation_source": {
                "mandate_id": mandate["id"], "mandate_version": 1, "attempt_id": attempt["id"]}}
    response = client.post(f"/api/paper/accounts/{mandate['account_id']}/proposals", json=body)
    assert response.status_code == 409 and counts()["proposals"] == 0


def test_passed_source_is_bound_to_exact_rules_targets_and_account_version(client):
    mandate = create(client, rebalance_trigger=policy(0))
    seed_scan()
    attempt = manual(client, mandate).json()["attempt"]
    body = {"expected_version": 1, "targets": [{"symbol": "SYNTA", "weight_pct": 20}],
            "idempotency_key": "synthetic-altered-targets", "automation_source": {
                "mandate_id": mandate["id"], "mandate_version": 1, "attempt_id": attempt["id"]}}
    response = client.post(f"/api/paper/accounts/{mandate['account_id']}/proposals", json=body)
    assert response.status_code == 409
    with store.connect() as db:
        run = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (attempt["run_id"],)).fetchone()[0])
    body["targets"] = run["target_weights"]
    paper.update_controls(mandate["account_id"], paper.ControlsInput(expected_version=1, kill_switch=False))
    body["expected_version"] = 2
    response = client.post(f"/api/paper/accounts/{mandate['account_id']}/proposals", json=body)
    assert response.status_code == 409 and counts()["proposals"] == 1


def test_risk_blocked_result_is_not_hidden_by_unmet_gate(client):
    identifier = account(client, limits={"max_position_weight_pct": 1, "min_cash_weight_pct": 0,
                                       "max_turnover_pct": 200})["id"]
    create(client, account_id=identifier, enabled=True, rebalance_trigger=policy(100))
    seed_scan()
    result = automation.tick()["results"][0]
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "paper_risk_blocked"
    assert result["attempt"]["result"]["rebalance_trigger"]["outcome"] == "blocked"
    assert result["attempt"]["result"]["violations"]
    assert counts()["proposals"] == counts()["fills"] == 0


def test_nonpositive_equity_and_missing_held_quote_wait_without_claim(client):
    mandate = create(client, enabled=True, rebalance_trigger=policy(1))
    seed_scan()
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET cash='0' WHERE id=?", (mandate["account_id"],))
    assert automation.tick()["results"][0]["status"] == "waiting"
    assert counts()["attempts"] == 0
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET cash='9000' WHERE id=?", (mandate["account_id"],))
        db.execute("INSERT INTO paper_holdings VALUES (?,'MISSING','1','100')", (mandate["account_id"],))
    assert automation.tick()["results"][0]["status"] == "waiting"
    assert counts()["attempts"] == 0


def test_no_order_policy_skips_only_when_trigger_enabled(client):
    identifier = account(client, execution_policy={"min_trade_notional": 100000})["id"]
    mandate = create(client, account_id=identifier, rebalance_trigger=policy(0))
    seed_scan()
    result = manual(client, mandate).json()
    assert result["status"] == "skipped" and result["attempt"]["reason_code"] == "no_change"
    assert result["attempt"]["result"]["rebalance_trigger"]["skipped_orders"]
    other = account(client, suffix="disabled-gate", execution_policy={"min_trade_notional": 100000})["id"]
    disabled = create(client, account_id=other)
    result = manual(client, disabled).json()
    assert result["status"] == "proposed"
    assert result["attempt"]["result"]["rebalance_trigger"]["outcome"] == "disabled"


def test_cooldown_observes_later_manual_acceptance_across_mandate_versions(client, monkeypatch):
    mandate = create(client, rebalance_trigger=policy(0, 2))
    seed_scan()
    first = manual(client, mandate).json()["attempt"]
    assert first["result"]["rebalance_trigger"]["last_fill"] is None
    paper.accept_proposal(mandate["account_id"], first["paper_proposal_id"],
                          paper.AcceptInput(expected_version=1, idempotency_key="synthetic-cooldown-later-accept"))
    # Advance without running recovery; the actual durable paper fill is enough.
    advance_session(monkeypatch, "2024-01-05")
    mandate = update(client, mandate, name="Synthetic renamed mandate").json()["mandate"]
    result = manual(client, mandate).json()
    evidence = result["attempt"]["result"]["rebalance_trigger"]
    assert result["status"] == "skipped" and "cooldown_active" in evidence["reason_codes"]
    assert evidence["last_fill"]["proposal_id"] == first["paper_proposal_id"]
    assert evidence["completed_sessions_since_last_fill"] == 1


def test_enabled_gates_use_and_and_preserve_evidence_after_auto_simulation(client):
    create(client, enabled=True, mode="auto_simulate", rebalance_trigger=policy(0, 252))
    seed_scan()
    result = automation.tick()["results"][0]
    assert result["status"] == "simulated"
    evidence = result["attempt"]["result"]["rebalance_trigger"]
    assert evidence["outcome"] == "pass" and evidence["completed_sessions_since_last_fill"] is None
    assert all(check["passed"] for check in evidence["checks"])
    assert result["attempt"]["result"]["account_version_after"] == 2


def test_changed_fill_identity_before_claim_waits_without_consuming_session(client, monkeypatch):
    create(client, enabled=True, rebalance_trigger=policy(100))
    seed_scan()
    original = automation._ready
    def changed(*args):
        result = original(*args)
        monkeypatch.setattr(rebalance_trigger, "latest_fill", lambda *args: {
            "proposal_id": "synthetic-concurrent-fill", "execution_session": AS_OF, "recorded_at": "synthetic"})
        return result
    monkeypatch.setattr(automation, "_ready", changed)
    assert automation.tick()["results"][0]["status"] == "changed"
    assert counts()["attempts"] == 0 and counts()["runs"] == 0


def test_legacy_v1_attempt_remains_original_and_accepts_under_original_authority(client):
    mandate = create(client)
    seed_scan()
    attempt = manual(client, mandate).json()["attempt"]
    # Reconstruct the pre-upgrade attempt contract: no trigger evidence existed.
    with store.connect() as db:
        db.execute("UPDATE agent_automation_attempts SET engine_version=?,result_json=NULL WHERE id=?",
                   (automation.LEGACY_ENGINE_VERSION, attempt["id"]))
    accepted = paper.accept_proposal(mandate["account_id"], attempt["paper_proposal_id"],
        paper.AcceptInput(expected_version=1, idempotency_key="synthetic-legacy-accept"))
    assert accepted["proposal"]["status"] == "simulated"
    detail = client.get(f"/api/agent-automation/mandates/{mandate['id']}/attempts").json()["attempts"][0]
    assert detail["engine_version"] == automation.LEGACY_ENGINE_VERSION and detail["result"] is None


def test_policy_change_requires_explicit_workflow_reauthorization(client):
    mandate = create(client, enabled=True, rebalance_trigger=policy(0))
    seed_scan()
    paper.update_controls(mandate["account_id"], paper.ControlsInput(expected_version=1,
        symbol_policy=paper.SymbolPolicy(mode="allowlist", symbols=SYMBOLS)))
    assert automation.tick()["results"][0]["status"] == "waiting" and counts()["attempts"] == 0
    renamed = update(client, mandate, name="Synthetic name only").json()["mandate"]
    assert renamed["symbol_policy_authorization"]["status"] == "stale"
    changed = update(client, renamed, rebalance_trigger=policy(1)).json()["mandate"]
    assert changed["symbol_policy_authorization"]["authorized_policy_version"] == 1
    assert changed["symbol_policy_authorization"]["current_policy"]["version"] == 2
    assert update(client, changed, workflow=workflow()).status_code == 409
    acknowledged = update(client, changed, workflow={**workflow(), "account_context": {
        "account_id": mandate["account_id"], "expected_policy_version": 2}}).json()["mandate"]
    assert acknowledged["symbol_policy_authorization"]["status"] == "current"
    assert manual(client, acknowledged).json()["status"] == "proposed"


def test_rebinding_account_requires_explicit_workflow_policy_context(client):
    mandate = create(client)
    other = account(client, suffix="rebound")
    assert update(client, mandate, account_id=other["id"]).status_code == 422
    rebound = update(client, mandate, account_id=other["id"], workflow={**workflow(), "account_context": {
        "account_id": other["id"], "expected_policy_version": 1}}).json()["mandate"]
    assert rebound["account_id"] == other["id"]


def test_actual_next_open_fill_drives_cooldown_from_execution_session(client, monkeypatch):
    from alphaview.panel import paper_next_open as next_open
    mandate = create(client, rebalance_trigger=policy(0, 2))
    seed_scan()
    attempt = manual(client, mandate).json()["attempt"]
    monkeypatch.setattr(next_open, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    source = next_open.list_orders(mandate["account_id"])["source_proposals"][0]
    queued = next_open.enqueue(mandate["account_id"], next_open.EnqueueInput(
        proposal_id=attempt["paper_proposal_id"], expected_account_version=1,
        expected_proposal_fingerprint=source["proposal_fingerprint"], max_execution_cost_usd=100,
        max_buy_cash_debit_usd=10000, confirm_next_open_simulation=True,
        idempotency_key="synthetic-trigger-queue"))
    assert queued["execution_session"] == "2024-01-05"
    advance_session(monkeypatch, "2024-01-05")
    monkeypatch.setattr(next_open, "utcnow", lambda: datetime(2024, 1, 5, 22, tzinfo=timezone.utc))
    filled = next_open.process_order(mandate["account_id"], queued["id"], next_open.OrderActionInput(
        expected_order_version=queued["version"], idempotency_key="synthetic-trigger-process"))
    assert filled["status"] == "filled"
    advance_session(monkeypatch, "2024-01-08")
    result = manual(client, mandate).json()
    evidence = result["attempt"]["result"]["rebalance_trigger"]
    assert result["status"] == "skipped" and "cooldown_active" in evidence["reason_codes"]
    assert evidence["last_fill"]["queue_order_id"] == queued["id"]
    assert evidence["last_fill"]["proposal_id"] == filled["execution_proposal_id"]
    assert evidence["last_fill"]["execution_session"] == "2024-01-05"
    assert evidence["completed_sessions_since_last_fill"] == 1
    with store.connect() as db:
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (attempt["paper_proposal_id"],)).fetchone()[0] == "proposed"


def test_trigger_schema_upgrade_retains_legacy_rows_and_disabled_default(client):
    mandate = create(client)
    seed_scan()
    first = manual(client, mandate).json()["attempt"]
    with store.connect() as db:
        db.execute("UPDATE agent_automation_attempts SET engine_version=?,result_json=NULL WHERE id=?",
                   (automation.LEGACY_ENGINE_VERSION, first["id"]))
        before = dict(db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (first["id"],)).fetchone())
        db.execute("ALTER TABLE agent_mandates DROP COLUMN rebalance_trigger_json")
        automation.init_schema(db)
        stored = json.loads(db.execute("SELECT rebalance_trigger_json FROM agent_mandates WHERE id=?", (mandate["id"],)).fetchone()[0])
        # Legacy rows keep the two-key column default; the regime gate only appears through normalization (default off).
        assert stored == {"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None}
        assert rebalance_trigger.Policy.model_validate(stored).model_dump() == policy()
        assert dict(db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (first["id"],)).fetchone()) == before
