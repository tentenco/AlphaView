"""Immutable local receipts for saved-workflow path evidence; no execution authority."""
from datetime import datetime, timedelta
import hashlib
import json
import re
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import Field, TypeAdapter

from . import allocator, paper_portfolio as paper, portfolio_agent as agent, scan_provenance, sessions, store
from . import workflow_path_costs as costs, workflow_path_validation as path

ENGINE_VERSION = "alphaview-workflow-path-receipt-v1"
MAX_BYTES, MAX_REQUEST_BYTES, MAX_ACCOUNT, MAX_TOTAL = 2097152, 16384, 50, 250
BASE = "/api/paper/accounts/{account_id}/runs/{run_id}/path-receipts"
HASH = r"^[a-f0-9]{64}$"
METHOD = (
    "Immutable advisory receipt for one server-rebuilt saved-workflow path or fixed-decision cost grid. "
    "Store the normalized complete request, original complete evidence, saved workflow, account version "
    "and policies, source and method fingerprints as canonical sorted-key finite UTF-8 JSON. "
    "The original historical evidence and current source eligibility are separate. Exact normalized "
    "retries replay the same stored payload before freshness checks; they never recompute or relabel "
    "historical evidence as current. A new receipt recomputes in a read snapshot, verifies the expected "
    "evidence, then rechecks all source/account/policy/method context under BEGIN IMMEDIATE. "
    "Unbound workflows have review association only, not account-specific performance. Unavailable "
    "evidence may be preserved with its original gaps. At most 50 per account, 250 total, 2 MiB per "
    "receipt; reject capacity/size overflow without truncation, import, deletion or overwriting. "
    "This is not an executable source, trading authorization, proposal gate, profitability or "
    "out-of-sample proof. No workflow, proposal, account, provider, model or broker mutation."
)


class _FiniteRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def validate(request):
            try:
                return await handler(request)
            except RequestValidationError as error:
                return JSONResponse({"detail": [{key: item[key] for key in ("loc", "msg", "type")}
                    for item in error.errors()]}, status_code=422, headers={"Cache-Control": "no-store"})
        return validate


router = APIRouter(route_class=_FiniteRoute)


class _SaveBase(agent.StrictInput):
    expected_account_version: int = Field(ge=1, strict=True)
    expected_evidence_engine_version: str = Field(min_length=1, max_length=100)
    expected_evidence_fingerprint: str = Field(pattern=HASH)


class SavePath(_SaveBase):
    kind: Literal["path_validation"]
    request: path.PathValidationInput


class SaveCosts(_SaveBase):
    kind: Literal["path_costs"]
    request: costs.CostInput


SaveInput = Annotated[SavePath | SaveCosts, Field(discriminator="kind")]
_SAVE = TypeAdapter(SaveInput)


def init_schema(db):
    """Frozen DDL; host initialization only, never a read/save path."""
    db.execute("""CREATE TABLE IF NOT EXISTS workflow_path_receipts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('path_validation','path_costs')),
        created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB))<=16384),
        content_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=2097152)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_workflow_path_receipts_scope ON workflow_path_receipts(account_id,run_id,created_at,id)")


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _reply(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


def _account_context(db, identifier):
    row = paper._account(db, identifier)
    return {"account_id": row["id"], "version": row["version"], "kill_switch": bool(row["kill_switch"]),
            "limits": json.loads(row["limits_json"]), "execution_policy": json.loads(row["execution_policy_json"]),
            "symbol_policy": json.loads(row["symbol_policy_json"])}


def _source(kind, run, evidence):
    baseline = evidence if kind == "path_validation" else evidence["baseline"]
    return {"agent_run_id": run["id"], "record_fingerprint": _hash(run),
            "proposal_fingerprint": run["proposal_fingerprint"], "input_revision": run["input_revision"],
            "as_of": run["as_of"], "history_fingerprint": evidence["history_fingerprint"],
            "evidence_fingerprint": evidence["evidence_fingerprint"],
            "account_binding": "workflow_bound" if run.get("account_context") else "review_association_only",
            "versions": {"evidence": evidence["engine_version"], "path": baseline["engine_version"],
                "workflow": run["engine_version"], "scan": baseline["scan_engine_version"],
                "allocator": baseline["allocator_engine_version"]}}


def _evidence_matches(evidence, body, run):
    """Check identity and method-independent protocol binding without rebuilding old evidence."""
    baseline = evidence if body.kind == "path_validation" else evidence["baseline"]
    request = body.request.model_dump()
    for value in (evidence, baseline):
        if (value["agent_run_id"] != run["id"] or value["proposal_fingerprint"] != run["proposal_fingerprint"]
                or value["input_revision"] != run["input_revision"] or value["as_of"] != run["as_of"]
                or value["current_at_snapshot"] is not True or value["mode"] != "advisory_only"
                or value["evidence_fingerprint"] != _hash({key: item for key, item in value.items() if key != "evidence_fingerprint"})):
            return False
    if (evidence["engine_version"] != body.expected_evidence_engine_version
            or evidence["evidence_fingerprint"] != body.expected_evidence_fingerprint
            or request["expected_proposal_fingerprint"] != run["proposal_fingerprint"]
            or request["expected_input_revision"] != run["input_revision"] or request["expected_as_of"] != run["as_of"]
            or baseline["settings"]["workflow"] != run["request"]
            or baseline["settings"]["symbol_policy"] != (run.get("account_context") or {}).get("symbol_policy")
            or baseline["candidate_symbols"] != run["request"]["candidate_symbols"]
            or baseline["status"] not in ("evaluated", "unavailable")
            or not isinstance(baseline["coverage"], dict) or not isinstance(baseline["reasons"], list)
            or not isinstance(baseline["decisions"], list) or not isinstance(baseline["curve"], list)
            or not isinstance(baseline["events"], list)
            or (baseline["status"] == "evaluated") != isinstance(baseline["metrics"], dict)):
        return False
    if body.kind == "path_costs":
        if (evidence["request"] != request or evidence["path_engine_version"] != baseline["engine_version"]
                or evidence["baseline_evidence_fingerprint"] != baseline["evidence_fingerprint"]
                or evidence["history_fingerprint"] != baseline["history_fingerprint"]
                or evidence["decision_fingerprint"] != _hash(baseline["decisions"])
                or evidence["status"] not in ("evaluated", "incomplete", "unavailable")
                or not isinstance(evidence["coverage"], dict) or not isinstance(evidence["scenarios"], list)
                or len(evidence["scenarios"]) != len(request["fee_bps"]) * len(request["slippage_bps"])):
            return False
    return True


def _decode(row):
    try:
        if (not isinstance(row["payload_json"], str) or not isinstance(row["request_json"], str)
                or len(row["payload_json"].encode()) > MAX_BYTES
                or len(row["request_json"].encode()) > MAX_REQUEST_BYTES):
            return None, "receipt_size_or_storage_invalid"
        payload, saved = json.loads(row["payload_json"]), json.loads(row["request_json"])
        if not isinstance(payload, dict) or _hash(payload) != row["content_fingerprint"]:
            return None, "receipt_content_changed"
        body = _SAVE.validate_python(saved["save_request"])
        evidence, run, context = payload["evidence"], payload["saved_workflow"], payload["account_context"]
        if (row["payload_json"] != _json(payload) or row["request_json"] != _json(saved)
                or _hash(saved) != row["id"] or saved["account_id"] != row["account_id"]
                or saved["run_id"] != row["run_id"] or body.kind != row["kind"]
                or saved["save_request"] != body.model_dump() or payload["request"] != body.request.model_dump()
                or payload["receipt_id"] != row["id"] or payload["kind"] != row["kind"]
                or payload["created_at"] != row["created_at"] or payload["engine_version"] != row["engine_version"]
                or context["account_id"] != row["account_id"] or context["version"] != body.expected_account_version
                or type(context["version"]) is not int or type(context["kill_switch"]) is not bool
                or any(not isinstance(context[key], dict) for key in ("limits", "execution_policy", "symbol_policy"))
                or run["id"] != row["run_id"] or run["saved"] is not True or run["status"] != "proposed"
                or not _evidence_matches(evidence, body, run)
                or payload["source_context"] != _source(body.kind, run, evidence)
                or (run.get("account_context") and (run["account_context"]["account_id"] != context["account_id"]
                    or run["account_context"]["symbol_policy"] != context["symbol_policy"]))
                or payload["policy"] != {"advisory_only": True, "execution_source": False, "gating_authority": False}):
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
    try:
        source, context = payload["source_context"], payload["account_context"]
        versions = source["versions"]
        reasons = []
        if payload["engine_version"] != ENGINE_VERSION:
            reasons.append("receipt_method_changed")
        if versions["evidence"] != (path.ENGINE_VERSION if payload["kind"] == "path_validation" else costs.ENGINE_VERSION):
            reasons.append("evidence_method_changed")
        if versions["path"] != path.ENGINE_VERSION:
            reasons.append("path_method_changed")
        if versions["workflow"] != agent.ENGINE_VERSION:
            reasons.append("workflow_method_changed")
        if versions["scan"] != scan_provenance.SCAN_ENGINE_VERSION:
            reasons.append("scan_method_changed")
        if versions["allocator"] != allocator.ENGINE_VERSION:
            reasons.append("allocator_method_changed")
        if source["input_revision"] != store.input_revision(db):
            reasons.append("inputs_changed")
        if source["as_of"] != sessions.latest_completed_session():
            reasons.append("session_changed")
        if db.execute("SELECT 1 FROM paper_accounts WHERE id=?", (context["account_id"],)).fetchone() is None:
            reasons.append("account_missing")
        elif _account_context(db, context["account_id"]) != context:
            reasons.append("account_context_changed")
        if db.execute("SELECT 1 FROM portfolio_agent_runs WHERE id=?", (source["agent_run_id"],)).fetchone() is None:
            reasons.append("workflow_missing")
        elif _hash(agent._run(db, source["agent_run_id"])) != source["record_fingerprint"]:
            reasons.append("workflow_changed")
        return {"current": not reasons, "reasons": reasons}
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError):
        return {"current": None, "reasons": ["context_unverifiable"]}


def _view(db, row, detail=True):
    payload, issue = _decode(row)
    evidence = payload["evidence"] if payload else None
    baseline = (evidence if row["kind"] == "path_validation" else evidence["baseline"]) if evidence else None
    # SQLite affinity does not prohibit BLOB metadata. Never reflect corrupt cells
    # into JSON or provide a usable identifier for an unverifiable identifier cell.
    def metadata(key, limit=200):
        value = row[key]
        return value if isinstance(value, str) and len(value.encode()) <= limit else ""
    value = {"id": metadata("id", 64), "account_id": metadata("account_id"), "run_id": metadata("run_id"), "kind": metadata("kind"),
             "created_at": metadata("created_at"), "engine_version": metadata("engine_version"),
             "content_fingerprint": metadata("content_fingerprint", 64), "integrity": {"available": payload is not None, "reason": issue},
             "currentness": _currentness(db, payload), "as_of": evidence["as_of"] if evidence else None,
             "status": evidence["status"] if evidence else None,
             "coverage": evidence["coverage"] if evidence else None,
             "baseline_metrics": baseline["metrics"] if baseline else None}
    if detail:
        value["receipt"] = payload
    return value


def _lookup(db, account_id, run_id, identifier):
    return db.execute("SELECT * FROM workflow_path_receipts WHERE account_id=? AND run_id=? AND id=?",
                      (account_id, run_id, identifier)).fetchone()


def _replay(db, account_id, run_id, identifier, request_json):
    row = _lookup(db, account_id, run_id, identifier)
    if row is None:
        return None
    if row["request_json"] != request_json:
        raise _problem("receipt_request_conflict", "歷史路徑回條的保存識別衝突")
    payload, issue = _decode(row)
    if payload is None:
        raise _problem(issue, "歷史路徑回條無法驗證；未覆寫或重建")
    return {**_view(db, row), "replayed": True}


@router.post(BASE)
def save_receipt(account_id: str, run_id: str, body: SaveInput):
    saved = {"account_id": account_id, "run_id": run_id, "save_request": body.model_dump()}
    request_json, identifier = _json(saved), _hash(saved)
    if len(request_json.encode()) > MAX_REQUEST_BYTES:
        raise _problem("receipt_request_size_limit", "路徑保存請求超過 16 KiB；未保存", 422)
    with store.read_snapshot():
        with store.connect() as db:
            replay = _replay(db, account_id, run_id, identifier, request_json)
            if replay is not None:
                return _reply(replay)
            context = _account_context(db, account_id)
            if context["version"] != body.expected_account_version:
                raise _problem("receipt_account_changed", "帳戶版本已變更；請重新讀取帳戶與路徑證據")
            run = agent._run(db, run_id)
            paper._validate_policy_binding(db, run.get("account_context"), account_id)
            evidence = path.evaluate(run_id, body.request) if body.kind == "path_validation" else costs.evaluate(run_id, body.request)
            if not _evidence_matches(evidence, body, run):
                raise _problem("receipt_evidence_changed", "伺服器重算路徑與已檢閱證據不同；未保存")
            payload = {"engine_version": ENGINE_VERSION, "receipt_id": identifier, "kind": body.kind,
                       "created_at": store.now(), "request": body.request.model_dump(), "saved_workflow": run,
                       "account_context": context, "source_context": _source(body.kind, run, evidence), "evidence": evidence,
                       "policy": {"advisory_only": True, "execution_source": False, "gating_authority": False}, "method": METHOD}
            encoded = _json(payload)
            if len(encoded.encode()) > MAX_BYTES:
                raise _problem("receipt_size_limit", "路徑回條超過 2 MiB；未截短或保存", 422)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _replay(db, account_id, run_id, identifier, request_json)
        if replay is not None:
            return _reply(replay)
        if _currentness(db, payload)["current"] is not True:
            raise _problem("receipt_context_changed", "保存期間來源、帳戶、政策、方法或交易日變更；未保存路徑回條")
        if (db.execute("SELECT COUNT(*) FROM workflow_path_receipts WHERE account_id=?", (account_id,)).fetchone()[0] >= MAX_ACCOUNT
                or db.execute("SELECT COUNT(*) FROM workflow_path_receipts").fetchone()[0] >= MAX_TOTAL):
            raise _problem("receipt_capacity", "路徑回條已達保留上限；不自動刪除歷史")
        db.execute("INSERT INTO workflow_path_receipts VALUES (?,?,?,?,?,?,?,?,?)",
                   (identifier, account_id, run_id, body.kind, payload["created_at"], ENGINE_VERSION,
                    request_json, _hash(payload), encoded))
        result = {**_view(db, _lookup(db, account_id, run_id, identifier)), "replayed": False}
    return _reply(result, 201)


@router.get(BASE)
@store.snapshot_read
def list_receipts(account_id: str, run_id: str, kind: Literal["path_validation", "path_costs"] | None = None,
                  limit: int = Query(default=20, ge=1, le=20), offset: int = Query(default=0, ge=0, le=MAX_TOTAL)):
    with store.connect() as db:
        where, args = " WHERE account_id=? AND run_id=?", [account_id, run_id]
        if kind is not None:
            where, args = where + " AND kind=?", [*args, kind]
        total = db.execute("SELECT COUNT(*) FROM workflow_path_receipts" + where, args).fetchone()[0]
        rows = db.execute("SELECT * FROM workflow_path_receipts" + where + " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                          (*args, limit, offset)).fetchall()
        return _reply({"engine_version": ENGINE_VERSION, "account_id": account_id, "run_id": run_id, "kind": kind,
            "items": [_view(db, row, detail=False) for row in rows],
            "checked_as_of": sessions.latest_completed_session(), "checked_input_revision": store.input_revision(db),
            "pagination": {"limit": limit, "offset": offset, "total": total, "returned": len(rows)},
            "retention": {"per_account": MAX_ACCOUNT, "global": MAX_TOTAL, "max_bytes": MAX_BYTES, "automatic_deletion": False}, "method": METHOD})


@router.get(BASE + "/{identifier}")
@store.snapshot_read
def get_receipt(account_id: str, run_id: str, identifier: str):
    with store.connect() as db:
        row = _lookup(db, account_id, run_id, identifier)
        if row is None:
            raise _problem("receipt_missing", "找不到此帳戶與工作流的路徑回條", 404)
        return _reply({**_view(db, row), "checked_as_of": sessions.latest_completed_session(),
                       "checked_input_revision": store.input_revision(db)})


@router.get(BASE + "/{identifier}/evidence.json")
@store.snapshot_read
def download_receipt(account_id: str, run_id: str, identifier: str,
                     expected_content_fingerprint: str = Query(pattern=HASH)):
    with store.connect() as db:
        row = _lookup(db, account_id, run_id, identifier)
        if row is None:
            raise _problem("receipt_missing", "找不到此帳戶與工作流的路徑回條", 404)
        payload, issue = _decode(row)
        if payload is None:
            raise _problem(issue, "路徑回條無法驗證，不能下載為有效證據")
        if row["content_fingerprint"] != expected_content_fingerprint:
            raise _problem("receipt_content_changed", "路徑回條內容指紋與已讀取內容不符；請重新讀取")
        return Response(content=row["payload_json"], media_type="application/json",
            headers={"Cache-Control": "no-store", "ETag": f'"{row["content_fingerprint"]}"',
                "Content-Disposition": f'attachment; filename="alphaview-path-receipt-{row["kind"]}-{identifier[:16]}.json"'})
