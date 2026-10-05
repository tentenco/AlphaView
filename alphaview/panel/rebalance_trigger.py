"""Versioned, read-only gates for the local paper automation cadence.

The caller owns one read snapshot covering rules, preflight and this evidence.
No displayed account weights are fed back into the threshold comparison.
"""
import json
from decimal import Decimal, localcontext

import pandas as pd
from pydantic import Field

from . import paper_portfolio as paper
from . import sessions, store

ENGINE_VERSION = "alphaview-rebalance-trigger-v1"
METHOD = (
    "完整目標包含現有與目標標的，未列持倉目標為零，剩餘權重為現金；"
    "以當期有效 USD 未調整收盤與 Decimal 股數／現金計算最大絕對偏離百分點，"
    "以未除法的分子交叉比較門檻，等於門檻即通過。exact 字串為 50 位有效數字"
    "的 Decimal 顯示值，分子／分母保留精確比較依據。缺值不補價或重分配。"
    "間隔以同任務、目前綁定帳戶的非零 paper 成交為準，跨任務版本保留，"
    "次日開盤模擬採 execution session；只計其後至本日的已完成 XNYS 交易日。"
    "超出所需間隔視窗僅記錄至少已達門檻，不推測精確日數。啟用的門檻全部須同時通過。"
    "市場風險變動門檻比較本日 regime band 與此任務上一筆嘗試記錄的 band；首次只記錄基準，"
    "分數不完整時等待而不略過、不觸發。"
    "這是本機模擬的頻率規則，不是報酬優化、預測或實盤指示。"
)


class RegimeChange(paper.StrictInput):
    """Fire only when the market-regime band moved at least `min_band_change` steps since the last recorded band."""
    enabled: bool = Field(default=False, strict=True)
    min_band_change: int = Field(default=1, ge=1, le=3, strict=True)


class Policy(paper.StrictInput):
    # Both keys are required on an explicitly supplied nested policy. Null is
    # an intentional disabled setting, not an omitted PATCH field. The regime
    # gate is optional and defaults to off so stored two-key policies still load.
    min_weight_drift_pp: float | None = Field(ge=0, le=100, strict=True)
    min_completed_sessions_between_fills: int | None = Field(ge=1, le=252, strict=True)
    regime_change: RegimeChange = Field(default_factory=RegimeChange)


def disabled_policy():
    return Policy(min_weight_drift_pp=None, min_completed_sessions_between_fills=None)


def normalize(stored_json):
    """Stored policy JSON (possibly pre-regime two-key) as the current full policy dict."""
    return Policy.model_validate_json(stored_json).model_dump()


def enabled(policy):
    return (any(policy.get(key) is not None for key in ("min_weight_drift_pp", "min_completed_sessions_between_fills"))
            or bool((policy.get("regime_change") or {}).get("enabled")))


REGIME_WAITING = "regime_unavailable"


def regime_check(db, mandate, as_of, setting):
    """Band on `as_of` versus the band recorded by this mandate's previous attempt; never fails open."""
    base = {"enabled": bool(setting["enabled"]), "min_band_change": setting["min_band_change"], "status": "disabled",
            "band": None, "score": None, "previous_band": None, "previous_session": None, "band_steps": None,
            "regime_version": None, "reason": None}
    if not setting["enabled"]:
        return base
    from . import regime_overlay
    bands = list(regime_overlay.EXPOSURE_CAPS)
    settings, _ = regime_overlay.current_policy(db, mandate["account_id"])
    evaluation = regime_overlay.regime_evaluation(settings["regime"], as_of)
    base.update(regime_version=evaluation.get("regime_version"), score=evaluation.get("score"), band=evaluation.get("zone"))
    previous = db.execute("""SELECT session_date,result_json FROM agent_automation_attempts
        WHERE mandate_id=? AND session_date<? ORDER BY session_date DESC LIMIT 1""", (mandate["id"], as_of)).fetchone()
    if previous and previous["result_json"]:
        recorded = ((json.loads(previous["result_json"]).get("rebalance_trigger") or {}).get("regime_change") or {})
        if recorded.get("band") in bands:
            base.update(previous_band=recorded["band"], previous_session=previous["session_date"])
    if base["score"] is None or base["band"] not in bands:
        missing = "、".join(evaluation.get("missing") or []) or "分數"
        return {**base, "status": "unavailable", "reason": f"市場風險溫度計不完整（缺 {missing}）"}
    if base["previous_band"] is None:
        return {**base, "status": "baseline", "reason": "首次記錄市場風險 band，作為後續變動基準"}
    steps = abs(bands.index(base["band"]) - bands.index(base["previous_band"]))
    fired = steps >= setting["min_band_change"]
    return {**base, "band_steps": steps, "status": "fired" if fired else "unchanged",
            "reason": None if fired else f"市場風險 band 未變動（{base['previous_band']}→{base['band']}，{steps} 階）"}


def _has_fill(db, account_id, proposal_id):
    return any(paper._decimal(row[0]) != 0 for row in db.execute(
        "SELECT shares_delta FROM paper_ledger WHERE account_id=? AND proposal_id=? AND kind='simulated_fill'",
        (account_id, proposal_id)))


def latest_fill(db, mandate_id, account_id):
    """Use durable proposal/ledger lineage, independent of attempt recovery.

    The source proposal of a next-open order is never accepted. Its execution
    proposal has a separate request, so follow the queue's frozen source.
    """
    candidates = []
    for row in db.execute("""SELECT id,preview_json,request_json,accepted_at FROM paper_proposals
            WHERE account_id=? AND status='simulated'""", (account_id,)):
        request = json.loads(row["request_json"])
        source = request.get("automation_source") or {}
        if source.get("mandate_id") != mandate_id or not _has_fill(db, account_id, row["id"]):
            continue
        preview = json.loads(row["preview_json"])
        candidates.append({"proposal_id": row["id"], "execution_session": preview["as_of"],
                           "recorded_at": row["accepted_at"]})
    for row in db.execute("""SELECT q.id,q.execution_session,q.execution_proposal_id,q.frozen_json,p.accepted_at
            FROM paper_next_open_orders q JOIN paper_proposals p ON p.id=q.execution_proposal_id
            WHERE q.account_id=? AND p.account_id=? AND q.status='filled' AND p.status='simulated'""",
                          (account_id, account_id)):
        frozen = json.loads(row["frozen_json"])
        source = (frozen.get("source_request") or {}).get("automation_source") or {}
        if source.get("mandate_id") != mandate_id or not _has_fill(db, account_id, row["execution_proposal_id"]):
            continue
        candidates.append({"proposal_id": row["execution_proposal_id"], "queue_order_id": row["id"],
                           "execution_session": row["execution_session"], "recorded_at": row["accepted_at"]})
    return max(candidates, key=lambda row: (row["execution_session"], row["recorded_at"] or "", row["proposal_id"])) if candidates else None


def elapsed_sessions(last_fill, as_of, required):
    """Bound all calendar access to the configured <=252-session horizon."""
    if last_fill is None:
        return {"completed_sessions_since_last_fill": None, "completed_sessions_lower_bound": None,
                "elapsed_sessions_exact": True, "passed": True, "waiting": False}
    last = last_fill["execution_session"]
    if last > as_of:
        return {"completed_sessions_since_last_fill": None, "completed_sessions_lower_bound": None,
                "elapsed_sessions_exact": False, "passed": None, "waiting": True}
    cal = sessions.calendar(pd.Timestamp(as_of).year)
    window = [value.date().isoformat() for value in cal.sessions_window(pd.Timestamp(as_of), -required)]
    if last < window[0]:
        return {"completed_sessions_since_last_fill": None, "completed_sessions_lower_bound": required,
                "elapsed_sessions_exact": False, "passed": True, "waiting": False}
    count = sum(last < day <= as_of for day in window)
    return {"completed_sessions_since_last_fill": count, "completed_sessions_lower_bound": None,
            "elapsed_sessions_exact": True, "passed": count >= required, "waiting": False}


def evaluate(db, mandate, run, preflight, as_of):
    """Return frozen evidence; waiting outcomes must never claim the session."""
    policy = normalize(mandate["rebalance_trigger_json"])
    account = paper._account(db, mandate["account_id"])
    evidence = {
        "engine_version": ENGINE_VERSION, "policy": policy, "outcome": "disabled", "reason_codes": [],
        "regime_change": regime_check(db, mandate, as_of, policy["regime_change"]) if enabled(policy) else None,
        "as_of": as_of, "input_revision": store.input_revision(db),
        "account_id": account["id"], "account_version": account["version"],
        "coverage": {"required": 0, "priced": 0, "missing": []}, "valuation_complete": None,
        "max_weight_drift_pp": None, "max_weight_drift_pp_exact": None,
        "max_drift_numerator_exact": None, "equity_denominator_exact": None,
        "components": [], "quote_details": [], "last_fill": None,
        "completed_sessions_since_last_fill": None, "completed_sessions_lower_bound": None,
        "elapsed_sessions_exact": True, "checks": [],
        "source_run_fingerprint": run["proposal_fingerprint"], "method": METHOD,
    }
    if not enabled(policy):
        return evidence
    if run["status"] != "proposed":
        return {**evidence, "outcome": "blocked", "reason_codes": ["agent_blocked"]}
    regime = evidence["regime_change"]
    if regime["status"] == "unavailable":
        # No band means no decision: wait for readings instead of firing or skipping on nothing.
        return {**evidence, "outcome": "waiting", "reason_codes": [REGIME_WAITING]}
    with localcontext() as context:
        context.prec = 50
        held = {row["symbol"]: row for row in paper._holdings(db, account["id"])}
        targets = {row["symbol"]: paper._decimal(row["weight_pct"]) for row in run["target_weights"]}
        required = sorted(set(held) | set(targets))
        quotes = {symbol: paper._quote(db, symbol, as_of) for symbol in required}
        missing = [symbol for symbol in required if quotes[symbol]["price"] is None]
        evidence.update(coverage={"required": len(required), "priced": len(required) - len(missing), "missing": missing},
                        quote_details=[{"symbol": symbol, **quote} for symbol, quote in quotes.items()],
                        valuation_complete=not missing)
        if missing:
            return {**evidence, "outcome": "waiting", "reason_codes": ["quote_unavailable"]}
        values = {symbol: paper._decimal(held[symbol]["shares"]) * paper._decimal(quotes[symbol]["price"])
                  if symbol in held else paper.ZERO for symbol in required}
        cash = paper._decimal(account["cash"])
        equity = cash + sum(values.values(), paper.ZERO)
        if equity <= 0:
            return {**evidence, "outcome": "waiting", "reason_codes": ["nonpositive_equity"]}
        components = [("symbol", symbol, values[symbol], targets.get(symbol, paper.ZERO)) for symbol in required]
        components.append(("cash", None, cash, paper.HUNDRED - sum(targets.values(), paper.ZERO)))
        numerators = []
        for kind, symbol, value, target in components:
            numerator = abs(paper.HUNDRED * value - target * equity)
            numerators.append(numerator)
            difference = numerator / equity
            evidence["components"].append({"kind": kind, "symbol": symbol,
                "current_weight_pct": float(paper.HUNDRED * value / equity), "target_weight_pct": float(target),
                "difference_pp": float(difference), "difference_pp_exact": str(difference),
                "difference_numerator_exact": str(numerator)})
        maximum = max(numerators)
        evidence.update(max_weight_drift_pp=float(maximum / equity), max_weight_drift_pp_exact=str(maximum / equity),
                        max_drift_numerator_exact=str(maximum), equity_denominator_exact=str(equity))
        drift = policy["min_weight_drift_pp"]
        drift_passed = None if drift is None else maximum >= paper._decimal(drift) * equity
        evidence["checks"].append({"code": "min_weight_drift_pp", "enabled": drift is not None,
                                   "passed": drift_passed, "actual": evidence["max_weight_drift_pp"], "required": drift})
    evidence["last_fill"] = latest_fill(db, mandate["id"], account["id"])
    cooldown = policy["min_completed_sessions_between_fills"]
    # Even drift-only policies must not use a valuation before a persisted
    # effective fill session. Normal next-open writes only occur after close.
    if evidence["last_fill"] and evidence["last_fill"]["execution_session"] > as_of:
        return {**evidence, "outcome": "waiting", "reason_codes": ["fill_session_incomplete"]}
    elapsed = elapsed_sessions(evidence["last_fill"], as_of, cooldown) if cooldown is not None else None
    if elapsed:
        evidence.update({key: value for key, value in elapsed.items() if key not in ("passed", "waiting")})
    evidence["checks"].append({"code": "min_completed_sessions_between_fills", "enabled": cooldown is not None,
        "passed": elapsed["passed"] if elapsed else None,
        "actual": evidence["completed_sessions_since_last_fill"] if evidence["elapsed_sessions_exact"] else evidence["completed_sessions_lower_bound"],
        "required": cooldown})
    if regime["enabled"]:
        evidence["checks"].append({"code": "regime_change", "enabled": True, "passed": regime["status"] == "fired",
                                   "actual": regime["band_steps"], "required": regime["min_band_change"]})
    if not preflight["executable"]:
        return {**evidence, "outcome": "blocked", "reason_codes": ["paper_risk_blocked"], "violations": preflight["violations"]}
    reasons = []
    if not preflight["orders"]:
        reasons.append("no_change")
        evidence["skipped_orders"] = preflight["skipped_orders"]
    if drift_passed is False:
        reasons.append("drift_below_threshold")
    if elapsed and elapsed["passed"] is False:
        reasons.append("cooldown_active")
    if regime["status"] == "baseline":
        reasons.append("regime_baseline_recorded")
    elif regime["status"] == "unchanged":
        reasons.append("regime_unchanged")
    return {**evidence, "outcome": "skip" if reasons else "pass", "reason_codes": reasons}
