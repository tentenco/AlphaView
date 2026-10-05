"""Booked Alpaca Paper fills versus broker positions on a fake broker; differences are reported, never corrected."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import alpaca_paper as alpaca, broker_reconciliation as recon, store
from tests.test_execution import FakeBroker, KEY, account, connect, proposal, setup, submit  # noqa: F401  (fixture re-export)

ACCOUNT = {"id": "synthetic-account", "account_number": "SYN-1", "status": "ACTIVE", "currency": "USD", "cash": "1000",
           "equity": "1000", "buying_power": "2000"}


def read():
    app = FastAPI()
    app.include_router(recon.router)
    with TestClient(app) as client:
        response = client.get("/api/alpaca-paper/reconciliation")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def provider_with(positions):
    def provider(config, path, params=None):
        assert config["api_key"] == KEY
        return {"/v2/account": dict(ACCOUNT), "/v2/positions": positions}[path]
    return provider


def filled_order(setup, monkeypatch):
    connect(enabled=True)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    submission = submit(setup, acct, prop).json()
    orders = submission.get("orders") or submission["submission"]["orders"]
    return acct, submission, orders[0]


def test_not_configured_is_unavailable_without_inventing_rows(setup):
    revision = store.input_revision()
    result = read()
    assert result["status"] == "unavailable" and result["broker"]["error"]["code"] == "not_configured"
    assert result["rows"] == [] and result["engine_version"] == "alphaview-book-reconciliation-v2"
    assert store.input_revision() == revision


def test_working_orders_are_pending_then_fills_match_the_broker_position(setup, monkeypatch):
    acct, submission, order = filled_order(setup, monkeypatch)
    monkeypatch.setattr(alpaca, "_get", provider_with([]))
    pending = read()
    assert [row["status"] for row in pending["rows"]] == ["pending"] and pending["status"] == "pending"
    assert pending["rows"][0]["booked_qty"] == "0" and pending["rows"][0]["working_orders"] == 1
    setup["broker"].fill(order["broker_order_id"])
    assert setup["client"].post(f"/api/execution/submissions/{submission.get('id') or submission['submission']['id']}/reconcile").status_code == 200
    with store.connect() as db:
        filled_qty = db.execute("SELECT filled_qty FROM execution_orders WHERE id=?", (order["id"],)).fetchone()[0]
    monkeypatch.setattr(alpaca, "_get", provider_with([{"symbol": "SYNTA", "qty": filled_qty}]))
    revision = store.input_revision()
    matched = read()
    row = matched["rows"][0]
    assert matched["status"] == "matched" and row["status"] == "matched"
    assert row["booked_qty"] == recon._text(recon.Decimal(filled_qty)) and row["difference"] == "0"
    assert row["accounts"] == [acct["id"]] and row["local_ledger"] == []
    assert matched["broker"]["status"] == "available" and matched["summary"]["matched"] == 1
    assert store.input_revision() == revision


def test_drift_unexplained_and_missing_positions_are_reported_not_corrected(setup, monkeypatch):
    acct, submission, order = filled_order(setup, monkeypatch)
    setup["broker"].fill(order["broker_order_id"])
    setup["client"].post(f"/api/execution/submissions/{submission.get('id') or submission['submission']['id']}/reconcile")
    monkeypatch.setattr(alpaca, "_get", provider_with([{"symbol": "SYNTA", "qty": "1"}, {"symbol": "SYNTB", "qty": "5"}]))
    result = read()
    by_symbol = {row["symbol"]: row for row in result["rows"]}
    assert by_symbol["SYNTA"]["status"] == "drift" and by_symbol["SYNTB"]["status"] == "unexplained"
    assert by_symbol["SYNTB"]["booked_qty"] == "0" and by_symbol["SYNTB"]["broker_qty"] == "5"
    assert result["status"] == "drift" and result["summary"]["drift"] == 1 and result["summary"]["unexplained"] == 1
    monkeypatch.setattr(alpaca, "_get", provider_with([]))
    missing = read()
    assert missing["rows"][0]["status"] == "drift" and missing["rows"][0]["broker_position"] is False
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
    assert all(call[0] != "POST" or call[1] == "/v2/orders" for call in setup["broker"].calls)
    assert sum(call[0] == "POST" for call in setup["broker"].calls) == 1


def test_broker_failure_or_changed_account_makes_everything_unavailable(setup, monkeypatch):
    acct, submission, order = filled_order(setup, monkeypatch)
    monkeypatch.setattr(alpaca, "_get", lambda config, path, params=None: (_ for _ in ()).throw(alpaca._problem("rate_limited", "slow down", 503)))
    result = read()
    assert result["status"] == "unavailable" and result["broker"]["error"]["code"] == "rate_limited"
    assert result["rows"][0]["status"] == "unavailable" and result["rows"][0]["broker_qty"] is None
    monkeypatch.setattr(alpaca, "_get", lambda config, path, params=None: {"/v2/account": {**ACCOUNT, "id": "someone-else"}, "/v2/positions": []}[path])
    changed = read()
    assert changed["broker"]["error"]["code"] == "account_changed" and changed["status"] == "unavailable"


@pytest.mark.parametrize("broker_qty, booked, expected", [
    (recon.Decimal("30"), {"qty": recon.Decimal("30"), "working": 0, "unknown": 0}, "matched"),
    (recon.Decimal("30.0000005"), {"qty": recon.Decimal("30"), "working": 0, "unknown": 0}, "matched"),
    (recon.Decimal("29"), {"qty": recon.Decimal("30"), "working": 0, "unknown": 0}, "drift"),
    (recon.Decimal("5"), None, "unexplained"),
    (None, {"qty": recon.Decimal("30"), "working": 0, "unknown": 0}, "drift"),
    (None, None, "matched"),
    (recon.Decimal("30"), {"qty": recon.Decimal("30"), "working": 1, "unknown": 0}, "pending"),
    (recon.Decimal("30"), {"qty": recon.Decimal("30"), "working": 0, "unknown": 1}, "unknown"),
])
def test_row_status_rules(broker_qty, booked, expected):
    assert recon._row_status(broker_qty, booked) == expected


@pytest.mark.parametrize("quantity", [None, "not-a-number", "NaN", "Infinity"])
def test_present_position_with_invalid_quantity_is_unavailable_not_matched(setup, monkeypatch, quantity):
    connect(enabled=False)
    monkeypatch.setattr(alpaca, "_get", provider_with([{"symbol": "SYNTA", "qty": quantity}]))
    before = store.input_revision()
    result = read()
    row = result["rows"][0]
    assert row["status"] == "unavailable" and result["status"] == "unavailable"
    assert row["broker_position"] is True
    assert row["broker_qty"] is None and row["difference"] is None
    assert row["reason_code"] == "broker_quantity_unavailable"
    assert result["summary"]["unavailable"] == 1 and result["summary"]["matched"] == 0
    assert store.input_revision() == before
