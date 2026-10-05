"""Bounded local archive/preflight over synthetic saved research only."""
import base64
import copy
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from alphaview.panel import allocation_receipt_archive as archive
from alphaview.panel import allocation_research as research, allocation_research_receipts as receipts
from alphaview.panel import paper_portfolio as paper, store
from tests.test_allocation_research import workspace  # noqa: F401
from tests.test_allocation_research_receipts import setup, save  # noqa: F401


@pytest.fixture
def subject(setup):
    setup[0].app.include_router(archive.router)
    return setup


def path(subject):
    return f"/api/paper/accounts/{subject[1]['id']}/allocation-research-receipt-archive"


def export(subject):
    response = subject[0].get(path(subject))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def preflight(subject, value):
    response = subject[0].post(path(subject) + "/preflight", content=json.dumps(value, ensure_ascii=False), headers={"Content-Type": "application/json"})
    assert response.status_code == 200, response.text
    json.dumps(response.json(), allow_nan=False)
    return response.json()


def resign(value):
    value["checksum"] = receipts._hash({key: item for key, item in value.items() if key != "checksum"})


def cell(value):
    raw = value.encode() if isinstance(value, str) else value
    return {"storage_type": "text" if isinstance(value, str) else "blob", "encoding": "utf-8" if isinstance(value, str) else "base64",
            "byte_length": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "content": value if isinstance(value, str) else base64.b64encode(value).decode(),
            "availability": "retained", "reason": None}


def whole_state():
    with store.connect() as db:
        return {row[0]: [tuple(item) for item in db.execute(f'SELECT * FROM "{row[0]}" ORDER BY rowid')]
                for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_roundtrip_preserves_exact_strings_and_is_query_only_without_research_or_writes(subject, monkeypatch):
    saved = save(subject)
    before, revision = whole_state(), store.input_revision()
    monkeypatch.setattr(research, "compare_allocations", lambda *args: pytest.fail("archive/preflight must not rebuild research"))
    original = archive._currentness
    def read_only(db, payload):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM allocation_research_receipts")
        return original(db, payload)
    monkeypatch.setattr(archive, "_currentness", read_only)
    value = export(subject)
    assert value["coverage"] == {"account_total": 1, "exported": 1, "complete_set": True, "raw_complete": 1, "integrity_available": 1, "integrity_unavailable": 0}
    assert value["checksum"] == receipts._hash({key: item for key, item in value.items() if key != "checksum"})
    with store.connect() as db:
        raw = dict(db.execute("SELECT * FROM allocation_research_receipts WHERE id=?", (saved["id"],)).fetchone())
    assert all(value["records"][0]["record"][key]["content"] == raw[key] for key in archive.COLUMNS)
    assert value["records"][0]["currentness"]["current"] is True
    result = preflight(subject, value)
    assert result["verdict"] == "compatible" and result["compatible"] is True
    assert result["records"][0]["duplicate"] == "identical_locally"
    assert result["policy"] == archive.POLICY
    assert whole_state() == before and store.input_revision() == revision


def test_full_set_export_is_not_list_pagination_and_never_includes_other_account(subject):
    saved = save(subject)
    # Malformed synthetic identity copies are still full-set entries with reasons.
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM allocation_research_receipts").fetchone())
        for index in range(24):
            other = {**row, "id": f"synthetic-copy-{index:02}"}
            db.execute("INSERT INTO allocation_research_receipts VALUES (?,?,?,?,?,?,?,?)", tuple(other[key] for key in archive.COLUMNS))
        other = {**row, "id": "synthetic-foreign", "account_id": "synthetic-foreign"}
        db.execute("INSERT INTO allocation_research_receipts VALUES (?,?,?,?,?,?,?,?)", tuple(other[key] for key in archive.COLUMNS))
    value = export(subject)
    assert len(value["records"]) == 25 and value["coverage"]["complete_set"]
    assert value["coverage"]["integrity_available"] == 1 and value["coverage"]["integrity_unavailable"] == 24
    assert all(entry["record"]["account_id"]["content"] == subject[1]["id"] for entry in value["records"])
    assert saved["id"] in {entry["id"] for entry in value["records"]}


@pytest.mark.parametrize("damaged", ["broken", "{\"bad\":NaN}", b"\x00\xffsynthetic blob"])
def test_corrupt_raw_payload_remains_in_archive_but_preflight_is_blocked(subject, damaged):
    save(subject)
    with store.connect() as db:
        db.execute("UPDATE allocation_research_receipts SET payload_json=?", (damaged,))
    value = export(subject)
    entry = value["records"][0]
    raw = entry["record"]["payload_json"]
    assert raw["availability"] == "retained" and not entry["integrity"]["available"]
    assert value["coverage"]["raw_complete"] == 1
    assert (base64.b64decode(raw["content"]) if isinstance(damaged, bytes) else raw["content"]) == damaged
    result = preflight(subject, value)
    assert result["verdict"] == "blocked" and "receipt_evidence_unverifiable" in result["records"][0]["reasons"]


def test_oversized_saved_request_is_withheld_with_exact_byte_coverage_not_silently_dropped(subject):
    save(subject)
    text = "x" * (archive.MAX_REQUEST_CELL_BYTES + 1)
    with store.connect() as db:
        db.execute("UPDATE allocation_research_receipts SET request_json=?", (text,))
    value = export(subject)
    entry = value["records"][0]
    assert entry["record"]["request_json"] == {"storage_type": "text", "encoding": "unavailable", "byte_length": len(text), "sha256": None, "content": None, "availability": "withheld", "reason": "cell_size_limit"}
    assert value["coverage"]["complete_set"] is True and value["coverage"]["raw_complete"] == 0
    assert preflight(subject, value)["records"][0]["reasons"] == ["archive_content_withheld"]


@pytest.mark.parametrize("mode,reason", [("checksum", "archive_checksum_mismatch"), ("account", "archive_account_mismatch"),
    ("coverage", "archive_coverage_mismatch"), ("version", "archive_version_unsupported"), ("schema", "archive_version_unsupported"),
    ("extra", "archive_shape_invalid"), ("permission", "archive_shape_invalid")])
def test_archive_header_validation_is_advisory_and_fail_closed(subject, mode, reason):
    save(subject)
    value = export(subject)
    if mode == "checksum": value["checksum"] = "0" * 64
    elif mode == "account": value["account_id"] = "synthetic-other"
    elif mode == "coverage": value["coverage"]["complete_set"] = False
    elif mode == "version": value["engine_version"] = "alphaview-allocation-receipt-archive-v99"
    elif mode == "schema": value["schema_version"] = 99
    elif mode == "extra": value["unknown"] = "synthetic"
    else: value["policy"]["import_authorized"] = True
    if mode != "checksum": resign(value)
    result = preflight(subject, value)
    assert result["verdict"] == "blocked" and reason in result["reasons"]


@pytest.mark.parametrize("raw,reason", [("{", "archive_json_invalid"), ("[]", "archive_shape_invalid"),
    ('{"x":NaN}', "nonfinite_json"), ('{"x":Infinity}', "nonfinite_json"), ('{"x":1e999}', "nonfinite_json"),
    ('{"x":1,"x":2}', "duplicate_json_key")])
def test_strict_finite_json_and_duplicate_keys_never_echo_input(subject, raw, reason):
    response = subject[0].post(path(subject) + "/preflight", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 200 and response.json()["reasons"] == [reason]
    assert "archive_json" not in response.json()
    json.dumps(response.json(), allow_nan=False)


def test_stream_size_and_media_type_are_enforced_before_json_parsing(subject, monkeypatch):
    monkeypatch.setattr(archive, "MAX_BYTES", 100)
    response = subject[0].post(path(subject) + "/preflight", content=b"x" * 101, headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and response.json()["detail"]["code"] == "archive_size_limit"
    assert subject[0].post(path(subject) + "/preflight", content="{}").status_code == 415


def test_nested_cell_checksum_and_canonical_receipt_fingerprints_are_independent(subject):
    save(subject)
    value = export(subject)
    value["records"][0]["record"]["payload_json"]["content"] += " "
    resign(value)
    result = preflight(subject, value)
    assert "cell_checksum_mismatch" in result["records"][0]["reasons"]
    value = export(subject)
    record = value["records"][0]["record"]
    payload = json.loads(record["payload_json"]["content"])
    payload["evidence"]["input_revision"] = "synthetic:changed"
    record["payload_json"] = cell(receipts._json(payload))
    resign(value)
    assert "receipt_content_changed" in preflight(subject, value)["records"][0]["reasons"]


def test_duplicate_archive_identity_and_conflicting_local_identity_are_blocked(subject):
    save(subject)
    value = export(subject)
    value["records"].append(copy.deepcopy(value["records"][0]))
    value["coverage"] = {"account_total": 2, "exported": 2, "complete_set": True, "raw_complete": 2, "integrity_available": 2, "integrity_unavailable": 0}
    resign(value)
    result = preflight(subject, value)
    assert "duplicate_archive_identity" in result["records"][1]["reasons"]
    value = export(subject)
    with store.connect() as db:
        db.execute("UPDATE allocation_research_receipts SET created_at='synthetic-different-time'")
    result = preflight(subject, value)
    assert result["records"][0]["duplicate"] == "conflicting_local_identity"
    assert "local_identity_conflict" in result["records"][0]["reasons"]


def test_stale_sources_remain_structurally_compatible_without_rebuilding(subject):
    save(subject)
    value = export(subject)
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[1]["id"],))
        db.execute("UPDATE bars SET adj_close=adj_close+1")
    result = preflight(subject, value)
    assert result["verdict"] == "compatible" and result["records"][0]["currentness"]["current"] is False
    assert {"account_context_changed", "inputs_changed"}.issubset(result["records"][0]["currentness"]["reasons"])
    assert result["records"][0]["archived_currentness"]["current"] is True
    assert result["snapshot_currentness"] == {"current": False, "reasons": ["account_version_changed", "inputs_changed"]}


def test_unknown_future_receipt_method_is_preserved_but_not_compatible(subject):
    save(subject)
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM allocation_research_receipts").fetchone())
        payload = json.loads(row["payload_json"])
        payload["engine_version"] = "alphaview-allocation-research-receipt-v99"
        db.execute("UPDATE allocation_research_receipts SET engine_version=?,payload_json=?,content_fingerprint=?",
                   (payload["engine_version"], receipts._json(payload), receipts._hash(payload)))
    value = export(subject)
    assert value["records"][0]["integrity"]["available"] is True
    result = preflight(subject, value)
    assert result["verdict"] == "blocked" and "receipt_method_unsupported" in result["records"][0]["reasons"]


def test_unknown_accounts_are_404_and_empty_archives_are_complete(subject):
    value = export(subject)
    assert value["coverage"]["account_total"] == 0 and value["coverage"]["complete_set"] is True
    assert preflight(subject, value)["verdict"] == "compatible"
    missing = path(subject).replace(subject[1]["id"], "synthetic-missing")
    assert subject[0].get(missing).status_code == 404
    assert subject[0].post(missing + "/preflight", json=value).status_code == 404


def test_export_count_cap_refuses_whole_bundle_and_existing_retention_unchanged(subject, monkeypatch):
    save(subject)
    monkeypatch.setattr(receipts, "MAX_ACCOUNT", 0)
    response = subject[0].get(path(subject))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "archive_count_limit"
    assert receipts.MAX_TOTAL == 500


def test_export_snapshot_keeps_account_context_consistent_during_concurrent_change(subject, monkeypatch):
    save(subject)
    original = archive._bounded_rows
    def update_account():
        with store.connect() as db:
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[1]["id"],))
    def rows_then_change(db, account_id):
        values = original(db, account_id)
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(update_account).result(timeout=10)
        return values
    monkeypatch.setattr(archive, "_bounded_rows", rows_then_change)
    value = export(subject)
    assert value["account_version"] == subject[1]["version"]
    assert value["records"][0]["currentness"]["current"] is True
    assert preflight(subject, value)["records"][0]["currentness"]["current"] is False


def test_foreign_archive_never_looks_up_other_account_currentness(subject, monkeypatch):
    save(subject)
    value = export(subject)
    other = paper.create_account(paper.AccountInput(name="Synthetic other", initial_cash=1000., idempotency_key="synthetic-archive-other"))["account"]
    original = archive._currentness
    def no_foreign(db, payload):
        if payload is not None:
            assert payload["account_context"]["account_id"] == other["id"]
        return original(db, payload)
    monkeypatch.setattr(archive, "_currentness", no_foreign)
    response = subject[0].post(path(subject).replace(subject[1]["id"], other["id"]) + "/preflight", json=value)
    assert response.status_code == 200
    result = response.json()
    assert result["verdict"] == "blocked" and "archive_account_mismatch" in result["reasons"]
    assert result["records"][0]["currentness"] == {"current": None, "reasons": ["account_not_compatible"]}


def test_nested_duplicate_json_keys_are_preserved_on_export_but_unverifiable(subject):
    saved = save(subject)
    with store.connect() as db:
        raw = db.execute("SELECT payload_json FROM allocation_research_receipts").fetchone()[0]
        db.execute("UPDATE allocation_research_receipts SET payload_json=?", ('{"engine_version":"synthetic",' + raw[1:],))
    value = export(subject)
    assert value["records"][0]["id"] == saved["id"] and value["records"][0]["integrity"]["available"] is False
    assert preflight(subject, value)["verdict"] == "blocked"


def test_forged_request_shape_cannot_become_compatible_by_rehashing_identity(subject):
    save(subject)
    with store.connect() as db:
        request = json.loads(db.execute("SELECT request_json FROM allocation_research_receipts").fetchone()[0])
        request["request"]["lookback_sessions"] = 25
        db.execute("UPDATE allocation_research_receipts SET id=?,request_json=?", (receipts._hash(request), receipts._json(request)))
    value = export(subject)
    assert value["records"][0]["integrity"]["available"] is True
    result = preflight(subject, value)
    assert "receipt_request_shape_invalid" in result["records"][0]["reasons"]


def test_oversized_encoded_export_refuses_whole_archive_and_no_write_routes_exist(subject, monkeypatch):
    save(subject)
    monkeypatch.setattr(archive, "MAX_BYTES", 100)
    response = subject[0].get(path(subject))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "archive_size_limit"
    assert subject[0].delete(path(subject)).status_code == 405
    assert subject[0].post(path(subject), json={}).status_code == 405


def test_fifty_rows_export_as_full_set_and_fifty_one_upload_is_rejected(subject):
    save(subject)
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM allocation_research_receipts").fetchone())
        for index in range(49):
            copy_row = {**row, "id": f"synthetic-full-{index:02}"}
            db.execute("INSERT INTO allocation_research_receipts VALUES (?,?,?,?,?,?,?,?)", tuple(copy_row[key] for key in archive.COLUMNS))
    value = export(subject)
    assert value["coverage"]["account_total"] == value["coverage"]["exported"] == 50
    result = preflight(subject, value)
    assert result["capacity"]["account_used"] == 50 and result["capacity"]["account_remaining"] == 0
    value["records"].append(copy.deepcopy(value["records"][0]))
    resign(value)
    assert preflight(subject, value)["reasons"] == ["archive_count_limit"]
