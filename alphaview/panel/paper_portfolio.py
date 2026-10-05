"""Isolated, local paper accounts with explicitly accepted close-price simulations.

No broker, network access, real-position import, or automatic execution lives here.
Paper writes have their own account version and never advance market input revisions.
"""
import hashlib
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN, localcontext
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import sessions, store
from .risk import valid_bar

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-portfolio-v2"
METHOD = (
    "獨立 USD 虛擬帳戶；目標權重以模擬前完整淨值為分母，未指定標的目標為 0%，"
    "剩餘權重保留現金，缺價不重分配。僅用最新已完成 XNYS 交易日的本機未調整收盤價，"
    "接受提案後按該參考價加不利滑價模擬，不是次日開盤、即時行情或券商成交。"
    "下單股數按設定 0–6 位小數向零截斷，金額取 8 位；低於最小交易金額的委託跳過，"
    "保留原現金與持倉，再核對扣費後實際權重。周轉率為買賣參考名目金額合計／模擬前淨值。"
    "手續費按模擬成交金額計算；買入成本包含費用、賣出損益扣除費用，採移動平均成本。"
    "不含稅、流動性、市場衝擊、股息及拆併股自動調整。"
)
WARNINGS = [
    "僅供本機流程演練；沒有連接券商，也不會改動真實持股。",
    "同日收盤參考價無法證明真實可成交；費用與滑價是使用者設定的假設，未建模流動性及公司行動，不能視為策略回測或實際績效。",
]
SHARE_STEP = Decimal("0.000001")
MONEY_STEP = Decimal("0.00000001")
ZERO = Decimal(0)
HUNDRED = Decimal(100)
MAX_ACCOUNTS = 20
MAX_HOLDINGS = 50
SYMBOL_POLICY_VERSION = "alphaview-paper-symbol-policy-v1"
SYMBOL_POLICY_METHOD = (
    "帳戶可選擇不限制標的或明確允許清單；空清單禁止所有新增股數。"
    "未允許的既有持倉僅可維持或減少股數，依完整淨值計算的目標股數判斷，"
    "在精度與最低交易额處理前檢查，不豁免報價、現金、費用或其他限制。"
    "政策每次變更保存不可覆寫版本；舊提案、規則來源及延後委託需重新授權。"
    "被排除的規則配置席位保留現金，不用其他候選補位。"
)


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Limits(StrictInput):
    max_position_weight_pct: float = Field(default=35, ge=0, le=100, strict=True)
    max_turnover_pct: float = Field(default=100, ge=0, le=200, strict=True)
    min_cash_weight_pct: float = Field(default=10, ge=0, le=100, strict=True)


class ExecutionPolicy(StrictInput):
    fee_bps: float = Field(default=0, ge=0, le=1000, strict=True)
    slippage_bps: float = Field(default=0, ge=0, le=1000, strict=True)
    min_trade_notional: float = Field(default=0, ge=0, le=1_000_000, strict=True)
    share_precision: int = Field(default=6, ge=0, le=6, strict=True)


class SymbolPolicy(StrictInput):
    mode: Literal["unrestricted", "allowlist"] = "unrestricted"
    symbols: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("symbols")
    @classmethod
    def clean_symbols(cls, values):
        # Use the same symbol grammar as manual paper targets, without silently
        # dropping duplicate entries or importing a research universe.
        result = [TargetWeight(symbol=value, weight_pct=0).symbol for value in values]
        if len(result) != len(set(result)):
            raise ValueError("允許清單的標的不可重複")
        return sorted(result)

    @model_validator(mode="after")
    def meaningful_symbols(self):
        if self.mode == "unrestricted" and self.symbols:
            raise ValueError("不限制標的模式的清單必須留空")
        return self


class AccountInput(StrictInput):
    name: str = Field(min_length=1, max_length=80)
    initial_cash: float = Field(gt=0, le=1_000_000_000, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    limits: Limits = Field(default_factory=Limits)
    execution_policy: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    symbol_policy: SymbolPolicy = Field(default_factory=SymbolPolicy)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("請輸入虛擬帳戶名稱")
        return value

    @field_validator("initial_cash")
    @classmethod
    def cash_precision(cls, value):
        if _money(value) <= 0:
            raise ValueError("初始虛擬現金至少為 0.00000001 USD")
        return value


class ControlsInput(StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    kill_switch: bool | None = Field(default=None, strict=True)
    limits: Limits | None = None
    execution_policy: ExecutionPolicy | None = None
    symbol_policy: SymbolPolicy | None = None

    @model_validator(mode="after")
    def some_control(self):
        if self.kill_switch is None and self.limits is None and self.execution_policy is None and self.symbol_policy is None:
            raise ValueError("請指定暫停開關、風險限制或模擬執行政策")
        return self


class TargetWeight(StrictInput):
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9][A-Z0-9.\-^=]{0,19}$")
    weight_pct: float = Field(ge=0, le=100, strict=True)

    @field_validator("symbol", mode="before")
    @classmethod
    def normalize_symbol(cls, value):
        return value.strip().upper() if isinstance(value, str) else value


class AutomationSource(StrictInput):
    mandate_id: str = Field(min_length=1, max_length=100)
    mandate_version: int = Field(ge=1, strict=True)
    attempt_id: str = Field(min_length=1, max_length=100)


class LocalAgentSource(StrictInput):
    analysis_id: str = Field(min_length=1, max_length=100)
    engine_version: str = Field(min_length=1, max_length=100)


class JevSource(StrictInput):
    run_id: str = Field(min_length=1, max_length=100)
    engine_version: str = Field(min_length=1, max_length=100)


class PreviewInput(StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    targets: list[TargetWeight] = Field(max_length=MAX_HOLDINGS)
    rationale: str = Field(default="", max_length=2000)
    automation_source: AutomationSource | None = None
    local_agent_source: LocalAgentSource | None = None
    jev_source: JevSource | None = None
    expected_input_revision: str | None = Field(default=None, min_length=1, max_length=100)
    expected_as_of: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def complete_weights(self):
        if sum(source is not None for source in (self.automation_source, self.local_agent_source, self.jev_source)) > 1:
            raise ValueError("提案只能綁定一種 Agent 來源")
        if len({item.symbol for item in self.targets}) != len(self.targets):
            raise ValueError("目標代碼不可重複")
        if sum((_decimal(item.weight_pct) for item in self.targets), ZERO) > HUNDRED:
            raise ValueError("目標權重總和不得超過 100%；剩餘權重保留現金")
        return self


class ProposalInput(PreviewInput):
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


class AcceptInput(StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


class RejectInput(StrictInput):
    expected_version: int = Field(ge=1, strict=True)


def init_schema(db):
    """Called by workspace initialization, never by a read endpoint."""
    statements = [
        """CREATE TABLE IF NOT EXISTS paper_accounts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
            initial_cash TEXT NOT NULL, cash TEXT NOT NULL, realized_pnl TEXT NOT NULL DEFAULT '0',
            version INTEGER NOT NULL DEFAULT 1, kill_switch INTEGER NOT NULL DEFAULT 0,
            limits_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS paper_holdings (
            account_id TEXT NOT NULL, symbol TEXT NOT NULL, shares TEXT NOT NULL,
            cost_basis TEXT NOT NULL, PRIMARY KEY(account_id,symbol),
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        )""",
        """CREATE TABLE IF NOT EXISTS paper_proposals (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
            preview_json TEXT NOT NULL, request_json TEXT NOT NULL,
            created_at TEXT NOT NULL, accepted_at TEXT,
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        )""",
        """CREATE TABLE IF NOT EXISTS paper_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
            kind TEXT NOT NULL, symbol TEXT, shares_delta TEXT NOT NULL DEFAULT '0',
            price TEXT, cash_delta TEXT NOT NULL, cash_after TEXT NOT NULL,
            realized_pnl TEXT NOT NULL DEFAULT '0', proposal_id TEXT, created_at TEXT NOT NULL,
            UNIQUE(proposal_id,symbol), FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        )""",
        """CREATE TABLE IF NOT EXISTS paper_idempotency (
            scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_paper_proposals_account ON paper_proposals(account_id,created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_paper_ledger_account ON paper_ledger(account_id,id DESC)",
    ]
    for statement in statements:
        db.execute(statement)
    # Upgrade first-wave paper tables without rewriting old proposals or fills.
    columns = {row["name"] for row in db.execute("PRAGMA table_info(paper_accounts)")}
    if "execution_policy_json" not in columns:
        default = _json(ExecutionPolicy().model_dump())
        db.execute("ALTER TABLE paper_accounts ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT '" + default + "'")
    if "symbol_policy_json" not in columns:
        default = _json(_initial_symbol_policy())
        db.execute("ALTER TABLE paper_accounts ADD COLUMN symbol_policy_json TEXT NOT NULL DEFAULT '" + default + "'")
    db.execute("""CREATE TABLE IF NOT EXISTS paper_symbol_policy_history (
        account_id TEXT NOT NULL, version INTEGER NOT NULL,
        policy_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(account_id,version), FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
    )""")
    db.execute("""INSERT OR IGNORE INTO paper_symbol_policy_history(account_id,version,policy_json,created_at)
        SELECT id,1,symbol_policy_json,created_at FROM paper_accounts""")
    ledger_columns = {row["name"] for row in db.execute("PRAGMA table_info(paper_ledger)")}
    for column, declaration in (("fee", "TEXT NOT NULL DEFAULT '0'"),
                                ("slippage_cost", "TEXT NOT NULL DEFAULT '0'"),
                                ("reference_price", "TEXT")):
        if column not in ledger_columns:
            db.execute(f"ALTER TABLE paper_ledger ADD COLUMN {column} {declaration}")


def _decimal(value):
    return Decimal(str(value))


def _money(value):
    return _decimal(value).quantize(MONEY_STEP, rounding=ROUND_HALF_EVEN)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


# Additive preview metadata that replay checks ignore, so proposals stored before a
# key existed still verify against a fresh preview.
PREVIEW_METADATA = ("risk_direction", "notices")


def _fingerprint(preview):
    return _hash({key: value for key, value in preview.items() if key not in PREVIEW_METADATA})


def _risk_direction(held, targets, quotes, equity):
    """Compare every target with the current weight from the same valuation; None when unpriced."""
    if equity is None or equity <= 0:
        return None
    current = {symbol: _decimal(row["shares"]) * _decimal(quotes[symbol]["price"]) / equity * HUNDRED
               for symbol, row in held.items()}
    increasing = reducing = False
    for symbol in set(current) | set(targets):
        before, after = current.get(symbol, ZERO), targets.get(symbol, ZERO)
        if after > before:
            increasing = True
        elif after < before:
            reducing = True
    return "mixed" if increasing and reducing else "increasing" if increasing else "reducing" if reducing else "unchanged"


def _reduce_only_exempt(db, account_id, preview):
    from .circuit_breakers import reduce_only_exempt
    return reduce_only_exempt(db, account_id, preview)


def _pause_refusal(db, account_id, preview):
    from .circuit_breakers import reduce_only_allowed, reduce_only_hint
    return "虛擬帳戶已暫停，無法模擬成交" + reduce_only_hint(reduce_only_allowed(db, account_id), preview.get("risk_direction"))


def _initial_symbol_policy(policy=None):
    return {"engine_version": SYMBOL_POLICY_VERSION, "version": 1,
            **(policy or SymbolPolicy()).model_dump()}


def _symbol_policy(db, account_id):
    return json.loads(_account(db, account_id)["symbol_policy_json"])


def _policy_active(policy):
    """Only pristine unrestricted accounts retain legacy receipt fingerprints."""
    return policy["mode"] != "unrestricted" or policy["version"] != 1


def _policy_context(db, context):
    context = context.model_dump() if hasattr(context, "model_dump") else context
    policy = _symbol_policy(db, context["account_id"])
    if context["expected_policy_version"] != policy["version"]:
        raise HTTPException(409, "允許標的政策已變更，請重新載入並產生工作流")
    return {"account_id": context["account_id"], "symbol_policy": policy}


def _policy_context_current(db, context):
    try:
        return context["symbol_policy"] == _symbol_policy(db, context["account_id"])
    except (HTTPException, KeyError, TypeError):
        return False


def _validate_policy_binding(db, context, account_id):
    if context and (context["account_id"] != account_id or not _policy_context_current(db, context)):
        raise HTTPException(409, "Agent 來源的帳戶或允許標的政策已變更，請重新產生工作流")


def _symbol_allowed(policy, symbol):
    return policy["mode"] == "unrestricted" or symbol in policy["symbols"]


def _policy_violation(policy, symbol, current_shares, desired_shares):
    if not _symbol_allowed(policy, symbol) and desired_shares > current_shares:
        return {"code": "symbol_not_allowed", "symbol": symbol,
                "message": "標的不在允許清單；既有持倉僅可維持或減少股數",
                "policy_version": policy["version"], "policy_engine_version": policy["engine_version"]}
    return None


def _insert_symbol_policy(db, account_id, policy, now):
    db.execute("UPDATE paper_accounts SET symbol_policy_json=? WHERE id=?", (_json(policy), account_id))
    db.execute("INSERT INTO paper_symbol_policy_history VALUES (?,?,?,?)",
               (account_id, policy["version"], _json(policy), now))


@contextmanager
def _write():
    try:
        with store.connect() as db:
            db.execute("PRAGMA busy_timeout=1000")
            db.execute("BEGIN IMMEDIATE")
            with localcontext() as context:
                context.prec = 50
                yield db
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise HTTPException(503, "虛擬帳戶資料庫忙碌，請稍後以相同請求識別碼重試") from exc
        raise


def _account(db, account_id):
    row = db.execute("SELECT * FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到虛擬帳戶")
    return dict(row)


def _version(account, expected):
    if account["version"] != expected:
        raise HTTPException(409, "虛擬帳戶已變更，請重新載入並預覽")


def _public_account(row):
    return {
        "id": row["id"], "name": row["name"], "currency": row["currency"],
        "initial_cash": float(row["initial_cash"]), "cash": float(row["cash"]),
        "version": row["version"], "kill_switch": bool(row["kill_switch"]),
        "limits": json.loads(row["limits_json"]), "execution_policy": json.loads(row["execution_policy_json"]),
        "symbol_policy": json.loads(row["symbol_policy_json"]),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def _quote(db, symbol, as_of):
    row = db.execute("SELECT * FROM bars WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT 1", (symbol, as_of)).fetchone()
    dataset = db.execute("SELECT currency FROM datasets WHERE symbol=?", (symbol,)).fetchone()
    detail = {"price": None, "price_date": row["date"] if row else None,
              "quote_status": "unavailable", "reason": "最新已完成交易日日線不可用"}
    if row is None:
        return detail
    if row["date"] != as_of:
        return {**detail, "quote_status": "stale", "reason": "行情尚未更新至最新已完成交易日"}
    if not valid_bar(row):
        return {**detail, "reason": "最新已完成交易日日線無效；未改用舊價"}
    if dataset is None or dataset["currency"] != "USD":
        return {**detail, "reason": "本機資料未確認 USD 計價，無法換算虛擬帳戶"}
    price = float(row["close"])
    if not 0.000001 <= price <= 1_000_000_000:
        return {**detail, "reason": "參考價格超出本版模擬支援範圍"}
    return {"price": price, "price_date": as_of, "quote_status": "ok", "reason": None}


def _holdings(db, account_id):
    return [dict(row) for row in db.execute(
        "SELECT symbol,shares,cost_basis FROM paper_holdings WHERE account_id=? ORDER BY symbol", (account_id,))]


def _valuation(db, account, as_of):
    rows = []
    total = ZERO
    priced = 0
    for position in _holdings(db, account["id"]):
        quantity, basis = _decimal(position["shares"]), _decimal(position["cost_basis"])
        quote = _quote(db, position["symbol"], as_of)
        value = quantity * _decimal(quote["price"]) if quote["price"] is not None else None
        if value is not None:
            total += value
            priced += 1
        rows.append({"symbol": position["symbol"], "shares": float(quantity),
                     "cost_basis": float(basis), "average_cost": float(basis / quantity),
                     **quote, "market_value": float(value) if value is not None else None,
                     "weight_pct": None,
                     "unrealized_pnl": float(value - basis) if value is not None else None})
    complete = priced == len(rows)
    equity = total + _decimal(account["cash"]) if complete else None
    if equity is not None and equity > 0:
        for row in rows:
            row["weight_pct"] = float(_decimal(row["market_value"]) / equity * HUNDRED)
    return {"holdings": rows, "coverage": {"required": len(rows), "priced": priced,
             "missing": [row["symbol"] for row in rows if row["price"] is None]},
            "valuation_complete": complete,
            "equity": float(equity) if equity is not None else None,
            "holdings_value": float(total) if complete else None,
            "priced_holdings_subtotal": float(total),
            "cash_weight_pct": float(_decimal(account["cash"]) / equity * HUNDRED) if equity else None,
            "unrealized_pnl": float(sum((_decimal(row["unrealized_pnl"]) for row in rows), ZERO)) if complete else None,
            "realized_pnl": float(account["realized_pnl"]),
            "total_return_pct": float((equity / _decimal(account["initial_cash"]) - 1) * HUNDRED) if equity is not None else None}


PROVENANCE_VERSION = "alphaview-proposal-provenance-v1"
_REGIME_SCALED = re.compile(r"市場風險覆蓋 alphaview-regime-overlay-v\d+：")
_REDUCE_ONLY = re.compile(r"純減倉模式 alphaview-reduce-only-v\d+")
_ALLOCATOR = re.compile(r"風險感知配置（([a-z_]+)，")
_VALIDATION = re.compile(r"validation=(off|\{.*\})\s*$", re.S)


def provenance(view):
    """Read-time view of who built a proposal and which gates shaped it, from stored evidence only (never guessed)."""
    rationale = view.get("rationale") or ""
    tags = set()
    if view.get("automation_source"):
        source = "automation"
    elif view.get("jev_source"):
        source = "jev"
        tags.add("jev_gate")
    elif view.get("local_agent_source"):
        source = "local_agent"
    elif rationale.startswith("Position stops alphaview-position-stops-v"):
        source = "position_stops"
        tags.add("position_stop")
    elif rationale.startswith("Research Desk 策略 "):
        source = "strategy_bridge"
    elif rationale.startswith("本機規則 Agent run "):
        source = "rules_workflow"
    else:
        source = "manual"
    if "目標已經 Jev 決策閘過濾" in rationale:
        tags.add("jev_gate")
    if _REGIME_SCALED.search(rationale):
        tags.add("regime_overlay:scale")
    if any(item.get("code") in ("regime_exposure_cap", "regime_unavailable") for item in view.get("violations") or []):
        tags.add("regime_overlay:block")
    if _REDUCE_ONLY.search(rationale):
        tags.add("reduce_only")
    allocator = _ALLOCATOR.search(rationale)
    if allocator:
        tags.add(f"allocator:{allocator.group(1)}")
    elif source in ("automation", "rules_workflow") and "固定配置" in rationale:
        tags.add("allocator:equal")
    validation = _VALIDATION.search(rationale)
    if validation:
        if validation.group(1) == "off":
            tags.add("validation:off")
        else:
            try:
                gate = json.loads(validation.group(1)).get("gate")
            except ValueError:
                gate = None
            if isinstance(gate, str) and gate:
                tags.add(f"validation:{gate}")
    if any(item.get("code") == "corporate_action_since_entry" for item in view.get("notices") or []):
        tags.add("corporate_action_notice")
    if view.get("status") == "submitted_external":
        tags.add("execution:alpaca_paper")
    return {"engine_version": PROVENANCE_VERSION, "source": source, "tags": sorted(tags)}


def _proposal(row):
    view = {**json.loads(row["preview_json"]), "id": row["id"], "status": row["status"],
            "created_at": row["created_at"], "accepted_at": row["accepted_at"]}
    view["provenance"] = provenance(view)
    return view


def _ledger(row):
    return {"id": row["id"], "kind": row["kind"], "symbol": row["symbol"],
            "shares_delta": float(row["shares_delta"]), "price": float(row["price"]) if row["price"] is not None else None,
            "cash_delta": float(row["cash_delta"]), "cash_after": float(row["cash_after"]),
            "realized_pnl": float(row["realized_pnl"]), "proposal_id": row["proposal_id"],
            "created_at": row["created_at"], "fee": float(row["fee"]),
            "slippage_cost": float(row["slippage_cost"]),
            "reference_price": float(row["reference_price"]) if row["reference_price"] is not None else (float(row["price"]) if row["price"] is not None else None)}


def _snapshot(db, account_id, as_of=None):
    as_of = as_of or sessions.latest_completed_session()
    account = _account(db, account_id)
    ledger = [_ledger(row) for row in db.execute(
        "SELECT * FROM paper_ledger WHERE account_id=? ORDER BY id DESC LIMIT 100", (account_id,))]
    proposals = [_proposal(row) for row in db.execute(
        "SELECT * FROM paper_proposals WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 20", (account_id,))]
    ledger_count = db.execute("SELECT COUNT(*) FROM paper_ledger WHERE account_id=?", (account_id,)).fetchone()[0]
    proposal_count = db.execute("SELECT COUNT(*) FROM paper_proposals WHERE account_id=?", (account_id,)).fetchone()[0]
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
            "account": _public_account(account), **_valuation(db, account, as_of),
            "ledger": ledger, "ledger_count": ledger_count, "ledger_truncated": ledger_count > len(ledger),
            "proposals": proposals, "proposal_count": proposal_count, "proposals_truncated": proposal_count > len(proposals),
            "method": METHOD, "warnings": WARNINGS}


def _existing_request(db, scope, key, body):
    row = db.execute("SELECT * FROM paper_idempotency WHERE scope=? AND key=?", (scope, key)).fetchone()
    if row is None:
        return None
    if row["request_hash"] != _hash(body):
        raise HTTPException(409, "請求識別碼已被不同內容使用，請勿重用")
    return json.loads(row["response_json"])


def _remember_request(db, scope, key, body, response):
    db.execute("INSERT INTO paper_idempotency VALUES (?,?,?,?,?)",
               (scope, key, _hash(body), _json(response), store.now()))


@router.get("/api/paper/accounts")
@store.snapshot_read
def accounts():
    with store.connect() as db:
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db),
                "accounts": [_public_account(dict(row)) for row in db.execute("SELECT * FROM paper_accounts ORDER BY created_at,id")],
                "method": METHOD, "warnings": WARNINGS}


@router.get("/api/paper/accounts/{account_id}")
@store.snapshot_read
def account_snapshot(account_id: str):
    with store.connect() as db:
        return _snapshot(db, account_id)


@router.post("/api/paper/accounts")
def create_account(body: AccountInput):
    payload = body.model_dump(exclude={"idempotency_key"})
    if body.symbol_policy == SymbolPolicy():
        payload.pop("symbol_policy", None)
    with _write() as db:
        existing = _existing_request(db, "create_account", body.idempotency_key, payload)
        if existing is not None:
            return existing
        if db.execute("SELECT COUNT(*) FROM paper_accounts").fetchone()[0] >= MAX_ACCOUNTS:
            raise HTTPException(422, f"本版最多支援 {MAX_ACCOUNTS} 個虛擬帳戶")
        account_id, now = uuid.uuid4().hex, store.now()
        cash = str(_money(body.initial_cash))
        db.execute("""INSERT INTO paper_accounts
            (id,name,currency,initial_cash,cash,limits_json,created_at,updated_at,execution_policy_json)
            VALUES (?,?,'USD',?,?,?,?,?,?)""", (account_id, body.name, cash, cash, _json(body.limits.model_dump()), now, now, _json(body.execution_policy.model_dump())))
        db.execute("""INSERT INTO paper_ledger(account_id,kind,cash_delta,cash_after,created_at)
            VALUES (?,'initial_cash',?,?,?)""", (account_id, cash, cash, now))
        _insert_symbol_policy(db, account_id, _initial_symbol_policy(body.symbol_policy), now)
        response = _snapshot(db, account_id)
        _remember_request(db, "create_account", body.idempotency_key, payload, response)
        return response


@router.patch("/api/paper/accounts/{account_id}/controls")
def update_controls(account_id: str, body: ControlsInput):
    snapshot, paused_now = _update_controls_locked(account_id, body)
    if paused_now:
        # After the pause has committed: one cancel request per working Alpaca order; a broker problem never undoes the pause.
        from .execution import sweep_after_pause
        snapshot["execution_sweep"] = sweep_after_pause(account_id, "kill_switch_enabled")
    return snapshot


def _update_controls_locked(account_id, body):
    with _write() as db:
        account = _account(db, account_id)
        _version(account, body.expected_version)
        kill = int(body.kill_switch) if body.kill_switch is not None else account["kill_switch"]
        if account["kill_switch"] and not kill:
            from .circuit_breakers import record_resume
            record_resume(db, account_id, account["version"])
        if kill and not account["kill_switch"]:
            # A manual pause also revokes standing automation authority until the mandate is renewed.
            from .agent_automation import require_reauth
            require_reauth(db, account_id, "kill_switch_enabled")
        limits = _json(body.limits.model_dump()) if body.limits is not None else account["limits_json"]
        policy = _json(body.execution_policy.model_dump()) if body.execution_policy is not None else account["execution_policy_json"]
        if body.symbol_policy is not None:
            previous = json.loads(account["symbol_policy_json"])
            requested = body.symbol_policy.model_dump()
            if any(previous[key] != requested[key] for key in requested):
                _insert_symbol_policy(db, account_id,
                    {"engine_version": SYMBOL_POLICY_VERSION, "version": previous["version"] + 1, **requested}, store.now())
        db.execute("UPDATE paper_accounts SET kill_switch=?,limits_json=?,execution_policy_json=?,version=version+1,updated_at=? WHERE id=?",
                   (kill, limits, policy, store.now(), account_id))
        return _snapshot(db, account_id), bool(kill and not account["kill_switch"])


@router.get("/api/paper/accounts/{account_id}/symbol-policy/history")
@store.snapshot_read
def symbol_policy_history(account_id: str):
    with store.connect() as db:
        account = _account(db, account_id)
        return {"engine_version": SYMBOL_POLICY_VERSION, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db), "account_version": account["version"],
                "items": [{"policy": json.loads(row["policy_json"]), "created_at": row["created_at"]}
                          for row in db.execute("SELECT * FROM paper_symbol_policy_history WHERE account_id=? ORDER BY version DESC", (account_id,))],
                "method": SYMBOL_POLICY_METHOD}


def _build_preview(db, account_id, body, as_of):
    revision = store.input_revision(db)
    if body.automation_source is not None:
        from .agent_automation import validate_source
        attempt = validate_source(db, body.automation_source.model_dump())
        if attempt["account_id"] != account_id:
            raise HTTPException(409, "自動化來源與虛擬帳戶不符")
        if "validated_target_weights" in attempt:
            if as_of != attempt["session_date"] or revision != attempt["input_revision"]:
                raise HTTPException(409, "自動化決策交易日或行情版本已變更，請重新產生")
            try:
                validated = [TargetWeight.model_validate(target).model_dump() for target in attempt["validated_target_weights"]]
            except (TypeError, ValueError) as exc:
                raise HTTPException(409, "自動化來源沒有有效的已驗證目標配置") from exc
            if validated != [target.model_dump() for target in body.targets]:
                raise HTTPException(409, "提案目標與已驗證的自動化決策不符")
    if body.local_agent_source is not None:
        # Lazy import keeps paper calculations independent of optional model workers.
        from .local_agent import validate_source
        source_result = validate_source(db, body.local_agent_source.model_dump())
        _validate_policy_binding(db, source_result.get("account_context"), account_id)
        try:
            source_targets = [TargetWeight.model_validate(row).model_dump() for row in source_result["target_weights"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(409, "本機模型來源沒有有效的完整目標配置") from exc
        if source_targets != [target.model_dump() for target in body.targets]:
            raise HTTPException(409, "提案目標與已驗證的本機模型輸出不符，請重新載入分析")
    if body.jev_source is not None:
        from .jev_decision import validate_source as validate_jev_source
        jev_result = validate_jev_source(db, body.jev_source.model_dump())
        _validate_policy_binding(db, jev_result.get("account_context"), account_id)
        try:
            jev_targets = [TargetWeight.model_validate(row).model_dump() for row in jev_result["target_weights"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(409, "Jev 決策來源沒有有效的完整目標配置") from exc
        if jev_targets != [target.model_dump() for target in body.targets]:
            raise HTTPException(409, "提案目標與已驗證的 Jev 決策結果不符，請重新載入決策")
    if body.expected_input_revision is not None and body.expected_input_revision != revision:
        raise HTTPException(409, "提案來源行情版本已變更，請重新產生 Agent run")
    if body.expected_as_of is not None and body.expected_as_of != as_of:
        raise HTTPException(409, "提案來源交易日已變更，請重新產生 Agent run")
    account = _account(db, account_id)
    _version(account, body.expected_version)
    limits = json.loads(account["limits_json"])
    policy = json.loads(account["execution_policy_json"])
    symbol_policy = json.loads(account["symbol_policy_json"])
    held = {row["symbol"]: row for row in _holdings(db, account_id)}
    targets = {target.symbol: _decimal(target.weight_pct) for target in body.targets}
    required = sorted(set(held) | {symbol for symbol, weight in targets.items() if weight > 0})
    quotes = {symbol: _quote(db, symbol, as_of) for symbol in required}
    missing = [symbol for symbol in required if quotes[symbol]["price"] is None]
    violations, orders, skipped, projected_holdings = [], [], [], []
    cash = _decimal(account["cash"])
    equity = cash + sum((_decimal(row["shares"]) * _decimal(quotes[symbol]["price"])
                         for symbol, row in held.items()), ZERO) if not missing else None
    direction = _risk_direction(held, targets, quotes, equity)

    def violation(code, message, symbol=None):
        violations.append({"code": code, "message": message, **({"symbol": symbol} if symbol else {})})

    if account["kill_switch"] and not _reduce_only_exempt(db, account_id, {"risk_direction": direction}):
        from .circuit_breakers import reduce_only_allowed, reduce_only_hint
        violation("kill_switch", "虛擬帳戶已暫停，解除暫停後需重新建立提案"
                  + reduce_only_hint(reduce_only_allowed(db, account_id), direction))
    for symbol in missing:
        violation("quote_unavailable", quotes[symbol]["reason"], symbol)
    for symbol, weight in targets.items():
        if weight > 0 and symbol not in held:
            denied = _policy_violation(symbol_policy, symbol, ZERO, weight)
            if denied:
                violations.append(denied)
        if weight > _decimal(limits["max_position_weight_pct"]):
            violation("max_position_weight", "目標權重超過單一標的上限", symbol)
    try:
        # Position-stop cooldowns block re-entry; the module is optional at import time.
        from .position_stops import cooldown_violations
        violations.extend(cooldown_violations(db, account_id, targets, held, as_of))
    except ImportError:
        pass
    notices = []
    try:
        # Corporate-action detection is a notice, never a violation: held symbols with events since entry need a look.
        from .corporate_actions import preview_notices
        notices.extend(preview_notices(db, account_id, held, as_of))
    except ImportError:
        pass
    try:
        # Regime overlay (block mode): total invested weight above the market-risk cap is a violation.
        from .regime_overlay import preview_violations
        violations.extend(preview_violations(db, account, targets, held, quotes, as_of))
    except ImportError:
        pass
    target_cash = HUNDRED - sum(targets.values(), ZERO)
    if target_cash < _decimal(limits["min_cash_weight_pct"]):
        violation("min_cash_weight", "目標剩餘現金低於最低現金比例")
    projected_cash = turnover = cash_weight = equity_after = None
    total_fees = total_slippage = ZERO
    if equity is not None and equity > 0:
        projected_cash = cash
        projected = {symbol: _decimal(row["shares"]) for symbol, row in held.items()}
        gross = ZERO
        share_step = Decimal(1).scaleb(-policy["share_precision"])
        fee_rate, slippage_rate = _decimal(policy["fee_bps"]) / 10000, _decimal(policy["slippage_bps"]) / 10000
        for symbol in required:
            price = _decimal(quotes[symbol]["price"])
            current = projected.get(symbol, ZERO)
            weight = targets.get(symbol, ZERO)
            desired = equity * weight / HUNDRED / price
            denied = _policy_violation(symbol_policy, symbol, current, desired)
            if denied and not any(item["code"] == "symbol_not_allowed" and item.get("symbol") == symbol for item in violations):
                violations.append(denied)
            requested_delta = desired - current
            if requested_delta == 0:
                continue
            quantity = abs(requested_delta).quantize(share_step, rounding=ROUND_DOWN)
            reference_notional = _money(quantity * price)
            skip_reason = "share_precision" if quantity == 0 else "min_trade_notional" if reference_notional < _decimal(policy["min_trade_notional"]) else "trade_below_precision" if reference_notional <= 0 else None
            if skip_reason:
                skipped.append({"symbol": symbol, "reason": skip_reason,
                                "requested_shares": float(abs(requested_delta)),
                                "reference_notional": float(reference_notional),
                                "message": {"share_precision": "股數低於設定精度，保留目前持倉",
                                            "min_trade_notional": "低於最小交易金額，保留目前持倉",
                                            "trade_below_precision": "金額低於模擬精度，保留目前持倉"}[skip_reason]})
                continue
            buying = requested_delta > 0
            delta = quantity if buying else -quantity
            fill_price = _money(price * (1 + slippage_rate if buying else 1 - slippage_rate))
            notional = _money(quantity * fill_price)
            fee = _money(notional * fee_rate)
            slippage = notional - reference_notional if buying else reference_notional - notional
            cash_delta = -(notional + fee) if buying else notional - fee
            projected_cash += cash_delta
            gross += reference_notional
            total_fees += fee
            total_slippage += slippage
            projected[symbol] = current + delta
            orders.append({"symbol": symbol, "side": "buy" if buying else "sell",
                           "shares": float(quantity), "shares_exact": str(quantity),
                           "reference_price": float(price), "fill_price": float(fill_price),
                           "fill_price_exact": str(fill_price), "reference_notional": float(reference_notional),
                           "notional": float(notional), "notional_exact": str(notional),
                           "fee": float(fee), "fee_exact": str(fee),
                           "slippage_cost": float(slippage), "slippage_cost_exact": str(slippage),
                           "cash_delta": float(cash_delta), "cash_delta_exact": str(cash_delta),
                           "current_shares": float(current), "target_shares": float(current + delta),
                           "target_weight_pct": float(weight), "projected_weight_pct": None})
        orders.sort(key=lambda order: (order["side"] != "sell", order["symbol"]))
        equity_after = projected_cash + sum((quantity * _decimal(quotes[symbol]["price"])
                                            for symbol, quantity in projected.items()), ZERO)
        turnover = gross / equity * HUNDRED
        cash_weight = projected_cash / equity_after * HUNDRED if equity_after > 0 else None
        for symbol, quantity in sorted(projected.items()):
            if quantity <= 0:
                continue
            value = quantity * _decimal(quotes[symbol]["price"])
            weight = value / equity_after * HUNDRED if equity_after > 0 else None
            projected_holdings.append({"symbol": symbol, "shares": float(quantity),
                                       "market_value": float(value), "weight_pct": float(weight) if weight is not None else None})
            if weight is not None and weight > _decimal(limits["max_position_weight_pct"]):
                if not any(item["code"] == "max_position_weight" and item.get("symbol") == symbol for item in violations):
                    violation("post_policy_max_position_weight", "執行政策後實際持倉權重超過上限", symbol)
        weights = {row["symbol"]: row["weight_pct"] for row in projected_holdings}
        for order in orders:
            order["projected_weight_pct"] = weights.get(order["symbol"], 0)
        if len(projected_holdings) > MAX_HOLDINGS:
            violation("holding_limit", "執行政策後持倉超過本版支援上限")
        if turnover > _decimal(limits["max_turnover_pct"]):
            violation("max_turnover", "買賣參考名目金額合計超過本次周轉率上限")
        if projected_cash < 0:
            violation("insufficient_cash", "模擬後現金不足，不支援融資或透支；未自動縮減委託")
        if equity_after <= 0:
            violation("nonpositive_equity", "扣費後虛擬帳戶淨值必須大於零")
        if cash_weight is not None and cash_weight < _decimal(limits["min_cash_weight_pct"]) and not any(item["code"] == "min_cash_weight" for item in violations):
            violation("min_cash_weight", "扣費與執行政策後現金低於最低現金比例")
    elif equity is not None:
        violation("nonpositive_equity", "虛擬帳戶淨值必須大於零")
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": revision,
            "account_id": account_id, "account_version": account["version"], "limits": limits,
            "execution_policy": policy,
            **({"symbol_policy": symbol_policy, "symbol_policy_method": SYMBOL_POLICY_METHOD} if _policy_active(symbol_policy) else {}),
            "targets": [target.model_dump() for target in body.targets], "rationale": body.rationale,
            "automation_source": body.automation_source.model_dump() if body.automation_source is not None else None,
            **({"local_agent_source": body.local_agent_source.model_dump()} if body.local_agent_source is not None else {}),
            **({"jev_source": body.jev_source.model_dump()} if body.jev_source is not None else {}),
            "coverage": {"required": len(required), "priced": len(required) - len(missing), "missing": missing},
            "quote_details": [{"symbol": symbol, **quotes[symbol]} for symbol in required],
            "valuation_complete": not missing, "equity_before": float(equity) if equity is not None else None,
            "cash_before": float(cash), "cash_after": float(projected_cash) if projected_cash is not None else None,
            "cash_after_exact": str(projected_cash) if projected_cash is not None else None,
            "equity_after": float(equity_after) if equity_after is not None else None,
            "cash_weight_after_pct": float(cash_weight) if cash_weight is not None else None,
            "turnover_pct": float(turnover) if turnover is not None else None,
            "fees_total": float(total_fees) if equity is not None else None,
            "slippage_total": float(total_slippage) if equity is not None else None,
            "cost_total": float(total_fees + total_slippage) if equity is not None else None,
            "orders": orders, "skipped_orders": skipped, "projected_holdings": projected_holdings,
            "violations": violations, "executable": not violations,
            "risk_direction": direction, "notices": notices,
            "method": METHOD, "warnings": WARNINGS}


@router.post("/api/paper/accounts/{account_id}/preview")
@store.snapshot_read
def preview(account_id: str, body: PreviewInput):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        return _build_preview(db, account_id, body, sessions.latest_completed_session())


@router.post("/api/paper/accounts/{account_id}/proposals")
def create_proposal(account_id: str, body: ProposalInput):
    return create_proposal_guarded(account_id, body)


def create_proposal_guarded(account_id: str, body: ProposalInput, guard=None):
    """Python-only automation hook; guard runs under the same write lock."""
    payload = body.model_dump(exclude={"idempotency_key"})
    # Preserve the pre-binding v2 request hash for ordinary/automation proposals.
    if body.local_agent_source is None:
        payload.pop("local_agent_source", None)
    if body.jev_source is None:
        payload.pop("jev_source", None)
    scope = f"proposal:{account_id}"
    with _write() as db:
        if guard is not None:
            guard(db)
        existing = _existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        result = _build_preview(db, account_id, body, sessions.latest_completed_session())
        proposal_id, now = uuid.uuid4().hex, store.now()
        status = "proposed" if result["executable"] else "blocked"
        db.execute("""INSERT INTO paper_proposals(id,account_id,status,preview_json,request_json,created_at)
            VALUES (?,?,?,?,?,?)""", (proposal_id, account_id, status, _json(result), _json(payload), now))
        response = {**result, "id": proposal_id, "status": status, "created_at": now, "accepted_at": None}
        response["provenance"] = provenance(response)
        _remember_request(db, scope, body.idempotency_key, payload, response)
        return response


def _get_proposal(db, account_id, proposal_id):
    row = db.execute("SELECT * FROM paper_proposals WHERE id=? AND account_id=?", (proposal_id, account_id)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到此帳戶的虛擬調倉提案")
    return dict(row)


@router.get("/api/paper/accounts/{account_id}/proposals/{proposal_id}")
@store.snapshot_read
def proposal_detail(account_id: str, proposal_id: str):
    with store.connect() as db:
        return _proposal(_get_proposal(db, account_id, proposal_id))


def _settle_orders(db, account, proposal_id, orders, cash_after_exact, now):
    """Price-model neutral atomic settlement; caller owns the write transaction."""
    account_id = account["id"]
    cash, realized = _decimal(account["cash"]), _decimal(account["realized_pnl"])
    for order in orders:
        symbol = order["symbol"]
        current = db.execute("SELECT * FROM paper_holdings WHERE account_id=? AND symbol=?", (account_id, symbol)).fetchone()
        quantity = _decimal(current["shares"]) if current else ZERO
        basis = _decimal(current["cost_basis"]) if current else ZERO
        delta = _decimal(order["shares_exact"]) * (1 if order["side"] == "buy" else -1)
        notional = _decimal(order["notional_exact"])
        fee = _decimal(order["fee_exact"])
        pnl = ZERO
        if delta < 0:
            removed_basis = basis if -delta == quantity else _money(basis * (-delta) / quantity)
            pnl = notional - fee - removed_basis
            basis -= removed_basis
            cash += notional - fee
            realized += pnl
        else:
            basis += notional + fee
            cash -= notional + fee
        quantity += delta
        if quantity < 0 or cash < 0:
            raise HTTPException(409, "模擬帳戶不足以完成提案；未寫入任何成交")
        if quantity == 0:
            db.execute("DELETE FROM paper_holdings WHERE account_id=? AND symbol=?", (account_id, symbol))
        else:
            db.execute("""INSERT INTO paper_holdings(account_id,symbol,shares,cost_basis) VALUES (?,?,?,?)
                ON CONFLICT(account_id,symbol) DO UPDATE SET shares=excluded.shares,cost_basis=excluded.cost_basis""",
                       (account_id, symbol, str(quantity), str(basis)))
        db.execute("""INSERT INTO paper_ledger
            (account_id,kind,symbol,shares_delta,price,cash_delta,cash_after,realized_pnl,proposal_id,created_at,fee,slippage_cost,reference_price)
            VALUES (?,'simulated_fill',?,?,?,?,?,?,?,?,?,?,?)""",
                   (account_id, symbol, str(delta), order["fill_price_exact"],
                    order["cash_delta_exact"], str(cash), str(pnl), proposal_id, now,
                    order["fee_exact"], order["slippage_cost_exact"], str(order["reference_price"])))
    if cash != _decimal(cash_after_exact):
        raise HTTPException(409, "模擬精度檢查未通過；未寫入任何成交")
    db.execute("UPDATE paper_accounts SET cash=?,realized_pnl=?,version=version+1,updated_at=? WHERE id=?",
               (str(cash), str(realized), now, account_id))


@router.post("/api/paper/accounts/{account_id}/proposals/{proposal_id}/accept")
def accept_proposal(account_id: str, proposal_id: str, body: AcceptInput):
    return accept_proposal_guarded(account_id, proposal_id, body)


def accept_proposal_guarded(account_id: str, proposal_id: str, body: AcceptInput, guard=None):
    """Python-only automation hook; the guard may reject but never execute fills."""
    scope = f"accept:{account_id}:{proposal_id}"
    payload = body.model_dump(exclude={"idempotency_key"})
    # Circuit breakers run in their own short transaction so an auto-pause persists
    # even though the fill below is refused; replays of finished accepts are skipped.
    from .circuit_breakers import guard_fill
    guard_fill(account_id, proposal_id, sessions.latest_completed_session(), trigger="accept")
    with _write() as db:
        if guard is not None:
            guard(db)
        existing = _existing_request(db, scope, body.idempotency_key, payload)
        if existing is not None:
            return existing
        account = _account(db, account_id)
        _version(account, body.expected_version)
        row = _get_proposal(db, account_id, proposal_id)
        original = json.loads(row["preview_json"])
        if account["kill_switch"] and not _reduce_only_exempt(db, account_id, original):
            raise HTTPException(409, _pause_refusal(db, account_id, original))
        if row["status"] != "proposed":
            raise HTTPException(409, "只有尚未接受且可執行的提案能模擬成交")
        as_of = sessions.latest_completed_session()
        if original["engine_version"] != ENGINE_VERSION:
            raise HTTPException(409, "調倉方法版本已更新，請重新建立提案")
        if original["as_of"] != as_of or original["input_revision"] != store.input_revision(db):
            raise HTTPException(409, "交易日或行情輸入已變更，請重新預覽與建立提案")
        if original["account_version"] != account["version"]:
            raise HTTPException(409, "提案建立後帳戶已變更，請重新建立提案")
        fresh = _build_preview(db, account_id, PreviewInput.model_validate_json(row["request_json"]), as_of)
        if not fresh["executable"] or _fingerprint(fresh) != _fingerprint(original):
            raise HTTPException(409, "提案驗算與預覽不符或限制未通過，請重新建立提案")
        now = store.now()
        _settle_orders(db, account, proposal_id, fresh["orders"], fresh["cash_after_exact"], now)
        db.execute("UPDATE paper_proposals SET status='simulated',accepted_at=? WHERE id=?", (now, proposal_id))
        response = {"proposal": _proposal(_get_proposal(db, account_id, proposal_id)), "account": _snapshot(db, account_id, as_of)}
        _remember_request(db, scope, body.idempotency_key, payload, response)
        return response


@router.post("/api/paper/accounts/{account_id}/proposals/{proposal_id}/reject")
def reject_proposal(account_id: str, proposal_id: str, body: RejectInput):
    with _write() as db:
        _version(_account(db, account_id), body.expected_version)
        row = _get_proposal(db, account_id, proposal_id)
        if row["status"] == "rejected":
            return _proposal(row)
        if row["status"] not in ("proposed", "blocked"):
            raise HTTPException(409, "已模擬成交的提案不可改為拒絕")
        db.execute("UPDATE paper_proposals SET status='rejected' WHERE id=?", (proposal_id,))
        return _proposal(_get_proposal(db, account_id, proposal_id))


@router.get("/api/paper/accounts/{account_id}/ledger")
@store.snapshot_read
def account_ledger(account_id: str, limit: Annotated[int, Query(ge=1, le=100)] = 100,
                   offset: Annotated[int, Query(ge=0, le=100_000)] = 0):
    with store.connect() as db:
        account = _account(db, account_id)
        count = db.execute("SELECT COUNT(*) FROM paper_ledger WHERE account_id=?", (account_id,)).fetchone()[0]
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db), "account_version": account["version"],
                "items": [_ledger(row) for row in db.execute(
                    "SELECT * FROM paper_ledger WHERE account_id=? ORDER BY id DESC LIMIT ? OFFSET ?", (account_id, limit, offset))],
                "total": count, "limit": limit, "offset": offset, "method": METHOD}
