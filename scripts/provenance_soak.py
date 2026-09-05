#!/usr/bin/env python3
"""Bounded synthetic SQLite provenance soak. No network, live DB, or private output."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def utcnow():
    return datetime.now(timezone.utc)


def forbid_network():
    def denied(*args, **kwargs):
        raise RuntimeError("Network is disabled for this synthetic provenance soak")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied


def writer():
    if os.environ.get("ALPHAVIEW_PROVENANCE_SOAK") != "1":
        raise RuntimeError("Synthetic environment required")
    with sqlite3.connect(os.environ["PANEL_DB_PATH"], timeout=2) as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")


def seed():
    from alphaview.panel import sessions, store
    store.init_db()
    days = sessions.expected_sessions("2024-01-02", "2025-12-31")[-250:]
    with store.connect() as db:
        for index, symbol in enumerate(("SYNTA", "SYNTB", "SYNTC")):
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,? ,0,'synthetic','now')", (symbol, "Synthetic fixture"))
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',3000000000)", (symbol, "Synthetic fixture"))
            bars = []
            for offset, day in enumerate(days):
                price = 100 + index * 10 + offset * .02 + math.sin(offset / 6)
                bars.append((symbol, day, price, price + 1, price - 1, price, price, 1000000.))
            db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", bars)
    return days[-1]


def cycle(as_of, *, subprocess_writer=False, check=lambda: None):
    from alphaview.panel import research, sessions, store
    from alphaview.panel.api import stock
    from alphaview.panel.scan_context import decorate
    check()
    with patch.object(sessions, "latest_completed_session", return_value=as_of):
        token = store.input_revision()
        for scope in ("portfolio", "market"):
            research.scan(scope=scope, check_cancel=check)
        assert store.input_revision() == token, "Scan publication changed input token"
        assert all(decorate(store.latest_scan(scope=scope))["input_status"] == "current" for scope in ("portfolio", "market"))
        assert stock("SYNTA", scope="portfolio")["position"]["research_context"]["available"]
        with store.connect() as db:
            db.execute("UPDATE bars SET close=close*1.0001,adj_close=adj_close*1.0001,high=MAX(high,close*1.0001+1) WHERE symbol='SYNTA' AND date=?", (as_of,))
        assert store.input_revision() != token
        stale = stock("SYNTA", scope="portfolio")["position"]
        assert stale["research"] is None and stale["research_context"]["input_status"] == "stale"
        for scope in ("portfolio", "market"):
            research.scan(scope=scope, check_cancel=check)
        assert stock("SYNTA", scope="portfolio")["position"]["research_context"]["available"]
        retained = {scope: store.latest_scan(scope=scope)["id"] for scope in ("portfolio", "market")}
        changed = False
        def mutate(message):
            nonlocal changed
            check()
            if changed:
                return
            changed = True
            if subprocess_writer:
                subprocess.run([sys.executable, str(Path(__file__).resolve()), "--writer"], check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            else:
                with sqlite3.connect(store.db_path(), timeout=2) as db:
                    db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        try:
            research.scan(mutate, scope="portfolio", check_cancel=check)
        except ValueError as exc:
            assert "輸入資料已變更" in str(exc), "Unexpected publication error"
        else:
            raise AssertionError("Concurrent input mutation published stale results")
        assert changed
        assert all(store.latest_scan(scope=scope)["id"] == identifier for scope, identifier in retained.items())
        assert stock("SYNTA", scope="portfolio")["position"]["research"] is None
        # Bound synthetic disk growth; preserve latest snapshot for every scope/date.
        with store.connect() as db:
            db.execute("DELETE FROM scans WHERE id NOT IN (SELECT MAX(id) FROM scans GROUP BY scope,as_of)")
            count = db.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
        assert count <= 120
    return {"checks": 8, "symbols": 3, "bars_per_symbol": 250, "retained_scan_rows": count,
            "writer": "subprocess" if subprocess_writer else "connection"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=60)
    parser.add_argument("--interval", type=float, default=12)
    parser.add_argument("--cycles", type=int, help="Optional short validation run")
    parser.add_argument("--directory", type=Path, default=ROOT / "artifacts/harness-2026-09-05")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--writer", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    forbid_network()
    if args.writer:
        writer()
        return 0
    if not 0 < args.minutes <= 60 or not 0 < args.interval <= 60 or (args.cycles is not None and args.cycles < 1):
        parser.error("Invalid bounded duration/interval/cycle count")
    state = json.loads((args.directory / "state.json").read_text())
    harness_deadline = datetime.fromisoformat(state["deadline"].replace("Z", "+00:00")) - timedelta(seconds=60)
    started = utcnow()
    deadline = min(started + timedelta(minutes=args.minutes), harness_deadline)
    marker = args.directory / "STOP"
    output = args.output or args.directory / ("provenance-soak-" + started.strftime("%Y%m%dT%H%M%SZ") + ".jsonl")
    summary_path = output.with_suffix(".summary.json")
    if output.exists() or summary_path.exists():
        parser.error("Evidence already exists; refusing to overwrite")
    summary = {"started_at": started.isoformat(), "deadline": deadline.isoformat(), "synthetic": True,
               "network": False, "cycles": 0, "checks": 0, "failures": 0, "status": "running"}
    class Stopped(Exception):
        pass
    def check():
        if marker.exists() or utcnow() >= deadline:
            raise Stopped()
    previous_path = os.environ.get("PANEL_DB_PATH")
    previous_flag = os.environ.get("ALPHAVIEW_PROVENANCE_SOAK")
    try:
        with output.open("x", encoding="utf-8") as receipts, tempfile.TemporaryDirectory(prefix="alphaview-provenance-soak-") as folder:
            os.environ["PANEL_DB_PATH"] = str(Path(folder) / "synthetic.db")
            os.environ["ALPHAVIEW_PROVENANCE_SOAK"] = "1"
            check()
            as_of = seed()
            while True:
                check()
                began = time.monotonic()
                record = {"at": utcnow().isoformat(), "cycle": summary["cycles"] + 1}
                try:
                    details = cycle(as_of, subprocess_writer=summary["cycles"] % 3 == 2, check=check)
                    summary["checks"] += details["checks"]
                    record.update(status="passed", **details)
                except Stopped:
                    raise
                except Exception as exc:
                    summary["failures"] += 1
                    record.update(status="failed", error_type=type(exc).__name__)
                summary["cycles"] += 1
                record["elapsed_seconds"] = round(time.monotonic() - began, 3)
                receipts.write(json.dumps(record, ensure_ascii=False) + "\n")
                receipts.flush()
                if args.cycles is not None and summary["cycles"] >= args.cycles:
                    summary["status"] = "completed"
                    break
                wait_until = time.monotonic() + max(0, args.interval - (time.monotonic() - began))
                while time.monotonic() < wait_until:
                    check()
                    time.sleep(min(1, wait_until - time.monotonic()))
    except Stopped:
        summary["status"] = "stopped" if marker.exists() else "completed"
    finally:
        for key, value in (("PANEL_DB_PATH", previous_path), ("ALPHAVIEW_PROVENANCE_SOAK", previous_flag)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        summary["finished_at"] = utcnow().isoformat()
        with summary_path.open("x", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
        print(json.dumps({"receipts": str(output), "summary": str(summary_path), **summary}, ensure_ascii=False), flush=True)
    return 1 if summary["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
