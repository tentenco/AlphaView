import json

import numpy as np
import pandas as pd

from . import store

STRATEGIES = [
    {"id": "turtle", "name": "海龜突破", "english": "Turtle breakout", "period": 21,
     "description": "收盤突破前 20 日高點，配合上漲陽線與成交量確認。",
     "rules": ["收盤 > 前 20 日最高價（不含當日）", "收盤 > 開盤且高於前日收盤", "成交量 ≥ 前 20 日均量"],
     "origin": "以價格突破、陽線與相對成交量確認訊號。"},
    {"id": "trend", "name": "均線趨勢", "english": "Trend following", "period": 200,
     "description": "辨識長期上升趨勢中，價格與成交量同步轉強的標的。",
     "rules": ["收盤 > MA50 > MA200", "成交量 ≥ 前 20 日均量的 1.2 倍"],
     "origin": "結合 50 日與 200 日均線，並要求成交量確認。"},
    {"id": "pullback", "name": "回檔觀察", "english": "RSI pullback", "period": 200,
     "description": "在長期多頭架構中尋找短線回檔，不將超賣直接視為買點。",
     "rules": ["收盤 > MA200", "14 日 Wilder RSI 介於 30–45", "收盤 > 前日收盤"],
     "origin": "RSI 使用 Wilder 平滑；訊號需同時滿足長期趨勢與轉強條件。"},
    {"id": "rps", "name": "相對強勢", "english": "Relative strength", "period": 121,
     "description": "比較所選股票池內 120 日報酬，找出接近區間高點的領先標的。",
     "rules": ["120 日報酬在同日有效股票池排名 ≥ 80 百分位", "收盤 ≥ 120 日最高價的 90%", "至少 3 檔具足夠歷史資料"],
     "origin": "排名僅限所選股票池，並非全美股排名。"},
]


def finite(value):
    return round(float(value), 6) if pd.notna(value) and np.isfinite(value) else None


def indicators(frame):
    from .market import history_quality
    quality = history_quality(frame)
    df = frame.copy()
    df["date"] = df["date"].astype(str)
    df = df.sort_values("date").reset_index(drop=True)
    df.attrs["data_quality"] = quality
    if df.empty:
        return df
    for column in ("open", "high", "low", "close", "adj_close", "volume"):
        df[column] = pd.to_numeric(df[column], errors="coerce")
    factor = df["adj_close"] / df["close"]
    for col in ("open", "high", "low", "close"):
        df[col] = df[col] * factor
    for n in (20, 50, 200):
        df[f"ma{n}"] = df.close.rolling(n).mean()
    df["high20"] = df.high.shift(1).rolling(20).max()
    df["low10"] = df.low.shift(1).rolling(10).min()
    df["high120"] = df.high.rolling(120).max()
    df["volume_ratio"] = df.volume / df.volume.shift(1).rolling(20).mean().replace(0, np.nan)
    df["return120"] = df.close.pct_change(120)
    delta = df.close.diff()
    gain, loss = delta.clip(lower=0), -delta.clip(upper=0)
    avg_gain, avg_loss = gain.copy() * np.nan, loss.copy() * np.nan
    if len(df) > 14:
        avg_gain.iloc[14], avg_loss.iloc[14] = gain.iloc[1:15].mean(), loss.iloc[1:15].mean()
        for i in range(15, len(df)):
            avg_gain.iloc[i] = (avg_gain.iloc[i - 1] * 13 + gain.iloc[i]) / 14
            avg_loss.iloc[i] = (avg_loss.iloc[i - 1] * 13 + loss.iloc[i]) / 14
    df["rsi"] = 100 - 100 / (1 + avg_gain / avg_loss.replace(0, np.nan))
    df.loc[(avg_loss == 0) & (avg_gain > 0), "rsi"] = 100
    df.loc[(avg_loss == 0) & (avg_gain == 0), "rsi"] = 50
    df["turtle"] = (df.close > df.high20) & (df.close > df.open) & (df.close > df.close.shift()) & (df.volume_ratio >= 1)
    df["trend"] = (df.close > df.ma50) & (df.ma50 > df.ma200) & (df.volume_ratio >= 1.2)
    df["pullback"] = (df.close > df.ma200) & df.rsi.between(30, 45) & (df.close > df.close.shift())
    return df


def evaluate(frames, as_of):
    sliced = {symbol: frame[frame.date <= as_of] for symbol, frame in frames.items()}
    qualities = {}
    for symbol, frame in sliced.items():
        issues = [issue for issue in frames[symbol].attrs.get("data_quality", {}).get("issues", [])
                  if issue["date"] is None or issue["date"] <= as_of]
        qualities[symbol] = {"status": "data_error" if issues else "ok" if len(frame) else "no_data",
                             "valid": not bool(issues) and bool(len(frame)), "checked_rows": len(frame),
                             "invalid_count": len(issues), "issues": issues}
    returns = {s: f.iloc[-1].return120 for s, f in sliced.items()
               if qualities[s]["valid"] and len(f) >= 121 and f.iloc[-1].date == as_of and pd.notna(f.iloc[-1].return120)}
    ranks = pd.Series(returns, dtype=float).rank(pct=True) * 100
    result = []
    for symbol, frame in sliced.items():
        quality = qualities[symbol]
        if quality["status"] == "data_error":
            reason = "日線資料異常，暫不產生訊號：" + "；".join(
                f"{issue['date'] or '日期未知'} {issue['reason']}" for issue in quality["issues"][:3])
            result.append({"symbol": symbol, "date": frame.iloc[-1].date if len(frame) else None,
                           "bars": len(frame), "indicators": {}, "quality": quality, "signals": [
                               {"strategy": st["id"], "status": "data_error", "matched": False, "reason": reason}
                               for st in STRATEGIES]})
            continue
        if frame.empty:
            result.append({"symbol": symbol, "date": None, "bars": 0, "indicators": {}, "signals": [
                {"strategy": st["id"], "status": "insufficient", "matched": False,
                 "reason": f'需要 {st["period"]} 個交易日；目前無資料'} for st in STRATEGIES]})
            continue
        last = frame.iloc[-1]
        metrics = {k: finite(last[k]) for k in ["close", "ma20", "ma50", "ma200", "high20", "high120", "volume_ratio", "rsi", "return120"]}
        metrics["rps"] = finite(ranks.get(symbol, np.nan))
        signals = []
        for st in STRATEGIES:
            available = len(frame) >= st["period"]
            if last.date != as_of:
                status, matched, reason = "stale", False, f"最新日線為 {last.date}，不納入 {as_of} 選股"
            elif not available or (st["id"] == "rps" and len(ranks) < 3):
                status, matched, reason = "insufficient", False, f'需要 {st["period"]} 日；目前 {len(frame)} 日'
                if st["id"] == "rps" and len(ranks) < 3:
                    reason += "；同日有效比較標的不足 3 檔"
            else:
                matched = bool(ranks.get(symbol, 0) >= 80 and last.close >= last.high120 * .9) if st["id"] == "rps" else bool(last[st["id"]])
                status = "match" if matched else "watch"
                if matched:
                    reason = "符合全部條件"
                else:
                    failures = []
                    if st["id"] == "turtle":
                        if last.close <= last.high20:
                            failures.append(f"尚未突破前 20 日高點 {last.high20:.2f}")
                        if not (last.close > last.open and last.close > frame.iloc[-2].close):
                            failures.append("未形成上漲陽線")
                        if last.volume_ratio < 1:
                            failures.append(f"量比 {last.volume_ratio:.2f}×，低於 1×")
                    elif st["id"] == "trend":
                        if last.close <= last.ma50:
                            failures.append(f"收盤未高於 MA50 {last.ma50:.2f}")
                        if last.ma50 <= last.ma200:
                            failures.append("MA50 未高於 MA200")
                        if last.volume_ratio < 1.2:
                            failures.append(f"量比 {last.volume_ratio:.2f}×，低於 1.2×")
                    elif st["id"] == "pullback":
                        if last.close <= last.ma200:
                            failures.append(f"收盤未高於 MA200 {last.ma200:.2f}")
                        if not 30 <= last.rsi <= 45:
                            failures.append(f"RSI {last.rsi:.1f}，不在 30–45 區間")
                        if last.close <= frame.iloc[-2].close:
                            failures.append("收盤尚未轉為上漲")
                    else:
                        if ranks.get(symbol, 0) < 80:
                            failures.append(f"股票池內 RPS {ranks.get(symbol, 0):.1f}，低於 80")
                        if last.close < last.high120 * .9:
                            failures.append(f"收盤低於 120 日高點的 90%（{last.high120 * .9:.2f}）")
                    reason = "；".join(failures) or "尚未符合全部條件"
            signals.append({"strategy": st["id"], "status": status, "matched": matched, "reason": reason})
        result.append({"symbol": symbol, "date": last.date, "bars": len(frame), "indicators": metrics, "signals": signals})
    return result


def scan(progress=lambda message: None, scope="portfolio", check_cancel=None):
    """Publish an entire dated scan batch, ordered against cancellation requests.

    check_cancel must only read state or raise: it runs while the publication
    transaction owns SQLite's writer reservation. Progress callbacks that write
    job status must stay outside that transaction.
    """
    previous = store.latest_scan(scope=scope)
    positions = store.universe(scope)
    frames = {p["symbol"]: indicators(store.history(p["symbol"])) for p in positions}
    observed_dates = {d for f in frames.values() for d in f.get("date", [])}
    dates = sorted(d for d in observed_dates
                   if pd.notna(pd.to_datetime(d, format="%Y-%m-%d", errors="coerce")))[-60:]
    if not dates:
        raise ValueError("尚無歷史日線，請先更新行情")
    timestamp = store.now()
    names = {p["symbol"]: p["name"] for p in positions}
    batch = []
    universe_json = json.dumps(list(frames))
    for index, as_of in enumerate(dates):
        progress(f"計算每日選股 {index + 1}/{len(dates)}：{as_of}")
        results = evaluate(frames, as_of)
        for row in results:
            row["name"] = names[row["symbol"]]
        batch.append((timestamp, as_of, universe_json,
                      json.dumps(results, ensure_ascii=False, allow_nan=False), scope))
    # Readers keep seeing the previous complete run until every date succeeds.
    # A calculation, serialization, or insertion failure publishes no partial run.
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if check_cancel is not None:
            check_cancel()
        db.executemany("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES (?,?,?,?,?)", batch)
    return {"dates": len(dates), "as_of": dates[-1], "symbols": len(frames),
            "matched_symbols": [r["symbol"] for r in results if any(s["matched"] for s in r["signals"])],
            "data_error_symbols": [r["symbol"] for r in results if r.get("quality", {}).get("status") == "data_error"],
            "unchanged": previous is not None and previous["result"] == results}


BACKTEST_ENGINE_VERSION = "alphaview-backtest-v3"


def _backtest_inputs(symbol, strategy, initial, fee_bps, start_date, end_date):
    from datetime import date
    import re
    if strategy not in {"turtle", "trend", "pullback"}:
        raise ValueError("回測支援海龜突破、均線趨勢與回檔觀察")
    try:
        if isinstance(initial, bool) or isinstance(fee_bps, bool):
            raise ValueError
        initial, fee_bps = float(initial), float(fee_bps)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("回測資金與成本必須為有效數值") from exc
    if not np.isfinite(initial) or initial <= 0:
        raise ValueError("回測起始資金必須為有限且大於零的數值")
    if not np.isfinite(fee_bps) or not 0 <= fee_bps <= 100:
        raise ValueError("單邊交易成本必須介於 0–100 bps（0–1%）")
    for value in (start_date, end_date):
        if value is not None:
            try:
                if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError
                date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError("回測日期必須為有效的 YYYY-MM-DD 日期") from exc
    if start_date and end_date and start_date > end_date:
        raise ValueError("回測開始日期不可晚於結束日期")
    raw = store.history(symbol)
    if end_date and not raw.empty:
        dates = raw.date.astype(str)
        valid_date = dates.str.fullmatch(r"\d{4}-\d{2}-\d{2}") & pd.to_datetime(
            dates, format="%Y-%m-%d", errors="coerce").notna()
        # Do not validate or fingerprint future bars for a historical run.
        # Undatable records remain included so they fail validation explicitly.
        raw = raw[(dates <= end_date) | ~valid_date]
    if raw.empty:
        raise ValueError("指定回測期間沒有可用日線")
    from .market import validate_bars
    return validate_bars(raw), {"initial": initial, "fee_bps": fee_bps,
                                "start_date": start_date, "end_date": end_date}


def _backtest_fingerprint(symbol, strategy, raw, parameters):
    import hashlib
    columns = ["date", "open", "high", "low", "close", "adj_close", "volume"]
    observations = [[str(row[0]), *[float(value) for value in row[1:]]]
                    for row in raw[columns].itertuples(index=False, name=None)]
    payload = {"engine_version": BACKTEST_ENGINE_VERSION, "symbol": symbol,
               "strategy": strategy, "parameters": parameters, "bars": observations}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def backtest_input_fingerprint(symbol, strategy, initial=10000, fee_bps=10, start_date=None, end_date=None):
    """Compare cached inputs without rerunning indicators or trade simulation."""
    raw, parameters = _backtest_inputs(symbol, strategy, initial, fee_bps, start_date, end_date)
    return _backtest_fingerprint(symbol, strategy, raw, parameters)


def backtest(symbol, strategy, initial=10000, fee_bps=10, start_date=None, end_date=None):
    from datetime import date
    raw, parameters = _backtest_inputs(symbol, strategy, initial, fee_bps, start_date, end_date)
    initial, fee_bps = parameters["initial"], parameters["fee_bps"]
    warmup = 200 if strategy != "turtle" else 21
    minimum_sessions = 2 if start_date or end_date else 20
    if len(raw) < warmup + minimum_sessions:
        raise ValueError(f"回測至少需要 {warmup + minimum_sessions} 個交易日（含暖機），目前 {len(raw)} 日")
    df = indicators(raw)
    eligible = df.index[(df.index >= warmup) & (df.date >= (start_date or df.iloc[0].date))]
    if len(eligible) < minimum_sessions:
        raise ValueError(f"指定期間至少需要 {minimum_sessions} 個暖機後交易日，目前 {len(eligible)} 日")
    start = int(eligible[0])
    adjusted_prices = df[["open", "high", "low", "close"]]
    if not np.isfinite(adjusted_prices).all().all() or not (adjusted_prices > 0).all().all():
        raise ValueError("調整後日線包含無效價格，無法回測；請重新更新行情")
    if df[strategy].iloc[start - 1:].isna().any():
        raise ValueError("回測訊號包含缺值；請重新更新行情")
    cash, units, entry, trades = initial, 0.0, None, []
    curve, values, closed_pnls = [], [initial], []
    fee = fee_bps / 10000
    benchmark_units = initial / df.iloc[start].open
    exposed_sessions = 0
    for i in range(start, len(df)):
        prior, bar = df.iloc[i - 1], df.iloc[i]
        exit_signal = (prior.close < prior.low10) if strategy == "turtle" else (
            prior.close < prior.ma50 if strategy == "trend" else prior.rsi >= 60 or prior.close < prior.ma200)
        if units and exit_signal:
            gross = units * bar.open
            exit_fee = gross * fee
            cash = gross - exit_fee
            net_pnl = cash - entry["capital"]
            closed_pnls.append(net_pnl)
            trades.append({"entry_date": entry["date"], "exit_date": bar.date,
                           "return_pct": round((cash / entry["capital"] - 1) * 100, 2),
                           "entry_price": entry["price"], "exit_price": finite(bar.open),
                           "entry_fee": round(entry["fee"], 6), "exit_fee": round(exit_fee, 6),
                           "net_pnl": round(net_pnl, 6),
                           "holding_days": (date.fromisoformat(bar.date) - date.fromisoformat(entry["date"])).days})
            units, entry = 0, None
        elif not units and bool(prior[strategy]):
            entry = {"date": bar.date, "capital": cash, "price": finite(bar.open), "fee": cash * fee}
            units, cash = cash * (1 - fee) / bar.open, 0
            entry["units"] = float(units)
        value = cash + units * bar.close
        benchmark = benchmark_units * bar.close
        if not np.isfinite([cash, units, value, benchmark]).all() or value <= 0 or benchmark <= 0:
            raise ValueError("回測計算超出有效數值範圍；請檢查日線價格")
        exposed_sessions += bool(units)
        values.append(float(value))
        # Preserve accounting precision; the UI formats currency for display.
        curve.append({"date": bar.date, "value": float(value), "benchmark": float(benchmark)})
    series = pd.Series(values)
    daily_returns = series.pct_change().iloc[1:]
    volatility = float(daily_returns.std(ddof=1)) if len(daily_returns) > 1 else np.nan
    sharpe = float(daily_returns.mean()) / volatility * np.sqrt(252) if volatility > 1e-12 else np.nan
    elapsed_days = (date.fromisoformat(df.iloc[-1].date) - date.fromisoformat(df.iloc[start].date)).days
    with np.errstate(over="ignore", invalid="ignore"):
        cagr = np.expm1(np.log(values[-1] / initial) * 365.25 / elapsed_days) * 100 if elapsed_days > 0 else np.nan
    profits = sum(pnl for pnl in closed_pnls if pnl > 0)
    losses = -sum(pnl for pnl in closed_pnls if pnl < 0)
    warnings = []
    if len(trades) < 30:
        warnings.append(f"僅 {len(trades)} 筆已平倉交易，樣本不足；勝率與獲利因子不宜用來判斷策略可靠度。")
    if len(curve) < 126:
        warnings.append(f"僅 {len(curve)} 個回測交易日，期間偏短；年化數值可能放大短期波動。")
    if not closed_pnls:
        warnings.append("尚無已平倉交易，勝率、獲利因子與平均持有天數無法計算。")
    elif losses == 0:
        warnings.append("尚無虧損的已平倉交易，獲利因子未定義。")
    if not np.isfinite(cagr):
        warnings.append("年化報酬超出有效數值範圍，未顯示 CAGR。")
    if start_date and start_date < df.iloc[warmup].date:
        warnings.append(f"指定起日缺乏足夠暖機資料，實際從 {df.iloc[start].date} 開始回測。")
    if entry:
        entry["fee"] = round(entry["fee"], 6)
    return {"symbol": symbol, "strategy": strategy, "start": df.iloc[start].date, "end": df.iloc[-1].date,
            "initial": initial, "final": curve[-1]["value"], "return_pct": round((curve[-1]["value"] / initial - 1) * 100, 2),
            "benchmark_pct": round((curve[-1]["benchmark"] / initial - 1) * 100, 2),
            "max_drawdown_pct": round(float((series / series.cummax() - 1).min()) * 100, 2),
            "trades": trades, "open_position": entry, "curve": curve,
            "cagr_pct": finite(cagr), "annualized_volatility_pct": finite(volatility * np.sqrt(252) * 100),
            "sharpe_ratio": finite(sharpe), "win_rate_pct": finite(100 * sum(p > 0 for p in closed_pnls) / len(closed_pnls)) if closed_pnls else None,
            "profit_factor": finite(profits / losses) if losses > 0 else None,
            "exposure_pct": round(exposed_sessions / len(curve) * 100, 6),
            "avg_holding_days": finite(np.mean([t["holding_days"] for t in trades])) if trades else None,
            "trading_days": len(curve), "elapsed_days": elapsed_days, "warnings": warnings,
            "engine_version": BACKTEST_ENGINE_VERSION,
            "input_fingerprint": _backtest_fingerprint(symbol, strategy, raw, parameters),
            "parameters": parameters, "benchmark_symbol": symbol,
            "method": f"前一日收盤確認訊號，次日開盤成交；單一標的、全額投入、僅做多；每次買賣扣 {fee_bps:g} bps（{fee_bps / 100:g}%）費用與滑價。"
                      "使用含股息調整日線；未平倉按末日收盤評價。基準為同一標的、相同起日開盤買入持有（未扣費），並非市場指數。"
                      "CAGR 以首末交易日期間的日曆天數／365.25 年化；波動率與 Sharpe 使用每日淨值報酬、252 日年化、樣本標準差、零無風險利率，包含首日開盤至收盤報酬。"
                      "曝險率為收盤仍持有部位的交易日比例；勝率、獲利因子與平均持有天數僅計已平倉交易。回測資金與持股成本分開計算。"}
