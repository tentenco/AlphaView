"""Opt-in, local-only portfolio-agent cadence with once-per-session claims.

No market refresh, provider call or broker is available here. Automatic actions
are confined to an independent paper account and reuse the paper risk checks.
"""
import hashlib
import json
import logging
import math
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, field_validator, model_validator

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import rebalance_trigger as triggers
from . import scan_provenance, sessions, store
from .locking import WorkspaceLock

router = APIRouter()
ENGINE_VERSION = "alphaview-agent-automation-v3"
TRIGGER_ENGINE_VERSION = "alphaview-agent-automation-v2"
OUTCOME_GUARD_VERSION = "alphaview-automation-outcome-guard-v1"
LEGACY_ENGINE_VERSION = "alphaview-agent-automation-v1"
POLL_INTERVAL_SECONDS = 60
MAX_MANDATES = 20
# Time-boxed authorization: a mandate may name its last valid XNYS session; a quantitative breach revokes it.
MAX_EXPIRY_SESSIONS = 180
EXPIRING_SOON_SESSIONS = 3
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
LIFECYCLE_EVENT_LIMIT = 30
logger = logging.getLogger(__name__)
METHOD = (
    "Local opt-in XNYS completed-session cadence. Each mandate has at most one durable "
    "attempt per latest completed session, regardless of later mandate edits or manual "
    "launches. No missed-session catch-up. Expired or revoked mandates claim a blocked "
    "attempt before candidate selection or research; renewal never retries that session. "
    "For authorized mandates, source or quote incompleteness waits without "
    "claiming that session; complete data with no qualifying candidates records a blocked "
    "run without liquidation. SQLite claims plus a workspace-scoped process lock prevent "
    "duplicate launches. A crashed claimed attempt is reconciled from paper records and "
    "never automatically retried that session. Proposal-only is default; auto_simulate "
    "requires explicit mandate opt-in and revalidates source, account and mandate versions "
    "inside the paper write transaction. Optional rebalance-trigger-v1 gates use the "
    "largest complete allocation drift including cash and completed XNYS sessions "
    "since a nonzero paper fill for this mandate/account; enabled gates combine with AND. "
    "Missing valuation waits without a claim; unmet gates save a skipped daily attempt "
    "without a paper proposal. Both gates disabled preserve the prior execution cadence. "
    "A claim-snapshot outcome guard downgrades this attempt to manual proposal review when a relevant "
    "workspace-wide decision family has at least 20 settled 10-session decisions and a hit rate below 40%, "
    "or its evidence cannot be evaluated. Insufficient samples are not a low signal. Rule targets always "
    "apply; Jev history applies only when the Jev gate is enabled. Mandate settings are unchanged. "
    "Historical v1/v2 attempts keep their original method and authority. This never places real orders."
)


class AutomationLock(WorkspaceLock):
    @staticmethod
    def lock_path():
        return Path(str(store.db_path().expanduser().resolve()) + ".agent-automation.lock")


RUN_LOCK = AutomationLock()


class WorkflowTemplate(agent.WorkflowInput):
    candidate_symbols: list[str] = Field(default_factory=list, max_length=100)


class JevGatePolicy(agent.StrictInput):
    """Optional fixed-outcome probability gate applied to the rules run before any proposal."""
    enabled: bool = False
    pass_threshold: float = Field(default=0.7, ge=0.5, le=0.99)
    max_risk_probability: float = Field(default=0.5, ge=0.01, le=0.5)


DEFAULT_JEV_GATE = JevGatePolicy().model_dump()


def _validate_expiry(value):
    """Expiry must be an XNYS session between the latest completed session and 180 sessions ahead."""
    if value is None:
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError("到期日格式須為 YYYY-MM-DD") from None
    today = sessions.latest_completed_session()
    if value < today:
        raise ValueError(f"到期日不可早於最新已完成交易日 {today}")
    horizon = sessions.expected_sessions(today, value)
    if not horizon or horizon[-1] != value:
        raise ValueError("到期日必須是 XNYS 交易日")
    if len(horizon) - 1 > MAX_EXPIRY_SESSIONS:
        raise ValueError(f"到期日最多可設在 {MAX_EXPIRY_SESSIONS} 個交易日之後")
    return value


class MandateInput(agent.StrictInput):
    name: str = Field(min_length=1, max_length=80)
    account_id: str = Field(min_length=1, max_length=100)
    workflow: WorkflowTemplate
    candidate_source: Literal["explicit", "scan_pool"] = "explicit"
    selector_limit: int = Field(default=100, ge=1, le=100)
    enabled: bool = False
    mode: Literal["proposal_only", "auto_simulate"] = "proposal_only"
    execution_target: Literal["paper_ledger", "alpaca_paper"] = "paper_ledger"
    rebalance_trigger: triggers.Policy = Field(default_factory=triggers.disabled_policy)
    jev_gate: JevGatePolicy = Field(default_factory=JevGatePolicy)
    expires_on: str | None = Field(default=None, pattern=DATE_PATTERN)

    @field_validator("expires_on")
    @classmethod
    def valid_expiry(cls, value):
        return _validate_expiry(value)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("請輸入自動化任務名稱")
        return value

    @model_validator(mode="after")
    def candidate_source_contract(self):
        if self.candidate_source == "explicit" and not self.workflow.candidate_symbols:
            raise ValueError("明確候選模式至少需要一個候選代碼")
        if self.candidate_source == "scan_pool" and self.workflow.candidate_symbols:
            raise ValueError("自動候選池模式的 candidate_symbols 必須留空；每輪依最新有效快照解析")
        return self


class MandatePatch(agent.StrictInput):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    account_id: str | None = Field(default=None, min_length=1, max_length=100)
    workflow: WorkflowTemplate | None = None
    candidate_source: Literal["explicit", "scan_pool"] | None = None
    selector_limit: int | None = Field(default=None, ge=1, le=100)
    enabled: bool | None = None
    mode: Literal["proposal_only", "auto_simulate"] | None = None
    execution_target: Literal["paper_ledger", "alpaca_paper"] | None = None
    rebalance_trigger: triggers.Policy | None = None
    jev_gate: JevGatePolicy | None = None
    expires_on: str | None = Field(default=None, pattern=DATE_PATTERN)

    @field_validator("expires_on")
    @classmethod
    def valid_expiry(cls, value):
        return _validate_expiry(value)

    @model_validator(mode="after")
    def has_changes(self):
        fields = self.model_fields_set - {"expected_version"}
        if not fields or any(getattr(self, name) is None for name in fields):
            raise ValueError("請指定至少一個非空的任務設定")
        if "name" in fields:
            self.name = self.name.strip()
            if not self.name:
                raise ValueError("請輸入自動化任務名稱")
        return self


class RunInput(agent.StrictInput):
    expected_version: int = Field(ge=1)
    allow_auto_simulate: bool = False


class RenewInput(agent.StrictInput):
    """Explicit human renewal: clears a re-authorization flag and sets (or removes) the expiry."""
    expected_version: int = Field(ge=1)
    expires_on: str | None = Field(default=None, pattern=DATE_PATTERN)
    acknowledge: bool = False

    @field_validator("expires_on")
    @classmethod
    def valid_expiry(cls, value):
        return _validate_expiry(value)


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS agent_mandates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        candidate_source TEXT NOT NULL DEFAULT 'explicit' CHECK(candidate_source IN ('explicit','scan_pool')),
        selector_limit INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        mode TEXT NOT NULL DEFAULT 'proposal_only' CHECK(mode IN ('proposal_only','auto_simulate')),
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_checked_at TEXT, last_status TEXT, last_reason TEXT
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS agent_automation_attempts (
        id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, session_date TEXT NOT NULL,
        mandate_version INTEGER NOT NULL, account_id TEXT NOT NULL, account_version INTEGER NOT NULL,
        mode TEXT NOT NULL, trigger_kind TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, run_id TEXT NOT NULL,
        paper_proposal_id TEXT, reason_code TEXT, reason TEXT, result_json TEXT,
        engine_version TEXT NOT NULL, input_revision TEXT NOT NULL,
        UNIQUE(mandate_id,session_date)
    )""")
    columns = {row["name"] for row in db.execute("PRAGMA table_info(agent_mandates)")}
    if "candidate_source" not in columns:
        db.execute("ALTER TABLE agent_mandates ADD COLUMN candidate_source TEXT NOT NULL DEFAULT 'explicit'")
    if "selector_limit" not in columns:
        db.execute("ALTER TABLE agent_mandates ADD COLUMN selector_limit INTEGER NOT NULL DEFAULT 100")
    # Use the same ALTER path for fresh and upgraded stores, preserving a single
    # exact schema signature for the backup preflight allowlist.
    if "rebalance_trigger_json" not in columns:
        db.execute("""ALTER TABLE agent_mandates ADD COLUMN rebalance_trigger_json TEXT NOT NULL
            DEFAULT '{"min_completed_sessions_between_fills":null,"min_weight_drift_pp":null}'""")
    if "execution_target" not in columns:
        # Existing mandates keep settling in the local ledger; Alpaca Paper is an explicit opt-in per mandate.
        db.execute("ALTER TABLE agent_mandates ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'paper_ledger'")
    if "jev_gate_json" not in columns:
        db.execute("ALTER TABLE agent_mandates ADD COLUMN jev_gate_json TEXT NOT NULL DEFAULT '" + _json(DEFAULT_JEV_GATE) + "'")
    if "expires_on" not in columns:
        # Time-boxed authorization; NULL keeps pre-existing open-ended mandates unchanged.
        db.execute("ALTER TABLE agent_mandates ADD COLUMN expires_on TEXT")
    if "reauth_required" not in columns:
        db.execute("ALTER TABLE agent_mandates ADD COLUMN reauth_required INTEGER NOT NULL DEFAULT 0")
    if "reauth_reason" not in columns:
        db.execute("ALTER TABLE agent_mandates ADD COLUMN reauth_reason TEXT")
    if "lifecycle_json" not in columns:
        db.execute("""ALTER TABLE agent_mandates ADD COLUMN lifecycle_json TEXT NOT NULL DEFAULT '{"events":[]}'""")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mandates_enabled_account ON agent_mandates(account_id) WHERE enabled=1")
    db.execute("CREATE INDEX IF NOT EXISTS idx_agent_automation_attempts_mandate ON agent_automation_attempts(mandate_id,session_date DESC)")


def utcnow():
    return datetime.now(timezone.utc)


def _instant(at=None):
    value = at or utcnow()
    instant = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if instant.tzinfo is None:
        raise ValueError("Automation clock must include a timezone")
    return instant.astimezone(timezone.utc)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _mandate(db, identifier):
    row = db.execute("SELECT * FROM agent_mandates WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到本機自動化任務")
    return dict(row)


def lifecycle(row, expected):
    """Pure lifecycle view of a mandate row for the latest completed session `expected` (no I/O)."""
    expires = row.get("expires_on")
    remaining = None
    if expires:
        remaining = len(sessions.expected_sessions(expected, expires)) - 1 if expires >= expected else 0
    reauth = bool(row.get("reauth_required"))
    if expires and expected > expires:
        state = "expired"
    elif reauth:
        state = "reauth_required"
    elif not row.get("enabled"):
        state = "inactive"
    elif remaining is not None and remaining <= EXPIRING_SOON_SESSIONS:
        state = "expiring_soon"
    else:
        state = "active"
    message = {"expired": f"授權已於 {expires} 到期；續期前不建立提案、不模擬、不送委託",
               "reauth_required": f"授權需重新確認（{row.get('reauth_reason') or 'unknown'}）；請在任務卡片重新授權",
               "expiring_soon": f"授權將於 {expires} 到期（剩 {remaining} 個交易日）"}.get(state)
    codes = {"expired": "mandate_expired", "reauth_required": "mandate_reauth_required"}
    return {"lifecycle": state, "expires_on": expires, "sessions_remaining": remaining, "reauth_required": reauth,
            "reauth_reason": row.get("reauth_reason"), "message": message, "blocked_code": codes.get(state)}


def _lifecycle_event(db, identifier, kind, **fields):
    row = db.execute("SELECT lifecycle_json FROM agent_mandates WHERE id=?", (identifier,)).fetchone()
    events = json.loads(row["lifecycle_json"])["events"] if row and row["lifecycle_json"] else []
    events = [*events, {"kind": kind, "at": store.now(), **fields}][-LIFECYCLE_EVENT_LIMIT:]
    db.execute("UPDATE agent_mandates SET lifecycle_json=? WHERE id=?", (_json({"events": events}), identifier))


def require_reauth(db, account_id, reason):
    """Flag the account's enabled mandates for explicit re-authorization; the caller holds the write transaction."""
    rows = db.execute("SELECT id FROM agent_mandates WHERE account_id=? AND enabled=1 AND reauth_required=0", (account_id,)).fetchall()
    now = store.now()
    for row in rows:
        db.execute("UPDATE agent_mandates SET reauth_required=1,reauth_reason=?,updated_at=? WHERE id=?", (reason[:200], now, row["id"]))
        _lifecycle_event(db, row["id"], "reauth_required", reason=reason[:200])
    return [row["id"] for row in rows]


def _unique_enabled_account(db, account_id, enabled, exclude=""):
    if enabled and db.execute("SELECT 1 FROM agent_mandates WHERE account_id=? AND enabled=1 AND id<>?", (account_id, exclude)).fetchone():
        raise HTTPException(409, "同一虛擬帳戶只能啟用一個自動化任務；請先停用現有任務")


def _account(db, identifier):
    row = db.execute("SELECT id,name,version,kill_switch FROM paper_accounts WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到任務綁定的虛擬帳戶")
    return dict(row)


def _bind_workflow(db, account_id, workflow):
    """A changed policy requires the caller's explicit expected version."""
    template = workflow.model_dump() if hasattr(workflow, "model_dump") else dict(workflow)
    policy = paper._symbol_policy(db, account_id)
    context = template.get("account_context")
    if context is None:
        if paper._policy_active(policy):
            raise HTTPException(409, "請檢閱目前允許標的政策，並在工作流明確指定帳戶及政策版本")
        context = {"account_id": account_id, "expected_policy_version": 1}
    if context["account_id"] != account_id:
        raise HTTPException(409, "工作流授權帳戶與任務綁定帳戶不符")
    paper._policy_context(db, context)
    return {**template, "account_context": context}


def _policy_authorization(db, mandate):
    policy = paper._symbol_policy(db, mandate["account_id"])
    context = json.loads(mandate["workflow_json"]).get("account_context")
    authorized = context["expected_policy_version"] if context else 1
    current = (context["account_id"] == mandate["account_id"] and authorized == policy["version"]) if context else not paper._policy_active(policy)
    return {"status": "current" if current else "stale", "authorized_policy_version": authorized,
            "current_policy": policy,
            "reason": None if current else "允許標的政策已變更；請檢閱並明確更新任務工作流授權"}


def _attempt(row):
    if row is None:
        return None
    result = dict(row)
    raw = result.pop("result_json")
    result["result"] = json.loads(raw) if raw else None
    result["paper_status"] = None
    if result["paper_proposal_id"]:
        with store.connect() as db:
            proposal = db.execute("SELECT status,accepted_at FROM paper_proposals WHERE id=?", (result["paper_proposal_id"],)).fetchone()
        if proposal:
            result["paper_status"] = proposal["status"]
            if proposal["status"] == "simulated" and result["status"] != "simulated":
                result.update(status="simulated", finished_at=proposal["accepted_at"],
                              reason_code="paper_accepted_after_proposal", reason="紙上提案已接受並完成模擬")
    return result


def _public(db, row, instant):
    expected = sessions.latest_completed_session(instant)
    last = db.execute("SELECT * FROM agent_automation_attempts WHERE mandate_id=? ORDER BY session_date DESC LIMIT 1", (row["id"],)).fetchone()
    current = db.execute("SELECT * FROM agent_automation_attempts WHERE mandate_id=? AND session_date=?", (row["id"], expected)).fetchone()
    account = _account(db, row["account_id"])
    current_public, last_public = _attempt(current), _attempt(last)
    status = "disabled" if not row["enabled"] else "paused" if account["kill_switch"] else current_public["status"] if current else row["last_status"] or "pending"
    reason = ("任務尚未啟用；仍可手動產生紙上提案" if not row["enabled"] else
              "虛擬帳戶暫停開關已啟用" if account["kill_switch"] else
              current_public["reason"] if current else row["last_reason"])
    life = lifecycle(row, expected)
    if current is None and life["blocked_code"]:
        reason = life["message"]
    next_due = None
    if row["enabled"] and not account["kill_switch"]:
        next_due = sessions.next_session_ready_after(expected) if current else instant.isoformat()
        if not current and row["last_checked_at"]:
            next_check = datetime.fromisoformat(row["last_checked_at"]) + timedelta(seconds=POLL_INTERVAL_SECONDS)
            next_due = max(instant, next_check).isoformat()
    return {"id": row["id"], "name": row["name"], "account_id": row["account_id"], "account_name": account["name"],
            "workflow": json.loads(row["workflow_json"]), "candidate_source": row["candidate_source"],
            "rebalance_trigger": triggers.normalize(row["rebalance_trigger_json"]),
            "symbol_policy_authorization": _policy_authorization(db, row),
            "selector_limit": row["selector_limit"], "enabled": bool(row["enabled"]), "mode": row["mode"],
            "execution_target": row["execution_target"], "jev_gate": json.loads(row["jev_gate_json"]),
            "expires_on": life["expires_on"], "sessions_remaining": life["sessions_remaining"],
            "reauth_required": life["reauth_required"], "reauth_reason": life["reauth_reason"],
            "lifecycle": life["lifecycle"], "lifecycle_message": life["message"],
            "lifecycle_events": json.loads(row["lifecycle_json"])["events"][-5:],
            "version": row["version"], "created_at": row["created_at"], "updated_at": row["updated_at"],
            "last_checked_at": row["last_checked_at"], "status": status, "reason": reason,
            "latest_eligible_session": expected, "next_due_at": next_due,
            "last_attempt": last_public, "current_attempt": current_public}


@router.get("/api/agent-automation/mandates")
@router.get("/api/agent-automation/state")
@store.snapshot_read
def state():
    instant = _instant()
    with store.connect() as db:
        mandates = [_public(db, dict(row), instant) for row in db.execute("SELECT * FROM agent_mandates ORDER BY created_at,id")]
    return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(instant),
            "input_revision": store.input_revision(), "mandates": mandates,
            "poll_interval_seconds": POLL_INTERVAL_SECONDS, "method": METHOD,
            "warnings": ["只在本機伺服器運行時檢查；未開機的交易日不補跑。", "自動模擬僅改動獨立虛擬帳戶；不連接券商。"]}


@router.get("/api/agent-automation/mandates/{identifier}")
@store.snapshot_read
def get_mandate(identifier: str):
    with store.connect() as db:
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db), "mandate": _public(db, _mandate(db, identifier), _instant()), "method": METHOD}


@router.post("/api/agent-automation/mandates", status_code=201)
def create_mandate(body: MandateInput):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        _account(db, body.account_id)
        if db.execute("SELECT count(*) FROM agent_mandates").fetchone()[0] >= MAX_MANDATES:
            raise HTTPException(422, f"本版最多支援 {MAX_MANDATES} 個本機自動化任務")
        _unique_enabled_account(db, body.account_id, body.enabled)
        workflow = _bind_workflow(db, body.account_id, body.workflow)
        identifier, created = uuid.uuid4().hex, store.now()
        db.execute("""INSERT INTO agent_mandates
            (id,name,account_id,workflow_json,candidate_source,selector_limit,enabled,mode,created_at,updated_at,rebalance_trigger_json,execution_target,jev_gate_json,expires_on)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (identifier, body.name, body.account_id, _json(workflow), body.candidate_source,
                    body.selector_limit, int(body.enabled), body.mode, created, created, _json(body.rebalance_trigger.model_dump()),
                    body.execution_target, _json(body.jev_gate.model_dump()), body.expires_on))
    return get_mandate(identifier)


@router.patch("/api/agent-automation/mandates/{identifier}")
def update_mandate(identifier: str, body: MandatePatch):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _mandate(db, identifier)
        if current["version"] != body.expected_version:
            raise HTTPException(409, "任務已由其他視窗更新；請重新載入再儲存")
        changes = body.model_dump(exclude_unset=True, exclude={"expected_version"})
        account_id = changes.get("account_id", current["account_id"])
        _account(db, account_id)
        merged = {**current, **changes}
        _unique_enabled_account(db, account_id, merged["enabled"], identifier)
        try:
            MandateInput(name=merged["name"], account_id=account_id,
                         workflow=changes.get("workflow", json.loads(current["workflow_json"])),
                         candidate_source=merged["candidate_source"], selector_limit=merged["selector_limit"],
                         enabled=bool(merged["enabled"]), mode=merged["mode"], execution_target=merged["execution_target"],
                         rebalance_trigger=changes.get("rebalance_trigger", triggers.normalize(current["rebalance_trigger_json"])),
                         jev_gate=changes.get("jev_gate", json.loads(current["jev_gate_json"])),
                         expires_on=changes.get("expires_on"))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if "workflow" in changes:
            workflow = _json(_bind_workflow(db, account_id, changes["workflow"]))
        elif account_id != current["account_id"]:
            raise HTTPException(422, "變更綁定帳戶時需同時提供已確認允許標的政策版本的完整工作流")
        else:
            workflow = current["workflow_json"]
        trigger = _json(changes["rebalance_trigger"]) if "rebalance_trigger" in changes else current["rebalance_trigger_json"]
        gate = _json(changes["jev_gate"]) if "jev_gate" in changes else current["jev_gate_json"]
        db.execute("""UPDATE agent_mandates SET name=?,account_id=?,workflow_json=?,candidate_source=?,selector_limit=?,enabled=?,mode=?,
            rebalance_trigger_json=?,execution_target=?,jev_gate_json=?,expires_on=?,version=version+1,updated_at=?,last_checked_at=NULL,last_status=NULL,last_reason=NULL WHERE id=?""",
                   (merged["name"], account_id, workflow, merged["candidate_source"], merged["selector_limit"], int(merged["enabled"]),
                    merged["mode"], trigger, merged["execution_target"], gate, merged["expires_on"], store.now(), identifier))
        db.execute("""UPDATE agent_automation_attempts SET status='invalidated',
            finished_at=coalesce(finished_at,?),reason_code='mandate_changed',reason=?
            WHERE mandate_id=? AND status IN ('running','proposed')""",
                   (store.now(), "任務設定已變更，先前待處理提案失效；本交易日不再次自動執行", identifier))
    return get_mandate(identifier)


@router.post("/api/paper/accounts/{account_id}/mandates/{identifier}/renew")
def renew_mandate(account_id: str, identifier: str, body: RenewInput):
    """Explicit re-authorization: the only way to clear a breach flag or move an expiry."""
    if not body.acknowledge:
        raise HTTPException(422, "續期需要明確確認（acknowledge=true）")
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = _mandate(db, identifier)
        if current["account_id"] != account_id:
            raise HTTPException(404, "此虛擬帳戶沒有這個自動化任務")
        if current["version"] != body.expected_version:
            raise HTTPException(409, "任務已由其他視窗更新；請重新載入再續期")
        now = store.now()
        _lifecycle_event(db, identifier, "renewed", expires_on=body.expires_on, previous_expires_on=current["expires_on"],
                         cleared_reason=current["reauth_reason"], mandate_version=current["version"] + 1)
        db.execute("""UPDATE agent_mandates SET expires_on=?,reauth_required=0,reauth_reason=NULL,version=version+1,updated_at=?,
            last_checked_at=NULL,last_status=NULL,last_reason=NULL WHERE id=?""", (body.expires_on, now, identifier))
        db.execute("""UPDATE agent_automation_attempts SET status='invalidated',
            finished_at=coalesce(finished_at,?),reason_code='mandate_renewed',reason=?
            WHERE mandate_id=? AND status IN ('running','proposed')""",
                   (now, "任務已重新授權，先前待處理提案失效；本交易日不再次自動執行", identifier))
    return get_mandate(identifier)


@router.get("/api/agent-automation/mandates/{identifier}/attempts")
@store.snapshot_read
def attempts(identifier: str, limit: int = Query(default=20, ge=1, le=100)):
    with store.connect() as db:
        _mandate(db, identifier)
        rows = db.execute("SELECT * FROM agent_automation_attempts WHERE mandate_id=? ORDER BY session_date DESC LIMIT ?", (identifier, limit)).fetchall()
    return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
            "input_revision": store.input_revision(), "attempts": [_attempt(row) for row in rows], "method": METHOD}


def _note_check(mandate, status, reason, instant):
    with store.connect() as db:
        db.execute("UPDATE agent_mandates SET last_checked_at=?,last_status=?,last_reason=? WHERE id=? AND version=?",
                   (instant.isoformat(), status, reason, mandate["id"], mandate["version"]))
    return {"status": status, "mandate_id": mandate["id"], "reason": reason}


def _capture_nav(attempt, account_version):
    if sessions.latest_completed_session() != attempt["session_date"]:
        return {"status": "unavailable", "reason": "原交易日已結束；不以目前持倉重建歷史淨值"}
    try:
        from . import paper_analytics
        receipt = paper_analytics.capture_nav(attempt["account_id"], paper_analytics.CaptureInput(
            expected_version=account_version, expected_input_revision=attempt["input_revision"]))
        snapshot = receipt["snapshot"]
        return {"status": "captured", "snapshot_id": snapshot["id"], "as_of": snapshot["as_of"],
                "valuation_complete": snapshot["valuation_complete"], "created": receipt["created"]}
    except Exception as exc:
        reason = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        return {"status": "unavailable", "reason": reason[:300]}


def _finish(identifier, status, code, reason, *, proposal_id=None, result=None):
    with store.connect() as db:
        attempt = dict(db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (identifier,)).fetchone())
    # Frozen trigger authority survives every later paper outcome and recovery.
    result = {**(json.loads(attempt["result_json"]) if attempt["result_json"] else {}), **(result or {})}
    if status in ("proposed", "blocked", "simulated", "skipped"):
        account_version = result.get("account_version_after", attempt["account_version"])
        result["nav_capture"] = _capture_nav(attempt, account_version)
    with store.connect() as db:
        db.execute("""UPDATE agent_automation_attempts SET status=?,finished_at=?,reason_code=?,reason=?,
            paper_proposal_id=coalesce(?,paper_proposal_id),result_json=? WHERE id=?
            AND (status='running' OR (?='simulated' AND status='invalidated') OR (?='skipped' AND status='skipped'))""",
                   (status, store.now(), code, reason, proposal_id, _json(result), identifier, status, status))
        row = db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (identifier,)).fetchone()
    return {"status": row["status"], "mandate_id": row["mandate_id"], "attempt": _attempt(row)}


def validate_source(db, source):
    """Read-only source guard also used when a paper proposal is accepted manually."""
    mandate = _mandate(db, source["mandate_id"])
    if mandate["version"] != source["mandate_version"]:
        raise HTTPException(409, "自動化任務版本已變更，此紙上提案已失效")
    row = db.execute("SELECT * FROM agent_automation_attempts WHERE id=? AND mandate_id=?",
                     (source["attempt_id"], source["mandate_id"])).fetchone()
    if row is None or row["mandate_version"] != source["mandate_version"]:
        raise HTTPException(409, "自動化來源嘗試紀錄不存在或版本不符")
    if row["trigger_kind"] == "schedule" and not mandate["enabled"]:
        raise HTTPException(409, "自動化任務已停用，此紙上提案已失效")
    life = lifecycle(mandate, sessions.latest_completed_session())
    if life["blocked_code"]:
        raise HTTPException(409, life["message"])
    if row["account_id"] != mandate["account_id"]:
        raise HTTPException(409, "自動化虛擬帳戶已變更")
    authorization = _policy_authorization(db, mandate)
    if authorization["status"] != "current":
        raise HTTPException(409, authorization["reason"])
    if row["engine_version"] not in (ENGINE_VERSION, TRIGGER_ENGINE_VERSION, LEGACY_ENGINE_VERSION) or row["status"] in ("invalidated", "failed", "interrupted"):
        raise HTTPException(409, "自動化來源已失效或中斷；請重新檢閱")
    attempt = dict(row)
    if row["engine_version"] == LEGACY_ENGINE_VERSION:
        return attempt
    if row["status"] not in ("running", "proposed"):
        raise HTTPException(409, "此自動化紀錄未授權建立或接受紙上提案")
    evidence = (json.loads(row["result_json"]) if row["result_json"] else {}).get("rebalance_trigger")
    if (not isinstance(evidence, dict) or evidence.get("engine_version") != triggers.ENGINE_VERSION
            or evidence.get("outcome") not in ("pass", "disabled")
            or evidence.get("as_of") != row["session_date"]
            or evidence.get("input_revision") != row["input_revision"]
            or evidence.get("account_id") != row["account_id"]
            or evidence.get("account_version") != row["account_version"]
            or evidence.get("policy") != triggers.normalize(mandate["rebalance_trigger_json"])):
        raise HTTPException(409, "自動化缺少有效且已通過的調倉門檻證據")
    account = _account(db, row["account_id"])
    reduce = (json.loads(row["result_json"]) if row["result_json"] else {}).get("reduce_only")
    if account["version"] != row["account_version"] or (account["kill_switch"] and not reduce):
        raise HTTPException(409, "自動化判斷後虛擬帳戶已變更或暫停")
    saved = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (row["run_id"],)).fetchone()
    if saved is None or saved["status"] != "proposed" or saved["engine_version"] != agent.ENGINE_VERSION:
        raise HTTPException(409, "自動化原始規則工作流不存在或方法已變更")
    run = json.loads(saved["result"])
    fingerprint = hashlib.sha256(_json({key: value for key, value in run.items() if key != "proposal_fingerprint"}).encode()).hexdigest()
    if (run.get("proposal_fingerprint") != fingerprint or evidence.get("source_run_fingerprint") != fingerprint
            or run.get("as_of") != row["session_date"] or run.get("input_revision") != row["input_revision"]
            or run.get("engine_version") != agent.ENGINE_VERSION
            or (run.get("scan") or {}).get("engine_version") != scan_provenance.SCAN_ENGINE_VERSION):
        raise HTTPException(409, "自動化門檻證據與原始規則工作流不符")
    attempt["validated_target_weights"] = run["target_weights"]
    if row["engine_version"] == ENGINE_VERSION:
        _verify_outcome_guard(row, mandate)
    gate_policy = json.loads(mandate["jev_gate_json"]) if "jev_gate_json" in mandate.keys() else dict(DEFAULT_JEV_GATE)
    gate = (json.loads(row["result_json"]) if row["result_json"] else {}).get("jev_gate")
    if gate_policy.get("enabled") or gate:
        if not isinstance(gate, dict) or gate.get("status") != "pass":
            raise HTTPException(409, "自動化任務要求 Jev 決策閘，但沒有通過的決策證據")
        from . import jev_decision
        decision = jev_decision.validate_source(db, {"run_id": gate.get("run_id"), "engine_version": gate.get("engine_version")})
        if (decision["source_run_id"] != row["run_id"] or decision["target_weights"] != gate.get("target_weights")
                or gate.get("policy") != {key: gate_policy[key] for key in ("pass_threshold", "max_risk_probability")}):
            raise HTTPException(409, "自動化的 Jev 決策閘證據與決策紀錄或任務政策不符")
        attempt["validated_target_weights"] = decision["target_weights"]
    overlay = (json.loads(row["result_json"]) if row["result_json"] else {}).get("regime_overlay")
    if overlay:
        from . import regime_overlay
        attempt["validated_target_weights"] = regime_overlay.verify_evidence(
            overlay, attempt["validated_target_weights"], row["session_date"], row["input_revision"])
    if reduce:
        # Paused account: the bound proposal may only carry the clamped (never larger) targets.
        from . import reduce_only
        attempt["validated_target_weights"] = reduce_only.verify_evidence(
            db, account, reduce, attempt["validated_target_weights"], row["session_date"], row["input_revision"])
    return attempt


def _guard(identifier, require_enabled, stopping):
    def check(db):
        row = db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (identifier,)).fetchone()
        if row is None or row["status"] != "running":
            raise HTTPException(409, "自動化嘗試已不在執行狀態")
        source = {"mandate_id": row["mandate_id"], "mandate_version": row["mandate_version"], "attempt_id": identifier}
        validate_source(db, source)
        mandate = _mandate(db, row["mandate_id"])
        if stopping() or (require_enabled and not mandate["enabled"]):
            raise HTTPException(409, "任務或本機伺服器已停止；不接續模擬")
        if sessions.latest_completed_session() != row["session_date"]:
            raise HTTPException(409, "自動化計算期間交易日已變更")
        if row["mode"] == "auto_simulate" and mandate["mode"] != "auto_simulate":
            raise HTTPException(409, "任務未授權自動紙上模擬")
    return check


def _recover_interrupted():
    """Caller owns RUN_LOCK, proving no live automation worker owns these rows."""
    recovered = []
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("""SELECT a.* FROM agent_automation_attempts a LEFT JOIN paper_proposals p ON p.id=a.paper_proposal_id
            WHERE a.status='running' OR (a.status IN ('invalidated','proposed') AND p.status='simulated')""").fetchall()
        for row in rows:
            proposal_id = row["paper_proposal_id"]
            if not proposal_id:
                receipt = db.execute("SELECT response_json FROM paper_idempotency WHERE scope=? AND key=?",
                                     (f"proposal:{row['account_id']}", f"automation-proposal:{row['id']}")).fetchone()
                if receipt:
                    proposal_id = json.loads(receipt[0]).get("id")
            proposal = db.execute("SELECT status FROM paper_proposals WHERE id=?", (proposal_id,)).fetchone() if proposal_id else None
            simulated = proposal is not None and proposal["status"] == "simulated"
            status = "simulated" if simulated else "interrupted"
            if simulated:
                recovered.append(dict(row))
            reason = "程序中斷前紙上模擬已完成；依持久化成交紀錄恢復狀態" if simulated else "程序中斷；保留來源與提案，本交易日不自動重試"
            db.execute("""UPDATE agent_automation_attempts SET status=?,finished_at=?,paper_proposal_id=?,
                reason_code=?,reason=? WHERE id=?""", (status, store.now(), proposal_id, "recovered_simulation" if simulated else "process_interrupted", reason, row["id"]))
    for row in recovered:
        details = json.loads(row["result_json"]) if row["result_json"] else {}
        details["nav_capture"] = _capture_nav(row, row["account_version"] + 1)
        with store.connect() as db:
            db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (_json(details), row["id"]))


def _ready(mandate, expected):
    from . import circuit_breakers, reduce_only
    reduction = None
    with store.read_snapshot():
        with store.connect() as db:
            account = _account(db, mandate["account_id"])
            authorization = _policy_authorization(db, mandate)
            reduce_allowed = circuit_breakers.reduce_only_allowed(db, mandate["account_id"])
        if account["kill_switch"] and not reduce_allowed:
            return None, account, "paused", "虛擬帳戶已暫停；不消耗當日嘗試", None, None
        if authorization["status"] != "current":
            return None, account, "waiting", authorization["reason"], None, None
        template = json.loads(mandate["workflow_json"])
        # Legacy contextless mandates are only authorized for pristine v1
        # unrestricted policies. New runs still freeze that explicit context.
        template["account_context"] = {"account_id": mandate["account_id"],
                                       "expected_policy_version": authorization["authorized_policy_version"]}
        selection = None
        if mandate["candidate_source"] == "scan_pool":
            from . import portfolio_candidates
            selection = portfolio_candidates.select_candidates(portfolio_candidates.SelectorInput(
                scope=template["scope"], strategy_weights=template["strategy_weights"],
                min_score=template["constraints"]["min_score"], min_matches=template["constraints"]["min_matches"],
                limit=mandate["selector_limit"]))
            if selection["status"] == "blocked":
                return None, account, "waiting", "等待自動候選池來源：" + "；".join(item["message"] for item in selection["reasons"]), None, None
            # Empty eligible selection still gets a trace of complete below-threshold
            # rows. These review symbols cannot become liquidation targets.
            template["candidate_symbols"] = selection["candidate_symbols"] or selection["review_symbols"]
        workflow = agent.WorkflowInput.model_validate(template)
        result = agent.preview(workflow)
        result["candidate_source"] = mandate["candidate_source"]
        if selection is not None:
            result["candidate_selection"] = selection
        result.pop("proposal_fingerprint", None)
        result["proposal_fingerprint"] = hashlib.sha256(_json(result).encode()).hexdigest()
        if result["as_of"] != expected:
            return None, account, "waiting", "交易日已切換，等待下一輪檢查", None, None
        if result["scan"] is None or any(issue["code"].startswith("scan_") for issue in result["blocking_reasons"]):
            return None, account, "waiting", "等待最新已完成交易日、相同股票池與目前輸入版本的選股快照", None, None
        if result["coverage"]["complete"] != result["coverage"]["requested"]:
            return None, account, "waiting", f"必要候選策略或行情尚未完整（{result['coverage']['complete']}/{result['coverage']['requested']}）；不消耗當日嘗試", None, None
        preflight = None
        if result["status"] == "proposed":
            targets = result["target_weights"]
            if account["kill_switch"]:
                # Paused account with reduce-only allowed: preflight the clamped targets, never the agent's growth.
                with store.connect() as db:
                    reduction = reduce_only.plan(db, account, targets, expected, "kill_switch")
                if reduction is None:
                    return None, account, "waiting", "等待持倉的當期有效行情以計算純減倉目標", None, None
                targets = reduction["targets_after"]
            preflight = paper.preview(mandate["account_id"], paper.PreviewInput(
                expected_version=account["version"], targets=targets,
                expected_input_revision=result["input_revision"], expected_as_of=expected))
            if not preflight["valuation_complete"]:
                return None, account, "waiting", "等待虛擬帳戶全部必要持倉與目標的當期有效 USD 行情", None, None
        with store.connect() as db:
            evidence = triggers.evaluate(db, mandate, result, preflight, expected)
        if evidence["outcome"] == "waiting":
            reasons = {"quote_unavailable": "等待所有現有與目標持倉的當期有效行情",
                       "nonpositive_equity": "虛擬帳戶淨值非正值，無法判斷配置偏離",
                       "fill_session_incomplete": "最近模擬成交的執行交易日尚未完成，等待當期估值",
                       triggers.REGIME_WAITING: "市場風險溫度計不完整，無法判斷 regime 變動；等待讀數"}
            return None, account, "waiting", "；".join(reasons[code] for code in evidence["reason_codes"]), evidence, None
        return result, account, "ready", None, evidence, reduction


def _record_attempt_result(identifier, extra):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT result_json FROM agent_automation_attempts WHERE id=?", (identifier,)).fetchone()
        merged = {**(json.loads(row["result_json"]) if row and row["result_json"] else {}), **extra}
        db.execute("UPDATE agent_automation_attempts SET result_json=? WHERE id=?", (_json(merged), identifier))


def _outcome_classification(flags, relevant):
    """Validate finite family counts, then apply the existing fixed ledger threshold."""
    from . import decision_ledger
    if not isinstance(flags, list):
        raise ValueError("outcome_flags_missing")
    selected = []
    for family in relevant:
        matches = [flag for flag in flags if isinstance(flag, dict) and flag.get("family") == family]
        if len(matches) != 1:
            raise ValueError("outcome_family_missing")
        flag = matches[0]
        count, rate = flag.get("n_settled"), flag.get("hit_rate")
        if type(count) is not int or count < 0:
            raise ValueError("outcome_count_invalid")
        if (count > 0 and (type(rate) not in (int, float) or not math.isfinite(rate) or not 0 <= rate <= 1)
                or count == 0 and rate is not None):
            raise ValueError("outcome_rate_unavailable")
        status = ("insufficient" if count < decision_ledger.HIT_RATE_MIN_SETTLED else
                  "low" if rate < decision_ledger.HIT_RATE_LOW else "ok")
        if flag.get("status") != status:
            raise ValueError("outcome_status_inconsistent")
        selected.append(flag)
    low = [flag["family"] for flag in selected if flag["status"] == "low"]
    status = "low" if low else "ok" if any(flag["status"] == "ok" for flag in selected) else "insufficient"
    return status, low


def _outcome_evidence(db, mandate, run, requested_mode, run_id, account_version):
    """Freeze one local evaluation in the caller's claim transaction, before any paid gate."""
    from . import decision_ledger
    relevant = ["agent_targets"] + (["jev_gate"] if json.loads(mandate["jev_gate_json"])["enabled"] else [])
    evidence = {"engine_version": OUTCOME_GUARD_VERSION, "decision_engine_version": decision_ledger.ENGINE_VERSION,
                "scope": "workspace_decision_families", "account_id": mandate["account_id"], "account_version": account_version,
                "run_id": run_id, "as_of": run["as_of"], "input_revision": run["input_revision"],
                "horizon_sessions": decision_ledger.HIT_RATE_HORIZON, "window_sessions": decision_ledger.HIT_RATE_WINDOW,
                "required_settled": decision_ledger.HIT_RATE_MIN_SETTLED, "low_threshold": decision_ledger.HIT_RATE_LOW,
                "relevant_families": relevant, "flags": [], "low_families": [], "settled_as_of": None,
                "requested_mode": requested_mode, "effective_mode": requested_mode,
                "status": "unavailable", "manual_review": True, "reason_code": "outcome_evidence_unavailable", "error": None}
    try:
        flags = decision_ledger.hit_rate_flags(db, mandate["account_id"], run["as_of"])
        if (flags["settled_as_of"] != run["as_of"] or flags["as_of"] != run["as_of"]
                or store.input_revision(db) != run["input_revision"]):
            raise ValueError("outcome_snapshot_mismatch")
        if (flags["engine_version"] != decision_ledger.ENGINE_VERSION
                or any(flags[key] != evidence[key] for key in ("horizon_sessions", "window_sessions", "required_settled", "low_threshold"))):
            raise ValueError("outcome_method_mismatch")
        status, low = _outcome_classification(flags["flags"], relevant)
        evidence.update(status=status, low_families=low, flags=flags["flags"], settled_as_of=flags["settled_as_of"],
                        manual_review=bool(low), reason_code="outcome_hit_rate_low" if low else None)
    except (HTTPException, sqlite3.OperationalError, KeyError, TypeError, ValueError) as exc:
        # Unavailable evidence is never mislabeled low or replaced by a guessed rate.
        evidence["error"] = {"code": "outcome_evidence_unavailable", "reason": str(exc)[:200]}
    evidence["effective_mode"] = "proposal_only" if evidence["manual_review"] else requested_mode
    evidence["downgraded"] = requested_mode == "auto_simulate" and evidence["effective_mode"] == "proposal_only"
    warning = {"status": evidence["status"], "code": evidence["reason_code"], "engine_version": evidence["decision_engine_version"],
               **{key: evidence[key] for key in ("horizon_sessions", "required_settled", "low_threshold", "flags", "relevant_families")}}
    return evidence, warning


def _verify_outcome_guard(row, mandate):
    """Recheck the frozen v3 classification, not a changing second outcome sample."""
    from . import decision_ledger
    evidence = (json.loads(row["result_json"]) if row["result_json"] else {}).get("outcome_guard")
    relevant = ["agent_targets"] + (["jev_gate"] if json.loads(mandate["jev_gate_json"])["enabled"] else [])
    expected = {"engine_version": OUTCOME_GUARD_VERSION, "decision_engine_version": decision_ledger.ENGINE_VERSION,
                "scope": "workspace_decision_families", "account_id": row["account_id"], "account_version": row["account_version"],
                "run_id": row["run_id"], "as_of": row["session_date"], "input_revision": row["input_revision"],
                "horizon_sessions": decision_ledger.HIT_RATE_HORIZON, "window_sessions": decision_ledger.HIT_RATE_WINDOW,
                "required_settled": decision_ledger.HIT_RATE_MIN_SETTLED, "low_threshold": decision_ledger.HIT_RATE_LOW,
                "relevant_families": relevant, "effective_mode": row["mode"]}
    try:
        if not isinstance(evidence, dict) or any(evidence.get(key) != value for key, value in expected.items()):
            raise ValueError("outcome_guard_binding_mismatch")
        requested = evidence.get("requested_mode")
        if requested not in ("proposal_only", "auto_simulate") or (requested == "auto_simulate" and mandate["mode"] != "auto_simulate"):
            raise ValueError("outcome_guard_mode_mismatch")
        if evidence.get("status") == "unavailable":
            status, low, review, code = "unavailable", [], True, "outcome_evidence_unavailable"
            if not isinstance(evidence.get("error"), dict) or evidence["error"].get("code") != code:
                raise ValueError("outcome_guard_missing_error")
        else:
            status, low = _outcome_classification(evidence.get("flags"), relevant)
            review, code = bool(low), "outcome_hit_rate_low" if low else None
            if evidence.get("settled_as_of") != row["session_date"]:
                raise ValueError("outcome_guard_session_mismatch")
        effective = "proposal_only" if review else requested
        if (evidence.get("status") != status or evidence.get("low_families") != low
                or evidence.get("manual_review") is not review or evidence.get("reason_code") != code
                or effective != row["mode"] or evidence.get("downgraded") is not (requested == "auto_simulate" and effective == "proposal_only")):
            raise ValueError("outcome_guard_decision_mismatch")
    except (TypeError, ValueError, KeyError):
        raise HTTPException(409, "自動化結果降級證據缺失、不一致或未綁定本次嘗試；請重新檢閱") from None
    return evidence


def _outcome_note(evidence):
    if evidence is None or not evidence["manual_review"]:
        return ""
    if evidence["status"] == "unavailable":
        return "；結果證據無法評估（不是低命中率），本輪僅保存人工審閱提案，不自動成交或送單"
    low = [flag for flag in evidence["flags"] if flag["family"] in evidence["low_families"]]
    detail = "、".join(f"{flag['family']} 最近 {flag['n_settled']} 筆已結算決策命中率 {flag['hit_rate']:.0%}" for flag in low)
    return f"；工作區來源家族 {detail}，低於 {evidence['low_threshold']:.0%}，本輪僅保存人工審閱提案，不自動成交或送單"


def _jev_gate(attempt_id, run_id, policy):
    """One Jev decision run bound to the saved rules run; its evidence is stored before any proposal exists."""
    from . import jev_decision
    request_policy = {"pass_threshold": policy["pass_threshold"], "max_risk_probability": policy["max_risk_probability"]}
    try:
        decision = jev_decision.create_run(jev_decision.RunInput(
            source_run_id=run_id, idempotency_key=f"automation-jev:{attempt_id}",
            policy=jev_decision.GatePolicy(**request_policy)))
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "jev_error", "message": str(exc.detail)}
        evidence = {"status": "unavailable", "policy": request_policy, "error": detail}
        _record_attempt_result(attempt_id, {"jev_gate": evidence})
        return {"status": "unavailable", "reason_code": "jev_gate_unavailable",
                "reason": f"Jev 決策閘無法執行：{detail.get('message')}；不建立提案", "evidence": evidence}
    passed = decision["status"] == "completed" and decision["proposal_ready"]
    evidence = {"status": "pass" if passed else "blocked", "run_id": decision["id"], "engine_version": decision["engine_version"],
                "question_set_version": decision["question_set_version"], "model": decision["model"], "policy": decision["policy"],
                "counts": decision["counts"], "latency_ms": decision["latency_ms"], "estimated_cost_usd": decision["estimated_cost_usd"],
                "target_weights": decision["target_weights"], "cash_weight_pct": decision["cash_weight_pct"],
                "run_status": decision["status"], "error": decision["error"]}
    _record_attempt_result(attempt_id, {"jev_gate": evidence})
    if not passed:
        return {"status": "blocked", "reason_code": "jev_gate_blocked",
                "reason": "Jev 決策閘沒有標的通過門檻，或回應未通過驗證；不建立提案、不清空持倉", "evidence": evidence}
    return {"status": "pass", "reason_code": None, "reason": None, "evidence": evidence}


def _trigger_reason(codes):
    reasons = {"no_change": "目前配置與委託精度／最小金額政策沒有可執行調整",
               "drift_below_threshold": "最大配置偏離尚未達設定門檻",
               "cooldown_active": "距上次非零模擬成交的已完成交易日間隔不足",
               "regime_baseline_recorded": "首次記錄市場風險 band，作為後續變動的基準",
               "regime_unchanged": "市場風險 band 未達設定的變動階數"}
    return "；".join(reasons[code] for code in codes) + "；本交易日略過，下一個完成交易日再檢查"


def _claim_lifecycle_block(db, mandate, expected, instant, life, *, manual, allow_auto_simulate):
    """Commit a terminal daily claim without research; caller owns BEGIN IMMEDIATE."""
    account = _account(db, mandate["account_id"])
    attempt_id = uuid.uuid4().hex
    mode = "auto_simulate" if mandate["mode"] == "auto_simulate" and (not manual or allow_auto_simulate) else "proposal_only"
    # The existing schema requires text. An empty run_id explicitly means no research run exists.
    db.execute("""INSERT INTO agent_automation_attempts
        (id,mandate_id,session_date,mandate_version,account_id,account_version,mode,trigger_kind,status,
         started_at,finished_at,run_id,engine_version,input_revision,result_json,reason_code,reason)
         VALUES (?,?,?,?,?,?,?,?,'blocked',?,?,'',?,?,?,?,?)""",
               (attempt_id, mandate["id"], expected, mandate["version"], mandate["account_id"], account["version"], mode,
                "manual" if manual else "schedule", instant.isoformat(), instant.isoformat(), ENGINE_VERSION,
                store.input_revision(db), _json({"mandate_lifecycle": life}), life["blocked_code"], life["message"]))
    db.execute("UPDATE agent_mandates SET last_checked_at=?,last_status='blocked',last_reason=? WHERE id=?",
               (instant.isoformat(), life["message"], mandate["id"]))
    row = db.execute("SELECT * FROM agent_automation_attempts WHERE id=?", (attempt_id,)).fetchone()
    return {"status": "blocked", "mandate_id": mandate["id"], "attempt": _attempt(row)}


def _execute_locked(identifier, *, instant, expected_version=None, manual=False, allow_auto_simulate=False, stopping=lambda: False):
    expected = sessions.latest_completed_session(instant)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        mandate = _mandate(db, identifier)
        existing = db.execute("SELECT * FROM agent_automation_attempts WHERE mandate_id=? AND session_date=?", (identifier, expected)).fetchone()
        if expected_version is not None and expected_version != mandate["version"]:
            raise HTTPException(409, "任務已更新；請重新載入後再執行")
        if existing:
            return {"status": "already_attempted", "mandate_id": identifier, "attempt": _attempt(existing)}
        if not manual and not mandate["enabled"]:
            return {"status": "disabled", "mandate_id": identifier}
        if stopping():
            return {"status": "stopped", "mandate_id": identifier}
        life = lifecycle(mandate, expected)
        if life["blocked_code"]:
            return _claim_lifecycle_block(db, mandate, expected, instant, life,
                                          manual=manual, allow_auto_simulate=allow_auto_simulate)
    if stopping():
        return {"status": "stopped", "mandate_id": identifier}
    captured_scan_engine = scan_provenance.SCAN_ENGINE_VERSION
    result, account, readiness, reason, evidence, reduction = _ready(mandate, expected)
    if result is None:
        return _note_check(mandate, readiness, reason, instant)
    mode = "auto_simulate" if mandate["mode"] == "auto_simulate" and (not manual or allow_auto_simulate) else "proposal_only"
    attempt_id, run_id = uuid.uuid4().hex, uuid.uuid4().hex
    outcome_guard = None
    try:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = _mandate(db, identifier)
            if current["version"] != mandate["version"] or (not manual and not current["enabled"]) or stopping():
                return {"status": "changed", "mandate_id": identifier, "reason": "檢查期間任務設定已變更或停止；未消耗當日嘗試"}
            # A breach may revoke authority without a version bump while research is running.
            life = lifecycle(current, expected)
            if life["blocked_code"]:
                return _claim_lifecycle_block(db, current, expected, instant, life,
                                              manual=manual, allow_auto_simulate=allow_auto_simulate)
            current_account = _account(db, mandate["account_id"])
            if current_account["version"] != account["version"] or bool(current_account["kill_switch"]) != (reduction is not None):
                return {"status": "changed", "mandate_id": identifier, "reason": "檢查期間虛擬帳戶已變更；未消耗當日嘗試"}
            if (triggers.enabled(evidence["policy"]) and evidence["outcome"] != "blocked"
                    and triggers.latest_fill(db, identifier, mandate["account_id"]) != evidence["last_fill"]):
                return {"status": "changed", "mandate_id": identifier, "reason": "檢查期間最近模擬成交已變更；未消耗當日嘗試"}
            skipped = evidence["outcome"] == "skip"
            status = "skipped" if skipped else "running"
            codes = evidence["reason_codes"]
            trigger_reason = _trigger_reason(codes) if skipped else None
            attempt_result = {"rebalance_trigger": evidence}
            if result["status"] == "proposed" and evidence["outcome"] in ("pass", "disabled"):
                outcome_guard, outcome_warning = _outcome_evidence(db, mandate, result, mode, run_id, account["version"])
                attempt_result.update(outcome_guard=outcome_guard, outcome_warning=outcome_warning)
                mode = outcome_guard["effective_mode"]
            db.execute("""INSERT INTO agent_automation_attempts
                (id,mandate_id,session_date,mandate_version,account_id,account_version,mode,trigger_kind,status,
                 started_at,run_id,engine_version,input_revision,result_json,finished_at,reason_code,reason)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (attempt_id, identifier, expected, mandate["version"], mandate["account_id"], account["version"], mode,
                        "manual" if manual else "schedule", status, instant.isoformat(), run_id, ENGINE_VERSION, result["input_revision"],
                        _json(attempt_result), instant.isoformat() if skipped else None,
                        codes[0] if skipped else None, trigger_reason))
            run = agent.save_preview(db, agent.WorkflowInput.model_validate(result["request"]), result,
                                     identifier=run_id, captured_scan_engine=captured_scan_engine)
            db.execute("UPDATE agent_mandates SET last_checked_at=?,last_status=?,last_reason=? WHERE id=?",
                       (instant.isoformat(), status, trigger_reason, identifier))
    except sqlite3.IntegrityError:
        with store.connect() as db:
            existing = db.execute("SELECT * FROM agent_automation_attempts WHERE mandate_id=? AND session_date=?", (identifier, expected)).fetchone()
        if existing is None:
            raise
        return {"status": "already_attempted", "mandate_id": identifier, "attempt": _attempt(existing)}
    except HTTPException as exc:
        if exc.status_code != 409:
            raise
        return _note_check(mandate, "waiting", str(exc.detail), instant)
    if run["status"] != "proposed":
        return _finish(attempt_id, "blocked", "agent_blocked", "完整研究未產生合格目標；沒有清空持倉或紙上成交", result={"blocking_reasons": run["blocking_reasons"]})
    # The claim-snapshot decision survives every subsequent gate, finish and failure.
    outcome_note = _outcome_note(outcome_guard)
    if reduction is not None:
        # Paused account under reduce-only: the plan is recorded first; the final clamp after the gates decides.
        _record_attempt_result(attempt_id, {"reduce_only": reduction})
    if evidence["outcome"] == "skip":
        return _finish(attempt_id, "skipped", evidence["reason_codes"][0], _trigger_reason(evidence["reason_codes"]))
    if evidence["outcome"] == "blocked":
        return _finish(attempt_id, "blocked", "paper_risk_blocked", "紙上帳戶風險限制未通過，沒有模擬成交",
                       result={"violations": evidence["violations"]})
    targets = run["target_weights"]
    gate_policy = json.loads(mandate["jev_gate_json"])
    if gate_policy["enabled"]:
        # Fixed-outcome probability gate on the saved rules run; unavailable or blocked never falls back to ungated targets.
        gate = _jev_gate(attempt_id, run_id, gate_policy)
        if gate["status"] != "pass":
            return _finish(attempt_id, "blocked", gate["reason_code"], gate["reason"], result={"jev_gate": gate["evidence"]})
        targets = gate["evidence"]["target_weights"]
    from . import circuit_breakers, regime_overlay
    with store.connect() as db:
        overlay = regime_overlay.apply_scale(db, mandate["account_id"], targets, expected)
    overlay_note = ""
    if overlay["status"] != "disabled":
        # Scale mode shrinks the gated targets to the regime cap; an unavailable regime is recorded, never guessed.
        _record_attempt_result(attempt_id, {"regime_overlay": overlay})
        targets = overlay["targets_after"]
        overlay_note = regime_overlay.note(overlay)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        breaker = circuit_breakers.enforce(db, mandate["account_id"], expected, trigger="automation")
    # Pause and revoked authority must commit before the execution layer contacts Alpaca Paper.
    breaker = circuit_breakers._sweep_if_paused(mandate["account_id"], breaker)
    if breaker["tripped"]:
        return _finish(attempt_id, "blocked", "circuit_breaker_tripped", "風險斷路器已觸發；本次不建立提案或模擬成交",
                       result={"circuit_breaker": breaker, "account_version_after": breaker["account_version_after"]})
    reduce_note = ""
    if reduction is not None:
        from . import reduce_only
        reduction = reduce_only.finalize(reduction, targets)
        _record_attempt_result(attempt_id, {"reduce_only": reduction})
        if reduction["status"] == "no_change":
            return _finish(attempt_id, "skipped", "reduce_only_no_change",
                           "帳戶暫停中，閘後目標在純減倉模式下沒有任何持倉需要減碼；本交易日略過")
        targets = reduction["targets_after"]
        reduce_note = reduce_only.note(reduction)
    guard = _guard(attempt_id, not manual, stopping)
    source = {"mandate_id": identifier, "mandate_version": mandate["version"], "attempt_id": attempt_id}
    try:
        request = paper.ProposalInput(
            expected_version=account["version"], targets=targets,
            expected_input_revision=run["input_revision"], expected_as_of=expected,
            rationale=agent._paper_rationale(run) + f" 自動化任務 {identifier} v{mandate['version']}。"
            + (" 目標已經 Jev 決策閘過濾，未通過的標的歸零保留現金。" if gate_policy["enabled"] else "")
            + (overlay_note.lstrip("；") + "。" if overlay_note else "")
            + (reduce_note.lstrip("；") + "。" if reduce_note else "")
            + (outcome_note.lstrip("；") + "。" if outcome_note else ""),
            idempotency_key=f"automation-proposal:{attempt_id}",
            automation_source=source,
        )
        proposal = paper.create_proposal_guarded(mandate["account_id"], request, guard)
        with store.connect() as db:
            db.execute("UPDATE agent_automation_attempts SET paper_proposal_id=? WHERE id=? AND status='running'", (proposal["id"], attempt_id))
        if proposal["status"] == "blocked":
            return _finish(attempt_id, "blocked", "paper_risk_blocked", "紙上帳戶風險限制未通過，沒有模擬成交", proposal_id=proposal["id"], result={"violations": proposal["violations"]})
        if mode == "proposal_only":
            return _finish(attempt_id, "proposed", outcome_guard["reason_code"] if outcome_guard and outcome_guard["manual_review"] else "proposal_ready", "紙上提案已保存，等待使用者檢閱與明確接受" + overlay_note + reduce_note + outcome_note, proposal_id=proposal["id"])
        if mandate["execution_target"] == "alpaca_paper":
            # The mandate's explicit target is the standing acknowledgement; every other rail
            # (orders enabled, caps, circuit breakers, currency checks) is re-applied by the execution layer.
            from . import execution
            submission = execution.submit(mandate["account_id"], proposal["id"], execution.SubmitInput(
                target="alpaca_paper", expected_account_version=account["version"],
                idempotency_key=f"automation-submit:{attempt_id}", acknowledge_external=True))
            return _finish(attempt_id, "submitted", "alpaca_paper_submitted",
                           "已依任務設定送出 Alpaca Paper 委託；成交結果需在交易代理分頁核對" + overlay_note, proposal_id=proposal["id"],
                           result={"execution_submission_id": submission["id"], "execution_status": submission["status"],
                                   "execution_target": "alpaca_paper", "order_count": submission["order_count"]})
        accepted = paper.accept_proposal_guarded(mandate["account_id"], proposal["id"],
                                               paper.AcceptInput(expected_version=account["version"], idempotency_key=f"automation-accept:{attempt_id}"), guard)
        return _finish(attempt_id, "simulated", "paper_simulated", "依本次允許自動模擬的任務設定完成一次本機紙上模擬" + overlay_note + reduce_note + outcome_note, proposal_id=proposal["id"],
                       result={"paper_engine_version": accepted["account"]["engine_version"], "account_version_after": accepted["account"]["account"]["version"]})
    except HTTPException as exc:
        return _finish(attempt_id, "invalidated" if exc.status_code == 409 else "failed", "execution_revalidation_failed", str(exc.detail)[:500])
    except Exception as exc:
        return _finish(attempt_id, "failed", "execution_failed", str(exc)[:500])


@router.post("/api/agent-automation/mandates/{identifier}/run")
def run_mandate(identifier: str, body: RunInput):
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "已有本機 Agent 任務正在執行；請稍後檢閱狀態")
    try:
        _recover_interrupted()
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
                **_execute_locked(identifier, instant=_instant(), expected_version=body.expected_version,
                                  manual=True, allow_auto_simulate=body.allow_auto_simulate), "method": METHOD}
    finally:
        RUN_LOCK.release()


def tick(at=None, stopping=lambda: False):
    if stopping():
        return {"status": "stopped", "results": []}
    if not RUN_LOCK.acquire(blocking=False):
        return {"status": "busy", "results": []}
    try:
        _recover_interrupted()
        instant = _instant(at)
        with store.connect() as db:
            identifiers = [row[0] for row in db.execute("SELECT id FROM agent_mandates WHERE enabled=1 ORDER BY created_at,id")]
        results = []
        for identifier in identifiers:
            if stopping():
                break
            try:
                results.append(_execute_locked(identifier, instant=instant, stopping=stopping))
            except Exception as exc:
                logger.exception("Local Agent automation mandate failed")
                results.append({"mandate_id": identifier, "status": "error", "reason": str(exc)[:500]})
        return {"status": "checked" if identifiers else "disabled", "as_of": sessions.latest_completed_session(instant), "results": results}
    finally:
        RUN_LOCK.release()


class Scheduler:
    def __init__(self, clock=utcnow, interval=POLL_INTERVAL_SECONDS):
        self.clock, self.interval = clock, interval
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None:
            raise RuntimeError("Agent automation scheduler already started")
        self._thread = threading.Thread(target=self._run, name="alphaview-agent-automation", daemon=True)
        self._thread.start()
        return self

    def _run(self):
        while not self._stop.is_set():
            try:
                tick(self.clock(), stopping=self._stop.is_set)
            except Exception:
                logger.exception("Local Agent automation scheduler tick failed")
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join()
