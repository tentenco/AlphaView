"""Preview and atomically merge portfolio CSV without deleting existing positions."""
import csv
from decimal import Decimal, InvalidOperation
import hashlib
import io
import json
import re
import sqlite3

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import store
from .jobs import RUN_LOCK

router = APIRouter()
FIELDS = ("name", "shares", "cost", "sector")
REQUIRED = {"symbol", "shares", "cost"}
OPTIONAL = {"name", "sector"}


class PreviewInput(BaseModel):
    csv_text: str = Field(max_length=300000)


class ImportInput(PreviewInput):
    expected_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def _decimal(raw, optional=False):
    text = raw.strip()
    if optional and not text:
        return None
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError("請填入有效數字，不可使用貨幣符號或千分位逗號") from exc
    if not number.is_finite() or not 0 <= number <= Decimal("1000000000"):
        raise ValueError("數值須為 0–1,000,000,000 的有限數字")
    converted = float(number)
    if number != 0 and converted == 0:
        raise ValueError("數值太小，無法在本地資料庫可靠表示")
    return converted


def _text(raw):
    # Undo the protective prefix emitted by our CSV exporter, never execute it.
    text = raw.strip()
    if len(text) > 1 and text[0] == "'" and text[1] in "=+-@\t\r":
        text = text[1:]
    return text


def _preview(csv_text, current):
    errors, warnings, rows = [], [], []
    existing = {row["symbol"]: row for row in current}
    seen = set()
    def error(row, field, message):
        errors.append({"row": row, "field": field, "message": message})
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff"), newline=""), strict=True)
    try:
        headers = reader.fieldnames
        if not headers:
            error(1, "header", "CSV 為空，請提供 symbol、shares、cost 標頭")
        else:
            headers = [header.strip().lower() for header in headers]
            reader.fieldnames = headers
            if len(set(headers)) != len(headers) or "" in headers:
                error(1, "header", "標頭不可重複或空白")
            missing = REQUIRED - set(headers)
            if missing:
                error(1, "header", "缺少必要欄位：" + ", ".join(sorted(missing)))
            ignored = set(headers) - REQUIRED - OPTIONAL
            if ignored:
                warnings.append("以下欄位不會匯入，報價與計算值仍由行情資料產生：" + ", ".join(sorted(ignored)))
            if not errors:
                for row_number, record in enumerate(reader, start=2):
                    if row_number > 101:
                        error(row_number, "rows", "每次最多匯入 100 檔，請縮減 CSV")
                        break
                    start_errors = len(errors)
                    if None in record or any(value is None for value in record.values()):
                        error(row_number, "columns", "欄位數與標頭不一致")
                        continue
                    symbol = record["symbol"].strip().upper()
                    if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", symbol):
                        error(row_number, "symbol", "股票代碼格式不正確")
                    if symbol in seen:
                        error(row_number, "symbol", "CSV 中股票代碼重複（不分大小寫）")
                    seen.add(symbol)
                    prior = existing.get(symbol)
                    after = {"name": prior["name"] if prior else symbol,
                             "sector": prior["sector"] if prior else "自訂清單"}
                    for field in ("shares", "cost"):
                        try:
                            after[field] = _decimal(record[field], optional=field == "cost")
                        except ValueError as exc:
                            error(row_number, field, str(exc))
                    if after.get("shares", 0) > 0 and after.get("cost") is None:
                        error(row_number, "cost", "持股數大於 0 時必須提供平均成本")
                    if "name" in headers:
                        after["name"] = _text(record["name"])
                        if not 1 <= len(after["name"]) <= 80:
                            error(row_number, "name", "名稱須為 1–80 個字元")
                    if "sector" in headers:
                        after["sector"] = _text(record["sector"])
                        if len(after["sector"]) > 50:
                            error(row_number, "sector", "產業欄位最多 50 個字元")
                    if len(errors) == start_errors:
                        before = {field: prior[field] for field in FIELDS} if prior else None
                        rows.append({"symbol": symbol, "action": "add" if prior is None else "unchanged" if before == after else "update",
                                     "before": before, "after": after})
    except csv.Error:
        error(reader.line_num or 1, "csv", "CSV 格式無法解析，請檢查引號與欄位分隔")
    if not errors and not rows:
        error(2, "rows", "CSV 沒有可匯入的資料列")
    if len(set(existing) | {row["symbol"] for row in rows}) > 100:
        error(0, "rows", "合併後清單超過 100 檔；未出現在 CSV 的既有標的不會刪除")
    counts = {action: sum(row["action"] == action for row in rows) for action in ("add", "update", "unchanged")}
    counts["total"] = len(rows)
    fingerprint = None
    if not errors:
        payload = {"version": 1, "positions": sorted(current, key=lambda row: row["symbol"]),
                   "input": [{"symbol": row["symbol"], **row["after"]} for row in rows]}
        fingerprint = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    return {"valid": not bool(errors), "errors": errors, "warnings": warnings, "rows": rows,
            "counts": counts, "fingerprint": fingerprint}


@router.post("/api/portfolio/import/preview")
def preview(body: PreviewInput):
    with store.connect() as db:
        current = [dict(row) for row in db.execute("SELECT * FROM positions ORDER BY symbol")]
    return _preview(body.csv_text, current)


@router.post("/api/portfolio/import")
def import_portfolio(body: ImportInput):
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "資料作業進行中，請完成後重新預覽匯入")
    try:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = [dict(row) for row in db.execute("SELECT * FROM positions ORDER BY symbol")]
            result = _preview(body.csv_text, current)
            if not result["valid"]:
                raise HTTPException(422, {"message": "CSV 驗證未通過，沒有匯入任何資料", "errors": result["errors"]})
            if result["fingerprint"] != body.expected_fingerprint:
                raise HTTPException(409, "持股或匯入內容已變更，請重新預覽後再確認匯入")
            timestamp = store.now()
            for row in result["rows"]:
                if row["action"] == "unchanged":
                    continue
                after = row["after"]
                db.execute("""INSERT INTO positions(symbol,name,shares,cost,sector,source,updated_at)
                    VALUES (?,?,?,?,?,'CSV 匯入',?) ON CONFLICT(symbol) DO UPDATE SET
                    name=excluded.name,shares=excluded.shares,cost=excluded.cost,
                    sector=excluded.sector,source=excluded.source,updated_at=excluded.updated_at""",
                    (row["symbol"], after["name"], after["shares"], after["cost"], after["sector"], timestamp))
            return {**result, "imported": {"added": result["counts"]["add"],
                                         "updated": result["counts"]["update"], "unchanged": result["counts"]["unchanged"]}}
    except sqlite3.Error as exc:
        raise HTTPException(500, "儲存匯入資料失敗，整批變更已回復；請重新預覽後重試") from exc
    finally:
        RUN_LOCK.release()
