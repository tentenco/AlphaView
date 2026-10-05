"""Immutable observed paper-account NAV; never reconstruct history from holdings."""
import json
from datetime import date
from decimal import Decimal, localcontext
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from . import paper_metrics, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-analytics-v1"
METHOD = (
    "淨值僅來自顯式擷取當時的虛擬帳戶與本機已完成交易日未調整收盤價，不從目前持倉倒推歷史。"
    "每筆觀測不可覆寫；每日序列採該日最後擷取，未擷取或缺價留空。"
    "日報酬僅連接相鄰且皆完整的 XNYS 交易日；觀察區間有缺口時，不計區間報酬或最大回落。"
    "最大回落為完整每日觀測淨值相對此前觀測最高淨值的最大跌幅（非負百分比），不包含盤中路徑。"
    "帳戶只有初始虛擬現金、沒有後續外部資金流；目前累積報酬為目前完整淨值／初始現金−1。"
    "周轉率總和是各已接受提案的買賣參考金額／各次模擬前淨值之和，並非年化周轉率。"
)
WARNINGS = [
    "這是虛擬帳戶的已擷取觀測，不是完整歷史回測或真實帳戶績效。",
    "費用與滑價依模擬設定；沒有稅、股息及拆併股自動調整。",
    "同日有多次擷取時，每日序列採最後一筆；舊觀測仍保留在快照清單。",
]


class CaptureInput(paper.StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    expected_input_revision: str | None = Field(default=None, min_length=1, max_length=100)


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS paper_nav_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
        as_of TEXT NOT NULL, account_version INTEGER NOT NULL, input_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL, observed_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        UNIQUE(account_id,as_of,account_version,input_revision,engine_version),
        FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_paper_nav_account_date ON paper_nav_snapshots(account_id,as_of,id)")


def _record(row):
    return {"id": row["id"], **json.loads(row["snapshot_json"])}


def _current(db, account, as_of):
    valuation = paper._valuation(db, account, as_of)
    return {"account_id": account["id"], "account_version": account["version"],
            "as_of": as_of, "input_revision": store.input_revision(db),
            "paper_engine_version": paper.ENGINE_VERSION,
            "cash": float(account["cash"]), "initial_cash": float(account["initial_cash"]),
            **valuation}


@router.post("/api/paper/accounts/{account_id}/nav/capture")
def capture_nav(account_id: str, body: CaptureInput):
    with paper._write() as db:
        account = paper._account(db, account_id)
        paper._version(account, body.expected_version)
        revision, as_of = store.input_revision(db), sessions.latest_completed_session()
        if body.expected_input_revision is not None and body.expected_input_revision != revision:
            raise HTTPException(409, "擷取前行情版本已變更，請重新載入虛擬帳戶")
        existing = db.execute("""SELECT * FROM paper_nav_snapshots WHERE
            account_id=? AND as_of=? AND account_version=? AND input_revision=? AND engine_version=?""",
                              (account_id, as_of, account["version"], revision, ENGINE_VERSION)).fetchone()
        if existing is not None:
            return {"engine_version": ENGINE_VERSION, "snapshot": _record(existing), "created": False,
                    "method": METHOD, "warnings": WARNINGS}
        snapshot = {**_current(db, account, as_of), "engine_version": ENGINE_VERSION,
                    "observed_at": store.now()}
        cursor = db.execute("""INSERT INTO paper_nav_snapshots
            (account_id,as_of,account_version,input_revision,engine_version,observed_at,snapshot_json)
            VALUES (?,?,?,?,?,?,?)""", (account_id, as_of, account["version"], revision,
                                       ENGINE_VERSION, snapshot["observed_at"], paper._json(snapshot)))
        return {"engine_version": ENGINE_VERSION, "snapshot": {"id": cursor.lastrowid, **snapshot},
                "created": True, "method": METHOD, "warnings": WARNINGS}


def _costs(db, account_id):
    fills = db.execute("SELECT * FROM paper_ledger WHERE account_id=? AND kind='simulated_fill'", (account_id,)).fetchall()
    fees = slippage = bought = sold = Decimal(0)
    for row in fills:
        quantity = Decimal(row["shares_delta"])
        gross = paper._money(abs(quantity) * Decimal(row["price"]))
        if quantity > 0:
            bought += gross
        else:
            sold += gross
        fees += Decimal(row["fee"])
        slippage += Decimal(row["slippage_cost"])
    turnover = Decimal(0)
    for row in db.execute("SELECT preview_json FROM paper_proposals WHERE account_id=? AND status='simulated'", (account_id,)):
        value = json.loads(row["preview_json"])["turnover_pct"]
        if value is not None:
            turnover += Decimal(str(value))
    return {"simulated_fill_count": len(fills), "buy_notional": float(bought), "sell_notional": float(sold),
            "fees_total": float(fees), "slippage_total": float(slippage), "cost_total": float(fees + slippage),
            "turnover_pct_sum": float(turnover)}


def _daily_series(db, account_id, as_of, window_sessions):
    rows = db.execute("""SELECT * FROM paper_nav_snapshots
        WHERE account_id=? AND as_of<=? AND engine_version=? ORDER BY as_of,id""",
                      (account_id, as_of, ENGINE_VERSION)).fetchall()
    captured = {}
    for row in rows:
        captured[row["as_of"]] = _record(row)
    if not captured:
        return [], {"captured_count": 0, "observed_sessions": 0, "complete_count": 0, "missing_count": 0,
                    "start": None, "end": None, "period_return_pct": None, "max_drawdown_pct": None,
                    "performance_available": False, "reason": "尚未擷取虛擬帳戶淨值", "truncated": False}
    calendar = sessions.calendar(date.fromisoformat(as_of).year)
    lower = max(min(captured), calendar.first_session.date().isoformat())
    dates = sessions.expected_sessions(lower, as_of)
    truncated = len(dates) > window_sessions or min(captured) < lower
    dates = dates[-window_sessions:]
    points = []
    for day in dates:
        observation = captured.get(day)
        complete = observation is not None and observation["valuation_complete"] and observation["equity"] is not None
        point = {"as_of": day, "equity": observation["equity"] if complete else None,
                 "status": "complete" if complete else "incomplete" if observation else "not_captured",
                 "snapshot_id": observation["id"] if observation else None,
                 "observed_at": observation["observed_at"] if observation else None,
                 "account_version": observation["account_version"] if observation else None,
                 "input_revision": observation["input_revision"] if observation else None,
                 "coverage": observation["coverage"] if observation else None, "return_pct": None}
        if complete and points and points[-1]["equity"] is not None and points[-1]["equity"] > 0:
            point["return_pct"] = float((Decimal(str(point["equity"])) / Decimal(str(points[-1]["equity"])) - 1) * 100)
        points.append(point)
    complete_count = sum(point["equity"] is not None for point in points)
    available = len(points) >= 2 and complete_count == len(points) and points[0]["equity"] > 0
    period_return = drawdown = None
    if available:
        peak = Decimal(str(points[0]["equity"]))
        drawdown = Decimal(0)
        for point in points:
            value = Decimal(str(point["equity"]))
            peak = max(peak, value)
            if peak > 0:
                drawdown = max(drawdown, (1 - value / peak) * 100)
        period_return = float((Decimal(str(points[-1]["equity"])) / Decimal(str(points[0]["equity"])) - 1) * 100)
        drawdown = float(drawdown)
    return points, {"captured_count": sum(point["snapshot_id"] is not None for point in points),
                    "observed_sessions": len(points), "complete_count": complete_count,
                    "missing_count": len(points) - complete_count,
                    "start": points[0]["as_of"] if points else None, "end": points[-1]["as_of"] if points else None,
                    "period_return_pct": period_return, "max_drawdown_pct": drawdown,
                    "performance_available": available,
                    "reason": None if available else "觀察區間含缺價或未擷取交易日" if complete_count < len(points) else "至少需要兩個相鄰且完整的交易日觀測",
                    "truncated": truncated}


@router.get("/api/paper/accounts/{account_id}/nav")
@store.snapshot_read
def nav_report(account_id: str, window_sessions: Annotated[int, Query(ge=2, le=2520)] = 252,
               benchmark: Annotated[str, Query(pattern=paper_metrics.BENCHMARK_PATTERN)] = paper_metrics.DEFAULT_BENCHMARK):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        account = paper._account(db, account_id)
        as_of = sessions.latest_completed_session()
        series, summary = _daily_series(db, account_id, as_of, window_sessions)
        current, costs = _current(db, account, as_of), _costs(db, account_id)
        return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
                "account_version": account["version"], "current": current,
                "series": series, "summary": summary, "costs": costs,
                "metrics": paper_metrics.compute(db, series, summary, costs, current, benchmark),
                "method": METHOD, "warnings": WARNINGS}


@router.get("/api/paper/accounts/{account_id}/nav/snapshots")
@store.snapshot_read
def nav_snapshots(account_id: str, limit: Annotated[int, Query(ge=1, le=100)] = 100,
                  offset: Annotated[int, Query(ge=0, le=100_000)] = 0):
    with store.connect() as db:
        account = paper._account(db, account_id)
        rows = db.execute("SELECT * FROM paper_nav_snapshots WHERE account_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
                          (account_id, limit, offset)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM paper_nav_snapshots WHERE account_id=?", (account_id,)).fetchone()[0]
        return {"engine_version": ENGINE_VERSION, "as_of": sessions.latest_completed_session(),
                "input_revision": store.input_revision(db), "account_version": account["version"],
                "items": [_record(row) for row in rows], "total": total, "limit": limit, "offset": offset,
                "method": METHOD, "warnings": WARNINGS}
