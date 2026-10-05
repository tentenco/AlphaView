"""Verified local pool selection and source-preserving automation integration."""
import json
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_automation as automation, paper_analytics, paper_portfolio as paper
from alphaview.panel import portfolio_agent as agent, portfolio_candidates as selector
from alphaview.panel import scan_provenance, sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB", "SYNTC", "SYNTD", "SYNTE"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "candidates.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    monkeypatch.setattr(automation, "utcnow", lambda: datetime(2024, 1, 5, 1, tzinfo=timezone.utc))
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        paper_analytics.init_schema(db)
        agent.init_schema(db)
        automation.init_schema(db)
    add_symbols(SYMBOLS)
    app = FastAPI()
    app.include_router(selector.router)
    app.include_router(automation.router)
    with TestClient(app) as result:
        yield result


def add_symbols(symbols, as_of=AS_OF):
    with store.connect() as db:
        for symbol in symbols:
            db.execute("INSERT OR IGNORE INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, as_of))
            db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))


def row(symbol, *, matched=2, missing=False, day=AS_OF):
    return {"symbol": symbol, "date": day, "bars": 240, "indicators": {"close": 100},
            "signals": [{"strategy": strategy, "status": "match" if index < matched else "watch",
                         "matched": index < matched, "reason": "Synthetic rule"}
                        for index, strategy in enumerate(agent.STRATEGY_IDS) if not (missing and strategy == "rps")]}


def scan(rows=None, *, day=AS_OF, scope="market", token="current", symbols=None):
    symbols = symbols or SYMBOLS
    rows = rows or [row("SYNTE", matched=0), row("SYNTD", missing=True), row("SYNTC"), row("SYNTB"), row("SYNTA", matched=4)]
    with store.connect() as db:
        cursor = db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,?,?)",
                            (day, json.dumps(symbols), json.dumps(rows), scope,
                             scan_provenance.current_token(db) if token == "current" else token))
        return cursor.lastrowid


def mandate(client, **kwargs):
    account_id = paper.create_account(paper.AccountInput(name="Synthetic account", initial_cash=10000, idempotency_key="synthetic-pool-account"))["account"]["id"]
    result = client.post("/api/agent-automation/mandates", json={"name": "Synthetic pool", "account_id": account_id,
                         "workflow": {"scope": "market"}, "candidate_source": "scan_pool", "enabled": True, **kwargs})
    assert result.status_code == 201, result.text
    return result.json()["mandate"]


def test_pool_counts_incomplete_exclusions_and_stable_rank_are_explicit(client):
    identifier = scan()
    before = store.input_revision()
    result = client.post("/api/portfolio-agent/candidates", json={"limit": 2}).json()
    assert result["status"] == "ready" and result["scan"]["id"] == identifier
    assert result["candidate_symbols"] == ["SYNTA", "SYNTB"]
    assert result["coverage"] == {"pool": 5, "complete": 4, "incomplete": 1, "eligible": 3, "selected": 2, "rejected": 2, "limited": 1}
    assert result["candidates"][0]["score"] == 100 and result["candidates"][1]["score"] == 50
    assert result["rejection_counts"]["enabled_strategy_unavailable"] == 1
    incomplete = next(item for item in result["rejected_sample"] if item["symbol"] == "SYNTD")
    assert incomplete["score"] is None and incomplete["coverage_pct"] == 75
    assert result == client.post("/api/portfolio-agent/candidates", json={"limit": 2}).json()
    assert store.input_revision() == before
    assert json.dumps(result, allow_nan=False)
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0


def test_disabled_strategy_changes_availability_without_reweighting(client):
    scan()
    result = client.post("/api/portfolio-agent/candidates", json={"strategy_weights": {"turtle": 50, "trend": 50, "pullback": 0, "rps": 0}}).json()
    assert result["coverage"]["complete"] == 5
    assert result["candidate_symbols"] == SYMBOLS[:4]
    assert all(item["score"] == 100 for item in result["candidates"])


@pytest.mark.parametrize("fault", ["missing", "legacy", "stale_inputs", "session", "universe"])
def test_bad_scan_source_blocks_pool_without_fake_scores(client, fault):
    if fault != "missing":
        scan(day="2024-01-03" if fault == "session" else AS_OF,
             token=None if fault == "legacy" else "current",
             symbols=SYMBOLS[:3] if fault == "universe" else None)
    if fault == "stale_inputs":
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1")
    result = client.post("/api/portfolio-agent/candidates", json={}).json()
    assert result["status"] == "blocked" and result["candidate_symbols"] == []
    assert result["coverage"]["complete"] == 0 and result["reasons"]


def test_complete_no_matches_is_distinct_from_unavailable_pool(client):
    scan([row(symbol, matched=0) for symbol in SYMBOLS])
    result = client.post("/api/portfolio-agent/candidates", json={"limit": 2}).json()
    assert result["status"] == "empty" and result["candidate_symbols"] == []
    assert result["review_symbols"] == SYMBOLS[:2]
    assert result["coverage"]["complete"] == 5 and result["coverage"]["eligible"] == 0
    scan([row(symbol, missing=True) for symbol in SYMBOLS])
    result = client.post("/api/portfolio-agent/candidates", json={}).json()
    assert result["status"] == "blocked" and result["review_symbols"] == []
    assert result["coverage"]["incomplete"] == 5


def test_pool_over_one_hundred_is_fully_counted_before_selection_limit(client):
    symbols = [f"SYN{index:03d}" for index in range(120)]
    add_symbols(symbols)
    with store.connect() as db:
        all_symbols = [item[0] for item in db.execute("SELECT symbol FROM market_universe ORDER BY symbol")]
    scan([row(symbol) for symbol in reversed(all_symbols)], symbols=all_symbols)
    result = client.post("/api/portfolio-agent/candidates", json={}).json()
    assert result["coverage"] == {"pool": 125, "complete": 125, "incomplete": 0, "eligible": 125, "selected": 100, "rejected": 0, "limited": 25}
    assert result["candidate_symbols"] == sorted(all_symbols)[:100]


@pytest.mark.parametrize("body", [{"limit": 0}, {"limit": 101}, {"limit": True}, {"min_score": "NaN"},
                                  {"scope": "all"}, {"unrecognized": True},
                                  {"strategy_weights": {"turtle": 50}},
                                  {"strategy_weights": {"turtle": 100, "trend": 0, "pullback": 0, "rps": 0}, "min_matches": 2}])
def test_selector_strict_input_validation(client, body):
    assert client.post("/api/portfolio-agent/candidates", json=body).status_code == 422


def test_duplicate_rows_and_invalid_quote_are_excluded_with_null_scores(client):
    with store.connect() as db:
        db.execute("UPDATE bars SET high=1 WHERE symbol='SYNTB'")
    scan([row("SYNTA"), row("SYNTA"), *[row(symbol) for symbol in SYMBOLS[1:]]])
    result = client.post("/api/portfolio-agent/candidates", json={}).json()
    assert result["candidate_symbols"] == SYMBOLS[2:]
    assert result["rejection_counts"] == {"current_quote_unavailable": 1, "scan_row_duplicate": 1}
    assert all(item["score"] is None for item in result["rejected_sample"])


def test_dynamic_pool_resolves_new_daily_symbols_and_persists_selector_evidence(client, monkeypatch):
    saved = mandate(client, selector_limit=2)
    scan()
    first = automation.tick()["results"][0]
    assert first["status"] == "proposed"
    first_run = agent.get_run(first["attempt"]["run_id"])
    assert first_run["request"]["candidate_symbols"] == ["SYNTA", "SYNTB"]
    assert first_run["candidate_source"] == "scan_pool"
    assert first_run["candidate_selection"]["coverage"]["pool"] == 5
    assert first_run["candidate_selection"]["engine_version"] == selector.ENGINE_VERSION
    assert first_run["candidate_selection"]["scan"]["id"] == first_run["scan"]["id"]
    assert first_run["cash_weight_pct"] == 68
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: "2024-01-05")
    add_symbols(SYMBOLS, "2024-01-05")
    scan([row(symbol, matched=4 if symbol == "SYNTE" else 2, day="2024-01-05") for symbol in SYMBOLS], day="2024-01-05")
    second = automation.tick()["results"][0]
    second_run = agent.get_run(second["attempt"]["run_id"])
    assert second_run["request"]["candidate_symbols"] == ["SYNTE", "SYNTA"]
    current = client.get(f"/api/agent-automation/mandates/{saved['id']}").json()["mandate"]
    assert current["workflow"]["candidate_symbols"] == [] and current["version"] == 1


def test_empty_pool_selection_records_blocked_run_without_liquidation(client):
    mandate(client, mode="auto_simulate")
    scan([row(symbol, matched=0) for symbol in SYMBOLS])
    result = automation.tick()["results"][0]
    assert result["status"] == "blocked"
    run = agent.get_run(result["attempt"]["run_id"])
    assert run["candidate_selection"]["status"] == "empty"
    assert run["candidate_selection"]["candidate_symbols"] == []
    assert run["target_weights"] == [] and run["cash_weight_pct"] is None
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0


def test_missing_pool_data_waits_without_session_attempt(client):
    mandate(client)
    assert automation.tick()["results"][0]["status"] == "waiting"
    scan([row(symbol, missing=True) for symbol in SYMBOLS])
    assert automation.tick()["results"][0]["status"] == "waiting"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0] == 0
    scan()
    assert automation.tick()["results"][0]["status"] == "proposed"


def test_source_change_after_resolution_rejects_atomic_claim_and_run(client, monkeypatch):
    mandate(client)
    scan()
    original = automation._ready
    def changed(*args):
        result = original(*args)
        scan([row(symbol) for symbol in SYMBOLS])
        return result
    monkeypatch.setattr(automation, "_ready", changed)
    assert automation.tick()["results"][0]["status"] == "waiting"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0


def test_source_mode_contract_and_versioned_patch(client):
    saved = mandate(client)
    endpoint = f"/api/agent-automation/mandates/{saved['id']}"
    assert client.patch(endpoint, json={"expected_version": 1, "candidate_source": "explicit"}).status_code == 422
    changed = client.patch(endpoint, json={"expected_version": 1, "candidate_source": "explicit", "workflow": {"scope": "market", "candidate_symbols": ["SYNTA"]}})
    assert changed.status_code == 200 and changed.json()["mandate"]["version"] == 2
    assert client.patch(endpoint, json={"expected_version": 2, "candidate_source": "scan_pool"}).status_code == 422
    changed = client.patch(endpoint, json={"expected_version": 2, "candidate_source": "scan_pool", "workflow": {"scope": "market"}, "selector_limit": 3})
    assert changed.status_code == 200 and changed.json()["mandate"]["selector_limit"] == 3
