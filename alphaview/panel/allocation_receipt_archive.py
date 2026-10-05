"""Account-scoped immutable receipt archives and advisory, read-only preflight.

No import, deletion, schema mutation, evidence reconstruction or execution route.
"""
import base64
import hashlib
import json
import math
import re
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import allocation_research as research, allocation_research_receipts as receipts
from . import paper_portfolio as paper, portfolio_agent as agent, sessions, store

ENGINE_VERSION = "alphaview-allocation-receipt-archive-v1"
SCHEMA_VERSION = 1
MAX_BYTES = 32 * 1024 * 1024
MAX_REQUEST_CELL_BYTES = 16 * 1024
MAX_METADATA_BYTES = 4096
COLUMNS = ("id", "account_id", "run_id", "created_at", "engine_version", "request_json", "content_fingerprint", "payload_json")
CANONICALIZATION = "python-json-sort-keys-utf8-finite-v1"
HASH = re.compile(r"^[a-f0-9]{64}$")
POLICY = {"read_only": True, "import_authorized": False, "delete_authorized": False, "execution_source": False}
METHOD = (
    "以同一唯讀快照封存此帳戶全部研究收據；保存原始 SQLite 文字或 BLOB 儲存格與逐格 SHA-256，"
    "外層校驗值為排除 checksum 後的排序鍵、無空白、UTF-8 有限 JSON 的 SHA-256。"
    "未知或超限內容明示不可用，不省略紀錄。預檢驗證格式、校驗、帳戶、方法與重複識別，"
    "目前來源資格另列；沒有匯入、刪除、研究重算、可執行來源或任何交易授權。"
)


def _reply(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


class _BoundedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request):
            if request.method == "POST":
                if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    return _reply({"detail": {"code": "archive_media_type", "message": "請提供 application/json 封存內容"}}, 415)
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        return _reply({"detail": {"code": "archive_size_limit", "message": "封存檔超過 32 MiB；未執行預檢"}}, 413)
                    chunks.append(chunk)
                request.state.archive_bytes = b"".join(chunks)
            return await handler(request)
        return bounded


router = APIRouter(route_class=_BoundedRoute)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Cell(Strict):
    storage_type: str = Field(max_length=30)
    encoding: Literal["utf-8", "base64", "unavailable"]
    byte_length: int | None = Field(default=None, ge=0)
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    content: str | None
    availability: Literal["retained", "withheld"]
    reason: str | None


class Integrity(Strict):
    available: bool
    reason: str | None


class Currentness(Strict):
    current: bool | None
    reasons: list[str] = Field(max_length=30)


class Entry(Strict):
    id: str | None = Field(max_length=MAX_METADATA_BYTES)
    content_fingerprint: str | None = Field(max_length=MAX_METADATA_BYTES)
    record: dict[str, Cell]
    integrity: Integrity
    currentness: Currentness


class Coverage(Strict):
    account_total: int = Field(ge=0, le=receipts.MAX_ACCOUNT)
    exported: int = Field(ge=0, le=receipts.MAX_ACCOUNT)
    complete_set: bool
    raw_complete: int = Field(ge=0, le=receipts.MAX_ACCOUNT)
    integrity_available: int = Field(ge=0, le=receipts.MAX_ACCOUNT)
    integrity_unavailable: int = Field(ge=0, le=receipts.MAX_ACCOUNT)


class Retention(Strict):
    per_account: Literal[50]
    global_limit: Literal[500]
    max_payload_bytes: Literal[262144]
    max_request_bytes: Literal[16384]
    automatic_deletion: Literal[False]


class Policy(Strict):
    read_only: Literal[True]
    import_authorized: Literal[False]
    delete_authorized: Literal[False]
    execution_source: Literal[False]


class Archive(Strict):
    engine_version: str = Field(max_length=100)
    schema_version: int = Field(ge=1)
    archive_kind: Literal["account_allocation_research_receipts"]
    canonicalization: Literal["python-json-sort-keys-utf8-finite-v1"]
    account_id: str = Field(min_length=1, max_length=MAX_METADATA_BYTES)
    account_version: int = Field(ge=1)
    as_of: str = Field(min_length=10, max_length=10)
    input_revision: str = Field(min_length=1, max_length=200)
    exported_at: str = Field(min_length=1, max_length=100)
    method: str = Field(max_length=4000)
    records: list[Entry] = Field(max_length=receipts.MAX_ACCOUNT)
    coverage: Coverage
    retention: Retention
    policy: Policy
    checksum: str = Field(pattern=r"^[a-f0-9]{64}$")


def _hash_bytes(value):
    return hashlib.sha256(value).hexdigest()


def _cell_limit(column):
    return receipts.MAX_BYTES if column == "payload_json" else MAX_REQUEST_CELL_BYTES if column == "request_json" else MAX_METADATA_BYTES


def _bounded_rows(db, account_id):
    fields = []
    for column in COLUMNS:
        size = f"length(CAST({column} AS BLOB))"
        fields.extend((f"typeof({column}) AS {column}_type", f"{size} AS {column}_bytes",
                       f"CASE WHEN {size}<={_cell_limit(column)} THEN {column} ELSE NULL END AS {column}"))
    return db.execute(f"SELECT {','.join(fields)} FROM allocation_research_receipts WHERE account_id=? ORDER BY created_at,id", (account_id,)).fetchall()


def _cell(row, column):
    value, size, kind = row[column], row[column + "_bytes"], row[column + "_type"]
    cell = {"storage_type": kind, "encoding": "unavailable", "byte_length": size, "sha256": None,
            "content": None, "availability": "withheld", "reason": None}
    if size is not None and size > _cell_limit(column):
        return {**cell, "reason": "cell_size_limit"}
    if isinstance(value, str):
        raw, encoding, content = value.encode("utf-8"), "utf-8", value
    elif isinstance(value, bytes):
        raw, encoding, content = value, "base64", base64.b64encode(value).decode("ascii")
    else:
        return {**cell, "reason": "cell_storage_unavailable"}
    return {**cell, "encoding": encoding, "sha256": _hash_bytes(raw), "content": content,
            "availability": "retained", "reason": None}


def _reject_constant(_value):
    raise ValueError("nonfinite_json")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _finite(value):
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            try:
                finite = math.isfinite(item)
            except OverflowError:
                finite = False
            if not finite:
                raise ValueError("nonfinite_json")
        if isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def _loads(raw):
    value = json.loads(raw, parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    _finite(value)
    return value


def _integrity(row):
    try:
        if not isinstance(row["request_json"], str) or not isinstance(row["payload_json"], str):
            return None, "receipt_evidence_unverifiable"
        _loads(row["request_json"])
        _loads(row["payload_json"])
        return receipts._decode(row)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError):
        return None, "receipt_evidence_unverifiable"


def _currentness(db, payload):
    try:
        return receipts._currentness(db, payload)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return {"current": None, "reasons": ["context_unverifiable"]}


def _entry(db, row):
    record = {column: _cell(row, column) for column in COLUMNS}
    complete = all(cell["availability"] == "retained" for cell in record.values())
    payload, problem = _integrity(row) if complete else (None, "archive_content_withheld")
    return {"id": row["id"] if isinstance(row["id"], str) else None,
            "content_fingerprint": row["content_fingerprint"] if isinstance(row["content_fingerprint"], str) else None,
            "record": record, "integrity": {"available": payload is not None, "reason": problem},
            "currentness": _currentness(db, payload)}


@router.get("/api/paper/accounts/{account_id}/allocation-research-receipt-archive")
@store.snapshot_read
def export_archive(account_id: str):
    with store.connect() as db:
        account = paper._account(db, account_id)
        total = db.execute("SELECT count(*) FROM allocation_research_receipts WHERE account_id=?", (account_id,)).fetchone()[0]
        if total > receipts.MAX_ACCOUNT:
            raise receipts._problem("archive_count_limit", "帳戶收據超過 50 筆；未輸出截短封存檔", 409)
        entries = [_entry(db, row) for row in _bounded_rows(db, account_id)]
        good = sum(entry["integrity"]["available"] for entry in entries)
        archive = {"engine_version": ENGINE_VERSION, "schema_version": SCHEMA_VERSION,
            "archive_kind": "account_allocation_research_receipts", "canonicalization": CANONICALIZATION,
            "account_id": account_id, "account_version": account["version"], "as_of": sessions.latest_completed_session(),
            "input_revision": store.input_revision(db), "exported_at": store.now(), "method": METHOD, "records": entries,
            "coverage": {"account_total": total, "exported": len(entries), "complete_set": len(entries) == total,
                         "raw_complete": sum(all(cell["availability"] == "retained" for cell in entry["record"].values()) for entry in entries),
                         "integrity_available": good, "integrity_unavailable": len(entries) - good},
            "retention": {"per_account": receipts.MAX_ACCOUNT, "global_limit": receipts.MAX_TOTAL,
                          "max_payload_bytes": receipts.MAX_BYTES, "max_request_bytes": MAX_REQUEST_CELL_BYTES, "automatic_deletion": False},
            "policy": dict(POLICY)}
        archive["checksum"] = receipts._hash(archive)
        if len(receipts._json(archive).encode()) > MAX_BYTES:
            raise receipts._problem("archive_size_limit", "完整封存檔超過 32 MiB；未輸出截短內容", 409)
        return _reply(archive)


def _decode_cells(entry):
    if set(entry["record"]) != set(COLUMNS):
        return None, ["record_columns_invalid"]
    row, reasons = {}, []
    for column, cell in entry["record"].items():
        if cell["availability"] != "retained" or cell["content"] is None:
            reasons.append("archive_content_withheld")
            continue
        try:
            if cell["encoding"] == "utf-8" and cell["storage_type"] == "text":
                raw = cell["content"].encode("utf-8")
                value = cell["content"]
            elif cell["encoding"] == "base64" and cell["storage_type"] == "blob":
                raw = base64.b64decode(cell["content"], validate=True)
                if base64.b64encode(raw).decode("ascii") != cell["content"]:
                    raise ValueError("noncanonical base64")
                value = raw
            else:
                reasons.append("cell_storage_unavailable")
                continue
        except (ValueError, UnicodeError):
            reasons.append("cell_encoding_invalid")
            continue
        if len(raw) > _cell_limit(column):
            reasons.append("cell_size_limit")
        elif cell["byte_length"] != len(raw) or cell["sha256"] != _hash_bytes(raw) or cell["reason"] is not None:
            reasons.append("cell_checksum_mismatch")
        else:
            row[column] = value
    return (row if not reasons else None), list(dict.fromkeys(reasons))


def _methods(payload):
    if payload is None:
        return []
    checks = ((payload.get("engine_version"), receipts.ENGINE_VERSION, "receipt_method_unsupported"),
              (payload["evidence"].get("engine_version"), research.ENGINE_VERSION, "research_method_unsupported"),
              (payload["source_context"].get("engine_version"), agent.ENGINE_VERSION, "workflow_method_unsupported"),
              (payload["source_context"].get("scan_engine_version"), agent.scan_provenance.SCAN_ENGINE_VERSION, "scan_method_unsupported"))
    return [reason for actual, expected, reason in checks if actual != expected]


def _preflight_entry(db, account_id, entry, seen):
    row, reasons = _decode_cells(entry)
    payload, issue, duplicate, scope_valid = None, None, "unverifiable", False
    if row is not None:
        identifier = row["id"]
        if not isinstance(identifier, str) or not HASH.fullmatch(identifier):
            reasons.append("receipt_identity_invalid")
        elif identifier in seen:
            reasons.append("duplicate_archive_identity")
        else:
            seen.add(identifier)
        if row["account_id"] != account_id:
            reasons.append("receipt_account_mismatch")
        else:
            scope_valid = True
        if entry["id"] != row["id"] or entry["content_fingerprint"] != row["content_fingerprint"]:
            reasons.append("entry_identity_mismatch")
        payload, issue = _integrity(row)
        if issue:
            reasons.append(issue)
        if payload is not None and not research_shape(payload):
            reasons.append("receipt_shape_unsupported")
        if payload is not None and not _request_shape(row, payload):
            reasons.append("receipt_request_shape_invalid")
        reasons.extend(_methods(payload))
        if entry["integrity"] != {"available": payload is not None, "reason": issue}:
            reasons.append("archived_integrity_mismatch")
        if isinstance(identifier, str) and HASH.fullmatch(identifier) and row["account_id"] == account_id:
            existing = db.execute("SELECT * FROM allocation_research_receipts WHERE id=?", (identifier,)).fetchone()
            if existing is None:
                duplicate = "absent_locally"
            elif existing["account_id"] == account_id and all(existing[column] == row[column] for column in COLUMNS):
                duplicate = "identical_locally"
            else:
                duplicate = "conflicting_local_identity"
                reasons.append("local_identity_conflict")
    reasons = list(dict.fromkeys(reasons))
    return {"id": entry["id"], "content_fingerprint": entry["content_fingerprint"],
            "compatible": not reasons, "reasons": reasons, "duplicate": duplicate,
            "integrity": {"available": payload is not None, "reason": issue or ("archive_content_unverifiable" if row is None else None)},
            "archived_currentness": entry["currentness"],
            "currentness": _currentness(db, payload) if scope_valid else {"current": None, "reasons": ["account_not_compatible"]}}


def research_shape(payload):
    """Reuse the existing understood receipt containers, without calculating."""
    try:
        return receipts._comparison_shape(payload["evidence"])
    except (ValueError, TypeError, KeyError, RecursionError):
        return False


def _request_shape(row, payload):
    try:
        request = _loads(row["request_json"])
        if set(request) != {"account_id", "request"}:
            return False
        body = receipts.SaveInput.model_validate(request["request"])
        evidence = payload["evidence"]
        return (body.expected_proposal_fingerprint == evidence["proposal_fingerprint"]
                and body.expected_input_revision == evidence["input_revision"]
                and body.expected_as_of == evidence["as_of"]
                and {key: value for key, value in body.model_dump().items() if key in research.AllocationResearchInput.model_fields} == evidence["request"])
    except (ValidationError, ValueError, KeyError, TypeError, RecursionError):
        return False


def _preflight(db, account, raw):
    base = {"engine_version": ENGINE_VERSION, "account_id": account["id"], "account_version": account["version"],
            "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db), "checked_at": store.now(),
            "verdict": "blocked", "compatible": False, "archive_checksum": None, "reasons": [], "records": [],
            "policy": dict(POLICY), "method": METHOD, "coverage": {"declared": None, "checked": 0, "compatible": 0, "unavailable": None},
            "capacity": None, "archive_context": None, "snapshot_currentness": {"current": None, "reasons": ["archive_unverifiable"]}}
    if len(raw) > MAX_BYTES:
        return {**base, "reasons": ["archive_size_limit"]}
    try:
        archive = _loads(raw.decode("utf-8"))
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError) as exc:
        reason = str(exc) if str(exc) in {"nonfinite_json", "duplicate_json_key"} else "archive_json_invalid"
        return {**base, "reasons": [reason]}
    if not isinstance(archive, dict):
        return {**base, "reasons": ["archive_shape_invalid"]}
    if archive.get("engine_version") != ENGINE_VERSION or archive.get("schema_version") != SCHEMA_VERSION or type(archive.get("schema_version")) is not int:
        return {**base, "reasons": ["archive_version_unsupported"]}
    if isinstance(archive.get("records"), list) and len(archive["records"]) > receipts.MAX_ACCOUNT:
        return {**base, "reasons": ["archive_count_limit"]}
    try:
        Archive.model_validate(archive)
        if date.fromisoformat(archive["as_of"]).isoformat() != archive["as_of"] or datetime.fromisoformat(archive["exported_at"]).utcoffset() is None:
            raise ValueError("invalid archive date")
        actual_hash = receipts._hash({key: value for key, value in archive.items() if key != "checksum"})
    except (ValidationError, ValueError, UnicodeError, OverflowError, RecursionError):
        return {**base, "reasons": ["archive_shape_invalid"]}
    reasons = []
    if actual_hash != archive["checksum"]:
        reasons.append("archive_checksum_mismatch")
    if archive["account_id"] != account["id"]:
        reasons.append("archive_account_mismatch")
    coverage, entries = archive["coverage"], archive["records"]
    raw_complete = sum(all(cell["availability"] == "retained" for cell in entry["record"].values()) for entry in entries)
    available = sum(entry["integrity"]["available"] for entry in entries)
    if (not coverage["complete_set"] or coverage["account_total"] != len(entries) or coverage["exported"] != len(entries)
            or coverage["raw_complete"] != raw_complete or coverage["integrity_available"] != available
            or coverage["integrity_unavailable"] != len(entries) - available):
        reasons.append("archive_coverage_mismatch")
    seen = set()
    results = [_preflight_entry(db, account["id"], entry, seen) for entry in entries]
    good = sum(row["compatible"] for row in results)
    if good != len(entries):
        reasons.append("archive_records_incompatible")
    local = db.execute("SELECT count(*) FROM allocation_research_receipts WHERE account_id=?", (account["id"],)).fetchone()[0]
    total = db.execute("SELECT count(*) FROM allocation_research_receipts").fetchone()[0]
    changed = []
    if archive["account_version"] != account["version"]:
        changed.append("account_version_changed")
    if archive["input_revision"] != base["input_revision"]:
        changed.append("inputs_changed")
    if archive["as_of"] != base["as_of"]:
        changed.append("session_changed")
    if len(entries) != local or any(row["duplicate"] != "identical_locally" for row in results):
        changed.append("receipt_set_changed")
    if archive["account_id"] != account["id"]:
        changed.append("account_not_compatible")
    return {**base, "verdict": "blocked" if reasons else "compatible", "compatible": not reasons,
            "archive_checksum": archive["checksum"], "reasons": reasons, "records": results,
            "coverage": {"declared": len(entries), "checked": len(results), "compatible": good, "unavailable": len(results) - good},
            "archive_context": {key: archive[key] for key in ("account_id", "account_version", "as_of", "input_revision", "exported_at")},
            "snapshot_currentness": {"current": not changed if not reasons else None, "reasons": changed or (["archive_unverifiable"] if reasons else [])},
            "capacity": {"account_used": local, "account_limit": receipts.MAX_ACCOUNT, "global_used": total,
                         "global_limit": receipts.MAX_TOTAL, "absent_locally": sum(row["duplicate"] == "absent_locally" for row in results),
                         "account_remaining": max(0, receipts.MAX_ACCOUNT - local), "global_remaining": max(0, receipts.MAX_TOTAL - total),
                         "automatic_deletion": False, "import_authorized": False}}


@router.post("/api/paper/accounts/{account_id}/allocation-research-receipt-archive/preflight")
@store.snapshot_read
def preflight_archive(account_id: str, request: Request):
    with store.connect() as db:
        account = paper._account(db, account_id)
        return _reply(_preflight(db, account, request.state.archive_bytes))
