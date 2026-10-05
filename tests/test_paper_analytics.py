"""Immutable observed NAV tests with isolated synthetic daily prices."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_analytics as analytics, paper_portfolio as paper, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "paper-analytics-test.db"))
    clock = {"session": "2024-01-05"}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: clock["session"])
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        analytics.init_schema(db)
        _price(db, 100, clock["session"])
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(analytics.router)
    with TestClient(app) as client:
        account = client.post("/api/paper/accounts", json={"name": "Synthetic NAV", "initial_cash": 10000,
                                                          "idempotency_key": "analytics-account"}).json()["account"]
        yield client, account, clock


def _price(db, price, day):
    db.execute("INSERT OR REPLACE INTO datasets(symbol,currency,status,last_date) VALUES ('SYNTH','USD','ok',?)", (day,))
    db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTH',?,?,?,?,?,?,1000)", (day, price, price * 1.01, price * .99, price, price))


def _capture(client, account, **changes):
    return client.post(f"/api/paper/accounts/{account['id']}/nav/capture", json={"expected_version": account["version"], **changes})


def _report(client, account, **params):
    response = client.get(f"/api/paper/accounts/{account['id']}/nav", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _buy(client, account):
    proposal = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={"expected_version": account["version"],
                          "targets": [{"symbol": "SYNTH", "weight_pct": 30}], "idempotency_key": "analytics-plan"}).json()
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept", json={"expected_version": account["version"], "idempotency_key": "analytics-accept"})
    assert response.status_code == 200, response.text
    return response.json()["account"]["account"]


def test_nav_is_explicit_current_read_does_not_create_history(workspace):
    client, account, _ = workspace
    revision = store.input_revision()
    result = _report(client, account)
    assert result["current"]["equity"] == 10000
    assert result["current"]["cash"] == 10000
    assert result["series"] == []
    assert not result["summary"]["performance_available"]
    assert result["summary"]["max_drawdown_pct"] is None
    assert result["costs"]["simulated_fill_count"] == 0
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_nav_snapshots").fetchone()[0] == 0
    json.dumps(result, allow_nan=False)


def test_capture_is_naturally_idempotent_and_does_not_advance_account_or_market_revision(workspace):
    client, account, _ = workspace
    revision = store.input_revision()
    first = _capture(client, account, expected_input_revision=revision)
    assert first.status_code == 200 and first.json()["created"]
    second = _capture(client, account)
    assert second.status_code == 200 and not second.json()["created"]
    assert first.json()["snapshot"] == second.json()["snapshot"]
    assert first.json()["snapshot"]["engine_version"] == "alphaview-paper-analytics-v1"
    assert first.json()["snapshot"]["paper_engine_version"] == paper.ENGINE_VERSION
    assert client.get(f"/api/paper/accounts/{account['id']}").json()["account"]["version"] == 1
    assert store.input_revision() == revision
    assert len(_report(client, account)["series"]) == 1
    assert not _report(client, account)["summary"]["performance_available"]


def test_capture_keeps_immutable_revision_history_and_latest_daily_observation(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    first = _capture(client, account).json()["snapshot"]
    with store.connect() as db:
        _price(db, 200, clock["session"])
    second = _capture(client, account).json()["snapshot"]
    assert first["id"] != second["id"] and first["input_revision"] != second["input_revision"]
    assert first["equity"] == 10000 and second["equity"] == 13000
    report = _report(client, account)
    assert report["series"][0]["snapshot_id"] == second["id"]
    assert report["series"][0]["equity"] == 13000
    history = client.get(f"/api/paper/accounts/{account['id']}/nav/snapshots").json()
    assert history["total"] == 2
    assert history["items"] == [second, first]
    json.dumps(history, allow_nan=False)


def test_adjacent_complete_sessions_have_returns_and_observed_max_drawdown(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    for day, value in (("2024-01-08", 200), ("2024-01-09", 100)):
        clock["session"] = day
        with store.connect() as db:
            _price(db, value, day)
        _capture(client, account)
    report = _report(client, account)
    assert [row["as_of"] for row in report["series"]] == ["2024-01-05", "2024-01-08", "2024-01-09"]
    assert [row["equity"] for row in report["series"]] == [10000, 13000, 10000]
    assert report["series"][0]["return_pct"] is None
    assert report["series"][1]["return_pct"] == 30
    assert report["series"][2]["return_pct"] == pytest.approx(-3000 / 13000 * 100)
    assert report["summary"]["performance_available"]
    assert report["summary"]["observed_sessions"] == report["summary"]["complete_count"] == 3
    assert report["summary"]["period_return_pct"] == 0
    assert report["summary"]["max_drawdown_pct"] == pytest.approx(3000 / 13000 * 100)
    assert report["current"]["total_return_pct"] == 0
    short = _report(client, account, window_sessions=2)
    assert short["summary"]["truncated"]
    assert short["summary"]["observed_sessions"] == 2
    assert short["summary"]["start"] == "2024-01-08"


def test_missing_quote_capture_stays_null_and_blocks_period_metrics(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    clock["session"] = "2024-01-08"
    incomplete = _capture(client, account).json()["snapshot"]
    assert not incomplete["valuation_complete"] and incomplete["equity"] is None
    assert incomplete["coverage"] == {"required": 1, "priced": 0, "missing": ["SYNTH"]}
    clock["session"] = "2024-01-09"
    with store.connect() as db:
        _price(db, 120, clock["session"])
    _capture(client, account)
    report = _report(client, account)
    assert [point["status"] for point in report["series"]] == ["complete", "incomplete", "complete"]
    assert report["series"][1]["equity"] is None
    assert all(point["return_pct"] is None for point in report["series"])
    assert report["summary"]["missing_count"] == 1
    assert report["summary"]["period_return_pct"] is None
    assert report["summary"]["max_drawdown_pct"] is None
    assert not report["summary"]["performance_available"]
    assert report["current"]["total_return_pct"] == 6


def test_uncaptured_session_is_a_gap_even_if_local_price_exists(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    with store.connect() as db:
        _price(db, 110, "2024-01-08")
        _price(db, 120, "2024-01-09")
    clock["session"] = "2024-01-09"
    _capture(client, account)
    report = _report(client, account)
    assert report["series"][1]["status"] == "not_captured"
    assert report["series"][1]["equity"] is None
    assert report["series"][1]["snapshot_id"] is None
    assert report["series"][2]["return_pct"] is None
    assert report["summary"]["captured_count"] == 2
    assert report["summary"]["observed_sessions"] == 3
    assert report["summary"]["max_drawdown_pct"] is None


def test_later_adjacent_returns_resume_without_bridging_earlier_gap(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    for day, price in (("2024-01-09", 120), ("2024-01-10", 130)):
        clock["session"] = day
        with store.connect() as db:
            _price(db, price, day)
        _capture(client, account)
    report = _report(client, account)
    assert report["series"][2]["return_pct"] is None
    assert report["series"][3]["return_pct"] == pytest.approx(300 / 10600 * 100)
    assert report["summary"]["max_drawdown_pct"] is None


def test_current_missing_valuation_is_distinct_from_last_captured_value(workspace):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    clock["session"] = "2024-01-08"
    report = _report(client, account)
    assert report["current"]["equity"] is None
    assert report["current"]["total_return_pct"] is None
    assert report["series"][0]["equity"] == 10000
    assert report["series"][1]["status"] == "not_captured"


def test_cost_summary_includes_execution_fees_and_slippage(workspace):
    client, account, _ = workspace
    updated = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 1,
                           "execution_policy": {"fee_bps": 100, "slippage_bps": 100}}).json()["account"]
    account = _buy(client, updated)
    report = _report(client, account)
    assert report["costs"] == {"simulated_fill_count": 1, "buy_notional": 3030, "sell_notional": 0,
                                "fees_total": 30.3, "slippage_total": 30, "cost_total": 60.3, "turnover_pct_sum": 30}
    assert report["current"]["equity"] == 9939.7
    assert report["current"]["total_return_pct"] == -.603


def test_capture_rejects_stale_account_and_input_revision_without_writes(workspace):
    client, account, _ = workspace
    assert _capture(client, account, expected_version=2).status_code == 409
    assert _capture(client, account, expected_input_revision="stale-revision").status_code == 409
    assert _report(client, account)["series"] == []


def test_concurrent_captures_have_one_immutable_row(workspace):
    client, account, _ = workspace
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _capture(client, account).json(), range(2)))
    assert sorted(result["created"] for result in results) == [False, True]
    assert results[0]["snapshot"] == results[1]["snapshot"]
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_nav_snapshots").fetchone()[0] == 1


def test_nav_reads_share_one_snapshot_with_market_revision(workspace, monkeypatch):
    client, account, clock = workspace
    account = _buy(client, account)
    _capture(client, account)
    revision = store.input_revision()
    original = analytics._daily_series
    changed = []
    def racing_series(*args):
        result = original(*args)
        if not changed:
            changed.append(True)
            with sqlite3.connect(store.db_path()) as db:
                _price(db, 200, clock["session"])
        return result
    monkeypatch.setattr(analytics, "_daily_series", racing_series)
    result = _report(client, account)
    assert result["input_revision"] == revision
    assert result["current"]["input_revision"] == revision
    assert result["current"]["equity"] == 10000
    assert store.input_revision() != revision


@pytest.mark.parametrize("payload", [{"expected_version": 0}, {"expected_version": True},
                                     {"expected_version": 1, "unexpected": 1}, {"expected_version": 1, "as_of": "2024-01-04"}])
def test_capture_never_accepts_backdated_or_unbounded_payloads(workspace, payload):
    client, account, _ = workspace
    assert client.post(f"/api/paper/accounts/{account['id']}/nav/capture", json=payload).status_code == 422


def test_nav_query_and_history_pagination_are_bounded(workspace):
    client, account, _ = workspace
    _capture(client, account)
    assert client.get(f"/api/paper/accounts/{account['id']}/nav", params={"window_sessions": 1}).status_code == 422
    assert client.get(f"/api/paper/accounts/{account['id']}/nav", params={"window_sessions": 2521}).status_code == 422
    history = client.get(f"/api/paper/accounts/{account['id']}/nav/snapshots", params={"limit": 1}).json()
    assert len(history["items"]) == history["total"] == 1
    assert client.get(f"/api/paper/accounts/{account['id']}/nav/snapshots", params={"limit": 101}).status_code == 422
