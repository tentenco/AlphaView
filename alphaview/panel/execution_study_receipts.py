"""Immutable research-only receipts for frozen saved-proposal execution studies."""
from datetime import datetime, timedelta
import hashlib
import json
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import Field, TypeAdapter

from . import execution_gtd_study as gtd, execution_limit_study as limit
from . import execution_volume_study as volume, paper_portfolio as paper, sessions, store

ENGINE_VERSION = "alphaview-execution-study-receipt-v1"
MAX_BYTES, MAX_REQUEST_BYTES, MAX_ACCOUNT, MAX_TOTAL = 2097152, 16384, 50, 250
BASE = "/api/paper/accounts/{account_id}/proposals/{proposal_id}/study-receipts"
HASH = r"^[a-f0-9]{64}$"
Identifier = volume.Identifier
ReceiptIdentifier = Annotated[str, Path(pattern=HASH)]
Kind = Literal["volume_day", "limit_day", "open_gtd"]
POLICY = {"advisory_only": True, "execution_source": False, "gating_authority": False}
METHOD = (
    "Immutable local research receipt for one existing saved-proposal volume DAY, open-only limit DAY "
    "or open-only GTD scenario. A new save rebuilds the original study inside a read snapshot and checks "
    "SHA-256 of its exact UTF-8 HTTP JSON bytes, independently of any embedded study fingerprint. "
    "Publication rechecks account policies, saved proposal record, input revision, completed session and "
    "method versions under BEGIN IMMEDIATE. Exact retries replay stored original bytes, even after context "
    "changes. Currentness describes the study evaluation context, not whether the older signal-date "
    "proposal is current or executable. Original gaps, zero scenarios, unknown intraday outcomes and "
    "expiry limitations remain unchanged. Historical reads never rebuild results. Caps: 50 per account, "
    "250 overall, 2 MiB per complete receipt; no truncation, import, deletion or overwriting. "
    "This is not a fill, broker state, execution source, permission, validation gate or trading advice."
)


class _FiniteRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def validate(request):
            # Bound the full JSON request before validation or study computation.
            if request.method == "POST" and len(await request.body()) > MAX_REQUEST_BYTES:
                return JSONResponse({"detail": {"code": "receipt_request_size_limit", "message": "Request exceeds 16 KiB"}}, status_code=422)
            try:
                return await handler(request)
            except RequestValidationError as error:
                return JSONResponse({"detail": [{key: item[key] for key in ("loc", "msg", "type")} for item in error.errors()]}, status_code=422)
        return validate


router = APIRouter(route_class=_FiniteRoute)


class VolumeRequest(volume.StudyInput):
    expected_account_version: int = Field(ge=1, le=2147483647, strict=True)


class _SaveBase(paper.StrictInput):
    expected_evidence_engine_version: str = Field(min_length=1, max_length=100)
    # Whole original HTTP response bytes; NOT GTD's embedded evidence_fingerprint.
    expected_raw_evidence_sha256: str = Field(pattern=HASH)


class SaveVolume(_SaveBase):
    kind: Literal["volume_day"]
    request: VolumeRequest


class SaveLimit(_SaveBase):
    kind: Literal["limit_day"]
    request: limit.StudyInput


class SaveGTD(_SaveBase):
    kind: Literal["open_gtd"]
    request: gtd.StudyInput


SaveInput = Annotated[SaveVolume | SaveLimit | SaveGTD, Field(discriminator="kind")]
_SAVE = TypeAdapter(SaveInput)


def ensure_schema(db):
    """Frozen host-initialization DDL; never called from receipt routes."""
    db.execute("""CREATE TABLE IF NOT EXISTS execution_study_receipts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('volume_day','limit_day','open_gtd')),
        created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB))<=16384),
        content_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=2097152)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_execution_study_receipts_scope ON execution_study_receipts(account_id,proposal_id,created_at,id)")


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _sha(raw):
    return hashlib.sha256(raw.encode("utf-8") if isinstance(raw, str) else raw).hexdigest()


def _problem(code, status=409):
    return HTTPException(status, {"code": code, "message": code})


def _reply(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


def _versions(kind):
    return {"receipt": ENGINE_VERSION, "evidence": {"volume_day": volume, "limit_day": limit, "open_gtd": gtd}[kind].ENGINE_VERSION,
            "volume": volume.ENGINE_VERSION, "limit": limit.ENGINE_VERSION if kind != "volume_day" else None,
            "paper": volume.SUPPORTED_PAPER_VERSION}


def _account(db, account_id):
    row = paper._account(db, account_id)
    return {"account_id": account_id, "version": row["version"], "kill_switch": bool(row["kill_switch"]),
            "limits": json.loads(row["limits_json"]), "execution_policy": json.loads(row["execution_policy_json"]),
            "symbol_policy": json.loads(row["symbol_policy_json"])}


def _proposal_hash(db, account_id, proposal_id):
    return _sha(_json(dict(paper._get_proposal(db, account_id, proposal_id))))


def _rebuild(account_id, proposal_id, body):
    if body.kind == "open_gtd":
        result = gtd.study(account_id, proposal_id, body.request, Response())
    else:
        result = (volume if body.kind == "volume_day" else limit).study(account_id, proposal_id, body.request)
    return result, JSONResponse(result).body.decode("utf-8")


def _payload(meta, raw):
    # Embed accepted server bytes literally. No JSON.parse/stringify representation loss.
    return '{"evidence":' + raw + ',' + _json(meta)[1:]


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("Nonfinite JSON")


_DECODER = json.JSONDecoder(object_pairs_hook=_pairs, parse_constant=_constant)


def _decode(row):
    try:
        encoded, requested = row["payload_json"], row["request_json"]
        if (not isinstance(encoded, str) or not isinstance(requested, str) or len(encoded.encode()) > MAX_BYTES
                or len(requested.encode()) > MAX_REQUEST_BYTES or not encoded.startswith('{"evidence":')):
            return None, None, "receipt_storage_invalid"
        if _sha(encoded) != row["content_fingerprint"]:
            return None, None, "receipt_content_changed"
        evidence, end = _DECODER.raw_decode(encoded, len('{"evidence":'))
        raw = encoded[len('{"evidence":'):end]
        payload, saved = _DECODER.decode(encoded), _DECODER.decode(requested)
        body = _SAVE.validate_python(saved["save_request"])
        context, source = payload["account_context"], payload["source_context"]
        meta = {key: value for key, value in payload.items() if key != "evidence"}
        if (encoded != _payload(meta, raw) or requested != _json(saved) or row["id"] != _sha(requested)
                or saved != {"account_id": row["account_id"], "proposal_id": row["proposal_id"], "save_request": body.model_dump()}
                or payload["receipt_id"] != row["id"] or payload["kind"] != row["kind"] or body.kind != row["kind"]
                or payload["engine_version"] != row["engine_version"] or payload["created_at"] != row["created_at"]
                or payload["request"] != body.request.model_dump() or evidence["request"] != body.request.model_dump()
                or context["account_id"] != row["account_id"] or type(context["version"]) is not int
                or context["version"] != body.request.expected_account_version or type(context["kill_switch"]) is not bool
                or any(not isinstance(context[key], dict) for key in ("limits", "execution_policy", "symbol_policy"))
                or evidence["account_id"] != row["account_id"] or evidence["account_version"] != context["version"]
                or evidence["source"]["id"] != row["proposal_id"] or evidence["source"]["account_id"] != row["account_id"]
                or evidence["source"]["proposal_fingerprint"] != body.request.expected_proposal_fingerprint
                or evidence["input_revision"] != body.request.expected_input_revision or evidence["as_of"] != body.request.expected_as_of
                or evidence["engine_version"] != body.expected_evidence_engine_version
                or source["raw_evidence_sha256"] != _sha(raw) or _sha(raw) != body.expected_raw_evidence_sha256
                or source["proposal_fingerprint"] != body.request.expected_proposal_fingerprint
                or source["input_revision"] != evidence["input_revision"] or source["as_of"] != evidence["as_of"]
                or source["bars_fingerprint"] != evidence["bars_fingerprint"] or source["versions"]["evidence"] != evidence["engine_version"]
                or source["versions"]["receipt"] != payload["engine_version"]
                or evidence["mode"] != "advisory_ex_post" or not isinstance(evidence["orders"], list)
                or not isinstance(evidence["coverage"], dict) or evidence["status"] not in ("complete", "incomplete", "unavailable")
                or payload["policy"] != POLICY or not isinstance(payload["method"], str)):
            return None, None, "receipt_unverifiable"
        # JSON decoding may overflow finite exponents; canonical encoding rejects it.
        _json(payload)
        for value in (source["record_fingerprint"], source["proposal_fingerprint"], source["bars_fingerprint"]):
            if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
                raise ValueError("Invalid source hash")
        stamp = datetime.fromisoformat(payload["created_at"])
        if stamp.utcoffset() != timedelta(0):
            raise ValueError("Invalid timestamp")
        if body.kind == "open_gtd" and evidence["evidence_fingerprint"] != paper._hash({key: value for key, value in evidence.items() if key != "evidence_fingerprint"}):
            raise ValueError("Invalid embedded GTD fingerprint")
        return payload, raw, None
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError, OverflowError):
        return None, None, "receipt_unverifiable"


def _currentness(db, payload):
    if payload is None:
        return {"current": None, "reasons": ["receipt_unverifiable"]}
    source, context = payload["source_context"], payload["account_context"]
    reasons = []
    try:
        if source["versions"] != _versions(payload["kind"]): reasons.append("method_changed")
        if source["input_revision"] != store.input_revision(db): reasons.append("inputs_changed")
        if source["as_of"] != sessions.latest_completed_session(): reasons.append("session_changed")
        if _account(db, context["account_id"]) != context: reasons.append("account_context_changed")
        if _proposal_hash(db, context["account_id"], payload["evidence"]["source"]["id"]) != source["record_fingerprint"]:
            reasons.append("proposal_changed")
        return {"current": not reasons, "reasons": reasons}
    except (HTTPException, ValueError, KeyError, TypeError, RecursionError, OverflowError):
        return {"current": None, "reasons": [*reasons, "context_unverifiable"]}


def _view(db, row, detail=True):
    payload, _raw, issue = _decode(row)
    def metadata(key, size=200):
        value = row[key]
        return value if isinstance(value, str) and len(value.encode()) <= size else ""
    evidence = payload["evidence"] if payload else None
    value = {key: metadata(key, 64 if key in ("id", "content_fingerprint") else 200) for key in
             ("id", "account_id", "proposal_id", "kind", "created_at", "engine_version", "content_fingerprint")}
    value.update(integrity={"available": payload is not None, "reason": issue}, currentness=_currentness(db, payload),
                 as_of=evidence["as_of"] if evidence else None, status=evidence["status"] if evidence else None,
                 coverage=evidence["coverage"] if evidence else None,
                 raw_evidence_sha256=payload["source_context"]["raw_evidence_sha256"] if payload else None,
                 source_proposal_current=evidence["source"]["current"] if evidence else None)
    if detail:
        value["receipt"] = payload
    return value


def _lookup(db, account_id, proposal_id, identifier):
    return db.execute("SELECT * FROM execution_study_receipts WHERE account_id=? AND proposal_id=? AND id=?",
                      (account_id, proposal_id, identifier)).fetchone()


def _replay(db, account_id, proposal_id, identifier, requested):
    row = _lookup(db, account_id, proposal_id, identifier)
    if row is None:
        return None
    if row["request_json"] != requested:
        raise _problem("receipt_request_conflict")
    payload, _raw, issue = _decode(row)
    if payload is None:
        raise _problem(issue)
    return {**_view(db, row), "replayed": True}


@router.post(BASE)
def save_receipt(account_id: Identifier, proposal_id: Identifier, body: SaveInput):
    saved = {"account_id": account_id, "proposal_id": proposal_id, "save_request": body.model_dump()}
    requested = _json(saved)
    if len(requested.encode()) > MAX_REQUEST_BYTES:
        raise _problem("receipt_request_size_limit", 422)
    identifier = _sha(requested)
    with store.read_snapshot():
        with store.connect() as db:
            replay = _replay(db, account_id, proposal_id, identifier, requested)
            if replay is not None:
                return _reply(replay)
            account = _account(db, account_id)
            proposal_hash = _proposal_hash(db, account_id, proposal_id)
            evidence, raw = _rebuild(account_id, proposal_id, body)
            if evidence["engine_version"] != body.expected_evidence_engine_version or _sha(raw) != body.expected_raw_evidence_sha256:
                raise _problem("receipt_evidence_changed")
            source = {"record_fingerprint": proposal_hash, "proposal_fingerprint": body.request.expected_proposal_fingerprint,
                      "input_revision": evidence["input_revision"], "as_of": evidence["as_of"],
                      "bars_fingerprint": evidence["bars_fingerprint"], "raw_evidence_sha256": _sha(raw), "versions": _versions(body.kind)}
            meta = {"engine_version": ENGINE_VERSION, "receipt_id": identifier, "kind": body.kind, "created_at": store.now(),
                    "request": body.request.model_dump(), "account_context": account, "source_context": source,
                    "policy": POLICY, "method": METHOD}
            encoded = _payload(meta, raw)
            if len(encoded.encode()) > MAX_BYTES:
                raise _problem("receipt_size_limit", 422)
            payload = {**meta, "evidence": evidence}
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _replay(db, account_id, proposal_id, identifier, requested)
        if replay is not None:
            return _reply(replay)
        if _currentness(db, payload)["current"] is not True:
            raise _problem("receipt_context_changed")
        if (db.execute("SELECT count(*) FROM execution_study_receipts WHERE account_id=?", (account_id,)).fetchone()[0] >= MAX_ACCOUNT
                or db.execute("SELECT count(*) FROM execution_study_receipts").fetchone()[0] >= MAX_TOTAL):
            raise _problem("receipt_capacity")
        db.execute("INSERT INTO execution_study_receipts VALUES (?,?,?,?,?,?,?,?,?)",
                   (identifier, account_id, proposal_id, body.kind, meta["created_at"], ENGINE_VERSION, requested, _sha(encoded), encoded))
        row = _lookup(db, account_id, proposal_id, identifier)
        if _decode(row)[0] is None:
            raise _problem("receipt_unverifiable")
        result = {**_view(db, row), "replayed": False}
    return _reply(result, 201)


@router.get(BASE)
@store.snapshot_read
def list_receipts(account_id: Identifier, proposal_id: Identifier, kind: Kind | None = None,
                  limit: int = Query(default=20, ge=1, le=20), offset: int = Query(default=0, ge=0, le=MAX_TOTAL)):
    with store.connect() as db:
        paper._get_proposal(db, account_id, proposal_id)
        where, args = " WHERE account_id=? AND proposal_id=?", [account_id, proposal_id]
        if kind is not None:
            where, args = where + " AND kind=?", [*args, kind]
        total = db.execute("SELECT count(*) FROM execution_study_receipts" + where, args).fetchone()[0]
        rows = db.execute("SELECT * FROM execution_study_receipts" + where + " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        return _reply({"engine_version": ENGINE_VERSION, "account_id": account_id, "proposal_id": proposal_id, "kind": kind,
                       "items": [_view(db, row, False) for row in rows],
                       "pagination": {"limit": limit, "offset": offset, "total": total, "returned": len(rows)},
                       "checked_as_of": sessions.latest_completed_session(), "checked_input_revision": store.input_revision(db),
                       "retention": {"per_account": MAX_ACCOUNT, "global": MAX_TOTAL, "max_bytes": MAX_BYTES, "automatic_deletion": False}, "method": METHOD})


@router.get(BASE + "/{identifier}")
@store.snapshot_read
def get_receipt(account_id: Identifier, proposal_id: Identifier, identifier: ReceiptIdentifier):
    with store.connect() as db:
        row = _lookup(db, account_id, proposal_id, identifier)
        if row is None:
            raise _problem("receipt_missing", 404)
        return _reply({**_view(db, row), "checked_as_of": sessions.latest_completed_session(), "checked_input_revision": store.input_revision(db)})


def _download(db, account_id, proposal_id, identifier, expected, original):
    row = _lookup(db, account_id, proposal_id, identifier)
    if row is None:
        raise _problem("receipt_missing", 404)
    _payload_value, raw, issue = _decode(row)
    if raw is None:
        raise _problem(issue)
    if row["content_fingerprint"] != expected:
        raise _problem("receipt_content_changed")
    content = raw if original else row["payload_json"]
    filename = f"alphaview-study-{row['kind']}-{account_id[:8]}-{proposal_id[:8]}-{identifier[:16]}-{'evidence' if original else 'receipt'}.json"
    return Response(content=content, media_type="application/json", headers={"Cache-Control": "no-store",
        "ETag": f'"{_sha(content)}"', "X-Receipt-Fingerprint": row["content_fingerprint"],
        "Content-Disposition": f'attachment; filename="{filename}"'})


@router.get(BASE + "/{identifier}/evidence.json")
@store.snapshot_read
def download_evidence(account_id: Identifier, proposal_id: Identifier, identifier: ReceiptIdentifier,
                      expected_content_fingerprint: str = Query(pattern=HASH)):
    with store.connect() as db:
        return _download(db, account_id, proposal_id, identifier, expected_content_fingerprint, True)


@router.get(BASE + "/{identifier}/receipt.json")
@store.snapshot_read
def download_receipt(account_id: Identifier, proposal_id: Identifier, identifier: ReceiptIdentifier,
                     expected_content_fingerprint: str = Query(pattern=HASH)):
    with store.connect() as db:
        return _download(db, account_id, proposal_id, identifier, expected_content_fingerprint, False)
