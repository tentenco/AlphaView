import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import alpha_replay, scan_provenance, store


def row(symbol, day, matches):
    return {"symbol": symbol, "date": day, "bars": 250, "indicators": {"close": 100, "rps": 85},
            "signals": [{"strategy": strategy, "status": "match" if strategy in matches else "watch",
                         "matched": strategy in matches} for strategy in alpha_replay.STRATEGIES]}


def test_scoring_matches_frontend_and_never_reweights_missing_data():
    weights = dict.fromkeys(alpha_replay.STRATEGIES, 25)
    day = "2026-09-04"
    rows = [row("AAA", day, ["trend", "rps"]), row("BBB", day, ["turtle", "trend", "rps"]), row("CCC", day, ["pullback"])]
    result = alpha_replay.rank_rows(rows, ["AAA", "BBB", "CCC"], day, weights, 50, 2)
    assert [(item["symbol"], item["score"], item["alpha"]) for item in result] == [("BBB", 75, True), ("AAA", 50, True), ("CCC", 25, False)]
    rows[0]["signals"][2]["status"] = "insufficient"
    result = alpha_replay.rank_rows(rows, ["AAA"], day, weights, 50, 2)
    assert result[0]["coverage"] == 75 and not result[0]["alpha"] and result[0]["score"] == 50
    rows[0]["signals"][0]["status"] = "data_error"
    assert not alpha_replay.rank_rows(rows, ["AAA"], day, weights, 50, 2)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "replay.db"))
    store.init_db()
    days = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]
    monkeypatch.setattr(alpha_replay.sessions, "latest_completed_session", lambda: days[-1])
    monkeypatch.setattr(alpha_replay.sessions, "expected_sessions", lambda start, end: days)
    with store.connect() as db:
        db.execute("INSERT INTO market_universe(symbol,name,source,discovered_at) VALUES ('AAA','AAA Company','test',?)", (store.now(),))
    token = scan_provenance.current_token()
    with store.connect() as db:
        for day in days:
            db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES (?,?,?,?,?,?)",
                       (store.now(), day, json.dumps(["AAA"]), json.dumps([row("AAA", day, ["trend", "turtle"])]), "market", token))
    return days


def test_replay_streaks_and_gaps_are_explicit(workspace):
    result = alpha_replay.replay(alpha_replay.ReplayInput(days=5))
    assert result["occurrences"][0]["count"] == result["occurrences"][0]["streak"] == 5
    with store.connect() as db:
        db.execute("DELETE FROM scans WHERE as_of=?", (workspace[-2],))
    result = alpha_replay.replay(alpha_replay.ReplayInput(days=5))
    occurrence = result["occurrences"][0]
    assert occurrence["count"] == 4 and occurrence["streak"] == 1 and occurrence["eligible_sessions"] == 4
    assert result["timeline"][-2]["reason"] == "missing_snapshot"
    json.dumps(result, allow_nan=False)


def test_stale_versions_cannot_appear_as_historical_picks(workspace):
    with store.connect() as db:
        db.execute("UPDATE scans SET input_revision='unknown' WHERE as_of=?", (workspace[-1],))
    result = alpha_replay.replay(alpha_replay.ReplayInput(days=5))
    assert not result["timeline"][-1]["available"]
    assert result["timeline"][-1]["picks"] == []
    assert result["occurrences"][0]["streak"] == 0
    assert not result["occurrences"][0]["current_alpha"]


def test_api_validates_weights_and_does_not_write(workspace):
    app = FastAPI(); app.include_router(alpha_replay.router)
    client = TestClient(app)
    before = store.input_revision()
    assert client.post("/api/alpha/replay", json={"days": 5}).status_code == 200
    assert client.post("/api/alpha/replay", json={"days": 999}).status_code == 422
    assert client.post("/api/alpha/replay", json={"weights": dict.fromkeys(alpha_replay.STRATEGIES, 0)}).status_code == 422
    assert store.input_revision() == before
