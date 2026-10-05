"""Decision outcome ledger on synthetic scans, runs, Jev rows and bars; isolated database, no providers."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import decision_ledger as ledger, paper_portfolio as paper, sessions, store

LATEST = "2024-02-15"
SESSIONS = sessions.expected_sessions("2023-01-03", LATEST)
S1 = SESSIONS[-21]          # exactly 20 completed sessions after it: settled for every horizon
S1_NEXT = SESSIONS[-20]
S2 = SESSIONS[-4]           # only 3 sessions after it: pending for every horizon
OLD = SESSIONS[-100]        # outside the default 60-session window
PRICES = {"SYNTA": lambda i: 100 + i, "SYNTB": lambda i: 300 - i, "SPY": lambda i: 200 + 0.5 * i}


def price(symbol, day):
    return PRICES[symbol](SESSIONS.index(day))


def forward(symbol, decision, horizon):
    after = [day for day in SESSIONS if day > decision]
    entry, exit_ = price(symbol, after[0]), price(symbol, after[horizon - 1])
    return round((exit_ / entry - 1) * 100, 4)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "ledger.db"))
    clock = {"now": LATEST}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["now"])
    store.init_db()
    with store.connect() as db:
        for symbol in PRICES:
            db.execute("INSERT INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)", (symbol, LATEST))
            for index, day in enumerate(SESSIONS):
                value = PRICES[symbol](index)
                db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", (symbol, day, value, value + 1, value - 1, value, value, 1000))
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(ledger.router)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield {"client": client, "clock": clock}


def scan_rows(matches):
    rows = {}
    for symbol, strategy in matches:
        rows.setdefault(symbol, []).append(strategy)
    return [{"symbol": symbol, "date": None, "bars": 240, "indicators": {}, "signals": [
        {"strategy": strategy, "status": "match" if strategy in matched else "watch", "matched": strategy in matched, "reason": "synthetic"}
        for strategy in ("turtle", "trend", "pullback", "rps")]} for symbol, matched in rows.items()]


def insert_scan(db, as_of, scope, matches, stale=False):
    rows = scan_rows(matches)
    for row in rows:
        row["date"] = "2023-12-01" if stale else as_of
    db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,?,'synthetic')",
               (as_of, json.dumps([row["symbol"] for row in rows]), json.dumps(rows), scope))


def insert_run(db, identifier, as_of, targets, status="proposed", scope="market", created="synthetic"):
    result = {"request": {"scope": scope}, "target_weights": [{"symbol": symbol, "weight_pct": weight} for symbol, weight in targets]}
    db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)",
               (identifier, created, "alphaview-agent-workflow-v1", as_of, "synthetic", status, "{}", json.dumps(result)))


def insert_jev(db, identifier, as_of, decisions, created="synthetic", status="completed"):
    payload = [{"symbol": symbol, "status": gate, "checks": [
        {"question": question, "value": value} for question, value in checks.items()]} for symbol, gate, checks in decisions]
    db.execute("""INSERT INTO jev_decision_runs(id,idempotency_key,request_hash,source_run_id,engine_version,question_set_version,status,
        created_at,as_of,input_revision,model_requested,model_answered,request_json,source_json,state_json,questions_json,request_digest,
        answers_json,usage_json,latency_ms,result_json,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (identifier, f"key-{identifier}", "hash", "run", "alphaview-jev-decision-v1", "alphaview-jev-questions-v1", status,
                created, as_of, "synthetic", "jev-1.13.0", "jev-1.13.0", "{}", "{}", "{}", "{}", "digest", None, None, None,
                json.dumps({"decisions": payload}), None))


def group(data, family, kind):
    return next(g for g in next(f for f in data["families"] if f["id"] == family)["groups"] if g["kind"] == kind)


def test_scan_signals_settle_only_after_the_horizon_and_score_against_the_benchmark(setup):
    with store.connect() as db:
        insert_scan(db, S1, "market", [("SYNTA", "turtle"), ("SYNTB", "trend")])
        insert_scan(db, S1, "portfolio", [("SYNTA", "turtle")])       # duplicate signal in another scope: counted once
        insert_scan(db, S1, "market", [("SYNTA", "turtle")], stale=True)  # later scan row for the same day/scope wins, stale rows ignored
        insert_scan(db, S2, "market", [("SYNTA", "turtle")])
        insert_scan(db, OLD, "market", [("SYNTB", "pullback")])           # outside the window
    revision = store.input_revision()
    response = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=5")
    assert response.status_code == 200, response.text
    data = response.json()
    assert store.input_revision() == revision and json.dumps(data, allow_nan=False)
    assert data["engine_version"] == ledger.ENGINE_VERSION and data["as_of"] == LATEST and data["horizon_sessions"] == 5
    assert data["window"]["sessions"] == 60 and data["window"]["end"] == LATEST and data["account"] is None
    turtle = group(data, "scan_signals", "turtle")
    # The later (stale) market scan replaced the first one for S1, so only the portfolio-scope turtle signal remains for S1.
    assert turtle["n"] == 2 and turtle["n_settled"] == 1 and turtle["n_pending"] == 1 and turtle["low_sample"]
    assert turtle["hit_rate"] == 1.0 and turtle["mean_return_pct"] == forward("SYNTA", S1, 5)
    assert turtle["mean_excess_pct"] == pytest.approx(forward("SYNTA", S1, 5) - forward("SPY", S1, 5), abs=1e-3)
    assert turtle["excess_coverage"] == {"n": 1, "of": 1, "reason": None}
    trend = group(data, "scan_signals", "trend")
    assert trend["n_settled"] == 0 and trend["reason"] == "no_decisions"
    assert group(data, "scan_signals", "pullback")["n"] == 0
    settled = [item for item in data["items"] if item["family"] == "scan_signals" and item["outcome"]["status"] == "settled"]
    assert len(settled) == 1 and settled[0]["symbol"] == "SYNTA" and settled[0]["hit"] is True
    assert settled[0]["outcome"]["entry_session"] == S1_NEXT and settled[0]["outcome"]["exit_session"] == SESSIONS[-16]
    pending = [item for item in data["items"] if item["decision_session"] == S2]
    assert len(pending) == 1 and pending[0]["outcome"] == {"status": "pending", "entry_session": SESSIONS[-3], "exit_session": None,
                                                           "sessions_elapsed": 3, "return_pct": None, "excess_pct": None,
                                                           "benchmark_return_pct": None, "reason": "horizon_not_elapsed"}
    assert not any(item["decision_session"] == OLD for item in data["items"])
    # Hand-checked numbers: SYNTA rises one point per session; entry at the next session, exit five sessions later.
    entry_index, exit_index = len(SESSIONS) - 20, len(SESSIONS) - 16
    assert turtle["mean_return_pct"] == round(((100 + exit_index) / (100 + entry_index) - 1) * 100, 4)


def test_rule_workflow_target_changes_are_diffed_against_the_previous_run(setup):
    with store.connect() as db:
        insert_run(db, "run-old", OLD, [("SYNTA", 20)])
        insert_run(db, "run-s1", S1, [("SYNTA", 20), ("SYNTB", 20)])
        insert_run(db, "run-s1-blocked", S1, [("SYNTB", 50)], status="blocked")
        insert_run(db, "run-next-early", S1_NEXT, [("SYNTA", 25)], created="synthetic-0")
        insert_run(db, "run-next", S1_NEXT, [("SYNTA", 30), ("SYNTC", 10)], created="synthetic-1")
    data = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=10").json()
    added, increased = group(data, "agent_targets", "added"), group(data, "agent_targets", "increased")
    decreased, removed = group(data, "agent_targets", "decreased"), group(data, "agent_targets", "removed")
    assert added["n"] == 2 and added["n_settled"] == 1 and added["n_unavailable"] == 1 and added["hit_rate"] == 0.0
    assert increased["n"] == 1 and increased["hit_rate"] == 1.0 and increased["mean_return_pct"] == forward("SYNTA", S1_NEXT, 10)
    assert removed["n"] == 1 and removed["direction"] == "exit" and removed["hit_rate"] == 1.0
    assert removed["mean_return_pct"] == forward("SYNTB", S1_NEXT, 10) < 0
    assert decreased["n"] == 0 and decreased["hit_rate"] is None and decreased["reason"] == "no_decisions"
    items = {(item["kind"], item["symbol"]): item for item in data["items"] if item["family"] == "agent_targets"}
    assert set(items) == {("added", "SYNTB"), ("increased", "SYNTA"), ("removed", "SYNTB"), ("added", "SYNTC")}
    assert items[("added", "SYNTC")]["outcome"]["status"] == "unavailable" and items[("added", "SYNTC")]["outcome"]["reason"] == "entry_bar_missing"
    assert items[("increased", "SYNTA")]["weight_from_pct"] == 20 and items[("increased", "SYNTA")]["weight_to_pct"] == 30
    assert items[("increased", "SYNTA")]["source_id"] == "agent_run:run-next"


def test_jev_gate_hit_rates_and_probability_calibration(setup):
    with store.connect() as db:
        insert_jev(db, "jev-early", S1, [("SYNTA", "pass", {"uptrend_intact": 0.5, "buying_pressure": 0.5, "overextended": 0.5})], created="synthetic-0")
        insert_jev(db, "jev-s1", S1, [("SYNTA", "pass", {"uptrend_intact": 0.9, "buying_pressure": 0.8, "overextended": 0.1}),
                                      ("SYNTB", "fail", {"uptrend_intact": 0.3, "buying_pressure": 0.5, "overextended": 0.7}),
                                      ("SYNTC", "unavailable", {})], created="synthetic-1", status="blocked")
        insert_jev(db, "jev-s2", S2, [("SYNTA", "pass", {"uptrend_intact": 0.95, "overextended": 0.2})])
    data = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=5").json()
    passed, failed, unavailable = (group(data, "jev_gate", kind) for kind in ("pass", "fail", "unavailable"))
    assert passed["n"] == 2 and passed["n_settled"] == 1 and passed["n_pending"] == 1 and passed["hit_rate"] == 1.0
    assert failed["n"] == 1 and failed["hit_rate"] == 1.0 and failed["mean_return_pct"] == forward("SYNTB", S1, 5)
    assert unavailable["n"] == 1 and unavailable["hit_rate"] is None and unavailable["reason"] == "no_direction"
    calibration = data["calibration"]
    questions = {question["id"]: question for question in calibration["questions"]}
    assert set(questions) == {"overextended", "uptrend_intact"}
    assert {entry["id"] for entry in calibration["unscorable"]} == {"buying_pressure", "setup_quality"}
    assert all(entry["reason"] for entry in calibration["unscorable"])
    over = questions["overextended"]
    # SYNTA (p=0.1) kept rising: no pullback → y=0; SYNTB (p=0.7) kept falling: pullback → y=1. Brier = (0.01 + 0.09) / 2.
    assert over["n"] == 2 and over["n_pending"] == 1 and over["brier"] == 0.05 and over["base_rate"] == 0.5 and over["low_sample"]
    assert over["mean_predicted"] == 0.4 and over["realization"]["kind"] == "pullback"
    bins = {tuple(entry["range"]): entry for entry in over["bins"]}
    assert bins[(0.0, 0.2)] == {"range": [0.0, 0.2], "n": 1, "mean_predicted": 0.1, "realized_rate": 0.0, "low_sample": True}
    assert bins[(0.6, 0.8)]["n"] == 1 and bins[(0.6, 0.8)]["realized_rate"] == 1.0 and bins[(0.2, 0.4)]["n"] == 0
    up = questions["uptrend_intact"]
    # Linear rise keeps close > MA50 > MA200 (y=1, p=0.9); linear fall breaks it (y=0, p=0.3). Brier = (0.01 + 0.09) / 2.
    assert up["n"] == 2 and up["brier"] == 0.05 and up["base_rate"] == 0.5 and up["realization"]["kind"] == "uptrend_criteria_hold"
    assert up["unavailable"] == {} and up["n_pending"] == 1
    items = {item["symbol"]: item for item in data["items"] if item["family"] == "jev_gate" and item["decision_session"] == S1}
    assert items["SYNTA"]["probabilities"] == {"uptrend_intact": 0.9, "buying_pressure": 0.8, "overextended": 0.1}
    assert items["SYNTA"]["source_id"] == "jev_run:jev-s1" and items["SYNTC"]["direction"] is None and items["SYNTC"]["hit"] is None


def test_uptrend_realization_needs_two_hundred_bars(setup):
    with store.connect() as db:
        insert_jev(db, "jev-s1", S1, [("SYNTA", "pass", {"uptrend_intact": 0.9})])
        db.execute("DELETE FROM bars WHERE symbol='SYNTA' AND date<?", (SESSIONS[-150],))
    data = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=5").json()
    up = next(question for question in data["calibration"]["questions"] if question["id"] == "uptrend_intact")
    assert up["n"] == 0 and up["brier"] is None and up["unavailable"] == {"history_insufficient": 1}
    assert group(data, "jev_gate", "pass")["hit_rate"] == 1.0


def test_missing_benchmark_leaves_excess_unavailable_without_fallback(setup):
    with store.connect() as db:
        insert_scan(db, S1, "market", [("SYNTA", "turtle")])
        db.execute("DELETE FROM bars WHERE symbol='SPY'")
    data = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=20").json()
    turtle = group(data, "scan_signals", "turtle")
    assert turtle["n_settled"] == 1 and turtle["mean_return_pct"] == forward("SYNTA", S1, 20)
    assert turtle["mean_excess_pct"] is None and turtle["excess_coverage"] == {"n": 0, "of": 1, "reason": "benchmark_unavailable"}
    item = next(item for item in data["items"] if item["family"] == "scan_signals")
    assert item["outcome"]["excess_pct"] is None and item["outcome"]["excess_reason"] == "benchmark_unavailable"
    assert any("SPY" in warning for warning in data["warnings"])
    json.dumps(data, allow_nan=False)


def test_paper_fills_of_one_account_settle_from_the_proposal_session(setup):
    client, clock = setup["client"], setup["clock"]
    account = client.post("/api/paper/accounts", json={"name": "Synthetic ledger account", "initial_cash": 10_000,
                                                       "idempotency_key": "ledger-account-01"}).json()["account"]
    clock["now"] = S1
    proposal = client.post(f"/api/paper/accounts/{account['id']}/proposals",
                           json={"expected_version": account["version"], "targets": [{"symbol": "SYNTB", "weight_pct": 30}],
                                 "idempotency_key": "ledger-proposal-01"})
    assert proposal.status_code == 200, proposal.text
    accepted = client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal.json()['id']}/accept",
                           json={"expected_version": account["version"], "idempotency_key": "ledger-accept-01"})
    assert accepted.status_code == 200, accepted.text
    clock["now"] = LATEST
    revision = store.input_revision()
    data = client.get(f"/api/trading-agent/outcomes?account_id={account['id']}&horizon_sessions=10&window_sessions=30").json()
    assert store.input_revision() == revision and data["account"] == {"id": account["id"], "name": "Synthetic ledger account"}
    buys = group(data, "paper_fills", "buy")
    assert buys["n"] == 1 and buys["n_settled"] == 1 and buys["hit_rate"] == 0.0 and buys["mean_return_pct"] == forward("SYNTB", S1, 10)
    assert group(data, "paper_fills", "sell")["n"] == 0
    assert client.get("/api/trading-agent/outcomes?account_id=unknown").status_code == 404


def test_parameter_bounds_and_empty_workspace(setup):
    client = setup["client"]
    assert client.get("/api/trading-agent/outcomes?horizon_sessions=7").status_code == 422
    assert client.get("/api/trading-agent/outcomes?horizon_sessions=0").status_code == 422
    assert client.get("/api/trading-agent/outcomes?window_sessions=3").status_code == 422
    assert client.get("/api/trading-agent/outcomes?window_sessions=300").status_code == 422
    data = client.get("/api/trading-agent/outcomes").json()
    assert data["horizon_sessions"] == 10 and data["items"] == [] and data["items_total"] == 0
    assert [family["id"] for family in data["families"]] == ["scan_signals", "agent_targets", "jev_gate"]
    assert all(group_["reason"] == "no_decisions" for family in data["families"] for group_ in family["groups"])
    assert any("沒有任何可結算的決策" in warning for warning in data["warnings"])
    assert data["method"] and data["price_basis"] and data["benchmark"] == "SPY" and data["horizons"] == [5, 10, 20]
    json.dumps(data, allow_nan=False)
