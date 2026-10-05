"""Corporate-action detection from the local adjustment factor (alphaview-corporate-actions-v1).

Detection only, from the `bars` table that is already on disk: no provider call, no ledger adjustment.
The factor f_t = adj_close_t / close_t is constant between corporate actions; a change between two
consecutive sessions marks an ex-date. A raw close ratio near a common split ratio is reported as a
suspected split, otherwise the factor change implies a cash dividend D = close_{t-1} × (1 − f_{t-1} / f_t)
(Yahoo back-adjusts earlier rows at the ex-date, so the earlier factor is the smaller one). Anything that
does not fit stays `unclassified` with its reason; a non-finite or non-positive price makes the session
pair `unavailable`. First step of the corporate-action gap in the 2026-10-01 benchmark (Lean, qlib).
"""
import math
import re
from datetime import date

from fastapi import APIRouter, HTTPException, Query

from . import paper_portfolio as paper
from . import corporate_action_evidence, sessions, store

ENGINE_VERSION = "alphaview-corporate-actions-v1"
FACTOR_TOLERANCE = 1e-6
SPLIT_TOLERANCE = 0.03
SPLIT_MULTIPLIERS = (2.0, 3.0, 4.0, 5.0, 10.0, 20.0, 1.5, 2 / 3, 0.5, 1 / 3, 0.25, 0.2, 0.1, 0.05)
MAX_DIVIDEND_SHARE = 0.25
MAX_SYMBOLS = 50
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
DATE = r"^\d{4}-\d{2}-\d{2}$"
METHOD = (
    "只讀本機日線：f_t = adj_close_t / close_t 在沒有公司行動時固定，相鄰交易日相對變化超過 1e-6 即視為除權息日。"
    "原始收盤比 close_t / close_{t-1} 落在常見拆併股比例（2、3、4、5、10、20、3/2 及其倒數）±3% 內 → 疑似拆併股，股數倍率＝原始價格比的倒數；"
    "否則以 D = close_{t-1} × (1 − f_{t-1} / f_t) 推算每股現金股息（Yahoo 在除息日回溯調整較早的列，因此較早的因子較小），"
    "D 必須為有限值且介於前一日收盤的 0–25% 才列為股息，否則列為無法分類並附原因；價格非有限或非正時該組交易日標示不可用，不略過。"
    "虛擬帳戶摘要用部位停損相同的進場日定義（由零轉正的最後一次成交所屬提案 as_of），只列進場日之後的事件。"
)
WARNINGS = [
    "這是啟發式偵測，不是公司行動資料；拆併股比例與股息金額都由調整價反推，可能把資料修訂誤判為事件。",
    "不會自動調整模擬帳本的股數或現金；持倉若在進場後遇到事件，請人工檢視成本與股數口徑。",
    "調整因子推算層無法分辨特別股息、分拆與併購現金補償；另列的供應者回傳證據也不保證來源完整。",
]
DATA_CONSISTENCY = (
    "行情更新（market.refresh → market.fetch_symbol）每次以供應者最近兩年重新調整的日線整批覆蓋該標的；若事件發生在最近一次更新之後，"
    "或本機資料是從備份還原的舊快照，表中可能同時存在拆併股前後口徑的列。請執行行情更新後重新偵測；market.history_quality 的覆蓋檢查不含此項。"
)

router = APIRouter()


def _finite(value, digits=8):
    return round(float(value), digits) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _problem(code, message, status=422):
    return HTTPException(status, {"code": code, "message": message})


def _rows(db, symbol, end):
    return [dict(row) for row in db.execute(
        "SELECT date, close, adj_close FROM bars WHERE symbol=? AND date<=? ORDER BY date", (symbol, end))]


def _usable(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def classify(prev, cur):
    """Event for the session pair (prev → cur), or None when the adjustment factor did not move."""
    base = {"ex_date": cur["date"], "prior_session": prev["date"]}
    if not all(_usable(row[key]) for row in (prev, cur) for key in ("close", "adj_close")):
        return {**base, "kind": "unavailable", "reason": "non_finite_or_nonpositive_price", "price_ratio": None,
                "factor_before": None, "factor_after": None, "factor_change_pct": None,
                "shares_multiplier": None, "implied_cash_per_share": None, "data_consistency": None}
    factor_before, factor_after = prev["adj_close"] / prev["close"], cur["adj_close"] / cur["close"]
    change = (factor_after - factor_before) / factor_before
    if abs(change) <= FACTOR_TOLERANCE:
        return None
    price_ratio = cur["close"] / prev["close"]
    event = {**base, "price_ratio": _finite(price_ratio), "factor_before": _finite(factor_before, 10),
             "factor_after": _finite(factor_after, 10), "factor_change_pct": _finite(change * 100, 6),
             "shares_multiplier": None, "implied_cash_per_share": None, "reason": None, "data_consistency": None}
    for multiplier in SPLIT_MULTIPLIERS:
        expected = 1 / multiplier
        if abs(price_ratio - expected) / expected <= SPLIT_TOLERANCE:
            return {**event, "kind": "suspected_split", "shares_multiplier": _finite(multiplier, 6),
                    "data_consistency": {"flag": "possible_mixed_basis", "message": DATA_CONSISTENCY}}
    implied = prev["close"] * (1 - factor_before / factor_after)
    if math.isfinite(implied) and 0 < implied <= MAX_DIVIDEND_SHARE * prev["close"]:
        return {**event, "kind": "dividend", "implied_cash_per_share": float(implied)}
    return {**event, "kind": "unclassified", "implied_cash_per_share": _finite(implied) if math.isfinite(implied) else None,
            "reason": "implied_cash_out_of_range" if math.isfinite(implied) else "implied_cash_not_finite"}


def detect(db, symbol, start=None, end=None):
    """Events for one symbol up to `end` (default: latest completed session), keeping those on/after `start`."""
    end = end or sessions.latest_completed_session()
    rows = _rows(db, symbol, end)
    events, unavailable = [], 0
    for prev, cur in zip(rows, rows[1:]):
        event = classify(prev, cur)
        if event is None:
            continue
        unavailable += event["kind"] == "unavailable"
        if start is None or event["ex_date"] >= start:
            events.append({"symbol": symbol, **event})
    coverage = {"symbol": symbol, "sessions": len(rows), "first": rows[0]["date"] if rows else None,
                "last": rows[-1]["date"] if rows else None, "pairs_checked": max(len(rows) - 1, 0),
                "unavailable_pairs": unavailable, "start": start, "end": end}
    return events, coverage


def _fill_session(db, proposal_id):
    row = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal_id,)).fetchone()
    return paper.json.loads(row["preview_json"]).get("as_of") if row else None


def _last_fill_session(db, account_id, symbol):
    row = db.execute("SELECT proposal_id FROM paper_ledger WHERE account_id=? AND symbol=? AND proposal_id IS NOT NULL ORDER BY id DESC LIMIT 1",
                     (account_id, symbol)).fetchone()
    return _fill_session(db, row["proposal_id"]) if row else None


def account_summary(db, account_id, as_of, include_evidence=False):
    from .position_stops import _entry_session
    account = paper._account(db, account_id)
    holdings, events, coverage, provider_evidence = [], [], [], []
    for row in paper._holdings(db, account_id):
        symbol = row["symbol"]
        entry, last_fill = _entry_session(db, account_id, symbol), _last_fill_session(db, account_id, symbol)
        found, cover = detect(db, symbol, None, as_of)
        since_entry = [event["ex_date"] for event in found if entry is not None and event["ex_date"] > entry]
        after_fill = [event["ex_date"] for event in found if last_fill is not None and event["ex_date"] > last_fill]
        for event in found:
            events.append({**event, "since_entry": event["ex_date"] in since_entry, "after_last_fill": event["ex_date"] in after_fill})
        holdings.append({"symbol": symbol, "shares": row["shares"], "entry_session": entry, "last_fill_session": last_fill,
                         "events_total": len(found), "events_since_entry": since_entry, "events_after_last_fill": after_fill,
                         "status": "events_since_entry" if since_entry else "entry_unknown" if entry is None else "clear"})
        coverage.append(cover)
        if include_evidence:
            provider_evidence.append(corporate_action_evidence.summary(db, symbol, found, None, as_of))
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "holdings": holdings, "flagged": [row["symbol"] for row in holdings if row["status"] == "events_since_entry"],
            "entry_unknown": [row["symbol"] for row in holdings if row["status"] == "entry_unknown"],
            "events": events, "coverage": coverage, "provider_evidence": provider_evidence}


def preview_notices(db, account_id, held, as_of):
    """Paper-preview hook: a notice (never a violation) per held symbol with events since its entry session."""
    if not held:
        return []
    summary = account_summary(db, account_id, as_of)
    notices = []
    for row in summary["holdings"]:
        if row["status"] == "events_since_entry":
            notices.append({"code": "corporate_action_since_entry", "symbol": row["symbol"], "ex_dates": row["events_since_entry"],
                            "message": f"{row['symbol']} 自進場日 {row['entry_session']} 後偵測到 {len(row['events_since_entry'])} 個疑似公司行動"
                                       "（股息或拆併股），模擬帳本未自動調整，請人工檢視"})
    return notices


def _symbols(value):
    names = [item.strip().upper() for item in value.split(",") if item.strip()]
    if not 1 <= len(names) <= MAX_SYMBOLS:
        raise _problem("invalid_symbols", f"請提供 1–{MAX_SYMBOLS} 個代碼")
    if len(set(names)) != len(names) or any(not SYMBOL.match(name) for name in names):
        raise _problem("invalid_symbols", "代碼格式無效或重複")
    return names


def _date(value, label):
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise _problem("invalid_date", f"{label} 不是有效日期") from None


@router.get("/api/corporate-actions")
@store.snapshot_read
def corporate_actions(symbols: str = Query(min_length=1, max_length=600),
                      start: str | None = Query(default=None, pattern=DATE), end: str | None = Query(default=None, pattern=DATE)):
    names = _symbols(symbols)
    start, end = _date(start, "start"), _date(end, "end")
    if start and end and start > end:
        raise _problem("invalid_date", "開始日期不可晚於結束日期")
    as_of = sessions.latest_completed_session()
    end = min(end, as_of) if end else as_of
    with store.connect() as db:
        events, coverage, provider_evidence = [], [], []
        for symbol in names:
            found, cover = detect(db, symbol, start, end)
            events.extend(found)
            coverage.append(cover)
            provider_evidence.append(corporate_action_evidence.summary(db, symbol, found, start, end))
        return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
                "symbols": names, "events": events, "coverage": coverage, "provider_evidence": provider_evidence, "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/paper/accounts/{account_id}/corporate-actions")
@store.snapshot_read
def account_corporate_actions(account_id: str):
    with store.connect() as db:
        summary = account_summary(db, account_id, sessions.latest_completed_session(), include_evidence=True)
        return {**summary, "input_revision": store.input_revision(db), "method": METHOD, "warnings": list(WARNINGS)}
