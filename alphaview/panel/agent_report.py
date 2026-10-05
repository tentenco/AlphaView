"""Trading Agent daily report: one paper account, one completed session, read-only.

Every number comes from tables that already exist (paper ledger, proposals,
captured NAV snapshots, automation attempts, Jev decisions, local bars). Nothing
is estimated or back-filled: a missing capture or price is reported as null
with its reason. Paper fills are simulations, never real trades.
"""
import csv
import html
import io
import json
import sqlite3
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from . import paper_analytics, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-agent-report-v1"
JEV_PRICE_USD_PER_MILLION_INPUT_TOKENS = Decimal("0.042")
METHOD = (
    "Session fills are paper_ledger simulated_fill rows whose proposal as_of equals the "
    "session; the window covers proposals whose as_of falls within the last N expected "
    "XNYS sessions ending at the session. Win rate counts sells with realized_pnl > 0 over "
    "all sells; largest win/loss are single-fill realized P&L. NAV change uses the last "
    "captured snapshot on or before the session versus the last captured snapshot before "
    "it; window return and drawdown reuse alphaview-paper-analytics-v1 over captured "
    "snapshots only. Jev cost is input tokens × the published list price and is an "
    "estimate. Nothing is back-filled; unavailable values are null with a reason."
)
WARNINGS = [
    "紙上成交是本機模擬，不是實盤交易或真實損益。",
    "淨值只來自已擷取的快照；未擷取的交易日沒有淨值變動可報。",
    "Jev 費用依回傳 token 與公開價目估算，不是帳單。",
    "報表不預測未來報酬，也不是投資建議。",
]


def _finite(value, digits=6):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return round(number, digits) if number == number and abs(number) != float("inf") else None


def _json_field(text, key):
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value.get(key) if isinstance(value, dict) else None


def _side(shares_delta):
    return "buy" if Decimal(shares_delta) > 0 else "sell"


def _fill(row):
    quantity = Decimal(row["shares_delta"])
    price = Decimal(row["price"]) if row["price"] is not None else None
    return {"symbol": row["symbol"], "side": _side(row["shares_delta"]), "shares": _finite(abs(quantity)),
            "price": _finite(price), "notional": _finite(abs(quantity) * price) if price is not None else None,
            "fee": _finite(row["fee"]), "slippage_cost": _finite(row["slippage_cost"]),
            "realized_pnl": _finite(row["realized_pnl"]), "proposal_id": row["proposal_id"],
            "session": row["session"], "created_at": row["created_at"]}


def _fill_rows(db, account_id, sessions_in_scope):
    if not sessions_in_scope:
        return []
    marks = ",".join("?" for _ in sessions_in_scope)
    rows = db.execute(f"""SELECT l.*, json_extract(p.preview_json, '$.as_of') AS session
        FROM paper_ledger l JOIN paper_proposals p ON p.id = l.proposal_id
        WHERE l.account_id=? AND l.kind='simulated_fill' AND json_extract(p.preview_json, '$.as_of') IN ({marks})
        ORDER BY l.id""", (account_id, *sessions_in_scope)).fetchall()
    return [_fill(row) for row in rows]


def _totals(fills):
    buys = [f for f in fills if f["side"] == "buy"]
    sells = [f for f in fills if f["side"] == "sell"]
    total = lambda items, key: _finite(sum(Decimal(str(item[key])) for item in items if item[key] is not None), 6)  # noqa: E731
    return {"count": len(fills), "buy_count": len(buys), "sell_count": len(sells),
            "buy_notional": total(buys, "notional"), "sell_notional": total(sells, "notional"),
            "fees": total(fills, "fee"), "slippage": total(fills, "slippage_cost"),
            "cost_total": _finite(Decimal(str(total(fills, "fee") or 0)) + Decimal(str(total(fills, "slippage_cost") or 0))),
            "realized_pnl": total(fills, "realized_pnl")}


def _window_stats(fills, window_sessions, dates):
    sells = [f for f in fills if f["side"] == "sell" and f["realized_pnl"] is not None]
    wins = [f for f in sells if f["realized_pnl"] > 0]
    losses = [f for f in sells if f["realized_pnl"] < 0]
    totals = _totals(fills)
    return {"window_sessions": window_sessions, "start": dates[0] if dates else None, "end": dates[-1] if dates else None,
            "fill_count": len(fills), "sell_count": len(sells), "realized_pnl": totals["realized_pnl"],
            "win_rate_pct": _finite(len(wins) / len(sells) * 100, 4) if sells else None,
            "wins": len(wins), "losses": len(losses),
            "largest_win": _finite(max(f["realized_pnl"] for f in wins)) if wins else None,
            "largest_loss": _finite(min(f["realized_pnl"] for f in losses)) if losses else None,
            "avg_realized_pnl": _finite(sum(f["realized_pnl"] for f in sells) / len(sells)) if sells else None,
            "cost_total": totals["cost_total"], "gross_notional": _finite(Decimal(str(totals["buy_notional"] or 0)) + Decimal(str(totals["sell_notional"] or 0))),
            "reason": None if sells else "區間內沒有賣出成交，無法計算勝率與最大單筆盈虧"}


def _nav(db, account_id, session, window_sessions):
    latest = db.execute("""SELECT * FROM paper_nav_snapshots WHERE account_id=? AND as_of<=? AND engine_version=?
        ORDER BY as_of DESC, id DESC LIMIT 1""", (account_id, session, paper_analytics.ENGINE_VERSION)).fetchone()
    previous = None
    if latest is not None:
        previous = db.execute("""SELECT * FROM paper_nav_snapshots WHERE account_id=? AND as_of<? AND engine_version=?
            ORDER BY as_of DESC, id DESC LIMIT 1""", (account_id, latest["as_of"], paper_analytics.ENGINE_VERSION)).fetchone()

    def point(row):
        if row is None:
            return None
        record = paper_analytics._record(row)
        complete = bool(record.get("valuation_complete")) and record.get("equity") is not None
        return {"as_of": record["as_of"], "equity": _finite(record["equity"]) if complete else None,
                "complete": complete, "observed_at": record.get("observed_at"), "snapshot_id": record["id"]}
    current, prior = point(latest), point(previous)
    change = None
    reason = None
    if current is None:
        reason = "尚未擷取此交易日或之前的淨值快照"
    elif current["as_of"] != session:
        reason = f"最近一次擷取為 {current['as_of']}，不是所選交易日"
    elif not current["complete"]:
        reason = "所選交易日的快照估值不完整"
    elif prior is None:
        reason = "沒有更早的快照可比較"
    elif not prior["complete"] or not prior["equity"]:
        reason = "前一次快照估值不完整"
    else:
        change = _finite((Decimal(str(current["equity"])) / Decimal(str(prior["equity"])) - 1) * 100, 4)
    _, summary = paper_analytics._daily_series(db, account_id, session, max(window_sessions, 2))
    return {"latest": current, "previous": prior, "session_change_pct": change, "session_change_reason": reason,
            "window_return_pct": _finite(summary["period_return_pct"], 4), "window_max_drawdown_pct": _finite(summary["max_drawdown_pct"], 4),
            "window_reason": summary["reason"], "captured_sessions": summary["captured_count"],
            "observed_sessions": summary["observed_sessions"]}


def _automation(db, account_id, session):
    try:
        attempts = [dict(row) for row in db.execute("""SELECT a.id, a.mandate_id, m.name AS mandate_name, a.status, a.reason_code, a.reason,
            a.mode, a.trigger_kind, a.started_at, a.finished_at, a.paper_proposal_id
            FROM agent_automation_attempts a LEFT JOIN agent_mandates m ON m.id = a.mandate_id
            WHERE a.account_id=? AND a.session_date=? ORDER BY a.started_at, a.id""", (account_id, session))]
        counts = {}
        for row in attempts:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        enabled = db.execute("SELECT COUNT(*) FROM agent_mandates WHERE account_id=? AND enabled=1", (account_id,)).fetchone()[0]
    except sqlite3.OperationalError:
        attempts, counts, enabled = [], {}, None
    pending = db.execute("SELECT COUNT(*) FROM paper_proposals WHERE account_id=? AND status='proposed'", (account_id,)).fetchone()[0]
    try:
        queue = {row["status"]: row["count"] for row in db.execute(
            "SELECT status, COUNT(*) AS count FROM paper_next_open_orders WHERE account_id=? GROUP BY status", (account_id,))}
    except sqlite3.OperationalError:
        queue = None
    return {"attempts": attempts, "status_counts": counts, "enabled_mandates": enabled,
            "pending_proposals": pending, "next_open_queue": queue}


def _jev(db, session):
    try:
        rows = db.execute("SELECT status, result_json, usage_json, latency_ms FROM jev_decision_runs WHERE as_of=?", (session,)).fetchall()
    except sqlite3.OperationalError:
        return {"available": False, "reason": "此工作區沒有 Jev 決策紀錄表"}
    counts = {"pass": 0, "fail": 0, "unavailable": 0}
    statuses = {}
    latencies, cost = [], Decimal(0)
    for row in rows:
        statuses[row["status"]] = statuses.get(row["status"], 0) + 1
        result = _json_field(row["result_json"], "counts") or {}
        for key in counts:
            value = result.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                counts[key] += value
        if isinstance(row["latency_ms"], int):
            latencies.append(row["latency_ms"])
        tokens = _json_field(row["usage_json"], "input_tokens")
        if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0:
            cost += Decimal(tokens) * JEV_PRICE_USD_PER_MILLION_INPUT_TOKENS / Decimal(1_000_000)
    return {"available": True, "runs": len(rows), "status_counts": statuses, "symbol_counts": counts,
            "average_latency_ms": _finite(sum(latencies) / len(latencies), 1) if latencies else None,
            "estimated_cost_usd": _finite(cost, 8) if rows else None,
            "cost_basis": "估算：輸入 token × $0.042／百萬（2026-09-30 公開價目），輸出 token 免費"}


def _circuit_breaker(db, account_id, session):
    try:
        from . import circuit_breakers  # noqa: WPS433 - optional module built in a parallel wave
    except ImportError:
        return {"available": False, "reason": "尚未安裝斷路器模組"}
    evaluate = getattr(circuit_breakers, "evaluate", None)
    if evaluate is None:
        return {"available": False, "reason": "斷路器模組沒有提供 evaluate"}
    try:
        result = evaluate(db, account_id, session)
    except (sqlite3.OperationalError, HTTPException, KeyError, TypeError, ValueError):
        return {"available": False, "reason": "斷路器評估失敗或資料表不存在"}
    return {"available": True, **result} if isinstance(result, dict) else {"available": False, "reason": "斷路器回傳格式不符"}


def _guarded(label, work):
    try:
        return {"available": True, **work()}
    except ImportError:
        return {"available": False, "reason": f"尚未安裝{label}模組"}
    except (sqlite3.OperationalError, HTTPException, KeyError, TypeError, ValueError):
        return {"available": False, "reason": f"{label}評估失敗或資料表不存在"}


def _operations(db, account_id, session):
    """Readiness, mandate lifecycle, position stops and the regime cap on the report session; each piece fails independently."""
    def readiness():
        from . import readiness as module
        result = module.evaluate(db, account_id, session)
        return {"overall": result["overall"], "execution_target": result.get("execution_target"),
                "failing": [check["id"] for check in result["checks"] if check["status"] == "fail"],
                "unavailable": [check["id"] for check in result["checks"] if check["status"] == "unavailable"]}

    def mandates():
        from . import agent_automation as module
        rows = [dict(row) for row in db.execute("SELECT * FROM agent_mandates WHERE account_id=? ORDER BY name", (account_id,))]
        views = [{"id": row["id"], "name": row["name"], **module.lifecycle(row, session)} for row in rows]
        counts = {}
        for view in views:
            counts[view["lifecycle"]] = counts.get(view["lifecycle"], 0) + 1
        return {"count": len(views), "lifecycle_counts": counts,
                "attention": [{"id": v["id"], "name": v["name"], "lifecycle": v["lifecycle"], "expires_on": v["expires_on"],
                               "sessions_remaining": v["sessions_remaining"], "message": v["message"]}
                              for v in views if v["lifecycle"] in ("expired", "reauth_required", "expiring_soon")]}

    def stops():
        from . import position_stops as module
        result = module.evaluate(db, account_id, session)
        return {"enabled": bool(result["policy"].get("enabled")), "tripped": result["tripped"], "unavailable": result["unavailable"],
                "holdings": len(result["holdings"])}

    def regime():
        from . import regime_overlay as module
        result = module.evaluate(db, account_id, session)
        return {"enabled": bool(result["policy"].get("enabled")), "mode": result["policy"].get("mode"),
                "zone": result["regime"]["zone"], "score": result["regime"]["score"], "complete": result["regime"]["complete"],
                "cap_pct": result["cap"].get("cap_pct"), "cap_status": result["cap"].get("status"),
                "current_exposure_pct": result["current_exposure_pct"], "exposure_status": result["exposure_status"]}
    return {"readiness": _guarded("就緒閘", readiness), "mandates": _guarded("自動化任務", mandates),
            "position_stops": _guarded("部位停損", stops), "regime_overlay": _guarded("市場風險覆蓋", regime)}


def _decision_quality(db, account_id):
    """10-session hit rates of the rule-workflow and Jev-gate families plus the setup_quality rank correlation (read-only)."""
    def quality():
        from . import decision_ledger as module
        data = module.build(db, account_id, 10, 60, max_items=1)
        families = {}
        for family in data["families"]:
            if family["id"] not in ("agent_targets", "jev_gate"):
                continue
            total = family["total"]
            families[family["id"]] = {
                "label": family["label"], "english": family["english"], "n": total["n"], "n_settled": total["n_settled"],
                "n_pending": total["n_pending"], "hit_rate": total["hit_rate"], "mean_excess_pct": total["mean_excess_pct"],
                "low_sample": total["low_sample"], "reason": total["reason"],
                "kinds": [{"kind": group["kind"], "label": group["label"], "english": group["english"], "n_settled": group["n_settled"],
                           "hit_rate": group["hit_rate"], "low_sample": group["low_sample"]} for group in family["groups"] if group["n"]]}
        correlation = data["calibration"]["score_correlation"]
        return {"engine_version": data["engine_version"], "horizon_sessions": 10, "window_sessions": 60, "families": families,
                "score_correlation": {key: correlation.get(key) for key in ("status", "spearman", "n", "low_sample", "reason")}}
    return _guarded("決策結果帳本", quality)


def _provenance_counts(db, account_id, session):
    by_source, by_tag, total = {}, {}, 0
    for row in db.execute("SELECT preview_json, status FROM paper_proposals WHERE account_id=?", (account_id,)):
        view = json.loads(row["preview_json"])
        if view.get("as_of") != session:
            continue
        item = paper.provenance({**view, "status": row["status"]})
        total += 1
        by_source[item["source"]] = by_source.get(item["source"], 0) + 1
        for tag in item["tags"]:
            by_tag[tag] = by_tag.get(tag, 0) + 1
    return {"engine_version": paper.PROVENANCE_VERSION, "session": session, "total": total,
            "by_source": dict(sorted(by_source.items())), "by_tag": dict(sorted(by_tag.items()))}


def _freshness(db, holdings, session):
    rows = []
    for holding in holdings:
        latest = db.execute("SELECT MAX(date) FROM bars WHERE symbol=?", (holding["symbol"],)).fetchone()[0]
        rows.append({"symbol": holding["symbol"], "latest_bar": latest, "stale": latest is None or latest < session})
    return {"symbols": rows, "stale_symbols": [row["symbol"] for row in rows if row["stale"]], "session": session}


def _window_dates(session, window_sessions):
    anchor = date.fromisoformat(session)
    lower = (anchor - timedelta(days=window_sessions * 2 + 14)).isoformat()
    return sessions.expected_sessions(lower, session)[-window_sessions:]


def build_report(db, account_id, session, window_sessions):
    as_of = sessions.latest_completed_session()
    if session is None:
        session = as_of
    try:
        date.fromisoformat(session)
    except ValueError as exc:
        raise HTTPException(422, {"code": "invalid_session", "message": "交易日必須是 YYYY-MM-DD"}) from exc
    if session > as_of:
        raise HTTPException(422, {"code": "session_not_completed", "message": f"{session} 尚未完成；最新完成交易日為 {as_of}"})
    account = paper._account(db, account_id)
    valuation = paper._valuation(db, account, session)
    dates = _window_dates(session, window_sessions)
    is_session = bool(sessions.expected_sessions(session, session))
    session_fills = _fill_rows(db, account_id, [session])
    window_fills = _fill_rows(db, account_id, dates)
    warnings = list(WARNINGS)
    if not is_session:
        warnings.append(f"{session} 不是 XNYS 交易日；此日沒有成交或快照可歸屬。")
    nav = _nav(db, account_id, session, window_sessions)
    if nav["session_change_pct"] is None:
        warnings.append("淨值變動不可用：" + (nav["session_change_reason"] or "未擷取"))
    freshness = _freshness(db, valuation["holdings"], session)
    if freshness["stale_symbols"]:
        warnings.append("部分持股的本機日線早於所選交易日：" + "、".join(freshness["stale_symbols"]))
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "session": session, "is_session": is_session,
            "input_revision": store.input_revision(db), "generated_at": store.now(),
            "account": {"id": account["id"], "name": account["name"], "version": account["version"],
                        "kill_switch": bool(account["kill_switch"]), "cash": _finite(account["cash"]),
                        "initial_cash": _finite(account["initial_cash"]), "equity": _finite(valuation["equity"]),
                        "valuation_complete": valuation["valuation_complete"], "coverage": valuation["coverage"],
                        "holdings_count": len(valuation["holdings"]), "realized_pnl": _finite(valuation["realized_pnl"]),
                        "unrealized_pnl": _finite(valuation["unrealized_pnl"]), "total_return_pct": _finite(valuation["total_return_pct"], 4)},
            "nav": nav, "fills": {"items": session_fills, "totals": _totals(session_fills)},
            "window": _window_stats(window_fills, window_sessions, dates),
            "automation": _automation(db, account_id, session), "jev": _jev(db, session),
            "circuit_breaker": _circuit_breaker(db, account_id, session),
            "operations": _operations(db, account_id, session),
            "decision_quality": _decision_quality(db, account_id),
            "provenance_counts": _provenance_counts(db, account_id, session),
            "data_freshness": freshness, "method": METHOD, "warnings": warnings}


SessionParam = Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]
WindowParam = Annotated[int, Query(ge=1, le=252)]


@router.get("/api/trading-agent/report")
@store.snapshot_read
def report(account_id: str, session: SessionParam = None, window_sessions: WindowParam = 20):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        return build_report(db, account_id, session, window_sessions)


def _cell(value):
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return "" if value is None else value


@router.get("/api/trading-agent/report.csv")
@store.snapshot_read
def report_csv(account_id: str, session: SessionParam = None, window_sessions: WindowParam = 20):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        data = build_report(db, account_id, session, window_sessions)
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(["session", "account_id", "symbol", "side", "shares", "price", "notional", "fee", "slippage_cost",
                     "realized_pnl", "proposal_id", "created_at", "engine_version", "note"])
    for fill in data["fills"]["items"]:
        writer.writerow([_cell(value) for value in (
            data["session"], data["account"]["id"], fill["symbol"], fill["side"], fill["shares"], fill["price"], fill["notional"],
            fill["fee"], fill["slippage_cost"], fill["realized_pnl"], fill["proposal_id"], fill["created_at"], ENGINE_VERSION,
            "paper simulated fill, not a real trade")])
    name = f"alphaview-agent-report-{data['account']['id'][:8]}-{data['session']}.csv"
    return Response("﻿" + stream.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


def _fmt(value, digits=2, suffix=""):
    if value is None:
        return "—"
    return f"{value:,.{digits}f}{suffix}"


def _pct(value):
    return "—" if value is None else f"{value:+.2f}%"


HTML_CSS = """
:root{color-scheme:light dark;--text:#1a1a1a;--muted:#5f6368;--line:#d9d9d9;--surface:#fafafa;--positive:#0b7a3b;--negative:#b3261e;--amber:#a15c00}
@media (prefers-color-scheme:dark){:root{--text:#ececec;--muted:#a0a0a0;--line:#3a3a3a;--surface:#161616;--positive:#4cc38a;--negative:#ff7b72;--amber:#e3b341}}
body{margin:0;padding:24px 16px;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;color:var(--text);background:var(--surface)}
main{max-width:960px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
p,li{color:var(--muted)}.meta{font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0;border:1px solid var(--line)}
.grid div{padding:14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.grid span{display:block;font-size:12px;color:var(--muted)}.grid strong{display:block;font-size:20px;margin:4px 0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);white-space:nowrap}
.scroll{overflow-x:auto}.pos{color:var(--positive)}.neg{color:var(--negative)}.warn{color:var(--amber)}
"""


def render_html(data):
    e = html.escape
    account, nav, fills, window, jev, auto = data["account"], data["nav"], data["fills"], data["window"], data["jev"], data["automation"]

    def card(label, value, note=""):
        return f"<div><span>{e(label)}</span><strong>{e(value)}</strong><span>{e(note)}</span></div>"

    def tone(value):
        return "pos" if value is not None and value > 0 else "neg" if value is not None and value < 0 else ""
    cards = [
        card("淨值 (Equity)", _fmt(account["equity"]), "估值完整" if account["valuation_complete"] else "估值不完整：缺價 " + "、".join(account["coverage"]["missing"])),
        card("當日淨值變動 (NAV change)", _pct(nav["session_change_pct"]), nav["session_change_reason"] or ""),
        card("區間報酬 (Window return)", _pct(nav["window_return_pct"]), f"{window['window_sessions']} 個交易日"),
        card("區間最大回撤 (Max drawdown)", _fmt(nav["window_max_drawdown_pct"], 2, "%"), nav["window_reason"] or ""),
        card("當日成交 (Fills)", str(fills["totals"]["count"]), f"費用+滑價 {_fmt(fills['totals']['cost_total'])}"),
        card("當日已實現損益 (Realized P&L)", _fmt(fills["totals"]["realized_pnl"]), "僅賣出成交"),
        card("區間勝率 (Win rate)", _fmt(window["win_rate_pct"], 1, "%"), f"{window['wins']} 勝 / {window['sell_count']} 賣出"),
        card("最大單筆虧損 (Largest loss)", _fmt(window["largest_loss"]), f"最大單筆獲利 {_fmt(window['largest_win'])}"),
        card("Jev 決策 (Decisions)", str(jev["runs"]) if jev.get("available") else "—",
             f"平均延遲 {_fmt(jev.get('average_latency_ms'), 0, ' ms')} · 估算 ${_fmt(jev.get('estimated_cost_usd'), 6)}" if jev.get("available") else jev.get("reason", "")),
        card("自動化嘗試 (Automation)", str(len(auto["attempts"])), " · ".join(f"{k} {v}" for k, v in auto["status_counts"].items()) or "無"),
        card("待審提案 (Pending)", str(auto["pending_proposals"]), "暫停中" if account["kill_switch"] else "帳戶運作中"),
        card("資料新鮮度 (Freshness)", str(len(data["data_freshness"]["stale_symbols"])) + " 檔過期",
             "、".join(data["data_freshness"]["stale_symbols"]) or "所有持股日線已到所選交易日"),
    ]
    rows = "".join(
        f"<tr><td>{e(f['symbol'])}</td><td>{e(f['side'])}</td><td>{_fmt(f['shares'], 4)}</td><td>{_fmt(f['price'], 4)}</td>"
        f"<td>{_fmt(f['notional'])}</td><td>{_fmt(f['fee'])}</td><td>{_fmt(f['slippage_cost'])}</td>"
        f"<td class=\"{tone(f['realized_pnl'])}\">{_fmt(f['realized_pnl'])}</td><td>{e(f['proposal_id'] or '')[:12]}</td></tr>"
        for f in fills["items"]) or "<tr><td colspan=\"9\">此交易日沒有紙上成交</td></tr>"
    attempts = "".join(
        f"<tr><td>{e(a['mandate_name'] or a['mandate_id'])}</td><td>{e(a['status'])}</td><td>{e(a['reason_code'] or '')}</td><td>{e(a['reason'] or '')}</td></tr>"
        for a in auto["attempts"]) or "<tr><td colspan=\"4\">此交易日沒有自動化嘗試</td></tr>"
    breaker = data["circuit_breaker"]
    breaker_text = e(json.dumps({k: v for k, v in breaker.items() if k != "available"}, ensure_ascii=False)) if breaker.get("available") else e(breaker.get("reason", "不可用"))
    warnings = "".join(f"<li>{e(w)}</li>" for w in data["warnings"])
    ops = data.get("operations") or {}
    quality = data.get("decision_quality") or {}
    if quality.get("available"):
        quality_items = "".join(
            f"<li><strong>{e(block['label'])}</strong>：已結算 {block['n_settled']}／待定 {block['n_pending']}；命中率 {_fmt(None if block['hit_rate'] is None else block['hit_rate'] * 100, 1, '%')}"
            f"{'（樣本少）' if block['low_sample'] else ''}{'；' + e(block['reason']) if block['reason'] else ''}</li>"
            for block in quality.get("families", {}).values())
        correlation = quality.get("score_correlation") or {}
        quality_items += (f"<li><strong>setup_quality 秩相關</strong>：{_fmt(correlation.get('spearman'), 3)}（N={correlation.get('n')}）"
                          f"{'；' + e(correlation.get('reason')) if correlation.get('reason') else ''}</li>")
    else:
        quality_items = f"<li>{e(quality.get('reason', '不可用'))}</li>"
    counts = data.get("provenance_counts") or {}
    provenance_text = (f"此交易日提案 {counts.get('total', 0)} 份；來源 " + (" · ".join(f"{k} {v}" for k, v in (counts.get('by_source') or {}).items()) or "無")
                       + "；閘門標籤 " + (" · ".join(f"{k} {v}" for k, v in (counts.get('by_tag') or {}).items()) or "無"))

    def ops_line(label, block, render):
        return f"<li><strong>{e(label)}</strong>：{e(render(block)) if block.get('available') else e(block.get('reason', '不可用'))}</li>"
    operations = "".join([
        ops_line("就緒閘", ops.get("readiness", {}), lambda b: f"{b['overall']}；未通過 {'、'.join(b['failing']) or '無'}；不可用 {'、'.join(b['unavailable']) or '無'}"),
        ops_line("任務授權", ops.get("mandates", {}), lambda b: f"{b['count']} 個任務；" + (" · ".join(f"{k} {v}" for k, v in b['lifecycle_counts'].items()) or "無") + ("；需注意：" + "、".join(f"{a['name']}（{a['lifecycle']}）" for a in b['attention']) if b['attention'] else "")),
        ops_line("部位停損", ops.get("position_stops", {}), lambda b: ("已啟用" if b['enabled'] else "未啟用") + f"；觸發 {'、'.join(b['tripped']) or '無'}；無法判斷 {'、'.join(b['unavailable']) or '無'}"),
        ops_line("市場風險覆蓋", ops.get("regime_overlay", {}), lambda b: ("已啟用 " + str(b['mode']) if b['enabled'] else "未啟用") + f"；區間 {b['zone'] or '—'}；分數 {_fmt(b['score'], 1)}；上限 {_fmt(b['cap_pct'], 0, '%')}；目前曝險 {_fmt(b['current_exposure_pct'], 1, '%')}（{b['exposure_status']}）"),
    ])
    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlphaView Agent 日報 {e(data['session'])}</title><style>{HTML_CSS}</style></head><body><main>
<h1>AlphaView Trading Agent 日報 (Daily report)</h1>
<p class="meta">帳戶 {e(account['name'])} · 交易日 {e(data['session'])} · 最新完成交易日 {e(data['as_of'])} · 產生於 {e(data['generated_at'])} · {e(ENGINE_VERSION)} · input revision {e(data['input_revision'])}</p>
<p class="warn">紙上模擬，不是實盤交易，也不是投資建議。</p>
<div class="grid">{''.join(cards)}</div>
<h2>當日紙上成交 (Session fills)</h2><div class="scroll"><table><thead><tr><th>代碼</th><th>方向</th><th>股數</th><th>價格</th><th>金額</th><th>費用</th><th>滑價</th><th>已實現損益</th><th>提案</th></tr></thead><tbody>{rows}</tbody></table></div>
<h2>自動化嘗試 (Automation attempts)</h2><div class="scroll"><table><thead><tr><th>任務</th><th>狀態</th><th>代碼</th><th>原因</th></tr></thead><tbody>{attempts}</tbody></table></div>
<h2>斷路器 (Circuit breaker)</h2><p class="meta">{breaker_text}</p>
<h2>營運狀態 (Operations)</h2><ul>{operations}</ul>
<h2>決策品質 (Decision quality)</h2><ul>{quality_items}</ul><p class="meta">{provenance_text}</p>
<h2>提醒與方法 (Warnings and method)</h2><ul>{warnings}</ul><p class="meta">{e(data['method'])}</p>
</main></body></html>"""


@router.get("/api/trading-agent/report.html")
@store.snapshot_read
def report_html(account_id: str, session: SessionParam = None, window_sessions: WindowParam = 20):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        data = build_report(db, account_id, session, window_sessions)
    name = f"alphaview-agent-report-{data['account']['id'][:8]}-{data['session']}.html"
    return Response(render_html(data), media_type="text/html; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store",
                             "X-Content-Type-Options": "nosniff"})
