"""Retrospective rule agreement from stored scans; never a return backtest."""
import json
import math
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import scan_provenance, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-alpha-v1"
STRATEGIES = ("turtle", "trend", "pullback", "rps")


class Weights(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    turtle: float = Field(default=25, ge=0, le=100)
    trend: float = Field(default=25, ge=0, le=100)
    pullback: float = Field(default=25, ge=0, le=100)
    rps: float = Field(default=25, ge=0, le=100)


class ReplayInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    scope: Literal["market", "portfolio"] = "market"
    days: Literal[5, 10, 20, 60] = 20
    weights: Weights = Field(default_factory=Weights)
    threshold: float = Field(default=50, ge=1, le=100)
    min_matches: int = Field(default=2, ge=1, le=4)

    @model_validator(mode="after")
    def positive_total(self):
        if sum(self.weights.model_dump().values()) <= 0:
            raise ValueError("策略權重合計須大於零")
        return self


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def rank_rows(rows, universe, day, weights, threshold, min_matches):
    total = sum(weights.values())
    members, seen, ranked = set(universe), set(), []
    for row in rows:
        symbol = row.get("symbol")
        if symbol not in members or symbol in seen:
            continue
        seen.add(symbol)
        metrics, quality, signals = row.get("indicators", {}), row.get("quality", {}), row.get("signals", [])
        if row.get("date") != day or not finite(row.get("bars")) or row["bars"] <= 0:
            continue
        if not finite(metrics.get("close")) or metrics["close"] <= 0 or quality.get("valid") is False:
            continue
        if quality.get("status") in {"data_error", "no_data"} or any(signal.get("status") in {"stale", "data_error"} for signal in signals):
            continue
        score, available_weight, matched = 0, 0, 0
        for strategy in STRATEGIES:
            parts = [signal for signal in signals if signal.get("strategy") == strategy]
            signal = parts[0] if len(parts) == 1 else {}
            available = signal.get("status") in {"match", "watch"} and signal.get("matched") is (signal.get("status") == "match")
            if available:
                available_weight += weights[strategy]
                if signal["matched"]:
                    score += weights[strategy] / total * 100
                    matched += int(weights[strategy] > 0)
        ranked.append({"symbol": symbol, "name": row.get("name") or symbol, "score": score,
                       "matched": matched, "coverage": available_weight / total * 100,
                       "alpha": available_weight == total and score + 1e-9 >= threshold and matched >= min_matches,
                       "rps": metrics.get("rps") if finite(metrics.get("rps")) else None})
    return sorted(ranked, key=lambda item: (-item["score"], -item["matched"], -(item["rps"] if item["rps"] is not None else -1), item["symbol"]))


@router.post("/api/alpha/replay")
@store.snapshot_read
def replay(body: ReplayInput):
    expected = sessions.latest_completed_session()
    calendar = sessions.expected_sessions((date.fromisoformat(expected) - timedelta(days=180)).isoformat(), expected)[-body.days:]
    members = store.universe(body.scope)
    universe = sorted(member["symbol"] for member in members)
    weights = body.weights.model_dump()
    token = scan_provenance.current_token()
    with store.connect() as db:
        saved = db.execute("""SELECT s.* FROM scans s JOIN
            (SELECT as_of,MAX(id) AS id FROM scans WHERE scope=? AND as_of>=? AND as_of<=? GROUP BY as_of) chosen
            ON s.id=chosen.id ORDER BY s.as_of""", (body.scope, calendar[0], expected)).fetchall() if calendar else []
    snapshots = {row["as_of"]: dict(row) for row in saved}
    timeline, ranked_by_day = [], {}
    for day in calendar:
        snapshot = snapshots.get(day)
        reason = "missing_snapshot" if snapshot is None else None
        if snapshot and snapshot["input_revision"] != token:
            reason = "stale_inputs"
        saved_universe = json.loads(snapshot["universe"]) if snapshot else []
        if snapshot and sorted(set(saved_universe)) != universe:
            reason = "changed_universe"
        ranked = [] if reason else rank_rows(json.loads(snapshot["result"]), saved_universe, day, weights, body.threshold, body.min_matches)
        ranked_by_day[day] = {row["symbol"]: row for row in ranked}
        picks = [row for row in ranked if row["alpha"]]
        timeline.append({"date": day, "available": reason is None, "reason": reason,
                         "scan_id": snapshot["id"] if snapshot else None, "usable": len(ranked),
                         "total": len(universe), "alpha_count": len(picks), "picks": picks[:30]})
    occurrences = []
    for symbol in universe:
        cells = []
        for point in timeline:
            row = ranked_by_day[point["date"]].get(symbol)
            cells.append(None if not point["available"] or row is None or row["coverage"] < 100 - 1e-9 else row["alpha"])
        count = sum(cell is True for cell in cells)
        if not count:
            continue
        latest = ranked_by_day[calendar[-1]].get(symbol) if calendar else None
        streak = 0
        for cell in reversed(cells):
            if cell is not True:
                break
            streak += 1
        occurrences.append({"symbol": symbol, "count": count, "eligible_sessions": sum(cell is not None for cell in cells),
                            "streak": streak, "current_alpha": bool(latest and latest["alpha"]),
                            "latest_score": latest["score"] if latest else None, "cells": cells})
    occurrences.sort(key=lambda item: (-item["count"], -item["streak"], -(item["latest_score"] or 0), item["symbol"]))
    return {"engine_version": ENGINE_VERSION, "scope": body.scope, "as_of": expected,
            "input_revision": token, "settings": body.model_dump(), "timeline": timeline,
            "occurrences": occurrences, "universe_count": len(universe),
            "method": "Retrospective screening of the current universe with current cached data and selected weights. Not a point-in-time universe or return backtest; survivorship and data revisions apply."}
