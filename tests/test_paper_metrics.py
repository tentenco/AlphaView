"""Deeper paper performance metrics on hand-computed synthetic NAV points (alphaview-paper-metrics-v1)."""
import json
import math
from statistics import stdev

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_analytics as analytics, paper_metrics as metrics, paper_portfolio as paper, sessions, store

DATES = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
EQUITIES = [10000.0, 10100.0, 9999.0, 10200.0]
RETURNS = [0.01, -0.01, 10200 / 9999 - 1]


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "metrics.db"))
    store.init_db()
    with store.connect() as connection:
        yield connection


def _bars(db, symbol, closes):
    for day, close in zip(DATES, closes):
        db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, close, close, close, close, close))


def _points():
    return [{"as_of": day, "equity": equity} for day, equity in zip(DATES, EQUITIES)]


SUMMARY = {"performance_available": True, "period_return_pct": 2.0, "max_drawdown_pct": 1.0, "reason": None}
COSTS = {"cost_total": 12.5}
CURRENT = {"initial_cash": 10000, "equity": 10200, "valuation_complete": True}


def test_risk_drawdown_and_cost_metrics_match_hand_computation(db):
    _bars(db, "SPY", [100, 101, 100, 102])
    result = metrics.compute(db, _points(), SUMMARY, COSTS, CURRENT)
    json.dumps(result, allow_nan=False)
    assert result["method_version"] == "alphaview-paper-metrics-v1"
    assert result["available"] and result["returns_n"] == 3 and result["low_sample"]
    risk = result["risk"]
    assert risk["annualized_return_pct"] == pytest.approx((1.02 ** 84 - 1) * 100)
    mean = sum(RETURNS) / 3
    assert risk["sharpe"] == pytest.approx(mean / stdev(RETURNS) * math.sqrt(252))
    downside = math.sqrt((0 + 0.01 ** 2 + 0) / 3)
    assert risk["sortino"] == pytest.approx(mean / downside * math.sqrt(252))
    assert risk["calmar"] == pytest.approx(risk["annualized_return_pct"] / 1.0)
    assert risk["best_day_pct"] == pytest.approx(RETURNS[2] * 100) and risk["worst_day_pct"] == pytest.approx(-1.0)
    assert (risk["positive_days"], risk["negative_days"], risk["reasons"]) == (2, 1, {})
    drawdown = result["drawdown"]
    assert drawdown["longest_underwater_sessions"] == 1
    assert (drawdown["longest_underwater_from"], drawdown["longest_underwater_to"]) == ("2024-01-03", "2024-01-04")
    assert not drawdown["underwater_ongoing"] and drawdown["current_drawdown_pct"] == 0
    costs = result["costs"]
    assert costs["cost_drag_pct_of_initial"] == pytest.approx(0.125)
    assert costs["net_return_since_funding_pct"] == pytest.approx(2.0)
    assert costs["gross_return_since_funding_pct"] == pytest.approx(2.125)
    benchmark = result["benchmark"]
    assert benchmark["available"] and benchmark["price_basis"] == "unadjusted_close"
    assert benchmark["period_return_pct"] == pytest.approx(2.0) and benchmark["excess_return_pct"] == pytest.approx(0)
    bench = [0.01, 100 / 101 - 1, 0.02]
    mean_bench = sum(bench) / 3
    covariance = sum((a - mean) * (b - mean_bench) for a, b in zip(RETURNS, bench)) / 2
    variance = sum((b - mean_bench) ** 2 for b in bench) / 2
    assert benchmark["beta"] == pytest.approx(covariance / variance)
    assert benchmark["coverage"] == {"required": 4, "priced": 4, "missing": []}
    assert math.isfinite(benchmark["information_ratio"]) and math.isfinite(benchmark["tracking_error_pct"])


def test_missing_benchmark_price_makes_benchmark_block_unavailable_without_filling(db):
    _bars(db, "SPY", [100, 101, 100, 102])
    db.execute("DELETE FROM bars WHERE symbol='SPY' AND date='2024-01-04'")
    result = metrics.compute(db, _points(), SUMMARY, COSTS, CURRENT)
    assert result["available"] and result["risk"]["sharpe"] is not None
    assert result["benchmark"] == {"symbol": "SPY", "available": False, "reason": "benchmark_unavailable",
                                   "coverage": {"required": 4, "priced": 3, "missing": ["2024-01-04"]}}
    json.dumps(result, allow_nan=False)


def test_flat_or_rising_only_series_reports_reasons_instead_of_numbers(db):
    _bars(db, "SPY", [100, 100, 100, 100])
    points = [{"as_of": day, "equity": 10000.0 + 10 * index} for index, day in enumerate(DATES)]
    summary = {**SUMMARY, "period_return_pct": 0.3, "max_drawdown_pct": 0.0}
    result = metrics.compute(db, points, summary, COSTS, {**CURRENT, "equity": None, "valuation_complete": False})
    assert result["risk"]["sortino"] is None and result["risk"]["reasons"]["sortino"] == "no_downside_observations"
    assert result["risk"]["calmar"] is None and result["risk"]["reasons"]["calmar"] == "no_drawdown"
    assert result["risk"]["sharpe"] == pytest.approx(0, abs=1e-9) or result["risk"]["sharpe"] > 0
    assert result["benchmark"]["beta"] is None and result["benchmark"]["reasons"]["beta"] == "benchmark_zero_variance"
    assert result["costs"]["reason"] == "valuation_incomplete" and result["costs"]["gross_return_since_funding_pct"] is None
    json.dumps(result, allow_nan=False)


def test_incomplete_series_passes_reason_through_and_keeps_costs(db):
    result = metrics.compute(db, [], {"performance_available": False, "reason": "尚未擷取虛擬帳戶淨值",
                                      "period_return_pct": None, "max_drawdown_pct": None}, COSTS, CURRENT)
    assert result == {**result, "available": False, "reason": "尚未擷取虛擬帳戶淨值", "risk": None, "drawdown": None,
                      "benchmark": None, "returns_n": 0, "low_sample": True}
    assert result["costs"]["cost_drag_pct_of_initial"] == pytest.approx(0.125)


def test_nav_report_embeds_metrics_and_validates_benchmark_symbol(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "metrics-api.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    store.init_db()
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(analytics.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic metrics", "initial_cash": 10000,
                                                          "idempotency_key": "metrics-account"}).json()["account"]
        revision = store.input_revision()
        result = client.get(f"/api/paper/accounts/{account['id']}/nav").json()
        assert result["metrics"]["method_version"] == "alphaview-paper-metrics-v1"
        assert not result["metrics"]["available"] and result["metrics"]["reason"]
        assert result["metrics"]["costs"]["cost_total"] == 0
        assert client.get(f"/api/paper/accounts/{account['id']}/nav", params={"benchmark": "bad symbol"}).status_code == 422
        assert client.get(f"/api/paper/accounts/{account['id']}/nav", params={"benchmark": "QQQ"}).status_code == 200
        assert store.input_revision() == revision
        json.dumps(result, allow_nan=False)
