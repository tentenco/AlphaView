"""Versioned, read-only candidate selection from a verified local scan pool."""
import hashlib
from collections import Counter
from typing import Literal

from fastapi import APIRouter
from pydantic import Field, model_validator

from . import portfolio_agent as agent
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-portfolio-candidates-v1"
MAX_POOL_SIZE = 5000
REJECTION_SAMPLE_LIMIT = 25
METHOD = (
    "Rank the current scope's complete local scan pool using verified latest completed "
    "XNYS-session provenance and the portfolio Agent's fixed strategy weights. Every "
    "enabled strategy and the current valid quote are required for a numeric score; "
    "incomplete candidates are excluded with counts and reasons, never scored as zero "
    "or assigned another strategy's weight. Rank by score descending, enabled matches "
    "descending, then symbol ascending; take at most the requested limit (1–100). "
    "This selects only from the saved workspace pool, not the whole stock market. "
    "Pool/complete/eligible/selected counts remain distinct. review_symbols contains "
    "complete rows for a blocked no-match research trace and never implies eligibility."
)


class SelectorInput(agent.StrictInput):
    scope: Literal["portfolio", "market"] = "market"
    strategy_weights: agent.StrategyWeights = Field(default_factory=agent.StrategyWeights)
    min_score: float = Field(default=50, ge=0, le=100)
    min_matches: int = Field(default=1, ge=1, le=4)
    limit: int = Field(default=100, ge=1, le=100)

    @model_validator(mode="after")
    def enough_enabled(self):
        if self.min_matches > sum(weight > 0 for weight in self.strategy_weights.model_dump().values()):
            raise ValueError("最低符合策略數不可超過啟用策略數")
        return self


@router.post("/api/portfolio-agent/candidates")
@store.snapshot_read
def select_candidates(body: SelectorInput):
    expected, revision = sessions.latest_completed_session(), store.input_revision()
    snapshot, blocking = agent._source(body, expected)
    symbols = sorted({row["symbol"] for row in store.universe(body.scope)})
    if len(symbols) > MAX_POOL_SIZE:
        blocking.append(agent._reason("pool_limit", f"本版候選池最多支援 {MAX_POOL_SIZE} 檔；未截斷後冒充完整池"))
    indexed = {}
    if snapshot:
        for row in snapshot["result"]:
            indexed.setdefault(row.get("symbol"), []).append(row)
    rows = []
    valid_symbols = [symbol for symbol in symbols if agent.SYMBOL.fullmatch(symbol)]
    if not blocking and valid_symbols:
        request = agent.WorkflowInput(scope=body.scope, candidate_symbols=valid_symbols[:100],
                                      strategy_weights=body.strategy_weights,
                                      constraints=agent.AllocationConstraints(min_score=body.min_score, min_matches=body.min_matches))
        membership = set(snapshot["universe"])
        with store.connect() as db:
            for symbol in symbols:
                if not agent.SYMBOL.fullmatch(symbol):
                    rows.append({"symbol": symbol, "status": "rejected", "score": None, "coverage_pct": 0,
                                 "matched_count": 0, "reasons": [agent._reason("unsupported_symbol", "代碼不在本版 Agent 支援格式")],
                                 "contributions": [], "evidence": {"quote_date": None, "reference_close": None}})
                    continue
                rows.append(agent._candidate(symbol, indexed.get(symbol, []) if symbol in membership else [], request, expected, db, []))
    if not blocking and symbols and not valid_symbols:
        rows = [{"symbol": symbol, "status": "rejected", "score": None, "coverage_pct": 0,
                 "matched_count": 0, "reasons": [agent._reason("unsupported_symbol", "代碼不在本版 Agent 支援格式")],
                 "contributions": [], "evidence": {"quote_date": None, "reference_close": None}}
                for symbol in symbols]
    complete = sorted((row for row in rows if row["score"] is not None),
                      key=lambda row: (-row["score"], -row["matched_count"], row["symbol"]))
    eligible = [row for row in complete if row["status"] == "eligible"]
    selected = [{**row, "rank": index + 1, "status": "selected"} for index, row in enumerate(eligible[:body.limit])]
    rejected = [row for row in rows if row["status"] == "rejected"]
    if not blocking and not symbols:
        blocking.append(agent._reason("empty_pool", "目前工作區股票池為空"))
    elif not blocking and not complete:
        blocking.append(agent._reason("no_complete_candidates", "候選池沒有啟用策略與當期行情皆完整的標的"))
    status = "blocked" if blocking else "ready" if selected else "empty"
    reasons = list(blocking)
    if status == "empty":
        reasons.append(agent._reason("no_eligible_candidates", "候選資料可驗證，但沒有符合固定策略門檻的標的；不產生清空持倉目標"))
    source = None if snapshot is None else {
        "id": snapshot["id"], "scope": snapshot["scope"], "as_of": snapshot["as_of"],
        "created_at": snapshot["created_at"], "input_revision": snapshot.get("input_revision"),
        "engine_version": snapshot["scan_engine_version"], "input_status": snapshot["input_status"],
        "matches_current_universe": snapshot["matches_current_universe"],
        "scan_member_count": snapshot["scan_member_count"], "current_member_count": snapshot["current_member_count"],
    }
    reason_counts = Counter(code for row in rejected for code in {reason["code"] for reason in row["reasons"]})
    result = {"engine_version": ENGINE_VERSION, "agent_engine_version": agent.ENGINE_VERSION,
              "as_of": expected, "input_revision": revision, "status": status, "request": body.model_dump(),
              "scope": body.scope, "scan": source,
              "coverage": {"pool": len(symbols), "complete": len(complete), "incomplete": len(symbols) - len(complete),
                           "eligible": len(eligible), "selected": len(selected), "rejected": len(symbols) - len(eligible),
                           "limited": max(0, len(eligible) - body.limit)},
              "candidate_symbols": [row["symbol"] for row in selected],
              "review_symbols": [row["symbol"] for row in complete[:body.limit]],
              "candidates": selected, "rejection_counts": dict(sorted(reason_counts.items())),
              "rejected_sample": [{"symbol": row["symbol"], "score": row["score"], "coverage_pct": row["coverage_pct"],
                                   "reasons": row["reasons"]} for row in rejected[:REJECTION_SAMPLE_LIMIT]],
              "rejection_sample_limit": REJECTION_SAMPLE_LIMIT, "reasons": reasons, "method": METHOD,
              "warnings": ["涵蓋範圍限於目前儲存的股票池；不是全市場選股或投資報酬預測。",
                           "有缺資料的候選會明確排除；選出少於配置席位時，剩餘權重仍保留現金。"]}
    result["selection_fingerprint"] = hashlib.sha256(agent._json(result).encode()).hexdigest()
    return result
