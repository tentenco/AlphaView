"""Limit-order style with a price band, terminal partial fills and derived execution inbox events (fake broker only)."""
import json
from decimal import Decimal

import pytest

from alphaview.panel import alpaca_paper as alpaca, execution, portfolio_inbox as inbox, store
from tests.test_execution import KEY, SECRET, account, connect, proposal, setup, submit  # noqa: F401  (fixture + helpers)


def connect_limit(band=50.0, **changes):
    config = connect(**changes)
    config["order_style"] = {"type": "limit", "limit_band_bps": band, "time_in_force": "day"}
    alpaca._write_config(config)
    return config


@pytest.mark.parametrize("reference,side,band,expected", [
    ("100", "buy", 50, "100.50"), ("100", "sell", 50, "99.50"), ("100", "buy", 0, "100.00"),
    ("123.456", "buy", 25, "123.76"), ("123.456", "sell", 25, "123.15"),  # 123.76464 / 123.14736 half-up to cents
    ("0.5", "buy", 100, "0.5050"), ("0.99", "sell", 10, "0.9890"),  # sub-dollar prices keep four decimals
    ("100.005", "buy", 0, "100.01"),  # half-up, not banker's rounding
])
def test_limit_price_arithmetic_and_rounding(reference, side, band, expected):
    assert format(execution.limit_price(reference, side, band), "f") == expected


@pytest.mark.parametrize("reference", [None, "", "0", "-5", "nan", "inf", "abc"])
def test_limit_price_refuses_unusable_references(reference):
    assert execution.limit_price(reference, "buy", 50) is None


def test_old_connector_config_loads_as_market_and_policy_round_trips(setup):
    config = connect()  # written without order_style, like configs saved before this field existed
    assert "order_style" not in config
    loaded = alpaca._read_config()
    assert loaded["order_style"] == {"type": "market", "limit_band_bps": 50.0, "time_in_force": "day"}
    public = alpaca._public(loaded)
    assert public["order_style"]["type"] == "market"
    response = setup["client"].post("/api/alpaca-paper/orders-policy", json={
        "expected_version": loaded["version"], "orders_enabled": True, "confirmation": alpaca.ENABLE_CONFIRMATION,
        "order_type": "limit", "limit_band_bps": 75})
    assert response.status_code == 200, response.text
    assert response.json()["order_style"] == {"type": "limit", "limit_band_bps": 75.0, "time_in_force": "day"}
    assert alpaca._read_config()["order_style"]["type"] == "limit"
    targets = setup["client"].get("/api/execution/targets").json()
    assert targets["targets"][1]["order_style"]["limit_band_bps"] == 75.0
    for body in ({"order_type": "stop"}, {"limit_band_bps": 501}, {"limit_band_bps": -1}):
        assert setup["client"].post("/api/alpaca-paper/orders-policy", json={
            "expected_version": alpaca._read_config()["version"], "orders_enabled": False, **body}).status_code == 422
    with pytest.raises(ValueError):
        alpaca._order_style({"type": "market", "time_in_force": "gtc"})
    with pytest.raises(ValueError):
        alpaca._order_style({"limit_band_bps": True})


def test_limit_submission_prices_each_line_and_sends_limit_payloads(setup):
    connect_limit(band=50)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    revision = store.input_revision()
    response = submit(setup, acct, prop)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["summary"]["order_type"] == "limit" and result["summary"]["order_style"]["limit_band_bps"] == 50.0
    assert [order["order_type"] for order in result["orders"]] == ["limit", "limit"]
    for order in result["orders"]:
        expected = format(execution.limit_price(order["reference_price"], order["side"], 50), "f")
        assert order["limit_price"] == expected
        assert Decimal(order["limit_price"]) == Decimal(order["reference_price"]) * Decimal("1.005")
    assert result["summary"]["limit_prices"] == {order["client_order_id"]: order["limit_price"] for order in result["orders"]}
    posted = [payload for method, path, _, payload in setup["broker"].calls if method == "POST"]
    assert len(posted) == 2 and all(item["type"] == "limit" and item["time_in_force"] == "day" for item in posted)
    assert {item["limit_price"] for item in posted} == {order["limit_price"] for order in result["orders"]}
    assert store.input_revision() == revision
    json.dumps(result, allow_nan=False)


def test_missing_reference_price_refuses_the_whole_submission_without_sending(setup, monkeypatch):
    connect_limit(band=50)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    original = execution._plan_orders

    def strip_reference(db, as_of, proposal_id, orders, caps, style=None):
        return original(db, as_of, proposal_id, [{**order, "reference_price": None} for order in orders], caps, style)

    monkeypatch.setattr(execution, "_plan_orders", strip_reference)
    response = submit(setup, acct, prop)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "reference_unavailable"
    assert setup["broker"].calls == []
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM execution_orders").fetchone()[0] == 0
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (prop["id"],)).fetchone()[0] == "proposed"


def test_market_style_is_unchanged_and_limit_price_is_null(setup):
    connect()
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}])
    result = submit(setup, acct, prop).json()
    assert result["summary"]["order_type"] == "market" and "limit_prices" not in result["summary"]
    assert result["orders"][0]["order_type"] == "market" and result["orders"][0]["limit_price"] is None
    posted = [payload for method, _, _, payload in setup["broker"].calls if method == "POST"]
    assert posted[0]["type"] == "market" and "limit_price" not in posted[0]


def test_expired_partial_fill_keeps_quantities_and_submission_is_terminal_mixed(setup):
    connect_limit(band=50)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    result = submit(setup, acct, prop).json()
    broker = setup["broker"]
    first, second = (order["broker_order_id"] for order in result["orders"])
    broker.fill(first)
    broker.orders[second].update(status="partially_filled", filled_qty="3", filled_avg_price="99.4")
    working = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert working["status"] == "partially_filled" and working["reconcile_required"] and working["partial_fills"] == 0
    broker.orders[second].update(status="expired", expired_at="2024-01-05T21:00:00Z")
    final = setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile").json()
    assert final["status"] == "mixed" and final["terminal"] and not final["reconcile_required"]
    assert final["partial_fills"] == 1 and final["order_counts"] == {"filled": 1, "expired": 1}
    expired = final["orders"][1]
    assert expired["status"] == "expired" and expired["filled_qty"] == "3" and expired["filled_avg_price"] == "99.4"
    assert expired["broker"]["limit_price"] is None  # the fake broker does not echo limit prices; nothing is invented
    assert execution.derive_status([("expired", "3")]) == "mixed"
    assert execution.derive_status([("expired", "0"), ("cancelled", None)]) == "cancelled"
    assert execution.derive_status(["filled", "filled"]) == "filled"
    assert execution.derive_status([("filled", "10"), ("cancelled", "2")]) == "mixed"
    json.dumps(final, allow_nan=False)


def test_inbox_execution_events_are_derived_once_per_order_state(setup):
    connect_limit(band=50)
    acct = account()
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    result = submit(setup, acct, prop).json()
    setup["client"].app.include_router(inbox.router)
    assert setup["client"].get("/api/portfolio-agent/inbox").json()["execution_events"] == []  # accepted orders are not events
    broker = setup["broker"]
    first, second = (order["broker_order_id"] for order in result["orders"])
    broker.fill(first)
    broker.orders[second].update(status="expired", filled_qty="3", filled_avg_price="99.4")
    setup["client"].post(f"/api/execution/submissions/{result['id']}/reconcile")
    revision = store.input_revision()
    view = setup["client"].get("/api/portfolio-agent/inbox").json()
    events = view["execution_events"]
    by_symbol = {event["symbol"]: event for event in events}
    assert {event["kind"] for event in events} == {"execution_filled", "execution_expired"} and len(events) == 2
    filled, expired = by_symbol["SYNTA"], by_symbol["SYNTB"]
    assert filled["key"] == f"execution:{result['orders'][0]['id']}:execution_filled"
    assert filled["limit_price"] == result["orders"][0]["limit_price"] and filled["account_name"] == acct["name"]
    assert expired["partial_fill"] is True and expired["filled_qty"] == "3" and expired["kind"] == "execution_expired"
    assert view["execution_event_counts"] == {"execution_filled": 1, "execution_expired": 1}
    assert view["counts"]["execution_events"] == 2 and view["counts"]["execution_attention"] == 0
    again = setup["client"].get("/api/portfolio-agent/inbox").json()
    assert [event["key"] for event in again["execution_events"]] == [event["key"] for event in events]
    assert store.input_revision() == revision
    assert setup["client"].get("/api/portfolio-agent/inbox", params={"execution_limit": 1}).json()["execution_pagination"] == {
        "limit": 1, "returned": 1, "total": 2}
    json.dumps(view, allow_nan=False)
