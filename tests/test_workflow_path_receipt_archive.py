"""Lossless local path archives, with synthetic accounts/history and no external actions."""
import base64
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from alphaview.panel import workflow_path_receipt_archive as archive
from alphaview.panel import workflow_path_receipts as receipts, workflow_path_validation as path, workflow_path_costs as costs
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent, store
from tests.test_workflow_path_receipts import setup, workspace, prepare, url, protected_state  # noqa: F401


@pytest.fixture
def sample(setup):
    client = setup[0]
    client.app.include_router(archive.router)
    request, _ = prepare(setup)
    response = client.post(url(setup), json=request)
    assert response.status_code == 201, response.text
    return setup, response.json()


def route(subject):
    return f"/api/paper/accounts/{subject[2]['id']}/workflow-path-receipt-archive"


def get(subject):
    return subject[0].get(route(subject))


def check(subject, value):
    raw = receipts._json(value) if not isinstance(value, (str, bytes)) else value
    return subject[0].post(route(subject) + "/preflight", content=raw, headers={"Content-Type": "application/json"})


def state():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT id,typeof(payload_json),hex(CAST(payload_json AS BLOB)),hex(CAST(request_json AS BLOB)) FROM workflow_path_receipts ORDER BY rowid")]


def rehash(value):
    for item in value["records"]:
        item["row_checksum"] = receipts._hash(item["record"])
    value["set_fingerprint"] = archive._set_hash([item["record"] for item in value["records"]])
    value["checksum"] = receipts._hash({key: item for key, item in value.items() if key != "checksum"})
    return value


def clone(identifier, *, new_id, account_id=None, run_id=None):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (identifier,)).fetchone())
        row.update(id=new_id)
        if account_id is not None: row["account_id"] = account_id
        if run_id is not None: row["run_id"] = run_id
        db.execute("INSERT INTO workflow_path_receipts VALUES (?,?,?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))


def test_complete_account_archive_keeps_both_kinds_original_bytes_and_readonly(sample, monkeypatch):
    subject, saved = sample
    body, _ = prepare(subject, "path_costs")
    response = subject[0].post(url(subject), json=body)
    assert response.status_code == 201, response.text
    before, protected, revision = state(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("No path recompute"))
    monkeypatch.setattr(costs, "evaluate", lambda *a: pytest.fail("No cost recompute"))
    monkeypatch.setattr(path, "_load_history", lambda *a: pytest.fail("No price/history reads"))
    original = archive._read_rows
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM workflow_path_receipts")
        return original(db, *args)
    monkeypatch.setattr(archive, "_read_rows", readonly)
    response = get(subject)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["coverage"] == {"account_total": 2, "exported": 2, "raw_complete": 2, "verified": 2, "unavailable": 0, "complete_set": True}
    assert response.content == receipts._json(value).encode() and response.headers["cache-control"] == "no-store"
    assert value["checksum"] == receipts._hash({key: item for key, item in value.items() if key != "checksum"})
    path_row = next(item for item in value["records"] if item["kind"] == "path_validation")
    assert path_row["record"]["payload_json"]["content"] == receipts._json(saved["receipt"])
    result = check(subject, response.content).json()
    assert result["compatible"], result
    assert {row["kind"] for row in result["records"]} == {"path_validation", "path_costs"}
    assert all(row["duplicate"] == "identical_locally" for row in result["records"])
    assert result["policy"] == archive.POLICY
    assert state() == before and protected_state() == protected and store.input_revision() == revision


def test_entire_account_set_crosses_workflows_and_pagination_but_excludes_other_account(sample):
    subject, saved = sample
    for index in range(24): clone(saved["id"], new_id=f"{index:064x}", run_id=f"synthetic-other-workflow-{index}")
    clone(saved["id"], new_id="f" * 64, account_id="a" * 32)
    value = get(subject).json()
    assert value["coverage"]["account_total"] == value["coverage"]["exported"] == value["coverage"]["raw_complete"] == 25
    assert value["coverage"]["verified"] == 1 and value["coverage"]["unavailable"] == 24
    assert all(item["record"]["account_id"]["content"] == subject[2]["id"] for item in value["records"])
    assert not check(subject, value).json()["compatible"]


@pytest.mark.parametrize("case", ["json", "blob", "invalid_utf8_text", "null_id", "blob_account", "nested_duplicate"])
def test_opaque_content_retained_but_incompatible_even_identical_locally(sample, case):
    subject, saved = sample
    with store.connect() as db:
        if case == "json": db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
        if case == "blob": db.execute("UPDATE workflow_path_receipts SET payload_json=? WHERE id=?", (b"\xff\x00broken", saved["id"]))
        if case == "invalid_utf8_text": db.execute("UPDATE workflow_path_receipts SET payload_json=CAST(x'ff00fe' AS TEXT) WHERE id=?", (saved["id"],))
        if case == "null_id": db.execute("UPDATE workflow_path_receipts SET id=NULL WHERE id=?", (saved["id"],))
        if case == "blob_account": db.execute("UPDATE workflow_path_receipts SET account_id=? WHERE id=?", (subject[2]["id"].encode(), saved["id"]))
        if case == "nested_duplicate":
            raw = db.execute("SELECT payload_json FROM workflow_path_receipts WHERE id=?", (saved["id"],)).fetchone()[0]
            db.execute("UPDATE workflow_path_receipts SET payload_json=? WHERE id=?", ('{"engine_version":"duplicate",' + raw[1:], saved["id"]))
    value = get(subject).json()
    assert value["coverage"]["raw_complete"] == 1 and value["coverage"]["verified"] == 0
    entry = value["records"][0]
    if case == "blob": assert base64.b64decode(entry["record"]["payload_json"]["content"]) == b"\xff\x00broken"
    if case == "invalid_utf8_text":
        cell = entry["record"]["payload_json"]
        assert cell["storage_type"] == "text" and cell["encoding"] == "base64" and base64.b64decode(cell["content"]) == b"\xff\x00\xfe"
    if case == "null_id": assert entry["record"]["id"]["content"] is None
    result = check(subject, value).json()
    assert not result["compatible"] and not result["records"][0]["integrity"]["available"]
    entry["integrity"] = {"available": True, "reason": None}
    value["coverage"].update(verified=1, unavailable=0)
    assert "archive_integrity_label_mismatch" in check(subject, rehash(value)).json()["records"][0]["reasons"]


def test_stale_valid_originals_remain_compatible_with_context_separate(sample, monkeypatch):
    subject, _ = sample
    value = get(subject).json()
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTB'")
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("No historical refresh"))
    result = check(subject, value).json()
    assert result["compatible"] and result["records"][0]["currentness"]["current"] is False
    assert set(result["snapshot_currentness"]["reasons"]) == {"account_version_changed", "inputs_changed"}
    assert set(result["records"][0]["currentness"]["reasons"]) == {"account_context_changed", "inputs_changed"}


@pytest.mark.parametrize("raw,reason", [(b'{"engine_version":1,"engine_version":2}', "duplicate_json_key"),
    (b'{"x":NaN}', "nonfinite_json"), (b'{"x":1e999}', "nonfinite_json"), (b'\xff', "archive_json_invalid"),
    (b'{', "archive_json_invalid"), (b'{"a":"\\ud800"}', "archive_json_invalid")])
def test_invalid_strict_json_blocks_without_write(sample, raw, reason):
    subject, _ = sample
    before = state()
    result = check(subject, raw)
    assert result.status_code == 200 and not result.json()["compatible"] and reason in result.json()["reasons"]
    assert state() == before


def test_checksums_duplicate_ids_method_scope_and_local_conflicts_block(sample, monkeypatch):
    subject, saved = sample
    original = get(subject).json()
    bad = copy.deepcopy(original); bad["checksum"] = "f" * 64
    assert "archive_checksum_mismatch" in check(subject, bad).json()["reasons"]
    bad = copy.deepcopy(original); bad["records"][0]["record"]["payload_json"]["sha256"] = "f" * 64
    assert not check(subject, rehash(bad)).json()["compatible"]
    bad = copy.deepcopy(original); bad["schema_version"] = 2
    assert "archive_version_unsupported" in check(subject, bad).json()["reasons"]
    bad = copy.deepcopy(original); bad["records"].append(copy.deepcopy(bad["records"][0])); bad["records"][1]["ordinal"] = 2
    bad["coverage"].update(account_total=2,exported=2,raw_complete=2,verified=2)
    assert "archive_duplicate_identity" in check(subject, rehash(bad)).json()["records"][1]["reasons"]
    monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-unsupported-path")
    assert "archive_evidence_method_unsupported" in check(subject, original).json()["records"][0]["reasons"]
    with store.connect() as db: db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
    assert "archive_local_identity_conflict" in check(subject, original).json()["records"][0]["reasons"]


def test_foreign_account_blocked_without_foreign_currentness_and_missing_account_404(sample, monkeypatch):
    subject, _ = sample
    value = get(subject).json()
    other = paper.create_account(paper.AccountInput(name="Synthetic other archive", initial_cash=10000, idempotency_key="synthetic-other-archive"))["account"]
    other_subject = (*subject[:2], other, subject[3])
    monkeypatch.setattr(archive, "_currentness", lambda *args: pytest.fail("No foreign-account currentness"))
    result = check(other_subject, value).json()
    assert not result["compatible"] and "archive_account_mismatch" in result["reasons"]
    assert result["records"][0]["currentness"] == {"current": None, "reasons": ["archive_account_unverifiable"]}
    missing = route(subject).replace(subject[2]["id"], "f" * 32)
    assert subject[0].get(missing).status_code == 404
    assert subject[0].post(missing + "/preflight", json=value).status_code == 404


def test_whole_size_count_limits_and_no_mutating_routes(sample, monkeypatch):
    subject, _ = sample
    original, before = get(subject).content, state()
    monkeypatch.setattr(archive, "MAX_BYTES", 100)
    assert get(subject).status_code == 413 and check(subject, original).status_code == 413
    assert state() == before
    assert subject[0].post(route(subject) + "/preflight", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    for action in ("import", "restore", "delete"):
        assert subject[0].post(route(subject) + "/" + action, json={}).status_code == 404


@pytest.mark.parametrize("kind", ["path_validation", "path_costs"])
def test_unavailable_original_remains_compatible_and_preserves_nulls(setup, kind):
    from tests.test_workflow_path_validation import saved as saved_workflow
    subject = setup
    client = subject[0]
    client.app.include_router(archive.router)
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (subject[1][-300],))
    subject = (*subject[:3], saved_workflow(client, subject[1]))
    body, evidence = prepare(subject, kind)
    assert evidence["status"] == "unavailable"
    saved = client.post(url(subject), json=body)
    assert saved.status_code == 201, saved.text
    value = get(subject).json()
    result = check(subject, value).json()
    assert result["compatible"], result
    assert result["records"][0]["diagnostic_status"] == "unavailable"
    original = json.loads(value["records"][0]["record"]["payload_json"]["content"])
    baseline = original["evidence"] if kind == "path_validation" else original["evidence"]["baseline"]
    assert baseline["metrics"] is None and baseline["reasons"]


def test_incomplete_cost_grid_preserves_unavailable_scenario_without_recompute(setup, monkeypatch):
    subject = setup
    subject[0].app.include_router(archive.router)
    original = costs._case
    def case(baseline, calendar, raw, fee, slip):
        if fee == 0 and slip == 0:
            return {"fee_bps": fee, "slippage_bps": slip, "is_baseline": False, "status": "unavailable",
                "reasons": [{"code": "nonfinite_accounting"}], "metrics": None, "costs": None, "differences": None,
                "curve": [], "events": [], "final_holdings": []}
        return original(baseline, calendar, raw, fee, slip)
    monkeypatch.setattr(costs, "_case", case)
    body, evidence = prepare(subject, "path_costs")
    assert evidence["status"] == "incomplete"
    result = subject[0].post(url(subject), json=body)
    assert result.status_code == 201, result.text
    value = get(subject).json()
    checked = check(subject, value).json()
    assert checked["compatible"], checked
    assert checked["records"][0]["diagnostic_status"] == "incomplete"


def test_missing_local_original_is_compatible_with_projected_capacity_and_set_currentness(sample):
    subject, saved = sample
    value = get(subject).json()
    with store.connect() as db: db.execute("DELETE FROM workflow_path_receipts WHERE id=?", (saved["id"],))
    result = check(subject, value).json()
    assert result["compatible"] and result["records"][0]["duplicate"] == "absent_locally"
    assert result["capacity"]["projected_account_total"] == result["capacity"]["projected_global_total"] == 1
    assert result["snapshot_currentness"] == {"current": False, "reasons": ["receipt_set_changed"]}
    assert state() == []


@pytest.mark.parametrize("limit", ["account", "global"])
def test_capacity_counts_all_kinds_and_accounts_without_deletion(sample, limit):
    subject, saved = sample
    value = get(subject).json()
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (saved["id"],)).fetchone())
        db.execute("DELETE FROM workflow_path_receipts")
        for index in range(50 if limit == "account" else 250):
            row.update(id=f"{index:064x}")
            if limit == "global": row["account_id"] = f"{index // 50 + 1:032x}"
            db.execute("INSERT INTO workflow_path_receipts VALUES (?,?,?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))
    before = state()
    result = check(subject, value).json()
    assert not result["compatible"] and "archive_receipt_capacity" in result["reasons"]
    assert result["capacity"]["absent_locally"] == 1
    assert result["capacity"]["projected_account_total"] == (51 if limit == "account" else 1)
    assert result["capacity"]["projected_global_total"] == (51 if limit == "account" else 251)
    assert state() == before
    clone("0" * 64, new_id="f" * 64)
    assert get(subject).status_code == 413


def test_export_snapshot_remains_consistent_during_concurrent_account_and_set_change(sample, monkeypatch):
    subject, saved = sample
    original = archive._read_rows
    def writer():
        clone(saved["id"], new_id="e" * 64)
        with store.connect() as db:
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[2]["id"],))
    def read_then_change(db, *args):
        values = original(db, *args)
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(writer).result(timeout=10)
        return values
    monkeypatch.setattr(archive, "_read_rows", read_then_change)
    value = get(subject).json()
    assert value["account_version"] == subject[2]["version"] and value["coverage"]["account_total"] == 1
    assert value["records"][0]["currentness"]["current"] is True
    monkeypatch.setattr(archive, "_read_rows", original)
    report = check(subject, value).json()
    assert report["compatible"]
    assert report["snapshot_currentness"] == {"current": False, "reasons": ["account_version_changed", "receipt_set_changed"]}
    assert report["records"][0]["currentness"]["current"] is False


@pytest.mark.parametrize("operation", ["export", "preflight"])
def test_session_transition_cannot_publish_mixed_currentness(sample, monkeypatch, operation):
    subject, _ = sample
    value = get(subject).json()
    count = 0
    def changed_session():
        nonlocal count
        count += 1
        return subject[1][-1] if count == 1 else "2099-01-01"
    monkeypatch.setattr(archive.sessions, "latest_completed_session", changed_session)
    response = get(subject) if operation == "export" else check(subject, value)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "path_archive_session_changed"


def test_empty_account_archive_is_complete_and_wrong_account_path_is_rejected(sample):
    subject, _ = sample
    account = paper.create_account(paper.AccountInput(name="Synthetic empty archive", initial_cash=10000, idempotency_key="synthetic-empty-archive"))["account"]
    other = (*subject[:2], account, subject[3])
    value = get(other).json()
    assert value["coverage"]["account_total"] == 0 and check(other, value).json()["compatible"]
    assert subject[0].get(route(subject).replace(subject[2]["id"], "not-an-account")).status_code == 422


def mutate_and_rebind(identifier, mutation):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (identifier,)).fetchone())
        payload, saved = json.loads(row["payload_json"]), json.loads(row["request_json"])
        mutation(payload)
        evidence = payload["evidence"]
        evidence["evidence_fingerprint"] = receipts._hash({key: item for key, item in evidence.items() if key != "evidence_fingerprint"})
        saved["save_request"]["expected_evidence_fingerprint"] = evidence["evidence_fingerprint"]
        saved["save_request"]["expected_evidence_engine_version"] = evidence["engine_version"]
        payload["receipt_id"] = receipts._hash(saved)
        payload["source_context"] = receipts._source(payload["kind"], payload["saved_workflow"], evidence)
        db.execute("UPDATE workflow_path_receipts SET id=?,request_json=?,payload_json=?,content_fingerprint=? WHERE id=?",
            (payload["receipt_id"], receipts._json(saved), receipts._json(payload), receipts._hash(payload), identifier))


@pytest.mark.parametrize("mutation", ["envelope", "events", "curve", "decision", "settings", "kind", "account"])
def test_rehashed_malformed_complete_original_never_becomes_compatible(sample, mutation):
    subject, saved = sample
    def change(payload):
        if mutation == "envelope": payload["new_execution_authority"] = True
        if mutation == "events": payload["evidence"]["events"][0]["trades"] = ["invalid"]
        if mutation == "curve": payload["evidence"]["curve"][0]["cash"] = None
        if mutation == "decision": payload["evidence"]["decisions"][0]["status"] = "invented-success"
        if mutation == "settings": payload["evidence"]["settings_fingerprint"] = "f" * 64
        if mutation == "kind": payload["request"]["fee_bps"] = [0]
        if mutation == "account": payload["account_context"]["account_id"] = "f" * 32
    mutate_and_rebind(saved["id"], change)
    value = get(subject).json()
    assert value["coverage"]["raw_complete"] == 1 and value["coverage"]["verified"] == 0
    assert not check(subject, rehash(value)).json()["compatible"]


def test_rehashed_unknown_method_text_and_evidence_version_are_incompatible(sample):
    subject, saved = sample
    mutate_and_rebind(saved["id"], lambda payload: payload.update(method="Synthetic unsupported method"))
    value = get(subject).json()
    result = check(subject, value).json()
    assert not result["compatible"] and "archive_method_text_unsupported" in result["records"][0]["reasons"]


def test_rehashed_cost_grid_must_preserve_each_requested_rate_pair(sample):
    subject, _ = sample
    body, _ = prepare(subject, "path_costs")
    saved = subject[0].post(url(subject), json=body).json()
    mutate_and_rebind(saved["id"], lambda payload: payload["evidence"]["scenarios"][0].update(fee_bps=13))
    value = get(subject).json()
    cost = next(row for row in value["records"] if row["kind"] == "path_costs")
    assert not cost["integrity"]["available"] and cost["integrity"]["reason"] == "archive_evidence_shape_unsupported"
    assert not check(subject, value).json()["compatible"]


def test_null_identity_reports_unknown_projected_capacity_without_zero_fallback(sample):
    subject, saved = sample
    with store.connect() as db: db.execute("UPDATE workflow_path_receipts SET id=NULL WHERE id=?", (saved["id"],))
    result = check(subject, get(subject).json()).json()
    assert result["capacity"]["unknown_identities"] == 1
    assert result["capacity"]["projected_account_total"] is None and result["capacity"]["projected_global_total"] is None
    assert not result["compatible"]
