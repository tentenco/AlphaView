"""Complete account execution-study receipt archives and read-only compatibility preflight."""
import base64
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import re
import struct
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import allocation_receipt_archive as strict_json
from . import research_integrity_archive as codec
from . import execution_study_receipts as receipts, execution_study_receipt_comparison as comparison
from . import paper_portfolio as paper
from . import execution_volume_study as volume, execution_limit_study as limit, execution_gtd_study as gtd
from . import sessions, store

ENGINE_VERSION = "alphaview-execution-study-receipt-archive-v1"
SCHEMA_VERSION, MAX_BYTES = 1, 32 * 1024 * 1024
BASE = "/api/paper/accounts/{account_id}/execution-study-receipt-archive"
COLUMNS = ("id", "account_id", "proposal_id", "kind", "created_at", "engine_version", "request_json", "content_fingerprint", "payload_json")
ACCOUNT = r"^[a-f0-9]{32}$"
HASH = r"^[a-f0-9]{64}$"
POLICY = {"read_only": True, "import_authorized": False, "restore_authorized": False, "delete_authorized": False, "execution_source": False}
CANONICAL = "python-json-sort-keys-utf8-finite-v1"
METHOD = (
    "One explicit account, exact stored account identifier bytes, complete saved execution-study receipts "
    "across all proposals and volume DAY, limit DAY and open-only GTD kinds. Query-only snapshot, no "
    "pagination or source recomputation. Preserve all nine SQLite storage types and exact raw bytes, "
    "including corrupt JSON, BLOB, invalid UTF-8 TEXT and explicit NULL; INTEGER decimal and REAL IEEE754 "
    "bytes retain original representation. Verify cell, row, set and archive checksums separately from "
    "receipt integrity, strict normalized requests, exact account/proposal/kind/source bindings, full "
    "understood envelope/evidence schema and supported methods. Opaque, unknown and conflicting rows "
    "remain present but incompatible. Original complete/incomplete/unavailable statuses and unknown "
    "intraday outcomes stay unchanged. Stale intact evidence can be compatible; currentness is separate. "
    "At most 50 per account, 250 globally, 2 MiB per original receipt, 16 KiB per saved request and "
    "32 MiB per complete archive; no partial export, truncation or automatic deletion. Checksums are "
    "not signatures or proof of authenticity. Read-only preflight does not import, restore, delete, "
    "recompute, read prices, call providers or authorize trading. Preview import is not implemented."
)


def _hash(value):
    return receipts._sha(receipts._json(value))



def _reply(value, status=200):
    return Response(receipts._json(value), status_code=status, media_type="application/json", headers={"Cache-Control": "no-store"})


def _problem(code, status=413):
    return receipts._problem(code, status)


class _BoundedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def bounded(request):
            if request.method == "POST":
                if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                    return _reply({"detail": {"code": "study_archive_media_type"}}, 415)
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        return _reply({"detail": {"code": "study_archive_size_limit"}}, 413)
                    chunks.append(chunk)
                request.state.study_archive_bytes = b"".join(chunks)
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
    proposal_id: str | None = Field(max_length=64)
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
    archive_kind: Literal["account_execution_study_receipts"]
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
    size = db.execute(f"SELECT COALESCE(SUM({'+'.join(sizes)}),0) FROM execution_study_receipts WHERE {where}", args).fetchone()[0]
    if size > MAX_BYTES:
        raise _problem("study_archive_size_limit")
    fields = []
    for key in COLUMNS:
        fields.extend((f"typeof({key}) AS {key}_type", f"CAST({key} AS BLOB) AS {key}_raw",
                       f"CASE WHEN typeof({key})='real' THEN {key} ELSE NULL END AS {key}_real"))
    rows = db.execute(f"SELECT {','.join(fields)} FROM execution_study_receipts WHERE {where} ORDER BY created_at,id,rowid", args).fetchall()
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


def _keys(value, names):
    return isinstance(value, dict) and set(value) == set(names.split())


def _day(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _bar(value):
    if value is None: return True
    return (_keys(value, "date open high low close adj_close volume invalid_fields") and _day(value["date"])
        and all(value[key] is None or comparison._finite(value[key]) for key in ("open", "high", "low", "close", "adj_close", "volume"))
        and value["invalid_fields"] == [key for key in ("open", "high", "low", "close", "adj_close", "volume") if value[key] is None])


def _bars(value):
    return (_keys(value, "signal_bar execution_bar dataset") and _bar(value["signal_bar"]) and _bar(value["execution_bar"])
        and (value["dataset"] is None or (_keys(value["dataset"], "currency source")
            and all(value["dataset"][key] is None or isinstance(value["dataset"][key], str) for key in ("currency", "source")))))


def _amounts(value, names):
    for name in names.split():
        number, exact = value[name], value[name + "_exact"]
        if number is None:
            if exact is not None: return False
        else:
            if not comparison._finite(number) or number < 0 or not isinstance(exact, str) or not 1 <= len(exact) <= 128: return False
            try:
                decimal = Decimal(exact)
                if not decimal.is_finite() or decimal < 0 or float(decimal) != number: return False
            except (InvalidOperation, ValueError, OverflowError):
                return False
    return True


def _shape(payload, body):
    """Verify saved protocol and coverage without reading bars or recalculating quantities."""
    try:
        value, kind = payload["evidence"], body.kind
        common = "engine_version account_id account_version input_revision as_of source execution_session session_completed time_in_force mode method warnings request bars_fingerprint status coverage orders reason"
        extra = "" if kind == "volume_day" else (" capacity_engine_version scenario_window intraday_outcome costs_included limit_price_bounds" if kind == "limit_day" else
            " capacity_engine_version limit_engine_version scenario_window intraday_outcome costs_included allowed_expiry_sessions max_sessions gtd_date gtd_session_completed horizon evidence_fingerprint")
        if not _keys(value, common + extra): return False
        if not _keys(payload["account_context"], "account_id version kill_switch limits execution_policy symbol_policy"): return False
        if not _keys(payload["source_context"], "record_fingerprint proposal_fingerprint input_revision as_of bars_fingerprint raw_evidence_sha256 versions"): return False
        if not _keys(payload["source_context"]["versions"], "receipt evidence volume limit paper"): return False
        source = value["source"]
        if not _keys(source, "id account_id engine_version created_at status as_of input_revision account_version proposal_fingerprint current stale_reasons available reason share_precision orders skipped_orders_count"): return False
        if (not all(_day(value[key]) for key in ("as_of", "execution_session")) or not _day(source["as_of"])
                or type(value["session_completed"]) is not bool or value["session_completed"] != (value["execution_session"] <= value["as_of"])
                or type(source["current"]) is not bool or type(source["available"]) is not bool
                or not _integer(source["skipped_orders_count"]) or type(source["share_precision"]) is not int or not 0 <= source["share_precision"] <= 6
                or not all(isinstance(source[key], list) and all(isinstance(s, str) for s in source[key]) for key in ("stale_reasons",))
                or not isinstance(value["warnings"], list) or not all(isinstance(s, str) for s in value["warnings"])): return False
        if source["available"] != (source["reason"] is None): return False
        if value["reason"] is not None and not isinstance(value["reason"], str): return False
        if kind != "volume_day" and (value["scenario_window"] != "open_only" or value["intraday_outcome"] != "unknown_from_daily_bars" or value["costs_included"] is not False): return False
        orders = comparison._orders(value)
        if orders is None or list(orders) != [row["symbol"] for row in source["orders"]]: return False
        if value["time_in_force"] != ("GTD" if kind == "open_gtd" else "DAY"): return False
        if kind == "open_gtd":
            allowed, horizon = value["allowed_expiry_sessions"], value["horizon"]
            if (type(value["max_sessions"]) is not int or value["max_sessions"] != 5 or len(allowed) != 5
                    or any(not _keys(row, "date completed") or not _day(row["date"]) or type(row["completed"]) is not bool or row["completed"] != (row["date"] <= value["as_of"]) for row in allowed)
                    or [row["date"] for row in allowed] != sorted(set(row["date"] for row in allowed))
                    or value["gtd_date"] != body.request.gtd_date or value["gtd_date"] not in [row["date"] for row in allowed]
                    or horizon != [row for row in allowed if row["date"] <= value["gtd_date"]]
                    or type(value["gtd_session_completed"]) is not bool or value["gtd_session_completed"] != (value["gtd_date"] <= value["as_of"])): return False
        elif kind == "limit_day" and value["limit_price_bounds"] != {"exclusive_min": 0, "max": limit.MAX_LIMIT_PRICE}: return False
        fixed_keys = "symbol side shares shares_exact reference_price"
        day_amounts = "capacity_shares scenario_shares expired_shares reference_notional"
        gtd_amounts = "observed_prefix_scenario_shares last_known_remaining_shares observed_prefix_reference_notional final_scenario_shares expired_shares final_reference_notional"
        step_amounts = "remaining_before capacity_shares scenario_shares remaining_after reference_notional"
        def pairs(names): return " ".join(name + " " + name + "_exact" for name in names.split())
        for fixed, row in zip(source["orders"], value["orders"]):
            if not _keys(fixed, fixed_keys) or fixed["side"] not in ("buy", "sell") or not _amounts(fixed, "shares") or volume._number(fixed["shares"]) is None or not comparison._finite(fixed["reference_price"]) or fixed["reference_price"] <= 0: return False
            if any(not comparison._equal(row.get(key), fixed[key]) for key in fixed_keys.split()): return False
            if kind == "open_gtd":
                if not _keys(row, fixed_keys + " status reason limit_price limit_price_exact intraday_outcome sessions observed_prefix_end expiry_verified expiry_state completed_in_scenario_at coverage " + pairs(gtd_amounts)): return False
                if not _amounts(row, gtd_amounts) or type(row["expiry_verified"]) is not bool or row["intraday_outcome"] != "unknown_from_daily_bars": return False
                if row["status"] == "unavailable" and any(row[key] is not None for key in ("final_scenario_shares", "expired_shares", "final_reference_notional")): return False
                for step in row["sessions"]:
                    if (not _keys(step, "date session_completed status reason open_condition raw_open session_volume evidence intraday_outcome " + pairs(step_amounts))
                            or not _amounts(step, step_amounts) or type(step["session_completed"]) is not bool
                            or step["intraday_outcome"] != "unknown_from_daily_bars" or (step["evidence"] is not None and not _bars(step["evidence"]))): return False
                if not _keys(row["coverage"], "required_sessions evaluated_sessions not_required_sessions unknown_sessions complete"): return False
            else:
                names = fixed_keys + " status reason raw_open session_volume fill_fraction_pct evidence " + pairs(day_amounts)
                if kind == "limit_day": names += " limit_price limit_price_exact limit_supplied open_condition intraday_outcome"
                if not _keys(row, names) or not _amounts(row, day_amounts) or not _bars(row["evidence"]): return False
                if row["status"] == "unavailable" and any(row[key] is not None for key in (*day_amounts.split(), "raw_open", "session_volume", "fill_fraction_pct")): return False
            if row["reason"] is not None and not isinstance(row["reason"], str): return False
            if kind != "volume_day":
                if not _amounts(row, "limit_price"): return False
                if row["limit_price"] is not None and row["limit_price"] <= 0: return False
            if kind == "limit_day" and (type(row["limit_supplied"]) is not bool or row["limit_supplied"] != (row["limit_price"] is not None)
                    or row["open_condition"] not in ("unavailable", "not_applied", "satisfied", "not_satisfied")
                    or row["intraday_outcome"] != "unknown_from_daily_bars"): return False
            points = row["sessions"] if kind == "open_gtd" else [row]
            for point in points:
                for name in ("raw_open", "session_volume"):
                    if point[name] is not None and (not comparison._finite(point[name]) or point[name] < 0): return False
                if kind == "open_gtd" and point["open_condition"] not in ("unavailable", "not_applied", "satisfied", "not_satisfied"): return False
            if kind != "open_gtd" and row["fill_fraction_pct"] is not None and (not comparison._finite(row["fill_fraction_pct"]) or not 0 <= row["fill_fraction_pct"] <= 100): return False
        counts = value["coverage"]
        if kind == "open_gtd":
            if not _keys(counts, "required_orders complete_orders unavailable_orders observed_prefix_orders") or not all(_integer(v) for v in counts.values()): return False
            if counts["observed_prefix_orders"] != sum(row["observed_prefix_end"] is not None for row in value["orders"]): return False
            expected = "complete" if orders and counts["complete_orders"] == len(orders) else "unavailable"
            bars = [{"symbol": row["symbol"], "sessions": [{"date": step["date"], "evidence": step["evidence"]} for step in row["sessions"]]} for row in value["orders"]]
        else:
            if not _keys(counts, "required available unavailable") or not all(_integer(v) for v in counts.values()): return False
            expected = "unavailable" if not counts["available"] else "complete" if counts["available"] == len(orders) else "incomplete"
            bars = [{"symbol": row["symbol"], "evidence": row["evidence"]} for row in value["orders"]]
        if value["status"] != expected or value["bars_fingerprint"] != paper._hash(bars): return False
        if orders: return comparison._shape(value, kind)
        return (all(v == 0 for v in counts.values()) and source["available"] is False
                and isinstance(source["reason"], str) and value["reason"] == source["reason"])
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
        if not isinstance(saved, dict) or set(saved) != {"account_id", "proposal_id", "save_request"}:
            return row, None, "archive_saved_request_invalid"
        body = receipts._SAVE.validate_python(saved["save_request"])
        if saved["save_request"] != body.model_dump():
            return row, None, "archive_saved_request_invalid"
        payload, _raw, issue = receipts._decode(row)
        if payload is None:
            return row, None, issue
        if set(payload) != {"engine_version", "receipt_id", "kind", "created_at", "request", "account_context", "source_context", "evidence", "method", "policy"}:
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
        "record": record, "row_checksum": _hash(record), "integrity": {"available": payload is not None, "reason": issue},
        "diagnostic_status": payload["evidence"]["status"] if payload else None, "kind": _metadata(row, "kind"), "proposal_id": _metadata(row, "proposal_id"), "currentness": _currentness(db, payload)}


def _set_hash(records):
    return _hash(sorted(_hash(record) for record in records))



def _version_reasons(payload):
    reasons = []
    if payload["engine_version"] != receipts.ENGINE_VERSION: reasons.append("archive_receipt_method_unsupported")
    if (payload["source_context"]["versions"] != receipts._versions(payload["kind"])
            or payload["evidence"]["source"]["engine_version"] != volume.SUPPORTED_PAPER_VERSION): reasons.append("archive_evidence_method_unsupported")
    module = {"volume_day": volume, "limit_day": limit, "open_gtd": gtd}[payload["kind"]]
    if payload["method"] != receipts.METHOD or payload["evidence"]["method"] != module.METHOD:
        reasons.append("archive_method_text_unsupported")
    return reasons


@router.get(BASE)
@store.snapshot_read
def export_archive(account_id: receipts.Identifier):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        account = paper._account(db, account_id)
        total = db.execute("SELECT COUNT(*) FROM execution_study_receipts").fetchone()[0]
        account_total = db.execute("SELECT COUNT(*) FROM execution_study_receipts WHERE CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),)).fetchone()[0]
        if total > receipts.MAX_TOTAL or account_total > receipts.MAX_ACCOUNT:
            raise _problem("study_archive_count_limit")
        records = _read_rows(db, "CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),))
        entries = [_entry(db, record, index + 1) for index, record in enumerate(records)]
        verified = sum(item["integrity"]["available"] for item in entries)
        value = {"engine_version": ENGINE_VERSION, "schema_version": SCHEMA_VERSION,
            "archive_kind": "account_execution_study_receipts", "canonicalization": CANONICAL, "columns": list(COLUMNS),
            "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "input_revision": store.input_revision(db), "exported_at": store.now(), "method": METHOD, "records": entries,
            "coverage": {"account_total": len(entries), "exported": len(entries), "raw_complete": len(entries),
                "verified": verified, "unavailable": len(entries) - verified, "complete_set": True},
            "retention": {"account_limit": receipts.MAX_ACCOUNT, "global_limit": receipts.MAX_TOTAL,
                "max_original_payload_bytes": receipts.MAX_BYTES, "max_archive_bytes": 33554432, "automatic_deletion": False},
            "policy": dict(POLICY), "set_fingerprint": _set_hash(records)}
        value["checksum"] = _hash(value)
        encoded = receipts._json(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("study_archive_size_limit")
        if sessions.latest_completed_session() != as_of:
            raise _problem("study_archive_session_changed", 409)
        return Response(encoded, media_type="application/json", headers={"Cache-Control": "no-store"})


def _preflight(db, account_id, account, raw):
    total = db.execute("SELECT COUNT(*) FROM execution_study_receipts").fetchone()[0]
    account_total = db.execute("SELECT COUNT(*) FROM execution_study_receipts WHERE CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),)).fetchone()[0]
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
    if archive["method"] != METHOD: reasons.append("archive_method_text_unsupported")
    if archive["columns"] != list(COLUMNS): reasons.append("archive_record_columns_invalid")
    if archive["checksum"] != _hash({key: value for key, value in archive.items() if key != "checksum"}): reasons.append("archive_checksum_mismatch")
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
        if entry["row_checksum"] != _hash(entry["record"]): problems.append("archive_row_checksum_mismatch")
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
            if any(entry[key] != _metadata(row, key) for key in ("id", "content_fingerprint", "kind", "proposal_id")):
                problems.append("archive_entry_identity_mismatch")
        if payload: problems.extend(_version_reasons(payload))
        matching_account = row is not None and row["account_id"] == account_id and archive["account_id"] == account_id
        results.append({"ordinal": entry["ordinal"], "id": entry["id"], "kind": entry["kind"], "proposal_id": entry["proposal_id"],
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
def preflight_archive(account_id: receipts.Identifier, request: Request):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        account = paper._account(db, account_id)
        value = _preflight(db, account_id, account, request.state.study_archive_bytes)
        if sessions.latest_completed_session() != as_of:
            raise _problem("study_archive_session_changed", 409)
        return _reply(value)
