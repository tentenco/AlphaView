"""Create an independent paper experiment from a current, fully valued paper account."""
import json
import uuid
from decimal import Decimal, localcontext

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-fork-v1"
METHOD = (
    "以完整當期報價建立獨立 paper 實驗分支，保留來源的虛擬現金與股數。"
    "每個起始部位按最新已完成交易日未調整收盤價重新建立成本基礎，部位金額各取八位；"
    "新初始資金＝原現金＋這些起始部位金額，已實現損益從零開始。"
    "opening_mark 是新實驗的開帳紀錄，不是買入成交，不收假設交易費。"
    "複製風險限制、執行設定與暫停開關；不複製過去損益、NAV、提案、自動化任務或待處理委託。"
    "來源帳戶不變；未來兩個帳戶各自演進，不能將新分支當作來源的歷史績效。"
)


class ForkPreviewInput(paper.StrictInput):
    expected_version: int = Field(ge=1, strict=True)


class ForkInput(ForkPreviewInput):
    name: str = Field(min_length=1, max_length=80)
    expected_source_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("請輸入實驗分支名稱")
        return value


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS paper_account_origins (
        account_id TEXT PRIMARY KEY, source_account_id TEXT NOT NULL,
        source_account_version INTEGER NOT NULL, source_input_revision TEXT NOT NULL,
        as_of TEXT NOT NULL, engine_version TEXT NOT NULL, source_digest TEXT NOT NULL,
        source_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES paper_accounts(id),
        FOREIGN KEY(source_account_id) REFERENCES paper_accounts(id)
    )""")


def _plan(db, account_id, expected_version):
    account = paper._account(db, account_id)
    paper._version(account, expected_version)
    as_of = sessions.latest_completed_session()
    valuation = paper._valuation(db, account, as_of)
    if not valuation["valuation_complete"]:
        raise HTTPException(422, "來源模擬帳戶缺少當期價格，無法建立一致的實驗起點")
    holdings = []
    stored_shares = {row["symbol"]: row["shares"] for row in paper._holdings(db, account_id)}
    initial_cash = Decimal(account["cash"])
    for row in sorted(valuation["holdings"], key=lambda item: item["symbol"]):
        shares = stored_shares[row["symbol"]]
        value = paper._money(Decimal(shares) * Decimal(str(row["price"])))
        initial_cash += value
        holdings.append({"symbol": row["symbol"], "shares": shares,
                         "reference_price": str(row["price"]), "opening_value": str(value)})
    if initial_cash <= 0 or initial_cash > Decimal("1000000000"):
        raise HTTPException(422, "實驗分支初始淨值必須大於零且不超過 10 億 USD")
    source = {"account_id": account_id, "account_name": account["name"], "account_version": account["version"],
              "input_revision": store.input_revision(db), "as_of": as_of, "paper_engine_version": paper.ENGINE_VERSION,
              "cash": account["cash"], "initial_cash": str(paper._money(initial_cash)), "holdings": holdings,
              "limits": json.loads(account["limits_json"]), "execution_policy": json.loads(account["execution_policy_json"]),
              "kill_switch": bool(account["kill_switch"])}
    symbol_policy = json.loads(account["symbol_policy_json"])
    if paper._policy_active(symbol_policy):
        source.update(symbol_policy=symbol_policy, symbol_policy_method=paper.SYMBOL_POLICY_METHOD)
    return {"engine_version": ENGINE_VERSION, "source": source, "source_digest": paper._hash(source),
            "as_of": as_of, "input_revision": source["input_revision"], "method": METHOD,
            "warnings": ["新的成本基礎與報酬起點不代表原部位實際買入成本。", "起始部位金額逐筆取八位小數，與即時計算的未取整估值可能有微小差異。"]}


@router.post("/api/paper/accounts/{account_id}/fork/preview")
@store.snapshot_read
def preview_fork(account_id: str, body: ForkPreviewInput):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        return _plan(db, account_id, body.expected_version)


@router.post("/api/paper/accounts/{account_id}/fork", status_code=201)
def create_fork(account_id: str, body: ForkInput):
    payload = body.model_dump()
    scope = f"fork:{account_id}"
    with paper._write() as db:
        previous = paper._existing_request(db, scope, body.idempotency_key, payload)
        if previous is not None:
            return previous
        plan = _plan(db, account_id, body.expected_version)
        if plan["source_digest"] != body.expected_source_digest:
            raise HTTPException(409, "來源帳戶、行情或交易日已改變；請重新預覽實驗起點")
        if db.execute("SELECT COUNT(*) FROM paper_accounts").fetchone()[0] >= paper.MAX_ACCOUNTS:
            raise HTTPException(422, "虛擬帳戶已達上限，無法新增分支")
        source = plan["source"]
        identifier, created = uuid.uuid4().hex, store.now()
        db.execute("""INSERT INTO paper_accounts(id,name,currency,initial_cash,cash,realized_pnl,version,kill_switch,
            limits_json,execution_policy_json,created_at,updated_at) VALUES (?,?,'USD',?,?,'0',1,?,?,?,?,?)""",
            (identifier, body.name, source["initial_cash"], source["cash"], int(source["kill_switch"]),
             paper._json(source["limits"]), paper._json(source["execution_policy"]), created, created))
        policy = source.get("symbol_policy", paper._initial_symbol_policy())
        paper._insert_symbol_policy(db, identifier,
            paper._initial_symbol_policy(paper.SymbolPolicy(mode=policy["mode"], symbols=policy["symbols"])), created)
        db.execute("""INSERT INTO paper_ledger(account_id,kind,cash_delta,cash_after,created_at)
            VALUES (?,'initial_cash',?,?,?)""", (identifier, source["initial_cash"],source["initial_cash"],created))
        balance = Decimal(source["initial_cash"])
        for holding in source["holdings"]:
            balance -= Decimal(holding["opening_value"])
            db.execute("INSERT INTO paper_holdings(account_id,symbol,shares,cost_basis) VALUES (?,?,?,?)",
                       (identifier,holding["symbol"],holding["shares"],holding["opening_value"]))
            db.execute("""INSERT INTO paper_ledger(account_id,kind,symbol,shares_delta,price,cash_delta,cash_after,reference_price,created_at)
                VALUES (?,'opening_mark',?,?,?,?,?,?,?)""", (identifier,holding["symbol"],holding["shares"],holding["reference_price"],
                str(-Decimal(holding["opening_value"])),str(paper._money(balance)),holding["reference_price"],created))
        if balance != Decimal(source["cash"]):
            raise HTTPException(409, "實驗分支開帳現金核對失敗")
        db.execute("""INSERT INTO paper_account_origins(account_id,source_account_id,source_account_version,source_input_revision,
            as_of,engine_version,source_digest,source_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
            (identifier,account_id,source["account_version"],source["input_revision"],source["as_of"],ENGINE_VERSION,
             plan["source_digest"],paper._json(source),created))
        response = {"engine_version": ENGINE_VERSION, "account": paper._snapshot(db,identifier,source["as_of"]),
                    "origin": plan, "method": METHOD}
        paper._remember_request(db, scope, body.idempotency_key, payload, response)
        return response


@router.get("/api/paper/accounts/{account_id}/origin")
@store.snapshot_read
def origin(account_id: str):
    with store.connect() as db:
        paper._account(db,account_id)
        row = db.execute("SELECT * FROM paper_account_origins WHERE account_id=?",(account_id,)).fetchone()
        return {"engine_version":ENGINE_VERSION,"origin":({key:row[key] for key in row.keys() if key!='source_json'} |
                {"source":json.loads(row["source_json"])}) if row else None,"method":METHOD}
