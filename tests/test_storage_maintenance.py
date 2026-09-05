import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import storage_maintenance as maintenance, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "storage.db"))
    store.init_db()
    app = FastAPI()
    app.include_router(maintenance.router)
    with TestClient(app) as value:
        yield value


def scan(scope="market", day="2024-01-02", result="研究"):
    with store.connect() as db:
        return db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES ('now',?,'[]',?,?)", (day, result, scope)).lastrowid


def post(client, preview):
    return client.post("/api/storage/cleanup", json={"expected_fingerprint": preview["fingerprint"], "confirm": True})


def test_preview_utf8_payload_and_cleanup_retains_latest_per_scope_date(client):
    old = scan()
    retained = [scan(), scan("portfolio"), scan(day="2024-01-03")]
    before = client.get("/api/storage").json()
    assert before["scan_rows"] == 4 and before["superseded_scan_rows"] == 1
    assert before["retained_scan_rows"] == 3
    assert before["superseded_payload_bytes"] == len("研究[]".encode())
    assert before["database_bytes"] >= 0 and before["wal_bytes"] >= 0
    assert before["reusable_bytes"] == before["page_size"] * before["freelist_pages"]
    response = post(client, before)
    assert response.status_code == 200
    assert response.json()["deleted_rows"] == 1
    assert response.json()["storage"]["superseded_scan_rows"] == 0
    with store.connect() as db:
        assert [row[0] for row in db.execute("SELECT id FROM scans ORDER BY id")] == retained


def test_all_unrelated_tables_unchanged(client):
    scan(); scan()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('TEST','Test',1,'test','now')")
        db.execute("INSERT INTO research_notes(symbol,note,updated_at) VALUES ('TEST','Keep','now')")
        db.execute("INSERT INTO backtests(created_at,symbol,strategy,result) VALUES ('now','TEST','turtle','{}')")
        db.execute("INSERT INTO jobs(id,kind,status,started_at) VALUES ('keep','refresh','completed','now')")
        db.execute("INSERT INTO schedule_attempts VALUES ('2024-01-02','keep','market',250,'now')")
        before = {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")] for table in maintenance.TABLE_PAYLOADS if table != "scans"}
    assert post(client, client.get("/api/storage").json()).status_code == 200
    with store.connect() as db:
        after = {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")] for table in before}
    assert after == before


def test_new_scan_invalidates_preview_and_rolls_back(client):
    scan(); scan()
    preview = client.get("/api/storage").json()
    scan()
    assert post(client, preview).status_code == 409
    assert client.get("/api/storage").json()["scan_rows"] == 3


def test_confirmation_and_workspace_lock(client):
    scan(); scan()
    preview = client.get("/api/storage").json()
    for confirmation in (False, "true", 1):
        assert client.post("/api/storage/cleanup", json={"expected_fingerprint": preview["fingerprint"], "confirm": confirmation}).status_code == 422
    assert maintenance.RUN_LOCK.acquire(blocking=False)
    try:
        assert post(client, preview).status_code == 409
    finally:
        maintenance.RUN_LOCK.release()
    assert post(client, preview).status_code == 200


def test_sql_failure_rolls_back_every_delete_and_releases_lock(client):
    first, second = scan(), scan()
    scan()
    with store.connect() as db:
        db.execute(f"CREATE TRIGGER fail_delete BEFORE DELETE ON scans WHEN OLD.id={second} BEGIN SELECT RAISE(ABORT,'test'); END")
    preview = client.get("/api/storage").json()
    assert post(client, preview).status_code == 500
    assert client.get("/api/storage").json()["scan_rows"] == 3
    assert maintenance.RUN_LOCK.acquire(blocking=False)
    maintenance.RUN_LOCK.release()


def test_empty_preview_and_repeat_cleanup_safe(client):
    preview = client.get("/api/storage").json()
    assert preview["superseded_scan_rows"] == 0
    assert post(client, preview).json()["deleted_rows"] == 0
    assert post(client, preview).json()["deleted_rows"] == 0


def test_scan_bound_and_deadline_fail_without_deleting(client, monkeypatch):
    scan(); scan()
    monkeypatch.setattr(maintenance, "MAX_SCAN_ROWS", 1)
    assert client.get("/api/storage").status_code == 503
    monkeypatch.setattr(maintenance, "MAX_SCAN_ROWS", 100000)
    preview = client.get("/api/storage").json()
    monkeypatch.setattr(maintenance, "MAX_SECONDS", -1)
    # Ensure SQLite executes enough VM operations to invoke its progress handler.
    with store.connect() as db:
        db.executemany("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES ('now','2024-01-02','[]','{}','market')", [()] * 100)
    assert post(client, preview).status_code == 503
    monkeypatch.setattr(maintenance, "MAX_SECONDS", 15)
    assert client.get("/api/storage").json()["scan_rows"] == 102


def test_sqlite_writer_busy_is_retryable_and_releases_workspace_lock(client):
    scan(); scan()
    preview = client.get("/api/storage").json()
    writer = sqlite3.connect(store.db_path())
    try:
        writer.execute("BEGIN IMMEDIATE")
        assert post(client, preview).status_code == 503
    finally:
        writer.rollback(); writer.close()
    assert post(client, preview).status_code == 200
