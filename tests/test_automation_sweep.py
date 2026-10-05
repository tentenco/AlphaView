"""Automation-triggered pauses sweep existing Paper orders through the fake execution layer."""
import json

import pytest

from alphaview.panel import agent_automation as automation
from alphaview.panel import alpaca_paper as alpaca, circuit_breakers, execution
from alphaview.panel import paper_portfolio as paper, store
from tests.test_automation_execution import (  # noqa: F401 (shared synthetic fixture)
    account, fills, mandate, run, setup,
)
from tests.test_execution import connect, proposal, submit


def prepared(setup, *, target="alpaca_paper", mode="auto_simulate", auto_pause=True):
    client = setup["client"]
    connect()
    acct = account(client)
    initial = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 10}], key="sweep-initial")
    accepted = paper.accept_proposal(acct["id"], initial["id"],
                                    paper.AcceptInput(expected_version=acct["version"], idempotency_key="sweep-fill"))
    acct = accepted["account"]["account"]
    working = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 20}], key="sweep-working")
    response = submit(setup, acct, working)
    assert response.status_code == 201, response.text
    submitted = response.json()
    assert len(submitted["orders"]) == 1 and submitted["orders"][0]["status"] == "accepted"
    circuit_breakers.put_breakers(acct["id"], circuit_breakers.PolicyInput(
        expected_version=1, policy=circuit_breakers.Policy(max_fills_per_session=1, auto_pause=auto_pause)))
    item = mandate(client, acct, enabled=True, execution_target=target, mode=mode)
    return acct, item, submitted


def saved_order(submitted):
    with store.connect() as db:
        return dict(db.execute("SELECT * FROM execution_orders WHERE submission_id=?", (submitted["id"],)).fetchone())


@pytest.mark.parametrize("target,mode", [
    ("alpaca_paper", "auto_simulate"), ("paper_ledger", "auto_simulate"), ("alpaca_paper", "proposal_only"),
])
def test_automation_pause_commits_then_cancels_working_orders_once(setup, monkeypatch, target, mode):
    client, broker = setup["client"], setup["broker"]
    acct, item, submitted = prepared(setup, target=target, mode=mode)
    original = broker.request
    seen = []

    def observe_committed_pause(config, method, path, params=None, payload=None):
        assert method == "DELETE", "Automation must not submit another order after its breaker trips"
        with store.connect() as db:
            # Acquiring the writer lock proves the pause transaction already ended.
            db.execute("BEGIN IMMEDIATE")
            state = db.execute("SELECT kill_switch,version FROM paper_accounts WHERE id=?", (acct["id"],)).fetchone()
            assert state["kill_switch"] == 1 and state["version"] == acct["version"] + 1
            assert db.execute("SELECT reauth_required FROM agent_mandates WHERE id=?", (item["id"],)).fetchone()[0] == 1
        seen.append(path)
        return original(config, method, path, params, payload)

    monkeypatch.setattr(alpaca, "_request", observe_committed_pause)
    response = run(client, item)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "circuit_breaker_tripped"
    assert seen == ["/v2/orders/broker-0001"]
    breaker = result["attempt"]["result"]["circuit_breaker"]
    sweep = breaker["execution_sweep"]
    assert breaker["paused_now"] and sweep["counts"] == {"cancel_requested": 1}
    assert sweep["reason"] == "circuit_breaker_tripped:max_fills_per_session"
    assert result["attempt"]["paper_proposal_id"] is None and fills() == 1
    assert saved_order(submitted)["status"] == "cancel_requested"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM execution_submissions").fetchone()[0] == 1
        summary = json.loads(db.execute("SELECT summary_json FROM execution_submissions WHERE id=?", (submitted["id"],)).fetchone()[0])
    assert summary["kill_switch_sweep"]["reason"] == sweep["reason"]
    assert run(client, item).json()["status"] == "already_attempted"
    assert automation.tick()["results"][0]["status"] == "already_attempted"
    again = circuit_breakers.evaluate_now(acct["id"])
    assert again["already_paused"] and not again["paused_now"] and "execution_sweep" not in again
    assert seen == ["/v2/orders/broker-0001"]
    assert [call[0] for call in broker.calls] == ["POST", "DELETE"]
    json.dumps(result, allow_nan=False)


def test_automation_cancel_transport_failure_keeps_pause_and_unknown_without_resend(setup):
    client, broker = setup["client"], setup["broker"]
    acct, item, submitted = prepared(setup)
    broker.fail_next = alpaca._problem("network_unavailable", "Synthetic cancel outage", 503)
    result = run(client, item).json()
    assert result["status"] == "blocked"
    sweep = result["attempt"]["result"]["circuit_breaker"]["execution_sweep"]
    assert sweep["counts"] == {"unknown": 1} and sweep["results"][0]["error"]["code"] == "network_unavailable"
    saved = saved_order(submitted)
    assert saved["status"] == "unknown" and json.loads(saved["error_json"])["phase"] == "sweep"
    state = paper.account_snapshot(acct["id"])["account"]
    assert state["kill_switch"] and state["version"] == acct["version"] + 1
    assert run(client, item).json()["status"] == "already_attempted"
    assert execution.cancel_working(acct["id"], reason="synthetic-repeat")["nothing_to_do"]
    assert [call[0] for call in broker.calls] == ["POST", "DELETE"] and fills() == 1
    reconciled = client.post(f"/api/execution/submissions/{submitted['id']}/reconcile").json()
    assert reconciled["orders"][0]["status"] == "accepted"
    assert [call[0] for call in broker.calls] == ["POST", "DELETE", "GET"]


def test_automation_trip_without_auto_pause_does_not_cancel_orders(setup):
    client, broker = setup["client"], setup["broker"]
    acct, item, submitted = prepared(setup, auto_pause=False)
    result = run(client, item).json()
    assert result["status"] == "blocked" and result["attempt"]["reason_code"] == "circuit_breaker_tripped"
    breaker = result["attempt"]["result"]["circuit_breaker"]
    assert not breaker["paused_now"] and "execution_sweep" not in breaker
    assert not paper.account_snapshot(acct["id"])["account"]["kill_switch"]
    assert saved_order(submitted)["status"] == "accepted" and [call[0] for call in broker.calls] == ["POST"]
    assert fills() == 1 and result["attempt"]["paper_proposal_id"] is None


def test_automation_sweep_respects_disabled_order_authority(setup):
    client, broker = setup["client"], setup["broker"]
    acct, item, submitted = prepared(setup)
    connect(enabled=False)
    result = run(client, item).json()
    assert result["status"] == "blocked"
    sweep = result["attempt"]["result"]["circuit_breaker"]["execution_sweep"]
    assert sweep["results"][0]["error"]["code"] == "orders_disabled"
    assert paper.account_snapshot(acct["id"])["account"]["kill_switch"]
    saved = saved_order(submitted)
    assert saved["status"] == "accepted" and json.loads(saved["error_json"])["code"] == "orders_disabled"
    assert [call[0] for call in broker.calls] == ["POST"] and fills() == 1


def test_authorized_reduce_only_alpaca_mandate_still_submits_only_sells(setup):
    client, broker = setup["client"], setup["broker"]
    connect()
    acct = account(client)
    initial = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 10}, {"symbol": "SYNTB", "weight_pct": 20}],
                       key="reduce-initial")
    accepted = paper.accept_proposal(acct["id"], initial["id"],
                                    paper.AcceptInput(expected_version=acct["version"], idempotency_key="reduce-fill"))
    acct = accepted["account"]["account"]
    circuit_breakers.put_breakers(acct["id"], circuit_breakers.PolicyInput(
        expected_version=1, policy=circuit_breakers.Policy(reduce_only_allowed=True)))
    paused = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=acct["version"], kill_switch=True))
    assert paused["execution_sweep"]["nothing_to_do"] and broker.calls == []
    # Creating the mandate after the pause is explicit current authority; no breach flags are cleared implicitly.
    item = mandate(client, paused["account"], enabled=True,
                   workflow={"scope": "market", "candidate_symbols": ["SYNTB"]})
    result = run(client, item).json()
    assert result["status"] == "submitted", result
    evidence = result["attempt"]["result"]
    assert evidence["reduce_only"]["status"] == "reduced" and evidence["execution_target"] == "alpaca_paper"
    # The synthetic rules target SYNTB at 16%: sell all 10 SYNTA and reduce SYNTB from 20 to 16 shares.
    assert evidence["reduce_only"]["targets_after"] == [{"symbol": "SYNTB", "weight_pct": 16.0}]
    assert evidence["order_count"] == 2 and fills() == 2
    assert [(call[0], call[1], call[3]["symbol"], call[3]["side"], call[3]["qty"],
             call[3]["type"], call[3]["time_in_force"]) for call in broker.calls] == [
        ("POST", "/v2/orders", "SYNTA", "sell", "10", "market", "day"),
        ("POST", "/v2/orders", "SYNTB", "sell", "4", "market", "day"),
    ]
    submission = client.get(f"/api/execution/submissions/{evidence['execution_submission_id']}").json()
    assert submission["target"] == "alpaca_paper"
    assert all(float(order["reference_notional"]) <= submission["summary"]["caps"]["max_order_notional_usd"]
               for order in submission["orders"])
    state = paper.account_snapshot(acct["id"])
    assert state["account"]["kill_switch"] and {row["symbol"]: row["shares"] for row in state["holdings"]} == {"SYNTA": 10, "SYNTB": 20}
    assert run(client, item).json()["status"] == "already_attempted" and len(broker.calls) == 2
