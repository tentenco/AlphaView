"""Explicit single held-symbol quote refresh and local corporate-action re-detection.

Uses the existing workspace writer job/lock and Yahoo adapter. Never changes
paper holdings, any universe membership, or the corporate-action inference rule.
"""
import hashlib
import json
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import corporate_action_evidence as evidence
from . import corporate_actions, jobs, market, paper_portfolio as paper, sessions, store

ENGINE_VERSION = "alphaview-corporate-action-refresh-v1"
KIND = "corporate_action_refresh"
router = APIRouter()


class RefreshInput(paper.StrictInput):
    symbol: str = Field(min_length=1, max_length=10, pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    expected_account_version: int = Field(ge=1, strict=True)
    expected_input_revision: str = Field(min_length=1, max_length=100)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("expected_as_of")
    @classmethod
    def valid_date(cls, value):
        return date.fromisoformat(value).isoformat()


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _prefix(account_id):
    return "ca-" + _hash(account_id)[:24] + "-"


def _job_id(account_id, body):
    return _prefix(account_id) + _hash(body.idempotency_key)[:32]


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _held(db, account_id, symbol):
    row = db.execute("SELECT shares FROM paper_holdings WHERE account_id=? AND symbol=?", (account_id, symbol)).fetchone()
    return bool(row and Decimal(row["shares"]).is_finite() and Decimal(row["shares"]) > 0)


def _check_request(db, account_id, body):
    account = paper._account(db, account_id)
    if account["version"] != body.expected_account_version:
        raise _problem("account_changed", "帳戶版本已變更；請重新讀取本機證據")
    if store.input_revision(db) != body.expected_input_revision:
        raise _problem("inputs_changed", "行情版本已變更；請重新讀取本機證據")
    if sessions.latest_completed_session() != body.expected_as_of:
        raise _problem("session_changed", "已收盤交易日已變更；請重新讀取本機證據")
    if not _held(db, account_id, body.symbol):
        raise _problem("symbol_not_held", "只能更新此虛擬帳戶目前持有的標的", 422)


def _context(row, account_id=None):
    try:
        saved = json.loads(row["result"])
        body = RefreshInput.model_validate(saved["request"])
        valid = (row["kind"] == KIND and saved["engine_version"] == ENGINE_VERSION
                 and isinstance(saved["account_id"], str)
                 and row["id"] == _job_id(saved["account_id"], body)
                 and saved["request_fingerprint"] == _hash(_json(body.model_dump()))
                 and (account_id is None or saved["account_id"] == account_id))
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise _problem("job_context_invalid", "作業來源與帳戶不符或紀錄不完整")
    return saved


def _public(row, account_id):
    saved = _context(row, account_id)
    return {"id": row["id"], "kind": row["kind"], "status": row["status"], "symbol": saved["request"]["symbol"],
            "account_id": account_id, "started_at": row["started_at"], "finished_at": row["finished_at"],
            "progress": row["progress"], "error": row["error"], "cancel_requested": bool(row["cancel_requested"]),
            "result": {key: value for key, value in saved.items() if key not in ("request", "request_fingerprint")}}


def _existing(db, account_id, body):
    row = db.execute("SELECT * FROM jobs WHERE id=?", (_job_id(account_id, body),)).fetchone()
    if row is None:
        return None
    saved = _context(row, account_id)
    if saved["request"] != body.model_dump():
        raise _problem("idempotency_conflict", "同一重送識別碼的更新內容不同")
    return {"job": _public(row, account_id), "replayed": True}


def _diagnosis(db, symbol, as_of):
    found, coverage = corporate_actions.detect(db, symbol, None, as_of)
    returned = evidence.summary(db, symbol, found, None, as_of)
    return {"as_of": as_of, "input_revision": store.input_revision(db), "symbol": symbol,
            "inference_engine_version": corporate_actions.ENGINE_VERSION, "inferred_events": len(found),
            "unavailable_pairs": coverage["unavailable_pairs"], "sessions": coverage["sessions"],
            "provider_status": returned["status"], "evidence_revision": returned.get("evidence_revision"),
            "returned_events": sum(event["reason"] is None for event in returned["events"]),
            "unavailable_cells": returned.get("coverage", {}).get("unavailable_cells"),
            "resolution": "not_proven"}


@router.post("/api/paper/accounts/{account_id}/corporate-actions/refresh", status_code=202)
def start_refresh(account_id: str, body: RefreshInput):
    with store.read_snapshot(), store.connect() as db:
        paper._account(db, account_id)
        existing = _existing(db, account_id, body)
        if existing:
            return existing
    if not jobs.RUN_LOCK.acquire(blocking=False):
        # A duplicate can arrive just after the first request committed its job.
        with store.read_snapshot(), store.connect() as db:
            existing = _existing(db, account_id, body)
            if existing:
                return existing
        raise _problem("workspace_busy", "已有資料作業正在執行；目前證據保留，稍後再試")
    owns_lock = True
    job_id = _job_id(account_id, body)
    try:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = _existing(db, account_id, body)
            if existing:
                return existing
            _check_request(db, account_id, body)
            context = {"engine_version": ENGINE_VERSION, "account_id": account_id,
                       "request": body.model_dump(), "request_fingerprint": _hash(_json(body.model_dump())),
                       "before": _diagnosis(db, body.symbol, body.expected_as_of), "resolution": "not_proven"}
            jobs.recover_interrupted_locked(db)
            db.execute("""INSERT INTO jobs(id,kind,status,started_at,progress,scope,cancel_requested,result)
                VALUES (?,?,'running',?,?,'portfolio',0,?)""",
                (job_id, KIND, store.now(), f"準備更新 {body.symbol} 最近兩年行情並重檢；未調整帳本", _json(context)))
        owns_lock = False
        jobs.launch_locked(job_id, KIND)
        with store.read_snapshot(), store.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return {"job": _public(row, account_id), "replayed": False}
    except HTTPException:
        raise
    except Exception as exc:
        raise _problem("launch_failed", "背景作業無法啟動；可重新讀取本機作業狀態", 503) from exc
    finally:
        if owns_lock:
            jobs.RUN_LOCK.release()


@router.get("/api/paper/accounts/{account_id}/corporate-actions/refresh")
@store.snapshot_read
def latest_refresh(account_id: str):
    with store.connect() as db:
        paper._account(db, account_id)
        prefix = _prefix(account_id)
        # Bound the indexed ID range to this account's deterministic namespace;
        # exact stored context is still checked before any row is returned.
        row = db.execute("SELECT * FROM jobs WHERE id>=? AND id<? ORDER BY started_at DESC,id DESC LIMIT 1",
                         (prefix, prefix + "z")).fetchone()
        return {"job": _public(row, account_id) if row else None}


@router.get("/api/paper/accounts/{account_id}/corporate-actions/refresh/{job_id}")
@store.snapshot_read
def get_refresh(account_id: str, job_id: str):
    with store.connect() as db:
        paper._account(db, account_id)
        row = db.execute("SELECT * FROM jobs WHERE id=? AND kind=?", (job_id, KIND)).fetchone()
        if row is None:
            raise _problem("job_not_found", "找不到公司行動重檢作業", 404)
        return {"job": _public(row, account_id)}


def run_job(job_id, result, check_cancel, progress):
    """Called only by jobs.worker while it owns RUN_LOCK; worker finalizes errors."""
    with store.read_snapshot(), store.connect() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise ValueError("公司行動重檢作業不存在")
        result.update(_context(row))
        body = RefreshInput.model_validate(result["request"])
        check_cancel()
        _check_request(db, result["account_id"], body)
    check_cancel()
    progress(f"正在更新 {body.symbol} 最近兩年行情；取消需等待目前下載結束")
    result["market"] = market.refresh(progress, symbols=[body.symbol], check_cancel=check_cancel)
    check_cancel()
    for _attempt in range(3):
        with store.read_snapshot(), store.connect() as db:
            as_of = sessions.latest_completed_session()
            after = _diagnosis(db, body.symbol, as_of)
            account = db.execute("SELECT version FROM paper_accounts WHERE id=?", (result["account_id"],)).fetchone()
            current_version = account["version"] if account else None
            still_held = _held(db, result["account_id"], body.symbol)
        changed = current_version != body.expected_account_version or not still_held or as_of != body.expected_as_of
        final = {**result, "after": after, "holding_context": "changed_not_validated" if changed else "unchanged",
                 "current_account_version": current_version, "still_held": still_held, "resolution": "not_proven"}
        failed = [entry for entry in result["market"] if entry["status"] != "ok"]
        message = (f"{body.symbol} 更新失敗，保留既有行情；重檢不代表異常已修復" if failed else
                   f"{body.symbol} 行情更新與本機重檢完成；不代表公司行動異常已修復，帳本未調整")
        if changed:
            message += "；帳戶或交易日已變更，本次未驗證目前持倉"
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # Re-detection is published against the same revision/account view.
            check_cancel()
            account = db.execute("SELECT version FROM paper_accounts WHERE id=?", (result["account_id"],)).fetchone()
            if (store.input_revision(db) != after["input_revision"]
                or (account["version"] if account else None) != current_version
                or _held(db, result["account_id"], body.symbol) != still_held
                or sessions.latest_completed_session() != as_of):
                continue
            result.update(final)
            db.execute("UPDATE jobs SET status=?,finished_at=?,progress=?,result=?,error=? WHERE id=?",
                       ("failed" if failed else "completed", store.now(), message, _json(result),
                        failed[0].get("error", "來源更新失敗") if failed else None, job_id))
            return
    raise ValueError("重檢資料在發布前持續變更；行情可能已完整保存，請重新讀取本機證據")
