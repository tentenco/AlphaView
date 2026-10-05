import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from alphaview.panel import paper_portfolio as paper, paper_forks as forks, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "forks.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda *args: "2026-09-18")
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2026-09-18',100,101,99,100,100,1000)")
        db.execute("INSERT INTO datasets(symbol,currency,source) VALUES ('SYNTA','USD','synthetic')")
    account = paper.create_account(paper.AccountInput(name="Synthetic source",initial_cash=10000,idempotency_key="fork-source"))["account"]
    proposal = paper.create_proposal(account["id"],paper.ProposalInput(expected_version=1,targets=[{"symbol":"SYNTA","weight_pct":20}],idempotency_key="fork-source-plan"))
    paper.accept_proposal(account["id"],proposal["id"],paper.AcceptInput(expected_version=1,idempotency_key="fork-source-fill"))
    with store.connect() as db:
        db.execute("UPDATE bars SET open=119,high=121,low=118,close=120,adj_close=120 WHERE symbol='SYNTA'")
    app=FastAPI();app.include_router(forks.router)
    with TestClient(app) as client:
        yield client,account["id"]


def create(client, identifier, key="fork-child"):
    plan=client.post(f"/api/paper/accounts/{identifier}/fork/preview",json={"expected_version":2}).json()
    return client.post(f"/api/paper/accounts/{identifier}/fork",json={"expected_version":2,"name":"Synthetic new experiment",
        "expected_source_digest":plan["source_digest"],"idempotency_key":key})


def test_fork_preserves_current_shares_cash_but_resets_basis_and_history(workspace):
    client,identifier=workspace
    before=paper.account_snapshot(identifier)
    revision=store.input_revision()
    response=create(client,identifier)
    assert response.status_code==201,response.text
    child=response.json()["account"]
    assert child["account"]["id"]!=identifier
    assert child["account"]["cash"]==8000 and child["account"]["initial_cash"]==10400
    assert child["holdings"][0]["shares"]==20 and child["holdings"][0]["cost_basis"]==2400
    assert child["unrealized_pnl"]==0 and child["realized_pnl"]==0 and child["total_return_pct"]==0
    assert child["proposals"]==[] and [e["kind"] for e in child["ledger"]]==["opening_mark","initial_cash"]
    assert sum(e["cash_delta"] for e in child["ledger"])==child["account"]["cash"]
    assert all(e["fee"]==0 and e["proposal_id"] is None for e in child["ledger"])
    assert child["account"]["limits"]==before["account"]["limits"]
    assert paper.account_snapshot(identifier)==before and store.input_revision()==revision
    assert json.dumps(response.json(),allow_nan=False)
    origin=client.get(f"/api/paper/accounts/{child['account']['id']}/origin").json()["origin"]
    assert origin["source_account_id"]==identifier and origin["source_account_version"]==2
    assert client.get(f"/api/paper/accounts/{identifier}/origin").json()["origin"] is None
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_nav_snapshots WHERE account_id=?",(child["account"]["id"],)).fetchone()[0]==0
        assert db.execute("SELECT COUNT(*) FROM agent_mandates WHERE account_id=?",(child["account"]["id"],)).fetchone()[0]==0


def test_retry_is_one_fork_even_after_source_changes(workspace):
    client,identifier=workspace
    plan=client.post(f"/api/paper/accounts/{identifier}/fork/preview",json={"expected_version":2}).json()
    body={"expected_version":2,"name":"Synthetic retry","expected_source_digest":plan["source_digest"],"idempotency_key":"fork-retry"}
    first=client.post(f"/api/paper/accounts/{identifier}/fork",json=body)
    paper.update_controls(identifier,paper.ControlsInput(expected_version=2,kill_switch=True))
    replay=client.post(f"/api/paper/accounts/{identifier}/fork",json=body)
    assert first.status_code==201 and replay.json()==first.json()
    changed=client.post(f"/api/paper/accounts/{identifier}/fork",json={**body,"name":"Different"})
    assert changed.status_code==409


def test_changed_source_digest_fails_without_account_or_ledger_write(workspace):
    client,identifier=workspace
    plan=client.post(f"/api/paper/accounts/{identifier}/fork/preview",json={"expected_version":2}).json()
    with store.connect() as db:
        db.execute("UPDATE bars SET close=119,adj_close=119 WHERE symbol='SYNTA'")
    response=client.post(f"/api/paper/accounts/{identifier}/fork",json={"expected_version":2,"name":"Stale",
        "expected_source_digest":plan["source_digest"],"idempotency_key":"fork-stale"})
    assert response.status_code==409
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_accounts").fetchone()[0]==1
        assert db.execute("SELECT COUNT(*) FROM paper_account_origins").fetchone()[0]==0


def test_missing_quotes_do_not_clone_partial_account(workspace):
    client,identifier=workspace
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTA'")
    assert client.post(f"/api/paper/accounts/{identifier}/fork/preview",json={"expected_version":2}).status_code==422


def test_paused_controls_are_inherited_and_cash_only_origin_is_valid(workspace):
    client,_=workspace
    source=paper.create_account(paper.AccountInput(name="Cash-only source",initial_cash=3333,idempotency_key="fork-cash-source"))["account"]
    paper.update_controls(source["id"],paper.ControlsInput(expected_version=1,kill_switch=True,execution_policy={"fee_bps":10,"slippage_bps":20,"min_trade_notional":50,"share_precision":0}))
    child=create(client,source["id"],"fork-cash-child").json()["account"]
    assert child["account"]["kill_switch"] and child["account"]["initial_cash"]==3333
    assert child["account"]["execution_policy"]["share_precision"]==0
    assert child["holdings"]==[] and len(child["ledger"])==1


def test_account_capacity_and_unknown_source_are_explicit(workspace,monkeypatch):
    client,identifier=workspace
    monkeypatch.setattr(paper,"MAX_ACCOUNTS",1)
    assert create(client,identifier).status_code==422
    assert client.get("/api/paper/accounts/missing/origin").status_code==404
    assert client.post(f"/api/paper/accounts/{identifier}/fork/preview",json={"expected_version":1}).status_code==409


def test_fork_copies_exact_stored_quantity_without_float_roundtrip(workspace):
    client,identifier=workspace
    exact="1000000000000.123456"
    with store.connect() as db:
        db.execute("UPDATE paper_holdings SET shares=? WHERE account_id=?",(exact,identifier))
        db.execute("UPDATE bars SET open=0.000001,high=0.000002,low=0.0000005,close=0.000001,adj_close=0.000001 WHERE symbol='SYNTA'")
    response=create(client,identifier)
    assert response.status_code==201,response.text
    child_id=response.json()["account"]["account"]["id"]
    with store.connect() as db:
        assert db.execute("SELECT shares FROM paper_holdings WHERE account_id=?",(child_id,)).fetchone()[0]==exact


def test_fork_copies_allowlist_as_independent_policy_history(workspace):
    source = paper.create_account(paper.AccountInput(name="Synthetic source policy", initial_cash=10000,
        idempotency_key="fork-policy-source", symbol_policy={"mode": "allowlist", "symbols": ["SYNTH"]}))["account"]
    plan = forks.preview_fork(source["id"], forks.ForkPreviewInput(expected_version=1))
    child = forks.create_fork(source["id"], forks.ForkInput(expected_version=1, name="Synthetic child policy",
        expected_source_digest=plan["source_digest"], idempotency_key="fork-policy-child"))["account"]["account"]
    assert child["symbol_policy"] == source["symbol_policy"]
    paper.update_controls(source["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": []}))
    assert paper.account_snapshot(child["id"])["account"]["symbol_policy"]["symbols"] == ["SYNTH"]
    assert len(paper.symbol_policy_history(child["id"])["items"]) == 1
