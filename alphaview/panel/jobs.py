"""Workspace jobs with cooperative, cross-process cancellation."""
import json
import threading
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import market, research, store
from .locking import WorkspaceLock

router = APIRouter()
RUN_LOCK = WorkspaceLock()


class JobInput(BaseModel):
    scope: Literal["portfolio", "market"] = "portfolio"
    kind: Literal["refresh", "scan", "retry"]
    symbols: list[str] = Field(default_factory=list, max_length=100)
    universe_limit: Literal[250, 500, 1000] = 250


class JobCancelled(Exception):
    pass


def recover_interrupted_locked(db, timestamp=None):
    """Caller must own RUN_LOCK: no live workspace writer can then own these jobs."""
    db.execute("""UPDATE jobs SET status='interrupted',finished_at=?,error=?
                  WHERE status='running'""",
               (timestamp or store.now(), "背景程序已中斷，請手動重新執行"))


def launch_locked(job_id, kind, scope="portfolio", symbols=None, universe_limit=250):
    """Adopt an already-held RUN_LOCK; worker or launch failure releases it.

    Job creation and any scheduler claim must commit before calling this helper.
    The caller must not release or reacquire the lock after handing it over.
    """
    try:
        threading.Thread(target=worker, args=(job_id, kind, scope, symbols or [], universe_limit), daemon=True).start()
    except Exception as exc:
        try:
            with store.connect() as db:
                db.execute("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?",
                           (store.now(), f"無法啟動背景作業：{str(exc)[:400]}", job_id))
        finally:
            RUN_LOCK.release()
        raise


def worker(job_id, kind, scope="portfolio", symbols=None, universe_limit=250):
    result = {}

    def check_cancel():
        with store.connect() as db:
            row = db.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["cancel_requested"]:
            raise JobCancelled("使用者已要求取消作業")

    def progress(message):
        check_cancel()
        with store.connect() as db:
            db.execute("UPDATE jobs SET progress=? WHERE id=? AND status='running' AND cancel_requested=0", (message, job_id))

    try:
        check_cancel()
        if kind in {"refresh", "retry"}:
            result["market"] = market.refresh(progress, scope=scope, symbols=symbols if kind == "retry" else None, check_cancel=check_cancel, universe_limit=universe_limit)
        check_cancel()
        scopes = [scope]
        if kind == "retry":
            requested = set(symbols or [])
            other = "portfolio" if scope == "market" else "market"
            if requested & {p["symbol"] for p in store.universe(other)}:
                scopes.append(other)
        result["scans"] = {}
        result["scan_errors"] = {}
        for scan_scope in scopes:
            check_cancel()
            progress(f"正在重算{'市場候選' if scan_scope == 'market' else '持股與觀察清單'}策略")
            try:
                scanned = research.scan(progress, scope=scan_scope, check_cancel=check_cancel)
            except JobCancelled:
                raise
            except Exception as exc:
                if scan_scope == scope:
                    raise ValueError(f"主要股票池無法完成選股：{exc}") from exc
                result["scan_errors"][scan_scope] = str(exc)[:400]
                continue
            result["scans"][scan_scope] = scanned
            if scan_scope == scope:
                result["scan"] = scanned
        check_cancel()
        failures = [r for r in result.get("market", []) if r["status"] == "error"]
        invalid = sorted({symbol for scan in result["scans"].values() for symbol in scan.get("data_error_symbols", [])})
        partial = bool(failures or invalid or result["scan_errors"])
        summary = (f"部分完成：{len(failures)} 檔更新失敗、{len(invalid)} 檔資料異常已排除"
                   + (f"、{len(result['scan_errors'])} 個股票池無法重算" if result["scan_errors"] else "")
                   + "；請查看資料管理") if partial else (
            f"選股完成：掃描 {result['scan']['symbols']} 檔，{len(result['scan']['matched_symbols'])} 檔符合條件"
            + ("；與上次結果相同" if result["scan"].get("unchanged") else "")
            + ("；已同步重算另一股票池" if len(scopes) > 1 else ""))
        # Cancellation requested before terminal commit remains visible and wins.
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row and row["cancel_requested"]:
                raise JobCancelled("使用者已要求取消作業")
            db.execute("UPDATE jobs SET status=?,finished_at=?,progress=?,result=?,error=NULL WHERE id=?",
                       ("partial" if partial else "completed", store.now(), summary, json.dumps(result, ensure_ascii=False), job_id))
    except JobCancelled:
        with store.connect() as db:
            db.execute("UPDATE jobs SET status='cancelled',finished_at=?,progress=?,result=?,error=NULL WHERE id=?",
                       (store.now(), "作業已取消；已完成下載及完整發布的選股紀錄保留，未完成計算不會發布。",
                        json.dumps(result, ensure_ascii=False), job_id))
    except Exception as exc:
        with store.connect() as db:
            db.execute("UPDATE jobs SET status='failed',finished_at=?,error=?,result=? WHERE id=?",
                       (store.now(), str(exc)[:500], json.dumps(result, ensure_ascii=False), job_id))
    finally:
        RUN_LOCK.release()


@router.post("/api/jobs", status_code=202)
def start_job(body: JobInput):
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "已有資料作業正在執行")
    job_id = str(uuid.uuid4())
    owns_lock = True
    try:
        if body.universe_limit != 250 and (body.kind != "refresh" or body.scope != "market"):
            raise HTTPException(422, "只有市場更新作業可設定股票池上限")
        if body.kind == "retry":
            members = {p["symbol"] for p in [*store.positions(), *store.universe("market")]}
            if not body.symbols or any(s not in members for s in body.symbols):
                raise HTTPException(422, "重試需選擇 1–100 檔已知標的")
        elif body.symbols:
            raise HTTPException(422, "只有重試作業可指定標的")
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            recover_interrupted_locked(db)
            db.execute("INSERT INTO jobs(id,kind,status,started_at,progress,scope,cancel_requested) VALUES (?,?,'running',?,'準備開始',?,0)",
                       (job_id, body.kind, store.now(), body.scope))
        owns_lock = False
        launch_locked(job_id, body.kind, body.scope, list(dict.fromkeys(body.symbols)), body.universe_limit)
    except Exception as exc:
        if owns_lock:
            RUN_LOCK.release()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(503, "背景作業無法啟動，請稍後重試") from exc
    return {"id": job_id}


@router.post("/api/jobs/{job_id}/cancel", status_code=202)
def cancel_job(job_id: str):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT status,cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到作業")
        if row["status"] == "running":
            db.execute("UPDATE jobs SET cancel_requested=1,progress='正在取消，等待目前下載結束…' WHERE id=?", (job_id,))
            return {"id": job_id, "status": "running", "cancel_requested": True}
        return {"id": job_id, "status": row["status"], "cancel_requested": bool(row["cancel_requested"])}
