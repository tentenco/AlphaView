"""Synthetic open-only limit comparisons do not infer an intraday execution path."""
import json
import sqlite3

import pytest

from alphaview.panel import execution_limit_study as limit, sessions, store
from tests.test_execution_volume_study import workspace, bar, state, SIGNAL, EXECUTION  # noqa: F401


@pytest.fixture
def ready(workspace):
    workspace[0].app.include_router(limit.router)
    return workspace


def url(ready):
    _, account, proposal, _ = ready
    return f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/limit-study"


def body(ready, limits=None, participation=10):
    response = ready[0].get(url(ready) + "/context")
    assert response.status_code == 200, response.text
    value = response.json()
    return {"expected_account_version": value["account_version"], "expected_input_revision": value["input_revision"],
        "expected_as_of": value["as_of"], "expected_proposal_fingerprint": value["source"]["proposal_fingerprint"],
        "participation_pct": participation, "limits": limits or []}


def study(ready, limits=None, participation=10):
    response = ready[0].post(url(ready), json=body(ready, limits, participation))
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def test_open_only_buy_partial_expiry_no_limit_and_readonly(ready, monkeypatch):
    original = limit._context
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM paper_accounts")
        return original(db, *args)
    monkeypatch.setattr(limit, "_context", readonly)
    before = state()
    result = study(ready, [{"symbol": "SYNTA", "limit_price": 110}])
    assert result["engine_version"] == "alphaview-execution-limit-study-v1"
    assert result["capacity_engine_version"] == "alphaview-execution-volume-study-v1"
    assert result["scenario_window"] == "open_only" and result["time_in_force"] == "DAY"
    assert result["costs_included"] is False
    first, second = result["orders"]
    assert first["open_condition"] == "satisfied" and first["scenario_shares"] == 10 and first["expired_shares"] == 20
    assert first["status"] == "partial_expired" and first["raw_open"] == first["limit_price"] == 110
    assert first["reference_notional"] == 1100 and first["intraday_outcome"] == "unknown_from_daily_bars"
    assert second["open_condition"] == "not_applied" and second["limit_price"] is None and second["status"] == "full"
    assert "NOT opening liquidity" in result["method"]
    assert study(ready, [{"symbol": "SYNTA", "limit_price": 110}]) == result and state() == before


@pytest.mark.parametrize("price,condition,quantity", [(109.999999, "not_satisfied", 0), (110, "satisfied", 10), (111, "satisfied", 10)])
def test_buy_limit_boundary(ready, price, condition, quantity):
    row = study(ready, [{"symbol": "SYNTA", "limit_price": price}])["orders"][0]
    assert row["open_condition"] == condition and row["scenario_shares"] == quantity
    assert row["expired_shares"] == 30 - quantity
    if not quantity:
        assert row["status"] == "not_marketable_at_open_expired" and row["reason"] == "open_does_not_meet_limit"
        assert row["capacity_shares"] == 10 and row["intraday_outcome"] == "unknown_from_daily_bars"


def sell_proposal(ready):
    client, account, _, clock = ready
    base = f"/api/paper/accounts/{account['id']}"
    opening = client.post(base + "/proposals", json={"expected_version": account["version"],
        "targets": [{"symbol": "SYNTA", "weight_pct": 30}], "idempotency_key": "synthetic-limit-opening"}).json()
    accepted = client.post(base + f"/proposals/{opening['id']}/accept", json={"expected_version": account["version"],
        "idempotency_key": "synthetic-limit-accept"})
    assert accepted.status_code == 200, accepted.text
    account = accepted.json()["account"]["account"]
    closing = client.post(base + "/proposals", json={"expected_version": account["version"], "targets": [],
        "idempotency_key": "synthetic-limit-closing"}).json()
    assert closing["orders"][0]["side"] == "sell"
    with store.connect() as db:
        bar(db, "SYNTA", "2024-01-09", 90, 100)
    clock["session"] = "2024-01-09"
    return client, account, closing, clock


@pytest.mark.parametrize("price,condition,quantity", [(89, "satisfied", 10), (90, "satisfied", 10), (90.000001, "not_satisfied", 0)])
def test_sell_limit_boundary_and_frozen_holdings(ready, price, condition, quantity):
    ready = sell_proposal(ready)
    before = state()
    row = study(ready, [{"symbol": "SYNTA", "limit_price": price}])["orders"][0]
    assert row["side"] == "sell" and row["open_condition"] == condition and row["scenario_shares"] == quantity
    assert row["reference_notional"] == quantity * 90
    assert state() == before


def test_daily_low_touch_cannot_create_limit_fill_and_volume_does_not_prove_opening_liquidity(ready):
    with store.connect() as db:
        db.execute("UPDATE bars SET low=90,high=150,volume=999999 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
    row = study(ready, [{"symbol": "SYNTA", "limit_price": 100}])["orders"][0]
    assert row["evidence"]["execution_bar"]["low"] < row["limit_price"] < row["raw_open"]
    assert row["scenario_shares"] == 0 and row["expired_shares"] == 30
    assert row["intraday_outcome"] == "unknown_from_daily_bars"


@pytest.mark.parametrize("field,value,reason", [("volume", "unavailable", "invalid_execution_volume"),
    ("volume", -1, "invalid_execution_volume"), ("open", 0, "invalid_execution_open"),
    ("adj_close", 55, "adjustment_factor_changed"), ("high", 0, "invalid_execution_bar")])
def test_missing_required_evidence_never_becomes_zero_even_if_limit_not_marketable(ready, field, value, reason):
    with store.connect() as db:
        db.execute(f"UPDATE bars SET {field}=? WHERE symbol='SYNTA' AND date=?", (value, EXECUTION))
    row = study(ready, [{"symbol": "SYNTA", "limit_price": 50}])["orders"][0]
    assert row["status"] == row["open_condition"] == "unavailable" and row["reason"] == reason
    assert row["scenario_shares"] is row["expired_shares"] is row["reference_notional"] is None
    assert row["limit_price"] == 50


@pytest.mark.parametrize("participation,volume", [(0, 100), (10, 0)])
def test_explicit_zero_capacity_still_expires_only_within_scenario(ready, participation, volume):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=? WHERE symbol='SYNTA' AND date=?", (volume, EXECUTION))
    row = study(ready, [{"symbol": "SYNTA", "limit_price": 110}], participation)["orders"][0]
    assert row["open_condition"] == "satisfied" and row["status"] == "unfilled_expired"
    assert row["scenario_shares"] == 0 and row["expired_shares"] == 30


def test_exact_session_missing_and_incomplete_session_are_unavailable(ready):
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
        bar(db, "SYNTA", "2024-01-09", 50, 99999)
    result = study(ready)
    assert result["orders"][0]["reason"] == "missing_execution_bar"
    assert result["coverage"] == {"required": 2, "available": 1, "unavailable": 1}
    ready[3]["session"] = SIGNAL
    assert all(row["reason"] == "execution_session_not_completed" for row in study(ready)["orders"])


@pytest.mark.parametrize("changes", [{"limits": [{"symbol": "SYNTA", "limit_price": 0}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": True}]}, {"limits": [{"symbol": "SYNTA", "limit_price": "100"}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": 1e13}]}, {"limits": [{"symbol": "SYNTA", "limit_price": 100, "notes": "excluded"}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": 100}, {"symbol": "SYNTA", "limit_price": 101}]},
    {"limits": [{"symbol": "SYNTX", "limit_price": 100}]}, {"limits": [{"symbol": "synta", "limit_price": 100}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": 100}] * 101}, {"expected_account_version": True},
    {"expected_account_version": 2_147_483_648}, {"participation_pct": "1"}, {"participation_pct": 101},
    {"time_in_force": "GTC"}, {"expected_as_of": "2024-02-30"}])
def test_strict_body_and_bounded_explicit_saved_symbols(ready, changes):
    before = state()
    response = ready[0].post(url(ready), json={**body(ready), **changes})
    assert response.status_code == 422 and state() == before


def test_nonfinite_nested_limit_cleanly_rejected(ready):
    payload = json.dumps(body(ready, [{"symbol": "SYNTA", "limit_price": 100}])).replace('"limit_price": 100', '"limit_price": 1e999')
    response = ready[0].post(url(ready), content=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "nonfinite_input"


@pytest.mark.parametrize("field,value", [("expected_account_version", 999), ("expected_input_revision", "stale"),
    ("expected_as_of", "2024-01-09"), ("expected_proposal_fingerprint", "0" * 64)])
def test_current_source_cas_without_writes(ready, field, value):
    before = state()
    assert ready[0].post(url(ready), json={**body(ready), field: value}).status_code == 409
    assert state() == before


def test_new_bars_after_context_and_session_rollover_reject(ready, monkeypatch):
    pending = body(ready)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=200 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
    assert ready[0].post(url(ready), json=pending).status_code == 409
    original = limit._row
    def rollover(*args):
        result = original(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-09")
        return result
    pending = body(ready)
    monkeypatch.setattr(limit, "_row", rollover)
    assert ready[0].post(url(ready), json=pending).status_code == 409


def test_cross_account_and_invalid_id(ready):
    client, _, proposal, _ = ready
    other = client.post("/api/paper/accounts", json={"name": "Synthetic other limits", "initial_cash": 10000,
        "idempotency_key": "synthetic-other-limits"}).json()["account"]
    wrong = f"/api/paper/accounts/{other['id']}/proposals/{proposal['id']}/limit-study"
    assert client.get(wrong + "/context").status_code == 404
    assert client.post(wrong, json=body(ready)).status_code == 404
    assert client.get('/api/paper/accounts/invalid/proposals/invalid/limit-study/context').status_code == 422


@pytest.mark.parametrize("change,reason", [("blocked", "blocked_source_proposal"), ("method", "paper_method_unsupported"),
                                        ("empty", "no_saved_orders")])
def test_unavailable_saved_proposal_is_not_a_zero_fill(ready, change, reason):
    with store.connect() as db:
        row = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (ready[2]["id"],)).fetchone()
        value = json.loads(row[0])
        if change == "blocked":
            value["executable"] = False
        elif change == "method":
            value["engine_version"] = "synthetic-unsupported"
        else:
            value["orders"] = []
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(value), ready[2]["id"]))
    result = study(ready)
    assert result["status"] == "unavailable" and result["source"]["reason"] == reason
    assert all(row["scenario_shares"] is None for row in result["orders"])


def test_decimal_capacity_rounding_does_not_redistribute_and_keeps_limits_request_canonical(ready):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=1.23456789 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
    result = study(ready, [{"symbol": "SYNTB", "limit_price": 100}, {"symbol": "SYNTA", "limit_price": 110}], 1)
    assert result["orders"][0]["scenario_shares_exact"] == "0.012345"
    assert result["orders"][0]["expired_shares_exact"] == "29.987655"
    assert result["orders"][1]["scenario_shares"] == 10
    assert [item["symbol"] for item in result["request"]["limits"]] == ["SYNTA", "SYNTB"]


def test_snapshot_bars_remain_consistent_during_concurrent_local_publication(ready, monkeypatch):
    pending = body(ready, [{"symbol": "SYNTA", "limit_price": 110}])
    original = limit._row
    changed = False
    def publish_elsewhere(db, *args):
        nonlocal changed
        if not changed:
            changed = True
            with sqlite3.connect(store.db_path()) as other:
                other.execute("UPDATE bars SET volume=999999 WHERE date=?", (EXECUTION,))
        return original(db, *args)
    monkeypatch.setattr(limit, "_row", publish_elsewhere)
    response = ready[0].post(url(ready), json=pending)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["input_revision"] == pending["expected_input_revision"]
    assert [row["session_volume"] for row in value["orders"]] == [100, 1000]
    assert ready[0].post(url(ready), json=pending).status_code == 409
