"""Immutable per-submission sweep observations, appended with the latest summary."""
from datetime import date, datetime, timezone
import hashlib
import json

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import JSONResponse

from . import paper_portfolio as paper, store

router = APIRouter()
ENGINE_VERSION = "alphaview-execution-sweep-history-v1"
QUERY_VERSION = "alphaview-execution-sweep-query-v1"
EXPORT_VERSION = "alphaview-execution-sweep-export-v1"
MAX_EXPORT_EVENTS, MAX_EXPORT_BYTES = 250, 2 * 1024 * 1024
METHOD = (
    "Each nonempty affected submission records its exact sweep receipt in the same final transaction as its latest summary. "
    "Events are immutable historical observations, with no backfill from old summaries. Reads verify content and identity "
    "without fetching broker state or changing orders. Current order status remains separate."
)
WARNINGS = [
    "A recorded cancel request is not confirmation of cancellation; later reconciliation may report a fill.",
    "History begins when this feature is installed. Empty history does not prove that no earlier sweep occurred.",
    "Hashes detect inconsistent local records; they are not signatures against a party able to rewrite the database and hashes.",
]
ID_PATTERN = r"^[A-Za-z0-9_-]+$"


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS execution_sweep_events (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, submission_id TEXT NOT NULL,
        created_at TEXT NOT NULL, engine_version TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_execution_sweep_events_account ON execution_sweep_events(account_id,created_at,id)")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _valid_payload(payload):
    if not isinstance(payload, dict) or payload.get("engine_version") != ENGINE_VERSION:
        return False
    if any(not _text(payload.get(key)) for key in ("account_id", "submission_id", "at", "reason")):
        return False
    try:
        if datetime.fromisoformat(payload["at"].replace("Z", "+00:00")).tzinfo is None:
            return False
    except (ValueError, TypeError):
        return False
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return False
    seen = set()
    for item in results:
        if (not isinstance(item, dict) or not _text(item.get("order_id")) or item["order_id"] in seen
                or item.get("submission_id") != payload["submission_id"] or not _text(item.get("symbol"))
                or item.get("side") not in ("buy", "sell")
                or item.get("previous_status") not in ("pending", "accepted", "partially_filled")
                or item.get("action") not in ("skipped", "unknown", "cancel_requested", "cancel_rejected")
                or "error" not in item):
            return False
        error = item["error"]
        if error is not None and (not isinstance(error, dict) or not _text(error.get("code"))):
            return False
        seen.add(item["order_id"])
    return True


def append_event(db, account_id, submission_id, receipt):
    """Caller owns the existing final BEGIN IMMEDIATE; no broker work or commit here."""
    if not db.in_transaction:
        raise RuntimeError("Sweep history requires the caller's write transaction")
    payload = {"engine_version": ENGINE_VERSION, "account_id": account_id, "submission_id": submission_id,
               "at": receipt["at"], "reason": receipt["reason"], "results": receipt["results"]}
    if not _valid_payload(payload):
        raise _problem("sweep_event_invalid", "Sweep event is incomplete; history and latest summary were not published")
    try:
        encoded, identifier = _json(payload), _hash(payload)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise _problem("sweep_event_invalid", "Sweep event is not finite JSON; history and latest summary were not published") from None
    existing = db.execute("SELECT * FROM execution_sweep_events WHERE id=?", (identifier,)).fetchone()
    expected = (identifier, account_id, submission_id, payload["at"], ENGINE_VERSION, identifier, encoded)
    if existing is not None:
        if tuple(existing) != expected:
            raise _problem("sweep_event_conflict", "Existing sweep event content conflicts with this event; it was not overwritten")
        return identifier
    db.execute("INSERT INTO execution_sweep_events VALUES (?,?,?,?,?,?,?)", expected)
    return identifier


def _decode(row):
    try:
        payload = json.loads(row["payload_json"])
        if not _valid_payload(payload):
            return None, "sweep_event_unverifiable"
        fingerprint = _hash(payload)
        if fingerprint != row["content_fingerprint"] or fingerprint != row["id"]:
            return None, "sweep_event_content_changed"
        if (payload["account_id"] != row["account_id"] or payload["submission_id"] != row["submission_id"]
                or payload["at"] != row["created_at"] or payload["engine_version"] != row["engine_version"]):
            return None, "sweep_event_identity_changed"
        return payload, None
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError):
        return None, "sweep_event_unverifiable"


def _view(row, *, detail):
    payload, issue = _decode(row)
    counts = None
    if payload is not None:
        counts = {}
        for entry in payload["results"]:
            counts[entry["action"]] = counts.get(entry["action"], 0) + 1
    result = {key: row[key] for key in ("id", "account_id", "submission_id", "created_at", "engine_version", "content_fingerprint")}
    result.update(integrity={"available": payload is not None, "reason": issue},
                  at=payload["at"] if payload else None, reason=payload["reason"] if payload else None,
                  results_count=len(payload["results"]) if payload else None, counts=counts)
    if detail:
        result["event"] = payload
    return result


def _reply(value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


def _date_filter(value):
    if value is None:
        return None
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError
        return parsed
    except ValueError:
        raise _problem("sweep_filter_invalid", "Use a real UTC calendar date in YYYY-MM-DD format", 422) from None


def _filters(start_date, end_date, reason):
    first, last = _date_filter(start_date), _date_filter(end_date)
    if first is not None and last is not None and first > last:
        raise _problem("sweep_filter_invalid", "The first UTC date must not follow the last UTC date", 422)
    if reason is not None and (not reason.strip() or reason != reason.strip()):
        raise _problem("sweep_filter_invalid", "The exact reason must not be blank or have surrounding whitespace", 422)
    return first, last


def _query(db, account_id, submission_id, first, last, reason, size, start):
    paper._account(db, account_id)
    if submission_id is not None and db.execute("SELECT id FROM execution_submissions WHERE account_id=? AND id=?", (account_id, submission_id)).fetchone() is None:
        raise _problem("sweep_submission_not_found", "Submission was not found in this account", 404)
    condition, params = "account_id=?", [account_id]
    if submission_id is not None:
        condition += " AND submission_id=?"
        params.append(submission_id)
    filtering = first is not None or last is not None or reason is not None
    excluded = None
    if filtering:
        # Verify before filtering and pagination: untrusted JSON/column values cannot
        # masquerade as matches. Stream the account scope without retaining all payloads.
        rows, total, excluded = [], 0, 0
        for row in db.execute(f"SELECT * FROM execution_sweep_events WHERE {condition} ORDER BY created_at DESC,id DESC", params):
            payload, issue = _decode(row)
            if issue:
                excluded += 1
                continue
            try:
                at = datetime.fromisoformat(payload["at"].replace("Z", "+00:00")).astimezone(timezone.utc).date()
            except (ValueError, OverflowError):
                excluded += 1
                continue
            if ((first is not None and at < first) or (last is not None and at > last)
                    or (reason is not None and payload["reason"] != reason)):
                continue
            if start <= total < start + size:
                rows.append(row)
            total += 1
    else:
        total = db.execute(f"SELECT COUNT(*) FROM execution_sweep_events WHERE {condition}", params).fetchone()[0]
        rows = db.execute(f"SELECT * FROM execution_sweep_events WHERE {condition} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (*params, size, start)).fetchall()
    return rows, total, excluded


@router.get("/api/execution/accounts/{account_id}/sweep-history")
@store.snapshot_read
def list_events(account_id: str,
                limit: str = Query(default="20", pattern=r"^(?:[1-9]|[1-4][0-9]|50)$"),
                offset: str = Query(default="0", pattern=r"^(?:0|[1-9][0-9]{0,2}|[1-4][0-9]{3}|5000)$"),
                submission_id: str | None = Query(default=None, min_length=1, max_length=100, pattern=ID_PATTERN),
                start_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                end_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                reason: str | None = Query(default=None, min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f]+$")):
    size, start = int(limit), int(offset)
    first, last = _filters(start_date, end_date, reason)
    with store.connect() as db:
        rows, total, excluded = _query(db, account_id, submission_id, first, last, reason, size, start)
        return _reply({"engine_version": ENGINE_VERSION, "account_id": account_id,
                       "query_version": QUERY_VERSION,
                       "filters": {"submission_id": submission_id, "start_date": start_date, "end_date": end_date, "reason": reason},
                       "filter_coverage": {"unverifiable_excluded": excluded,
                                           "note": "Filtered totals include only verified matches; unfiltered history retains unverifiable records."},
                       "items": [_view(row, detail=False) for row in rows],
                       "pagination": {"limit": size, "offset": start, "total": total, "returned": len(rows)},
                       "method": METHOD, "warnings": WARNINGS})


@router.get("/api/execution/accounts/{account_id}/sweep-history/export")
@store.snapshot_read
def export_events(account_id: str,
                  submission_id: str | None = Query(default=None, min_length=1, max_length=100, pattern=ID_PATTERN),
                  start_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                  end_date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                  reason: str | None = Query(default=None, min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f]+$")):
    first, last = _filters(start_date, end_date, reason)
    with store.connect() as db:
        rows, total, excluded = _query(db, account_id, submission_id, first, last, reason, MAX_EXPORT_EVENTS, 0)
        if total > MAX_EXPORT_EVENTS:
            raise _problem("sweep_export_limit", "More than 250 matching events; narrow the dates, reason or submission before exporting", 413)
        items = [_view(row, detail=True) for row in rows]
        result = {"export_version": EXPORT_VERSION, "engine_version": ENGINE_VERSION, "query_version": QUERY_VERSION,
                  "account_id": account_id,
                  "filters": {"submission_id": submission_id, "start_date": start_date, "end_date": end_date, "reason": reason},
                  "filter_coverage": {"unverifiable_excluded": excluded}, "items": items,
                  "coverage": {"matching_events": total, "exported_events": len(items),
                               "verified_events": sum(item["integrity"]["available"] for item in items),
                               "unverifiable_events": sum(not item["integrity"]["available"] for item in items),
                               "complete_for_filters": True, "max_events": MAX_EXPORT_EVENTS, "max_bytes": MAX_EXPORT_BYTES},
                  "method": METHOD, "warnings": WARNINGS,
                  "purpose": "Read-only evidence copy, not an archive operation, deletion, import or execution request."}
        encoded = _json(result)
        if len(encoded.encode()) > MAX_EXPORT_BYTES:
            raise _problem("sweep_export_size", "Matching event content exceeds 2 MiB; narrow the query before exporting", 413)
        return _reply(result)


@router.get("/api/execution/accounts/{account_id}/sweep-history/{identifier}")
@store.snapshot_read
def get_event(account_id: str, identifier: str = Path(pattern=r"^[a-f0-9]{64}$")):
    with store.connect() as db:
        paper._account(db, account_id)
        row = db.execute("SELECT * FROM execution_sweep_events WHERE account_id=? AND id=?", (account_id, identifier)).fetchone()
        if row is None:
            raise _problem("sweep_event_not_found", "Saved sweep event was not found in this account", 404)
        return _reply(_view(row, detail=True))
