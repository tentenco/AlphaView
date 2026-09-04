import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import jobs, market, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "jobs.db"))
    store.init_db()
    with store.connect() as db:
        if "cancel_requested" not in {r["name"] for r in db.execute("PRAGMA table_info(jobs)")}:
            db.execute("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0")
    store.seed_portfolio()
    app = FastAPI(); app.include_router(jobs.router)
    with TestClient(app) as value:
        yield value
    if jobs.RUN_LOCK.locked():
        jobs.RUN_LOCK.release()


def insert_job(kind="refresh", scope="portfolio", cancel=0):
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope,cancel_requested) VALUES ('test',?,'running',?,?,?)", (kind, store.now(), scope, cancel))
    assert jobs.RUN_LOCK.acquire(blocking=False)


def read_job():
    with store.connect() as db:
        return dict(db.execute("SELECT * FROM jobs ORDER BY started_at DESC LIMIT 1").fetchone())


def scanned(**extra):
    return {"symbols": 7, "matched_symbols": ["NVDA"], "unchanged": False, "data_error_symbols": [], **extra}


def test_thread_start_failure_is_terminal_and_unlocks(client):
    with patch.object(jobs.threading.Thread, "start", side_effect=RuntimeError("thread unavailable")):
        with pytest.raises(HTTPException) as caught:
            jobs.start_job(jobs.JobInput(kind="refresh"))
    assert caught.value.status_code == 503
    assert read_job()["status"] == "failed"
    assert read_job()["finished_at"]
    assert not jobs.RUN_LOCK.locked()


def test_validation_does_not_leave_lock_or_ghost_job(client):
    for body in [{"kind": "bad"}, {"kind": "retry"}, {"kind": "retry", "symbols": ["UNKNOWN"]}, {"kind": "scan", "symbols": ["NVDA"]}, {"kind": "retry", "symbols": ["NVDA"] * 101}]:
        assert client.post("/api/jobs", json=body).status_code == 422
        assert not jobs.RUN_LOCK.locked()
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_cancel_request_keeps_running_until_worker_stops(client):
    insert_job()
    assert client.post("/api/jobs/test/cancel").json() == {"id": "test", "status": "running", "cancel_requested": True}
    assert read_job()["status"] == "running"
    with patch.object(jobs.market, "refresh") as refresh, patch.object(jobs.research, "scan") as scan:
        jobs.worker("test", "refresh")
    refresh.assert_not_called(); scan.assert_not_called()
    assert read_job()["status"] == "cancelled" and read_job()["error"] is None
    assert client.post("/api/jobs/test/cancel").json()["status"] == "cancelled"
    assert client.post("/api/jobs/missing/cancel").status_code == 404
    assert not jobs.RUN_LOCK.locked()


def test_scan_cancelled_during_progress_never_publishes(client):
    insert_job(kind="scan")
    def scan(progress, scope, check_cancel=None):
        client.post("/api/jobs/test/cancel")
        progress("calculated first date")
        pytest.fail("cancelled progress must stop scan")
    with patch.object(jobs.research, "scan", side_effect=scan):
        jobs.worker("test", "scan")
    assert read_job()["status"] == "cancelled"
    assert json.loads(read_job()["result"])["scans"] == {}


def test_retry_limits_downloads_and_rescans_both_impacted_scopes(client):
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('NVDA','NVIDIA','test',?,1)", (store.now(),))
    insert_job(kind="retry")
    with patch.object(jobs.market, "refresh", return_value=[{"symbol": "NVDA", "status": "ok"}]) as refresh, patch.object(jobs.research, "scan", return_value=scanned()) as scan:
        jobs.worker("test", "retry", "portfolio", ["NVDA"])
    assert refresh.call_args.kwargs["symbols"] == ["NVDA"]
    assert callable(refresh.call_args.kwargs["check_cancel"])
    assert [call.kwargs["scope"] for call in scan.call_args_list] == ["portfolio", "market"]
    assert all(callable(call.kwargs["check_cancel"]) for call in scan.call_args_list)
    assert read_job()["status"] == "completed"
    assert set(json.loads(read_job()["result"])["scans"]) == {"portfolio", "market"}


def test_partial_accounts_for_download_failures_and_quarantined_bars(client):
    insert_job()
    with patch.object(jobs.market, "refresh", return_value=[{"symbol": "NVDA", "status": "error"}]), patch.object(jobs.research, "scan", return_value=scanned(data_error_symbols=["NVDA"])):
        jobs.worker("test", "refresh")
    assert read_job()["status"] == "partial"
    assert "1 檔更新失敗、1 檔資料異常" in read_job()["progress"]


def test_primary_scope_failure_is_clear_and_unlocks(client):
    insert_job(kind="scan")
    with patch.object(jobs.research, "scan", side_effect=ValueError("尚無歷史日線")):
        jobs.worker("test", "scan")
    assert read_job()["status"] == "failed"
    assert "主要股票池無法完成選股" in read_job()["error"]
    assert not jobs.RUN_LOCK.locked()


def test_refresh_checks_cancel_before_pending_quotes_and_does_not_mark_errors(client):
    calls = []
    def check():
        if calls:
            raise jobs.JobCancelled()
    def fetch(symbol):
        calls.append(symbol)
        return {"symbol": symbol, "rows": 1}
    with patch.object(market, "fetch_symbol", side_effect=fetch), patch.object(market, "discover_universe") as discover:
        with pytest.raises(jobs.JobCancelled):
            market.refresh(scope="portfolio", symbols=["NVDA", "MSFT", "AAPL"], check_cancel=check)
    assert calls == ["NVDA"]
    discover.assert_not_called()
    assert store.dataset_rows() == []


def seed_quote_history():
    import pandas as pd
    from alphaview.panel.sessions import expected_sessions
    dates = expected_sessions("2024-01-02", "2024-06-30")[:45]
    frame = pd.DataFrame({"symbol": "NVDA", "date": dates, "open": 100., "high": 101.,
                          "low": 99., "close": 100., "adj_close": 100., "volume": 1_000_000.})
    with store.connect() as db:
        frame.to_sql("bars", db, if_exists="append", index=False)
    return dates


def test_cancel_during_final_calculation_preserves_previous_scan_batch(client):
    dates = seed_quote_history()
    jobs.research.scan()
    previous = store.latest_scan()
    with store.connect() as db:
        count = db.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
    insert_job(kind="scan")
    evaluate = jobs.research.evaluate

    def cancel_on_final_date(frames, as_of):
        result = evaluate(frames, as_of)
        if as_of == dates[-1]:
            assert client.post("/api/jobs/test/cancel").json()["cancel_requested"]
        return result

    with patch.object(jobs.research, "evaluate", side_effect=cancel_on_final_date):
        jobs.worker("test", "scan")
    assert read_job()["status"] == "cancelled"
    assert json.loads(read_job()["result"])["scans"] == {}
    assert store.latest_scan() == previous
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM scans").fetchone()[0] == count
    assert not jobs.RUN_LOCK.locked()


def test_publication_transaction_orders_a_later_cancel_request(client):
    import threading
    seed_quote_history()
    # This verifies the opposite ordering: a cancel writer starting after the
    # publication guard cannot sneak its flag between that check and the inserts.
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope,cancel_requested) VALUES ('ordering','scan','running',?,'portfolio',0)", (store.now(),))
    attempting, cancelled = threading.Event(), threading.Event()
    errors = []
    writer = None

    def request_cancel():
        try:
            attempting.set()
            with store.connect() as db:
                db.execute("UPDATE jobs SET cancel_requested=1 WHERE id='ordering'")
            cancelled.set()
        except Exception as exc:
            errors.append(exc)

    def guard():
        nonlocal writer
        with store.connect() as db:
            assert db.execute("SELECT cancel_requested FROM jobs WHERE id='ordering'").fetchone()[0] == 0
        writer = threading.Thread(target=request_cancel, daemon=True)
        writer.start()
        assert attempting.wait(timeout=5)
        assert not cancelled.wait(timeout=.05)

    result = jobs.research.scan(check_cancel=guard)
    assert cancelled.wait(timeout=5)
    writer.join(timeout=5)
    assert not errors and not writer.is_alive()
    assert store.latest_scan()["as_of"] == result["as_of"]
