"""Compare immutable saved workflow observations, never rerun rules or attribute causes."""
from decimal import Decimal
import json
import math

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator

from . import portfolio_agent as agent, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-workflow-comparison-v1"
MAX_CANDIDATES = 100
METHOD = (
    "Compare the persisted JSON of two distinct Portfolio Agent runs under one read snapshot; no strategy, "
    "allocator, quote or performance is recomputed. Candidate and selected-set observations are shown as saved. "
    "A missing symbol, field, invalid number or blocked target remains unknown, never zero. Score differences "
    "are comparison minus baseline only when both finite saved scores use the same workflow method version. "
    "Target-weight and cash differences are percentage-point arithmetic between two available saved allocations, "
    "even if allocation methods differ; they do not explain causality. Settings changes and saved source/method "
    "identity changes are separate. Currentness labels alone consult current local metadata in the same snapshot; "
    "they do not change historical values. At most 100 saved candidates per run and 200 union rows."
)
WARNINGS = [
    "這是兩份保存紀錄的差異，不是績效比較、參數敏感度實驗或因果解釋。",
    "方法、行情、交易日與設定可能同時改變；不能把分數或權重差異歸因於某一設定。",
    "權重與現金差值只代表百分點算術；未記錄的標的或受阻配置不視為零。",
    "歷史值不重算；當期標示只代表此次比較快照的本機來源狀態，不保證之後仍當期。",
]
SETTINGS = ["scope", "candidate_symbols", *[f"strategy_weights.{rule}" for rule in agent.STRATEGY_IDS],
            *[f"constraints.{key}" for key in agent.AllocationConstraints.model_fields]]
SOURCES = ["engine_version", "as_of", "input_revision", "proposal_fingerprint", "scan.id", "scan.as_of",
           "scan.engine_version", "allocator.engine_version", "allocator.method", "account_context.account_id",
           "account_context.symbol_policy.engine_version", "account_context.symbol_policy.version"]


class CompareInput(agent.StrictInput):
    baseline_run_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    comparison_run_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def different_runs(self):
        if self.baseline_run_id == self.comparison_run_id:
            raise ValueError("請選擇兩筆不同的保存工作流")
        return self


def _unknown(reason):
    return {"known": False, "value": None, "reason": reason}


def _finite_json(value):
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_finite_json(item) for item in value.values())
    if isinstance(value, list):
        return all(_finite_json(item) for item in value)
    return True


def _value(mapping, path):
    value = mapping
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return _unknown("not_recorded")
        value = value[part]
    if value is None:
        return _unknown("missing_value")
    if not _finite_json(value):
        return _unknown("invalid_number")
    return {"known": True, "value": value, "reason": None}


def _number(mapping, field):
    value = _value(mapping, field)
    if not value["known"]:
        return value
    number = value["value"]
    if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number <= 100 or not math.isfinite(number):
        return _unknown("invalid_number")
    return value


def _delta(left, right, *, comparable=True, reason="method_changed"):
    if not comparable:
        return _unknown(reason)
    if not left["known"] or not right["known"]:
        return _unknown("missing_side")
    return {"known": True, "value": float(Decimal(str(right["value"])) - Decimal(str(left["value"]))), "reason": None}


def _differences(left, right, fields):
    result = []
    for field in fields:
        a, b = _value(left, field), _value(right, field)
        result.append({"field": field, "baseline": a, "comparison": b,
                       "status": "unknown" if not a["known"] or not b["known"] else "same" if a["value"] == b["value"] else "changed"})
    return result


def _load(db, identifier):
    row = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, {"code": "workflow_not_found", "message": "找不到指定的保存工作流"})
    # A bound before JSON parsing also limits legacy or damaged records; no partial truncation.
    if len(row["result"]) > 2_000_000:
        raise HTTPException(422, {"code": "workflow_record_limit", "message": "保存工作流超過本版比較上限"})
    try:
        result = json.loads(row["result"])
    except (ValueError, RecursionError):
        raise HTTPException(422, {"code": "workflow_record_invalid", "message": "保存工作流 JSON 無法比較"}) from None
    if not isinstance(result, dict):
        raise HTTPException(422, {"code": "workflow_record_invalid", "message": "保存工作流格式無法比較"})
    candidates = result.get("candidates")
    targets = result.get("target_weights")
    for values in (candidates, targets):
        if values is not None and (not isinstance(values, list) or len(values) > MAX_CANDIDATES
                                  or any(not isinstance(item, dict) or not isinstance(item.get("symbol"), str)
                                         or not agent.SYMBOL.fullmatch(item["symbol"]) for item in values)
                                  or len({item["symbol"] for item in values}) != len(values)):
            raise HTTPException(422, {"code": "workflow_record_limit", "message": "保存候選或目標超過上限、重複或格式無效"})
    union = {item["symbol"] for item in (candidates or [])} | {item["symbol"] for item in (targets or [])}
    if len(union) > MAX_CANDIDATES:
        raise HTTPException(422, {"code": "workflow_record_limit", "message": "每筆保存工作流最多比較 100 個標的"})
    return {**result, "id": row["id"], "created_at": row["created_at"]}


def _currentness(run):
    required = ("engine_version", "input_revision", "as_of")
    if any(not isinstance(run.get(key), str) or not run[key] for key in required):
        return {"current": None, "stale_reasons": ["source_identity_incomplete"]}
    try:
        return agent._currentness(run)
    except (AttributeError, KeyError, TypeError, ValueError):
        return {"current": None, "stale_reasons": ["source_identity_incomplete"]}


def _metadata(run):
    return {"id": run["id"], "created_at": run["created_at"],
            **{key: _value(run, key)["value"] for key in ("engine_version", "as_of", "input_revision", "proposal_fingerprint", "status")},
            "scan": {key: _value(run, f"scan.{key}")["value"] for key in ("id", "as_of", "engine_version")},
            "allocator": {key: _value(run, f"allocator.{key}")["value"] for key in ("engine_version", "method")},
            "account_context": _value(run, "account_context")["value"], **_currentness(run)}


def _side(run, symbol):
    candidate = next((item for item in (run.get("candidates") or []) if item["symbol"] == symbol), None)
    target = next((item for item in (run.get("target_weights") or []) if item["symbol"] == symbol), None)
    status = _value(candidate, "status")
    if status["known"] and status["value"] not in ("selected", "unselected", "rejected"):
        status = _unknown("invalid_status")
    return {"candidate_recorded": candidate is not None, "target_recorded": target is not None,
            "status": status, "score": _number(candidate, "score"),
            "weight_pct": _number(target, "weight_pct") if run.get("status") == "proposed" else _unknown("allocation_unavailable")}


def _selected(run):
    candidates = run.get("candidates")
    if not isinstance(candidates, list) or any(item.get("status") not in ("selected", "unselected", "rejected") for item in candidates):
        return None
    return sorted(item["symbol"] for item in candidates if item["status"] == "selected")


def compare(body):
    with store.connect() as db:
        a, b = _load(db, body.baseline_run_id), _load(db, body.comparison_run_id)
        score_comparable = bool(isinstance(a.get("engine_version"), str) and a["engine_version"]
                                and a["engine_version"] == b.get("engine_version"))
        symbols = sorted({item["symbol"] for run in (a, b) for key in ("candidates", "target_weights") for item in (run.get(key) or [])})
        rows = []
        for symbol in symbols:
            left, right = _side(a, symbol), _side(b, symbol)
            rows.append({"symbol": symbol, "baseline": left, "comparison": right,
                         "score_delta": _delta(left["score"], right["score"], comparable=score_comparable),
                         "weight_delta_pp": _delta(left["weight_pct"], right["weight_pct"])})
        cash_a = _number(a, "cash_weight_pct") if a.get("status") == "proposed" else _unknown("allocation_unavailable")
        cash_b = _number(b, "cash_weight_pct") if b.get("status") == "proposed" else _unknown("allocation_unavailable")
        selected_a, selected_b = _selected(a), _selected(b)
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db),
                "baseline": _metadata(a), "comparison": _metadata(b), "rows": rows,
                "selected": {"baseline": selected_a, "comparison": selected_b,
                    "only_in_baseline": sorted(set(selected_a) - set(selected_b)) if selected_a is not None and selected_b is not None else None,
                    "only_in_comparison": sorted(set(selected_b) - set(selected_a)) if selected_a is not None and selected_b is not None else None,
                    "baseline_recorded": selected_a is not None, "comparison_recorded": selected_b is not None},
                "cash": {"baseline": cash_a, "comparison": cash_b, "delta_pp": _delta(cash_a, cash_b)},
                "settings": _differences(a.get("request"), b.get("request"), SETTINGS), "sources": _differences(a, b, SOURCES),
                "comparability": {"score_deltas": score_comparable, "score_reason": None if score_comparable else "method_changed",
                    "baseline_allocation": a.get("status") == "proposed", "comparison_allocation": b.get("status") == "proposed",
                    "weight_delta_semantics": "saved_percentage_point_arithmetic_only", "performance_comparison": False},
                "coverage": {"union_symbols": len(rows), "baseline_candidates": len(a["candidates"]) if isinstance(a.get("candidates"), list) else None,
                    "comparison_candidates": len(b["candidates"]) if isinstance(b.get("candidates"), list) else None,
                    "score_deltas_available": sum(row["score_delta"]["known"] for row in rows),
                    "weight_deltas_available": sum(row["weight_delta_pp"]["known"] for row in rows)},
                "method": METHOD, "warnings": WARNINGS}


@router.post("/api/portfolio-agent/compare")
@store.snapshot_read
def compare_endpoint(body: CompareInput):
    return JSONResponse(compare(body), headers={"Cache-Control": "no-store"})
