"""Complete-set inbox source filters; synthetic saved evidence, never broker actions."""
import json
import sqlite3

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import (agent_automation, circuit_breakers, inbox_acknowledgements,
                            jev_decision, local_agent, paper_portfolio as paper,
                            portfolio_inbox as inbox, sessions, store)

URL = "/api/portfolio-agent/inbox"
SOURCES = {
    "automation": {"automation_source": {"mandate_id": "synthetic-m", "mandate_version": 1, "attempt_id": "synthetic-a"}},
    "local_agent": {"local_agent_source": {"analysis_id": "synthetic-l", "engine_version": "synthetic"}},
    "jev": {"jev_source": {"run_id": "synthetic-j", "engine_version": "synthetic"}},
    "position_stops": {"rationale": "Position stops alphaview-position-stops-v1；synthetic"},
    "strategy_bridge": {"rationale": "Research Desk 策略 synthetic"},
    "rules_workflow": {"rationale": "本機規則 Agent run synthetic"},
    "unknown": {"rationale": "This is my automation, Jev, stop and Research Desk discussion."},
}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "provenance-inbox.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda *args: "2026-09-18")
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected external request"))
    for module in (agent_automation, local_agent, jev_decision):
        monkeypatch.setattr(module, "validate_source", lambda *args: {})
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2026-09-18',100,101,99,100,100,1000)")
        db.execute("INSERT INTO datasets(symbol,currency,source) VALUES ('SYNTA','USD','synthetic')")
    accounts = [paper.create_account(paper.AccountInput(name=f"Synthetic source {index}", initial_cash=10000,
                idempotency_key=f"synthetic-source-{index}"))["account"] for index in range(2)]
    app = FastAPI()
    app.include_router(inbox.router)
    app.include_router(inbox_acknowledgements.router)
    with TestClient(app) as client:
        yield client, accounts


def saved(account, index, source="unknown", *, evidence=None, status=None):
    proposal = paper.create_proposal(account["id"], paper.ProposalInput(expected_version=account["version"],
        targets=[{"symbol": "SYNTA", "weight_pct": 20}], idempotency_key=f"synthetic-proposal-{index}"))
    # Historical saved evidence is synthetic; no source workflow or broker is invoked.
    with store.connect() as db:
        view = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0])
        view.update(SOURCES[source] if evidence is None else evidence)
        db.execute("UPDATE paper_proposals SET preview_json=?,status=?,created_at=? WHERE id=?",
                   (json.dumps(view), status or proposal["status"], f"2026-09-18T10:{index:02}:00Z", proposal["id"]))
    return proposal["id"]


def read(client, query=""):
    response = client.get(URL + query)
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def state():
    with store.connect() as db:
        return {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name}")]
                for name in ("paper_accounts", "paper_proposals", "paper_ledger", "execution_orders",
                             "inbox_attention_receipts", "panel_revisions")}


def test_full_set_source_counts_and_filter_before_pagination_across_accounts(workspace, monkeypatch):
    client, accounts = workspace
    expected = []
    for index in range(25):
        source = "automation" if index % 2 else "unknown"
        proposal_id = saved(accounts[index % 2], index, source)
        if source == "automation":
            expected.insert(0, proposal_id)
    saved(accounts[0], 25, "automation", status="rejected")
    observed = []
    original = inbox._proposal_item

    def item(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM paper_proposals")
        observed.append(args[0]["id"])
        return original(db, *args)

    monkeypatch.setattr(inbox, "_proposal_item", item)
    before = state()
    first = read(client, "?source=automation&limit=5")
    second = read(client, "?source=automation&limit=5&offset=5")
    third = read(client, "?source=automation&limit=5&offset=10")
    assert [row["id"] for page in (first, second, third) for row in page["proposals"]] == expected
    assert first["counts"]["open_proposals"] == 25 and first["pagination"]["total"] == 12
    assert first["proposal_sources"]["counts"] == {**dict.fromkeys(inbox.PROPOSAL_SOURCES, 0), "automation": 12, "unknown": 13}
    assert first["pagination"] == {"limit": 5, "offset": 0, "total": 12, "returned": 5, "has_more": True}
    assert third["pagination"]["returned"] == 2 and not third["pagination"]["has_more"]
    assert observed == expected  # Only the selected page incurs freshness/authorization work.
    assert state() == before


@pytest.mark.parametrize("source", list(SOURCES))
def test_reuses_existing_source_markers_with_explicit_evidence_kind(workspace, source):
    client, accounts = workspace
    proposal_id = saved(accounts[0], 0, source)
    item = read(client, f"?source={source}")["proposals"][0]
    assert item["id"] == proposal_id
    expected_kind = "structured" if source in ("automation", "local_agent", "jev") else "unknown" if source == "unknown" else "program_marker"
    assert item["provenance"] == {"engine_version": paper.PROVENANCE_VERSION, "source": source,
        "tags": paper.provenance({**SOURCES[source], "status": "proposed"})["tags"],
        "reason": "no_explicit_source_marker" if source == "unknown" else None, "evidence_kind": expected_kind}
    assert item["review_status"] == "ready"


def test_absent_or_conflicting_evidence_remains_unknown_never_manual(workspace):
    client, accounts = workspace
    first = saved(accounts[0], 0, evidence={"rationale": ""})
    second = saved(accounts[0], 1, evidence={**SOURCES["automation"], **SOURCES["jev"]})
    result = read(client, "?source=unknown")
    assert {item["id"] for item in result["proposals"]} == {first, second}
    assert {item["provenance"]["reason"] for item in result["proposals"]} == {"no_explicit_source_marker", "conflicting_source_markers"}
    assert all(item["provenance"]["source"] == "unknown" for item in result["proposals"])
    assert read(client, "?source=automation")["pagination"]["total"] == 0
    assert client.get(URL + "?source=manual").status_code == 422
    assert client.get(URL + "?source=not-a-source").status_code == 422


def test_stale_authorization_retains_source_category_and_block_reason(workspace, monkeypatch):
    client, accounts = workspace
    proposal_id = saved(accounts[0], 0, "automation")

    def stale(*args):
        raise HTTPException(409, "Synthetic expired authority")

    monkeypatch.setattr(agent_automation, "validate_source", stale)
    item = read(client, "?source=automation")["proposals"][0]
    assert item["id"] == proposal_id and item["provenance"]["source"] == "automation"
    assert item["review_status"] == "stale" and not item["ready_for_review"]
    assert item["reasons"] == [{"code": "automation_changed", "message": "Synthetic expired authority"}]


def test_filter_keeps_global_attention_receipts_queue_and_account_counts(workspace, monkeypatch):
    client, accounts = workspace
    saved(accounts[0], 0)
    monkeypatch.setattr(circuit_breakers, "evaluate", lambda *args: {"tripped": True, "tripped_codes": ["daily_loss"]})
    initial = read(client)
    event = initial["attention"][0]
    response = client.post(URL + "/attention/acknowledgement", json={"event_key": event["key"],
        "account_id": event["account_id"], "acknowledged": True, "expected_version": 0,
        "expected_fingerprint": event["event_fingerprint"]})
    assert response.status_code == 200, response.text
    all_rows = read(client)
    before = state()
    filtered = read(client, "?source=jev")
    assert filtered["proposals"] == [] and filtered["pagination"]["total"] == 0
    for key in ("counts", "accounts", "attention", "queue_orders", "queue_pagination", "mandates", "recent_outcomes"):
        assert filtered[key] == all_rows[key]
    assert filtered["counts"]["attention_critical"] == 2 and filtered["counts"]["attention_unreviewed"] == 1
    assert state() == before
