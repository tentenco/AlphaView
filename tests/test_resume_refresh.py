import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import jobs, market, sessions, store


@pytest.fixture
def workspace(tmp_path,monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'resume.db'))
    store.init_db()
    days=sessions.expected_sessions('2026-01-02','2026-09-04')[-130:]
    monkeypatch.setattr(market,'latest_completed_session',lambda:days[-1])
    monkeypatch.setattr(sessions,'latest_completed_session',lambda:days[-1])
    yield days
    if jobs.RUN_LOCK.locked():jobs.RUN_LOCK.release()


def add(symbol,days,*,scope='portfolio',status='ok',currency='USD',name=None,exchange='NMS',error=None):
    with store.connect() as db:
        if scope=='portfolio':
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,0,'test','test')",(symbol,'Synthetic '+symbol))
        else:
            db.execute("INSERT INTO market_universe VALUES (?,?,'test','test',3e9)",(symbol,'Synthetic '+symbol))
        db.executemany('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)',[(symbol,day,100,101,99,100,100,1000) for day in days])
        db.execute("INSERT INTO datasets(symbol,name,currency,exchange,fetched_at,last_date,bar_count,status,error) VALUES (?,?,?,?,?,?,?,?,?)",
                   (symbol,name if name is not None else 'Synthetic '+symbol,currency,exchange,store.now(),days[-1] if days else None,len(days),status,error))


def run_job(kind='resume',scope='portfolio'):
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope) VALUES ('job',?,'running','test',?)",(kind,scope))
    assert jobs.RUN_LOCK.acquire(False)
    jobs.worker('job',kind,scope)
    with store.connect() as db:result=dict(db.execute("SELECT * FROM jobs WHERE id='job'").fetchone())
    result['result']=json.loads(result['result'])
    return result


def test_source_success_followed_by_scan_failure_resumes_without_download(workspace):
    add('A',workspace)
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,error) VALUES ('prior','refresh','failed','old','scan failed')")
    with patch.object(market,'fetch_symbol') as fetch:
        result=run_job()
    fetch.assert_not_called()
    assert result['status']=='completed'
    assert result['result']['resume']['skipped']==1
    assert result['result']['resume']['downloaded']==0
    assert result['result']['scan']['symbols']==1
    assert store.latest_scan() is not None
    assert '續跑保留 1 檔' in result['progress']


@pytest.mark.parametrize('change', ['error','currency','fallback_name','exchange','source','count','gap','future','stale'])
def test_only_successful_identified_complete_cache_can_skip(workspace,change):
    add('A',workspace)
    with store.connect() as db:
        if change=='error':db.execute("UPDATE datasets SET status='error',error='last source failed'")
        if change=='currency':db.execute("UPDATE datasets SET currency='EUR'")
        if change=='fallback_name':db.execute("UPDATE datasets SET name='A'")
        if change=='exchange':db.execute("UPDATE datasets SET exchange=NULL")
        if change=='source':db.execute("UPDATE datasets SET source='unknown'")
        if change=='count':db.execute('UPDATE datasets SET bar_count=1')
        if change=='gap':
            db.execute('DELETE FROM bars WHERE date=?',(workspace[-5],));db.execute('UPDATE datasets SET bar_count=bar_count-1')
        if change=='future':
            db.execute("INSERT INTO bars VALUES ('A','2026-09-08',100,101,99,100,100,1000)")
            db.execute('UPDATE datasets SET bar_count=bar_count+1')
        if change=='stale':
            db.execute('DELETE FROM bars WHERE date=?',(workspace[-1],))
            db.execute('UPDATE datasets SET bar_count=bar_count-1,last_date=?',(workspace[-2],))
    with patch.object(market,'fetch_symbol',return_value=dict(symbol='A',rows=130,last_date=workspace[-1])) as fetch:
        result=market.resume_refresh()
    fetch.assert_called_once_with('A')
    assert result['resume']['skipped']==0 and result['resume']['downloaded']==1
    assert result['market'][0]['action']=='downloaded'


def test_valid_short_ipo_is_cached_without_demanding_longer_history(workspace):
    add('IPO',workspace[-15:])
    with patch.object(market,'fetch_symbol') as fetch:
        result=run_job()
    fetch.assert_not_called()
    assert result['status']=='completed'
    assert result['result']['resume']['skipped']==1
    assert result['result']['scan']['short_history_symbols']==['IPO']


def test_error_with_current_valid_bars_is_retried_once_and_remains_partial_on_failure(workspace):
    add('A',workspace,status='error',error='previous failure')
    with patch.object(market,'fetch_symbol',side_effect=ValueError('still unavailable')) as fetch:
        result=run_job()
    fetch.assert_called_once_with('A')
    assert result['status']=='partial'
    assert result['result']['resume']['failed']==1
    assert result['result']['resume']['skipped']==0
    assert len(store.history('A'))==len(workspace)


def test_resume_uses_current_membership_and_never_rediscovers(workspace):
    add('CURRENT',workspace,scope='market')
    add('OLD',workspace)
    before=store.universe('market')
    with patch.object(market,'discover_universe') as discovery,patch.object(market,'fetch_symbol') as fetch:
        result=run_job(scope='market')
    discovery.assert_not_called();fetch.assert_not_called()
    assert result['result']['resume']['total']==1
    assert [row['symbol'] for row in result['result']['market']]==['CURRENT']
    assert store.universe('market')==before


@pytest.mark.parametrize('name,days_from', [('Old SPCX ETF',-30),('Space Exploration Technologies',0)])
def test_spcx_identity_or_pre_listing_history_never_skips(workspace,name,days_from):
    add('SPCX',workspace[days_from:],name=name)
    with patch.object(market,'fetch_symbol',side_effect=ValueError('identity pending')) as fetch:
        result=market.resume_refresh()
    fetch.assert_called_once_with('SPCX')
    assert result['resume']['failed']==1 and result['resume']['skipped']==0


def test_skip_loop_observes_cancel_and_retains_observed_counts(workspace):
    add('A',workspace);add('B',workspace)
    def progress(message):
        jobs.cancel_job('job')
    original=market.resume_refresh
    def resume(*args,**kwargs):
        return original(progress,**kwargs)
    with patch.object(market,'resume_refresh',side_effect=resume),patch.object(market,'fetch_symbol') as fetch:
        result=run_job()
    fetch.assert_not_called()
    assert result['status']=='cancelled'
    assert result['result']['resume']['skipped']==1
    assert store.latest_scan() is None


def test_api_accepts_resume_but_disallows_discovery_limit_or_symbol_list(workspace):
    app=FastAPI();app.include_router(jobs.router)
    client=TestClient(app)
    assert client.post('/api/jobs',json=dict(kind='resume',scope='market',universe_limit=500)).status_code==422
    assert client.post('/api/jobs',json=dict(kind='resume',symbols=['A'])).status_code==422
    with patch.object(jobs,'launch_locked',side_effect=lambda *args: jobs.RUN_LOCK.release()):
        assert client.post('/api/jobs',json=dict(kind='resume',scope='portfolio')).status_code==202


def test_cancel_during_download_stops_pending_fetch_and_keeps_counts(workspace):
    add('A',workspace,status='error');add('B',workspace,status='error')
    calls=[]
    def fetch(symbol):
        calls.append(symbol)
        jobs.cancel_job('job')
        return dict(symbol=symbol,rows=len(workspace),last_date=workspace[-1])
    with patch.object(market,'fetch_symbol',side_effect=fetch):
        result=run_job()
    assert calls==['A']
    assert result['status']=='cancelled'
    assert result['result']['resume']['counts_complete'] is False
    assert result['result']['resume']['processed']<=1
    assert store.latest_scan() is None


def test_downloaded_shared_symbol_rescans_both_scopes(workspace):
    add('A',workspace,status='error')
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('A','Synthetic A','test','test',3e9)")
    def fetch(symbol):
        with store.connect() as db:db.execute("UPDATE datasets SET status='ok',error=NULL WHERE symbol=?",(symbol,))
        return dict(symbol=symbol,rows=len(workspace),last_date=workspace[-1])
    with patch.object(market,'fetch_symbol',side_effect=fetch):
        result=run_job()
    assert result['status']=='completed'
    assert set(result['result']['scans'])=={'portfolio','market'}
    assert result['result']['resume']['downloaded']==1
    assert result['result']['resume']['counts_complete'] is True


def test_cancellation_after_resume_before_scan_publication_still_wins(workspace):
    add('A',workspace)
    scan=jobs.research.scan
    def cancel_scan(*args,**kwargs):
        jobs.cancel_job('job')
        return scan(*args,**kwargs)
    with patch.object(jobs.research,'scan',side_effect=cancel_scan),patch.object(market,'fetch_symbol') as fetch:
        result=run_job()
    fetch.assert_not_called()
    assert result['status']=='cancelled'
    assert result['result']['resume']['skipped']==1
    assert store.latest_scan() is None
