"""Bounded, read-only rank-sum and full-covariance ERC research for a saved workflow."""
from datetime import date, timedelta
import hashlib
import json
import math

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator

from . import allocator, portfolio_agent as agent, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-allocation-research-v1"
MAX_SYMBOLS, MAX_SWEEPS, RISK_TOLERANCE, EIGEN_RATIO_MIN = 30, 5000, 1e-8, 1e-10
SOURCES = [
    {"title": "Griveau-Billion, Richard & Roncalli (2013), A Fast Algorithm for Computing High-dimensional Risk Parity Portfolios",
     "url": "https://arxiv.org/pdf/1311.4057", "section": "Appendix A.3.2, equation 5; normalized volatility scaling"},
    {"title": "Malkiel & Jun (2009), The Value Effect and the Market for Chinese Stocks",
     "url": "https://www.princeton.edu/~ceps/workingpapers/188malkiel.pdf", "section": "Equation 4, rank weighting; this implementation fixes a positive rank-sum slope"},
]
METHOD = (
    "Advisory allocation arithmetic for all selected symbols of one current, saved, proposed workflow. "
    "Freeze B=sum(saved target weights), the saved per-symbol cap, and score-descending/match-descending/"
    "symbol-ascending ranks. Rank-sum weights are B*(n-r+1)/(n*(n+1)/2). Require every selected symbol's "
    "L+1 exact completed XNYS-session adjusted closes for L=20..120 daily log returns; no dropped dates or "
    "pairwise covariance. Estimate sample covariance (L-1 denominator), annualize by 252, and require positive "
    "variance and minimum/maximum covariance eigenvalue ratio >1e-10. No shrinkage, imputation or fallback. "
    "ERC solves 0.5*y'C*y-sum((1/n)*log(y_i)) on full correlation C by positive-root coordinate descent; "
    "normalize y_i/sigma_i to B. Stop only when max(abs(risk share-1/n))<=1e-8, at most 5000 sweeps. "
    "Cap each weight independently and floor to 8 decimals; excess and rounding stay cash, never redistributed. "
    "Show signed volatility contributions and risk shares before/after caps; capped ERC need not be equal risk. "
    "Cash is modeled as zero risk, with no return/cost estimate. Missing history, invalid covariance or failed "
    "solver makes the comparison unavailable, not a partial allocation. At most 30 symbols, 3630 closes and "
    "900 entries per matrix. No active allocator changes, proposal gate, persistence, provider or broker call."
)
WARNINGS = [
    "排名只表示保存的共識順序；不是預期報酬，也不是配置或組合績效驗證。",
    "歷史共變異矩陣是樣本估計；未考慮估計誤差、未來相關性、交易成本或流動性。",
    "單檔上限可能破壞等風險貢獻；超出額度及取位餘額留現金，不重新配置。",
    "負風險貢獻表示樣本共變異下的抵銷效果，不代表資產不會虧損；現金在此模型中視為零風險。",
    "只讀研究比較，不變更保存工作流、主動配置方法或提案；不可直接套用或下單。",
]


class AllocationResearchInput(agent.StrictInput):
    expected_proposal_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    lookback_sessions: int = Field(default=60, ge=20, le=120)

    @field_validator("expected_as_of")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _reason(code, **details):
    return {"code": code, **details}


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _history(db, symbols, as_of, lookback):
    days = sessions.expected_sessions((date.fromisoformat(as_of) - timedelta(days=lookback * 3 + 30)).isoformat(), as_of)[-(lookback + 1):]
    coverage = {"required_symbols": len(symbols), "complete_symbols": 0, "required_closes": len(symbols) * (lookback + 1),
                "valid_closes": 0, "required_return_sessions": lookback, "common_return_sessions": 0, "per_symbol": []}
    if len(days) != lookback + 1 or days[-1] != as_of:
        return None, coverage, [], [_reason("calendar_unavailable")], None
    series, reasons, records = [], [], []
    complete_returns = set(days[1:])
    for symbol in symbols:
        rows = {row["date"]: row["adj_close"] for row in db.execute(
            "SELECT date,adj_close FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date", (symbol, days[0], as_of))}
        missing = [day for day in days if day not in rows]
        invalid = [day for day in days if day in rows and not _positive(rows[day])]
        valid = {day for day in days if day in rows and _positive(rows[day])}
        valid_returns = {later for earlier, later in zip(days, days[1:]) if earlier in valid and later in valid}
        complete_returns &= valid_returns
        item = {"symbol": symbol, "required_closes": lookback + 1, "valid_closes": len(valid),
                "valid_returns": len(valid_returns), "missing_dates": missing, "invalid_dates": invalid,
                "status": "complete" if not missing and not invalid else "unavailable"}
        coverage["per_symbol"].append(item)
        coverage["valid_closes"] += len(valid)
        if missing or invalid:
            reasons.append(_reason("history_incomplete" if missing else "invalid_adjusted_close", symbol=symbol,
                                   missing_dates=missing, invalid_dates=invalid))
            continue
        coverage["complete_symbols"] += 1
        prices = [rows[day] for day in days]
        records.append({"symbol": symbol, "adjusted_closes": prices})
        series.append([math.log(later) - math.log(earlier) for earlier, later in zip(prices, prices[1:])])
    coverage["common_return_sessions"] = len(complete_returns)
    return (None if reasons else np.asarray(series, dtype=float).T), coverage, days, reasons, (None if reasons else _hash({"dates": days, "series": records}))


def _covariance(returns):
    covariance = np.atleast_2d(np.cov(returns, rowvar=False, ddof=1)) * 252
    diagnostics = {"min_eigenvalue": None, "max_eigenvalue": None, "eigenvalue_ratio": None,
                   "condition_number": None, "required_eigenvalue_ratio_gt": EIGEN_RATIO_MIN}
    if not np.isfinite(covariance).all():
        return None, None, diagnostics, "nonfinite_covariance"
    variance = np.diag(covariance)
    if np.any(variance <= 0):
        return covariance, None, diagnostics, "zero_variance"
    sigma = np.sqrt(variance)
    correlation = covariance / np.outer(sigma, sigma)
    try:
        eigenvalues = np.linalg.eigvalsh(covariance)
    except np.linalg.LinAlgError:
        return covariance, correlation, diagnostics, "covariance_eigendecomposition_failed"
    low, high = float(eigenvalues[0]), float(eigenvalues[-1])
    ratio = low / high if high > 0 else None
    condition = high / low if low > 0 else None
    diagnostics.update(min_eigenvalue=low, max_eigenvalue=high, eigenvalue_ratio=ratio,
                       condition_number=condition if condition is not None and math.isfinite(condition) else None)
    if ratio is None or ratio <= EIGEN_RATIO_MIN:
        return covariance, correlation, diagnostics, "singular_or_ill_conditioned_covariance"
    return covariance, correlation, diagnostics, None


def _erc(covariance, correlation):
    """Positive coordinate minimizers of the cited quadratic log-barrier objective."""
    size = len(covariance)
    budget = 1 / size
    y = np.ones(size)
    sigma = np.sqrt(np.diag(covariance))
    error = None
    for sweep in range(1, MAX_SWEEPS + 1):
        for index in range(size):
            a = float(correlation[index, index])
            cross = math.fsum(float(correlation[index, other]) * float(y[other]) for other in range(size) if other != index)
            root = math.sqrt(cross * cross + 4 * a * budget)
            y[index] = 2 * budget / (root + cross) if cross >= 0 else (root - cross) / (2 * a)
        x = y / sigma
        weights = x / math.fsum(x)
        terms = weights * (covariance @ weights)
        variance = float(math.fsum(terms))
        if not np.isfinite(weights).all() or np.any(weights <= 0) or not math.isfinite(variance) or variance <= 0:
            return None, {"converged": False, "sweeps": sweep, "max_risk_share_error": None, "reason": "solver_nonfinite"}
        error = float(np.max(np.abs(terms / variance - budget)))
        if error <= RISK_TOLERANCE:
            return weights, {"converged": True, "sweeps": sweep, "max_risk_share_error": error, "reason": None}
    return None, {"converged": False, "sweeps": MAX_SWEEPS, "max_risk_share_error": error, "reason": "solver_nonconvergence"}


def _risk(covariance, weights_pct):
    weights = np.asarray(weights_pct) / 100
    terms = weights * (covariance @ weights)
    variance = float(math.fsum(terms))
    if not math.isfinite(variance) or variance <= 0:
        return {"status": "unavailable", "reason": "nonpositive_portfolio_variance", "volatility_annualized_pct": None,
                "contributions_annualized_pct": [None] * len(weights), "risk_shares_pct": [None] * len(weights),
                "max_equal_risk_share_error": None}
    volatility = math.sqrt(variance)
    shares = terms / variance
    return {"status": "calculated", "reason": None, "volatility_annualized_pct": volatility * 100,
            "contributions_annualized_pct": (terms / volatility * 100).tolist(), "risk_shares_pct": (shares * 100).tolist(),
            "max_equal_risk_share_error": float(np.max(np.abs(shares - 1 / len(weights))))}


def _scenario(symbols, raw, cap, budget, covariance):
    capped = [allocator._floor8(min(float(weight), cap)) for weight in raw]
    invested = math.fsum(capped)
    return {"status": "calculated", "reason": None,
            "weights": [{"symbol": symbol, "raw_weight_pct": float(raw[index]), "capped_weight_pct": capped[index]}
                        for index, symbol in enumerate(symbols)],
            "invested_before_pct": budget, "invested_after_pct": invested, "cash_before_pct": 100 - budget,
            "cash_after_pct": 100 - invested, "capped_or_rounded_to_cash_pct": max(0.0, budget - invested),
            "risk_before": _risk(covariance, raw), "risk_after": _risk(covariance, capped)}


def _unavailable(code):
    return {"status": "unavailable", "reason": code, "weights": [], "invested_before_pct": None,
            "invested_after_pct": None, "cash_before_pct": None, "cash_after_pct": None,
            "capped_or_rounded_to_cash_pct": None, "risk_before": None, "risk_after": None}


@router.post("/api/portfolio-agent/runs/{identifier}/allocation-research")
@store.snapshot_read
def compare_allocations(identifier: str, body: AllocationResearchInput):
    with store.connect() as db:
        run = agent._run(db, identifier)
        if (run["proposal_fingerprint"] != body.expected_proposal_fingerprint or run["input_revision"] != body.expected_input_revision
                or run["as_of"] != body.expected_as_of or not agent._currentness(run)["current"]):
            raise _problem("allocation_research_stale", "工作流來源或指紋已變更；請重新產生工作流")
        if run["status"] != "proposed":
            raise _problem("allocation_research_blocked", "只能比較已保存且未受阻的工作流", 422)
        selected = sorted((row for row in run["candidates"] if row["status"] == "selected"),
                          key=lambda row: (-row["score"], -row["matched_count"], row["symbol"]))
        symbols = [row["symbol"] for row in selected]
        targets = run["target_weights"]
        if (not 1 <= len(symbols) <= MAX_SYMBOLS or len(set(symbols)) != len(symbols)
                or len(targets) != len(symbols) or {row["symbol"] for row in targets} != set(symbols)):
            raise _problem("allocation_research_selection", "保存工作流的完整入選標的或目標不一致", 422)
        if any(not isinstance(row["weight_pct"], (int, float)) or isinstance(row["weight_pct"], bool)
               or not math.isfinite(row["weight_pct"]) or row["weight_pct"] < 0 for row in targets):
            raise _problem("allocation_research_budget", "保存工作流的投入預算不可用", 422)
        constraints = agent.AllocationConstraints.model_validate(run["request"]["constraints"])
        budget, cap = math.fsum(row["weight_pct"] for row in targets), constraints.max_position_weight_pct
        if budget > 100 or any(row["weight_pct"] > cap for row in targets):
            raise _problem("allocation_research_budget", "保存工作流的投入預算超出限制", 422)
        revision, as_of = store.input_revision(db), run["as_of"]
        returns, coverage, days, reasons, history_fingerprint = _history(db, symbols, as_of, body.lookback_sessions)
        covariance = correlation = diagnostics = solver = None
        if budget == 0:
            reasons.append(_reason("zero_invested_budget"))
        if not reasons:
            covariance, correlation, diagnostics, issue = _covariance(returns)
            if issue:
                reasons.append(_reason(issue))
        weights = None
        if not reasons:
            weights, solver = _erc(covariance, correlation)
            if weights is None:
                reasons.append(_reason(solver["reason"]))
        if reasons:
            methods = {name: _unavailable(reasons[0]["code"]) for name in ("rank_sum", "equal_risk_contribution")}
        else:
            size = len(symbols)
            rank_weights = [budget * (size - index) / (size * (size + 1) / 2) for index in range(size)]
            methods = {"rank_sum": _scenario(symbols, rank_weights, cap, budget, covariance),
                       "equal_risk_contribution": _scenario(symbols, weights * budget, cap, budget, covariance)}
        if store.input_revision(db) != revision or sessions.latest_completed_session() != as_of:
            raise _problem("allocation_research_stale", "比較期間行情或交易日已變更；請重新比較")
        response = {"engine_version": ENGINE_VERSION, "agent_engine_version": run["engine_version"],
            "agent_run_id": identifier, "proposal_fingerprint": run["proposal_fingerprint"], "as_of": as_of,
            "input_revision": revision, "current_at_snapshot": True, "mode": "advisory_only",
            "status": "unavailable" if reasons else "calculated", "reasons": reasons, "request": body.model_dump(),
            "selected_symbols": symbols, "ranking": [{"rank": index + 1, "symbol": row["symbol"], "score": row["score"],
                "matched_count": row["matched_count"]} for index, row in enumerate(selected)],
            "saved_targets": targets, "invested_budget_pct": budget, "position_cap_pct": cap,
            "window": {"lookback_sessions": body.lookback_sessions, "price_dates": days, "return_dates": days[1:]},
            "coverage": coverage, "history_fingerprint": history_fingerprint,
            "covariance_annualized": covariance.tolist() if covariance is not None else None,
            "correlation": correlation.tolist() if correlation is not None else None, "matrix_diagnostics": diagnostics,
            "solver": None if solver is None else {**solver, "max_sweeps": MAX_SWEEPS, "risk_share_tolerance": RISK_TOLERANCE},
            "methods": methods, "method": METHOD, "warnings": WARNINGS, "sources": SOURCES}
        response["evidence_fingerprint"] = _hash(response)
        return JSONResponse(response, headers={"Cache-Control": "no-store"})
