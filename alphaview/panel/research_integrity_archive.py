"""One-symbol portable typed-cell archives and read-only compatibility preflight."""
import base64
from datetime import date, datetime
import re
import struct
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import allocation_receipt_archive as strict_json
from . import research_desk as desk, research_integrity as integrity, research_integrity_receipts as receipts
from . import sessions, store

ENGINE_VERSION = "alphaview-research-integrity-archive-v1"
SCHEMA_VERSION, MAX_BYTES = 1, 32 * 1024 * 1024
BASE = "/api/research-desk/integrity-receipt-archive"
COLUMNS = ("id", "symbol", "created_at", "engine_version", "request_json", "content_fingerprint", "payload_json")
SYMBOL = r"^[A-Z][A-Z0-9.-]{0,9}$"
HASH = r"^[a-f0-9]{64}$"
POLICY = {"read_only": True, "import_authorized": False, "restore_authorized": False, "delete_authorized": False, "execution_source": False}
CANONICAL = "python-json-sort-keys-utf8-finite-v1"
METHOD = (
    "One explicit symbol only, with membership defined by exact stored symbol bytes equal to its ASCII spelling. "
    "Capture the entire symbol set before pagination in one query-only snapshot. Preserve every SQLite cell's "
    "storage type and exact content, including opaque corrupt JSON, BLOB and invalid UTF-8 TEXT, without replacement "
    "characters. INTEGER uses canonical decimal, REAL uses big-endian IEEE754 bytes, NULL is explicit. Each cell "
    "has a byte hash, each typed row has a checksum, and the complete canonical archive has a checksum. "
    "These hashes do not by themselves verify receipt evidence. Recheck strict JSON, saved request, original "
    "receipt bindings and understood diagnostic shape; opaque or conflicting rows are incompatible even if "
    "identical locally. Currentness is separate; valid unavailable or differences-found diagnostics retain "
    "their original status. At most 500 workspace receipts and 32 MiB for a complete symbol archive; reject "
    "overflow without dropping or withholding cells. Preflight is read-only compatibility information, not "
    "restoration, import, deletion, recomputation, diagnostic success or execution authorization."
)


def _reply(value, status=200):
    return Response(receipts._json(value), status_code=status, media_type="application/json", headers={"Cache-Control": "no-store"})


def _problem(code, status=413):
    return receipts._problem(code, code, status)


class _BoundedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def bounded(request):
            if request.method == "POST":
                if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    return _reply({"detail": {"code": "integrity_archive_media_type"}}, 415)
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        return _reply({"detail": {"code": "integrity_archive_size_limit"}}, 413)
                    chunks.append(chunk)
                request.state.integrity_archive_bytes = b"".join(chunks)
            return await handler(request)
        return bounded


router = APIRouter(route_class=_BoundedRoute)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Cell(Strict):
    storage_type: Literal["text", "blob", "integer", "real", "null"]
    encoding: Literal["utf-8", "base64", "integer-decimal", "ieee754-base64", "null"]
    byte_length: int = Field(ge=0, le=MAX_BYTES)
    sha256: str = Field(pattern=HASH)
    content: str | None


class Verification(Strict):
    available: bool
    reason: str | None


class Currentness(Strict):
    current: bool | None
    reasons: list[str] = Field(max_length=30)


class Entry(Strict):
    ordinal: int = Field(ge=1, le=500)
    id: str | None = Field(max_length=64)
    content_fingerprint: str | None = Field(max_length=64)
    record: dict[str, Cell]
    row_checksum: str = Field(pattern=HASH)
    integrity: Verification
    diagnostic_status: str | None = Field(max_length=100)
    currentness: Currentness


class Coverage(Strict):
    symbol_total: int = Field(ge=0, le=500)
    exported: int = Field(ge=0, le=500)
    raw_complete: int = Field(ge=0, le=500)
    verified: int = Field(ge=0, le=500)
    unavailable: int = Field(ge=0, le=500)
    complete_set: Literal[True]


class Retention(Strict):
    workspace_limit: Literal[500]
    max_original_payload_bytes: Literal[262144]
    max_archive_bytes: Literal[33554432]
    automatic_deletion: Literal[False]


class Policy(Strict):
    read_only: Literal[True]
    import_authorized: Literal[False]
    restore_authorized: Literal[False]
    delete_authorized: Literal[False]
    execution_source: Literal[False]


class Archive(Strict):
    engine_version: str = Field(max_length=100)
    schema_version: int = Field(ge=1)
    archive_kind: Literal["symbol_sampled_prefix_receipts"]
    canonicalization: Literal["python-json-sort-keys-utf8-finite-v1"]
    columns: list[str] = Field(min_length=7, max_length=7)
    symbol: str = Field(pattern=SYMBOL)
    as_of: str = Field(min_length=10, max_length=10)
    input_revision: str = Field(min_length=1, max_length=200)
    exported_at: str = Field(max_length=100)
    method: str = Field(max_length=5000)
    records: list[Entry] = Field(max_length=500)
    coverage: Coverage
    retention: Retention
    policy: Policy
    set_fingerprint: str = Field(pattern=HASH)
    checksum: str = Field(pattern=HASH)


def _cell(kind, raw, number=None):
    if kind == "null":
        raw, encoding, content = b"", "null", None
    elif kind == "real":
        raw = struct.pack(">d", number)
        encoding, content = "ieee754-base64", base64.b64encode(raw).decode("ascii")
    elif kind == "integer":
        raw = str(int(raw.decode("ascii"))).encode("ascii")
        encoding, content = "integer-decimal", raw.decode("ascii")
    elif kind == "text":
        try:
            content, encoding = raw.decode("utf-8", errors="strict"), "utf-8"
        except UnicodeError:
            content, encoding = base64.b64encode(raw).decode("ascii"), "base64"
    else:
        content, encoding = base64.b64encode(raw).decode("ascii"), "base64"
    return {"storage_type": kind, "encoding": encoding, "byte_length": len(raw),
            "sha256": strict_json._hash_bytes(raw), "content": content}


def _read_rows(db, where, args):
    sizes = [f"CASE WHEN typeof({key})='real' THEN 8 ELSE COALESCE(length(CAST({key} AS BLOB)),0) END" for key in COLUMNS]
    size = db.execute(f"SELECT COALESCE(SUM({'+'.join(sizes)}),0) FROM research_integrity_receipts WHERE {where}", args).fetchone()[0]
    if size > MAX_BYTES:
        raise _problem("integrity_archive_size_limit")
    fields = []
    for key in COLUMNS:
        fields.extend((f"typeof({key}) AS {key}_type", f"CAST({key} AS BLOB) AS {key}_raw",
                       f"CASE WHEN typeof({key})='real' THEN {key} ELSE NULL END AS {key}_real"))
    rows = db.execute(f"SELECT {','.join(fields)} FROM research_integrity_receipts WHERE {where} ORDER BY created_at,id,rowid", args).fetchall()
    return [{key: _cell(row[key + "_type"], row[key + "_raw"], row[key + "_real"]) for key in COLUMNS} for row in rows]


def _decode_cells(record):
    if set(record) != set(COLUMNS):
        return None, ["archive_record_columns_invalid"]
    row, reasons = {}, []
    for key, cell in record.items():
        try:
            kind, encoding, content = cell["storage_type"], cell["encoding"], cell["content"]
            if kind == "null" and encoding == "null" and content is None:
                raw, value = b"", None
            elif kind == "text" and encoding == "utf-8" and isinstance(content, str):
                raw, value = content.encode("utf-8"), content
            elif kind in ("text", "blob") and encoding == "base64" and isinstance(content, str):
                raw = base64.b64decode(content, validate=True)
                if base64.b64encode(raw).decode("ascii") != content:
                    raise ValueError("noncanonical_base64")
                value = raw
                if kind == "text":
                    try:
                        value = raw.decode("utf-8", errors="strict")
                        raise ValueError("text_requires_utf8_encoding")
                    except UnicodeError:
                        pass
            elif kind == "integer" and encoding == "integer-decimal" and isinstance(content, str):
                if not re.fullmatch(r"0|-?[1-9][0-9]{0,18}", content):
                    raise ValueError("invalid_integer")
                value = int(content)
                if not -(2 ** 63) <= value < 2 ** 63:
                    raise ValueError("integer_range")
                raw = content.encode("ascii")
            elif kind == "real" and encoding == "ieee754-base64" and isinstance(content, str):
                raw = base64.b64decode(content, validate=True)
                if len(raw) != 8 or base64.b64encode(raw).decode("ascii") != content:
                    raise ValueError("invalid_real")
                value = struct.unpack(">d", raw)[0]
            else:
                raise ValueError("type_encoding_mismatch")
            if cell["byte_length"] != len(raw) or cell["sha256"] != strict_json._hash_bytes(raw):
                reasons.append("archive_cell_checksum_mismatch")
            else:
                row[key] = value
        except (ValueError, UnicodeError, TypeError, KeyError, OverflowError, struct.error):
            reasons.append("archive_cell_encoding_invalid")
    return (row if not reasons else None), sorted(set(reasons))


def _integer(value):
    return type(value) is int and value >= 0


def _shape(evidence, body):
    try:
        def valid_date(value):
            return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
        fields = evidence["fields"]
        if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields) or len(fields) != len(set(fields)):
            return False
        if not isinstance(evidence["warnings"], list) or any(not isinstance(warning, str) for warning in evidence["warnings"]):
            return False
        window = evidence["window"]
        if window is not None and (not isinstance(window, dict) or set(window) != {"start", "end", "sessions", "history_sessions"}
                or not valid_date(window["end"]) or (window["start"] is not None and not valid_date(window["start"]))
                or not _integer(window["sessions"]) or not _integer(window["history_sessions"])):
            return False
        counts, prefixes = evidence["counts"], evidence["prefixes"]
        names = ("prefixes", "compared_session_pairs", "compared_values", "differences", "unavailable_values", "invalid_signal_sessions")
        if set(counts) != set(names) or not all(_integer(counts[key]) for key in names):
            return False
        if not isinstance(prefixes, list) or len(prefixes) > body.request.max_prefixes or counts["prefixes"] != len(prefixes):
            return False
        mapping = {"compared_session_pairs": "compared_sessions", "compared_values": "compared_values", "differences": "difference_count",
                   "unavailable_values": "unavailable_values", "invalid_signal_sessions": "invalid_signal_sessions"}
        for prefix in prefixes:
            if not isinstance(prefix, dict) or not all(_integer(prefix.get(key)) for key in (*mapping.values(), "history_sessions")):
                return False
            expected = "differences_found" if prefix["difference_count"] else "unavailable" if prefix["unavailable_values"] or prefix["invalid_signal_sessions"] else "no_difference_detected"
            if prefix.get("status") != expected or prefix["compared_sessions"] < integrity.MIN_COMPARED_SESSIONS:
                return False
            for key in ("cutoff_date", "compared_start"):
                if date.fromisoformat(prefix[key]).isoformat() != prefix[key]:
                    return False
        if any(counts[key] != sum(prefix[source] for prefix in prefixes) for key, source in mapping.items()):
            return False
        for key in ("differences", "unavailable_values"):
            details = evidence[key]
            if not isinstance(details, list) or len(details) > min(integrity.MAX_DETAILS, counts[key]):
                return False
            if type(evidence[key + "_truncated"]) is not bool or evidence[key + "_truncated"] != (counts[key] > len(details)):
                return False
            names = {"prefix_end", "date", "field", "before", "after"} | ({"code"} if key == "unavailable_values" else set())
            for detail in details:
                if not isinstance(detail, dict) or set(detail) != names or detail["field"] not in fields:
                    return False
                if not valid_date(detail["prefix_end"]) or not valid_date(detail["date"]):
                    return False
                if any(detail[item] is not None and type(detail[item]) not in (int, float, bool) for item in ("before", "after")):
                    return False
                if key == "unavailable_values" and detail["code"] != "nonfinite_output":
                    return False
        if not isinstance(evidence["unavailable"], list) or any(not isinstance(item, dict) or set(item) != {"code", "message"}
                or not isinstance(item["code"], str) or not isinstance(item["message"], str) for item in evidence["unavailable"]):
            return False
        if (counts["unavailable_values"] or counts["invalid_signal_sessions"]) and not evidence["unavailable"]:
            return False
        expected = "differences_found" if counts["differences"] else "unavailable" if evidence["unavailable"] or not prefixes else "no_difference_detected"
        limits = {"max_history_bars": integrity.MAX_HISTORY_BARS, "max_prefixes": body.request.max_prefixes,
            "min_compared_sessions": integrity.MIN_COMPARED_SESSIONS, "max_details": integrity.MAX_DETAILS,
            "numeric_rtol": integrity.RTOL, "numeric_atol": integrity.ATOL}
        return evidence["status"] == expected and evidence["limits"] == limits
    except (ValueError, KeyError, TypeError, OverflowError):
        return False


def _verify(record):
    row, reasons = _decode_cells(record)
    if row is None:
        return None, None, reasons[0]
    if not all(isinstance(row[key], str) for key in COLUMNS):
        return row, None, "archive_receipt_nontext"
    try:
        saved = strict_json._loads(row["request_json"])
        strict_json._loads(row["payload_json"])
        if set(saved) != {"engine_version", "save_request"} or len(row["request_json"].encode()) > 16384:
            return row, None, "archive_saved_request_invalid"
        body = receipts.SaveInput.model_validate(saved["save_request"])
        if saved["save_request"] != body.model_dump():
            return row, None, "archive_saved_request_invalid"
        payload, issue = receipts._decode(row)
        if payload is None:
            return row, None, issue
        if not _shape(payload["evidence"], body):
            return row, None, "archive_diagnostic_shape_unsupported"
        return row, payload, None
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError, ValidationError):
        return row, None, "archive_receipt_unverifiable"


def _currentness(db, payload):
    try:
        return receipts._currentness(db, payload)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return {"current": None, "reasons": ["archive_context_unverifiable"]}


def _metadata(row, key):
    value = row.get(key) if row else None
    return value if isinstance(value, str) and len(value) <= 64 else None


def _entry(db, record, ordinal):
    row, payload, issue = _verify(record)
    return {"ordinal": ordinal, "id": _metadata(row, "id"), "content_fingerprint": _metadata(row, "content_fingerprint"),
        "record": record, "row_checksum": receipts._hash(record), "integrity": {"available": payload is not None, "reason": issue},
        "diagnostic_status": payload["evidence"]["status"] if payload else None, "currentness": _currentness(db, payload)}


def _set_hash(records):
    return receipts._hash(sorted(receipts._hash(record) for record in records))


@router.get(BASE)
@store.snapshot_read
def export_archive(symbol: str = Query(pattern=SYMBOL)):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        total = db.execute("SELECT COUNT(*) FROM research_integrity_receipts").fetchone()[0]
        if total > receipts.MAX_TOTAL:
            raise _problem("integrity_archive_count_limit")
        records = _read_rows(db, "CAST(symbol AS BLOB)=?", (symbol.encode("ascii"),))
        entries = [_entry(db, record, index + 1) for index, record in enumerate(records)]
        verified = sum(item["integrity"]["available"] for item in entries)
        value = {"engine_version": ENGINE_VERSION, "schema_version": SCHEMA_VERSION, "archive_kind": "symbol_sampled_prefix_receipts",
            "canonicalization": CANONICAL, "columns": list(COLUMNS), "symbol": symbol, "as_of": as_of,
            "input_revision": store.input_revision(db), "exported_at": store.now(), "method": METHOD, "records": entries,
            "coverage": {"symbol_total": len(entries), "exported": len(entries), "raw_complete": len(entries), "verified": verified,
                "unavailable": len(entries) - verified, "complete_set": True},
            "retention": {"workspace_limit": receipts.MAX_TOTAL, "max_original_payload_bytes": receipts.MAX_BYTES,
                "max_archive_bytes": 33554432, "automatic_deletion": False}, "policy": dict(POLICY), "set_fingerprint": _set_hash(records)}
        value["checksum"] = receipts._hash(value)
        encoded = receipts._json(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("integrity_archive_size_limit")
        if sessions.latest_completed_session() != as_of:
            raise _problem("integrity_archive_session_changed", 409)
        return Response(encoded, media_type="application/json", headers={"Cache-Control": "no-store"})


def _preflight(db, symbol, raw):
    total = db.execute("SELECT COUNT(*) FROM research_integrity_receipts").fetchone()[0]
    base = {"engine_version": ENGINE_VERSION, "symbol": symbol, "as_of": sessions.latest_completed_session(),
        "input_revision": store.input_revision(db), "checked_at": store.now(), "compatible": False, "verdict": "blocked",
        "archive_checksum": None, "reasons": [], "records": [], "policy": dict(POLICY), "method": METHOD,
        "coverage": {"declared": None, "checked": 0, "compatible": 0, "unavailable": None}, "capacity": None,
        "archive_context": None, "snapshot_currentness": {"current": None, "reasons": ["archive_unverifiable"]}}
    try:
        archive = strict_json._loads(raw.decode("utf-8", errors="strict"))
        pending = [archive]
        while pending:
            item = pending.pop()
            if isinstance(item, str):
                item.encode("utf-8", errors="strict")
            elif isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
    except (ValueError, UnicodeError, TypeError, OverflowError, RecursionError) as error:
        code = str(error) if str(error) in ("duplicate_json_key", "nonfinite_json") else "archive_json_invalid"
        return {**base, "reasons": [code]}
    if not isinstance(archive, dict):
        return {**base, "reasons": ["archive_shape_invalid"]}
    if archive.get("engine_version") != ENGINE_VERSION or type(archive.get("schema_version")) is not int or archive["schema_version"] != SCHEMA_VERSION:
        return {**base, "reasons": ["archive_version_unsupported"]}
    try:
        Archive.model_validate(archive)
        if date.fromisoformat(archive["as_of"]).isoformat() != archive["as_of"] or datetime.fromisoformat(archive["exported_at"]).utcoffset() is None:
            raise ValueError("invalid_date")
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        return {**base, "reasons": ["archive_shape_invalid"]}
    entries, reasons = archive["records"], []
    if archive["columns"] != list(COLUMNS): reasons.append("archive_record_columns_invalid")
    if archive["checksum"] != receipts._hash({key: value for key, value in archive.items() if key != "checksum"}): reasons.append("archive_checksum_mismatch")
    if archive["symbol"] != symbol: reasons.append("archive_symbol_mismatch")
    expected = {"symbol_total": len(entries), "exported": len(entries), "raw_complete": len(entries),
        "verified": sum(item["integrity"]["available"] for item in entries),
        "unavailable": sum(not item["integrity"]["available"] for item in entries), "complete_set": True}
    if archive["coverage"] != expected or [entry["ordinal"] for entry in entries] != list(range(1, len(entries) + 1)):
        reasons.append("archive_coverage_mismatch")
    if archive["set_fingerprint"] != _set_hash([entry["record"] for entry in entries]): reasons.append("archive_set_fingerprint_mismatch")
    parsed = [_verify(entry["record"]) for entry in entries]
    ids = {row["id"] for row, _, _ in parsed if row and isinstance(row["id"], str) and re.fullmatch(HASH, row["id"])}
    local_records, local_limit = [], False
    if ids:
        try:
            local_records = _read_rows(db, f"CAST(id AS BLOB) IN ({','.join('?' for _ in ids)})", tuple(identifier.encode("ascii") for identifier in sorted(ids)))
        except HTTPException as error:
            if error.status_code != 413: raise
            local_limit = True
            reasons.append("archive_local_set_size_limit")
    local = {}
    for record in local_records:
        identifier = record["id"]
        if identifier["encoding"] == "utf-8": key = identifier["content"]
        elif identifier["encoding"] == "base64":
            try: key = base64.b64decode(identifier["content"]).decode("ascii")
            except (UnicodeError, ValueError): continue
        else: continue
        local.setdefault(key, []).append(record)
    seen, results = set(), []
    for entry, (row, payload, issue) in zip(entries, parsed):
        problems, duplicate = [], "unverifiable"
        if entry["row_checksum"] != receipts._hash(entry["record"]): problems.append("archive_row_checksum_mismatch")
        if issue: problems.append(issue)
        if entry["integrity"] != {"available": payload is not None, "reason": issue}: problems.append("archive_integrity_label_mismatch")
        if entry["diagnostic_status"] != (payload["evidence"]["status"] if payload else None): problems.append("archive_diagnostic_label_mismatch")
        if row is not None:
            identifier = row["id"]
            if not isinstance(identifier, str) or not re.fullmatch(HASH, identifier): problems.append("archive_receipt_identity_invalid")
            elif identifier in seen: problems.append("archive_duplicate_identity")
            else:
                seen.add(identifier)
                if not local_limit:
                    matches = local.get(identifier, [])
                    duplicate = "absent_locally" if not matches else "identical_locally" if len(matches) == 1 and matches[0] == entry["record"] else "conflicting_local_identity"
                    if duplicate == "conflicting_local_identity": problems.append("archive_local_identity_conflict")
            if row["symbol"] != symbol: problems.append("archive_receipt_symbol_mismatch")
            if entry["id"] != _metadata(row, "id") or entry["content_fingerprint"] != _metadata(row, "content_fingerprint"):
                problems.append("archive_entry_identity_mismatch")
        if payload:
            for actual, supported, code in ((payload["engine_version"], receipts.ENGINE_VERSION, "archive_receipt_method_unsupported"),
                (payload["evidence"]["engine_version"], integrity.ENGINE_VERSION, "archive_integrity_method_unsupported"),
                (payload["evidence"]["desk_engine_version"], desk.ENGINE_VERSION, "archive_desk_method_unsupported")):
                if actual != supported: problems.append(code)
        results.append({"ordinal": entry["ordinal"], "id": entry["id"], "compatible": not problems and not local_limit,
            "reasons": sorted(set(problems)), "duplicate": duplicate, "integrity": {"available": payload is not None, "reason": issue},
            "diagnostic_status": payload["evidence"]["status"] if payload else None, "archived_currentness": entry["currentness"],
            "currentness": _currentness(db, payload) if row and row["symbol"] == symbol else {"current": None, "reasons": ["archive_symbol_unverifiable"]}})
    if any(not item["compatible"] for item in results): reasons.append("archive_records_incompatible")
    absent = len({item["id"] for item in results if item["duplicate"] == "absent_locally"})
    unknown = sum(item["duplicate"] == "unverifiable" for item in results)
    projected = total + absent if not unknown else None
    if total > receipts.MAX_TOTAL or (projected is not None and projected > receipts.MAX_TOTAL): reasons.append("archive_workspace_capacity")
    changed = []
    if archive["input_revision"] != base["input_revision"]: changed.append("workspace_inputs_changed")
    if archive["as_of"] != base["as_of"]: changed.append("session_changed")
    set_known = True
    try:
        current_set = _read_rows(db, "CAST(symbol AS BLOB)=?", (symbol.encode("ascii"),))
        if _set_hash(current_set) != archive["set_fingerprint"]: changed.append("receipt_set_changed")
    except HTTPException as error:
        if error.status_code != 413: raise
        set_known = False
        changed.append("archive_local_set_size_limit")
    return {**base, "compatible": not reasons, "verdict": "compatible" if not reasons else "blocked", "archive_checksum": archive["checksum"],
        "reasons": sorted(set(reasons)), "records": results,
        "coverage": {"declared": archive["coverage"]["symbol_total"], "checked": len(results), "compatible": sum(item["compatible"] for item in results),
            "unavailable": sum(not item["compatible"] for item in results)},
        "capacity": {"workspace_used": total, "workspace_limit": receipts.MAX_TOTAL, "remaining": max(0, receipts.MAX_TOTAL - total),
            "absent_locally": absent, "unknown_identities": unknown, "projected_total": projected, "automatic_deletion": False, "import_authorized": False},
        "archive_context": {key: archive[key] for key in ("symbol", "as_of", "input_revision", "exported_at")},
        "snapshot_currentness": {"current": not changed if set_known and not reasons else None, "reasons": changed or (["archive_unverifiable"] if reasons else [])}}


@router.post(BASE + "/preflight")
@store.snapshot_read
def preflight_archive(request: Request, symbol: str = Query(pattern=SYMBOL)):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        value = _preflight(db, symbol, request.state.integrity_archive_bytes)
        if sessions.latest_completed_session() != as_of:
            raise _problem("integrity_archive_session_changed", 409)
        return _reply(value)
