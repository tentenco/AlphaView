"""Strategy validation gate for the Research Desk (alphaview-validation-v1).

Benchmark gap #2 (Vibe-Trading "Validate" layer, pybroker walk-forward / bootstrap, Bailey & López de Prado's
probabilistic and deflated Sharpe ratio). Fixed-parameter rules only: nothing is optimised here, the same
configuration is re-simulated on chronological folds, its closed-trade returns are bootstrapped with a fixed
seed, and its daily-return Sharpe ratio is tested against zero (or against the expected maximum of `trials`
comparable attempts). A verdict of `pass` needs every test available; anything missing can only be `warn`.
"""
import math
from statistics import NormalDist

import numpy as np
from fastapi import APIRouter
from pydantic import Field, model_validator

from . import sessions, store
from . import research_desk as desk

VALIDATION_VERSION = "alphaview-validation-v1"
BOOTSTRAP_SAMPLES = 2000
BOOTSTRAP_SEED = 20261001
MIN_BOOTSTRAP_TRADES = 10
MIN_SHARPE_SESSIONS = 30
PASS_CONSISTENCY, FAIL_CONSISTENCY = 0.75, 0.5
PASS_DSR, FAIL_DSR = 0.95, 0.5
RULE = (
    "pass：三項檢定皆可用，且分段一致性 ≥ 0.75、平均交易報酬 95% bootstrap 區間下界 > 0、機率化／去膨脹 Sharpe ≥ 0.95。"
    "fail：一致性 < 0.5，或區間上界 ≤ 0，或機率化 Sharpe < 0.5。其餘（含任一檢定不可用）為 warn。"
)
METHOD = (
    "同一組固定參數在暖機後的測試區間重新模擬（口徑同 Research Desk：前日收盤訊號、次日開盤成交、費用與滑價）。"
    "走動式分段把區間依交易日等分為 K 段，每段獨立由空手起算、不延續部位，一致性＝有成交段中報酬為正的比例；"
    "沒有成交的段不計入分母。Bootstrap 以固定種子對已平倉交易報酬重抽 2000 次，回報平均交易報酬的 2.5／97.5 百分位與平均 ≤ 0 的比例；"
    "少於 10 筆平倉交易不計。機率化 Sharpe（PSR）依 Bailey & López de Prado 以日報酬的偏態與峰度修正估計誤差，"
    "計算 Sharpe 大於基準值的機率；trials > 1 時基準值改為該數量獨立嘗試下的期望最大 Sharpe（去膨脹 Sharpe，DSR），"
    "各嘗試的 Sharpe 變異數以本策略的估計變異數代替，是簡化假設。少於 30 個日報酬或波動為零時不計。"
)
WARNINGS = [
    "驗證只能證偽、不能證明策略有效；通過的策略仍可能在未來失效，也不是交易指示。",
    "分段一致性與 bootstrap 都只用一個標的的本機日線，倖存者偏差與資料修訂不在檢定範圍。",
    "trials 由使用者申報；漏報比較過的設定數會高估去膨脹 Sharpe。",
]

router = APIRouter()


class ValidateFields(desk.agent.StrictInput):
    config: desk.StrategyConfig
    risk: desk.Risk = Field(default_factory=desk.Risk)
    test_start: str | None = Field(default=None, pattern=desk.DATE)
    test_end: str | None = Field(default=None, pattern=desk.DATE)
    folds: int = Field(default=4, ge=2, le=8)
    trials: int = Field(default=1, ge=1, le=500)

    @model_validator(mode="after")
    def valid_dates(self):
        desk._valid_date(self.test_start)
        desk._valid_date(self.test_end)
        if self.test_start and self.test_end and self.test_start > self.test_end:
            raise ValueError("開始日期不可晚於結束日期")
        return self


class ValidateInput(ValidateFields):
    symbol: str = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def valid_symbol(self):
        desk._symbol(self.symbol)
        return self


def _walk_forward(series, entry, exit_, valid, first, last, risk, folds):
    count = last - first
    size = count // folds
    if size < desk.MIN_WINDOW_SESSIONS:
        return {"available": False, "reason": "insufficient_history", "folds": [], "consistency": None,
                "detail": f"測試期間 {count} 日無法切成 {folds} 段各至少 {desk.MIN_WINDOW_SESSIONS} 日"}
    rows = []
    for index in range(folds):
        a = first + index * size
        b = last if index == folds - 1 else a + size
        run = desk.simulate(series, entry, exit_, valid, a, b, risk)
        summary = desk.metrics(series, run)
        status = "no_trades" if not run["trades"] else "positive" if summary["return_pct"] > 0 else "negative"
        rows.append({"index": index + 1, "start": summary["start"], "end": summary["end"], "sessions": summary["sessions"],
                     "return_pct": summary["return_pct"], "closed_trades": summary["closed_trades"],
                     "win_rate_pct": summary["win_rate_pct"], "max_drawdown_pct": summary["max_drawdown_pct"],
                     "sharpe_ratio": summary["sharpe_ratio"], "status": status})
    traded = [row for row in rows if row["status"] != "no_trades"]
    if len(traded) < 2:
        return {"available": False, "reason": "insufficient_traded_folds", "folds": rows, "consistency": None,
                "detail": f"只有 {len(traded)} 段有成交，至少需要 2 段"}
    positive = sum(row["status"] == "positive" for row in traded)
    return {"available": True, "reason": None, "folds": rows, "traded_folds": len(traded), "positive_folds": positive,
            "consistency": desk._finite(positive / len(traded), 4), "detail": None}


def _bootstrap(trades):
    returns = np.array([trade["return_pct"] for trade in trades], float)
    if len(returns) < MIN_BOOTSTRAP_TRADES:
        return {"available": False, "reason": "insufficient_trades", "closed_trades": int(len(returns)),
                "required": MIN_BOOTSTRAP_TRADES, "samples": BOOTSTRAP_SAMPLES, "seed": BOOTSTRAP_SEED}
    generator = np.random.default_rng(BOOTSTRAP_SEED)
    means = returns[generator.integers(0, len(returns), size=(BOOTSTRAP_SAMPLES, len(returns)))].mean(axis=1)
    lower, upper = np.percentile(means, [2.5, 97.5])
    return {"available": True, "reason": None, "closed_trades": int(len(returns)), "samples": BOOTSTRAP_SAMPLES,
            "seed": BOOTSTRAP_SEED, "mean_trade_return_pct": desk._finite(returns.mean(), 4),
            "ci95_lower_pct": desk._finite(lower, 4), "ci95_upper_pct": desk._finite(upper, 4),
            "probability_mean_le_zero": desk._finite(float((means <= 0).mean()), 4)}


def _sharpe_test(run, trials):
    values = np.array([run["initial"], *run["values"]], float)
    daily = values[1:] / values[:-1] - 1
    n = len(daily)
    if n < MIN_SHARPE_SESSIONS:
        return {"available": False, "reason": "insufficient_sessions", "sessions": int(n), "required": MIN_SHARPE_SESSIONS, "trials": trials}
    std = float(daily.std(ddof=1))
    if not std > 1e-12:
        return {"available": False, "reason": "zero_volatility", "sessions": int(n), "trials": trials}
    sharpe = float(daily.mean()) / std
    centred = daily - daily.mean()
    skew = float((centred ** 3).mean() / std ** 3)
    kurtosis = float((centred ** 4).mean() / std ** 4)
    variance_term = 1 - skew * sharpe + (kurtosis - 1) / 4 * sharpe ** 2
    if not variance_term > 0:
        return {"available": False, "reason": "invalid_moments", "sessions": int(n), "trials": trials}
    normal = NormalDist()
    benchmark = 0.0
    if trials > 1:
        estimator_std = math.sqrt(variance_term / (n - 1))
        gamma = 0.5772156649015329
        benchmark = estimator_std * ((1 - gamma) * normal.inv_cdf(1 - 1 / trials) + gamma * normal.inv_cdf(1 - 1 / (trials * math.e)))
    statistic = (sharpe - benchmark) * math.sqrt(n - 1) / math.sqrt(variance_term)
    probability = normal.cdf(statistic)
    return {"available": True, "reason": None, "sessions": int(n), "trials": trials,
            "sharpe_daily": desk._finite(sharpe, 6), "sharpe_annualized": desk._finite(sharpe * math.sqrt(252), 4),
            "skewness": desk._finite(skew, 4), "kurtosis": desk._finite(kurtosis, 4),
            "benchmark_sharpe_daily": desk._finite(benchmark, 6), "kind": "deflated" if trials > 1 else "probabilistic",
            "probability": desk._finite(probability, 4)}


def _verdict(walk, boot, sharpe):
    reasons = []
    status = "warn"
    fails = []
    if walk["available"] and walk["consistency"] < FAIL_CONSISTENCY:
        fails.append(f"分段一致性 {walk['consistency']:.2f} < {FAIL_CONSISTENCY}")
    if boot["available"] and boot["ci95_upper_pct"] <= 0:
        fails.append("平均交易報酬 95% 區間上界 ≤ 0")
    if sharpe["available"] and sharpe["probability"] < FAIL_DSR:
        fails.append(f"機率化 Sharpe {sharpe['probability']:.2f} < {FAIL_DSR}")
    if fails:
        return {"status": "fail", "reasons": fails, "rule": RULE}
    for name, block in (("walk_forward", walk), ("bootstrap", boot), ("sharpe", sharpe)):
        if not block["available"]:
            reasons.append(f"{name} 不可用：{block['reason']}")
    if walk["available"] and walk["consistency"] < PASS_CONSISTENCY:
        reasons.append(f"分段一致性 {walk['consistency']:.2f} < {PASS_CONSISTENCY}")
    if boot["available"] and boot["ci95_lower_pct"] <= 0:
        reasons.append("平均交易報酬 95% 區間包含 0")
    if sharpe["available"] and sharpe["probability"] < PASS_DSR:
        reasons.append(f"機率化 Sharpe {sharpe['probability']:.2f} < {PASS_DSR}")
    if not reasons:
        status = "pass"
    return {"status": status, "reasons": reasons, "rule": RULE}


def validate(body: ValidateInput):
    request = body.model_dump()
    config, risk = request["config"], request["risk"]
    as_of = sessions.latest_completed_session()
    with store.read_snapshot():
        revision = store.input_revision()
        series = desk.Series(body.symbol, body.test_end)
        entry, exit_, valid = desk.signals(series, config)
        warmup = desk.warmup_start(valid)
        if warmup is None:
            raise desk.DeskError("insufficient_history", f"{body.symbol} 的歷史不足以計算此策略的指標")
        warnings = []
        first = warmup
        if body.test_start:
            requested = next((i for i, value in enumerate(series.dates) if value >= body.test_start), len(series.dates))
            if requested < warmup:
                warnings.append(f"指定起日缺少暖機資料，實際從 {series.dates[warmup]} 開始。")
            first = max(first, requested)
        last = len(series.dates)
        if last - first < desk.MIN_WINDOW_SESSIONS:
            raise desk.DeskError("insufficient_history", f"測試期間只有 {max(last - first, 0)} 個交易日；至少需要 {desk.MIN_WINDOW_SESSIONS} 日")
        run = desk.simulate(series, entry, exit_, valid, first, last, risk)
        summary = desk.metrics(series, run)
        walk = _walk_forward(series, entry, exit_, valid, first, last, risk, body.folds)
    boot = _bootstrap(run["trades"])
    sharpe = _sharpe_test(run, body.trials)
    verdict = _verdict(walk, boot, sharpe)
    return {"engine_version": VALIDATION_VERSION, "desk_engine_version": desk.ENGINE_VERSION, "as_of": as_of,
            "input_revision": revision, "request": request, "symbol": body.symbol, "config": config,
            "label": desk.config_label(config), "label_en": desk.config_label(config, True),
            "window": {"start": summary["start"], "end": summary["end"], "sessions": summary["sessions"]},
            "summary": {key: summary[key] for key in ("return_pct", "max_drawdown_pct", "sharpe_ratio", "closed_trades",
                                                       "win_rate_pct", "profit_factor", "avg_trade_return_pct")},
            "walk_forward": walk, "bootstrap": boot, "sharpe": sharpe, "verdict": verdict,
            "fingerprint": series.fingerprint, "method": METHOD, "warnings": [*WARNINGS, *warnings]}


class ValidateBatchInput(ValidateFields):
    symbols: list[str] = Field(min_length=1, max_length=desk.MAX_SYMBOLS)

    @model_validator(mode="after")
    def valid_batch(self):
        [desk._symbol(symbol) for symbol in self.symbols]
        if len(set(self.symbols)) != len(self.symbols):
            raise ValueError("代碼不可重複")
        return self


def _compact(result):
    walk, boot, sharpe = result["walk_forward"], result["bootstrap"], result["sharpe"]
    return {"symbol": result["symbol"], "status": "evaluated", "verdict": result["verdict"]["status"],
            "reasons": result["verdict"]["reasons"], "window": result["window"],
            "closed_trades": result["summary"]["closed_trades"], "return_pct": result["summary"]["return_pct"],
            "consistency": walk["consistency"] if walk["available"] else None,
            "ci95": [boot["ci95_lower_pct"], boot["ci95_upper_pct"]] if boot["available"] else None,
            "probability": sharpe["probability"] if sharpe["available"] else None,
            "unavailable": [name for name, block in (("walk_forward", walk), ("bootstrap", boot), ("sharpe", sharpe)) if not block["available"]]}


def validate_batch(body: ValidateBatchInput):
    """Same configuration across the tournament's symbols; one symbol's failure never hides the others."""
    fields = body.model_dump(exclude={"symbols"})
    items = []
    for symbol in body.symbols:
        try:
            items.append(_compact(validate(ValidateInput(symbol=symbol, **fields))))
        except desk.DeskError as error:
            items.append({"symbol": symbol, "status": "unavailable", "code": error.code, "message": error.message, "verdict": None})
    counts = {"pass": 0, "warn": 0, "fail": 0, "unavailable": 0}
    for item in items:
        counts[item["verdict"] or "unavailable"] += 1
    evaluated = counts["pass"] + counts["warn"] + counts["fail"]
    overall = "unavailable" if not evaluated else "fail" if counts["fail"] else "pass" if counts["pass"] == evaluated else "warn"
    return {"engine_version": VALIDATION_VERSION, "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(),
            "config": fields["config"], "label": desk.config_label(fields["config"]), "label_en": desk.config_label(fields["config"], True),
            "folds": body.folds, "trials": body.trials, "items": items, "counts": counts,
            "pass_share": desk._finite(counts["pass"] / evaluated, 4) if evaluated else None, "overall": overall,
            "method": METHOD + " 跨標的彙總：overall 為 fail 若任一標的 fail，pass 須全部已評估標的皆 pass，其餘 warn；不可用的標的不計入分母。",
            "warnings": [*WARNINGS, "跨標的一致性只說明同一設定在不同標的的穩定度，不是分散投資的證據。"]}


@router.post("/api/research-desk/validate-batch")
def validate_batch_endpoint(body: ValidateBatchInput):
    return validate_batch(body)


@router.post("/api/research-desk/validate")
def validate_endpoint(body: ValidateInput):
    try:
        return validate(body)
    except desk.DeskError as error:
        raise error.http() from None
