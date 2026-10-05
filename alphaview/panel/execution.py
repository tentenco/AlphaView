"""Execution layer: route an executable paper proposal to a named execution target.

Targets are `paper_ledger` (the existing local simulation, unchanged) and
`alpaca_paper` (market DAY orders on Alpaca's PAPER host, opt-in, capped,
idempotent by client order id). There is no live-broker target: the transport
rejects any other host, the connector must be explicitly enabled, and every
submission is recorded before the first request leaves the machine so an
unknown outcome is never silently retried. Paper fills on Alpaca do not touch
the local ledger; the proposal is marked submitted_external instead.
"""
import hashlib
import json
import math
import re
import uuid
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from . import alpaca_paper as alpaca
from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-execution-v1"
TARGETS = ("paper_ledger", "alpaca_paper")
ORDER_TYPE, TIME_IN_FORCE = "market", "day"
QTY_STEP = Decimal("0.000000001")
PRICE_STEP, SUB_DOLLAR_STEP = Decimal("0.01"), Decimal("0.0001")
ACCEPTED = {"new", "accepted", "pending_new", "accepted_for_bidding", "calculated"}
CANCEL_REQUESTED = {"pending_cancel", "pending_replace"}
TERMINAL = {"filled", "cancelled", "rejected", "expired", "skipped"}
BROKER_STATUS = {"filled": "filled", "partially_filled": "partially_filled", "canceled": "cancelled",
                 "expired": "expired", "rejected": "rejected", "stopped": "rejected", "suspended": "rejected",
                 "done_for_day": "cancelled", "replaced": "unknown"}
METHOD = (
    "A proposal is executable only while it is current: same completed session, same market input revision, "
    "same account version, kill switch off, preview hash unchanged, and any circuit breaker clear. Target "
    "paper_ledger settles the proposal in the local ledger exactly as manual acceptance does. Target alpaca_paper "
    "requires the Alpaca Paper connection with orders explicitly enabled and an acknowledgement in the request; "
    "it records the submission and every order locally first, marks the proposal submitted_external, then sends "
    "one market DAY order per proposal line (sells first) with a deterministic client_order_id. Quantities are "
    "the proposal's exact shares truncated to nine decimals; per-order notional and per-submission count caps "
    "come from the connector policy, and each quantity must stay within the volume-participation cap of the "
    "decision session's local volume (missing volume blocks the order rather than scaling it). The connector's "
    "order style is either market or limit: a limit order is priced at the proposal reference price plus (buy) or "
    "minus (sell) the configured band in basis points, rounded half-up to cents (four decimals under one dollar); "
    "a line without a finite positive reference price is refused, never downgraded to a market order. A transport "
    "failure leaves the order unknown and skips the remaining lines; "
    "reconcile queries Alpaca by broker id or client id and never resends. A submission may override the "
    "connection's order style for itself only (recorded as order_style_source=override). Turning the kill switch "
    "on, or a circuit breaker that pauses the account, sweeps the account's working Alpaca orders: recorded orders "
    "never sent are marked skipped, orders with a broker id get one cancel request each (record before send, an "
    "unreachable broker leaves the order unknown for reconcile, never a second request). Alpaca fills are not "
    "written to the local paper ledger; the two books are reconciled by the user, not merged."
)
WARNINGS = [
    "Alpaca Paper 是模擬帳戶，不是實盤；本層沒有實盤券商目標，也不會自動送出任何委託。",
    "送到 Alpaca 的委託不會回寫本機模擬帳本；兩本帳各自獨立，請以核對結果為準。",
    "傳輸失敗時結果為 unknown：先核對，不重送；重複的請求識別碼只會回放原紀錄。",
    "市價單成交價與提案參考價可能不同；本層不估算滑價或成交機率。",
    "限價單可能整天未成交而到期（expired）或只部分成交；到期或取消前已成交的數量會保留在委託列，送出紀錄狀態為 mixed。",
    "暫停帳戶會對未完結的 Alpaca 委託各送一次取消請求；取消請求不保證在成交前到達，請以核對結果為準。",
]


class OrderStyleOverride(agent.StrictInput):
    """Per-submission order style; a missing band keeps the connection's band."""
    type: Literal["market", "limit"]
    limit_band_bps: float | None = Field(default=None, ge=0, le=500)


class SubmitInput(agent.StrictInput):
    target: Literal["paper_ledger", "alpaca_paper"]
    expected_account_version: int = Field(ge=1, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    acknowledge_external: bool = False
    order_style_override: OrderStyleOverride | None = None


class SweepInput(agent.StrictInput):
    expected_account_version: int = Field(ge=1, strict=True)
    reason: str = Field(min_length=1, max_length=200)


class CancelInput(agent.StrictInput):
    expected_status: str = Field(min_length=1, max_length=40)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=409):
    return HTTPException(status, {"code": code, "message": message})


def _text(value, maximum=300):
    return value[:maximum] if isinstance(value, str) else None


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS execution_submissions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
        target TEXT NOT NULL CHECK(target IN ('paper_ledger','alpaca_paper')),
        status TEXT NOT NULL CHECK(status IN ('simulated','submitted','partially_filled','filled','cancelled','rejected','mixed','unknown')),
        idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, engine_version TEXT NOT NULL,
        as_of TEXT NOT NULL, input_revision TEXT NOT NULL, account_version INTEGER NOT NULL, connection_version TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, summary_json TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS execution_orders (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, account_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')),
        qty TEXT NOT NULL, order_type TEXT NOT NULL, time_in_force TEXT NOT NULL,
        reference_price TEXT NOT NULL, reference_notional TEXT NOT NULL,
        client_order_id TEXT NOT NULL UNIQUE, broker_order_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','partially_filled','filled','cancel_requested','cancelled','expired','rejected','unknown','skipped')),
        filled_qty TEXT, filled_avg_price TEXT, submitted_at TEXT, last_synced_at TEXT, response_json TEXT, error_json TEXT,
        FOREIGN KEY(submission_id) REFERENCES execution_submissions(id)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_execution_submissions_account ON execution_submissions(account_id,created_at DESC)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_execution_orders_submission ON execution_orders(submission_id,sequence)")


# --- Views ---------------------------------------------------------------------------------

def _order_view(row, limit_prices=None):
    row = dict(row)
    return {"id": row["id"], "submission_id": row["submission_id"], "sequence": row["sequence"], "symbol": row["symbol"],
            "side": row["side"], "qty": row["qty"], "order_type": row["order_type"], "time_in_force": row["time_in_force"],
            "limit_price": (limit_prices or {}).get(row["client_order_id"]),
            "reference_price": row["reference_price"], "reference_notional": row["reference_notional"],
            "client_order_id": row["client_order_id"], "broker_order_id": row["broker_order_id"], "status": row["status"],
            "filled_qty": row["filled_qty"], "filled_avg_price": row["filled_avg_price"], "submitted_at": row["submitted_at"],
            "last_synced_at": row["last_synced_at"], "terminal": row["status"] in TERMINAL,
            "broker": json.loads(row["response_json"]) if row["response_json"] else None,
            "error": json.loads(row["error_json"]) if row["error_json"] else None}


def _submission_view(db, row, *, detail=True):
    row = dict(row)
    summary = json.loads(row["summary_json"])
    orders = [_order_view(item, summary.get("limit_prices")) for item in db.execute(
        "SELECT * FROM execution_orders WHERE submission_id=? ORDER BY sequence", (row["id"],))]
    counts = {}
    for order in orders:
        counts[order["status"]] = counts.get(order["status"], 0) + 1
    partial_fills = sum(_partial_terminal(order["status"], order["filled_qty"]) for order in orders)
    view = {"id": row["id"], "engine_version": row["engine_version"], "account_id": row["account_id"],
            "proposal_id": row["proposal_id"], "target": row["target"], "status": row["status"],
            "as_of": row["as_of"], "input_revision": row["input_revision"], "account_version": row["account_version"],
            "connection_version": row["connection_version"], "created_at": row["created_at"], "updated_at": row["updated_at"],
            "summary": summary, "order_counts": counts, "order_count": len(orders), "partial_fills": partial_fills,
            "reconcile_required": row["status"] in ("submitted", "partially_filled", "unknown"),
            "terminal": row["status"] in ("simulated", "filled", "cancelled", "rejected", "mixed")}
    if detail:
        view.update(orders=orders, method=METHOD, warnings=list(WARNINGS))
    return view


def _submission_row(db, identifier):
    row = db.execute("SELECT * FROM execution_submissions WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise _problem("submission_not_found", "找不到這筆執行紀錄", 404)
    return dict(row)


def _partial_terminal(status, filled_qty):
    """An expired or cancelled order that already filled part of its quantity is a terminal partial fill."""
    if status not in ("expired", "cancelled") or not filled_qty:
        return False
    try:
        return Decimal(str(filled_qty)) > 0
    except ArithmeticError:
        return False


def derive_status(order_statuses):
    """Submission status from its orders; unknown dominates, then working, then terminal mixes.

    Items may be plain statuses or (status, filled_qty) pairs; an expired/cancelled order with fills
    counts as a terminal partial fill, so the submission is `mixed` rather than `cancelled`.
    """
    statuses = ["partial_terminal" if isinstance(item, tuple) and _partial_terminal(*item) else (item[0] if isinstance(item, tuple) else item)
                for item in order_statuses]
    if not statuses:
        return "rejected"
    if "unknown" in statuses:
        return "unknown"
    if any(status in ("pending", "accepted", "cancel_requested") for status in statuses):
        return "partially_filled" if any(status in ("filled", "partially_filled") for status in statuses) else "submitted"
    if "partially_filled" in statuses:
        return "partially_filled"
    kinds = set(statuses)
    if kinds == {"filled"}:
        return "filled"
    if kinds <= {"rejected", "skipped"}:
        return "rejected"
    if kinds <= {"cancelled", "expired", "skipped"}:
        return "cancelled"
    return "mixed"


def _refresh_status(db, submission_id, extra=None):
    statuses = [(row["status"], row["filled_qty"]) for row in db.execute("SELECT status,filled_qty FROM execution_orders WHERE submission_id=?", (submission_id,))]
    row = _submission_row(db, submission_id)
    summary = {**json.loads(row["summary_json"]), **(extra or {})}
    db.execute("UPDATE execution_submissions SET status=?,updated_at=?,summary_json=? WHERE id=?",
               (derive_status(statuses), store.now(), _json(summary), submission_id))


# --- Broker order mapping --------------------------------------------------------------------

def _qty_text(shares_exact):
    quantity = Decimal(shares_exact).quantize(QTY_STEP, rounding=ROUND_DOWN)
    if quantity <= 0:
        return None
    return format(quantity.normalize(), "f")


def client_order_id(proposal_id, symbol):
    safe = re.sub(r"[^A-Za-z0-9]", "_", symbol)
    return f"av-{proposal_id[:16]}-{safe}"[:64]


def _map_broker_order(value):
    """Normalize an Alpaca order object to local status fields; unknown shapes stay unknown."""
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        return None
    broker_status = value.get("status") if isinstance(value.get("status"), str) else ""
    filled = alpaca._decimal(value.get("filled_qty")) or "0"
    if broker_status in ACCEPTED:
        status = "partially_filled" if Decimal(filled) > 0 else "accepted"
    elif broker_status in CANCEL_REQUESTED:
        status = "cancel_requested"
    else:
        status = BROKER_STATUS.get(broker_status, "unknown")
    return {"broker_order_id": value["id"], "status": status, "filled_qty": filled,
            "filled_avg_price": alpaca._decimal(value.get("filled_avg_price")),
            "broker": {key: alpaca._text(value.get(key)) for key in ("id", "client_order_id", "status", "symbol", "side", "type",
                                                                     "time_in_force", "submitted_at", "filled_at", "canceled_at",
                                                                     "expired_at", "updated_at")}
                      | {"qty": alpaca._decimal(value.get("qty")), "filled_qty": filled,
                         "filled_avg_price": alpaca._decimal(value.get("filled_avg_price")),
                         "limit_price": alpaca._decimal(value.get("limit_price"))}}


def _record_broker_order(db, order_id, mapped, *, submitted_at=None):
    fields = {"broker_order_id": mapped["broker_order_id"], "status": mapped["status"], "filled_qty": mapped["filled_qty"],
              "filled_avg_price": mapped["filled_avg_price"], "last_synced_at": store.now(),
              "response_json": _json(mapped["broker"]), "error_json": None}
    if submitted_at:
        fields["submitted_at"] = submitted_at
    assignments = ",".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE execution_orders SET {assignments} WHERE id=?", (*fields.values(), order_id))


def _record_order_problem(db, order_id, status, error, *, submitted_at=None):
    db.execute("UPDATE execution_orders SET status=?,error_json=?,last_synced_at=?,submitted_at=coalesce(?,submitted_at) WHERE id=?",
               (status, _json(error), store.now(), submitted_at, order_id))


def _rejection(status_code, value):
    message = value.get("message") if isinstance(value, dict) else None
    return {"code": "order_rejected", "http_status": status_code,
            "message": _text(message) or "Alpaca 拒絕這筆委託", "broker_code": value.get("code") if isinstance(value, dict) else None}


# --- Submission ----------------------------------------------------------------------------

def _validate_proposal(db, account_id, proposal_id, expected_version, as_of):
    """Same currency checks as manual acceptance; returns (account, proposal row, fresh preview)."""
    account = paper._account(db, account_id)
    paper._version(account, expected_version)
    row = paper._get_proposal(db, account_id, proposal_id)
    original = json.loads(row["preview_json"])
    # Reduce-only mode: a strictly risk-reducing proposal may still execute while paused.
    if account["kill_switch"] and not paper._reduce_only_exempt(db, account_id, original):
        raise _problem("kill_switch", paper._pause_refusal(db, account_id, original))
    if row["status"] != "proposed":
        raise _problem("proposal_not_executable", "只有尚未接受且可執行的提案能送出執行")
    if original["engine_version"] != paper.ENGINE_VERSION:
        raise _problem("method_changed", "調倉方法版本已更新，請重新建立提案")
    if original["as_of"] != as_of or original["input_revision"] != store.input_revision(db):
        raise _problem("inputs_changed", "交易日或行情輸入已變更，請重新預覽與建立提案")
    if original["account_version"] != account["version"]:
        raise _problem("account_changed", "提案建立後帳戶已變更，請重新建立提案")
    fresh = paper._build_preview(db, account_id, paper.PreviewInput.model_validate_json(row["request_json"]), as_of)
    if not fresh["executable"] or paper._fingerprint(fresh) != paper._fingerprint(original):
        raise _problem("preview_mismatch", "提案驗算與預覽不符或限制未通過，請重新建立提案")
    return account, row, fresh


def _circuit_breaker_guard(account_id, proposal_id, as_of):
    """Runs in its own short write transaction (like manual acceptance) so an auto-pause outlives a refusal."""
    try:
        from . import circuit_breakers
    except ImportError:
        return None
    guard = getattr(circuit_breakers, "guard_fill", None)
    return guard(account_id, proposal_id, as_of, trigger="execution") if guard is not None else None


def _session_volume(db, symbol, as_of):
    row = db.execute("SELECT volume FROM bars WHERE symbol=? AND date=?", (symbol, as_of)).fetchone()
    if row is None or row["volume"] is None:
        return None
    volume = Decimal(str(row["volume"]))
    return volume if volume.is_finite() and volume > 0 else None


def limit_price(reference_price, side, band_bps):
    """Reference ± band, half-up to cents (four decimals under $1); None when the reference is unusable."""
    try:
        reference = Decimal(str(reference_price))
    except (ArithmeticError, TypeError, ValueError):
        return None
    if not reference.is_finite() or reference <= 0:
        return None
    band = Decimal(str(band_bps)) / Decimal(10_000)
    price = reference * (1 + band if side == "buy" else 1 - band)
    if price <= 0:
        return None
    return price.quantize(PRICE_STEP if price >= 1 else SUB_DOLLAR_STEP, rounding=ROUND_HALF_UP)


def _resolve_style(config, override):
    """Connection-wide style unless the submission overrides it; an override without a band keeps the connection band."""
    base = dict(config.get("order_style") or alpaca.DEFAULT_ORDER_STYLE)
    if override is None:
        return base, "connection"
    band = base["limit_band_bps"] if override.limit_band_bps is None else float(override.limit_band_bps)
    return {"type": override.type, "limit_band_bps": band, "time_in_force": "day"}, "override"


def _plan_orders(db, as_of, proposal_id, orders, caps, style=None):
    """Pre-trade checks fail closed: a missing cap input blocks the order instead of scaling it."""
    style = style or dict(alpaca.DEFAULT_ORDER_STYLE)
    planned = []
    if len(orders) > caps["max_orders_per_submission"]:
        raise _problem("order_count_cap", f"提案有 {len(orders)} 筆委託，超過每次送出上限 {caps['max_orders_per_submission']}", 422)
    participation_cap = Decimal(str(caps.get("max_volume_participation_pct", 100))) / 100
    for sequence, order in enumerate(orders, 1):
        qty = _qty_text(order["shares_exact"])
        if qty is None:
            raise _problem("quantity_precision", f"{order['symbol']} 的股數在九位小數下為零，無法送出", 422)
        if Decimal(str(order["reference_notional"])) > Decimal(str(caps["max_order_notional_usd"])):
            raise _problem("order_notional_cap", f"{order['symbol']} 參考金額超過每筆上限 {caps['max_order_notional_usd']:g} USD", 422)
        volume = _session_volume(db, order["symbol"], as_of)
        if volume is None:
            raise _problem("volume_unavailable", f"{order['symbol']} 在 {as_of} 沒有可用成交量，無法檢查參與率；未送出", 422)
        participation = Decimal(qty) / volume
        if participation > participation_cap:
            raise _problem("volume_participation_cap",
                           f"{order['symbol']} 股數為當日成交量的 {float(participation * 100):.2f}%，超過上限 {caps['max_volume_participation_pct']:g}%", 422)
        price = None
        if style["type"] == "limit":
            price = limit_price(order.get("reference_price"), order["side"], style["limit_band_bps"])
            if price is None:
                raise _problem("reference_unavailable", f"{order['symbol']} 沒有可用的參考價，無法計算限價；未送出（不會改送市價單）", 422)
        planned.append({"sequence": sequence, "symbol": order["symbol"], "side": order["side"], "qty": qty,
                        "reference_price": str(order["reference_price"]), "reference_notional": str(order["reference_notional"]),
                        "session_volume": str(volume), "volume_participation_pct": float(participation * 100),
                        "client_order_id": client_order_id(proposal_id, order["symbol"]),
                        "order_type": style["type"], "time_in_force": style["time_in_force"],
                        "limit_price": format(price, "f") if price is not None else None})
    return planned


def submit(account_id, proposal_id, body: SubmitInput):
    as_of = sessions.latest_completed_session()
    payload = body.model_dump(exclude={"idempotency_key"}, exclude_none=True)
    with store.read_snapshot():
        with store.connect() as db:
            existing = db.execute("SELECT * FROM execution_submissions WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
            if existing is not None:
                if existing["request_hash"] != _hash(payload) or existing["proposal_id"] != proposal_id:
                    raise _problem("idempotency_conflict", "執行請求識別碼已被不同內容使用")
                return _submission_view(db, existing)
    if body.target == "paper_ledger":
        accepted = paper.accept_proposal_guarded(account_id, proposal_id,
                                                 paper.AcceptInput(expected_version=body.expected_account_version, idempotency_key=body.idempotency_key))
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            identifier, now = uuid.uuid4().hex, store.now()
            proposal = accepted["proposal"]
            summary = {"orders": len(proposal["orders"]), "cost_total": proposal["cost_total"],
                       "turnover_pct": proposal["turnover_pct"], "paper_engine_version": proposal["engine_version"]}
            db.execute("""INSERT OR IGNORE INTO execution_submissions
                (id,account_id,proposal_id,target,status,idempotency_key,request_hash,engine_version,as_of,input_revision,
                 account_version,connection_version,created_at,updated_at,summary_json)
                VALUES (?,?,?,'paper_ledger','simulated',?,?,?,?,?,?,NULL,?,?,?)""",
                       (identifier, account_id, proposal_id, body.idempotency_key, _hash(payload), ENGINE_VERSION,
                        proposal["as_of"], proposal["input_revision"], body.expected_account_version, now, now, _json(summary)))
            row = db.execute("SELECT * FROM execution_submissions WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
            return _submission_view(db, row)
    if not body.acknowledge_external:
        raise _problem("acknowledgement_required", "送到 Alpaca Paper 前必須確認 acknowledge_external", 422)
    config = alpaca._read_config()
    if config is None:
        raise _problem("not_configured", "尚未設定 Alpaca Paper API 連線")
    if not config["orders_enabled"]:
        raise _problem("orders_disabled", "Alpaca Paper 委託能力尚未啟用；請先在連線設定以確認字串啟用")
    _circuit_breaker_guard(account_id, proposal_id, as_of)
    identifier, now = uuid.uuid4().hex, store.now()
    with paper._write() as db:
        existing = db.execute("SELECT * FROM execution_submissions WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
        if existing is not None:
            return _submission_view(db, existing)
        account, row, fresh = _validate_proposal(db, account_id, proposal_id, body.expected_account_version, as_of)
        style, style_source = _resolve_style(config, body.order_style_override)
        planned = _plan_orders(db, as_of, proposal_id, fresh["orders"], config["order_caps"], style)
        if not planned:
            raise _problem("nothing_to_submit", "提案沒有可送出的委託", 422)
        summary = {"orders": len(planned), "reference_notional_total": str(sum(Decimal(item["reference_notional"]) for item in planned)),
                   "caps": config["order_caps"], "order_type": style["type"], "time_in_force": style["time_in_force"],
                   "order_style": style, "order_style_source": style_source, "sent": 0}
        if style["type"] == "limit":
            summary["limit_prices"] = {item["client_order_id"]: item["limit_price"] for item in planned}
        db.execute("""INSERT INTO execution_submissions
            (id,account_id,proposal_id,target,status,idempotency_key,request_hash,engine_version,as_of,input_revision,
             account_version,connection_version,created_at,updated_at,summary_json)
            VALUES (?,?,?,'alpaca_paper','submitted',?,?,?,?,?,?,?,?,?,?)""",
                   (identifier, account_id, proposal_id, body.idempotency_key, _hash(payload), ENGINE_VERSION, as_of,
                    fresh["input_revision"], account["version"], config["version"], now, now, _json(summary)))
        for item in planned:
            db.execute("""INSERT INTO execution_orders
                (id,submission_id,account_id,proposal_id,sequence,symbol,side,qty,order_type,time_in_force,reference_price,
                 reference_notional,client_order_id,status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')""",
                       (uuid.uuid4().hex, identifier, account_id, proposal_id, item["sequence"], item["symbol"], item["side"],
                        item["qty"], item["order_type"], item["time_in_force"], item["reference_price"], item["reference_notional"], item["client_order_id"]))
        db.execute("UPDATE paper_proposals SET status='submitted_external' WHERE id=? AND status='proposed'", (proposal_id,))
    _send_pending(identifier, config)
    with store.connect() as db:
        return _submission_view(db, _submission_row(db, identifier))


def _send_pending(submission_id, config):
    """Send each recorded pending order once; the first transport failure stops the batch."""
    with store.connect() as db:
        pending = [dict(row) for row in db.execute(
            "SELECT * FROM execution_orders WHERE submission_id=? AND status='pending' ORDER BY sequence", (submission_id,))]
        limit_prices = json.loads(_submission_row(db, submission_id)["summary_json"]).get("limit_prices") or {}
    sent, halted = 0, False
    for order in pending:
        if halted:
            with store.connect() as db:
                _record_order_problem(db, order["id"], "skipped", {"code": "not_sent", "message": "前一筆委託結果未知，本筆未送出"})
            continue
        submitted_at = store.now()
        payload = {"symbol": order["symbol"], "qty": order["qty"], "side": order["side"], "type": order["order_type"],
                   "time_in_force": order["time_in_force"], "client_order_id": order["client_order_id"]}
        if order["order_type"] == "limit":
            if not limit_prices.get(order["client_order_id"]):
                with store.connect() as db:
                    _record_order_problem(db, order["id"], "skipped", {"code": "limit_price_missing", "message": "找不到記錄的限價，本筆未送出"})
                continue
            payload["limit_price"] = limit_prices[order["client_order_id"]]
        try:
            status_code, value = alpaca._request(config, "POST", "/v2/orders", payload=payload)
        except HTTPException as exc:
            halted = True
            with store.connect() as db:
                _record_order_problem(db, order["id"], "unknown", {**exc.detail, "message": exc.detail.get("message")} if isinstance(exc.detail, dict) else {"code": "transport", "message": str(exc.detail)}, submitted_at=submitted_at)
            continue
        sent += 1
        with store.connect() as db:
            mapped = _map_broker_order(value) if status_code == 200 else None
            if mapped is not None:
                _record_broker_order(db, order["id"], mapped, submitted_at=submitted_at)
            elif status_code == 200:
                _record_order_problem(db, order["id"], "unknown", {"code": "invalid_response", "message": "Alpaca 回應格式不符；委託結果待核對"}, submitted_at=submitted_at)
                halted = True
            else:
                _record_order_problem(db, order["id"], "rejected", _rejection(status_code, value), submitted_at=submitted_at)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        _refresh_status(db, submission_id, {"sent": sent, "halted": halted})


# --- Reconcile and cancel -----------------------------------------------------------------

def _lookup(config, order):
    if order["broker_order_id"]:
        return alpaca._request(config, "GET", f"/v2/orders/{order['broker_order_id']}")
    return alpaca._request(config, "GET", "/v2/orders:by_client_order_id", params={"client_order_id": order["client_order_id"]})


def reconcile(submission_id):
    with store.connect() as db:
        submission = _submission_row(db, submission_id)
        orders = [dict(row) for row in db.execute(
            "SELECT * FROM execution_orders WHERE submission_id=? AND status NOT IN ('filled','cancelled','expired','rejected','skipped') ORDER BY sequence",
            (submission_id,))]
    if submission["target"] != "alpaca_paper":
        raise _problem("not_reconcilable", "本機帳本執行不需要核對", 422)
    config = alpaca._read_config()
    if config is None or not config["orders_enabled"]:
        raise _problem("orders_disabled", "Alpaca Paper 委託能力未啟用，無法核對")
    checked = 0
    for order in orders:
        try:
            status_code, value = _lookup(config, order)
        except HTTPException as exc:
            with store.connect() as db:
                detail = exc.detail if isinstance(exc.detail, dict) else {"code": "transport", "message": str(exc.detail)}
                db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?", (_json({**detail, "phase": "reconcile"}), store.now(), order["id"]))
            continue
        checked += 1
        with store.connect() as db:
            mapped = _map_broker_order(value) if status_code == 200 else None
            if mapped is not None:
                _record_broker_order(db, order["id"], mapped)
            elif status_code == 404:
                # Not found is not proof of absence: keep unknown, never resend.
                db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?",
                           (_json({"code": "not_found", "message": "Alpaca 找不到此委託；不能視為未送出，也不會重送", "phase": "reconcile"}), store.now(), order["id"]))
            else:
                db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?",
                           (_json({"code": "reconcile_failed", "http_status": status_code, "phase": "reconcile"}), store.now(), order["id"]))
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        _refresh_status(db, submission_id, {"last_reconcile_at": store.now(), "last_reconcile_checked": checked})
        return _submission_view(db, _submission_row(db, submission_id))


def cancel(order_id, body: CancelInput):
    with store.connect() as db:
        order = db.execute("SELECT * FROM execution_orders WHERE id=?", (order_id,)).fetchone()
        if order is None:
            raise _problem("order_not_found", "找不到這筆委託", 404)
        order = dict(order)
    if order["status"] != body.expected_status:
        raise _problem("order_changed", "委託狀態已變更；請重新載入後再取消")
    if order["status"] in TERMINAL or order["status"] == "pending":
        raise _problem("order_not_cancelable", "此委託不在可取消的狀態", 422)
    if not order["broker_order_id"]:
        raise _problem("reconcile_required", "此委託沒有券商識別；請先核對", 422)
    config = alpaca._read_config()
    if config is None or not config["orders_enabled"]:
        raise _problem("orders_disabled", "Alpaca Paper 委託能力未啟用，無法取消")
    try:
        status_code, value = alpaca._request(config, "DELETE", f"/v2/orders/{order['broker_order_id']}")
    except HTTPException as exc:
        # The cancel may or may not have reached Alpaca: the order becomes unknown until reconciled.
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            detail = exc.detail if isinstance(exc.detail, dict) else {"code": "transport", "message": str(exc.detail)}
            db.execute("UPDATE execution_orders SET status='unknown',error_json=?,last_synced_at=? WHERE id=?",
                       (_json({**detail, "phase": "cancel"}), store.now(), order_id))
            _refresh_status(db, order["submission_id"])
        raise
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if status_code in (200, 204):
            db.execute("UPDATE execution_orders SET status='cancel_requested',last_synced_at=?,error_json=NULL WHERE id=?", (store.now(), order_id))
        else:
            db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?",
                       (_json({"code": "cancel_rejected", "http_status": status_code, "message": _text(value.get("message")) if isinstance(value, dict) else None, "phase": "cancel"}), store.now(), order_id))
        _refresh_status(db, order["submission_id"])
    return reconcile(order["submission_id"])


# --- Kill-switch sweep ---------------------------------------------------------------------

SWEEP_WORKING = ("pending", "accepted", "partially_filled")


def cancel_working(account_id, *, reason):
    """Cancel the account's working Alpaca Paper orders once each; idempotent and never resends.

    Recorded orders that were never sent become `skipped` without touching the broker. Orders with a
    broker id get one DELETE; an unreachable broker leaves that order `unknown` for the reconcile loop.
    The sweep is recorded on every affected submission as `kill_switch_sweep`.
    """
    reason = _text(reason, 200) or "kill_switch"
    with store.connect() as db:
        paper._account(db, account_id)
        orders = [dict(row) for row in db.execute(f"""SELECT o.* FROM execution_orders o
            JOIN execution_submissions s ON s.id = o.submission_id
            WHERE o.account_id=? AND s.target='alpaca_paper' AND o.status IN ({",".join("?" * len(SWEEP_WORKING))})
            ORDER BY s.created_at, o.sequence""", (account_id, *SWEEP_WORKING))]
        settled = db.execute("""SELECT count(*) FROM execution_orders o JOIN execution_submissions s ON s.id = o.submission_id
            WHERE o.account_id=? AND s.target='alpaca_paper' AND o.status NOT IN ('pending','accepted','partially_filled')""",
                             (account_id,)).fetchone()[0]
    at = store.now()
    results, config = [], None
    if any(order["status"] != "pending" for order in orders):
        try:
            config = alpaca._read_config()
        except HTTPException:
            config = None
    for order in orders:
        entry = {"order_id": order["id"], "submission_id": order["submission_id"], "symbol": order["symbol"],
                 "side": order["side"], "previous_status": order["status"], "action": None, "error": None}
        if order["status"] == "pending":
            with store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                _record_order_problem(db, order["id"], "skipped", {"code": "swept", "message": f"帳戶暫停（{reason}），尚未送出的委託不再送出", "phase": "sweep"})
            entry["action"] = "skipped"
        elif not order["broker_order_id"]:
            entry.update(action="unknown", error={"code": "reconcile_required", "message": "委託沒有券商識別，無法取消；請先核對"})
        elif config is None or not config["orders_enabled"]:
            entry.update(action="unknown", error={"code": "orders_disabled" if config else "not_configured",
                                                  "message": "Alpaca Paper 委託能力未啟用，無法送出取消請求"})
            with store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?", (_json({**entry["error"], "phase": "sweep"}), store.now(), order["id"]))
        else:
            try:
                status_code, value = alpaca._request(config, "DELETE", f"/v2/orders/{order['broker_order_id']}")
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {"code": "transport", "message": str(exc.detail)}
                with store.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("UPDATE execution_orders SET status='unknown',error_json=?,last_synced_at=? WHERE id=?",
                               (_json({**detail, "phase": "sweep"}), store.now(), order["id"]))
                entry.update(action="unknown", error=detail)
            else:
                with store.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    if status_code in (200, 204):
                        db.execute("UPDATE execution_orders SET status='cancel_requested',last_synced_at=?,error_json=NULL WHERE id=?", (store.now(), order["id"]))
                        entry["action"] = "cancel_requested"
                    else:
                        error = {"code": "cancel_rejected", "http_status": status_code,
                                 "message": _text(value.get("message")) if isinstance(value, dict) else None}
                        db.execute("UPDATE execution_orders SET error_json=?,last_synced_at=? WHERE id=?", (_json({**error, "phase": "sweep"}), store.now(), order["id"]))
                        entry.update(action="cancel_rejected", error=error)
        results.append(entry)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        from . import execution_sweep_history
        for submission_id in sorted({entry["submission_id"] for entry in results}):
            receipt = {"at": at, "reason": reason,
                       "results": [entry for entry in results if entry["submission_id"] == submission_id]}
            execution_sweep_history.append_event(db, account_id, submission_id, receipt)
            _refresh_status(db, submission_id, {"kill_switch_sweep": receipt})
    counts = {}
    for entry in results:
        counts[entry["action"]] = counts.get(entry["action"], 0) + 1
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "at": at, "reason": reason,
            "nothing_to_do": not results, "orders_considered": len(results), "already_terminal": settled,
            "counts": counts, "results": results}


def sweep_after_pause(account_id, reason):
    """Runs after the pause has committed; a broker problem is reported, never raised, so the pause stands."""
    try:
        return cancel_working(account_id, reason=reason)
    except HTTPException as exc:
        return {"engine_version": ENGINE_VERSION, "account_id": account_id, "at": store.now(), "reason": reason,
                "nothing_to_do": False, "orders_considered": 0, "counts": {}, "results": [],
                "error": exc.detail if isinstance(exc.detail, dict) else {"code": "sweep_failed", "message": str(exc.detail)}}


# --- Unattended reconcile ------------------------------------------------------------------

RECONCILE_INTERVAL_SECONDS = 120
MAX_AUTO_RECONCILE = 10


def reconcile_open(limit=MAX_AUTO_RECONCILE):
    """Reconcile working Alpaca Paper submissions; does nothing unless orders are enabled."""
    try:
        config = alpaca._read_config()
    except HTTPException:
        return {"checked": 0, "skipped": "credential_file", "results": []}
    if config is None or not config["orders_enabled"]:
        return {"checked": 0, "skipped": "orders_disabled", "results": []}
    with store.connect() as db:
        identifiers = [row["id"] for row in db.execute(
            "SELECT id FROM execution_submissions WHERE target='alpaca_paper' AND status IN ('submitted','partially_filled','unknown') "
            "ORDER BY created_at LIMIT ?", (limit,))]
    results = []
    for identifier in identifiers:
        try:
            results.append({"id": identifier, "status": reconcile(identifier)["status"]})
        except HTTPException as exc:
            results.append({"id": identifier, "error": exc.detail})
    return {"checked": len(identifiers), "skipped": None, "results": results}


class Scheduler:
    """Background reconcile loop; never submits, cancels or reads credentials beyond the connector file."""

    def __init__(self, interval=RECONCILE_INTERVAL_SECONDS):
        import threading
        self.interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="alphaview-execution-reconcile", daemon=True)
        self.last_result = None

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=5)

    def _loop(self):
        import logging
        while not self._stop.wait(self.interval):
            try:
                self.last_result = reconcile_open()
            except Exception:
                logging.getLogger(__name__).exception("Execution reconcile tick failed")


# --- API -----------------------------------------------------------------------------------

def targets_view():
    config = None
    try:
        config = alpaca._read_config()
    except HTTPException:
        config = None
    return {"engine_version": ENGINE_VERSION, "targets": [
        {"id": "paper_ledger", "label": "本機模擬帳本", "english": "Local paper ledger", "available": True,
         "external": False, "reason": None},
        {"id": "alpaca_paper", "label": "Alpaca Paper 委託", "english": "Alpaca Paper orders",
         "available": bool(config and config["orders_enabled"]), "external": True,
         "reason": None if config and config["orders_enabled"] else ("orders_disabled" if config else "not_configured"),
         "caps": config["order_caps"] if config else None, "order_style": config.get("order_style") if config else None,
         "connection_version": config["version"] if config else None},
    ], "live_trading": {"available": False, "reason": "本專案沒有實盤券商目標；見 docs/execution.md 的上線就緒路線圖"},
        "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/execution/targets")
def targets_endpoint():
    return targets_view()


@router.post("/api/execution/accounts/{account_id}/proposals/{proposal_id}/submit", status_code=201)
def submit_endpoint(account_id: str, proposal_id: str, body: SubmitInput):
    return submit(account_id, proposal_id, body)


@router.get("/api/execution/accounts/{account_id}/submissions")
@store.snapshot_read
def list_submissions(account_id: str, limit: int = Query(default=20, ge=1, le=100)):
    with store.connect() as db:
        paper._account(db, account_id)
        rows = db.execute("SELECT * FROM execution_submissions WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
                          (account_id, limit)).fetchall()
        return {"engine_version": ENGINE_VERSION, "account_id": account_id, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db), "submissions": [_submission_view(db, row, detail=False) for row in rows],
                "targets": targets_view()["targets"], "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/execution/submissions/{identifier}")
@store.snapshot_read
def submission_endpoint(identifier: str):
    with store.connect() as db:
        return _submission_view(db, _submission_row(db, identifier))


@router.post("/api/execution/submissions/{identifier}/reconcile")
def reconcile_endpoint(identifier: str):
    return reconcile(identifier)


@router.post("/api/execution/accounts/{account_id}/cancel-working")
def cancel_working_endpoint(account_id: str, body: SweepInput):
    with store.connect() as db:
        paper._version(paper._account(db, account_id), body.expected_account_version)
    return cancel_working(account_id, reason=body.reason)


@router.post("/api/execution/reconcile-open")
def reconcile_open_endpoint():
    return {"engine_version": ENGINE_VERSION, **reconcile_open()}


@router.post("/api/execution/orders/{order_id}/cancel")
def cancel_endpoint(order_id: str, body: CancelInput):
    return cancel(order_id, body)
