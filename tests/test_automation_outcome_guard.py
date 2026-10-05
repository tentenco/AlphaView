"""Frozen outcome evidence gates unattended execution; synthetic data and fake services only."""
import copy
import json
import sqlite3
from datetime import datetime, timezone

import pytest

from alphaview.panel import agent_automation as automation, decision_ledger, paper_portfolio as paper
from alphaview.panel import execution, sessions, store
from tests.test_automation_outcome_warning import DAY1, account, mandate, run, seed, setup
from tests.test_automation_execution import setup as execution_setup, mandate as execution_mandate
from tests.test_automation_jev import setup as jev_setup, connect_jev, evaluate_calls, mandate as jev_mandate


def evidence(day=DAY1, *, count=20, rate=0.2, jev_count=20, jev_rate=0.8):
    def flag(family, n, hit_rate):
        return {"family": family, "label": family, "english": family, "n_settled": n, "hit_rate": hit_rate,
                "status": "insufficient" if n < 20 else "low" if hit_rate < 0.4 else "ok"}
    flags = [flag("agent_targets", count, rate), flag("jev_gate", jev_count, jev_rate)]
    return {"engine_version": decision_ledger.ENGINE_VERSION, "as_of": day, "settled_as_of": day,
            "horizon_sessions": 10, "window_sessions": 252, "required_settled": 20, "low_threshold": 0.4,
            "flags": flags, "low": [item["family"] for item in flags if item["status"] == "low"]}


def fake_evidence(monkeypatch, value):
    calls = []

    def evaluate(db, account_id, day):
        calls.append((account_id, day, db.in_transaction))
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)
    monkeypatch.setattr(decision_ledger, "hit_rate_flags", evaluate)
    return calls


@pytest.mark.parametrize("count,rate,expected,status", [
    (0, None, "simulated", "insufficient"), (19, 0.0, "simulated", "insufficient"),
    (20, 0.399, "proposed", "low"), (20, 0.4, "simulated", "ok"), (20, 0.8, "simulated", "ok"),
])
def test_fixed_sample_and_rate_boundaries_preserve_mandate_authority(setup, monkeypatch, count, rate, expected, status):
    client = setup
    seed(DAY1)
    acct = account(client)
    item = mandate(client, acct)
    calls = fake_evidence(monkeypatch, evidence(count=count, rate=rate))
    result = run(client, item)
    assert result["status"] == expected, result
    attempt = result["attempt"]
    guard = attempt["result"]["outcome_guard"]
    assert guard["status"] == status and guard["downgraded"] is (expected == "proposed")
    assert guard["run_id"] == attempt["run_id"] and guard["as_of"] == DAY1
    assert guard["account_id"] == acct["id"] and guard["account_version"] == acct["version"]
    assert calls == [(acct["id"], DAY1, True)]
    saved = client.get(f"/api/agent-automation/mandates/{item['id']}").json()["mandate"]
    assert (saved["mode"], saved["enabled"], saved["reauth_required"], saved["version"]) == ("auto_simulate", True, False, item["version"])
    json.dumps(result, allow_nan=False)


def test_jev_low_is_irrelevant_when_gate_disabled(setup, monkeypatch):
    client = setup
    seed(DAY1)
    calls = fake_evidence(monkeypatch, evidence(rate=0.8, jev_rate=0.1))
    result = run(client, mandate(client, account(client)))
    assert result["status"] == "simulated", result
    guard = result["attempt"]["result"]["outcome_guard"]
    assert guard["relevant_families"] == ["agent_targets"] and guard["low_families"] == []
    assert len(calls) == 1


@pytest.mark.parametrize("rule_rate,jev_rate,low_family", [(0.2, 0.8, "agent_targets"), (0.8, 0.2, "jev_gate")])
def test_either_relevant_low_family_requires_review_and_one_required_jev_call(jev_setup, monkeypatch, rule_rate, jev_rate, low_family):
    client = jev_setup["client"]
    connect_jev(jev_setup)
    acct = account(client)
    item = jev_mandate(client, acct, mode="auto_simulate", enabled=True)
    calls = fake_evidence(monkeypatch, evidence(rate=rule_rate, jev_rate=jev_rate))
    result = run(client, item)
    assert result["status"] == "proposed", result
    guard = result["attempt"]["result"]["outcome_guard"]
    assert guard["low_families"] == [low_family] and guard["relevant_families"] == ["agent_targets", "jev_gate"]
    assert len(calls) == 1 and len(evaluate_calls(jev_setup)) == 1
    assert result["attempt"]["result"]["jev_gate"]["status"] == "pass"
    assert paper.account_snapshot(acct["id"])["account"]["version"] == acct["version"]


def test_frozen_evidence_survives_a_required_jev_failure_without_proposal(jev_setup, monkeypatch):
    client = jev_setup["client"]
    calls = fake_evidence(monkeypatch, evidence())
    result = run(client, jev_mandate(client, account(client), mode="auto_simulate"))
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "jev_gate_unavailable"
    assert result["attempt"]["paper_proposal_id"] is None
    assert result["attempt"]["result"]["outcome_guard"]["status"] == "low"
    assert len(calls) == 1 and evaluate_calls(jev_setup) == []


@pytest.mark.parametrize("kind", ["database", "missing", "nan", "inconsistent", "method", "session"])
def test_unavailable_evidence_is_distinct_from_low_and_never_guesses_a_rate(setup, monkeypatch, kind):
    client = setup
    seed(DAY1)
    value = evidence()
    if kind == "database":
        value = sqlite3.OperationalError("synthetic unavailable")
    elif kind == "missing":
        value["flags"] = []
    elif kind == "nan":
        value["flags"][0]["hit_rate"] = float("nan")
    elif kind == "inconsistent":
        value["flags"][0]["status"] = "ok"
    elif kind == "method":
        value["horizon_sessions"] = 5
    else:
        value["settled_as_of"] = "2024-01-03"
    fake_evidence(monkeypatch, value)
    result = run(client, mandate(client, account(client)))
    assert result["status"] == "proposed", result
    attempt = result["attempt"]
    guard = attempt["result"]["outcome_guard"]
    assert attempt["reason_code"] == "outcome_evidence_unavailable"
    assert guard["status"] == "unavailable" and guard["manual_review"] and guard["flags"] == [] and guard["low_families"] == []
    assert "不是低命中率" in attempt["reason"] and "低於 40%" not in attempt["reason"]
    json.dumps(result, allow_nan=False)


def test_review_proposal_can_be_manually_accepted_without_recomputing_the_frozen_sample(setup, monkeypatch):
    client = setup
    seed(DAY1)
    acct = account(client)
    calls = fake_evidence(monkeypatch, evidence())
    result = run(client, mandate(client, acct))
    attempt = result["attempt"]
    before = copy.deepcopy(attempt["result"]["outcome_guard"])
    monkeypatch.setattr(decision_ledger, "hit_rate_flags", lambda *args: pytest.fail("Frozen sample must not be recomputed"))
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-manual-review"})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["proposal"]["status"] == "simulated" and len(calls) == 1
    saved = client.get(f"/api/agent-automation/mandates/{attempt['mandate_id']}/attempts").json()["attempts"][0]
    assert saved["result"]["outcome_guard"] == before


def test_downgraded_alpaca_attempt_never_reaches_the_execution_layer(execution_setup, monkeypatch):
    client = execution_setup["client"]
    acct = account(client)
    fake_evidence(monkeypatch, evidence())
    monkeypatch.setattr(execution, "submit", lambda *args, **kwargs: pytest.fail("Review-only attempt must not submit"))
    result = run(client, execution_mandate(client, acct))
    assert result["status"] == "proposed" and result["attempt"]["mode"] == "proposal_only"
    assert execution_setup["broker"].calls == []
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM execution_submissions").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0


@pytest.mark.parametrize("version,expected", [(automation.ENGINE_VERSION, 409), (automation.TRIGGER_ENGINE_VERSION, 200)])
def test_guard_is_required_for_v3_without_reinterpreting_existing_v2_proposals(setup, monkeypatch, version, expected):
    client = setup
    seed(DAY1)
    acct = account(client)
    fake_evidence(monkeypatch, evidence())
    attempt = run(client, mandate(client, acct))["attempt"]
    with store.connect() as db:
        saved = json.loads(db.execute("SELECT result_json FROM agent_automation_attempts WHERE id=?", (attempt["id"],)).fetchone()[0])
        del saved["outcome_guard"]
        db.execute("UPDATE agent_automation_attempts SET engine_version=?,result_json=? WHERE id=?", (version, json.dumps(saved), attempt["id"]))
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-version-review"})
    assert accepted.status_code == expected, accepted.text


@pytest.mark.parametrize("field,value", [
    ("account_id", "synthetic-other"), ("input_revision", "different"),
    ("low_threshold", 0.1), ("manual_review", False), ("low_families", []),
])
def test_frozen_guard_binding_and_classification_are_revalidated_at_acceptance(setup, monkeypatch, field, value):
    client = setup
    seed(DAY1)
    acct = account(client)
    fake_evidence(monkeypatch, evidence())
    attempt = run(client, mandate(client, acct))["attempt"]
    with store.connect() as db:
        saved = json.loads(db.execute("SELECT result_json FROM agent_automation_attempts WHERE id=?", (attempt["id"],)).fetchone()[0])
        saved["outcome_guard"][field] = value
        db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (json.dumps(saved), attempt["id"]))
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{attempt['paper_proposal_id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "synthetic-tampered-review"})
    assert accepted.status_code == 409 and "降級證據" in accepted.text
    assert paper.account_snapshot(acct["id"])["account"]["version"] == acct["version"]


def test_renewal_keeps_same_day_idempotency_and_next_session_takes_a_new_sample(setup, monkeypatch):
    client = setup
    seed(DAY1)
    acct = account(client)
    item = mandate(client, acct)
    calls = fake_evidence(monkeypatch, evidence())
    first = run(client, item)
    renewed = client.post(f"/api/paper/accounts/{acct['id']}/mandates/{item['id']}/renew",
                          json={"expected_version": item["version"], "acknowledge": True})
    assert renewed.status_code == 200, renewed.text
    item = renewed.json()["mandate"]
    repeated = run(client, item)
    assert repeated["status"] == "already_attempted" and repeated["attempt"]["id"] == first["attempt"]["id"] and len(calls) == 1
    day = "2024-01-05"
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: day)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 6, 1, tzinfo=timezone.utc))
    seed(day)
    next_calls = fake_evidence(monkeypatch, evidence(day, rate=0.8))
    next_attempt = run(client, item)
    assert next_attempt["status"] == "simulated", next_attempt
    assert next_calls == [(acct["id"], day, True)]


def test_input_change_during_evaluation_rolls_back_the_entire_claim(setup, monkeypatch):
    client = setup
    seed(DAY1)
    acct = account(client)
    item = mandate(client, acct)

    def changed(db, *args):
        db.execute("UPDATE bars SET volume=volume+1")
        return evidence()
    monkeypatch.setattr(decision_ledger, "hit_rate_flags", changed)
    result = run(client, item)
    assert result["status"] == "waiting", result
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0
