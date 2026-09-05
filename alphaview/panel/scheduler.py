"""Opt-in local EOD refresh: one automatic attempt per completed US session."""
from datetime import datetime, timezone
import logging
import threading
from typing import Literal
import uuid

from fastapi import APIRouter, HTTPException
import pandas as pd
from pydantic import BaseModel, Field, StrictBool

from . import jobs, sessions, store

router = APIRouter()
POLL_INTERVAL_SECONDS = 60
logger = logging.getLogger(__name__)


def utcnow():
    return datetime.now(timezone.utc)


def _instant(at=None):
    instant = pd.Timestamp(utcnow() if at is None else at)
    if instant.tzinfo is None:
        raise ValueError("Scheduler clock must include a timezone")
    return instant.tz_convert("UTC")


def _settings(db):
    row = db.execute("SELECT * FROM refresh_schedule WHERE id=1").fetchone()
    if row is None:
        raise RuntimeError("排程設定尚未初始化")
    return {key: bool(value) if key == "enabled" else value for key, value in dict(row).items() if key != "id"}


def state(at=None):
    instant = _instant(at)
    eligible = sessions.latest_completed_session(instant)
    with store.connect() as db:
        db.execute("BEGIN")
        settings = _settings(db)
        last = db.execute("""SELECT a.*,j.status,j.finished_at,j.error FROM schedule_attempts a
            LEFT JOIN jobs j ON j.id=a.job_id ORDER BY a.session_date DESC LIMIT 1""").fetchone()
        attempted = db.execute("SELECT 1 FROM schedule_attempts WHERE session_date=?", (eligible,)).fetchone() is not None
    next_due = None
    if settings["enabled"]:
        next_due = sessions.next_session_ready_after(eligible) if attempted else instant.isoformat()
    return {**settings, "latest_eligible_session": eligible, "next_due_at": next_due,
            "poll_interval_seconds": POLL_INTERVAL_SECONDS, "last_attempt": dict(last) if last else None}


class ScheduleInput(BaseModel):
    enabled: StrictBool
    scope: Literal["market", "portfolio"]
    universe_limit: Literal[250, 500, 1000]
    version: int = Field(ge=0, strict=True)


@router.get("/api/schedule")
def get_schedule():
    return state()


@router.put("/api/schedule")
def save_schedule(body: ScheduleInput):
    # Disabling future launches remains possible while a download owns RUN_LOCK.
    # The transaction serializes against an automatic claim, not the whole job.
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _settings(db)
        if body.version != current["version"]:
            raise HTTPException(409, "排程設定已由其他視窗更新；請重新載入後再儲存")
        db.execute("""UPDATE refresh_schedule SET enabled=?,scope=?,universe_limit=?,
                      version=version+1,updated_at=? WHERE id=1""",
                   (int(body.enabled), body.scope, body.universe_limit, store.now()))
    return state()


def tick(at=None, launch=None, stopping=lambda: False):
    """Perform one due check. Injected launch must adopt jobs.launch_locked semantics."""
    if stopping():
        return {"status": "stopped"}
    instant = _instant(at)
    with store.connect() as db:
        if not _settings(db)["enabled"]:
            return {"status": "disabled"}
    eligible = sessions.latest_completed_session(instant)
    if not jobs.RUN_LOCK.acquire(blocking=False):
        return {"status": "busy", "session_date": eligible}
    owns_lock = True
    job_id = str(uuid.uuid4())
    try:
        with store.connect() as db:
            db.execute("PRAGMA busy_timeout=1000")
            db.execute("BEGIN IMMEDIATE")
            if stopping():
                return {"status": "stopped"}
            settings = _settings(db)
            if not settings["enabled"]:
                return {"status": "disabled"}
            jobs.recover_interrupted_locked(db, instant.isoformat())
            if db.execute("SELECT 1 FROM schedule_attempts WHERE session_date=?", (eligible,)).fetchone():
                return {"status": "already_attempted", "session_date": eligible}
            effective_limit = settings["universe_limit"] if settings["scope"] == "market" else 250
            db.execute("""INSERT INTO jobs(id,kind,status,started_at,progress,scope,cancel_requested)
                          VALUES (?,'refresh','running',?,'收盤排程：準備開始',?,0)""",
                       (job_id, instant.isoformat(), settings["scope"]))
            db.execute("INSERT INTO schedule_attempts VALUES (?,?,?,?,?)",
                       (eligible, job_id, settings["scope"], effective_limit, instant.isoformat()))
        if stopping():
            with store.connect() as db:
                db.execute("UPDATE jobs SET status='interrupted',finished_at=?,error=? WHERE id=?",
                           (store.now(), "本地伺服器停止，排程尚未啟動；請手動重試", job_id))
            return {"status": "stopped", "job_id": job_id, "session_date": eligible}
        # Ownership transfers before launch; worker or launch failure releases it.
        owns_lock = False
        try:
            (launch or jobs.launch_locked)(job_id, "refresh", settings["scope"], [], effective_limit)
        except Exception as exc:
            return {"status": "launch_failed", "job_id": job_id, "session_date": eligible, "error": str(exc)[:400]}
        return {"status": "started", "job_id": job_id, "session_date": eligible}
    finally:
        if owns_lock:
            jobs.RUN_LOCK.release()


class Scheduler:
    """Polling thread lifetime is explicit; stopping it does not cancel a running job."""

    def __init__(self, clock=utcnow, launch=None, interval=POLL_INTERVAL_SECONDS):
        self.clock, self.launch, self.interval = clock, launch, interval
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None:
            raise RuntimeError("Scheduler already started")
        self._thread = threading.Thread(target=self._run, name="alphaview-eod-scheduler", daemon=True)
        self._thread.start()
        return self

    def _run(self):
        while not self._stop.is_set():
            try:
                tick(self.clock(), launch=self.launch, stopping=self._stop.is_set)
            except Exception:
                logger.exception("Local refresh scheduler tick failed")
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join()
