"""Research Desk on synthetic bars only: isolated database, hand-checkable trades, no providers."""
import csv
import io
import json
import math
from unittest.mock import patch

import numpy as np
import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import research_desk as rd
from alphaview.panel import sessions, store

AS_OF = "2024-12-31"


def business_days(count, start="2023-01-03"):
    days = sessions.expected_sessions(start, "2026-12-31")
    assert len(days) >= count
    return days[:count]


def insert_bars(symbol, closes, *, opens=None, volumes=None, adj=None, start="2023-01-03"):
    days = business_days(len(closes), start)
    opens = opens or closes
    volumes = volumes or [1000.0] * len(closes)
    adj = adj or closes
    with store.connect() as db:
        db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        for day, o, c, v, a in zip(days, opens, closes, volumes, adj):
            db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", (symbol, day, o, max(o, c) * 1.001, min(o, c) * 0.999, c, a, v))
    return days


def wave(count=400, base=100.0, amplitude=0.25, period=60, drift=0.0005):
    return [base * (1 + drift) ** i * (1 + amplitude * math.sin(2 * math.pi * i / period)) for i in range(count)]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "desk.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("Unexpected network request"))
    store.init_db()
    app = FastAPI()
    app.include_router(rd.router)
    with TestClient(app) as value:
        yield value


def tournament(client, **changes):
    body = {"symbols": ["SYNTA"], "configs": [{"strategy": "buy_hold"}, {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}],
            "save": False, **changes}
    response = client.post("/api/research-desk/tournament", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_wilder_rsi_matches_the_daily_screen_convention():
    from alphaview.panel import research
    import pandas as pd
    closes = wave(120, amplitude=0.1, period=17)
    frame = pd.DataFrame({"date": business_days(120), "open": closes, "high": closes, "low": closes, "close": closes,
                          "adj_close": closes, "volume": [1.0] * 120})
    screen = research.indicators(frame)["rsi"].to_numpy(float)
    mine = rd.wilder_rsi(np.array(closes), 14)
    both = np.isfinite(screen)
    assert np.array_equal(both, np.isfinite(mine)) and np.allclose(screen[both], mine[both], atol=1e-9)
    assert math.isnan(mine[13]) and rd.wilder_rsi(np.array([1.0] * 20), 14)[14] == 50.0
    assert rd.wilder_rsi(np.arange(1.0, 21.0), 14)[14] == 100.0


def test_next_open_fills_costs_and_hand_checked_round_trip(client):
    # Closes: flat 100, a jump to 120 then a fall to 90; opens differ so fills are observable.
    closes = [100.0] * 30 + [120.0] * 5 + [90.0] * 25
    opens = [c - 1 for c in closes]
    insert_bars("SYNTA", closes, opens=opens)
    series = rd.Series("SYNTA")
    entry = np.zeros(60, bool)
    exit_ = np.zeros(60, bool)
    entry[29], exit_[34] = True, True  # signals read on these closes
    risk = rd.Risk(initial_cash=10000, fee_bps=10, slippage_bps=50).model_dump()
    run = rd.simulate(series, entry, exit_, np.ones(60, bool), 20, 60, risk)
    trade = run["trades"][0]
    buy_fill, sell_fill = opens[30] * 1.005, opens[35] * 0.995
    units = 10000 / 1.001 / buy_fill
    proceeds = units * sell_fill * (1 - 0.001)
    assert trade["entry_date"] == series.dates[30] and trade["signal_date"] == series.dates[29]
    assert trade["exit_date"] == series.dates[35] and trade["exit_reason"] == "signal"
    assert trade["entry_price"] == pytest.approx(buy_fill) and trade["exit_price"] == pytest.approx(sell_fill)
    assert trade["net_pnl"] == pytest.approx(proceeds - 10000) and trade["holding_sessions"] == 5
    assert run["values"][-1] == pytest.approx(proceeds) and run["open_position"] is None
    summary = rd.metrics(series, run)
    assert summary["closed_trades"] == 1 and summary["wins"] == 0 and summary["profit_factor"] == 0
    assert summary["gross_loss"] == pytest.approx(10000 - proceeds, abs=0.01) and summary["win_rate_pct"] == 0
    assert summary["exposure_pct"] == pytest.approx(5 / 40 * 100) and summary["largest_loss_pct"] < -20
    idle = rd.metrics(series, rd.simulate(series, np.zeros(60, bool), np.zeros(60, bool), np.ones(60, bool), 20, 60, risk))
    assert idle["closed_trades"] == 0 and idle["return_pct"] == 0 and idle["profit_factor"] is None
    assert idle["gross_loss"] == 0 and math.copysign(1, idle["gross_loss"]) == 1 and idle["win_rate_pct"] is None


def test_close_confirmed_stop_and_target_exit_next_open_without_same_bar_reentry(client):
    closes = [100.0] * 25 + [96.0, 94.0, 94.0, 94.0, 94.0] + [100.0] * 10 + [130.0] * 10
    insert_bars("SYNTA", closes)
    series = rd.Series("SYNTA")
    always = np.ones(50, bool)
    risk = rd.Risk(initial_cash=10000, fee_bps=0, stop_loss_pct=5, take_profit_pct=20).model_dump()
    run = rd.simulate(series, always, np.zeros(50, bool), always, 21, 50, risk)
    reasons = [(t["exit_reason"], t["exit_index"]) for t in run["trades"]]
    assert reasons[0] == ("stop_loss", 27)  # close 94 on session 26 breaches 100 × 0.95, exit at session 27's open
    assert run["trades"][1]["entry_index"] == 28  # re-entry waits one session after the exit
    assert any(reason == "take_profit" for reason, _ in reasons)


def test_signals_are_well_defined_and_exact_for_each_family(client):
    closes = wave(300, amplitude=0.2, period=40)
    insert_bars("SYNTA", closes, volumes=[1000.0 + 500 * math.sin(i / 3) for i in range(300)])
    series = rd.Series("SYNTA")
    configs = [{"strategy": key, "params": rd.normalize_params(key, {})} for key in rd.STRATEGIES]
    for config in configs:
        entry, exit_, valid = rd.signals(series, config)
        assert entry.dtype == bool and exit_.dtype == bool and not (entry & ~valid).any() and not (exit_ & ~valid).any()
    fast, slow = series.sma(20), series.sma(50)
    entry, exit_, valid = rd.signals(series, {"strategy": "sma_cross", "params": {"fast": 20, "slow": 50}})
    crosses = [i for i in range(51, 300) if fast[i] > slow[i] and fast[i - 1] <= slow[i - 1]]
    assert list(np.flatnonzero(entry)) == crosses and rd.warmup_start(valid) == 51
    upper = [max(series.high[i - 20:i]) for i in range(20, 300)]
    entry, _, valid = rd.signals(series, {"strategy": "donchian_breakout", "params": {"entry_period": 20, "exit_period": 10}})
    assert [bool(entry[i]) for i in range(20, 300)] == [series.close[i] > upper[i - 20] for i in range(20, 300)]
    assert rd.warmup_start(valid) == 21


@pytest.mark.parametrize("params,error", [({"fast": 50, "slow": 20}, "快線"), ({"fast": 2.5}, "整數"), ({"fast": True}, None),
                                          ({"unknown": 1}, "不支援"), ({"slow": 401}, "介於")])
def test_config_validation_is_strict_without_coercing_or_clamping(client, params, error):
    response = client.post("/api/research-desk/tournament", json={"symbols": ["SYNTA"], "configs": [{"strategy": "sma_cross", "params": params}]})
    assert response.status_code == 422
    if error:
        assert error in response.text


def test_request_bounds_duplicates_and_oos_share(client):
    base = {"symbols": ["SYNTA"], "configs": [{"strategy": "buy_hold"}]}
    for change in ({"oos_pct": 5}, {"oos_pct": 60}, {"symbols": ["SYNTA", "SYNTA"]}, {"symbols": ["bad"]},
                   {"configs": [{"strategy": "buy_hold"}, {"strategy": "buy_hold", "params": {}}]},
                   {"symbols": [f"S{i}" for i in range(11)]}, {"start_date": "2024-02-30"},
                   {"start_date": "2024-06-01", "end_date": "2024-01-01"}, {"risk": {"fee_bps": 101}},
                   {"risk": {"stop_loss_pct": 0.1}}, {"risk": {"position_pct": 0}}, {"extra": 1}):
        assert client.post("/api/research-desk/tournament", json={**base, **change}).status_code == 422, change


def test_tournament_shares_windows_splits_out_of_sample_and_is_read_only(client):
    insert_bars("SYNTA", wave(400))
    insert_bars("SYNTB", wave(400, amplitude=0.1, period=90, drift=0.001))
    revision = store.input_revision()
    result = tournament(client, symbols=["SYNTA", "SYNTB", "SYNTC"], oos_pct=30)
    assert store.input_revision() == revision and json.dumps(result, allow_nan=False)
    missing = next(row for row in result["symbols"] if row["symbol"] == "SYNTC")
    assert missing["status"] == "unavailable" and missing["error"]["code"] == "no_history"
    symbol = next(row for row in result["symbols"] if row["symbol"] == "SYNTA")
    windows = symbol["windows"]
    assert windows["full"]["sessions"] == 400 - 21 and windows["out_of_sample"]["sessions"] == int(379 * 0.3)
    assert windows["in_sample"]["sessions"] + windows["out_of_sample"]["sessions"] == windows["full"]["sessions"]
    rows = [row for row in result["results"] if row["symbol"] == "SYNTA"]
    assert {row["full"]["start"] for row in rows} == {windows["full"]["start"]}
    bh = next(row for row in rows if row["config_index"] == 0)
    assert bh["full"]["excess_return_pct"] == 0 and bh["full"]["open_position"]
    board = result["leaderboard"]
    assert [row["rank"] for row in board] == [1, 2] and board[0]["rank_value"] >= board[1]["rank_value"]
    assert next(row for row in board if row["config"]["strategy"] == "buy_hold")["flags"] == ["benchmark_strategy"]
    assert result["engine_version"] == rd.ENGINE_VERSION and result["as_of"] == AS_OF and result["run_id"] is None
    assert any("多重比較" in warning for warning in result["warnings"])


def test_no_out_of_sample_and_short_history_are_reported_not_invented(client):
    insert_bars("SYNTA", wave(60))
    result = tournament(client, oos_pct=0)
    symbol = result["symbols"][0]
    assert symbol["out_of_sample_available"] is False and symbol["windows"]["in_sample"] == symbol["windows"]["full"]
    assert all(row["out_of_sample"] is None for row in result["results"])
    assert any("未保留樣本外" in warning for warning in result["warnings"])
    short = tournament(client, oos_pct=40)
    assert short["symbols"][0]["out_of_sample_available"] is False and short["symbols"][0]["out_of_sample_reason"]
    response = client.post("/api/research-desk/tournament", json={"symbols": ["SYNTA"], "configs": [{"strategy": "alphaview_trend"}]})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "no_usable_symbols"


def test_invalid_history_is_rejected_per_symbol(client):
    insert_bars("SYNTA", wave(300))
    insert_bars("SYNTB", wave(300))
    with store.connect() as db:
        db.execute("UPDATE bars SET close=-5 WHERE symbol='SYNTB' AND rowid IN (SELECT rowid FROM bars WHERE symbol='SYNTB' LIMIT 1 OFFSET 100)")
    result = tournament(client, symbols=["SYNTA", "SYNTB"])
    status = {row["symbol"]: row for row in result["symbols"]}
    assert status["SYNTA"]["status"] == "ok" and status["SYNTB"]["error"]["code"] == "invalid_history"
    assert {row["symbol"] for row in result["results"]} == {"SYNTA"}


def test_ranking_metrics_and_out_of_sample_decay_flag():
    rows = [{"config_index": 0, "symbol": s, "in_sample": {"return_pct": 10, "excess_return_pct": 5, "max_drawdown_pct": -3, "sharpe_ratio": 1,
             "closed_trades": 10, "wins": 6, "gross_profit": 60, "gross_loss": 20, "exposure_pct": 50, "open_position": False},
             "out_of_sample": {"return_pct": -2, "excess_return_pct": -4, "max_drawdown_pct": -6, "sharpe_ratio": -1,
             "closed_trades": 4, "wins": 1, "gross_profit": 5, "gross_loss": 10, "exposure_pct": 40, "open_position": False}} for s in ("A", "B")]
    in_sample, oos = rd._aggregate(rows, "in_sample"), rd._aggregate(rows, "out_of_sample")
    assert in_sample["pooled_profit_factor"] == 3 and in_sample["pooled_win_rate_pct"] == 60 and in_sample["beats_benchmark"] == 2
    assert rd._flags({"strategy": "sma_cross"}, in_sample, oos) == ["low_sample", "out_of_sample_decay"]


def test_history_is_saved_listed_and_marked_stale_after_inputs_change(client):
    insert_bars("SYNTA", wave(300))
    saved = tournament(client, save=True)
    assert saved["run_id"]
    runs = client.get("/api/research-desk/runs").json()
    assert runs["total"] == 1 and runs["runs"][0]["id"] == saved["run_id"] and runs["runs"][0]["current"]
    detail = client.get(f"/api/research-desk/runs/{saved['run_id']}").json()
    assert detail["symbols"] == saved["symbols"]
    assert detail["symbols"][0]["status"] == "ok"
    assert detail["leaderboard"] == saved["leaderboard"] and detail["current"]
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    stale = client.get("/api/research-desk/runs").json()["runs"][0]
    assert not stale["current"] and stale["stale_reasons"] == ["inputs_changed"]
    assert client.get("/api/research-desk/runs/unknown").status_code == 404


def test_diagnose_attributes_losses_by_condition_and_is_read_only(client):
    insert_bars("SYNTA", wave(400, amplitude=0.3, period=45, drift=-0.0005))
    insert_bars("SPY", wave(400, amplitude=0.05, period=200, drift=0.0004))
    revision = store.input_revision()
    config = {"strategy": "rsi_reversion", "params": {"period": 14, "entry": 35, "exit": 65}}
    response = client.post("/api/research-desk/diagnose", json={"symbol": "SYNTA", "config": config, "test_start": "2023-12-01"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert store.input_revision() == revision and json.dumps(result, allow_nan=False)
    assert result["window"]["start"] >= "2023-12-01" and len(result["curve"]) == result["window"]["sessions"]
    assert result["summary"]["closed_trades"] == len(result["trades"]) > 0
    trade = result["trades"][0]
    assert set(trade["conditions"]) == {"trend", "rsi_zone", "volatility", "benchmark", "holding", "exit_reason"}
    assert trade["conditions"]["rsi_zone"] in ("oversold", "weak") and trade["signal_date"] < trade["entry_date"]
    for dimension, buckets in result["conditions"].items():
        assert sum(row["trades"] for row in buckets) == len(result["trades"]), dimension
        shares = [row["loss_share_pct"] for row in buckets if row["loss_share_pct"] is not None]
        assert not shares or sum(shares) == pytest.approx(100, abs=0.05)
    assert result["drawdowns"] and all(row["depth_pct"] < 0 for row in result["drawdowns"])
    assert result["drawdowns"] == sorted(result["drawdowns"], key=lambda row: row["depth_pct"])
    assert all({"code", "text", "text_en", "evidence"} <= set(note) for note in result["hypotheses"])
    assert result["benchmark"]["excess_return_pct"] is None and result["summary"]["excess_return_pct"] is not None


def test_diagnose_marks_missing_benchmark_unavailable(client):
    insert_bars("SYNTA", wave(300))
    result = client.post("/api/research-desk/diagnose", json={"symbol": "SYNTA", "config": {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}},
                                                               "benchmark_symbol": "NOPE"}).json()
    assert all(trade["conditions"]["benchmark"] == "unavailable" for trade in result["trades"])
    assert any("NOPE" in warning for warning in result["warnings"])
    assert client.post("/api/research-desk/diagnose", json={"symbol": "MISSING", "config": {"strategy": "buy_hold"}}).status_code == 422


def test_trades_csv_guards_formulas_and_labels_open_positions(client):
    insert_bars("SYNTA", wave(300))
    body = {"symbol": "SYNTA", "config": {"strategy": "buy_hold"}}
    response = client.post("/api/research-desk/trades.csv", json=body)
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"] and response.text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))
    assert rows[0][0] == "status" and rows[-1][0] == "open_marked_to_market" and len(rows) == 2
    assert rd._cell("=HYPERLINK(1)") == "'=HYPERLINK(1)" and rd._cell(-5.0) == -5.0


@pytest.mark.parametrize("strategy", list(rd.STRATEGIES))
def test_pine_export_mirrors_the_contract_for_every_strategy(client, strategy):
    config = {"strategy": strategy, "params": rd.normalize_params(strategy, {})}
    response = client.post("/api/research-desk/pine", json={"config": config, "risk": {"fee_bps": 10, "position_pct": 50, "stop_loss_pct": 8,
                                                                                      "slippage_bps": 5}, "start_date": "2024-01-02"})
    assert response.status_code == 200, response.text
    code = response.json()["code"]
    assert code.startswith("//@version=6\n") and "commission_value=0.1," in code and "default_qty_value=50," in code
    assert "process_orders_on_close=false" in code and "initial_capital=100000," in code
    assert 'timestamp("2024-01-02T00:00:00+00:00")' in code and "(1 - 8 / 100)" in code and "targetHit = false" in code
    assert "entrySignal =" in code and "exitSignal =" in code and "slippage of 5 bps is not represented" in code
    assert "nan" not in code.lower().replace("ta.", "") and "None" not in code
    assert code.count("strategy.entry(") == 1 and code.count("strategy.close(") == 3


def test_pine_indicator_calls_carry_parameters():
    code = rd.pine_script({"strategy": "bollinger_reversion", "params": {"period": 30, "std_mult": 2.5}}, rd.Risk().model_dump())
    assert "ta.bb(close, 30, 2.5)" in code and 'timestamp("1970-01-01T00:00:00+00:00")' in code
    code = rd.pine_script({"strategy": "rsi_reversion", "params": {"period": 2, "entry": 10.0, "exit": 70.0}}, rd.Risk().model_dump())
    assert "ta.rsi(close, 2)" in code and "rsiValue <= 10" in code and "rsiValue >= 70" in code


def test_presets_crud_with_version_conflicts(client):
    config = {"strategy": "sma_cross", "params": {"fast": 10, "slow": 30}}
    created = client.post("/api/research-desk/presets", json={"name": "  Fast trend  ", "config": config})
    assert created.status_code == 201
    preset = created.json()
    assert preset["name"] == "Fast trend" and preset["version"] == 1 and preset["config"]["params"] == {"fast": 10, "slow": 30}
    assert preset["risk"] == rd.Risk().model_dump() and preset["label_en"] == "Moving-average crossover 10/30"
    update = {"name": "Slower", "config": {**config, "params": {"fast": 20, "slow": 60}}, "expected_version": 1}
    assert client.put(f"/api/research-desk/presets/{preset['id']}", json=update).json()["version"] == 2
    assert client.put(f"/api/research-desk/presets/{preset['id']}", json=update).status_code == 409
    assert client.request("DELETE", f"/api/research-desk/presets/{preset['id']}", json={"expected_version": 1}).status_code == 409
    assert client.request("DELETE", f"/api/research-desk/presets/{preset['id']}", json={"expected_version": 2}).status_code == 200
    assert client.get("/api/research-desk/presets").json()["presets"] == []
    assert client.post("/api/research-desk/presets", json={"name": "   ", "config": config}).status_code == 422
    assert client.put("/api/research-desk/presets/unknown", json=update).status_code == 404


def test_catalog_is_offline_and_complete(client):
    with patch.object(rd, "Series", side_effect=AssertionError("catalog must not read bars")):
        result = client.get("/api/research-desk/catalog").json()
    assert [row["id"] for row in result["strategies"]] == list(rd.STRATEGIES)
    assert len(result["classic_set"]) == len(rd.CLASSIC_SET) and result["risk_defaults"]["fee_bps"] == 10
    assert result["attribution"]["license"] == "MIT" and result["limits"]["configs"] == rd.MAX_CONFIGS
    for item in result["classic_set"]:
        rd.StrategyConfig.model_validate(item)
