"""Same-window adjusted-price comparisons, using only the local read snapshot."""
import math
import re
import sqlite3
import time

import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from . import sessions, store
from .risk import valid_bar

router = APIRouter()
COMPARISON_ENGINE_VERSION = 'alphaview-comparison-v1'
MAX_SECONDS = 10


def requested_symbols(value):
    symbols = [part.strip().upper() for part in value.split(',')]
    if not 2 <= len(symbols) <= 5 or len(set(symbols)) != len(symbols):
        raise HTTPException(422, '請選擇 2 至 5 檔不重複標的')
    if any(not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', symbol) for symbol in symbols):
        raise HTTPException(422, '標的代碼格式無效')
    return symbols


def metadata_reason(symbol, dataset, aggregate, as_of):
    if not dataset or dataset['status'] != 'ok' or dataset['error']:
        return '來源更新未成功或缺少來源紀錄'
    if dataset['currency'] != 'USD':
        return '無法確認美元標的資訊'
    name, exchange = dataset['name'], dataset['exchange']
    if not isinstance(name, str) or not name.strip() or name.strip().upper() == symbol:
        return '缺少實際標的名稱，身份尚未確認'
    if not isinstance(exchange, str) or not exchange.strip():
        return '缺少交易所資訊'
    if dataset['source'] != 'Yahoo Finance / yfinance':
        return '快取來源無法確認'
    if dataset['bar_count'] != aggregate['total']:
        return '來源筆數與已儲存日線不一致'
    if dataset['last_date'] != as_of or aggregate['last'] != as_of:
        return '日線尚未涵蓋最新已收盤交易日或包含未完成日期'
    if symbol == 'SPCX' and (not any(word in name.lower() for word in ('space exploration', 'spacex'))
                             or (aggregate['first'] and aggregate['first'] < '2026-06-12')):
        return 'SPCX 身份或上市日期尚未通過確認'
    return None


def report(symbols, window=60):
    symbols = requested_symbols(','.join(symbols))
    if window not in (60, 120, 252):
        raise HTTPException(422, '比較期間必須為 60、120 或 252 個交易日')
    deadline = time.monotonic() + MAX_SECONDS
    as_of = sessions.latest_completed_session()
    dates = sessions.expected_sessions((pd.Timestamp(as_of) - pd.Timedelta(days=500)).date().isoformat(), as_of)[-(window + 1):]
    if len(dates) != window + 1:
        raise HTTPException(503, '交易日曆未涵蓋所需期間')
    date_set, series = set(dates), []
    try:
        with store.read_snapshot(), store.connect() as db:
            db.execute('PRAGMA busy_timeout=1000')
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            try:
                revision = store.input_revision(db)
                for symbol in symbols:
                    if time.monotonic() > deadline:
                        raise HTTPException(503, '標的比較逾時，請稍後重試')
                    member = db.execute('SELECT name FROM positions WHERE symbol=? UNION ALL SELECT name FROM market_universe WHERE symbol=? LIMIT 1', (symbol, symbol)).fetchone()
                    if member is None:
                        raise HTTPException(422, f'{symbol} 不在目前個人清單或美股候選池')
                    dataset = db.execute('SELECT * FROM datasets WHERE symbol=?', (symbol,)).fetchone()
                    aggregate = db.execute('SELECT COUNT(*) AS total,MIN(date) AS first,MAX(date) AS last FROM bars WHERE symbol=?', (symbol,)).fetchone()
                    rows = db.execute('SELECT * FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date LIMIT 502', (symbol, dates[0], as_of)).fetchall()
                    valid = {row['date']: float(row['adj_close']) for row in rows if row['date'] in date_set and valid_bar(row)}
                    observed = sum(row['date'] in date_set for row in rows)
                    reason = metadata_reason(symbol, dataset, aggregate, as_of)
                    if not reason and any(row['date'] not in date_set for row in rows):
                        reason = '期間包含非 XNYS 交易日日線'
                    if not reason and observed != len(dates):
                        reason = f'完整共同期間需要 {len(dates)} 筆日線，目前只有 {observed} 筆；不縮短期間或補值'
                    if not reason and len(valid) != len(dates):
                        reason = '共同期間包含無效日線；不跨越缺口'
                    points, anchor, latest, change = [], None, None, None
                    if not reason:
                        anchor, latest = valid[dates[0]], valid[dates[-1]]
                        for day in dates:
                            percentage = (valid[day] / anchor - 1) * 100
                            if not math.isfinite(percentage):
                                reason = '價格比例超出可計算範圍'
                                break
                            points.append({'date': day, 'return_pct': percentage})
                        if reason:
                            points, anchor, latest = [], None, None
                        else:
                            change = points[-1]['return_pct']
                    series.append({'symbol': symbol, 'name': member['name'],
                                   'source': dataset['source'] if dataset else None,
                                   'eligible': reason is None, 'reason': reason,
                                   'observed_prices': observed, 'valid_prices': len(valid),
                                   'anchor_price': anchor, 'latest_price': latest,
                                   'return_pct': change, 'points': points})
            finally:
                db.set_progress_handler(None, 0)
    except sqlite3.OperationalError as exc:
        code = getattr(exc, 'sqlite_errorcode', 0) & 0xFF
        if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_INTERRUPT):
            raise HTTPException(503, '資料庫忙碌或比較逾時，請稍後重試') from exc
        raise
    eligible = sum(row['eligible'] for row in series)
    return {'as_of': as_of, 'window': window, 'anchor_date': dates[0], 'end_date': dates[-1],
            'expected_prices': len(dates), 'requested_count': len(symbols), 'eligible_count': eligible,
            'complete': eligible == len(symbols), 'status': 'ready' if eligible >= 2 else 'insufficient',
            'dates': dates, 'input_revision': revision, 'comparison_engine_version': COMPARISON_ENGINE_VERSION,
            'series': series,
            'warnings': ['這是個別標的的調整價格比較，不是持股損益、投資組合績效或交易策略回測。',
                         '調整價格沿用本機來源資料，不另行重建股息或公司行動；不可當成已驗證的含息總報酬。'],
            'method': '所有可用標的使用同一組完整 XNYS 交易日，以共同起日調整收盤價為 0%；報酬 = (當日調整收盤價 / 起日調整收盤價 - 1) × 100。期間為指定數目的日報酬區間，需多一筆起始價格；缺值不補、缺日不跨越，也不以較短歷史替代。'}


@router.get('/api/comparison')
def comparison(symbols: str = Query(..., max_length=80), window: int = 60):
    return report(requested_symbols(symbols), window)
