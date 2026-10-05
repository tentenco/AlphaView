"""Durable, explicitly authorized next-session raw-open paper simulations.

No broker, downloader, provider call, live order, or later-date substitution.
Frozen signal-close quantities are settled only after the specified day completes.
"""
from datetime import datetime, timezone
from decimal import Decimal, localcontext
import hashlib
import json
import logging
import math
import threading
import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
import pandas as pd
from pydantic import Field, field_validator

from . import paper_portfolio as paper, sessions, store
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-next-open-v1"
DIGEST_VERSION = "alphaview-paper-source-prefix-v1"
MAX_PREFIX_ROWS = 500_000
MAX_MANIFEST_SYMBOLS = 10_000
POLL_INTERVAL_SECONDS = 60
ACTIVE = ("waiting_session", "waiting_prices", "blocked")
TERMINAL = ("filled", "cancelled", "invalidated")
METHOD = (
    "開盤前明確授權的獨立本機 next-open 模擬；按 signal-close 提案凍結股數、帳戶版本、政策與上限，"
    "等待指定下一 XNYS 交易日完成後，僅用該日本機未調整開盤價加不利滑價計算。"
    "缺價等待，不換日期、不重算股數、不部分記帳；按開盤估值重驗現金、費用與實際配置限制。"
    "同帳戶最多一批未結束委託；沒有資金預留，帳戶或政策改動使原批次失效。"
    "這是事後參考價情境，沒有券商、即時成交、流動性、稅或公司行動模型。"
    "實際記錄時間與假設執行日分列，不回填既有 NAV。"
)
WARNINGS = [
    "指定日完成後才可用日線 open 計算；不是當時真實成交或即時委託。",
    "以先賣後買、整批可成交作為模擬假設；未模擬流動性、市場衝擊、股息與拆併股。",
    "已保存的 NAV 不會因延後模擬而改寫；本模型不是歷史帳戶重建。",
]
logger = logging.getLogger(__name__)


class EnqueueInput(paper.StrictInput):
    proposal_id: str = Field(min_length=1, max_length=100)
    expected_account_version: int = Field(ge=1, strict=True)
    expected_proposal_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    max_execution_cost_usd: float = Field(ge=0, le=1_000_000_000, strict=True)
    max_buy_cash_debit_usd: float = Field(ge=0, le=1_000_000_000_000, strict=True)
    confirm_next_open_simulation: bool = Field(strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("confirm_next_open_simulation")
    @classmethod
    def confirmed(cls, value):
        if not value:
            raise ValueError("必須明確同意指定交易日的本機開盤參考價模擬")
        return value


class OrderActionInput(paper.StrictInput):
    expected_order_version: int = Field(ge=1, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


def init_schema(db):
    statements = [
        """CREATE TABLE IF NOT EXISTS paper_next_open_orders (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_proposal_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('waiting_session','waiting_prices','blocked','filled','cancelled','invalidated')),
            version INTEGER NOT NULL DEFAULT 1, engine_version TEXT NOT NULL,
            signal_session TEXT NOT NULL, execution_session TEXT NOT NULL,
            enqueue_before TEXT NOT NULL, eligible_after TEXT NOT NULL,
            frozen_json TEXT NOT NULL, source_manifest_json TEXT NOT NULL,
            prefix_digest TEXT NOT NULL, prefix_rows INTEGER NOT NULL,
            evaluation_json TEXT, reason_code TEXT NOT NULL, reason TEXT NOT NULL,
            execution_proposal_id TEXT UNIQUE, last_checked_revision TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id),
            FOREIGN KEY(source_proposal_id) REFERENCES paper_proposals(id)
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_next_open_active
            ON paper_next_open_orders(account_id)
            WHERE status IN ('waiting_session','waiting_prices','blocked')""",
        """CREATE INDEX IF NOT EXISTS idx_paper_next_open_account
            ON paper_next_open_orders(account_id,created_at DESC)""",
        """CREATE TABLE IF NOT EXISTS paper_next_open_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL, reason_code TEXT NOT NULL, reason TEXT NOT NULL,
            input_revision TEXT NOT NULL, evaluation_json TEXT, created_at TEXT NOT NULL,
            UNIQUE(order_id,idempotency_key),
            FOREIGN KEY(order_id) REFERENCES paper_next_open_orders(id)
        )""",
    ]
    for statement in statements:
        db.execute(statement)


def utcnow():
    return datetime.now(timezone.utc)


def _instant(at=None):
    instant = pd.Timestamp(utcnow() if at is None else at)
    if instant.tzinfo is None:
        raise ValueError("Next-open clock must include a timezone")
    return instant.tz_convert("UTC")


def _window(at=None):
    instant = _instant(at)
    signal = sessions.latest_completed_session(instant)
    cal = sessions.calendar(instant.year)
    following = cal.next_session(pd.Timestamp(signal))
    opening = cal.session_open(following)
    ready = cal.session_close(following) + pd.Timedelta(minutes=15)
    return {"signal_session": signal, "execution_session": following.date().isoformat(),
            "enqueue_before": opening.isoformat(), "eligible_after": ready.isoformat(),
            "can_enqueue": instant < opening,
            "reason": None if instant < opening else "指定下一交易日已開盤；需等待新交易日完成後重新建立提案"}


def _account_fingerprint(db, account):
    policy = json.loads(account["symbol_policy_json"])
    return paper._hash({"account": {**{key: account[key] for key in (
        "id", "version", "cash", "realized_pnl", "kill_switch", "limits_json", "execution_policy_json")},
        **({"symbol_policy_json": account["symbol_policy_json"]} if paper._policy_active(policy) else {})},
        "holdings": paper._holdings(db, account["id"])})


def _source_authorization(db, request, account_id):
    """Freeze historical authority separately from market-data freshness."""
    if request.get("jev_source"):
        # No historical re-authorization exists for external decisions yet; never treat one as manual.
        raise HTTPException(409, "Jev 決策閘來源的提案尚不支援次日開盤佇列；請於當期直接檢閱與接受")
    if request.get("local_agent_source"):
        from .local_agent import validate_historical_source
        authorization = validate_historical_source(db, request["local_agent_source"])
        paper._validate_policy_binding(db, authorization.get("account_context"), account_id)
        return {"kind": "local_agent", "authorization": authorization}
    if request.get("automation_source"):
        from . import agent_automation, portfolio_agent, scan_provenance
        source = request["automation_source"]
        attempt = agent_automation.validate_source(db, source)
        if attempt["account_id"] != account_id:
            raise HTTPException(409, "自動化來源與虛擬帳戶不符")
        run = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (attempt["run_id"],)).fetchone()
        if run is None:
            raise HTTPException(409, "自動化的原始規則工作流不存在")
        result = json.loads(run["result"])
        paper._validate_policy_binding(db, result.get("account_context"), account_id)
        if (run["status"] != "proposed" or result["engine_version"] != portfolio_agent.ENGINE_VERSION
                or (result.get("scan") or {}).get("engine_version") != scan_provenance.SCAN_ENGINE_VERSION
                or result["target_weights"] != request["targets"]):
            raise HTTPException(409, "自動化規則來源方法或完整目標已變更")
        return {"kind": "automation", "source": source, "run_id": run["id"],
                "run_fingerprint": paper._hash(dict(run)), "engine_version": attempt["engine_version"]}
    return {"kind": "explicit_saved_proposal"}


def _current_proposal(db, account_id, proposal_id, as_of):
    account = paper._account(db, account_id)
    row = paper._get_proposal(db, account_id, proposal_id)
    preview = json.loads(row["preview_json"])
    request = json.loads(row["request_json"])
    if row["status"] != "proposed" or preview.get("engine_version") != paper.ENGINE_VERSION:
        raise HTTPException(409, "僅能排入目前方法且尚未接受的可執行提案")
    if preview["as_of"] != as_of or preview["input_revision"] != store.input_revision(db):
        raise HTTPException(409, "提案交易日或行情版本已變更，請重新建立")
    if preview["account_version"] != account["version"] or account["kill_switch"]:
        raise HTTPException(409, "帳戶已變更或暫停，請重新建立提案")
    with localcontext() as context:
        context.prec = 50
        fresh = paper._build_preview(db, account_id, paper.PreviewInput.model_validate(request), as_of)
    if not fresh["executable"] or paper._fingerprint(fresh) != paper._fingerprint(preview):
        raise HTTPException(409, "提案來源或重新驗算結果已變更")
    return account, row, preview, request


def _source_manifest(db):
    symbols = [row[0] for row in db.execute("SELECT symbol FROM datasets UNION SELECT symbol FROM bars ORDER BY symbol")]
    if len(symbols) > MAX_MANIFEST_SYMBOLS:
        raise HTTPException(422, f"來源資料集超過 {MAX_MANIFEST_SYMBOLS} 個，本版不截斷來源範圍")
    return symbols


def _canonical_number(value):
    # SQLite REAL 100 and 100.0 are economically identical. Nonfinite historical
    # inputs remain explicit digest markers, never usable price replacements.
    if value is None:
        return None
    number = float(value)
    return number.hex() if math.isfinite(number) else str(number)


def _prefix_digest(db, manifest, cutoff):
    digest = hashlib.sha256()
    digest.update(paper._json({"method": DIGEST_VERSION, "cutoff": cutoff, "manifest": manifest}).encode())
    count = 0
    for symbol in manifest:
        identity = db.execute("SELECT symbol,currency,exchange,source FROM datasets WHERE symbol=?", (symbol,)).fetchone()
        digest.update(paper._json({"symbol": symbol, "identity": dict(identity) if identity else None}).encode())
        for row in db.execute("SELECT * FROM bars WHERE symbol=? AND date<=? ORDER BY date", (symbol, cutoff)):
            count += 1
            if count > MAX_PREFIX_ROWS:
                raise HTTPException(422, f"來源歷史超過 {MAX_PREFIX_ROWS} 筆，本版不截斷或忽略其他標的")
            values = [symbol, row["date"], *(_canonical_number(row[key]) for key in (
                "open", "high", "low", "close", "adj_close", "volume"))]
            digest.update(paper._json(values).encode())
            digest.update(b"\n")
    return digest.hexdigest(), count


def _get_order(db, account_id, order_id):
    row = db.execute("SELECT * FROM paper_next_open_orders WHERE id=? AND account_id=?", (order_id, account_id)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到此帳戶的次日開盤模擬委託")
    return dict(row)


def _basic_invalid(db, row, frozen):
    if row["engine_version"] != ENGINE_VERSION or frozen["source_preview"]["engine_version"] != paper.ENGINE_VERSION:
        return "method_changed", "模擬或來源方法版本已變更，原委託失效"
    account = paper._account(db, row["account_id"])
    if account["kill_switch"] or _account_fingerprint(db, account) != frozen["account_fingerprint"]:
        return "account_changed", "帳戶、持倉、政策或暫停開關已變更，原委託失效"
    source = paper._get_proposal(db, row["account_id"], row["source_proposal_id"])
    if source["status"] != "proposed" or paper._hash({key: source[key] for key in (
            "id", "account_id", "preview_json", "request_json")}) != frozen["source_record_fingerprint"]:
        return "source_changed", "來源提案已接受、拒絕或修改，原委託失效"
    try:
        authorization = _source_authorization(db, frozen["source_request"], row["account_id"])
    except HTTPException as exc:
        return "source_changed", str(exc.detail)
    if authorization != frozen["source_authorization"]:
        return "source_changed", "Agent 來源授權或已保存的結果已變更，原委託失效"
    return None


def _buy_debit(orders):
    return sum((paper._decimal(row["notional_exact"]) + paper._decimal(row["fee_exact"])
                for row in orders if row["side"] == "buy"), paper.ZERO)


def _view(db, row, at=None):
    instant = _instant(at)
    frozen = json.loads(row["frozen_json"])
    source = frozen["source_preview"]
    evaluation = json.loads(row["evaluation_json"]) if row["evaluation_json"] else None
    attempts = [dict(item) for item in db.execute("""SELECT id,trigger_kind,status,reason_code,reason,input_revision,created_at
        FROM paper_next_open_attempts WHERE order_id=? ORDER BY id DESC LIMIT 20""", (row["id"],))]
    filled = row["status"] == "filled"
    reference_revised = None
    if filled and evaluation:
        quotes = _open_quotes(db, frozen, row["execution_session"])
        reference_revised = _open_fingerprint(quotes) != evaluation["open_price_fingerprint"]
    return {key: row[key] for key in ("id", "account_id", "source_proposal_id", "engine_version", "status", "version",
            "signal_session", "execution_session", "enqueue_before", "eligible_after", "created_at", "updated_at",
            "completed_at", "reason_code", "reason", "execution_proposal_id")} | {
        "as_of": sessions.latest_completed_session(instant), "input_revision": store.input_revision(db),
        "source_account_version": source["account_version"], "source_input_revision": source["input_revision"],
        "source_proposal_fingerprint": paper._hash(source),
        "max_execution_cost_usd": frozen["max_execution_cost_usd"],
        "max_buy_cash_debit_usd": frozen["max_buy_cash_debit_usd"],
        "frozen_orders": source["orders"], "source_estimated_cost": source["cost_total"],
        "source_estimated_buy_cash_debit": float(_buy_debit(source["orders"])),
        "source_prefix": {"method": DIGEST_VERSION, "digest": row["prefix_digest"], "rows": row["prefix_rows"],
                          "symbols": len(json.loads(row["source_manifest_json"])), "max_rows": MAX_PREFIX_ROWS},
        "limits": source["limits"], "execution_policy": source["execution_policy"], "last_evaluation": evaluation,
        **({"symbol_policy": source["symbol_policy"], "symbol_policy_method": paper.SYMBOL_POLICY_METHOD} if source.get("symbol_policy") else {}),
        "recorded_at": row["completed_at"] if filled else None,
        "effective_session": row["execution_session"] if filled else None,
        "late_recording": bool(evaluation and evaluation.get("late_recording")) if filled else False,
        "execution_reference_revised": reference_revised,
        "can_cancel": row["status"] in ACTIVE,
        "can_process": row["status"] in ACTIVE and instant >= pd.Timestamp(row["eligible_after"]),
        "attempts": attempts, "method": METHOD, "warnings": WARNINGS}


@router.get("/api/paper/accounts/{account_id}/next-open-orders")
@store.snapshot_read
def list_orders(account_id: str, limit: Annotated[int, Query(ge=1, le=100)] = 20,
                offset: Annotated[int, Query(ge=0, le=100_000)] = 0):
    instant, window = _instant(), _window()
    with store.connect() as db:
        paper._account(db, account_id)
        active = db.execute("SELECT 1 FROM paper_next_open_orders WHERE account_id=? AND status IN (?,?,?)",
                            (account_id, *ACTIVE)).fetchone()
        if active:
            window = {**window, "can_enqueue": False, "reason": "帳戶已有未結束的次日開盤委託，請先處理或取消"}
        source_proposals = []
        for proposal in db.execute("""SELECT * FROM paper_proposals WHERE account_id=? AND status='proposed'
                ORDER BY created_at DESC,id DESC LIMIT 20""", (account_id,)):
            preview = json.loads(proposal["preview_json"])
            reason = None
            try:
                _current_proposal(db, account_id, proposal["id"], window["signal_session"])
                if not preview["orders"]:
                    reason = "提案沒有需要執行的非零委託"
            except HTTPException as exc:
                reason = str(exc.detail)
            source_proposals.append({"id": proposal["id"], "created_at": proposal["created_at"],
                "proposal_fingerprint": paper._hash(preview), "eligible": reason is None, "reason": reason,
                "order_count": len(preview["orders"]), "estimated_cost": preview.get("cost_total"),
                "estimated_buy_cash_debit": float(_buy_debit(preview["orders"])), "orders": preview["orders"]})
        total = db.execute("SELECT COUNT(*) FROM paper_next_open_orders WHERE account_id=?", (account_id,)).fetchone()[0]
        items = [_view(db, dict(row), instant) for row in db.execute("""SELECT * FROM paper_next_open_orders
            WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?""", (account_id, limit, offset))]
        return {"engine_version": ENGINE_VERSION, "as_of": window["signal_session"],
                "input_revision": store.input_revision(db), "enqueue_window": window, "source_proposals": source_proposals,
                "items": items, "total": total, "limit": limit, "offset": offset, "method": METHOD}


@router.get("/api/paper/accounts/{account_id}/next-open-orders/{order_id}")
@store.snapshot_read
def order_detail(account_id: str, order_id: str):
    with store.connect() as db:
        return _view(db, _get_order(db, account_id, order_id))


@router.post("/api/paper/accounts/{account_id}/next-open-orders")
def enqueue(account_id: str, body: EnqueueInput):
    scope, payload = f"next-open-enqueue:{account_id}", body.model_dump(exclude={"idempotency_key"})
    with store.read_snapshot(), store.connect() as db, localcontext() as context:
        context.prec = 50
        existing = paper._existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        window = _window()
        if not window["can_enqueue"]:
            raise HTTPException(409, window["reason"])
        account, proposal, preview, request = _current_proposal(db, account_id, body.proposal_id, window["signal_session"])
        paper._version(account, body.expected_account_version)
        if paper._hash(preview) != body.expected_proposal_fingerprint:
            raise HTTPException(409, "來源提案摘要不同，請重新載入")
        if not preview["orders"]:
            raise HTTPException(422, "提案沒有需要執行的非零委託")
        manifest = _source_manifest(db)
        digest, rows = _prefix_digest(db, manifest, window["signal_session"])
        revision = store.input_revision(db)
        symbols = sorted({row["symbol"] for row in paper._holdings(db, account_id)} | {row["symbol"] for row in preview["orders"]})
        adjustment_factors = {}
        for symbol in symbols:
            bar = db.execute("SELECT close,adj_close FROM bars WHERE symbol=? AND date=?", (symbol, window["signal_session"])).fetchone()
            adjustment_factors[symbol] = str(paper._decimal(bar["adj_close"]) / paper._decimal(bar["close"]))
        frozen = {"source_preview": preview, "source_request": request,
                  "source_record_fingerprint": paper._hash({key: proposal[key] for key in ("id", "account_id", "preview_json", "request_json")}),
                  "account_fingerprint": _account_fingerprint(db, account), "holdings": paper._holdings(db, account_id),
                  "source_authorization": _source_authorization(db, request, account_id),
                  "adjustment_factors": adjustment_factors, "quote_symbols": symbols,
                  "max_execution_cost_usd": body.max_execution_cost_usd,
                  "max_buy_cash_debit_usd": body.max_buy_cash_debit_usd}
    with paper._write() as db:
        existing = paper._existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        if store.input_revision(db) != revision:
            raise HTTPException(503, "計算來源期間行情已變更；請以相同識別碼重試")
        if _instant() >= pd.Timestamp(window["enqueue_before"]):
            raise HTTPException(409, "指定交易日已開盤，不能回溯排入開盤委託")
        account, proposal, fresh, _ = _current_proposal(db, account_id, body.proposal_id, window["signal_session"])
        if (_account_fingerprint(db, account) != frozen["account_fingerprint"] or fresh != preview
                or _source_authorization(db, request, account_id) != frozen["source_authorization"]):
            raise HTTPException(409, "建立委託期间帳戶或來源已變更")
        active = db.execute("SELECT * FROM paper_next_open_orders WHERE account_id=? AND status IN (?,?,?)", (account_id, *ACTIVE)).fetchone()
        if active:
            invalid = _basic_invalid(db, dict(active), json.loads(active["frozen_json"]))
            if not invalid:
                raise HTTPException(409, "同帳戶只能有一批未結束的次日開盤委託")
            now = store.now()
            db.execute("""UPDATE paper_next_open_orders SET status='invalidated',version=version+1,
                reason_code=?,reason=?,updated_at=?,completed_at=? WHERE id=?""", (*invalid, now, now, active["id"]))
        identifier, now = uuid.uuid4().hex, store.now()
        db.execute("""INSERT INTO paper_next_open_orders
            (id,account_id,source_proposal_id,status,engine_version,signal_session,execution_session,
             enqueue_before,eligible_after,frozen_json,source_manifest_json,prefix_digest,prefix_rows,
             reason_code,reason,created_at,updated_at)
            VALUES (?,?,?,'waiting_session',?,?,?,?,?,?,?,?,?,'waiting_session',?,?,?)""",
            (identifier, account_id, body.proposal_id, ENGINE_VERSION, window["signal_session"], window["execution_session"],
             window["enqueue_before"], window["eligible_after"], paper._json(frozen), paper._json(manifest), digest, rows,
             "已凍結股數與上限，等待指定交易日完成後讀取本機開盤價", now, now))
        response = _view(db, _get_order(db, account_id, identifier))
        paper._remember_request(db, scope, body.idempotency_key, payload, response)
        return response


def _open_quotes(db, frozen, execution_session):
    quotes = {}
    for symbol in frozen["quote_symbols"]:
        bar = db.execute("SELECT * FROM bars WHERE symbol=? AND date=?", (symbol, execution_session)).fetchone()
        identity = db.execute("SELECT currency FROM datasets WHERE symbol=?", (symbol,)).fetchone()
        reason = None
        if bar is None:
            reason = "本機缺少指定交易日日線；不改用較晚或較早價格"
        elif not valid_bar(bar):
            reason = "指定交易日日線無效；需修正本機資料後重試"
        elif identity is None or identity["currency"] != "USD":
            reason = "本機資料未確認 USD 計價"
        elif not 0.000001 <= bar["open"] <= 1_000_000_000:
            reason = "指定日開盤價超出本版支援範圍"
        changed = False
        if reason is None:
            factor = paper._decimal(bar["adj_close"]) / paper._decimal(bar["close"])
            source_factor = paper._decimal(frozen["adjustment_factors"][symbol])
            changed = abs(factor - source_factor) > abs(source_factor) * Decimal("0.000001")
        quotes[symbol] = {"price": float(bar["open"]) if reason is None else None,
                          "price_date": execution_session if bar else None,
                          "quote_status": "ok" if reason is None else "unavailable", "reason": reason,
                          "adjustment_factor_changed": changed}
    return quotes


def _open_fingerprint(quotes):
    return paper._hash([{"symbol": symbol, "price_date": row["price_date"], "raw_open": row["price"]}
                        for symbol, row in sorted(quotes.items())])


def _evaluate(db, row, frozen):
    """Pure fixed-quantity evaluation in one read snapshot, with no sizing pass."""
    account = paper._account(db, row["account_id"])
    source = frozen["source_preview"]
    limits, policy = source["limits"], source["execution_policy"]
    symbol_policy = json.loads(account["symbol_policy_json"])
    quotes = _open_quotes(db, frozen, row["execution_session"])
    missing = [symbol for symbol, quote in quotes.items() if quote["price"] is None]
    violations, orders, projected_holdings = [], [], []
    cash = paper._decimal(account["cash"])
    cash_after = equity = equity_after = cash_weight = turnover = fees = slippage = buy_debit = None

    def violation(code, message, symbol=None):
        violations.append({"code": code, "message": message, **({"symbol": symbol} if symbol else {})})

    for symbol in missing:
        violation("quote_unavailable", quotes[symbol]["reason"], symbol)
    held_shares = {holding["symbol"]: paper._decimal(holding["shares"]) for holding in frozen["holdings"]}
    for order in source["orders"]:
        current = held_shares.get(order["symbol"], paper.ZERO)
        desired = current + paper._decimal(order["shares_exact"]) * (1 if order["side"] == "buy" else -1)
        denied = paper._policy_violation(symbol_policy, order["symbol"], current, desired)
        if denied:
            violations.append(denied)
    if not missing:
        projected = {holding["symbol"]: paper._decimal(holding["shares"]) for holding in frozen["holdings"]}
        equity = cash + sum((quantity * paper._decimal(quotes[symbol]["price"])
                             for symbol, quantity in projected.items()), paper.ZERO)
        cash_after, gross, fees, slippage, buy_debit = cash, paper.ZERO, paper.ZERO, paper.ZERO, paper.ZERO
        fee_rate = paper._decimal(policy["fee_bps"]) / 10000
        slippage_rate = paper._decimal(policy["slippage_bps"]) / 10000
        for symbol, quote in quotes.items():
            if quote["adjustment_factor_changed"]:
                violation("corporate_action_unsupported", "調整因子跨日變動，疑似公司行動；本版不調整股數", symbol)
        for frozen_order in source["orders"]:
            symbol, buying = frozen_order["symbol"], frozen_order["side"] == "buy"
            price, quantity = paper._decimal(quotes[symbol]["price"]), paper._decimal(frozen_order["shares_exact"])
            reference_notional = paper._money(quantity * price)
            fill_price = paper._money(price * (1 + slippage_rate if buying else 1 - slippage_rate))
            notional = paper._money(quantity * fill_price)
            fee = paper._money(notional * fee_rate)
            order_slippage = notional - reference_notional if buying else reference_notional - notional
            cash_delta = -(notional + fee) if buying else notional - fee
            current = projected.get(symbol, paper.ZERO)
            projected[symbol] = current + quantity * (1 if buying else -1)
            if reference_notional <= 0 or reference_notional < paper._decimal(policy["min_trade_notional"]):
                violation("min_trade_notional", "凍結委託在指定日低於最小交易金額，整批阻塞、不跳單", symbol)
            if projected[symbol] < 0:
                violation("insufficient_shares", "持股不足以完成凍結賣出股數", symbol)
            cash_after += cash_delta
            gross += reference_notional
            fees += fee
            slippage += order_slippage
            if buying:
                buy_debit += notional + fee
            orders.append({**frozen_order, "reference_price": float(price), "fill_price": float(fill_price),
                "fill_price_exact": str(fill_price), "reference_notional": float(reference_notional),
                "notional": float(notional), "notional_exact": str(notional),
                "fee": float(fee), "fee_exact": str(fee), "slippage_cost": float(order_slippage),
                "slippage_cost_exact": str(order_slippage), "cash_delta": float(cash_delta),
                "cash_delta_exact": str(cash_delta), "projected_weight_pct": None})
        orders.sort(key=lambda order: (order["side"] != "sell", order["symbol"]))
        equity_after = cash_after + sum((quantity * paper._decimal(quotes[symbol]["price"])
                                        for symbol, quantity in projected.items()), paper.ZERO)
        if equity > 0:
            turnover = gross / equity * 100
        if equity_after > 0:
            cash_weight = cash_after / equity_after * 100
        for symbol, quantity in sorted(projected.items()):
            if quantity <= 0:
                continue
            value = quantity * paper._decimal(quotes[symbol]["price"])
            weight = value / equity_after * 100 if equity_after > 0 else None
            projected_holdings.append({"symbol": symbol, "shares": float(quantity), "market_value": float(value),
                                       "weight_pct": float(weight) if weight is not None else None})
            if weight is not None and weight > paper._decimal(limits["max_position_weight_pct"]):
                violation("post_policy_max_position_weight", "開盤價與成本重驗後實際持倉權重超過上限", symbol)
        weights = {holding["symbol"]: holding["weight_pct"] for holding in projected_holdings}
        for order in orders:
            order["projected_weight_pct"] = weights.get(order["symbol"], 0)
        if equity <= 0 or equity_after <= 0:
            violation("nonpositive_equity", "模擬前後淨值必須大於零")
        if cash_after < 0:
            violation("insufficient_cash", "開盤價重驗後現金不足；不縮單或透支")
        if turnover is not None and turnover > paper._decimal(limits["max_turnover_pct"]):
            violation("max_turnover", "開盤參考名目金額超過凍結周轉率限制")
        if cash_weight is not None and cash_weight < paper._decimal(limits["min_cash_weight_pct"]):
            violation("min_cash_weight", "開盤價與成本重驗後現金低於凍結比例限制")
        if len(projected_holdings) > paper.MAX_HOLDINGS:
            violation("holding_limit", "模擬後持股超過本版上限")
        if fees + slippage > paper._decimal(frozen["max_execution_cost_usd"]):
            violation("execution_cost_cap", "費用加不利滑價超過開盤前授權上限")
        if buy_debit > paper._decimal(frozen["max_buy_cash_debit_usd"]):
            violation("buy_cash_debit_cap", "買入本金加買入手續費超過開盤前授權上限")

    def number(value):
        return float(value) if value is not None else None

    return {"engine_version": ENGINE_VERSION, "as_of": row["execution_session"], "input_revision": store.input_revision(db),
        "account_id": account["id"], "account_version": account["version"], "limits": limits, "execution_policy": policy,
        **({"symbol_policy": symbol_policy, "symbol_policy_method": paper.SYMBOL_POLICY_METHOD} if paper._policy_active(symbol_policy) else {}),
        "targets": source["targets"], "rationale": source["rationale"], "automation_source": source.get("automation_source"),
        **({"local_agent_source": source["local_agent_source"]} if source.get("local_agent_source") else {}),
        "coverage": {"required": len(quotes), "priced": len(quotes) - len(missing), "missing": missing},
        "quote_details": [{"symbol": symbol, **quote} for symbol, quote in quotes.items()],
        "valuation_complete": not missing, "equity_before": number(equity), "cash_before": float(cash),
        "cash_after": number(cash_after), "cash_after_exact": str(cash_after) if cash_after is not None else None,
        "equity_after": number(equity_after), "cash_weight_after_pct": number(cash_weight), "turnover_pct": number(turnover),
        "fees_total": number(fees), "slippage_total": number(slippage),
        "cost_total": number(fees + slippage) if fees is not None else None,
        "orders": orders, "skipped_orders": [], "projected_holdings": projected_holdings,
        "violations": violations, "executable": not violations, "signal_session": row["signal_session"],
        "execution_session": row["execution_session"], "gross_buy_cash_debit": number(buy_debit),
        "max_execution_cost_usd": frozen["max_execution_cost_usd"], "max_buy_cash_debit_usd": frozen["max_buy_cash_debit_usd"],
        "open_price_fingerprint": _open_fingerprint(quotes), "method": METHOD, "warnings": WARNINGS}


def _prepare_process(db, row, instant):
    frozen = json.loads(row["frozen_json"])
    invalid = _basic_invalid(db, row, frozen)
    if invalid:
        return "invalidated", *invalid, None
    if instant < pd.Timestamp(row["eligible_after"]):
        return "waiting_session", "waiting_session", "指定交易日尚未完成；需等待收盤後 15 分鐘", None
    try:
        digest, count = _prefix_digest(db, json.loads(row["source_manifest_json"]), row["signal_session"])
    except HTTPException as exc:
        return "invalidated", "source_history_unavailable", str(exc.detail), None
    if digest != row["prefix_digest"] or count != row["prefix_rows"]:
        return "invalidated", "source_history_changed", "原 signal 日及更早的行情或資料身份已修正，原委託失效", None
    evaluation = _evaluate(db, row, frozen)
    if not evaluation["valuation_complete"]:
        return "waiting_prices", "quote_unavailable", "指定交易日資料不完整；保留原日期與股數等待本機資料", evaluation
    if not evaluation["executable"]:
        return "blocked", "policy_blocked", "指定日開盤價重驗未通過；需檢閱原因並明確重試，不會自動縮單", evaluation
    return "filled", "filled", "已按指定日開盤參考價完成整批本機模擬", evaluation


def _record_attempt(db, row, body, trigger_kind, status, code, reason, evaluation, revision, now, *, action="process"):
    db.execute("""INSERT INTO paper_next_open_attempts
        (order_id,trigger_kind,idempotency_key,status,reason_code,reason,input_revision,evaluation_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", (row["id"], trigger_kind, f"{action}:{body.idempotency_key}", status, code, reason, revision,
                                        paper._json(evaluation) if evaluation else None, now))


@router.post("/api/paper/accounts/{account_id}/next-open-orders/{order_id}/process")
def process_order(account_id: str, order_id: str, body: OrderActionInput):
    return _process_order(account_id, order_id, body)


def _process_order(account_id, order_id, body, *, trigger_kind="manual", stopping=lambda: False):
    scope = f"next-open-process:{account_id}:{order_id}"
    payload = {**body.model_dump(exclude={"idempotency_key"}), "trigger_kind": trigger_kind}
    with store.read_snapshot(), store.connect() as db, localcontext() as context:
        context.prec = 50
        existing = paper._existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        row = _get_order(db, account_id, order_id)
        if row["version"] != body.expected_order_version:
            raise HTTPException(409, "委託版本已變更，請重新載入")
        if row["status"] not in ACTIVE or trigger_kind == "scheduler" and row["status"] == "blocked":
            raise HTTPException(409, "此委託狀態不可接續處理")
        revision = store.input_revision(db)
        status, code, reason, evaluation = _prepare_process(db, row, _instant())
    with paper._write() as db:
        existing = paper._existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        current = _get_order(db, account_id, order_id)
        if current["version"] != body.expected_order_version or current["status"] not in ACTIVE:
            raise HTTPException(409, "計算期間委託已取消或改變，請重新載入")
        if stopping():
            raise HTTPException(503, "本機 runner 已停止；未執行模擬")
        if store.input_revision(db) != revision:
            raise HTTPException(503, "驗算期間行情已變更；未寫入成交，請以相同識別碼重試")
        frozen = json.loads(current["frozen_json"])
        invalid = _basic_invalid(db, current, frozen)
        if invalid:
            status, (code, reason), evaluation = "invalidated", invalid, None
        now, execution_id = store.now(), None
        if status == "filled":
            instant = _instant()
            if instant < pd.Timestamp(current["eligible_after"]):
                raise HTTPException(409, "指定日尚未完成，不允許提前執行")
            execution_id = uuid.uuid4().hex
            evaluation = {**evaluation, "queue_order_id": order_id, "source_proposal_id": current["source_proposal_id"],
                          "recorded_at": now, "effective_session": current["execution_session"],
                          "late_recording": sessions.latest_completed_session(instant) > current["execution_session"]}
            execution_request = {"queue_order_id": order_id, "source_proposal_id": current["source_proposal_id"],
                                 "method_version": ENGINE_VERSION}
            db.execute("""INSERT INTO paper_proposals(id,account_id,status,preview_json,request_json,created_at,accepted_at)
                VALUES (?,?,'simulated',?,?,?,?)""", (execution_id, account_id, paper._json(evaluation),
                                                       paper._json(execution_request), now, now))
            paper._settle_orders(db, paper._account(db, account_id), execution_id, evaluation["orders"],
                                 evaluation["cash_after_exact"], now)
        db.execute("""UPDATE paper_next_open_orders SET status=?,version=version+1,evaluation_json=?,
            reason_code=?,reason=?,execution_proposal_id=?,last_checked_revision=?,updated_at=?,completed_at=? WHERE id=?""",
            (status, paper._json(evaluation) if evaluation else None, code, reason, execution_id, revision,
             now, now if status in TERMINAL else None, order_id))
        _record_attempt(db, current, body, trigger_kind, status, code, reason, evaluation, revision, now)
        response = _view(db, _get_order(db, account_id, order_id))
        paper._remember_request(db, scope, body.idempotency_key, payload, response)
        return response


@router.post("/api/paper/accounts/{account_id}/next-open-orders/{order_id}/cancel")
def cancel_order(account_id: str, order_id: str, body: OrderActionInput):
    scope, payload = f"next-open-cancel:{account_id}:{order_id}", body.model_dump(exclude={"idempotency_key"})
    with paper._write() as db:
        existing = paper._existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        row = _get_order(db, account_id, order_id)
        if row["version"] != body.expected_order_version or row["status"] not in ACTIVE:
            raise HTTPException(409, "委託已更新或結束，無法取消")
        now = store.now()
        db.execute("""UPDATE paper_next_open_orders SET status='cancelled',version=version+1,reason_code='cancelled',
            reason='使用者已取消，未寫入成交',updated_at=?,completed_at=? WHERE id=?""", (now, now, order_id))
        _record_attempt(db, row, body, "manual", "cancelled", "cancelled", "使用者已取消，未寫入成交", None,
                        store.input_revision(db), now, action="cancel")
        response = _view(db, _get_order(db, account_id, order_id))
        paper._remember_request(db, scope, body.idempotency_key, payload, response)
        return response


def _due_pending():
    """Read-only eligibility; an idle runner must not reserve the writer lock."""
    with store.read_snapshot(), store.connect() as db:
        revision, instant = store.input_revision(db), _instant()
        rows = [dict(row) for row in db.execute("""SELECT * FROM paper_next_open_orders
            WHERE status IN ('waiting_session','waiting_prices') ORDER BY created_at,id LIMIT 20""")
            if instant >= pd.Timestamp(row["eligible_after"])
            and (row["status"] != "waiting_prices" or row["last_checked_revision"] != revision)]
    return revision, rows


def tick(*, stopping=lambda: False):
    """Only pending batches; no downloads, blocked retries, or date rollover."""
    from . import jobs
    if stopping():
        return {"processed": 0, "reason": "stopped_or_workspace_busy"}
    _, pending = _due_pending()
    if not pending:
        return {"processed": 0, "reason": "no_due_orders"}
    if stopping() or not jobs.RUN_LOCK.acquire(blocking=False):
        return {"processed": 0, "reason": "stopped_or_workspace_busy"}
    processed = 0
    try:
        # The preliminary read grants no authority. Refresh after acquiring the
        # lock, then retain each process transaction's version/source checks.
        revision, rows = _due_pending()
        for row in rows:
            if stopping():
                break
            body = OrderActionInput(expected_order_version=row["version"],
                                    idempotency_key=f"scheduler-{row['version']}-{hashlib.sha256(revision.encode()).hexdigest()[:24]}")
            try:
                _process_order(row["account_id"], row["id"], body, trigger_kind="scheduler", stopping=stopping)
                processed += 1
            except HTTPException as exc:
                # Expected source/queue contention is retried on a later tick;
                # no detached worker can outlive this runner's stop signal.
                if exc.status_code not in (404, 409, 503):
                    raise
        return {"processed": processed, "reason": None}
    finally:
        jobs.RUN_LOCK.release()


class Scheduler:
    def __init__(self):
        self._stopping = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stopping.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="paper-next-open")
        self._thread.start()

    def _run(self):
        while not self._stopping.is_set():
            try:
                tick(stopping=self._stopping.is_set)
            except Exception:
                logger.exception("Next-open paper runner tick failed")
            self._stopping.wait(POLL_INTERVAL_SECONDS)

    def stop(self):
        self._stopping.set()
        if self._thread:
            self._thread.join(timeout=5)
