"""Lossless local execution-study archives, with synthetic accounts/history and no external actions."""
import base64
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from alphaview.panel import execution_study_receipt_archive as archive
from alphaview.panel import execution_study_receipts as receipts
from alphaview.panel import paper_portfolio as paper, store
from tests.test_execution_study_receipts import setup, workspace, prepare, url, saved, KINDS  # noqa: F401
from tests.test_execution_volume_study import state as protected_state



@pytest.fixture
def sample(setup):
    client = setup[0]
    client.app.include_router(archive.router)
    request, _ = prepare(setup)
    response = client.post(url(setup), json=request)
    assert response.status_code == 201, response.text
    return setup, response.json()


def route(subject):
    return f"/api/paper/accounts/{subject[1]['id']}/execution-study-receipt-archive"


def get(subject):
    return subject[0].get(route(subject))


def check(subject, value):
    raw = receipts._json(value) if not isinstance(value, (str, bytes)) else value
    return subject[0].post(route(subject) + "/preflight", content=raw, headers={"Content-Type": "application/json"})


def state():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT id,typeof(payload_json),hex(CAST(payload_json AS BLOB)),hex(CAST(request_json AS BLOB)) FROM execution_study_receipts ORDER BY rowid")]


def rehash(value):
    for item in value["records"]:
        item["row_checksum"] = archive._hash(item["record"])
    value["set_fingerprint"] = archive._set_hash([item["record"] for item in value["records"]])
    value["checksum"] = archive._hash({key: item for key, item in value.items() if key != "checksum"})
    return value


def clone(identifier, *, new_id, account_id=None, proposal_id=None):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM execution_study_receipts WHERE id=?", (identifier,)).fetchone())
        row.update(id=new_id)
        if account_id is not None: row["account_id"] = account_id
        if proposal_id is not None: row["proposal_id"] = proposal_id
        db.execute("INSERT INTO execution_study_receipts VALUES (?,?,?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))


def test_complete_account_archive_keeps_both_kinds_original_bytes_and_readonly(sample, monkeypatch):
    subject, saved = sample
    body, _ = prepare(subject, "limit_day")
    response = subject[0].post(url(subject), json=body)
    assert response.status_code == 201, response.text
    before, protected, revision = state(), protected_state(), store.input_revision()
    monkeypatch.setattr(receipts, "_rebuild", lambda *a: pytest.fail("No recompute"))
    monkeypatch.setattr(receipts, "ensure_schema", lambda *a: pytest.fail("No schema init"))
    monkeypatch.setattr(receipts.volume, "_bar_evidence", lambda *a: pytest.fail("No price/history reads"))
    original = archive._read_rows
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM execution_study_receipts")
        return original(db, *args)
    monkeypatch.setattr(archive, "_read_rows", readonly)
    response = get(subject)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["coverage"] == {"account_total": 2, "exported": 2, "raw_complete": 2, "verified": 2, "unavailable": 0, "complete_set": True}
    assert response.content == receipts._json(value).encode() and response.headers["cache-control"] == "no-store"
    assert value["checksum"] == archive._hash({key: item for key, item in value.items() if key != "checksum"})
    path_row = next(item for item in value["records"] if item["kind"] == "volume_day")
    assert json.loads(path_row["record"]["payload_json"]["content"]) == saved["receipt"]
    result = check(subject, response.content).json()
    assert result["compatible"], result
    assert {row["kind"] for row in result["records"]} == {"volume_day", "limit_day"}
    assert all(row["duplicate"] == "identical_locally" for row in result["records"])
    assert result["policy"] == archive.POLICY
    assert state() == before and protected_state() == protected and store.input_revision() == revision


def test_entire_account_set_crosses_workflows_and_pagination_but_excludes_other_account(sample):
    subject, saved = sample
    for index in range(24): clone(saved["id"], new_id=f"{index:064x}", proposal_id=f"synthetic-other-workflow-{index}")
    clone(saved["id"], new_id="f" * 64, account_id="a" * 32)
    value = get(subject).json()
    assert value["coverage"]["account_total"] == value["coverage"]["exported"] == value["coverage"]["raw_complete"] == 25
    assert value["coverage"]["verified"] == 1 and value["coverage"]["unavailable"] == 24
    assert all(item["record"]["account_id"]["content"] == subject[1]["id"] for item in value["records"])
    assert not check(subject, value).json()["compatible"]


@pytest.mark.parametrize("case", ["json", "blob", "invalid_utf8_text", "null_id", "blob_account", "nested_duplicate"])
def test_opaque_content_retained_but_incompatible_even_identical_locally(sample, case):
    subject, saved = sample
    with store.connect() as db:
        if case == "json": db.execute("UPDATE execution_study_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
        if case == "blob": db.execute("UPDATE execution_study_receipts SET payload_json=? WHERE id=?", (b"\xff\x00broken", saved["id"]))
        if case == "invalid_utf8_text": db.execute("UPDATE execution_study_receipts SET payload_json=CAST(x'ff00fe' AS TEXT) WHERE id=?", (saved["id"],))
        if case == "null_id": db.execute("UPDATE execution_study_receipts SET id=NULL WHERE id=?", (saved["id"],))
        if case == "blob_account": db.execute("UPDATE execution_study_receipts SET account_id=? WHERE id=?", (subject[1]["id"].encode(), saved["id"]))
        if case == "nested_duplicate":
            raw = db.execute("SELECT payload_json FROM execution_study_receipts WHERE id=?", (saved["id"],)).fetchone()[0]
            db.execute("UPDATE execution_study_receipts SET payload_json=? WHERE id=?", ('{"engine_version":"duplicate",' + raw[1:], saved["id"]))
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
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[1]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTB'")
    monkeypatch.setattr(receipts, "_rebuild", lambda *a: pytest.fail("No historical refresh"))
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
    monkeypatch.setattr(receipts.volume, "ENGINE_VERSION", "synthetic-unsupported-study")
    assert "archive_evidence_method_unsupported" in check(subject, original).json()["records"][0]["reasons"]
    with store.connect() as db: db.execute("UPDATE execution_study_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
    assert "archive_local_identity_conflict" in check(subject, original).json()["records"][0]["reasons"]


def test_foreign_account_blocked_without_foreign_currentness_and_missing_account_404(sample, monkeypatch):
    subject, _ = sample
    value = get(subject).json()
    other = paper.create_account(paper.AccountInput(name="Synthetic other archive", initial_cash=10000, idempotency_key="synthetic-other-archive"))["account"]
    other_subject = (subject[0], other, *subject[2:])
    monkeypatch.setattr(archive, "_currentness", lambda *args: pytest.fail("No foreign-account currentness"))
    result = check(other_subject, value).json()
    assert not result["compatible"] and "archive_account_mismatch" in result["reasons"]
    assert result["records"][0]["currentness"] == {"current": None, "reasons": ["archive_account_unverifiable"]}
    missing = route(subject).replace(subject[1]["id"], "f" * 32)
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


@pytest.mark.parametrize("kind", KINDS)
def test_unavailable_original_remains_compatible_and_preserves_nulls(setup, kind):
    setup[0].app.include_router(archive.router)
    with store.connect() as db: db.execute("DELETE FROM bars WHERE date='2024-01-08'")
    _body, response, receipt = saved(setup, kind)
    assert response.json()["status"] == "unavailable"
    value = get(setup).json()
    result = check(setup, value).json()
    assert result["compatible"], result
    assert result["records"][0]["diagnostic_status"] == "unavailable"
    raw = value["records"][0]["record"]["payload_json"]["content"]
    assert response.text in raw
    assert json.loads(raw)["evidence"]["orders"][0]["reason"] == "missing_execution_bar"


def test_missing_local_original_is_compatible_with_projected_capacity_and_set_currentness(sample):
    subject, saved = sample
    value = get(subject).json()
    with store.connect() as db: db.execute("DELETE FROM execution_study_receipts WHERE id=?", (saved["id"],))
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
        row = dict(db.execute("SELECT * FROM execution_study_receipts WHERE id=?", (saved["id"],)).fetchone())
        db.execute("DELETE FROM execution_study_receipts")
        for index in range(50 if limit == "account" else 250):
            row.update(id=f"{index:064x}")
            if limit == "global": row["account_id"] = f"{index // 50 + 1:032x}"
            db.execute("INSERT INTO execution_study_receipts VALUES (?,?,?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))
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
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[1]["id"],))
    def read_then_change(db, *args):
        values = original(db, *args)
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(writer).result(timeout=10)
        return values
    monkeypatch.setattr(archive, "_read_rows", read_then_change)
    value = get(subject).json()
    assert value["account_version"] == subject[1]["version"] and value["coverage"]["account_total"] == 1
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
        return subject[3]["session"] if count == 1 else "2099-01-01"
    monkeypatch.setattr(archive.sessions, "latest_completed_session", changed_session)
    response = get(subject) if operation == "export" else check(subject, value)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "study_archive_session_changed"


def test_empty_account_archive_is_complete_and_wrong_account_path_is_rejected(sample):
    subject, _ = sample
    account = paper.create_account(paper.AccountInput(name="Synthetic empty archive", initial_cash=10000, idempotency_key="synthetic-empty-archive"))["account"]
    other = (subject[0], account, *subject[2:])
    value = get(other).json()
    assert value["coverage"]["account_total"] == 0 and check(other, value).json()["compatible"]
    assert subject[0].get(route(subject).replace(subject[1]["id"], "not-an-account")).status_code == 422


def mutate_and_rebind(identifier, mutation):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM execution_study_receipts WHERE id=?", (identifier,)).fetchone())
        payload, request = json.loads(row["payload_json"]), json.loads(row["request_json"])
        mutation(payload)
        evidence = payload["evidence"]
        if payload["kind"] == "open_gtd": evidence["evidence_fingerprint"] = paper._hash({k:v for k,v in evidence.items() if k != "evidence_fingerprint"})
        raw = receipts._json(evidence)
        request["save_request"]["expected_raw_evidence_sha256"] = receipts._sha(raw)
        request["save_request"]["expected_evidence_engine_version"] = evidence["engine_version"]
        requested = receipts._json(request)
        payload["receipt_id"] = receipts._sha(requested)
        payload["source_context"]["raw_evidence_sha256"] = receipts._sha(raw)
        payload["source_context"]["versions"]["evidence"] = evidence["engine_version"]
        encoded = receipts._payload({k:v for k,v in payload.items() if k != "evidence"}, raw)
        db.execute("UPDATE execution_study_receipts SET id=?,request_json=?,payload_json=?,content_fingerprint=? WHERE id=?",
            (payload["receipt_id"], requested, encoded, receipts._sha(encoded), identifier))


@pytest.mark.parametrize("mutation", ["envelope", "orders", "coverage", "source", "bar", "unknownfield"])
def test_rehashed_malformed_original_never_becomes_compatible(sample, mutation):
    subject, receipt = sample
    def change(payload):
        e = payload["evidence"]
        if mutation == "envelope": payload["new_execution_authority"] = True
        if mutation == "orders": e["orders"][0]["status"] = "invented-success"
        if mutation == "coverage": e["coverage"]["available"] = 100
        if mutation == "source": e["source"]["orders"][0]["shares"] = None
        if mutation == "bar": e["orders"][0]["evidence"]["execution_bar"]["volume"] = 999
        if mutation == "unknownfield": e["future_authority"] = True
    mutate_and_rebind(receipt["id"], change)
    value = get(subject).json()
    assert value["coverage"]["raw_complete"] == 1 and value["coverage"]["verified"] == 0
    assert not check(subject, rehash(value)).json()["compatible"]


def test_rehashed_unknown_method_text_incompatible(sample):
    subject, receipt = sample
    mutate_and_rebind(receipt["id"], lambda payload: payload.update(method="Synthetic unsupported method"))
    value = get(subject).json()
    result = check(subject, value).json()
    assert not result["compatible"] and "archive_method_text_unsupported" in result["records"][0]["reasons"]


def test_null_identity_reports_unknown_projected_capacity_without_zero_fallback(sample):
    subject, saved = sample
    with store.connect() as db: db.execute("UPDATE execution_study_receipts SET id=NULL WHERE id=?", (saved["id"],))
    result = check(subject, get(subject).json()).json()
    assert result["capacity"]["unknown_identities"] == 1
    assert result["capacity"]["projected_account_total"] is None and result["capacity"]["projected_global_total"] is None
    assert not result["compatible"]


def test_all_three_kinds_and_corrupt_record_roundtrip_exact_storage_without_any_write(setup, monkeypatch):
    setup[0].app.include_router(archive.router)
    originals = [saved(setup, kind) for kind in KINDS]
    corrupt = saved(setup, participation_pct=17)[2]
    raw_corrupt = b'{"synthetic":1.0,"negative_zero":-0.0,"exponent":1e-7,"unknown":"\xe5\x90\x88\xe6\x88\x90","null":null,"duplicate":1,"duplicate":2}'
    with store.connect() as db:
        db.execute("UPDATE execution_study_receipts SET payload_json=? WHERE id=?", (raw_corrupt, corrupt["id"]))
    before, protected, revision = state(), protected_state(), store.input_revision()
    original_read = archive._read_rows
    def blocked(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        for sql in ("DELETE FROM execution_study_receipts", "UPDATE paper_accounts SET version=version+1", "CREATE TABLE unauthorized(x)"):
            with pytest.raises(sqlite3.OperationalError): db.execute(sql)
        return original_read(db, *args)
    monkeypatch.setattr(archive, "_read_rows", blocked)
    monkeypatch.setattr(receipts, "_rebuild", lambda *a: pytest.fail("No study recompute"))
    monkeypatch.setattr(receipts.volume, "_bar_evidence", lambda *a: pytest.fail("No price/volume reads"))
    value = get(setup).json()
    assert value["coverage"] == {"account_total":4,"exported":4,"raw_complete":4,"verified":3,"unavailable":1,"complete_set":True}
    checked = check(setup, value).json()
    assert not checked["compatible"] and checked["coverage"]["compatible"] == 3
    for _body, evidence, receipt in originals:
        entry = next(r for r in value["records"] if r["id"] == receipt["id"])
        row, reasons = archive._decode_cells(entry["record"])
        assert reasons == [] and receipts._sha(row["payload_json"]) == receipt["content_fingerprint"]
        assert evidence.text in row["payload_json"]
        assert row["payload_json"].encode().hex().upper() == next(r[2] for r in before if r[0] == receipt["id"])
    broken = next(r for r in value["records"] if r["id"] == corrupt["id"])
    row, reasons = archive._decode_cells(broken["record"])
    assert row["payload_json"] == raw_corrupt and not reasons
    assert state() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("case", ["extra", "bool_version", "columns", "method", "policy", "capacity"])
def test_strict_outer_schema_and_policy(sample, case):
    subject, _ = sample
    value = get(subject).json()
    if case == "extra": value["future_import"] = True
    if case == "bool_version": value["account_version"] = True
    if case == "columns": value["columns"][0] = "wrong"
    if case == "method": value["method"] = "unsupported"
    if case == "policy": value["policy"]["import_authorized"] = True
    if case == "capacity": value["retention"]["global_limit"] = 999
    result = check(subject, rehash(value)).json()
    assert not result["compatible"]


def test_saved_empty_proposal_retains_unavailable_and_can_be_archived(setup):
    setup[0].app.include_router(archive.router)
    clock = setup[3]
    clock["session"] = "2024-01-05"
    response = setup[0].post(f"/api/paper/accounts/{setup[1]['id']}/proposals", json={
        "expected_version":setup[1]["version"], "idempotency_key":"synthetic-empty-proposal", "targets":[]})
    assert response.status_code == 200, response.text
    subject = (setup[0],setup[1],response.json(),clock)
    clock["session"] = "2024-01-08"
    _body, evidence, _receipt = saved(subject)
    assert evidence.json()["orders"] == [] and evidence.json()["status"] == "unavailable"
    result = check(subject,get(subject).json()).json()
    assert result["compatible"], result


def test_unknown_kind_retained_in_raw_account_set_and_never_compatible(sample):
    subject, receipt = sample
    with store.connect() as db:
        db.execute("PRAGMA ignore_check_constraints=ON")
        db.execute("UPDATE execution_study_receipts SET kind='synthetic_future_kind' WHERE id=?", (receipt["id"],))
    before = state()
    value = get(subject).json()
    assert value["records"][0]["kind"] == "synthetic_future_kind"
    assert value["records"][0]["record"]["kind"]["content"] == "synthetic_future_kind"
    result = check(subject, value).json()
    assert not result["compatible"] and result["records"][0]["duplicate"] == "identical_locally"
    assert state() == before


def test_raw_float_decimal_representations_and_unicode_survive_supported_originals(setup):
    setup[0].app.include_router(archive.router)
    _body, evidence, receipt = saved(setup, "limit_day", participation_pct=0)
    assert '0.0' in evidence.text and '盤中' in evidence.text
    value = get(setup).json()
    row, reasons = archive._decode_cells(value["records"][0]["record"])
    assert not reasons and evidence.text in row["payload_json"]
    payload, exact, issue = receipts._decode(row)
    assert issue is None and exact.encode() == evidence.content
    assert payload["evidence"]["orders"][0]["scenario_shares"] == 0
    assert check(setup, value).json()["compatible"]
