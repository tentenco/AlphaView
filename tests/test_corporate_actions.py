"""Corporate-action detection on synthetic bars: dividends, suspected splits, unclassified and unavailable pairs; notices only."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import corporate_actions as actions
from alphaview.panel import paper_portfolio as paper
from alphaview.panel import sessions, store

DAYS = sessions.expected_sessions("2024-01-02", "2024-01-31")


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "corporate-actions.db"))
    clock = {"session": DAYS[-1]}
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: clock["session"])
    store.init_db()
    app = FastAPI()
    app.include_router(actions.router)
    app.include_router(paper.router)
    with TestClient(app) as client:
        yield {"client": client, "clock": clock}


def bars(symbol, rows):
    """rows: list of (date, close, adj_close); open/high/low follow the close."""
    with store.connect() as db:
        db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        for day, close, adj in rows:
            db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,1000)", (symbol, day, close, close, close, close, adj))


def constant(symbol, factor_by_day):
    bars(symbol, [(day, 100.0, 100.0 * factor_by_day(index)) for index, day in enumerate(DAYS)])


def test_dividend_is_implied_from_the_factor_step_and_everything_else_is_quiet(setup):
    # Factor 0.98 before the ex-date (index 5), 1.0 from then on: D = 100 × (1 − 0.98 / 1.0) = 2.
    constant("SYNTA", lambda index: 0.98 if index < 5 else 1.0)
    revision = store.input_revision()
    response = setup["client"].get("/api/corporate-actions", params={"symbols": "SYNTA"})
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    assert result["engine_version"] == "alphaview-corporate-actions-v1" and result["symbols"] == ["SYNTA"]
    assert len(result["events"]) == 1
    event = result["events"][0]
    assert event["kind"] == "dividend" and event["ex_date"] == DAYS[5] and event["prior_session"] == DAYS[4]
    assert abs(event["implied_cash_per_share"] - 2.0) < 1e-9
    assert event["shares_multiplier"] is None and event["data_consistency"] is None
    assert result["coverage"] == [{"symbol": "SYNTA", "sessions": len(DAYS), "first": DAYS[0], "last": DAYS[-1],
                                   "pairs_checked": len(DAYS) - 1, "unavailable_pairs": 0, "start": None, "end": DAYS[-1]}]
    assert store.input_revision() == revision
    windowed = setup["client"].get("/api/corporate-actions", params={"symbols": "SYNTA", "start": DAYS[6]}).json()
    assert windowed["events"] == []


def test_two_for_one_split_is_suspected_with_a_consistency_flag(setup):
    # Raw close halves on index 4 while the adjusted close is continuous: a 2-for-1 split.
    bars("SYNTB", [(day, 200.0 if index < 4 else 100.0, 100.0) for index, day in enumerate(DAYS)])
    with store.connect() as db:
        events, coverage = actions.detect(db, "SYNTB")
    assert len(events) == 1
    event = events[0]
    assert event["kind"] == "suspected_split" and event["ex_date"] == DAYS[4]
    assert event["shares_multiplier"] == 2.0 and event["price_ratio"] == 0.5
    assert event["data_consistency"]["flag"] == "possible_mixed_basis" and "market.refresh" in event["data_consistency"]["message"]
    assert event["implied_cash_per_share"] is None
    json.dumps(events, allow_nan=False)


def test_negative_implied_cash_is_unclassified_and_bad_prices_are_unavailable(setup):
    # Factor falls (1.0 → 0.98) on index 3: the implied cash would be negative.
    constant("SYNTC", lambda index: 1.0 if index < 3 else 0.98)
    bars("SYNTD", [(day, 0.0 if index == 2 else 50.0, 50.0 if index != 2 else 0.0) for index, day in enumerate(DAYS)])
    with store.connect() as db:
        odd, _ = actions.detect(db, "SYNTC")
        bad, coverage = actions.detect(db, "SYNTD")
    assert [event["kind"] for event in odd] == ["unclassified"]
    assert odd[0]["reason"] == "implied_cash_out_of_range" and odd[0]["implied_cash_per_share"] < 0
    assert [event["kind"] for event in bad] == ["unavailable", "unavailable"]
    assert [event["ex_date"] for event in bad] == [DAYS[2], DAYS[3]] and coverage["unavailable_pairs"] == 2
    assert all(event["reason"] == "non_finite_or_nonpositive_price" for event in bad)
    json.dumps(bad, allow_nan=False)


def _account(client, name="synthetic-ca-account"):
    return client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 10000, "idempotency_key": name}).json()["account"]


def _fill(client, acct, targets, key):
    proposal = client.post(f"/api/paper/accounts/{acct['id']}/proposals",
                           json={"expected_version": acct["version"], "targets": targets, "idempotency_key": key}).json()
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": key + "-accept"})
    assert accepted.status_code == 200, accepted.text
    return accepted.json()["account"]["account"], proposal


def test_account_summary_flags_only_events_after_entry_and_previews_carry_a_notice(setup):
    client, clock = setup["client"], setup["clock"]
    # SYNTA: dividend at index 8 (after entry on index 4). SYNTB: dividend at index 2 (before entry).
    constant("SYNTA", lambda index: 0.98 if index < 8 else 1.0)
    constant("SYNTB", lambda index: 0.98 if index < 2 else 1.0)
    clock["session"] = DAYS[4]
    acct = _account(client)
    acct, _ = _fill(client, acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}], "synthetic-open")
    clock["session"] = DAYS[-1]
    revision = store.input_revision()
    summary = client.get(f"/api/paper/accounts/{acct['id']}/corporate-actions").json()
    json.dumps(summary, allow_nan=False)
    rows = {row["symbol"]: row for row in summary["holdings"]}
    assert rows["SYNTA"]["status"] == "events_since_entry" and rows["SYNTA"]["events_since_entry"] == [DAYS[8]]
    assert rows["SYNTA"]["entry_session"] == DAYS[4] and rows["SYNTA"]["last_fill_session"] == DAYS[4]
    assert rows["SYNTA"]["events_after_last_fill"] == [DAYS[8]]
    assert rows["SYNTB"]["status"] == "clear" and rows["SYNTB"]["events_total"] == 1 and rows["SYNTB"]["events_since_entry"] == []
    assert summary["flagged"] == ["SYNTA"] and summary["entry_unknown"] == []
    flagged = [event for event in summary["events"] if event["since_entry"]]
    assert [(event["symbol"], event["ex_date"]) for event in flagged] == [("SYNTA", DAYS[8])]
    assert store.input_revision() == revision
    preview = client.post(f"/api/paper/accounts/{acct['id']}/preview",
                          json={"expected_version": acct["version"], "targets": [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}]})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["executable"] and body["violations"] == []
    assert [notice["code"] for notice in body["notices"]] == ["corporate_action_since_entry"]
    assert body["notices"][0]["symbol"] == "SYNTA" and body["notices"][0]["ex_dates"] == [DAYS[8]]
    assert store.input_revision() == revision


def test_entry_unknown_is_reported_and_proposals_stored_before_notices_still_verify(setup):
    client = setup["client"]
    constant("SYNTA", lambda index: 0.98 if index < 10 else 1.0)
    constant("SYNTB", lambda index: 0.98 if index < 10 else 1.0)
    acct = _account(client)
    with store.connect() as db:
        # A holding without any ledger fill has no entry session: reported, not guessed.
        db.execute("INSERT INTO paper_holdings(account_id,symbol,shares,cost_basis) VALUES (?,?,?,?)", (acct["id"], "SYNTB", "5", "500"))
    response = client.post(f"/api/paper/accounts/{acct['id']}/proposals",
                           json={"expected_version": acct["version"], "targets": [{"symbol": "SYNTA", "weight_pct": 20}],
                                 "idempotency_key": "legacy-synthetic-proposal"})
    assert response.status_code == 200, response.text
    proposal = response.json()
    assert proposal["notices"] == [] and proposal["executable"]
    with store.connect() as db:
        stored = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0])
        stored.pop("notices")
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (paper._json(stored), proposal["id"]))
    summary = client.get(f"/api/paper/accounts/{acct['id']}/corporate-actions").json()
    assert summary["entry_unknown"] == ["SYNTB"] and summary["flagged"] == []
    assert {row["symbol"]: row["status"] for row in summary["holdings"]} == {"SYNTB": "entry_unknown"}
    accepted = client.post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                           json={"expected_version": acct["version"], "idempotency_key": "legacy-synthetic-accept"})
    assert accepted.status_code == 200, accepted.text
    assert "notices" in paper.PREVIEW_METADATA


@pytest.mark.parametrize("params", [{"symbols": ""}, {"symbols": "bad symbol"}, {"symbols": "SYNTA,SYNTA"},
                                    {"symbols": ",".join(f"S{i}" for i in range(51))}, {"symbols": "SYNTA", "start": "2024-02-30"},
                                    {"symbols": "SYNTA", "start": "2024-03-01", "end": "2024-02-01"}])
def test_query_bounds_are_strict(setup, params):
    response = setup["client"].get("/api/corporate-actions", params=params)
    assert response.status_code == 422, response.text


def test_unknown_account_is_404_and_empty_symbol_history_has_no_events(setup):
    assert setup["client"].get("/api/paper/accounts/missing/corporate-actions").status_code == 404
    result = setup["client"].get("/api/corporate-actions", params={"symbols": "NOPE"}).json()
    assert result["events"] == [] and result["coverage"][0]["sessions"] == 0 and result["coverage"][0]["first"] is None
