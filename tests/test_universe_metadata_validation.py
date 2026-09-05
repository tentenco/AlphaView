import json
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from alphaview.panel import api, market, store


@pytest.fixture(autouse=True)
def workspace(tmp_path,monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH',str(tmp_path/'metadata.db'))
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('OLD','Previous pool','test','test',3e9)")


def candidate(index):
    return dict(symbol=f'S{index}',longName=f'Synthetic {index}',quoteType='EQUITY',currency='USD',exchange='NMS',marketCap=3e9)


def discover(extra):
    quotes=[candidate(i) for i in range(20)]+[extra]
    with patch('yfinance.screen',return_value=dict(start=0,total=len(quotes),quotes=quotes)):
        return market.discover_universe()


@pytest.mark.parametrize('cap',[float('inf'),float('-inf'),float('nan'),None,-1,0,True,False,1999999999.,'3000000000',{},[]])
def test_invalid_or_unverified_cap_never_publishes_as_eligible(cap):
    extra=candidate(20);extra['marketCap']=cap
    assert discover(extra)==20
    assert market.universe_metadata()['raw_count']==21
    assert market.universe_metadata()['accepted_count']==20
    assert 'S20' not in {row['symbol'] for row in store.universe('market')}
    response=TestClient(api.app).get('/api/overview')
    assert response.status_code==200
    json.dumps(response.json(),allow_nan=False)


@pytest.mark.parametrize('field,value',[('symbol',{}),('symbol',[]),('symbol',None),('exchange',{}),('exchange',[]),('exchange',None)])
def test_non_string_identity_is_skipped_without_breaking_page_signature(field,value):
    extra=candidate(20);extra[field]=value
    assert discover(extra)==20


@pytest.mark.parametrize('long_name,short_name,expected',[(None,'Short','Short'),('',None,'S20'),({'bad':1},'Short','Short'),(123,[], 'S20'),('  ', ' Nice ', 'Nice')])
def test_optional_name_uses_nonempty_string_fallback(long_name,short_name,expected):
    extra=candidate(20);extra.update(longName=long_name,shortName=short_name)
    assert discover(extra)==21
    assert next(row for row in store.universe('market') if row['symbol']=='S20')['name']==expected


def test_bad_cap_count_below_minimum_preserves_previous_pool_and_metadata():
    before=market.universe_metadata()
    quotes=[candidate(i) for i in range(20)];quotes[-1]['marketCap']=None
    with patch('yfinance.screen',return_value=dict(start=0,total=20,quotes=quotes)),pytest.raises(ValueError,match='不足 20'):
        market.discover_universe()
    assert [row['symbol'] for row in store.universe('market')]==['OLD']
    assert market.universe_metadata()==before


def ticker(metadata):
    class FakeTicker:
        def history(self,**kwargs):
            return pd.DataFrame(dict(Open=[100.],High=[101.],Low=[99.],Close=[100.],**{'Adj Close':[100.],'Volume':[1000.]}),index=pd.to_datetime(['2026-09-04']))
        def get_history_metadata(self):
            return metadata
    return FakeTicker()


def test_fetch_optional_name_and_exchange_are_safe_without_price_invention():
    with patch('yfinance.Ticker',return_value=ticker(dict(currency='USD',longName={'bad':1},shortName=' Valid name ',exchangeName={'bad':1}))),patch.object(market,'latest_completed_session',return_value='2026-09-04'):
        assert market.fetch_symbol('SYNTH')['rows']==1
    dataset=store.dataset_rows()[0]
    assert dataset['name']=='Valid name' and dataset['exchange'] is None
    assert store.history('SYNTH').iloc[-1].close==100


def test_spcx_missing_typed_name_cannot_confirm_instrument_identity():
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SPCX','2026-09-03',100,101,99,100,100,1000)")
    with patch('yfinance.Ticker',return_value=ticker(dict(currency='USD',longName={'bad':1}))),pytest.raises(ValueError,match='身分待確認'):
        market.fetch_symbol('SPCX')
    assert store.history('SPCX').date.tolist()==['2026-09-03']
