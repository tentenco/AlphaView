"""Per-symbol accounting attribution of one immutable retrospective path, not causal alpha."""
import hashlib
import json
import math

from fastapi import APIRouter, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from . import sessions, store, workflow_path_validation as path

ENGINE_VERSION = "alphaview-workflow-path-attribution-v1"
MAX_SESSIONS, MAX_SYMBOLS, MAX_RESPONSE_BYTES = 252, 100, 16 * 1024 * 1024
ABS_TOLERANCE, REL_TOLERANCE = 1e-8, 1e-10
QUANTITY_ABS_TOLERANCE, QUANTITY_REL_TOLERANCE = 1e-12, 1e-12
METHOD = (
    "Advisory accounting attribution of exactly one alphaview-workflow-path-validation-v1 path. "
    "Preserve its entire evidence unchanged and reread the same bounded original history universe in "
    "the same query-only snapshot, requiring an identical history fingerprint. Reconstruct signed share "
    "changes from saved buy/sell legs. Symbol daily PnL = prior_shares*(close_today-close_prior) + "
    "signed_share_change*(close_today-raw_open_today) - symbol_fees. Evaluate the equivalent expression "
    "ending_shares*close_today - prior_shares*close_prior - signed_share_change*raw_open_today - fees. "
    "Require prior close only for prior nonzero shares, current close only for ending nonzero shares, "
    "and raw open only for trades. A fully exited position needs no subsequent prices; an observed "
    "inactive zero needs no prices. Cash earns zero interest. Report dollar PnL and contribution "
    "percentage points = 100*PnL/original_initial_cash; these are not individual investment returns, "
    "money-weighted returns, benchmark-relative alpha or causal effects. Daily symbol totals reconcile "
    "to the saved NAV change, reconstructed cash and marked holdings; cumulative totals reconcile to "
    "final NAV minus initial cash. Currency tolerance = max(1e-8,1e-10*max(initial_cash,abs(previous_NAV), "
    "abs(current_NAV),sum(abs(accounting_terms)))). Report residual and tolerance, never a statistical "
    "pass verdict. Only a saved full sale excluded from that rebalance target set may remove share "
    "roundoff within max(1e-12,1e-12*prior_shares); expose the removed quantity. Never clamp a retained "
    "tiny target. A required-price or arithmetic gap permanently disables that symbol's cumulative "
    "series and the aggregate; other complete symbol series remain explicitly partial evidence. "
    "At most 252 sessions, 100 candidate symbols, 100 history symbols, 3000 stored bars per history "
    "symbol and 16 MiB complete response, without truncation. No reselection, optimization, ranking, "
    "benchmark, opportunity cost, proposal, account write, provider, model or broker call."
)
WARNINGS = [
    "這是同一條模擬路徑的帳務拆解，不是因果 alpha、個別標的投資報酬率、金額加權報酬或交易指示。",
    "貢獻以原始模擬資金為分母，單位是百分點；不是標的自身投入金額的報酬率，也不與基準比較。",
    "固定候選、保存設定與修訂資料的事後偏差維持；分解損益不會形成樣本外或策略有效性證明。",
    "交易費用歸屬該筆買賣標的並扣除一次；現金利息為原路徑明示的零假設。沒有股息或拆股權益補估。",
    "任何必要價格或算術缺口會使受影響標的的累計結果及組合合計持續不可用；其他標的只代表部分證據。",
]


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


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _finite(value):
    if isinstance(value, dict): return all(_finite(item) for item in value.values())
    if isinstance(value, (list, tuple)): return all(_finite(item) for item in value)
    return not isinstance(value, float) or math.isfinite(value)


def _number(value, *, positive=False):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and (value > 0 if positive else value >= 0)


def _tolerance(initial, previous, current, terms):
    return max(ABS_TOLERANCE, REL_TOLERANCE * max(initial, abs(previous), abs(current), math.fsum(abs(value) for value in terms)))


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _summary(symbol, required, reasons):
    return {"symbol": symbol, "status": "unavailable", "reasons": list(reasons), "metrics": None,
        "coverage": {"required_sessions": required, "evaluated_sessions": 0, "known_inactive_sessions": 0,
            "required_price_values": 0, "available_price_values": 0}}


def attribute(baseline, calendar, raw):
    """Pure reconstruction; tiny synthetic windows are useful for analytical oracles."""
    symbols = baseline["candidate_symbols"]
    required = baseline["window"]["sessions"]
    rows = [_summary(symbol, required, []) for symbol in symbols]
    reasons = ([{"code": "baseline_unavailable", "details": baseline["reasons"]}] if baseline["status"] != "evaluated" else [])
    if reasons:
        for row in rows: row["reasons"] = list(reasons)
        return rows, [], None, reasons
    if (not 1 <= required <= MAX_SESSIONS or not 1 <= len(symbols) <= MAX_SYMBOLS or len(set(symbols)) != len(symbols)
            or len(calendar) != required + 1 or len(baseline["curve"]) != required
            or [point["date"] for point in baseline["curve"]] != calendar[1:]):
        reasons = [{"code": "attribution_support_incomplete"}]
        for row in rows: row["reasons"] = list(reasons)
        return rows, [], None, reasons
    initial = baseline["metrics"]["initial_cash"]
    if not _number(initial, positive=True):
        raise ValueError("Invalid original initial cash")
    prices = {symbol: {bar["date"]: bar for bar in bars} for symbol, bars in (raw or {}).items()}
    events = {event["trade_date"]: event for event in baseline["events"]}
    decisions = {decision["trade_date"]: decision for decision in baseline["decisions"]}
    if len(events) != len(baseline["events"]) or any(day not in calendar[1:] for day in events):
        reasons = [{"code": "attribution_event_invalid"}]
        for row in rows: row["reasons"] = list(reasons)
        return rows, [], None, reasons
    totals = {symbol: {"gross_pnl": [], "fees": [], "net_pnl": [], "traded_notional": [], "trade_count": 0,
        "ending_shares": 0., "quantity_roundoff": []} for symbol in symbols}
    holdings = {symbol: 0. for symbol in symbols}
    failures, daily, aggregate_failed = {}, [], False
    cash, previous_nav = initial, initial
    for offset, (previous, day) in enumerate(zip(calendar, calendar[1:])):
        point, event, decision = baseline["curve"][offset], events.get(day), decisions.get(day)
        trades = event["trades"] if event else []
        indexed = {trade["symbol"]: trade for trade in trades}
        event_valid = (len(indexed) == len(trades) and set(indexed).issubset(symbols)
            and (event is None or (decision is not None and decision["status"] == "rebalance" and event["signal_date"] == previous)))
        if not event_valid:
            for symbol in symbols:
                failures.setdefault(symbol, {"code": "attribution_event_invalid", "date": day})
        target_symbols = {target["symbol"] for target in decision["targets"]} if event_valid and event else None
        contributions, cash_terms, mark_terms, accounting_terms = [], [], [], []
        for summary in rows:
            symbol = summary["symbol"]
            trade = indexed.get(symbol)
            prior = holdings[symbol]
            item = {"symbol": symbol, "status": "unavailable", "reasons": [], "known_inactive": False,
                "prior_shares": prior, "share_change": None, "ending_shares": None, "quantity_roundoff": 0.,
                "previous_raw_close": None, "current_raw_close": None, "raw_open": None, "fee": None,
                "gross_pnl": None, "net_pnl": None, "contribution_pp": None, "cumulative_pnl": None,
                "coverage": {"required_price_values": 0, "available_price_values": 0}}
            change, fee, roundoff = 0., 0., 0.
            issue = None
            if trade:
                if (trade.get("side") not in ("buy", "sell") or not _number(trade.get("shares"), positive=True)
                        or not _number(trade.get("fee")) or not _number(trade.get("notional"), positive=True)
                        or not _number(trade.get("raw_open"), positive=True)):
                    issue = {"code": "attribution_trade_invalid", "symbol": symbol, "date": day}
                else:
                    change = trade["shares"] * (1 if trade["side"] == "buy" else -1)
                    fee = trade["fee"]
            ending = prior + change if prior is not None and issue is None else None
            if ending is not None:
                quantity_tolerance = max(QUANTITY_ABS_TOLERANCE, QUANTITY_REL_TOLERANCE * prior)
                if (target_symbols is not None and symbol not in target_symbols and prior > 0 and trade
                        and trade["side"] == "sell" and abs(ending) <= quantity_tolerance):
                    roundoff, ending = ending, 0.
                if not _number(ending) or (target_symbols is not None and ((symbol in target_symbols and ending <= 0) or (symbol not in target_symbols and ending != 0))):
                    issue = {"code": "quantity_reconstruction_unavailable", "symbol": symbol, "date": day}
                    ending = None
            item.update(share_change=change if issue is None else None, ending_shares=ending,
                fee=fee if issue is None else None, quantity_roundoff=roundoff)
            holdings[symbol] = ending
            requested = [("previous_raw_close", previous, "close", prior is not None and prior > 0),
                         ("current_raw_close", day, "close", ending is not None and ending > 0),
                         ("raw_open", day, "open", trade is not None)]
            for field, date, source_field, needed in requested:
                if not needed: continue
                item["coverage"]["required_price_values"] += 1
                price = prices.get(symbol, {}).get(date, {}).get(source_field)
                if not _number(price, positive=True):
                    issue = issue or {"code": "required_price_unavailable", "symbol": symbol, "date": date, "field": source_field}
                else:
                    item[field] = price
                    item["coverage"]["available_price_values"] += 1
            if trade and item["raw_open"] is not None and issue is None:
                if item["raw_open"] != trade["raw_open"] or not math.isclose(abs(change) * item["raw_open"], trade["notional"], rel_tol=REL_TOLERANCE, abs_tol=ABS_TOLERANCE):
                    issue = {"code": "saved_trade_price_mismatch", "symbol": symbol, "date": day}
            item["known_inactive"] = prior == 0 and ending == 0 and trade is None
            for key in ("required_price_values", "available_price_values"):
                summary["coverage"][key] += item["coverage"][key]
            if item["known_inactive"]: summary["coverage"]["known_inactive_sessions"] += 1
            if prior is None or ending is None:
                issue = issue or {"code": "quantity_reconstruction_unavailable", "symbol": symbol, "date": day}
            if issue: failures.setdefault(symbol, issue)
            if symbol not in failures:
                try:
                    prior_value = prior * item["previous_raw_close"] if prior else 0.
                    ending_value = ending * item["current_raw_close"] if ending else 0.
                    execution = change * item["raw_open"] if trade else 0.
                    gross = math.fsum([ending_value, -prior_value, -execution])
                    net = gross - fee
                    cumulative = math.fsum([*totals[symbol]["net_pnl"], net])
                    cumulative_support = [math.fsum([*totals[symbol][key], value]) for key, value in
                        (("gross_pnl", gross), ("fees", fee), ("traded_notional", abs(execution)))]
                    if not _finite([prior_value, ending_value, execution, gross, net, cumulative, net / initial * 100, cumulative_support]):
                        raise ValueError("Nonfinite accounting")
                    item.update(status="evaluated", gross_pnl=gross, net_pnl=net, contribution_pp=net / initial * 100, cumulative_pnl=cumulative)
                    totals[symbol]["gross_pnl"].append(gross)
                    totals[symbol]["fees"].append(fee)
                    totals[symbol]["net_pnl"].append(net)
                    totals[symbol]["traded_notional"].append(abs(execution))
                    totals[symbol]["trade_count"] += int(trade is not None)
                    totals[symbol]["ending_shares"] = ending
                    totals[symbol]["quantity_roundoff"].append(roundoff)
                    summary["coverage"]["evaluated_sessions"] += 1
                    cash_terms.extend([-execution, -fee])
                    mark_terms.append(ending_value)
                    accounting_terms.extend([prior_value, ending_value, execution, fee])
                except (ValueError, OverflowError, ZeroDivisionError):
                    failures[symbol] = {"code": "attribution_arithmetic_unavailable", "symbol": symbol, "date": day}
            if symbol in failures:
                item["reasons"] = [failures[symbol]]
            contributions.append(item)
        day_reasons = []
        reconciliation = None
        if failures:
            aggregate_failed = True
            day_reasons = [{"code": "symbol_attribution_incomplete", "symbols": list(failures)}]
        if not aggregate_failed:
            try:
                net = math.fsum(item["net_pnl"] for item in contributions)
                expected_change = point["value"] - previous_nav
                reconstructed_cash = math.fsum([cash, *cash_terms])
                marked_nav = math.fsum([reconstructed_cash, *mark_terms])
                tolerance = _tolerance(initial, previous_nav, point["value"], accounting_terms)
                reconciliation = {"symbol_pnl": net, "nav_change": expected_change, "pnl_residual": net - expected_change,
                    "reconstructed_cash": reconstructed_cash, "saved_cash": point["cash"], "cash_residual": reconstructed_cash - point["cash"],
                    "marked_nav": marked_nav, "saved_nav": point["value"], "nav_residual": marked_nav - point["value"], "tolerance": tolerance}
                if not _finite(reconciliation):
                    raise ValueError("Nonfinite reconciliation")
                if any(abs(reconciliation[key]) > tolerance for key in ("pnl_residual", "cash_residual", "nav_residual")):
                    aggregate_failed = True
                    day_reasons = [{"code": "daily_accounting_mismatch", "date": day}]
                cash = reconstructed_cash
            except (ValueError, OverflowError, ZeroDivisionError):
                aggregate_failed = True
                reconciliation = None
                day_reasons = [{"code": "attribution_arithmetic_unavailable", "date": day}]
        if aggregate_failed and not day_reasons:
            day_reasons = [{"code": "prior_aggregate_gap"}]
        if day_reasons: reasons.extend(reason for reason in day_reasons if reason not in reasons)
        daily.append({"date": day, "previous_date": previous, "status": "unavailable" if aggregate_failed else "evaluated",
            "reasons": day_reasons, "contributions": contributions, "reconciliation": reconciliation})
        previous_nav = point["value"]
    for summary in rows:
        symbol = summary["symbol"]
        if symbol in failures:
            summary["reasons"] = [failures[symbol]]
            continue
        values = totals[symbol]
        net = math.fsum(values["net_pnl"])
        summary.update(status="evaluated", metrics={"gross_pnl": math.fsum(values["gross_pnl"]), "fees": math.fsum(values["fees"]),
            "net_pnl": net, "contribution_pp": net / initial * 100, "traded_notional": math.fsum(values["traded_notional"]),
            "trade_count": values["trade_count"], "ending_shares": values["ending_shares"], "quantity_roundoff": math.fsum(values["quantity_roundoff"])})
    aggregate = None
    if not aggregate_failed:
        net = math.fsum(row["metrics"]["net_pnl"] for row in rows)
        change = baseline["metrics"]["final_value"] - initial
        tolerance = _tolerance(initial, initial, baseline["metrics"]["final_value"], [row["metrics"]["net_pnl"] for row in rows])
        fees = math.fsum(row["metrics"]["fees"] for row in rows)
        aggregate = {"initial_cash": initial, "symbol_pnl": net, "path_nav_change": change, "pnl_residual": net - change,
            "contribution_pp": net / initial * 100, "path_return_pct": baseline["metrics"]["return_pct"],
            "return_residual_pp": net / initial * 100 - baseline["metrics"]["return_pct"],
            "return_tolerance_pp": tolerance / initial * 100,
            "total_fees": fees, "fees_residual": fees - baseline["metrics"]["total_fees"], "cash_interest_pnl": 0., "tolerance": tolerance}
        if (not _finite(aggregate) or abs(aggregate["pnl_residual"]) > tolerance or abs(aggregate["fees_residual"]) > tolerance
                or abs(aggregate["return_residual_pp"]) > aggregate["return_tolerance_pp"]):
            aggregate = None
            reasons.append({"code": "aggregate_accounting_mismatch"})
    return rows, daily, aggregate, reasons


def evaluate(identifier, body):
    baseline = path.evaluate(identifier, body)
    if not _finite(baseline):
        raise _problem("path_attribution_nonfinite_source", "原路徑包含非有限值，不能形成歸屬證據", 422)
    calendar, raw, loaded = [], None, {"coverage": {}, "reasons": []}
    if baseline["status"] == "evaluated":
        symbols = baseline["rps_universe"] or baseline["candidate_symbols"]
        if len(symbols) > MAX_SYMBOLS or len(baseline["candidate_symbols"]) > MAX_SYMBOLS:
            raise _problem("path_attribution_symbol_limit", "歸屬標的超過上限", 422)
        calendar = sessions.expected_sessions(baseline["window"]["signal_start"], baseline["as_of"])
        with store.connect() as db:
            raw = path._load_history(db, symbols, baseline["as_of"], loaded)
        if raw is None or loaded["history_fingerprint"] != baseline["history_fingerprint"]:
            raise _problem("path_attribution_history_changed", "歸屬歷史與原路徑指紋不符；請重新檢查工作流")
    rows, daily, aggregate, reasons = attribute(baseline, calendar, raw)
    if sessions.latest_completed_session() != baseline["as_of"]:
        raise _problem("path_attribution_session_changed", "歸屬計算期間交易日已變更；請重新檢查工作流")
    result = {"engine_version": ENGINE_VERSION, "path_engine_version": baseline["engine_version"],
        "agent_run_id": identifier, "proposal_fingerprint": baseline["proposal_fingerprint"], "input_revision": baseline["input_revision"],
        "as_of": baseline["as_of"], "current_at_snapshot": True, "mode": "advisory_only", "request": body.model_dump(),
        "baseline": baseline, "baseline_evidence_fingerprint": baseline["evidence_fingerprint"], "history_fingerprint": baseline["history_fingerprint"],
        "reread_history_fingerprint": loaded.get("history_fingerprint"), "history_coverage": loaded["coverage"].get("history", []),
        "status": "evaluated" if aggregate is not None else "unavailable", "reasons": reasons, "symbols": rows, "daily": daily,
        "aggregate": aggregate, "coverage": {"required_symbols": len(rows), "available_symbols": sum(row["status"] == "evaluated" for row in rows),
            "required_sessions": baseline["window"]["sessions"], "available_daily_reconciliations": sum(day["status"] == "evaluated" for day in daily),
            "required_price_values": sum(row["coverage"]["required_price_values"] for row in rows),
            "available_price_values": sum(row["coverage"]["available_price_values"] for row in rows), "path_evaluations": 1},
        "tolerance": {"currency_absolute": ABS_TOLERANCE, "currency_relative": REL_TOLERANCE,
            "quantity_absolute": QUANTITY_ABS_TOLERANCE, "quantity_relative": QUANTITY_REL_TOLERANCE}, "method": METHOD, "warnings": list(WARNINGS)}
    result["evidence_fingerprint"] = _hash(result)
    if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode()) > MAX_RESPONSE_BYTES:
        raise _problem("path_attribution_size_limit", "完整歸屬證據超過大小上限；不截斷資料", 422)
    return result


@router.post("/api/portfolio-agent/runs/{identifier}/path-attribution")
@store.snapshot_read
def inspect_attribution(identifier: str, body: path.PathValidationInput):
    return JSONResponse(evaluate(identifier, body), headers={"Cache-Control": "no-store"})
