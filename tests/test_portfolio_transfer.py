import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import portfolio_transfer as transfer, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "transfer.db"))
    store.init_db()
    store.seed_portfolio()
    app = FastAPI(); app.include_router(transfer.router)
    with TestClient(app) as client:
        yield client


def preview(client, text):
    response = client.post("/api/portfolio/import/preview", json={"csv_text": text})
    assert response.status_code == 200
    return response.json()


def commit(client, text, fingerprint):
    return client.post("/api/portfolio/import", json={"csv_text": text, "expected_fingerprint": fingerprint})


def test_preview_then_merge_normalizes_symbols_and_preserves_unmentioned_metadata(client):
    before = {r["symbol"]: r for r in store.positions()}
    text = '\ufeffsymbol,shares,cost\nnvda,2.5,100.25\nnew,0,\n'
    result = preview(client, text)
    assert result["valid"] and result["counts"] == {"add": 1, "update": 1, "unchanged": 0, "total": 2}
    assert store.positions() == list(before.values())
    assert result["rows"][0]["after"]["name"] == before["NVDA"]["name"]
    assert result["rows"][1]["after"]["name"] == "NEW"
    assert commit(client, text, result["fingerprint"]).status_code == 200
    after = {r["symbol"]: r for r in store.positions()}
    assert len(after) == 8
    assert after["NVDA"]["shares"] == 2.5 and after["NVDA"]["cost"] == 100.25
    assert after["NVDA"]["source"] == "CSV 匯入"
    assert after["MSFT"] == before["MSFT"]
    assert after["NEW"]["sector"] == "自訂清單" and after["NEW"]["cost"] is None


def test_export_roundtrip_ignores_quotes_and_preserves_unchanged_rows(client):
    from alphaview.panel.api import export_portfolio
    with store.connect() as db:
        db.execute("UPDATE positions SET name='=Research name',shares=1.5,cost=100.25 WHERE symbol='NVDA'")
    before = store.positions()
    text = export_portfolio().body.decode()
    result = preview(client, text)
    assert result["valid"] and result["counts"]["unchanged"] == 7
    assert any("price" in warning and "source" in warning for warning in result["warnings"])
    assert commit(client, text, result["fingerprint"]).status_code == 200
    assert store.positions() == before


@pytest.mark.parametrize("text,field", [
    ("symbol,shares\nNVDA,1\n", "header"),
    ("symbol,shares,cost,cost\nNVDA,1,1,1\n", "header"),
    ("symbol,shares,cost\nNVDA,NaN,1\n", "shares"),
    ("symbol,shares,cost\nNVDA,1e-999,1\n", "shares"),
    ("symbol,shares,cost\nNVDA,Infinity,1\n", "shares"),
    ("symbol,shares,cost\nNVDA,-1,1\n", "shares"),
    ("symbol,shares,cost\nNVDA,1000000001,1\n", "shares"),
    ("symbol,shares,cost\nNVDA,1,\n", "cost"),
    ("symbol,shares,cost\nNVDA,1,-1\n", "cost"),
    ("symbol,shares,cost\nNVDA,1,NaN\n", "cost"),
    ("symbol,shares,cost\nNVDA,1,100\nnvda,2,200\n", "symbol"),
    ("symbol,shares,cost\n=EVAL,1,100\n", "symbol"),
    ("symbol,shares,cost,name\nNVDA,1,100,\n", "name"),
    ("symbol,shares,cost\nNVDA,1\n", "columns"),
    ('symbol,shares,cost\n"NVDA,1,100\n', "csv"),
    ("symbol,shares,cost\n", "rows"),
])
def test_invalid_csv_blocks_whole_import(client, text, field):
    before = store.positions()
    result = preview(client, text)
    assert not result["valid"] and result["fingerprint"] is None
    assert field in {e["field"] for e in result["errors"]}
    assert commit(client, text, "0" * 64).status_code == 422
    assert store.positions() == before


def test_stale_fingerprint_detects_even_unmentioned_concurrent_edits(client):
    text = 'symbol,shares,cost\nNVDA,1,100\n'
    result = preview(client, text)
    with store.connect() as db:
        db.execute("UPDATE positions SET name='Changed elsewhere' WHERE symbol='MSFT'")
    response = commit(client, text, result["fingerprint"])
    assert response.status_code == 409
    assert next(r for r in store.positions() if r["symbol"] == "NVDA")["shares"] == 0
    fresh = preview(client, text)
    assert fresh["fingerprint"] != result["fingerprint"]
    assert commit(client, text.replace('1,100', '2,100'), fresh["fingerprint"]).status_code == 409


def test_sql_failure_rolls_back_all_changes_and_releases_lock(client):
    text = 'symbol,shares,cost\nNVDA,1,100\nNEW,1,100\n'
    result = preview(client, text); before = store.positions()
    with store.connect() as db:
        db.execute("CREATE TRIGGER reject_new BEFORE INSERT ON positions WHEN NEW.symbol='NEW' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    response = commit(client, text, result["fingerprint"])
    assert response.status_code == 500
    assert store.positions() == before
    assert not transfer.RUN_LOCK.locked()


def test_busy_lock_blocks_commit_but_preview_remains_readonly(client):
    text = 'symbol,shares,cost\nNVDA,1,100\n'
    assert transfer.RUN_LOCK.acquire(blocking=False)
    try:
        result = preview(client, text)
        assert result["valid"]
        assert commit(client, text, result["fingerprint"]).status_code == 409
    finally:
        transfer.RUN_LOCK.release()


def test_row_and_postmerge_limits(client):
    text = 'symbol,shares,cost\n' + ''.join(f'S{i},0,\n' for i in range(101))
    assert not preview(client, text)["valid"]
    text = 'symbol,shares,cost\n' + ''.join(f'S{i},0,\n' for i in range(94))
    result = preview(client, text)
    assert not result["valid"] and any('合併後' in e["message"] for e in result["errors"])
    text = 'symbol,shares,cost\n' + ''.join(f'S{i},0,\n' for i in range(93))
    result = preview(client, text)
    assert result["valid"]
    assert commit(client, text, result["fingerprint"]).status_code == 200
    assert len(store.positions()) == 100


def test_name_sector_limits_and_payload_bound(client):
    text = 'symbol,shares,cost,name,sector\nNVDA,1,1,' + 'n' * 81 + ',' + 's' * 51
    result = preview(client, text)
    assert {e["field"] for e in result["errors"]} == {"name", "sector"}
    assert client.post('/api/portfolio/import/preview', json={"csv_text": "x" * 300001}).status_code == 422
