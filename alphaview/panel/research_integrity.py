"""Bounded, read-only prefix comparisons of the Research Desk's own signal implementation."""
import math
import hashlib

import numpy as np
from fastapi import APIRouter
from pydantic import Field, model_validator

from . import research_desk as desk, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-research-integrity-v1"
MAX_HISTORY_BARS = 2000
MAX_PREFIXES = 6
MIN_COMPARED_SESSIONS = 20
MAX_DETAILS = 100
RTOL, ATOL = 1e-10, 1e-12
METHOD = (
    "One fixed Research Desk configuration and one local symbol. Build the Desk's Series and signals on "
    "history ending no later than the latest completed XNYS session, then rebuild them independently on "
    "up to six deterministic truncated prefixes. Compare entry, exit, validity and the strategy's indicator "
    "inputs over their common requested signal dates after the full history's warm-up. Each prefix must "
    "contain at least 20 compared sessions and exclude at least one later bar. Boolean values compare "
    "exactly; finite numeric values use rtol=1e-10 and atol=1e-12. Non-finite eligible values and invalid "
    "signal sessions remain unavailable and cannot pass. Before means full-history output; after means "
    "rebuilt prefix output. At most 2000 stored bars, seven Series builds, and 100 details per category. "
    "This samples prefix stability, not all possible future-data leaks, and never simulates or places trades."
)
WARNINGS = [
    "未檢出差異只表示本次抽樣的歷史前綴一致，不是因果性證明、策略獲利證明或交易指示。",
    "只測試目前保存的一份本機日線與一組設定；不涵蓋資料修訂、倖存者偏差、未抽樣切點或成交模擬。",
    "比較期間只含完整暖機後的訊號日期；調整價沿用本機資料，並未重建歷史上當時可取得的資料版本。",
]


class IntegrityInput(desk.agent.StrictInput):
    symbol: str = Field(min_length=1, max_length=10)
    config: desk.StrategyConfig
    test_start: str | None = Field(default=None, pattern=desk.DATE)
    test_end: str | None = Field(default=None, pattern=desk.DATE)
    max_prefixes: int = Field(default=MAX_PREFIXES, ge=1, le=MAX_PREFIXES)

    @model_validator(mode="after")
    def valid_request(self):
        desk._symbol(self.symbol)
        desk._valid_date(self.test_start)
        desk._valid_date(self.test_end)
        if self.test_start and self.test_end and self.test_start > self.test_end:
            raise ValueError("開始日期不可晚於結束日期")
        return self


def _outputs(series, config):
    """Observe the trusted signal arrays and their actual indicator dependencies, without another signal engine."""
    entry, exit_, valid = desk.signals(series, config)
    fields = {"entry": np.asarray(entry), "exit": np.asarray(exit_), "valid": np.asarray(valid),
              "close": series.close}
    strategy, params = config["strategy"], config["params"]
    if strategy == "sma_cross":
        fields.update(sma_fast=series.sma(params["fast"]), sma_slow=series.sma(params["slow"]))
    elif strategy == "rsi_reversion":
        fields["rsi"] = series.rsi(params["period"])
    elif strategy == "donchian_breakout":
        fields.update(prior_high=series.prior_high(params["entry_period"]), prior_low=series.prior_low(params["exit_period"]))
    elif strategy == "bollinger_reversion":
        middle, deviation = series.sma(params["period"]), series.stdev(params["period"])
        fields.update(middle=middle, stdev=deviation, lower=middle - params["std_mult"] * deviation)
    else:
        names = {
            "alphaview_turtle": ("open", "previous_close", "high20", "low10", "volume_ratio"),
            "alphaview_trend": ("ma50", "ma200", "volume_ratio"),
            "alphaview_pullback": ("ma200", "rsi", "previous_close"),
        }.get(strategy, ())
        fields.update({name: series.column(name) for name in names})
    for name, values in fields.items():
        if np.asarray(values).shape != (len(series.dates),):
            raise desk.DeskError("invalid_output_shape", f"{name} 輸出長度與歷史日期不符")
        if name in ("entry", "exit", "valid") and values.dtype != np.bool_:
            raise desk.DeskError("invalid_signal_output", f"{name} 必須為布林訊號，不能把缺值轉成有效訊號")
    return fields


def _value(value):
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    number = float(value)
    return number if math.isfinite(number) else None


def _cutoffs(first, length, maximum):
    earliest, latest = first + MIN_COMPARED_SESSIONS - 1, length - 2
    if latest < earliest:
        return []
    count = min(maximum, latest - earliest + 1)
    if count == 1:
        return [latest]
    return [earliest + (latest - earliest) * index // (count - 1) for index in range(count)]


def _unavailable(result, code, message):
    result["unavailable"].append({"code": code, "message": message})
    return _summarize(result)


def _summarize(result):
    counts = result["counts"]
    counts["prefixes"] = len(result["prefixes"])
    for output, source in (("compared_session_pairs", "compared_sessions"), ("compared_values", "compared_values"),
                           ("differences", "difference_count"), ("unavailable_values", "unavailable_values"),
                           ("invalid_signal_sessions", "invalid_signal_sessions")):
        counts[output] = sum(row[source] for row in result["prefixes"])
    result["differences_truncated"] = counts["differences"] > len(result["differences"])
    result["unavailable_values_truncated"] = counts["unavailable_values"] > len(result["unavailable_values"])
    if counts["unavailable_values"] or counts["invalid_signal_sessions"]:
        result["unavailable"].append({"code": "incomplete_signal_coverage", "message": "比較期間有非有限指標或無效訊號日期，不能判為一致"})
    result["status"] = ("differences_found" if counts["differences"] else
                        "unavailable" if result["unavailable"] or not counts["prefixes"] else "no_difference_detected")
    result["evidence_fingerprint"] = hashlib.sha256(desk._json({key: value for key, value in result.items()
        if key != "evidence_fingerprint"}).encode()).hexdigest()
    return result


def _compare(result, full, before, prefix, after, first):
    cutoff = prefix.dates[-1]
    last = len(prefix.dates)
    summary = {"cutoff_date": cutoff, "history_sessions": last, "compared_start": full.dates[first],
               "compared_sessions": last - first, "compared_values": 0, "difference_count": 0,
               "unavailable_values": 0, "invalid_signal_sessions": 0, "status": "no_difference_detected"}
    for field in before:
        left, right = before[field][first:last], after[field][first:last]
        if field in ("entry", "exit", "valid"):
            available = np.ones(len(left), bool)
            changed = left != right
        else:
            full_finite, prefix_finite = np.isfinite(left), np.isfinite(right)
            available = full_finite & prefix_finite
            changed = (full_finite != prefix_finite) | (available & ~np.isclose(left, right, rtol=RTOL, atol=ATOL))
        summary["compared_values"] += int(available.sum())
        summary["unavailable_values"] += int((~available).sum())
        for offset in np.flatnonzero(~available):
            if len(result["unavailable_values"]) < MAX_DETAILS:
                result["unavailable_values"].append({"prefix_end": cutoff, "date": full.dates[first + int(offset)],
                                                     "field": field, "code": "nonfinite_output",
                                                     "before": _value(left[offset]), "after": _value(right[offset])})
        summary["difference_count"] += int(changed.sum())
        for offset in np.flatnonzero(changed):
            if len(result["differences"]) < MAX_DETAILS:
                result["differences"].append({"prefix_end": cutoff, "date": full.dates[first + int(offset)],
                                              "field": field, "before": _value(left[offset]), "after": _value(right[offset])})
    invalid = ~before["valid"][first:last] | ~after["valid"][first:last]
    summary["invalid_signal_sessions"] = int(invalid.sum())
    if summary["difference_count"]:
        summary["status"] = "differences_found"
    elif summary["unavailable_values"] or summary["invalid_signal_sessions"]:
        summary["status"] = "unavailable"
    return summary


@router.post("/api/research-desk/integrity")
@store.snapshot_read
def inspect_integrity(body: IntegrityInput):
    as_of, revision = sessions.latest_completed_session(), store.input_revision()
    request = body.model_dump()
    config = request["config"]
    effective_end = min(body.test_end, as_of) if body.test_end else as_of
    result = {"engine_version": ENGINE_VERSION, "desk_engine_version": desk.ENGINE_VERSION,
              "as_of": as_of, "input_revision": revision, "symbol": body.symbol, "config": config,
              "request": request, "fingerprint": None, "effective_end": effective_end,
              "status": "unavailable", "window": None, "fields": [], "prefixes": [], "differences": [],
              "unavailable": [], "unavailable_values": [],
              "counts": {"prefixes": 0, "compared_session_pairs": 0, "compared_values": 0,
                         "differences": 0, "unavailable_values": 0, "invalid_signal_sessions": 0},
              "limits": {"max_history_bars": MAX_HISTORY_BARS, "max_prefixes": body.max_prefixes,
                         "min_compared_sessions": MIN_COMPARED_SESSIONS, "max_details": MAX_DETAILS,
                         "numeric_rtol": RTOL, "numeric_atol": ATOL},
              "method": METHOD, "warnings": list(WARNINGS)}
    with store.connect() as db:
        count = db.execute("SELECT count(*) FROM bars WHERE symbol=?", (body.symbol,)).fetchone()[0]
    if count > MAX_HISTORY_BARS:
        return _unavailable(result, "history_limit", f"本機共 {count} 筆日線，超過單次 {MAX_HISTORY_BARS} 筆上限；未啟動計算")
    try:
        full = desk.Series(body.symbol, effective_end)
        result["fingerprint"] = full.fingerprint
        before = _outputs(full, config)
        result["fields"] = list(before)
        available = np.flatnonzero(before["valid"])
        if not len(available):
            return _unavailable(result, "insufficient_history", "沒有完整暖機後可比較的訊號日期")
        first = int(available[0])
        if body.test_start:
            first = max(first, next((i for i, value in enumerate(full.dates) if value >= body.test_start), len(full.dates)))
        cutoffs = _cutoffs(first, len(full.dates), body.max_prefixes)
        result["window"] = {"start": full.dates[first] if first < len(full.dates) else None,
                            "end": full.dates[-1], "sessions": max(len(full.dates) - first, 0),
                            "history_sessions": len(full.dates)}
        if not cutoffs:
            return _unavailable(result, "insufficient_history", "至少需要 20 個可比較訊號日期與 1 個較晚日期，才能移除未來資料重算")
        for index in cutoffs:
            cutoff = full.dates[index]
            prefix = desk.Series(body.symbol, cutoff)
            if prefix.dates != full.dates[:index + 1]:
                return _unavailable(result, "date_mismatch", "前綴重算的日期與完整歷史不一致，無法對齊比較")
            after = _outputs(prefix, config)
            result["prefixes"].append(_compare(result, full, before, prefix, after, first))
    except desk.DeskError as error:
        return _unavailable(result, error.code, error.message)
    return _summarize(result)
