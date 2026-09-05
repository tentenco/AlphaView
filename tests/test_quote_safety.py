import json

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from alphaview.panel import store, sessions
from alphaview.panel.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "quote-safety.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-04")
    with TestClient(app) as value:
        yield value


def holding(symbol="TEST", closes=(100., 100., 110.), dates=("2024-01-02", "2024-01-03", "2024-01-04"), shares=10):
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES (?,?,?,50,'test',?)",
                   (symbol, symbol, shares, store.now()))
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)",
                       [(symbol, day, 100., 120., 90., close, close, 1_000_000.) for day, close in zip(dates, closes)])


@pytest.mark.parametrize("bad", [0., -1., "NaN", "broken", float("inf")])
def test_invalid_latest_quote_is_unavailable_without_fallback_or_json_failure(client, bad):
    holding(closes=(100., 100., bad))
    response = client.get("/api/overview")
    assert response.status_code == 200
    overview = response.json()
    pos = overview["positions"][0]
    assert pos["price"] is None and pos["price_date"] == "2024-01-04"
    assert pos["market_value"] is None and pos["pnl"] is None
    assert pos["weight"] is None
    assert pos["change"] is None and pos["change_pct"] is None
    assert pos["quote_status"] == "unavailable"
    assert pos["sparkline"][-1]["close"] is None
    assert overview["summary"]["market_value"] is None
    assert overview["summary"]["pnl"] is None
    assert overview["summary"]["day_change"] is None
    assert overview["summary"]["partial"]
    assert overview["summary"]["priced_count"] == 0
    detail = client.get("/api/stocks/TEST")
    assert detail.status_code == 200 and detail.json()["position"]["price"] is None
    historical = client.get("/api/stocks/TEST?as_of=2024-01-03").json()["position"]
    assert historical["price"] == 100 and historical["market_value"] == 1000
    assert historical["quote_status"] == "ok"
    json.dumps(overview, allow_nan=False)
    json.dumps(detail.json(), allow_nan=False)


def test_invalid_previous_quote_keeps_valuation_but_not_a_fabricated_daily_change(client):
    holding(closes=(100., 0., 110.))
    overview = client.get("/api/overview").json()
    pos = overview["positions"][0]
    assert pos["price"] == 110 and pos["market_value"] == 1100
    assert pos["change"] is None and pos["change_pct"] is None
    assert pos["quote_status"] == "partial"
    assert overview["summary"]["market_value"] == 1100
    assert not overview["summary"]["partial"]
    assert overview["summary"]["day_change"] is None
    assert overview["summary"]["day_change_pct"] is None
    assert overview["summary"]["day_change_partial"]
    assert overview["summary"]["day_change_covered_count"] == 0


def test_partially_valued_portfolio_exposes_subtotal_and_coverage(client):
    holding("GOOD")
    holding("BAD", closes=(100., 100., "NaN"))
    result = client.get("/api/overview").json()["summary"]
    assert result["market_value"] == 1100
    assert result["pnl"] == 600
    assert result["holding_count"] == 2 and result["priced_count"] == 1
    assert result["partial"] and result["day_change_partial"]
    assert result["day_change"] is None


def test_no_holdings_is_zero_rather_than_unknown(client):
    result = client.get("/api/overview").json()["summary"]
    assert result["holding_count"] == 0
    assert result["market_value"] == result["pnl"] == result["day_change"] == 0
    assert not result["partial"] and not result["day_change_partial"]


def test_missing_sessions_are_not_reported_as_a_single_daily_change(client, monkeypatch):
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    holding(closes=(100., 110.), dates=("2024-01-02", "2024-01-05"))
    result = client.get("/api/overview").json()
    assert result["positions"][0]["market_value"] == 1100
    assert result["positions"][0]["change"] is None
    assert "不是相鄰交易日" in result["positions"][0]["quote_reason"]
    assert result["summary"]["day_change"] is None


def test_mixed_price_dates_never_become_one_aggregate_daily_change(client, monkeypatch):
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    holding("ONE")
    holding("TWO", dates=("2024-01-03", "2024-01-04", "2024-01-05"))
    result = client.get("/api/overview").json()["summary"]
    assert result["market_value"] == 2200
    assert result["mixed_dates"] and result["day_change_partial"]
    assert result["day_change"] is None


def test_arithmetic_overflow_does_not_break_json_or_create_invalid_weights(client):
    holding("ONE", closes=(1e308, 1e308, 1e308), shares=1)
    holding("TWO", closes=(1e308, 1e308, 1e308), shares=1)
    response = client.get("/api/overview")
    assert response.status_code == 200
    result = response.json()
    assert result["summary"]["market_value"] is None and result["summary"]["partial"]
    assert [p["weight"] for p in result["positions"]] == [50, 50]
    json.dumps(result, allow_nan=False)
    assert client.get("/api/stocks/ONE").status_code == 200


def test_per_position_valuation_overflow_is_excluded_from_coverage(client):
    holding(closes=(1e308, 1e308, 1e308), shares=10)
    response = client.get("/api/overview")
    assert response.status_code == 200
    result = response.json()
    assert result["positions"][0]["price"] == 1e308
    assert result["positions"][0]["market_value"] is None
    assert result["summary"]["priced_count"] == 0
    assert result["summary"]["market_value"] is None
