"""Read-only coverage diagnostics. Never fill missing sessions with invented bars."""
from . import market, store
from .sessions import expected_sessions, latest_completed_session


def report():
    expected = latest_completed_session()
    members = {p["symbol"]: p for p in [*store.universe("market"), *store.positions()]}
    datasets = {d["symbol"]: d for d in store.dataset_rows()}
    items = []
    for symbol, member in sorted(members.items()):
        frame = store.history(symbol)
        dataset = datasets.get(symbol, {})
        dates = sorted(set(frame.get("date", [])))
        last = dates[-1] if dates else None
        gaps = []
        invalid_dates = []
        issues = []
        if len(frame):
            assessment = market.history_quality(frame)
            if not assessment["valid"]:
                issues.append("；".join(f"{i['date'] or '無日期'}：{i['reason']}" for i in assessment["issues"][:3]))
                invalid_dates = sorted({i["date"] for i in assessment["issues"] if i["date"] in dates})
            try:
                gaps = sorted(set(expected_sessions(dates[0], min(last, expected))) - set(dates))
                extra = sorted(set(dates) - set(expected_sessions(dates[0], max(last, expected))))
                if extra:
                    invalid_dates = sorted(set(invalid_dates + extra))
                    issues.append("非交易日日線：" + ", ".join(extra[:3]))
            except (ValueError, TypeError) as exc:
                issues.append("無法檢查交易日：" + str(exc)[:100])
        if not dates:
            status, reason = "missing", "尚無歷史行情；請更新標的"
        elif issues:
            status, reason = "error", "；".join(issues)
        elif dataset.get("status") == "error":
            status, reason = "error", dataset.get("error") or "最近更新失敗，保留先前資料"
        elif gaps:
            status, reason = "error", f"歷史區間缺少 {len(gaps)} 個交易日；不補造價格"
        elif last > expected:
            status, reason = "error", f"日線 {last} 尚未通過完整收盤時間，預期至 {expected}"
        elif last < expected:
            status, reason = "stale", f"日線停留在 {last}；預期完整交易日 {expected}"
        else:
            status, reason = "ok", "價格結構與交易日覆蓋通過檢查"
        items.append({"symbol": symbol, "name": member["name"], "last_date": last,
                      "bars": len(frame), "status": status, "reason": reason,
                      "gap_dates": gaps, "invalid_dates": invalid_dates,
                      "source": dataset.get("source", "Yahoo Finance / yfinance")})
    return {"as_of": max((i["last_date"] for i in items if i["last_date"]), default=None),
            "expected_session": expected,
            "counts": {"total": len(items), **{s: sum(i["status"] == s for i in items) for s in ("ok", "stale", "error", "missing")}},
            "items": items, "checked_at": store.now()}
