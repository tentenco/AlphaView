import json
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from alphaview.panel import research, scan_context, sessions, store
from alphaview.panel.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "provenance.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-04")
    with TestClient(app) as client:
        with store.connect() as db:
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('TEST','Synthetic',0,'test','now')")
            db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [("TEST", day, 100., 101., 99., 100., 100., 1000.) for day in ("2024-01-02", "2024-01-03", "2024-01-04")])
        yield client


def seed_scan(day="2024-01-04", *, legacy=False, scope="portfolio"):
    row = {"symbol": "TEST", "name": "Synthetic", "date": day, "bars": 3,
           "indicators": {"rsi": 80}, "signals": [{"strategy": "turtle", "status": "match", "matched": True, "reason": "synthetic"}]}
    with store.connect() as db:
        cursor = db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('2024-01-04T22:00:00+00:00',?,'[\"TEST\"]',?,?,?)", (day, json.dumps([row]), scope, None if legacy else store.input_revision(db)))
    return cursor.lastrowid


def test_current_signal_carries_precise_snapshot_context(client):
    identifier = seed_scan()
    result = client.get("/api/stocks/TEST").json()["position"]
    assert result["research"]["signals"][0]["matched"]
    assert result["research_context"] == {"snapshot_id": identifier, "as_of": "2024-01-04", "created_at": "2024-01-04T22:00:00+00:00", "scope": "portfolio", "input_status": "current", "available": True, "reason": None}


def test_current_quote_cannot_show_previous_session_signal(client):
    seed_scan("2024-01-03")
    result = client.get("/api/stocks/TEST").json()["position"]
    assert result["price_date"] == "2024-01-04" and result["research"] is None
    assert result["research_context"]["as_of"] == "2024-01-03"
    assert "日期" in result["research_context"]["reason"]
    historical = client.get("/api/stocks/TEST?as_of=2024-01-03").json()["position"]
    assert historical["research"] is not None


def test_legacy_unknown_never_treated_as_current(client):
    seed_scan(legacy=True)
    result = client.get("/api/stocks/TEST").json()["position"]
    assert result["research"] is None
    assert result["research_context"]["input_status"] == "unknown"
    scan = client.get("/api/scans").json()
    assert scan["input_stale"] is None and scan["input_status"] == "unknown"


def test_same_date_price_changes_invalidate_current_and_historical_signals(client):
    seed_scan()
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='TEST'")
    for suffix in ("", "?as_of=2024-01-04"):
        result = client.get("/api/stocks/TEST" + suffix).json()["position"]
        assert result["research"] is None
        assert result["research_context"]["input_status"] == "stale"
    assert client.get("/api/scans").json()["input_stale"] is True


def test_scan_and_job_publication_do_not_invalidate_inputs_or_other_scopes(client):
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('TEST','Synthetic','test','now',3000000000)")
    before = store.input_revision()
    research.scan(scope="market")
    research.scan(scope="portfolio")
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at) VALUES ('job','scan','completed','now')")
        db.execute("UPDATE jobs SET progress='updated' WHERE id='job'")
    assert store.input_revision() == before
    assert client.get("/api/scans?scope=market").json()["input_status"] == "current"
    assert client.get("/api/scans?scope=portfolio").json()["input_status"] == "current"


def test_direct_writer_during_computation_prevents_all_publication(client):
    seed_scan()
    before = store.latest_scan()["id"]
    changed = False
    def progress(message):
        nonlocal changed
        if not changed:
            changed = True
            with store.connect() as db:
                db.execute("UPDATE bars SET volume=volume+1")
    with pytest.raises(ValueError, match="輸入資料已變更"):
        research.scan(progress)
    assert store.latest_scan()["id"] == before


def test_input_capture_is_consistent_then_rejects_new_writer_token(client):
    original = store.history
    changed = False
    def history(symbol):
        nonlocal changed
        result = original(symbol)
        if not changed:
            changed = True
            # Independent connection intentionally bypasses the shared reader, like another process.
            import sqlite3
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("UPDATE bars SET volume=volume+1")
        return result
    with patch.object(store, "history", side_effect=history), pytest.raises(ValueError, match="輸入資料已變更"):
        research.scan()
    assert store.latest_scan() is None


def test_migration_restart_preserves_existing_data_and_legacy_token(client):
    identifier = seed_scan(legacy=True)
    with store.connect() as db:
        for row in db.execute("SELECT name FROM sqlite_schema WHERE name LIKE 'inputs_%'").fetchall():
            db.execute('DROP TRIGGER "' + row[0] + '"')
        db.execute("ALTER TABLE panel_revisions DROP COLUMN inputs_revision")
        db.execute("ALTER TABLE scans DROP COLUMN input_revision")
    original = store.connect
    class BrokenMigration:
        def __init__(self, db): self.db = db
        def __getattr__(self, name): return getattr(self.db, name)
        def execute(self, sql, *args):
            if sql.startswith("CREATE TRIGGER IF NOT EXISTS inputs_"):
                raise RuntimeError("synthetic migration interruption")
            return self.db.execute(sql, *args)
    @contextmanager
    def connection():
        with original() as db:
            yield BrokenMigration(db)
    with patch.object(store, "connect", connection), pytest.raises(RuntimeError):
        store.init_db()
    with store.connect() as db:
        assert "inputs_revision" not in {row["name"] for row in db.execute("PRAGMA table_info(panel_revisions)")}
        assert "input_revision" not in {row["name"] for row in db.execute("PRAGMA table_info(scans)")}
    store.init_db()
    token = store.input_revision()
    store.init_db()
    assert store.input_revision() == token
    assert store.latest_scan()["id"] == identifier and store.latest_scan()["input_revision"] is None
    assert len(store.positions()) == 1
