"""Complete account workflow path receipt archives and read-only compatibility preflight."""
import base64
from datetime import date, datetime
import re
import struct
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import allocation_receipt_archive as strict_json
from . import research_integrity_archive as codec
from . import workflow_path_receipts as receipts, workflow_path_receipt_comparison as comparison
from . import paper_portfolio as paper, workflow_path_validation as path, workflow_path_costs as costs
from . import portfolio_agent as agent, scan_provenance, allocator
from . import sessions, store

ENGINE_VERSION = "alphaview-workflow-path-receipt-archive-v1"
SCHEMA_VERSION, MAX_BYTES = 1, 32 * 1024 * 1024
BASE = "/api/paper/accounts/{account_id}/workflow-path-receipt-archive"
COLUMNS = ("id", "account_id", "run_id", "kind", "created_at", "engine_version", "request_json", "content_fingerprint", "payload_json")
ACCOUNT = r"^[a-f0-9]{32}$"
HASH = r"^[a-f0-9]{64}$"
POLICY = {"read_only": True, "import_authorized": False, "restore_authorized": False, "delete_authorized": False, "execution_source": False}
CANONICAL = "python-json-sort-keys-utf8-finite-v1"
METHOD = (
    "One explicit account only, with membership defined by exact stored account identifier bytes. "
    "Capture every path_validation and path_costs receipt across saved workflows before pagination in "
    "one query-only snapshot. Preserve every SQLite cell storage type and exact content, including "
    "opaque corrupt JSON, BLOB and invalid UTF-8 TEXT, without replacement characters. INTEGER uses "
    "canonical decimal, REAL uses big-endian IEEE754 bytes and NULL is explicit. Verify byte hashes, "
    "typed row checksums and the complete canonical archive checksum separately from evidence integrity. "
    "Recheck strict JSON, normalized saved request, exact account/run/kind bindings, complete original "
    "receipt envelope and understood evidence shape and methods. Opaque, conflicting or unsupported "
    "rows are incompatible even when identical locally. Currentness is separate; valid unavailable "
    "or incomplete originals keep their status. At most 50 account receipts, 250 globally and 32 MiB "
    "for the complete archive; reject overflow without dropping or withholding cells. Preflight is "
    "read-only information, not import, restoration, deletion, recomputation, research approval or "
    "execution authorization. No history, price, provider, model, broker or account mutation."
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
                    return _reply({"detail": {"code": "path_archive_media_type"}}, 415)
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        return _reply({"detail": {"code": "path_archive_size_limit"}}, 413)
                    chunks.append(chunk)
                request.state.path_archive_bytes = b"".join(chunks)
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
    ordinal: int = Field(ge=1, le=50)
    id: str | None = Field(max_length=64)
    content_fingerprint: str | None = Field(max_length=64)
    run_id: str | None = Field(max_length=64)
    kind: str | None = Field(max_length=100)
    record: dict[str, Cell]
    row_checksum: str = Field(pattern=HASH)
    integrity: Verification
    diagnostic_status: str | None = Field(max_length=100)
    currentness: Currentness


class Coverage(Strict):
    account_total: int = Field(ge=0, le=50)
    exported: int = Field(ge=0, le=50)
    raw_complete: int = Field(ge=0, le=50)
    verified: int = Field(ge=0, le=50)
    unavailable: int = Field(ge=0, le=50)
    complete_set: Literal[True]


class Retention(Strict):
    account_limit: Literal[50]
    global_limit: Literal[250]
    max_original_payload_bytes: Literal[2097152]
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
    archive_kind: Literal["account_workflow_path_receipts"]
    canonicalization: Literal["python-json-sort-keys-utf8-finite-v1"]
    columns: list[str] = Field(min_length=9, max_length=9)
    account_id: str = Field(pattern=ACCOUNT)
    account_version: int = Field(ge=1)
    as_of: str = Field(min_length=10, max_length=10)
    input_revision: str = Field(min_length=1, max_length=200)
    exported_at: str = Field(max_length=100)
    method: str = Field(max_length=5000)
    records: list[Entry] = Field(max_length=50)
    coverage: Coverage
    retention: Retention
    policy: Policy
    set_fingerprint: str = Field(pattern=HASH)
    checksum: str = Field(pattern=HASH)


_cell = codec._cell

def _read_rows(db, where, args):
    sizes = [f"CASE WHEN typeof({key})='real' THEN 8 ELSE COALESCE(length(CAST({key} AS BLOB)),0) END" for key in COLUMNS]
    size = db.execute(f"SELECT COALESCE(SUM({'+'.join(sizes)}),0) FROM workflow_path_receipts WHERE {where}", args).fetchone()[0]
    if size > MAX_BYTES:
        raise _problem("path_archive_size_limit")
    fields = []
    for key in COLUMNS:
        fields.extend((f"typeof({key}) AS {key}_type", f"CAST({key} AS BLOB) AS {key}_raw",
                       f"CASE WHEN typeof({key})='real' THEN {key} ELSE NULL END AS {key}_real"))
    rows = db.execute(f"SELECT {','.join(fields)} FROM workflow_path_receipts WHERE {where} ORDER BY created_at,id,rowid", args).fetchall()
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


def _accounting_shape(value, *, cost_case=False):
    for row in value["curve"]:
        if (not comparison._day(row.get("date")) or not path._positive(row.get("value"))
                or not comparison._finite(row.get("cash")) or row["cash"] < 0
                or not comparison._finite(row.get("exposure_pct"))):
            return False
    for row in value["events"]:
        if (not comparison._day(row.get("signal_date")) or not comparison._day(row.get("trade_date"))
                or row["signal_date"] >= row["trade_date"] or not comparison._finite(row.get("fee"))
                or row["fee"] < 0 or not comparison._finite(row.get("cash")) or row["cash"] < 0
                or not isinstance(row.get("trades"), list)):
            return False
        for trade in row["trades"]:
            if (not isinstance(trade, dict) or not isinstance(trade.get("symbol"), str)
                    or trade.get("side") not in ("buy", "sell") or not path._positive(trade.get("shares"))
                    or not path._positive(trade.get("raw_open")) or not comparison._finite(trade.get("fee")) or trade["fee"] < 0):
                return False
            keys = ("raw_notional", "execution_notional", "fill_price") if cost_case else ("notional",)
            if not all(path._positive(trade.get(key)) for key in keys):
                return False
    for row in value["final_holdings"]:
        if (not isinstance(row.get("symbol"), str) or not all(path._positive(row.get(key)) for key in ("shares", "raw_close", "value"))):
            return False
    return True


def _shape(payload, body):
    """Validate complete stored protocol shapes without loading prices or replaying accounting."""
    try:
        evidence = payload["evidence"]
        baseline = evidence if body.kind == "path_validation" else evidence["baseline"]
        settings = baseline["settings"]
        if set(settings) != {"window_sessions", "rebalance_sessions", "initial_cash", "fee_bps", "slippage_bps", "workflow", "symbol_policy"}:
            return False
        if any(not comparison._finite(settings[key]) for key in ("window_sessions", "rebalance_sessions", "initial_cash", "fee_bps", "slippage_bps")):
            return False
        if settings["window_sessions"] <= 0 or settings["rebalance_sessions"] <= 0 or settings["initial_cash"] <= 0:
            return False
        if baseline["settings_fingerprint"] != receipts._hash({"settings": settings, "engine_version": baseline["engine_version"],
                "proposal_fingerprint": baseline["proposal_fingerprint"], "scan_engine_version": baseline["scan_engine_version"],
                "allocator_engine_version": baseline["allocator_engine_version"]}):
            return False
        if baseline["agent_engine_version"] != payload["saved_workflow"]["engine_version"]:
            return False
        window = baseline["window"]
        if (not isinstance(window, dict) or set(window) != {"signal_start", "start", "end", "sessions"}
                or not comparison._day(window["end"]) or window["end"] != baseline["as_of"]
                or not _integer(window["sessions"]) or window["sessions"] != settings["window_sessions"]
                or any(window[key] is not None and not comparison._day(window[key]) for key in ("signal_start", "start"))):
            return False
        if not comparison._universe(baseline["candidate_symbols"]) or not comparison._universe(baseline["rps_universe"], empty=True):
            return False
        coverage = baseline["coverage"]
        names = ("required_decisions", "evaluated_decisions", "available_decisions", "required_path_sessions", "valued_path_sessions")
        if set(coverage) != {*names, "history"} or not all(_integer(coverage[key]) for key in names):
            return False
        if not isinstance(coverage["history"], list) or any(not isinstance(item, dict) or set(item) != {"symbol", "bars"}
                or not isinstance(item["symbol"], str) or not _integer(item["bars"]) for item in coverage["history"]):
            return False
        for key in ("reasons", "decisions", "curve", "events", "final_holdings"):
            if not isinstance(baseline[key], list) or any(not isinstance(row, dict) for row in baseline[key]):
                return False
        if coverage["evaluated_decisions"] != len(baseline["decisions"]) or coverage["valued_path_sessions"] != len(baseline["curve"]):
            return False
        if coverage["available_decisions"] != sum(row.get("status") != "unavailable" for row in baseline["decisions"]):
            return False
        if not (coverage["available_decisions"] <= coverage["evaluated_decisions"] <= coverage["required_decisions"]
                and coverage["valued_path_sessions"] <= coverage["required_path_sessions"]):
            return False
        if any(not isinstance(row.get("code"), str) for row in baseline["reasons"]):
            return False
        for decision in baseline["decisions"]:
            if (decision.get("status") not in ("rebalance", "hold_no_candidates", "unavailable")
                    or not comparison._day(decision.get("signal_date")) or not comparison._day(decision.get("trade_date"))
                    or decision["signal_date"] >= decision["trade_date"]
                    or any(not isinstance(decision.get(key), list) or any(not isinstance(row, dict) for row in decision[key])
                        for key in ("targets", "candidates", "reasons"))):
                return False
            if any(not isinstance(row.get("symbol"), str) or not path._positive(row.get("weight_pct")) for row in decision["targets"]):
                return False
            if decision["status"] == "rebalance" and (not decision["targets"] or not comparison._finite(decision.get("cash_weight_pct"))):
                return False
        if not _accounting_shape(baseline):
            return False
        if baseline["status"] == "evaluated":
            if not all(row["matches"] for row in comparison._basis(payload, payload)):
                return False
        elif (baseline["metrics"] is not None or baseline["curve"] or baseline["events"] or baseline["final_holdings"] or not baseline["reasons"]):
            return False
        for value in (baseline, evidence):
            if not isinstance(value["warnings"], list) or any(not isinstance(item, str) for item in value["warnings"]) or not isinstance(value["method"], str):
                return False
        if body.kind == "path_costs":
            scenarios = evidence["scenarios"]
            expected_pairs = [(fee, slip) for fee in body.request.fee_bps for slip in body.request.slippage_bps]
            if [(row["fee_bps"], row["slippage_bps"]) for row in scenarios] != expected_pairs:
                return False
            available = 0
            for scenario in scenarios:
                if type(scenario["is_baseline"]) is not bool or scenario["is_baseline"] != (scenario["fee_bps"] == settings["fee_bps"] and scenario["slippage_bps"] == settings["slippage_bps"]):
                    return False
                if not isinstance(scenario["reasons"], list) or any(not isinstance(row, dict) or not isinstance(row.get("code"), str) for row in scenario["reasons"]):
                    return False
                if scenario["status"] == "evaluated":
                    available += 1
                    if baseline["status"] != "evaluated" or scenario["reasons"] or not comparison._metrics(scenario["metrics"]) or not comparison._metrics(scenario["costs"], comparison.COSTS):
                        return False
                    if comparison._dates(scenario) != comparison._dates(baseline):
                        return False
                    if not comparison._metrics(scenario["differences"], ("final_value", "return_pp", "max_drawdown_pp", "explicit_cost")):
                        return False
                elif scenario["status"] != "unavailable" or any(scenario[key] is not None for key in ("metrics", "costs", "differences")) or any(scenario[key] for key in ("curve", "events", "final_holdings")) or not scenario["reasons"]:
                    return False
                for key in ("events", "final_holdings", "curve"):
                    if not isinstance(scenario[key], list) or any(not isinstance(row, dict) for row in scenario[key]):
                        return False
                if not _accounting_shape(scenario, cost_case=True):
                    return False
            if evidence["coverage"] != {"required_scenarios": len(scenarios), "available_scenarios": available,
                    "unavailable_scenarios": len(scenarios) - available, "decision_sets_computed": 1}:
                return False
            if evidence["status"] != ("evaluated" if available == len(scenarios) else "unavailable" if not available else "incomplete"):
                return False
            if evidence["scenario_fingerprint"] != receipts._hash({"engine_version": evidence["engine_version"], "fee_bps": body.request.fee_bps, "slippage_bps": body.request.slippage_bps}):
                return False
        return True
    except (ValueError, KeyError, TypeError, OverflowError, IndexError, AttributeError):
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
        if not isinstance(saved, dict) or set(saved) != {"account_id", "run_id", "save_request"}:
            return row, None, "archive_saved_request_invalid"
        body = receipts._SAVE.validate_python(saved["save_request"])
        if saved["save_request"] != body.model_dump():
            return row, None, "archive_saved_request_invalid"
        payload, issue = receipts._decode(row)
        if payload is None:
            return row, None, issue
        if set(payload) != {"engine_version", "receipt_id", "kind", "created_at", "request", "saved_workflow", "account_context", "source_context", "evidence", "method", "policy"}:
            return row, None, "archive_receipt_envelope_unsupported"
        if not _shape(payload, body):
            return row, None, "archive_evidence_shape_unsupported"
        return row, payload, None
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError, ValidationError, AttributeError):
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
        "diagnostic_status": payload["evidence"]["status"] if payload else None, "kind": _metadata(row, "kind"), "run_id": _metadata(row, "run_id"), "currentness": _currentness(db, payload)}


def _set_hash(records):
    return receipts._hash(sorted(receipts._hash(record) for record in records))



def _version_reasons(payload):
    source = payload["source_context"]["versions"]
    supported = {"evidence": path.ENGINE_VERSION if payload["kind"] == "path_validation" else costs.ENGINE_VERSION,
        "path": path.ENGINE_VERSION, "workflow": agent.ENGINE_VERSION,
        "scan": scan_provenance.SCAN_ENGINE_VERSION, "allocator": allocator.ENGINE_VERSION}
    reasons = []
    if payload["engine_version"] != receipts.ENGINE_VERSION:
        reasons.append("archive_receipt_method_unsupported")
    if source != supported:
        reasons.append("archive_evidence_method_unsupported")
    baseline = comparison._baseline(payload)
    if (payload["method"] != receipts.METHOD or baseline["method"] != path.METHOD
            or payload["evidence"]["method"] != (path.METHOD if payload["kind"] == "path_validation" else costs.METHOD)):
        reasons.append("archive_method_text_unsupported")
    return reasons


@router.get(BASE)
@store.snapshot_read
def export_archive(account_id: comparison.AccountId):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        account = paper._account(db, account_id)
        total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts").fetchone()[0]
        account_total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts WHERE CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),)).fetchone()[0]
        if total > receipts.MAX_TOTAL or account_total > receipts.MAX_ACCOUNT:
            raise _problem("path_archive_count_limit")
        records = _read_rows(db, "CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),))
        entries = [_entry(db, record, index + 1) for index, record in enumerate(records)]
        verified = sum(item["integrity"]["available"] for item in entries)
        value = {"engine_version": ENGINE_VERSION, "schema_version": SCHEMA_VERSION,
            "archive_kind": "account_workflow_path_receipts", "canonicalization": CANONICAL, "columns": list(COLUMNS),
            "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "input_revision": store.input_revision(db), "exported_at": store.now(), "method": METHOD, "records": entries,
            "coverage": {"account_total": len(entries), "exported": len(entries), "raw_complete": len(entries),
                "verified": verified, "unavailable": len(entries) - verified, "complete_set": True},
            "retention": {"account_limit": receipts.MAX_ACCOUNT, "global_limit": receipts.MAX_TOTAL,
                "max_original_payload_bytes": receipts.MAX_BYTES, "max_archive_bytes": 33554432, "automatic_deletion": False},
            "policy": dict(POLICY), "set_fingerprint": _set_hash(records)}
        value["checksum"] = receipts._hash(value)
        encoded = receipts._json(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("path_archive_size_limit")
        if sessions.latest_completed_session() != as_of:
            raise _problem("path_archive_session_changed", 409)
        return Response(encoded, media_type="application/json", headers={"Cache-Control": "no-store"})


def _preflight(db, account_id, account, raw):
    total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts").fetchone()[0]
    account_total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts WHERE CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),)).fetchone()[0]
    base = {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
        "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db), "checked_at": store.now(),
        "compatible": False, "verdict": "blocked", "archive_checksum": None, "reasons": [], "records": [],
        "policy": dict(POLICY), "method": METHOD,
        "coverage": {"declared": None, "checked": 0, "compatible": 0, "unavailable": None}, "capacity": None,
        "archive_context": None, "snapshot_currentness": {"current": None, "reasons": ["archive_unverifiable"]}}
    try:
        archive = strict_json._loads(raw.decode("utf-8", errors="strict"))
        pending = [archive]
        while pending:
            item = pending.pop()
            if isinstance(item, str): item.encode("utf-8", errors="strict")
            elif isinstance(item, dict): pending.extend(item.keys()); pending.extend(item.values())
            elif isinstance(item, list): pending.extend(item)
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
    if archive["account_id"] != account_id: reasons.append("archive_account_mismatch")
    expected = {"account_total": len(entries), "exported": len(entries), "raw_complete": len(entries),
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
            if row["account_id"] != account_id: problems.append("archive_receipt_account_mismatch")
            if any(entry[key] != _metadata(row, key) for key in ("id", "content_fingerprint", "kind", "run_id")):
                problems.append("archive_entry_identity_mismatch")
        if payload: problems.extend(_version_reasons(payload))
        matching_account = row is not None and row["account_id"] == account_id and archive["account_id"] == account_id
        results.append({"ordinal": entry["ordinal"], "id": entry["id"], "kind": entry["kind"], "run_id": entry["run_id"],
            "compatible": not problems and not local_limit and matching_account, "reasons": sorted(set(problems)), "duplicate": duplicate,
            "integrity": {"available": payload is not None, "reason": issue},
            "diagnostic_status": payload["evidence"]["status"] if payload else None, "archived_currentness": entry["currentness"],
            "currentness": _currentness(db, payload) if matching_account else {"current": None, "reasons": ["archive_account_unverifiable"]}})
    if any(not item["compatible"] for item in results): reasons.append("archive_records_incompatible")
    absent = len({item["id"] for item in results if item["duplicate"] == "absent_locally"})
    unknown = sum(item["duplicate"] == "unverifiable" for item in results)
    projected_account, projected_global = (account_total + absent, total + absent) if not unknown else (None, None)
    if (account_total > receipts.MAX_ACCOUNT or total > receipts.MAX_TOTAL or
            (projected_account is not None and projected_account > receipts.MAX_ACCOUNT) or
            (projected_global is not None and projected_global > receipts.MAX_TOTAL)):
        reasons.append("archive_receipt_capacity")
    changed = []
    if archive["account_version"] != base["account_version"]: changed.append("account_version_changed")
    if archive["input_revision"] != base["input_revision"]: changed.append("inputs_changed")
    if archive["as_of"] != base["as_of"]: changed.append("session_changed")
    set_known = True
    try:
        current_set = _read_rows(db, "CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),))
        if _set_hash(current_set) != archive["set_fingerprint"]: changed.append("receipt_set_changed")
    except HTTPException as error:
        if error.status_code != 413: raise
        set_known = False
        changed.append("archive_local_set_size_limit")
    return {**base, "compatible": not reasons, "verdict": "compatible" if not reasons else "blocked", "archive_checksum": archive["checksum"],
        "reasons": sorted(set(reasons)), "records": results,
        "coverage": {"declared": archive["coverage"]["account_total"], "checked": len(results), "compatible": sum(item["compatible"] for item in results),
            "unavailable": sum(not item["compatible"] for item in results)},
        "capacity": {"account_used": account_total, "account_limit": receipts.MAX_ACCOUNT, "global_used": total, "global_limit": receipts.MAX_TOTAL,
            "account_remaining": max(0, receipts.MAX_ACCOUNT - account_total), "global_remaining": max(0, receipts.MAX_TOTAL - total),
            "absent_locally": absent, "unknown_identities": unknown, "projected_account_total": projected_account, "projected_global_total": projected_global,
            "automatic_deletion": False, "import_authorized": False},
        "archive_context": {key: archive[key] for key in ("account_id", "account_version", "as_of", "input_revision", "exported_at")},
        "snapshot_currentness": {"current": not changed if set_known and not reasons else None, "reasons": changed or (["archive_unverifiable"] if reasons else [])}}


@router.post(BASE + "/preflight")
@store.snapshot_read
def preflight_archive(account_id: comparison.AccountId, request: Request):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        account = paper._account(db, account_id)
        value = _preflight(db, account_id, account, request.state.path_archive_bytes)
        if sessions.latest_completed_session() != as_of:
            raise _problem("path_archive_session_changed", 409)
        return _reply(value)
