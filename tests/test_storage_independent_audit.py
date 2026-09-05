"""Independent storage retention, transaction rollback and reader snapshot checks."""
import sqlite3

import pytest
from fastapi import HTTPException

from alphaview.panel import storage_maintenance as maintenance, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'storage-audit.db'))
    store.init_db()


def insert(scope, day, created='same timestamp'):
    with store.connect() as db:
        return db.execute('INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES (?,?,?, ?,?)',
                          (created,day,'["SYNTH"]','[]',scope)).lastrowid


def cleanup():
    return maintenance.cleanup(maintenance.CleanupInput(expected_fingerprint=maintenance.preview()['fingerprint'],confirm=True))


def ids():
    with store.connect() as db:
        return [row[0] for row in db.execute('SELECT id FROM scans ORDER BY id')]


def test_retention_matches_reader_ids_even_when_clock_moves_backwards(workspace):
    first=insert('market','2024-01-02','2099-01-01')
    second=insert('market','2024-01-02','2000-01-01')
    portfolio=insert('portfolio','2024-01-02','2000-01-01')
    other_day=insert('market','2024-01-03','1999-01-01')
    latest=store.latest_scan('2024-01-02','market')
    assert latest['id']==second
    result=cleanup()
    assert result['deleted_rows']==1
    assert ids()==[second,portfolio,other_day]
    assert first not in ids()
    assert store.latest_scan('2024-01-02','market')==latest


def test_unicode_identity_is_not_normalized_or_cross_deleted(workspace):
    # Unknown legacy identities must remain exact, including canonical-looking
    # Unicode sequences: visually similar names are not proof of the same scope.
    scopes=['市場','市场','é','e\u0301','market','market ']
    retained=[]
    for scope in scopes:
        insert(scope,'2024-01-02')
        retained.append(insert(scope,'2024-01-02'))
    assert cleanup()['deleted_rows']==len(scopes)
    assert ids()==retained


@pytest.mark.parametrize('scope,day',[(None,'2024-01-02'),('market',None)])
def test_unknown_null_identity_rejected_by_current_schema(workspace,scope,day):
    with pytest.raises(sqlite3.IntegrityError):
        insert(scope,day)
    assert ids()==[]


def test_open_reader_keeps_precleanup_snapshot_while_new_readers_see_retained(workspace):
    old=insert('market','2024-01-02')
    newest=insert('market','2024-01-02')
    reader=sqlite3.connect(store.db_path())
    try:
        reader.execute('BEGIN')
        before=reader.execute('SELECT id FROM scans ORDER BY id').fetchall()
        assert before==[(old,),(newest,)]
        assert cleanup()['deleted_rows']==1
        assert reader.execute('SELECT id FROM scans ORDER BY id').fetchall()==before
        assert ids()==[newest]
    finally:
        reader.rollback();reader.close()


def test_failure_after_all_deletes_rolls_back_and_releases_lock(workspace,monkeypatch):
    insert('market','2024-01-02');insert('market','2024-01-02')
    before=ids()
    fingerprint=maintenance.preview()['fingerprint']
    snapshot=maintenance._snapshot
    calls=[]
    def fail_after_deletes(db):
        calls.append(True)
        if len(calls)==2:
            assert db.execute('SELECT COUNT(*) FROM scans').fetchone()[0]==1
            raise HTTPException(503,'Synthetic post-delete failure')
        return snapshot(db)
    monkeypatch.setattr(maintenance,'_snapshot',fail_after_deletes)
    with pytest.raises(HTTPException) as caught:
        maintenance.cleanup(maintenance.CleanupInput(expected_fingerprint=fingerprint,confirm=True))
    assert caught.value.status_code==503
    assert ids()==before
    assert maintenance.RUN_LOCK.acquire(False)
    maintenance.RUN_LOCK.release()
