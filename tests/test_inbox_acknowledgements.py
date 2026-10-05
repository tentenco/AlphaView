"""Synthetic versioned review receipts; no brokerage or private account data."""
from concurrent.futures import ThreadPoolExecutor
import json

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from alphaview.panel import agent_automation, circuit_breakers, inbox_acknowledgements as acknowledgements, paper_portfolio as paper, portfolio_inbox, sessions, store

URL = "/api/portfolio-agent/inbox/attention/acknowledgement"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "inbox-review.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda *args: "2026-09-18")
    store.init_db()
    account = paper.create_account(paper.AccountInput(
        name="Synthetic review account", initial_cash=10000, idempotency_key="synthetic-inbox-review"))["account"]
    source = {"tripped": True, "tripped_codes": ["daily_loss"]}
    monkeypatch.setattr(circuit_breakers, "evaluate", lambda db, account_id, as_of: source)
    app = FastAPI()
    app.include_router(portfolio_inbox.router)
    app.include_router(acknowledgements.router)
    with TestClient(app) as client:
        yield client, account, source


def read(client):
    response = client.get("/api/portfolio-agent/inbox")
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def event(client):
    return next(item for item in read(client)["attention"] if item["kind"] == "circuit_breaker_tripped")


def request(item, acknowledged=True):
    return {"event_key": item["key"], "account_id": item["account_id"], "acknowledged": acknowledged,
            "expected_version": item["acknowledgement"]["version"], "expected_fingerprint": item["event_fingerprint"]}


def write(client, item, acknowledged=True):
    response = client.post(URL, json=request(item, acknowledged))
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def receipt_rows():
    with store.connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM inbox_attention_receipts")]


def test_review_and_mark_unread_preserve_risk_counts_account_and_input_revision(workspace):
    client, account, _ = workspace
    revision = store.input_revision()
    before = paper.account_snapshot(account["id"])
    first = event(client)
    assert first["acknowledgement"] == {"engine_version": acknowledgements.ENGINE_VERSION,
        "can_acknowledge": True, "acknowledged": False, "version": 0,
        "acknowledged_at": None, "updated_at": None}
    assert first["navigation"] == {"tab": "risk"}
    assert receipt_rows() == []
    noop = write(client, first, acknowledged=False)
    assert noop["changed"] is False and receipt_rows() == []
    saved = write(client, first)
    assert saved["changed"] is True and saved["engine_version"] == acknowledgements.ENGINE_VERSION
    assert saved["as_of"] == "2026-09-18" and saved["input_revision"] == revision
    reviewed = saved["event"]
    assert reviewed["acknowledgement"]["acknowledged"] is True
    assert reviewed["acknowledgement"]["version"] == 1
    assert reviewed["acknowledgement"]["acknowledged_at"]
    value = read(client)
    assert value["counts"]["attention_critical"] == value["counts"]["attention_total"] == 1
    assert value["counts"]["attention_unreviewed"] == value["counts"]["attention_unreviewed_critical"] == 0
    assert value["attention"][0] == reviewed
    before_noop = receipt_rows()
    assert write(client, reviewed)["changed"] is False
    assert receipt_rows() == before_noop
    unread = write(client, reviewed, acknowledged=False)["event"]
    assert unread["acknowledgement"]["version"] == 2 and not unread["acknowledgement"]["acknowledged"]
    assert unread["acknowledgement"]["acknowledged_at"] is None
    assert read(client)["counts"]["attention_unreviewed_critical"] == 1
    assert paper.account_snapshot(account["id"]) == before and store.input_revision() == revision
    assert set(receipt_rows()[0]) == {"event_key", "account_id", "event_fingerprint", "acknowledged", "version", "created_at", "updated_at", "acknowledged_at"}


def test_same_key_changed_content_reopens_and_rejects_an_old_fingerprint(workspace):
    client, _, source = workspace
    original = event(client)
    reviewed = write(client, original)["event"]
    saved_rows = receipt_rows()
    source["tripped_codes"] = ["daily_loss", "drawdown"]
    changed = event(client)
    assert changed["key"] == original["key"] and changed["event_fingerprint"] != original["event_fingerprint"]
    assert changed["acknowledgement"]["version"] == 1
    assert changed["acknowledgement"]["acknowledged"] is False
    assert changed["acknowledgement"]["acknowledged_at"] is None
    assert read(client)["counts"]["attention_unreviewed"] == 1
    stale = client.post(URL, json=request(reviewed))
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "attention_changed"
    assert receipt_rows() == saved_rows
    rereviewed = write(client, changed)["event"]
    assert rereviewed["acknowledgement"]["version"] == 2 and rereviewed["acknowledgement"]["acknowledged"]


def test_old_version_wrong_account_missing_event_and_source_errors_cannot_be_acknowledged(workspace, monkeypatch):
    client, _, source = workspace
    first = event(client)
    write(client, first)
    rows = receipt_rows()
    assert client.post(URL, json=request(first)).status_code == 409
    current = event(client)
    assert client.post(URL, json={**request(current), "account_id": "synthetic-other-account"}).status_code == 409
    source["tripped"] = False
    assert client.post(URL, json=request(current)).status_code == 409
    assert receipt_rows() == rows

    def unavailable(*args):
        raise HTTPException(503, "Synthetic source failure")
    monkeypatch.setattr(circuit_breakers, "evaluate", unavailable)
    failure = read(client)["attention"][0]
    assert failure["kind"] == "source_unavailable"
    assert failure["acknowledgement"]["can_acknowledge"] is False
    assert failure["acknowledgement"]["acknowledged"] is False
    result = client.post(URL, json={**request(failure), "account_id": "synthetic-any-account"})
    assert result.status_code == 409 and result.json()["detail"]["code"] == "attention_source_unavailable"
    assert read(client)["counts"]["attention_unreviewed"] == 1
    assert receipt_rows() == rows


def test_event_is_rederived_under_the_same_immediate_transaction(workspace, monkeypatch):
    client, _, _ = workspace
    first = event(client)
    derive = portfolio_inbox.current_attention
    observations = []

    def observe(db, as_of):
        observations.append((db.in_transaction, db.execute("PRAGMA query_only").fetchone()[0]))
        return derive(db, as_of)
    monkeypatch.setattr(portfolio_inbox, "current_attention", observe)
    write(client, first)
    assert observations == [(True, 0)]


def test_mandate_lifecycle_review_uses_the_same_content_as_the_read_snapshot(workspace):
    client, account, source = workspace
    source["tripped"] = False
    saved = agent_automation.create_mandate(agent_automation.MandateInput(
        name="Synthetic reviewed mandate", account_id=account["id"], enabled=False,
        workflow=agent_automation.WorkflowTemplate(scope="market", candidate_symbols=["SYNTA"])))
    identifier = saved["mandate"]["id"]
    with store.connect() as db:
        db.execute("UPDATE agent_mandates SET reauth_required=1,reauth_reason='synthetic_review' WHERE id=?", (identifier,))
        before = dict(db.execute("SELECT * FROM agent_mandates WHERE id=?", (identifier,)).fetchone())
    item = read(client)["attention"][0]
    assert item["kind"] == "mandate_reauth_required"
    reviewed = write(client, item)["event"]
    assert reviewed["event_fingerprint"] == item["event_fingerprint"]
    assert read(client)["attention"][0] == reviewed
    with store.connect() as db:
        assert dict(db.execute("SELECT * FROM agent_mandates WHERE id=?", (identifier,)).fetchone()) == before


def test_concurrent_review_writers_have_one_winner_and_no_duplicate_receipt(workspace):
    client, _, _ = workspace
    body = request(event(client))
    revision = store.input_revision()
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: client.post(URL, json=body).status_code, range(2)))
    assert sorted(statuses) == [200, 409]
    assert len(receipt_rows()) == 1 and receipt_rows()[0]["version"] == 1
    assert store.input_revision() == revision


@pytest.mark.parametrize("change", [
    {"expected_version": True}, {"expected_version": 0.5}, {"expected_version": "0"},
    {"expected_version": -1}, {"acknowledged": 1}, {"acknowledged": "true"},
    {"account_id": None}, {"event_key": ""}, {"expected_fingerprint": "invalid"},
    {"notes": "synthetic unwanted extra field"},
])
def test_strict_request_validation_rejects_invalid_versions_and_extra_fields(workspace, change):
    client, _, _ = workspace
    assert client.post(URL, json={**request(event(client)), **change}).status_code == 422
    assert receipt_rows() == []


def test_nonfinite_version_is_rejected_by_the_model(workspace):
    client, _, _ = workspace
    for value in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValueError):
            acknowledgements.AcknowledgementInput.model_validate({**request(event(client)), "expected_version": value})


def test_fingerprint_covers_full_event_content_but_not_receipt_metadata():
    item = {"key": "synthetic:key", "kind": "circuit_breaker_tripped", "severity": "critical",
            "account_id": "synthetic-account", "account_name": "Synthetic", "at": "2026-09-18",
            "title_zh": "合成事件", "title_en": "Synthetic event", "detail": "daily_loss", "navigation": {"tab": "risk"}}
    digest = acknowledgements.fingerprint(item)
    assert acknowledgements.fingerprint(dict(reversed(list(item.items())))) == digest
    assert acknowledgements.fingerprint({**item, "event_fingerprint": "old", "acknowledgement": {"version": 9}}) == digest
    for key, value in {"kind": "other", "severity": "warn", "account_id": "other", "account_name": "Renamed",
                       "at": "2026-09-19", "title_zh": "新事件", "title_en": "New event", "detail": "drawdown",
                       "navigation": {"tab": "plan"}, "evidence": {"reason": "new"}}.items():
        assert acknowledgements.fingerprint({**item, key: value}) != digest
