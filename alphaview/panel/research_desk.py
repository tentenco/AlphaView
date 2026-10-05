"""Research Desk: parameterized long-only strategy tournaments on local daily bars.

Concepts adapted from Miles Deutscher's MIT-licensed Research Desk
(github.com/Miles-Deutscher/Backtesting-Engine): a small strategy catalog,
saved presets, run history and an explicit metrics panel. AlphaView keeps its
own execution contract instead of the upstream same-bar close fills: signals on
the prior completed close, fills at the next session open, adjusted prices,
per-side costs and no invented exits. Nothing here places orders, calls a
model or reaches a market-data provider.
"""
import csv
import hashlib
import io
import json
import math
import re
import uuid
from datetime import date
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field, field_validator, model_validator

from . import portfolio_agent as agent
from . import research, sessions, store
from .market import validate_bars

router = APIRouter()
ENGINE_VERSION = "alphaview-research-desk-v1"
PINE_EXPORT_VERSION = "alphaview-pine-export-v1"
MAX_SYMBOLS, MAX_CONFIGS = 10, 24
MIN_WINDOW_SESSIONS = 20
MIN_SAMPLE_TRADES = 30
MAX_PRESETS = 200
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
DATE = r"^\d{4}-\d{2}-\d{2}$"
METHOD = (
    "Daily adjusted OHLC from the local workspace (dividend/split factor adj_close/close applied to open, high, low "
    "and close). Every signal is read on a completed session close and filled at the next session open; long only, "
    "one position at a time, no pyramiding. Each entry commits position_pct of equity; the entry cost is reserved "
    "from that budget so notional = budget / (1 + fee). Slippage moves the fill price against the trade, fees apply "
    "to each side. Optional stop-loss and take-profit are close-confirmed against the entry fill and exit at the "
    "next open, so gaps can make realized losses larger than the stop. After an exit the same session cannot "
    "re-enter. Open positions at the end are marked to the last close and reported as open, never sold on paper. "
    "All configs in a tournament share one window per symbol, starting after the longest warm-up. The benchmark is "
    "buy-and-hold of the same symbol from the same open with the same costs, 100% invested and no stops. With an "
    "out-of-sample share, the window is split chronologically and each part starts flat; ranking uses the "
    "in-sample part only. Excess return is the strategy return minus that benchmark in percentage points."
)
WARNINGS = [
    "回測是歷史模擬，不是預測或交易指示；資料品質、成本、滑價、流動性、倖存者偏差與過度擬合都會影響結果。",
    "測試的設定越多，樣本內第一名越可能只是運氣；請以樣本外結果與跨標的一致性判斷，而不是單一最高報酬。",
    "停損／停利以收盤確認、次日開盤出場，不是盤中觸價；跳空可能讓實際虧損大於設定值。",
    "本機日線約兩年，長週期策略的可測試期間會被暖機期縮短。",
]


def _int(label, english, minimum, maximum, default):
    return {"kind": "int", "label": label, "english": english, "min": minimum, "max": maximum, "default": default}


def _num(label, english, minimum, maximum, default):
    return {"kind": "float", "label": label, "english": english, "min": minimum, "max": maximum, "default": default}


STRATEGIES = {
    "buy_hold": {
        "label": "買入持有", "english": "Buy and hold", "family": "baseline", "source": "Research Desk",
        "summary": "第一個測試交易日開盤買入並持有到期末；所有策略的基準。",
        "summary_en": "Buy at the first test-session open and hold to the end; the baseline for every strategy.",
        "params": {}},
    "sma_cross": {
        "label": "均線交叉", "english": "Moving-average crossover", "family": "trend", "source": "Research Desk",
        "summary": "快線由下往上穿越慢線時買入，反向穿越時賣出。",
        "summary_en": "Buy when the fast SMA crosses above the slow SMA; sell on the reverse cross.",
        "params": {"fast": _int("快線週期", "Fast SMA", 2, 200, 20), "slow": _int("慢線週期", "Slow SMA", 5, 400, 50)}},
    "rsi_reversion": {
        "label": "RSI 均值回歸", "english": "RSI mean reversion", "family": "mean_reversion", "source": "Research Desk",
        "summary": "Wilder RSI 低於或等於進場值時買入，高於或等於出場值時賣出。",
        "summary_en": "Buy when Wilder RSI is at or below the entry level; sell at or above the exit level.",
        "params": {"period": _int("RSI 週期", "RSI period", 2, 50, 14),
                   "entry": _num("進場 RSI ≤", "Entry RSI ≤", 5, 50, 30),
                   "exit": _num("出場 RSI ≥", "Exit RSI ≥", 50, 95, 70)}},
    "donchian_breakout": {
        "label": "通道突破", "english": "Donchian breakout", "family": "trend", "source": "Classic",
        "summary": "收盤高於前 N 日最高價時買入，低於前 M 日最低價時賣出。",
        "summary_en": "Buy when the close exceeds the prior N-session high; sell below the prior M-session low.",
        "params": {"entry_period": _int("突破週期", "Breakout period", 5, 200, 20),
                   "exit_period": _int("出場週期", "Exit period", 2, 100, 10)}},
    "bollinger_reversion": {
        "label": "布林通道回歸", "english": "Bollinger mean reversion", "family": "mean_reversion", "source": "Classic",
        "summary": "收盤跌破下軌（均線減 k 倍母體標準差）時買入，回到中軌以上時賣出。",
        "summary_en": "Buy when the close falls below the lower band (SMA minus k population deviations); sell at the middle band.",
        "params": {"period": _int("週期", "Period", 5, 100, 20), "std_mult": _num("標準差倍數", "Deviation multiple", 0.5, 4, 2)}},
    "alphaview_turtle": {
        "label": "海龜突破（每日選股規則）", "english": "Turtle breakout (screen rule)", "family": "alphaview", "source": "AlphaView",
        "summary": "與每日選股相同的進場條件；收盤跌破前 10 日最低價時出場。",
        "summary_en": "The daily screen's entry rule; exit when the close falls below the prior 10-session low.",
        "params": {}},
    "alphaview_trend": {
        "label": "均線趨勢（每日選股規則）", "english": "Trend following (screen rule)", "family": "alphaview", "source": "AlphaView",
        "summary": "與每日選股相同的進場條件；收盤跌破 MA50 時出場。",
        "summary_en": "The daily screen's entry rule; exit when the close falls below the 50-day SMA.",
        "params": {}},
    "alphaview_pullback": {
        "label": "回檔觀察（每日選股規則）", "english": "RSI pullback (screen rule)", "family": "alphaview", "source": "AlphaView",
        "summary": "與每日選股相同的進場條件；RSI ≥ 60 或收盤跌破 MA200 時出場。",
        "summary_en": "The daily screen's entry rule; exit at RSI ≥ 60 or a close below the 200-day SMA.",
        "params": {}},
}
StrategyId = Literal["buy_hold", "sma_cross", "rsi_reversion", "donchian_breakout", "bollinger_reversion",
                     "alphaview_turtle", "alphaview_trend", "alphaview_pullback"]
CLASSIC_SET = [
    {"strategy": "buy_hold", "params": {}},
    {"strategy": "sma_cross", "params": {"fast": 20, "slow": 50}},
    {"strategy": "sma_cross", "params": {"fast": 50, "slow": 200}},
    {"strategy": "rsi_reversion", "params": {"period": 14, "entry": 30, "exit": 70}},
    {"strategy": "rsi_reversion", "params": {"period": 2, "entry": 10, "exit": 70}},
    {"strategy": "donchian_breakout", "params": {"entry_period": 20, "exit_period": 10}},
    {"strategy": "donchian_breakout", "params": {"entry_period": 55, "exit_period": 20}},
    {"strategy": "bollinger_reversion", "params": {"period": 20, "std_mult": 2}},
    {"strategy": "alphaview_turtle", "params": {}},
    {"strategy": "alphaview_trend", "params": {}},
    {"strategy": "alphaview_pullback", "params": {}},
]


class DeskError(Exception):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

    def http(self):
        return HTTPException(self.status, {"code": self.code, "message": self.message})


def normalize_params(strategy, params):
    spec = STRATEGIES[strategy]["params"]
    unknown = sorted(set(params) - set(spec))
    if unknown:
        raise ValueError(f"此策略不支援參數：{', '.join(unknown)}")
    result = {}
    for name, rule in spec.items():
        value = params.get(name, rule["default"])
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{rule['label']}必須是有限數值")
        if rule["kind"] == "int":
            if isinstance(value, float):
                if not value.is_integer():
                    raise ValueError(f"{rule['label']}必須是整數")
                value = int(value)
        else:
            value = float(value)
        if not rule["min"] <= value <= rule["max"]:
            raise ValueError(f"{rule['label']}必須介於 {rule['min']}–{rule['max']}")
        result[name] = value
    if strategy == "sma_cross" and result["fast"] >= result["slow"]:
        raise ValueError("快線週期必須小於慢線週期")
    if strategy == "rsi_reversion" and result["entry"] >= result["exit"]:
        raise ValueError("RSI 進場值必須小於出場值")
    return result


class StrategyConfig(agent.StrictInput):
    strategy: StrategyId
    params: dict[str, int | float] = Field(default_factory=dict, max_length=8)

    @model_validator(mode="after")
    def valid_params(self):
        self.params = normalize_params(self.strategy, self.params)
        return self


class Risk(agent.StrictInput):
    initial_cash: float = Field(default=100000, ge=1000, le=1e9)
    fee_bps: float = Field(default=10, ge=0, le=100)
    slippage_bps: float = Field(default=0, ge=0, le=100)
    position_pct: float = Field(default=100, ge=1, le=100)
    stop_loss_pct: float | None = Field(default=None, ge=0.5, le=50)
    take_profit_pct: float | None = Field(default=None, ge=1, le=500)


def _valid_date(value):
    if value is not None:
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("日期必須為有效的 YYYY-MM-DD") from exc
    return value


def _symbol(value):
    if not SYMBOL.fullmatch(value):
        raise ValueError("股票代碼必須是大寫英數字、句點或連字號，最多 10 字元")
    return value


class TournamentInput(agent.StrictInput):
    symbols: list[str] = Field(min_length=1, max_length=MAX_SYMBOLS)
    configs: list[StrategyConfig] = Field(min_length=1, max_length=MAX_CONFIGS)
    risk: Risk = Field(default_factory=Risk)
    start_date: str | None = Field(default=None, pattern=DATE)
    end_date: str | None = Field(default=None, pattern=DATE)
    oos_pct: int = Field(default=30, ge=0, le=50)
    rank_by: Literal["excess_return", "sharpe", "profit_factor", "max_drawdown"] = "excess_return"
    save: bool = True

    @field_validator("symbols")
    @classmethod
    def valid_symbols(cls, symbols):
        [_symbol(symbol) for symbol in symbols]
        if len(set(symbols)) != len(symbols):
            raise ValueError("代碼不可重複")
        return symbols

    @model_validator(mode="after")
    def valid_request(self):
        _valid_date(self.start_date)
        _valid_date(self.end_date)
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("開始日期不可晚於結束日期")
        if 0 < self.oos_pct < 10:
            raise ValueError("樣本外比例必須為 0（不保留）或 10–50%")
        keys = [_json(config.model_dump()) for config in self.configs]
        if len(set(keys)) != len(keys):
            raise ValueError("策略設定不可重複")
        return self


class DiagnoseInput(agent.StrictInput):
    symbol: str = Field(min_length=1, max_length=10)
    config: StrategyConfig
    risk: Risk = Field(default_factory=Risk)
    test_start: str | None = Field(default=None, pattern=DATE)
    test_end: str | None = Field(default=None, pattern=DATE)
    benchmark_symbol: str = Field(default="SPY", min_length=1, max_length=10)

    @model_validator(mode="after")
    def valid_request(self):
        _symbol(self.symbol)
        _symbol(self.benchmark_symbol)
        _valid_date(self.test_start)
        _valid_date(self.test_end)
        if self.test_start and self.test_end and self.test_start > self.test_end:
            raise ValueError("開始日期不可晚於結束日期")
        return self


class PineInput(agent.StrictInput):
    config: StrategyConfig
    risk: Risk = Field(default_factory=Risk)
    start_date: str | None = Field(default=None, pattern=DATE)

    @model_validator(mode="after")
    def valid_date(self):
        _valid_date(self.start_date)
        return self


class PresetInput(agent.StrictInput):
    name: str = Field(min_length=1, max_length=60)
    config: StrategyConfig
    risk: Risk = Field(default_factory=Risk)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("請輸入預設名稱")
        return value


class PresetUpdate(PresetInput):
    expected_version: int = Field(ge=1)


class PresetDelete(agent.StrictInput):
    expected_version: int = Field(ge=1)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite(value, digits=6):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return round(number, digits) if math.isfinite(number) else None


def _params_text(config, english=False):
    s, p = config["strategy"], config["params"]
    if s == "sma_cross":
        return f"{p['fast']}/{p['slow']}"
    if s == "rsi_reversion":
        return f"{p['period']} · {p['entry']:g}/{p['exit']:g}"
    if s == "donchian_breakout":
        return f"{p['entry_period']}/{p['exit_period']}"
    if s == "bollinger_reversion":
        return f"{p['period']} · {p['std_mult']:g}σ"
    return ""


def config_label(config, english=False):
    spec = STRATEGIES[config["strategy"]]
    text = _params_text(config, english)
    name = spec["english"] if english else spec["label"]
    return f"{name} {text}".strip()


# --- Local data and indicators ------------------------------------------------------------

class Series:
    """One symbol's validated, dividend-adjusted daily history with cached indicators."""

    def __init__(self, symbol, end_date=None):
        raw = store.history(symbol)
        if raw.empty:
            raise DeskError("no_history", f"{symbol} 沒有本機日線；請先在資料管理更新行情")
        if end_date:
            dates = raw.date.astype(str)
            valid = dates.str.fullmatch(r"\d{4}-\d{2}-\d{2}") & pd.to_datetime(dates, format="%Y-%m-%d", errors="coerce").notna()
            raw = raw[(dates <= end_date) | ~valid]
            if raw.empty:
                raise DeskError("no_history", f"{symbol} 在結束日期前沒有日線")
        try:
            raw = validate_bars(raw)
        except ValueError as exc:
            raise DeskError("invalid_history", f"{symbol}：{exc}") from None
        df = research.indicators(raw)
        prices = df[["open", "high", "low", "close"]].to_numpy(float)
        if not np.isfinite(prices).all() or not (prices > 0).all():
            raise DeskError("invalid_history", f"{symbol} 的調整後日線包含無效價格；請重新更新行情")
        columns = ["date", "open", "high", "low", "close", "adj_close", "volume"]
        observations = [[str(row[0]), *[float(value) for value in row[1:]]] for row in raw[columns].itertuples(index=False, name=None)]
        self.symbol = symbol
        self.df = df
        self.dates = df["date"].astype(str).tolist()
        self.open, self.high, self.low, self.close = (df[name].to_numpy(float) for name in ("open", "high", "low", "close"))
        self.volume = df["volume"].to_numpy(float)
        self.fingerprint = hashlib.sha256(_json({"engine_version": ENGINE_VERSION, "symbol": symbol, "bars": observations}).encode()).hexdigest()
        self._cache = {}

    def _cached(self, key, build):
        if key not in self._cache:
            self._cache[key] = build()
        return self._cache[key]

    def column(self, name):
        return self._cached(("column", name), lambda: self.df[name].to_numpy(float))

    def sma(self, n):
        return self._cached(("sma", n), lambda: pd.Series(self.close).rolling(n, min_periods=n).mean().to_numpy())

    def stdev(self, n):
        return self._cached(("stdev", n), lambda: pd.Series(self.close).rolling(n, min_periods=n).std(ddof=0).to_numpy())

    def prior_high(self, n):
        return self._cached(("prior_high", n), lambda: pd.Series(self.high).shift(1).rolling(n, min_periods=n).max().to_numpy())

    def prior_low(self, n):
        return self._cached(("prior_low", n), lambda: pd.Series(self.low).shift(1).rolling(n, min_periods=n).min().to_numpy())

    def rsi(self, n):
        return self._cached(("rsi", n), lambda: wilder_rsi(self.close, n))

    def volatility(self, n=20):
        returns = pd.Series(self.close).pct_change()
        return self._cached(("volatility", n), lambda: (returns.rolling(n, min_periods=n).std(ddof=1) * math.sqrt(252) * 100).to_numpy())


def wilder_rsi(close, period):
    """Wilder RSI seeded with the simple mean of the first `period` changes (same as the daily screen)."""
    close = np.asarray(close, float)
    out = np.full(len(close), np.nan)
    if len(close) <= period:
        return out
    delta = np.diff(close)
    gain, loss = np.clip(delta, 0, None), np.clip(-delta, 0, None)
    average_gain, average_loss = gain[:period].mean(), loss[:period].mean()

    def value(up, down):
        if down == 0:
            return 50.0 if up == 0 else 100.0
        return 100 - 100 / (1 + up / down)
    out[period] = value(average_gain, average_loss)
    for i in range(period + 1, len(close)):
        average_gain = (average_gain * (period - 1) + gain[i - 1]) / period
        average_loss = (average_loss * (period - 1) + loss[i - 1]) / period
        out[i] = value(average_gain, average_loss)
    return out


def _shift(values):
    return np.concatenate([[np.nan], values[:-1]])


def signals(series, config):
    """Entry, exit and validity arrays evaluated on each session's completed close."""
    s, p, c = config["strategy"], config["params"], series.close
    n = len(c)
    with np.errstate(invalid="ignore"):
        if s == "buy_hold":
            return np.ones(n, bool), np.zeros(n, bool), np.ones(n, bool)
        if s == "sma_cross":
            fast, slow = series.sma(p["fast"]), series.sma(p["slow"])
            prior_fast, prior_slow = _shift(fast), _shift(slow)
            valid = np.isfinite(fast) & np.isfinite(slow) & np.isfinite(prior_fast) & np.isfinite(prior_slow)
            return (valid & (fast > slow) & (prior_fast <= prior_slow),
                    valid & (fast < slow) & (prior_fast >= prior_slow), valid)
        if s == "rsi_reversion":
            rsi = series.rsi(p["period"])
            valid = np.isfinite(rsi)
            return valid & (rsi <= p["entry"]), valid & (rsi >= p["exit"]), valid
        if s == "donchian_breakout":
            upper, lower = series.prior_high(p["entry_period"]), series.prior_low(p["exit_period"])
            valid = np.isfinite(upper) & np.isfinite(lower)
            return valid & (c > upper), valid & (c < lower), valid
        if s == "bollinger_reversion":
            middle, deviation = series.sma(p["period"]), series.stdev(p["period"])
            lower = middle - p["std_mult"] * deviation
            valid = np.isfinite(middle) & np.isfinite(lower)
            return valid & (c < lower), valid & (c >= middle), valid
        if s == "alphaview_turtle":
            high20, ratio, low10 = series.column("high20"), series.column("volume_ratio"), series.column("low10")
            valid = np.isfinite(high20) & np.isfinite(ratio) & np.isfinite(low10)
            return valid & series.df["turtle"].to_numpy(bool), valid & (c < low10), valid
        if s == "alphaview_trend":
            ma50, ma200, ratio = series.column("ma50"), series.column("ma200"), series.column("volume_ratio")
            valid = np.isfinite(ma50) & np.isfinite(ma200) & np.isfinite(ratio)
            return valid & series.df["trend"].to_numpy(bool), valid & (c < ma50), valid
        if s == "alphaview_pullback":
            ma200, rsi = series.column("ma200"), series.column("rsi")
            valid = np.isfinite(ma200) & np.isfinite(rsi)
            return valid & series.df["pullback"].to_numpy(bool), valid & ((rsi >= 60) | (c < ma200)), valid
    raise DeskError("unknown_strategy", "不支援的策略")


def warmup_start(valid):
    """First session index whose prior close carries a fully defined signal."""
    if not valid.any():
        return None
    return int(np.argmax(valid)) + 1


# --- Simulation and metrics ---------------------------------------------------------------

def _benchmark_risk(risk):
    return {**risk, "position_pct": 100.0, "stop_loss_pct": None, "take_profit_pct": None}


def simulate(series, entry, exit_, valid, first, last, risk):
    """Next-open fills over sessions [first, last); every decision reads session i-1."""
    o, c, dates = series.open, series.close, series.dates
    fee, slip = risk["fee_bps"] / 10000, risk["slippage_bps"] / 10000
    stop = risk["stop_loss_pct"] / 100 if risk.get("stop_loss_pct") else None
    target = risk["take_profit_pct"] / 100 if risk.get("take_profit_pct") else None
    cash, units, position = float(risk["initial_cash"]), 0.0, None
    trades, values, exposed, invalid_sessions = [], [], 0, 0
    for i in range(first, last):
        prior = i - 1
        if not valid[prior]:
            invalid_sessions += 1
        if units:
            reason = "signal" if exit_[prior] else None
            if reason is None and stop and c[prior] <= position["entry_price"] * (1 - stop):
                reason = "stop_loss"
            if reason is None and target and c[prior] >= position["entry_price"] * (1 + target):
                reason = "take_profit"
            if reason:
                fill = o[i] * (1 - slip)
                gross = units * fill
                exit_fee = gross * fee
                proceeds = gross - exit_fee
                cash += proceeds
                trades.append({**position, "exit_index": i, "exit_date": dates[i], "exit_price": float(fill),
                               "exit_fee": float(exit_fee), "exit_reason": reason,
                               "net_pnl": float(proceeds - position["cost"]),
                               "return_pct": float((proceeds / position["cost"] - 1) * 100),
                               "holding_sessions": i - position["entry_index"],
                               "holding_days": (date.fromisoformat(dates[i]) - date.fromisoformat(position["entry_date"])).days})
                units, position = 0.0, None
        elif entry[prior]:
            budget = cash * risk["position_pct"] / 100
            notional = budget / (1 + fee)
            fill = o[i] * (1 + slip)
            units = notional / fill
            cash -= budget
            position = {"signal_index": prior, "signal_date": dates[prior], "entry_index": i, "entry_date": dates[i],
                        "entry_price": float(fill), "units": float(units), "cost": float(budget),
                        "entry_fee": float(budget - notional)}
        value = cash + units * c[i]
        if not math.isfinite(value) or value <= 0:
            raise DeskError("numeric_range", f"{series.symbol} 的模擬淨值超出有效範圍；請檢查日線價格")
        exposed += bool(units)
        values.append(float(value))
    open_position = None
    if position:
        mark = units * c[last - 1]
        open_position = {**position, "mark_date": dates[last - 1], "mark_price": float(c[last - 1]),
                         "unrealized_pnl": float(mark - position["cost"]),
                         "unrealized_return_pct": float((mark / position["cost"] - 1) * 100)}
    return {"first": first, "last": last, "values": values, "trades": trades, "open_position": open_position,
            "exposed": exposed, "invalid_sessions": invalid_sessions, "initial": float(risk["initial_cash"])}


def metrics(series, run):
    initial, values = run["initial"], np.array([run["initial"], *run["values"]], float)
    start, end = series.dates[run["first"]], series.dates[run["last"] - 1]
    final = values[-1]
    daily = values[1:] / values[:-1] - 1
    volatility = float(daily.std(ddof=1)) if len(daily) > 1 else math.nan
    sharpe = float(daily.mean()) / volatility * math.sqrt(252) if volatility > 1e-12 else math.nan
    elapsed = (date.fromisoformat(end) - date.fromisoformat(start)).days
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        cagr = float(np.expm1(np.log(final / initial) * 365.25 / elapsed) * 100) if elapsed > 0 else math.nan
    trades = run["trades"]
    pnls = [trade["net_pnl"] for trade in trades]
    gross_profit = math.fsum(p for p in pnls if p > 0)
    gross_loss = math.fsum(-p for p in pnls if p < 0)
    wins = sum(p > 0 for p in pnls)
    streak = longest = 0
    for pnl in pnls:
        streak = streak + 1 if pnl < 0 else 0
        longest = max(longest, streak)
    sessions_count = run["last"] - run["first"]
    return {"start": start, "end": end, "sessions": sessions_count,
            "final_equity": _finite(final, 2), "net_profit": _finite(final - initial, 2),
            "return_pct": _finite((final / initial - 1) * 100, 4),
            "cagr_pct": _finite(cagr, 4),
            "max_drawdown_pct": _finite(float((values / np.maximum.accumulate(values) - 1).min()) * 100, 4),
            "peak_equity": _finite(values.max(), 2), "lowest_equity": _finite(values.min(), 2),
            "sharpe_ratio": _finite(sharpe, 4), "annualized_volatility_pct": _finite(volatility * math.sqrt(252) * 100, 4),
            "closed_trades": len(trades), "wins": wins,
            "win_rate_pct": _finite(wins / len(trades) * 100, 4) if trades else None,
            "gross_profit": _finite(gross_profit, 2), "gross_loss": _finite(gross_loss, 2),
            "profit_factor": _finite(gross_profit / gross_loss, 4) if gross_loss > 0 else None,
            "avg_trade_return_pct": _finite(np.mean([t["return_pct"] for t in trades]), 4) if trades else None,
            "largest_win_pct": _finite(max(t["return_pct"] for t in trades), 4) if trades else None,
            "largest_loss_pct": _finite(min(t["return_pct"] for t in trades), 4) if trades else None,
            "max_consecutive_losses": longest,
            "avg_holding_sessions": _finite(np.mean([t["holding_sessions"] for t in trades]), 2) if trades else None,
            "exposure_pct": _finite(run["exposed"] / sessions_count * 100, 4) if sessions_count else None,
            "open_position": run["open_position"] is not None, "invalid_signal_sessions": run["invalid_sessions"],
            "excess_return_pct": None}


def _with_excess(result, benchmark):
    if result["return_pct"] is not None and benchmark["return_pct"] is not None:
        result["excess_return_pct"] = _finite(result["return_pct"] - benchmark["return_pct"], 4)
    return result


def _windows(series, starts, start_date, oos_pct):
    if any(start is None for start in starts):
        raise DeskError("insufficient_history", f"{series.symbol} 的歷史不足以計算全部策略的指標")
    first = max(starts)
    if start_date:
        requested = next((i for i, value in enumerate(series.dates) if value >= start_date), len(series.dates))
        first = max(first, requested)
    last = len(series.dates)
    count = last - first
    if count < MIN_WINDOW_SESSIONS:
        raise DeskError("insufficient_history", f"{series.symbol} 暖機後只有 {max(count, 0)} 個交易日；至少需要 {MIN_WINDOW_SESSIONS} 日")
    windows = {"full": (first, last)}
    oos_reason = None
    if oos_pct:
        oos = int(count * oos_pct / 100)
        if oos < MIN_WINDOW_SESSIONS or count - oos < MIN_WINDOW_SESSIONS:
            oos_reason = f"測試期間 {count} 日，無法切出各至少 {MIN_WINDOW_SESSIONS} 日的樣本內與樣本外區間"
            windows["in_sample"] = (first, last)
        else:
            windows["in_sample"] = (first, last - oos)
            windows["out_of_sample"] = (last - oos, last)
    else:
        windows["in_sample"] = (first, last)
    return windows, oos_reason


def _describe(series, windows):
    return {name: {"start": series.dates[a], "end": series.dates[b - 1], "sessions": b - a} for name, (a, b) in windows.items()}


# --- Tournament ---------------------------------------------------------------------------

def _mean(values):
    values = [value for value in values if value is not None]
    return _finite(math.fsum(values) / len(values), 4) if values else None


def _aggregate(rows, window):
    parts = [row[window] for row in rows if row.get(window)]
    if not parts:
        return None
    closed = sum(part["closed_trades"] for part in parts)
    wins = sum(part["wins"] for part in parts)
    gross_profit = math.fsum(part["gross_profit"] or 0 for part in parts)
    gross_loss = math.fsum(part["gross_loss"] or 0 for part in parts)
    return {"symbols": len(parts), "mean_return_pct": _mean([p["return_pct"] for p in parts]),
            "mean_excess_return_pct": _mean([p["excess_return_pct"] for p in parts]),
            "beats_benchmark": sum((p["excess_return_pct"] or 0) > 0 for p in parts),
            "mean_max_drawdown_pct": _mean([p["max_drawdown_pct"] for p in parts]),
            "mean_sharpe_ratio": _mean([p["sharpe_ratio"] for p in parts]),
            "pooled_closed_trades": closed, "pooled_win_rate_pct": _finite(wins / closed * 100, 4) if closed else None,
            "pooled_profit_factor": _finite(gross_profit / gross_loss, 4) if gross_loss > 0 else None,
            "mean_exposure_pct": _mean([p["exposure_pct"] for p in parts]),
            "open_positions": sum(p["open_position"] for p in parts)}


RANK_FIELDS = {"excess_return": "mean_excess_return_pct", "sharpe": "mean_sharpe_ratio",
               "profit_factor": "pooled_profit_factor", "max_drawdown": "mean_max_drawdown_pct"}


def _flags(config, ranking, oos):
    if config["strategy"] == "buy_hold":
        # The benchmark holds one open position by design; sample and win-count flags would be noise.
        return ["benchmark_strategy"]
    flags = []
    if ranking and ranking["pooled_closed_trades"] < MIN_SAMPLE_TRADES:
        flags.append("low_sample")
    if ranking and ranking["pooled_closed_trades"] == 0 and ranking["open_positions"] == 0:
        flags.append("no_trades")
    if ranking and ranking["beats_benchmark"] * 2 < ranking["symbols"]:
        flags.append("beats_benchmark_minority")
    if (ranking and oos and (ranking["mean_excess_return_pct"] or 0) > 0
            and (oos["mean_excess_return_pct"] is None or oos["mean_excess_return_pct"] <= 0)):
        flags.append("out_of_sample_decay")
    return flags


def tournament(body: TournamentInput):
    request = body.model_dump()
    risk, configs = request["risk"], request["configs"]
    as_of = sessions.latest_completed_session()
    with store.read_snapshot():
        revision = store.input_revision()
        symbol_rows, results, warnings = [], [], list(WARNINGS)
        for symbol in body.symbols:
            try:
                series = Series(symbol, body.end_date)
                compiled = [signals(series, config) for config in configs]
                windows, oos_reason = _windows(series, [warmup_start(valid) for _, _, valid in compiled], body.start_date, body.oos_pct)
            except DeskError as error:
                symbol_rows.append({"symbol": symbol, "status": "unavailable", "error": {"code": error.code, "message": error.message}})
                continue
            benchmark_entry, benchmark_exit, benchmark_valid = signals(series, {"strategy": "buy_hold", "params": {}})
            benchmark = {name: metrics(series, simulate(series, benchmark_entry, benchmark_exit, benchmark_valid, a, b, _benchmark_risk(risk)))
                         for name, (a, b) in windows.items()}
            for index, (entry, exit_, valid) in enumerate(compiled):
                row = {"config_index": index, "symbol": symbol}
                for name, (a, b) in windows.items():
                    row[name] = _with_excess(metrics(series, simulate(series, entry, exit_, valid, a, b, risk)), benchmark[name])
                row.setdefault("out_of_sample", None)
                results.append(row)
            stale = series.dates[-1] < as_of and not body.end_date
            symbol_rows.append({"symbol": symbol, "status": "ok", "error": None, "bars": len(series.dates),
                                "data_start": series.dates[0], "data_end": series.dates[-1], "history_stale": stale,
                                "windows": _describe(series, windows), "out_of_sample_available": "out_of_sample" in windows,
                                "out_of_sample_reason": oos_reason, "benchmark": {**benchmark, "out_of_sample": benchmark.get("out_of_sample")},
                                "fingerprint": series.fingerprint})
    usable = [row for row in symbol_rows if row["status"] == "ok"]
    if not usable:
        raise DeskError("no_usable_symbols", "所有代碼都沒有足夠的有效本機日線；請先更新行情或縮短暖機期")
    field = RANK_FIELDS[body.rank_by]
    leaderboard = []
    for index, config in enumerate(configs):
        rows = [row for row in results if row["config_index"] == index]
        in_sample, out_of_sample, full = _aggregate(rows, "in_sample"), _aggregate(rows, "out_of_sample"), _aggregate(rows, "full")
        leaderboard.append({"config_index": index, "config": config, "label": config_label(config),
                            "label_en": config_label(config, True), "family": STRATEGIES[config["strategy"]]["family"],
                            "in_sample": in_sample, "out_of_sample": out_of_sample, "full": full,
                            "rank_value": in_sample[field] if in_sample else None,
                            "flags": _flags(config, in_sample, out_of_sample)})
    leaderboard.sort(key=lambda row: (row["rank_value"] is None, -(row["rank_value"] or 0), row["config_index"]))
    for rank, row in enumerate(leaderboard, 1):
        row["rank"] = rank
    if body.oos_pct == 0:
        warnings.append("未保留樣本外區間；排名只反映同一段資料上的表現，最容易過度擬合。")
    if any(row.get("history_stale") for row in usable):
        warnings.append("部分代碼的本機日線早於最新完成交易日；結果只涵蓋已下載的資料。")
    short_symbols = [row["symbol"] for row in usable if not row["out_of_sample_available"] and body.oos_pct]
    if short_symbols:
        warnings.append(f"{'、'.join(short_symbols)} 的期間太短，沒有樣本外區間；其排名使用完整期間。")
    warnings.append(f"本次比較 {len(configs)} 組設定 × {len(usable)} 檔代碼；多重比較會讓樣本內最佳值偏樂觀。")
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": revision, "request": request,
            "rank_by": body.rank_by, "rank_window": "in_sample", "configs_tested": len(configs),
            "symbols": symbol_rows, "results": results, "leaderboard": leaderboard,
            "benchmark_summary": {name: _mean([row["benchmark"][name]["return_pct"] for row in usable if row["benchmark"].get(name)])
                                  for name in ("full", "in_sample", "out_of_sample")},
            "method": METHOD, "warnings": warnings}


@router.post("/api/research-desk/tournament")
def tournament_endpoint(body: TournamentInput):
    try:
        result = tournament(body)
    except DeskError as error:
        raise error.http() from None
    result["run_id"] = None
    if body.save:
        identifier = uuid.uuid4().hex
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO research_desk_runs(id,created_at,engine_version,as_of,input_revision,request_json,result_json) VALUES (?,?,?,?,?,?,?)",
                       (identifier, store.now(), ENGINE_VERSION, result["as_of"], result["input_revision"],
                        _json(result["request"]), _json(result)))
        result["run_id"] = identifier
    return result


# --- Diagnostics: why a configuration lost -------------------------------------------------

def _bucket(label, trades):
    pnls = [trade["net_pnl"] for trade in trades]
    losses = math.fsum(-p for p in pnls if p < 0)
    wins = sum(p > 0 for p in pnls)
    return {"bucket": label, "trades": len(trades), "wins": wins,
            "win_rate_pct": _finite(wins / len(trades) * 100, 2) if trades else None,
            "total_pnl": _finite(math.fsum(pnls), 2), "gross_loss": _finite(losses, 2),
            "avg_return_pct": _finite(np.mean([t["return_pct"] for t in trades]), 4) if trades else None,
            "worst_return_pct": _finite(min(t["return_pct"] for t in trades), 4) if trades else None}


def _conditions(trades, dimension, order):
    total_loss = math.fsum(-t["net_pnl"] for t in trades if t["net_pnl"] < 0)
    rows = []
    for label in order:
        members = [trade for trade in trades if trade["conditions"][dimension] == label]
        if members:
            row = _bucket(label, members)
            row["loss_share_pct"] = _finite(row["gross_loss"] / total_loss * 100, 2) if total_loss > 0 else None
            rows.append(row)
    return rows


def _drawdowns(dates, values, first, limit=5):
    series = [(dates[first], values[0]), *[(dates[first + k], value) for k, value in enumerate(values[1:])]]
    episodes, peak, current = [], (0, series[0][1]), None
    for position, (_, value) in enumerate(series):
        if value >= peak[1]:
            if current:
                current["recovery"] = position
                episodes.append(current)
                current = None
            peak = (position, value)
        elif current is None:
            current = {"peak": peak[0], "peak_value": peak[1], "trough": position, "trough_value": value, "recovery": None}
        elif value < current["trough_value"]:
            current.update(trough=position, trough_value=value)
    if current:
        episodes.append(current)
    episodes.sort(key=lambda item: item["trough_value"] / item["peak_value"])
    return [{"peak_date": series[e["peak"]][0], "trough_date": series[e["trough"]][0],
             "recovery_date": series[e["recovery"]][0] if e["recovery"] is not None else None,
             "depth_pct": _finite((e["trough_value"] / e["peak_value"] - 1) * 100, 4),
             "sessions_to_trough": e["trough"] - e["peak"],
             "sessions_to_recovery": e["recovery"] - e["trough"] if e["recovery"] is not None else None}
            for e in episodes[:limit]]


def _hypotheses(summary, benchmark, conditions, risk):
    notes = []

    def add(code, zh, en, **evidence):
        notes.append({"code": code, "text": zh, "text_en": en, "evidence": evidence})
    closed = summary["closed_trades"]
    if closed < MIN_SAMPLE_TRADES:
        add("small_sample", f"只有 {closed} 筆已平倉交易；先拉長期間或跨標的測試，再判斷任何修改是否真的有效。",
            f"Only {closed} closed trades; widen the period or test more symbols before trusting any change.", closed_trades=closed)
    for dimension, label, zh, en in (
            ("trend", "below_ma200", "收盤低於 MA200 時進場", "entries taken below the 200-day SMA"),
            ("volatility", "high", "高波動期間進場", "entries taken in the high-volatility tercile"),
            ("benchmark", "below_ma200", "大盤（基準）低於 MA200 時進場", "entries taken while the benchmark was below its 200-day SMA")):
        row = next((item for item in conditions.get(dimension, []) if item["bucket"] == label), None)
        if row and row["trades"] >= 3 and (row["loss_share_pct"] or 0) >= 60:
            add(f"{dimension}_losses",
                f"{row['loss_share_pct']:.0f}% 的虧損金額來自{zh}（{row['trades']} 筆）；可另建一組排除這種情況的設定，並用樣本外區間驗證。",
                f"{row['loss_share_pct']:.0f}% of losses came from {en} ({row['trades']} trades); test a variant that excludes them and validate it out of sample.",
                loss_share_pct=row["loss_share_pct"], trades=row["trades"])
    if closed and (summary["win_rate_pct"] or 0) >= 50 and summary["profit_factor"] is not None and summary["profit_factor"] < 1:
        add("payoff", f"勝率 {summary['win_rate_pct']:.0f}% 但獲利因子 {summary['profit_factor']:.2f}：平均虧損大於平均獲利。",
            f"A {summary['win_rate_pct']:.0f}% win rate with profit factor {summary['profit_factor']:.2f}: average losses outweigh average wins.",
            win_rate_pct=summary["win_rate_pct"], profit_factor=summary["profit_factor"])
    if not risk.get("stop_loss_pct") and summary["largest_loss_pct"] is not None and summary["largest_loss_pct"] <= -15:
        add("no_stop", f"未設定停損，最大單筆虧損 {summary['largest_loss_pct']:.1f}%；可比較加入收盤停損後的回撤與報酬。",
            f"No stop is set and the largest loss is {summary['largest_loss_pct']:.1f}%; compare drawdown and return with a close-confirmed stop.",
            largest_loss_pct=summary["largest_loss_pct"])
    excess = summary["excess_return_pct"]
    if excess is not None and excess < 0 and (summary["exposure_pct"] or 0) < 50:
        add("low_exposure", f"報酬落後買入持有 {abs(excess):.1f} 個百分點，而曝險只有 {summary['exposure_pct']:.0f}%；空手期間錯過的漲幅是主要差距之一。",
            f"Return trails buy-and-hold by {abs(excess):.1f} points with only {summary['exposure_pct']:.0f}% exposure; time out of the market explains part of the gap.",
            excess_return_pct=excess, exposure_pct=summary["exposure_pct"])
    if (summary["max_drawdown_pct"] is not None and benchmark["max_drawdown_pct"] is not None
            and summary["max_drawdown_pct"] < benchmark["max_drawdown_pct"]):
        add("deeper_drawdown", f"最大回撤 {summary['max_drawdown_pct']:.1f}% 比買入持有的 {benchmark['max_drawdown_pct']:.1f}% 更深。",
            f"Maximum drawdown of {summary['max_drawdown_pct']:.1f}% is deeper than buy-and-hold's {benchmark['max_drawdown_pct']:.1f}%.",
            max_drawdown_pct=summary["max_drawdown_pct"], benchmark_max_drawdown_pct=benchmark["max_drawdown_pct"])
    return notes


def _benchmark_regime(symbol, series):
    if symbol == series.symbol:
        other = series
    else:
        try:
            other = Series(symbol)
        except DeskError as error:
            return {}, error.message
    ma200 = other.sma(200)
    regime = {}
    for index, day in enumerate(other.dates):
        if math.isfinite(ma200[index]):
            regime[day] = "above_ma200" if other.close[index] > ma200[index] else "below_ma200"
    return regime, None


def diagnose(body: DiagnoseInput):
    request = body.model_dump()
    config, risk = request["config"], request["risk"]
    as_of = sessions.latest_completed_session()
    with store.read_snapshot():
        revision = store.input_revision()
        series = Series(body.symbol, body.test_end)
        entry, exit_, valid = signals(series, config)
        warmup = warmup_start(valid)
        if warmup is None:
            raise DeskError("insufficient_history", f"{body.symbol} 的歷史不足以計算此策略的指標")
        warnings = []
        first = warmup
        if body.test_start:
            requested = next((i for i, value in enumerate(series.dates) if value >= body.test_start), len(series.dates))
            if requested < warmup:
                warnings.append(f"指定起日缺少暖機資料，實際從 {series.dates[warmup]} 開始。")
            first = max(first, requested)
        last = len(series.dates)
        if last - first < MIN_WINDOW_SESSIONS:
            raise DeskError("insufficient_history", f"測試期間只有 {max(last - first, 0)} 個交易日；至少需要 {MIN_WINDOW_SESSIONS} 日")
        run = simulate(series, entry, exit_, valid, first, last, risk)
        b_entry, b_exit, b_valid = signals(series, {"strategy": "buy_hold", "params": {}})
        bench_run = simulate(series, b_entry, b_exit, b_valid, first, last, _benchmark_risk(risk))
        benchmark = metrics(series, bench_run)
        summary = _with_excess(metrics(series, run), benchmark)
        regime, regime_error = _benchmark_regime(body.benchmark_symbol, series)
    ma200, rsi, volatility = series.sma(200), series.rsi(14), series.volatility(20)
    window_vol = volatility[first - 1:last - 1]
    window_vol = window_vol[np.isfinite(window_vol)]
    cuts = np.percentile(window_vol, [100 / 3, 200 / 3]) if len(window_vol) >= MIN_WINDOW_SESSIONS else None
    trades = []
    for trade in run["trades"]:
        s = trade["signal_index"]
        trend = "unavailable" if not math.isfinite(ma200[s]) else "above_ma200" if series.close[s] > ma200[s] else "below_ma200"
        r = rsi[s]
        zone = ("unavailable" if not math.isfinite(r) else "oversold" if r < 30 else "weak" if r < 50
                else "strong" if r <= 70 else "overbought")
        vol = volatility[s]
        vol_regime = ("unavailable" if cuts is None or not math.isfinite(vol) else
                      "low" if vol <= cuts[0] else "mid" if vol <= cuts[1] else "high")
        hold = "short" if trade["holding_sessions"] <= 5 else "medium" if trade["holding_sessions"] <= 20 else "long"
        trades.append({key: value for key, value in trade.items() if key not in ("signal_index", "entry_index", "exit_index")}
                      | {"conditions": {"trend": trend, "rsi_zone": zone, "volatility": vol_regime,
                                        "benchmark": regime.get(trade["signal_date"], "unavailable"),
                                        "holding": hold, "exit_reason": trade["exit_reason"]},
                         "rsi_at_signal": _finite(r, 2), "volatility_at_signal_pct": _finite(vol, 2)})
    for trade in trades:
        for key in ("entry_price", "exit_price", "units", "cost", "entry_fee", "exit_fee", "net_pnl", "return_pct"):
            trade[key] = _finite(trade[key], 6)
    conditions = {
        "trend": _conditions(trades, "trend", ["above_ma200", "below_ma200", "unavailable"]),
        "rsi_zone": _conditions(trades, "rsi_zone", ["oversold", "weak", "strong", "overbought", "unavailable"]),
        "volatility": _conditions(trades, "volatility", ["low", "mid", "high", "unavailable"]),
        "benchmark": _conditions(trades, "benchmark", ["above_ma200", "below_ma200", "unavailable"]),
        "holding": _conditions(trades, "holding", ["short", "medium", "long"]),
        "exit_reason": _conditions(trades, "exit_reason", ["signal", "stop_loss", "take_profit"]),
    }
    if regime_error:
        warnings.append(f"基準 {body.benchmark_symbol} 無法使用：{regime_error}")
    elif trades and all(t["conditions"]["benchmark"] == "unavailable" for t in trades):
        warnings.append(f"基準 {body.benchmark_symbol} 在這些進場日沒有可用的 MA200 讀數。")
    if cuts is None:
        warnings.append("測試期間太短，無法切分波動率三分位。")
    open_position = run["open_position"]
    if open_position:
        open_position = {key: (_finite(value, 6) if isinstance(value, float) else value) for key, value in open_position.items()
                         if key not in ("signal_index", "entry_index")}
    curve = [{"date": series.dates[first + k], "value": _finite(value, 2), "benchmark": _finite(bench_run["values"][k], 2)}
             for k, value in enumerate(run["values"])]
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": revision, "request": request,
            "symbol": body.symbol, "config": config, "label": config_label(config), "label_en": config_label(config, True),
            "window": {"start": series.dates[first], "end": series.dates[last - 1], "sessions": last - first},
            "summary": summary, "benchmark": benchmark, "curve": curve, "trades": trades, "open_position": open_position,
            "conditions": conditions, "drawdowns": _drawdowns(series.dates, [run["initial"], *run["values"]], first),
            "hypotheses": _hypotheses(summary, benchmark, conditions, risk), "fingerprint": series.fingerprint,
            "benchmark_symbol": body.benchmark_symbol, "volatility_cuts_pct": [_finite(v, 2) for v in cuts] if cuts is not None else None,
            "method": METHOD + (" Conditions are read on the signal session: close versus its 200-day SMA, 14-day Wilder RSI "
                                "zone, 20-day annualized volatility tercile within the test window, and the benchmark's close "
                                "versus its own 200-day SMA on the same date. Hypotheses are deterministic observations to "
                                "test in a new configuration, not recommendations."),
            "warnings": [*WARNINGS[:1], *warnings]}


@router.post("/api/research-desk/diagnose")
def diagnose_endpoint(body: DiagnoseInput):
    try:
        return diagnose(body)
    except DeskError as error:
        raise error.http() from None


def _cell(value):
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return "" if value is None else value


@router.post("/api/research-desk/trades.csv")
def trades_csv(body: DiagnoseInput):
    try:
        result = diagnose(body)
    except DeskError as error:
        raise error.http() from None
    stream = io.StringIO()
    writer = csv.writer(stream)
    columns = ["status", "symbol", "strategy", "params", "signal_date", "entry_date", "entry_price", "exit_date",
               "exit_price", "exit_reason", "units", "cost", "entry_fee", "exit_fee", "net_pnl", "return_pct",
               "holding_sessions", "holding_days", "trend_at_signal", "rsi_at_signal", "rsi_zone",
               "volatility_at_signal_pct", "volatility_regime", "benchmark_regime", "engine_version", "data_fingerprint"]
    writer.writerow(columns)
    params = _json(result["config"]["params"])
    for trade in result["trades"]:
        c = trade["conditions"]
        writer.writerow([_cell(v) for v in (
            "closed", result["symbol"], result["config"]["strategy"], params, trade["signal_date"], trade["entry_date"],
            trade["entry_price"], trade["exit_date"], trade["exit_price"], trade["exit_reason"], trade["units"],
            trade["cost"], trade["entry_fee"], trade["exit_fee"], trade["net_pnl"], trade["return_pct"],
            trade["holding_sessions"], trade["holding_days"], c["trend"], trade["rsi_at_signal"], c["rsi_zone"],
            trade["volatility_at_signal_pct"], c["volatility"], c["benchmark"], ENGINE_VERSION, result["fingerprint"])])
    position = result["open_position"]
    if position:
        writer.writerow([_cell(v) for v in (
            "open_marked_to_market", result["symbol"], result["config"]["strategy"], params, position["signal_date"],
            position["entry_date"], position["entry_price"], position["mark_date"], position["mark_price"], "open",
            position["units"], position["cost"], position["entry_fee"], None, position["unrealized_pnl"],
            position["unrealized_return_pct"], None, None, None, None, None, None, None, None, ENGINE_VERSION, result["fingerprint"])])
    name = f"research-desk-{result['symbol']}-{result['config']['strategy']}-{result['window']['start']}-{result['window']['end']}.csv"
    return Response("﻿" + stream.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


# --- Pine Script v6 export ----------------------------------------------------------------

def _pine_number(value):
    return str(int(value)) if float(value).is_integer() else f"{float(value):.6g}"


def pine_script(config, risk, start_date=None):
    s, p = config["strategy"], config["params"]
    title = f"AlphaView RD - {config_label(config, True)}"
    lines = ["//@version=6",
             f"// Exported by AlphaView Research Desk ({PINE_EXPORT_VERSION}; engine {ENGINE_VERSION}).",
             f"// Strategy: {STRATEGIES[s]['english']} {json.dumps(p, sort_keys=True)}",
             "// Mirrors AlphaView's contract: signal on the bar close, fill at the next bar open, long only,",
             "// one position, commission per side, no same-bar re-entry, close-confirmed stops.",
             "// Not compiled or verified inside TradingView by AlphaView. TradingView bars (dividend adjustment,",
             "// sessions, vendor) can differ from AlphaView's local adjusted Yahoo bars; expect different numbers.",
             "// Pine sizes orders from equity before commission, so fills can differ slightly from AlphaView's budget rule."]
    if s == "rsi_reversion":
        lines.append("// ta.rsi returns 100 when a window has no moves; AlphaView returns 50 in that rare case.")
    if risk["slippage_bps"]:
        lines.append(f"// AlphaView slippage of {_pine_number(risk['slippage_bps'])} bps is not represented: Pine slippage is set in ticks.")
    lines += [
        f'strategy("{title}", overlay=true, initial_capital={_pine_number(risk["initial_cash"])}, '
        f'default_qty_type=strategy.percent_of_equity, default_qty_value={_pine_number(risk["position_pct"])}, '
        f'commission_type=strategy.commission.percent, commission_value={_pine_number(risk["fee_bps"] / 100)}, '
        'pyramiding=0, process_orders_on_close=false, calc_on_every_tick=false)',
        "",
        f'startTime = input.time(timestamp("{start_date or "1970-01-01"}T00:00:00+00:00"), "Backtest start")',
        "inWindow = time >= startTime",
    ]
    body = {
        "buy_hold": ["entrySignal = true", "exitSignal = false"],
        "sma_cross": [f"fastMa = ta.sma(close, {p.get('fast')})", f"slowMa = ta.sma(close, {p.get('slow')})",
                      "entrySignal = ta.crossover(fastMa, slowMa)", "exitSignal = ta.crossunder(fastMa, slowMa)"],
        "rsi_reversion": [f"rsiValue = ta.rsi(close, {p.get('period')})",
                          f"entrySignal = rsiValue <= {_pine_number(p.get('entry', 0))}",
                          f"exitSignal = rsiValue >= {_pine_number(p.get('exit', 0))}"],
        "donchian_breakout": [f"upper = ta.highest(high, {p.get('entry_period')})[1]",
                              f"lower = ta.lowest(low, {p.get('exit_period')})[1]",
                              "entrySignal = close > upper", "exitSignal = close < lower"],
        "bollinger_reversion": [f"[middle, upperBand, lowerBand] = ta.bb(close, {p.get('period')}, {_pine_number(p.get('std_mult', 0))})",
                                "entrySignal = close < lowerBand", "exitSignal = close >= middle"],
        "alphaview_turtle": ["volRatio = volume / ta.sma(volume, 20)[1]",
                             "entrySignal = close > ta.highest(high, 20)[1] and close > open and close > close[1] and volRatio >= 1",
                             "exitSignal = close < ta.lowest(low, 10)[1]"],
        "alphaview_trend": ["ma50 = ta.sma(close, 50)", "ma200 = ta.sma(close, 200)", "volRatio = volume / ta.sma(volume, 20)[1]",
                            "entrySignal = close > ma50 and ma50 > ma200 and volRatio >= 1.2", "exitSignal = close < ma50"],
        "alphaview_pullback": ["ma200 = ta.sma(close, 200)", "rsiValue = ta.rsi(close, 14)",
                               "entrySignal = close > ma200 and rsiValue >= 30 and rsiValue <= 45 and close > close[1]",
                               "exitSignal = rsiValue >= 60 or close < ma200"],
    }[s]
    lines += ["", *body, "", "longOpen = strategy.position_size > 0"]
    stop, target = risk.get("stop_loss_pct"), risk.get("take_profit_pct")
    lines.append(f"stopHit = longOpen and close <= strategy.position_avg_price * (1 - {_pine_number(stop)} / 100)" if stop else "stopHit = false")
    lines.append(f"targetHit = longOpen and close >= strategy.position_avg_price * (1 + {_pine_number(target)} / 100)" if target else "targetHit = false")
    lines += ["",
              "if longOpen and exitSignal",
              '    strategy.close("Long", comment="Signal")',
              "else if stopHit",
              '    strategy.close("Long", comment="Stop")',
              "else if targetHit",
              '    strategy.close("Long", comment="Target")',
              "else if inWindow and not longOpen and entrySignal",
              '    strategy.entry("Long", strategy.long)',
              ""]
    return "\n".join(lines)


@router.post("/api/research-desk/pine")
def pine_endpoint(body: PineInput):
    request = body.model_dump()
    code = pine_script(request["config"], request["risk"], body.start_date)
    return {"engine_version": ENGINE_VERSION, "export_version": PINE_EXPORT_VERSION, "config": request["config"],
            "label": config_label(request["config"]), "label_en": config_label(request["config"], True),
            "filename": f"alphaview-{request['config']['strategy']}.pine", "code": code,
            "notes": ["未在 TradingView 內編譯或驗證；貼上後若出錯，請以錯誤訊息逐步修正。",
                      "TradingView 的資料來源與除權息調整設定可能不同，結果不會與 AlphaView 完全一致。"]}


# --- Catalog, presets and history ---------------------------------------------------------

@router.get("/api/research-desk/catalog")
def catalog():
    return {"engine_version": ENGINE_VERSION, "pine_export_version": PINE_EXPORT_VERSION,
            "strategies": [{"id": key, **{k: v for k, v in value.items()}, "params": [{"name": name, **rule} for name, rule in value["params"].items()]}
                           for key, value in STRATEGIES.items()],
            "classic_set": [{"strategy": item["strategy"], "params": normalize_params(item["strategy"], item["params"])} for item in CLASSIC_SET],
            "risk_defaults": Risk().model_dump(), "limits": {"symbols": MAX_SYMBOLS, "configs": MAX_CONFIGS,
                                                             "min_window_sessions": MIN_WINDOW_SESSIONS, "min_sample_trades": MIN_SAMPLE_TRADES},
            "attribution": {"project": "Research Desk", "url": "https://github.com/Miles-Deutscher/Backtesting-Engine", "license": "MIT"},
            "method": METHOD, "warnings": WARNINGS}


def _preset(row):
    return {"id": row["id"], "name": row["name"], "config": json.loads(row["config_json"]), "risk": json.loads(row["risk_json"]),
            "version": row["version"], "engine_version": row["engine_version"], "created_at": row["created_at"], "updated_at": row["updated_at"],
            "label": config_label(json.loads(row["config_json"])), "label_en": config_label(json.loads(row["config_json"]), True)}


@router.get("/api/research-desk/presets")
@store.snapshot_read
def presets():
    with store.connect() as db:
        rows = db.execute("SELECT * FROM research_desk_presets ORDER BY updated_at DESC,id").fetchall()
    return {"engine_version": ENGINE_VERSION, "presets": [_preset(row) for row in rows]}


def _preset_row(db, identifier):
    row = db.execute("SELECT * FROM research_desk_presets WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, {"code": "preset_not_found", "message": "找不到這個策略預設"})
    return row


@router.post("/api/research-desk/presets", status_code=201)
def create_preset(body: PresetInput):
    request = body.model_dump()
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT COUNT(*) FROM research_desk_presets").fetchone()[0] >= MAX_PRESETS:
            raise HTTPException(409, {"code": "preset_limit", "message": f"最多保存 {MAX_PRESETS} 個策略預設"})
        identifier, now = uuid.uuid4().hex, store.now()
        db.execute("INSERT INTO research_desk_presets(id,name,config_json,risk_json,version,engine_version,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)",
                   (identifier, request["name"], _json(request["config"]), _json(request["risk"]), ENGINE_VERSION, now, now))
        return _preset(_preset_row(db, identifier))


@router.put("/api/research-desk/presets/{identifier}")
def update_preset(identifier: str, body: PresetUpdate):
    request = body.model_dump()
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = _preset_row(db, identifier)
        if row["version"] != body.expected_version:
            raise HTTPException(409, {"code": "preset_changed", "message": "這個預設已在其他視窗更新；請重新載入後再儲存"})
        db.execute("UPDATE research_desk_presets SET name=?,config_json=?,risk_json=?,version=version+1,engine_version=?,updated_at=? WHERE id=?",
                   (request["name"], _json(request["config"]), _json(request["risk"]), ENGINE_VERSION, store.now(), identifier))
        return _preset(_preset_row(db, identifier))


@router.delete("/api/research-desk/presets/{identifier}")
def delete_preset(identifier: str, body: PresetDelete):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = _preset_row(db, identifier)
        if row["version"] != body.expected_version:
            raise HTTPException(409, {"code": "preset_changed", "message": "這個預設已在其他視窗更新；請重新載入後再刪除"})
        db.execute("DELETE FROM research_desk_presets WHERE id=?", (identifier,))
    return {"deleted": identifier}


def _run_summary(row, revision):
    result = json.loads(row["result_json"])
    reasons = []
    if row["engine_version"] != ENGINE_VERSION:
        reasons.append("engine_changed")
    if row["input_revision"] != revision:
        reasons.append("inputs_changed")
    return {"id": row["id"], "created_at": row["created_at"], "engine_version": row["engine_version"], "as_of": row["as_of"],
            "input_revision": row["input_revision"], "symbols": [item["symbol"] for item in result["symbols"]],
            "symbols_ok": sum(item["status"] == "ok" for item in result["symbols"]), "configs_tested": result["configs_tested"],
            "rank_by": result["rank_by"], "oos_pct": result["request"]["oos_pct"],
            "top": [{"label": item["label"], "label_en": item["label_en"], "rank_value": item["rank_value"]} for item in result["leaderboard"][:3]],
            "current": not reasons, "stale_reasons": reasons}


@router.get("/api/research-desk/runs")
@store.snapshot_read
def runs(limit: int = Query(default=50, ge=1, le=100)):
    with store.connect() as db:
        revision = store.input_revision(db)
        rows = db.execute("SELECT * FROM research_desk_runs ORDER BY created_at DESC,id DESC LIMIT ?", (limit,)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM research_desk_runs").fetchone()[0]
    return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(), "input_revision": revision,
            "total": total, "runs": [_run_summary(row, revision) for row in rows]}


@router.get("/api/research-desk/runs/{identifier}")
@store.snapshot_read
def run_detail(identifier: str):
    with store.connect() as db:
        revision = store.input_revision(db)
        row = db.execute("SELECT * FROM research_desk_runs WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, {"code": "run_not_found", "message": "找不到這次研究紀錄"})
    summary = _run_summary(row, revision)
    # List summaries use symbol codes; details must retain each saved symbol's
    # status, coverage and windows so the diagnosis path remains available.
    del summary["symbols"]
    return {**json.loads(row["result_json"]), "run_id": row["id"], "created_at": row["created_at"], **summary}


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS research_desk_presets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL, risk_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, engine_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS research_desk_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, engine_version TEXT NOT NULL, as_of TEXT NOT NULL,
        input_revision TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_research_desk_runs_created ON research_desk_runs(created_at,id)")
