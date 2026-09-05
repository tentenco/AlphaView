import json

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import risk, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "risk.db"))
    store.init_db()
    dates = sessions.expected_sessions("2024-01-02", "2024-12-31")[-121:]
    monkeypatch.setattr(risk.sessions, "latest_completed_session", lambda: dates[-1])
    return dates


def add(dates, symbol, changes=None, shares=1, drop=(), invalid=()):
    changes = changes if changes is not None else np.sin(np.arange(len(dates)) / 3) * .01
    prices = 100 * np.cumprod(1 + changes)
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,?,'test',?)", (symbol, symbol, shares, store.now()))
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [(symbol, day, price, price * 1.01, price * .99, price, 0 if index in invalid else price, 1000) for index, (day, price) in enumerate(zip(dates, prices)) if index not in drop])
    return prices


def pair(result, left, right):
    return next(row for row in result["pairs"] if row["left"] == left and row["right"] == right)


def test_identical_opposite_and_constant_returns_and_weights(workspace):
    changes = np.sin(np.arange(121) / 3) * .01
    add(workspace, "A", changes, shares=2)
    add(workspace, "B", changes)
    add(workspace, "C", -changes)
    add(workspace, "D", np.zeros(121))
    result = risk.report()
    assert pair(result, "A", "B")["correlation"] == pytest.approx(1)
    assert pair(result, "A", "C")["correlation"] == pytest.approx(-1)
    assert pair(result, "A", "D")["correlation"] is None
    assert pair(result, "A", "D")["reason"]
    assert result["valuation_complete"] and result["priced_count"] == 4
    assert sum(row["weight_pct"] for row in result["holdings"]) == pytest.approx(100)
    assert result["largest_weight_pct"] == max(row["weight_pct"] for row in result["holdings"])
    assert result["top3_weight_pct"] < 100
    assert pair(result, "A", "B")["observations"] == 60
    assert pair(risk.report(120), "A", "B")["observations"] == 120
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("kind", ["missing", "invalid"])
def test_gap_removes_both_adjacent_returns_without_multiday_bridge(workspace, kind):
    add(workspace, "A")
    add(workspace, "B", drop=(90,) if kind == "missing" else (), invalid=(90,) if kind == "invalid" else ())
    result = risk.report()
    assert pair(result, "A", "B")["observations"] == 58
    assert pair(result, "A", "B")["correlation"] == pytest.approx(1)


def test_recent_ipo_insufficient_common_dates(workspace):
    add(workspace, "A")
    add(workspace[-30:], "B")
    result = risk.report()
    assert pair(result, "A", "B")["observations"] == 29
    assert pair(result, "A", "B")["correlation"] is None
    assert "40" in pair(result, "A", "B")["reason"]


@pytest.mark.parametrize("invalid", [False, True])
def test_stale_or_invalid_latest_excludes_series_and_full_weights(workspace, invalid):
    add(workspace, "A")
    add(workspace, "B", invalid=(120,) if invalid else (), drop=() if invalid else (120,))
    result = risk.report()
    assert not result["valuation_complete"] and result["priced_count"] == 1
    assert result["market_value"] == result["holdings"][0]["market_value"]
    assert result["top3_weight_pct"] is None
    assert all(row["weight_pct"] is None for row in result["holdings"])
    assert pair(result, "A", "B")["observations"] == 0
    assert pair(result, "A", "B")["correlation"] is None


def test_no_holdings_and_watchlist_are_not_risk_positions(workspace):
    add(workspace, "WATCH", shares=0)
    result = risk.report()
    assert result["holding_count"] == 0 and result["holdings"] == result["pairs"] == []
    assert result["market_value"] is None and result["largest_weight_pct"] is None


def test_overflow_valuation_is_unavailable_strict_json(workspace):
    add(workspace, "A", shares=1e308)
    result = risk.report()
    assert not result["valuation_complete"] and result["market_value"] is None
    json.dumps(result, allow_nan=False)


def test_endpoint_validation_and_no_writes(workspace):
    add(workspace, "A")
    before = store.db_path().read_bytes()
    app = FastAPI()
    app.include_router(risk.router)
    with TestClient(app) as client:
        assert client.get("/api/portfolio/risk?window=61").status_code == 422
        assert client.get("/api/portfolio/risk?window=120").status_code == 200
    assert store.db_path().read_bytes() == before


def test_bounded_holdings_and_timeout(workspace, monkeypatch):
    with store.connect() as db:
        db.executemany("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,1,'test','test')", [(f"S{i}", f"S{i}") for i in range(101)])
    with pytest.raises(risk.HTTPException) as caught:
        risk.report()
    assert caught.value.status_code == 422
    monkeypatch.setattr(risk, "MAX_SECONDS", -1)
    with pytest.raises(risk.HTTPException) as caught:
        risk.report()
    assert caught.value.status_code == 503


def test_aggregate_overflow_hides_concentration_without_nonfinite_json(workspace):
    add(workspace, "A", np.zeros(121), shares=1e306)
    add(workspace, "B", np.zeros(121), shares=1e306)
    result = risk.report()
    assert result["priced_count"] == 2
    assert result["market_value"] is None and not result["valuation_complete"]
    assert result["largest_weight_pct"] is None
    json.dumps(result, allow_nan=False)


def test_future_prices_do_not_replace_latest_completed_session(workspace):
    add(workspace, "A")
    before = risk.report()
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('A','2025-01-02',200,201,199,200,200,1000)")
    assert risk.report() == before


def test_extreme_finite_daily_returns_are_scaled_before_correlation(workspace):
    add(workspace, "A")
    add(workspace, "B")
    with store.connect() as db:
        for symbol in ("A", "B"):
            db.executemany("UPDATE bars SET adj_close=? WHERE symbol=? AND date=?", [(1e150 if index % 2 else 1e-150, symbol, day) for index, day in enumerate(workspace)])
    result = risk.report()
    assert pair(result, "A", "B")["correlation"] == pytest.approx(1)
    json.dumps(result, allow_nan=False)
