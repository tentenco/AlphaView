"""Synthetic broker evidence receipts: local readiness, bounded freshness and atomic capture."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from alphaview.panel import agent_automation, alpaca_paper as alpaca, broker_reconciliation as recon, readiness, sessions, store
from tests.test_book_reconciliation import ACCOUNT
from tests.test_execution import KEY, SECRET, account, connect, setup  # noqa: F401

URL = "/api/alpaca-paper/reconciliation/receipt"


@pytest.fixture
def workspace(setup, monkeypatch):
    config = connect(enabled=False)
    acct = account(name="Synthetic reconciliation receipt", key="synthetic-receipt-account")
    clock = {"now": datetime(2024, 1, 5, 15, tzinfo=timezone.utc), "session": sessions.latest_completed_session()}
    monkeypatch.setattr(store, "now", lambda: clock["now"].isoformat())
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    source = {"positions": [], "failure": False, "during": None, "calls": []}

    def provider(config, path, params=None):
        source["calls"].append(path)
        if source["failure"]:
            raise alpaca._problem("network_unavailable", "Synthetic broker unavailable", 503)
        if path == "/v2/account":
            return dict(ACCOUNT)
        assert path == "/v2/positions"
        if source["during"]:
            source["during"]()
        return source["positions"]
    monkeypatch.setattr(alpaca, "_get", provider)
    app = FastAPI()
    app.include_router(recon.router)
    app.include_router(readiness.router)
    with TestClient(app) as client:
        yield client, acct, config, clock, source


def local(client):
    response = client.get(URL)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def body(state):
    return {f"expected_{key}": state[key] for key in (
        "version", "connection_version", "broker_account_id", "as_of", "input_revision", "book_fingerprint")}


def capture(client):
    response = client.post(URL, json=body(local(client)))
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def records():
    with store.connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM broker_reconciliation_receipts")]


def enable_mandate(acct):
    return agent_automation.create_mandate(agent_automation.MandateInput(
        name="Synthetic broker receipt mandate", account_id=acct["id"], enabled=True,
        workflow=agent_automation.WorkflowTemplate(scope="market", candidate_symbols=["SYNTA"]), execution_target="alpaca_paper"))


def check(client, acct):
    response = client.get("/api/trading-agent/readiness", params={"account_id": acct["id"]})
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["engine_version"] == "alphaview-readiness-v3" and value["overall"] != "live_ready"
    return next(item for item in value["checks"] if item["id"] == "broker_book_reconciled")


def test_local_get_and_readiness_never_fetch_broker_and_capture_persists_sanitized_evidence(workspace, monkeypatch):
    client, acct, _, _, source = workspace
    enable_mandate(acct)
    state = local(client)
    assert state["receipt"] is None and state["version"] == 0
    assert source["calls"] == [] and records() == []
    assert check(client, acct)["reason_code"] == "receipt_missing"
    assert source["calls"] == []
    revision = store.input_revision()
    saved = capture(client)
    assert source["calls"] == ["/v2/account", "/v2/positions"]
    assert saved["version"] == 1 and saved["receipt"]["current"]
    assert saved["receipt"]["result"]["status"] == "matched"
    assert saved["max_age_seconds"] == 900
    for text in (json.dumps(saved), json.dumps(records())):
        assert KEY not in text and SECRET not in text and "api_key" not in text and "secret_key" not in text
    assert store.input_revision() == revision
    assert len(records()) == 1
    monkeypatch.setattr(alpaca, "_get", lambda *args, **kwargs: pytest.fail("Readiness must not call broker"))
    assert check(client, acct)["status"] == "pass"
    assert local(client)["receipt"]["current"] is True
    assert store.input_revision() == revision


def test_existing_live_get_stays_read_only_and_never_creates_a_receipt(workspace):
    client, _, _, _, source = workspace
    response = client.get("/api/alpaca-paper/reconciliation")
    assert response.status_code == 200 and response.json()["engine_version"] == recon.ENGINE_VERSION
    assert source["calls"] == ["/v2/account", "/v2/positions"]
    assert records() == [] and local(client)["version"] == 0


def test_failed_capture_replaces_success_and_readiness_does_not_fall_back(workspace):
    client, acct, _, _, source = workspace
    enable_mandate(acct)
    first = capture(client)
    assert check(client, acct)["status"] == "pass"
    source["failure"] = True
    failed = capture(client)
    assert failed["version"] == first["version"] + 1
    assert failed["receipt"]["current"] is True
    assert failed["receipt"]["result"]["status"] == "unavailable"
    assert failed["receipt"]["result"]["broker"]["error"]["code"] == "network_unavailable"
    assert len(records()) == 1
    assert check(client, acct)["status"] == "unavailable"
    assert check(client, acct)["reason_code"] == "book_unavailable"


@pytest.mark.parametrize("seconds, current, reason", [(900, True, None), (901, False, "receipt_stale"), (-1, False, "receipt_timestamp_invalid")])
def test_freshness_is_bounded_by_fifteen_minutes_and_rejects_future_timestamps(workspace, seconds, current, reason):
    client, acct, _, clock, _ = workspace
    enable_mandate(acct)
    capture(client)
    clock["now"] += timedelta(seconds=seconds)
    state = local(client)
    assert state["receipt"]["current"] is current
    result = check(client, acct)
    assert result["status"] == ("pass" if current else "unavailable")
    assert result["reason_code"] == reason


def insert_book_order(acct):
    with store.connect() as db:
        db.execute("""INSERT INTO execution_submissions(id,account_id,proposal_id,target,status,idempotency_key,request_hash,engine_version,
            as_of,input_revision,account_version,connection_version,created_at,updated_at,summary_json)
            VALUES ('synthetic-receipt-sub',?,'synthetic-prop','alpaca_paper','submitted','receipt-k','receipt-h','synthetic',
                '2024-01-04','synthetic:1',1,'synthetic-version','synthetic','synthetic','{}')""", (acct["id"],))
        db.execute("""INSERT INTO execution_orders(id,submission_id,account_id,proposal_id,sequence,symbol,side,qty,order_type,time_in_force,
            reference_price,reference_notional,client_order_id,status,filled_qty)
            VALUES ('synthetic-receipt-order','synthetic-receipt-sub',?,'synthetic-prop',1,'SYNTA','buy','1','market','day',
                '100','100','synthetic-receipt-client','accepted','0')""", (acct["id"],))


@pytest.mark.parametrize("change, reason", [
    ("inputs", "receipt_inputs_changed"), ("book", "receipt_book_changed"),
    ("config", "receipt_connection_changed"), ("account", "receipt_account_changed"),
    ("session", "receipt_session_changed"),
])
def test_source_change_during_fetch_rejects_without_overwriting_and_old_receipt_is_stale(workspace, change, reason):
    client, acct, config, clock, source = workspace
    enable_mandate(acct)
    capture(client)
    prior = records()
    expected = body(local(client))

    def mutate():
        if change == "inputs":
            with store.connect() as db:
                db.execute("UPDATE bars SET adj_close=adj_close+1 WHERE symbol='SYNTA'")
        elif change == "book":
            insert_book_order(acct)
        elif change in ("config", "account"):
            with alpaca._config_lock():
                alpaca._write_config({**config, **({"version": "b" * 32} if change == "config" else {"account_id": "synthetic-other"})})
        else:
            clock["session"] = "2024-01-08"

    def during_fetch():
        # A concurrent writer must not accidentally reuse the request's query-only snapshot.
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(mutate).result(timeout=5)
    source["during"] = during_fetch
    response = client.post(URL, json=expected)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "reconciliation_changed"
    assert records() == prior
    stale = local(client)["receipt"]
    assert not stale["current"] and reason in stale["unavailable_reasons"]
    assert check(client, acct)["status"] == "unavailable"


def test_changed_receipt_version_is_rejected_before_network(workspace):
    client, _, _, _, source = workspace
    expected = body(local(client))
    capture(client)
    before = list(source["calls"])
    assert client.post(URL, json=expected).status_code == 409
    assert source["calls"] == before and records()[0]["version"] == 1


@pytest.mark.parametrize("quantity", [None, "not-a-number", "NaN", "Infinity"])
def test_invalid_broker_quantities_stay_unavailable_in_receipt_and_readiness(workspace, quantity):
    client, acct, _, _, source = workspace
    enable_mandate(acct)
    source["positions"] = [{"symbol": "SYNTA", "qty": quantity}]
    saved = capture(client)
    row = saved["receipt"]["result"]["rows"][0]
    assert row["status"] == "unavailable" and row["broker_position"] is True
    assert row["broker_qty"] is None and row["difference"] is None
    assert row["reason_code"] == "broker_quantity_unavailable"
    assert check(client, acct)["status"] == "unavailable"


def test_unexplained_and_pending_books_fail_readiness_without_trading(workspace):
    client, acct, _, _, source = workspace
    enable_mandate(acct)
    source["positions"] = [{"symbol": "SYNTA", "qty": "5"}]
    capture(client)
    assert check(client, acct)["status"] == "fail" and check(client, acct)["reason_code"] == "book_unexplained"
    insert_book_order(acct)
    capture(client)
    assert check(client, acct)["status"] == "fail" and check(client, acct)["reason_code"] == "book_pending"
    assert all(path in ("/v2/account", "/v2/positions") for path in source["calls"])


@pytest.mark.parametrize("change", [
    {"expected_version": True}, {"expected_version": "0"}, {"expected_version": 0.5}, {"expected_version": -1},
    {"expected_connection_version": None}, {"expected_broker_account_id": ""}, {"expected_as_of": "bad"},
    {"expected_book_fingerprint": "bad"}, {"acknowledge": True},
])
def test_capture_input_is_strict_and_rejects_extra_fields_before_network(workspace, change):
    client, _, _, _, source = workspace
    response = client.post(URL, json={**body(local(client)), **change})
    assert response.status_code == 422
    assert source["calls"] == [] and records() == []
