import csv
import hashlib
import io
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from alphaview.panel import paper_portfolio as paper, paper_reports as reports, sessions, store


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "paper-export.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-09-18")
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES ('PRIVATE','Synthetic private marker',2,300,'test','now')")
        db.execute("INSERT INTO bars VALUES ('SYNTA','2026-09-18',100,101,99,100,100,1000)")
        db.execute("INSERT INTO datasets(symbol,currency,source) VALUES ('SYNTA','USD','synthetic')")
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(reports.router)
    account = paper.create_account(paper.AccountInput(name="=SYNTHETIC()", initial_cash=10000, idempotency_key="export-account"))
    proposal = paper.create_proposal(account["account"]["id"], paper.ProposalInput(expected_version=1, targets=[{"symbol":"SYNTA","weight_pct":20}], idempotency_key="export-proposal"))
    paper.accept_proposal(account["account"]["id"], proposal["id"], paper.AcceptInput(expected_version=1, idempotency_key="export-accept"))
    with TestClient(app) as client:
        yield client, account["account"]["id"], proposal["id"]


def test_json_export_has_all_exact_ledger_rows_and_verifiable_hash_without_private_positions(setup):
    client, account_id, _ = setup
    revision = store.input_revision()
    before = paper.account_snapshot(account_id)
    response = client.get(f"/api/paper/accounts/{account_id}/export")
    assert response.status_code == 200 and "attachment" in response.headers["content-disposition"]
    value = response.json()
    content = value["content"]
    assert content["complete"] and content["ledger_count"] == 2 and content["proposal_count"] == 1
    assert content["ledger_entries"][-1]["cash_after"] == "8000.00000000"
    assert value["content_sha256"] == hashlib.sha256(reports._canonical(content).encode()).hexdigest()
    assert "Synthetic private marker" not in response.text and "PRIVATE" not in response.text
    assert json.dumps(value, allow_nan=False)
    assert store.input_revision() == revision and paper.account_snapshot(account_id) == before


def test_csv_escapes_text_formula_but_keeps_signed_exact_cash_numeric(setup):
    client, account_id, _ = setup
    response = client.get(f"/api/paper/accounts/{account_id}/export?format=csv")
    rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert len(rows) == 2 and rows[0]["account_name"] == "'=SYNTHETIC()"
    assert rows[1]["cash_delta"] == "-2000.00000000"
    assert rows[1]["symbol"] == "SYNTA"
    assert response.headers["cache-control"] == "no-store"


def test_receipt_is_scoped_to_proposal_and_explicitly_paper(setup):
    client, account_id, proposal_id = setup
    response = client.get(f"/api/paper/accounts/{account_id}/proposals/{proposal_id}/receipt")
    value = response.json()["content"]
    assert value["executed_in_paper"] and value["live_order"] is False
    assert value["proposal"]["id"] == proposal_id and value["proposal"]["engine_version"] == paper.ENGINE_VERSION
    assert len(value["ledger_entries"]) == 1
    assert value["ledger_entries"][0]["proposal_id"] == proposal_id
    second = paper.create_account(paper.AccountInput(name="Second", initial_cash=5000, idempotency_key="second-account"))
    assert client.get(f"/api/paper/accounts/{second['account']['id']}/proposals/{proposal_id}/receipt").status_code == 404


def test_oversized_export_refuses_instead_of_silently_truncating(setup, monkeypatch):
    client, account_id, _ = setup
    monkeypatch.setattr(reports, "MAX_EXPORT_ROWS", 1)
    assert client.get(f"/api/paper/accounts/{account_id}/export").status_code == 422
    assert client.get(f"/api/paper/accounts/{account_id}/export?format=csv").status_code == 422
