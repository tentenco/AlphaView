import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import comparison, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'comparison.db'))
    store.init_db()
    dates = sessions.expected_sessions('2023-01-01', '2024-12-31')[-253:]
    monkeypatch.setattr(comparison.sessions, 'latest_completed_session', lambda: dates[-1])
    return dates


def add(dates, symbol, *, drop=(), market=False):
    with store.connect() as db:
        if market:
            db.execute('INSERT INTO market_universe(symbol,name,source,discovered_at) VALUES (?,?,?,?)', (symbol, symbol+' company', 'test', store.now()))
        else:
            db.execute('INSERT INTO positions(symbol,name,source,updated_at) VALUES (?,?,?,?)', (symbol, symbol+' company', 'test', store.now()))
        rows = [(symbol, day, 100+i, 101+i, 99+i, 100+i, 100+i, 1000) for i, day in enumerate(dates) if i not in drop]
        db.executemany('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)', rows)
        db.execute('INSERT INTO datasets(symbol,name,currency,exchange,last_date,bar_count,status) VALUES (?,?,?,?,?,?,?)', (symbol, symbol+' company', 'USD', 'NMS', dates[-1], len(rows), 'ok'))


def test_same_anchor_all_windows_and_union_membership(workspace):
    add(workspace, 'AAA')
    add(workspace, 'BBB', market=True)
    for window in (60, 120, 252):
        result = comparison.report(['AAA', 'BBB'], window)
        assert result['complete'] and result['status'] == 'ready'
        assert result['expected_prices'] == window+1
        assert result['anchor_date'] == workspace[-window-1]
        assert result['input_revision'] == store.input_revision()
        for row in result['series']:
            assert [p['date'] for p in row['points']] == result['dates']
            assert row['points'][0]['return_pct'] == 0
            assert row['return_pct'] == pytest.approx((352/(352-window)-1)*100)
        json.dumps(result, allow_nan=False)


@pytest.mark.parametrize('kind', ['gap', 'ipo', 'invalid', 'stale', 'currency', 'identity', 'source', 'error', 'count', 'future', 'weekend'])
def test_unavailable_never_shortens_or_bridges(workspace, kind):
    add(workspace, 'AAA')
    add(workspace[-40:] if kind == 'ipo' else workspace, 'BBB', drop=(240,) if kind == 'gap' else ())
    with store.connect() as db:
        updates = {'invalid': ('UPDATE bars SET adj_close=0 WHERE symbol=? AND date=?', ('BBB', workspace[-8])),
                   'stale': ("UPDATE datasets SET last_date='2024-12-30' WHERE symbol=?", ('BBB',)),
                   'currency': ("UPDATE datasets SET currency='EUR' WHERE symbol=?", ('BBB',)),
                   'identity': ("UPDATE datasets SET name='BBB' WHERE symbol=?", ('BBB',)),
                   'source': ("UPDATE datasets SET source='other' WHERE symbol=?", ('BBB',)),
                   'error': ("UPDATE datasets SET error='failed' WHERE symbol=?", ('BBB',)),
                   'count': ("UPDATE datasets SET bar_count=1 WHERE symbol=?", ('BBB',))}
        if kind in updates:
            db.execute(*updates[kind])
        if kind in ('future', 'weekend'):
            day = '2025-01-02' if kind == 'future' else '2024-12-28'
            db.execute('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)', ('BBB', day, 100, 101, 99, 100, 100, 100))
            db.execute('UPDATE datasets SET bar_count=bar_count+1 WHERE symbol=?', ('BBB',))
    result = comparison.report(['AAA', 'BBB'])
    assert result['status'] == 'insufficient' and not result['complete']
    bad = result['series'][1]
    assert not bad['eligible'] and bad['reason'] and bad['points'] == []
    assert bad['return_pct'] is bad['anchor_price'] is bad['latest_price'] is None
    assert result['anchor_date'] == workspace[-61]


def test_missing_metadata_and_overflow_are_finite(workspace):
    add(workspace, 'AAA')
    add(workspace, 'BBB')
    with store.connect() as db:
        db.execute('UPDATE bars SET adj_close=1e-300 WHERE symbol=? AND date=?', ('AAA', workspace[-61]))
        db.execute('UPDATE bars SET adj_close=1e300 WHERE symbol=? AND date=?', ('AAA', workspace[-1]))
        db.execute('DELETE FROM datasets WHERE symbol=?', ('BBB',))
    result = comparison.report(['AAA', 'BBB'])
    assert result['eligible_count'] == 0
    assert '範圍' in result['series'][0]['reason']
    assert result['series'][1]['source'] is None
    json.dumps(result, allow_nan=False)


def test_api_bounds_and_no_writes(workspace):
    add(workspace, 'AAA')
    add(workspace, 'BBB')
    app = FastAPI()
    app.include_router(comparison.router)
    revision = store.input_revision()
    with TestClient(app) as client:
        for query in ('symbols=AAA', 'symbols=AAA,AAA', 'symbols=AAA,UNKNOWN', 'symbols=AAA,BBB&window=61', 'symbols=A,B,C,D,E,F', 'symbols=AAA,%25'):
            assert client.get('/api/comparison?'+query).status_code == 422
        assert client.get('/api/comparison?symbols=aaa,bbb').status_code == 200
    assert store.input_revision() == revision


def test_read_snapshot_pins_members_metadata_and_bars(workspace, monkeypatch):
    add(workspace, 'AAA')
    add(workspace, 'BBB')
    old_revision = store.input_revision()
    original = comparison.metadata_reason
    changed = False
    def concurrent(*args):
        nonlocal changed
        if not changed:
            import sqlite3
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("UPDATE bars SET adj_close=adj_close*2 WHERE symbol='BBB'")
                writer.execute("UPDATE datasets SET status='error' WHERE symbol='BBB'")
            changed = True
        return original(*args)
    monkeypatch.setattr(comparison, 'metadata_reason', concurrent)
    result = comparison.report(['AAA', 'BBB'])
    assert result['complete'] and result['input_revision'] == old_revision
    assert result['series'][0]['points'] == result['series'][1]['points']
    assert store.input_revision() != old_revision


def test_timeout(workspace, monkeypatch):
    add(workspace, 'AAA')
    add(workspace, 'BBB')
    monkeypatch.setattr(comparison, 'MAX_SECONDS', -1)
    with pytest.raises(Exception) as error:
        comparison.report(['AAA', 'BBB'])
    assert error.value.status_code == 503


def test_comparison_engine_bump_refreshes_poll_without_invalidating_scans(workspace, monkeypatch):
    from alphaview.panel import api, scan_provenance
    before = api.research_revision(workspace[-1])
    scan_token = scan_provenance.current_token()
    monkeypatch.setattr(comparison, 'COMPARISON_ENGINE_VERSION', 'alphaview-comparison-v2')
    assert api.research_revision(workspace[-1]) != before
    assert scan_provenance.current_token() == scan_token


def test_spcx_identity_is_not_substituted_by_old_etf(workspace):
    add(workspace, 'AAA')
    add(workspace, 'SPCX')
    result = comparison.report(['AAA', 'SPCX'])
    assert not result['series'][1]['eligible']
    assert 'SPCX' in result['series'][1]['reason']
