"""Paper-account circuit breakers: daily loss, drawdown and fill-count limits.

A tripped breaker refuses new paper fills and, when auto-pause is on, flips the
existing account kill switch. Baselines come only from captured NAV snapshots;
missing evidence is reported as unavailable and never trips anything.
"""
import json
import math
import uuid
from decimal import Decimal, localcontext

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-circuit-breaker-v1"
CHECKS = ("daily_loss", "max_drawdown", "max_fills_per_session")
LABELS = {"daily_loss": "每日虧損上限", "max_drawdown": "最大回撤上限", "max_fills_per_session": "單日成交筆數上限"}
METHOD = (
    "Three independent limits evaluated on the latest completed session against the paper account's own "
    "records. daily_loss compares the current complete paper valuation with the latest captured NAV snapshot "
    "dated strictly before the session; max_drawdown compares it with the highest captured complete NAV; "
    "max_fills_per_session counts simulated fills whose proposal belongs to the session. A limit that is not "
    "set is disabled; a check without a complete valuation or without a captured snapshot is unavailable and "
    "never trips. Any tripped check refuses new paper fills, and with auto_pause it also sets the account "
    "kill switch, which stays on until the user resumes the account. With reduce_only_allowed, a paused account "
    "or a tripped breaker still admits a proposal whose risk_direction is 'reducing' (every target weight at or "
    "below the current weight, no new symbol, so cash can only rise); anything that buys stays refused. Nothing "
    "here reads intraday prices, broker accounts or real holdings."
)
WARNINGS = [
    "斷路器只作用於本機 paper 帳戶；沒有實盤帳戶、券商或盤中價格。",
    "基準只來自已擷取的 NAV 快照；沒有快照或估值不完整時為「不可用」，不會觸發，也不會補值。",
    "觸發後帳戶維持暫停直到使用者手動恢復；恢復不會清除歷史事件。",
    "純減倉例外只放行每個標的目標權重都不高於目前權重、且不新增標的的提案；估值不完整時不放行。",
]


class Policy(agent.StrictInput):
    daily_loss_limit_pct: float | None = Field(default=None, ge=0.1, le=50)
    max_drawdown_pct: float | None = Field(default=None, ge=1, le=90)
    max_fills_per_session: int | None = Field(default=None, ge=1, le=100)
    auto_pause: bool = True
    # Reduce-only mode: exits may pass a pause or a tripped breaker; buys never do.
    reduce_only_allowed: bool = False


class PolicyInput(agent.StrictInput):
    policy: Policy
    expected_version: int = Field(ge=1)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite(value, digits=4):
    if value is None:
        return None
    number = float(value)
    return round(number, digits) if math.isfinite(number) else None


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS paper_circuit_breakers (
        account_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS paper_circuit_breaker_events (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('tripped','evaluated','resumed','policy_changed')),
        session_date TEXT, reason_code TEXT, evidence_json TEXT NOT NULL,
        account_version_before INTEGER, account_version_after INTEGER, created_at TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_paper_circuit_breaker_events_account ON paper_circuit_breaker_events(account_id,created_at)")


def _stored(db, account_id):
    row = db.execute("SELECT policy_json,version FROM paper_circuit_breakers WHERE account_id=?", (account_id,)).fetchone()
    return (json.loads(row["policy_json"]), row["version"]) if row else ({}, 1)


def current_policy(db, account_id):
    """Stored policy and version; an account without a row is version 1 with every limit off.

    The regime overlay keeps its own object in the same JSON (see regime_overlay.py) and is not part of this policy.
    """
    data, version = _stored(db, account_id)
    if not data:
        return Policy().model_dump(), version
    return Policy.model_validate({key: value for key, value in data.items() if key != "regime_overlay"}).model_dump(), version


def _event(db, account_id, kind, *, session_date=None, reason_code=None, evidence=None, before=None, after=None):
    db.execute("""INSERT INTO paper_circuit_breaker_events
        (id,account_id,kind,session_date,reason_code,evidence_json,account_version_before,account_version_after,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)""",
               (uuid.uuid4().hex, account_id, kind, session_date, reason_code, _json(evidence or {}), before, after, store.now()))


def _snapshots(db, account_id):
    rows = db.execute("SELECT id,as_of,snapshot_json FROM paper_nav_snapshots WHERE account_id=? ORDER BY as_of,id", (account_id,)).fetchall()
    complete = []
    for row in rows:
        snapshot = json.loads(row["snapshot_json"])
        equity = snapshot.get("equity")
        if snapshot.get("valuation_complete") and isinstance(equity, (int, float)) and math.isfinite(equity) and equity > 0:
            complete.append({"id": row["id"], "as_of": row["as_of"], "equity": Decimal(str(equity))})
    return complete


def _fills_in_session(db, account_id, as_of):
    rows = db.execute("""SELECT p.preview_json FROM paper_ledger l JOIN paper_proposals p ON p.id=l.proposal_id
        WHERE l.account_id=? AND l.kind='simulated_fill'""", (account_id,)).fetchall()
    return sum(json.loads(row["preview_json"]).get("as_of") == as_of for row in rows)


def _check(code, enabled, limit, *, observed=None, status=None, reason=None, detail=None):
    return {"code": code, "label": LABELS[code], "enabled": enabled, "observed": _finite(observed), "limit": limit,
            "status": status, "reason": reason, "detail": detail or {}}


def evaluate(db, account_id, as_of):
    """Read-only evaluation; every number comes from the account's own paper records."""
    account = paper._account(db, account_id)
    policy, version = current_policy(db, account_id)
    with localcontext() as context:
        context.prec = 50
        valuation = paper._valuation(db, account, as_of)
        equity = Decimal(str(valuation["equity"])) if valuation["equity"] is not None else None
        snapshots = _snapshots(db, account_id)
        prior = [snapshot for snapshot in snapshots if snapshot["as_of"] < as_of]
        baseline = prior[-1] if prior else None
        peak = max(snapshots, key=lambda snapshot: (snapshot["equity"], snapshot["as_of"], snapshot["id"])) if snapshots else None
        fills = _fills_in_session(db, account_id, as_of)
        checks = []
        for code, limit in (("daily_loss", policy["daily_loss_limit_pct"]), ("max_drawdown", policy["max_drawdown_pct"])):
            reference = baseline if code == "daily_loss" else peak
            if limit is None:
                checks.append(_check(code, False, None, status="disabled"))
            elif equity is None:
                checks.append(_check(code, True, limit, status="unavailable", reason="valuation_incomplete",
                                     detail={"missing": valuation["coverage"]["missing"]}))
            elif reference is None:
                checks.append(_check(code, True, limit, status="unavailable",
                                     reason="no_prior_nav_snapshot" if code == "daily_loss" else "no_nav_snapshot"))
            else:
                change = (equity / reference["equity"] - 1) * 100
                checks.append(_check(code, True, limit, observed=change, status="tripped" if change <= -Decimal(str(limit)) else "pass",
                                     detail={"equity": _finite(equity, 2), "reference_equity": _finite(reference["equity"], 2),
                                             "reference_as_of": reference["as_of"], "reference_snapshot_id": reference["id"]}))
        limit = policy["max_fills_per_session"]
        if limit is None:
            checks.append(_check("max_fills_per_session", False, None, status="disabled", detail={"fills": fills}))
        else:
            checks.append(_check("max_fills_per_session", True, limit, observed=fills, status="tripped" if fills >= limit else "pass",
                                 detail={"fills": fills}))
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
            "kill_switch": bool(account["kill_switch"]), "as_of": as_of, "policy": policy, "policy_version": version,
            "checks": checks, "tripped": any(check["status"] == "tripped" for check in checks),
            "tripped_codes": [check["code"] for check in checks if check["status"] == "tripped"],
            "unavailable": [check["code"] for check in checks if check["status"] == "unavailable"],
            "valuation_complete": valuation["valuation_complete"]}


def enforce(db, account_id, as_of, *, trigger):
    """Caller holds a write transaction; pauses the account when a tripped check allows it."""
    evaluation = evaluate(db, account_id, as_of)
    before = evaluation["account_version"]
    already_paused, paused_now, after = evaluation["kill_switch"], False, before
    if evaluation["tripped"] and not already_paused and evaluation["policy"]["auto_pause"]:
        after = before + 1
        db.execute("UPDATE paper_accounts SET kill_switch=1,version=version+1,updated_at=? WHERE id=? AND version=?",
                   (store.now(), account_id, before))
        _event(db, account_id, "tripped", session_date=as_of, reason_code=evaluation["tripped_codes"][0],
               evidence={"trigger": trigger, "checks": evaluation["checks"], "policy_version": evaluation["policy_version"]},
               before=before, after=after)
        paused_now = True
    if evaluation["tripped"] and trigger != "read":
        # A quantitative breach revokes standing automation authority until a human renews the mandate.
        from .agent_automation import require_reauth
        require_reauth(db, account_id, "circuit_breaker_tripped:" + evaluation["tripped_codes"][0])
    if trigger != "read":
        _event(db, account_id, "evaluated", session_date=as_of,
               reason_code=evaluation["tripped_codes"][0] if evaluation["tripped"] else None,
               evidence={"trigger": trigger, "tripped": evaluation["tripped"], "unavailable": evaluation["unavailable"],
                         "checks": evaluation["checks"], "paused_now": paused_now}, before=before, after=after)
    return {**evaluation, "paused_now": paused_now, "already_paused": already_paused,
            "kill_switch": already_paused or paused_now, "account_version_after": after}


def reduce_only_allowed(db, account_id):
    """Stored reduce-only flag; accounts without a policy row keep the default (off)."""
    return bool(current_policy(db, account_id)[0].get("reduce_only_allowed", False))


def reduce_only_hint(allowed, direction):
    """Suffix for refusals so the user learns why an exit did or did not qualify."""
    if not allowed:
        return "；reduce_only 未啟用：斷路器政策可允許純減倉提案（只賣不買）通過暫停"
    shown = direction or "unavailable"
    return f"；reduce_only 已啟用，但本提案不是純減倉（risk_direction={shown}），仍不放行"


def reduce_only_exempt(db, account_id, preview):
    """A stored/fresh preview passes a pause or a trip only when it is strictly risk-reducing."""
    return preview.get("risk_direction") == "reducing" and reduce_only_allowed(db, account_id)


def _refusal(status, *, allowed=False, direction=None):
    parts = [f"{LABELS[check['code']]} {check['observed']} / {check['limit']}" for check in status["checks"] if check["status"] == "tripped"]
    suffix = "；帳戶已自動暫停" if status["paused_now"] else "；帳戶已暫停" if status["already_paused"] else "；帳戶未自動暫停（auto_pause 關閉）"
    return ("circuit_breaker_tripped：風險斷路器已觸發（" + "、".join(parts) + "）" + suffix + "，本次不模擬成交；請到風險斷路器面板檢閱"
            + reduce_only_hint(allowed, direction))


def guard_fill(account_id, proposal_id, as_of, *, trigger):
    """Own short write transaction so an auto-pause survives the refused fill that follows.

    Skips proposals that are no longer 'proposed' so idempotent accept replays keep working.
    A tripped breaker still lets a strictly reducing proposal through when the policy allows it.
    """
    with paper._write() as db:
        row = db.execute("SELECT status,preview_json FROM paper_proposals WHERE id=? AND account_id=?", (proposal_id, account_id)).fetchone()
        if row is None or row["status"] != "proposed":
            return None
        status = enforce(db, account_id, as_of, trigger=trigger)
        direction = json.loads(row["preview_json"]).get("risk_direction")
        allowed = bool(status["policy"].get("reduce_only_allowed", False))
    status = _sweep_if_paused(account_id, status)
    if status["tripped"]:
        if allowed and direction == "reducing":
            return {**status, "reduce_only_exempt": True}
        raise HTTPException(409, _refusal(status, allowed=allowed, direction=direction))
    return {**status, "reduce_only_exempt": False}


def _sweep_if_paused(account_id, status):
    """A pause that just committed also cancels the account's working Alpaca orders (reported, never raised)."""
    if not status.get("paused_now"):
        return status
    from .execution import sweep_after_pause
    return {**status, "execution_sweep": sweep_after_pause(account_id, "circuit_breaker_tripped:" + status["tripped_codes"][0])}


def record_resume(db, account_id, version_before):
    _event(db, account_id, "resumed", evidence={"trigger": "controls"}, before=version_before, after=version_before + 1)


def _public(db, account_id, evaluation):
    return {**evaluation, "input_revision": store.input_revision(db), "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/paper/accounts/{account_id}/circuit-breakers")
@store.snapshot_read
def get_breakers(account_id: str):
    with store.connect() as db:
        return _public(db, account_id, evaluate(db, account_id, sessions.latest_completed_session()))


@router.put("/api/paper/accounts/{account_id}/circuit-breakers")
def put_breakers(account_id: str, body: PolicyInput):
    with paper._write() as db:
        paper._account(db, account_id)
        previous, version = current_policy(db, account_id)
        if body.expected_version != version:
            raise _problem("policy_changed", "斷路器設定已在其他視窗更新；請重新載入後再儲存")
        policy = body.policy.model_dump()
        stored, _ = _stored(db, account_id)
        # A breaker save never touches the regime overlay stored alongside it.
        row_json = {**policy, **({"regime_overlay": stored["regime_overlay"]} if stored.get("regime_overlay") else {})}
        db.execute("""INSERT INTO paper_circuit_breakers(account_id,policy_json,version,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET policy_json=excluded.policy_json,version=excluded.version,updated_at=excluded.updated_at""",
                   (account_id, _json(row_json), version + 1, store.now()))
        _event(db, account_id, "policy_changed", evidence={"previous": previous, "policy": policy, "version": version + 1})
        return _public(db, account_id, evaluate(db, account_id, sessions.latest_completed_session()))


@router.post("/api/paper/accounts/{account_id}/circuit-breakers/evaluate")
def evaluate_now(account_id: str):
    with paper._write() as db:
        status = enforce(db, account_id, sessions.latest_completed_session(), trigger="manual")
        public = _public(db, account_id, status)
    return _sweep_if_paused(account_id, public)


@router.get("/api/paper/accounts/{account_id}/circuit-breakers/events")
@store.snapshot_read
def events(account_id: str, limit: int = Query(default=50, ge=1, le=100)):
    with store.connect() as db:
        paper._account(db, account_id)
        rows = db.execute("SELECT * FROM paper_circuit_breaker_events WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
                          (account_id, limit)).fetchall()
        return {"engine_version": ENGINE_VERSION, "account_id": account_id, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db),
                "events": [{"id": row["id"], "kind": row["kind"], "session_date": row["session_date"], "reason_code": row["reason_code"],
                            "evidence": json.loads(row["evidence_json"]), "account_version_before": row["account_version_before"],
                            "account_version_after": row["account_version_after"], "created_at": row["created_at"]} for row in rows]}
