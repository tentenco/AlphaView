"""Synthetic, isolated rules-to-paper workflow contracts."""
import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store


AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB", "SYNTC", "SYNTD"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "agent.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    store.init_db()
    with store.connect() as db:
        agent.init_schema(db)
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
    app = FastAPI()
    app.include_router(agent.router)
    with TestClient(app) as result:
        yield result


def payload(**changes):
    return {"scope": "market", "candidate_symbols": SYMBOLS[:3], **changes}


def seed_scan(*, day=AS_OF, token="current", rows=None, universe=None):
    if rows is None:
        rows = [scan_row(symbol) for symbol in SYMBOLS]
    with store.connect() as db:
        revision = scan_provenance.current_token(db) if token == "current" else token
        cursor = db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('now',?,?,?,'market',?)",
                            (day, json.dumps(universe or SYMBOLS), json.dumps(rows), revision))
        return cursor.lastrowid


def scan_row(symbol, *, matches=("turtle", "trend"), missing=()):
    return {"symbol": symbol, "name": "Synthetic", "date": AS_OF, "bars": 240,
            "indicators": {"close": 100}, "signals": [
                {"strategy": strategy, "status": "match" if strategy in matches else "watch",
                 "matched": strategy in matches, "reason": "Synthetic rule"}
                for strategy in agent.STRATEGY_IDS if strategy not in missing]}


def test_preview_uses_fixed_slots_and_is_read_only(client):
    identifier = seed_scan()
    before = store.input_revision()
    with store.connect() as db:
        schema = [tuple(row) for row in db.execute("SELECT name,sql FROM sqlite_schema ORDER BY name")]
    with patch.object(agent, "init_schema", side_effect=AssertionError("Read must not create schema")):
        response = client.post("/api/portfolio-agent/preview", json=payload())
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "proposed"
    assert result["target_weights"] == [{"symbol": symbol, "weight_pct": 16} for symbol in SYMBOLS[:3]]
    assert result["cash_weight_pct"] == 52
    assert result["scan"]["id"] == identifier and result["scan"]["input_status"] == "current"
    assert result["coverage"] == {"requested": 3, "complete": 3, "eligible": 3, "selected": 3, "rejected": 0}
    assert [step["role"] for step in result["steps"]] == ["research_analyst", "allocation_planner", "risk_reviewer", "proposal"]
    assert all(step["engine"] == "deterministic_rules" for step in result["steps"])
    assert all(check["passed"] for check in result["risk_checks"])
    assert json.dumps(result, allow_nan=False)
    assert store.input_revision() == before
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0
        assert schema == [tuple(row) for row in db.execute("SELECT name,sql FROM sqlite_schema ORDER BY name")]


def test_missing_enabled_strategy_rejects_without_reweight_or_cash_redistribution(client):
    seed_scan(rows=[scan_row("SYNTA", missing=("rps",)), scan_row("SYNTB"), scan_row("SYNTC")])
    result = client.post("/api/portfolio-agent/preview", json=payload()).json()
    candidate = result["candidates"][0]
    assert candidate["score"] is None and candidate["coverage_pct"] == 75
    assert candidate["status"] == "rejected"
    assert {reason["code"] for reason in candidate["reasons"]} == {"enabled_strategy_unavailable"}
    assert next(part for part in candidate["contributions"] if part["strategy"] == "rps")["points"] is None
    assert result["target_weights"] == [{"symbol": "SYNTB", "weight_pct": 16}, {"symbol": "SYNTC", "weight_pct": 16}]
    assert result["cash_weight_pct"] == 68
    assert result["coverage"]["rejected"] == 1


def test_disabled_strategy_is_not_required_and_tie_break_is_stable(client):
    seed_scan(rows=[scan_row(symbol, missing=("rps", "pullback")) for symbol in SYMBOLS])
    body = payload(candidate_symbols=["SYNTC", "SYNTA", "SYNTB"],
                   strategy_weights={"turtle": 60, "trend": 40, "pullback": 0, "rps": 0},
                   constraints={"max_positions": 2, "max_position_weight_pct": 30, "cash_buffer_pct": 10})
    first = client.post("/api/portfolio-agent/preview", json=body).json()
    second = client.post("/api/portfolio-agent/preview", json=body).json()
    assert first == second
    assert first["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 30}]
    assert first["cash_weight_pct"] == 40
    assert first["candidates"][0]["status"] == "unselected"
    assert all(candidate["score"] == 100 for candidate in first["candidates"])


@pytest.mark.parametrize("fault", ["missing", "old_session", "legacy", "engine", "inputs", "universe"])
def test_unverified_or_stale_scan_blocks_allocation(client, fault):
    if fault != "missing":
        seed_scan(day="2024-01-03" if fault == "old_session" else AS_OF,
                  token=None if fault == "legacy" else "alphaview-scan-v999|" + store.input_revision() if fault == "engine" else "current",
                  universe=SYMBOLS[:2] if fault == "universe" else None)
    if fault == "inputs":
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    result = client.post("/api/portfolio-agent/preview", json=payload()).json()
    assert result["status"] == "blocked"
    assert result["target_weights"] == [] and result["cash_weight_pct"] is None
    assert result["blocking_reasons"]
    assert result["coverage"]["selected"] == 0


@pytest.mark.parametrize("fault", ["duplicate", "missing_signal", "bad_signal", "short_history", "old_row", "bad_quality", "bad_close", "quote", "nonfinite_quote"])
def test_candidate_evidence_failure_stays_unavailable(client, fault):
    row = scan_row("SYNTA")
    if fault == "duplicate":
        rows = [row, row]
    else:
        rows = [row]
    if fault == "missing_signal":
        row["signals"].pop()
    if fault == "bad_signal":
        row["signals"][0]["matched"] = False
    if fault == "short_history":
        row["bars"] = 20
    if fault == "old_row":
        row["date"] = "2024-01-03"
    if fault == "bad_quality":
        row["quality"] = {"valid": False, "status": "data_error"}
    if fault == "bad_close":
        row["indicators"]["close"] = None
    if fault in ("quote", "nonfinite_quote"):
        with store.connect() as db:
            if fault == "quote":
                db.execute("DELETE FROM bars WHERE symbol='SYNTA'")
            else:
                db.execute("UPDATE bars SET high=? WHERE symbol='SYNTA'", (float("inf"),))
    seed_scan(rows=rows)
    result = client.post("/api/portfolio-agent/preview", json=payload(candidate_symbols=["SYNTA"])).json()
    assert result["status"] == "blocked"
    assert result["candidates"][0]["score"] is None
    assert result["target_weights"] == []
    assert json.dumps(result, allow_nan=False)


def test_no_signal_does_not_become_empty_liquidation_proposal(client):
    seed_scan(rows=[scan_row(symbol, matches=()) for symbol in SYMBOLS])
    result = client.post("/api/portfolio-agent/preview", json=payload()).json()
    assert result["status"] == "blocked" and result["cash_weight_pct"] is None
    assert result["blocking_reasons"][0]["code"] == "no_eligible_candidates"
    assert all(row["score"] == 0 for row in result["candidates"])
    assert result["coverage"]["complete"] == 3


@pytest.mark.parametrize("changes", [
    {"candidate_symbols": ["SYNTA", "SYNTA"]},
    {"candidate_symbols": ["synthetic"]},
    {"candidate_symbols": []},
    {"candidate_symbols": ["SYNTA;DROP"]},
    {"surprise": True},
    {"strategy_weights": {"turtle": 30}},
    {"strategy_weights": {"turtle": 100, "trend": 0, "pullback": 0, "rps": 0}, "constraints": {"min_matches": 2}},
    {"constraints": {"cash_buffer_pct": 100}},
    {"constraints": {"max_position_weight_pct": 0}},
    {"constraints": {"max_positions": 31}},
    {"constraints": {"min_score": True}},
    {"constraints": {"max_positions": 1.0}},
    {"constraints": {"min_score": "NaN"}},
    {"constraints": {"min_score": "Infinity"}},
])
def test_strict_bounded_input_validation(client, changes):
    assert client.post("/api/portfolio-agent/preview", json=payload(**changes)).status_code == 422


def test_saved_trace_is_immutable_and_read_reports_currentness(client, monkeypatch):
    seed_scan()
    before = store.input_revision()
    result = client.post("/api/portfolio-agent/runs", json=payload())
    assert result.status_code == 201
    result = result.json()
    assert result["saved"] and result["id"]
    listed = client.get("/api/portfolio-agent/runs").json()["runs"]
    assert listed[0]["id"] == result["id"] and listed[0]["current"]
    detail = client.get(f"/api/portfolio-agent/runs/{result['id']}").json()
    assert detail["steps"] == result["steps"] and detail["current"]
    assert store.input_revision() == before
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    stale = client.get(f"/api/portfolio-agent/runs/{result['id']}").json()
    assert not stale["current"] and stale["stale_reasons"] == ["session_changed"]
    assert stale["proposal_fingerprint"] == result["proposal_fingerprint"]
    assert stale["target_weights"] == result["target_weights"]
    assert client.get("/api/portfolio-agent/runs/nonexistent").status_code == 404
    assert client.get("/api/portfolio-agent/runs?limit=101").status_code == 422
    assert client.get("/api/portfolio-agent/runs?limit=0").status_code == 422


@pytest.mark.parametrize("mutation", ["quote", "scan", "session", "engine", "scan_engine"])
def test_save_detects_concurrent_source_change_without_partial_run(client, monkeypatch, mutation):
    seed_scan()
    original = agent.preview
    def changed(body):
        result = original(body)
        if mutation == "quote":
            with store.connect() as db:
                db.execute("UPDATE bars SET volume=volume+1")
        elif mutation == "scan":
            seed_scan()
        elif mutation == "session":
            monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
        elif mutation == "engine":
            monkeypatch.setattr(agent, "ENGINE_VERSION", "alphaview-portfolio-agent-v999")
        else:
            monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v999")
        return result
    monkeypatch.setattr(agent, "preview", changed)
    response = client.post("/api/portfolio-agent/runs", json=payload())
    assert response.status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0


def test_blocked_run_is_saved_for_review_but_cannot_bridge(client):
    result = client.post("/api/portfolio-agent/runs", json=payload()).json()
    assert result["status"] == "blocked"
    detail = client.get(f"/api/portfolio-agent/runs/{result['id']}").json()
    assert detail["blocking_reasons"][0]["code"] == "scan_missing"


def test_repeat_schema_initialization_preserves_saved_trace(client):
    seed_scan()
    result = client.post("/api/portfolio-agent/runs", json=payload()).json()
    before = store.input_revision()
    with store.connect() as db:
        agent.init_schema(db)
        agent.init_schema(db)
    assert client.get(f"/api/portfolio-agent/runs/{result['id']}").json()["steps"] == result["steps"]
    assert store.input_revision() == before


def paper_account(**changes):
    from alphaview.panel import paper_portfolio as paper
    with store.connect() as db:
        paper.init_schema(db)
    account = paper.create_account(paper.AccountInput(
        name="Synthetic paper account", initial_cash=10000,
        idempotency_key="synthetic-account", **changes))
    return account["account"]["id"]


def test_paper_bridge_revalidates_and_only_saves_pending_proposal(client):
    seed_scan()
    account_id = paper_account()
    run = client.post("/api/portfolio-agent/runs", json=payload()).json()
    before = store.input_revision()
    body = {"account_id": account_id, "expected_account_version": 1}
    endpoint = f"/api/portfolio-agent/runs/{run['id']}"
    preview = client.post(endpoint + "/paper-preview", json=body)
    assert preview.status_code == 200
    paper = preview.json()["paper_preview"]
    assert paper["executable"] and paper["targets"] == run["target_weights"]
    assert paper["cash_weight_after_pct"] == run["cash_weight_pct"]
    assert run["id"] in paper["rationale"] and run["proposal_fingerprint"] in paper["rationale"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0
    body["idempotency_key"] = "synthetic-agent-proposal"
    proposal = client.post(endpoint + "/paper-proposal", json=body)
    assert proposal.status_code == 201
    saved = proposal.json()["paper_proposal"]
    assert saved["status"] == "proposed" and saved["accepted_at"] is None
    repeated = client.post(endpoint + "/paper-proposal", json=body).json()
    assert repeated["paper_proposal"]["id"] == saved["id"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_holdings").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 1
        request = json.loads(db.execute("SELECT request_json FROM paper_proposals").fetchone()[0])
        assert request["expected_input_revision"] == run["input_revision"]
        assert request["expected_as_of"] == run["as_of"]
    assert store.input_revision() == before


def test_paper_has_final_constraint_authority(client):
    seed_scan()
    account_id = paper_account(limits={"max_position_weight_pct": 10})
    run = client.post("/api/portfolio-agent/runs", json=payload()).json()
    assert run["status"] == "proposed"
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/paper-proposal",
                           json={"account_id": account_id, "expected_account_version": 1,
                                 "idempotency_key": "synthetic-blocked-proposal"})
    assert response.status_code == 201
    proposal = response.json()["paper_proposal"]
    assert proposal["status"] == "blocked" and not proposal["executable"]
    assert "max_position_weight" in {item["code"] for item in proposal["violations"]}


@pytest.mark.parametrize("condition", ["blocked", "stale", "engine", "scan_engine"])
def test_invalid_run_cannot_reach_paper_preview_or_proposal(client, monkeypatch, condition):
    from alphaview.panel import paper_portfolio as paper
    if condition != "blocked":
        seed_scan()
    account_id = paper_account()
    run = client.post("/api/portfolio-agent/runs", json=payload()).json()
    if condition == "stale":
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1")
    elif condition == "engine":
        monkeypatch.setattr(agent, "ENGINE_VERSION", "alphaview-portfolio-agent-v999")
    elif condition == "scan_engine":
        monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v999")
    body = {"account_id": account_id, "expected_account_version": 1}
    with patch.object(paper, "preview", side_effect=AssertionError("Stale run reached paper preview")), \
         patch.object(paper, "create_proposal_guarded", side_effect=AssertionError("Stale run reached paper proposal")):
        assert client.post(f"/api/portfolio-agent/runs/{run['id']}/paper-preview", json=body).status_code == 409
        body["idempotency_key"] = "synthetic-blocked-bridge"
        assert client.post(f"/api/portfolio-agent/runs/{run['id']}/paper-proposal", json=body).status_code == 409


@pytest.mark.parametrize("change", ["input", "session", "policy"])
def test_paper_write_transaction_rejects_source_change_after_bridge_check(client, monkeypatch, change):
    from alphaview.panel import paper_portfolio as paper
    seed_scan()
    account_id = paper_account()
    run = client.post("/api/portfolio-agent/runs", json=payload(
        account_context={"account_id": account_id, "expected_policy_version": 1})).json()
    original = paper.create_proposal_guarded
    def changed(account_id, body, guard=None):
        if change == "input":
            with store.connect() as db:
                db.execute("UPDATE bars SET volume=volume+1")
        elif change == "session":
            monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
        else:
            paper.update_controls(account_id, paper.ControlsInput(expected_version=1,
                symbol_policy={"mode": "allowlist", "symbols": SYMBOLS}))
        return original(account_id, body, guard=guard)
    monkeypatch.setattr(paper, "create_proposal_guarded", changed)
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/paper-proposal",
                           json={"account_id": account_id, "expected_account_version": 2 if change == "policy" else 1,
                                 "idempotency_key": "synthetic-concurrent-source"})
    assert response.status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0] == 0


def test_stale_engine_blocked_trace_can_be_saved_for_review(client):
    seed_scan(token="alphaview-scan-v999|" + store.input_revision())
    response = client.post("/api/portfolio-agent/runs", json=payload())
    assert response.status_code == 201
    result = response.json()
    assert result["status"] == "blocked"
    detail = client.get(f"/api/portfolio-agent/runs/{result['id']}").json()
    assert "scan_engine_changed" in detail["stale_reasons"]
    assert detail["blocking_reasons"][0]["code"] == "scan_provenance_unavailable"


def _policy_account(symbols=None, key="policy-account"):
    from alphaview.panel import paper_portfolio as paper
    return paper.create_account(paper.AccountInput(name="Synthetic policy", initial_cash=10000,
        idempotency_key=key, symbol_policy={"mode": "unrestricted" if symbols is None else "allowlist", "symbols": symbols or []}))["account"]


def test_bound_policy_removes_original_slots_without_backfill_and_records_version(client):
    seed_scan()
    account = _policy_account(["SYNTB", "SYNTC"])
    result = agent.create_run(agent.WorkflowInput(**payload(
        account_context={"account_id": account["id"], "expected_policy_version": 1},
        constraints={"max_positions": 2, "max_position_weight_pct": 30})))
    assert result["target_weights"] == [{"symbol": "SYNTB", "weight_pct": 30}]
    assert result["cash_weight_pct"] == 70 and result["allocation"]["unused_slots"] == 1
    assert result["candidates"][0]["status"] == "rejected"
    assert result["candidates"][0]["reasons"][0]["code"] == "symbol_not_allowed"
    assert result["candidates"][2]["status"] == "unselected"
    assert result["account_context"]["symbol_policy"] == account["symbol_policy"]
    assert agent.get_run(result["id"])["current"]


def test_policy_change_stales_bound_rule_run_and_blocks_cross_account_bridge(client):
    from alphaview.panel import paper_portfolio as paper
    from fastapi import HTTPException
    seed_scan()
    account = _policy_account(["SYNTA"])
    other = _policy_account(["SYNTA"], key="policy-other-account")
    run = agent.create_run(agent.WorkflowInput(**payload(account_context={"account_id": account["id"], "expected_policy_version": 1})))
    with pytest.raises(HTTPException) as exc:
        agent.paper_preview(run["id"], agent.PaperBridgeInput(account_id=other["id"], expected_account_version=1))
    assert exc.value.status_code == 409
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=1, symbol_policy={"mode": "allowlist", "symbols": []}))
    assert agent.get_run(run["id"])["stale_reasons"] == ["symbol_policy_changed"]
    with pytest.raises(HTTPException):
        agent.paper_proposal(run["id"], agent.PaperProposalBridgeInput(account_id=account["id"], expected_account_version=2, idempotency_key="stale-policy-run"))


def test_unbound_legacy_rule_bridge_still_enforces_current_account_allowlist(client):
    seed_scan()
    account = _policy_account(["SYNTA"])
    run = agent.create_run(agent.WorkflowInput(**payload()))
    result = agent.paper_preview(run["id"], agent.PaperBridgeInput(account_id=account["id"], expected_account_version=1))["paper_preview"]
    assert not result["executable"]
    assert {row["symbol"] for row in result["violations"] if row["code"] == "symbol_not_allowed"} == {"SYNTB", "SYNTC"}


def test_policy_edit_during_rule_save_rejected_atomically(client):
    from alphaview.panel import paper_portfolio as paper
    from fastapi import HTTPException
    seed_scan()
    account = _policy_account(["SYNTA"])
    body = agent.WorkflowInput(**payload(account_context={"account_id": account["id"], "expected_policy_version": 1}))
    result = agent.preview(body)
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=1, symbol_policy={"mode": "allowlist", "symbols": []}))
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        with pytest.raises(HTTPException):
            agent.save_preview(db, body, result)
        assert db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0] == 0
