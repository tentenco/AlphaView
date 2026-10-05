"""Pure, bounded historical-prefix signals over caller-frozen raw inputs.

This is an R0 diagnostic, not an allocation, accounting, or execution engine.
The caller supplies every symbol and immutable data identity. No workspace,
provider, scheduler, or current-time lookup participates in evaluation.
"""
from collections.abc import Mapping
from datetime import date, datetime
from hashlib import sha256
from importlib.metadata import version
import json
import math
import re

import numpy as np
import pandas as pd

from . import market, research, sessions
from .scan_provenance import SCAN_ENGINE_VERSION

ENGINE_VERSION = "alphaview-paper-replay-prefix-v1"
SCHEMA_VERSION = "alphaview-paper-replay-prefix-schema-v1"
FINGERPRINT_VERSION = "alphaview-paper-replay-prefix-sha256-v1"
MAX_SYMBOLS = 50
MAX_CAPTURE_ROWS = 500_000
MAX_CELL_TEXT = 256
MAX_ISSUE_EXAMPLES = 20
MIN_YEAR, MAX_YEAR = 1990, 2100
MAX_PREFIX_YEAR_SPAN = 6
RAW_COLUMNS = ("date", "open", "high", "low", "close", "adj_close", "volume")
_SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.\-^=]{0,19}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"))


def _dated(value):
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _scalar(value):
    """Canonicalize raw scalar meaning independent of pandas column dtype."""
    if isinstance(value, np.generic):
        value = value.item()
    if value is None or value is pd.NA or value is pd.NaT:
        return {"missing": True}
    if isinstance(value, (date, datetime)):
        value = str(value)
    if isinstance(value, str):
        if len(value) > MAX_CELL_TEXT:
            raise ValueError(f"Raw scalar text exceeds {MAX_CELL_TEXT} characters")
        return value
    if isinstance(value, int):
        if value.bit_length() > 1024:
            raise ValueError("Raw integers exceed the 1024-bit scalar bound")
        try:
            converted = float(value)
        except OverflowError:
            converted = math.inf if value > 0 else -math.inf
        if not math.isfinite(converted) or int(converted) != value:
            # Preserve a changed raw integer even when indicator float64 cannot
            # distinguish it. Exactly representable ints still match floats.
            return {"integer": str(value)}
    if isinstance(value, (int, float)):
        try:
            number = float(value)
        except OverflowError:
            return {"number": "overflow", "sign": 1 if value > 0 else -1}
        if math.isnan(number):
            return {"missing": True}
        if math.isinf(number):
            return {"number": "infinity", "sign": 1 if number > 0 else -1}
        return number if number else 0.0
    raise ValueError("Raw cells must be scalar text, numbers, dates, or missing values")


def _restore(value):
    if isinstance(value, dict):
        if "invalid_date" in value:
            return f"<{value['type']}:{value['invalid_date']}>"
        if "integer" in value:
            return float(value["integer"])
        return np.nan if "missing" in value else value["sign"] * np.inf
    return value


def _date_scalar(value):
    # A date object must not become an accepted ISO string *after* cutoff.
    # Non-string dates have unknown temporal placement under this contract.
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, (date, datetime)):
        return {"invalid_date": str(value), "type": "datetime" if isinstance(value, datetime) else "date"}
    return _scalar(value)


def _identity(value):
    if not isinstance(value, Mapping) or set(value) != {"source", "currency", "exchange"}:
        raise ValueError("Each identity requires exactly source, currency, and exchange")
    result = dict(value)
    for key, item in result.items():
        if key == "exchange" and item is None:
            continue
        if not isinstance(item, str) or not item.strip() or len(item) > MAX_CELL_TEXT:
            raise ValueError("Identity fields must be explicit bounded nonempty strings (exchange may be null)")
    return result


def _prefix(frame, as_of):
    if not isinstance(frame, pd.DataFrame) or not frame.columns.is_unique:
        raise ValueError("Each raw input must be a DataFrame with unique columns")
    columns = [column for column in RAW_COLUMNS if column in frame]
    # Inspect dates first. Future values, even corrupt ones, never reach value
    # validation, indicators, or the fingerprint. Undatable rows stay present.
    # pandas emits no tuples for zero selected columns; retain the observations
    # as undatable empty records so missing-column lineage/counts do not vanish.
    records = [[] for _ in range(len(frame))] if not columns else []
    for row in frame.loc[:, columns].itertuples(index=False, name=None):
        raw = dict(zip(columns, row))
        raw_date = raw.get("date")
        if _dated(raw_date) and raw_date > as_of:
            continue
        # Numeric text keeps its raw identity; existing research methods decide
        # whether it can be parsed. Float conversion must not erase revisions.
        records.append([_date_scalar(raw[column]) if column == "date" else _scalar(raw[column])
                        for column in columns])
    records.sort(key=_json)
    # Reconstruct only admitted canonical columns; caller attrs/derived columns
    # never enter the calculation, and the caller's DataFrames stay untouched.
    prefix = pd.DataFrame([[_restore(value) for value in row] for row in records],
                          columns=columns, index=range(len(records)))
    return prefix, {"columns": columns, "rows": records}


def _quality(prefix):
    dated = sorted(value for value in prefix.get("date", []) if _dated(value))
    if dated and (int(dated[0][:4]) < MIN_YEAR or int(dated[-1][:4]) > MAX_YEAR
                  or int(dated[-1][:4]) - int(dated[0][:4]) > MAX_PREFIX_YEAR_SPAN):
        return {"status": "data_error", "valid": False, "checked_rows": len(prefix),
                "invalid_count": 1, "issues": [{"date": None,
                "reason": "Observed prefix exceeds supported calendar years or six-year span"}]}
    try:
        return market.history_quality(prefix)
    except (ValueError, OverflowError) as error:
        # Calendar unavailability is explicit; never substitute weekdays.
        return {"status": "data_error", "valid": False, "checked_rows": len(prefix),
                "invalid_count": 1, "issues": [{"date": None,
                "reason": f"Prefix calendar validation unavailable: {type(error).__name__}"}]}


def evaluate_prefix(raw_by_symbol, as_of, *, identities):
    """Return finite JSON signals for an explicit fixed pool at one XNYS date.

    DataFrame dates use strict ISO session labels. Identities have exactly
    ``source``, ``currency``, and ``exchange`` (the latter may be null). The
    caller freezes these inputs before calling; no store capture occurs here.
    Invalid raw data yields unavailable signals, while malformed requests or
    admission limits raise ValueError. Limits include *all* captured rows, so
    future-invariance applies to admitted requests, not admission failures.
    """
    if not _dated(as_of) or not MIN_YEAR <= int(as_of[:4]) <= MAX_YEAR:
        raise ValueError(f"as_of must be an ISO date within {MIN_YEAR}..{MAX_YEAR}")
    try:
        is_session = sessions.calendar(int(as_of[:4])).is_session(pd.Timestamp(as_of))
    except (ValueError, OverflowError) as error:
        raise ValueError("as_of is outside the supported XNYS calendar") from error
    if not is_session:
        raise ValueError("as_of must be an XNYS trading session")
    if not isinstance(raw_by_symbol, Mapping) or not 1 <= len(raw_by_symbol) <= MAX_SYMBOLS:
        raise ValueError(f"Explicit fixed pool must contain 1..{MAX_SYMBOLS} symbols")
    if any(not isinstance(symbol, str) or not _SYMBOL.fullmatch(symbol) for symbol in raw_by_symbol):
        raise ValueError("Symbols must be explicit canonical uppercase symbols")
    if not isinstance(identities, Mapping) or set(identities) != set(raw_by_symbol):
        raise ValueError("Identities must exactly match the fixed symbol pool")
    if any(not isinstance(frame, pd.DataFrame) for frame in raw_by_symbol.values()):
        raise ValueError("Each raw input must be a DataFrame")
    if sum(len(frame) for frame in raw_by_symbol.values()) > MAX_CAPTURE_ROWS:
        raise ValueError(f"Capture exceeds {MAX_CAPTURE_ROWS} rows")
    methods = {"engine_version": ENGINE_VERSION, "schema_version": SCHEMA_VERSION,
               "fingerprint_version": FINGERPRINT_VERSION, "scan_engine_version": SCAN_ENGINE_VERSION,
               "calendar": "XNYS", "exchange_calendars_version": version("exchange-calendars"),
               "pandas_version": pd.__version__, "numpy_version": np.__version__}
    manifest = {"methods": methods, "as_of": as_of, "inputs": []}
    frames, prefixes, qualities, frozen_identities = {}, {}, {}, {}
    for symbol in sorted(raw_by_symbol):
        identity = _identity(identities[symbol])
        prefix, canonical = _prefix(raw_by_symbol[symbol], as_of)
        quality = _quality(prefix)
        prefixes[symbol], qualities[symbol], frozen_identities[symbol] = prefix, quality, identity
        manifest["inputs"].append({"symbol": symbol, "identity": identity, "raw_prefix": canonical})
        if quality["status"] != "data_error":
            frames[symbol] = research.indicators(prefix)
    computed = {row["symbol"]: row for row in research.evaluate(frames, as_of)}
    rows, peers = [], []
    for symbol in sorted(prefixes):
        prefix, quality = prefixes[symbol], qualities[symbol]
        observed_dates = sorted(value for value in prefix.get("date", []) if _dated(value))
        if symbol in computed:
            row = computed[symbol]
        else:
            reason = "日線資料異常，暫不產生訊號：" + "；".join(
                f"{issue['date'] or '日期未知'} {issue['reason']}" for issue in quality["issues"][:3])
            row = {"symbol": symbol, "date": observed_dates[-1] if observed_dates else None,
                   "bars": len(prefix), "indicators": {}, "signals": [
                       {"strategy": strategy["id"], "status": "data_error", "matched": False, "reason": reason}
                       for strategy in research.STRATEGIES]}
        if symbol in frames and quality["valid"] and len(frames[symbol]) >= 121:
            last = frames[symbol].iloc[-1]
            if last.date == as_of and np.isfinite(last[research.SIGNAL_METRICS["rps"]].astype(float)).all():
                peers.append(symbol)
        row["quality"] = {**quality, "issues": quality["issues"][:MAX_ISSUE_EXAMPLES],
                          "issues_truncated": len(quality["issues"]) > MAX_ISSUE_EXAMPLES}
        row["identity"] = frozen_identities[symbol]
        row["first_observed_session"] = observed_dates[0] if observed_dates else None
        row["missing_reasons"] = [dict(signal) for signal in row["signals"]
                                  if signal["status"] not in {"match", "watch"}]
        rows.append(row)
    strategy_coverage = {strategy["id"]: sum(signal["status"] in {"match", "watch"}
                          for row in rows for signal in row["signals"] if signal["strategy"] == strategy["id"])
                         for strategy in research.STRATEGIES}
    result = {**methods, "as_of": as_of, "fingerprint": sha256(_json(manifest).encode()).hexdigest(),
              "coverage": {"requested": len(rows), "valid": sum(row["quality"]["valid"] for row in rows),
                           "current": sum(row["quality"]["valid"] and row["date"] == as_of for row in rows),
                           "complete": sum(not row["missing_reasons"] for row in rows),
                           "rps_peers": len(peers), "rps_minimum_peers": 3,
                           "rps_peer_symbols": peers, "strategies": strategy_coverage},
              "symbols": rows}
    # Keep the public contract JSON-safe even when a raw value overflows.
    _json(result)
    return result
