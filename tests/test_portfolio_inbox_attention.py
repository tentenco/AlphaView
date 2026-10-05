"""Derived operator attention feed in the all-account inbox: synthetic accounts, no storage, sources fail independently."""
import json

from fastapi import HTTPException
import pytest

from alphaview.panel import circuit_breakers, corporate_actions, paper_portfolio as paper, portfolio_inbox as inbox, position_stops, store
from tests.test_portfolio_inbox import proposal, workspace  # noqa: F401  (fixture re-export)

MANDATE = {"id": "synthetic-mandate", "name": "Synthetic task", "account_id": None, "account_name": "Synthetic inbox",
           "enabled": True, "mode": "proposal_only", "version": 1, "status": "pending", "reason": None, "next_due_at": None,
           "last_checked_at": None, "candidate_source": "scan", "last_attempt": None, "updated_at": "2026-09-18T20:00:00+00:00",
           "lifecycle": "expired", "lifecycle_message": "授權已於 2026-09-17 到期", "expires_on": "2026-09-17", "sessions_remaining": 0}


def fake_state(account, lifecycle="expired"):
    mandate = {**MANDATE, "account_id": account["id"], "lifecycle": lifecycle}
    return lambda: {"engine_version": "synthetic", "as_of": "2026-09-18", "input_revision": "x", "mandates": [mandate],
                    "poll_interval_seconds": 60, "method": "", "warnings": []}


def read(client):
    response = client.get("/api/portfolio-agent/inbox")
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def by_kind(value):
    return {item["kind"]: item for item in value["attention"]}


def insert_orders(account_id, proposal_id):
    with store.connect() as db:
        for sid, as_of, status, error, sweep in (("sub-old", "2026-09-17", "unknown", None, None),
                                                 ("sub-new", "2026-09-18", "rejected", {"code": "insufficient_buying_power", "message": "no"},
                                                  {"at": "2026-09-18T21:00:00+00:00", "reason": "kill_switch_enabled",
                                                   "results": [{"submission_id": "sub-new", "action": "cancel_requested"}, {"submission_id": "sub-new", "action": "skipped"}]})):
            db.execute("""INSERT INTO execution_submissions(id,account_id,proposal_id,target,status,idempotency_key,request_hash,engine_version,
                as_of,input_revision,account_version,connection_version,created_at,updated_at,summary_json)
                VALUES (?,?,?,'alpaca_paper','unknown',?,?,?,?,?,1,'c',?,?,?)""",
                       (sid, account_id, proposal_id, f"key-{sid}", "hash", "alphaview-execution-v1", as_of, "rev",
                        f"{as_of}T20:00:00+00:00", f"{as_of}T20:00:00+00:00", json.dumps({"kill_switch_sweep": sweep} if sweep else {})))
            db.execute("""INSERT INTO execution_orders(id,submission_id,account_id,proposal_id,sequence,symbol,side,qty,order_type,time_in_force,
                reference_price,reference_notional,client_order_id,broker_order_id,status,filled_qty,filled_avg_price,submitted_at,last_synced_at,response_json,error_json)
                VALUES (?,?,?,?,1,'SYNTA','buy','10','market','day','100','1000',?,?,?,NULL,NULL,?,?,NULL,?)""",
                       (f"order-{sid}", sid, account_id, proposal_id, f"client-{sid}", f"broker-{sid}", status,
                        f"{as_of}T20:30:00+00:00", f"{as_of}T20:31:00+00:00", json.dumps(error) if error else None))


def test_each_source_becomes_a_keyed_item_with_navigation(workspace, monkeypatch):
    client, account = workspace
    saved = proposal(account)
    monkeypatch.setattr(inbox.agent_automation, "state", fake_state(account, "expired"))
    monkeypatch.setattr(circuit_breakers, "evaluate", lambda db, account_id, as_of: {"tripped": True, "tripped_codes": ["daily_loss"]})
    monkeypatch.setattr(position_stops, "evaluate", lambda db, account_id, as_of: {"tripped": ["SYNTA"], "unavailable": []})
    monkeypatch.setattr(corporate_actions, "account_summary", lambda db, account_id, as_of: {"events": [
        {"symbol": "SYNTA", "ex_date": "2026-09-16", "kind": "suspected_split", "since_entry": True,
         "data_consistency": {"flag": "possible_mixed_basis", "message": "x"}},
        {"symbol": "SYNTA", "ex_date": "2026-09-15", "kind": "dividend", "since_entry": True, "data_consistency": None},
        {"symbol": "SYNTA", "ex_date": "2026-09-01", "kind": "dividend", "since_entry": False}]})
    insert_orders(account["id"], saved["id"])
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=account["version"], kill_switch=True))
    revision = store.input_revision()
    value = read(client)
    items = by_kind(value)
    assert items["mandate_expired"]["severity"] == "critical" and items["mandate_expired"]["navigation"] == {"tab": "automation", "mandate_id": "synthetic-mandate"}
    assert items["account_paused"]["severity"] == "warn" and items["account_paused"]["account_name"] == "Synthetic inbox"
    assert items["circuit_breaker_tripped"]["severity"] == "critical" and items["circuit_breaker_tripped"]["detail"] == "daily_loss"
    assert items["position_stop_tripped"]["severity"] == "warn" and items["position_stop_tripped"]["detail"] == "SYNTA"
    assert items["corporate_action_mixed_basis"]["severity"] == "critical" and items["corporate_action_mixed_basis"]["key"] == f"corporate:{account['id']}:SYNTA:2026-09-16"
    assert items["corporate_action_since_entry"]["severity"] == "info"
    assert not any(item["key"].endswith("2026-09-01") for item in value["attention"])
    assert items["stale_unknown_order"]["severity"] == "critical" and items["stale_unknown_order"]["navigation"] == {"tab": "trading-agent", "proposal_id": saved["id"], "order_id": "order-sub-old"}
    assert items["execution_rejected"]["detail"] == "SYNTA buy 10 · insufficient_buying_power"
    assert items["kill_switch_sweep"]["severity"] == "warn" and "cancel_requested 1" in items["kill_switch_sweep"]["detail"] and "skipped 1" in items["kill_switch_sweep"]["detail"]
    assert value["counts"]["attention_critical"] == 5 and value["counts"]["attention_warn"] == 3 and value["counts"]["attention_total"] == len(value["attention"])
    severities = [inbox.SEVERITY_ORDER[item["severity"]] for item in value["attention"]]
    assert severities == sorted(severities)
    for level in ("critical", "warn", "info"):
        stamps = [item["at"] for item in value["attention"] if item["severity"] == level and item["at"]]
        assert stamps == sorted(stamps, reverse=True)
    assert len({item["key"] for item in value["attention"]}) == len(value["attention"])
    assert read(client)["attention"] == value["attention"]
    assert store.input_revision() == revision
    assert "PRIVATE" not in json.dumps(value)


def test_lifecycle_severities_and_quiet_accounts(workspace, monkeypatch):
    client, account = workspace
    assert read(client)["attention"] == [] and read(client)["counts"]["attention_total"] == 0
    monkeypatch.setattr(inbox.agent_automation, "state", fake_state(account, "expiring_soon"))
    assert by_kind(read(client))["mandate_expiring_soon"]["severity"] == "warn"
    monkeypatch.setattr(inbox.agent_automation, "state", fake_state(account, "reauth_required"))
    assert by_kind(read(client))["mandate_reauth_required"]["severity"] == "critical"
    monkeypatch.setattr(inbox.agent_automation, "state", fake_state(account, "active"))
    assert read(client)["attention"] == []


def test_failing_source_is_reported_without_hiding_the_others(workspace, monkeypatch):
    client, account = workspace
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=account["version"], kill_switch=True))

    def broken(db, account_id, as_of):
        raise HTTPException(503, {"code": "breaker_unavailable", "message": "synthetic failure"})
    monkeypatch.setattr(circuit_breakers, "evaluate", broken)
    monkeypatch.setattr(position_stops, "evaluate", lambda db, account_id, as_of: (_ for _ in ()).throw(KeyError("policy")))
    value = read(client)
    unavailable = [item for item in value["attention"] if item["kind"] == "source_unavailable"]
    assert {item["key"] for item in unavailable} == {"source_unavailable:circuit_breakers", "source_unavailable:position_stops"}
    assert all(item["severity"] == "info" and item["navigation"] is None for item in unavailable)
    assert "synthetic failure" in next(item["detail"] for item in unavailable if item["key"].endswith("circuit_breakers"))
    assert by_kind(value)["account_paused"]["severity"] == "warn"
    assert value["attention"][0]["kind"] == "account_paused" and value["attention"][-1]["kind"] == "source_unavailable"


@pytest.mark.parametrize("lifecycle", ["expired", "reauth_required"])
def test_critical_items_sort_before_warnings_and_newest_first(workspace, monkeypatch, lifecycle):
    client, account = workspace
    saved = proposal(account)
    insert_orders(account["id"], saved["id"])
    monkeypatch.setattr(inbox.agent_automation, "state", fake_state(account, lifecycle))
    value = read(client)
    kinds = [item["kind"] for item in value["attention"]]
    assert kinds[:3] == ["execution_rejected", "stale_unknown_order", f"mandate_{lifecycle}"] or kinds[:3] == ["execution_rejected", f"mandate_{lifecycle}", "stale_unknown_order"]
    assert kinds[3] == "kill_switch_sweep"
