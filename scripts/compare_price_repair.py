#!/usr/bin/env python3
"""Diagnostic evidence only: never writes application data or adopts fetched prices."""
import argparse
from datetime import datetime, timezone
import hashlib
from importlib import metadata as package_metadata
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
COLUMNS = {"Open": "open", "High": "high", "Low": "low", "Close": "close", "Adj Close": "adj_close", "Volume": "volume"}
IDENTITY = ("symbol", "currency", "instrumentType", "exchangeName", "fullExchangeName", "exchangeTimezoneName", "longName", "shortName")


def now():
    return datetime.now(timezone.utc).isoformat()


def clean(value):
    import pandas as pd
    if pd.api.types.is_scalar(value) and pd.isna(value):
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def encode(value):
    return json.dumps(clean(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def inspect(frame):
    from alphaview.panel.market import history_quality
    labels = [str(column) for column in frame.columns]
    if len(labels) != len(set(labels)):
        raise ValueError("Duplicate column labels after string normalization; diagnostic evidence would lose cells")
    rows, issues = [], []
    for index, row in frame.iterrows():
        values = {}
        for column, value in row.items():
            normalized = clean(value)
            if normalized is None:
                issues.append({"index": str(index), "column": str(column), "reason": "missing_or_nonfinite"})
            values[str(column)] = normalized
        rows.append({"index": str(index), "date": str(index.date()) if hasattr(index, "date") else str(index), "values": values})
    quality_frame = frame.rename(columns=COLUMNS).copy()
    quality_frame["date"] = [row["date"] for row in rows]
    try:
        quality = clean(history_quality(quality_frame))
    except Exception as exc:
        quality = {"valid": False, "status": "validation_error", "error": str(exc)[:500]}
    return {"columns": [str(c) for c in frame.columns], "rows": rows, "issues": issues,
            "quality": quality, "validation_scope": "structural_only; instrument identity and latest-completed-session eligibility are not verified by this quality check", "hash_basis": "SHA-256 of UTF-8 canonical JSON rows: sorted keys, compact separators, non-ASCII preserved; missing/nonfinite values normalized to null with separate issues. Includes index/date/all returned columns; not a raw HTTP response hash.", "sha256": hashlib.sha256(encode(rows).encode()).hexdigest()}


def compare(raw, repaired):
    # Preserve duplicate rows as arrays; never silently overwrite a duplicated date.
    def grouped(source):
        result = {}
        for row in source["rows"]:
            result.setdefault(row["date"], []).append(row["values"])
        return result
    left, right = grouped(raw), grouped(repaired)
    differences = []
    for day in sorted(left.keys() & right.keys()):
        if len(left[day]) != 1 or len(right[day]) != 1:
            if left[day] != right[day]:
                differences.append({"date": day, "column": "__duplicate_rows__", "raw": left[day], "repair": right[day]})
            continue
        for column in sorted(left[day][0].keys() | right[day][0].keys()):
            a, b = left[day][0].get(column), right[day][0].get(column)
            if a != b or (column in left[day][0]) != (column in right[day][0]):
                differences.append({"date": day, "column": column, "raw": a, "repair": b,
                                    "raw_present": column in left[day][0], "repair_present": column in right[day][0]})
    return {"added_dates": sorted(right.keys() - left.keys()), "missing_dates": sorted(left.keys() - right.keys()),
            "differences": differences, "changed_value_count": sum(row["column"] != "Repaired?" for row in differences)}


def runtime_versions():
    versions = {"python": sys.version}
    for package in ("pandas", "numpy", "yfinance", "scikit-learn", "scipy"):
        try:
            versions[package] = package_metadata.version(package)
        except package_metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def fetch(symbol, stop_marker=None):
    import yfinance as yf
    result = {"symbol": symbol, "runtime_versions": runtime_versions(), "yfinance_version": yf.__version__, "started_at": now(),
              "parameters": {"period": "2y", "interval": "1d", "auto_adjust": False, "actions": False,
                             "keepna": True, "raise_errors": True, "timeout": 20},
              "warning": "診斷用途；repair 為重建或啟發式轉換，不證明資料正確；兩次請求可能跨越供應者資料更新。未採用任何價格。"}
    for label, repair in (("raw", False), ("repair", True)):
        if stop_marker and Path(stop_marker).exists():
            result[label] = {"error": "STOP marker requested; request not started", "stopped": True}
            continue
        attempt = {"started_at": now(), "repair": repair}
        try:
            ticker = yf.Ticker(symbol)
            frame = ticker.history(**result["parameters"], repair=repair)
            metadata = ticker.get_history_metadata() or {}
            attempt.update(inspect(frame))
            attempt["identity"] = {key: clean(metadata[key]) for key in IDENTITY if key in metadata}
        except Exception as exc:
            attempt["error"] = str(exc)[:1000]
        attempt["finished_at"] = now()
        result[label] = attempt
    if "rows" in result["raw"] and "rows" in result["repair"]:
        result["comparison"] = compare(result["raw"], result["repair"])
    result["finished_at"] = now()
    return result


def write_new(path, value):
    with Path(path).open("x", encoding="utf-8") as handle:
        handle.write(encode(value) + "\n")


def run_worker(command, log, timeout, stop_marker):
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + timeout
    try:
        while True:
            if stop_marker.exists():
                return "stopped", None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "timeout", None
            try:
                code = process.wait(timeout=min(1, remaining))
                return ("completed" if code == 0 else "failed"), code
            except subprocess.TimeoutExpired:
                pass
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("symbols", nargs="+", help="At most five US symbols")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--per-symbol-seconds", type=int, default=180)
    parser.add_argument("--total-seconds", type=int, default=480)
    parser.add_argument("--stop-at", help="Timezone-aware ISO timestamp, e.g. harness deadline")
    parser.add_argument("--stop-marker", type=Path, default=ROOT / "STOP", help="Stop before downloads and terminate active worker when this file exists")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--worker-output", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    symbols = list(dict.fromkeys(symbol.upper() for symbol in args.symbols))
    if not 1 <= len(symbols) <= 5 or any(not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol) for symbol in symbols):
        parser.error("Supply one to five valid symbols")
    if args.worker:
        if len(symbols) != 1 or args.worker_output is None:
            parser.error("Invalid worker arguments")
        write_new(args.worker_output, fetch(symbols[0], args.stop_marker))
        return
    if not 1 <= args.per_symbol_seconds <= 180 or not 1 <= args.total_seconds <= 480:
        parser.error("Per-symbol deadline must be ≤180s; total deadline ≤480s")
    budget = args.total_seconds
    if args.stop_at:
        stop = datetime.fromisoformat(args.stop_at)
        if stop.tzinfo is None:
            parser.error("--stop-at requires an explicit timezone")
        budget = min(budget, (stop - datetime.now(timezone.utc)).total_seconds())
    folder = args.output_dir or ROOT / "artifacts" / ("price-repair-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False, mode=0o700)
    deadline = time.monotonic() + budget
    outcomes = []
    for symbol in symbols:
        remaining = deadline - time.monotonic()
        if args.stop_marker.exists():
            outcomes.append({"symbol": symbol, "status": "not_started_stop_marker"})
            continue
        if remaining <= 0:
            outcomes.append({"symbol": symbol, "status": "not_started_deadline"})
            continue
        path = folder / f"{symbol}.json"
        with (folder / f"{symbol}.log").open("x") as log:
            status, code = run_worker([sys.executable, str(Path(__file__).resolve()), symbol, "--worker", "--worker-output", str(path), "--stop-marker", str(args.stop_marker)],
                                      log, min(args.per_symbol_seconds, remaining), args.stop_marker)
        outcome = {"symbol": symbol, "status": status}
        if code is not None:
            outcome["exit_code"] = code
        outcomes.append(outcome)
    write_new(folder / "manifest.json", {"finished_at": now(), "outcomes": outcomes, "adopted": False})
    print(folder)


if __name__ == "__main__":
    main()
