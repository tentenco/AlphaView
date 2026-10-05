import json
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from alphaview.panel import paper_next_open as next_open, paper_portfolio as paper, paper_reports, portfolio_inbox as inbox, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "inbox.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda *args: "2026-09-18")
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2026-09-18',100,101,99,100,100,1000)")
        db.execute("INSERT INTO datasets(symbol,currency,source) VALUES ('SYNTA','USD','synthetic')")
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES ('PRIVATE','synthetic private marker',2,3,'test','now')")
    account = paper.create_account(paper.AccountInput(name="Synthetic inbox", initial_cash=10000, idempotency_key="inbox-account"))["account"]
    app = FastAPI()
    app.include_router(inbox.router)
    with TestClient(app) as client:
        yield client, account


def proposal(account, index=0, weight=20):
    return paper.create_proposal(account["id"], paper.ProposalInput(expected_version=account["version"],
        targets=[{"symbol": "SYNTA", "weight_pct": weight}], idempotency_key=f"inbox-proposal-{index}"))


def test_inbox_preserves_db_and_has_no_real_portfolio_fields(workspace):
    client, account = workspace
    saved = proposal(account)
    before = paper.account_snapshot(account["id"])
    revision = store.input_revision()
    response = client.get("/api/portfolio-agent/inbox")
    value = response.json()
    assert value["proposals"][0]["id"] == saved["id"]
    assert value["proposals"][0]["ready_for_review"]
    assert value["counts"]["open_proposals"] == 1
    assert "PRIVATE" not in response.text and "synthetic private marker" not in response.text
    assert json.dumps(value, allow_nan=False)
    assert store.input_revision() == revision and paper.account_snapshot(account["id"]) == before


def test_closed_proposal_moves_to_outcomes_and_invalidates_older_account_version(workspace):
    client, account = workspace
    old = proposal(account, 0)
    accepted = proposal(account, 1)
    paper.accept_proposal(account["id"], accepted["id"], paper.AcceptInput(expected_version=1,idempotency_key="inbox-accept"))
    value = client.get("/api/portfolio-agent/inbox").json()
    assert value["counts"]["open_proposals"] == 1 and value["counts"]["simulated_proposals"] == 1
    assert value["proposals"][0]["id"] == old["id"]
    assert value["proposals"][0]["review_status"] == "stale"
    assert value["recent_outcomes"][0]["proposal_id"] == accepted["id"]
    assert value["recent_outcomes"][0]["accepted_at"]


def test_blocked_preview_and_paused_account_are_not_ready(workspace):
    client, account = workspace
    blocked = proposal(account, weight=90)
    value = client.get("/api/portfolio-agent/inbox").json()
    item = value["proposals"][0]
    assert item["id"] == blocked["id"] and item["review_status"] == "blocked"
    assert item["reasons"] and not item["ready_for_review"]
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=1, kill_switch=True))
    value = client.get("/api/portfolio-agent/inbox").json()
    assert value["counts"]["paused_accounts"] == 1
    assert {r["code"] for r in value["proposals"][0]["reasons"]} >= {"account_changed", "account_paused"}


def test_source_versions_are_compared_independently(workspace):
    client, account = workspace
    saved = proposal(account)
    with store.connect() as db:
        preview = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (saved["id"],)).fetchone()[0])
        preview.update(engine_version="old-paper", as_of="2026-09-17", input_revision="old-input")
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(preview),saved["id"]))
    item = client.get("/api/portfolio-agent/inbox").json()["proposals"][0]
    assert {r["code"] for r in item["reasons"]} == {"method_changed", "session_changed", "inputs_changed"}
    assert not item["current"] and not item["ready_for_review"]


def test_pagination_has_full_counts_stable_order_and_no_duplicates(workspace):
    client, account = workspace
    for n in range(3):
        proposal(account, n)
    first = client.get("/api/portfolio-agent/inbox?limit=2").json()
    second = client.get("/api/portfolio-agent/inbox?limit=2&offset=2").json()
    assert first["pagination"] == {"limit":2,"offset":0,"total":3,"returned":2,"has_more":True}
    assert second["pagination"]["total"] == 3 and not second["pagination"]["has_more"]
    assert len({p["id"] for p in first["proposals"] + second["proposals"]}) == 3
    assert client.get("/api/portfolio-agent/inbox?limit=0").status_code == 422
    assert client.get("/api/portfolio-agent/inbox?offset=-1").status_code == 422


def test_automation_source_invalidation_is_visible(workspace, monkeypatch):
    client, account = workspace
    saved = proposal(account)
    with store.connect() as db:
        preview = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (saved["id"],)).fetchone()[0])
        preview["automation_source"] = {"mandate_id":"synthetic", "mandate_version":1, "attempt_id":"synthetic"}
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(preview),saved["id"]))
    def invalid(*args):
        raise HTTPException(409, "synthetic version changed")
    monkeypatch.setattr(inbox.agent_automation, "validate_source", invalid)
    item = client.get("/api/portfolio-agent/inbox").json()["proposals"][0]
    assert item["review_status"] == "stale" and item["source"] == "automation"
    assert any(reason["code"] == "automation_changed" for reason in item["reasons"])


@pytest.fixture
def queue_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "queue-inbox.db"))
    clock = {"now": datetime(2024, 1, 6, 12, tzinfo=timezone.utc)}
    latest = sessions.latest_completed_session
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: latest(at or clock["now"]))
    monkeypatch.setattr(next_open, "utcnow", lambda: clock["now"])
    monkeypatch.setattr(store, "now", lambda: clock["now"].isoformat())
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO datasets(symbol,currency,source,last_date) VALUES ('SYNTA','USD','synthetic','2024-01-05')")
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-05',100,101,99,100,100,1000)")
    account = paper.create_account(paper.AccountInput(name="Synthetic queue inbox", initial_cash=10000,
        idempotency_key="queue-inbox-account"))["account"]
    saved = proposal(account)
    app = FastAPI()
    for router in (inbox.router, next_open.router, paper.router, paper_reports.router):
        app.include_router(router)
    with TestClient(app) as client:
        yield client, clock, account, saved


def queued(account, saved, key="inbox-queue-0"):
    source = next(item for item in next_open.list_orders(account["id"])["source_proposals"] if item["id"] == saved["id"])
    return next_open.enqueue(account["id"], next_open.EnqueueInput(
        proposal_id=saved["id"], expected_account_version=account["version"],
        expected_proposal_fingerprint=source["proposal_fingerprint"],
        max_execution_cost_usd=100, max_buy_cash_debit_usd=5000,
        confirm_next_open_simulation=True, idempotency_key=key))


def test_queue_inbox_groups_waits_preserves_complete_attempt_count_and_is_read_only(queue_workspace):
    client, clock, account, saved = queue_workspace
    order = queued(account, saved)
    for index in range(23):
        order = next_open.process_order(account["id"], order["id"], next_open.OrderActionInput(
            expected_order_version=order["version"], idempotency_key=f"inbox-wait-{index}"))
    revision, before = store.input_revision(), paper.account_snapshot(account["id"])
    with store.connect() as db:
        changes_before = db.execute("SELECT COUNT(*) FROM paper_next_open_attempts").fetchone()[0]
    value = client.get("/api/portfolio-agent/inbox").json()
    assert value["engine_version"] == "alphaview-portfolio-inbox-v3"
    assert value["counts"]["queue_orders"] == value["counts"]["active_queue_orders"] == 1
    assert len(value["queue_orders"]) == 1
    item = value["queue_orders"][0]
    assert item["id"] == order["id"] and item["account_id"] == account["id"]
    assert item["attempt_count"] == 23 and item["can_cancel"] and not item["can_process"]
    exact = client.get(f"/api/paper/accounts/{account['id']}/next-open-orders/{item['id']}").json()
    assert len(exact["attempts"]) == 20 and exact["source_proposal_id"] == saved["id"]
    assert store.input_revision() == revision and paper.account_snapshot(account["id"]) == before
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_next_open_attempts").fetchone()[0] == changes_before
    json.dumps(value, allow_nan=False)


def test_queue_inbox_exact_object_can_cancel_and_terminal_actions_disappear(queue_workspace):
    client, clock, account, saved = queue_workspace
    order = queued(account, saved)
    clock["now"] = datetime(2024, 1, 8, 21, 15, tzinfo=timezone.utc)
    order = next_open.process_order(account["id"], order["id"], next_open.OrderActionInput(
        expected_order_version=order["version"], idempotency_key="inbox-missing-prices"))
    item = client.get("/api/portfolio-agent/inbox").json()["queue_orders"][0]
    assert item["status"] == "waiting_prices" and item["can_process"]
    url = f"/api/paper/accounts/{item['account_id']}/next-open-orders/{item['id']}"
    body = {"expected_order_version": item["version"], "idempotency_key": "inbox-cancel-queue"}
    response = client.post(f"{url}/cancel", json=body)
    assert response.status_code == 200
    value = client.get("/api/portfolio-agent/inbox").json()
    terminal = value["queue_orders"][0]
    assert terminal["status"] == "cancelled" and not terminal["can_cancel"] and not terminal["can_process"]
    assert value["counts"]["active_queue_orders"] == 0 and terminal["attempt_count"] == 2
    assert client.post(f"{url}/process", json={**body, "idempotency_key": "inbox-stale-action"}).status_code == 409
    assert paper.account_snapshot(account["id"])["account"]["cash"] == 10000


def test_queue_inbox_filled_order_links_to_independent_execution_receipt(queue_workspace):
    client, clock, account, saved = queue_workspace
    order = queued(account, saved)
    clock["now"] = datetime(2024, 1, 8, 21, 15, tzinfo=timezone.utc)
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-08',105,106,104,105,105,1000)")
    filled = next_open.process_order(account["id"], order["id"], next_open.OrderActionInput(
        expected_order_version=order["version"], idempotency_key="inbox-fill-queue"))
    item = client.get("/api/portfolio-agent/inbox").json()["queue_orders"][0]
    assert item["status"] == "filled" and item["execution_proposal_id"] == filled["execution_proposal_id"]
    assert item["execution_proposal_id"] != saved["id"] and not item["can_process"] and not item["can_cancel"]
    receipt = client.get(f"/api/paper/accounts/{account['id']}/proposals/{item['execution_proposal_id']}/receipt")
    assert receipt.status_code == 200
    assert order["id"] in receipt.text


def test_queue_pagination_is_independent_and_counts_all_orders(queue_workspace):
    client, clock, account, saved = queue_workspace
    for index in range(3):
        order = queued(account, saved, key=f"inbox-queue-{index}")
        if index < 2:
            next_open.cancel_order(account["id"], order["id"], next_open.OrderActionInput(
                expected_order_version=order["version"], idempotency_key=f"inbox-cancel-{index}"))
    first = client.get("/api/portfolio-agent/inbox?queue_limit=2&limit=1").json()
    second = client.get("/api/portfolio-agent/inbox?queue_limit=2&queue_offset=2").json()
    assert first["queue_pagination"] == {"limit": 2, "offset": 0, "total": 3, "returned": 2, "has_more": True}
    assert second["queue_pagination"]["returned"] == 1 and not second["queue_pagination"]["has_more"]
    assert len({row["id"] for row in first["queue_orders"] + second["queue_orders"]}) == 3
    assert first["pagination"]["total"] == 1 and first["counts"]["active_queue_orders"] == 1
    assert first["queue_status_counts"] == {"cancelled": 2, "waiting_session": 1}
    assert client.get("/api/portfolio-agent/inbox?queue_limit=0").status_code == 422
    assert client.get("/api/portfolio-agent/inbox?queue_offset=-1").status_code == 422
