"""Reduce-only clamp for automation attempts on a paused paper account (alphaview-reduce-only-v1).

When the circuit-breaker policy allows reduce-only exits and the account's kill switch is on, an automation
attempt may still run, but its targets are clamped: every symbol's target becomes min(target, current held weight),
unheld symbols are dropped, nothing can grow. A clamp that changes nothing is a skipped attempt, never a proposal.
The evidence is re-derived at proposal binding so a bound proposal can only carry the clamped targets.
"""
from decimal import ROUND_DOWN, localcontext

from fastapi import HTTPException

from . import paper_portfolio as paper
from . import store

ENGINE_VERSION = "alphaview-reduce-only-v1"
WEIGHT_STEP = paper._decimal("0.00000001")


def current_weights(db, account, as_of):
    """Exact current weight (% of equity) per held symbol; None when a price is missing or equity is not positive."""
    full = paper._account(db, account["id"])  # the automation view carries no cash
    held = paper._holdings(db, account["id"])
    quotes = {row["symbol"]: paper._quote(db, row["symbol"], as_of) for row in held}
    if any(quote["price"] is None for quote in quotes.values()):
        return None
    with localcontext() as context:
        context.prec = 50
        values = {row["symbol"]: paper._decimal(row["shares"]) * paper._decimal(quotes[row["symbol"]]["price"]) for row in held}
        equity = paper._decimal(full["cash"]) + sum(values.values(), paper.ZERO)
        if equity <= 0:
            return None
        return {symbol: value / equity * paper.HUNDRED for symbol, value in values.items()}


def clamp(targets, current):
    """Targets ≤ current weights (rounded down to 8 dp), no new symbols; `changed` means some holding shrinks."""
    with localcontext() as context:
        context.prec = 50
        wanted = {row["symbol"]: paper._decimal(row["weight_pct"]) for row in targets}
        after, dropped, changed = [], [], False
        for symbol in sorted(wanted):
            if symbol not in current:
                dropped.append(symbol)
        for symbol in sorted(current):
            limit = current[symbol]
            weight = wanted.get(symbol, paper.ZERO)
            if weight < limit:
                changed = True
            reduced = min(weight, limit)
            after.append({"symbol": symbol, "weight_pct": float(reduced.quantize(WEIGHT_STEP, rounding=ROUND_DOWN))})
        after = [row for row in after if row["weight_pct"] > 0 or wanted.get(row["symbol"]) is not None]
        return {"targets_after": after, "dropped_symbols": dropped, "changed": changed}


def plan(db, account, targets, as_of, reason):
    """Evidence for an attempt: original targets, exact current weights and the clamped targets."""
    current = current_weights(db, account, as_of)
    if current is None:
        return None
    result = clamp(targets, current)
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
            "reason": reason, "account_version": account["version"],
            "current_weights": {symbol: str(value) for symbol, value in current.items()},
            "targets_before": [{"symbol": row["symbol"], "weight_pct": row["weight_pct"]} for row in targets],
            "gated_targets": None, "targets_after": result["targets_after"], "dropped_symbols": result["dropped_symbols"],
            "status": "reduced" if result["changed"] else "no_change"}


def finalize(evidence, gated_targets):
    """Clamp the gated (Jev / overlay) targets with the recorded current weights; evidence to store before binding."""
    current = {symbol: paper._decimal(value) for symbol, value in evidence["current_weights"].items()}
    result = clamp(gated_targets, current)
    return {**evidence, "gated_targets": [{"symbol": row["symbol"], "weight_pct": row["weight_pct"]} for row in gated_targets],
            "targets_after": result["targets_after"], "dropped_symbols": result["dropped_symbols"],
            "status": "reduced" if result["changed"] else "no_change"}


def verify_evidence(db, account, evidence, gated_targets, session_date, input_revision):
    """Re-derive the clamp from the live account; a bound proposal may only carry `targets_after`."""
    from . import circuit_breakers
    if not circuit_breakers.reduce_only_allowed(db, account["id"]):
        raise HTTPException(409, "純減倉例外已關閉；暫停中的自動化提案已失效")
    if (not isinstance(evidence, dict) or evidence.get("engine_version") != ENGINE_VERSION
            or evidence.get("as_of") != session_date or evidence.get("input_revision") != input_revision
            or evidence.get("account_version") != account["version"] or evidence.get("gated_targets") != gated_targets):
        raise HTTPException(409, "自動化的純減倉證據與嘗試紀錄或閘後目標不符")
    current = current_weights(db, account, session_date)
    if current is None or {symbol: str(value) for symbol, value in current.items()} != evidence.get("current_weights"):
        raise HTTPException(409, "虛擬帳戶持倉或估值已變更，純減倉目標需重新計算")
    expected = clamp(gated_targets, current)
    if evidence.get("status") != "reduced" or expected["targets_after"] != evidence.get("targets_after"):
        raise HTTPException(409, "自動化的純減倉目標與重新計算不符")
    return expected["targets_after"]


def note(evidence):
    return (f"；純減倉模式 {ENGINE_VERSION}（{evidence['reason']}）：目標不得高於目前權重，"
            f"{len(evidence['dropped_symbols'])} 個新標的已略去")
