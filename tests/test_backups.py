import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import backups, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "panel.db"))
    monkeypatch.setattr(store, "ROOT", tmp_path)
    (tmp_path / "pyproject.toml").write_text('[project]\nversion="2.0.0"\n')
    store.init_db(); store.seed_portfolio()
    with store.connect() as db:
        db.execute("INSERT INTO research_notes VALUES ('NVDA','Saved research','[\"example\"]',1,?)", (store.now(),))
    return tmp_path


@pytest.fixture
def client(workspace):
    app = FastAPI(); app.include_router(backups.router)
    with TestClient(app) as client:
        yield client


def unpack(response):
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def test_download_is_complete_consistent_hashed_and_cleans_private_temps(client, workspace):
    source_before = store.positions()
    files = unpack(client.post('/api/backups', json={"preferences": {"universe_limit": 500}}))
    assert set(files) == {'alphaview.db', 'manifest.json', 'research-notes.json', 'browser-settings.json'}
    manifest = json.loads(files['manifest.json'])
    assert manifest['product'] == 'AlphaView' and manifest['app_version'] == '2.0.0'
    assert manifest['encrypted'] is False and manifest['restore_automatic'] is False
    assert manifest['table_counts']['positions'] == 7 and manifest['table_counts']['research_notes'] == 1
    for name, info in manifest['files'].items():
        assert hashlib.sha256(files[name]).hexdigest() == info['sha256']
        assert len(files[name]) == info['bytes']
    snapshot = workspace / 'verify.db'; snapshot.write_bytes(files['alphaview.db'])
    with sqlite3.connect(snapshot) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'
        note = db.execute('SELECT note,version FROM research_notes').fetchone()
        schema = [dict(zip(('type','name','tbl_name','sql'),row)) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    assert manifest['schema_sha256'] == hashlib.sha256(json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    notes = json.loads(files['research-notes.json'])['notes']
    assert (notes[0]['note'], notes[0]['version']) == note
    assert json.loads(files['browser-settings.json'])['preferences']['universe_limit'] == 500
    assert store.positions() == source_before
    assert list((workspace / 'artifacts').glob('alphaview-backup-*')) == []


def test_concurrent_wal_writer_does_not_mix_snapshot_tables(workspace, monkeypatch):
    original_connect = sqlite3.connect
    writer = original_connect(store.db_path())
    writer.execute("UPDATE positions SET shares=1,cost=1 WHERE symbol='NVDA'"); writer.commit()
    mutated = False
    class Source(sqlite3.Connection):
        def backup(self, destination, **kwargs):
            nonlocal mutated
            writer.execute("UPDATE positions SET shares=2 WHERE symbol='NVDA'")
            writer.execute("UPDATE research_notes SET note='New concurrent note',version=2")
            writer.commit(); mutated = True
            return super().backup(destination, **kwargs)
    def connect(database, *args, **kwargs):
        if kwargs.get('uri'):
            kwargs['factory'] = Source
        return original_connect(database, *args, **kwargs)
    monkeypatch.setattr(backups.sqlite3, 'connect', connect)
    try:
        folder, archive = backups.create_archive({})
        with original_connect(folder / 'alphaview.db') as snapshot:
            assert snapshot.execute("SELECT shares FROM positions WHERE symbol='NVDA'").fetchone()[0] == 1
            assert snapshot.execute("SELECT version FROM research_notes").fetchone()[0] == 1
        assert mutated and writer.execute("SELECT version FROM research_notes").fetchone()[0] == 2
        assert json.loads((folder/'research-notes.json').read_text())['notes'][0]['version'] == 1
        assert os.stat(folder).st_mode & 0o777 == 0o700
        assert all(os.stat(path).st_mode & 0o777 == 0o600 for path in folder.iterdir())
    finally:
        writer.close()
        if 'folder' in locals():
            backups.shutil.rmtree(folder)


def test_backup_includes_committed_uncheckpointed_wal(workspace):
    writer = sqlite3.connect(store.db_path())
    writer.execute('PRAGMA wal_autocheckpoint=0')
    writer.execute("UPDATE research_notes SET note='Only in committed WAL',version=3"); writer.commit()
    assert Path(str(store.db_path())+'-wal').stat().st_size > 0
    try:
        folder, archive = backups.create_archive({})
        with sqlite3.connect(folder/'alphaview.db') as snapshot:
            assert snapshot.execute('SELECT version FROM research_notes').fetchone()[0] == 3
    finally:
        writer.close()
        if 'folder' in locals(): backups.shutil.rmtree(folder)


def test_concurrent_backup_rejected_without_creating_files(client, workspace):
    assert backups.BACKUP_LOCK.acquire(blocking=False)
    try:
        assert client.post('/api/backups', json={}).status_code == 409
    finally:
        backups.BACKUP_LOCK.release()
    assert not (workspace/'artifacts').exists()


def test_deadline_failure_removes_temporary_files_and_unlocks(client, workspace, monkeypatch):
    monkeypatch.setattr(backups, 'DEADLINE_SECONDS', -1)
    assert client.post('/api/backups', json={}).status_code == 503
    assert list((workspace/'artifacts').iterdir()) == []
    assert not backups.BACKUP_LOCK.locked()


@pytest.mark.parametrize('preferences', [{'unknown': 'secret'}, {'universe_limit': 2000}, {'presets': 'all localStorage'}, {'presets': [{'version': 2, 'name': 'bad'}]}, {'presets': [None]}, {'presets': [dict(version=1,name='bad',settings={})]}])
def test_rejects_unknown_or_invalid_preferences(client, preferences):
    assert client.post('/api/backups', json={'preferences': preferences}).status_code == 422


def test_accepts_valid_presets_without_exporting_unrelated_storage(client):
    numeric = {key: '' for key in ('priceMin','priceMax','rsiMin','rsiMax','volumeMin','rpsMin','matchesMin')}
    preset = {'version':1,'name':'Trend','settings':{'scope':'market','strategy':'trend','only':True,'newOnly':True,'query':'','numeric':numeric,'sort':'rps','direction':'desc'}}
    files = unpack(client.post('/api/backups', json={'preferences':{'presets':[preset]}}))
    assert json.loads(files['browser-settings.json'])['preferences'] == {'presets':[preset]}
    bad = json.loads(json.dumps(preset)); bad['settings']['numeric']['rsiMin']='101'
    assert client.post('/api/backups', json={'preferences':{'presets':[bad]}}).status_code == 422


def test_missing_database_does_not_create_source(client, workspace, monkeypatch):
    path = workspace/'missing.db'; monkeypatch.setenv('PANEL_DB_PATH',str(path))
    assert client.post('/api/backups',json={}).status_code == 503
    assert not path.exists()
    assert list((workspace/'artifacts').iterdir()) == []


def test_no_arbitrary_paths_or_extra_payload_keys(client):
    assert client.post('/api/backups',json={'path':'/tmp/private.db'}).status_code == 422


@pytest.mark.parametrize('failure', ['send_error', 'cancelled', 'malformed_range', 'unsatisfiable_range'])
def test_response_cleans_on_send_failure_cancellation_and_range_errors(workspace, failure):
    import asyncio
    response = backups.download_backup(backups.BackupInput())
    folder = response.cleanup_folder
    assert folder.exists()
    headers = []
    if failure == 'malformed_range': headers = [(b'range', b'bytes=bad')]
    if failure == 'unsatisfiable_range': headers = [(b'range', b'bytes=999999999999-')]
    scope = {'type':'http', 'method':'POST', 'path':'/api/backups', 'headers':headers, 'extensions':{}}
    messages = []
    async def receive():
        return {'type':'http.request', 'body':b'', 'more_body':False}
    async def send(message):
        if failure == 'send_error': raise OSError('client disconnected')
        if failure == 'cancelled': raise asyncio.CancelledError()
        messages.append(message)
    if failure in {'send_error','cancelled'}:
        with pytest.raises(OSError if failure == 'send_error' else asyncio.CancelledError):
            asyncio.run(response(scope, receive, send))
    else:
        asyncio.run(response(scope, receive, send))
        assert messages[0]['status'] == (400 if failure == 'malformed_range' else 416)
    assert not folder.exists()
    assert not backups.BACKUP_LOCK.locked()
