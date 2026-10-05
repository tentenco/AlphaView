"""Retrospective saved-setting paths: synthetic bars, isolated DB, no external calls."""
from concurrent.futures import ThreadPoolExecutor
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import allocator, portfolio_agent as agent, research, scan_provenance, sessions, store
from alphaview.panel import workflow_path_validation as path
from tests.test_research_desk import insert_bars, wave


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "workflow-path.db"))
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("No external requests"))
    store.init_db()
    for symbol, period in (("SYNTA", 31), ("SYNTB", 47), ("SYNTC", 63)):
        closes = wave(520, period=period)
        days = insert_bars(symbol, closes, opens=[value * .98 for value in closes])
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: days[-1])
    with store.connect() as db:
        for symbol in ("SYNTA", "SYNTB", "SYNTC"):
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','synthetic',1000000000)", (symbol, "Synthetic"))
    app = FastAPI()
    app.include_router(agent.router)
    app.include_router(path.router)
    with TestClient(app) as client:
        yield client, days, monkeypatch


def saved(client, days, **changes):
    symbols = ["SYNTA", "SYNTB", "SYNTC"]
    rows = [{"symbol": symbol, "name": "Synthetic", "date": days[-1], "bars": len(days),
             "indicators": {"close": 100}, "signals": [{"strategy": rule, "status": "match", "matched": True,
             "reason": "Synthetic"} for rule in agent.STRATEGY_IDS]} for symbol in symbols]
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (days[-1], json.dumps(symbols), json.dumps(rows), scan_provenance.current_token(db)))
    response = client.post("/api/portfolio-agent/runs", json={"candidate_symbols": symbols,
        "strategy_weights": {"turtle": 100, "trend": 0, "pullback": 0, "rps": 0},
        "constraints": {"max_positions": 1, "max_position_weight_pct": 60, "cash_buffer_pct": 20}, **changes})
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "proposed", response.json()
    return response.json()


def body(run, **changes):
    return {"expected_proposal_fingerprint": run["proposal_fingerprint"],
            "expected_input_revision": run["input_revision"], "expected_as_of": run["as_of"], **changes}


def url(run):
    return f"/api/portfolio-agent/runs/{run['id']}/path-validation"


def test_real_saved_settings_path_is_readonly_complete_and_not_hindsight_selected(workspace):
    client, days, _ = workspace
    run = saved(client, days)
    revision = store.input_revision()
    result = client.post(url(run), json=body(run))
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    value = result.json()
    assert value["status"] == "evaluated", value["reasons"]
    assert value["engine_version"] == path.ENGINE_VERSION and value["mode"] == "advisory_only"
    assert "verdict" not in value and "pass" not in value
    assert value["candidate_symbols"] == ["SYNTA", "SYNTB", "SYNTC"]
    assert [row["symbol"] for row in run["target_weights"]] == ["SYNTA"]
    assert value["coverage"]["valued_path_sessions"] == len(value["curve"]) == 252
    assert value["coverage"]["available_decisions"] == len(value["decisions"]) == 12
    assert value["window"]["signal_start"] == days[-253] and value["window"]["start"] == days[-252]
    assert all(row["signal_date"] < row["trade_date"] for row in value["decisions"])
    assert value["metrics"]["trade_count"] > 0 and value["metrics"]["total_fees"] > 0
    for decision in value["decisions"]:
        assert len(decision["candidates"]) == 3
        assert sum(row["weight_pct"] for row in decision["targets"]) <= 60
    for event in value["events"]:
        for trade in event["trades"]:
            with store.connect() as db:
                opening = db.execute("SELECT open FROM bars WHERE symbol=? AND date=?", (trade["symbol"], event["trade_date"])).fetchone()[0]
            assert trade["raw_open"] == opening
    json.dumps(value, allow_nan=False)
    assert len(value["history_fingerprint"]) == len(value["evidence_fingerprint"]) == len(value["settings_fingerprint"]) == 64
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM portfolio_agent_runs").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM paper_proposals").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM research_desk_runs").fetchone()[0] == 0


def test_every_decision_uses_only_prefix_and_allocator_signal_date(workspace, monkeypatch):
    client, days, _ = workspace
    run = saved(client, days, constraints={"max_positions": 2, "allocation_method": "inverse_volatility"})
    real_indicators, real_evaluate, real_allocate = research.indicators, research.evaluate, allocator.allocate
    prefixes, signal_days, allocation_days = [], [], []
    def indicators(frame):
        prefixes.append(frame["date"].max())
        return real_indicators(frame)
    def evaluate(frames, day):
        assert all(frame.date.max() == day for frame in frames.values())
        signal_days.append(day)
        return real_evaluate(frames, day)
    def allocate(db, selected, constraints, day):
        allocation_days.append(day)
        return real_allocate(db, selected, constraints, day)
    monkeypatch.setattr(research, "indicators", indicators)
    monkeypatch.setattr(research, "evaluate", evaluate)
    monkeypatch.setattr(allocator, "allocate", allocate)
    result = client.post(url(run), json=body(run)).json()
    assert result["status"] == "evaluated"
    expected = days[-253:-1:21]
    assert signal_days == expected and prefixes == [day for day in expected for _ in range(3)]
    assert allocation_days and set(allocation_days).issubset(expected)
    assert all(row["allocator"]["method"] == "inverse_volatility" for row in result["decisions"] if row["allocator"])


def test_missing_enabled_rule_never_becomes_cash_or_smaller_universe(workspace):
    client, days, _ = workspace
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (days[-300],))
    run = saved(client, days)
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == "unavailable" and value["metrics"] is None
    assert not value["curve"] and not value["events"] and value["coverage"]["valued_path_sessions"] == 0
    assert value["coverage"]["available_decisions"] == 0
    assert all(row["status"] == "unavailable" and not row["targets"] for row in value["decisions"])
    assert any(reason["symbol"] == "SYNTB" for reason in value["decisions"][0]["reasons"])
    assert value["decisions"][0]["coverage"]["available_candidate_rules"] == 2
    assert value["decisions"][0]["coverage"]["required_candidate_rules"] == 3


def test_mutating_later_bars_leaves_every_earlier_decision_identical(workspace):
    client, days, _ = workspace
    settings = {"constraints": {"max_positions": 2, "allocation_method": "score_tilt"}}
    run = saved(client, days, **settings)
    before = client.post(url(run), json=body(run)).json()
    cutoff = before["decisions"][6]["signal_date"]
    with store.connect() as db:
        db.execute("UPDATE bars SET open=open*1.5,high=high*1.5,low=low*1.5,close=close*1.5,adj_close=adj_close*1.5,volume=volume*2 WHERE symbol='SYNTA' AND date>?", (cutoff,))
        # Ensure the altered future crosses an actual decision boundary, rather than
        # relying on a scale change that could leave all threshold booleans unchanged.
        db.execute("UPDATE bars SET open=500,high=1001,low=499,close=1000,adj_close=1000,volume=1000000 WHERE symbol='SYNTA' AND date=?",
                   (before["decisions"][7]["signal_date"],))
    revised_run = saved(client, days, **settings)
    after = client.post(url(revised_run), json=body(revised_run)).json()
    assert before["status"] == after["status"] == "evaluated"
    assert before["history_fingerprint"] != after["history_fingerprint"]
    assert before["decisions"][:7] == after["decisions"][:7]
    assert before["decisions"][7:] != after["decisions"][7:]


def test_rps_uses_full_saved_scan_universe_and_missing_peer_blocks(workspace):
    client, days, _ = workspace
    run = saved(client, days, candidate_symbols=["SYNTA"], strategy_weights={"turtle": 0, "trend": 0, "pullback": 0, "rps": 100})
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == "evaluated"
    assert value["rps_universe"] == ["SYNTA", "SYNTB", "SYNTC"] and value["candidate_symbols"] == ["SYNTA"]
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTC' AND date=?", (days[-300],))
    run = saved(client, days, candidate_symbols=["SYNTA"], strategy_weights={"turtle": 0, "trend": 0, "pullback": 0, "rps": 100})
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == "unavailable" and value["metrics"] is None
    assert any(reason["code"] == "rps_peer_unavailable" and reason["symbol"] == "SYNTC" for reason in value["decisions"][0]["reasons"])


def test_hand_checked_next_open_fee_and_raw_close_valuation():
    calendar = ["2024-01-02", "2024-01-03", "2024-01-04"]
    raw = {"SYNTA": [{"date": day, "open": o, "high": max(o, c), "low": min(o, c), "close": c,
                      "adj_close": c / 2, "volume": 1} for day, o, c in zip(calendar, [50, 100, 120], [50, 110, 130])]}
    decisions = [{"signal_date": calendar[0], "trade_date": calendar[1], "status": "rebalance",
                  "targets": [{"symbol": "SYNTA", "weight_pct": 50}]}]
    value = path._simulate(calendar, decisions, raw)
    net_nav = path.INITIAL_CASH / 1.0005
    shares = net_nav * .5 / 100
    assert value["events"][0]["trades"][0]["raw_open"] == 100
    assert value["final_holdings"][0]["shares"] == pytest.approx(shares)
    assert value["metrics"]["total_fees"] == pytest.approx(shares * 100 * .001)
    assert value["metrics"]["final_value"] == pytest.approx(net_nav * .5 + shares * 130)
    assert value["curve"][0]["value"] == pytest.approx(net_nav * .5 + shares * 110)


def test_hold_no_candidates_and_corporate_action_do_not_fabricate_accounting():
    calendar = ["2024-01-02", "2024-01-03", "2024-01-04"]
    raw = {"SYNTA": [{"date": day, "open": 100, "high": 100, "low": 100, "close": 100,
                      "adj_close": 100, "volume": 1} for day in calendar]}
    decisions = [{"signal_date": calendar[0], "trade_date": calendar[1], "status": "rebalance",
                  "targets": [{"symbol": "SYNTA", "weight_pct": 50}]},
                 {"signal_date": calendar[1], "trade_date": calendar[2], "status": "hold_no_candidates", "targets": []}]
    value = path._simulate(calendar, decisions, raw)
    assert len(value["events"]) == 1 and value["final_holdings"][0]["shares"] > 0
    raw["SYNTA"][-1]["adj_close"] = 101
    with pytest.raises(path.PathUnavailable) as error:
        path._simulate(calendar, decisions, raw)
    assert error.value.reason["code"] == "held_corporate_action_unmodeled"


@pytest.mark.parametrize("change", [{"window_sessions": 20}, {"fee_bps": 0}, {"expected_as_of": "2024-02-30"},
                                    {"expected_input_revision": True}, {"expected_proposal_fingerprint": "invalid"}])
def test_strict_inputs_fail_before_compute(workspace, monkeypatch, change):
    client, days, _ = workspace
    run = saved(client, days)
    monkeypatch.setattr(path, "_compute", lambda *a: pytest.fail("Invalid request must not compute"))
    assert client.post(url(run), json=body(run, **change)).status_code == 422


@pytest.mark.parametrize("field,value", [("expected_proposal_fingerprint", "b" * 64), ("expected_input_revision", "changed"),
                                       ("expected_as_of", "2024-01-01")])
def test_stale_source_fails_before_compute(workspace, monkeypatch, field, value):
    client, days, _ = workspace
    run = saved(client, days)
    monkeypatch.setattr(path, "_compute", lambda *a: pytest.fail("Stale request must not compute"))
    assert client.post(url(run), json=body(run, **{field: value})).status_code == 409


def test_history_bound_before_indicator_loading(workspace, monkeypatch):
    client, days, _ = workspace
    run = saved(client, days)
    monkeypatch.setattr(path, "MAX_HISTORY_BARS", 519)
    monkeypatch.setattr(research, "indicators", lambda *a: pytest.fail("Oversized history must not calculate"))
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == "unavailable" and value["history_fingerprint"] is None
    assert all(reason["code"] == "history_limit" for reason in value["reasons"])


def test_concurrent_writer_cannot_mix_decision_snapshots(workspace, monkeypatch):
    client, days, _ = workspace
    run = saved(client, days)
    baseline = client.post(url(run), json=body(run)).json()
    original, calls = path._decision, []
    def decision(*args):
        value = original(*args)
        calls.append(value["signal_date"])
        if len(calls) == 1:
            def write():
                with store.connect() as db:
                    db.execute("UPDATE bars SET volume=volume+7 WHERE symbol='SYNTA'")
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(write).result(timeout=5)
        return value
    monkeypatch.setattr(path, "_decision", decision)
    response = client.post(url(run), json=body(run))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["decisions"] == baseline["decisions"] and value["metrics"] == baseline["metrics"]
    assert value["input_revision"] != store.input_revision() and value["current_at_snapshot"]
    assert not client.get(f"/api/portfolio-agent/runs/{run['id']}").json()["current"]


def test_session_rollover_rejects_result(workspace, monkeypatch):
    client, days, _ = workspace
    run = saved(client, days)
    real = path._compute
    def moved(*args):
        value = real(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-10-01")
        return value
    monkeypatch.setattr(path, "_compute", moved)
    assert client.post(url(run), json=body(run)).status_code == 409
