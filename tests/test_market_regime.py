import json
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import api, market_regime, sessions, store

EXPECTED = "2026-09-04"
DEFAULT_WEIGHTS = market_regime.Weights().model_dump()


def readings_2000():
    return {"buffett": {"value": 145.0}, "shiller": {"value": 44.2},
            "yield_curve": {"value": -0.4, "detail": {"yield_10y": 6.2, "yield_2y": 6.6}},
            "technical": {"value": 15.0}, "sentiment": {"value": 90}}


@pytest.mark.parametrize("value,risk", [(120, 25), (120.01, 50), (150, 50), (150.5, 75), (180, 75), (181, 90), (200, 90), (200.1, 100)])
def test_buffett_buckets_follow_upstream_edges(value, risk):
    assert market_regime.bucket_buffett(value) == risk


@pytest.mark.parametrize("value,risk", [(25, 20), (25.1, 50), (30, 50), (31, 70), (35, 70), (35.5, 90), (40, 90), (40.1, 100)])
def test_shiller_buckets_follow_upstream_edges(value, risk):
    assert market_regime.bucket_shiller(value) == risk


@pytest.mark.parametrize("spread,risk,status", [(-0.51, 80, "deep_inversion"), (-0.5, 60, "inversion"), (-0.01, 60, "inversion"),
                                                (0, 70, "reinversion"), (0.49, 70, "reinversion"), (0.5, 30, "normal"), (2, 30, "normal")])
def test_yield_curve_reinversion_is_the_highest_positive_spread_risk(spread, risk, status):
    assert market_regime.bucket_yield(spread) == (risk, status)


@pytest.mark.parametrize("deviation,risk", [(30, 100), (25, 85), (20, 65), (15, 40), (5, 20), (0, 20), (-10, 20), (-10.1, 10)])
def test_technical_buckets_follow_upstream_edges(deviation, risk):
    assert market_regime.bucket_technical(deviation) == risk


@pytest.mark.parametrize("value,risk", [(81, 100), (80, 70), (61, 70), (60, 40), (20, 40), (19, 0), (0, 0)])
def test_sentiment_buckets_follow_upstream_edges(value, risk):
    assert market_regime.bucket_sentiment(value) == risk


def test_reference_scenarios_reproduce_upstream_scores_with_default_weights():
    scored = {s["id"]: market_regime.scenario_result(s, DEFAULT_WEIGHTS, EXPECTED) for s in market_regime.SCENARIOS}
    assert scored["2000-03"]["score"] == pytest.approx(70.5)
    assert scored["2007-10"]["score"] == pytest.approx(52.25)
    assert scored["2022-01"]["score"] == pytest.approx(62.0)
    assert [scored[key]["zone"] for key in ("2000-03", "2007-10", "2022-01")] == ["elevated", "watch", "elevated"]
    assert scored["2007-10"]["factors"][2]["status"] == "reinversion"
    assert all(row["risk"] is not None for row in scored["2000-03"]["factors"])


@pytest.mark.parametrize("score,expected_zone", [(0, "calm"), (39.99, "calm"), (40, "watch"), (59.9, "watch"), (60, "elevated"), (79.9, "elevated"), (80, "extreme"), (None, None)])
def test_zone_boundaries(score, expected_zone):
    assert market_regime.zone(score) == expected_zone


def test_missing_enabled_factor_blocks_composite_without_reweighting():
    readings = readings_2000()
    readings["sentiment"] = None
    result = market_regime.evaluate(DEFAULT_WEIGHTS, readings, EXPECTED)
    assert result["score"] is None and result["zone"] is None and not result["complete"]
    assert result["missing"] == ["sentiment"]
    sentiment = result["factors"][4]
    assert sentiment["reason"] == "missing_input" and sentiment["risk"] is None
    assert [row["risk"] for row in result["factors"][:4]] == [50, 100, 60, 40]
    weights = {**DEFAULT_WEIGHTS, "sentiment": 0}
    result = market_regime.evaluate(weights, readings, EXPECTED)
    assert result["complete"] and result["missing"] == []
    assert result["score"] == pytest.approx((50 * 15 + 100 * 25 + 60 * 25 + 40 * 20) / 85)
    assert not result["factors"][4]["enabled"]


def test_weights_normalize_by_their_total_and_reject_zero_total():
    doubled = {factor: weight * 2 for factor, weight in DEFAULT_WEIGHTS.items()}
    assert market_regime.evaluate(doubled, readings_2000(), EXPECTED)["score"] == pytest.approx(70.5)
    with pytest.raises(ValueError):
        market_regime.evaluate(dict.fromkeys(market_regime.FACTORS, 0), readings_2000(), EXPECTED)


def test_stale_manual_readings_are_flagged_but_still_counted():
    readings = readings_2000()
    readings["buffett"]["as_of"] = date(2026, 3, 1)
    readings["shiller"]["as_of"] = date(2026, 8, 20)
    result = market_regime.evaluate(DEFAULT_WEIGHTS, readings, EXPECTED)
    assert result["score"] == pytest.approx(70.5)
    assert result["stale_inputs"] == ["buffett"]
    buffett, shiller = result["factors"][0], result["factors"][1]
    assert buffett["stale"] and buffett["age_days"] == 187 and buffett["as_of"] == "2026-03-01"
    assert not shiller["stale"] and shiller["age_days"] == 15


def test_yield_factor_requires_both_legs_and_keeps_the_older_date():
    inputs = market_regime.Inputs(yield_10y={"value": 4.1, "as_of": "2026-09-03"})
    assert market_regime.manual_readings(inputs)["yield_curve"] == {
        "available": False, "reason": "missing_input", "detail": {"missing": ["yield_2y"]}}
    inputs = market_regime.Inputs(yield_10y={"value": 4.1, "as_of": "2026-09-03"}, yield_2y={"value": 3.6, "as_of": "2026-08-01"})
    reading = market_regime.manual_readings(inputs)["yield_curve"]
    assert reading["value"] == pytest.approx(0.5) and reading["as_of"] == date(2026, 8, 1)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "regime.db"))
    store.init_db()
    days = sessions.expected_sessions("2025-06-01", EXPECTED)[-250:]
    assert days[-1] == EXPECTED
    monkeypatch.setattr(market_regime.sessions, "latest_completed_session", lambda: EXPECTED)
    return days


def insert_bars(days, closes):
    with store.connect() as db:
        for day, close in zip(days, closes):
            db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", ("VOO", day, close, close + 1, close - 1, close, close, 1000))


def test_benchmark_technical_factor_requires_current_valid_history(workspace):
    days = workspace
    assert market_regime.benchmark_reading("VOO", EXPECTED)["reason"] == "no_history"
    insert_bars(days, [100.0] * 249 + [110.0])
    reading = market_regime.benchmark_reading("VOO", EXPECTED)
    ma200 = (199 * 100 + 110) / 200
    assert reading["available"] and reading["value"] == pytest.approx((110 - ma200) / ma200 * 100, abs=1e-4)
    assert reading["detail"]["ma200"] == pytest.approx(ma200) and reading["bars"] == 250
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='VOO' AND date=?", (EXPECTED,))
    assert market_regime.benchmark_reading("VOO", EXPECTED)["reason"] == "stale_history"
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('VOO',?,110,100,120,110,110,1000)", (EXPECTED,))
    assert market_regime.benchmark_reading("VOO", EXPECTED)["reason"] == "data_error"


def test_short_benchmark_history_cannot_produce_a_deviation(workspace):
    insert_bars(workspace[-150:], [100.0] * 150)
    assert market_regime.benchmark_reading("VOO", EXPECTED)["reason"] == "insufficient_history"


def test_api_scores_only_when_every_enabled_factor_is_present(workspace):
    app = FastAPI()
    app.include_router(market_regime.router)
    client = TestClient(app)
    inputs = {"buffett_ratio": {"value": 145, "as_of": "2026-03-01"}, "shiller_pe": {"value": 44.2},
              "yield_10y": {"value": 6.2}, "yield_2y": {"value": 6.6}, "fear_greed": {"value": 90}}
    response = client.post("/api/market/regime", json={"inputs": inputs})
    assert response.status_code == 200
    body = response.json()
    assert body["score"] is None and body["missing"] == ["technical"]
    assert body["benchmark"] == {"symbol": "VOO", "name": None, "source": None, "bars": 0, "last_date": None,
                                 "available": False, "reason": "no_history", "deviation_pct": None}
    assert body["stale_inputs"] == ["buffett"]
    assert [s["score"] for s in body["scenarios"]] == pytest.approx([70.5, 52.25, 62.0])
    json.dumps(body, allow_nan=False)
    insert_bars(workspace, [100.0] * 249 + [110.0])
    before = store.input_revision()
    body = client.post("/api/market/regime", json={"inputs": inputs}).json()
    assert body["complete"] and body["score"] == pytest.approx(70.5) and body["zone"] == "elevated"
    assert body["benchmark"]["available"] and body["benchmark"]["ma200"] == pytest.approx((199 * 100 + 110) / 200)
    assert body["engine_version"] == "alphaview-regime-v1" and body["as_of"] == EXPECTED
    assert store.input_revision() == before


def test_api_rejects_out_of_range_inputs_and_unknown_fields(workspace):
    app = FastAPI()
    app.include_router(market_regime.router)
    client = TestClient(app)
    assert client.post("/api/market/regime", json={}).status_code == 200
    assert client.post("/api/market/regime", json={"weights": dict.fromkeys(market_regime.FACTORS, 0)}).status_code == 422
    assert client.post("/api/market/regime", json={"inputs": {"fear_greed": {"value": 101}}}).status_code == 422
    assert client.post("/api/market/regime", json={"inputs": {"shiller_pe": {"value": 30, "as_of": "2999-01-01"}}}).status_code == 422
    assert client.post("/api/market/regime", json={"benchmark": "TQQQ"}).status_code == 422
    assert client.post("/api/market/regime", json={"inputs": {"gdp": {"value": 1}}}).status_code == 422
    assert client.post("/api/market/regime", json={"inputs": {"fear_greed": {"value": "NaN"}}}).status_code == 422


def test_main_app_exposes_the_regime_route():
    assert "post" in api.app.openapi()["paths"]["/api/market/regime"]
