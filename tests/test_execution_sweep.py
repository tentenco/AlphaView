"""Kill-switch sweep of working Alpaca Paper orders and per-submission order-style override, on the fake broker."""
import json
import uuid

import pytest

from alphaview.panel import alpaca_paper as alpaca, circuit_breakers, execution, paper_portfolio as paper, store
from tests.test_execution import KEY, SECRET, account, connect, proposal, setup, submit  # noqa: F401  (fixture re-export)


def pause(setup, acct, on=True):
    response = setup["client"].patch(f"/api/paper/accounts/{acct['id']}/controls",
                                     json={"expected_version": acct["version"], "kill_switch": on})
    assert response.status_code == 200, response.text
    return response.json()


def order_rows(submission_id):
    with store.connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM execution_orders WHERE submission_id=? ORDER BY sequence", (submission_id,))]


def sweep(setup, acct, version, reason="manual_sweep"):
    return setup["client"].post(f"/api/execution/accounts/{acct['id']}/cancel-working",
                                json={"expected_account_version": version, "reason": reason})


def test_pause_sweeps_working_orders_once_and_is_idempotent(setup):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    result = submit(setup, acct, prop).json()
    broker = setup["broker"]
    broker.fill("broker-0001")
    setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile")
    with store.connect() as db:
        # A recorded order that never left the machine (process died between record and send).
        db.execute("""INSERT INTO execution_orders (id,submission_id,account_id,proposal_id,sequence,symbol,side,qty,order_type,
            time_in_force,reference_price,reference_notional,client_order_id,status)
            VALUES (?,?,?,?,3,'SYNTA','sell','1','market','day','100','100',?,'pending')""",
                   (uuid.uuid4().hex, result["id"], acct["id"], prop["id"], "av-pending-synthetic"))
    revision = store.input_revision()
    calls_before = len(broker.calls)
    paused = pause(setup, acct)
    assert paused["account"]["kill_switch"] is True
    sweep_result = paused["execution_sweep"]
    json.dumps(sweep_result, allow_nan=False)
    assert sweep_result["reason"] == "kill_switch_enabled" and not sweep_result["nothing_to_do"]
    assert sweep_result["counts"] == {"cancel_requested": 1, "skipped": 1} and sweep_result["already_terminal"] == 1
    actions = {entry["previous_status"]: entry["action"] for entry in sweep_result["results"]}
    assert actions == {"accepted": "cancel_requested", "pending": "skipped"}
    assert [call[:2] for call in broker.calls[calls_before:]] == [("DELETE", "/v2/orders/broker-0002")]
    rows = order_rows(result["id"])
    assert [row["status"] for row in rows] == ["filled", "cancel_requested", "skipped"]
    assert json.loads(rows[2]["error_json"])["code"] == "swept"
    with store.connect() as db:
        summary = json.loads(db.execute("SELECT summary_json FROM execution_submissions WHERE id=?", (result["id"],)).fetchone()[0])
    assert summary["kill_switch_sweep"]["reason"] == "kill_switch_enabled" and len(summary["kill_switch_sweep"]["results"]) == 2
    assert SECRET not in json.dumps(paused)
    # Second sweep: nothing is working any more, no broker call, no state change.
    again = sweep(setup, acct, paused["account"]["version"])
    assert again.status_code == 200, again.text
    assert again.json()["nothing_to_do"] and again.json()["results"] == [] and len(broker.calls) == calls_before + 1
    assert [row["status"] for row in order_rows(result["id"])] == ["filled", "cancel_requested", "skipped"]
    assert store.input_revision() == revision


def test_unreachable_broker_keeps_the_pause_and_never_resends_the_cancel(setup, monkeypatch):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    result = submit(setup, acct, prop).json()
    broker = setup["broker"]
    real = broker.request

    def flaky(config, method, path, params=None, payload=None):
        if method == "DELETE":
            broker.calls.append((method, path, params, payload))
            raise alpaca._problem("network_unavailable", "無法連線至 Alpaca Paper，請檢查網路後重試", 503)
        return real(config, method, path, params, payload)
    monkeypatch.setattr(alpaca, "_request", flaky)
    paused = pause(setup, acct)
    assert paused["account"]["kill_switch"] is True
    entry = paused["execution_sweep"]["results"][0]
    assert entry["action"] == "unknown" and entry["error"]["code"] == "network_unavailable"
    rows = order_rows(result["id"])
    assert rows[0]["status"] == "unknown" and json.loads(rows[0]["error_json"])["phase"] == "sweep"
    with store.connect() as db:
        assert db.execute("SELECT status FROM execution_submissions WHERE id=?", (result["id"],)).fetchone()[0] == "unknown"
    deletes = sum(call[0] == "DELETE" for call in broker.calls)
    again = sweep(setup, acct, paused["account"]["version"]).json()
    assert again["nothing_to_do"] and sum(call[0] == "DELETE" for call in broker.calls) == deletes
    monkeypatch.setattr(alpaca, "_request", real)
    reconciled = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert reconciled["orders"][0]["status"] == "accepted" and reconciled["status"] == "submitted"


def test_manual_sweep_requires_current_version_reason_and_account(setup):
    connect()
    acct = account()
    assert sweep(setup, acct, acct["version"] + 1).status_code == 409
    response = setup["client"].post(f"/api/execution/accounts/{acct['id']}/cancel-working", json={"expected_account_version": acct["version"]})
    assert response.status_code == 422
    assert setup["client"].post("/api/execution/accounts/unknown/cancel-working",
                                json={"expected_account_version": 1, "reason": "x"}).status_code == 404
    empty = sweep(setup, acct, acct["version"]).json()
    assert empty["nothing_to_do"] and empty["counts"] == {} and empty["already_terminal"] == 0
    assert len(setup["broker"].calls) == 0


def test_circuit_breaker_pause_sweeps_before_refusing(setup, monkeypatch):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    result = submit(setup, acct, prop).json()
    broker = setup["broker"]
    with store.connect() as db:
        acct = dict(db.execute("SELECT * FROM paper_accounts WHERE id=?", (acct["id"],)).fetchone())
    second = proposal(acct, [{"symbol": "SYNTB", "weight_pct": 20}], key="synthetic-proposal-2")

    def tripped(db, account_id, as_of, *, trigger):
        db.execute("UPDATE paper_accounts SET kill_switch=1,version=version+1 WHERE id=?", (account_id,))
        return {"tripped": True, "paused_now": True, "already_paused": False, "tripped_codes": ["daily_loss"],
                "policy": {"reduce_only_allowed": False}, "checks": [], "unavailable": [], "kill_switch": True,
                "account_version": acct["version"], "account_version_after": acct["version"] + 1}
    monkeypatch.setattr(circuit_breakers, "enforce", tripped)
    with pytest.raises(Exception) as refused:
        execution.submit(acct["id"], second["id"], execution.SubmitInput(target="alpaca_paper", expected_account_version=acct["version"],
                                                                         idempotency_key="synthetic-submit-2", acknowledge_external=True))
    assert getattr(refused.value, "status_code", None) == 409
    assert [call[:2] for call in broker.calls if call[0] == "DELETE"] == [("DELETE", "/v2/orders/broker-0001")]
    assert order_rows(result["id"])[0]["status"] == "cancel_requested"
    with store.connect() as db:
        summary = json.loads(db.execute("SELECT summary_json FROM execution_submissions WHERE id=?", (result["id"],)).fetchone()[0])
        assert summary["kill_switch_sweep"]["reason"] == "circuit_breaker_tripped:daily_loss"
        assert db.execute("SELECT kill_switch FROM paper_accounts WHERE id=?", (acct["id"],)).fetchone()[0] == 1


def test_style_override_applies_to_one_submission_and_is_recorded(setup):
    connect()  # connection-wide style: market (band default 50)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    response = submit(setup, acct, prop, order_style_override={"type": "limit", "limit_band_bps": 75})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["summary"]["order_style"] == {"type": "limit", "limit_band_bps": 75.0, "time_in_force": "day"}
    assert result["summary"]["order_style_source"] == "override" and result["orders"][0]["limit_price"] == "100.75"
    payload = setup["broker"].calls[0][3]
    assert payload["type"] == "limit" and payload["limit_price"] == "100.75"
    # Replaying the same key with the same override returns the stored submission without sending again.
    replay = submit(setup, acct, prop, order_style_override={"type": "limit", "limit_band_bps": 75})
    assert replay.json()["id"] == result["id"] and len(setup["broker"].calls) == 1
    assert submit(setup, acct, prop).status_code == 409  # same key, different content
    with store.connect() as db:
        acct = dict(db.execute("SELECT * FROM paper_accounts WHERE id=?", (acct["id"],)).fetchone())
    second = proposal(acct, [{"symbol": "SYNTB", "weight_pct": 20}], key="synthetic-proposal-2")
    plain = submit(setup, acct, second, idempotency_key="synthetic-submit-2").json()
    assert plain["summary"]["order_style_source"] == "connection" and plain["summary"]["order_type"] == "market"
    assert setup["broker"].calls[1][3]["type"] == "market" and "limit_price" not in setup["broker"].calls[1][3]
    with store.connect() as db:
        acct = dict(db.execute("SELECT * FROM paper_accounts WHERE id=?", (acct["id"],)).fetchone())
    third = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 10}], key="synthetic-proposal-3")
    band_from_connection = submit(setup, acct, third, idempotency_key="synthetic-submit-3", order_style_override={"type": "limit"}).json()
    assert band_from_connection["summary"]["order_style"]["limit_band_bps"] == 50.0
    assert band_from_connection["orders"][0]["limit_price"] == "100.50"
    for bad in ({"type": "stop"}, {"type": "limit", "limit_band_bps": 501}, {"type": "limit", "extra": 1}):
        assert submit(setup, acct, third, idempotency_key="synthetic-submit-bad", order_style_override=bad).status_code == 422
    json.dumps(result, allow_nan=False)
