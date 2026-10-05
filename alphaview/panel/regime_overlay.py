"""Market-regime exposure overlay for paper accounts.

Maps the alphaview-regime-v1 composite (stored manual macro readings plus the
local benchmark bars) to a cap on the account's total invested weight. `block`
turns a proposal that would leave the account above the cap into a paper
violation; `scale` shrinks the rules Agent's targets proportionally before the
proposal exists. An incomplete regime never yields a cap: block fails closed,
scale is skipped and says so. The policy lives inside the circuit-breaker
policy JSON (no schema change) with its own version counter.
"""
import json
from decimal import Decimal, ROUND_DOWN, localcontext
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field, ValidationError, model_validator

from . import market_regime
from . import paper_portfolio as paper
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-regime-overlay-v1"
HUNDRED = Decimal(100)
WEIGHT_STEP = Decimal("0.00000001")
# Regime band -> maximum invested weight (% of equity). The table is part of
# this method version; a different mapping is a new version, not an edit.
EXPOSURE_CAPS = {"calm": Decimal(100), "watch": Decimal(80), "elevated": Decimal(60), "extreme": Decimal(40)}
METHOD = (
    "The account stores its own alphaview-regime-v1 settings (benchmark, factor weights, manual macro readings with "
    "their dates). On the latest completed session the composite is recomputed from those readings and the local "
    "benchmark bars, and its band maps to a cap on total invested weight: calm 100, watch 80, elevated 60, extreme 40 "
    "percent. block: a paper proposal whose target invested weight exceeds the cap is a violation "
    "(regime_exposure_cap) unless it lowers exposure below the account's current priced invested weight; an incomplete "
    "regime is the violation regime_unavailable. scale: before an automation or run-bridge proposal is built, targets "
    "above the cap are multiplied by cap / invested and rounded down to eight decimals, with the evidence stored on the "
    "attempt; an incomplete regime leaves the targets unscaled and is recorded as regime_overlay_unavailable. No cap "
    "is ever assumed from a missing factor, stale manual readings keep their regime-v1 semantics, and nothing here "
    "sells anything by itself."
)
WARNINGS = [
    "上限只作用於紙上提案與自動化目標；沒有實盤、沒有自動賣出，也不會把持倉自動減到上限以下。",
    "總經讀數是使用者手動輸入的日期值，過期會標示 stale 但仍參與計算；缺任何啟用因子就沒有上限，block 模式擋下、scale 模式不縮放。",
    "band→cap 表是 v1 的固定假設，不是預測；換表就是新版本。",
]


class ManualReading(paper.StrictInput):
    value: float
    as_of: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ManualInputs(paper.StrictInput):
    buffett_ratio: ManualReading | None = None
    shiller_pe: ManualReading | None = None
    yield_10y: ManualReading | None = None
    yield_2y: ManualReading | None = None
    fear_greed: ManualReading | None = None


class RegimeSettings(paper.StrictInput):
    benchmark: Literal["VOO", "SPY", "QQQ"] = "VOO"
    weights: market_regime.Weights = Field(default_factory=market_regime.Weights)
    inputs: ManualInputs = Field(default_factory=ManualInputs)

    @model_validator(mode="after")
    def regime_rules(self):
        # Ranges, future dates and the positive weight total are regime v1's own rules.
        try:
            market_regime.RegimeInput.model_validate(self.model_dump())
        except ValidationError as exc:
            raise ValueError("市場風險設定不合法：" + exc.errors()[0]["msg"]) from exc
        return self


class Policy(paper.StrictInput):
    enabled: bool = False
    mode: Literal["block", "scale"] = "block"
    regime: RegimeSettings = Field(default_factory=RegimeSettings)


class PolicyInput(paper.StrictInput):
    policy: Policy
    expected_version: int = Field(ge=0)


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _breaker_row(db, account_id):
    return db.execute("SELECT policy_json,version FROM paper_circuit_breakers WHERE account_id=?", (account_id,)).fetchone()


def current_policy(db, account_id):
    """Overlay policy and its own version (0 = never saved), read from the circuit-breaker policy JSON."""
    row = _breaker_row(db, account_id)
    stored = (json.loads(row["policy_json"]) if row else {}).get("regime_overlay")
    if not stored:
        return Policy().model_dump(), 0
    return Policy.model_validate({key: value for key, value in stored.items() if key != "version"}).model_dump(), stored.get("version", 0)


def _write_policy(db, account_id, policy, version, previous):
    from . import circuit_breakers as breakers
    row = _breaker_row(db, account_id)
    data = json.loads(row["policy_json"]) if row else breakers.Policy().model_dump()
    data["regime_overlay"] = {**policy, "version": version}
    db.execute("""INSERT INTO paper_circuit_breakers(account_id,policy_json,version,updated_at) VALUES (?,?,1,?)
        ON CONFLICT(account_id) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at""",
               (account_id, breakers._json(data), store.now()))
    breakers._event(db, account_id, "policy_changed", evidence={"regime_overlay": {"previous": previous, "policy": policy, "version": version}})


def regime_evaluation(settings, as_of):
    """alphaview-regime-v1 composite from stored manual readings and the local benchmark bars."""
    request = market_regime.RegimeInput.model_validate(settings)
    weights = request.weights.model_dump()
    readings = market_regime.manual_readings(request.inputs)
    readings["technical"] = (market_regime.benchmark_reading(request.benchmark, as_of) if weights["technical"] > 0
                             else {"available": False, "reason": "disabled"})
    result = market_regime.evaluate(weights, readings, as_of)
    return {"regime_version": market_regime.ENGINE_VERSION, "regime_as_of": as_of, "benchmark": request.benchmark, **result}


def exposure_cap(evaluation):
    """Pure mapping from a regime evaluation to a cap; no score means no cap."""
    score, band = evaluation.get("score"), evaluation.get("zone")
    base = {"engine_version": ENGINE_VERSION, "regime_version": evaluation.get("regime_version"),
            "regime_as_of": evaluation.get("regime_as_of"), "score": score, "band": band,
            "missing": list(evaluation.get("missing") or []), "stale_inputs": list(evaluation.get("stale_inputs") or [])}
    if score is None or band not in EXPOSURE_CAPS:
        return {**base, "cap_pct": None, "status": "unavailable", "reason": "regime_incomplete"}
    return {**base, "cap_pct": float(EXPOSURE_CAPS[band]), "status": "ok", "reason": None}


def scale_targets(targets, cap):
    """Proportional shrink to the cap, rounded down; unchanged when already within it."""
    with localcontext() as context:
        context.prec = 50
        invested = sum((paper._decimal(row["weight_pct"]) for row in targets), paper.ZERO)
        if invested <= cap:
            return [{"symbol": row["symbol"], "weight_pct": row["weight_pct"]} for row in targets]
        factor = cap / invested
        return [{"symbol": row["symbol"],
                 "weight_pct": float((paper._decimal(row["weight_pct"]) * factor).quantize(WEIGHT_STEP, rounding=ROUND_DOWN))}
                for row in targets]


def _invested_weight(cash, held, quotes):
    """Current invested weight (% of equity) from priced holdings; None when any price is missing."""
    with localcontext() as context:
        context.prec = 50
        invested = paper.ZERO
        for symbol, row in held.items():
            quote = quotes.get(symbol) or {}
            if quote.get("price") is None:
                return None
            invested += paper._decimal(row["shares"]) * paper._decimal(quote["price"])
        equity = paper._decimal(cash) + invested
        return invested / equity * HUNDRED if equity > 0 else None


def preview_violations(db, account, targets, held, quotes, as_of):
    """Paper-preview hook for block mode; targets are Decimal weights by symbol."""
    policy, _ = current_policy(db, account["id"])
    if not policy["enabled"] or policy["mode"] != "block":
        return []
    cap = exposure_cap(regime_evaluation(policy["regime"], as_of))
    if cap["status"] != "ok":
        missing = "、".join(cap["missing"]) or "分數"
        return [{"code": "regime_unavailable", "message": f"市場風險溫度計不完整（缺 {missing}），block 模式下不建立提案"}]
    invested = sum(targets.values(), paper.ZERO)
    limit = paper._decimal(cap["cap_pct"])
    if invested <= limit:
        return []
    current = _invested_weight(account["cash"], held, quotes)
    if current is not None and invested < current:
        return []
    return [{"code": "regime_exposure_cap",
             "message": (f"目標總曝險 {float(invested):.2f}% 超過市場風險上限 {float(limit):.0f}%（{cap['band']}，分數 {cap['score']}）"
                         + (f"；減碼提案須低於目前曝險 {float(current):.2f}%" if current is not None else ""))}]


def apply_scale(db, account_id, targets, as_of):
    """Scale-mode evidence for a target list; `targets_after` is always usable, scaled or not."""
    policy, version = current_policy(db, account_id)
    copy = [{"symbol": row["symbol"], "weight_pct": row["weight_pct"]} for row in targets]
    evidence = {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
                "policy_version": version, "mode": policy["mode"], "status": "disabled", "applied": False,
                "cap": None, "targets_before": copy, "targets_after": copy, "invested_before_pct": None,
                "invested_after_pct": None, "warnings": []}
    if not policy["enabled"] or policy["mode"] != "scale":
        return evidence
    cap = exposure_cap(regime_evaluation(policy["regime"], as_of))
    evidence["cap"] = cap
    if cap["status"] != "ok":
        return {**evidence, "status": "unavailable", "warnings": ["regime_overlay_unavailable"]}
    scaled = scale_targets(copy, paper._decimal(cap["cap_pct"]))
    before = float(sum((paper._decimal(row["weight_pct"]) for row in copy), paper.ZERO))
    after = float(sum((paper._decimal(row["weight_pct"]) for row in scaled), paper.ZERO))
    applied = scaled != copy
    return {**evidence, "status": "scaled" if applied else "within_cap", "applied": applied, "targets_after": scaled,
            "invested_before_pct": before, "invested_after_pct": after}


def note(evidence):
    """Short 繁中 suffix for attempt reasons and proposal rationales."""
    if evidence["status"] == "unavailable":
        return "；市場風險覆蓋不可用（regime_overlay_unavailable），目標未縮放"
    if evidence["status"] == "scaled":
        cap = evidence["cap"]
        return (f"；市場風險覆蓋 {ENGINE_VERSION}：總曝險 {evidence['invested_before_pct']:.2f}%→"
                f"{evidence['invested_after_pct']:.2f}%（{cap['band']}，上限 {cap['cap_pct']:.0f}%）")
    return ""


def verify_evidence(evidence, validated, session_date, input_revision):
    """Re-derive scaled targets from the stored cap; returns the targets a bound proposal must carry."""
    if (not isinstance(evidence, dict) or evidence.get("engine_version") != ENGINE_VERSION
            or evidence.get("as_of") != session_date or evidence.get("input_revision") != input_revision
            or evidence.get("targets_before") != validated):
        raise HTTPException(409, "自動化的市場風險覆蓋證據與嘗試紀錄或規則目標不符")
    if evidence.get("status") != "scaled":
        return validated
    cap = evidence.get("cap") or {}
    if cap.get("status") != "ok" or cap.get("band") not in EXPOSURE_CAPS or cap.get("cap_pct") != float(EXPOSURE_CAPS[cap["band"]]):
        raise HTTPException(409, "自動化的市場風險覆蓋上限與方法版本不符")
    expected = scale_targets(validated, paper._decimal(cap["cap_pct"]))
    if evidence.get("targets_after") != expected:
        raise HTTPException(409, "自動化的市場風險覆蓋縮放結果與重新計算不符")
    return expected


def evaluate(db, account_id, as_of):
    account = paper._account(db, account_id)
    policy, version = current_policy(db, account_id)
    regime = regime_evaluation(policy["regime"], as_of)
    cap = exposure_cap(regime)
    held = {row["symbol"]: row for row in paper._holdings(db, account_id)}
    quotes = {symbol: paper._quote(db, symbol, as_of) for symbol in held}
    exposure = _invested_weight(account["cash"], held, quotes)
    if cap["status"] != "ok":
        exposure_status = "no_cap"
    elif exposure is None:
        exposure_status = "unavailable"
    else:
        exposure_status = "above_cap" if exposure > paper._decimal(cap["cap_pct"]) else "within_cap"
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "policy": policy, "policy_version": version, "cap": cap, "caps_table": {band: float(value) for band, value in EXPOSURE_CAPS.items()},
            "regime": {"benchmark": regime["benchmark"], "score": regime["score"], "zone": regime["zone"], "complete": regime["complete"],
                       "missing": regime["missing"], "stale_inputs": regime["stale_inputs"], "factors": regime["factors"]},
            "current_exposure_pct": float(exposure) if exposure is not None else None,
            "exposure_missing": [symbol for symbol in held if quotes[symbol]["price"] is None], "exposure_status": exposure_status}


def _public(db, result):
    return {**result, "input_revision": store.input_revision(db), "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/paper/accounts/{account_id}/regime-overlay")
@store.snapshot_read
def get_overlay(account_id: str):
    with store.connect() as db:
        return _public(db, evaluate(db, account_id, sessions.latest_completed_session()))


@router.put("/api/paper/accounts/{account_id}/regime-overlay")
def put_overlay(account_id: str, body: PolicyInput):
    with paper._write() as db:
        paper._account(db, account_id)
        previous, version = current_policy(db, account_id)
        if body.expected_version != version:
            raise _problem("policy_changed", "市場風險覆蓋設定已在其他視窗更新；請重新載入後再儲存")
        _write_policy(db, account_id, body.policy.model_dump(), version + 1, previous)
        return _public(db, evaluate(db, account_id, sessions.latest_completed_session()))
