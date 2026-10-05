"""Held-symbol, read-only inspection of saved corporate-action payload revisions."""
from datetime import date, datetime
import json
import math
import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import Field, model_validator

from . import corporate_action_evidence as evidence, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-corporate-action-history-v1"
AccountId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
Symbol = Annotated[str, Path(min_length=1, max_length=20, pattern=r"^[A-Z0-9][A-Z0-9.\-^=]{0,19}$")]
Revision = Annotated[str, Path(pattern=r"^[1-9]\d{0,9}$")]
CELL_FIELDS = ("raw_type", "raw_value", "value", "reason")
METHOD = (
    "Read-only saved payload history for a finite positive current holding of the selected paper account. "
    "A revision is a distinct adapter-returned payload, not each fetch. Compare exactly two saved revisions "
    "by (ex_date,kind), preserving raw type, raw value, numeric value and unavailable reason. "
    "Historical capture coverage/window is unknown: only the latest coverage record is stored and is not "
    "reused as historical coverage. Source completeness is always unknown. Added/removed rows describe "
    "saved payload differences only, never actual occurrence/cancellation or a missing amount of zero. "
    "Canonical content hashes verify payload consistency, not signatures, symbol identity or first-fetch time; "
    "symbol/revision/time are separately format-checked stored metadata. No provider fetch or ledger changes."
)


def _problem(code, status=422):
    return HTTPException(status, {"code": code, "message": code})


class CompareInput(paper.StrictInput):
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    baseline_revision: int = Field(ge=1, le=2_147_483_647, strict=True)
    selected_revision: int = Field(ge=1, le=2_147_483_647, strict=True)
    expected_baseline_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_selected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="before")
    @classmethod
    def finite(cls, value):
        try:
            json.dumps(value, allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise _problem("nonfinite_history_input") from exc
        return value

    @model_validator(mode="after")
    def distinct(self):
        if self.baseline_revision == self.selected_revision:
            raise ValueError("Select two distinct saved revisions")
        return self


def _positive(value):
    try:
        return not isinstance(value, bool) and math.isfinite(float(value)) and float(value) > 0
    except (TypeError, ValueError, OverflowError):
        return False


def _base(db, account_id, symbol=None):
    account = paper._account(db, account_id)
    if symbol is not None:
        holding = db.execute("SELECT shares FROM paper_holdings WHERE account_id=? AND symbol=?", (account_id, symbol)).fetchone()
        if holding is None or holding["shares"] == 0:
            raise _problem("symbol_not_currently_held", 404)
        if not _positive(holding["shares"]):
            raise _problem("holding_scope_unavailable", 409)
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
            "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db),
            "source_completeness": "unknown", "historical_coverage": None,
            "historical_coverage_reason": "historical_capture_coverage_not_stored", "method": METHOD,
            **({"symbol": symbol} if symbol is not None else {})}


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON key")
        value[key] = item
    return value


def _decode(raw):
    def reject(value):
        raise ValueError("Nonfinite JSON")
    return json.loads(raw, parse_constant=reject, object_pairs_hook=_pairs)


def _payload_valid(payload):
    if not isinstance(payload, dict) or set(payload) != {"engine_version", "source", "adapter_version", "source_completeness",
                                                       "value_basis", "columns_present", "events"}:
        raise ValueError("payload_schema_unavailable")
    if payload["engine_version"] != evidence.ENGINE_VERSION:
        raise ValueError("unsupported_evidence_method")
    if (payload["source"] != evidence.SOURCE or payload["source_completeness"] != "unknown"
            or payload["value_basis"] != "adapter_returned_not_wire_payload"
            or not isinstance(payload["adapter_version"], str) or not 1 <= len(payload["adapter_version"]) <= 1000):
        raise ValueError("payload_schema_unavailable")
    columns = payload["columns_present"]
    if not isinstance(columns, dict) or set(columns) != set(evidence.FIELDS) or any(type(value) is not bool for value in columns.values()):
        raise ValueError("payload_schema_unavailable")
    events = payload["events"]
    if not isinstance(events, list) or len(events) > evidence.MAX_ROWS * 2:
        raise ValueError("event_count_unavailable")
    seen = set()
    for event in events:
        if not isinstance(event, dict) or set(event) != {"ex_date", "kind", *CELL_FIELDS}:
            raise ValueError("event_schema_unavailable")
        day, kind = event["ex_date"], event["kind"]
        if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day or kind not in evidence.FIELDS.values():
            raise ValueError("event_schema_unavailable")
        identity = (day, kind)
        if identity in seen:
            raise ValueError("duplicate_event_identity")
        seen.add(identity)
        column = next(key for key, value in evidence.FIELDS.items() if value == kind)
        if not columns[column]:
            raise ValueError("event_column_mismatch")
        if (not isinstance(event["raw_type"], str) or not re.fullmatch(r"[A-Za-z0-9_.]{1,64}", event["raw_type"])
                or not (event["raw_value"] is None or isinstance(event["raw_value"], str) and len(event["raw_value"]) <= 256)):
            raise ValueError("event_cell_unavailable")
        value, reason = event["value"], event["reason"]
        if reason is None:
            if (type(value) not in (int, float) or not _positive(value) or event["raw_value"] is None
                    or event["raw_type"] in ("str", "bool", "bool_", "NoneType")):
                raise ValueError("event_cell_unavailable")
        elif reason not in ("missing_value", "non_numeric_value", "non_finite_value", "negative_value") or value is not None:
            raise ValueError("event_cell_unavailable")
        if (event["raw_value"] is None or event["raw_type"] == "NoneType" or reason == "missing_value") and not (
                event["raw_value"] is None and event["raw_type"] == "NoneType" and reason == "missing_value"):
            raise ValueError("event_cell_unavailable")


def _revision(row, *, detail=False):
    raw, payload, reason = None, None, None
    valid_revision = type(row["revision"]) is int and 1 <= row["revision"] <= 2_147_483_647
    valid_fingerprint = isinstance(row["fingerprint"], str) and re.fullmatch(r"[a-f0-9]{64}", row["fingerprint"]) is not None
    timestamp = row["first_fetched_at"]
    valid_time = False
    if isinstance(timestamp, str) and len(timestamp) <= 80:
        try:
            valid_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).tzinfo is not None
        except ValueError:
            valid_time = False
    try:
        if not valid_revision or not valid_fingerprint or not valid_time:
            raise ValueError("stored_metadata_unavailable")
        raw = row["payload_json"]
        if not isinstance(raw, str) or len(raw.encode()) > evidence.MAX_BYTES:
            raise ValueError("payload_size_unavailable")
        candidate = _decode(raw)
        if evidence._hash(candidate) != row["fingerprint"]:
            raise ValueError("payload_hash_mismatch")
        _payload_valid(candidate)
        payload = candidate
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as exc:
        code = str(exc)
        reason = code if code in {"stored_metadata_unavailable", "payload_size_unavailable", "payload_hash_mismatch",
            "payload_schema_unavailable", "unsupported_evidence_method", "event_count_unavailable", "event_schema_unavailable",
            "duplicate_event_identity", "event_column_mismatch", "event_cell_unavailable"} else "saved_payload_unreadable"
    return {"symbol": row["symbol"], "revision": row["revision"] if valid_revision else None,
            "fingerprint": row["fingerprint"] if valid_fingerprint else None,
            "first_fetched_at": timestamp if valid_time else None,
            "integrity": {"available": payload is not None, "reason": reason},
            "evidence_engine_version": payload["engine_version"] if payload else None,
            "adapter_version": payload["adapter_version"] if payload else None,
            "saved_event_count": len(payload["events"]) if payload else None,
            "columns_present": payload["columns_present"] if payload else None,
            "source_completeness": "unknown", "historical_coverage": None,
            "historical_coverage_reason": "historical_capture_coverage_not_stored",
            **({"payload": payload, "payload_json": raw if payload is not None else None} if detail else {})}


def _get(db, symbol, revision):
    row = db.execute("SELECT * FROM corporate_action_evidence WHERE symbol=? AND revision=?", (symbol, revision)).fetchone()
    if row is None:
        raise _problem("evidence_revision_not_found", 404)
    return _revision(row, detail=True)


def _changes(baseline, selected):
    old = {(event["ex_date"], event["kind"]): event for event in baseline["events"]}
    new = {(event["ex_date"], event["kind"]): event for event in selected["events"]}
    rows = []
    for day, kind in sorted(old.keys() | new.keys()):
        before, after = old.get((day, kind)), new.get((day, kind))
        if before == after:
            continue
        codes = ["added"] if before is None else ["removed_from_saved_payload"] if after is None else []
        if before is not None and after is not None:
            if before["raw_type"] != after["raw_type"]:
                codes.append("raw_type_changed")
            if any(before[key] != after[key] for key in ("raw_value", "value", "reason")):
                codes.append("changed")
        fields = {key: {"baseline": before[key] if before else None, "selected": after[key] if after else None,
                       "baseline_reason": "event_absent_from_saved_payload" if before is None else before["reason"] if before[key] is None else None,
                       "selected_reason": "event_absent_from_saved_payload" if after is None else after["reason"] if after[key] is None else None}
                  for key in CELL_FIELDS}
        delta, delta_reason = None, None
        if before is None or after is None:
            delta_reason = "event_absent_from_saved_payload"
        elif before["reason"] is not None or after["reason"] is not None:
            delta_reason = "amount_unavailable"
        elif baseline["adapter_version"] != selected["adapter_version"]:
            delta_reason = "adapter_version_changed"
        elif before["raw_type"] != after["raw_type"]:
            delta_reason = "raw_type_changed"
        else:
            delta = after["value"] - before["value"]
            if not math.isfinite(delta):
                delta, delta_reason = None, "amount_delta_nonfinite"
        rows.append({"ex_date": day, "kind": kind, "change_types": codes, "baseline": before, "selected": after,
                     "baseline_reason": "event_absent_from_saved_payload" if before is None else None,
                     "selected_reason": "event_absent_from_saved_payload" if after is None else None,
                     "fields": fields, "numeric_delta": delta, "numeric_delta_reason": delta_reason})
    return rows


@router.get("/api/paper/accounts/{account_id}/corporate-actions/history/context")
@store.snapshot_read
def history_context(account_id: AccountId):
    with store.connect() as db:
        base = _base(db, account_id)
        rows = db.execute("SELECT symbol,shares FROM paper_holdings WHERE account_id=? ORDER BY symbol LIMIT 101", (account_id,)).fetchall()
        if len(rows) > 100:
            raise _problem("holding_scope_limit")
        items = []
        for row in rows:
            if row["shares"] == 0:
                continue
            valid = _positive(row["shares"]) and isinstance(row["symbol"], str) and re.fullmatch(r"[A-Z0-9][A-Z0-9.\-^=]{0,19}", row["symbol"]) is not None
            items.append({"symbol": row["symbol"], "available": valid, "reason": None if valid else "holding_scope_unavailable"})
        return {**base, "symbols": items}


@router.get("/api/paper/accounts/{account_id}/corporate-actions/history/{symbol}")
@store.snapshot_read
def history(account_id: AccountId, symbol: Symbol,
            limit: str = Query(default="20", pattern=r"^[1-9]\d{0,2}$"),
            offset: str = Query(default="0", pattern=r"^(0|[1-9]\d{0,3})$")):
    size, start = int(limit), int(offset)
    if size > 50 or start > 5000:
        raise _problem("history_bounds")
    with store.connect() as db:
        base = _base(db, account_id, symbol)
        rows = db.execute("SELECT * FROM corporate_action_evidence WHERE symbol=? ORDER BY revision DESC LIMIT ? OFFSET ?", (symbol, size, start)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM corporate_action_evidence WHERE symbol=?", (symbol,)).fetchone()[0]
        return {**base, "items": [_revision(row) for row in rows],
                "pagination": {"limit": size, "offset": start, "total": total, "returned": len(rows)}}


@router.get("/api/paper/accounts/{account_id}/corporate-actions/history/{symbol}/{revision}")
@store.snapshot_read
def detail(account_id: AccountId, symbol: Symbol, revision: Revision):
    number = int(revision)
    if number > 2_147_483_647:
        raise _problem("revision_bounds")
    with store.connect() as db:
        return {**_base(db, account_id, symbol), "item": _get(db, symbol, number)}


@router.post("/api/paper/accounts/{account_id}/corporate-actions/history/{symbol}/compare")
@store.snapshot_read
def compare(account_id: AccountId, symbol: Symbol, body: CompareInput):
    with store.connect() as db:
        base = _base(db, account_id, symbol)
        if body.expected_account_version != base["account_version"]:
            raise _problem("account_scope_changed", 409)
        baseline, selected = _get(db, symbol, body.baseline_revision), _get(db, symbol, body.selected_revision)
        for item, expected in ((baseline, body.expected_baseline_fingerprint), (selected, body.expected_selected_fingerprint)):
            if item["fingerprint"] is not None and item["fingerprint"] != expected:
                raise _problem("evidence_fingerprint_changed", 409)
        available = baseline["integrity"]["available"] and selected["integrity"]["available"]
        changes = _changes(baseline["payload"], selected["payload"]) if available else None
        return {**base, "request": body.model_dump(), "status": "compared" if available else "unavailable",
                "baseline": baseline, "selected": selected, "changes": changes,
                "change_count": len(changes) if changes is not None else None,
                "reason": None if available else "saved_evidence_unavailable"}
