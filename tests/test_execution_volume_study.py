"""Synthetic saved quantities and exact-day capacity, with no execution side effects."""
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import execution_volume_study as volume, paper_portfolio as paper, sessions, store

SIGNAL = "2024-01-05"
EXECUTION = "2024-01-08"


def bar(db, symbol, day, price, volume=1000):
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)",
               (symbol, day, price, price * 1.01, price * .99, price, price, volume))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic-volume.db"))
    clock = {"session": SIGNAL}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: clock["session"])
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected outbound call"))
    store.init_db()
    with store.connect() as db:
        for symbol in ("SYNTA", "SYNTB"):
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
            bar(db, symbol, SIGNAL, 100)
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(volume.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic volume study", "initial_cash": 10000,
                              "idempotency_key": "synthetic-account"}).json()["account"]
        response = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={
            "expected_version": account["version"], "idempotency_key": "synthetic-proposal",
            "targets": [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}]})
        assert response.status_code == 200, response.text
        proposal = response.json()
        assert proposal["executable"]
        with store.connect() as db:
            bar(db, "SYNTA", EXECUTION, 110, 100)
            bar(db, "SYNTB", EXECUTION, 95, 1000)
        clock["session"] = EXECUTION
        yield client, account, proposal, clock


def url(account, proposal):
    return f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/volume-study"


def body_for(client, account, proposal, participation=10):
    response = client.get(url(account, proposal) + "/context")
    assert response.status_code == 200, response.text
    context = response.json()
    return {"expected_account_version": context["account_version"], "expected_input_revision": context["input_revision"],
            "expected_as_of": context["as_of"], "expected_proposal_fingerprint": context["source"]["proposal_fingerprint"],
            "participation_pct": participation}


def study(workspace, participation=10):
    client, account, proposal, _ = workspace
    response = client.post(url(account, proposal), json=body_for(client, account, proposal, participation))
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def state():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
                for table in ("paper_accounts", "paper_holdings", "paper_proposals", "paper_ledger", "paper_idempotency",
                              "execution_orders", "execution_submissions", "panel_revisions")}


def test_frozen_shares_next_open_partial_expiry_and_readonly_snapshot(workspace, monkeypatch):
    before = state()
    original = volume._context

    def query_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM paper_accounts")
        return original(db, *args)

    monkeypatch.setattr(volume, "_context", query_only)
    result = study(workspace)
    assert result["engine_version"] == "alphaview-execution-volume-study-v1"
    assert result["execution_session"] == EXECUTION and result["time_in_force"] == "DAY"
    assert result["coverage"] == {"required": 2, "available": 2, "unavailable": 0}
    first, second = result["orders"]
    assert first["shares"] == 30 and first["raw_open"] == 110
    assert first["capacity_shares"] == first["scenario_shares"] == 10
    assert first["expired_shares"] == 20 and first["reference_notional"] == 1100
    assert first["status"] == "partial_expired" and second["status"] == "full"
    assert second["scenario_shares"] == 20 and second["expired_shares"] == 0
    assert result["source"]["current"] is False
    assert set(result["source"]["stale_reasons"]) == {"inputs_changed", "session_changed"}
    assert result["source"]["available"] is True
    assert "not known at the open" in result["method"]
    assert len(result["bars_fingerprint"]) == 64
    assert study(workspace) == result and state() == before


def test_capacity_rounds_down_saved_precision_and_is_per_symbol(workspace):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=1.23456789 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
    result = study(workspace, 1)
    first, second = result["orders"]
    assert first["scenario_shares_exact"] == "0.012345"
    assert first["expired_shares_exact"] == "29.987655"
    assert second["scenario_shares"] == 10  # Never receives the other order's shortfall/capacity.


@pytest.mark.parametrize("participation,volume_value", [(0, 1000), (10, 0)])
def test_explicit_zero_is_unfilled_and_expires(workspace, participation, volume_value):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=? WHERE date=?", (volume_value, EXECUTION))
    rows = study(workspace, participation)["orders"]
    assert all(row["status"] == "unfilled_expired" and row["scenario_shares"] == 0 for row in rows)
    assert all(row["expired_shares"] == row["shares"] and row["reason"] is None for row in rows)


def test_missing_exact_day_never_uses_prior_or_later_bar(workspace):
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
        bar(db, "SYNTA", "2024-01-09", 999, 9999999)
    result = study(workspace)
    first = result["orders"][0]
    assert first["reason"] == "missing_execution_bar" and first["status"] == "unavailable"
    assert first["scenario_shares"] is first["expired_shares"] is first["reference_notional"] is None
    assert result["coverage"] == {"required": 2, "available": 1, "unavailable": 1}
    assert result["status"] == "incomplete"


@pytest.mark.parametrize("field,value,reason", [
    ("volume", -1, "invalid_execution_volume"), ("volume", float("inf"), "invalid_execution_volume"),
    ("volume", "not-volume", "invalid_execution_volume"), ("open", 0, "invalid_execution_open"),
    ("open", float("inf"), "invalid_execution_open"), ("adj_close", 55, "adjustment_factor_changed"),
    ("close", 0, "invalid_execution_basis"),
    ("high", 1, "invalid_execution_bar"),
])
def test_invalid_volume_open_and_adjustment_basis_stay_unavailable(workspace, field, value, reason):
    with store.connect() as db:
        db.execute(f"UPDATE bars SET {field}=? WHERE symbol='SYNTA' AND date=?", (value, EXECUTION))
    row = study(workspace)["orders"][0]
    assert row["status"] == "unavailable" and row["reason"] == reason
    assert row["scenario_shares"] is row["capacity_shares"] is row["expired_shares"] is None


def test_uncompleted_session_ignores_even_prefetched_future_bars(workspace):
    workspace[3]["session"] = SIGNAL
    result = study(workspace)
    assert result["session_completed"] is False
    assert all(row["reason"] == "execution_session_not_completed" for row in result["orders"])
    assert all(row["evidence"]["execution_bar"] is None for row in result["orders"])


@pytest.mark.parametrize("change,reason", [("signal", "signal_reference_changed"), ("currency", "usd_identity_unavailable")])
def test_signal_revision_and_unknown_currency_do_not_create_fills(workspace, change, reason):
    with store.connect() as db:
        if change == "signal":
            db.execute("UPDATE bars SET close=101 WHERE symbol='SYNTA' AND date=?", (SIGNAL,))
        else:
            db.execute("UPDATE datasets SET currency=NULL WHERE symbol='SYNTA'")
    assert study(workspace)["orders"][0]["reason"] == reason


@pytest.mark.parametrize("field,value", [("expected_account_version", 999), ("expected_input_revision", "obsolete"),
    ("expected_as_of", "2024-01-09"), ("expected_proposal_fingerprint", "0" * 64)])
def test_changed_context_or_proposal_fingerprint_conflicts_without_writes(workspace, field, value):
    client, account, proposal, _ = workspace
    body = body_for(client, account, proposal)
    before = state()
    response = client.post(url(account, proposal), json={**body, field: value})
    assert response.status_code == 409 and state() == before


def test_bar_changes_between_context_and_post_conflict(workspace):
    client, account, proposal, _ = workspace
    body = body_for(client, account, proposal)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=123 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
    before = state()
    assert client.post(url(account, proposal), json=body).status_code == 409
    assert state() == before


@pytest.mark.parametrize("change", [{"participation_pct": True}, {"participation_pct": "10"}, {"participation_pct": -1},
    {"participation_pct": 101}, {"expected_account_version": True}, {"order_type": "limit"},
    {"expected_as_of": "2024-02-30"}])
def test_strict_finite_bounded_body_and_no_limit_inference(workspace, change):
    client, account, proposal, _ = workspace
    body = body_for(client, account, proposal)
    assert client.post(url(account, proposal), json={**body, **change}).status_code == 422


def test_nonfinite_body_rejected_without_json_nan_response(workspace):
    client, account, proposal, _ = workspace
    body = body_for(client, account, proposal)
    # A numeric exponent overflow exercises JSON finite validation without a nonstandard NaN token.
    raw = json.dumps(body).replace('"participation_pct": 10', '"participation_pct": 1e999')
    response = client.post(url(account, proposal), content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "nonfinite_input"


def test_cross_account_and_invalid_identifiers_are_rejected(workspace):
    client, account, proposal, _ = workspace
    other = client.post("/api/paper/accounts", json={"name": "Synthetic other", "initial_cash": 10000,
                        "idempotency_key": "other-account"}).json()["account"]
    assert client.get(url(other, proposal) + "/context").status_code == 404
    assert client.post(url(other, proposal), json=body_for(client, account, proposal)).status_code == 404
    assert client.get(url({"id": "invalid"}, proposal) + "/context").status_code == 422


@pytest.mark.parametrize("kind,expected", [("blocked", "blocked_source_proposal"), ("method", "paper_method_unsupported"),
                                          ("empty", "no_saved_orders")])
def test_blocked_unknown_method_and_empty_saved_source_are_explicit(workspace, kind, expected):
    client, account, proposal, _ = workspace
    with store.connect() as db:
        preview = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0])
        if kind == "blocked":
            preview["executable"] = False
        elif kind == "method":
            preview["engine_version"] = "unknown-paper-version"
        else:
            preview["orders"] = []
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(preview), proposal["id"]))
    result = study(workspace)
    assert result["status"] == "unavailable" and result["source"]["reason"] == expected
    assert all(row["reason"] == expected and row["scenario_shares"] is None for row in result["orders"])


def test_corrupt_saved_quantity_is_not_replaced_or_silently_rounded(workspace):
    client, account, proposal, _ = workspace
    with store.connect() as db:
        row = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()
        preview = json.loads(row[0]); preview["orders"][0]["shares_exact"] = "30.0000001"
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(preview), proposal["id"]))
    response = client.get(url(account, proposal) + "/context")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "saved_proposal_unavailable"


def test_a_saved_sell_uses_frozen_quantity_without_changing_holdings(workspace):
    client, account, _, clock = workspace
    base = f"/api/paper/accounts/{account['id']}"
    opening = client.post(base + "/proposals", json={"expected_version": account["version"],
        "targets": [{"symbol": "SYNTA", "weight_pct": 30}], "idempotency_key": "synthetic-opening"}).json()
    accepted = client.post(base + f"/proposals/{opening['id']}/accept", json={
        "expected_version": account["version"], "idempotency_key": "synthetic-fill"})
    assert accepted.status_code == 200, accepted.text
    account = accepted.json()["account"]["account"]
    closing = client.post(base + "/proposals", json={"expected_version": account["version"], "targets": [],
        "idempotency_key": "synthetic-closing"}).json()
    assert closing["orders"][0]["side"] == "sell"
    with store.connect() as db:
        bar(db, "SYNTA", "2024-01-09", 90, 100)
    clock["session"] = "2024-01-09"
    before = state()
    result = study((client, account, closing, clock), 10)
    row = result["orders"][0]
    assert row["side"] == "sell" and row["scenario_shares"] == 10
    assert row["reference_notional"] == 900 and row["status"] == "partial_expired"
    assert state() == before


def test_snapshot_does_not_mix_bars_changed_after_context(workspace, monkeypatch):
    client, account, proposal, _ = workspace
    body = body_for(client, account, proposal)
    original = volume._row
    changed = False

    def concurrent_bar_publish(db, *args):
        nonlocal changed
        if not changed:
            changed = True
            with sqlite3.connect(store.db_path()) as other:
                other.execute("UPDATE bars SET volume=999999 WHERE date=?", (EXECUTION,))
        return original(db, *args)

    monkeypatch.setattr(volume, "_row", concurrent_bar_publish)
    response = client.post(url(account, proposal), json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["input_revision"] == body["expected_input_revision"]
    assert [row["session_volume"] for row in result["orders"]] == [100, 1000]
    assert client.post(url(account, proposal), json=body).status_code == 409
