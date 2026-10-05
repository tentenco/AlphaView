"""Deeper paper performance metrics on the observed NAV series (additive to alphaview-paper-analytics-v1).

Benchmark gap #8 of the 2026-10-01 benchmark (quantstats / qlib risk report): Sortino, Calmar, underwater
duration, benchmark-relative beta / tracking error / information ratio and gross-versus-net cost drag.
Snapshots keep their own engine version; this block only derives numbers from the complete daily series.
"""
import math
from statistics import fmean, stdev

METRICS_VERSION = "alphaview-paper-metrics-v1"
ANNUAL_SESSIONS = 252
LOW_SAMPLE_RETURNS = 20
DEFAULT_BENCHMARK = "SPY"
BENCHMARK_PATTERN = r"^[A-Z][A-Z0-9.\-]{0,9}$"

METHOD = (
    "進階指標只從完整且相鄰的每日觀測淨值推導：日報酬為相鄰觀測淨值比值減一；年化以 252 個交易日、無風險利率 0 計。"
    "Sharpe＝平均日報酬／樣本標準差×√252；Sortino 的分母是以 0 為目標的下方偏差（所有日報酬取 min(r,0) 平方的平均再開根號）；"
    "Calmar＝年化區間報酬／觀察最大回落。最長水下期間是自觀測峰值到下一次創高之間的交易日數，未回升則標示進行中。"
    "基準採同一區間本機未調整收盤的價格報酬（與不含股息的虛擬帳本口徑一致）；任一交易日缺基準價則基準相關指標整體不可用，不用鄰近價填補。"
    "Beta＝日報酬與基準日報酬的樣本共變異數／基準變異數；追蹤誤差＝超額日報酬樣本標準差×√252；資訊比率＝平均超額日報酬／其標準差×√252。"
    "成本拖累＝帳戶累計費用與滑價／初始虛擬現金；毛報酬＝淨報酬加回累計成本，只在目前估值完整時計算。"
)
WARNINGS = [
    "日報酬樣本少於 20 筆時，年化指標與比率會被少數觀測主導，只供參考，已標示 low_sample。",
    "這些是虛擬帳本的已觀測數字，不是回測、也不是實盤績效；不包含股息、稅與拆併股。",
    "年化報酬是把區間報酬以幾何方式外推到 252 個交易日，短樣本下數值可能極端。",
]


def _finite(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


def _cost_block(costs, current):
    initial = float(current["initial_cash"])
    cost_total = float(costs["cost_total"])
    block = {"cost_total": cost_total, "cost_drag_pct_of_initial": _finite(cost_total / initial * 100) if initial > 0 else None,
             "net_return_since_funding_pct": None, "gross_return_since_funding_pct": None, "reason": None}
    if current["valuation_complete"] and current["equity"] is not None and initial > 0:
        net = float(current["equity"]) - initial
        block["net_return_since_funding_pct"] = _finite(net / initial * 100)
        block["gross_return_since_funding_pct"] = _finite((net + cost_total) / initial * 100)
    else:
        block["reason"] = "valuation_incomplete"
    return block


def _risk(returns, period_return_pct, max_drawdown_pct):
    n = len(returns)
    mean = fmean(returns)
    std = stdev(returns) if n >= 2 else None
    reasons = {}
    try:
        annual_return = ((1 + period_return_pct / 100) ** (ANNUAL_SESSIONS / n) - 1) * 100
    except OverflowError:
        annual_return = None
        reasons["annualized_return_pct"] = "overflow"
    annual_vol = _finite(std * math.sqrt(ANNUAL_SESSIONS) * 100) if std is not None else None
    if std is None:
        reasons["annualized_volatility_pct"] = reasons["sharpe"] = "insufficient_returns"
    sharpe = _finite(mean / std * math.sqrt(ANNUAL_SESSIONS)) if std else None
    if std == 0:
        reasons["sharpe"] = "zero_volatility"
    downside = math.sqrt(fmean([min(value, 0.0) ** 2 for value in returns]))
    sortino = _finite(mean / downside * math.sqrt(ANNUAL_SESSIONS)) if downside > 0 else None
    if downside == 0:
        reasons["sortino"] = "no_downside_observations"
    calmar = None
    if annual_return is not None and max_drawdown_pct is not None and max_drawdown_pct > 0:
        calmar = _finite(annual_return / max_drawdown_pct)
    else:
        reasons["calmar"] = "no_drawdown"
    return {"annualized_return_pct": _finite(annual_return), "annualized_volatility_pct": annual_vol,
            "sharpe": sharpe, "sortino": sortino, "calmar": calmar,
            "mean_daily_return_pct": _finite(mean * 100), "best_day_pct": _finite(max(returns) * 100),
            "worst_day_pct": _finite(min(returns) * 100),
            "positive_days": sum(value > 0 for value in returns), "negative_days": sum(value < 0 for value in returns),
            "reasons": reasons}


def _drawdown(points, equities, max_drawdown_pct):
    peak, peak_index, longest, span = equities[0], 0, 0, (None, None)
    for index, equity in enumerate(equities):
        if equity >= peak:
            peak, peak_index = equity, index
            continue
        length = index - peak_index
        if length > longest:
            longest, span = length, (points[peak_index]["as_of"], points[index]["as_of"])
    current = _finite((1 - equities[-1] / peak) * 100) if peak > 0 else None
    return {"max_drawdown_pct": max_drawdown_pct, "longest_underwater_sessions": longest,
            "longest_underwater_from": span[0], "longest_underwater_to": span[1],
            "underwater_ongoing": equities[-1] < peak, "current_drawdown_pct": current}


def _benchmark(db, dates, returns, period_return_pct, symbol):
    closes = {row["date"]: float(row["close"]) for row in db.execute(
        "SELECT date, close FROM bars WHERE symbol=? AND date BETWEEN ? AND ?", (symbol, dates[0], dates[-1]))}
    missing = [day for day in dates if not closes.get(day, 0) > 0]
    coverage = {"required": len(dates), "priced": len(dates) - len(missing), "missing": missing[:10]}
    if missing:
        return {"symbol": symbol, "available": False, "reason": "benchmark_unavailable", "coverage": coverage}
    bench = [closes[dates[index]] / closes[dates[index - 1]] - 1 for index in range(1, len(dates))]
    diff = [own - other for own, other in zip(returns, bench)]
    period = (closes[dates[-1]] / closes[dates[0]] - 1) * 100
    beta = correlation = tracking_error = information_ratio = None
    reasons = {}
    if len(bench) >= 2:
        mean_own, mean_bench = fmean(returns), fmean(bench)
        variance = sum((value - mean_bench) ** 2 for value in bench) / (len(bench) - 1)
        covariance = sum((own - mean_own) * (other - mean_bench) for own, other in zip(returns, bench)) / (len(bench) - 1)
        std_own, std_bench, std_diff = stdev(returns), math.sqrt(variance), stdev(diff)
        beta = _finite(covariance / variance) if variance > 0 else None
        correlation = _finite(covariance / (std_own * std_bench)) if std_own > 0 and std_bench > 0 else None
        tracking_error = _finite(std_diff * math.sqrt(ANNUAL_SESSIONS) * 100)
        information_ratio = _finite(fmean(diff) / std_diff * math.sqrt(ANNUAL_SESSIONS)) if std_diff > 0 else None
        if variance == 0:
            reasons["beta"] = "benchmark_zero_variance"
        if std_diff == 0:
            reasons["information_ratio"] = "zero_tracking_error"
    else:
        reasons["beta"] = reasons["information_ratio"] = "insufficient_returns"
    return {"symbol": symbol, "available": True, "price_basis": "unadjusted_close",
            "period_return_pct": _finite(period), "excess_return_pct": _finite(period_return_pct - period),
            "beta": beta, "correlation": correlation, "tracking_error_pct": tracking_error,
            "information_ratio": information_ratio, "coverage": coverage, "reasons": reasons}


def compute(db, points, summary, costs, current, benchmark_symbol=DEFAULT_BENCHMARK):
    """Metrics for a `paper_analytics` daily series; everything is null with a reason when the series is incomplete."""
    base = {"method_version": METRICS_VERSION, "available": False, "reason": None, "returns_n": 0,
            "low_sample": True, "risk": None, "drawdown": None, "benchmark": None,
            "costs": _cost_block(costs, current), "method": METHOD, "warnings": WARNINGS}
    if not summary["performance_available"]:
        return {**base, "reason": summary["reason"]}
    equities = [float(point["equity"]) for point in points]
    returns = [equities[index] / equities[index - 1] - 1 for index in range(1, len(equities))]
    dates = [point["as_of"] for point in points]
    return {**base, "available": True, "returns_n": len(returns), "low_sample": len(returns) < LOW_SAMPLE_RETURNS,
            "risk": _risk(returns, summary["period_return_pct"], summary["max_drawdown_pct"]),
            "drawdown": _drawdown(points, equities, summary["max_drawdown_pct"]),
            "benchmark": _benchmark(db, dates, returns, summary["period_return_pct"], benchmark_symbol)}
