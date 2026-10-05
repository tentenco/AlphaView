"""Account-scoped human annotations; never alter local-model evidence or authority."""
from datetime import date, datetime
import json
import re
from typing import Annotated, Literal
import uuid

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator, model_validator

from . import local_agent as local, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-local-agent-review-v1"
ID = Annotated[str, Path(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]
MAX_SOURCE_BYTES = 4_000_000
REASONS = ("evidence_uncertain", "source_stale", "model_limitations", "allocation_concern", "insufficient_information")
State = Literal["review_required", "reviewed", "rejected"]
Reason = Literal["evidence_uncertain", "source_stale", "model_limitations", "allocation_concern", "insufficient_information"]
METHOD = (
    "Independent human research annotations for one account and saved local-model analysis. "
    "Reviewed means seen, not verified or approved. Rejected records a human research judgment, not an execution control. "
    "Program evidence, source currentness and paper authorization remain independent and unchanged. "
    "Every immutable event binds the full saved analysis/rule content, current account/version/policy, "
    "input revision, completed session and verifier identities. Changed context requires a new review. "
    "No model calls, raw output, notes, target changes, proposal creation, orders or authority expansion."
)


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS local_agent_review_events (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, analysis_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>=1), engine_version TEXT NOT NULL,
        binding_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('review_required','reviewed','rejected')),
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
        UNIQUE(account_id,analysis_id,version), UNIQUE(account_id,analysis_id,idempotency_key)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_local_agent_review_scope ON local_agent_review_events(account_id,analysis_id,version DESC)")


def _problem(code, status=409):
    return HTTPException(status, {"code": code, "message": code})


class ReviewInput(paper.StrictInput):
    expected_version: int = Field(ge=0, le=2_147_483_646, strict=True)
    expected_account_version: int = Field(ge=1, le=2_147_483_647, strict=True)
    expected_input_revision: str = Field(min_length=1, max_length=100)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_binding_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    state: State
    reason_codes: list[Reason] = Field(default_factory=list, max_length=5)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")

    @model_validator(mode="before")
    @classmethod
    def finite_input(cls, value):
        try:
            json.dumps(value, allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise _problem("nonfinite_review_input", 422) from exc
        return value

    @field_validator("expected_as_of")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value

    @field_validator("reason_codes")
    @classmethod
    def unique_reasons(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("Duplicate review reasons")
        return sorted(value)

    @model_validator(mode="after")
    def rejection_reason(self):
        if self.state == "rejected" and not self.reason_codes:
            raise ValueError("A rejected research judgment needs an explicit concern")
        return self


def _record_fingerprint(row):
    if row is None:
        return None
    value = dict(row)
    if sum(len(item.encode("utf-8")) for item in value.values() if isinstance(item, str)) > MAX_SOURCE_BYTES:
        raise _problem("saved_review_source_too_large", 422)
    return paper._hash(value)


def _scope(account_id, row, rule):
    """Known account-bound sources cannot be annotated under another account.

    Unbound analyses remain globally readable, with annotations isolated by the
    selected account. Unreadable account context cannot be treated as unbound.
    """
    values = [row["source_json"], rule["result"] if rule else "{}"]
    for raw in values:
        try:
            parsed = local._decode(raw)
            if not isinstance(parsed, dict):
                raise ValueError("Source shape")
            bound = parsed.get("account_context")
            if bound is not None:
                if not isinstance(bound, dict) or not isinstance(bound.get("account_id"), str) or not bound["account_id"]:
                    raise ValueError("Account context")
                if bound["account_id"] != account_id:
                    raise _problem("analysis_account_mismatch", 404)
        except (ValueError, TypeError, KeyError) as exc:
            raise _problem("analysis_account_binding_unavailable") from exc


def _context(db, account_id, analysis_id):
    account = paper._account(db, account_id)
    row = local._row(db, analysis_id)
    rule_row = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (row["source_run_id"],)).fetchone()
    analysis_digest, rule_digest = _record_fingerprint(row), _record_fingerprint(rule_row)
    _scope(account_id, row, rule_row)
    as_of, revision = sessions.latest_completed_session(), store.input_revision(db)
    report = local._saved_evidence(db, row)
    try:
        currentness = local._currentness(db, row)
    except (ValueError, TypeError, KeyError, AttributeError):
        currentness = {"current": False, "stale_reasons": ["saved_source_unreadable"]}
    if sessions.latest_completed_session() != as_of:
        raise _problem("review_session_changed")
    verified = report["proof"] is not None
    problems = [check["reason"]["code"] for check in report["checks"] if check["reason"] is not None]
    program = {"integrity_version": local.INTEGRITY_VERSION, "evidence_status": report["status"], "verified": verified,
               "source_currentness": currentness, "proposal_eligible": verified and currentness["current"],
               "paper_preview_required": True, "validation_issues": report["validation_issues"],
               "uncertainty_codes": sorted(set(problems + currentness["stale_reasons"]))}
    binding = {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
               "symbol_policy_fingerprint": paper._hash(account["symbol_policy_json"]),
               "analysis_id": analysis_id, "analysis_engine_version": row["engine_version"],
               "analysis_content_fingerprint": analysis_digest, "analysis_status": row["status"],
               "cancel_requested": bool(row["cancel_requested"]), "source_run_id": row["source_run_id"],
               "rule_content_fingerprint": rule_digest, "rule_engine_version": rule_row["engine_version"] if rule_row else None,
               "saved_as_of": row["as_of"], "saved_input_revision": row["input_revision"],
               "as_of": as_of, "input_revision": revision,
               "authorization_fingerprint": report["proof"]["authorization_fingerprint"] if verified else None,
               "program": program}
    try:
        _safe_binding(binding)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise _problem("analysis_review_metadata_unavailable") from exc
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "analysis_id": analysis_id,
            "binding": binding, "binding_fingerprint": paper._hash(binding), "program": program,
            "can_review": row["status"] not in ("queued", "running"),
            "unavailable_reason": "analysis_still_active" if row["status"] in ("queued", "running") else None,
            "reason_options": list(REASONS), "method": METHOD}


def _safe_binding(binding):
    """Only provenance and fixed verifier codes may be exposed in review history."""
    keys = {"engine_version", "account_id", "account_version", "symbol_policy_fingerprint", "analysis_id",
            "analysis_engine_version", "analysis_content_fingerprint", "analysis_status", "cancel_requested",
            "source_run_id", "rule_content_fingerprint", "rule_engine_version", "saved_as_of", "saved_input_revision",
            "as_of", "input_revision", "authorization_fingerprint", "program"}
    if not isinstance(binding, dict) or set(binding) != keys or binding["engine_version"] != ENGINE_VERSION:
        raise ValueError("Binding shape")
    for field in ("account_id", "analysis_id", "source_run_id", "analysis_engine_version", "rule_engine_version"):
        value = binding[field]
        if field == "rule_engine_version" and value is None:
            continue
        if not isinstance(value, str) or not 1 <= len(value) <= 100 or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
            raise ValueError("Binding identifier")
    for field in ("symbol_policy_fingerprint", "analysis_content_fingerprint", "rule_content_fingerprint", "authorization_fingerprint"):
        value = binding[field]
        if field in ("rule_content_fingerprint", "authorization_fingerprint") and value is None:
            continue
        if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{64}", value) is None:
            raise ValueError("Binding fingerprint")
    for field in ("input_revision", "saved_input_revision"):
        if not isinstance(binding[field], str) or not 1 <= len(binding[field]) <= 100:
            raise ValueError("Binding revision")
    for field in ("as_of", "saved_as_of"):
        value = binding[field]
        if not isinstance(value, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
            raise ValueError("Binding session")
        date.fromisoformat(value)
    if (type(binding["account_version"]) is not int or not 1 <= binding["account_version"] <= 2_147_483_647
            or type(binding["cancel_requested"]) is not bool
            or binding["analysis_status"] not in ("queued", "running", "completed", "blocked", "failed", "cancelled", "stale", "interrupted")):
        raise ValueError("Binding state")
    program = binding["program"]
    if not isinstance(program, dict) or set(program) != {"integrity_version", "evidence_status", "verified", "source_currentness",
            "proposal_eligible", "paper_preview_required", "validation_issues", "uncertainty_codes"}:
        raise ValueError("Program shape")
    if program["integrity_version"] != local.INTEGRITY_VERSION:
        raise ValueError("Program method")
    current = program["source_currentness"]
    if (not isinstance(current, dict) or set(current) != {"current", "stale_reasons"}
            or type(current["current"]) is not bool or type(program["verified"]) is not bool
            or type(program["proposal_eligible"]) is not bool or program["paper_preview_required"] is not True
            or program["evidence_status"] not in ("verified", "failed", "unavailable")
            or program["verified"] != (program["evidence_status"] == "verified")
            or program["proposal_eligible"] != (program["verified"] and current["current"])):
        raise ValueError("Program status")
    for codes in (program["validation_issues"], program["uncertainty_codes"], current["stale_reasons"]):
        if not isinstance(codes, list) or len(codes) > 100 or any(not isinstance(code, str) or not code or len(code) > 100
                or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789_" for character in code) for code in codes):
            raise ValueError("Program codes")


def _event(row):
    """Do not present any receipt body or state when local immutable evidence fails."""
    metadata = {key: row[key] for key in ("id", "account_id", "analysis_id", "version", "created_at", "engine_version",
                                         "binding_fingerprint", "content_fingerprint")}
    payload, issue = None, None
    try:
        if len(row["payload_json"].encode()) > 100_000:
            raise ValueError("Receipt size")
        candidate = local._decode(row["payload_json"])
        if (not isinstance(candidate, dict) or set(candidate) != {"id", "engine_version", "account_id", "analysis_id",
                "version", "created_at", "binding_fingerprint", "binding", "state", "reason_codes", "request"}
                or paper._hash(candidate) != row["content_fingerprint"]):
            raise ValueError("Receipt content")
        for key in ("id", "account_id", "analysis_id", "version", "created_at", "engine_version", "binding_fingerprint", "state"):
            if candidate.get(key) != row[key]:
                raise ValueError("Receipt identity")
        if candidate["engine_version"] != ENGINE_VERSION or candidate["state"] not in ("review_required", "reviewed", "rejected"):
            raise ValueError("Receipt method/state")
        if type(candidate["version"]) is not int or not 1 <= candidate["version"] <= 2_147_483_647:
            raise ValueError("Receipt version")
        if datetime.fromisoformat(candidate["created_at"].replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("Receipt time")
        body = ReviewInput.model_validate(candidate["request"])
        if (body.state != candidate["state"] or body.reason_codes != candidate["reason_codes"]
                or body.expected_version + 1 != candidate["version"] or body.idempotency_key != row["idempotency_key"]
                or paper._hash(body.model_dump()) != row["request_hash"]
                or paper._hash(candidate["binding"]) != row["binding_fingerprint"]
                or body.expected_binding_fingerprint != row["binding_fingerprint"]):
            raise ValueError("Receipt binding")
        binding = candidate["binding"]
        _safe_binding(binding)
        if binding["account_id"] != row["account_id"] or binding["analysis_id"] != row["analysis_id"]:
            raise ValueError("Receipt scope")
        if (body.expected_account_version != binding["account_version"] or body.expected_as_of != binding["as_of"]
                or body.expected_input_revision != binding["input_revision"]):
            raise ValueError("Receipt source")
        payload = candidate
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, HTTPException):
        issue = "review_event_unverifiable"
    return {**metadata, "integrity": {"available": payload is not None, "reason": issue}, "receipt": payload}


def _latest(db, account_id, analysis_id):
    return db.execute("SELECT * FROM local_agent_review_events WHERE account_id=? AND analysis_id=? ORDER BY version DESC LIMIT 1",
                      (account_id, analysis_id)).fetchone()


def _view(db, context):
    row = _latest(db, context["account_id"], context["analysis_id"])
    latest = _event(row) if row else None
    valid = bool(latest and latest["integrity"]["available"])
    matches = bool(valid and latest["binding_fingerprint"] == context["binding_fingerprint"])
    return {**context, "version": row["version"] if row else 0, "latest": latest,
            "effective_state": latest["receipt"]["state"] if matches else "review_required",
            "review_current": matches,
            "review_reason": None if matches else "no_review" if row is None else "source_changed" if valid else "review_history_unavailable"}


def _reply(value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


@router.get("/api/paper/accounts/{account_id}/local-agent/{analysis_id}/review")
@store.snapshot_read
def get_review(account_id: ID, analysis_id: ID):
    with store.connect() as db:
        return _reply(_view(db, _context(db, account_id, analysis_id)))


@router.post("/api/paper/accounts/{account_id}/local-agent/{analysis_id}/review")
def record_review(account_id: ID, analysis_id: ID, body: ReviewInput):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        context = _context(db, account_id, analysis_id)
        if not context["can_review"]:
            raise _problem("analysis_still_active")
        for field in ("account_version", "input_revision", "as_of"):
            if getattr(body, f"expected_{field}") != context["binding"][field]:
                raise _problem("review_context_changed")
        if body.expected_binding_fingerprint != context["binding_fingerprint"]:
            raise _problem("review_context_changed")
        latest = _latest(db, account_id, analysis_id)
        # A corrupt head cannot silently fall back or be papered over by a new review.
        if latest and not _event(latest)["integrity"]["available"]:
            raise _problem("review_history_unavailable")
        request_hash = paper._hash(body.model_dump())
        existing = db.execute("SELECT * FROM local_agent_review_events WHERE account_id=? AND analysis_id=? AND idempotency_key=?",
                              (account_id, analysis_id, body.idempotency_key)).fetchone()
        if existing:
            if existing["request_hash"] != request_hash:
                raise _problem("review_key_conflict")
            if latest is None or existing["id"] != latest["id"]:
                raise _problem("review_superseded")
            if sessions.latest_completed_session() != context["binding"]["as_of"]:
                raise _problem("review_session_changed")
            return _reply({**_view(db, context), "changed": False})
        version = latest["version"] if latest else 0
        if body.expected_version != version:
            raise _problem("review_version_changed")
        payload = {"id": uuid.uuid4().hex, "engine_version": ENGINE_VERSION, "account_id": account_id,
                   "analysis_id": analysis_id, "version": version + 1, "created_at": store.now(),
                   "binding_fingerprint": context["binding_fingerprint"], "binding": context["binding"],
                   "state": body.state, "reason_codes": body.reason_codes, "request": body.model_dump()}
        if sessions.latest_completed_session() != context["binding"]["as_of"]:
            raise _problem("review_session_changed")
        db.execute("""INSERT INTO local_agent_review_events
            (id,account_id,analysis_id,version,engine_version,binding_fingerprint,state,idempotency_key,request_hash,
             created_at,content_fingerprint,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (payload["id"], account_id, analysis_id, version + 1, ENGINE_VERSION, context["binding_fingerprint"], body.state,
             body.idempotency_key, request_hash, payload["created_at"], paper._hash(payload), paper._json(payload)))
        return _reply({**_view(db, context), "changed": True})


@router.get("/api/paper/accounts/{account_id}/local-agent/{analysis_id}/reviews")
@store.snapshot_read
def history(account_id: ID, analysis_id: ID,
            limit: str = Query(default="20", pattern=r"^[1-9]\d{0,2}$"),
            offset: str = Query(default="0", pattern=r"^(0|[1-9]\d{0,3})$")):
    size, start = int(limit), int(offset)
    if size > 50 or start > 5000:
        raise _problem("review_history_bounds", 422)
    with store.connect() as db:
        paper._account(db, account_id)
        rows = db.execute("SELECT * FROM local_agent_review_events WHERE account_id=? AND analysis_id=? ORDER BY version DESC LIMIT ? OFFSET ?",
                          (account_id, analysis_id, size, start)).fetchall()
        total = db.execute("SELECT count(*) FROM local_agent_review_events WHERE account_id=? AND analysis_id=?", (account_id, analysis_id)).fetchone()[0]
        return _reply({"engine_version": ENGINE_VERSION, "account_id": account_id, "analysis_id": analysis_id,
                       "items": [_event(row) for row in rows],
                       "pagination": {"limit": size, "offset": start, "total": total, "returned": len(rows)}, "method": METHOD})


@router.get("/api/paper/accounts/{account_id}/local-agent/{analysis_id}/reviews/{review_id}")
@store.snapshot_read
def get_event(account_id: ID, analysis_id: ID, review_id: ID):
    with store.connect() as db:
        paper._account(db, account_id)
        row = db.execute("SELECT * FROM local_agent_review_events WHERE id=? AND account_id=? AND analysis_id=?",
                         (review_id, account_id, analysis_id)).fetchone()
        if row is None:
            raise _problem("review_not_found", 404)
        return _reply(_event(row))
