"""Research Desk strategy → paper proposal bridge.

Reads one strategy configuration's signal on the latest completed session for
each requested symbol, turns enter/hold/exit/flat into full-portfolio target
weights, and hands them to the paper module, which enforces every account
limit exactly as for a manual proposal. No new tables and no new proposal
source: the result is an ordinary paper proposal that the user still has to
accept in the Agent workspace. Nothing here trades.
"""
import json
import math
from decimal import Decimal

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator, model_validator

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import research_desk as rd
from . import research_validation as rv
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-strategy-bridge-v2"
MAX_SYMBOLS = 10
METHOD = (
    "For each requested symbol the configuration's entry, exit and validity signals are read on the latest "
    "completed session's close from the local adjusted daily bars (the same Series and signal rules as the "
    "Research Desk). A symbol whose latest local bar is not that session, or whose history fails validation, "
    "is unavailable and receives weight 0; no older close is substituted. Held symbols (paper shares > 0) with "
    "an exit signal go to 0 (exit); held symbols without one keep the slot (hold); unheld symbols with a defined "
    "entry signal take the slot (enter); everything else is flat at 0. The slot is min(max_weight_pct, "
    "floor(100 / symbols to 8 decimals)); weight freed by unavailable, flat or exit symbols stays in cash and is "
    "never redistributed. The targets are a complete paper portfolio target, so paper holdings outside the "
    "requested symbols are sold to zero if the proposal is accepted. Fills happen at the next session's open "
    "only when the user explicitly accepts the proposal; that differs from the backtest's fill model, which "
    "fills at the open of the session right after the signal. An unaccepted proposal expires with the next "
    "completed session or any market-data update. No stop-loss or take-profit state is carried between "
    "sessions: only the rule's own exit signal is evaluated."
)
WARNINGS = [
    "這是把回測規則翻成當日目標配置的紙上提案，不是回測績效的延續，也不是交易指示。",
    "訊號在最新完成交易日收盤讀取；只有使用者在 Agent 投資組合明確接受後，才會以次日開盤參考價模擬成交。",
    "停損／停利狀態不會跨交易日保存；每天只評估規則本身的進出場訊號。",
    "未被要求的紙上持倉在完整目標中為零；接受前請先檢閱紙上調倉明細。",
    "驗證閘只能證偽：require_pass 擋下 fail 與全部不可用的設定，但通過或 warn 不代表未來有效。",
]
VALIDATION_FOLDS = 4
GATE_LABELS = {"pass": ("驗證通過", "Validation passed"), "warn": ("驗證保留", "Validation warn"),
               "blocked": ("驗證未通過，提案被擋下", "Validation failed; proposal refused"),
               "overridden": ("驗證未通過，已由使用者明確覆寫", "Validation failed; explicitly overridden by the user"),
               "off": ("未驗證", "Validation off")}
LABELS = {"enter": ("進場", "Enter"), "hold": ("續抱", "Hold"), "exit": ("出場", "Exit"), "flat": ("空手", "Flat"),
          "unavailable": ("不可用", "Unavailable")}


class ValidationPolicy(agent.StrictInput):
    """How the alphaview-validation-v1 verdicts gate the proposal; a fail can only be overridden explicitly."""
    mode: Literal["require_pass", "warn_only", "off"] = "require_pass"
    acknowledge_fail: bool = False


class BridgeInput(agent.StrictInput):
    account_id: str = Field(min_length=1, max_length=100)
    expected_account_version: int = Field(ge=1, strict=True)
    symbols: list[str] = Field(min_length=1, max_length=MAX_SYMBOLS)
    config: rd.StrategyConfig
    risk: rd.Risk = Field(default_factory=rd.Risk)
    test_start: str | None = Field(default=None, pattern=rd.DATE)
    test_end: str | None = Field(default=None, pattern=rd.DATE)
    folds: int = Field(default=VALIDATION_FOLDS, ge=2, le=8)
    max_weight_pct: float = Field(default=20, ge=1, le=100)
    trials: int = Field(default=1, ge=1, le=500)
    validation: ValidationPolicy = Field(default_factory=ValidationPolicy)

    @model_validator(mode="after")
    def valid_validation_dates(self):
        rd._valid_date(self.test_start)
        rd._valid_date(self.test_end)
        if self.test_start and self.test_end and self.test_start > self.test_end:
            raise ValueError("開始日期不可晚於結束日期")
        return self

    @field_validator("symbols")
    @classmethod
    def valid_symbols(cls, symbols):
        for symbol in symbols:
            rd._symbol(symbol)
        if len(set(symbols)) != len(symbols):
            raise ValueError("代碼不可重複")
        return symbols


class BridgeProposalInput(BridgeInput):
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _last(values):
    return rd._finite(values[-1], 4) if len(values) else None


def _indicators(series, config):
    """A few strategy-relevant values on the signal session, for review only."""
    s, p = config["strategy"], config["params"]
    if s == "sma_cross":
        return {"fast_sma": _last(series.sma(p["fast"])), "slow_sma": _last(series.sma(p["slow"]))}
    if s == "rsi_reversion":
        return {"rsi": _last(series.rsi(p["period"]))}
    if s == "donchian_breakout":
        return {"upper": _last(series.prior_high(p["entry_period"])), "lower": _last(series.prior_low(p["exit_period"]))}
    if s == "bollinger_reversion":
        middle, deviation = series.sma(p["period"]), series.stdev(p["period"])
        return {"middle": _last(middle), "lower_band": _last(middle - p["std_mult"] * deviation)}
    if s == "alphaview_turtle":
        return {name: _last(series.column(name)) for name in ("high20", "low10", "volume_ratio")}
    if s == "alphaview_trend":
        return {name: _last(series.column(name)) for name in ("ma50", "ma200", "volume_ratio")}
    if s == "alphaview_pullback":
        return {name: _last(series.column(name)) for name in ("ma200", "rsi")}
    return {}


def slot_weight(count, max_weight_pct):
    return min(float(max_weight_pct), math.floor(100 / count * 1e8) / 1e8)


def decide(db, body, session):
    """Per-symbol decisions on the latest completed session; never substitutes an older close."""
    config = body.config.model_dump()
    held = {row["symbol"] for row in paper._holdings(db, body.account_id) if Decimal(row["shares"]) > 0}
    slot = slot_weight(len(body.symbols), body.max_weight_pct)
    decisions = []
    for symbol in body.symbols:
        decision = {"symbol": symbol, "held": symbol in held, "status": "unavailable", "weight_pct": 0.0,
                    "reason": None, "evidence": None}
        try:
            series = rd.Series(symbol)
        except rd.DeskError as error:
            decision["reason"] = {"code": error.code, "message": error.message}
            decisions.append(decision)
            continue
        last = series.dates[-1]
        if last != session:
            decision["reason"] = {"code": "history_stale", "message": f"{symbol} 最新本機日線為 {last}，不是最新完成交易日 {session}；請先更新行情"}
            decisions.append(decision)
            continue
        entry, exit_, valid = rd.signals(series, config)
        flags = {"entry": bool(entry[-1]), "exit": bool(exit_[-1]), "valid": bool(valid[-1])}
        decision["evidence"] = {"date": last, "close": rd._finite(series.close[-1], 4), **flags, "indicators": _indicators(series, config)}
        if decision["held"] and flags["exit"]:
            decision.update(status="exit", weight_pct=0.0, reason={"code": "exit_signal", "message": "規則出場訊號成立；目標歸零"})
        elif decision["held"]:
            decision.update(status="hold", weight_pct=slot, reason={"code": "no_exit_signal", "message": "持有中且沒有出場訊號；維持席位"})
        elif flags["entry"] and flags["valid"]:
            decision.update(status="enter", weight_pct=slot, reason={"code": "entry_signal", "message": "規則進場訊號成立"})
        elif not flags["valid"]:
            decision.update(status="flat", reason={"code": "signal_not_defined", "message": "指標暖機不足，訊號未定義；不進場"})
        else:
            decision.update(status="flat", reason={"code": "no_entry_signal", "message": "沒有進場訊號"})
        decisions.append(decision)
    return decisions, slot


def validation_phase(body):
    """Run the validation gate for the bridge's symbols; never raises, the caller decides whether to refuse."""
    policy = body.validation
    if policy.mode == "off":
        return {"mode": "off", "gate": "off", "skipped": True, "acknowledge_fail": policy.acknowledge_fail,
                "overridable": False, "failing": [], "unavailable": [], "warn": [], "reasons": []}
    context = {"risk": body.risk.model_dump(), "test_start": body.test_start,
               "test_end": body.test_end, "folds": body.folds, "trials": body.trials}
    batch = rv.validate_batch(rv.ValidateBatchInput(symbols=list(body.symbols), config=body.config,
                                                    **context))
    verdicts = {item["symbol"]: item["verdict"] or "unavailable" for item in batch["items"]}
    failing = [symbol for symbol, verdict in verdicts.items() if verdict == "fail"]
    warn = [symbol for symbol, verdict in verdicts.items() if verdict == "warn"]
    unavailable = [symbol for symbol, verdict in verdicts.items() if verdict == "unavailable"]
    reasons = []
    if policy.mode == "require_pass":
        if batch["overall"] == "unavailable":
            gate, overridable = "blocked", False
            reasons.append("所有代碼的驗證都不可用，無法判定；require_pass 不接受不可用的設定")
        elif failing:
            gate, overridable = ("overridden" if policy.acknowledge_fail else "blocked"), True
            reasons.append(f"驗證 fail：{'、'.join(failing)}")
        elif warn or unavailable:
            gate, overridable = "warn", False
            reasons.append(f"驗證 warn／不可用：{'、'.join(warn + unavailable)}；提案照常建立但請留意")
        else:
            gate, overridable = "pass", False
    else:
        gate, overridable = ("warn" if failing or warn or unavailable else "pass"), False
        if failing or warn or unavailable:
            reasons.append(f"僅警告模式：fail {'、'.join(failing) or '無'}；warn {'、'.join(warn) or '無'}；不可用 {'、'.join(unavailable) or '無'}")
    return {"mode": policy.mode, "gate": gate, "skipped": False, "acknowledge_fail": policy.acknowledge_fail,
            "overridable": overridable, "engine_version": batch["engine_version"], "input_revision": batch["input_revision"],
            "folds": batch["folds"], "trials": batch["trials"], "overall": batch["overall"], "counts": batch["counts"],
            "pass_share": batch["pass_share"], "verdicts": verdicts, "items": batch["items"],
            "request": context,
            "failing": failing, "warn": warn, "unavailable": unavailable, "reasons": reasons,
            "labels": {key: {"zh": zh, "en": en} for key, (zh, en) in GATE_LABELS.items()}}


def _validation_note(validation):
    if validation["gate"] == "off":
        return "validation=off"
    compact = {"v": validation["engine_version"], "mode": validation["mode"], "gate": validation["gate"], "overall": validation["overall"],
               "counts": validation["counts"], "folds": validation["folds"], "trials": validation["trials"],
               "input_revision": validation["input_revision"], "ack": validation["acknowledge_fail"],
               "request": validation["request"], "verdicts": validation["verdicts"]}
    return "validation=" + _json(compact)


def _preview_input(body, decisions, session, revision, config, validation):
    targets = [{"symbol": row["symbol"], "weight_pct": float(row["weight_pct"])} for row in decisions]
    head = f"Research Desk 策略 {rd.config_label(config)}；{ENGINE_VERSION}；訊號日 {session}；{_json(config)}"
    note = _validation_note(validation)
    if len(head) + 1 + len(note) > 2000:
        note = _validation_note({**validation, "verdicts": {"omitted": len(validation.get("verdicts", {}))}})
    rationale = f"{head}；{note}"
    assert len(rationale) <= 2000, "rationale exceeds the paper limit"
    return {"expected_version": body.expected_account_version, "targets": targets, "rationale": rationale,
            "expected_input_revision": revision, "expected_as_of": session}


def _result(body, session, revision, decisions, slot, config, validation):
    counts = {status: sum(row["status"] == status for row in decisions) for status in LABELS}
    warnings = list(WARNINGS)
    if validation["gate"] in ("warn", "blocked", "overridden"):
        warnings.extend(validation["reasons"])
    return {"engine_version": ENGINE_VERSION, "as_of": session, "input_revision": revision, "account_id": body.account_id,
            "validation": validation, "would_refuse": validation["gate"] == "blocked",
            "config": config, "label": rd.config_label(config), "label_en": rd.config_label(config, True),
            "max_weight_pct": float(body.max_weight_pct), "slot_weight_pct": slot, "decisions": decisions, "counts": counts,
            "target_weights": [{"symbol": row["symbol"], "weight_pct": row["weight_pct"]} for row in decisions],
            "invested_weight_pct": round(math.fsum(row["weight_pct"] for row in decisions), 8),
            "labels": {key: {"zh": zh, "en": en} for key, (zh, en) in LABELS.items()},
            "method": METHOD + (" Before a proposal is built the same configuration is validated per symbol "
                                "(alphaview-validation-v1, the request's risk settings, historical validation window, "
                                "folds and trials; defaults apply only when omitted). The historical validation window "
                                "does not move the current signal session or change paper account execution limits. "
                                "require_pass refuses on any "
                                "fail or when every symbol is unavailable unless the fail is explicitly acknowledged, "
                                "warn_only only annotates, off skips; the verdicts are recorded in the proposal rationale."),
            "warnings": warnings}


def _decide_phase(body):
    session = sessions.latest_completed_session()
    config = body.config.model_dump()
    with store.read_snapshot():
        with store.connect() as db:
            paper._account(db, body.account_id)
            revision = store.input_revision(db)
            decisions, slot = decide(db, body, session)
    return session, revision, config, decisions, slot


@router.post("/api/research-desk/paper-preview")
@store.snapshot_read
def paper_preview(body: BridgeInput):
    session, revision, config, decisions, slot = _decide_phase(body)
    validation = validation_phase(body)
    request = paper.PreviewInput(**_preview_input(body, decisions, session, revision, config, validation))
    preview = paper.preview(body.account_id, request)
    return {**_result(body, session, revision, decisions, slot, config, validation), "paper_preview": preview}


@router.post("/api/research-desk/paper-proposal", status_code=201)
def paper_proposal(body: BridgeProposalInput):
    # Evaluate all evidence against one read snapshot, then let paper's write
    # transaction reject a changed revision before it can publish a proposal.
    with store.read_snapshot():
        session, revision, config, decisions, slot = _decide_phase(body)
        validation = validation_phase(body)
    if validation["gate"] == "blocked":
        raise HTTPException(422, {"code": "validation_failed", "message": "；".join(validation["reasons"]) or "驗證閘未通過",
                                  "failing": validation["failing"], "unavailable": validation["unavailable"],
                                  "overridable": validation["overridable"]})
    request = paper.ProposalInput(**_preview_input(body, decisions, session, revision, config, validation), idempotency_key=body.idempotency_key)
    proposal = paper.create_proposal(body.account_id, request)
    if not isinstance(proposal, dict) or "id" not in proposal:
        raise HTTPException(502, {"code": "proposal_unavailable", "message": "紙上提案未建立"})
    return {**_result(body, session, revision, decisions, slot, config, validation), "paper_proposal": proposal}
