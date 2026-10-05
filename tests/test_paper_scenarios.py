"""Deterministic hypothetical shocks, isolated synthetic paper accounts only."""
import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_portfolio as paper, paper_scenarios as scenarios, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "scenarios.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        for symbol, price in (("SYNTH", 100), ("OTHER", 50), ("THIRD", 25)):
            db.execute("INSERT INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok','2024-01-05')", (symbol,))
            db.execute("INSERT INTO bars VALUES (?,'2024-01-05',?,?,?,?,?,1000)", (symbol, price, price * 1.01, price * .99, price, price))
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES ('REAL-SYNTH','Synthetic real fixture',11,13,'test','test')")
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(scenarios.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic scenario", "initial_cash": 10000,
                                                          "idempotency_key": "scenario-account"}).json()["account"]
        yield client, account


def _invest(client, account):
    proposal = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={"expected_version": account["version"],
        "targets": [{"symbol": "SYNTH", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}],
        "idempotency_key": "scenario-buy"}).json()
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept", json={"expected_version": account["version"], "idempotency_key": "scenario-accept"})
    assert response.status_code == 200, response.text
    return response.json()["account"]["account"]


def _compare(client, account, **changes):
    response = client.post(f"/api/paper/accounts/{account['id']}/scenarios/compare", json={"expected_version": account["version"], "global_shock_pct": -20, **changes})
    assert response.status_code == 200, response.text
    return response.json()


def _counts():
    with store.connect() as db:
        return [db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] for name in ("paper_accounts", "paper_holdings", "paper_proposals", "paper_ledger", "paper_idempotency")]


def test_global_shock_applies_only_to_holdings_and_is_readonly(workspace):
    client, account = workspace
    account = _invest(client, account)
    before, revision, real = _counts(), store.input_revision(), store.positions()
    result = _compare(client, account)
    current = result["current"]
    assert result["engine_version"] == "alphaview-paper-scenarios-v1"
    assert result["paper_engine_version"] == paper.ENGINE_VERSION
    assert current["status"] == "available"
    assert current["base_equity"] == current["posttrade_equity"] == 10000
    assert current["stressed_equity"] == 9000 and current["cash"] == 5000
    assert current["shock_pnl"] == current["total_pnl"] == -1000
    assert current["shock_return_pct"] == current["total_return_pct"] == -10
    assert current["cash_weight_pct"] == 50
    assert current["stressed_cash_weight_pct"] == pytest.approx(5000 / 9000 * 100)
    assert current["worst_position"] == {"symbol": "SYNTH", "pnl": -600, "shock_pct": -20}
    assert current["cost_total"] == 0
    assert _counts() == before and store.input_revision() == revision and store.positions() == real
    json.dumps(result, allow_nan=False)


def test_symbol_override_replaces_global_and_normalizes_symbols(workspace):
    client, account = workspace
    account = _invest(client, account)
    current = _compare(client, account, symbol_shocks=[{"symbol": " synth ", "shock_pct": 10}])["current"]
    values = {row["symbol"]: row for row in current["positions"]}
    assert values["SYNTH"]["stressed_price"] == 110
    assert values["SYNTH"]["pnl"] == 300
    assert values["OTHER"]["stressed_price"] == 40
    assert current["stressed_equity"] == 9900
    assert current["worst_position"]["symbol"] == "OTHER"


def test_cash_only_current_is_unchanged_under_extreme_price_shock(workspace):
    client, account = workspace
    current = _compare(client, account, global_shock_pct=-99)["current"]
    assert current["stressed_equity"] == 10000
    assert current["shock_pnl"] == current["shock_return_pct"] == 0
    assert current["positions"] == [] and current["worst_position"] is None
    assert current["largest_weight_pct"] == current["stressed_largest_weight_pct"] == 0
    assert current["stressed_cash_weight_pct"] == 100


def test_full_target_plans_are_independent_and_do_not_execute(workspace):
    client, account = workspace
    account = _invest(client, account)
    before = _counts()
    result = _compare(client, account, plans=[{"name": "All cash", "targets": []},
        {"name": "Third only", "targets": [{"symbol": "THIRD", "weight_pct": 30}]}])
    cash, third = result["plans"]
    assert cash["status"] == third["status"] == "available"
    assert cash["stressed_equity"] == cash["cash"] == 10000
    assert cash["positions"] == []
    assert third["stressed_equity"] == 9400 and third["cash"] == 7000
    assert len(third["positions"]) == 1 and third["positions"][0]["symbol"] == "THIRD"
    assert third["positions"][0]["shares"] == 120
    assert len(cash["preview"]["orders"]) == 2
    assert len(third["preview"]["orders"]) == 3
    assert result["current"]["cash"] == 5000
    assert _counts() == before


def test_plan_execution_cost_is_separated_from_hypothetical_shock_pnl(workspace):
    client, account = workspace
    account = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 1,
        "execution_policy": {"fee_bps": 100, "slippage_bps": 100}}).json()["account"]
    plan = _compare(client, account, plans=[{"name": "Costed", "targets": [{"symbol": "SYNTH", "weight_pct": 30}]}])["plans"][0]
    assert plan["base_equity"] == 10000
    assert plan["posttrade_equity"] == 9939.7
    assert plan["stressed_equity"] == 9339.7
    assert plan["cash"] == 6939.7
    assert plan["fees_total"] == 30.3 and plan["slippage_total"] == 30 and plan["cost_total"] == 60.3
    assert plan["shock_pnl"] == -600
    assert plan["total_pnl"] == -660.3 and plan["total_return_pct"] == -6.603
    assert plan["shock_return_pct"] == pytest.approx(-600 / 9939.7 * 100)


def test_blocked_plan_keeps_preview_and_does_not_present_stress_as_executable(workspace):
    client, account = workspace
    plan = _compare(client, account, plans=[{"name": "Over limit", "targets": [{"symbol": "SYNTH", "weight_pct": 80}]}])["plans"][0]
    assert plan["status"] == "blocked"
    assert not plan["preview"]["executable"]
    assert plan["posttrade_equity"] == 10000
    assert plan["stressed_equity"] is None and plan["shock_pnl"] is None and plan["total_return_pct"] is None
    assert plan["positions"] == []
    assert "max_position_weight" in {item["code"] for item in plan["policy_breaches"]}


def test_minimum_trade_skip_preserves_existing_holdings_in_scenario(workspace):
    client, account = workspace
    account = _invest(client, account)
    account = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"],
        "execution_policy": {"min_trade_notional": 4000}}).json()["account"]
    plan = _compare(client, account, plans=[{"name": "Cash intent", "targets": []}])["plans"][0]
    assert plan["status"] == "available"
    assert len(plan["preview"]["skipped_orders"]) == 2
    assert len(plan["positions"]) == 2
    assert plan["cash"] == 5000 and plan["stressed_equity"] == 9000


def test_stress_detects_post_shock_concentration_and_cash_floor(workspace):
    client, account = workspace
    account = _invest(client, account)
    account = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": account["version"],
        "limits": {"max_position_weight_pct": 35, "min_cash_weight_pct": 40}}).json()["account"]
    current = _compare(client, account, global_shock_pct=200, symbol_shocks=[{"symbol": "OTHER", "shock_pct": 0}])["current"]
    assert current["stressed_equity"] == 16000
    assert current["stressed_cash_weight_pct"] == 31.25
    assert current["stressed_largest_weight_pct"] == 56.25
    codes = {item["code"] for item in current["policy_breaches"]}
    assert {"stressed_max_position_weight", "stressed_min_cash_weight"} <= codes
    assert current["status"] == "available"


def test_missing_current_quote_makes_current_unavailable_and_plan_blocked(workspace):
    client, account = workspace
    account = _invest(client, account)
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTH'")
    result = _compare(client, account, plans=[{"name": "Cash", "targets": []}])
    assert result["current"]["status"] == "unavailable"
    assert result["current"]["coverage"] == {"required": 2, "priced": 1, "missing": ["SYNTH"]}
    assert result["current"]["base_equity"] is None and result["current"]["stressed_equity"] is None
    assert result["current"]["cash"] == 5000
    assert all(row["pnl"] is None for row in result["current"]["positions"])
    assert result["plans"][0]["status"] == "blocked"
    assert result["plans"][0]["stressed_equity"] is None
    json.dumps(result, allow_nan=False)


def test_missing_new_target_quote_blocks_only_that_plan(workspace):
    client, account = workspace
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='THIRD'")
    result = _compare(client, account, plans=[{"name": "Good", "targets": [{"symbol": "SYNTH", "weight_pct": 30}]},
                                            {"name": "Missing", "targets": [{"symbol": "THIRD", "weight_pct": 30}]}])
    assert result["current"]["status"] == result["plans"][0]["status"] == "available"
    assert result["plans"][1]["status"] == "blocked"
    assert result["plans"][1]["coverage"]["missing"] == ["THIRD"]
    assert result["plans"][1]["base_equity"] == 10000


def test_unused_symbol_override_is_explicit_error(workspace):
    client, account = workspace
    response = client.post(f"/api/paper/accounts/{account['id']}/scenarios/compare", json={"expected_version": 1, "global_shock_pct": -20,
        "symbol_shocks": [{"symbol": "OTHER", "shock_pct": 10}], "plans": [{"name": "Zero weight", "targets": [{"symbol": "OTHER", "weight_pct": 0}]}]})
    assert response.status_code == 422
    assert "OTHER" in response.json()["detail"]
    # A positive target makes the override relevant, even for a plan.
    result = _compare(client, account, symbol_shocks=[{"symbol": "OTHER", "shock_pct": 10}],
                      plans=[{"name": "Positive", "targets": [{"symbol": "OTHER", "weight_pct": 20}]}])
    assert result["plans"][0]["positions"][0]["shock_pct"] == 10


def test_scenario_and_all_plan_previews_share_same_snapshot(workspace, monkeypatch):
    client, account = workspace
    revision = store.input_revision()
    original = paper._build_preview
    changed = []
    def racing_preview(*args, **kwargs):
        result = original(*args, **kwargs)
        if not changed:
            changed.append(True)
            with sqlite3.connect(store.db_path()) as db:
                db.execute("UPDATE bars SET open=200,high=201,low=199,close=200,adj_close=200 WHERE symbol='SYNTH'")
        return result
    monkeypatch.setattr(paper, "_build_preview", racing_preview)
    result = _compare(client, account, plans=[{"name": "First", "targets": [{"symbol": "SYNTH", "weight_pct": 30}]},
                                            {"name": "Second", "targets": [{"symbol": "SYNTH", "weight_pct": 20}]}])
    assert result["input_revision"] == revision
    assert all(plan["preview"]["input_revision"] == revision for plan in result["plans"])
    assert all(plan["positions"][0]["base_price"] == 100 for plan in result["plans"])
    assert store.input_revision() != revision


@pytest.mark.parametrize("changes", [
    {"expected_version": True}, {"global_shock_pct": -100}, {"global_shock_pct": 201},
    {"global_shock_pct": "NaN"}, {"global_shock_pct": True}, {"unexpected": 1},
    {"plans": [{"name": f"P{i}", "targets": []} for i in range(6)]},
    {"plans": [{"name": "   ", "targets": []}]},
    {"plans": [{"name": "Same", "targets": []}, {"name": " same ", "targets": []}]},
    {"plans": [{"name": "Too much", "targets": [{"symbol": "SYNTH", "weight_pct": 60}, {"symbol": "OTHER", "weight_pct": 60}]}]},
    {"symbol_shocks": [{"symbol": "SYNTH", "shock_pct": -20}, {"symbol": "synth", "shock_pct": 10}]},
    {"symbol_shocks": [{"symbol": "SYNTH", "shock_pct": 201}]},
    {"symbol_shocks": [{"symbol": "SYNTH", "shock_pct": "Infinity"}]},
])
def test_scenario_requests_are_strict_finite_and_bounded(workspace, changes):
    client, account = workspace
    response = client.post(f"/api/paper/accounts/{account['id']}/scenarios/compare", json={"expected_version": 1, "global_shock_pct": -20, **changes})
    assert response.status_code == 422


def test_scenario_version_conflict_and_missing_account_are_explicit(workspace):
    client, account = workspace
    assert client.post(f"/api/paper/accounts/{account['id']}/scenarios/compare", json={"expected_version": 2, "global_shock_pct": -20}).status_code == 409
    assert client.post("/api/paper/accounts/missing/scenarios/compare", json={"expected_version": 1, "global_shock_pct": -20}).status_code == 404


def test_scenario_plans_enforce_current_allowlist_without_mutating_account(workspace):
    client, account = workspace
    account = paper.update_controls(account["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": ["OTHER"]}))["account"]
    before, revision = _counts(), store.input_revision()
    result = _compare(client, account, plans=[{"name": "Excluded", "targets": [{"symbol": "SYNTH", "weight_pct": 20}]},
        {"name": "Allowed", "targets": [{"symbol": "OTHER", "weight_pct": 20}]}])
    assert result["plans"][0]["status"] == "blocked"
    assert result["plans"][0]["stressed_equity"] is None
    assert result["plans"][0]["policy_breaches"][0]["code"] == "symbol_not_allowed"
    assert result["plans"][1]["status"] == "available"
    assert _counts() == before and store.input_revision() == revision
