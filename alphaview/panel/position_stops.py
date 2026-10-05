"""Position stops for paper accounts: absolute stop-loss, trailing stop and re-entry cooldown.

Evaluated on the latest completed session from the paper account's own cost
basis and the raw closes since the fill that opened the position. A tripped
holding becomes a sell-to-zero line in an ordinary paper proposal that still
needs explicit acceptance; nothing is sold automatically. Missing prices or an
unknown entry session make a check unavailable, never a trip.
"""
import json
import uuid
from decimal import Decimal, ROUND_DOWN
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-position-stops-v1"
HUNDRED = Decimal(100)
WEIGHT_STEP = Decimal("0.00000001")
METHOD = (
    "For every paper holding on the latest completed session: average cost = cost basis / shares; entry session = the "
    "as_of of the proposal whose fill last moved the position from zero to positive (ledger order); peak = highest raw "
    "close strictly after the entry session up to and including the session. stop_loss trips when close <= average cost "
    "x (1 - stop_loss_pct/100); trailing_stop trips when close <= peak x (1 - trailing_stop_pct/100) and the peak is "
    "above the average cost. A missing current price, unknown entry session or missing peak makes that check "
    "unavailable. The stop proposal keeps every other holding at its current weight (market value / equity, rounded "
    "down to eight decimals) and sets tripped symbols to zero; it is refused when any holding lacks a price. Tripped "
    "symbols receive a cooldown until the Nth later session; a target that would open a position in a symbol under "
    "cooldown is a paper violation (stop_cooldown). Stops are close-confirmed, never intraday."
)
WARNINGS = [
    "停損以收盤確認並產生提案；沒有盤中觸價、沒有自動賣出，跳空可能使實際虧損大於設定。",
    "峰值只看進場成交之後的本機收盤；沒有進場紀錄（例如分支開帳）時追蹤停損不可用。",
    "冷卻期在建立停損提案時記錄；拒絕提案不會自動解除，可在面板手動移除。",
]


class Policy(agent.StrictInput):
    enabled: bool = False
    stop_loss_pct: float | None = Field(default=None, ge=1, le=50)
    trailing_stop_pct: float | None = Field(default=None, ge=1, le=50)
    cooldown_sessions: int = Field(default=5, ge=0, le=60)


class PolicyInput(agent.StrictInput):
    policy: Policy
    expected_version: int = Field(ge=0)


class ProposalInput(agent.StrictInput):
    expected_account_version: int = Field(ge=1, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS paper_position_stops (
        account_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS paper_stop_cooldowns (
        account_id TEXT NOT NULL, symbol TEXT NOT NULL, until_session TEXT NOT NULL, reason TEXT NOT NULL,
        proposal_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(account_id, symbol)
    )""")


def _policy_row(db, account_id):
    row = db.execute("SELECT * FROM paper_position_stops WHERE account_id=?", (account_id,)).fetchone()
    if row is None:
        return Policy().model_dump(), 0
    return json.loads(row["policy_json"]), row["version"]


def _entry_session(db, account_id, symbol):
    """Session (proposal as_of) of the fill that last opened the current position; None when unknown."""
    quantity, entry = Decimal(0), None
    for row in db.execute("SELECT shares_delta, proposal_id, kind FROM paper_ledger WHERE account_id=? AND symbol=? ORDER BY id",
                          (account_id, symbol)):
        delta = Decimal(str(row["shares_delta"]))
        before, quantity = quantity, quantity + delta
        if before <= 0 < quantity:
            entry = None
            if row["proposal_id"]:
                proposal = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (row["proposal_id"],)).fetchone()
                if proposal:
                    entry = json.loads(proposal["preview_json"]).get("as_of")
        elif quantity <= 0:
            entry = None
    return entry


def _peak_close(db, symbol, entry_session, as_of):
    row = db.execute("SELECT MAX(close) AS peak FROM bars WHERE symbol=? AND date>? AND date<=?", (symbol, entry_session, as_of)).fetchone()
    peak = row["peak"] if row else None
    return Decimal(str(peak)) if peak is not None and peak > 0 else None


def evaluate(db, account_id, as_of):
    policy, version = _policy_row(db, account_id)
    account = paper._account(db, account_id)
    stop = Decimal(str(policy["stop_loss_pct"])) / HUNDRED if policy.get("stop_loss_pct") else None
    trailing = Decimal(str(policy["trailing_stop_pct"])) / HUNDRED if policy.get("trailing_stop_pct") else None
    holdings, tripped, unavailable = [], [], []
    for position in paper._holdings(db, account_id):
        symbol = position["symbol"]
        shares, basis = Decimal(str(position["shares"])), Decimal(str(position["cost_basis"]))
        average = basis / shares if shares > 0 else None
        quote = paper._quote(db, symbol, as_of)
        close = Decimal(str(quote["price"])) if quote["price"] is not None else None
        entry = _entry_session(db, account_id, symbol)
        peak = _peak_close(db, symbol, entry, as_of) if entry else None
        checks = []
        status = "hold"
        if policy["enabled"] and stop is not None:
            if close is None or average is None:
                checks.append({"code": "stop_loss", "status": "unavailable", "reason": quote.get("reason") or "price_unavailable"})
            else:
                limit = average * (1 - stop)
                hit = close <= limit
                checks.append({"code": "stop_loss", "status": "tripped" if hit else "pass", "limit": float(limit),
                               "observed": float(close), "loss_from_cost_pct": float((close / average - 1) * 100)})
                if hit:
                    status = "stop_loss"
        if policy["enabled"] and trailing is not None:
            if close is None or entry is None or peak is None or average is None:
                checks.append({"code": "trailing_stop", "status": "unavailable",
                               "reason": "entry_session_unknown" if entry is None else "peak_unavailable" if peak is None else "price_unavailable"})
            elif peak <= average:
                checks.append({"code": "trailing_stop", "status": "pass", "reason": "no_gain_since_entry", "peak": float(peak), "observed": float(close)})
            else:
                limit = peak * (1 - trailing)
                hit = close <= limit
                checks.append({"code": "trailing_stop", "status": "tripped" if hit else "pass", "limit": float(limit), "peak": float(peak),
                               "observed": float(close), "drawdown_from_peak_pct": float((close / peak - 1) * 100)})
                if hit and status == "hold":
                    status = "trailing_stop"
        if any(check["status"] == "unavailable" for check in checks) and status == "hold":
            status = "unavailable"
        holdings.append({"symbol": symbol, "shares": float(shares), "average_cost": float(average) if average is not None else None,
                         "close": float(close) if close is not None else None, "entry_session": entry,
                         "peak_close": float(peak) if peak is not None else None, "status": status, "checks": checks})
        if status in ("stop_loss", "trailing_stop"):
            tripped.append(symbol)
        if status == "unavailable":
            unavailable.append(symbol)
    cooldowns = [dict(row) for row in db.execute(
        "SELECT symbol,until_session,reason,proposal_id,created_at FROM paper_stop_cooldowns WHERE account_id=? AND until_session>=? ORDER BY symbol",
        (account_id, as_of))]
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "policy": policy, "policy_version": version, "holdings": holdings, "tripped": tripped, "unavailable": unavailable,
            "cooldowns": cooldowns}


def cooldown_violations(db, account_id, targets, held, as_of):
    """Paper-preview hook: opening a position in a symbol under cooldown is a violation."""
    active = {row["symbol"]: row for row in db.execute(
        "SELECT symbol,until_session,reason FROM paper_stop_cooldowns WHERE account_id=? AND until_session>=?", (account_id, as_of))}
    violations = []
    for symbol, weight in targets.items():
        if weight > 0 and symbol not in held and symbol in active:
            violations.append({"code": "stop_cooldown", "symbol": symbol,
                               "message": f"{symbol} 因{active[symbol]['reason']}停損處於冷卻期至 {active[symbol]['until_session']}，不重新建倉"})
    return violations


def _cooldown_until(as_of, count):
    if count <= 0:
        return as_of
    from datetime import date, timedelta
    later = sessions.expected_sessions(as_of, (date.fromisoformat(as_of) + timedelta(days=count * 3 + 21)).isoformat())
    later = [day for day in later if day > as_of]
    return later[count - 1] if len(later) >= count else later[-1] if later else as_of


def _targets_after_stops(db, account, as_of, evaluation):
    """Current weights for kept holdings, zero for tripped; refused when any holding lacks a price."""
    equity = Decimal(str(account["cash"]))
    values = {}
    for position in paper._holdings(db, account["id"]):
        quote = paper._quote(db, position["symbol"], as_of)
        if quote["price"] is None:
            raise _problem("valuation_incomplete", f"{position['symbol']} 沒有當期有效行情，無法建立完整目標；未建立停損提案", 422)
        values[position["symbol"]] = Decimal(str(position["shares"])) * Decimal(str(quote["price"]))
        equity += values[position["symbol"]]
    if equity <= 0:
        raise _problem("nonpositive_equity", "虛擬帳戶淨值非正值，無法建立停損提案", 422)
    tripped = set(evaluation["tripped"])
    targets = []
    for symbol, value in sorted(values.items()):
        weight = Decimal(0) if symbol in tripped else (value / equity * HUNDRED).quantize(WEIGHT_STEP, rounding=ROUND_DOWN)
        targets.append({"symbol": symbol, "weight_pct": float(weight)})
    return targets


@router.get("/api/paper/accounts/{account_id}/position-stops")
@store.snapshot_read
def get_stops(account_id: str):
    with store.connect() as db:
        result = evaluate(db, account_id, sessions.latest_completed_session())
        return {**result, "input_revision": store.input_revision(db), "method": METHOD, "warnings": list(WARNINGS)}


@router.put("/api/paper/accounts/{account_id}/position-stops")
def put_stops(account_id: str, body: PolicyInput):
    with paper._write() as db:
        paper._account(db, account_id)
        _, version = _policy_row(db, account_id)
        if version != body.expected_version:
            raise _problem("policy_changed", "停損政策已在其他視窗更新；請重新載入")
        now = store.now()
        if version == 0:
            db.execute("INSERT INTO paper_position_stops(account_id,policy_json,version,updated_at) VALUES (?,?,1,?)",
                       (account_id, _json(body.policy.model_dump()), now))
        else:
            db.execute("UPDATE paper_position_stops SET policy_json=?,version=version+1,updated_at=? WHERE account_id=?",
                       (_json(body.policy.model_dump()), now, account_id))
        result = evaluate(db, account_id, sessions.latest_completed_session())
        return {**result, "input_revision": store.input_revision(db), "method": METHOD, "warnings": list(WARNINGS)}


@router.post("/api/paper/accounts/{account_id}/position-stops/proposal", status_code=201)
def stop_proposal(account_id: str, body: ProposalInput):
    as_of = sessions.latest_completed_session()
    with store.read_snapshot():
        with store.connect() as db:
            account = paper._account(db, account_id)
            paper._version(account, body.expected_account_version)
            evaluation = evaluate(db, account_id, as_of)
            if not evaluation["policy"]["enabled"]:
                raise _problem("stops_disabled", "停損政策尚未啟用", 422)
            if not evaluation["tripped"]:
                raise _problem("nothing_tripped", "沒有觸發停損的持倉；未建立提案", 409)
            targets = _targets_after_stops(db, account, as_of, evaluation)
            revision = store.input_revision(db)
    reasons = {row["symbol"]: row["status"] for row in evaluation["holdings"] if row["status"] in ("stop_loss", "trailing_stop")}
    rationale = (f"Position stops {ENGINE_VERSION}；{as_of}；觸發：" + "、".join(f"{symbol}（{reasons[symbol]}）" for symbol in evaluation["tripped"])
                 + "；其餘持倉維持目前權重，釋出部分保留現金。")
    proposal = paper.create_proposal(account_id, paper.ProposalInput(
        expected_version=body.expected_account_version, targets=targets, rationale=rationale,
        expected_input_revision=revision, expected_as_of=as_of, idempotency_key=body.idempotency_key))
    until = _cooldown_until(as_of, evaluation["policy"]["cooldown_sessions"])
    with paper._write() as db:
        for symbol in evaluation["tripped"]:
            db.execute("""INSERT INTO paper_stop_cooldowns(account_id,symbol,until_session,reason,proposal_id,created_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET until_session=excluded.until_session,
                reason=excluded.reason,proposal_id=excluded.proposal_id,created_at=excluded.created_at""",
                       (account_id, symbol, until, reasons[symbol], proposal["id"], store.now()))
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "tripped": evaluation["tripped"], "targets": targets,
            "cooldown_until": until, "paper_proposal": proposal, "method": METHOD, "warnings": list(WARNINGS)}


@router.delete("/api/paper/accounts/{account_id}/position-stops/cooldowns/{symbol}")
def clear_cooldown(account_id: str, symbol: str):
    with paper._write() as db:
        paper._account(db, account_id)
        removed = db.execute("DELETE FROM paper_stop_cooldowns WHERE account_id=? AND symbol=?", (account_id, symbol.upper())).rowcount
    return {"account_id": account_id, "symbol": symbol.upper(), "removed": bool(removed)}
