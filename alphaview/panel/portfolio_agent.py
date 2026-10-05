"""Deterministic, auditable local research-to-paper-allocation workflow.

These named roles are rule-engine stages, not LLM calls. Nothing in this module
places an order or changes a real/paper holding. Saved runs are immutable local
research records; paper accounting independently validates any proposed targets.
"""
import hashlib
import json
import math
import re
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import allocator, research, scan_context, scan_provenance, sessions, store
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-portfolio-agent-v1"
STRATEGY_IDS = tuple(strategy["id"] for strategy in research.STRATEGIES)
PERIODS = {strategy["id"]: strategy["period"] for strategy in research.STRATEGIES}
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
METHOD = (
    "Local deterministic research analyst → allocation planner → risk reviewer → proposal. "
    "Only the latest completed XNYS-session scan with current engine/input provenance and "
    "unchanged universe is eligible. Every enabled strategy must be available; missing "
    "inputs reject the candidate without redistributing strategy weights. Alpha score "
    "is the sum of matched fixed strategy weights (total 100), not expected return. "
    "Rank by score descending, enabled matches descending, then symbol ascending. "
    "Each selected candidate receives a fixed slot: min((100 − cash buffer) / maximum "
    "positions, maximum position weight). Unused slots remain cash; weights are rounded "
    "down to eight decimal places. With allocation_method inverse_volatility or score_tilt "
    "(alphaview-allocator-v1) the same invested total is split by 1/σ or score × 1/σ over the "
    "lookback of daily log returns; a missing σ makes the whole allocation unavailable instead "
    "of falling back to equal slots. Paper accounting must independently validate the "
    "entire target portfolio, cash, current quotes and account constraints."
)
WARNINGS = [
    "角色是可重現的本機規則引擎，沒有呼叫 LLM、付費服務或券商。",
    "Alpha 分數是策略共識，不代表報酬預測；這是紙上組合研究提案。",
    "完整目標會將未列入的紙上持倉目標設為零；必須先檢閱紙上調倉明細。",
    "風險角色僅驗證配置規則與來源完整性，沒有預測波動、相關性或未來損失。",
]


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class StrategyWeights(StrictInput):
    turtle: float = Field(default=25, ge=0, le=100)
    trend: float = Field(default=25, ge=0, le=100)
    pullback: float = Field(default=25, ge=0, le=100)
    rps: float = Field(default=25, ge=0, le=100)

    @model_validator(mode="after")
    def fixed_total(self):
        if not math.isclose(math.fsum(self.model_dump().values()), 100, abs_tol=1e-8, rel_tol=0):
            raise ValueError("策略權重必須合計 100；不自動正規化或重分配")
        return self


class AllocationConstraints(StrictInput):
    min_score: float = Field(default=50, ge=0, le=100)
    min_matches: int = Field(default=1, ge=1, le=4)
    max_positions: int = Field(default=5, ge=1, le=30)
    max_position_weight_pct: float = Field(default=25, gt=0, le=100)
    cash_buffer_pct: float = Field(default=20, ge=0, lt=100)
    allocation_method: Literal["equal", "inverse_volatility", "score_tilt"] = "equal"
    volatility_lookback_sessions: int = Field(default=60, ge=20, le=120)


class AccountContext(StrictInput):
    account_id: str = Field(min_length=1, max_length=100)
    expected_policy_version: int = Field(ge=1)


class WorkflowInput(StrictInput):
    scope: Literal["portfolio", "market"] = "market"
    candidate_symbols: list[str] = Field(min_length=1, max_length=100)
    strategy_weights: StrategyWeights = Field(default_factory=StrategyWeights)
    constraints: AllocationConstraints = Field(default_factory=AllocationConstraints)
    account_context: AccountContext | None = None

    @field_validator("candidate_symbols")
    @classmethod
    def valid_symbols(cls, symbols):
        if any(not SYMBOL.fullmatch(symbol) for symbol in symbols):
            raise ValueError("股票代碼必須是大寫英數字、句點或連字號，最多 10 字元")
        if len(set(symbols)) != len(symbols):
            raise ValueError("候選代碼不可重複")
        return symbols

    @model_validator(mode="after")
    def enough_enabled_strategies(self):
        if self.constraints.min_matches > sum(weight > 0 for weight in self.strategy_weights.model_dump().values()):
            raise ValueError("最低符合策略數不可超過啟用策略數")
        return self


class PaperBridgeInput(StrictInput):
    account_id: str = Field(min_length=1, max_length=100)
    expected_account_version: int = Field(ge=1, strict=True)


class PaperProposalBridgeInput(PaperBridgeInput):
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


def init_schema(db):
    """Called only from the host's explicit schema initialization transaction."""
    db.execute("""CREATE TABLE IF NOT EXISTS portfolio_agent_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
        as_of TEXT NOT NULL, input_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed','blocked')),
        request TEXT NOT NULL, result TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_agent_runs_created ON portfolio_agent_runs(created_at,id)")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _reason(code, message, **detail):
    return {"code": code, "message": message, **detail}


def _finite_positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _source(body, expected):
    snapshot = scan_context.decorate(store.latest_scan(scope=body.scope))
    issues = []
    if snapshot is None:
        issues.append(_reason("scan_missing", "尚無選股快照；請先完成當期選股"))
        return None, issues
    if snapshot["as_of"] != expected:
        issues.append(_reason("scan_session_mismatch", "選股快照不是最新已完成交易日", observed=snapshot["as_of"], required=expected))
    if snapshot["input_status"] != "current":
        issues.append(_reason("scan_provenance_unavailable", "選股引擎或輸入版本已過期或無法驗證", observed=snapshot["input_status"]))
    if not snapshot["matches_current_universe"]:
        issues.append(_reason("scan_universe_changed", "選股股票池與目前工作區不同，請重新掃描"))
    return snapshot, issues


def _candidate(symbol, rows, body, as_of, db, global_issues):
    weights = body.strategy_weights.model_dump()
    candidate = {"symbol": symbol, "status": "rejected", "score": None,
                 "coverage_pct": 0.0, "matched_count": 0, "reasons": [],
                 "contributions": [], "evidence": {"quote_date": None, "reference_close": None}}
    if global_issues:
        candidate["reasons"] = [_reason("source_unavailable", "當期選股來源未通過檢查")]
        return candidate
    if len(rows) != 1:
        candidate["reasons"] = [_reason("scan_row_missing" if not rows else "scan_row_duplicate", "選股快照必須包含唯一候選列")]
        return candidate
    row = rows[0]
    quality = row.get("quality") or {}
    indicators = row.get("indicators") or {}
    reasons = candidate["reasons"]
    if row.get("date") != as_of or not _finite_positive(row.get("bars")):
        reasons.append(_reason("candidate_history_unavailable", "候選缺少當期有效日線"))
    if quality.get("valid") is False or quality.get("status") in ("data_error", "no_data"):
        reasons.append(_reason("candidate_data_error", "選股資料品質檢查未通過"))
    if not _finite_positive(indicators.get("close")):
        reasons.append(_reason("adjusted_close_unavailable", "當期調整收盤價不可用"))
    quote = db.execute("SELECT * FROM bars WHERE symbol=? AND date=?", (symbol, as_of)).fetchone()
    if quote is None or not valid_bar(quote):
        reasons.append(_reason("current_quote_unavailable", "最新已完成交易日的未調整收盤行情不可用"))
    else:
        candidate["evidence"].update(quote_date=as_of, reference_close=float(quote["close"]))
    available_weight, score, matches = 0.0, 0.0, 0
    for strategy in STRATEGY_IDS:
        signals = [signal for signal in row.get("signals", []) if isinstance(signal, dict) and signal.get("strategy") == strategy]
        signal = signals[0] if len(signals) == 1 else {}
        matched = signal.get("matched")
        available = (len(signals) == 1 and signal.get("status") in ("match", "watch")
                     and isinstance(matched, bool) and matched == (signal["status"] == "match")
                     and _finite_positive(row.get("bars")) and row["bars"] >= PERIODS[strategy])
        weight = weights[strategy]
        enabled = weight > 0
        points = weight if available and matched and enabled else 0.0
        candidate["contributions"].append({"strategy": strategy, "weight": weight, "enabled": enabled,
                                            "available": available, "matched": bool(available and matched),
                                            "points": points if available or not enabled else None,
                                            "status": signal.get("status", "missing"),
                                            "reason": signal.get("reason", "策略訊號缺失或重複")})
        if enabled and not available:
            reasons.append(_reason("enabled_strategy_unavailable", "必要啟用策略缺少可驗證訊號", strategy=strategy))
        if available:
            available_weight += weight
        score += points
        matches += int(enabled and available and matched)
    candidate.update(coverage_pct=round(available_weight, 8), matched_count=matches)
    if reasons:
        return candidate
    candidate["score"] = round(score, 8)
    if score + 1e-9 < body.constraints.min_score:
        reasons.append(_reason("score_below_minimum", "固定權重共識分數未達門檻", minimum=body.constraints.min_score))
    if matches < body.constraints.min_matches:
        reasons.append(_reason("matches_below_minimum", "符合策略數未達門檻", minimum=body.constraints.min_matches))
    if not reasons:
        candidate["status"] = "eligible"
    return candidate


def _step(role, status, summary, evidence):
    return {"role": role, "engine": "deterministic_rules", "engine_version": ENGINE_VERSION,
            "status": status, "summary": summary, "evidence": evidence}


@store.snapshot_read
def preview(body: WorkflowInput):
    from . import paper_portfolio as paper

    expected = sessions.latest_completed_session()
    revision = store.input_revision()
    snapshot, source_issues = _source(body, expected)
    members = set(snapshot["universe"]) if snapshot else set()
    indexed = {}
    if snapshot:
        for row in snapshot["result"]:
            indexed.setdefault(row.get("symbol"), []).append(row)
    with store.connect() as db:
        account_context = paper._policy_context(db, body.account_context) if body.account_context else None
        candidates = [_candidate(symbol, indexed.get(symbol, []) if symbol in members else [], body, expected, db, source_issues)
                      for symbol in body.candidate_symbols]
    eligible = sorted((row for row in candidates if row["status"] == "eligible"),
                      key=lambda row: (-row["score"], -row["matched_count"], row["symbol"]))
    selected = eligible[:body.constraints.max_positions]
    # Policy removes original ranked slots. Never replace an excluded slot with
    # a lower-ranked candidate or enlarge the remaining target weights.
    if account_context:
        symbol_policy = account_context["symbol_policy"]
        for row in candidates:
            if not paper._symbol_allowed(symbol_policy, row["symbol"]):
                row["status"] = "rejected"
                row["reasons"].append(_reason("symbol_not_allowed", "標的不在帳戶允許清單；原配置席位保留現金，不補位",
                                             policy_version=symbol_policy["version"], policy_engine_version=symbol_policy["engine_version"]))
        selected = [row for row in selected if row["status"] != "rejected"]
    slot = allocator.slot_weight(body.constraints)
    for row in selected:
        row["status"] = "selected"
    for row in eligible[body.constraints.max_positions:]:
        if row["status"] != "rejected":
            row.update(status="unselected", reasons=[_reason("position_limit", "排序在最大持倉數之外；不重新分配其他配置")])
    with store.connect() as db:
        targets, allocation_evidence = allocator.allocate(db, selected, body.constraints, expected)
    invested = math.fsum(target["weight_pct"] for target in targets)
    cash = round(100 - invested, 8)
    blocking = list(source_issues)
    warnings = list(WARNINGS)
    if allocation_evidence["status"] == "unavailable":
        blocking.append(_reason("allocation_unavailable", "風險配置所需的波動率不可用；不回退等權、不產生提案",
                                method=allocation_evidence["method"], lookback_sessions=allocation_evidence["lookback_sessions"],
                                symbols=[item["symbol"] for item in allocation_evidence["unavailable"]]))
        warnings.append("allocation_unavailable：" + "；".join(f"{item['symbol']} {item['message']}" for item in allocation_evidence["unavailable"]))
    if not selected and not blocking:
        blocking.append(_reason("no_eligible_candidates", "沒有符合完整策略與門檻的候選；不產生清空持倉提案"))
    risk_checks = [
        {"code": "position_count", "passed": len(targets) <= body.constraints.max_positions,
         "observed": len(targets), "limit": body.constraints.max_positions},
        {"code": "position_weight", "passed": all(0 < target["weight_pct"] <= body.constraints.max_position_weight_pct for target in targets),
         "observed": max((target["weight_pct"] for target in targets), default=0), "limit": body.constraints.max_position_weight_pct},
        {"code": "cash_buffer", "passed": cash + 1e-8 >= body.constraints.cash_buffer_pct,
         "observed": cash, "limit": body.constraints.cash_buffer_pct},
        {"code": "long_only_unlevered", "passed": 0 <= invested <= 100 and cash >= 0, "observed": invested, "limit": 100},
        {"code": "complete_selected_evidence", "passed": all(row["coverage_pct"] == 100 and row["evidence"]["quote_date"] == expected for row in selected),
         "observed": len(selected), "limit": len(selected)},
    ]
    for check in risk_checks:
        if not check["passed"]:
            blocking.append(_reason("allocation_constraint_failed", "目標配置未通過規則檢查", check=check["code"]))
    status = "blocked" if blocking else "proposed"
    counts = {"requested": len(candidates), "complete": sum(row["score"] is not None for row in candidates),
              "eligible": sum(row["status"] in ("selected", "unselected") for row in candidates), "selected": len(selected),
              "rejected": sum(row["status"] == "rejected" for row in candidates)}
    source = None if snapshot is None else {
        "id": snapshot["id"], "scope": snapshot["scope"], "as_of": snapshot["as_of"],
        "created_at": snapshot["created_at"], "input_revision": snapshot.get("input_revision"),
        "engine_version": snapshot["scan_engine_version"], "input_status": snapshot["input_status"],
        "matches_current_universe": snapshot["matches_current_universe"],
    }
    steps = [
        _step("research_analyst", "completed" if not source_issues else "blocked",
              "逐檔核對來源、當期行情、啟用策略完整性與固定權重共識。", {"scan": source, "coverage": counts}),
        _step("allocation_planner", "completed" if targets else "blocked",
              "依共識排名填入固定配置席位，空席與未使用額度保留現金。" if allocation_evidence["method"] == "equal"
              else "依共識排名入選後，以風險感知方法分配相同總投入；單檔上限與現金緩衝不變，超出上限留現金。",
              {"slot_weight_pct": slot, "maximum_slots": body.constraints.max_positions,
               "unused_slots": body.constraints.max_positions - len(selected), "cash_weight_pct": cash,
               "allocator": allocation_evidence}),
        _step("risk_reviewer", "completed" if not blocking else "blocked",
              "核對單檔上限、現金緩衝、完整來源與無槓桿限制；紙上帳戶另行驗算。", {"checks": risk_checks, "blocking_reasons": blocking}),
        _step("proposal", "completed" if status == "proposed" else "blocked",
              "保存可追溯目標，等待使用者檢閱紙上調倉預覽。" if status == "proposed" else "來源或配置不足，停止產生可接續提案。",
              {"target_weights": targets if status == "proposed" else [], "paper_validation_required": True}),
    ]
    result = {"engine_version": ENGINE_VERSION, "workflow_kind": "deterministic_rules", "mode": "paper_preview_only",
              "as_of": expected, "input_revision": revision, "status": status, "request": body.model_dump(exclude_none=True),
              **({"account_context": account_context, "symbol_policy_method": paper.SYMBOL_POLICY_METHOD} if account_context else {}),
              "scan": source, "coverage": counts, "candidates": candidates,
              "target_weights": targets if status == "proposed" else [], "cash_weight_pct": cash if status == "proposed" else None,
              "allocation": {"slot_weight_pct": slot, "unused_slots": body.constraints.max_positions - len(selected),
                             "method": allocation_evidence["method"]},
              "allocator": allocation_evidence,
              "risk_checks": risk_checks, "blocking_reasons": blocking, "steps": steps,
              "method": METHOD, "warnings": warnings}
    result["proposal_fingerprint"] = hashlib.sha256(_json(result).encode()).hexdigest()
    return result


@router.post("/api/portfolio-agent/preview")
def preview_endpoint(body: WorkflowInput):
    return preview(body)


def save_preview(db, body: WorkflowInput, result, *, identifier=None, captured_scan_engine=None):
    """Persist a calculated run in a caller-owned write transaction.

    Automation uses this to atomically link a once-per-session claim to its
    immutable run. Callers must hold BEGIN IMMEDIATE; this helper never commits.
    """
    captured_scan_engine = captured_scan_engine or scan_provenance.SCAN_ENGINE_VERSION
    if result.get("account_context"):
        from .paper_portfolio import _policy_context_current
        if not _policy_context_current(db, result["account_context"]):
            raise HTTPException(409, "Agent 計算期間允許標的政策已變更，請重新產生工作流")
    if (result["input_revision"] != store.input_revision(db)
            or result["as_of"] != sessions.latest_completed_session()
            or result["engine_version"] != ENGINE_VERSION
            or captured_scan_engine != scan_provenance.SCAN_ENGINE_VERSION):
        raise HTTPException(409, "Agent 計算期間資料或交易日已變更；請重新產生工作流")
    latest = db.execute("SELECT id FROM scans WHERE scope=? ORDER BY id DESC LIMIT 1", (body.scope,)).fetchone()
    if (latest["id"] if latest else None) != (result["scan"]["id"] if result["scan"] else None):
        raise HTTPException(409, "Agent 計算期間選股快照已變更；請重新產生工作流")
    identifier, created = identifier or uuid.uuid4().hex, store.now()
    db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)",
               (identifier, created, ENGINE_VERSION, result["as_of"], result["input_revision"], result["status"], _json(body.model_dump(exclude_none=True)), _json(result)))
    return {**result, "id": identifier, "created_at": created, "saved": True}


@router.post("/api/portfolio-agent/runs", status_code=201)
def create_run(body: WorkflowInput):
    captured_scan_engine = scan_provenance.SCAN_ENGINE_VERSION
    result = preview(body)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        return save_preview(db, body, result, captured_scan_engine=captured_scan_engine)


def _run(db, identifier):
    row = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到 Agent 工作流")
    return {**json.loads(row["result"]), "id": row["id"], "created_at": row["created_at"], "saved": True}


def _currentness(result):
    reasons = []
    if result["engine_version"] != ENGINE_VERSION:
        reasons.append("engine_changed")
    if result["input_revision"] != store.input_revision():
        reasons.append("inputs_changed")
    if result["as_of"] != sessions.latest_completed_session():
        reasons.append("session_changed")
    if result.get("scan") and result["scan"].get("engine_version") != scan_provenance.SCAN_ENGINE_VERSION:
        reasons.append("scan_engine_changed")
    if result.get("account_context"):
        from .paper_portfolio import _policy_context_current
        with store.connect() as db:
            if not _policy_context_current(db, result["account_context"]):
                reasons.append("symbol_policy_changed")
    return {"current": not reasons, "stale_reasons": reasons}


@router.get("/api/portfolio-agent/runs")
@store.snapshot_read
def list_runs(limit: int = Query(default=20, ge=1, le=100)):
    with store.connect() as db:
        rows = db.execute("SELECT * FROM portfolio_agent_runs ORDER BY created_at DESC,id DESC LIMIT ?", (limit,)).fetchall()
        items = []
        for row in rows:
            result = json.loads(row["result"])
            items.append({"id": row["id"], "created_at": row["created_at"], "engine_version": row["engine_version"],
                          "as_of": row["as_of"], "status": row["status"], "scope": result["request"]["scope"],
                          "coverage": result["coverage"], "target_weights": result["target_weights"],
                          "cash_weight_pct": result["cash_weight_pct"], **_currentness(result)})
            if result.get("account_context"):
                items[-1]["account_context"] = result["account_context"]
    return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
            "input_revision": store.input_revision(), "runs": items, "method": METHOD}


@router.get("/api/portfolio-agent/runs/{identifier}")
@store.snapshot_read
def get_run(identifier: str):
    with store.connect() as db:
        result = _run(db, identifier)
    return {**result, **_currentness(result)}


@router.post("/api/portfolio-agent/runs/{identifier}/paper-preview")
@store.snapshot_read
def paper_preview(identifier: str, body: PaperBridgeInput):
    from . import paper_portfolio

    with store.connect() as db:
        result = _run(db, identifier)
        paper_portfolio._validate_policy_binding(db, result.get("account_context"), body.account_id)
        overlay = _overlay(db, body.account_id, result)
    if result["status"] != "proposed":
        raise HTTPException(409, "此 Agent 工作流沒有可接續的目標配置")
    if not _currentness(result)["current"]:
        raise HTTPException(409, "Agent 工作流來源已變更或過期；請重新產生工作流")
    request = paper_portfolio.PreviewInput(expected_version=body.expected_account_version,
                                          targets=overlay["targets_after"],
                                          expected_input_revision=result["input_revision"],
                                          expected_as_of=result["as_of"],
                                          rationale=_paper_rationale(result, overlay))
    paper = paper_portfolio.preview(body.account_id, request)
    return {"agent_run_id": identifier, "agent_engine_version": ENGINE_VERSION,
            "as_of": result["as_of"], "input_revision": result["input_revision"],
            "regime_overlay": overlay, "paper_preview": paper, "method": METHOD}


def _overlay(db, account_id, result):
    """Scale-mode regime overlay for a run's targets; disabled policies return the targets unchanged."""
    from . import regime_overlay
    if result["status"] != "proposed":
        return None
    return regime_overlay.apply_scale(db, account_id, result["target_weights"], result["as_of"])


def _paper_rationale(result, overlay=None):
    from . import regime_overlay
    suffix = regime_overlay.note(overlay) if overlay else ""
    method = (result.get("allocator") or {}).get("method", "equal")
    return (f"本機規則 Agent run {result['id']}；{result['engine_version']}；"
            f"選股 {result['as_of']}，{result['coverage']['selected']} 檔"
            f"{'固定配置' if method == 'equal' else f'風險感知配置（{method}，{allocator.ENGINE_VERSION}）'}，"
            f"保留現金 {result['cash_weight_pct']}%；"
            f"proposal fingerprint {result['proposal_fingerprint']}。完整角色理由與拒絕原因保存於 Agent 工作流。"
            + (suffix.lstrip("；") + "。" if suffix else ""))


@router.post("/api/portfolio-agent/runs/{identifier}/paper-proposal", status_code=201)
def paper_proposal(identifier: str, body: PaperProposalBridgeInput):
    from . import paper_portfolio

    with store.read_snapshot():
        with store.connect() as db:
            result = _run(db, identifier)
            paper_portfolio._validate_policy_binding(db, result.get("account_context"), body.account_id)
            overlay = _overlay(db, body.account_id, result)
        if result["status"] != "proposed":
            raise HTTPException(409, "此 Agent 工作流沒有可接續的目標配置")
        if not _currentness(result)["current"]:
            raise HTTPException(409, "Agent 工作流來源已變更或過期；請重新產生工作流")
    request = paper_portfolio.ProposalInput(
        expected_version=body.expected_account_version, targets=overlay["targets_after"],
        expected_input_revision=result["input_revision"], expected_as_of=result["as_of"],
        rationale=_paper_rationale(result, overlay), idempotency_key=body.idempotency_key,
    )
    paper = paper_portfolio.create_proposal_guarded(body.account_id, request,
        guard=lambda db: paper_portfolio._validate_policy_binding(db, result.get("account_context"), body.account_id))
    return {"agent_run_id": identifier, "agent_engine_version": ENGINE_VERSION,
            "as_of": result["as_of"], "input_revision": result["input_revision"],
            "regime_overlay": overlay, "paper_proposal": paper, "method": METHOD}


class AllocationCompareInput(StrictInput):
    volatility_lookback_sessions: int | None = Field(default=None, ge=20, le=120)


@router.post("/api/portfolio-agent/runs/{identifier}/allocations")
@store.snapshot_read
def compare_allocations(identifier: str, body: AllocationCompareInput):
    """What-if split of a saved run's selected symbols under every allocation method, on current local bars."""
    with store.connect() as db:
        result = _run(db, identifier)
        constraints = AllocationConstraints.model_validate(result["request"]["constraints"])
        if body.volatility_lookback_sessions is not None:
            constraints = constraints.model_copy(update={"volatility_lookback_sessions": body.volatility_lookback_sessions})
        selected = [row for row in result["candidates"] if row["status"] == "selected"]
        methods = {}
        for method in allocator.METHODS:
            targets, evidence = allocator.allocate(db, selected, constraints.model_copy(update={"allocation_method": method}), result["as_of"])
            methods[method] = {"status": evidence["status"], "targets": targets,
                               "cash_weight_pct": round(100 - math.fsum(target["weight_pct"] for target in targets), 8) if targets else None,
                               "allocator": evidence}
        revision = store.input_revision(db)
    return {"engine_version": allocator.ENGINE_VERSION, "agent_run_id": identifier, "as_of": result["as_of"],
            "input_revision": revision, "run_method": (result.get("allocator") or {}).get("method", "equal"),
            "lookback_sessions": constraints.volatility_lookback_sessions, "methods": methods,
            "method": allocator.METHOD + " 比較以目前本機日線重算，不是保存工作流當時的證據；只有工作流本身的方法可接續紙上提案。",
            "warnings": list(allocator.WARNINGS)}
