"""Portable prefix archives use only synthetic local receipts and preserve corruption."""
import base64
import copy
import json
import math
import sqlite3
import struct

import pytest

from alphaview.panel import research_integrity_archive as archive, research_integrity_receipts as receipts
from alphaview.panel import research_integrity as integrity, research_desk as desk, store
from tests.test_research_integrity_receipts import workspace, prepare, save  # noqa: F401


@pytest.fixture
def sample(workspace):
    client, days = workspace
    client.app.include_router(archive.router)
    body, _ = prepare(client)
    saved = save(client, body)
    return client, days, saved


def get(client, symbol="SYNTA"):
    return client.get(archive.BASE, params={"symbol": symbol})


def check(client, value, symbol="SYNTA"):
    raw = receipts._json(value) if not isinstance(value, (str, bytes)) else value
    return client.post(archive.BASE + "/preflight", params={"symbol": symbol}, content=raw, headers={"Content-Type": "application/json"})


def state():
    with store.connect() as db:
        return list(db.execute("SELECT id,typeof(payload_json),hex(CAST(payload_json AS BLOB)),hex(CAST(request_json AS BLOB)) FROM research_integrity_receipts ORDER BY rowid"))


def rehash(value):
    for item in value["records"]:
        item["row_checksum"] = receipts._hash(item["record"])
    value["set_fingerprint"] = archive._set_hash([item["record"] for item in value["records"]])
    value["checksum"] = receipts._hash({key: item for key, item in value.items() if key != "checksum"})
    return value


def clone(identifier, *, new_id, symbol="SYNTA", payload=None):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM research_integrity_receipts WHERE id=?", (identifier,)).fetchone())
        row.update(id=new_id, symbol=symbol)
        if payload is not None: row["payload_json"] = payload
        db.execute("INSERT INTO research_integrity_receipts VALUES (?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))


def test_complete_canonical_archive_and_preflight_readonly_without_recompute(sample, monkeypatch):
    client, _, saved = sample
    before, revision = state(), store.input_revision()
    monkeypatch.setattr(integrity, "inspect_integrity", lambda *a: pytest.fail("No diagnostic recompute"))
    monkeypatch.setattr(desk, "Series", lambda *a: pytest.fail("No history or indicator rebuild"))
    original = archive._read_rows
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM research_integrity_receipts")
        return original(db, *args)
    monkeypatch.setattr(archive, "_read_rows", readonly)
    response = get(client)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["coverage"] == {"symbol_total": 1, "exported": 1, "raw_complete": 1, "verified": 1, "unavailable": 0, "complete_set": True}
    assert response.content == receipts._json(value).encode() and response.headers["cache-control"] == "no-store"
    assert value["checksum"] == receipts._hash({key: item for key, item in value.items() if key != "checksum"})
    assert value["records"][0]["record"]["payload_json"]["content"] == receipts._json(saved["receipt"])
    result = check(client, response.content).json()
    assert result["compatible"], result
    assert result["records"][0]["duplicate"] == "identical_locally"
    assert result["records"][0]["diagnostic_status"] == "no_difference_detected"
    assert result["policy"] == archive.POLICY and state() == before and store.input_revision() == revision


def test_entire_symbol_set_is_not_twenty_row_page_and_other_symbols_are_excluded(sample):
    client, _, saved = sample
    for index in range(24): clone(saved["id"], new_id=f"{index:064x}")
    clone(saved["id"], new_id="f" * 64, symbol="SYNTB")
    result = get(client).json()
    assert result["coverage"]["symbol_total"] == result["coverage"]["exported"] == result["coverage"]["raw_complete"] == 25
    assert result["coverage"]["verified"] == 1 and result["coverage"]["unavailable"] == 24
    assert all(item["record"]["symbol"]["content"] == "SYNTA" for item in result["records"])
    assert not check(client, result).json()["compatible"]


@pytest.mark.parametrize("case", ["json", "blob", "invalid_utf8_text", "null_id", "blob_symbol"])
def test_opaque_cells_are_lossless_and_never_compatible_even_identical_locally(sample, case):
    client, _, saved = sample
    with store.connect() as db:
        if case == "json": db.execute("UPDATE research_integrity_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
        if case == "blob": db.execute("UPDATE research_integrity_receipts SET payload_json=? WHERE id=?", (b"\xff\x00broken", saved["id"]))
        if case == "invalid_utf8_text": db.execute("UPDATE research_integrity_receipts SET payload_json=CAST(x'ff00fe' AS TEXT) WHERE id=?", (saved["id"],))
        if case == "null_id": db.execute("UPDATE research_integrity_receipts SET id=NULL WHERE id=?", (saved["id"],))
        if case == "blob_symbol": db.execute("UPDATE research_integrity_receipts SET symbol=? WHERE id=?", (b"SYNTA", saved["id"]))
    value = get(client).json()
    assert value["coverage"]["raw_complete"] == 1 and value["coverage"]["verified"] == 0
    entry = value["records"][0]
    if case == "blob":
        cell = entry["record"]["payload_json"]
        assert cell["storage_type"] == "blob" and base64.b64decode(cell["content"]) == b"\xff\x00broken"
    if case == "invalid_utf8_text":
        cell = entry["record"]["payload_json"]
        assert cell["storage_type"] == "text" and cell["encoding"] == "base64" and base64.b64decode(cell["content"]) == b"\xff\x00\xfe"
    if case == "null_id": assert entry["record"]["id"]["storage_type"] == "null" and entry["record"]["id"]["content"] is None
    result = check(client, value).json()
    assert result["compatible"] is False and result["records"][0]["integrity"]["available"] is False
    entry["integrity"] = {"available": True, "reason": None}
    value["coverage"].update(verified=1, unavailable=0)
    forged = check(client, rehash(value)).json()
    assert not forged["compatible"] and "archive_integrity_label_mismatch" in forged["records"][0]["reasons"]


@pytest.mark.parametrize("kind,raw,number", [("integer", b"-9223372036854775808", None), ("real", None, -0.), ("real", None, float("inf")), ("null", None, None)])
def test_typed_numeric_and_null_codec_retains_exact_type_and_bytes(kind, raw, number):
    record = {key: archive._cell("text", b"synthetic") for key in archive.COLUMNS}
    record["id"] = archive._cell(kind, raw, number)
    value, reasons = archive._decode_cells(record)
    assert reasons == []
    if kind == "real": assert base64.b64decode(record["id"]["content"]) == struct.pack(">d", number)
    if kind == "integer": assert value["id"] == -(2 ** 63)
    if kind == "null": assert value["id"] is None
    assert archive._verify(record)[1] is None
    json.dumps(record, allow_nan=False)


def test_unavailable_diagnostic_remains_compatible_without_becoming_success(sample):
    client, _, _ = sample
    body, _ = prepare(client, symbol="SYNTZ")
    save(client, body)
    value = get(client, "SYNTZ").json()
    assert value["records"][0]["integrity"]["available"]
    report = check(client, value, "SYNTZ").json()
    assert report["compatible"] and report["records"][0]["diagnostic_status"] == "unavailable"


@pytest.mark.parametrize("raw,reason", [(b'{"engine_version":1,"engine_version":2}', "duplicate_json_key"), (b'{"x":NaN}', "nonfinite_json"), (b'{"x":1e999}', "nonfinite_json"), (b'\xff', "archive_json_invalid"), (b'{', "archive_json_invalid")])
def test_strict_utf8_json_preflight_is_visible_and_does_not_write(sample, raw, reason):
    client, _, _ = sample
    before = state()
    result = check(client, raw)
    assert result.status_code == 200 and result.json()["compatible"] is False and reason in result.json()["reasons"]
    assert state() == before


def test_checksum_cell_rehash_duplicate_ids_scope_versions_and_local_conflicts_block(sample):
    client, _, saved = sample
    original = get(client).json()
    bad = copy.deepcopy(original); bad["checksum"] = "f" * 64
    assert "archive_checksum_mismatch" in check(client, bad).json()["reasons"]
    bad = copy.deepcopy(original); bad["records"][0]["record"]["payload_json"]["sha256"] = "f" * 64
    assert not check(client, rehash(bad)).json()["compatible"]
    bad = copy.deepcopy(original); bad["schema_version"] = 2
    assert "archive_version_unsupported" in check(client, bad).json()["reasons"]
    assert "archive_symbol_mismatch" in check(client, original, "SYNTB").json()["reasons"]
    bad = copy.deepcopy(original); bad["records"].append(copy.deepcopy(bad["records"][0]));bad["records"][1]["ordinal"] = 2
    bad["coverage"].update(symbol_total=2,exported=2,raw_complete=2,verified=2)
    report = check(client, rehash(bad)).json()
    assert not report["compatible"] and "archive_duplicate_identity" in report["records"][1]["reasons"]
    with store.connect() as db: db.execute("UPDATE research_integrity_receipts SET payload_json='{' WHERE id=?", (saved["id"],))
    report = check(client, original).json()
    assert "archive_local_identity_conflict" in report["records"][0]["reasons"]


def test_empty_single_symbol_and_explicit_scope_required(sample):
    client, _, _ = sample
    value = get(client, "EMPTY").json()
    assert value["coverage"]["exported"] == 0 and check(client, value, "EMPTY").json()["compatible"]
    for params in ({}, {"symbol": ""}, {"symbol": "SYNTA,SYNTB"}, {"symbol": "syntA"}):
        assert client.get(archive.BASE, params=params).status_code == 422
    assert client.post(archive.BASE + "/preflight?symbol=SYNTA", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post(archive.BASE + "/import?symbol=SYNTA", json=value).status_code == 404


def test_whole_archive_size_and_request_limits_refuse_without_partial_output(sample, monkeypatch):
    client, _, _ = sample
    original, before = get(client).content, state()
    monkeypatch.setattr(archive, "MAX_BYTES", 100)
    assert get(client).status_code == 413
    assert check(client, original).status_code == 413
    assert state() == before


def test_actual_difference_diagnostic_remains_difference_after_compatible_preflight(sample, monkeypatch):
    client, _, _ = sample
    original = desk.Series.rsi
    monkeypatch.setattr(desk.Series, "rsi", lambda series, period: original(series, period) + series.close[-1] / 1000)
    body, evidence = prepare(client)
    assert evidence["status"] == "differences_found"
    save(client, body)
    value = get(client).json()
    result = check(client, value).json()
    assert result["compatible"], result
    assert "differences_found" in [row["diagnostic_status"] for row in result["records"]]


@pytest.mark.parametrize("mutation", ["details", "window", "fields", "warnings"])
def test_rehashed_malformed_original_diagnostic_is_not_upgraded(sample, mutation):
    client, _, saved = sample
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM research_integrity_receipts WHERE id=?", (saved["id"],)).fetchone())
        payload, request = json.loads(row["payload_json"]), json.loads(row["request_json"])
        evidence = payload["evidence"]
        if mutation == "details":
            evidence["prefixes"][0]["difference_count"] = 1
            evidence["prefixes"][0]["status"] = "differences_found"
            evidence["counts"]["differences"] = 1
            evidence["status"] = "differences_found"
            evidence["differences"] = ["unverifiable"]
        if mutation == "window": evidence["window"] = {"start": "not-a-date"}
        if mutation == "fields": evidence["fields"] = {"rsi": "unverifiable"}
        if mutation == "warnings": evidence["warnings"] = [None]
        evidence["evidence_fingerprint"] = receipts._hash({key: item for key, item in evidence.items() if key != "evidence_fingerprint"})
        request["save_request"]["expected_evidence_fingerprint"] = evidence["evidence_fingerprint"]
        payload["receipt_id"] = receipts._hash(request)
        payload["source_context"] = receipts._source(evidence)
        db.execute("UPDATE research_integrity_receipts SET id=?,request_json=?,payload_json=?,content_fingerprint=? WHERE id=?",
            (payload["receipt_id"], receipts._json(request), receipts._json(payload), receipts._hash(payload), saved["id"]))
    value = get(client).json()
    assert value["coverage"]["raw_complete"] == 1 and value["coverage"]["verified"] == 0
    assert value["records"][0]["integrity"]["reason"] == "archive_diagnostic_shape_unsupported"
    assert not check(client, rehash(value)).json()["compatible"]


def test_workspace_capacity_counts_all_symbols_and_never_evicts(sample):
    client, _, saved = sample
    value = get(client).json()
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM research_integrity_receipts WHERE id=?", (saved["id"],)).fetchone())
        db.execute("DELETE FROM research_integrity_receipts")
        for index in range(500):
            row.update(id=f"{index:064x}", symbol="SYNTB")
            db.execute("INSERT INTO research_integrity_receipts VALUES (?,?,?,?,?,?,?)", tuple(row[key] for key in archive.COLUMNS))
    before = state()
    result = check(client, value).json()
    assert result["capacity"] == {"workspace_used": 500, "workspace_limit": 500, "remaining": 0,
        "absent_locally": 1, "unknown_identities": 0, "projected_total": 501, "automatic_deletion": False, "import_authorized": False}
    assert not result["compatible"] and "archive_workspace_capacity" in result["reasons"]
    assert state() == before
    clone("0" * 64, new_id="f" * 64, symbol="SYNTB")
    assert get(client).status_code == 413


def test_export_snapshot_retains_one_set_when_concurrent_receipt_added(sample, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    client, _, saved = sample
    original = archive._read_rows
    def read_then_change(db, *args):
        values = original(db, *args)
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(clone, saved["id"], new_id="e" * 64).result(timeout=10)
        return values
    monkeypatch.setattr(archive, "_read_rows", read_then_change)
    value = get(client).json()
    assert value["coverage"]["symbol_total"] == len(value["records"]) == 1
    monkeypatch.setattr(archive, "_read_rows", original)
    report = check(client, value).json()
    assert report["compatible"] and report["snapshot_currentness"] == {"current": False, "reasons": ["receipt_set_changed"]}
    assert get(client).json()["coverage"]["symbol_total"] == 2


def test_escaped_surrogate_envelope_is_blocked_instead_of_server_error(sample):
    client, _, _ = sample
    value = get(client).json()
    value["method"] = "\ud800"
    report = check(client, json.dumps(value, ensure_ascii=True)).json()
    assert not report["compatible"] and report["reasons"] == ["archive_json_invalid"]


@pytest.mark.parametrize("operation", ["export", "preflight"])
def test_session_transition_cannot_publish_mixed_currentness(sample, monkeypatch, operation):
    client, days, _ = sample
    value = get(client).json()
    count = 0
    def changed_session():
        nonlocal count
        count += 1
        return days[-1] if count == 1 else "2099-01-01"
    monkeypatch.setattr(archive.sessions, "latest_completed_session", changed_session)
    response = get(client) if operation == "export" else check(client, value)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "integrity_archive_session_changed"
