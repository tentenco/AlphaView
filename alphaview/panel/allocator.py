"""Risk-aware allocation for the rules workflow (alphaview-allocator-v1).

Diagonal only: one volatility per symbol, no covariance matrix, no optimiser, no new
dependencies. The selection and the invested total come from the rules workflow; this
module only decides how that total is split among the selected symbols.
"""
import math
from datetime import date, timedelta
from statistics import stdev

from . import sessions

ENGINE_VERSION = "alphaview-allocator-v1"
METHODS = ("equal", "inverse_volatility", "score_tilt")
ANNUAL_SESSIONS = 252
METHOD = (
    "equal：每個入選標的取得固定席位 min((100 − 現金緩衝) / 最大持倉數, 單檔上限)。"
    "inverse_volatility：原始權重 ∝ 1/σ；score_tilt：原始權重 ∝ 共識分數 × 1/σ。"
    "σ 是以 as_of 為最後一日、回看 N 個交易日（N 個日對數報酬、N+1 個調整收盤）的樣本標準差年化（√252）；"
    "任一交易日缺日線、價格非有限或波動為零，該標的不可用，整個配置不回退等權、不產生目標。"
    "風險方法的總投入 = 席位權重 × 入選數，與 equal 相同，只改變分配方式；"
    "單檔仍受單檔上限限制，超出部分留在現金，不重分配給其他標的；權重向下取八位小數。"
)
WARNINGS = [
    "反波動只用單一標的的歷史波動，不看相關性；不是最小變異數或風險平價最佳化。",
    "短回看窗口的 σ 估計雜訊大；結果是假設情境，不是預期報酬或風險預測。",
]


def _floor8(value):
    return math.floor(value * 1e8) / 1e8


def slot_weight(constraints):
    return _floor8(min((100 - constraints.cash_buffer_pct) / constraints.max_positions, constraints.max_position_weight_pct))


def volatility(db, symbol, as_of, lookback):
    """Annualised sample std of `lookback` daily log returns of adj_close ending on as_of, or (None, reason)."""
    first = (date.fromisoformat(as_of) - timedelta(days=lookback * 3 + 30)).isoformat()
    expected = sessions.expected_sessions(first, as_of)[-(lookback + 1):]
    if len(expected) < lookback + 1 or expected[-1] != as_of:
        return None, {"code": "calendar_unavailable", "message": "無法取得回看窗口的交易日曆"}
    rows = db.execute("SELECT date, adj_close FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date",
                      (symbol, expected[0], as_of)).fetchall()
    closes = {row["date"]: row["adj_close"] for row in rows}
    missing = [day for day in expected if day not in closes]
    if missing:
        return None, {"code": "history_incomplete", "message": "回看窗口內缺少調整收盤日線",
                      "required_sessions": len(expected), "missing_sessions": len(missing), "first_missing": missing[0]}
    series = [closes[day] for day in expected]
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in series):
        return None, {"code": "invalid_price", "message": "回看窗口內有非有限或非正的調整收盤價"}
    returns = [math.log(later / earlier) for earlier, later in zip(series, series[1:])]
    deviation = stdev(returns)
    if not deviation > 0:
        return None, {"code": "zero_volatility", "message": "回看窗口內波動為零，無法反波動加權"}
    return deviation * math.sqrt(ANNUAL_SESSIONS) * 100, None


def allocate(db, selected, constraints, as_of):
    """Targets for the selected candidate rows plus evidence; empty targets when the method is unavailable."""
    slot = slot_weight(constraints)
    method = constraints.allocation_method
    budget = _floor8(slot * len(selected))
    evidence = {"engine_version": ENGINE_VERSION, "method": method, "status": "applied",
                "lookback_sessions": None, "slot_weight_pct": slot, "invested_budget_pct": budget,
                "capped_to_cash_pct": 0.0, "per_symbol": [], "unavailable": []}
    if method == "equal" or not selected:
        evidence["per_symbol"] = [{"symbol": row["symbol"], "score": row["score"], "sigma_annualized_pct": None,
                                   "raw_weight_pct": slot, "capped_weight_pct": slot, "reason": None} for row in selected]
        return [{"symbol": row["symbol"], "weight_pct": slot} for row in selected], evidence
    lookback = constraints.volatility_lookback_sessions
    evidence["lookback_sessions"] = lookback
    rows = []
    for row in selected:
        sigma, reason = volatility(db, row["symbol"], as_of, lookback)
        if reason is None and method == "score_tilt" and not (isinstance(row["score"], (int, float)) and row["score"] > 0):
            sigma, reason = None, {"code": "nonpositive_score", "message": "分數傾斜需要正的共識分數"}
        rows.append({"symbol": row["symbol"], "score": row["score"], "sigma_annualized_pct": None if sigma is None else round(sigma, 8),
                     "raw_weight_pct": None, "capped_weight_pct": None, "reason": reason})
    evidence["per_symbol"] = rows
    unavailable = [{"symbol": row["symbol"], **row["reason"]} for row in rows if row["reason"]]
    if unavailable:
        evidence.update(status="unavailable", unavailable=unavailable)
        return [], evidence
    raw = {row["symbol"]: (row["score"] if method == "score_tilt" else 1.0) / row["sigma_annualized_pct"] for row in rows}
    total = math.fsum(raw.values())
    targets = []
    for row in rows:
        share = budget * raw[row["symbol"]] / total
        capped = min(_floor8(share), constraints.max_position_weight_pct)
        row.update(raw_weight_pct=round(share, 8), capped_weight_pct=capped)
        targets.append({"symbol": row["symbol"], "weight_pct": capped})
    evidence["capped_to_cash_pct"] = round(budget - math.fsum(target["weight_pct"] for target in targets), 8)
    return targets, evidence
