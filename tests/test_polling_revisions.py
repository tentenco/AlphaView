import pytest
from fastapi.testclient import TestClient
from alphaview.panel import api, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'panel.db'))
    with TestClient(api.app) as client:
        store.seed_portfolio()
        yield client


def test_revision_migration_is_idempotent_and_status_does_not_load_market_data(client, monkeypatch):
    before = client.get('/api/status').json()
    store.init_db()
    assert client.get('/api/status').json() == before
    monkeypatch.setattr(api, 'enriched_positions', lambda *args: pytest.fail('status loaded positions'))
    assert client.get('/api/status').json() == before
    with store.connect() as db:
        triggers = db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_%'").fetchall()
        assert len(triggers) == 21


@pytest.mark.parametrize('table,insert,values', [
    ('positions', 'symbol,name,source,updated_at', ('ZZZ','Test','test','same-time')),
    ('bars', 'symbol,date,open,high,low,close,adj_close,volume', ('ZZZ','2026-09-04',1,1,1,1,1,1)),
    ('datasets', 'symbol', ('ZZZ',)),
    ('scans', 'created_at,as_of,universe,result', ('same-time','2026-09-04','[]','[]')),
    ('market_universe', 'symbol,name,source,discovered_at', ('ZZZ','Test','test','same-time')),
    ('market_universe_metadata', 'id,requested_limit,raw_count,accepted_count,pages,discovered_at', (1,250,1,1,1,'same-time')),
])
def test_each_overview_table_insert_update_delete_changes_revision_even_same_timestamp(client, table, insert, values):
    def revision():
        return client.get('/api/status').json()['revision']
    first = revision()
    with store.connect() as db:
        db.execute(f'INSERT INTO {table}({insert}) VALUES({",".join("?" for _ in values)})', values)
    second = revision()
    assert second != first
    field = insert.split(',')[0]
    with store.connect() as db:
        db.execute(f'UPDATE {table} SET {field}={field}')
    third = revision()
    assert third != second
    with store.connect() as db:
        db.execute(f'DELETE FROM {table}')
    assert revision() != third


def test_job_only_progress_is_lightweight_and_rollback_does_not_change_revision(client):
    before = client.get('/api/status').json()
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('test','scan','running','same-time','first')")
    started = client.get('/api/status').json()
    assert started['revision'] == before['revision']
    assert started['jobs_revision'] != before['jobs_revision']
    with store.connect() as db:
        db.execute("UPDATE jobs SET progress='second' WHERE id='test'")
    progressed = client.get('/api/status').json()
    assert progressed['revision'] == before['revision']
    assert progressed['jobs_revision'] != started['jobs_revision']
    assert progressed['jobs'][0]['progress'] == 'second'
    with pytest.raises(RuntimeError):
        with store.connect() as db:
            db.execute("UPDATE positions SET name='uncommitted'")
            raise RuntimeError('rollback')
    assert client.get('/api/status').json() == progressed


def test_overview_revision_and_data_share_snapshot_across_concurrent_write(client, monkeypatch):
    original = api.enriched_positions
    before = client.get('/api/status').json()
    def read_then_write(*args):
        items = original(*args)
        # A separate thread avoids inheriting the snapshot's query-only connection.
        from concurrent.futures import ThreadPoolExecutor
        def write():
            with store.connect() as db:
                db.execute("UPDATE positions SET name='Concurrent writer' WHERE symbol='AAPL'")
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(write).result()
        return items
    monkeypatch.setattr(api, 'enriched_positions', read_then_write)
    result = client.get('/api/overview').json()
    assert result['revision'] == before['revision']
    assert next(p for p in result['positions'] if p['symbol'] == 'AAPL')['name'] != 'Concurrent writer'
    assert client.get('/api/status').json()['revision'] != result['revision']


def test_expected_session_rollover_invalidates_unchanged_database(client, monkeypatch):
    monkeypatch.setattr(api.sessions, 'latest_completed_session', lambda: '2026-09-03')
    before = client.get('/api/status').json()
    monkeypatch.setattr(api.sessions, 'latest_completed_session', lambda: '2026-09-04')
    after = client.get('/api/status').json()
    assert before['revision'] != after['revision']
    assert before['jobs_revision'] == after['jobs_revision']


def test_existing_database_migrates_without_losing_data(client):
    with store.connect() as db:
        original = [tuple(row) for row in db.execute('SELECT * FROM positions ORDER BY symbol')]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_%'").fetchall():
            db.execute(f'DROP TRIGGER {row["name"]}')
        db.execute('DROP TABLE panel_revisions')
    store.init_db()
    with store.connect() as db:
        assert [tuple(row) for row in db.execute('SELECT * FROM positions ORDER BY symbol')] == original
    before = client.get('/api/status').json()['revision']
    with store.connect() as db:
        db.execute("UPDATE positions SET name=name WHERE symbol='AAPL'")
    assert client.get('/api/status').json()['revision'] != before
