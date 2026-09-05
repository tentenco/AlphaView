"""Explicit preview/confirmation for superseded scan snapshots only."""
import hashlib
import json
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from . import store
from .jobs import RUN_LOCK

router = APIRouter()
MAX_SECONDS = 15
MAX_SCAN_ROWS = 100_000
TABLE_PAYLOADS = {
    "positions": None, "market_universe": None, "market_universe_metadata": None,
    "bars": None, "datasets": None,
    "scans": "COALESCE(length(CAST(result AS BLOB)),0)+COALESCE(length(CAST(universe AS BLOB)),0)",
    "backtests": "COALESCE(length(CAST(result AS BLOB)),0)",
    "research_notes": "COALESCE(length(CAST(note AS BLOB)),0)+COALESCE(length(CAST(tags AS BLOB)),0)",
    "jobs": "COALESCE(length(CAST(result AS BLOB)),0)+COALESCE(length(CAST(progress AS BLOB)),0)+COALESCE(length(CAST(error AS BLOB)),0)",
    "refresh_schedule": None, "schedule_attempts": None,
}


def _size(path):
    try:
        return Path(path).stat().st_size
    except FileNotFoundError:
        return 0


def _snapshot(db):
    rows = db.execute(f"""SELECT id,scope,as_of,created_at,{TABLE_PAYLOADS['scans']} AS bytes
        FROM scans ORDER BY scope,as_of,id LIMIT ?""", (MAX_SCAN_ROWS + 1,)).fetchall()
    if len(rows) > MAX_SCAN_ROWS:
        raise HTTPException(503, "快照數量超過本地清理上限，請先備份並安排離線維護")
    latest = {(row["scope"], row["as_of"]): row["id"] for row in rows}
    old = [row for row in rows if latest[row["scope"], row["as_of"]] != row["id"]]
    fingerprint = hashlib.sha256(json.dumps([tuple(row) for row in rows], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    tables = []
    for table, payload in TABLE_PAYLOADS.items():
        count, size = db.execute(f"SELECT COUNT(*), {f'COALESCE(SUM({payload}),0)' if payload else 'NULL'} FROM {table}").fetchone()
        tables.append({"name": table, "rows": count, "payload_bytes": size})
    page_size = db.execute("PRAGMA page_size").fetchone()[0]
    page_count = db.execute("PRAGMA page_count").fetchone()[0]
    free = db.execute("PRAGMA freelist_count").fetchone()[0]
    result = {"fingerprint": fingerprint, "scan_rows": len(rows), "retained_scan_rows": len(latest),
              "superseded_scan_rows": len(old), "superseded_payload_bytes": sum(row["bytes"] for row in old),
              "tables": tables, "database_bytes": _size(store.db_path()), "wal_bytes": _size(str(store.db_path()) + "-wal"),
              "page_size": page_size, "page_count": page_count, "freelist_pages": free, "reusable_bytes": free * page_size,
              "cleanup_available": True,
              "warnings": ["只清理同股票池、同日期被較新版本取代的選股快照；每個日期最新版本保留。",
                           "持股、筆記、行情、回測及排程紀錄不刪除；清理前可先下載本地備份。",
                           "刪除空間供 SQLite 重用，不執行 VACUUM，資料庫檔案不一定縮小。",
                           "payload_bytes 是列出的文字內容位元組數，不含索引或資料頁開銷；檔案大小為量測當下值，WAL 可隨其他作業變動。"]}
    return result, old


def _prepare(db, readonly=False):
    deadline = time.monotonic() + MAX_SECONDS
    db.execute("PRAGMA busy_timeout=1000")
    if readonly:
        db.execute("PRAGMA query_only=ON")
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)


def _error(exc):
    if isinstance(exc, sqlite3.OperationalError) and any(part in str(exc).lower() for part in ("locked", "busy", "interrupt")):
        return HTTPException(503, "儲存空間檢查逾時或資料庫忙碌；請稍後重新預覽")
    return HTTPException(500, "儲存維護失敗，變更已回復；請重新預覽後重試")


@router.get("/api/storage")
def preview():
    try:
        with store.connect() as db:
            _prepare(db, readonly=True)
            db.execute("BEGIN")
            return _snapshot(db)[0]
    except sqlite3.Error as exc:
        raise _error(exc) from exc


class CleanupInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirm: StrictBool


@router.post("/api/storage/cleanup")
def cleanup(body: CleanupInput):
    if not body.confirm:
        raise HTTPException(422, "請先確認只刪除被取代的選股快照")
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "另一個資料作業正在執行，請完成後重新預覽")
    try:
        with store.connect() as db:
            _prepare(db)
            db.execute("BEGIN IMMEDIATE")
            before, old = _snapshot(db)
            if before["fingerprint"] != body.expected_fingerprint:
                raise HTTPException(409, "選股快照已變更，請重新預覽後再確認")
            db.executemany("DELETE FROM scans WHERE id=?", [(row["id"],) for row in old])
            after, _ = _snapshot(db)
        # File lengths are sampled after commit; logical counts describe the committed transaction.
        after["database_bytes"] = _size(store.db_path())
        after["wal_bytes"] = _size(str(store.db_path()) + "-wal")
        return {"deleted_rows": len(old), "deleted_payload_bytes": before["superseded_payload_bytes"], "storage": after}
    except sqlite3.Error as exc:
        raise _error(exc) from exc
    finally:
        RUN_LOCK.release()
