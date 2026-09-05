"""Independent boundary and snapshot checks for portfolio-risk diagnostics."""
from contextlib import contextmanager
import json

import numpy as np
import pytest

from alphaview.panel import risk, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'risk-audit.db'))
    store.init_db()
    days = sessions.expected_sessions('2024-01-02', '2024-12-31')[-61:]
    monkeypatch.setattr(risk.sessions, 'latest_completed_session', lambda: days[-1])
    return days


def seed(days, symbol, drop=(), adjusted=None):
    prices = 100 * np.cumprod(1 + np.sin(np.arange(len(days))) * .01)
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,1,'test','test')", (symbol,symbol))
        db.executemany('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)', [
            (symbol, day, price, price, price, price, price if adjusted is None else adjusted[i], 100.)
            for i,(day,price) in enumerate(zip(days,prices)) if i not in drop])
    return prices


def pair(report):
    return next(row for row in report['pairs'] if row['left']=='A' and row['right']=='B')


@pytest.mark.parametrize('last_missing,observations,defined', [(48,40,True),(49,39,False)])
def test_pairwise_threshold_uses_intersection_not_each_stock_count(workspace, last_missing, observations, defined):
    # Each contiguous nine-day absence removes ten returns. Disjoint missing
    # segments leave exactly40 common returns; one extra missing date leaves39.
    seed(workspace,'A',drop=range(10,19))
    seed(workspace,'B',drop=range(40,last_missing+1))
    result=risk.report()
    assert min(row['return_count'] for row in result['holdings']) >= 49
    shared=pair(result)
    assert shared['observations']==observations
    assert (shared['correlation'] is not None)==defined
    if defined:
        assert shared['correlation']==pytest.approx(1)


def test_subnormal_adjusted_prices_preserve_defined_returns(workspace):
    # Absolute price scale is irrelevant: these represent alternating +100%/-50%.
    adjusted=[1e-320 if i%2 else 2e-320 for i in range(len(workspace))]
    seed(workspace,'A',adjusted=adjusted)
    seed(workspace,'B',adjusted=[1. if i%2 else 2. for i in range(len(workspace))])
    result=risk.report()
    assert pair(result)['observations']==60
    assert pair(result)['correlation']==pytest.approx(1)
    json.dumps(result,allow_nan=False)


def test_unrepresentable_returns_are_excluded_without_nonfinite_json(workspace):
    seed(workspace,'A',adjusted=[1e-300 if i%2 else 1e300 for i in range(len(workspace))])
    seed(workspace,'B')
    result=risk.report()
    assert pair(result)['observations']==30
    assert pair(result)['correlation'] is None
    json.dumps(result,allow_nan=False)


def test_holdings_and_quotes_share_one_sqlite_snapshot(workspace, monkeypatch):
    seed(workspace,'A')
    prices=seed(workspace,'B')
    original_connect=store.connect
    committed=[]
    @contextmanager
    def concurrent_connect():
        with original_connect() as db:
            def trace(sql):
                if sql.startswith('SELECT * FROM bars WHERE') and not committed:
                    committed.append(True)
                    # Commit another client's price/position update after this
                    # report has already read positions and established snapshot.
                    with original_connect() as writer:
                        writer.execute("UPDATE positions SET shares=9 WHERE symbol='B'")
                        writer.execute("UPDATE bars SET open=999,high=999,low=999,close=999,adj_close=999 WHERE symbol='B' AND date=?",(workspace[-1],))
            db.set_trace_callback(trace)
            yield db
    monkeypatch.setattr(store,'connect',concurrent_connect)
    result=risk.report()
    assert committed
    b=next(row for row in result['holdings'] if row['symbol']=='B')
    assert b['market_value']==pytest.approx(prices[-1])
    assert b['weight_pct']==pytest.approx(50)
    assert pair(result)['correlation']==pytest.approx(1)
    with original_connect() as db:
        assert db.execute("SELECT shares FROM positions WHERE symbol='B'").fetchone()[0]==9


def test_exclusive_sqlite_lock_returns_retryable_503(workspace):
    import sqlite3
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app=FastAPI()
    app.include_router(risk.router)
    lock=sqlite3.connect(store.db_path())
    try:
        lock.execute('PRAGMA locking_mode=EXCLUSIVE')
        lock.execute('BEGIN EXCLUSIVE')
        lock.execute('SELECT COUNT(*) FROM positions').fetchone()
        with TestClient(app,raise_server_exceptions=False) as client:
            response=client.get('/api/portfolio/risk')
        assert response.status_code==503
        assert '稍後重試' in response.json()['detail']
    finally:
        lock.rollback()
        lock.close()
    # The read-only endpoint recovers normally once the owning connection exits.
    assert risk.report()['holding_count']==0


@pytest.mark.parametrize('code,message,retryable', [
    (517,'snapshot conflict',True),  # SQLITE_BUSY_SNAPSHOT
    (262,'shared cache conflict',True),  # SQLITE_LOCKED_SHAREDCACHE
    (None,'database is locked',True),
    (1,'database is locked',False),  # Known non-contention code must not be hidden.
    (None,'no such table: positions',False),
])
def test_extended_sqlite_codes_and_conservative_fallback(workspace, monkeypatch, code, message, retryable):
    import sqlite3
    error=sqlite3.OperationalError(message)
    if code is not None:
        error.sqlite_errorcode=code
    @contextmanager
    def failed_connection():
        raise error
        yield
    monkeypatch.setattr(store,'connect',failed_connection)
    with pytest.raises(risk.HTTPException if retryable else sqlite3.OperationalError) as caught:
        risk.report()
    if retryable:
        assert caught.value.status_code==503
