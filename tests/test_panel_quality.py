import pandas as pd
import pytest
pytest.importorskip('fastapi')
from fastapi.testclient import TestClient
from alphaview.panel import store, quality
from alphaview.panel.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'quality.db'))
    monkeypatch.setattr(quality, 'latest_completed_session', lambda: '2026-09-08')
    with TestClient(app) as c:
        yield c


def put_bars(client, symbol, dates, bad=False):
    assert client.put(f'/api/positions/{symbol}', json={'symbol':symbol,'name':symbol,'shares':0}).status_code == 200
    rows = [{'symbol':symbol,'date':date,'open':100,'high':102,'low':99,'close':101,'adj_close':101,'volume':1000} for date in dates]
    if bad:
        rows[-1]['open'] = 0
    with store.connect() as db:
        pd.DataFrame(rows).to_sql('bars',db,if_exists='append',index=False)


def test_quality_excludes_holidays_and_does_not_claim_prelisting_gap(client):
    put_bars(client,'GOOD',['2026-09-04','2026-09-08'])
    put_bars(client,'IPO',['2026-09-08'])
    report = client.get('/api/data-quality').json()
    assert report['counts']['ok'] == 2
    assert all(i['gap_dates'] == [] for i in report['items'])


def test_quality_distinguishes_gap_invalid_stale_and_missing(client):
    put_bars(client,'GAP',['2026-09-02','2026-09-04','2026-09-08'])
    put_bars(client,'BAD',['2026-09-08'],bad=True)
    put_bars(client,'OLD',['2026-09-04'])
    client.put('/api/positions/NONE',json={'symbol':'NONE','name':'No data','shares':0})
    report = client.get('/api/data-quality').json()
    items = {i['symbol']:i for i in report['items']}
    assert report['counts'] == {'total':4,'ok':0,'stale':1,'error':2,'missing':1}
    assert items['GAP']['gap_dates'] == ['2026-09-03']
    assert items['BAD']['invalid_dates'] == ['2026-09-08']
    assert items['OLD']['status'] == 'stale'
    assert items['NONE']['status'] == 'missing'


def test_retry_validates_known_bounded_symbols_without_starting_provider(client):
    assert client.post('/api/jobs',json={'kind':'retry','symbols':[]}).status_code == 422
    assert client.post('/api/jobs',json={'kind':'retry','symbols':['UNKNOWN']}).status_code == 422
    assert client.post('/api/jobs',json={'kind':'refresh','symbols':['UNKNOWN']}).status_code == 422


def test_custom_port_same_origin_writes_and_cross_site_rejection(client):
    payload = {'symbol':'TEST','name':'Test','shares':0}
    with TestClient(app,base_url='http://127.0.0.1:9988') as port_client:
        assert port_client.put('/api/positions/TEST',json=payload,headers={'Origin':'http://127.0.0.1:9988'}).status_code == 200
        assert port_client.put('/api/positions/TEST',json=payload,headers={'Origin':'http://evil.example'}).status_code == 403
        assert port_client.put('/api/positions/TEST',json=payload,headers={'Sec-Fetch-Site':'cross-site'}).status_code == 403
