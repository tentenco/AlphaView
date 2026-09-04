import json
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from alphaview.panel import market, research, store
from alphaview.panel.api import app


@pytest.fixture
def panel(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "panel.db"))
    with TestClient(app) as client:
        yield client


def sample_frame(n=260):
    from alphaview.panel.sessions import expected_sessions
    close = np.linspace(100, 180, n)
    return pd.DataFrame({"symbol": "TEST", "date": expected_sessions("2024-01-02", "2025-12-31")[:n],
                         "open": close - .5, "high": close + .3, "low": close - 1,
                         "close": close, "adj_close": close, "volume": np.full(n, 1000000.)})


def test_starter_watchlist_is_private_and_idempotent(panel):
    store.seed_portfolio()
    response = panel.put("/api/positions/NVDA", json={"symbol": "NVDA", "name": "NVIDIA", "shares": 2000, "cost": 190})
    assert response.status_code == 200
    store.seed_portfolio()
    items = {p["symbol"]: p for p in panel.get("/api/overview").json()["positions"]}
    assert len(items) == 7
    assert items["NVDA"]["shares"] == 2000
    assert items["TSLA"]["shares"] == 0
    assert items["TSLA"]["cost"] is None
    assert items["GOOGL"]["snapshot_price"] is None
    assert items["GOOGL"]["price"] is None
    assert items["GOOGL"]["source"] == "初始觀察清單"


def test_position_validation_and_cross_origin_writes(panel):
    assert panel.put("/api/positions/TEST", json={"symbol": "TEST", "name": "Test", "shares": -1}).status_code == 422
    assert panel.put("/api/positions/TEST", json={"symbol": "TEST", "name": "Test", "shares": 1}).status_code == 422
    assert panel.put("/api/positions/TEST", json={"symbol": "TEST", "name": "Test", "shares": 0},
                     headers={"Origin": "https://unrelated.example"}).status_code == 403
    assert panel.get("/api/unknown").status_code == 404
    assert panel.get("/api/overview", headers={"Host": "unrelated.example"}).status_code == 400


def test_no_future_bars_in_historical_screening():
    original = sample_frame()
    target = original.iloc[220].date
    changed = original.copy()
    changed.loc[221:, ["close", "adj_close", "high"]] *= 10
    a = research.evaluate({"TEST": research.indicators(original)}, target)
    b = research.evaluate({"TEST": research.indicators(changed)}, target)
    assert a == b
    assert a[0]["bars"] == 221


def test_breakout_excludes_current_high_and_rsi_handles_flat_and_up():
    frame = sample_frame()
    frame.loc[259, ["close", "adj_close", "high", "volume"]] = [200, 200, 210, 2000000]
    metrics = research.indicators(frame)
    assert bool(metrics.iloc[-1].turtle)
    assert metrics.iloc[-1].high20 == pytest.approx(frame.iloc[239:259].high.max())
    assert metrics.iloc[-1].rsi == 100
    frame[["close", "adj_close"]] = 100
    assert research.indicators(frame).iloc[-1].rsi == 50


def test_rps_requires_comparable_universe_and_excludes_stale():
    f = research.indicators(sample_frame())
    result = research.evaluate({"ONE": f, "TWO": f, "STALE": f.iloc[:-1]}, f.iloc[-1].date)
    assert result[0]["signals"][-1]["status"] == "insufficient"
    assert all(s["status"] == "stale" for s in result[-1]["signals"])
    short = research.evaluate({"IPO": f.iloc[:59]}, f.iloc[58].date)
    assert short[0]["signals"][1]["status"] == "insufficient"


def test_backtest_executes_next_open_with_cost_and_leaves_open_marked():
    f = research.indicators(sample_frame(240))
    f["turtle"] = False
    f.loc[22, "turtle"] = True
    f["low10"] = 0
    with patch.object(store, "history", return_value=f), patch.object(research, "indicators", return_value=f):
        result = research.backtest("TEST", "turtle")
    assert result["open_position"]["date"] == f.iloc[23].date
    expected_units = 10000 * .999 / f.iloc[23].open
    assert result["final"] == pytest.approx(round(expected_units * f.iloc[-1].close, 2))
    assert result["curve"][1]["value"] == 10000
    assert result["trades"] == []


def test_backtest_flat_returns_no_trades_and_zero_drawdown():
    f = research.indicators(sample_frame(240))
    f["turtle"] = False
    with patch.object(store, "history", return_value=f), patch.object(research, "indicators", return_value=f):
        result = research.backtest("TEST", "turtle")
    assert result["return_pct"] == 0
    assert result["max_drawdown_pct"] == 0
    assert result["trades"] == []


def test_failed_refresh_keeps_previous_bars(panel):
    store.seed_portfolio()
    f = sample_frame(30)
    f["symbol"] = "GOOGL"
    with store.connect() as db:
        f.to_sql("bars", db, if_exists="append", index=False)
    with patch.object(market, "fetch_symbol", side_effect=RuntimeError("provider offline")):
        results = market.refresh()
    assert all(r["status"] == "error" for r in results)
    assert len(store.history("GOOGL")) == 30
    assert store.dataset_rows()[0]["error"] == "provider offline"


def test_scan_dates_persist_and_portfolio_totals_use_quotes(panel):
    store.seed_portfolio()
    panel.put("/api/positions/GOOGL", json={"symbol": "GOOGL", "name": "Alphabet", "shares": 10, "cost": 120})
    panel.put("/api/positions/NVDA", json={"symbol": "NVDA", "name": "NVIDIA", "shares": 5, "cost": 100})
    f = sample_frame(260)
    f["symbol"] = "GOOGL"
    with store.connect() as db:
        f.to_sql("bars", db, if_exists="append", index=False)
    result = research.scan()
    assert result["dates"] == 60
    body = panel.get("/api/overview").json()
    assert body["summary"]["partial"]
    assert body["summary"]["market_value"] == pytest.approx(1800)
    assert body["summary"]["pnl"] == pytest.approx((180 - 120) * 10)
    scan = panel.get("/api/scans", params={"as_of": result["as_of"]}).json()
    assert scan["universe"] == [p["symbol"] for p in store.positions()]
    assert panel.get("/api/scans?as_of=1900-01-01").status_code == 404
    assert panel.get("/api/scans?as_of=not-a-date").status_code == 422


def test_export_escapes_spreadsheet_formulas(panel):
    panel.put("/api/positions/TEST", json={"symbol": "TEST", "name": "=1+1", "shares": 0})
    response = panel.get("/api/export")
    assert response.status_code == 200
    assert "'=1+1" in response.text
    assert "attachment" in response.headers["content-disposition"]


def test_saved_backtest_endpoint(panel):
    f = sample_frame(240)
    with patch.object(store, "history", return_value=f):
        response = panel.post("/api/backtest", json={"symbol": "TEST", "strategy": "turtle"})
    assert response.status_code == 200
    saved = panel.get("/api/backtest/TEST/turtle").json()
    assert saved["created_at"]
    assert saved["final"] == response.json()["final"]
    assert panel.get("/api/backtest/UNKNOWN/turtle").json() is None


def seed_market_members():
    with store.connect() as db:
        db.executemany("INSERT INTO market_universe VALUES (?,?,?,?,?)", [
            ("AAPL", "Apple", "test universe", store.now(), 1e12),
            ("MSFT", "Microsoft", "test universe", store.now(), 1e12),
            ("NVDA", "NVIDIA", "test universe", store.now(), 1e12),
        ])


def test_market_scope_does_not_change_holdings_or_mix_scans(panel):
    store.seed_portfolio()
    seed_market_members()
    before = store.positions()
    for symbol in ['AAPL', 'MSFT', 'NVDA']:
        f = sample_frame(240)
        f['symbol'] = symbol
        with store.connect() as db:
            f.to_sql('bars', db, if_exists='append', index=False)
    market_result = research.scan(scope='market')
    portfolio_result = research.scan(scope='portfolio')
    assert market_result['symbols'] == 3
    assert portfolio_result['symbols'] == 7
    assert store.positions() == before
    m = panel.get('/api/scans?scope=market').json()
    p = panel.get('/api/scans?scope=portfolio').json()
    assert m['scope'] == 'market' and m['universe'] == ['AAPL', 'MSFT', 'NVDA']
    assert 'AMZN' in p['universe']
    assert panel.get('/api/scans?scope=invalid').status_code == 422
    detail = panel.get('/api/stocks/AAPL?scope=market').json()
    assert detail['position']['name'] == 'Apple'
    assert detail['position']['shares'] == 0
    assert detail['position']['research']['symbol'] == 'AAPL'
    old_date = m['as_of']
    assert panel.get(f'/api/stocks/AAPL?scope=market&as_of={old_date}').status_code == 200
    repeated = research.scan(scope='market')
    assert repeated['unchanged']


def test_add_market_candidate_never_overwrites_existing_holding(panel):
    store.seed_portfolio()
    seed_market_members()
    before = next(p for p in store.positions() if p['symbol'] == 'NVDA')
    assert panel.post('/api/watchlist/NVDA').json()['added'] is False
    assert next(p for p in store.positions() if p['symbol'] == 'NVDA') == before
    with store.connect() as db:
        db.execute("DELETE FROM positions WHERE symbol='AAPL'")
    added = panel.post('/api/watchlist/AAPL')
    assert added.status_code == 200 and added.json()['added']
    p = next(p for p in store.positions() if p['symbol'] == 'AAPL')
    assert p['shares'] == 0 and p['cost'] is None
    assert panel.post('/api/watchlist/AAPL').json()['added'] is False
    assert panel.post('/api/watchlist/UNKNOWN').status_code == 404


def test_market_discovery_validates_source_and_preserves_previous_on_failure(panel):
    import yfinance as yf
    seed_market_members()
    before = store.universe('market')
    with patch.object(yf, 'screen', return_value={'quotes': []}):
        with pytest.raises(ValueError):
            market.discover_universe()
    assert store.universe('market') == before
    quotes = [{'symbol': f'T{i}', 'quoteType': 'EQUITY', 'currency': 'USD', 'exchange': 'NMS',
               'shortName': f'Test {i}'} for i in range(25)]
    quotes += [{'symbol': 'BAD', 'quoteType': 'ETF', 'currency': 'USD', 'exchange': 'NMS'}]
    with patch.object(yf, 'screen', return_value={'quotes': quotes}):
        assert market.discover_universe() == 25
    assert not any(p['symbol'] == 'BAD' for p in store.universe('market'))


def test_historical_stock_valuation_uses_selected_quote_and_current_quantity(panel):
    panel.put("/api/positions/TEST", json={"symbol": "TEST", "name": "Test", "shares": 10, "cost": 50})
    frame = sample_frame(30)
    with store.connect() as db:
        frame.to_sql("bars", db, if_exists="append", index=False)
    when = frame.iloc[10].date
    pos = panel.get(f"/api/stocks/TEST?as_of={when}").json()["position"]
    assert pos["market_value"] == pytest.approx(pos["price"] * 10)
    assert pos["pnl"] == pytest.approx((pos["price"] - 50) * 10)
    assert pos["change"] == pytest.approx(frame.iloc[10].close - frame.iloc[9].close)
    assert pos["sparkline"][-1]["date"] == when
    assert pos["weight"] is None
    assert "並非歷史持倉" in pos["valuation_basis"]


def test_notes_persist_and_reject_lost_updates(panel):
    store.seed_portfolio()
    assert panel.get('/api/notes/NOPE').status_code == 404
    initial = panel.get('/api/notes/AAPL').json()
    assert initial['version'] == 0 and initial['note'] == ''
    saved = panel.put('/api/notes/AAPL', json={'note':'Research <script> as plain text', 'tags':[' tech ','tech'], 'version':0})
    assert saved.status_code == 200 and saved.json()['tags'] == ['tech']
    stale = panel.put('/api/notes/AAPL', json={'note':'outdated overwrite', 'version':0})
    assert stale.status_code == 409
    assert panel.get('/api/notes/AAPL').json()['note'].startswith('Research')
    assert panel.put('/api/notes/AAPL', json={'note':'x'*6001,'version':1}).status_code == 422
    assert panel.put('/api/notes/AAPL', json={'note':'valid','tags':['x'*25],'version':1}).status_code == 422
    final = panel.put('/api/notes/AAPL', json={'note':'Updated', 'version':1}).json()
    assert final['version'] == 2
