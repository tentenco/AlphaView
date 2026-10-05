"""User-requested local exports of paper accounts and immutable proposal receipts."""
import csv
import hashlib
import io
import json
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-export-v1"
MAX_EXPORT_ROWS = 50_000
MAX_EXPORT_PROPOSALS = 5_000
METHOD = (
    "唯讀匯出單一虛擬帳戶的一致資料庫快照；只包含 paper 帳戶，不讀取真實持股或研究筆記。"
    "數值結算字串按儲存值保留。JSON SHA-256 用於檔案完整性核對，不是簽章或真實成交證明。"
    "CSV 金額為原始十進位文字；可能被試算表解讀為公式的文字會加前置單引號。"
)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _attachment(payload, filename):
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    return Response(encoded, media_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
    })


def _receipt(db, account_id, proposal_id):
    row = paper._get_proposal(db, account_id, proposal_id)
    fills = [dict(item) for item in db.execute(
        "SELECT * FROM paper_ledger WHERE account_id=? AND proposal_id=? ORDER BY id",
        (account_id, proposal_id),
    )]
    return {"proposal": paper._proposal(row), "original_request": json.loads(row["request_json"]),
            "ledger_entries": fills, "executed_in_paper": row["status"] == "simulated",
            "live_order": False}


def _envelope(content, revision, as_of):
    return {"format_version": 1, "engine_version": ENGINE_VERSION, "exported_at": store.now(),
            "as_of": as_of, "input_revision": revision, "scope": "paper_account_only",
            "contains_private_paper_data": True, "content": content,
            "content_sha256": hashlib.sha256(_canonical(content).encode()).hexdigest(),
            "hash_method": "SHA-256 of content encoded as UTF-8 JSON, sorted keys, compact separators, ensure_ascii=false",
            "method": METHOD}


@router.get("/api/paper/accounts/{account_id}/proposals/{proposal_id}/receipt")
@store.snapshot_read
def proposal_receipt(account_id: str, proposal_id: str):
    with store.connect() as db:
        paper._account(db, account_id)
        content = _receipt(db, account_id, proposal_id)
        result = _envelope(content, store.input_revision(db), sessions.latest_completed_session())
    return _attachment(result, "alphaview-paper-proposal-receipt.json")


def _spreadsheet_text(value):
    if value is None:
        return ""
    text = str(value)
    if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")):
        return "'" + text
    return text


@router.get("/api/paper/accounts/{account_id}/export")
@store.snapshot_read
def export_account(account_id: str, format: Literal["json", "csv"] = "json"):
    with store.connect() as db:
        account = paper._account(db, account_id)
        count = db.execute("SELECT count(*) FROM paper_ledger WHERE account_id=?", (account_id,)).fetchone()[0]
        if count > MAX_EXPORT_ROWS:
            raise HTTPException(422, "帳本超過本版單次匯出 50,000 筆上限；未匯出部分資料")
        rows = [dict(row) for row in db.execute("SELECT * FROM paper_ledger WHERE account_id=? ORDER BY id", (account_id,))]
        revision, as_of = store.input_revision(db), sessions.latest_completed_session()
        if format == "csv":
            output = io.StringIO(newline="")
            writer = csv.writer(output)
            writer.writerow(["export_method", "valuation_as_of", "input_revision", "account_name", "ledger_id",
                             "created_at", "kind", "symbol", "shares_delta", "reference_price", "fill_price",
                             "fee", "slippage_cost", "cash_delta", "cash_after", "realized_pnl", "proposal_id"])
            for row in rows:
                # Numeric fields come from exact decimal storage, never user text.
                writer.writerow([ENGINE_VERSION, as_of, revision, _spreadsheet_text(account["name"]), row["id"],
                                 row["created_at"], _spreadsheet_text(row["kind"]), _spreadsheet_text(row["symbol"]),
                                 row["shares_delta"], row["reference_price"], row["price"], row["fee"],
                                 row["slippage_cost"], row["cash_delta"], row["cash_after"], row["realized_pnl"],
                                 row["proposal_id"]])
            return Response("\ufeff" + output.getvalue(), media_type="text/csv; charset=utf-8", headers={
                "Content-Disposition": 'attachment; filename="alphaview-paper-ledger.csv"', "Cache-Control": "no-store",
            })
        proposal_count = db.execute("SELECT count(*) FROM paper_proposals WHERE account_id=?", (account_id,)).fetchone()[0]
        if proposal_count > MAX_EXPORT_PROPOSALS:
            raise HTTPException(422, "提案超過本版單次匯出 5,000 筆上限；未匯出部分資料")
        proposal_rows = db.execute("SELECT * FROM paper_proposals WHERE account_id=? ORDER BY created_at,id", (account_id,)).fetchall()
        content = {"account": paper._public_account(account), "paper_engine_version": paper.ENGINE_VERSION,
                   "current_valuation": paper._valuation(db, account, as_of), "ledger_entries": rows,
                   "ledger_count": count, "proposals": [paper._proposal(row) for row in proposal_rows],
                   "proposal_count": proposal_count, "complete": True,
                   "limitations": "Paper account export only; not a full workspace backup, broker statement, or import file."}
        result = _envelope(content, revision, as_of)
    return _attachment(result, "alphaview-paper-account.json")
