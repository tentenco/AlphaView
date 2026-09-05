import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from fastapi.testclient import TestClient

from alphaview.panel import api, sessions, store


@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'temporal.db'))
    monkeypatch.setattr(sessions,'latest_completed_session',lambda:'2024-01-05')
    store.init_db()
    with store.connect() as db:
        for symbol in ('A','B'):
            db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES (?,?,1,90,'test','test')",(symbol,symbol))
            for day in ('2024-01-04','2024-01-05'):
                db.execute('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)',(symbol,day,100,101,99,100,100,1000))
    return TestClient(api.app)


def test_future_cached_latest_is_unavailable_without_older_fallback(client):
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('A','2024-01-08',1000,1001,999,1000,1000,1000)")
    result=client.get('/api/overview').json()
    position=result['positions'][0]
    assert position['quote_status']=='unavailable'
    assert position['price'] is None and position['market_value'] is None
    assert position['price_date']=='2024-01-08'
    assert position['expected_session']=='2024-01-05'
    assert position['sparkline'][-1]['close'] is None
    assert result['summary']['priced_count']==1 and result['summary']['partial']
    detail=client.get('/api/stocks/A').json()
    assert detail['position']['price'] is None
    assert max(point['date'] for point in detail['history'])=='2024-01-05'
    json.dumps(detail,allow_nan=False)


def test_stale_valid_close_is_visible_but_not_current_daily_change(client):
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE date='2024-01-05'")
        for symbol in ('A','B'):
            db.execute('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)',(symbol,'2024-01-03',90,91,89,90,90,1000))
    result=client.get('/api/overview').json()
    assert all(p['quote_status']=='stale' and p['price']==100 and p['change'] is None for p in result['positions'])
    summary=result['summary']
    assert summary['market_value']==200 and summary['priced_count']==2
    assert summary['stale_count']==2 and summary['current_priced_count']==0
    assert summary['partial'] and summary['day_change_partial']
    assert summary['day_change'] is None


def test_historical_weekend_target_and_uncompleted_future_rejection(client):
    historical=client.get('/api/stocks/A?as_of=2024-01-06')
    assert historical.status_code==200
    position=historical.json()['position']
    assert position['expected_session']=='2024-01-05'
    assert position['quote_status']=='ok' and position['price']==100
    earlier=client.get('/api/stocks/A?as_of=2024-01-04').json()['position']
    assert earlier['expected_session']=='2024-01-04' and earlier['quote_status']=='partial'
    assert client.get('/api/stocks/A?as_of=2024-01-08').status_code==422
    assert client.get('/api/stocks/A?as_of=2099-01-01').status_code==422


def test_overview_cannot_tear_across_committed_price_update(client,monkeypatch):
    history=store.history;committed=[]
    def racing_history(symbol):
        result=history(symbol)
        if not committed:
            committed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("UPDATE bars SET open=200,high=201,low=199,close=200,adj_close=200 WHERE date='2024-01-05'")
        return result
    monkeypatch.setattr(store,'history',racing_history)
    result=client.get('/api/overview').json()
    assert result['summary']['market_value']==200
    assert result['summary']['day_change']==0
    assert not result['summary']['partial']
    assert client.get('/api/overview').json()['summary']['market_value']==400


def test_read_scope_does_not_escape_to_worker_or_later_writes(client):
    def change():
        with store.connect() as writer:
            writer.execute("UPDATE positions SET shares=2")
    with store.read_snapshot():
        assert all(p['shares']==1 for p in store.positions())
        with pytest.raises(sqlite3.OperationalError,match='readonly'):
            with store.connect() as reader:
                reader.execute('UPDATE positions SET shares=99')
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(change).result(timeout=5)
        assert all(p['shares']==1 for p in store.positions())
    assert all(p['shares']==2 for p in store.positions())
    change()  # Thread-local read scope was removed and writes remain usable.


def test_stock_detail_reuses_same_snapshot_for_position_and_chart(client,monkeypatch):
    history=store.history;committed=[]
    def racing_history(symbol):
        result=history(symbol)
        if not committed:
            committed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute('UPDATE positions SET shares=2')
                writer.execute("UPDATE bars SET open=200,high=201,low=199,close=200,adj_close=200 WHERE date='2024-01-05'")
        return result
    monkeypatch.setattr(store,'history',racing_history)
    result=client.get('/api/stocks/A').json()
    assert result['position']['shares']==1
    assert result['position']['price']==100
    assert result['position']['market_value']==100
    assert result['history'][-1]['close']==100


def test_weekend_stock_uses_matching_prior_session_scan(client):
    row=dict(symbol='A',name='A',date='2024-01-05',signals=[])
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES ('test','2024-01-05','[\"A\"]',?,'portfolio')",(json.dumps([row]),))
    result=client.get('/api/stocks/A?as_of=2024-01-06').json()
    assert result['position']['research']==row
    assert client.get('/api/stocks/A?as_of=0001-01-01').status_code==422


def test_allocation_requires_all_holdings_on_current_session(client):
    current=client.get('/api/overview').json()
    assert [p['weight'] for p in current['positions']]==[50,50]
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='B' AND date='2024-01-05'")
    mixed=client.get('/api/overview').json()
    assert mixed['summary']['mixed_dates']
    assert all(p['weight'] is None for p in mixed['positions'])
    assert all(p['market_value']==100 for p in mixed['positions'])
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='A' AND date='2024-01-05'")
    stale=client.get('/api/overview').json()
    assert all(p['weight'] is None for p in stale['positions'])


def test_missing_daily_change_does_not_hide_current_allocation(client):
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE date='2024-01-04'")
    result=client.get('/api/overview').json()
    assert result['summary']['day_change_partial']
    assert all(p['quote_status']=='partial' and p['weight']==50 for p in result['positions'])
