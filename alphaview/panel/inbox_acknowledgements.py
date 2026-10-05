"""Versioned review receipts for derived inbox events; never resolve the underlying risk."""
import hashlib
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-inbox-acknowledgement-v1"
METHOD = (
    "已檢閱只記錄使用者已看過這份事件內容，不代表風險解除。"
    "事件的完整內容指紋與檢閱版本均需相符才可寫入；內容變更後自動顯示未檢閱。"
    "來源不可用不能標示已檢閱；嚴重度與需要處理總數不因檢閱而減少。"
    "此收據不更改帳戶、行情輸入版本、提案、委託或自動化授權。"
)


class AcknowledgementInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    event_key: str = Field(min_length=1, max_length=500)
    account_id: str = Field(min_length=1, max_length=100)
    acknowledged: bool
    expected_version: int = Field(ge=0)
    expected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS inbox_attention_receipts (
        event_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
        event_fingerprint TEXT NOT NULL CHECK(length(event_fingerprint)=64),
        acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),
        version INTEGER NOT NULL CHECK(version>=1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT
    )""")


def fingerprint(item):
    """Receipt metadata must never feed back into the stable actionable-event identity."""
    event = {key: value for key, value in item.items() if key not in ("event_fingerprint", "acknowledgement")}
    canonical = json.dumps({"engine_version": ENGINE_VERSION, "event": event},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _view(item, row):
    digest = fingerprint(item)
    can_acknowledge = bool(item.get("account_id")) and item["kind"] != "source_unavailable"
    matches = bool(row and row["event_fingerprint"] == digest and row["account_id"] == item.get("account_id"))
    acknowledged = bool(can_acknowledge and matches and row["acknowledged"])
    return {**item, "event_fingerprint": digest, "acknowledgement": {
        "engine_version": ENGINE_VERSION,
        "can_acknowledge": can_acknowledge,
        "acknowledged": acknowledged,
        "version": row["version"] if row else 0,
        "acknowledged_at": row["acknowledged_at"] if acknowledged else None,
        "updated_at": row["updated_at"] if row else None,
    }}


def attach_receipts(db, items):
    receipts = {row["event_key"]: row for row in db.execute("SELECT * FROM inbox_attention_receipts")}
    return [_view(item, receipts.get(item["key"])) for item in items]


def _conflict(code, message):
    return HTTPException(409, {"code": code, "message": message})


@router.post("/api/portfolio-agent/inbox/attention/acknowledgement")
def acknowledge(body: AcknowledgementInput):
    from . import portfolio_inbox

    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        as_of = sessions.latest_completed_session()
        # Derive again under the writer lock, using this connection for every source.
        items = portfolio_inbox.current_attention(db, as_of)
        item = next((value for value in items if value["key"] == body.event_key), None)
        if item is None:
            raise _conflict("attention_changed", "事項已變更或不再存在，請重新整理待辦")
        if item["kind"] == "source_unavailable":
            raise _conflict("attention_source_unavailable", "來源不可用不能標示已檢閱，請先恢復來源")
        if item.get("account_id") != body.account_id:
            raise _conflict("attention_account_changed", "事項所屬帳戶不符，請重新整理待辦")
        digest = fingerprint(item)
        if digest != body.expected_fingerprint:
            raise _conflict("attention_changed", "事項內容已變更，請重新檢閱最新內容")
        row = db.execute("SELECT * FROM inbox_attention_receipts WHERE event_key=?", (body.event_key,)).fetchone()
        version = row["version"] if row else 0
        if version != body.expected_version or (row and row["account_id"] != body.account_id):
            raise _conflict("attention_review_changed", "檢閱狀態已在其他視窗更新，請重新整理待辦")
        unchanged = (not row and not body.acknowledged) or (
            row and row["event_fingerprint"] == digest and bool(row["acknowledged"]) == body.acknowledged)
        if not unchanged:
            now = store.now()
            db.execute("""INSERT INTO inbox_attention_receipts
                (event_key,account_id,event_fingerprint,acknowledged,version,created_at,updated_at,acknowledged_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(event_key) DO UPDATE SET event_fingerprint=excluded.event_fingerprint,
                    acknowledged=excluded.acknowledged,version=excluded.version,
                    updated_at=excluded.updated_at,acknowledged_at=excluded.acknowledged_at""",
                       (body.event_key, body.account_id, digest, int(body.acknowledged), version + 1,
                        now, now, now if body.acknowledged else None))
            row = db.execute("SELECT * FROM inbox_attention_receipts WHERE event_key=?", (body.event_key,)).fetchone()
        return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
                "changed": not unchanged, "event": _view(item, row), "method": METHOD}
