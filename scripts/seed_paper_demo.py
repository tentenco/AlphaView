"""Create a new, explicitly synthetic UI review workspace under artifacts/.

Never reads or modifies the real workspace. Refuses existing destination files.
No provider calls: all bars are generated fixtures labelled synthetic.
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
import math
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def seed(destination, with_paper_history=False):
    destination = Path(destination).resolve()
    if not destination.is_relative_to((ROOT / "artifacts").resolve()):
        raise ValueError("Synthetic review databases must be under artifacts/.")
    if destination.exists():
        raise ValueError("Destination already exists; choose a new synthetic workspace.")
    os.environ["PANEL_DB_PATH"] = str(destination)
    from alphaview.panel import research, sessions, store

    store.init_db()
    as_of = sessions.latest_completed_session()
    days = sessions.expected_sessions((date.fromisoformat(as_of) - timedelta(days=600)).isoformat(), as_of)[-300:]
    with store.connect() as db:
        for index, symbol in enumerate(("SYNTA", "SYNTB", "SYNTC", "SYNTD")):
            db.execute("INSERT INTO market_universe(symbol,name,source,discovered_at,market_cap) VALUES (?,?,?,?,?)",
                       (symbol, f"Synthetic review asset {index + 1}", "synthetic UI fixture", store.now(), 1_000_000_000))
            db.execute("INSERT INTO positions(symbol,name,shares,cost,sector,source,updated_at) VALUES (?,?,0,NULL,?,?,?)",
                       (symbol, f"Synthetic review asset {index + 1}", "Synthetic", "synthetic UI fixture", store.now()))
            for offset, day in enumerate(days):
                trend = (0.11 + index * 0.035) * offset if index < 3 else -0.02 * offset
                price = 40 + index * 20 + trend + math.sin(offset / 13) * 0.8
                close = round(price, 6)
                opened = round(price - 0.12, 6)
                db.execute("INSERT INTO bars(symbol,date,open,high,low,close,adj_close,volume) VALUES (?,?,?,?,?,?,?,?)",
                           (symbol, day, opened, close + 0.6, opened - 0.6, close, close, 1_000_000 + offset * 1000))
            db.execute("INSERT INTO datasets(symbol,name,currency,exchange,fetched_at,last_date,bar_count,status,source) VALUES (?,?,?,?,?,?,?,?,?)",
                       (symbol, f"Synthetic review asset {index + 1}", "USD", "NMS", store.now(), as_of, len(days), "ok", "synthetic UI fixture; not market data"))
    research.scan(scope="market")
    research.scan(scope="portfolio")
    result = {"database": str(destination), "synthetic": True, "as_of": as_of, "symbols": 4, "bars_per_symbol": len(days)}
    if with_paper_history:
        result["paper_history"] = add_synthetic_paper_history(destination)
    return result


def add_synthetic_paper_history(destination):
    """Replay generated fixtures through real paper functions, never fabricate NAV rows."""
    destination = Path(destination).resolve()
    if not destination.is_relative_to((ROOT / "artifacts").resolve()) or not destination.is_file():
        raise ValueError("An existing synthetic artifacts database is required.")
    os.environ["PANEL_DB_PATH"] = str(destination)
    from alphaview.panel import paper_portfolio as paper, paper_analytics as analytics, sessions, store
    with store.connect() as db:
        datasets = [dict(row) for row in db.execute("SELECT symbol,source FROM datasets ORDER BY symbol")]
        if datasets != [{"symbol": symbol, "source": "synthetic UI fixture; not market data"} for symbol in ("SYNTA","SYNTB","SYNTC","SYNTD")]:
            raise ValueError("This is not the generated synthetic review workspace.")
        if db.execute("SELECT COUNT(*) FROM positions WHERE shares<>0 OR cost IS NOT NULL").fetchone()[0]:
            raise ValueError("Synthetic history refuses a workspace containing nonempty position inputs.")
        if db.execute("SELECT 1 FROM paper_accounts WHERE name IN ('Synthetic balanced history','Synthetic cash history','Synthetic gap history')").fetchone():
            raise ValueError("The synthetic history accounts already exist.")
    as_of = sessions.latest_completed_session()
    days = sessions.expected_sessions((date.fromisoformat(as_of)-timedelta(days=45)).isoformat(),as_of)[-20:]
    original_session, original_now = sessions.latest_completed_session, store.now
    current = days[0]
    accounts = []
    try:
        sessions.latest_completed_session = lambda *args: current
        store.now = lambda: f"{current}T21:00:00+00:00"
        for name in ("balanced", "cash", "gap"):
            account = paper.create_account(paper.AccountInput(name=f"Synthetic {name} history",initial_cash=10000,
                idempotency_key=f"synthetic-history-{name}-account",
                limits={"max_position_weight_pct":50,"max_turnover_pct":200,"min_cash_weight_pct":10},
                execution_policy={"fee_bps":5,"slippage_bps":8,"min_trade_notional":25,"share_precision":4}))["account"]
            accounts.append({"kind":name,"id":account["id"]})
        for index, day in enumerate(days):
            current = day
            for item in accounts:
                account = paper.account_snapshot(item["id"])["account"]
                if item["kind"] != "cash" and index in (0,10):
                    targets = ([{"symbol":"SYNTA","weight_pct":30 if index==0 else 25},
                                {"symbol":"SYNTB","weight_pct":30 if index==0 else 35},
                                {"symbol":"SYNTC","weight_pct":25}]
                               if item["kind"]=="balanced" else [{"symbol":"SYNTD","weight_pct":40 if index==0 else 35}])
                    proposal = paper.create_proposal(item["id"],paper.ProposalInput(expected_version=account["version"],targets=targets,
                        rationale="Synthetic historical UI fixture; no real market data.",idempotency_key=f"synthetic-history-{item['kind']}-{index}"))
                    if not proposal["executable"]:
                        raise ValueError("Synthetic fixture proposal unexpectedly blocked.")
                    account = paper.accept_proposal(item["id"],proposal["id"],paper.AcceptInput(expected_version=account["version"],
                        idempotency_key=f"synthetic-history-accept-{item['kind']}-{index}"))["account"]["account"]
                if not (item["kind"] == "gap" and index == 8):
                    analytics.capture_nav(item["id"],analytics.CaptureInput(expected_version=account["version"]))
        return {"synthetic":True,"sessions":len(days),"start":days[0],"end":days[-1],"deliberate_gap":days[8],"accounts":accounts,
                "method":"Generated bars replayed through actual paper creation, execution, and NAV capture functions with an isolated fixture clock. Not historical market performance."}
    finally:
        sessions.latest_completed_session, store.now = original_session, original_now


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--with-paper-history", action="store_true", help="Include 20 generated sessions for three synthetic paper accounts.")
    args = parser.parse_args()
    print(json.dumps(seed(args.database, args.with_paper_history), indent=2))
