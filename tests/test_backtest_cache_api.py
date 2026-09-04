"""A saved result belongs to its parameters and observed input history."""
import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from alphaview.panel import store
from alphaview.panel.api import app
from tests.test_panel import sample_frame


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "cache.db"))
    with TestClient(app) as client:
        with store.connect() as db:
            sample_frame(240).to_sql("bars", db, if_exists="append", index=False)
        yield client


def test_api_cache_selects_exact_parameters_and_rejects_changed_input(client):
    end = sample_frame(240).iloc[230].date
    first = {"symbol": "TEST", "strategy": "turtle", "initial": 25000,
             "fee_bps": 25, "end_date": end}
    response = client.post("/api/backtest", json=first)
    assert response.status_code == 200
    original = response.json()
    assert original["parameters"]["initial"] == 25000
    assert original["parameters"]["fee_bps"] == 25
    assert client.post("/api/backtest", json={**first, "initial": 50000}).status_code == 200
    query = {k: v for k, v in first.items() if k not in ("symbol", "strategy")}
    saved = client.get("/api/backtest/TEST/turtle", params=query).json()
    assert saved["input_fingerprint"] == original["input_fingerprint"]
    assert saved["final"] == original["final"]
    assert saved["cache_stale"] is False
    assert client.get("/api/backtest/TEST/turtle").json() is None
    assert client.get("/api/backtest/TEST/turtle", params={**query, "fee_bps": 26}).json() is None
    # A correction after the requested end cannot contaminate a historical result.
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume*2 WHERE date>?", (end,))
    assert client.get("/api/backtest/TEST/turtle", params=query).json()["cache_stale"] is False
    # A valid correction within the input range makes the cache visibly stale.
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume*2 WHERE date=?", (end,))
    stale = client.get("/api/backtest/TEST/turtle", params=query).json()
    assert stale["cache_stale"] is True
    assert stale["final"] == original["final"]


def test_corrupt_history_keeps_saved_result_inspectable_but_stale(client):
    assert client.post("/api/backtest", json={"symbol": "TEST", "strategy": "turtle"}).status_code == 200
    with store.connect() as db:
        db.execute("UPDATE bars SET high=0 WHERE date=(SELECT MAX(date) FROM bars)")
    response = client.get("/api/backtest/TEST/turtle")
    assert response.status_code == 200
    assert response.json()["cache_stale"] is True
    assert client.post("/api/backtest", json={"symbol": "TEST", "strategy": "turtle"}).status_code == 422
