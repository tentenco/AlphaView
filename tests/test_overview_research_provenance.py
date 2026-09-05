from alphaview.panel import scan_provenance
import json
from fastapi.testclient import TestClient
from alphaview.panel import api, store


def test_overview_withholds_current_signals_after_inputs_change_but_keeps_quote(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'provenance.db'))
    monkeypatch.setattr(api.sessions, 'latest_completed_session', lambda: '2026-09-04')
    with TestClient(api.app) as client:
        with store.connect() as db:
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES('SYNTH','Synthetic',0,'test','fixed')")
            for date, price in [('2026-09-03',149),('2026-09-04',150)]:
                db.execute('INSERT INTO bars(symbol,date,open,high,low,close,adj_close,volume) VALUES(?,?,?,?,?,?,?,?)', ('SYNTH', date, price, price+1,price-1,price,price,1000))
        token = scan_provenance.current_token()
        row = {'symbol':'SYNTH','name':'Synthetic','date':'2026-09-04','bars':2,'indicators':{'close':150},'signals':[{'strategy':'trend','status':'match','matched':True,'reason':'Synthetic match'}]}
        with store.connect() as db:
            db.execute('INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES(?,?,?,?,?,?)', ('fixed','2026-09-04','["SYNTH"]',json.dumps([row]),'portfolio',token))
        initial = client.get('/api/overview').json()
        assert initial['summary']['research_available'] is True
        assert initial['summary']['matched_count'] == 1
        assert initial['positions'][0]['research']['signals'][0]['matched'] is True
        with store.connect() as db:
            db.execute("UPDATE bars SET open=151,high=152,low=150,close=151,adj_close=151 WHERE symbol='SYNTH' AND date='2026-09-04'")
        updated = client.get('/api/overview').json()
        assert updated['positions'][0]['price'] == 151
        assert updated['positions'][0]['research'] is None
        context = updated['positions'][0]['research_context']
        assert context['available'] is False and context['input_status'] == 'stale'
        assert updated['summary']['matched_count'] is None
        assert updated['summary']['research_available'] is False
        assert updated['scan']['result'][0]['signals'][0]['matched'] is True  # preserved historical snapshot
        detail = client.get('/api/stocks/SYNTH').json()['position']
        assert detail['research_context'] == context
        assert detail['research'] is None
