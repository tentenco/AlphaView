"""Independent resume checks: boundary cache identities and shared-scope failures."""
import json
from unittest.mock import patch

import pytest

from alphaview.panel import jobs, market, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "resume-independent.db"))
    store.init_db()
    days = sessions.expected_sessions("2026-06-12", "2026-09-04")
    monkeypatch.setattr(market, "latest_completed_session", lambda: days[-1])
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: days[-1])
    yield days
    if jobs.RUN_LOCK.locked():
        jobs.RUN_LOCK.release()


def add(symbol, days, *, error=None, name=None):
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,0,'synthetic','now')", (symbol, name or "Synthetic name"))
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [(symbol, day, 100., 101., 99., 100., 100., 1000.) for day in days])
        db.execute("INSERT INTO datasets(symbol,name,currency,exchange,last_date,bar_count,status,error) VALUES (?,?,'USD','NYQ',?,?,'ok',?)", (symbol, name or "Synthetic name", days[-1] if days else None, len(days), error))


def worker():
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope) VALUES ('job','resume','running','now','portfolio')")
    assert jobs.RUN_LOCK.acquire(False)
    jobs.worker("job", "resume", "portfolio")
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM jobs WHERE id='job'").fetchone())
    row["result"] = json.loads(row["result"])
    return row


@pytest.mark.parametrize("corruption", ["empty", "nonfinite", "ohlc", "error_with_ok_status"])
def test_current_metadata_never_hides_unusable_bars(workspace, corruption):
    add("TEST", workspace, error="previous provider error" if corruption == "error_with_ok_status" else None)
    with store.connect() as db:
        if corruption == "empty":
            db.execute("DELETE FROM bars")
            db.execute("UPDATE datasets SET bar_count=0")
        elif corruption == "nonfinite":
            db.execute("UPDATE bars SET adj_close='Infinity' WHERE date=?", (workspace[-1],))
        elif corruption == "ohlc":
            db.execute("UPDATE bars SET high=80 WHERE date=?", (workspace[-20],))
    with patch.object(market, "fetch_symbol", side_effect=ValueError("still invalid")) as fetch:
        result = market.resume_refresh()
    fetch.assert_called_once_with("TEST")
    assert result["resume"]["skipped"] == 0 and result["resume"]["failed"] == 1


def test_confirmed_spcx_post_listing_short_history_can_skip(workspace):
    add("SPCX", workspace[-10:], name="Space Exploration Technologies")
    with patch.object(market, "fetch_symbol") as fetch:
        result = market.resume_refresh()
    fetch.assert_not_called()
    assert result["resume"]["skipped"] == 1


def test_failed_shared_download_still_rescans_both_scopes(workspace):
    add("SHARED", workspace, error="prior failure")
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('SHARED','Synthetic','test','now',3000000000)")
    with patch.object(market, "fetch_symbol", side_effect=ValueError("provider unavailable")):
        result = worker()
    assert result["status"] == "partial"
    assert set(result["result"]["scans"]) == {"portfolio", "market"}
    assert result["result"]["resume"]["failed"] == 1
    assert result["result"]["resume"]["counts_complete"]


def test_all_cached_resume_does_not_publish_unrelated_pool(workspace):
    add("CACHED", workspace)
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('CACHED','Synthetic','test','now',3000000000)")
    with patch.object(market, "fetch_symbol") as fetch, patch.object(market, "discover_universe") as discover:
        result = worker()
    fetch.assert_not_called()
    discover.assert_not_called()
    assert result["status"] == "completed"
    assert set(result["result"]["scans"]) == {"portfolio"}
    assert store.latest_scan(scope="market") is None


def test_secondary_scan_failure_keeps_primary_and_terminal_partial(workspace):
    add("SHARED", workspace, error="prior failure")
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('SHARED','Synthetic','test','now',3000000000)")
    actual_scan = jobs.research.scan
    def scan(*args, scope, **kwargs):
        if scope == "market":
            raise ValueError("secondary isolated failure")
        return actual_scan(*args, scope=scope, **kwargs)
    with patch.object(market, "fetch_symbol", return_value={"symbol": "SHARED", "rows": len(workspace), "last_date": workspace[-1]}), patch.object(jobs.research, "scan", side_effect=scan):
        result = worker()
    assert result["status"] == "partial"
    assert store.latest_scan(scope="portfolio") is not None
    assert store.latest_scan(scope="market") is None
    assert result["result"]["scan_errors"] == {"market": "secondary isolated failure"}
