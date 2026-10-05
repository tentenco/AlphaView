"""Synthetic count-only receipt capacity; no provider or production workspace access."""
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import paper_portfolio as paper, research_evidence_capacity as capacity, sessions, store

FAMILIES = ("allocation_research_receipts", "research_integrity_receipts",
            "workflow_path_receipts", "execution_study_receipts")


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic-capacity.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-10-01")
    monkeypatch.setattr(requests.Session, "request", lambda *a, **kw: pytest.fail("Unexpected provider call"))
    store.init_db()
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(capacity.router)
    with TestClient(app) as client:
        accounts = []
        for name in ("one", "two"):
            response = client.post("/api/paper/accounts", json={"name": f"Synthetic {name}",
                "initial_cash": 1000, "idempotency_key": f"synthetic-capacity-{name}"})
            assert response.status_code == 200, response.text
            accounts.append(response.json()["account"])
        yield client, accounts


def url(account):
    return f"/api/paper/accounts/{account['id']}/research-evidence-capacity"


def read(workspace, account_index=0):
    response = workspace[0].get(url(workspace[1][account_index]))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    json.dumps(result, allow_nan=False)
    assert [item["family"] for item in result["families"]] == list(FAMILIES)
    return result


def insert(db, family, account_id, identifier, payload="{broken-synthetic"):
    common = (identifier, "2026-10-01T00:00:00Z", "synthetic-unknown", "{broken-request", "bad-hash", payload)
    if family == "research_integrity_receipts":
        db.execute(f"INSERT INTO {family} VALUES (?,?,?,?,?,?,?)", (common[0], "SYNT", *common[1:]))
    elif family == "allocation_research_receipts":
        db.execute(f"INSERT INTO {family} VALUES (?,?,?,?,?,?,?,?)", (common[0], account_id, "synthetic-run", *common[1:]))
    else:
        kind = "path_validation" if family == "workflow_path_receipts" else "volume_day"
        db.execute(f"INSERT INTO {family} VALUES (?,?,?,?,?,?,?,?,?)", (common[0], account_id, "synthetic-source", kind, *common[1:]))


def test_empty_counts_are_known_zero_and_integrity_has_no_account_scope(workspace):
    value = read(workspace)
    assert value["engine_version"] == "alphaview-research-evidence-capacity-v1"
    assert value["account_id"] == workspace[1][0]["id"] and value["account_version"] == 1
    assert value["as_of"] == "2026-10-01" and value["input_revision"] == store.input_revision()
    assert value["policy"] == capacity.POLICY
    assert value["integrity"] == {"assessed": False, "available": None, "reason": "not_assessed"}
    for item, maximum in zip(value["families"], (500, 500, 250, 250), strict=True):
        assert item["workspace"] == {"scope": "workspace", "count": 0, "limit": maximum,
            "remaining": maximum, "over_limit": False, "reason": None}
        if item["family"] == "research_integrity_receipts":
            assert item["account"] == {"scope": "account", "count": None, "limit": None,
                "remaining": None, "over_limit": None, "reason": "workspace_scoped_family"}
        else:
            assert item["account"] == {"scope": "account", "count": 0, "limit": 50,
                "remaining": 50, "over_limit": False, "reason": None}


def test_counts_all_stored_corrupt_rows_and_separates_account_from_workspace(workspace):
    first, other = workspace[1]
    with store.connect() as db:
        for family in FAMILIES:
            insert(db, family, first["id"], "synthetic-one", b"\xff\x00invalid-json")
            insert(db, family, other["id"], "synthetic-two")
            insert(db, family, other["id"], "synthetic-three")
            # SQLite TEXT with invalid UTF-8 must not be decoded by the count endpoint.
            db.execute(f"UPDATE {family} SET payload_json=CAST(x'ff' AS TEXT) WHERE id='synthetic-three'")
    one, two = read(workspace), read(workspace, 1)
    for left, right in zip(one["families"], two["families"], strict=True):
        assert left["workspace"]["count"] == right["workspace"]["count"] == 3
        if left["family"] != "research_integrity_receipts":
            assert left["account"]["count"] == 1 and left["account"]["remaining"] == 49
            assert right["account"]["count"] == 2 and right["account"]["remaining"] == 48
        else:
            assert left["account"]["count"] is right["account"]["count"] is None


@pytest.mark.parametrize("count,over", [(50, False), (51, True)])
def test_at_or_above_limit_keeps_actual_counts_and_zero_remaining(workspace, count, over):
    first = workspace[1][0]
    with store.connect() as db:
        for index in range(count):
            insert(db, "execution_study_receipts", first["id"], f"synthetic-{index}")
        for index in range(501):
            insert(db, "research_integrity_receipts", None, f"synthetic-{index}")
    value = read(workspace)
    execution = value["families"][3]["account"]
    assert execution["count"] == count and execution["limit"] == 50
    assert execution["remaining"] == 0 and execution["over_limit"] is over
    integrity = value["families"][1]["workspace"]
    assert integrity["count"] == 501 and integrity["remaining"] == 0 and integrity["over_limit"]


def test_limits_are_taken_from_existing_receipt_modules(workspace, monkeypatch):
    monkeypatch.setattr(capacity.allocation, "MAX_ACCOUNT", 7)
    monkeypatch.setattr(capacity.allocation, "MAX_TOTAL", 17)
    monkeypatch.setattr(capacity.integrity, "MAX_TOTAL", 19)
    monkeypatch.setattr(capacity.workflow, "MAX_ACCOUNT", 11)
    monkeypatch.setattr(capacity.workflow, "MAX_TOTAL", 23)
    monkeypatch.setattr(capacity.execution, "MAX_ACCOUNT", 13)
    monkeypatch.setattr(capacity.execution, "MAX_TOTAL", 29)
    values = read(workspace)["families"]
    assert [value["account"]["limit"] for value in values] == [7, None, 11, 13]
    assert [value["workspace"]["limit"] for value in values] == [17, 19, 23, 29]


def test_unknown_account_and_invalid_identifier_do_not_produce_workspace_totals(workspace):
    response = workspace[0].get(url({"id": "f" * 32}))
    assert response.status_code == 404 and response.json()["detail"]["code"] == "capacity_account_missing"
    response = workspace[0].get(url({"id": "synthetic-invalid"}))
    assert response.status_code == 422


def test_one_query_only_snapshot_has_no_payload_reads_decode_schema_or_writes(workspace, monkeypatch):
    with store.connect() as db:
        for family in FAMILIES:
            insert(db, family, workspace[1][0]["id"], "synthetic-one")
        before = list(db.iterdump())
    original = capacity._family
    statements = []
    connections = set()
    def count_only(db, *args):
        connections.add(id(db))
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM execution_study_receipts")
        db.set_trace_callback(statements.append)
        def authorizer(action, table, column, *_args):
            if action == sqlite3.SQLITE_READ and table in FAMILIES and column not in ("", "account_id"):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorizer)
        return original(db, *args)
    monkeypatch.setattr(capacity, "_family", count_only)
    for module in (capacity.allocation, capacity.integrity, capacity.workflow, capacity.execution):
        for name in ("_decode", "_view", "init_schema", "ensure_schema", "_rebuild"):
            if hasattr(module, name):
                monkeypatch.setattr(module, name, lambda *a, **k: pytest.fail("Count read must not decode, validate or initialize"))
    read(workspace)
    assert len(connections) == 1
    reads = [statement for statement in statements if statement.upper().startswith("SELECT")]
    assert len(reads) == 7 and all(statement.upper().startswith("SELECT COUNT(*) FROM ") for statement in reads)
    with store.connect() as db:
        assert list(db.iterdump()) == before


def test_concurrent_insert_and_context_change_are_not_mixed_into_active_snapshot(workspace, monkeypatch):
    first = workspace[1][0]
    revision = store.input_revision()
    original = capacity._family
    changed = False
    def write_new_state():
        with store.connect() as db:
            for family in FAMILIES:
                insert(db, family, first["id"], "synthetic-concurrent")
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (first["id"],))
            db.execute("UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1")
    def interleave(db, *args):
        nonlocal changed
        result = original(db, *args)
        if not changed:
            changed = True
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(write_new_state).result(timeout=10)
        return result
    monkeypatch.setattr(capacity, "_family", interleave)
    old = read(workspace)
    assert old["account_version"] == first["version"] and old["input_revision"] == revision
    assert all(item["workspace"]["count"] == 0 for item in old["families"])
    new = read(workspace)
    assert new["account_version"] == first["version"] + 1 and new["input_revision"] != revision
    assert all(item["workspace"]["count"] == 1 for item in new["families"])
