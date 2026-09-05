import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from alphaview.panel import api, quality, store


@pytest.fixture
def workspace(tmp_path,monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'report-snapshots.db'))
    monkeypatch.setattr(quality,'latest_completed_session',lambda:'2024-01-05')
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('SYNTH','Synthetic',0,'test','test')")
        db.execute("INSERT INTO datasets(symbol,status,error,last_date) VALUES ('SYNTH','error','Old source failure','2024-01-04')")
        db.execute("INSERT INTO bars VALUES ('SYNTH','2024-01-04',100,101,99,100,100,1000)")


def test_quality_dataset_and_bars_are_one_snapshot_during_real_commit(workspace,monkeypatch):
    datasets=store.dataset_rows
    committed=[]
    def racing_datasets():
        result=datasets()
        if not committed:
            committed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("INSERT INTO bars VALUES ('SYNTH','2024-01-05',100,101,99,100,100,1000)")
                writer.execute("UPDATE datasets SET status='ok',error=NULL,last_date='2024-01-05'")
        return result
    monkeypatch.setattr(store,'dataset_rows',racing_datasets)
    before=quality.report()
    assert before['counts']['error']==1 and before['counts']['ok']==0
    assert before['items'][0]['last_date']=='2024-01-04'
    assert before['items'][0]['bars']==1
    assert before['items'][0]['reason']=='Old source failure'
    after=quality.report()
    assert after['counts']['ok']==1 and after['counts']['error']==0
    assert after['items'][0]['last_date']=='2024-01-05'
    assert after['items'][0]['bars']==2


def test_scan_context_cannot_mix_snapshot_and_later_membership(workspace,monkeypatch):
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('SYNTH','Synthetic','test','test',1)")
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES ('test','2024-01-05',?,'[]','market')",(json.dumps(['SYNTH']),))
    latest_scan=store.latest_scan
    committed=[]
    def racing_scan(*args,**kwargs):
        result=latest_scan(*args,**kwargs)
        if not committed:
            committed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("INSERT INTO market_universe VALUES ('OTHER','Synthetic other','test','test',1)")
                writer.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES ('later','2024-01-05',?,'[]','market')",(json.dumps(['SYNTH','OTHER']),))
        return result
    monkeypatch.setattr(store,'latest_scan',racing_scan)
    client=TestClient(api.app)
    before=client.get('/api/scans?scope=market').json()
    assert before['matches_current_universe']
    assert before['scan_member_count']==before['current_member_count']==1
    after=client.get('/api/scans?scope=market').json()
    assert after['matches_current_universe']
    assert after['scan_member_count']==after['current_member_count']==2
