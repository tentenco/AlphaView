"""Book reconciliation: fills AlphaView booked at Alpaca Paper versus the broker's own positions.

`alphaview-book-reconciliation-v2`. The execution layer records every Alpaca Paper order before sending it and
keeps the broker's filled quantity on reconcile; this read-only view sums those fills per symbol and compares them
with `/v2/positions`. A difference is reported, never corrected: the local paper ledger is a separate simulation
and is only shown for context. Nautilus-style reconciliation gap from the 2026-10-01 benchmark (Lean, Nautilus).
"""
from datetime import datetime
from decimal import Decimal
import hashlib
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import alpaca_paper as alpaca, sessions, store

ENGINE_VERSION = "alphaview-book-reconciliation-v2"
RECEIPT_VERSION = "alphaview-reconciliation-receipt-v1"
RECEIPT_MAX_AGE_SECONDS = 15 * 60
TOLERANCE = Decimal("0.000001")
WORKING = {"pending", "accepted", "partially_filled", "cancel_requested"}
SEVERITY = {"matched": 0, "pending": 1, "unknown": 2, "unexplained": 3, "drift": 4, "unavailable": 5}
METHOD = (
    "AlphaView 帳簿數量＝所有送往 Alpaca Paper 的執行委託在最近一次核對時的成交股數合計（買入為正、賣出為負），"
    "只計入本專案送出的委託；券商數量來自同一個 Paper 帳戶的 /v2/positions，先驗證帳戶身份再讀取。"
    "任一標的仍有未完結或結果未知的委託時只標示待定，不判定差異；券商有部位但帳簿沒有紀錄標示為無法解釋（例如在 Alpaca 介面手動交易）；"
    "差異超過 0.000001 股即為漂移。本機模擬帳本的持股只供對照，它與 Alpaca 是兩套各自結算的紀錄。"
    "券商有回傳部位但數量無法判讀時標為不可用，與券商明確沒有該部位分開，不把缺值當作零或核對一致。"
)
WARNINGS = [
    "這不是對帳修正：發現差異只會顯示，不會自動下單、不會改寫帳簿或模擬帳本。",
    "券商持倉與本機帳簿不是同一時刻的原子快照；盤中成交後請重新核對。",
    "券商回應不可用時整份核對不可用，不以上次結果替代。",
]

router = APIRouter()


class CaptureInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    expected_version: int = Field(ge=0)
    expected_connection_version: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_broker_account_id: str = Field(min_length=1, max_length=100)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_input_revision: str = Field(min_length=1, max_length=200)
    expected_book_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS broker_reconciliation_receipts (
        id INTEGER PRIMARY KEY CHECK(id=1),
        version INTEGER NOT NULL CHECK(version>=1),
        engine_version TEXT NOT NULL,
        broker_account_id TEXT NOT NULL,
        connection_version TEXT NOT NULL,
        as_of TEXT NOT NULL,
        input_revision TEXT NOT NULL,
        book_fingerprint TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        result_json TEXT NOT NULL
    )""")


def _text(value):
    return format(value.normalize(), "f") if isinstance(value, Decimal) else value


def _booked(db):
    rows = db.execute("""SELECT o.account_id, o.symbol, o.side, o.filled_qty, o.status FROM execution_orders o
        JOIN execution_submissions s ON s.id = o.submission_id WHERE s.target = 'alpaca_paper'""").fetchall()
    booked = {}
    for row in rows:
        entry = booked.setdefault(row["symbol"], {"qty": Decimal(0), "accounts": set(), "working": 0, "unknown": 0, "filled_orders": 0})
        entry["accounts"].add(row["account_id"])
        if row["status"] in WORKING:
            entry["working"] += 1
        elif row["status"] == "unknown":
            entry["unknown"] += 1
        if row["filled_qty"]:
            qty = Decimal(row["filled_qty"])
            if qty > 0:
                entry["qty"] += qty if row["side"] == "buy" else -qty
                entry["filled_orders"] += 1
    return booked


def _ledger(db, accounts):
    if not accounts:
        return {}
    marks = ",".join("?" * len(accounts))
    ledger = {}
    for row in db.execute(f"SELECT account_id, symbol, shares FROM paper_holdings WHERE account_id IN ({marks}) ORDER BY account_id", list(accounts)):
        ledger.setdefault(row["symbol"], []).append({"account_id": row["account_id"], "shares": row["shares"]})
    return ledger


def _broker_positions(config):
    account = alpaca._account(alpaca._get(config, "/v2/account"))
    if account["id"] != config["account_id"]:
        raise alpaca._problem("account_changed", "Alpaca 回傳帳戶身份與連線時不同；請重新設定", 409)
    positions = {}
    for item in alpaca._positions(alpaca._get(config, "/v2/positions"))["items"]:
        if item["symbol"] and item["qty"] is not None:
            positions[item["symbol"]] = Decimal(item["qty"])
        elif item["symbol"]:
            positions[item["symbol"]] = None
    return positions


def _row_status(broker_qty, entry):
    if entry and entry["unknown"]:
        return "unknown"
    if entry and entry["working"]:
        return "pending"
    booked_qty = entry["qty"] if entry else Decimal(0)
    if broker_qty is None:
        return "matched" if booked_qty == 0 else "drift"
    if booked_qty == 0 and broker_qty != 0:
        return "unexplained"
    return "matched" if abs(broker_qty - booked_qty) <= TOLERANCE else "drift"


def build(db, config):
    booked = _booked(db)
    accounts = sorted({account for entry in booked.values() for account in entry["accounts"]})
    ledger = _ledger(db, accounts)
    broker = {"status": "unavailable", "fetched_at": None, "error": None, "account_id": config["account_id"] if config else None}
    positions = None
    if config is None:
        broker["error"] = {"code": "not_configured", "message": "尚未設定 Alpaca Paper 連線"}
    else:
        try:
            positions = _broker_positions(config)
            broker.update(status="available", fetched_at=store.now())
        except HTTPException as error:
            broker["error"] = error.detail if isinstance(error.detail, dict) else {"code": "provider_unavailable", "message": str(error.detail)}
    rows = []
    for symbol in sorted(set(booked) | set(positions or {})):
        entry = booked.get(symbol)
        broker_qty = positions.get(symbol) if positions is not None else None
        booked_qty = entry["qty"] if entry else Decimal(0)
        invalid_quantity = positions is not None and symbol in positions and broker_qty is None
        status = "unavailable" if positions is None or invalid_quantity else _row_status(broker_qty, entry)
        difference = (None if positions is None or invalid_quantity or broker_qty is None and booked_qty == 0
                      else (broker_qty or Decimal(0)) - booked_qty)
        rows.append({"symbol": symbol, "status": status, "broker_qty": _text(broker_qty) if positions is not None else None,
                     "broker_position": bool(positions and symbol in positions), "booked_qty": _text(booked_qty),
                     "difference": _text(difference) if difference is not None else None,
                     "reason_code": "broker_quantity_unavailable" if invalid_quantity else None,
                     "filled_orders": entry["filled_orders"] if entry else 0, "working_orders": entry["working"] if entry else 0,
                     "unknown_orders": entry["unknown"] if entry else 0, "accounts": sorted(entry["accounts"]) if entry else [],
                     "local_ledger": ledger.get(symbol, [])})
    counts = {name: sum(row["status"] == name for row in rows) for name in SEVERITY}
    overall = "unavailable" if positions is None else max((row["status"] for row in rows), key=SEVERITY.get, default="matched")
    return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db),
            "status": overall, "broker": broker, "rows": rows, "summary": {**counts, "symbols": len(rows), "accounts": accounts},
            "method": METHOD, "warnings": WARNINGS}


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def book_fingerprint(db):
    """Hash all execution-book records and displayed ledger context, without storing their payload twice."""
    orders = [dict(row) for row in db.execute("""SELECT o.*, s.target, s.connection_version,
        s.account_id AS submission_account_id FROM execution_orders o
        JOIN execution_submissions s ON s.id=o.submission_id WHERE s.target='alpaca_paper' ORDER BY o.id""")]
    accounts = sorted({row["account_id"] for row in orders})
    return hashlib.sha256(_json({"orders": orders, "local_ledger": _ledger(db, accounts)}).encode()).hexdigest()


def _context(db, config, as_of):
    row = db.execute("SELECT * FROM broker_reconciliation_receipts WHERE id=1").fetchone()
    return {"version": row["version"] if row else 0,
            "connection_version": config["version"] if config else None,
            "broker_account_id": config["account_id"] if config else None,
            "as_of": as_of, "input_revision": store.input_revision(db), "book_fingerprint": book_fingerprint(db)}


def receipt_state(db, config, as_of):
    """Local-only freshness assessment. This helper must never query the broker."""
    context = _context(db, config, as_of)
    row = db.execute("SELECT * FROM broker_reconciliation_receipts WHERE id=1").fetchone()
    receipt = None
    if row:
        reasons = []
        for field, code in (("connection_version", "receipt_connection_changed"),
                            ("broker_account_id", "receipt_account_changed"), ("as_of", "receipt_session_changed"),
                            ("input_revision", "receipt_inputs_changed"), ("book_fingerprint", "receipt_book_changed")):
            if row[field] != context[field]:
                reasons.append(code)
        result = json.loads(row["result_json"])
        if not isinstance(result, dict) or not isinstance(result.get("broker"), dict):
            raise ValueError("Invalid reconciliation receipt")
        if row["engine_version"] != RECEIPT_VERSION or result.get("engine_version") != ENGINE_VERSION:
            reasons.append("receipt_method_changed")
        age = None
        try:
            captured, now = datetime.fromisoformat(row["captured_at"]), datetime.fromisoformat(store.now())
            if captured.tzinfo is None or now.tzinfo is None:
                raise ValueError("timestamp without timezone")
            age = (now - captured).total_seconds()
            if age < 0:
                reasons.append("receipt_timestamp_invalid")
            elif age > RECEIPT_MAX_AGE_SECONDS:
                reasons.append("receipt_stale")
        except (TypeError, ValueError, OverflowError):
            reasons.append("receipt_timestamp_invalid")
        receipt = {"version": row["version"], "captured_at": row["captured_at"], "age_seconds": age,
                   "current": not reasons, "unavailable_reasons": reasons, "result": result}
    return {"engine_version": RECEIPT_VERSION, **context, "can_capture": config is not None,
            "max_age_seconds": RECEIPT_MAX_AGE_SECONDS, "receipt": receipt,
            "method": "只讀取本機核對收據；同一交易日、連線身份、行情版本與執行帳簿均未變且擷取不超過 15 分鐘才有效。"}


def _expected(body, context):
    for field in ("version", "connection_version", "broker_account_id", "as_of", "input_revision", "book_fingerprint"):
        if getattr(body, f"expected_{field}") != context[field]:
            raise alpaca._problem("reconciliation_changed", "核對來源或收據版本已變更；本次結果未保存，請重新核對", 409)


@router.get("/api/alpaca-paper/reconciliation/receipt")
@store.snapshot_read
def get_receipt():
    with store.connect() as db:
        result = receipt_state(db, alpaca._read_config(), sessions.latest_completed_session())
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/api/alpaca-paper/reconciliation/receipt")
def capture_receipt(body: CaptureInput):
    # Broker I/O uses a stable read snapshot and holds no SQLite writer or config lock.
    with store.read_snapshot():
        with store.connect() as db:
            config = alpaca._read_config()
            context = _context(db, config, sessions.latest_completed_session())
            _expected(body, context)
            result = build(db, config)
            if result["as_of"] != context["as_of"] or result["input_revision"] != context["input_revision"]:
                raise alpaca._problem("reconciliation_changed", "核對期間交易日或行情版本已變更；請重新核對", 409)
            captured_at = store.now()
    # Config mutators use this lock; acquire it before the SQLite writer, never in reverse.
    with alpaca._config_lock():
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = alpaca._read_config()
            latest = _context(db, current, sessions.latest_completed_session())
            _expected(body, latest)
            db.execute("""INSERT INTO broker_reconciliation_receipts
                (id,version,engine_version,broker_account_id,connection_version,as_of,input_revision,book_fingerprint,captured_at,result_json)
                VALUES (1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,
                    engine_version=excluded.engine_version,broker_account_id=excluded.broker_account_id,
                    connection_version=excluded.connection_version,as_of=excluded.as_of,input_revision=excluded.input_revision,
                    book_fingerprint=excluded.book_fingerprint,captured_at=excluded.captured_at,result_json=excluded.result_json""",
                       (latest["version"] + 1, RECEIPT_VERSION, latest["broker_account_id"], latest["connection_version"],
                        latest["as_of"], latest["input_revision"], latest["book_fingerprint"], captured_at, _json(result)))
            saved = receipt_state(db, current, latest["as_of"])
    return JSONResponse(saved, headers={"Cache-Control": "no-store"})


@router.get("/api/alpaca-paper/reconciliation")
@store.snapshot_read
def reconciliation():
    with store.connect() as db:
        result = build(db, alpaca._read_config())
    return JSONResponse(result, headers={"Cache-Control": "no-store"})
