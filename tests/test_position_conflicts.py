"""Real optimistic edit conflicts must not overwrite a newer position."""
import pytest
from fastapi.testclient import TestClient
from alphaview.panel import store
from alphaview.panel.api import app

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'positions.db'))
    with TestClient(app) as value:
        yield value

def test_edit_conflict_preserves_newer_values(client):
    body = {'symbol':'TEST','name':'Synthetic','shares':1,'cost':10,'expected_updated_at':None}
    assert client.put('/api/positions/TEST',json=body).status_code == 200
    original=store.positions()[0]
    current={**body,'shares':2,'expected_updated_at':original['updated_at']}
    assert client.put('/api/positions/TEST',json=current).status_code == 200
    response=client.put('/api/positions/TEST',json={**current,'shares':3})
    assert response.status_code == 409
    assert store.positions()[0]['shares'] == 2
    assert client.put('/api/positions/TEST',json={**current,'shares':3,'expected_updated_at':store.positions()[0]['updated_at']}).status_code == 200

def test_new_form_cannot_replace_existing_symbol(client):
    body={'symbol':'TEST','name':'Synthetic','shares':0,'expected_updated_at':None}
    assert client.put('/api/positions/TEST',json=body).status_code == 200
    assert client.put('/api/positions/TEST',json={**body,'name':'Duplicate form'}).status_code == 409
    assert store.positions()[0]['name']=='Synthetic'

def test_legacy_api_without_token_remains_compatible(client):
    body={'symbol':'TEST','name':'Synthetic','shares':0}
    assert client.put('/api/positions/TEST',json=body).status_code == 200
    assert client.put('/api/positions/TEST',json={**body,'name':'Explicit API update'}).status_code == 200
