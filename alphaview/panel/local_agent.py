"""One local Ollama pass: cited qualitative review with bounded paper targets.

No LLM tool calls, cloud endpoints, model downloads, live trading or automatic
paper acceptance. Numerical market facts and targets are always program-owned.
"""
import hashlib
import http.client
import json
import logging
import math
import re
import socket
import threading
import uuid
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, model_validator

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import sessions, store
from .locking import WorkspaceLock

router = APIRouter()
logger = logging.getLogger(__name__)
ENGINE_VERSION = "alphaview-local-agent-v1"
HISTORICAL_AUTH_VERSION = "alphaview-local-agent-historical-authorization-v1"
INTEGRITY_VERSION = "alphaview-local-agent-integrity-v1"
PROMPT_VERSION = "alphaview-local-agent-prompt-v1"
OLLAMA_HOST, OLLAMA_PORT = "127.0.0.1", 11434
METADATA_TIMEOUT = 3
INFERENCE_TIMEOUT = 120
MAX_RESPONSE_BYTES = 2_097_152
MAX_CONTENT_BYTES = 65_536
MAX_PROMPT_BYTES = 24_576
MAX_SELECTED = 10
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
OPTIONS = {"temperature": 0, "seed": 42, "num_ctx": 8192, "num_predict": 2048}
ROLES = ("research_analyst", "allocation_reviewer", "risk_reviewer")
FINDING_LABELS = {
    "complete_evidence": "引用標的的啟用策略資料完整。",
    "mixed_signals": "啟用策略沒有全部符合，應保留不同訊號的限制。",
    "within_position_limit": "原規則目標位於單檔配置上限之內。",
    "cash_buffer_available": "原規則配置保留至少要求的現金緩衝。",
    "forecast_not_available": "目前證據沒有未來報酬預測，無法由共識分數推得報酬。",
}
REASON_LABELS = {
    "rule_consensus": "依已通過的規則共識保留檢閱。",
    "mixed_signals": "模型選擇對未全部符合的策略共識採取較保守處理。",
    "cash_caution": "模型選擇增加現金保留，不把減少的配置挪給其他標的。",
    "no_forecast": "模型考量缺少報酬預測證據，選擇較保守的配置。",
}
METHOD = (
    "One installed local Ollama model pass returns three role viewpoints, not three "
    "independent models or calls. The model selects constrained qualitative finding "
    "codes and cites immutable input fact IDs; program validation checks every citation "
    "and its supporting condition. No model-written numerical market assertions are "
    "accepted. Analysis mode retains every original selected slot; conservative mode "
    "may retain, halve or exclude each original selected symbol. The program computes "
    "targets from original slots, rounded down to 8 decimals, with no new symbols or "
    "weight redistribution; all-zero/abstain outputs are blocked. Only verified, current "
    "saved rules runs with up to 10 selected symbols qualify. Paper preview/proposal "
    "requires independent source/account/risk validation and never auto-accepts."
)
SYSTEM_PROMPT = (
    "You are a local portfolio research reviewer, not a trader. Return only JSON matching "
    "the supplied schema. Use only supplied fact IDs. Do not use tools, external sources, "
    "new symbols, numerical market claims or free-form prose. Produce exactly three role "
    "viewpoints and one decision for EVERY selected symbol. In analysis mode ALL actions "
    "must be retain. In conservative mode retain/halve/exclude are permitted, never increase "
    "or redistribute weights. Each role needs a supported finding with citations. Finding "
    "complete_evidence cites coverage=100; mixed_signals cites consensus matched<enabled; "
    "within_position_limit cites allocation:position_limit; cash_buffer_available cites "
    "allocation:cash_buffer; forecast_not_available cites limitation:forecast. For each "
    "decision: rule_consensus cites its own score; mixed_signals cites its own consensus "
    "and requires matched<enabled; cash_caution cites its own slot and allocation:cash_buffer; "
    "no_forecast cites its own slot and limitation:forecast. Use disposition continue when "
    "providing a supported review or abstain if unable. These are high-level review choices, "
    "not private chain-of-thought."
)


class LocalLock(WorkspaceLock):
    @staticmethod
    def lock_path():
        return Path(str(store.db_path().expanduser().resolve()) + ".local-agent.lock")


RUN_LOCK = LocalLock()


class LocalRunInput(agent.StrictInput):
    source_run_id: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=100)
    mode: Literal["analysis", "conservative"] = "analysis"
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")

    @model_validator(mode="after")
    def local_model_name(self):
        if not MODEL_NAME.fullmatch(self.model) or "cloud" in self.model.lower():
            raise ValueError("只能使用已安裝的本機模型名稱；不接受 cloud、URL 或遠端 registry")
        return self


class Finding(agent.StrictInput):
    code: Literal["complete_evidence", "mixed_signals", "within_position_limit", "cash_buffer_available", "forecast_not_available"]
    evidence_ids: list[str] = Field(min_length=1, max_length=6)


class RoleView(agent.StrictInput):
    role: Literal["research_analyst", "allocation_reviewer", "risk_reviewer"]
    assessment: Literal["supported", "caution", "insufficient"]
    findings: list[Finding] = Field(min_length=1, max_length=4)


class Decision(agent.StrictInput):
    symbol: str = Field(min_length=1, max_length=10)
    action: Literal["retain", "halve", "exclude"]
    reason_code: Literal["rule_consensus", "mixed_signals", "cash_caution", "no_forecast"]
    evidence_ids: list[str] = Field(min_length=1, max_length=6)


class ModelOutput(agent.StrictInput):
    disposition: Literal["continue", "abstain"]
    roles: list[RoleView] = Field(min_length=3, max_length=3)
    decisions: list[Decision] = Field(min_length=1, max_length=MAX_SELECTED)


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS local_agent_runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        source_run_id TEXT NOT NULL, engine_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','failed','cancelled','stale','interrupted')),
        phase TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        as_of TEXT NOT NULL, input_revision TEXT NOT NULL,
        request_json TEXT NOT NULL, source_json TEXT NOT NULL, model_json TEXT NOT NULL,
        facts_json TEXT NOT NULL, prompt_json TEXT NOT NULL, prompt_digest TEXT NOT NULL,
        schema_digest TEXT NOT NULL, result_json TEXT, error_json TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_local_agent_runs_created ON local_agent_runs(created_at,id)")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _error(code, message):
    return {"code": code, "message": message}


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON")
    return number


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _decode(value):
    def invalid(_):
        raise ValueError("Non-finite JSON")
    return json.loads(value, parse_constant=invalid, parse_float=_finite_float, object_pairs_hook=_pairs)


def _ollama(method, path, payload=None, timeout=METADATA_TIMEOUT):
    allowed = {("GET", "/api/status"), ("GET", "/api/version"), ("GET", "/api/tags"),
               ("POST", "/api/show"), ("POST", "/api/chat")}
    if (method, path) not in allowed:
        raise HTTPException(422, "不支援的本機模型端點")
    connection = http.client.HTTPConnection(OLLAMA_HOST, OLLAMA_PORT, timeout=timeout)
    try:
        raw = _json(payload).encode() if payload is not None else None
        connection.request(method, path, body=raw, headers={"Accept": "application/json", "Content-Type": "application/json"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise HTTPException(503, "本機模型服務回傳 redirect；已拒絕跟隨")
        content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise HTTPException(503, "本機模型服務回應超過大小上限")
        if response.status != 200:
            raise HTTPException(503, f"本機 Ollama {path} 回應 HTTP {response.status}；未下載模型或呼叫其他服務")
        try:
            result = _decode(content.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(503, "本機模型服務回傳無效 JSON") from exc
        if not isinstance(result, dict):
            raise HTTPException(503, "本機模型服务回應格式不符")
        return result
    except (socket.timeout, TimeoutError) as exc:
        raise HTTPException(503, "本機模型推理或資料查詢逾時") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise HTTPException(503, "無法連線至 127.0.0.1:11434；請先啟動已停用雲端的本機 Ollama") from exc
    finally:
        connection.close()


def _remote(value):
    if isinstance(value, dict):
        return any((key in ("remote_model", "remote_host") and bool(item)) or _remote(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_remote(item) for item in value)
    return False


def _catalog():
    try:
        status = _ollama("GET", "/api/status")
    except HTTPException as exc:
        raise HTTPException(503, "無法驗證 Ollama cloud.disabled；需要支援 /api/status 且以 OLLAMA_NO_CLOUD=1 啟動的版本") from exc
    cloud = status.get("cloud")
    if not isinstance(cloud, dict) or cloud.get("disabled") is not True:
        raise HTTPException(503, "Ollama 尚未確認停用雲端；請以 OLLAMA_NO_CLOUD=1 啟動本機服務")
    version = _ollama("GET", "/api/version").get("version")
    tags = _ollama("GET", "/api/tags").get("models")
    if not isinstance(tags, list) or len(tags) > 200:
        raise HTTPException(503, "本機模型清單格式不符或超過支援上限")
    accepted, rejected = [], []
    for item in tags:
        name = item.get("name") if isinstance(item, dict) else None
        reason = None
        if not isinstance(name, str) or not MODEL_NAME.fullmatch(name) or "cloud" in name.lower():
            reason = "cloud_or_unsupported_name"
        elif _remote(item):
            reason = "remote_metadata"
        elif not isinstance(item.get("size"), int) or isinstance(item["size"], bool) or item["size"] <= 0:
            reason = "missing_local_size"
        elif not isinstance(item.get("digest"), str) or not DIGEST.fullmatch(item["digest"]):
            reason = "missing_digest"
        elif not isinstance(item.get("details"), dict) or item["details"].get("format") != "gguf":
            reason = "unsupported_local_format"
        if reason:
            rejected.append({"name": name if isinstance(name, str) else "unknown", "reason": reason})
        else:
            accepted.append({"name": name, "digest": item["digest"], "size": item["size"],
                             "modified_at": item.get("modified_at"), "details": item.get("details", {}), "status": "installed"})
    return {"available": True, "server_version": version, "cloud_disabled": True,
            "models": accepted, "rejected_models": rejected, "reason": None}


@router.get("/api/local-agent/models")
def models():
    try:
        result = _catalog()
    except HTTPException as exc:
        result = {"available": False, "server_version": None, "cloud_disabled": None,
                  "models": [], "rejected_models": [], "reason": str(exc.detail)}
    return {"engine_version": ENGINE_VERSION, "endpoint": "http://127.0.0.1:11434", **result,
            "max_selected": MAX_SELECTED, "inference_timeout_seconds": INFERENCE_TIMEOUT,
            "modes": ["analysis", "conservative"], "method": METHOD}


def _model(name):
    catalog = _catalog()
    choices = [item for item in catalog["models"] if item["name"] == name]
    if len(choices) != 1:
        raise HTTPException(422, "模型未安裝、名稱不唯一或不符合本機限制；不會自動下載")
    shown = _ollama("POST", "/api/show", {"model": name, "verbose": False})
    if (_remote(shown) or not isinstance(shown.get("details"), dict)
            or shown["details"].get("format") != "gguf" or not isinstance(shown.get("capabilities"), list)
            or "completion" not in shown["capabilities"]):
        raise HTTPException(422, "模型不是可驗證的本機 GGUF completion 模型，或含遠端 metadata")
    return {**choices[0], "capabilities": shown["capabilities"], "show_digest": _hash(shown),
            "server_version": catalog["server_version"], "cloud_disabled": True}


def _source(db, identifier):
    source = agent._run(db, identifier)
    if source["status"] != "proposed" or not agent._currentness(source)["current"]:
        raise HTTPException(409, "來源規則工作流未通過、已過期或版本不符；請先重算規則工作流")
    if not 1 <= len(source["target_weights"]) <= MAX_SELECTED:
        raise HTTPException(422, f"本機模型分析需要 1–{MAX_SELECTED} 個已選定規則目標")
    return source


def _source_summary(source):
    return {"id": source["id"], "engine_version": source["engine_version"], "as_of": source["as_of"],
            **({"account_context": source["account_context"], "symbol_policy_method": paper.SYMBOL_POLICY_METHOD} if source.get("account_context") else {}),
            "input_revision": source["input_revision"], "proposal_fingerprint": source["proposal_fingerprint"],
            "scan": source["scan"], "target_weights": source["target_weights"],
            "cash_weight_pct": source["cash_weight_pct"], "constraints": source["request"]["constraints"],
            "strategy_weights": source["request"]["strategy_weights"]}


def _facts(source):
    facts = []
    def add(identifier, kind, value, symbol=None):
        facts.append({"id": identifier, "kind": kind, "value": value, "symbol": symbol,
                      "as_of": source["as_of"], "scan_id": source["scan"]["id"]})
    candidates = {row["symbol"]: row for row in source["candidates"]}
    for target in source["target_weights"]:
        symbol = target["symbol"]
        row = candidates.get(symbol)
        if not row or row["score"] is None or row["coverage_pct"] != 100 or row["evidence"]["quote_date"] != source["as_of"]:
            raise HTTPException(409, "規則目標的必要證據不完整，不能交給模型補值")
        add(f"candidate:{symbol}:score", "score", row["score"], symbol)
        add(f"candidate:{symbol}:coverage", "coverage", row["coverage_pct"], symbol)
        add(f"candidate:{symbol}:consensus", "consensus", {"matched": row["matched_count"],
            "enabled": sum(part["enabled"] for part in row["contributions"])}, symbol)
        add(f"candidate:{symbol}:slot", "slot", target["weight_pct"], symbol)
        add(f"candidate:{symbol}:quote", "quote", row["evidence"]["reference_close"], symbol)
    add("allocation:position_limit", "position_limit", {"largest": max(target["weight_pct"] for target in source["target_weights"]),
                                                       "limit": source["request"]["constraints"]["max_position_weight_pct"]})
    add("allocation:cash_buffer", "cash_buffer", {"reserved": source["cash_weight_pct"], "minimum": source["request"]["constraints"]["cash_buffer_pct"]})
    add("limitation:forecast", "limitation", "No future return forecast is present in these rule signals.")
    return facts


def _prompt(body, source, facts):
    schema = ModelOutput.model_json_schema()
    schema["$defs"]["Decision"]["properties"]["symbol"]["enum"] = [target["symbol"] for target in source["target_weights"]]
    for name in ("Finding", "Decision"):
        schema["$defs"][name]["properties"]["evidence_ids"]["items"]["enum"] = [fact["id"] for fact in facts]
    content = {"mode": body.mode, "source_run_id": source["id"], "as_of": source["as_of"],
               "selected_symbols": [target["symbol"] for target in source["target_weights"]], "facts": facts,
               "output_schema": schema}
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": _json(content)}]
    if len(_json(messages).encode()) > MAX_PROMPT_BYTES:
        raise HTTPException(422, "本機分析輸入超過上下文預算；請縮小規則目標數")
    return {"model": body.model, "messages": messages, "format": schema, "stream": False,
            "think": False, "options": dict(OPTIONS), "keep_alive": "5m"}


def _row(db, identifier):
    row = db.execute("SELECT * FROM local_agent_runs WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到本機模型分析")
    return dict(row)


def _currentness(db, row):
    reasons = []
    if row["engine_version"] != ENGINE_VERSION:
        reasons.append("local_engine_changed")
    try:
        source = _source(db, row["source_run_id"])
        saved = json.loads(row["source_json"])
        if source["proposal_fingerprint"] != saved["proposal_fingerprint"]:
            reasons.append("source_fingerprint_changed")
    except HTTPException:
        reasons.append("source_run_stale_or_unavailable")
    return {"current": not reasons, "stale_reasons": reasons}


def _public(db, row, *, detail=True):
    freshness = _currentness(db, row)
    effective = "stale" if not freshness["current"] and row["status"] in ("completed", "blocked") else row["status"]
    result = json.loads(row["result_json"]) if row["result_json"] else None
    metadata = json.loads(row["model_json"])
    response = {"id": row["id"], "engine_version": row["engine_version"], "source_run_id": row["source_run_id"],
                "status": effective, "stored_status": row["status"], "phase": row["phase"],
                "cancel_requested": bool(row["cancel_requested"]), "created_at": row["created_at"],
                "started_at": row["started_at"], "finished_at": row["finished_at"], "as_of": row["as_of"],
                "input_revision": row["input_revision"], "request": json.loads(row["request_json"]),
                "model": metadata, "error": json.loads(row["error_json"]) if row["error_json"] else None,
                "proposal_ready": effective == "completed" and bool(result and result.get("proposal_ready")),
                "target_weights": result.get("target_weights", []) if result else [],
                "cash_weight_pct": result.get("cash_weight_pct") if result else None,
                "single_model_pass": True, **freshness}
    if detail:
        response.update(source=json.loads(row["source_json"]), facts=json.loads(row["facts_json"]), result=result,
                        prompt_version=metadata.get("prompt_version", "alphaview-local-agent-prompt-v1"),
                        prompt_digest=row["prompt_digest"], schema_digest=row["schema_digest"],
                        options=json.loads(row["prompt_json"])["options"], method=METHOD,
                        warnings=["同一次本機模型推論產生三種角色觀點，並非三個獨立模型。",
                                  "模型只選擇有引用的分類判斷；所有行情數字與目標權重由程式提供及驗證。",
                                  "此分析不會自動接受紙上提案，也沒有真實交易介面。"])
    return response


@router.get("/api/local-agent/runs")
@store.snapshot_read
def list_runs(limit: int = Query(default=20, ge=1, le=100)):
    with store.connect() as db:
        rows = db.execute("SELECT * FROM local_agent_runs ORDER BY created_at DESC,id DESC LIMIT ?", (limit,)).fetchall()
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db),
                "runs": [_public(db, dict(row), detail=False) for row in rows], "method": METHOD}


@router.get("/api/local-agent/runs/{identifier}")
@store.snapshot_read
def get_run(identifier: str):
    with store.connect() as db:
        return _public(db, _row(db, identifier))


def _existing(db, body):
    row = db.execute("SELECT * FROM local_agent_runs WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
    if row is None:
        return None
    if row["request_hash"] != _hash(body.model_dump(exclude={"idempotency_key"})):
        raise HTTPException(409, "分析請求識別碼已被不同內容使用")
    return _public(db, dict(row))


def _recover_locked(db):
    db.execute("UPDATE local_agent_runs SET status='interrupted',phase='finished',finished_at=?,error_json=? WHERE status IN ('queued','running')",
               (store.now(), _json(_error("process_interrupted", "本機分析程序已中斷；未自動重跑或產生紙上提案"))))


def recover_interrupted():
    if not RUN_LOCK.acquire(blocking=False):
        return False
    try:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            _recover_locked(db)
        return True
    finally:
        RUN_LOCK.release()


@router.post("/api/local-agent/runs", status_code=202)
def create_run(body: LocalRunInput):
    with store.read_snapshot():
        with store.connect() as db:
            existing = _existing(db, body)
    if existing is not None:
        return existing
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "已有本機模型分析執行中；請等待完成或取消後再啟動")
    owns_lock = True
    try:
        with store.read_snapshot():
            with store.connect() as db:
                source = _source(db, body.source_run_id)
                facts = _facts(source)
        metadata = {**_model(body.model), "prompt_version": PROMPT_VERSION}
        prompt = _prompt(body, source, facts)
        identifier, created = uuid.uuid4().hex, store.now()
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = _existing(db, body)
            if existing is not None:
                return existing
            current = _source(db, body.source_run_id)
            if _source_summary(current) != _source_summary(source):
                raise HTTPException(409, "本機分析準備期間來源已變更")
            _recover_locked(db)
            db.execute("""INSERT INTO local_agent_runs
                (id,idempotency_key,request_hash,source_run_id,engine_version,status,phase,created_at,
                 as_of,input_revision,request_json,source_json,model_json,facts_json,prompt_json,prompt_digest,schema_digest)
                VALUES (?,?,?,?,?,'queued','source_check',?,?,?,?,?,?,?,?,?,?)""",
                       (identifier, body.idempotency_key, _hash(body.model_dump(exclude={"idempotency_key"})), body.source_run_id, ENGINE_VERSION,
                        created, source["as_of"], source["input_revision"], _json(body.model_dump()), _json(_source_summary(source)),
                        _json(metadata), _json(facts), _json(prompt), _hash(prompt), _hash(prompt["format"])))
        owns_lock = False
        try:
            launch_locked(identifier)
        except Exception as exc:
            with store.connect() as db:
                db.execute("UPDATE local_agent_runs SET status='failed',phase='finished',finished_at=?,error_json=? WHERE id=?",
                           (store.now(), _json(_error("launch_failed", str(exc)[:300])), identifier))
        return get_run(identifier)
    finally:
        if owns_lock:
            RUN_LOCK.release()


def launch_locked(identifier):
    try:
        threading.Thread(target=worker, args=(identifier,), name="alphaview-local-agent", daemon=True).start()
    except Exception:
        RUN_LOCK.release()
        raise


def _set_phase(identifier, phase):
    with store.connect() as db:
        db.execute("UPDATE local_agent_runs SET status='running',phase=?,started_at=coalesce(started_at,?) WHERE id=? AND status IN ('queued','running')",
                   (phase, store.now(), identifier))


def _cancelled(identifier):
    with store.connect() as db:
        return bool(_row(db, identifier)["cancel_requested"])


def _finish(identifier, status, result=None, error=None):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = _row(db, identifier)
        if row["cancel_requested"]:
            status, error = "cancelled", _error("cancelled", "已取消本機分析；不提供可接續的紙上目標")
        elif not _currentness(db, row)["current"]:
            status, error = "stale", _error("source_changed", "分析期間來源行情、交易日或引擎已變更；結果保留但不可接續")
        if result is not None and status != "completed":
            result.update(proposal_ready=False, target_weights=[], cash_weight_pct=None)
        db.execute("UPDATE local_agent_runs SET status=?,phase='finished',finished_at=?,result_json=?,error_json=? WHERE id=?",
                   (status, store.now(), _json(result) if result is not None else None, _json(error) if error else None, identifier))


def _supported(code, cited):
    if code == "complete_evidence":
        return any(fact["kind"] == "coverage" and fact["value"] == 100 for fact in cited)
    if code == "mixed_signals":
        return any(fact["kind"] == "consensus" and fact["value"]["matched"] < fact["value"]["enabled"] for fact in cited)
    if code == "within_position_limit":
        return any(fact["kind"] == "position_limit" and fact["value"]["largest"] <= fact["value"]["limit"] for fact in cited)
    if code == "cash_buffer_available":
        return any(fact["kind"] == "cash_buffer" and fact["value"]["reserved"] >= fact["value"]["minimum"] for fact in cited)
    return code == "forecast_not_available" and any(fact["id"] == "limitation:forecast" for fact in cited)


def validate_output(content, source, facts, mode):
    issues = []
    base = {"raw_content": content, "output_digest": hashlib.sha256(content.encode()).hexdigest(),
            "output": None, "role_views": [], "decisions": [], "target_weights": [], "cash_weight_pct": None,
            "proposal_ready": False, "validation": {"valid": False, "issues": issues}}
    try:
        parsed = _decode(content)
        output = ModelOutput.model_validate(parsed)
    except (ValueError, TypeError) as exc:
        issues.append(_error("invalid_model_schema", str(exc)[:500]))
        return base
    base["output"] = output.model_dump()
    catalog = {fact["id"]: fact for fact in facts}
    selected = {target["symbol"]: target["weight_pct"] for target in source["target_weights"]}
    if sorted(view.role for view in output.roles) != sorted(ROLES):
        issues.append(_error("role_set_invalid", "模型必須提供三種不同的指定角色觀點"))
    if sorted(item.symbol for item in output.decisions) != sorted(selected):
        issues.append(_error("symbol_set_invalid", "模型目標必須完整對應原規則已選標的，不得新增、遺漏或重複"))
    def citations(ids):
        if len(ids) != len(set(ids)) or any(identifier not in catalog for identifier in ids):
            issues.append(_error("invalid_citation", "模型引用不存在或重複的證據 ID"))
            return []
        return [catalog[identifier] for identifier in ids]
    for view in output.roles:
        findings = []
        for finding in view.findings:
            cited = citations(finding.evidence_ids)
            if not _supported(finding.code, cited):
                issues.append(_error("unsupported_finding", "角色判斷未由引用證據支持"))
            findings.append({**finding.model_dump(), "text": FINDING_LABELS[finding.code], "evidence": cited})
        base["role_views"].append({"role": view.role, "assessment": view.assessment, "findings": findings})
    targets = []
    for decision in output.decisions:
        cited = citations(decision.evidence_ids)
        own = [fact for fact in cited if fact["symbol"] == decision.symbol]
        allowed = False
        if decision.reason_code == "rule_consensus":
            allowed = any(fact["kind"] == "score" and fact["value"] >= source["constraints"]["min_score"] for fact in own)
        elif decision.reason_code == "mixed_signals":
            allowed = _supported("mixed_signals", own)
        elif decision.reason_code == "cash_caution":
            allowed = any(fact["kind"] == "slot" for fact in own) and _supported("cash_buffer_available", cited)
        elif decision.reason_code == "no_forecast":
            allowed = any(fact["kind"] == "slot" for fact in own) and _supported("forecast_not_available", cited)
        if not allowed:
            issues.append(_error("unsupported_decision", "配置判斷未引用該標的與必要限制的有效證據"))
        if mode == "analysis" and decision.action != "retain":
            issues.append(_error("analysis_cannot_reallocate", "分析模式不允許變更原配置"))
        original = selected.get(decision.symbol)
        target = None
        if original is not None:
            factor = {"retain": Decimal(1), "halve": Decimal("0.5"), "exclude": Decimal(0)}[decision.action]
            target = float((Decimal(str(original)) * factor).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN))
            targets.append({"symbol": decision.symbol, "weight_pct": target})
        base["decisions"].append({**decision.model_dump(), "text": REASON_LABELS[decision.reason_code], "evidence": cited,
                                  "original_weight_pct": original, "target_weight_pct": target})
    if output.disposition == "abstain":
        issues.append(_error("model_abstained", "本機模型選擇不提出可接續配置"))
    if targets and not any(target["weight_pct"] > 0 for target in targets):
        issues.append(_error("all_targets_zero", "不允許模型以全零配置產生清空紙上持倉提案"))
    if not issues:
        base.update(target_weights=targets, cash_weight_pct=round(100 - math.fsum(target["weight_pct"] for target in targets), 8), proposal_ready=True)
        base["validation"]["valid"] = True
    return base


def worker(identifier):
    try:
        if _cancelled(identifier):
            _finish(identifier, "cancelled")
            return
        with store.read_snapshot():
            with store.connect() as db:
                row = _row(db, identifier)
                current = _currentness(db, row)
        if not current["current"]:
            _finish(identifier, "stale")
            return
        metadata = json.loads(row["model_json"])
        verified = _model(metadata["name"])
        if verified["digest"] != metadata["digest"] or verified["show_digest"] != metadata["show_digest"]:
            _finish(identifier, "stale", error=_error("model_changed", "推理前本機模型內容已變更"))
            return
        _set_phase(identifier, "local_inference")
        response = _ollama("POST", "/api/chat", json.loads(row["prompt_json"]), timeout=INFERENCE_TIMEOUT)
        if _cancelled(identifier):
            _finish(identifier, "cancelled")
            return
        if _remote(response) or response.get("model") != metadata["name"]:
            _finish(identifier, "failed", error=_error("nonlocal_response", "模型回應含遠端來源或模型名稱不符"))
            return
        message = response.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if (response.get("done") is not True or response.get("done_reason") != "stop" or not isinstance(content, str)
                or not content.strip() or len(content.encode()) > MAX_CONTENT_BYTES
                or message.get("tool_calls") or message.get("images")):
            _finish(identifier, "blocked", error=_error("incomplete_response", "模型回應未完整結束、超出上限或嘗試使用工具；未接受結果"))
            return
        verified = _model(metadata["name"])
        if verified["digest"] != metadata["digest"] or verified["show_digest"] != metadata["show_digest"]:
            _finish(identifier, "stale", error=_error("model_changed", "推理期間本機模型內容已變更"))
            return
        _set_phase(identifier, "output_validation")
        body = json.loads(row["request_json"])
        result = validate_output(content, json.loads(row["source_json"]), json.loads(row["facts_json"]), body["mode"])
        result["metrics"] = {key: response.get(key) if type(response.get(key)) is int and response[key] >= 0 else None
                             for key in ("total_duration", "load_duration", "prompt_eval_count", "eval_count", "eval_duration")}
        _finish(identifier, "completed" if result["proposal_ready"] else "blocked", result=result)
    except HTTPException as exc:
        _finish(identifier, "failed", error=_error("local_runtime_error", str(exc.detail)[:500]))
    except Exception as exc:
        logger.exception("Local model analysis failed")
        _finish(identifier, "failed", error=_error("analysis_failed", str(exc)[:500]))
    finally:
        RUN_LOCK.release()


@router.post("/api/local-agent/runs/{identifier}/cancel")
def cancel_run(identifier: str):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = _row(db, identifier)
        if row["status"] in ("queued", "running"):
            db.execute("UPDATE local_agent_runs SET cancel_requested=1 WHERE id=?", (identifier,))
    return get_run(identifier)


class _EvidenceFailure(Exception):
    def __init__(self, code, message, status="failed"):
        super().__init__(message)
        self.issue = _error(code, message)
        self.status = status


def _citation_coverage(output, facts):
    """Count known references, not factual truth or investment usefulness."""
    if output is None:
        return None
    groups = [finding["evidence_ids"] for role in output["roles"] for finding in role["findings"]]
    groups.extend(decision["evidence_ids"] for decision in output["decisions"])
    catalog = {fact["id"] for fact in facts}
    references = [identifier for ids in groups for identifier in ids]
    covered = sum(bool(ids) and len(ids) == len(set(ids)) and all(identifier in catalog for identifier in ids) for ids in groups)
    return {"claims": len(groups), "claims_with_valid_references": covered,
            "citations": len(references), "known_citations": sum(identifier in catalog for identifier in references),
            "unknown_ids": sorted(set(references) - catalog),
            "duplicate_citations": sum(len(ids) - len(set(ids)) for ids in groups),
            "coverage_pct": round(100 * covered / len(groups), 2) if groups else None}


def _saved_evidence(db, row):
    """Reconstruct one saved proof without live data, model calls or writes.

    This checks internal consistency against the saved rule fingerprint. It does
    not attest model identity or protect against rewriting every saved artifact.
    Current source/account-policy eligibility is checked separately by callers.
    """
    codes = ("analysis_method", "rules_record", "rules_fingerprint", "source_binding", "saved_facts",
             "saved_request", "prompt_digest", "schema_digest", "structured_output", "output_digest",
             "result_replay", "analysis_completion")
    checks = {code: {"code": code, "status": "unavailable",
                     "reason": _error("prerequisite_unavailable", "前置證據未通過，尚未執行此檢查")} for code in codes}
    report = {"status": "unavailable", "checks": list(checks.values()), "citation_coverage": None,
              "validation_issues": [], "proof": None}
    stage = "analysis_method"

    def require(condition, code, message, *, status="failed"):
        if not condition:
            raise _EvidenceFailure(code, message, status)
        checks[stage].update(status="passed", reason=None)

    try:
        require(row["engine_version"] == ENGINE_VERSION, "analysis_method_unavailable",
                "此分析方法沒有相容的證據驗證器", status="unavailable")
        stage = "rules_record"
        rule = agent._run(db, row["source_run_id"])
        rule_record = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (row["source_run_id"],)).fetchone()
        require(rule["engine_version"] == agent.ENGINE_VERSION and rule["status"] == "proposed"
                and bool(rule.get("scan")) and rule["scan"].get("engine_version") == agent.scan_provenance.SCAN_ENGINE_VERSION
                and all(rule_record[key] == rule[key] for key in ("engine_version", "status", "as_of", "input_revision"))
                and _decode(rule_record["request"]) == rule["request"],
                "rules_record_mismatch", "保存的規則、掃描方法或來源欄位不一致")
        stage = "rules_fingerprint"
        rule_basis = {key: value for key, value in rule.items() if key not in ("id", "created_at", "saved", "proposal_fingerprint")}
        require(_hash(rule_basis) == rule["proposal_fingerprint"], "rules_fingerprint_mismatch",
                "保存的完整規則紀錄與來源指紋不符")
        stage = "source_binding"
        saved_source = _decode(row["source_json"])
        require(saved_source == _source_summary(rule) and row["as_of"] == rule["as_of"]
                and row["input_revision"] == rule["input_revision"],
                "source_binding_mismatch", "分析保存的來源摘要、交易日或輸入版本與規則紀錄不符")
        stage = "saved_facts"
        facts = _decode(row["facts_json"])
        require(facts == _facts(rule), "saved_facts_mismatch", "保存的事實與規則紀錄重建的事實不符")
        stage = "saved_request"
        body = _decode(row["request_json"])
        request = LocalRunInput.model_validate(body)
        metadata = _decode(row["model_json"])
        require(request.source_run_id == row["source_run_id"] and request.model == metadata.get("name")
                and request.idempotency_key == row["idempotency_key"]
                and _hash(request.model_dump(exclude={"idempotency_key"})) == row["request_hash"],
                "saved_request_mismatch", "保存的分析請求、模型名稱或請求指紋不符")
        stage = "prompt_digest"
        prompt = _decode(row["prompt_json"])
        require(_hash(prompt) == row["prompt_digest"] and prompt.get("model") == request.model,
                "prompt_digest_mismatch", "保存的 prompt 內容或模型名稱與指紋不符")
        stage = "schema_digest"
        require(isinstance(prompt.get("format"), dict) and _hash(prompt["format"]) == row["schema_digest"],
                "schema_digest_mismatch", "保存的輸出結構與 schema 指紋不符")
        stage = "structured_output"
        result = _decode(row["result_json"]) if row["result_json"] else None
        if not isinstance(result, dict) or not isinstance(result.get("raw_content"), str):
            raise _EvidenceFailure("saved_output_unavailable", "缺少可重新驗證的原始結構化輸出", "unavailable")
        content = result["raw_content"]
        require(bool(content.strip()) and len(content.encode()) <= MAX_CONTENT_BYTES,
                "saved_output_invalid", "保存的原始輸出為空或超出大小限制")
        validated = validate_output(content, saved_source, facts, request.mode)
        report["citation_coverage"] = _citation_coverage(validated["output"], facts)
        # Only codes escape the proof boundary: schema errors can include raw model text.
        report["validation_issues"] = sorted({issue["code"] for issue in validated["validation"]["issues"]})
        require(validated["proposal_ready"], "output_validation_failed", "原始模型輸出未通過結構、引用或配置限制驗證")
        stage = "output_digest"
        require(result.get("output_digest") == validated["output_digest"], "output_digest_mismatch",
                "原始模型輸出與保存的輸出指紋不符")
        stage = "result_replay"
        mismatched = [key for key, value in validated.items() if result.get(key) != value]
        checks[stage]["mismatched_fields"] = mismatched
        require(not mismatched, "result_replay_mismatch", "保存的觀點、決策或目標與原始輸出重驗結果不符")
        stage = "analysis_completion"
        require(row["status"] == "completed" and not row["cancel_requested"],
                "analysis_not_completed", "分析未完成或已要求取消，不能形成可接續證據")
        immutable = {"request": body, "source": saved_source, "facts": facts, "model": metadata,
                     "result": result, "prompt_digest": row["prompt_digest"], "schema_digest": row["schema_digest"]}
        authorization = {"method_version": HISTORICAL_AUTH_VERSION, "analysis_id": row["id"], "engine_version": row["engine_version"],
                         **({"account_context": saved_source["account_context"]} if saved_source.get("account_context") else {}),
                         "source_run_id": rule["id"], "source_engine_version": rule["engine_version"],
                         "scan_engine_version": rule["scan"]["engine_version"], "as_of": row["as_of"],
                         "input_revision": row["input_revision"], "target_weights": validated["target_weights"],
                         "source_fingerprint": rule["proposal_fingerprint"], "analysis_fingerprint": _hash(immutable)}
        authorization["authorization_fingerprint"] = _hash(authorization)
        report.update(status="verified", proof=authorization)
    except _EvidenceFailure as exc:
        checks[stage].update(status=exc.status, reason=exc.issue)
        report["status"] = exc.status
    except HTTPException:
        checks[stage].update(status="unavailable", reason=_error("saved_source_unavailable", "保存的來源或必要證據無法重建"))
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        checks[stage].update(status="unavailable", reason=_error("saved_evidence_unreadable", "保存的證據欄位缺失、格式不符或不是有限 JSON"))
    return report


def _require_saved_proof(db, row):
    report = _saved_evidence(db, row)
    if report["proof"] is None:
        issue = next(check["reason"] for check in report["checks"] if check["status"] != "passed")
        raise HTTPException(409, {"code": "local_evidence_unverified", "message": issue["message"],
                                  "integrity_version": INTEGRITY_VERSION, "reason": issue["code"]})
    return report["proof"]


@router.get("/api/local-agent/runs/{identifier}/integrity")
@store.snapshot_read
def verify_saved_run(identifier: str):
    with store.connect() as db:
        row = _row(db, identifier)
        report = _saved_evidence(db, row)
        try:
            currentness = _currentness(db, row)
        except (ValueError, TypeError, KeyError, AttributeError):
            currentness = {"current": False, "stale_reasons": ["saved_source_unreadable"]}
        return {"engine_version": INTEGRITY_VERSION, "analysis_id": row["id"], "source_run_id": row["source_run_id"],
                "as_of": row["as_of"], "input_revision": row["input_revision"],
                "status": report["status"], "verified": report["proof"] is not None,
                "checks": report["checks"], "citation_coverage": report["citation_coverage"],
                "validation_issues": report["validation_issues"], "source_currentness": currentness,
                "proposal_eligible": report["proof"] is not None and currentness["current"],
                "authorization_fingerprint": report["proof"]["authorization_fingerprint"] if report["proof"] else None,
                "method": "Read-only reconstruction of saved rules, facts, digests, strict output, citations and program-owned targets. "
                          "No model calls. Internal consistency is separate from current source eligibility and does not attest model identity or forecast quality."}


def validate_source(db, source):
    row = _row(db, source["analysis_id"])
    if source["engine_version"] != ENGINE_VERSION or row["engine_version"] != ENGINE_VERSION:
        raise HTTPException(409, "本機分析方法版本已變更")
    if row["status"] != "completed" or row["cancel_requested"]:
        raise HTTPException(409, "本機分析未通過或已取消")
    proof = _require_saved_proof(db, row)
    if not _currentness(db, row)["current"]:
        raise HTTPException(409, "本機分析來源已過期")
    return {"analysis_id": row["id"], "source_run_id": row["source_run_id"], "target_weights": proof["target_weights"],
            **({"account_context": proof["account_context"]} if proof.get("account_context") else {}),
            "as_of": row["as_of"], "input_revision": row["input_revision"]}


def validate_historical_source(db, source, *, expected_fingerprint=None):
    """Revalidate frozen next-open evidence, then its separate account-policy gate.

    The successful v1 payload and fingerprint remain identical. Latest session and
    revision are intentionally not part of this historical authorization check.
    """
    row = _row(db, source["analysis_id"])
    if source["engine_version"] != ENGINE_VERSION:
        raise HTTPException(409, "歷史本機分析的方法已變更")
    authorization = _require_saved_proof(db, row)
    if authorization.get("account_context") and not paper._policy_context_current(db, authorization["account_context"]):
        raise HTTPException(409, "歷史本機分析的允許標的政策已變更，原授權失效")
    if expected_fingerprint is not None and authorization["authorization_fingerprint"] != expected_fingerprint:
        raise HTTPException(409, "歷史本機分析與已凍結的授權指紋不符")
    return authorization


def _paper_input(identifier, body, *, save=False):
    with store.read_snapshot():
        with store.connect() as db:
            source = validate_source(db, {"analysis_id": identifier, "engine_version": ENGINE_VERSION})
            paper._validate_policy_binding(db, source.get("account_context"), body.account_id)
    payload = {"expected_version": body.expected_account_version, "targets": source["target_weights"],
               "expected_input_revision": source["input_revision"], "expected_as_of": source["as_of"],
               "local_agent_source": {"analysis_id": identifier, "engine_version": ENGINE_VERSION},
               "rationale": f"本機模型分析 {identifier}；來源規則 run {source['source_run_id']}；{ENGINE_VERSION}。模型輸出與引用已通過程式驗證。"}
    if save:
        payload["idempotency_key"] = body.idempotency_key
    return payload


@router.post("/api/local-agent/runs/{identifier}/paper-preview")
def paper_preview(identifier: str, body: agent.PaperBridgeInput):
    result = paper.preview(body.account_id, paper.PreviewInput(**_paper_input(identifier, body)))
    return {"analysis_id": identifier, "engine_version": ENGINE_VERSION, "paper_preview": result, "method": METHOD}


@router.post("/api/local-agent/runs/{identifier}/paper-proposal", status_code=201)
def paper_proposal(identifier: str, body: agent.PaperProposalBridgeInput):
    result = paper.create_proposal(body.account_id, paper.ProposalInput(**_paper_input(identifier, body, save=True)))
    return {"analysis_id": identifier, "engine_version": ENGINE_VERSION, "paper_proposal": result, "method": METHOD}
