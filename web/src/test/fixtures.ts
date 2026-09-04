import type { Backtest, Overview, Position, Signal } from '../types'

export function position(symbol = 'NVDA', signals: Signal[] = []): Position {
  return {
    symbol,
    name: `${symbol} company`,
    shares: 1.25,
    cost: 100,
    sector: 'Technology',
    source: 'test',
    snapshot_price: null,
    snapshot_change: null,
    price: 120,
    change: 1,
    change_pct: 0.84,
    market_value: 150,
    pnl: 25,
    pnl_pct: 20,
    weight: 100,
    price_date: '2026-09-04',
    sparkline: [],
    research: { symbol, date: '2026-09-04', bars: 250, indicators: {}, signals },
    dataset: null,
  }
}
export function overview(): Overview {
  return {
    positions: [position()],
    market_universe: [
      { symbol: 'NVDA', name: 'NVIDIA', discovered_at: '2026-09-05' },
      { symbol: 'DELL', name: 'Dell Technologies', discovered_at: '2026-09-05' },
    ],
    strategies: ['turtle', 'trend', 'pullback', 'rps'].map((id, i) => ({
      id,
      name: ['海龜突破', '均線趨勢', '回檔觀察', '相對強勢'][i],
      english: id,
      period: 200,
      description: `${id} description`,
      rules: ['Rule'],
      origin: 'AlphaView',
    })),
    summary: {
      market_value: 150,
      pnl: 25,
      pnl_pct: 20,
      day_change: 1,
      day_change_pct: 0.84,
      holding_count: 1,
      watch_count: 0,
      priced_count: 1,
      dates: ['2026-09-04'],
      matched_count: 0,
      partial: false,
      mixed_dates: false,
    },
    scan: null,
    scan_dates: [],
    market_scan: null,
    market_scan_dates: [],
    datasets: [],
    jobs: [],
    server_time: '2026-09-05',
  }
}
export function backtest(symbol = 'NVDA', strategy = 'turtle', method = 'Fresh result'): Backtest {
  return {
    symbol,
    strategy,
    start: '2025-09-04',
    end: '2026-09-04',
    initial: 10000,
    final: 12000,
    return_pct: 20,
    benchmark_pct: 10,
    max_drawdown_pct: -4,
    trades: [],
    open_position: null,
    curve: [],
    method,
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
