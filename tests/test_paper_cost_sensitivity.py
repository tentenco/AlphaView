"""Synthetic cost grids keep order size fixed and never mutate account or execution state."""
import json
import sqlite3

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_cost_sensitivity as costs, paper_portfolio as paper, sessions, store

AS_OF = "2024-01-05"
TARGETS = [{"symbol": "SYNTA", "weight_pct": 30}]


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "costs.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network request"))
    store.init_db()
    with store.connect() as db:
        for symbol, price, volume in (("SYNTA", 100, 1000), ("SYNTB", 50, 2000)):
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
            db.execute("INSERT INTO bars VALUES (?,?,?, ?, ?, ?, ?, ?)",
                       (symbol, AS_OF, price, price * 1.01, price * .99, price, price, volume))
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(costs.router)
    with TestClient(app) as client:
        acct = client.post("/api/paper/accounts", json={"name": "Synthetic costs", "initial_cash": 10000,
                           "idempotency_key": "synthetic-costs"}).json()["account"]
        yield client, acct


def payload(client, acct, targets=TARGETS):
    response = client.post(f"/api/paper/accounts/{acct['id']}/preview",
                           json={"expected_version": acct["version"], "targets": targets})
    assert response.status_code == 200, response.text
    preview = response.json()
    return {"expected_version": acct["version"], "expected_input_revision": preview["input_revision"],
            "expected_as_of": preview["as_of"], "expected_engine_version": preview["engine_version"], "targets": targets,
            "expected_orders": [{key: order[key] for key in ("symbol", "side", "shares", "reference_price")}
                                for order in preview["orders"]], "fee_bps": [0, 100], "slippage_bps": [0, 100]}, preview


def compare(client, acct, body):
    response = client.post(f"/api/paper/accounts/{acct['id']}/cost-sensitivity", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def state():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
                for table in ("paper_accounts", "paper_holdings", "paper_proposals", "paper_ledger", "paper_idempotency",
                              "execution_orders", "execution_submissions", "panel_revisions")}


def test_buy_grid_matches_hand_calculation_and_is_query_only(workspace, monkeypatch):
    client, acct = workspace
    body, preview = payload(client, acct)
    before = state()
    original = paper._build_preview

    def query_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM paper_accounts")
        return original(db, *args)

    monkeypatch.setattr(paper, "_build_preview", query_only)
    result = compare(client, acct, body)
    assert result["engine_version"] == "alphaview-paper-cost-sensitivity-v1"
    assert result["input_revision"] == preview["input_revision"] and result["as_of"] == AS_OF
    row = result["scenarios"][-1]
    assert row["fees_total"] == 30.3 and row["slippage_total"] == 30
    assert row["cost_total"] == row["cost_change_vs_baseline"] == 60.3
    assert row["cash_after"] == 6939.7 and row["equity_after"] == 9939.7
    assert result["liquidity"]["coverage"] == {"required": 1, "available": 1, "unavailable": 0}
    assert result["liquidity"]["orders"][0]["participation_pct"] == 3
    assert result["liquidity"]["orders"][0]["session_volume"] == 1000
    assert result == compare(client, acct, body) and state() == before


def test_sell_grid_charges_fees_on_adverse_sell_notional(workspace):
    client, acct = workspace
    proposal = paper.create_proposal(acct["id"], paper.ProposalInput(expected_version=acct["version"], targets=TARGETS,
                                                                 idempotency_key="synthetic-open"))
    acct = paper.accept_proposal(acct["id"], proposal["id"], paper.AcceptInput(
        expected_version=acct["version"], idempotency_key="synthetic-accept"))["account"]["account"]
    body, _ = payload(client, acct, [])
    before = state()
    result = compare(client, acct, body)
    row = result["scenarios"][-1]
    assert row["fees_total"] == 29.7 and row["slippage_total"] == 30 and row["cost_total"] == 59.7
    assert row["cash_after"] == row["equity_after"] == 9940.3
    assert result["liquidity"]["orders"][0]["side"] == "sell" and state() == before


def test_current_cost_cell_reproduces_paper_rounding_and_skipped_orders(workspace):
    client, acct = workspace
    acct = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=acct["version"],
        execution_policy=paper.ExecutionPolicy(fee_bps=12.345, slippage_bps=7.891, share_precision=2, min_trade_notional=600)))["account"]
    body, preview = payload(client, acct, [{"symbol": "SYNTA", "weight_pct": 10.123456}, {"symbol": "SYNTB", "weight_pct": 1}])
    body.update(fee_bps=[12.345], slippage_bps=[7.891])
    result = compare(client, acct, body)
    row = result["scenarios"][0]
    for key in ("fees_total", "slippage_total", "cost_total", "cash_after", "equity_after", "cash_weight_after_pct"):
        assert row[key] == preview[key]
    assert row["cost_change_vs_baseline"] == 0
    assert result["baseline"]["orders"][0]["shares"] == 10.12
    assert result["baseline"]["skipped_orders"][0]["symbol"] == "SYNTB"
    assert result["liquidity"]["coverage"]["required"] == 1


def test_cost_cells_keep_fixed_quantity_and_enforce_cash_and_concentration(workspace):
    client, acct = workspace
    acct = paper.update_controls(acct["id"], paper.ControlsInput(expected_version=1,
        limits=paper.Limits(max_position_weight_pct=100, min_cash_weight_pct=0)))["account"]
    body, preview = payload(client, acct, [{"symbol": "SYNTA", "weight_pct": 100}])
    assert preview["executable"]
    body.update(fee_bps=[0, 1000], slippage_bps=[0, 1000])
    result = compare(client, acct, body)
    stressed = result["scenarios"][-1]
    assert stressed["status"] == "blocked" and stressed["cash_after"] == -2100
    assert {row["code"] for row in stressed["violations"]} >= {"insufficient_cash", "post_policy_max_position_weight"}
    assert result["baseline"]["orders"][0]["shares"] == 100
    assert result["liquidity"]["orders"][0]["participation_pct"] == 10


def test_lower_hypothetical_cost_does_not_remove_baseline_block(workspace):
    client, acct = workspace
    body, preview = payload(client, acct, [{"symbol": "SYNTA", "weight_pct": 80}])
    assert not preview["executable"]
    result = compare(client, acct, body)
    assert all(row["status"] == "blocked" for row in result["scenarios"])
    assert all(any(reason["code"] == "max_position_weight" for reason in row["violations"]) for row in result["scenarios"])


def test_zero_volume_is_unavailable_without_using_prior_volume(workspace):
    client, acct = workspace
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=0 WHERE symbol='SYNTA'")
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-04',100,101,99,100,100,9999)")
    body, _ = payload(client, acct)
    result = compare(client, acct, body)
    row = result["liquidity"]["orders"][0]
    assert row["status"] == "unavailable" and row["participation_pct"] is None and row["session_volume"] is None
    assert row["reason"] == "nonpositive_or_nonfinite_volume"
    assert result["liquidity"]["coverage"] == {"required": 1, "available": 0, "unavailable": 1}
    assert result["scenarios"][-1]["cost_total"] == 60.3  # Explicit assumptions do not infer volume impact.


def test_missing_price_and_no_orders_do_not_publish_zero_cost_as_a_comparison(workspace):
    client, acct = workspace
    body, _ = payload(client, acct, [])
    result = compare(client, acct, body)
    assert all(row["reason"] == "no_planned_orders" and row["cost_total"] is None for row in result["scenarios"])
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTA'")
    body, _ = payload(client, acct)
    result = compare(client, acct, body)
    assert all(row["reason"] == "valuation_unavailable" and row["cost_total"] is None for row in result["scenarios"])
    assert result["baseline"]["coverage"]["missing"] == ["SYNTA"]


@pytest.mark.parametrize("change", [
    {"fee_bps": []}, {"slippage_bps": []}, {"fee_bps": [0, 1, 2, 3, 4, 5]},
    {"fee_bps": [-1]}, {"slippage_bps": [1001]}, {"fee_bps": [0, 0]},
    {"fee_bps": [True]}, {"slippage_bps": ["10"]}, {"unknown": 1},
    {"expected_as_of": "2024-02-30"},
])
def test_grid_inputs_are_strict_and_bounded(workspace, change):
    client, acct = workspace
    body, _ = payload(client, acct)
    response = client.post(f"/api/paper/accounts/{acct['id']}/cost-sensitivity", json={**body, **change})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("field,value", [
    ("expected_version", 99), ("expected_as_of", "2024-01-04"),
    ("expected_input_revision", "stale:1"), ("expected_engine_version", "old-method"),
    ("expected_orders", []),
])
def test_stale_or_forged_preview_identity_is_rejected(workspace, field, value):
    client, acct = workspace
    body, _ = payload(client, acct)
    response = client.post(f"/api/paper/accounts/{acct['id']}/cost-sensitivity", json={**body, field: value})
    assert response.status_code == 409, response.text


def test_maximum_grid_is_25_and_nonfinite_inputs_are_rejected(workspace):
    client, acct = workspace
    body, _ = payload(client, acct)
    body.update(fee_bps=[0, 10, 20, 30, 40], slippage_bps=[0, 10, 20, 30, 40])
    assert len(compare(client, acct, body)["scenarios"]) == 25
    with pytest.raises(ValueError):
        costs.SensitivityInput(**{**body, "fee_bps": [float("nan")]})
