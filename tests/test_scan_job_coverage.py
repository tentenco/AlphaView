import json
from unittest.mock import patch

import pytest

from alphaview.panel import jobs, research, sessions, store


@pytest.fixture
def workspace(tmp_path,monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'coverage.db'))
    store.init_db()
    days=sessions.expected_sessions('2024-01-02','2024-12-31')[-220:]
    monkeypatch.setattr(sessions,'latest_completed_session',lambda:days[-1])
    yield days
    if jobs.RUN_LOCK.locked():
        jobs.RUN_LOCK.release()


def add(symbol,days,market=False):
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,0,'test','test')",(symbol,symbol))
        if market:
            db.execute("INSERT INTO market_universe VALUES (?,?,'test','test',3e9)",(symbol,symbol))
        db.executemany('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)',[(symbol,day,100,101,99,100,100,1000) for day in days])


def run_job(kind='scan',scope='portfolio',symbols=None):
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope) VALUES ('test',?,'running','test',?)",(kind,scope))
    assert jobs.RUN_LOCK.acquire(False)
    jobs.worker('test',kind,scope,symbols)
    with store.connect() as db:
        row=dict(db.execute("SELECT * FROM jobs WHERE id='test'").fetchone())
    row['result']=json.loads(row['result'])
    return row


def test_missing_and_stale_are_partial_even_for_scan_only(workspace):
    add('CURRENT',workspace)
    add('MISSING',[])
    add('STALE',workspace[:-1])
    result=run_job()
    assert result['status']=='partial'
    scan=result['result']['scan']
    assert scan['coverage']==dict(total=3,current=1,missing=1,stale=1,data_error=0,unclosed=0,short_history=0)
    assert scan['missing_symbols']==['MISSING'] and scan['stale_symbols']==['STALE']
    assert '1 檔缺少行情' in result['progress'] and '1 檔行情過期' in result['progress']
    assert '0 檔更新失敗' in result['progress']


def test_whole_pool_lag_is_partial_despite_all_matching_snapshot_dates(workspace):
    add('A',workspace[:-1]);add('B',workspace[:-1])
    result=run_job()
    scan=result['result']['scan']
    assert result['status']=='partial'
    assert scan['as_of']==workspace[-2] and scan['expected_session']==workspace[-1]
    assert scan['scan_as_of_stale']
    assert scan['stale_symbols']==['A','B']
    # Preserve historical signal semantics; freshness describes the job coverage.
    assert all(signal['status']!='stale' for row in store.latest_scan()['result'] for signal in row['signals'])
    assert '選股日期落後' in result['progress']


def test_valid_recent_ipo_is_warmup_not_update_failure_or_partial(workspace):
    add('MATURE',workspace);add('IPO',workspace[-30:])
    result=run_job()
    assert result['status']=='completed'
    scan=result['result']['scan']
    assert scan['coverage']['current']==2 and scan['coverage']['short_history']==1
    assert scan['short_history_symbols']==['IPO']
    assert not scan['missing_symbols'] and not scan['stale_symbols']
    assert '並非更新失敗' in result['progress']
    assert '部分完成' not in result['progress']


def test_all_valid_history_is_complete(workspace):
    add('A',workspace)
    result=run_job()
    assert result['status']=='completed'
    assert result['result']['scan']['coverage']['current']==1
    assert result['result']['scan']['short_history_symbols']==[]


def test_retry_coverage_unions_scopes_without_double_counting(workspace):
    add('COMMON',workspace,market=True)
    add('MISSING',[],market=True)
    with patch.object(jobs.market,'refresh',return_value=[dict(symbol='COMMON',status='ok')]):
        result=run_job('retry','portfolio',['COMMON'])
    assert result['status']=='partial'
    assert set(result['result']['scans'])=={'portfolio','market'}
    assert '1 檔缺少行情' in result['progress']
    assert '2 檔缺少行情' not in result['progress']


def test_cancellation_wins_over_partial_terminal_classification(workspace):
    add('CURRENT',workspace);add('MISSING',[])
    scan=research.scan
    def cancel_after_scan(*args,**kwargs):
        result=scan(*args,**kwargs)
        jobs.cancel_job('test')
        return result
    with patch.object(jobs.research,'scan',side_effect=cancel_after_scan):
        result=run_job()
    assert result['status']=='cancelled'
    assert result['result']['scan']['coverage']['missing']==1
    assert result['error'] is None


def test_future_cache_never_publishes_future_snapshot_but_remains_diagnostic(workspace):
    add('FUTURE',workspace);add('CURRENT',workspace)
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('FUTURE','2025-01-02',999,1001,998,1000,1000,2000)")
    result=run_job()
    scan=result['result']['scan']
    assert result['status']=='partial'
    assert scan['as_of']==workspace[-1]
    assert scan['unclosed_symbols']==['FUTURE']
    assert scan['coverage']['unclosed']==1 and scan['coverage']['current']==1
    assert not scan['matched_symbols'] and not scan['scan_as_of_unclosed']
    with store.connect() as db:
        assert db.execute('SELECT MAX(as_of) FROM scans').fetchone()[0]==workspace[-1]
        assert db.execute("SELECT COUNT(*) FROM bars WHERE date='2025-01-02'").fetchone()[0]==1
    row=next(row for row in store.latest_scan()['result'] if row['symbol']=='FUTURE')
    assert row['date']==workspace[-1] and row['indicators']['close']==100
    assert '未完成交易日日線' in result['progress']


def test_only_future_history_fails_without_replacing_prior_complete_scan(workspace):
    add('A',workspace)
    research.scan()
    previous=store.latest_scan()
    with store.connect() as db:
        db.execute('DELETE FROM bars')
        db.execute("INSERT INTO bars VALUES ('A','2025-01-02',999,1001,998,1000,1000,2000)")
    result=run_job()
    assert result['status']=='failed'
    assert '未發布未收盤或未來日期' in result['error']
    assert store.latest_scan()==previous
