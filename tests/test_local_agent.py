"""Synthetic local inference: bounded facts, durable jobs, paper source validation."""
import copy
import json
import sqlite3
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import local_agent as local
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent
from alphaview.panel import scan_provenance, sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]
MODEL = "synthetic:4b"


def output():
    return {"disposition": "continue", "roles": [
        {"role": "research_analyst", "assessment": "supported", "findings": [
            {"code": "complete_evidence", "evidence_ids": ["candidate:SYNTA:coverage"]}]},
        {"role": "allocation_reviewer", "assessment": "supported", "findings": [
            {"code": "within_position_limit", "evidence_ids": ["allocation:position_limit"]}]},
        {"role": "risk_reviewer", "assessment": "caution", "findings": [
            {"code": "forecast_not_available", "evidence_ids": ["limitation:forecast"]}]}],
        "decisions": [{"symbol": symbol, "action": "retain", "reason_code": "rule_consensus",
                       "evidence_ids": [f"candidate:{symbol}:score"]} for symbol in SYMBOLS]}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "local-agent.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    store.init_db()
    with store.connect() as db:
        local.init_schema(db)
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        rows = [{"symbol": symbol, "date": AS_OF, "bars": 240, "indicators": {"close": 100},
                 "signals": [{"strategy": strategy, "status": "match" if i < 2 else "watch", "matched": i < 2,
                              "reason": "Synthetic"} for i, strategy in enumerate(agent.STRATEGY_IDS)]} for symbol in SYMBOLS]
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (AS_OF, json.dumps(SYMBOLS), json.dumps(rows), scan_provenance.current_token(db)))
    source = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS))
    responses = {
        "/api/status": {"cloud": {"disabled": True}}, "/api/version": {"version": "0.24.0"},
        "/api/tags": {"models": [{"name": MODEL, "digest": "a" * 64, "size": 10000, "modified_at": "synthetic",
                                  "details": {"format": "gguf"}},
                                 {"name": "synthetic:cloud", "digest": "b" * 64, "size": 346, "details": {"format": "gguf"}}]},
        "/api/show": {"details": {"format": "gguf"}, "capabilities": ["completion", "thinking"]},
        "/api/chat": {"model": MODEL, "done": True, "done_reason": "stop", "message": {"role": "assistant", "content": json.dumps(output()),
                        "thinking": "This must never be saved"}, "total_duration": 100, "eval_count": 100},
    }
    calls = []
    def fake_ollama(method, path, payload=None, timeout=local.METADATA_TIMEOUT):
        calls.append((method, path, payload, timeout))
        value = responses[path]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value() if callable(value) else value)
    monkeypatch.setattr(local, "_ollama", fake_ollama)
    queued = []
    monkeypatch.setattr(local, "launch_locked", queued.append)
    app = FastAPI()
    app.include_router(local.router)
    app.include_router(paper.router)
    with TestClient(app) as client:
        yield {"client": client, "source": source, "responses": responses, "calls": calls, "queued": queued}
    if local.RUN_LOCK.locked():
        local.RUN_LOCK.release()


def launch(setup, **changes):
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": MODEL,
                                   "idempotency_key": "synthetic-local-analysis", **changes})
    assert response.status_code == 202, response.text
    return response.json()


def complete(setup, **changes):
    run = launch(setup, **changes)
    local.worker(run["id"])
    return setup["client"].get(f"/api/local-agent/runs/{run['id']}").json()


def counts():
    with store.connect() as db:
        return {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("local_agent_runs", "paper_proposals", "paper_ledger")}


def account(setup):
    return paper.create_account(paper.AccountInput(name="Synthetic paper", initial_cash=10000, idempotency_key="synthetic-account"))["account"]


def test_one_pass_three_viewpoints_and_readonly_history(setup):
    before = store.input_revision()
    queued = launch(setup)
    assert queued["status"] == "queued" and queued["phase"] == "source_check"
    assert queued["result"] is None and queued["proposal_ready"] is False
    local.worker(queued["id"])
    run = local.get_run(queued["id"])
    assert run["status"] == "completed" and run["phase"] == "finished"
    assert run["result"]["validation"] == {"valid": True, "issues": []}
    assert run["target_weights"] == setup["source"]["target_weights"]
    assert run["cash_weight_pct"] == 68 and run["single_model_pass"]
    assert len(run["result"]["role_views"]) == 3
    chats = [call for call in setup["calls"] if call[1] == "/api/chat"]
    assert len(chats) == 1 and chats[0][3] == 120
    prompt = chats[0][2]
    assert prompt["think"] is False and prompt["stream"] is False and "tools" not in prompt
    assert prompt["options"] == local.OPTIONS
    assert "This must never be saved" not in json.dumps(run)
    assert run["model"]["digest"] == "a" * 64 and run["prompt_digest"] and run["schema_digest"]
    prior = counts()
    with patch.object(local, "init_schema", side_effect=AssertionError("Readonly schema mutation")):
        history = setup["client"].get("/api/local-agent/runs").json()
        assert history["runs"][0]["id"] == run["id"] and "result" not in history["runs"][0]
        assert setup["client"].get(f"/api/local-agent/runs/{run['id']}").status_code == 200
    assert counts() == prior and store.input_revision() == before
    assert prior["paper_proposals"] == 0 and prior["paper_ledger"] == 0


def test_conservative_halves_slot_and_never_redistributes(setup):
    value = output()
    value["decisions"][0].update(action="halve", reason_code="no_forecast", evidence_ids=["candidate:SYNTA:slot", "limitation:forecast"])
    setup["responses"]["/api/chat"]["message"]["content"] = json.dumps(value)
    run = complete(setup, mode="conservative")
    assert run["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 8}, {"symbol": "SYNTB", "weight_pct": 16}]
    assert run["cash_weight_pct"] == 76 and run["proposal_ready"]


@pytest.mark.parametrize("fault,code", [
    ("unknown_citation", "invalid_citation"), ("duplicate_citation", "invalid_citation"),
    ("unsupported_finding", "unsupported_finding"), ("wrong_own_evidence", "unsupported_decision"),
    ("new_symbol", "symbol_set_invalid"), ("duplicate_symbol", "symbol_set_invalid"), ("missing_symbol", "symbol_set_invalid"),
    ("duplicate_role", "role_set_invalid"), ("reduce_analysis", "analysis_cannot_reallocate"),
    ("abstain", "model_abstained"), ("all_zero", "all_targets_zero"), ("market_claim", "invalid_model_schema"),
    ("malformed", "invalid_model_schema"), ("empty", "invalid_model_schema"), ("nan", "invalid_model_schema"),
])
def test_bad_output_is_blocked_without_fallback_targets(setup, fault, code):
    value = output()
    mode = "analysis"
    if fault == "unknown_citation": value["roles"][0]["findings"][0]["evidence_ids"] = ["invented:source"]
    if fault == "duplicate_citation": value["roles"][0]["findings"][0]["evidence_ids"] *= 2
    if fault == "unsupported_finding": value["roles"][0]["findings"][0]["evidence_ids"] = ["candidate:SYNTA:quote"]
    if fault == "wrong_own_evidence": value["decisions"][0]["evidence_ids"] = ["candidate:SYNTB:score"]
    if fault == "new_symbol": value["decisions"][0]["symbol"] = "UNKNOWN"
    if fault == "duplicate_symbol": value["decisions"][0] = value["decisions"][1]
    if fault == "missing_symbol": value["decisions"].pop()
    if fault == "duplicate_role": value["roles"][0] = value["roles"][1]
    if fault == "reduce_analysis": value["decisions"][0]["action"] = "halve"
    if fault == "abstain": value["disposition"] = "abstain"
    if fault == "all_zero":
        mode = "conservative"
        for decision in value["decisions"]: decision["action"] = "exclude"
    if fault == "market_claim": value["predicted_price"] = 120
    content = "{" if fault == "malformed" else "{}" if fault == "empty" else '{"x":NaN}' if fault == "nan" else json.dumps(value)
    setup["responses"]["/api/chat"]["message"]["content"] = content
    run = complete(setup, mode=mode)
    assert run["status"] == "blocked" and not run["proposal_ready"] and run["target_weights"] == []
    assert code in {item["code"] for item in run["result"]["validation"]["issues"]}
    assert counts()["paper_proposals"] == 0


@pytest.mark.parametrize("fault", ["cloud", "status_missing", "null_cloud", "remote_tags", "remote_show", "null_details", "no_completion", "uninstalled"])
def test_unverified_runtime_never_calls_inference(setup, fault):
    if fault == "cloud": setup["responses"]["/api/status"]["cloud"]["disabled"] = False
    if fault == "status_missing": setup["responses"]["/api/status"] = HTTPException(503, "old runtime")
    if fault == "null_cloud": setup["responses"]["/api/status"]["cloud"] = None
    if fault == "remote_tags": setup["responses"]["/api/tags"]["models"][0]["remote_host"] = "remote.example"
    if fault == "remote_show": setup["responses"]["/api/show"]["remote_model"] = "remote"
    if fault == "null_details": setup["responses"]["/api/tags"]["models"][0]["details"] = None
    if fault == "no_completion": setup["responses"]["/api/show"]["capabilities"] = None
    if fault == "uninstalled": setup["responses"]["/api/tags"]["models"] = []
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": MODEL,
                                    "idempotency_key": "synthetic-analysis"})
    assert response.status_code in (422, 503), response.text
    assert counts()["local_agent_runs"] == 0 and not local.RUN_LOCK.locked()
    assert not any(call[1] == "/api/chat" for call in setup["calls"])


@pytest.mark.parametrize("name", ["test:cloud", "https://external.example/model", "registry.example/model:4b", "model\n:4b"])
def test_remote_model_names_rejected_before_metadata(setup, name):
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": name,
                                    "idempotency_key": "synthetic-analysis"})
    assert response.status_code == 422 and setup["calls"] == []


def test_models_filters_cloud_and_exposes_setup_reason(setup):
    result = setup["client"].get("/api/local-agent/models").json()
    assert result["available"] and [m["name"] for m in result["models"]] == [MODEL]
    assert result["rejected_models"] == [{"name": "synthetic:cloud", "reason": "cloud_or_unsupported_name"}]
    setup["responses"]["/api/status"] = HTTPException(503, "unreachable")
    result = setup["client"].get("/api/local-agent/models").json()
    assert result["available"] is False and "OLLAMA_NO_CLOUD=1" in result["reason"]


def test_same_key_replay_never_restarts_and_other_job_conflicts(setup):
    first = launch(setup)
    assert launch(setup)["id"] == first["id"]
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": MODEL,
                                    "mode": "conservative", "idempotency_key": "synthetic-local-analysis"})
    assert response.status_code == 409
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": MODEL,
                                    "idempotency_key": "second-analysis"})
    assert response.status_code == 409 and len(setup["queued"]) == 1
    local.worker(first["id"])
    assert launch(setup)["status"] == "completed" and len(setup["queued"]) == 1


@pytest.mark.parametrize("when", ["queued", "inference"])
def test_cancel_discards_result_without_paper_actions(setup, when):
    run = launch(setup)
    if when == "queued":
        cancelled = local.cancel_run(run["id"])
        assert cancelled["cancel_requested"] and cancelled["status"] == "queued"
    else:
        normal = setup["responses"]["/api/chat"]
        def chat():
            local.cancel_run(run["id"])
            return normal
        setup["responses"]["/api/chat"] = chat
    local.worker(run["id"])
    finished = local.get_run(run["id"])
    assert finished["status"] == "cancelled" and finished["target_weights"] == []
    assert not finished["proposal_ready"] and counts()["paper_proposals"] == 0
    assert not local.RUN_LOCK.locked()
    if when == "queued": assert not any(call[1] == "/api/chat" for call in setup["calls"])


def test_refresh_during_inference_is_unblocked_and_result_stale(setup):
    normal = setup["responses"]["/api/chat"]
    def chat():
        # A separate real writer succeeds while inference is pending: no long DB transaction.
        with sqlite3.connect(store.db_path(), timeout=0.1) as db:
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        return normal
    setup["responses"]["/api/chat"] = chat
    run = complete(setup)
    assert run["status"] == "stale" and not run["proposal_ready"]
    assert run["error"]["code"] == "source_changed" and run["target_weights"] == []
    assert run["result"]["raw_content"]


def test_model_replacement_during_inference_is_stale(setup):
    normal = setup["responses"]["/api/chat"]
    def chat():
        setup["responses"]["/api/tags"]["models"][0]["digest"] = "c" * 64
        return normal
    setup["responses"]["/api/chat"] = chat
    run = complete(setup)
    assert run["status"] == "stale" and run["error"]["code"] == "model_changed"


@pytest.mark.parametrize("fault", ["timeout", "remote", "truncated", "empty", "tools", "wrong_model"])
def test_runtime_failures_do_not_become_completed(setup, fault):
    response = setup["responses"]["/api/chat"]
    if fault == "timeout": setup["responses"]["/api/chat"] = HTTPException(503, "timed out")
    if fault == "remote": response["remote_host"] = "example.com"
    if fault == "truncated": response["done_reason"] = "length"
    if fault == "empty": response["message"]["content"] = ""
    if fault == "tools": response["message"]["tool_calls"] = [{"function": {"name": "trade"}}]
    if fault == "wrong_model": response["model"] = "other:4b"
    run = complete(setup)
    assert run["status"] in ("failed", "blocked") and not run["proposal_ready"]
    assert run["target_weights"] == [] and not local.RUN_LOCK.locked()


def test_recovery_marks_only_orphan_and_requires_lock(setup):
    run = launch(setup)
    assert local.recover_interrupted() is False
    local.RUN_LOCK.release()  # Simulated vanished process releases kernel lock.
    assert local.recover_interrupted() is True
    result = local.get_run(run["id"])
    assert result["status"] == "interrupted" and result["error"]["code"] == "process_interrupted"
    assert launch(setup)["id"] == run["id"] and len(setup["queued"]) == 1


def test_source_mutation_before_launch_blocks_without_inference(setup):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
    response = setup["client"].post("/api/local-agent/runs", json={"source_run_id": setup["source"]["id"], "model": MODEL,
                                    "idempotency_key": "synthetic-analysis"})
    assert response.status_code == 409 and setup["calls"] == []


def test_paper_bridge_source_bound_and_manual_accept_revalidates(setup):
    run = complete(setup)
    acct = account(setup)
    bridge = {"account_id": acct["id"], "expected_account_version": acct["version"]}
    preview = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview", json=bridge)
    assert preview.status_code == 200, preview.text
    assert preview.json()["paper_preview"]["executable"]
    assert counts()["paper_proposals"] == 0
    response = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-proposal", json={**bridge, "idempotency_key": "synthetic-proposal"})
    assert response.status_code == 201, response.text
    proposal = response.json()["paper_proposal"]
    assert proposal["status"] == "proposed"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
        db.execute("UPDATE bars SET volume=volume+1")
    assert local.get_run(run["id"])["status"] == "stale"
    assert setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview", json=bridge).status_code == 409
    accepted = setup["client"].post(f"/api/paper/accounts/{acct['id']}/proposals/{proposal['id']}/accept",
                                   json={"expected_version": acct["version"], "idempotency_key": "synthetic-accept"})
    assert accepted.status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0


def test_paper_targets_cannot_be_changed_under_local_analysis_binding(setup):
    run = complete(setup)
    acct = account(setup)
    changed = copy.deepcopy(run["target_weights"])
    changed[0]["weight_pct"] = 20
    response = setup["client"].post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": 1, "targets": changed,
                                   "local_agent_source": {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION}})
    assert response.status_code == 409 and counts()["paper_proposals"] == 0


def test_current_valid_analysis_can_only_fill_after_explicit_paper_accept(setup):
    run = complete(setup)
    acct = account(setup)
    bridge = agent.PaperProposalBridgeInput(account_id=acct["id"], expected_account_version=1, idempotency_key="synthetic-proposal")
    proposed = local.paper_proposal(run["id"], bridge)["paper_proposal"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
    result = paper.accept_proposal(acct["id"], proposed["id"], paper.AcceptInput(expected_version=1, idempotency_key="synthetic-accept"))
    assert result["proposal"]["status"] == "simulated"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 2


def test_historical_prompt_options_and_version_do_not_follow_runtime_defaults(setup, monkeypatch):
    run = complete(setup)
    monkeypatch.setattr(local, "OPTIONS", {"temperature": 1})
    monkeypatch.setattr(local, "PROMPT_VERSION", "future-prompt-version")
    historical = local.get_run(run["id"])
    assert historical["options"] == run["options"]
    assert historical["prompt_version"] == run["prompt_version"]


@pytest.mark.parametrize("status,body,expected", [(200, b'{"cloud":{"disabled":true}}', None),
                                                  (302, b'{}', 'redirect'), (503, b'{}', 'HTTP 503'),
                                                  (200, b'{"v":NaN}', 'JSON'), (200, b'{"v":1,"v":2}', 'JSON')])
def test_fixed_loopback_transport_never_follows_redirect_or_proxy(monkeypatch, status, body, expected):
    requests = []
    class Response:
        def __init__(self): self.status = status
        def read(self, maximum):
            assert maximum == local.MAX_RESPONSE_BYTES + 1
            return body
    class Connection:
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("127.0.0.1", 11434, 3)
        def request(self, method, path, body, headers): requests.append((method, path, body))
        def getresponse(self): return Response()
        def close(self): requests.append("closed")
    monkeypatch.setenv("HTTP_PROXY", "http://must-not-use.example:80")
    monkeypatch.setattr(local.http.client, "HTTPConnection", Connection)
    if expected:
        with pytest.raises(HTTPException) as error:
            local._ollama("GET", "/api/status")
        assert expected in error.value.detail
    else:
        assert local._ollama("GET", "/api/status") == {"cloud": {"disabled": True}}
    assert requests == [("GET", "/api/status", None), "closed"]
    with pytest.raises(HTTPException) as error:
        local._ollama("POST", "/api/pull", {"model": MODEL})
    assert error.value.status_code == 422 and len(requests) == 2


def test_historical_authorization_allows_new_session_without_weakening_current_bridge(setup, monkeypatch):
    run = complete(setup)
    binding = {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION}
    before = counts()
    with store.connect() as db:
        frozen = local.validate_historical_source(db, binding)
        assert local.validate_source(db, binding)["target_weights"] == frozen["target_weights"]
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-05',101,111,91,101,101,1000)")
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    with store.connect() as db:
        assert local.validate_historical_source(db, binding, expected_fingerprint=frozen["authorization_fingerprint"]) == frozen
        with pytest.raises(HTTPException) as error:
            local.validate_source(db, binding)
        assert error.value.status_code == 409
    assert counts() == before
    assert local.get_run(run["id"])["status"] == "stale"


@pytest.mark.parametrize("fault", ["cancel", "status", "method", "source_target", "source_metadata", "source_summary", "facts", "prompt", "output", "targets", "frozen_hash"])
def test_historical_authorization_rechecks_immutable_source_and_output(setup, fault):
    run = complete(setup)
    binding = {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION}
    with store.connect() as db:
        frozen = local.validate_historical_source(db, binding)
        if fault == "cancel":
            db.execute("UPDATE local_agent_runs SET cancel_requested=1 WHERE id=?", (run["id"],))
        if fault == "status":
            db.execute("UPDATE local_agent_runs SET status='blocked' WHERE id=?", (run["id"],))
        if fault == "method":
            db.execute("UPDATE local_agent_runs SET engine_version='future-version' WHERE id=?", (run["id"],))
        if fault == "source_target":
            result = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (run["source_run_id"],)).fetchone()[0])
            result["target_weights"][0]["weight_pct"] = 24
            db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (json.dumps(result), run["source_run_id"]))
        if fault == "source_metadata":
            db.execute("UPDATE portfolio_agent_runs SET status='blocked' WHERE id=?", (run["source_run_id"],))
        if fault in ("source_summary", "facts", "prompt", "output", "targets"):
            column = {"source_summary": "source_json", "facts": "facts_json", "prompt": "prompt_json", "output": "result_json", "targets": "result_json"}[fault]
            value = json.loads(db.execute(f"SELECT {column} FROM local_agent_runs WHERE id=?", (run["id"],)).fetchone()[0])
            if fault == "source_summary": value["cash_weight_pct"] = 50
            if fault == "facts": value[0]["value"] = 99
            if fault == "prompt": value["options"]["temperature"] = 1
            if fault == "output": value["raw_content"] = "{}"
            if fault == "targets": value["target_weights"][0]["weight_pct"] = 24
            db.execute(f"UPDATE local_agent_runs SET {column}=? WHERE id=?", (json.dumps(value), run["id"]))
        expected = "0" * 64 if fault == "frozen_hash" else frozen["authorization_fingerprint"]
        with pytest.raises(HTTPException) as error:
            local.validate_historical_source(db, binding, expected_fingerprint=expected)
        assert error.value.status_code == 409


def test_local_analysis_inherits_policy_binding_and_refuses_other_account(setup):
    owner = account(setup)
    source = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS,
        account_context={"account_id": owner["id"], "expected_policy_version": 1}))
    setup["source"] = source
    run = complete(setup)
    assert run["source"]["account_context"]["symbol_policy"] == owner["symbol_policy"]
    other = paper.create_account(paper.AccountInput(name="Synthetic other", initial_cash=10000,
        idempotency_key="other-policy-account"))["account"]
    response = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview", json={
        "account_id": other["id"], "expected_account_version": 1})
    assert response.status_code == 409
    with store.connect() as db:
        authority = local.validate_historical_source(db, {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION})
    assert authority["account_context"]["account_id"] == owner["id"]
    paper.update_controls(owner["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))
    assert not local.get_run(run["id"])["current"]
    with store.connect() as db, pytest.raises(HTTPException):
        local.validate_historical_source(db, {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION})


def test_unbound_local_analysis_cannot_bypass_current_policy(setup):
    owner = account(setup)
    run = complete(setup)
    owner = paper.update_controls(owner["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))["account"]
    response = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview", json={
        "account_id": owner["id"], "expected_account_version": owner["version"]})
    assert response.status_code == 200
    result = response.json()["paper_preview"]
    assert not result["executable"]
    assert {row["symbol"] for row in result["violations"] if row["code"] == "symbol_not_allowed"} == {"SYNTB"}
