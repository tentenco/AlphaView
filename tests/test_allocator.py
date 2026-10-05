"""Risk-aware allocator (alphaview-allocator-v1) on synthetic bars: hand-computed σ ratios, caps, and fail-closed σ."""
import hashlib
import json
import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import allocator, paper_portfolio as paper, portfolio_agent as agent, sessions, store
from tests.test_portfolio_agent import AS_OF, SYMBOLS, scan_row, seed_scan

LOOKBACK = 20
HISTORY = sessions.expected_sessions("2023-11-01", AS_OF)[-(LOOKBACK + 1):]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "allocator.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    store.init_db()
    with store.connect() as db:
        agent.init_schema(db)
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        _history(db, "SYNTA", 0.01)
        _history(db, "SYNTB", 0.02)
    app = FastAPI()
    app.include_router(agent.router)
    app.include_router(paper.router)
    with TestClient(app) as result:
        yield result


def _history(db, symbol, log_return):
    """Alternating ±log_return daily moves: sample σ of the 20 returns is exactly log_return × √(20/19)."""
    price = 100.0
    for index, day in enumerate(HISTORY):
        if index:
            price *= math.exp(log_return if index % 2 else -log_return)
        db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, price, price * 1.01, price * 0.99, price, price))


def _run(client, **constraints):
    body = {"scope": "market", "candidate_symbols": ["SYNTA", "SYNTB"],
            "constraints": {"max_positions": 2, "cash_buffer_pct": 0, "max_position_weight_pct": 100,
                            "volatility_lookback_sessions": LOOKBACK, **constraints}}
    response = client.post("/api/portfolio-agent/runs", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_equal_method_is_unchanged_and_default(client):
    seed_scan()
    explicit = _run(client, allocation_method="equal")
    implicit = client.post("/api/portfolio-agent/runs", json={"scope": "market", "candidate_symbols": ["SYNTA", "SYNTB"],
                           "constraints": {"max_positions": 2, "cash_buffer_pct": 0, "max_position_weight_pct": 100}}).json()
    assert explicit["target_weights"] == implicit["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 50}, {"symbol": "SYNTB", "weight_pct": 50}]
    assert implicit["request"]["constraints"]["allocation_method"] == "equal"
    assert implicit["allocator"]["engine_version"] == allocator.ENGINE_VERSION
    assert implicit["allocator"]["status"] == "applied" and implicit["allocator"]["lookback_sessions"] is None
    assert implicit["allocation"] == {"slot_weight_pct": 50, "unused_slots": 0, "method": "equal"}


def test_inverse_volatility_splits_the_same_budget_by_hand_computed_sigma(client):
    seed_scan()
    revision = store.input_revision()
    run = _run(client, allocation_method="inverse_volatility")
    json.dumps(run, allow_nan=False)
    assert run["status"] == "proposed"
    weights = {target["symbol"]: target["weight_pct"] for target in run["target_weights"]}
    assert weights["SYNTA"] == pytest.approx(200 / 3, abs=1e-6) and weights["SYNTB"] == pytest.approx(100 / 3, abs=1e-6)
    assert math.fsum(weights.values()) <= 100 and run["cash_weight_pct"] == pytest.approx(0, abs=1e-6)
    evidence = run["allocator"]
    assert evidence["method"] == "inverse_volatility" and evidence["lookback_sessions"] == LOOKBACK
    sigma = {row["symbol"]: row["sigma_annualized_pct"] for row in evidence["per_symbol"]}
    assert sigma["SYNTA"] == pytest.approx(0.01 * math.sqrt(20 / 19) * math.sqrt(252) * 100, rel=1e-6)
    assert sigma["SYNTB"] == pytest.approx(2 * sigma["SYNTA"], rel=1e-9)
    assert evidence["invested_budget_pct"] == 100 and evidence["capped_to_cash_pct"] == pytest.approx(0, abs=1e-6)
    assert run["steps"][1]["evidence"]["allocator"]["engine_version"] == allocator.ENGINE_VERSION
    assert all(check["passed"] for check in run["risk_checks"])
    assert store.input_revision() == revision


def test_position_cap_keeps_excess_in_cash_without_redistribution(client):
    seed_scan()
    run = _run(client, allocation_method="inverse_volatility", max_position_weight_pct=40)
    # slot = min(100/2, 40) = 40 → budget 80 split 2:1 → SYNTA 53.33 capped at 40, SYNTB 26.67; excess stays in cash
    assert run["allocator"]["slot_weight_pct"] == 40 and run["allocator"]["invested_budget_pct"] == 80
    weights = {target["symbol"]: target["weight_pct"] for target in run["target_weights"]}
    assert weights == {"SYNTA": 40, "SYNTB": pytest.approx(80 / 3, abs=1e-6)}
    assert run["cash_weight_pct"] == pytest.approx(100 - 40 - 80 / 3, abs=1e-6)
    assert run["allocator"]["capped_to_cash_pct"] == pytest.approx(160 / 3 - 40, abs=1e-6)
    assert next(row for row in run["allocator"]["per_symbol"] if row["symbol"] == "SYNTA")["raw_weight_pct"] == pytest.approx(160 / 3, abs=1e-6)
    assert all(check["passed"] for check in run["risk_checks"])


def test_cash_buffer_and_slot_budget_match_the_equal_method(client):
    seed_scan()
    run = _run(client, allocation_method="inverse_volatility", cash_buffer_pct=20, max_positions=4)
    # slot = min(80/4, 100) = 20; two selected → budget 40, split 2:1
    assert run["allocator"]["slot_weight_pct"] == 20 and run["allocator"]["invested_budget_pct"] == 40
    weights = {target["symbol"]: target["weight_pct"] for target in run["target_weights"]}
    assert weights["SYNTA"] == pytest.approx(80 / 3, abs=1e-6) and weights["SYNTB"] == pytest.approx(40 / 3, abs=1e-6)
    assert run["cash_weight_pct"] == pytest.approx(60, abs=1e-6)


def test_missing_history_blocks_without_equal_fallback(client):
    seed_scan()
    body = {"scope": "market", "candidate_symbols": ["SYNTA", "SYNTC"],
            "constraints": {"max_positions": 2, "cash_buffer_pct": 0, "max_position_weight_pct": 100,
                            "allocation_method": "inverse_volatility", "volatility_lookback_sessions": LOOKBACK}}
    run = client.post("/api/portfolio-agent/runs", json=body).json()
    json.dumps(run, allow_nan=False)
    assert run["status"] == "blocked" and run["target_weights"] == [] and run["cash_weight_pct"] is None
    reason = next(item for item in run["blocking_reasons"] if item["code"] == "allocation_unavailable")
    assert reason["symbols"] == ["SYNTC"] and reason["method"] == "inverse_volatility"
    assert run["allocator"]["status"] == "unavailable"
    assert run["allocator"]["unavailable"][0]["code"] == "history_incomplete"
    assert run["allocator"]["unavailable"][0]["missing_sessions"] == LOOKBACK
    assert any(warning.startswith("allocation_unavailable") for warning in run["warnings"])
    assert [row["status"] for row in run["candidates"]] == ["selected", "selected"]
    assert run["steps"][1]["status"] == "blocked"


def test_score_tilt_orders_by_score_over_sigma(client):
    seed_scan(rows=[scan_row("SYNTA"), scan_row("SYNTB", matches=agent.STRATEGY_IDS), scan_row("SYNTC"), scan_row("SYNTD")])
    run = _run(client, allocation_method="score_tilt")
    # SYNTA: score 50 / σ; SYNTB: score 100 / (2σ) → equal raw weights
    weights = {target["symbol"]: target["weight_pct"] for target in run["target_weights"]}
    assert weights["SYNTA"] == pytest.approx(50, abs=1e-6) and weights["SYNTB"] == pytest.approx(50, abs=1e-6)
    inverse = _run(client, allocation_method="inverse_volatility")
    assert {t["symbol"]: t["weight_pct"] for t in inverse["target_weights"]}["SYNTA"] == pytest.approx(200 / 3, abs=1e-6)


def test_evidence_is_inside_the_fingerprint_and_bridges_to_paper(client):
    seed_scan()
    run = _run(client, allocation_method="inverse_volatility")
    recomputed = hashlib.sha256(agent._json({key: value for key, value in run.items()
                                             if key not in ("proposal_fingerprint", "id", "created_at", "saved")}).encode()).hexdigest()
    assert run["proposal_fingerprint"] == recomputed
    account = client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 10000, "idempotency_key": "alloc-account"}).json()["account"]
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/paper-preview",
                           json={"account_id": account["id"], "expected_account_version": account["version"]})
    assert response.status_code == 200, response.text
    preview = response.json()["paper_preview"]
    assert {target["symbol"]: target["weight_pct"] for target in preview["targets"]} == {t["symbol"]: t["weight_pct"] for t in run["target_weights"]}
    assert "inverse_volatility" in preview["rationale"] and allocator.ENGINE_VERSION in preview["rationale"]


def test_allocation_comparison_is_read_only_and_bounded(client):
    seed_scan()
    run = _run(client, allocation_method="equal")
    revision = store.input_revision()
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/allocations", json={})
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    assert result["engine_version"] == allocator.ENGINE_VERSION and result["run_method"] == "equal"
    assert set(result["methods"]) == set(allocator.METHODS)
    assert result["methods"]["equal"]["targets"] == run["target_weights"]
    assert {t["symbol"]: t["weight_pct"] for t in result["methods"]["inverse_volatility"]["targets"]}["SYNTA"] == pytest.approx(200 / 3, abs=1e-6)
    assert result["methods"]["score_tilt"]["status"] == "applied"
    assert client.post(f"/api/portfolio-agent/runs/{run['id']}/allocations", json={"volatility_lookback_sessions": 10}).status_code == 422
    assert client.post(f"/api/portfolio-agent/runs/{run['id']}/allocations", json={"unknown": 1}).status_code == 422
    assert client.post("/api/portfolio-agent/runs/missing/allocations", json={}).status_code == 404
    assert store.input_revision() == revision


@pytest.mark.parametrize("changes", [{"allocation_method": "risk_parity"}, {"volatility_lookback_sessions": 19},
                                     {"volatility_lookback_sessions": 121}, {"volatility_lookback_sessions": 60.0}])
def test_allocator_settings_are_strictly_validated(client, changes):
    response = client.post("/api/portfolio-agent/preview", json={"scope": "market", "candidate_symbols": ["SYNTA"], "constraints": changes})
    assert response.status_code == 422


def test_volatility_requires_the_full_window_and_positive_variance(client):
    with store.connect() as db:
        value, reason = allocator.volatility(db, "SYNTA", AS_OF, LOOKBACK)
        assert reason is None and value > 0
        assert allocator.volatility(db, "SYNTA", AS_OF, LOOKBACK + 1)[1]["code"] == "history_incomplete"
        for day in HISTORY:
            db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTD',?,100,101,99,100,100,1000)", (day,))
        assert allocator.volatility(db, "SYNTD", AS_OF, LOOKBACK)[1]["code"] == "zero_volatility"
        db.execute("UPDATE bars SET adj_close=0 WHERE symbol='SYNTD' AND date=?", (HISTORY[3],))
        assert allocator.volatility(db, "SYNTD", AS_OF, LOOKBACK)[1]["code"] == "invalid_price"
