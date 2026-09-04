import json
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from alphaview.panel import jobs, market, quality, store
from alphaview.panel.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "context.db"))
    with TestClient(app) as value:
        yield value


def members(symbols, scope="market"):
    with store.connect() as db:
        if scope == "market":
            db.execute("DELETE FROM market_universe")
            db.executemany("INSERT INTO market_universe VALUES (?,?, 'test',?,1)",
                           [(symbol, symbol, store.now()) for symbol in symbols])
        else:
            db.execute("DELETE FROM positions")
            db.executemany("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,0,'test',?)",
                           [(symbol, symbol, store.now()) for symbol in symbols])


def snapshot(symbols, day="2026-09-04", scope="market"):
    result = [{"symbol": symbol, "date": day, "indicators": {"rps": 75.}, "signals": []} for symbol in symbols]
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES (?,?,?,?,?)",
                   (store.now(), day, json.dumps(symbols), json.dumps(result), scope))


def test_equal_counts_with_different_symbols_still_mismatch_and_never_mutate_snapshots(client):
    members(["A", "B"])
    snapshot(["A", "C"])
    original = store.latest_scan(scope="market")
    response = client.get("/api/scans?scope=market").json()
    assert response["matches_current_universe"] is False
    assert response["scan_member_count"] == response["current_member_count"] == 2
    assert response["universe"] == original["universe"]
    assert response["result"] == original["result"]
    assert store.latest_scan(scope="market") == original
    assert "matches_current_universe" not in original


def test_overview_and_historical_endpoint_context_are_scope_specific(client):
    members(["A", "B"])
    members(["P"], scope="portfolio")
    snapshot(["A"], day="2026-09-03")
    snapshot(["B", "A"])
    snapshot(["P"], scope="portfolio")
    overview = client.get("/api/overview").json()
    assert overview["market_scan"]["matches_current_universe"] is True
    assert overview["scan"]["matches_current_universe"] is True
    old = client.get("/api/scans?scope=market&as_of=2026-09-03").json()
    assert old["matches_current_universe"] is False
    assert (old["scan_member_count"], old["current_member_count"]) == (1, 2)
    members(["P", "Q"], scope="portfolio")
    assert client.get("/api/scans?scope=portfolio").json()["matches_current_universe"] is False
    assert client.get("/api/scans?scope=market").json()["matches_current_universe"] is True


def test_cancel_after_pool_publication_exposes_retained_scan_context_until_rescan(client):
    members(["OLD"])
    snapshot(["OLD"])
    original = store.latest_scan(scope="market")
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope,cancel_requested) VALUES ('expand','refresh','running',?,'market',0)", (store.now(),))
    discover = market.discover_universe

    def provider(query, *, size, offset, **kwargs):
        return {"total": 500, "start": offset, "quotes": [
            {"symbol": f"S{i}", "shortName": f"Stock {i}", "quoteType": "EQUITY", "currency": "USD", "exchange": "NMS"}
            for i in range(offset, offset + size)]}

    def cancel_after_discovery(*args, **kwargs):
        result = discover(*args, **kwargs)
        jobs.cancel_job("expand")
        return result

    assert jobs.RUN_LOCK.acquire(False)
    with patch("yfinance.screen", side_effect=provider), patch.object(market, "discover_universe", side_effect=cancel_after_discovery), patch.object(market, "fetch_symbol") as fetch:
        jobs.worker("expand", "refresh", "market", universe_limit=500)
    fetch.assert_not_called()
    response = client.get("/api/overview").json()
    assert response["jobs"][0]["status"] == "cancelled"
    assert response["market_universe_meta"]["accepted_count"] == 500
    assert response["market_scan"]["matches_current_universe"] is False
    assert response["market_scan"]["scan_member_count"] == 1
    assert response["market_scan"]["current_member_count"] == 500
    assert store.latest_scan(scope="market") == original
    snapshot([f"S{i}" for i in range(500)])
    assert client.get("/api/scans?scope=market").json()["matches_current_universe"] is True


def test_missing_history_keeps_missing_status_and_exposes_provider_error(client):
    members(["FAILED", "NEW"])
    with store.connect() as db:
        db.execute("INSERT INTO datasets(symbol,status,error) VALUES ('FAILED','error','Provider rejected malformed OHLC on 2026-09-04')")
    result = quality.report()
    items = {row["symbol"]: row for row in result["items"]}
    assert items["FAILED"]["status"] == "missing"
    assert "Provider rejected malformed OHLC on 2026-09-04" in items["FAILED"]["reason"]
    assert items["NEW"]["status"] == "missing"
    assert "最近更新失敗" not in items["NEW"]["reason"]
    assert result["counts"]["missing"] == 2
