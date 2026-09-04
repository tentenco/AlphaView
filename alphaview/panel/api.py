import csv
import io
import json
from contextlib import asynccontextmanager
from datetime import date
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import market, research, store, quality, changes
from .jobs import RUN_LOCK, router as jobs_router


@asynccontextmanager
async def lifespan(app):
    store.init_db()
    if RUN_LOCK.acquire(blocking=False):
        try:
            with store.connect() as db:
                db.execute("UPDATE jobs SET status='interrupted',finished_at=?,error='伺服器重啟，請重新執行' WHERE status='running'", (store.now(),))
        finally:
            RUN_LOCK.release()
    yield


app = FastAPI(title="AlphaView Research Panel", lifespan=lifespan)
app.include_router(jobs_router)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


@app.middleware("http")
async def local_writes(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        allowed = {str(request.base_url).rstrip("/"), "http://127.0.0.1:5173", "http://localhost:5173"}
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin not in allowed):
            return JSONResponse({"detail": "不允許跨站寫入"}, status_code=403)
    return await call_next(request)


class PositionInput(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    name: str = Field(min_length=1, max_length=80)
    shares: float = Field(ge=0, le=1e9, allow_inf_nan=False)
    cost: float | None = Field(default=None, ge=0, le=1e9, allow_inf_nan=False)
    sector: str = Field(default="自訂清單", max_length=50)

    @model_validator(mode="after")
    def requires_cost(self):
        if self.shares > 0 and self.cost is None:
            raise ValueError("持股數大於 0 時，請填入平均成本")
        return self


class BacktestInput(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    strategy: str = Field(pattern="^(turtle|trend|pullback)$")
    initial: float = Field(default=10000, gt=0, le=1e12, allow_inf_nan=False)
    fee_bps: float = Field(default=10, ge=0, le=100, allow_inf_nan=False)
    start_date: date | None = None
    end_date: date | None = None


def enriched_positions():
    scan = store.latest_scan()
    signals = {r["symbol"]: r for r in scan["result"]} if scan else {}
    datasets = {r["symbol"]: r for r in store.dataset_rows()}
    result = []
    for pos in store.positions():
        frame = store.history(pos["symbol"])
        last = frame.iloc[-1] if len(frame) else None
        prev = frame.iloc[-2] if len(frame) > 1 else None
        price = float(last.close) if last is not None else None
        change = price - float(prev.close) if prev is not None else None
        value = price * pos["shares"] if price is not None else None
        cost_value = pos["shares"] * pos["cost"] if pos["cost"] is not None else None
        pnl = value - cost_value if value is not None and cost_value is not None and pos["shares"] > 0 else None
        result.append({**pos, "price": price, "change": change,
            "change_pct": change / float(prev.close) * 100 if prev is not None else None,
            "market_value": value, "cost_value": cost_value, "pnl": pnl,
            "pnl_pct": pnl / cost_value * 100 if pnl is not None and cost_value else None,
            "price_date": last.date if last is not None else None,
            "sparkline": [{"date": r.date, "close": float(r.close)} for r in frame.tail(30).itertuples()],
            "dataset": datasets.get(pos["symbol"]), "research": signals.get(pos["symbol"])})
    total = sum(p["market_value"] or 0 for p in result)
    for p in result:
        p["weight"] = (p["market_value"] or 0) / total * 100 if total else 0
    return result


@app.get("/api/overview")
def overview():
    items = enriched_positions()
    valued = [p for p in items if p["shares"] > 0 and p["price"] is not None]
    total = sum(p["market_value"] for p in valued)
    pnl = sum(p["pnl"] or 0 for p in valued)
    cost = sum(p["cost_value"] or 0 for p in valued)
    changes = sum((p["change"] or 0) * p["shares"] for p in valued)
    dates = sorted({p["price_date"] for p in valued if p["price_date"]})
    recent = store.latest_scan()
    with store.connect() as db:
        scans = [dict(r) for r in db.execute("SELECT as_of,MAX(created_at) AS created_at FROM scans WHERE scope='portfolio' GROUP BY as_of ORDER BY as_of DESC LIMIT 60")]
        market_dates = [dict(r) for r in db.execute("SELECT as_of,MAX(created_at) AS created_at FROM scans WHERE scope='market' GROUP BY as_of ORDER BY as_of DESC LIMIT 60")]
        jobs = [dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY started_at DESC LIMIT 10")]
    matched = [r for r in recent["result"] if any(s["matched"] for s in r["signals"])] if recent else []
    return {"positions": items, "summary": {"market_value": total, "pnl": pnl,
        "pnl_pct": pnl / cost * 100 if cost else None, "day_change": changes,
        "day_change_pct": changes / (total - changes) * 100 if total - changes else None,
        "holding_count": sum(p["shares"] > 0 for p in items), "watch_count": sum(p["shares"] == 0 for p in items),
        "priced_count": len(valued), "dates": dates, "matched_count": len(matched),
        "partial": len(valued) < sum(p["shares"] > 0 for p in items), "mixed_dates": len(dates) > 1},
        "scan": recent, "scan_dates": scans, "strategies": research.STRATEGIES,
        "market_scan": store.latest_scan(scope="market"), "market_scan_dates": market_dates,
        "market_universe": store.universe("market"),
        "datasets": store.dataset_rows(), "jobs": jobs, "server_time": store.now()}


@app.get("/api/scans")
def scan_result(as_of: date | None = None, scope: Literal["portfolio", "market"] = "portfolio"):
    result = store.latest_scan(str(as_of) if as_of else None, scope=scope)
    if not result:
        raise HTTPException(404, "這個日期尚無選股紀錄")
    return result


@app.get("/api/stocks/{symbol}")
def stock(symbol: str, scope: Literal["portfolio", "market"] = "portfolio", as_of: date | None = None):
    pos = next((p for p in enriched_positions() if p["symbol"] == symbol), None)
    member = next((p for p in store.universe("market") if p["symbol"] == symbol), None)
    snapshot = store.latest_scan(str(as_of) if as_of else None, scope=scope)
    row = next((r for r in snapshot["result"] if r["symbol"] == symbol), None) if snapshot else None
    if not pos and not member and not row:
        raise HTTPException(404, "找不到標的")
    raw = store.history(symbol)
    if as_of:
        raw = raw[raw.date <= str(as_of)]
    last = raw.iloc[-1] if len(raw) else None
    prev = raw.iloc[-2] if len(raw) > 1 else None
    if not pos:
        pos = {"symbol": symbol, "name": (member or row)["name"], "shares": 0, "cost": None,
               "snapshot_price": None, "sector": "市場候選", "source": "市場選股",
               "dataset": next((r for r in store.dataset_rows() if r["symbol"] == symbol), None)}
    price = float(last.close) if last is not None else None
    change = price - float(prev.close) if prev is not None else None
    value = price * pos["shares"] if price is not None else None
    cost_value = pos["shares"] * pos["cost"] if pos["cost"] is not None else None
    pnl = value - cost_value if value is not None and cost_value is not None and pos["shares"] > 0 else None
    pos.update({"research": row, "price": price, "change": change,
                "price_date": last.date if last is not None else None,
                "change_pct": change / float(prev.close) * 100 if prev is not None and prev.close else None,
                "market_value": value, "cost_value": cost_value, "pnl": pnl,
                "pnl_pct": pnl / cost_value * 100 if pnl is not None and cost_value else None,
                "sparkline": [{"date": r.date, "close": float(r.close)} for r in raw.tail(30).itertuples()],
                "valuation_basis": "目前股數與成本 × 所選日期收盤價，並非歷史持倉" if as_of else "目前持股與最新收盤價"})
    # Current allocation cannot be represented as a historical portfolio weight.
    if as_of:
        pos["weight"] = None
    df = research.indicators(raw)
    price_history = [{"date": r.date, **{k: research.finite(getattr(r, k)) for k in
                     ("close", "ma20", "ma50", "ma200", "rsi", "volume")}} for r in df.itertuples()]
    return {"position": pos, "history": price_history, "strategies": research.STRATEGIES}


@app.post("/api/watchlist/{symbol}")
def add_candidate(symbol: str):
    member = next((p for p in store.universe("market") if p["symbol"] == symbol), None)
    if not member:
        raise HTTPException(404, "此股票不在目前市場候選清單")
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "掃描進行中，完成後即可加入觀察名單")
    try:
        with store.connect() as db:
            existing = db.execute("SELECT 1 FROM positions WHERE symbol=?", (symbol,)).fetchone()
            if not existing and db.execute("SELECT COUNT(*) FROM positions").fetchone()[0] >= 100:
                raise HTTPException(400, "本地清單上限為 100 檔")
            db.execute("""INSERT OR IGNORE INTO positions(symbol,name,shares,cost,sector,source,updated_at)
                        VALUES (?,?,0,NULL,'市場候選','市場選股加入',?)""", (symbol, member["name"], store.now()))
    finally:
        RUN_LOCK.release()
    return {"symbol": symbol, "added": not bool(existing)}


@app.put("/api/positions/{symbol}")
def save_position(symbol: str, body: PositionInput):
    if symbol != body.symbol:
        raise HTTPException(400, "股票代碼不一致")
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "資料作業進行中，完成後即可編輯持股")
    try:
        with store.connect() as db:
            exists = db.execute("SELECT 1 FROM positions WHERE symbol=?", (symbol,)).fetchone()
            if not exists and db.execute("SELECT COUNT(*) FROM positions").fetchone()[0] >= 100:
                raise HTTPException(400, "本地清單上限為 100 檔")
            db.execute("""INSERT INTO positions(symbol,name,shares,cost,sector,source,updated_at)
                VALUES (?,?,?,?,?,'使用者編輯',?) ON CONFLICT(symbol) DO UPDATE SET
                name=excluded.name,shares=excluded.shares,cost=excluded.cost,sector=excluded.sector,
                source=excluded.source,updated_at=excluded.updated_at""",
                (symbol, body.name, body.shares, body.cost, body.sector, store.now()))
    finally:
        RUN_LOCK.release()
    return {"ok": True, "symbol": symbol}


@app.post("/api/backtest")
def run_backtest(body: BacktestInput):
    try:
        result = research.backtest(body.symbol, body.strategy, initial=body.initial, fee_bps=body.fee_bps,
            start_date=str(body.start_date) if body.start_date else None,
            end_date=str(body.end_date) if body.end_date else None)
        result["created_at"] = store.now()
        with store.connect() as db:
            db.execute("INSERT INTO backtests(created_at,symbol,strategy,result) VALUES (?,?,?,?)",
                       (result["created_at"], body.symbol, body.strategy, json.dumps(result, ensure_ascii=False)))
        return result
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/backtest/{symbol}/{strategy}")
def saved_backtest(symbol: str, strategy: str, initial: float = 10000, fee_bps: float = 10,
                   start_date: date | None = None, end_date: date | None = None):
    parameters = {"initial": initial, "fee_bps": fee_bps,
                  "start_date": str(start_date) if start_date else None,
                  "end_date": str(end_date) if end_date else None}
    with store.connect() as db:
        rows = db.execute("SELECT result FROM backtests WHERE symbol=? AND strategy=? ORDER BY id DESC",
                          (symbol, strategy)).fetchall()
    for row in rows:
        result = json.loads(row["result"])
        saved = result.get("parameters", {"initial": 10000, "fee_bps": 10, "start_date": None, "end_date": None})
        if any(saved.get(k) != value for k, value in parameters.items()):
            continue
        try:
            current = research.backtest_input_fingerprint(symbol, strategy, **parameters)
            result["cache_stale"] = current != result.get("input_fingerprint")
        except ValueError:
            result["cache_stale"] = True
        return result
    return None


@app.get("/api/export")
def export_portfolio():
    stream = io.StringIO()
    columns = ["symbol", "name", "shares", "cost", "price", "price_date", "market_value", "pnl", "pnl_pct", "source"]
    writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in enriched_positions():
        safe = {k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v)
                for k, v in row.items()}
        writer.writerow(safe)
    return Response("\ufeff" + stream.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="alphaview-portfolio.csv"'})



class NoteInput(BaseModel):
    note: str = Field(default="", max_length=6000)
    tags: list[str] = Field(default_factory=list, max_length=5)
    version: int = Field(ge=0)

    @model_validator(mode="after")
    def clean_tags(self):
        tags = list(dict.fromkeys(tag.strip() for tag in self.tags if tag.strip()))
        if any(len(tag) > 24 for tag in tags):
            raise ValueError("每個標籤最多 24 個字元")
        self.tags = tags
        return self


def known_symbol(symbol):
    return any(p["symbol"] == symbol for p in [*store.positions(), *store.universe("market"), *store.dataset_rows()])


@app.get("/api/notes/{symbol}")
def read_note(symbol: str):
    if not known_symbol(symbol):
        raise HTTPException(404, "找不到研究標的")
    with store.connect() as db:
        row = db.execute("SELECT * FROM research_notes WHERE symbol=?", (symbol,)).fetchone()
    return {**dict(row), "tags": json.loads(row["tags"])} if row else {
        "symbol": symbol, "note": "", "tags": [], "version": 0, "updated_at": None}


@app.put("/api/notes/{symbol}")
def save_note(symbol: str, body: NoteInput):
    if not known_symbol(symbol):
        raise HTTPException(404, "找不到研究標的")
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT version FROM research_notes WHERE symbol=?", (symbol,)).fetchone()
        version = existing["version"] if existing else 0
        if version != body.version:
            raise HTTPException(409, "筆記已在其他視窗更新；請先重新載入再合併你的修改")
        updated = store.now()
        db.execute("""INSERT INTO research_notes(symbol,note,tags,version,updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(symbol) DO UPDATE SET note=excluded.note,tags=excluded.tags,
            version=excluded.version,updated_at=excluded.updated_at""",
            (symbol, body.note, json.dumps(body.tags, ensure_ascii=False), version + 1, updated))
    return {"symbol": symbol, "note": body.note, "tags": body.tags, "version": version + 1, "updated_at": updated}


@app.get("/api/signal-changes")
def signal_changes(scope: Literal["portfolio", "market"] = "market", as_of: date | None = None):
    return changes.report(scope, str(as_of) if as_of else None)


@app.get("/api/data-quality")
def data_quality():
    return quality.report()


@app.get("/api/health")
def health():
    return {"status": "ok", "mode": "local", "database": store.db_path().name}


DIST = store.ROOT / "web/dist"
if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{path:path}")
def frontend(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "API 不存在")
    if not (DIST / "index.html").exists():
        raise HTTPException(503, "請先執行 cd web && npm run build")
    return FileResponse(DIST / "index.html")
