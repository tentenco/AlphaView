"""Multi-factor market crash-risk temperature adapted from US_Stock_Crash_Monitor.

Manual macro readings arrive with the request and carry their own dates; the
technical factor is read from locally stored benchmark bars. A missing enabled
factor makes the composite unavailable instead of shrinking it. This is market
context for research, never a trade signal.
"""
import math
from datetime import date
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-regime-v1"
UPSTREAM = "https://github.com/middletoo/US_Stock_Crash_Monitor"
FACTORS = ("buffett", "shiller", "yield_curve", "technical", "sentiment")
BENCHMARKS = ("VOO", "SPY", "QQQ")
# Manual readings older than this (in days before the completed session) are
# flagged stale. They still count; the user entered them knowingly.
STALE_AFTER_DAYS = {"buffett": 120, "shiller": 45, "yield_curve": 10, "sentiment": 7}
RANGES = {"buffett_ratio": (0, 1000), "shiller_pe": (0, 200), "yield_10y": (-5, 30),
          "yield_2y": (-5, 30), "fear_greed": (0, 100)}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# Bucket edges follow the upstream model unchanged. Each maps an observed
# reading to a 0–100 factor risk; the composite is the weight-normalized sum.
def bucket_buffett(value):
    return 100 if value > 200 else 90 if value > 180 else 75 if value > 150 else 50 if value > 120 else 25


def bucket_shiller(value):
    return 100 if value > 40 else 90 if value > 35 else 70 if value > 30 else 50 if value > 25 else 20


def bucket_yield(spread):
    if spread < -0.5:
        return 80, "deep_inversion"
    if spread < 0:
        return 60, "inversion"
    if spread < 0.5:
        return 70, "reinversion"
    return 30, "normal"


def bucket_technical(deviation_pct):
    if deviation_pct > 25:
        return 100
    if deviation_pct > 20:
        return 85
    if deviation_pct > 15:
        return 65
    if deviation_pct > 5:
        return 40
    if deviation_pct < -10:
        return 10
    return 20


def bucket_sentiment(value):
    return 100 if value > 80 else 70 if value > 60 else 0 if value < 20 else 40


def factor_risk(factor, value):
    if factor == "yield_curve":
        return bucket_yield(value)
    return {"buffett": bucket_buffett, "shiller": bucket_shiller,
            "technical": bucket_technical, "sentiment": bucket_sentiment}[factor](value), None


def zone(score):
    if score is None:
        return None
    return "extreme" if score >= 80 else "elevated" if score >= 60 else "watch" if score >= 40 else "calm"


# Approximate pre-crash readings taken from the upstream project's reference
# table. They are orientation points, not independently verified datasets.
SCENARIOS = [
    {"id": "2000-03", "period": "2000-03", "readings": {"buffett": 145.0, "shiller": 44.2, "yield_10y": 6.2,
                                                        "yield_2y": 6.6, "technical": 15.0, "sentiment": 90}},
    {"id": "2007-10", "period": "2007-10", "readings": {"buffett": 110.0, "shiller": 27.5, "yield_10y": 4.6,
                                                        "yield_2y": 4.2, "technical": 8.0, "sentiment": 75}},
    {"id": "2022-01", "period": "2022-01", "readings": {"buffett": 195.0, "shiller": 38.3, "yield_10y": 1.6,
                                                        "yield_2y": 0.8, "technical": 12.0, "sentiment": 75}},
]


class Reading(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    value: float
    as_of: date | None = None


class Inputs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    buffett_ratio: Reading | None = None
    shiller_pe: Reading | None = None
    yield_10y: Reading | None = None
    yield_2y: Reading | None = None
    fear_greed: Reading | None = None

    @model_validator(mode="after")
    def within_ranges(self):
        today = date.today()
        for key, (low, high) in RANGES.items():
            reading = getattr(self, key)
            if reading is None:
                continue
            if not low <= reading.value <= high:
                raise ValueError(f"{key} 須介於 {low} 與 {high} 之間")
            if reading.as_of is not None and reading.as_of > today:
                raise ValueError(f"{key} 的日期尚未到來")
        return self


class Weights(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    buffett: float = Field(default=15, ge=0, le=100)
    shiller: float = Field(default=25, ge=0, le=100)
    yield_curve: float = Field(default=25, ge=0, le=100)
    technical: float = Field(default=20, ge=0, le=100)
    sentiment: float = Field(default=15, ge=0, le=100)


class RegimeInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    weights: Weights = Field(default_factory=Weights)
    inputs: Inputs = Field(default_factory=Inputs)
    benchmark: Literal["VOO", "SPY", "QQQ"] = "VOO"

    @model_validator(mode="after")
    def positive_total(self):
        if sum(self.weights.model_dump().values()) <= 0:
            raise ValueError("因子權重合計須大於零")
        return self


def manual_readings(inputs):
    """Turn request inputs into factor readings; the yield factor needs both legs."""
    def reading(key):
        value = getattr(inputs, key)
        return None if value is None else {"value": value.value, "as_of": value.as_of}
    readings = {"buffett": reading("buffett_ratio"), "shiller": reading("shiller_pe"),
                "sentiment": reading("fear_greed")}
    ten, two = reading("yield_10y"), reading("yield_2y")
    if ten is None or two is None:
        missing = [key for key, leg in (("yield_10y", ten), ("yield_2y", two)) if leg is None]
        readings["yield_curve"] = {"available": False, "reason": "missing_input", "detail": {"missing": missing}}
    else:
        dated = [leg["as_of"] for leg in (ten, two) if leg["as_of"] is not None]
        readings["yield_curve"] = {"value": round(ten["value"] - two["value"], 6), "as_of": min(dated) if dated else None,
                                   "detail": {"yield_10y": ten["value"], "yield_2y": two["value"]}}
    return readings


def benchmark_reading(symbol, expected):
    """Deviation of the benchmark's adjusted close from its 200-session average."""
    from .research import indicators
    frame = store.history(symbol)
    dataset = next((row for row in store.dataset_rows() if row["symbol"] == symbol), None)
    base = {"symbol": symbol, "name": dataset["name"] if dataset else None,
            "source": dataset["source"] if dataset else None, "bars": int(len(frame)),
            "last_date": str(frame["date"].max()) if len(frame) else None}
    if frame.empty:
        return {"available": False, "reason": "no_history", **base}
    df = indicators(frame)
    quality = df.attrs.get("data_quality", {})
    if not quality.get("valid"):
        return {"available": False, "reason": "data_error", **base,
                "issues": [issue for issue in quality.get("issues", [])[:3]]}
    last = df.iloc[-1]
    if last.date != expected:
        return {"available": False, "reason": "stale_history", **base}
    close, ma200 = float(last.close), float(last.ma200) if finite(last.ma200) else None
    if len(df) < 200 or ma200 is None or ma200 <= 0 or not finite(close) or close <= 0:
        return {"available": False, "reason": "insufficient_history", **base}
    deviation = (close - ma200) / ma200 * 100
    if not finite(deviation):
        return {"available": False, "reason": "invalid_values", **base}
    return {"available": True, "value": round(deviation, 4), "as_of": date.fromisoformat(expected), **base,
            "detail": {"adjusted_close": round(close, 4), "ma200": round(ma200, 4)}}


def evaluate(weights, readings, expected):
    """Weight-normalized composite; enabled factors without data block the score."""
    total = sum(weights[factor] for factor in FACTORS)
    if total <= 0:
        raise ValueError("因子權重合計須大於零")
    session = date.fromisoformat(expected)
    factors, accumulated, missing, stale = [], 0.0, [], []
    for factor in FACTORS:
        weight = weights[factor]
        reading = readings.get(factor)
        row = {"id": factor, "weight": weight, "weight_pct": round(weight / total * 100, 4), "enabled": weight > 0,
               "available": False, "value": None, "as_of": None, "age_days": None, "stale": False,
               "risk": None, "status": None, "reason": None, "detail": (reading or {}).get("detail")}
        if reading is None or reading.get("available") is False or not finite(reading.get("value")):
            row["reason"] = (reading or {}).get("reason") or "missing_input"
        else:
            risk, status = factor_risk(factor, reading["value"])
            as_of = reading.get("as_of")
            age = (session - as_of).days if isinstance(as_of, date) else None
            limit = STALE_AFTER_DAYS.get(factor)
            row.update(available=True, value=reading["value"], risk=risk, status=status,
                       as_of=as_of.isoformat() if isinstance(as_of, date) else None, age_days=age,
                       stale=age is not None and limit is not None and age > limit)
        if row["enabled"]:
            if row["available"]:
                accumulated += row["risk"] * weight / total
                if row["stale"]:
                    stale.append(factor)
            else:
                missing.append(factor)
        factors.append(row)
    score = round(accumulated, 4) if not missing else None
    return {"factors": factors, "score": score, "zone": zone(score), "complete": not missing,
            "missing": missing, "stale_inputs": stale}


def scenario_result(scenario, weights, expected):
    readings = scenario["readings"]
    prepared = {"buffett": {"value": readings["buffett"]}, "shiller": {"value": readings["shiller"]},
                "yield_curve": {"value": round(readings["yield_10y"] - readings["yield_2y"], 6),
                                "detail": {"yield_10y": readings["yield_10y"], "yield_2y": readings["yield_2y"]}},
                "technical": {"value": readings["technical"]}, "sentiment": {"value": readings["sentiment"]}}
    scored = evaluate(weights, prepared, expected)
    return {"id": scenario["id"], "period": scenario["period"], "score": scored["score"], "zone": scored["zone"],
            "factors": [{"id": row["id"], "value": row["value"], "risk": row["risk"], "status": row["status"],
                         "weight_pct": row["weight_pct"]} for row in scored["factors"]]}


@router.post("/api/market/regime")
@store.snapshot_read
def market_regime(body: RegimeInput):
    expected = sessions.latest_completed_session()
    weights = body.weights.model_dump()
    benchmark = benchmark_reading(body.benchmark, expected)
    readings = manual_readings(body.inputs)
    readings["technical"] = benchmark
    result = evaluate(weights, readings, expected)
    return {"engine_version": ENGINE_VERSION, "as_of": expected, "input_revision": store.input_revision(),
            "benchmark": {"symbol": benchmark["symbol"], "name": benchmark["name"], "source": benchmark["source"],
                          "bars": benchmark["bars"], "last_date": benchmark["last_date"],
                          "available": benchmark["available"], "reason": benchmark.get("reason"),
                          "deviation_pct": benchmark.get("value"), **(benchmark.get("detail") or {})},
            "weights": weights, **result,
            "scenarios": [scenario_result(scenario, weights, expected) for scenario in SCENARIOS],
            "stale_after_days": STALE_AFTER_DAYS, "upstream": UPSTREAM,
            "method": ("Weight-normalized sum of five bucketed factor risks (0–100) adapted from "
                       "US_Stock_Crash_Monitor. Manual macro readings keep their entered dates; the technical "
                       "factor compares the local benchmark's dividend-adjusted close with its 200-session "
                       "average. A missing enabled factor leaves the composite unavailable. Historical scenarios "
                       "use approximate upstream reference readings. Research context, not a trade signal.")}
