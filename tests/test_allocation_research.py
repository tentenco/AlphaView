"""Independent mathematical oracles and synthetic saved-workflow research contracts."""
import hashlib
import json
import math
import sqlite3

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import allocation_research as research, allocator, portfolio_agent as agent, sessions, store
from tests.test_portfolio_agent import AS_OF, SYMBOLS, scan_row, seed_scan

DAYS = sessions.expected_sessions("2023-01-01", AS_OF)[-121:]


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "allocation-research.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected external call"))
    store.init_db()
    with store.connect() as db:
        for index, symbol in enumerate(SYMBOLS):
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
            price = 100.0
            for offset, day in enumerate(DAYS):
                if offset:
                    price *= math.exp(.01 * (math.sin(offset * (index + 1)) + .2 * math.cos(offset * .3)))
                db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, price, price * 1.01, price * .99, price, price))
    seed_scan(rows=[scan_row(symbol) for symbol in SYMBOLS])
    app = FastAPI()
    app.include_router(agent.router)
    app.include_router(research.router)
    with TestClient(app) as client:
        yield client


def saved(client, symbols=None, **constraints):
    response = client.post("/api/portfolio-agent/runs", json={"scope": "market", "candidate_symbols": symbols or SYMBOLS[:3],
        "constraints": {"max_positions": 3, "cash_buffer_pct": 10, "max_position_weight_pct": 40, **constraints}})
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["status"] == "proposed"
    return result


def body(run, **changes):
    return {"expected_proposal_fingerprint": run["proposal_fingerprint"], "expected_input_revision": run["input_revision"],
            "expected_as_of": run["as_of"], "lookback_sessions": 20, **changes}


def compare(client, run, **changes):
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run, **changes))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def state():
    with store.connect() as db:
        return {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name}")]
                for name in ("portfolio_agent_runs", "paper_accounts", "paper_proposals", "paper_ledger", "execution_orders", "panel_revisions")}


def rewrite_run(run, change):
    """Synthetic historical input construction, with a correctly recomputed saved fingerprint."""
    with store.connect() as db:
        result = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (run["id"],)).fetchone()[0])
        change(result)
        result.pop("proposal_fingerprint")
        result["proposal_fingerprint"] = hashlib.sha256(agent._json(result).encode()).hexdigest()
        db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (agent._json(result), run["id"]))
    return {**result, "id": run["id"]}


def test_rank_sum_uses_frozen_rank_budget_caps_and_keeps_excess_cash(workspace, monkeypatch):
    run = saved(workspace, symbols=["SYNTC", "SYNTA", "SYNTB"])
    before = state()
    original = research._history

    def query_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM portfolio_agent_runs")
        return original(db, *args)

    monkeypatch.setattr(research, "_history", query_only)
    result = compare(workspace, run)
    assert result["engine_version"] == "alphaview-allocation-research-v1"
    assert result["selected_symbols"] == ["SYNTA", "SYNTB", "SYNTC"]
    assert result["invested_budget_pct"] == 90
    assert result["methods"]["rank_sum"]["weights"] == [
        {"symbol": "SYNTA", "raw_weight_pct": 45, "capped_weight_pct": 40},
        {"symbol": "SYNTB", "raw_weight_pct": 30, "capped_weight_pct": 30},
        {"symbol": "SYNTC", "raw_weight_pct": 15, "capped_weight_pct": 15}]
    assert result["methods"]["rank_sum"]["cash_after_pct"] == 15
    assert result["methods"]["rank_sum"]["capped_or_rounded_to_cash_pct"] == 5
    assert result["coverage"]["common_return_sessions"] == 20
    assert result["coverage"]["valid_closes"] == result["coverage"]["required_closes"] == 63
    assert len(result["covariance_annualized"]) == 3 and result["window"]["price_dates"] == DAYS[-21:]
    assert result == compare(workspace, run) and state() == before


def test_saved_capped_budget_is_not_reclaimed_or_recomputed(workspace):
    run = saved(workspace, allocation_method="inverse_volatility", max_position_weight_pct=30)
    run = rewrite_run(run, lambda result: result.update(target_weights=[{"symbol": symbol, "weight_pct": weight}
        for symbol, weight in zip(SYMBOLS, [20, 15, 10])], cash_weight_pct=55))
    result = compare(workspace, run)
    assert result["invested_budget_pct"] == 45
    assert result["methods"]["rank_sum"]["cash_before_pct"] == 55
    assert result["methods"]["rank_sum"]["weights"][0]["raw_weight_pct"] == 22.5


def test_full_covariance_solver_has_equal_risk_not_inverse_volatility():
    covariance = np.array([[.01, .004, .001], [.004, .04, -.003], [.001, -.003, .0225]])
    sigmas = np.sqrt(np.diag(covariance))
    weights, evidence = research._erc(covariance, covariance / np.outer(sigmas, sigmas))
    assert evidence["converged"] and evidence["sweeps"] < 100
    assert sum(weights) == pytest.approx(1) and all(weights > 0)
    independent = [weights[index] * sum(covariance[index, other] * weights[other] for other in range(3)) for index in range(3)]
    assert max(independent) - min(independent) < 1e-10
    assert weights == pytest.approx([.4305675531, .2362984349, .3331340119], abs=1e-8)
    assert not np.allclose(weights, (1 / sigmas) / sum(1 / sigmas))


def test_diagonal_covariance_matches_analytic_inverse_sigma_solution():
    covariance = np.diag([.01, .04, .09])
    weights, _ = research._erc(covariance, np.eye(3))
    assert weights == pytest.approx([6 / 11, 3 / 11, 2 / 11], abs=1e-10)


@pytest.mark.parametrize("correlation", [-.8, 0, .8])
def test_two_asset_analytic_erc_cancels_cross_terms_for_any_valid_correlation(correlation):
    sigma = np.array([.1, .3])
    matrix = np.array([[1, correlation], [correlation, 1]])
    covariance = matrix * np.outer(sigma, sigma)
    weights, evidence = research._erc(covariance, matrix)
    assert evidence["converged"]
    # Equal contributions cancel the shared cross term: w1²σ1² = w2²σ2².
    assert weights == pytest.approx([.75, .25], abs=1e-7)
    assert weights[0] * sigma[0] == pytest.approx(weights[1] * sigma[1], abs=1e-8)


def test_solver_is_invariant_to_covariance_scale_and_symbol_permutation():
    covariance = np.array([[.01, .004, .001], [.004, .04, -.003], [.001, -.003, .0225]])
    sigma = np.sqrt(np.diag(covariance))
    weights, _ = research._erc(covariance, covariance / np.outer(sigma, sigma))
    for scale in (.0001, 10000):
        scaled = covariance * scale
        scaled_sigma = np.sqrt(np.diag(scaled))
        actual, _ = research._erc(scaled, scaled / np.outer(scaled_sigma, scaled_sigma))
        assert actual == pytest.approx(weights, abs=1e-8)
    permutation = np.array([2, 0, 1])
    permuted = covariance[np.ix_(permutation, permutation)]
    permuted_sigma = np.sqrt(np.diag(permuted))
    actual, _ = research._erc(permuted, permuted / np.outer(permuted_sigma, permuted_sigma))
    assert actual == pytest.approx(weights[permutation], abs=1e-7)


def test_caps_break_erc_and_signed_contributions_are_not_clipped():
    covariance = np.array([[.01, -.015], [-.015, .04]])
    sigma = np.sqrt(np.diag(covariance))
    erc, _ = research._erc(covariance, covariance / np.outer(sigma, sigma))
    result = research._scenario(["SYNTA", "SYNTB"], erc * 90, 40, 90, covariance)
    assert result["risk_before"]["risk_shares_pct"] == pytest.approx([50, 50], abs=1e-5)
    assert result["risk_after"]["risk_shares_pct"] != pytest.approx([50, 50])
    negative = research._scenario(["SYNTA", "SYNTB"], [10, 80], 100, 90, covariance)
    assert negative["risk_before"]["risk_shares_pct"][0] < 0
    assert negative["risk_after"]["contributions_annualized_pct"][0] < 0
    assert sum(negative["risk_after"]["risk_shares_pct"]) == pytest.approx(100)
    assert sum(negative["risk_after"]["contributions_annualized_pct"]) == pytest.approx(negative["risk_after"]["volatility_annualized_pct"])
    rank = research._scenario(["SYNTA", "SYNTB"], [60, 30], 25, 90,
                              np.array([[.001, -.004], [-.004, .04]]))
    assert rank["risk_before"]["risk_shares_pct"][0] < 0
    assert rank["risk_after"]["risk_shares_pct"][0] < 0
    assert rank["weights"] == [{"symbol": "SYNTA", "raw_weight_pct": 60, "capped_weight_pct": 25},
                                {"symbol": "SYNTB", "raw_weight_pct": 30, "capped_weight_pct": 25}]


def test_one_symbol_and_zero_budget_have_explicit_semantics(workspace):
    run = saved(workspace, symbols=["SYNTA"])
    value = compare(workspace, run)
    assert value["status"] == "calculated" and value["invested_budget_pct"] == 30
    for method in value["methods"].values():
        assert method["weights"] == [{"symbol": "SYNTA", "raw_weight_pct": 30, "capped_weight_pct": 30}]
        assert method["risk_before"]["risk_shares_pct"] == [100]
    run = rewrite_run(run, lambda result: result.update(target_weights=[{"symbol": "SYNTA", "weight_pct": 0}], cash_weight_pct=100))
    value = compare(workspace, run)
    assert value["status"] == "unavailable" and value["reasons"] == [{"code": "zero_invested_budget"}]
    assert all(method["weights"] == [] and method["cash_after_pct"] is None for method in value["methods"].values())


@pytest.mark.parametrize("fault,reason", [("missing", "history_incomplete"), ("invalid", "invalid_adjusted_close"),
    ("constant", "zero_variance"), ("identical", "singular_or_ill_conditioned_covariance")])
def test_missing_or_invalid_history_never_drops_dates_symbols_or_falls_back(workspace, fault, reason):
    with store.connect() as db:
        if fault == "missing":
            db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (DAYS[-10],))
        elif fault == "invalid":
            db.execute("UPDATE bars SET adj_close=? WHERE symbol='SYNTB' AND date=?", (float("inf"), DAYS[-10]))
        elif fault == "constant":
            db.execute("UPDATE bars SET adj_close=100 WHERE symbol='SYNTB'")
        else:
            db.execute("UPDATE bars SET adj_close=(SELECT b.adj_close FROM bars b WHERE b.symbol='SYNTA' AND b.date=bars.date) WHERE symbol='SYNTB'")
    seed_scan()
    run = saved(workspace)
    value = compare(workspace, run)
    assert value["status"] == "unavailable" and value["reasons"][0]["code"] == reason
    assert all(method["weights"] == [] and method["risk_before"] is None for method in value["methods"].values())
    assert value["selected_symbols"] == SYMBOLS[:3] and value["invested_budget_pct"] == 90
    if fault in ("missing", "invalid"):
        assert value["coverage"]["required_closes"] == 63 and value["coverage"]["valid_closes"] == 62
        assert value["coverage"]["common_return_sessions"] == 18
        assert value["covariance_annualized"] is None


def test_solver_nonconvergence_makes_both_methods_unavailable(workspace, monkeypatch):
    run = saved(workspace)
    monkeypatch.setattr(research, "MAX_SWEEPS", 1)
    result = compare(workspace, run)
    assert result["status"] == "unavailable" and result["solver"]["converged"] is False
    assert result["solver"]["sweeps"] == 1 and result["solver"]["reason"] == "solver_nonconvergence"
    assert result["solver"]["max_risk_share_error"] > research.RISK_TOLERANCE
    assert all(method["weights"] == [] for method in result["methods"].values())
    assert result["covariance_annualized"] is not None


@pytest.mark.parametrize("change", [{"lookback_sessions": 19}, {"lookback_sessions": 121}, {"lookback_sessions": 20.0},
    {"lookback_sessions": True}, {"lookback_sessions": "20"}, {"extra": True}, {"expected_as_of": "2024-02-30"},
    {"expected_proposal_fingerprint": "bad"}])
def test_request_bounds_are_strict(workspace, change):
    run = saved(workspace)
    response = workspace.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run, **change))
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("change", [{"expected_proposal_fingerprint": "a" * 64}, {"expected_input_revision": "old"},
                                   {"expected_as_of": "2024-01-03"}])
def test_saved_identity_mismatch_is_409_without_calculation(workspace, monkeypatch, change):
    run = saved(workspace)
    monkeypatch.setattr(research, "_history", lambda *args: pytest.fail("stale source must not calculate"))
    response = workspace.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run, **change))
    assert response.status_code == 409


def test_changed_market_input_and_session_race_are_rejected(workspace, monkeypatch):
    run = saved(workspace)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    response = workspace.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run))
    assert response.status_code == 409
    seed_scan()
    run = saved(workspace)
    original = research._erc

    def changed(*args):
        result = original(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
        return result

    monkeypatch.setattr(research, "_erc", changed)
    response = workspace.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run))
    assert response.status_code == 409


def test_covariance_matches_independent_sample_log_return_formula(workspace):
    run = saved(workspace)
    value = compare(workspace, run, lookback_sessions=120)
    with store.connect() as db:
        prices = [[row[0] for row in db.execute("SELECT adj_close FROM bars WHERE symbol=? ORDER BY date", (symbol,))] for symbol in SYMBOLS[:3]]
    returns = [[math.log(prices[col][i + 1]) - math.log(prices[col][i]) for i in range(120)] for col in range(3)]
    means = [math.fsum(series) / 120 for series in returns]
    expected = [[252 * math.fsum((returns[i][k] - means[i]) * (returns[j][k] - means[j]) for k in range(120)) / 119 for j in range(3)] for i in range(3)]
    assert np.array(value["covariance_annualized"]) == pytest.approx(np.array(expected), rel=1e-12)
    assert value["solver"]["max_risk_share_error"] <= research.RISK_TOLERANCE
    assert value["coverage"]["required_closes"] == 363
    assert allocator.METHODS == ("equal", "inverse_volatility", "score_tilt")


def test_exact_saved_identity_changed_after_client_capture_is_rejected(workspace, monkeypatch):
    run = saved(workspace)
    changed = rewrite_run(run, lambda result: result.update(cash_weight_pct=11))
    assert changed["proposal_fingerprint"] != run["proposal_fingerprint"]
    monkeypatch.setattr(research, "_history", lambda *args: pytest.fail("changed saved identity must not calculate"))
    response = workspace.post(f"/api/portfolio-agent/runs/{run['id']}/allocation-research", json=body(run))
    assert response.status_code == 409


def test_maximum_all_selected_set_and_history_remain_bounded(workspace):
    symbols = [f"SYN{i:02}" for i in range(30)]
    with store.connect() as db:
        db.execute("DELETE FROM market_universe")
        for index, symbol in enumerate(symbols):
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
            price = 100.0
            for offset, day in enumerate(DAYS):
                if offset:
                    price *= math.exp(.01 * math.sin(offset * (index + 1)))
                db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, price, price * 1.01, price * .99, price, price))
    seed_scan(rows=[scan_row(symbol) for symbol in symbols], universe=symbols)
    run = saved(workspace, symbols=symbols, max_positions=30)
    result = compare(workspace, run, lookback_sessions=120)
    assert result["status"] == "calculated"
    assert result["coverage"]["required_closes"] == result["coverage"]["valid_closes"] == 3630
    assert result["coverage"]["required_symbols"] == result["coverage"]["complete_symbols"] == 30
    assert sum(len(row) for row in result["covariance_annualized"]) == 900
    assert all(len(method["weights"]) == 30 for method in result["methods"].values())
    assert result["solver"]["sweeps"] <= 5000
