"""Immutable, server-rebuilt sampled-prefix diagnostic receipts for the research workspace."""
from datetime import date, datetime, timedelta
import hashlib
import json
import re

from fastapi import APIRouter, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import Field, field_validator

from . import portfolio_agent as agent, research_desk as desk, research_integrity as integrity, sessions, store

ENGINE_VERSION = "alphaview-research-integrity-receipt-v1"
MAX_BYTES, MAX_TOTAL = 256 * 1024, 500
METHOD = (
    "Immutable local record of one server-recomputed alphaview-research-integrity diagnostic. "
    "A canonical request and expected workspace input revision, completed session and full evidence "
    "fingerprint bind publication. Recheck sources and method versions under BEGIN IMMEDIATE after "
    "the read snapshot closes. Exact normalized retries replay the original bytes without recomputation; "
    "currentness is assessed separately when read. A workspace revision mismatch does not establish "
    "that this symbol's bars changed. At most 500 receipts, 256 KiB each; no automatic deletion. "
    "This preserves a sampled diagnostic, including differences and unavailable results; it is not "
    "proof of causality, absence of future leakage, profitability or readiness for trading."
)


class _ReceiptRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def finite_validation_errors(request):
            try:
                return await handler(request)
            except RequestValidationError as error:
                details = [{key: item[key] for key in ("loc", "msg", "type")} for item in error.errors()]
                return JSONResponse({"detail": details}, status_code=422, headers={"Cache-Control": "no-store"})
        return finite_validation_errors


router = APIRouter(route_class=_ReceiptRoute)


class SaveInput(agent.StrictInput):
    request: integrity.IntegrityInput
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_evidence_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("expected_as_of")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value


def init_schema(db):
    """Host initialization transaction only; read and save paths never run DDL."""
    db.execute("""CREATE TABLE IF NOT EXISTS research_integrity_receipts (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, created_at TEXT NOT NULL,
        engine_version TEXT NOT NULL, request_json TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=262144)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_research_integrity_receipts_symbol ON research_integrity_receipts(symbol,created_at,id)")


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _reply(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


def _source(evidence):
    return {"symbol": evidence["symbol"], "as_of": evidence["as_of"], "input_revision": evidence["input_revision"],
            "history_fingerprint": evidence["fingerprint"], "integrity_engine_version": evidence["engine_version"],
            "desk_engine_version": evidence["desk_engine_version"], "request_fingerprint": _hash(evidence["request"]),
            "evidence_fingerprint": evidence["evidence_fingerprint"]}


def _decode(row):
    if not isinstance(row["payload_json"], str) or not isinstance(row["request_json"], str):
        return None, "receipt_unverifiable"
    if len(row["payload_json"].encode()) > MAX_BYTES:
        return None, "receipt_size_limit"
    try:
        payload, saved = json.loads(row["payload_json"]), json.loads(row["request_json"])
        if not isinstance(payload, dict) or _hash(payload) != row["content_fingerprint"]:
            return None, "receipt_content_changed"
        evidence, request, source = payload["evidence"], payload["request"], payload["source_context"]
        if (not isinstance(evidence, dict) or not isinstance(request, dict) or not isinstance(source, dict)
                or _hash(saved) != row["id"] or saved["engine_version"] != row["engine_version"]
                or payload["engine_version"] != row["engine_version"]
                or payload["receipt_id"] != row["id"] or payload["created_at"] != row["created_at"]
                or saved["save_request"]["request"] != request or evidence["request"] != request
                or evidence["symbol"] != row["symbol"] or request["symbol"] != row["symbol"]
                or evidence["config"] != request["config"] or source != _source(evidence)
                or saved["save_request"]["expected_input_revision"] != evidence["input_revision"]
                or saved["save_request"]["expected_as_of"] != evidence["as_of"]
                or saved["save_request"]["expected_evidence_fingerprint"] != evidence["evidence_fingerprint"]
                or evidence["evidence_fingerprint"] != _hash({key: value for key, value in evidence.items() if key != "evidence_fingerprint"})
                or row["payload_json"] != _json(payload) or row["request_json"] != _json(saved)):
            return None, "receipt_unverifiable"
        if (not isinstance(evidence["status"], str) or not isinstance(evidence["counts"], dict)
                or not isinstance(evidence["prefixes"], list) or not isinstance(evidence["unavailable"], list)):
            return None, "receipt_unverifiable"
        if (not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:\+00:00|Z)", payload["created_at"])
                or datetime.fromisoformat(payload["created_at"]).utcoffset() != timedelta(0)):
            return None, "receipt_unverifiable"
        return payload, None
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError):
        return None, "receipt_unverifiable"


def _currentness(db, payload):
    if payload is None:
        return {"current": None, "reasons": ["receipt_unverifiable"]}
    source = payload["source_context"]
    reasons = []
    if payload["engine_version"] != ENGINE_VERSION:
        reasons.append("receipt_method_changed")
    if source["integrity_engine_version"] != integrity.ENGINE_VERSION:
        reasons.append("integrity_method_changed")
    if source["desk_engine_version"] != desk.ENGINE_VERSION:
        reasons.append("desk_method_changed")
    if source["input_revision"] != store.input_revision(db):
        reasons.append("workspace_inputs_changed")
    if source["as_of"] != sessions.latest_completed_session():
        reasons.append("session_changed")
    return {"current": not reasons, "reasons": reasons}


def _view(db, row, detail=True):
    payload, reason = _decode(row)
    evidence = payload["evidence"] if payload else None
    view = {"id": row["id"], "symbol": row["symbol"], "created_at": row["created_at"],
            "engine_version": row["engine_version"], "content_fingerprint": row["content_fingerprint"],
            "integrity": {"available": payload is not None, "reason": reason},
            "currentness": _currentness(db, payload), "status": evidence["status"] if evidence else None,
            "as_of": evidence["as_of"] if evidence else None,
            "config": evidence["config"] if evidence else None,
            "counts": evidence["counts"] if evidence else None}
    if detail:
        view["receipt"] = payload
    return view


def _lookup(db, identifier):
    return db.execute("SELECT * FROM research_integrity_receipts WHERE id=?", (identifier,)).fetchone()


def _replay(db, identifier, request_json):
    row = _lookup(db, identifier)
    if row is None:
        return None
    if row["request_json"] != request_json:
        raise _problem("receipt_request_conflict", "前綴回條的保存識別衝突")
    payload, issue = _decode(row)
    if payload is None:
        raise _problem(issue, "已保存前綴回條無法驗證；未覆寫或重建歷史")
    return {**_view(db, row), "replayed": True}


@router.post("/api/research-desk/integrity-receipts")
def save_receipt(body: SaveInput):
    saved = {"engine_version": ENGINE_VERSION, "save_request": body.model_dump()}
    request_json, identifier = _json(saved), _hash(saved)
    with store.read_snapshot():
        with store.connect() as db:
            replay = _replay(db, identifier, request_json)
            if replay is not None:
                return _reply(replay)
            if body.expected_input_revision != store.input_revision(db) or body.expected_as_of != sessions.latest_completed_session():
                raise _problem("receipt_source_changed", "資料版本或交易日已變更；請重新比較前綴")
            evidence = integrity.inspect_integrity(body.request)
            expected_hash = _hash({key: value for key, value in evidence.items() if key != "evidence_fingerprint"})
            if (evidence.get("evidence_fingerprint") != expected_hash or expected_hash != body.expected_evidence_fingerprint
                    or evidence["input_revision"] != body.expected_input_revision or evidence["as_of"] != body.expected_as_of
                    or evidence["request"] != body.request.model_dump()):
                raise _problem("receipt_evidence_changed", "伺服器重算的前綴證據與已檢閱結果不同；未保存")
            payload = {"engine_version": ENGINE_VERSION, "receipt_id": identifier, "created_at": store.now(),
                       "request": body.request.model_dump(),
                       "source_context": _source(evidence), "evidence": evidence, "method": METHOD}
            encoded = _json(payload)
            if len(encoded.encode()) > MAX_BYTES:
                raise _problem("receipt_size_limit", "前綴回條超過 256 KiB；未截短或保存", 422)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _replay(db, identifier, request_json)
        if replay is not None:
            return _reply(replay)
        if _currentness(db, payload)["current"] is not True:
            raise _problem("receipt_context_changed", "保存期間來源、方法或交易日已變更；未保存前綴回條")
        if db.execute("SELECT COUNT(*) FROM research_integrity_receipts").fetchone()[0] >= MAX_TOTAL:
            raise _problem("receipt_capacity", "前綴回條已達 500 筆保留上限；不自動刪除歷史")
        db.execute("INSERT INTO research_integrity_receipts VALUES (?,?,?,?,?,?,?)",
                   (identifier, body.request.symbol, payload["created_at"], ENGINE_VERSION, request_json, _hash(payload), encoded))
        value = {**_view(db, _lookup(db, identifier)), "replayed": False}
    return _reply(value, 201)


@router.get("/api/research-desk/integrity-receipts")
@store.snapshot_read
def list_receipts(symbol: str | None = Query(default=None, pattern=r"^[A-Z][A-Z0-9.-]{0,9}$"),
                  limit: int = Query(default=20, ge=1, le=20), offset: int = Query(default=0, ge=0, le=500)):
    with store.connect() as db:
        where, args = (" WHERE symbol=?", (symbol,)) if symbol else ("", ())
        total = db.execute("SELECT COUNT(*) FROM research_integrity_receipts" + where, args).fetchone()[0]
        rows = db.execute("SELECT * FROM research_integrity_receipts" + where + " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                          (*args, limit, offset)).fetchall()
        return _reply({"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
            "input_revision": store.input_revision(db), "items": [_view(db, row, detail=False) for row in rows],
            "pagination": {"limit": limit, "offset": offset, "total": total, "returned": len(rows)},
            "retention": {"workspace": MAX_TOTAL, "max_bytes": MAX_BYTES, "automatic_deletion": False}, "method": METHOD})


@router.get("/api/research-desk/integrity-receipts/{identifier}")
@store.snapshot_read
def get_receipt(identifier: str):
    with store.connect() as db:
        row = _lookup(db, identifier)
        if row is None:
            raise _problem("receipt_missing", "找不到前綴診斷回條", 404)
        return _reply({**_view(db, row), "checked_as_of": sessions.latest_completed_session(),
                       "checked_input_revision": store.input_revision(db)})


@router.get("/api/research-desk/integrity-receipts/{identifier}/evidence.json")
@store.snapshot_read
def download_receipt(identifier: str,
                     expected_content_fingerprint: str | None = Query(default=None, pattern=r"^[a-f0-9]{64}$")):
    with store.connect() as db:
        row = _lookup(db, identifier)
        if row is None:
            raise _problem("receipt_missing", "找不到前綴診斷回條", 404)
        payload, issue = _decode(row)
        if payload is None:
            raise _problem(issue, "前綴回條無法驗證，不能下載為有效證據")
        if expected_content_fingerprint is not None and row["content_fingerprint"] != expected_content_fingerprint:
            raise _problem("receipt_content_changed", "回條內容指紋與已讀取內容不符；請重新讀取歷史")
        symbol = re.sub(r"[^A-Za-z0-9_-]", "-", row["symbol"])[:20]
        return Response(content=row["payload_json"], media_type="application/json",
                        headers={"Cache-Control": "no-store", "ETag": f'"{row["content_fingerprint"]}"', "Content-Disposition":
                                 f'attachment; filename="alphaview-prefix-receipt-{symbol}-{identifier[:16]}.json"'})
