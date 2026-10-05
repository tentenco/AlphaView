"""Read-only retrospective path of saved settings, with independently rebuilt decision prefixes."""
from datetime import date, timedelta
import hashlib
import json
import math

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator

from . import allocator, portfolio_agent as agent, research, scan_provenance, sessions, store
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-workflow-path-validation-v1"
MAX_CANDIDATES, MAX_PEERS, MAX_HISTORY_BARS = 30, 100, 3000
WINDOW_SESSIONS, REBALANCE_SESSIONS = 252, 21
INITIAL_CASH, FEE_BPS, FACTOR_RTOL = 100000.0, 10.0, 1e-6
METHOD = (
    "Retrospective path of a current saved workflow's fixed candidate list, strategy weights, constraints "
    "and saved symbol policy. This is not point-in-time universe selection or evidence of out-of-sample "
    "strategy validity. Rebuild research.indicators and research.evaluate independently on local history "
    "prefixes ending at each prior-close decision: twelve decisions, every 21 sessions over the latest "
    "252 completed XNYS sessions. RPS uses the entire saved scan universe, never a smaller substitute; "
    "every required peer/candidate rule must be available. Rank by saved weighted score, matches, symbol; "
    "use the saved allocator on that date. Policy exclusions leave original slots empty. No eligible "
    "candidate means no proposal and unchanged holdings, matching the workflow. Missing evidence instead "
    "makes the whole path unavailable. Fractional raw shares trade at the following session's raw open; "
    "target weights apply to equity after 10 bps fees on net trades, with zero slippage, 100000 initial cash, "
    "zero cash return and no terminal liquidation. Signals and allocator volatility use adjusted prices; "
    "valuation uses raw closes. An adjacent adjustment-factor change over relative tolerance 1e-6 while "
    "held makes accounting unavailable: no dividend, split or other entitlement is invented. At most 30 "
    "candidates, 100 total required symbols and 3000 stored bars per symbol, checked before history loading. "
    "No model, provider, broker, account mutation, proposal gate, optimization or statistical pass verdict."
)
WARNINGS = [
    "候選清單、RPS 股票池與設定固定於保存工作流當時；包含事後選擇與倖存者偏差，不是當時股票池的策略回測。",
    "每次訊號只用當日以前的本機資料；調整價仍是目前保存的修訂版本，不是歷史當時可取得的資料版本。",
    "沒有符合候選時沿用原部位；這對應工作流不建立清空提案的行為，不代表繼續持有的建議。",
    "以未調整開盤成交、未調整收盤估值；持有期間調整因子變動則整段不可用，不推算股息或拆併股。",
    "不包含市場風險覆蓋、停損、模型、帳戶風控或實際成交限制；這不是完整自動化帳戶績效、樣本外證明或交易指示。",
]


class PathValidationInput(agent.StrictInput):
    expected_proposal_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("expected_as_of")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value


class PathUnavailable(ValueError):
    def __init__(self, code, **details):
        self.reason = {"code": code, **details}
        super().__init__(code)


def _hash(value):
    def safe(item):
        if isinstance(item, float) and not math.isfinite(item):
            return {"invalid_numeric_value": str(item)}
        if isinstance(item, dict):
            return {key: safe(content) for key, content in item.items()}
        if isinstance(item, (tuple, list)):
            return [safe(content) for content in item]
        return item
    return hashlib.sha256(json.dumps(safe(value), sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _unavailable(result, code, **details):
    result["reasons"].append({"code": code, **details})
    return result


def _load_history(db, symbols, as_of, result):
    counts = {symbol: db.execute("SELECT COUNT(*) FROM bars WHERE symbol=? AND date<=?", (symbol, as_of)).fetchone()[0]
              for symbol in symbols}
    result["coverage"]["history"] = [{"symbol": symbol, "bars": count} for symbol, count in counts.items()]
    for symbol, count in counts.items():
        if count > MAX_HISTORY_BARS:
            _unavailable(result, "history_limit", symbol=symbol, observed=count, limit=MAX_HISTORY_BARS)
        elif not count:
            _unavailable(result, "no_history", symbol=symbol)
    if result["reasons"]:
        return None
    raw = {symbol: [dict(row) for row in db.execute(
        "SELECT date,open,high,low,close,adj_close,volume FROM bars WHERE symbol=? AND date<=? ORDER BY date", (symbol, as_of))]
        for symbol in symbols}
    result["history_fingerprint"] = _hash(raw)
    return raw


def _decision(db, raw, signal_day, trade_day, workflow, policy):
    # Build only truncated raw histories, rather than computing on future bars and slicing output.
    frames = {symbol: research.indicators(pd.DataFrame([bar for bar in bars if bar["date"] <= signal_day],
              columns=["date", "open", "high", "low", "close", "adj_close", "volume"])) for symbol, bars in raw.items()}
    scanned = research.evaluate(frames, signal_day)
    indexed = {row["symbol"]: row for row in scanned}
    rows = [agent._candidate(symbol, [indexed[symbol]], workflow, signal_day, db, [])
            for symbol in workflow.candidate_symbols]
    weights = workflow.strategy_weights.model_dump()
    enabled = sum(value > 0 for value in weights.values())
    coverage = {"required_candidate_rules": len(rows) * enabled,
                "available_candidate_rules": sum(contribution["enabled"] and contribution["available"]
                    for row in rows for contribution in row["contributions"]),
                "required_rps_peers": len(indexed) if weights["rps"] > 0 else 0,
                "available_rps_peers": 0}
    gaps = []
    if workflow.strategy_weights.rps > 0:
        for symbol, row in indexed.items():
            rps = next(signal for signal in row["signals"] if signal["strategy"] == "rps")
            if rps["status"] not in ("match", "watch"):
                gaps.append({"code": "rps_peer_unavailable", "symbol": symbol, "rule": "rps", "status": rps["status"]})
            else:
                coverage["available_rps_peers"] += 1
    for row in rows:
        if row["score"] is None:
            gaps.extend({"symbol": row["symbol"], **reason} for reason in row["reasons"])
    decision = {"signal_date": signal_day, "trade_date": trade_day, "status": "unavailable", "targets": [],
                "cash_weight_pct": None, "candidates": [{key: row[key] for key in
                    ("symbol", "score", "matched_count", "coverage_pct", "status", "reasons")} for row in rows],
                "allocator": None, "coverage": coverage, "reasons": gaps}
    if gaps:
        return decision
    ranked = sorted((row for row in rows if row["status"] == "eligible"),
                    key=lambda row: (-row["score"], -row["matched_count"], row["symbol"]))
    selected = ranked[:workflow.constraints.max_positions]
    if policy:
        from .paper_portfolio import _symbol_allowed
        selected = [row for row in selected if _symbol_allowed(policy, row["symbol"])]
    for row in decision["candidates"]:
        if policy:
            from .paper_portfolio import _symbol_allowed
            if not _symbol_allowed(policy, row["symbol"]):
                row["status"] = "policy_excluded"
                continue
        if row["status"] == "eligible":
            row["status"] = "selected" if any(item["symbol"] == row["symbol"] for item in selected) else "unselected"
    if not selected:
        decision["status"] = "hold_no_candidates"
        return decision
    targets, evidence = allocator.allocate(db, selected, workflow.constraints, signal_day)
    decision["allocator"] = evidence
    if evidence["status"] != "applied":
        decision["reasons"] = [{"code": "allocation_unavailable", "details": evidence["unavailable"]}]
        return decision
    decision.update(status="rebalance", targets=targets,
                    cash_weight_pct=100 - math.fsum(target["weight_pct"] for target in targets))
    return decision


def _rebalance(shares, cash, targets, prices, fee):
    weights = {target["symbol"]: target["weight_pct"] / 100 for target in targets}
    if any(not _positive(weight) for weight in weights.values()) or math.fsum(weights.values()) > 1:
        raise PathUnavailable("invalid_target_weights")
    held = {symbol: amount * prices[symbol] for symbol, amount in shares.items()}
    equity = cash + math.fsum(held.values())
    symbols = sorted(set(shares) | set(weights))
    def turnover(nav):
        return math.fsum(abs(nav * weights.get(symbol, 0) - held.get(symbol, 0)) for symbol in symbols)
    low, high = 0.0, equity
    for _ in range(80):
        mid = (low + high) / 2
        if mid + fee * turnover(mid) > equity:
            high = mid
        else:
            low = mid
    values = {symbol: low * weight for symbol, weight in weights.items()}
    trades = []
    for symbol in symbols:
        difference = values.get(symbol, 0) - held.get(symbol, 0)
        if difference != 0:
            trades.append({"symbol": symbol, "side": "buy" if difference > 0 else "sell",
                           "shares": abs(difference) / prices[symbol], "raw_open": prices[symbol],
                           "notional": abs(difference), "fee": abs(difference) * fee})
    costs = math.fsum(trade["fee"] for trade in trades)
    next_cash = equity - math.fsum(values.values()) - costs
    if not math.isfinite(next_cash) or next_cash < -1e-7:
        raise PathUnavailable("nonfinite_accounting")
    # The low bisection bound leaves at most floating-point residual; record it in cash.
    next_cash = max(0.0, next_cash)
    return {symbol: value / prices[symbol] for symbol, value in values.items()}, next_cash, trades, costs


def _simulate(calendar, decisions, raw):
    prices = {symbol: {bar["date"]: bar for bar in bars} for symbol, bars in raw.items()}
    by_day = {decision["trade_date"]: decision for decision in decisions}
    cash, shares, curve, events = INITIAL_CASH, {}, [], []
    cost_total, notional, peak, drawdown = 0.0, 0.0, INITIAL_CASH, 0.0
    def bar(symbol, day):
        row = prices.get(symbol, {}).get(day)
        if row is None or not valid_bar(row):
            raise PathUnavailable("valuation_bar_unavailable", symbol=symbol, date=day)
        return row
    for previous, day in zip(calendar, calendar[1:]):
        for symbol in shares:
            before, after = bar(symbol, previous), bar(symbol, day)
            old, new = before["adj_close"] / before["close"], after["adj_close"] / after["close"]
            if not _positive(old) or not _positive(new):
                raise PathUnavailable("invalid_adjustment_factor", symbol=symbol, date=day)
            if not math.isclose(old, new, rel_tol=FACTOR_RTOL, abs_tol=0):
                raise PathUnavailable("held_corporate_action_unmodeled", symbol=symbol, date=day,
                                      previous_factor=old, current_factor=new)
        decision = by_day.get(day)
        if decision and decision["status"] == "rebalance":
            required = set(shares) | {row["symbol"] for row in decision["targets"]}
            opens = {symbol: bar(symbol, day)["open"] for symbol in required}
            shares, cash, trades, cost = _rebalance(shares, cash, decision["targets"], opens, FEE_BPS / 10000)
            cost_total += cost
            notional += math.fsum(trade["notional"] for trade in trades)
            events.append({"signal_date": previous, "trade_date": day, "trades": trades, "fee": cost, "cash": cash})
        holding_value = math.fsum(amount * bar(symbol, day)["close"] for symbol, amount in shares.items())
        value = cash + holding_value
        if not _positive(value) or not all(math.isfinite(number) for number in (cost_total, notional, holding_value)):
            raise PathUnavailable("nonfinite_accounting", date=day)
        peak = max(peak, value)
        drawdown = min(drawdown, (value / peak - 1) * 100)
        curve.append({"date": day, "value": value, "cash": cash, "exposure_pct": holding_value / value * 100})
    final = curve[-1]["value"]
    return {"curve": curve, "events": events, "metrics": {"initial_cash": INITIAL_CASH, "final_value": final,
                "return_pct": (final / INITIAL_CASH - 1) * 100, "max_drawdown_pct": drawdown,
                "total_fees": cost_total, "traded_notional": notional, "trade_count": sum(len(row["trades"]) for row in events)},
            "final_holdings": [{"symbol": symbol, "shares": amount, "raw_close": bar(symbol, calendar[-1])["close"],
                                "value": amount * bar(symbol, calendar[-1])["close"]} for symbol, amount in sorted(shares.items())]}


def evaluate(identifier, body):
    with store.connect() as db:
        run = agent._run(db, identifier)
        if (run["proposal_fingerprint"] != body.expected_proposal_fingerprint
                or run["input_revision"] != body.expected_input_revision or run["as_of"] != body.expected_as_of
                or not agent._currentness(run)["current"]):
            raise HTTPException(409, {"code": "workflow_path_stale", "message": "工作流來源已變更；請重新產生工作流後檢查路徑"})
        if run["status"] != "proposed":
            raise HTTPException(422, {"code": "workflow_path_not_proposed", "message": "需要可用的已保存工作流"})
        workflow = agent.WorkflowInput.model_validate(run["request"])
        as_of, revision = run["as_of"], store.input_revision(db)
        calendar = sessions.expected_sessions((date.fromisoformat(as_of) - timedelta(days=550)).isoformat(), as_of)[-(WINDOW_SESSIONS + 1):]
        result = {"engine_version": ENGINE_VERSION, "agent_engine_version": run["engine_version"],
                  "scan_engine_version": scan_provenance.SCAN_ENGINE_VERSION, "allocator_engine_version": allocator.ENGINE_VERSION,
                  "agent_run_id": identifier, "proposal_fingerprint": run["proposal_fingerprint"],
                  "as_of": as_of, "input_revision": revision, "current_at_snapshot": True, "mode": "advisory_only",
                  "status": "unavailable", "reasons": [], "candidate_symbols": workflow.candidate_symbols,
                  "rps_universe": [], "settings": {"window_sessions": WINDOW_SESSIONS, "rebalance_sessions": REBALANCE_SESSIONS,
                    "initial_cash": INITIAL_CASH, "fee_bps": FEE_BPS, "slippage_bps": 0, "workflow": run["request"],
                    "symbol_policy": (run.get("account_context") or {}).get("symbol_policy")},
                  "window": {"signal_start": calendar[0] if calendar else None, "start": calendar[1] if len(calendar) > 1 else None,
                             "end": as_of, "sessions": WINDOW_SESSIONS},
                  "coverage": {"required_decisions": 12, "evaluated_decisions": 0, "available_decisions": 0,
                               "required_path_sessions": WINDOW_SESSIONS, "valued_path_sessions": 0, "history": []},
                  "history_fingerprint": None, "settings_fingerprint": None, "evidence_fingerprint": None,
                  "decisions": [], "curve": [], "events": [], "metrics": None, "final_holdings": [],
                  "method": METHOD, "warnings": list(WARNINGS)}
        result["settings_fingerprint"] = _hash({"settings": result["settings"], "engine_version": ENGINE_VERSION,
            "proposal_fingerprint": run["proposal_fingerprint"], "scan_engine_version": scan_provenance.SCAN_ENGINE_VERSION,
            "allocator_engine_version": allocator.ENGINE_VERSION})
        _compute(db, run, workflow, calendar, result)
    if sessions.latest_completed_session() != as_of:
        raise HTTPException(409, {"code": "workflow_path_stale", "message": "計算期間交易日已變更；請重新檢查路徑"})
    result["evidence_fingerprint"] = _hash({key: value for key, value in result.items() if key != "evidence_fingerprint"})
    return result


def _compute(db, run, workflow, calendar, result):
    if len(calendar) != WINDOW_SESSIONS + 1:
        return _unavailable(result, "calendar_unavailable")
    if len(workflow.candidate_symbols) > MAX_CANDIDATES:
        return _unavailable(result, "candidate_limit", observed=len(workflow.candidate_symbols), limit=MAX_CANDIDATES)
    universe = list(workflow.candidate_symbols)
    if workflow.strategy_weights.rps > 0:
        scan = db.execute("SELECT universe FROM scans WHERE id=?", ((run.get("scan") or {}).get("id"),)).fetchone()
        if scan is None:
            return _unavailable(result, "saved_rps_universe_missing")
        peers = json.loads(scan["universe"])
        if not isinstance(peers, list) or len(peers) != len(set(peers)) or not set(universe).issubset(peers):
            return _unavailable(result, "saved_rps_universe_invalid")
        universe = sorted(peers)
        result["rps_universe"] = universe
        if len(universe) < 3:
            return _unavailable(result, "insufficient_rps_peers", observed=len(universe), required=3)
    if len(universe) > MAX_PEERS:
        return _unavailable(result, "peer_limit", observed=len(universe), limit=MAX_PEERS)
    raw = _load_history(db, universe, result["as_of"], result)
    if raw is None:
        return result
    for index in range(0, WINDOW_SESSIONS, REBALANCE_SESSIONS):
        decision = _decision(db, raw, calendar[index], calendar[index + 1], workflow, result["settings"]["symbol_policy"])
        result["decisions"].append(decision)
    result["coverage"].update(evaluated_decisions=len(result["decisions"]),
        available_decisions=sum(row["status"] != "unavailable" for row in result["decisions"]))
    if result["coverage"]["available_decisions"] != result["coverage"]["required_decisions"]:
        return _unavailable(result, "decision_evidence_incomplete")
    try:
        path = _simulate(calendar, result["decisions"], raw)
    except PathUnavailable as error:
        result["reasons"].append(error.reason)
        return result
    except (OverflowError, FloatingPointError):
        return _unavailable(result, "nonfinite_accounting")
    result.update(path, status="evaluated")
    result["coverage"]["valued_path_sessions"] = len(path["curve"])
    return result


@router.post("/api/portfolio-agent/runs/{identifier}/path-validation")
@store.snapshot_read
def validate_path(identifier: str, body: PathValidationInput):
    return JSONResponse(evaluate(identifier, body), headers={"Cache-Control": "no-store"})
