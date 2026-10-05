"""Execution layer on synthetic accounts with a fake Alpaca Paper broker; no network, no real keys."""
import json

import pytest
import requests
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import alpaca_paper as alpaca
from alphaview.panel import execution
from alphaview.panel import paper_portfolio as paper
from alphaview.panel import sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]
KEY = "PKSYNTHETIC0000000000"
SECRET = "synthetic-secret-for-tests-only"
REAL_REQUEST = alpaca._request


class FakeBroker:
    """Scripted Alpaca Paper responses keyed by (method, path); records every request."""

    def __init__(self):
        self.calls = []
        self.orders = {}
        self.fail_next = None
        self.reject_next = None
        self.counter = 0

    def request(self, config, method, path, params=None, payload=None):
        assert config["api_key"] == KEY and config["orders_enabled"]
        self.calls.append((method, path, params, payload))
        if self.fail_next:
            problem, self.fail_next = self.fail_next, None
            raise problem
        if method == "POST":
            if self.reject_next:
                status, body, self.reject_next = *self.reject_next, None
                return status, body
            self.counter += 1
            order = {"id": f"broker-{self.counter:04d}", "client_order_id": payload["client_order_id"], "status": "accepted",
                     "symbol": payload["symbol"], "side": payload["side"], "type": payload["type"], "time_in_force": payload["time_in_force"],
                     "qty": payload["qty"], "filled_qty": "0", "filled_avg_price": None, "submitted_at": "2024-01-05T14:30:00Z",
                     "secret_echo": SECRET}
            self.orders[order["id"]] = order
            return 200, dict(order)
        if method == "GET" and path == "/v2/orders:by_client_order_id":
            for order in self.orders.values():
                if order["client_order_id"] == params["client_order_id"]:
                    return 200, dict(order)
            return 404, {"code": 40410000, "message": "order not found"}
        if method == "GET":
            order = self.orders.get(path.rsplit("/", 1)[1])
            return (200, dict(order)) if order else (404, {"message": "order not found"})
        if method == "DELETE":
            order = self.orders[path.rsplit("/", 1)[1]]
            order["status"] = "pending_cancel"
            return 204, None
        raise AssertionError(method)

    def fill(self, broker_id, qty=None, price="101.5"):
        order = self.orders[broker_id]
        order.update(status="filled", filled_qty=qty or order["qty"], filled_avg_price=price, filled_at="2024-01-05T14:31:00Z")

    def settle_cancel(self, broker_id):
        self.orders[broker_id]["status"] = "canceled"


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "execution.db"))
    monkeypatch.delenv("ALPHAVIEW_ALPACA_CREDENTIALS_PATH", raising=False)
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    monkeypatch.setattr(requests.Session, "get", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
    broker = FakeBroker()
    monkeypatch.setattr(alpaca, "_request", broker.request)
    app = FastAPI()
    app.include_router(execution.router)
    app.include_router(paper.router)
    app.include_router(alpaca.router)
    with TestClient(app) as client:
        yield {"client": client, "broker": broker}


def connect(*, enabled=True, caps=None):
    config = {"schema_version": 1, "endpoint": alpaca.BASE_URL, "api_key": KEY, "secret_key": SECRET,
              "version": "a" * 32, "connected_at": "2024-01-05T00:00:00+00:00", "account_id": "synthetic-account",
              "orders_enabled": enabled, "order_caps": caps or dict(alpaca.DEFAULT_ORDER_CAPS)}
    alpaca._write_config(config)
    return config


def account(name="Synthetic paper", key="synthetic-account", cash=10000):
    return paper.create_account(paper.AccountInput(name=name, initial_cash=cash, idempotency_key=key))["account"]


def proposal(acct, targets, key="synthetic-proposal"):
    body = paper.ProposalInput(expected_version=acct["version"], targets=targets, idempotency_key=key)
    return paper.create_proposal(acct["id"], body)


def submit(setup, acct, prop, **changes):
    body = {"target": "alpaca_paper", "expected_account_version": acct["version"], "idempotency_key": "synthetic-submit",
            "acknowledge_external": True, **changes}
    return setup["client"].post(f"/api/execution/accounts/{acct['id']}/proposals/{prop['id']}/submit", json=body)


def fills():
    with store.connect() as db:
        return db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0]


def test_paper_ledger_target_settles_locally_and_replays(setup):
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    revision = store.input_revision()
    response = submit(setup, acct, prop, target="paper_ledger", acknowledge_external=False)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["target"] == "paper_ledger" and result["status"] == "simulated" and result["terminal"]
    assert fills() == 1 and setup["broker"].calls == []
    replay = submit(setup, acct, prop, target="paper_ledger", acknowledge_external=False)
    assert replay.status_code == 201 and replay.json()["id"] == result["id"] and fills() == 1
    listed = setup["client"].get(f"/api/execution/accounts/{acct['id']}/submissions").json()
    assert [row["id"] for row in listed["submissions"]] == [result["id"]] and listed["targets"][1]["available"] is False
    assert store.input_revision() == revision and json.dumps(listed, allow_nan=False)


def test_alpaca_target_requires_acknowledgement_configuration_and_enabled_orders(setup):
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    assert submit(setup, acct, prop, acknowledge_external=False).json()["detail"]["code"] == "acknowledgement_required"
    assert submit(setup, acct, prop).json()["detail"]["code"] == "not_configured"
    connect(enabled=False)
    assert submit(setup, acct, prop).json()["detail"]["code"] == "orders_disabled"
    assert setup["broker"].calls == [] and fills() == 0
    with store.connect() as db:
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (prop["id"],)).fetchone()[0] == "proposed"
        assert db.execute("SELECT count(*) FROM execution_submissions").fetchone()[0] == 0


def test_alpaca_submission_is_recorded_before_sending_then_reconciled_to_filled(setup):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    revision = store.input_revision()
    response = submit(setup, acct, prop)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["status"] == "submitted" and result["reconcile_required"] and not result["terminal"]
    assert [order["symbol"] for order in result["orders"]] == ["SYNTA", "SYNTB"]
    assert [order["status"] for order in result["orders"]] == ["accepted", "accepted"]
    assert result["orders"][0]["client_order_id"] == execution.client_order_id(prop["id"], "SYNTA")
    assert result["orders"][0]["qty"] == "30" and result["orders"][0]["broker_order_id"] == "broker-0001"
    assert SECRET not in response.text
    assert [call[0] for call in setup["broker"].calls] == ["POST", "POST"]
    assert setup["broker"].calls[0][3] == {"symbol": "SYNTA", "qty": "30", "side": "buy", "type": "market", "time_in_force": "day",
                                          "client_order_id": result["orders"][0]["client_order_id"]}
    assert fills() == 0
    with store.connect() as db:
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (prop["id"],)).fetchone()[0] == "submitted_external"
    accept = setup["client"].post(f"/api/paper/accounts/{acct['id']}/proposals/{prop['id']}/accept",
                                  json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept"})
    assert accept.status_code == 409 and fills() == 0
    assert submit(setup, acct, prop).json()["id"] == result["id"] and len(setup["broker"].calls) == 2
    setup["broker"].fill("broker-0001")
    setup["broker"].fill("broker-0002", price="99.25")
    reconciled = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert reconciled["status"] == "filled" and reconciled["terminal"] and not reconciled["reconcile_required"]
    assert [order["filled_avg_price"] for order in reconciled["orders"]] == ["101.5", "99.25"]
    assert reconciled["summary"]["sent"] == 2 and reconciled["summary"]["last_reconcile_checked"] == 2
    assert store.input_revision() == revision and json.dumps(reconciled, allow_nan=False)


def test_transport_failure_leaves_unknown_skips_the_rest_and_never_resends(setup):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    setup["broker"].fail_next = alpaca._problem("network_unavailable", "Synthetic outage", 503)
    result = submit(setup, acct, prop).json()
    assert result["status"] == "unknown" and result["summary"] == {**result["summary"], "sent": 0, "halted": True}
    assert [order["status"] for order in result["orders"]] == ["unknown", "skipped"]
    assert result["orders"][0]["error"]["code"] == "network_unavailable" and len(setup["broker"].calls) == 1
    reconciled = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert reconciled["orders"][0]["status"] == "unknown" and reconciled["orders"][0]["error"]["code"] == "not_found"
    assert setup["broker"].calls[-1][:2] == ("GET", "/v2/orders:by_client_order_id")
    assert not any(call[0] == "POST" for call in setup["broker"].calls[1:])
    # The order did reach Alpaca after all: reconcile adopts the broker record instead of resending.
    setup["broker"].orders["broker-late"] = {"id": "broker-late", "client_order_id": result["orders"][0]["client_order_id"],
                                             "status": "filled", "qty": "30", "filled_qty": "30", "filled_avg_price": "100.75"}
    reconciled = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert reconciled["orders"][0]["status"] == "filled" and reconciled["orders"][0]["broker_order_id"] == "broker-late"
    assert reconciled["status"] == "mixed" and reconciled["terminal"]


def test_rejections_and_caps_are_recorded_without_sending_more(setup):
    connect(caps={"max_order_notional_usd": 2500, "max_orders_per_submission": 1})
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    response = submit(setup, acct, prop)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "order_count_cap"
    connect(caps={"max_order_notional_usd": 2500, "max_orders_per_submission": 5})
    response = submit(setup, acct, prop, idempotency_key="synthetic-submit-2")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "order_notional_cap"
    connect(caps={"max_order_notional_usd": 5000, "max_orders_per_submission": 5, "max_volume_participation_pct": 1})
    response = submit(setup, acct, prop, idempotency_key="synthetic-submit-2b")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "volume_participation_cap"
    assert setup["broker"].calls == []
    with store.connect() as db:
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (prop["id"],)).fetchone()[0] == "proposed"
    connect()
    setup["broker"].reject_next = (403, {"code": 40310000, "message": "insufficient buying power", "secret_echo": SECRET})
    result = submit(setup, acct, prop, idempotency_key="synthetic-submit-3").json()
    assert [order["status"] for order in result["orders"]] == ["rejected", "accepted"]
    assert result["orders"][0]["error"]["message"] == "insufficient buying power" and "secret_echo" not in json.dumps(result)
    assert result["status"] == "submitted"
    setup["broker"].fill("broker-0001")
    assert setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()["status"] == "mixed"
    # Missing session volume fails closed: a fresh proposal on a zero-volume bar is refused before any send.
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=0 WHERE symbol='SYNTB'")
    current = paper.accounts()["accounts"][0]
    fresh = proposal(current, [{"symbol": "SYNTB", "weight_pct": 10}], key="synthetic-proposal-volume")
    sent_before = len(setup["broker"].calls)
    response = submit(setup, current, fresh, expected_account_version=current["version"], idempotency_key="synthetic-submit-4")
    assert response.status_code in (409, 422) and len(setup["broker"].calls) == sent_before


def test_cancel_requires_current_status_and_reconciles(setup):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    result = submit(setup, acct, prop).json()
    order = result["orders"][0]
    stale = setup["client"].post(f"/api/execution/orders/{order['id']}/cancel", json={"expected_status": "filled"})
    assert stale.status_code == 409
    cancelled = setup["client"].post(f"/api/execution/orders/{order['id']}/cancel", json={"expected_status": "accepted"}).json()
    assert cancelled["orders"][0]["status"] == "cancel_requested" and setup["broker"].calls[-2][:2] == ("DELETE", "/v2/orders/broker-0001")
    setup["broker"].settle_cancel("broker-0001")
    reconciled = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert reconciled["orders"][0]["status"] == "cancelled" and reconciled["status"] == "cancelled"
    again = setup["client"].post(f"/api/execution/orders/{order['id']}/cancel", json={"expected_status": "cancelled"})
    assert again.status_code == 422


def test_stale_proposal_paused_account_and_circuit_breaker_block_submission(setup, monkeypatch):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
    assert submit(setup, acct, prop).json()["detail"]["code"] == "inputs_changed"
    paused = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=acct["version"], kill_switch=True))["account"]
    assert submit(setup, acct, prop, expected_account_version=paused["version"], idempotency_key="synthetic-submit-2").json()["detail"]["code"] == "kill_switch"
    try:
        from alphaview.panel import circuit_breakers
    except ImportError:
        circuit_breakers = None
    if circuit_breakers is not None and hasattr(circuit_breakers, "guard_fill"):
        def tripped(account_id, proposal_id, as_of, *, trigger):
            assert trigger == "execution"
            raise HTTPException(409, {"code": "circuit_breaker_tripped", "message": "synthetic trip"})
        monkeypatch.setattr(circuit_breakers, "guard_fill", tripped)
        resumed = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=paused["version"], kill_switch=False))["account"]
        prop = proposal(resumed, [{"symbol": "SYNTA", "weight_pct": 30}], key="synthetic-proposal-2")
        response = submit(setup, resumed, prop, expected_account_version=resumed["version"], idempotency_key="synthetic-submit-3")
        assert response.status_code == 409 and response.json()["detail"]["code"] == "circuit_breaker_tripped"
    assert setup["broker"].calls == [] and fills() == 0


def test_orders_policy_requires_confirmation_and_transport_refuses_unsafe_calls(setup, monkeypatch):
    client = setup["client"]
    monkeypatch.setattr(alpaca, "_get", lambda *args, **kwargs: {"id": "synthetic-account", "status": "ACTIVE"})
    saved = client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET}).json()
    assert saved["orders_enabled"] is False and saved["order_caps"] == alpaca.DEFAULT_ORDER_CAPS
    denied = client.post("/api/alpaca-paper/orders-policy", json={"expected_version": saved["version"], "orders_enabled": True})
    assert denied.status_code == 422 and denied.json()["detail"]["code"] == "confirmation_required"
    enabled = client.post("/api/alpaca-paper/orders-policy", json={"expected_version": saved["version"], "orders_enabled": True,
                                                                  "confirmation": alpaca.ENABLE_CONFIRMATION, "max_order_notional_usd": 1500})
    assert enabled.status_code == 200 and enabled.json()["orders_enabled"] is True
    assert enabled.json()["order_caps"]["max_order_notional_usd"] == 1500 and "orders.submit" in enabled.json()["capabilities"]
    assert enabled.json()["version"] != saved["version"] and SECRET not in enabled.text
    assert client.get("/api/execution/targets").json()["targets"][1]["available"] is True
    disabled = client.post("/api/alpaca-paper/orders-policy", json={"expected_version": enabled.json()["version"], "orders_enabled": False})
    assert disabled.status_code == 200 and disabled.json()["orders_enabled"] is False
    stale = client.post("/api/alpaca-paper/orders-policy", json={"expected_version": saved["version"], "orders_enabled": False})
    assert stale.status_code == 409
    rotated = client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET, "expected_version": disabled.json()["version"]}).json()
    assert rotated["orders_enabled"] is False
    for method in ("POST", "PATCH", "DELETE"):
        assert client.request(method, "/api/alpaca-paper/orders", json={"symbol": "SYNTH"}).status_code == 404
    monkeypatch.setattr(alpaca, "_request", REAL_REQUEST)
    config = {"api_key": KEY, "secret_key": SECRET, "endpoint": alpaca.BASE_URL, "orders_enabled": False}
    with pytest.raises(HTTPException) as error:
        alpaca._request(config, "POST", "/v2/orders", payload={})
    assert error.value.detail["code"] == "orders_disabled"
    for method, path in (("POST", "/v2/orders/abc"), ("PUT", "/v2/orders"), ("DELETE", "/v2/account"), ("GET", "/v2/positions")):
        with pytest.raises(HTTPException) as error:
            alpaca._request({**config, "orders_enabled": True}, method, path)
        assert error.value.status_code == 422
    with pytest.raises(HTTPException):
        alpaca._request({**config, "orders_enabled": True, "endpoint": "https://api.alpaca.markets"}, "POST", "/v2/orders", payload={})


def test_unattended_reconcile_only_touches_working_submissions_and_respects_the_switch(setup):
    assert execution.reconcile_open() == {"checked": 0, "skipped": "not_configured", "results": []} or execution.reconcile_open()["skipped"] in ("orders_disabled", "credential_file")
    connect()
    acct = account()
    first = submit(setup, acct, proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])).json()
    calls_before = len(setup["broker"].calls)
    setup["broker"].fill("broker-0001")
    result = execution.reconcile_open()
    assert result["checked"] == 1 and result["results"] == [{"id": first["id"], "status": "filled"}]
    assert len(setup["broker"].calls) == calls_before + 1 and setup["broker"].calls[-1][0] == "GET"
    assert execution.reconcile_open()["checked"] == 0  # terminal submissions are left alone
    connect(enabled=False)
    assert execution.reconcile_open()["skipped"] == "orders_disabled"
    response = setup["client"].post("/api/execution/reconcile-open")
    assert response.status_code == 200 and response.json()["skipped"] == "orders_disabled"
    scheduler = execution.Scheduler(interval=0.05).start()
    import time
    time.sleep(0.2)
    scheduler.stop()
    assert scheduler.last_result is not None and scheduler.last_result["skipped"] == "orders_disabled"
    assert not scheduler._thread.is_alive()


def test_status_derivation_and_quantity_text():
    assert execution.derive_status([]) == "rejected"
    assert execution.derive_status(["accepted", "filled"]) == "partially_filled"
    assert execution.derive_status(["accepted", "accepted"]) == "submitted"
    assert execution.derive_status(["filled", "unknown"]) == "unknown"
    assert execution.derive_status(["filled", "filled"]) == "filled"
    assert execution.derive_status(["rejected", "skipped"]) == "rejected"
    assert execution.derive_status(["cancelled", "expired"]) == "cancelled"
    assert execution.derive_status(["filled", "cancelled"]) == "mixed"
    assert execution._qty_text("12.3456789012") == "12.345678901" and execution._qty_text("100.000") == "100"
    assert execution._qty_text("0.0000000001") is None
    assert execution.client_order_id("p" * 40, "BRK.B") == "av-" + "p" * 16 + "-BRK_B"
