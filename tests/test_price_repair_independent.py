"""Offline independent diagnostics: normalized missingness and complete changes."""
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

spec=importlib.util.spec_from_file_location('repair_independent',Path(__file__).resolve().parents[1]/'scripts/compare_price_repair.py')
diagnostic=importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def frame():
    return pd.DataFrame({'Open':[100.], 'High':[102.], 'Low':[98.], 'Close':[101.],
                         'Adj Close':[101.], 'Volume':[1000.]},index=pd.to_datetime(['2024-01-02']))


@pytest.mark.parametrize('missing',[pd.NA,pd.NaT,np.nan,np.inf,-np.inf,None])
def test_all_scalar_missing_or_nonfinite_cells_become_null_and_issue(missing):
    raw=frame().astype(object)
    raw.loc[raw.index[0],'Adj Close']=missing
    inspected=diagnostic.inspect(raw)
    assert inspected['rows'][0]['values']['Adj Close'] is None
    assert any(issue['column']=='Adj Close' and issue['reason']=='missing_or_nonfinite' for issue in inspected['issues'])
    json.dumps(inspected,allow_nan=False)


def test_equivalent_missing_representations_do_not_invent_price_changes():
    raw,repaired=frame().astype(object),frame().astype(object)
    raw.loc[raw.index[0],'Adj Close']=pd.NA
    repaired.loc[repaired.index[0],'Adj Close']=np.nan
    assert diagnostic.compare(diagnostic.inspect(raw),diagnostic.inspect(repaired))['changed_value_count']==0


def test_all_source_columns_compared_even_when_marker_says_not_repaired():
    raw=frame()
    repaired=frame()
    for column in raw.columns:
        repaired[column]=repaired[column]*2
    repaired['Dividends']=.1
    repaired['Repaired?']=False
    result=diagnostic.compare(diagnostic.inspect(raw),diagnostic.inspect(repaired))
    assert result['changed_value_count']==7
    assert {row['column'] for row in result['differences']}==set(raw.columns)|{'Dividends','Repaired?'}


def test_missing_column_differs_from_present_null_cell():
    raw=frame()
    repaired=frame()
    repaired['Optional action']=None
    result=diagnostic.compare(diagnostic.inspect(raw),diagnostic.inspect(repaired))
    difference=result['differences'][0]
    assert difference['column']=='Optional action'
    assert difference['raw'] is None and difference['repair'] is None
    assert difference['raw_present'] is False and difference['repair_present'] is True


def test_unchanged_duplicate_dates_remain_invalid_and_preserved():
    raw=pd.concat([frame(),frame()])
    inspected=diagnostic.inspect(raw)
    assert len(inspected['rows'])==2
    assert inspected['quality']['valid'] is False
    assert diagnostic.compare(inspected,inspected)['differences']==[]


def test_structural_success_does_not_claim_identity_or_completed_session_verification(monkeypatch):
    import yfinance as yf
    future=frame()
    future.index=pd.to_datetime(['2027-01-04'])
    class WrongInstrument:
        def __init__(self,symbol):
            pass
        def history(self,**kwargs):
            return future
        def get_history_metadata(self):
            return dict(symbol='OTHER',currency='EUR',instrumentType='ETF')
    monkeypatch.setattr(yf,'Ticker',WrongInstrument)
    result=diagnostic.fetch('SYNTH')
    for name in ('raw','repair'):
        assert result[name]['quality']['valid'] is True
        assert result[name]['identity']['symbol']=='OTHER'
        assert result[name]['rows'][0]['date']=='2027-01-04'
        assert 'not verified' in result[name]['validation_scope']
        assert result[name]['validation_scope'].startswith('structural_only')
        assert not result[name].get('identity_verified')
