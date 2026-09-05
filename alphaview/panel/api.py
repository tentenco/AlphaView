import asyncio
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

from . import market, research, store, quality, changes, charting, quotes, scan_context, scheduler, sessions
from .jobs import RUN_LOCK, recover_interrupted_locked, router as jobs_router
from .portfolio_transfer import router as portfolio_transfer_router
from .backups import router as backups_router
from .risk import router as risk_router
from .storage_maintenance import router as storage_router


@asynccontextmanager
async def lifespan(app):
    store.init_db()
    if RUN_LOCK.acquire(blocking=False):
        try:
            with store.connect() as db:
                recover_interrupted_locked(db)
        finally:
            RUN_LOCK.release()
    local_schedule = scheduler.Scheduler().start()
    try:
        yield
    finally:
        await asyncio.to_thread(local_schedule.stop)


app = FastAPI(title="AlphaView Research Panel", lifespan=lifespan)
app.include_router(jobs_router)
app.include_router(portfolio_transfer_router)
app.include_router(backups_router)
app.include_router(scheduler.router)
app.include_router(risk_router)
app.include_router(storage_router)
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
    expected_updated_at: str | None = Field(default=None, max_length=80)

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


@store.snapshot_read
def enriched_positions(expected_session=None):
    expected_session = expected_session or sessions.latest_completed_session()
    scan = store.latest_scan()
    signals = {r["symbol"]: r for r in scan["result"]} if scan else {}
    datasets = {r["symbol"]: r for r in store.dataset_rows()}
    result = []
    for pos in store.positions():
        frame = store.history(pos["symbol"])
        result.append({**pos, **quotes.valuation(frame, pos["shares"], pos["cost"], expected_session),
            "dataset": datasets.get(pos["symbol"]), "research": signals.get(pos["symbol"])})
    scale = max((p["market_value"] or 0 for p in result), default=0)
    scaled_total = sum((p["market_value"] or 0) / scale for p in result) if scale else 0
    for p in result:
        p["weight"] = None if p["shares"] > 0 and p["market_value"] is None else (
            ((p["market_value"] or 0) / scale) / scaled_total * 100 if scaled_total else 0)
    return result


@app.get("/api/overview")
@store.snapshot_read
def overview():
    expected_session = sessions.latest_completed_session()
    items = enriched_positions(expected_session)
    holdings = [p for p in items if p["shares"] > 0]
    valued = [p for p in holdings if p["market_value"] is not None]
    stale_count = sum(p["quote_status"] == "stale" for p in holdings)
    pnl_valued = [p for p in valued if p["pnl"] is not None and p["cost_value"] is not None]
    total = quotes.total(p["market_value"] for p in valued) if valued or not holdings else None
    pnl = quotes.total(p["pnl"] for p in pnl_valued) if pnl_valued or not holdings else None
    cost = quotes.total(p["cost_value"] for p in pnl_valued)
    dates = sorted({p["price_date"] for p in valued if p["price_date"]})
    day_components = [quotes.finite(p["change"] * p["shares"]) for p in valued
                      if p["change"] is not None and p["change_pct"] is not None]
    day_components = [component for component in day_components if component is not None]
    day_partial = len(day_components) != len(holdings) or len(dates) > 1
    daily_change = quotes.total(day_components) if not day_partial else None
    day_partial = day_partial or daily_change is None
    previous_total = quotes.finite(total - daily_change) if total is not None and daily_change is not None else None
    recent = store.latest_scan()
    market_members = store.universe("market")
    with store.connect() as db:
        scans = [dict(r) for r in db.execute("SELECT as_of,MAX(created_at) AS created_at FROM scans WHERE scope='portfolio' GROUP BY as_of ORDER BY as_of DESC LIMIT 60")]
        market_dates = [dict(r) for r in db.execute("SELECT as_of,MAX(created_at) AS created_at FROM scans WHERE scope='market' GROUP BY as_of ORDER BY as_of DESC LIMIT 60")]
        # Polling needs public job state, not the potentially large stored result payload.
        jobs = [dict(r) for r in db.execute("SELECT id,kind,status,started_at,finished_at,progress,error,scope,cancel_requested FROM jobs ORDER BY started_at DESC LIMIT 10")]
    matched = [r for r in recent["result"] if any(s["matched"] for s in r["signals"])] if recent else []
    return {"positions": items, "summary": {"market_value": total, "pnl": pnl,
        "pnl_pct": quotes.finite(pnl / cost * 100) if pnl is not None and cost else None,
        "day_change": daily_change,
        "day_change_pct": quotes.finite(daily_change / previous_total * 100) if daily_change is not None and previous_total else None,
        "day_change_partial": day_partial, "day_change_covered_count": len(day_components),
        "holding_count": sum(p["shares"] > 0 for p in items), "watch_count": sum(p["shares"] == 0 for p in items),
        "priced_count": len(valued), "stale_count": stale_count,
        "current_priced_count": sum(p["price_date"] == expected_session for p in valued),
        "expected_session": expected_session, "dates": dates, "matched_count": len(matched),
        "partial": bool(stale_count) or len(valued) < len(holdings) or len(pnl_valued) < len(holdings) or total is None or pnl is None,
        "mixed_dates": len(dates) > 1},
        "scan": scan_context.decorate(recent, items), "scan_dates": scans, "strategies": research.STRATEGIES,
        "market_scan": scan_context.decorate(store.latest_scan(scope="market"), market_members), "market_scan_dates": market_dates,
        "market_universe": market_members,
        "market_universe_meta": market.universe_metadata(),
        "datasets": store.dataset_rows(), "jobs": jobs, "server_time": store.now()}


@app.get("/api/scans")
@store.snapshot_read
def scan_result(as_of: date | None = None, scope: Literal["portfolio", "market"] = "portfolio"):
    result = store.latest_scan(str(as_of) if as_of else None, scope=scope)
    if not result:
        raise HTTPException(404, "這個日期尚無選股紀錄")
    return scan_context.decorate(result)


@app.get("/api/stocks/{symbol}")
@store.snapshot_read
def stock(symbol: str, scope: Literal["portfolio", "market"] = "portfolio", as_of: date | None = None):
    expected_session = sessions.latest_completed_session()
    if as_of:
        if as_of > date.today():
            raise HTTPException(422, "所選日期尚未到來，請選擇已完成交易日")
        from datetime import timedelta
        try:
            candidates = sessions.expected_sessions((as_of - timedelta(days=14)).isoformat(), as_of.isoformat())
            selected_session = candidates[-1]
        except (ValueError, OverflowError, IndexError) as exc:
            raise HTTPException(422, "所選日期超出可用交易日曆範圍") from exc
        if selected_session > expected_session:
            raise HTTPException(422, "所選交易日尚未收盤，請選擇已完成交易日")
        expected_session = selected_session
    pos = next((p for p in enriched_positions() if p["symbol"] == symbol), None)
    member = next((p for p in store.universe("market") if p["symbol"] == symbol), None)
    snapshot = store.latest_scan(expected_session if as_of else None, scope=scope)
    row = next((r for r in snapshot["result"] if r["symbol"] == symbol), None) if snapshot else None
    if not pos and not member and not row:
        raise HTTPException(404, "找不到標的")
    raw = store.history(symbol)
    if as_of:
        raw = raw[raw.date <= expected_session]
    if not pos:
        pos = {"symbol": symbol, "name": (member or row)["name"], "shares": 0, "cost": None,
               "snapshot_price": None, "sector": "市場候選", "source": "市場選股",
               "dataset": next((r for r in store.dataset_rows() if r["symbol"] == symbol), None)}
    pos.update({"research": row, **quotes.valuation(raw, pos["shares"], pos["cost"], expected_session),
                "valuation_basis": "目前股數與成本 × 所選日期收盤價，並非歷史持倉" if as_of else "目前持股與最新收盤價"})
    # Current allocation cannot be represented as a historical portfolio weight.
    if as_of:
        pos["weight"] = None
    return {"position": pos, **charting.history(raw[raw.date <= expected_session]), "strategies": research.STRATEGIES}


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
            db.execute("BEGIN IMMEDIATE")
            exists = db.execute("SELECT updated_at FROM positions WHERE symbol=?", (symbol,)).fetchone()
            if "expected_updated_at" in body.model_fields_set:
                current_version = exists["updated_at"] if exists else None
                if current_version != body.expected_updated_at:
                    raise HTTPException(409, "此標的已在其他視窗或匯入作業中修改；請關閉編輯並重新開啟，核對最新資料後再儲存")
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
