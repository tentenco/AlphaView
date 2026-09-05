import json
import os
import sqlite3
import threading
from functools import wraps
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def now():
    return datetime.now(timezone.utc).isoformat()


def db_path():
    return Path(os.getenv("PANEL_DB_PATH", str(ROOT / "data/panel.db")))


_read_scope = threading.local()


@contextmanager
def read_snapshot():
    """Reuse one query-only snapshot in this synchronous thread, never workers.

    Nested read helpers share it. Writes fail at SQLite rather than escaping to
    another connection. The thread-local scope is always removed before return.
    """
    if getattr(_read_scope, "connection", None) is not None:
        yield
        return
    with connect() as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        _read_scope.connection = db
        _read_scope.path = db_path().resolve()
        try:
            yield
        finally:
            del _read_scope.connection
            del _read_scope.path


def snapshot_read(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with read_snapshot():
            return function(*args, **kwargs)
    return wrapped


@contextmanager
def connect():
    path = db_path()
    shared = getattr(_read_scope, "connection", None)
    if shared is not None and _read_scope.path == path.resolve():
        yield shared
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS positions (
            symbol TEXT PRIMARY KEY, name TEXT NOT NULL, shares REAL NOT NULL DEFAULT 0,
            cost REAL, sector TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
            snapshot_price REAL, snapshot_change REAL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS market_universe (
            symbol TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
            discovered_at TEXT NOT NULL, market_cap REAL
        );
        CREATE TABLE IF NOT EXISTS market_universe_metadata (
            id INTEGER PRIMARY KEY CHECK(id=1), requested_limit INTEGER NOT NULL,
            provider_total INTEGER, raw_count INTEGER NOT NULL,
            accepted_count INTEGER NOT NULL, pages INTEGER NOT NULL,
            discovered_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bars (
            symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL,
            high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
            adj_close REAL NOT NULL, volume REAL NOT NULL,
            PRIMARY KEY(symbol, date)
        );
        CREATE TABLE IF NOT EXISTS datasets (
            symbol TEXT PRIMARY KEY, name TEXT, currency TEXT, exchange TEXT,
            fetched_at TEXT, last_date TEXT, bar_count INTEGER DEFAULT 0,
            status TEXT, error TEXT, source TEXT NOT NULL DEFAULT 'Yahoo Finance / yfinance'
        );
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            as_of TEXT NOT NULL, universe TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backtests (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            symbol TEXT NOT NULL, strategy TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS research_notes (
            symbol TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, progress TEXT,
            result TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS refresh_schedule (
            id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
            scope TEXT NOT NULL DEFAULT 'market' CHECK(scope IN ('market','portfolio')),
            universe_limit INTEGER NOT NULL DEFAULT 250 CHECK(universe_limit IN (250,500,1000)),
            version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schedule_attempts (
            session_date TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL, universe_limit INTEGER NOT NULL, claimed_at TEXT NOT NULL
        );
        """)
        db.execute("INSERT OR IGNORE INTO refresh_schedule(id,updated_at) VALUES (1,?)", (now(),))
        for table in ("scans", "jobs"):
            if "scope" not in {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'portfolio'")
        if "cancel_requested" not in {r["name"] for r in db.execute("PRAGMA table_info(jobs)")}:
            db.execute("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0")
        db.execute("CREATE INDEX IF NOT EXISTS idx_scan_scope_date ON scans(scope,as_of,id)")


def universe(scope="portfolio"):
    if scope == "portfolio":
        return positions()
    with connect() as db:
        return [dict(r) for r in db.execute("SELECT * FROM market_universe ORDER BY symbol")]


# Public starter symbols contain no account balances or cost basis.
SEED = [
    ("AAPL", "Apple", "科技"),
    ("MSFT", "Microsoft", "科技"),
    ("GOOGL", "Alphabet", "通訊服務"),
    ("AMZN", "Amazon", "非必需消費"),
    ("META", "Meta Platforms", "通訊服務"),
    ("NVDA", "NVIDIA", "半導體"),
    ("TSLA", "Tesla", "電動車"),
]


def seed_portfolio():
    """Add an optional starter watchlist without changing existing positions."""
    init_db()
    with connect() as db:
        for symbol, name, sector in SEED:
            db.execute("""INSERT OR IGNORE INTO positions
                (symbol,name,shares,cost,sector,source,updated_at)
                VALUES (?,?,0,NULL,?,'初始觀察清單',?)""",
                (symbol, name, sector, now()))


def positions():
    with connect() as db:
        return [dict(r) for r in db.execute("SELECT * FROM positions ORDER BY symbol")]


def dataset_rows():
    with connect() as db:
        return [dict(r) for r in db.execute("SELECT * FROM datasets ORDER BY symbol")]


def history(symbol):
    import pandas as pd
    with connect() as db:
        return pd.read_sql_query("SELECT * FROM bars WHERE symbol=? ORDER BY date", db, params=(symbol,))


def latest_scan(as_of=None, scope="portfolio"):
    with connect() as db:
        row = db.execute("SELECT * FROM scans WHERE scope=? " + ("AND as_of=? " if as_of else "") +
                         "ORDER BY id DESC LIMIT 1", (scope, as_of) if as_of else (scope,)).fetchone()
    if not row:
        return None
    return {**dict(row), "universe": json.loads(row["universe"]), "result": json.loads(row["result"])}
