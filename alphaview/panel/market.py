
import math
from numbers import Real

import numpy as np
import pandas as pd

from . import store
from .sessions import latest_completed_session


def history_quality(frame, as_of=None, check_sessions=True):
    """Inspect raw bars without changing/deleting prices, optionally as of a date.

    A later malformed bar cannot invalidate an earlier dated snapshot. Undatable
    observations remain errors because their position in time cannot be known.
    """
    columns = ["open", "high", "low", "close", "adj_close", "volume"]
    missing = set(["date", *columns]) - set(frame.columns)
    if missing:
        return {"status": "data_error", "valid": False, "checked_rows": len(frame), "invalid_count": len(frame),
                "issues": [{"date": None, "reason": f"日線缺少必要欄位：{', '.join(sorted(missing))}"}]}
    dates = frame["date"].astype(str)
    valid_dates = dates.str.fullmatch(r"\d{4}-\d{2}-\d{2}") & pd.to_datetime(
        dates, format="%Y-%m-%d", errors="coerce").notna()
    selected = ~valid_dates | (dates <= str(as_of)) if as_of is not None else pd.Series(True, index=frame.index)
    data = frame.loc[selected, columns].apply(pd.to_numeric, errors="coerce").reset_index(drop=True)
    dates, valid_dates = dates[selected].reset_index(drop=True), valid_dates[selected].reset_index(drop=True)
    if data.empty:
        return {"status": "no_data", "valid": False, "checked_rows": 0, "invalid_count": 0, "issues": []}
    prices = data[["open", "high", "low", "close", "adj_close"]]
    # Roughly one float32 ULP: absorb provider numeric representation noise,
    # never a price tick. Adjusted-close scale must not widen OHLC tolerance.
    tolerance = data[["open", "high", "low", "close"]].abs().max(axis=1).clip(lower=1) * 1e-7
    failures = {
        "日期無效": ~valid_dates,
        "日期重複": dates.duplicated(keep=False),
        "價格或成交量包含缺值／非有限數值": ~np.isfinite(data).all(axis=1),
        "價格必須大於零": (prices <= 0).any(axis=1),
        "成交量不可為負數": data.volume < 0,
        "最高價低於開盤、最低或收盤價": data.high + tolerance < data[["open", "low", "close"]].max(axis=1),
        "最低價高於開盤、最高或收盤價": data.low - tolerance > data[["open", "high", "close"]].min(axis=1),
    }
    bad = pd.DataFrame(failures).any(axis=1)
    issues = [{"date": dates.iloc[i] if valid_dates.iloc[i] else None,
               "reason": "；".join(reason for reason, mask in failures.items() if mask.iloc[i])
                         + (f"（{dates.iloc[i]}）" if not valid_dates.iloc[i] else "")}
              for i in data.index[bad]]
    if check_sessions and valid_dates.any():
        from .sessions import expected_sessions
        observed = set(dates[valid_dates])
        # Start at the first observed bar, not a universe member's presumed IPO.
        # Never fill a missing session with a prior close or invented volume.
        expected = set(expected_sessions(min(observed), max(observed)))
        issues.extend({"date": d, "reason": "缺少交易日日線，技術指標視窗不完整"}
                      for d in sorted(expected - observed))
        issues.extend({"date": d, "reason": "非美股交易日卻有日線"}
                      for d in sorted(observed - expected))
        issues.sort(key=lambda issue: issue["date"] or "")
    return {"status": "data_error" if issues else "ok", "valid": not bool(issues),
            "checked_rows": len(data), "invalid_count": len(issues), "issues": issues}


def validate_bars(frame, check_sessions=True):
    """Reject a corrupt replacement; retain valid zero-volume sessions."""
    quality = history_quality(frame, check_sessions=check_sessions)
    if quality["status"] == "no_data":
        raise ValueError("沒有可用的完整日線")
    if not quality["valid"]:
        details = "；".join(f"{issue['date'] or '日期未知'}：{issue['reason']}" for issue in quality["issues"][:3])
        label = "日線日期無效或重複" if any("日期" in i["reason"] for i in quality["issues"]) else "日線價格或成交量無效"
        raise ValueError(f"{label}（{details}）；未替換原有資料")
    result = frame.copy()
    columns = ["open", "high", "low", "close", "adj_close", "volume"]
    result[columns] = result[columns].apply(pd.to_numeric)
    result["date"] = result["date"].astype(str)
    return result.sort_values("date").reset_index(drop=True)


def display_name(metadata, symbol):
    """Optional provider labels are text, never identities inferred from objects."""
    for key in ("longName", "shortName"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return symbol


def eligible_market_cap(value):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        return None
    try:
        value = float(value)
    except (ValueError, OverflowError):
        return None
    return value if math.isfinite(value) and value >= 2_000_000_000 else None


def fetch_symbol(symbol):
    import yfinance as yf
    ticker = yf.Ticker(symbol)
    frame = ticker.history(period="2y", interval="1d", auto_adjust=False, actions=False,
                           raise_errors=True, timeout=20)
    if frame.empty:
        raise ValueError("資料源未回傳日線；請確認代碼或稍後重試")
    meta = ticker.get_history_metadata() or {}
    if not isinstance(meta, dict):
        raise ValueError("資料源標的資訊格式無效；未替換原有資料")
    currency = meta.get("currency")
    if currency != "USD":
        raise ValueError(f"此面板目前僅支援美元標的；資料源幣別為 {currency}")
    name = display_name(meta, symbol)
    exchange = meta.get("exchangeName")
    exchange = exchange.strip() or None if isinstance(exchange, str) else None
    if symbol == "SPCX" and not any(s in name.lower() for s in ("space exploration", "spacex")):
        raise ValueError(f"SPCX 身分待確認：資料源回傳 {name}，未匯入以免混用舊 ETF")
    frame = frame.copy()
    index = pd.to_datetime(frame.index, errors="coerce")
    if index.isna().any():
        raise ValueError("資料源日線日期無效；未替換原有資料")
    frame["date"] = [str(d.date()) for d in index]
    frame = frame[frame["date"] <= latest_completed_session()]
    if symbol == "SPCX":
        frame = frame[frame["date"] >= "2026-06-12"]
    frame = frame.rename(columns={"Open": "open", "High": "high", "Low": "low",
                                  "Close": "close", "Adj Close": "adj_close", "Volume": "volume"})
    columns = ["open", "high", "low", "close", "adj_close", "volume"]
    if "adj_close" not in frame:
        raise ValueError("資料源未提供調整收盤價")
    frame = validate_bars(frame)
    records = [(symbol, row.date, *[float(getattr(row, col)) for col in columns])
               for row in frame.itertuples()]
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol=?", (symbol,))
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", records)
        db.execute("""INSERT INTO datasets
          (symbol,name,currency,exchange,fetched_at,last_date,bar_count,status,error)
          VALUES (?,?,?,?,?,?,?,'ok',NULL) ON CONFLICT(symbol) DO UPDATE SET
          name=excluded.name,currency=excluded.currency,exchange=excluded.exchange,
          fetched_at=excluded.fetched_at,last_date=excluded.last_date,
          bar_count=excluded.bar_count,status='ok',error=NULL""",
          (symbol, name, currency, exchange, store.now(),
           frame["date"].max(), len(frame)))
    return {"symbol": symbol, "rows": len(frame), "last_date": frame["date"].max()}


UNIVERSE_LIMITS = (250, 500, 1000)


def universe_metadata():
    with store.connect() as db:
        row = db.execute("SELECT * FROM market_universe_metadata WHERE id=1").fetchone()
        count = db.execute("SELECT COUNT(*) FROM market_universe").fetchone()[0]
    if row:
        return {key: value for key, value in dict(row).items() if key != "id"}
    return {"requested_limit": next((limit for limit in UNIVERSE_LIMITS if count <= limit), 1000),
            "provider_total": None, "raw_count": None, "accepted_count": count,
            "pages": None, "discovered_at": None}


def discover_universe(universe_limit=250, progress=lambda message: None, check_cancel=lambda: None):
    import re
    import yfinance as yf
    if type(universe_limit) is not int or universe_limit not in UNIVERSE_LIMITS:
        raise ValueError("市場股票池上限須為 250、500 或 1000")
    query = yf.EquityQuery("and", [
        yf.EquityQuery("eq", ["region", "us"]),
        yf.EquityQuery("is-in", ["exchange", "NMS", "NYQ"]),
        yf.EquityQuery("gte", ["intradaymarketcap", 2_000_000_000]),
        yf.EquityQuery("gte", ["intradayprice", 5]),
        yf.EquityQuery("gte", ["avgdailyvol3m", 200_000]),
    ])
    entries, seen_pages = {}, set()
    offset, pages, provider_total = 0, 0, None
    timestamp = store.now()
    target = universe_limit
    while offset < target:
        check_cancel()
        size = min(250, target - offset)
        progress(f"建立市場股票池：第 {pages + 1}/{(target + 249) // 250} 頁 · 目標最多 {universe_limit} 檔")
        response = yf.screen(query, size=size, offset=offset, sortField="intradaymarketcap", sortAsc=False)
        check_cancel()
        if not isinstance(response, dict):
            raise ValueError("市場股票池分頁回應異常，保留原股票池")
        total, start, quotes = response.get("total"), response.get("start"), response.get("quotes")
        if type(total) is not int or total < 0 or type(start) is not int or start != offset or not isinstance(quotes, list):
            raise ValueError("市場股票池分頁資訊不完整或位移錯誤，保留原股票池")
        if provider_total is not None and total != provider_total:
            raise ValueError("市場股票池總數在分頁期間改變，請重試；保留原股票池")
        provider_total = total
        target = min(universe_limit, total)
        expected = min(size, max(0, total - offset))
        if len(quotes) != expected:
            raise ValueError("市場股票池分頁筆數不足或超出預期，保留原股票池")
        signature = tuple(q.get("symbol") if isinstance(q, dict) and isinstance(q.get("symbol"), str) else None for q in quotes)
        if signature in seen_pages:
            raise ValueError("資料源重複回傳相同股票池頁面，保留原股票池")
        seen_pages.add(signature)
        for quote in quotes:
            if not isinstance(quote, dict):
                continue
            symbol = quote.get("symbol", "")
            exchange = quote.get("exchange")
            market_cap = eligible_market_cap(quote.get("marketCap"))
            if (market_cap is not None and isinstance(symbol, str) and quote.get("quoteType") == "EQUITY" and quote.get("currency") == "USD"
                    and isinstance(exchange, str) and exchange in {"NMS", "NYQ"} and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", symbol)):
                entries.setdefault(symbol, (symbol, display_name(quote, symbol),
                                            f"Yahoo Equity Screener · 市值排序擷取最多 {universe_limit} 檔",
                                            timestamp, market_cap))
        pages += 1
        offset += len(quotes)
        if not quotes:
            break
    if len(entries) < 20:
        raise ValueError("市場股票池回傳不足 20 檔，保留原清單；請稍後重試")
    check_cancel()
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        check_cancel()
        db.execute("DELETE FROM market_universe")
        db.executemany("INSERT INTO market_universe VALUES (?,?,?,?,?)", list(entries.values()))
        db.execute("""INSERT INTO market_universe_metadata
            (id,requested_limit,provider_total,raw_count,accepted_count,pages,discovered_at)
            VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            requested_limit=excluded.requested_limit,provider_total=excluded.provider_total,
            raw_count=excluded.raw_count,accepted_count=excluded.accepted_count,
            pages=excluded.pages,discovered_at=excluded.discovered_at""",
            (universe_limit, provider_total, offset, len(entries), pages, timestamp))
    progress(f"股票池已建立：目標最多 {universe_limit} 檔，取得 {len(entries)} 檔有效標的（資料源符合條件共 {provider_total} 檔）")
    return len(entries)


def refresh(progress=lambda message: None, scope="portfolio", symbols=None, check_cancel=lambda: None, universe_limit=250):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    check_cancel()
    if scope == "market" and symbols is None:
        progress(f"正在從美股市場建立候選股票池（最多 {universe_limit} 檔）")
        discover_universe(universe_limit, progress=progress, check_cancel=check_cancel)
    members = store.universe(scope) if symbols is None else [{"symbol": symbol} for symbol in dict.fromkeys(symbols)]
    results = []

    def fetch(position):
        # Keep cancellation outside the provider-error handler: cancelling a job
        # must not overwrite a valid dataset with a spurious download error.
        check_cancel()
        symbol = position["symbol"]
        try:
            return {**fetch_symbol(symbol), "status": "ok"}
        except Exception as exc:
            error = str(exc)[:400]
            with store.connect() as db:
                db.execute("""INSERT INTO datasets (symbol,status,error) VALUES (?,'error',?)
                  ON CONFLICT(symbol) DO UPDATE SET status='error',error=excluded.error""", (symbol, error))
            return {"symbol": symbol, "status": "error", "error": error}

    with ThreadPoolExecutor(max_workers=4 if scope == "market" else 1) as pool:
        pending = [pool.submit(fetch, member) for member in members]
        for task in as_completed(pending):
            result = task.result()
            results.append(result)
            progress(f"已更新 {len(results)}/{len(members)} 檔 · {result['symbol']}")
    check_cancel()
    return results
