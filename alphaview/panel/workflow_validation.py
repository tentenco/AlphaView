"""Advisory standalone-rule evidence for immutable Portfolio Agent runs; never an allocator gate."""
from datetime import date, timedelta
import hashlib
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator

from . import portfolio_agent as agent, research_desk as desk, research_validation as validation, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-workflow-validation-v1"
MAX_SYMBOLS, MAX_HISTORY_BARS, WINDOW_SESSIONS, FOLDS = 5, 3000, 252, 4
FIXED_RISK = {"initial_cash": 100000.0, "fee_bps": 10.0, "slippage_bps": 0.0, "position_pct": 100.0,
              "stop_loss_pct": None, "take_profit_pct": None}
RULE_MAPPING = {"turtle": "alphaview_turtle", "trend": "alphaview_trend", "pullback": "alphaview_pullback", "rps": None}
METHOD = (
    "Advisory evidence for each requested symbol and every enabled rule in the saved Portfolio Agent run. "
    "Turtle, trend and pullback use the existing fixed alphaview_* Research Desk rules and alphaview-validation-v1; "
    "RPS remains unavailable because single-symbol simulation cannot reproduce cross-sectional universe ranks. "
    "Each rule is simulated independently over the latest 252 completed XNYS sessions, with earlier local bars "
    "used only for indicator warmup, four chronological folds, and fixed Research Desk risk defaults: initial "
    "cash 100000, position 100%, fee 10 bps, slippage 0 bps, no additional stop or take-profit. "
    "At most five selected symbols and fifteen mapped rule calls; symbols exceeding 3000 raw local bars are "
    "reported unavailable before loading history. Rule weights remain the saved score weights, not simulated "
    "portfolio weights. Coverage includes unsupported, missing and uninspected symbol-rule pairs. "
    "There is no composite verdict, allocator performance estimate, proposal gate, persistence or reallocation."
)
WARNINGS = [
    "單一規則驗證不能證明加權共識、配置器或整體組合有效；不合併各規則績效。",
    "這是保存工作流的按需研究證據，不是紙上提案閘門；不保存到提案，不修改目標或重分配權重。",
    "RPS 依賴跨標的排名，沒有等價的單一標的驗證；啟用時仍計入所需覆蓋分母。",
    "未檢查的標的與不可用的檢定保留為缺口；trials 應包含使用者比較過的設定次數。",
    "驗證只使用本機日線，不呼叫模型、資料供應商或券商；通過單項檢定仍不是交易指示。",
]


class ValidationInput(agent.StrictInput):
    symbols: list[str] = Field(min_length=1, max_length=MAX_SYMBOLS)
    trials: int = Field(default=1, ge=1, le=500)
    expected_proposal_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("symbols")
    @classmethod
    def valid_symbols(cls, symbols):
        if len(set(symbols)) != len(symbols) or any(not agent.SYMBOL.fullmatch(symbol) for symbol in symbols):
            raise ValueError("驗證代碼不可重複，且須為大寫有效股票代碼")
        return symbols


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _empty(symbol, rule, weight, config, code, message):
    return {"symbol": symbol, "rule": rule, "weight": weight, "config": config, "status": "unavailable", "verdict": None,
            "code": code, "reasons": [message], "window": None, "history_fingerprint": None,
            "closed_trades": None, "consistency": None, "ci95": None, "probability": None,
            "unavailable_tests": [{"test": name, "reason": code} for name in ("walk_forward", "bootstrap", "sharpe")]}


def evaluate(identifier, body):
    with store.connect() as db:
        run = agent._run(db, identifier)
        if (run["proposal_fingerprint"] != body.expected_proposal_fingerprint
                or run["input_revision"] != body.expected_input_revision or run["as_of"] != body.expected_as_of
                or not agent._currentness(run)["current"]):
            raise _problem("workflow_validation_stale", "工作流來源或指紋已變更；請重新產生工作流後驗證")
        selected = [item["symbol"] for item in run["candidates"] if item["status"] == "selected"]
        if run["status"] != "proposed" or not set(body.symbols).issubset(selected):
            raise _problem("workflow_validation_selection", "只能驗證這筆已保存工作流實際選入的標的", 422)
        weights = agent.StrategyWeights.model_validate(run["request"]["strategy_weights"]).model_dump()
        rules = [{"rule": rule, "weight": weights[rule],
                  "config": {"strategy": RULE_MAPPING[rule], "params": {}} if RULE_MAPPING[rule] else None}
                 for rule in agent.STRATEGY_IDS if weights[rule] > 0]
        as_of, revision = run["as_of"], store.input_revision(db)
        days = sessions.expected_sessions((date.fromisoformat(as_of) - timedelta(days=550)).isoformat(), as_of)
        test_start = days[-WINDOW_SESSIONS]
        risk = desk.Risk(**FIXED_RISK).model_dump()
        rule_fingerprint = _fingerprint({"engine_version": ENGINE_VERSION, "agent_engine_version": run["engine_version"],
                                        "proposal_fingerprint": run["proposal_fingerprint"], "enabled_rules": rules,
                                        "desk_engine_version": desk.ENGINE_VERSION,
                                        "validation_engine_version": validation.VALIDATION_VERSION})
        items = []
        for symbol in body.symbols:
            info = db.execute("SELECT COUNT(*) AS count, MAX(CASE WHEN date<=? THEN date END) AS latest FROM bars WHERE symbol=?",
                              (as_of, symbol)).fetchone()
            unavailable = None
            if info["count"] > MAX_HISTORY_BARS:
                unavailable = ("history_limit", "本機日線超過本次計算上限 3000 筆；未截短或補值")
            elif info["latest"] != as_of:
                unavailable = ("history_stale" if info["latest"] else "no_history", "缺少最新完成交易日的本機日線；不使用舊收盤替代")
            for rule in rules:
                config = rule["config"]
                if config is None:
                    items.append(_empty(symbol, rule["rule"], rule["weight"], config, "unsupported_cross_sectional_rule",
                                        "RPS 需要跨標的排名，沒有等價的單一標的驗證"))
                    continue
                if unavailable:
                    items.append(_empty(symbol, rule["rule"], rule["weight"], config, *unavailable))
                    continue
                try:
                    evidence = validation.validate(validation.ValidateInput(symbol=symbol, config=config, risk=risk,
                        test_start=test_start, test_end=as_of, folds=FOLDS, trials=body.trials))
                except desk.DeskError as error:
                    items.append(_empty(symbol, rule["rule"], rule["weight"], config, error.code, error.message))
                    continue
                if evidence["input_revision"] != revision or evidence["as_of"] != as_of:
                    raise _problem("workflow_validation_stale", "驗證期間資料或交易日已變更；請重新驗證")
                compact = validation._compact(evidence)
                items.append({key: value for key, value in compact.items() if key not in ("return_pct", "unavailable")}
                    | {"rule": rule["rule"], "weight": rule["weight"], "config": config, "code": None,
                       "history_fingerprint": evidence["fingerprint"],
                       "unavailable_tests": [{"test": name, "reason": evidence[name]["reason"]}
                           for name in ("walk_forward", "bootstrap", "sharpe") if not evidence[name]["available"]]})
    if sessions.latest_completed_session() != as_of:
        raise _problem("workflow_validation_stale", "驗證期間交易日已變更；請重新驗證")
    evaluated = sum(item["status"] == "evaluated" for item in items)
    requested_pairs, required_pairs = len(items), len(selected) * len(rules)
    request = {"symbols": list(body.symbols), "trials": body.trials, "folds": FOLDS,
               "test_start": test_start, "test_end": as_of, "window_sessions": WINDOW_SESSIONS, "risk": risk}
    return {"engine_version": ENGINE_VERSION, "validation_engine_version": validation.VALIDATION_VERSION,
            "desk_engine_version": desk.ENGINE_VERSION, "agent_engine_version": run["engine_version"],
            "agent_run_id": identifier, "proposal_fingerprint": run["proposal_fingerprint"],
            "rule_fingerprint": rule_fingerprint, "as_of": as_of, "input_revision": revision,
            "evidence_fingerprint": _fingerprint({"rules": rule_fingerprint, "request": request, "input_revision": revision}),
            "current_at_snapshot": True, "mode": "advisory_only", "request": request, "enabled_rules": rules,
            "selected_symbols": selected, "uninspected_symbols": [symbol for symbol in selected if symbol not in body.symbols],
            "coverage": {"selected_symbols": len(selected), "requested_symbols": len(body.symbols), "enabled_rules": len(rules),
                "required_pairs": required_pairs, "requested_pairs": requested_pairs, "evaluated_pairs": evaluated,
                "fully_available_pairs": sum(not item["unavailable_tests"] for item in items),
                "unavailable_pairs": requested_pairs - evaluated, "uninspected_pairs": required_pairs - requested_pairs},
            "counts": {name: sum(item["verdict"] == name for item in items) for name in ("pass", "warn", "fail")},
            "items": items, "method": METHOD, "warnings": WARNINGS}


@router.post("/api/portfolio-agent/runs/{identifier}/validation")
@store.snapshot_read
def validate_workflow(identifier: str, body: ValidationInput):
    return JSONResponse(evaluate(identifier, body), headers={"Cache-Control": "no-store"})
