from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import jobs, market, store


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "universe.db"))
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('OLD','Old member','test',?,1)", (store.now(),))


def quote(i):
    return {"symbol": f"S{i}", "longName": f"Stock {i}", "quoteType": "EQUITY", "currency": "USD", "exchange": "NMS", "marketCap": 1000000000000 - i}


def paginated(total=1886):
    def fetch(query, *, size, offset, **kwargs):
        assert size <= 250
        assert kwargs == {"sortField": "intradaymarketcap", "sortAsc": False}
        return {"start": offset, "total": total, "quotes": [quote(i) for i in range(offset, min(offset + size, total))]}
    return fetch


@pytest.mark.parametrize("limit,pages", [(250, 1), (500, 2), (1000, 4)])
def test_expands_with_bounded_sequential_pages_and_metadata(limit, pages):
    with patch("yfinance.screen", side_effect=paginated()) as screen:
        assert market.discover_universe(limit) == limit
    assert [c.kwargs["offset"] for c in screen.call_args_list] == list(range(0, limit, 250))
    metadata = market.universe_metadata()
    assert metadata == {"requested_limit": limit, "provider_total": 1886, "raw_count": limit,
                        "accepted_count": limit, "pages": pages, "discovered_at": metadata["discovered_at"]}
    assert len(store.universe("market")) == limit
    assert all(str(limit) in r["source"] for r in store.universe("market"))


def test_legitimate_short_total_keeps_requested_limit_and_explicit_actual_count():
    with patch("yfinance.screen", side_effect=paginated(310)):
        assert market.discover_universe(1000) == 310
    assert market.universe_metadata()["requested_limit"] == 1000
    assert market.universe_metadata()["accepted_count"] == 310
    assert market.universe_metadata()["pages"] == 2


@pytest.mark.parametrize("defect", ["exception", "short", "wrong_offset", "duplicate_page", "changed_total"])
def test_second_page_failure_preserves_previous_pool_and_metadata(defect):
    before = market.universe_metadata()
    def fetch(query, **kwargs):
        response = paginated()(query, **kwargs)
        if kwargs["offset"]:
            if defect == "exception": raise RuntimeError("provider timeout")
            if defect == "short": response["quotes"].pop()
            if defect == "wrong_offset": response["start"] = 0
            if defect == "duplicate_page": response["quotes"] = [quote(i) for i in range(250)]
            if defect == "changed_total": response["total"] += 1
        return response
    with patch("yfinance.screen", side_effect=fetch), pytest.raises((ValueError, RuntimeError)):
        market.discover_universe(500)
    assert [r["symbol"] for r in store.universe("market")] == ["OLD"]
    assert market.universe_metadata() == before


@pytest.mark.parametrize("cancel_call", [3, 5, 6])
def test_cancellation_between_pages_or_before_atomic_publish_preserves_pool(cancel_call):
    checks = 0
    def cancel():
        nonlocal checks
        checks += 1
        if checks == cancel_call:
            raise jobs.JobCancelled()
    with patch("yfinance.screen", side_effect=paginated()), pytest.raises(jobs.JobCancelled):
        market.discover_universe(500, check_cancel=cancel)
    assert [r["symbol"] for r in store.universe("market")] == ["OLD"]
    assert market.universe_metadata()["provider_total"] is None


def test_deduplicates_boundary_and_filters_invalid_identity_with_actual_count():
    def fetch(query, **kwargs):
        response = paginated()(query, **kwargs)
        if kwargs["offset"]:
            response["quotes"][0] = quote(249)
            response["quotes"][1]["quoteType"] = "ETF"
            response["quotes"][2]["currency"] = "EUR"
        return response
    with patch("yfinance.screen", side_effect=fetch):
        assert market.discover_universe(500) == 497
    assert market.universe_metadata()["raw_count"] == 500
    assert market.universe_metadata()["accepted_count"] == 497


@pytest.mark.parametrize("limit", [0, 251, 2000, True, 250.0, "500"])
def test_invalid_direct_limits_do_not_contact_provider(limit):
    with patch("yfinance.screen") as screen, pytest.raises(ValueError):
        market.discover_universe(limit)
    screen.assert_not_called()


def test_targeted_retry_does_not_rediscover_or_shrink_expanded_pool():
    with patch("yfinance.screen", side_effect=paginated()):
        market.discover_universe(500)
    before = market.universe_metadata()
    with patch.object(market, "discover_universe") as discovery, patch.object(market, "fetch_symbol", return_value={"symbol": "S300"}) as fetch:
        result = market.refresh(scope="market", symbols=["S300"], universe_limit=250)
    discovery.assert_not_called(); fetch.assert_called_once_with("S300")
    assert result == [{"symbol": "S300", "status": "ok"}]
    assert len(store.universe("market")) == 500 and market.universe_metadata() == before


def test_job_limit_validation_and_thread_contract():
    app = FastAPI(); app.include_router(jobs.router)
    with TestClient(app) as client:
        for body in [{"kind": "refresh", "scope": "market", "universe_limit": 300}, {"kind": "refresh", "scope": "portfolio", "universe_limit": 500}, {"kind": "scan", "scope": "market", "universe_limit": 1000}]:
            assert client.post("/api/jobs", json=body).status_code == 422
        with patch.object(jobs.threading, "Thread") as thread:
            response = client.post("/api/jobs", json={"kind": "refresh", "scope": "market", "universe_limit": 1000})
        assert response.status_code == 202
        assert thread.call_args.kwargs["args"][-1] == 1000
        jobs.RUN_LOCK.release()
