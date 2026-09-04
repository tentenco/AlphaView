"""Read-only, snapshot-based daily signal comparisons; never emits notifications."""
import json
from datetime import date

from . import store

KINDS = ("entered", "exited", "continued", "unavailable", "universe_added", "universe_removed")


def _snapshot(row):
    if row is None:
        return None
    return {**dict(row), "universe": json.loads(row["universe"]), "result": json.loads(row["result"])}


def _valid(signal, row, as_of):
    return (row is not None and row.get("date") == as_of and signal is not None
            and signal.get("status") in {"match", "watch"}
            and isinstance(signal.get("matched"), bool)
            and signal["matched"] == (signal["status"] == "match"))


def report(scope="market", as_of=None):
    """Compare latest snapshots of distinct stored dates, isolated by scope.

    Scan publication is atomic. A repeat of the same day replaces the effective
    snapshot, not the comparison date. Missing/invalid data never means exit.
    """
    if scope not in {"market", "portfolio"}:
        raise ValueError("選股範圍必須為 market 或 portfolio")
    if as_of is not None and (not isinstance(as_of, str) or date.fromisoformat(as_of).isoformat() != as_of):
        raise ValueError("日期格式須為 YYYY-MM-DD")
    with store.connect() as db:
        db.execute("BEGIN")
        current = _snapshot(db.execute(
            "SELECT * FROM scans WHERE scope=? " + ("AND as_of=? " if as_of else "")
            + "ORDER BY as_of DESC,id DESC LIMIT 1", (scope, as_of) if as_of else (scope,)).fetchone())
        previous = _snapshot(db.execute(
            "SELECT * FROM scans WHERE scope=? AND as_of<? ORDER BY as_of DESC,id DESC LIMIT 1",
            (scope, current["as_of"])).fetchone()) if current else None
    result = {"scope": scope, "status": "ready" if previous else "first_snapshot" if current else "no_snapshot",
              "current_date": current["as_of"] if current else None,
              "previous_date": previous["as_of"] if previous else None,
              "current_snapshot_id": current["id"] if current else None,
              "previous_snapshot_id": previous["id"] if previous else None,
              "current_created_at": current["created_at"] if current else None,
              "previous_created_at": previous["created_at"] if previous else None,
              "counts": {kind: 0 for kind in KINDS}, "events": [],
              "current_symbols": len(current["universe"]) if current else 0,
              "previous_symbols": len(previous["universe"]) if previous else 0}
    if not previous:
        return result
    old_rows = {r["symbol"]: r for r in previous["result"]}
    new_rows = {r["symbol"]: r for r in current["result"]}
    old_members, new_members = set(previous["universe"]), set(current["universe"])

    def emit(kind, symbol, strategy=None, old=None, new=None, reason=""):
        record = new_rows.get(symbol) or old_rows.get(symbol) or {}
        result["events"].append({"kind": kind, "symbol": symbol, "name": record.get("name", symbol),
                                 "strategy": strategy, "previous_status": old.get("status") if old else None,
                                 "current_status": new.get("status") if new else None,
                                 "previous_reason": old.get("reason") if old else None,
                                 "current_reason": new.get("reason") if new else None, "reason": reason})
        result["counts"][kind] += 1

    for symbol in sorted(new_members - old_members):
        emit("universe_added", symbol, reason="新加入本次股票池；沒有同股票池的前日比較，不列為新策略訊號。")
    for symbol in sorted(old_members - new_members):
        emit("universe_removed", symbol, reason="已離開本次股票池；不代表策略條件退出。")
    for symbol in sorted(old_members & new_members):
        old_row, new_row = old_rows.get(symbol), new_rows.get(symbol)
        old_signals = {s["strategy"]: s for s in (old_row or {}).get("signals", [])}
        new_signals = {s["strategy"]: s for s in (new_row or {}).get("signals", [])}
        strategies = sorted(set(old_signals) | set(new_signals))
        if not strategies:
            emit("unavailable", symbol, reason="兩期缺少可比較的策略紀錄。")
        for strategy in strategies:
            old, new = old_signals.get(strategy), new_signals.get(strategy)
            if not (_valid(old, old_row, previous["as_of"]) and _valid(new, new_row, current["as_of"])):
                emit("unavailable", symbol, strategy, old, new, "任一期訊號缺失、資料不足、過期或異常；無法判定策略進出。")
            elif new["matched"] and not old["matched"]:
                emit("entered", symbol, strategy, old, new, "前期未符合，本期符合條件。")
            elif old["matched"] and not new["matched"]:
                emit("exited", symbol, strategy, old, new, "前期符合，本期已不符合條件。")
            elif old["matched"] and new["matched"]:
                emit("continued", symbol, strategy, old, new, "兩期皆符合條件。")
    return result
