"""Append-only yfinance-returned action evidence; never applies ledger adjustments.

The adapter itself normalizes/fills its columns, so this is not Yahoo wire data
and column coverage does not prove the upstream action feed is complete.
"""
import hashlib
import json
import math
from numbers import Real

from . import store

ENGINE_VERSION = "alphaview-corporate-action-evidence-v1"
SOURCE = "Yahoo Finance / yfinance"
MAX_ROWS = 800
MAX_BYTES = 1_000_000
MAX_COMMIT_ATTEMPTS = 3
FIELDS = {"Dividends": "cash_dividend", "Stock Splits": "stock_split"}
BAR_COLUMNS = "date,open,high,low,close,adj_close,volume"


class PublicationConflict(ValueError):
    """Stale publication, not a failure of the latest stored provider dataset."""


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS corporate_action_evidence (
        symbol TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
        fingerprint TEXT NOT NULL, first_fetched_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(symbol,revision), UNIQUE(symbol,fingerprint)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS corporate_action_coverage (
        symbol TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0),
        evidence_revision INTEGER NOT NULL, previous_evidence_revision INTEGER,
        fetched_at TEXT NOT NULL, bars_fingerprint TEXT NOT NULL,
        input_revision TEXT NOT NULL, coverage_json TEXT NOT NULL,
        FOREIGN KEY(symbol,evidence_revision) REFERENCES corporate_action_evidence(symbol,revision)
    )""")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def bars_fingerprint(db, symbol):
    digest = hashlib.sha256()
    for row in db.execute(f"SELECT {BAR_COLUMNS} FROM bars WHERE symbol=? ORDER BY date", (symbol,)):
        # repr preserves malformed/non-finite existing rows without JSON inventing a value.
        digest.update(repr(tuple(row)).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def symbol_identity(db, symbol):
    dataset = db.execute("SELECT * FROM datasets WHERE symbol=?", (symbol,)).fetchone()
    head = db.execute("SELECT * FROM corporate_action_coverage WHERE symbol=?", (symbol,)).fetchone()
    return (bars_fingerprint(db, symbol), tuple(dataset) if dataset else None, tuple(head) if head else None)


def capture_identity(symbol):
    with store.read_snapshot(), store.connect() as db:
        return symbol_identity(db, symbol)


def _cell(value):
    raw_type = type(value).__name__
    # Do not coerce strings or bools to amounts. Store the adapter-returned text
    # and numeric repr, without rounding or NaN JSON tokens.
    if value is None:
        return {"raw_type": raw_type, "raw_value": None, "value": None, "reason": "missing_value"}
    raw = str(value) if isinstance(value, str) else repr(value.item() if hasattr(value, "item") else value)
    if len(raw) > 256:
        raise ValueError("公司行動欄位超過可保存長度；未替換原有資料")
    result = {"raw_type": raw_type, "raw_value": raw, "value": None, "reason": None}
    if isinstance(value, (bool,)) or raw_type == "bool_" or not isinstance(value, Real):
        result["reason"] = "non_numeric_value"
    elif not math.isfinite(float(value)):
        result["reason"] = "non_finite_value"
    elif float(value) < 0:
        result["reason"] = "negative_value"
    else:
        result["value"] = float(value)
    return result


def prepare(frame, adapter_version):
    """Retain nonzero/unknown cells exactly; daily zeros are coverage counts only."""
    if not 1 <= len(frame) <= MAX_ROWS:
        raise ValueError(f"公司行動擷取需有 1–{MAX_ROWS} 筆日線；未替換原有資料")
    events, columns = [], {}
    for field, kind in FIELDS.items():
        present = field in frame.columns
        counts = {"present": present, "checked": len(frame) if present else 0,
                  "zero": 0, "events": 0, "unavailable": 0 if present else len(frame)}
        if present:
            for day, value in zip(frame["date"].tolist(), frame[field].tolist()):
                cell = _cell(value)
                if cell["reason"]:
                    counts["unavailable"] += 1
                elif cell["value"] == 0:
                    counts["zero"] += 1
                    continue
                else:
                    counts["events"] += 1
                events.append({"ex_date": day, "kind": kind, **cell})
        columns[field] = counts
    payload = {"engine_version": ENGINE_VERSION, "source": SOURCE, "adapter_version": str(adapter_version),
               "source_completeness": "unknown", "value_basis": "adapter_returned_not_wire_payload",
               "columns_present": {field: entry["present"] for field, entry in columns.items()},
               "events": sorted(events, key=lambda event: (event["ex_date"], event["kind"]))}
    coverage = {"first": frame["date"].min(), "last": frame["date"].max(), "rows": len(frame),
                "requested_period": "2y", "columns": columns,
                "unavailable_cells": sum(entry["unavailable"] for entry in columns.values()),
                "source_completeness": "unknown"}
    payload_json, coverage_json = _json(payload), _json(coverage)
    if len(payload_json.encode()) + len(coverage_json.encode()) > MAX_BYTES:
        raise ValueError("公司行動證據超過保存上限；未替換原有資料")
    return {"payload": payload, "payload_json": payload_json, "coverage_json": coverage_json,
            "fingerprint": _hash(payload)}


def _commit_snapshot(symbol, expected_identity):
    with store.read_snapshot(), store.connect() as db:
        if symbol_identity(db, symbol) != expected_identity:
            raise PublicationConflict("同一標的在下載期間已更新；未替換原有資料，請重試")
        return store.input_revision(db)


def publish(symbol, records, dataset, prepared, expected_identity):
    """One fetch, bounded commit-only retry; publication always checks global CAS."""
    for _attempt in range(MAX_COMMIT_ATTEMPTS):
        expected_revision = _commit_snapshot(symbol, expected_identity)
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if symbol_identity(db, symbol) != expected_identity:
                raise PublicationConflict("同一標的在下載期間已更新；未替換原有資料，請重試")
            if store.input_revision(db) != expected_revision:
                continue
            fetched_at = store.now()
            db.execute("DELETE FROM bars WHERE symbol=?", (symbol,))
            db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", records)
            db.execute("""INSERT INTO datasets
                (symbol,name,currency,exchange,fetched_at,last_date,bar_count,status,error)
                VALUES (?,?,?,?,?,?,?,'ok',NULL) ON CONFLICT(symbol) DO UPDATE SET
                name=excluded.name,currency=excluded.currency,exchange=excluded.exchange,
                fetched_at=excluded.fetched_at,last_date=excluded.last_date,
                bar_count=excluded.bar_count,status='ok',error=NULL""",
                (symbol, dataset["name"], dataset["currency"], dataset["exchange"], fetched_at,
                 dataset["last_date"], len(records)))
            previous = db.execute("SELECT * FROM corporate_action_coverage WHERE symbol=?", (symbol,)).fetchone()
            existing = db.execute("SELECT revision FROM corporate_action_evidence WHERE symbol=? AND fingerprint=?",
                                  (symbol, prepared["fingerprint"])).fetchone()
            if existing:
                revision = existing["revision"]
            else:
                revision = db.execute("SELECT COALESCE(MAX(revision),0)+1 FROM corporate_action_evidence WHERE symbol=?", (symbol,)).fetchone()[0]
                db.execute("INSERT INTO corporate_action_evidence VALUES (?,?,?,?,?)",
                           (symbol, revision, prepared["fingerprint"], fetched_at, prepared["payload_json"]))
            previous_revision = (previous["evidence_revision"] if previous and previous["evidence_revision"] != revision
                                 else previous["previous_evidence_revision"] if previous else None)
            db.execute("""INSERT INTO corporate_action_coverage VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(symbol) DO UPDATE SET version=excluded.version,
                evidence_revision=excluded.evidence_revision,previous_evidence_revision=excluded.previous_evidence_revision,
                fetched_at=excluded.fetched_at,bars_fingerprint=excluded.bars_fingerprint,
                input_revision=excluded.input_revision,coverage_json=excluded.coverage_json""",
                (symbol, previous["version"] + 1 if previous else 1, revision, previous_revision, fetched_at,
                 bars_fingerprint(db, symbol), store.input_revision(db), prepared["coverage_json"]))
            return
    raise PublicationConflict("輸入資料在發布前持續變更；未替換原有資料，請重試")


def _changes(previous, current, first, last):
    old = {(event["ex_date"], event["kind"]): event for event in previous["events"] if first <= event["ex_date"] <= last}
    new = {(event["ex_date"], event["kind"]): event for event in current["events"]}
    changes = []
    for key in sorted(old.keys() | new.keys()):
        if old.get(key) == new.get(key):
            continue
        changes.append({"ex_date": key[0], "kind": key[1],
                        "status": "changed" if key in old and key in new else "newly_reported" if key in new else "not_reported_in_latest_capture",
                        "previous_raw_value": old.get(key, {}).get("raw_value"),
                        "current_raw_value": new.get(key, {}).get("raw_value")})
    return changes


def summary(db, symbol, inferred, start, end):
    head = db.execute("SELECT * FROM corporate_action_coverage WHERE symbol=?", (symbol,)).fetchone()
    if head is None:
        return {"symbol": symbol, "engine_version": ENGINE_VERSION, "status": "unavailable",
                "reason": "not_captured", "source_completeness": "unknown", "events": [], "comparisons": [], "changes": []}
    stored = db.execute("SELECT * FROM corporate_action_evidence WHERE symbol=? AND revision=?",
                        (symbol, head["evidence_revision"])).fetchone()
    payload, coverage = json.loads(stored["payload_json"]), json.loads(head["coverage_json"])
    dataset = db.execute("SELECT status,error,fetched_at FROM datasets WHERE symbol=?", (symbol,)).fetchone()
    reasons = []
    if bars_fingerprint(db, symbol) != head["bars_fingerprint"]:
        reasons.append("bars_changed")
    if dataset is None or dataset["status"] != "ok" or dataset["error"]:
        reasons.append("source_update_failed")
    elif dataset["fetched_at"] != head["fetched_at"]:
        reasons.append("capture_not_aligned")
    if coverage["last"] < end:
        reasons.append("coverage_ends_before_as_of")
    events = [event for event in payload["events"] if (start is None or event["ex_date"] >= start) and event["ex_date"] <= end]
    inferred_days = {(event["ex_date"], "cash_dividend" if event["kind"] == "dividend" else "stock_split")
                     for event in inferred if event["kind"] in ("dividend", "suspected_split")}
    reported = {(event["ex_date"], event["kind"]) for event in events if event["reason"] is None}
    comparisons = []
    for day, kind in sorted(inferred_days | reported):
        present = payload["columns_present"]["Dividends" if kind == "cash_dividend" else "Stock Splits"]
        in_window = coverage["first"] <= day <= coverage["last"]
        unknown_cell = any(event["ex_date"] == day and event["kind"] == kind and event["reason"] for event in events)
        status = ("inconclusive" if reasons or not present or not in_window or unknown_cell else
                  "same_date_and_kind" if (day, kind) in inferred_days & reported else
                  "inferred_without_reported_event" if (day, kind) in inferred_days else "reported_without_inference")
        comparisons.append({"ex_date": day, "kind": kind, "status": status,
                            "amount_comparison": "inconclusive_adjustment_basis"})
    changes = []
    if head["previous_evidence_revision"] is not None:
        previous = db.execute("SELECT payload_json FROM corporate_action_evidence WHERE symbol=? AND revision=?",
                              (symbol, head["previous_evidence_revision"])).fetchone()
        changes = _changes(json.loads(previous[0]), payload, coverage["first"], coverage["last"])
        changes = [change for change in changes if (start is None or change["ex_date"] >= start) and change["ex_date"] <= end]
    return {"symbol": symbol, **{key: value for key, value in payload.items() if key != "events"},
            "status": "stale" if reasons else "partial" if coverage["unavailable_cells"] else "available",
            "freshness_reasons": reasons, "capture_version": head["version"], "evidence_revision": head["evidence_revision"],
            "previous_evidence_revision": head["previous_evidence_revision"], "fetched_at": head["fetched_at"],
            "captured_input_revision": head["input_revision"], "coverage": coverage,
            "events": events, "comparisons": comparisons, "changes": changes}
