"""Fixed-window captured NAV comparisons with synthetic balances and quotes."""
import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_analytics as analytics, paper_comparison as comparison, paper_portfolio as paper, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "nav-compare.db"))
    clock = {"session": "2024-01-05"}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: clock["session"])
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        analytics.init_schema(db)
        _price(db, 100, clock["session"])
    app = FastAPI()
    for router in (paper.router, analytics.router, comparison.router):
        app.include_router(router)
    with TestClient(app) as client:
        accounts = []
        for index, cash in enumerate((10000, 20000)):
            account = client.post("/api/paper/accounts", json={"name": f"Synthetic {index}", "initial_cash": cash,
                                                             "idempotency_key": f"comparison-account-{index}"}).json()["account"]
            accounts.append(account)
        proposal = client.post(f"/api/paper/accounts/{accounts[0]['id']}/proposals", json={"expected_version": 1,
            "targets": [{"symbol": "SYNTH", "weight_pct": 30}], "idempotency_key": "comparison-buy"}).json()
        accounts[0] = client.post(f"/api/paper/accounts/{accounts[0]['id']}/proposals/{proposal['id']}/accept",
                                 json={"expected_version": 1, "idempotency_key": "comparison-accept"}).json()["account"]["account"]
        yield client, accounts, clock


def _price(db, price, day):
    db.execute("INSERT OR REPLACE INTO datasets(symbol,currency,status,last_date) VALUES ('SYNTH','USD','ok',?)", (day,))
    db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTH',?,?,?,?,?,?,1000)", (day, price, price * 1.01, price * .99, price, price))


def _capture(client, accounts):
    return [client.post(f"/api/paper/accounts/{account['id']}/nav/capture", json={"expected_version": account["version"]}).json()["snapshot"] for account in accounts]


def _compare(client, accounts, start="2024-01-05", end="2024-01-08"):
    response = client.post("/api/paper/nav/compare", json={"account_ids": [row["id"] for row in accounts], "start": start, "end": end})
    assert response.status_code == 200, response.text
    return response.json()


def _next(client, accounts, clock, day, price):
    clock["session"] = day
    with store.connect() as db:
        _price(db, price, day)
    return _capture(client, accounts)


def test_fixed_period_compares_captured_returns_with_common_normalized_start(workspace):
    client, accounts, clock = workspace
    initial = _capture(client, accounts)
    final = _next(client, accounts, clock, "2024-01-08", 200)
    revision = store.input_revision()
    result = _compare(client, accounts)
    assert result["engine_version"] == "alphaview-paper-nav-comparison-v1"
    assert result["period"] == {"start": "2024-01-05", "end": "2024-01-08", "session_count": 2}
    assert result["common_start_complete"] and result["comparable"]
    first, second = result["accounts"]
    assert first["start_equity"] == 10000 and first["end_equity"] == 13000
    assert first["return_pct"] == 30 and second["return_pct"] == 0
    assert [point["normalized100"] for point in first["series"]] == [100, 130]
    assert [point["normalized100"] for point in second["series"]] == [100, 100]
    assert first["series"][0]["snapshot_id"] == initial[0]["id"]
    assert first["series"][1]["snapshot_id"] == final[0]["id"]
    assert first["series"][1]["input_revision"] == final[0]["input_revision"]
    assert result["comparisons"] == [{"left_id": accounts[0]["id"], "right_id": accounts[1]["id"],
                                     "return_difference_pp": 30, "equity_change_difference": 3000,
                                     "left_initial_cash": 10000, "right_initial_cash": 20000}]
    assert store.input_revision() == revision
    json.dumps(result, allow_nan=False)


def test_missing_requested_start_is_not_shifted_and_disables_all_normalization(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts[:1])
    _next(client, accounts, clock, "2024-01-08", 200)
    result = _compare(client, accounts)
    assert not result["common_start_complete"] and not result["comparable"]
    assert result["accounts"][1]["start_equity"] is None
    assert result["accounts"][1]["series"][0]["as_of"] == "2024-01-05"
    assert result["accounts"][1]["series"][0]["status"] == "not_captured"
    assert all(point["normalized100"] is None for account in result["accounts"] for point in account["series"])
    assert result["accounts"][0]["performance_available"]
    assert not result["accounts"][1]["performance_available"]
    assert result["comparisons"] == []
    assert result["period"]["start"] == "2024-01-05"


def test_missing_requested_end_remains_null_not_latest_available_value(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    _next(client, accounts[:1], clock, "2024-01-08", 200)
    result = _compare(client, accounts)
    assert result["common_start_complete"] and not result["comparable"]
    second = result["accounts"][1]
    assert second["end_equity"] is None
    assert second["return_pct"] is None and second["equity_change"] is None and second["max_drawdown_pct"] is None
    assert second["series"][-1]["as_of"] == "2024-01-08"
    assert second["series"][-1]["normalized100"] is None
    assert result["comparisons"] == []


def test_midperiod_gap_stays_null_and_blocks_statistics_without_hiding_later_observations(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    _next(client, accounts[:1], clock, "2024-01-08", 200)
    _next(client, accounts, clock, "2024-01-09", 100)
    result = _compare(client, accounts, end="2024-01-09")
    first, second = result["accounts"]
    assert first["max_drawdown_pct"] == pytest.approx(3000 / 13000 * 100)
    assert first["return_pct"] == 0
    assert second["coverage"]["missing_sessions"] == ["2024-01-08"]
    assert [point["normalized100"] for point in second["series"]] == [100, None, 100]
    assert second["return_pct"] is None and second["max_drawdown_pct"] is None
    assert not result["comparable"] and result["comparisons"] == []


def test_incomplete_quote_capture_is_not_treated_as_cash_only_nav(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    clock["session"] = "2024-01-08"
    _capture(client, accounts)
    result = _compare(client, accounts)
    first = result["accounts"][0]
    assert first["series"][-1]["status"] == "incomplete"
    assert first["series"][-1]["equity"] is None
    assert first["series"][-1]["quote_coverage"]["missing"] == ["SYNTH"]
    assert not result["comparable"]


def test_only_latest_immutable_capture_per_session_is_selected(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    old = _next(client, accounts, clock, "2024-01-08", 150)
    latest = _next(client, accounts, clock, "2024-01-08", 200)
    result = _compare(client, accounts)
    assert result["accounts"][0]["series"][-1]["snapshot_id"] == latest[0]["id"]
    assert result["accounts"][0]["end_equity"] == 13000
    with store.connect() as db:
        assert json.loads(db.execute("SELECT snapshot_json FROM paper_nav_snapshots WHERE id=?", (old[0]["id"],)).fetchone()[0])["equity"] == 11500


def test_new_current_prices_do_not_revalue_historical_captures(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    _next(client, accounts, clock, "2024-01-08", 200)
    with store.connect() as db:
        _price(db, 999, "2024-01-08")
    result = _compare(client, accounts)
    assert result["accounts"][0]["end_equity"] == 13000
    assert result["accounts"][0]["return_pct"] == 30


def test_unsupported_latest_snapshot_method_is_explicit_gap(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    latest = _next(client, accounts, clock, "2024-01-08", 200)
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM paper_nav_snapshots WHERE id=?", (latest[0]["id"],)).fetchone())
        payload = json.loads(row["snapshot_json"])
        payload["engine_version"] = "synthetic-future-analytics"
        db.execute("INSERT INTO paper_nav_snapshots(account_id,as_of,account_version,input_revision,engine_version,observed_at,snapshot_json) VALUES (?,?,?,?,?,?,?)",
                   (row["account_id"], row["as_of"], row["account_version"], row["input_revision"], payload["engine_version"], row["observed_at"], json.dumps(payload)))
    result = _compare(client, accounts)
    assert result["accounts"][0]["series"][-1]["status"] == "unsupported_method"
    assert result["accounts"][0]["end_equity"] is None
    assert not result["comparable"]


def test_account_input_order_is_preserved_without_performance_ranking(workspace):
    client, accounts, clock = workspace
    _capture(client, accounts)
    _next(client, accounts, clock, "2024-01-08", 200)
    result = _compare(client, list(reversed(accounts)))
    assert [row["account_id"] for row in result["accounts"]] == [accounts[1]["id"], accounts[0]["id"]]
    assert result["comparisons"][0]["return_difference_pp"] == -30
    assert "rankings" not in result and "winner" not in result


def test_comparison_reads_all_accounts_in_one_database_snapshot(workspace, monkeypatch):
    client, accounts, clock = workspace
    _capture(client, accounts)
    _next(client, accounts, clock, "2024-01-08", 200)
    original = comparison._account_series
    changed = []
    def racing_series(db, account, days):
        result = original(db, account, days)
        if not changed:
            changed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("DELETE FROM paper_nav_snapshots WHERE account_id=? AND as_of='2024-01-08'", (accounts[1]["id"],))
        return result
    monkeypatch.setattr(comparison, "_account_series", racing_series)
    result = _compare(client, accounts)
    assert result["comparable"] and result["accounts"][1]["end_equity"] == 20000
    assert not _compare(client, accounts)["comparable"]


@pytest.mark.parametrize("start,end", [("2024-01-06", "2024-01-08"), ("2024-01-05", "2024-01-07"),
                                      ("2024-01-05", "2024-01-09"), ("2010-01-04", "2024-01-08")])
def test_no_silent_calendar_shift_future_endpoint_or_unbounded_period(workspace, start, end):
    client, accounts, clock = workspace
    clock["session"] = "2024-01-08"
    response = client.post("/api/paper/nav/compare", json={"account_ids": [row["id"] for row in accounts], "start": start, "end": end})
    assert response.status_code == 422


@pytest.mark.parametrize("change", [{"account_ids": ["only-one"]}, {"account_ids": ["same", "same"]},
                                    {"account_ids": [f"a{i}" for i in range(6)]}, {"start": "2024-02-30"},
                                    {"start": "2024-01-08", "end": "2024-01-08"}, {"extra": 1}])
def test_comparison_request_is_bounded_and_forbids_extra_fields(workspace, change):
    client, accounts, clock = workspace
    clock["session"] = "2024-01-08"
    body = {"account_ids": [row["id"] for row in accounts], "start": "2024-01-05", "end": "2024-01-08", **change}
    assert client.post("/api/paper/nav/compare", json=body).status_code == 422


def test_unknown_account_is_not_silently_omitted(workspace):
    client, accounts, clock = workspace
    clock["session"] = "2024-01-08"
    assert client.post("/api/paper/nav/compare", json={"account_ids": [accounts[0]["id"], "missing-account"], "start": "2024-01-05", "end": "2024-01-08"}).status_code == 404
