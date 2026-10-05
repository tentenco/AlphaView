"""Jev decision gate: synthetic sources, mocked transport, no real keys or provider calls."""
import copy
import json
from unittest.mock import MagicMock

import pytest
import requests
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import jev_decision as jev
from alphaview.panel import paper_next_open, paper_portfolio as paper, portfolio_agent as agent, portfolio_inbox
from alphaview.panel import scan_provenance, sessions, store

AS_OF = "2024-01-04"
SYMBOLS = ["SYNTA", "SYNTB"]
KEY = "apikey_synthetic00000000000000000000_synthetic0000000000000000000000000000"


def indicators(**overrides):
    base = {"close": 110, "ma20": 105, "ma50": 100, "ma200": 90, "high20": 108, "high120": 112,
            "volume_ratio": 1.6, "rsi": 63, "return120": 0.24, "rps": 91}
    return {**base, **overrides}


def scan_row(symbol, matches=("turtle", "trend"), **overrides):
    return {"symbol": symbol, "name": "Synthetic", "date": AS_OF, "bars": 240, "indicators": indicators(**overrides),
            "signals": [{"strategy": strategy, "status": "match" if strategy in matches else "watch",
                         "matched": strategy in matches, "reason": "Synthetic"} for strategy in agent.STRATEGY_IDS]}


def answers_for(symbols, **overrides):
    result = {}
    for symbol in symbols:
        result[f"{symbol}:uptrend_intact"] = {"type": "noul", "noul": 0.96}
        result[f"{symbol}:buying_pressure"] = {"type": "noul", "noul": 0.92}
        result[f"{symbol}:overextended"] = {"type": "noul", "noul": 0.32}
        result[f"{symbol}:setup_quality"] = {"type": "score", "score": 2.95, "confidence": 0.95,
                                            "legend": {"0": "Weak", "1": "Mixed", "2": "Constructive", "3": "Strong"},
                                            "probabilities": {"0": 0.0, "1": 0.01, "2": 0.03, "3": 0.96}}
    result.update(overrides)
    return result


def response(symbols=SYMBOLS, **overrides):
    return {"model": jev.MODEL, "answers": answers_for(symbols, **overrides), "usage": {"input_tokens": 658, "output_tokens": 90}}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "jev.db"))
    monkeypatch.delenv("ALPHAVIEW_JEV_CREDENTIALS_PATH", raising=False)
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: AS_OF)
    monkeypatch.setattr(jev, "RETRY_DELAY_SECONDS", 0)
    monkeypatch.setattr(requests.Session, "request", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    store.init_db()
    with store.connect() as db:
        for symbol in SYMBOLS:
            db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','now',1000000000)", (symbol, "Synthetic"))
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                   (AS_OF, json.dumps(SYMBOLS), json.dumps([scan_row(symbol) for symbol in SYMBOLS]), scan_provenance.current_token(db)))
    source = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS))
    calls = []
    state = {"response": response(), "models": {"models": [{"name": "jev-latest", "description": "Synthetic", "release_date": "2026"}]}}

    def fake_call(config, method, path, payload=None):
        assert config["api_key"] == KEY
        calls.append((method, path, copy.deepcopy(payload)))
        value = state["response"] if path == jev.EVALUATE_PATH else state["models"]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value() if callable(value) else value), 231
    monkeypatch.setattr(jev, "_call", fake_call)
    app = FastAPI()
    app.include_router(jev.router)
    app.include_router(paper.router)
    with TestClient(app) as client:
        yield {"client": client, "source": source, "calls": calls, "state": state}


def connect(setup, **extra):
    result = setup["client"].post("/api/jev/connection", json={"api_key": KEY, **extra})
    assert result.status_code == 200, result.text
    return result.json()


def run(setup, **changes):
    result = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"],
                                                          "idempotency_key": "synthetic-jev-run", **changes})
    assert result.status_code == 201, result.text
    return result.json()


def counts():
    with store.connect() as db:
        return {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("jev_decision_runs", "paper_proposals", "paper_ledger")}


def account(setup, name="Synthetic paper", key="synthetic-account"):
    return paper.create_account(paper.AccountInput(name=name, initial_cash=10000, idempotency_key=key))["account"]


def test_connection_is_offline_owner_only_and_never_echoes_the_key(setup, tmp_path):
    client = setup["client"]
    assert client.get("/api/jev/connection").json()["configured"] is False
    unconfigured = client.post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-jev-run"})
    assert unconfigured.status_code == 409 and unconfigured.json()["detail"]["code"] == "not_configured"
    revision = store.input_revision()
    saved = connect(setup)
    assert [call[1] for call in setup["calls"]] == [jev.MODELS_PATH]
    path = jev.credential_path()
    assert path.parent == store.db_path().parent and path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["api_key"] == KEY
    public = client.get("/api/jev/connection")
    assert public.headers["cache-control"] == "no-store"
    assert public.json()["configured"] is True and public.json()["model"] == jev.MODEL
    assert public.json()["trading_enabled"] is False and public.json()["available_models"] == ["jev-latest"]
    assert KEY not in public.text and KEY not in json.dumps(saved)
    assert store.input_revision() == revision
    for change in ({"api_key": "sk-not-a-typesafe-key-000000000"}, {"api_key": "apikey_short"}, {"extra": KEY},
                   {"expected_version": [KEY]}, {"api_key": "apikey_" + "a" * 5000}):
        result = client.post("/api/jev/connection", json={"api_key": KEY, **change})
        assert result.status_code == 422 and KEY not in result.text
    assert client.post("/api/jev/connection", json={"api_key": KEY}).status_code == 409
    before = path.read_bytes()
    setup["state"]["models"] = jev._problem("authentication_failed", "Synthetic denial", 401)
    rejected = client.post("/api/jev/connection", json={"api_key": KEY, "expected_version": saved["version"]})
    assert rejected.status_code == 401 and path.read_bytes() == before and KEY not in rejected.text
    path.chmod(0o644)
    loose = client.get("/api/jev/connection")
    assert loose.status_code == 503 and KEY not in loose.text
    path.chmod(0o600)
    target = tmp_path / "elsewhere.json"
    path.rename(target)
    path.symlink_to(target)
    assert client.get("/api/jev/connection").status_code == 503
    path.unlink()
    target.rename(path)
    assert client.request("DELETE", "/api/jev/connection", json={"expected_version": "old"}).status_code == 409
    removed = client.request("DELETE", "/api/jev/connection", json={"expected_version": saved["version"]})
    assert removed.status_code == 200 and removed.json()["configured"] is False and not path.exists()


def test_question_set_is_versioned_offline_and_english(setup):
    result = setup["client"].get("/api/jev/questions").json()
    assert result["question_set_version"] == jev.QUESTION_SET_VERSION and result["model"] == jev.MODEL
    assert [question["id"] for question in result["questions"]] == ["uptrend_intact", "buying_pressure", "overextended", "setup_quality"]
    assert [question["gate"] for question in result["questions"]] == ["high", "high", "low", None]
    assert all("candidates.<symbol>" in question["instructions"] for question in result["questions"])
    assert result["default_policy"] == {"pass_threshold": 0.7, "max_risk_probability": 0.5}
    assert setup["calls"] == [] and json.dumps(result, allow_nan=False)


def test_state_is_program_bucketed_and_contains_no_private_data(setup):
    connect(setup)
    acct = account(setup)
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,cost,sector,source,updated_at) VALUES ('SYNTA','Private',12345,67.89,'x','y','now')")
        db.execute("INSERT INTO research_notes(symbol,note,tags,version,updated_at) VALUES ('SYNTA','secret note','[]',1,'now')")
        # Positions are an input table; re-stamp the synthetic scan so the rules run stays current.
        db.execute("UPDATE scans SET input_revision=?", (scan_provenance.current_token(db),))
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS))
    run(setup)
    method, path, payload = [call for call in setup["calls"] if call[1] == jev.EVALUATE_PATH][0]
    assert method == "POST" and payload["model"] == jev.MODEL
    candidate = payload["state"]["candidates"]["SYNTA"]
    assert "bullish alignment" in candidate["trend_structure"]
    assert candidate["breakout_20d"].startswith("close is above the prior 20-day high")
    assert candidate["volume"] == "heavy: 1.6x the 20-day average volume"
    assert candidate["rsi_14"] == "strong momentum (RSI 55-70), RSI 63"
    assert candidate["relative_strength"] == "top quintile of the scanned universe (RPS 91)"
    assert candidate["distance_from_120d_high"] == "at or within 2% of the 120-day high"
    assert candidate["strategy_signals"] == {"turtle_breakout": "matched", "trend_following": "matched",
                                             "rsi_pullback": "not matched", "relative_strength": "not matched"}
    assert set(payload["questions"]) == {f"{symbol}:{question['id']}" for symbol in SYMBOLS for question in jev.QUESTIONS}
    assert all("`candidates.SYNTA`" in question["instructions"] for key, question in payload["questions"].items() if key.startswith("SYNTA:"))
    serialized = json.dumps(payload)
    for private in ("12345", "67.89", "secret note", "Private", acct["id"], "shares", "cost", "note"):
        assert private not in serialized


def test_gate_passes_and_bridges_to_paper_with_explicit_accept(setup):
    connect(setup)
    revision = store.input_revision()
    result = run(setup)
    assert result["status"] == "completed" and result["proposal_ready"] and result["counts"] == {"pass": 2, "fail": 0, "unavailable": 0}
    assert result["target_weights"] == setup["source"]["target_weights"] and result["cash_weight_pct"] == 68
    assert result["model"] == {"requested": jev.MODEL, "answered": jev.MODEL} and result["latency_ms"] == 231
    assert result["usage"] == {"input_tokens": 658, "output_tokens": 90}
    assert result["estimated_cost_usd"] == pytest.approx(658 * 0.042 / 1_000_000)
    decision = result["result"]["decisions"][0]
    assert decision["status"] == "pass" and [check["passed"] for check in decision["checks"]] == [True, True, True]
    assert decision["setup_quality"]["level_label"] == "Strong" and decision["target_weight_pct"] == 16
    assert result["question_set_version"] == jev.QUESTION_SET_VERSION and result["current"]
    assert json.dumps(result, allow_nan=False) and store.input_revision() == revision
    acct = account(setup)
    bridge = {"account_id": acct["id"], "expected_account_version": acct["version"]}
    preview = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-preview", json=bridge)
    assert preview.status_code == 200 and preview.json()["paper_preview"]["executable"]
    assert preview.json()["paper_preview"]["jev_source"] == {"run_id": result["id"], "engine_version": jev.ENGINE_VERSION}
    assert counts()["paper_proposals"] == 0
    saved = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-proposal", json={**bridge, "idempotency_key": "synthetic-proposal"})
    assert saved.status_code == 201, saved.text
    proposal = saved.json()["paper_proposal"]
    assert proposal["status"] == "proposed" and proposal["jev_source"]["run_id"] == result["id"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 0
    accepted = paper.accept_proposal(acct["id"], proposal["id"], paper.AcceptInput(expected_version=acct["version"], idempotency_key="synthetic-accept"))
    assert accepted["proposal"]["status"] == "simulated"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0] == 2
    assert len([call for call in setup["calls"] if call[1] == jev.EVALUATE_PATH]) == 1


@pytest.mark.parametrize("override,failing", [
    ({"SYNTB:buying_pressure": {"type": "noul", "noul": 0.4}}, "buying_pressure"),
    ({"SYNTB:overextended": {"type": "noul", "noul": 0.7}}, "overextended"),
])
def test_failed_threshold_excludes_symbol_and_holds_cash(setup, override, failing):
    connect(setup)
    setup["state"]["response"] = response(**override)
    result = run(setup)
    assert result["status"] == "completed" and result["counts"] == {"pass": 1, "fail": 1, "unavailable": 0}
    assert result["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 16}, {"symbol": "SYNTB", "weight_pct": 0.0}]
    assert result["cash_weight_pct"] == 84
    failed = [decision for decision in result["result"]["decisions"] if decision["symbol"] == "SYNTB"][0]
    assert failed["status"] == "fail"
    assert [check["question"] for check in failed["checks"] if check["passed"] is False] == [failing]


def test_policy_thresholds_are_bounded_recorded_and_can_block_everything(setup):
    connect(setup)
    invalid = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-bad",
                                                          "policy": {"pass_threshold": 0.3, "max_risk_probability": 0.5}})
    assert invalid.status_code == 422 and setup["calls"] == [call for call in setup["calls"] if call[1] == jev.MODELS_PATH]
    result = run(setup, policy={"pass_threshold": 0.95, "max_risk_probability": 0.5})
    assert result["status"] == "blocked" and not result["proposal_ready"] and result["target_weights"] == []
    assert result["policy"] == {"pass_threshold": 0.95, "max_risk_probability": 0.5}
    assert result["counts"] == {"pass": 0, "fail": 2, "unavailable": 0} and result["cash_weight_pct"] is None
    assert [reason["code"] for reason in result["result"]["blocking_reasons"]] == ["no_passing_candidates"]
    acct = account(setup)
    bridge = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-preview", json={"account_id": acct["id"], "expected_account_version": 1})
    assert bridge.status_code == 409 and counts()["paper_proposals"] == 0


@pytest.mark.parametrize("fault", ["missing_answer", "extra_answer", "nan", "wrong_type", "wrong_model", "out_of_range"])
def test_invalid_answers_block_without_reweighting(setup, fault):
    connect(setup)
    value = response()
    if fault == "missing_answer":
        del value["answers"]["SYNTB:uptrend_intact"]
    if fault == "extra_answer":
        value["answers"]["SYNTC:uptrend_intact"] = {"type": "noul", "noul": 0.9}
    if fault == "nan":
        value["answers"]["SYNTB:uptrend_intact"]["noul"] = float("nan")
    if fault == "wrong_type":
        value["answers"]["SYNTB:uptrend_intact"] = {"type": "score", "score": 1}
    if fault == "wrong_model":
        value["model"] = "jev-2.0.0"
    if fault == "out_of_range":
        value["answers"]["SYNTB:uptrend_intact"]["noul"] = 1.5
    setup["state"]["response"] = value
    result = run(setup)
    assert result["status"] == "blocked" and result["error"]["code"] == "answers_invalid"
    assert result["target_weights"] == [] and result["cash_weight_pct"] is None and not result["proposal_ready"]
    decisions = {decision["symbol"]: decision for decision in result["result"]["decisions"]}
    if fault not in ("extra_answer", "wrong_model"):
        assert decisions["SYNTB"]["status"] == "unavailable" and decisions["SYNTB"]["target_weight_pct"] == 0
        assert decisions["SYNTA"]["status"] == "pass"
    assert json.dumps(result, allow_nan=False) and counts()["jev_decision_runs"] == 1


def test_incomplete_indicators_mark_symbol_unavailable_without_fabrication(setup):
    connect(setup)
    with store.connect() as db:
        rows = [scan_row("SYNTA"), scan_row("SYNTB", ma200=None)]
        db.execute("UPDATE scans SET result=?", (json.dumps(rows),))
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS))
    setup["state"]["response"] = response(["SYNTA"])
    result = run(setup)
    payload = [call for call in setup["calls"] if call[1] == jev.EVALUATE_PATH][0][2]
    assert list(payload["state"]["candidates"]) == ["SYNTA"] and len(payload["questions"]) == 4
    decisions = {decision["symbol"]: decision for decision in result["result"]["decisions"]}
    assert decisions["SYNTB"]["status"] == "unavailable" and decisions["SYNTB"]["missing"] == ["ma200"]
    assert all(check["reason"] == "state_incomplete" for check in decisions["SYNTB"]["checks"])
    assert result["status"] == "completed" and result["target_weights"] == [{"symbol": "SYNTA", "weight_pct": 16}, {"symbol": "SYNTB", "weight_pct": 0.0}]


def test_transport_problems_do_not_persist_runs_or_expose_the_key(setup):
    connect(setup)
    for code, status in (("rate_limited", 503), ("network_unavailable", 503), ("authentication_failed", 401), ("invalid_response", 502)):
        setup["state"]["response"] = jev._problem(code, "Synthetic " + KEY, status)
        result = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-" + code})
        assert result.status_code == status and result.json()["detail"]["code"] == code
    assert counts()["jev_decision_runs"] == 0


def test_fixed_transport_is_bounded_without_proxy_or_redirects(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://must-not-use.example:80")
    monkeypatch.setattr(jev, "RETRY_DELAY_SECONDS", 0)
    statuses = []
    bodies = {"body": json.dumps(response()).encode()}
    reply = MagicMock()
    reply.__enter__.return_value = reply
    reply.iter_content.side_effect = lambda chunk_size: [bodies["body"]]
    session = MagicMock()
    session.__enter__.return_value = session

    def request(method, url, **kwargs):
        reply.status_code = statuses.pop(0) if statuses else 200
        return reply
    session.request.side_effect = request
    monkeypatch.setattr(requests, "Session", lambda: session)
    config = {"api_key": KEY, "endpoint": jev.BASE_URL}
    value, latency = jev._call(config, "POST", jev.EVALUATE_PATH, {"state": "x"})
    assert value["model"] == jev.MODEL and latency >= 0 and session.trust_env is False
    args, kwargs = session.request.call_args
    assert args == ("POST", "https://api.typesafe.ai/v1/systemone") and kwargs["allow_redirects"] is False
    assert kwargs["headers"]["Authorization"] == "Bearer " + KEY and kwargs["timeout"] == (4, 20)
    for path in ("/v1/other", "https://api.typesafe.ai/v1/systemone"):
        with pytest.raises(HTTPException) as error:
            jev._call(config, "POST", path)
        assert error.value.status_code == 422
    with pytest.raises(HTTPException):
        jev._call({**config, "endpoint": "https://evil.example"}, "GET", jev.MODELS_PATH)
    statuses[:] = [429, 429]
    with pytest.raises(HTTPException) as error:
        jev._call(config, "GET", jev.MODELS_PATH)
    assert error.value.detail["code"] == "rate_limited" and KEY not in json.dumps(error.value.detail)
    statuses[:] = [429]
    assert jev._call(config, "GET", jev.MODELS_PATH)[0]["model"] == jev.MODEL
    for status, code in ((301, "provider_unavailable"), (401, "authentication_failed"), (422, "request_rejected"), (500, "provider_unavailable")):
        statuses[:] = [status]
        with pytest.raises(HTTPException) as error:
            jev._call(config, "GET", jev.MODELS_PATH)
        assert error.value.detail["code"] == code
    bodies["body"] = b'{"model": NaN}'
    with pytest.raises(HTTPException) as error:
        jev._call(config, "GET", jev.MODELS_PATH)
    assert error.value.detail["code"] == "invalid_response"
    bodies["body"] = b"x" * (jev.MAX_RESPONSE_BYTES + 1)
    with pytest.raises(HTTPException) as error:
        jev._call(config, "GET", jev.MODELS_PATH)
    assert error.value.detail["code"] == "response_limit"
    session.request.side_effect = requests.ConnectionError(KEY)
    with pytest.raises(HTTPException) as error:
        jev._call(config, "GET", jev.MODELS_PATH)
    assert error.value.detail["code"] == "network_unavailable" and KEY not in json.dumps(error.value.detail)


def test_idempotent_replay_and_conflict_never_repeat_the_paid_call(setup):
    connect(setup)
    first = run(setup)
    assert run(setup)["id"] == first["id"]
    conflict = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-jev-run",
                                                           "policy": {"pass_threshold": 0.8, "max_risk_probability": 0.5}})
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "idempotency_conflict"
    assert len([call for call in setup["calls"] if call[1] == jev.EVALUATE_PATH]) == 1 and counts()["jev_decision_runs"] == 1


def test_source_change_before_run_is_rejected_without_a_call(setup):
    connect(setup)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
    result = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-jev-run"})
    assert result.status_code == 409 and result.json()["detail"]["code"] == "source_stale"
    assert not any(call[1] == jev.EVALUATE_PATH for call in setup["calls"]) and counts()["jev_decision_runs"] == 0


def test_source_change_during_evaluation_is_stored_as_stale(setup):
    connect(setup)
    normal = setup["state"]["response"]

    def evaluate():
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        return normal
    setup["state"]["response"] = evaluate
    result = run(setup)
    assert result["status"] == "stale" and result["error"]["code"] == "source_changed"
    assert result["target_weights"] == [] and not result["proposal_ready"] and result["answers"]
    acct = account(setup)
    bridge = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-preview", json={"account_id": acct["id"], "expected_account_version": 1})
    assert bridge.status_code == 409


def test_targets_cannot_be_changed_under_jev_binding_and_other_sources_are_exclusive(setup):
    connect(setup)
    result = run(setup)
    acct = account(setup)
    changed = copy.deepcopy(result["target_weights"])
    changed[0]["weight_pct"] = 20
    binding = {"run_id": result["id"], "engine_version": jev.ENGINE_VERSION}
    tampered = setup["client"].post(f"/api/paper/accounts/{acct['id']}/preview", json={"expected_version": 1, "targets": changed, "jev_source": binding})
    assert tampered.status_code == 409
    mixed = setup["client"].post(f"/api/paper/accounts/{acct['id']}/preview", json={
        "expected_version": 1, "targets": result["target_weights"], "jev_source": binding,
        "local_agent_source": {"analysis_id": "x", "engine_version": "y"}})
    assert mixed.status_code == 422
    unknown = setup["client"].post(f"/api/paper/accounts/{acct['id']}/preview", json={
        "expected_version": 1, "targets": result["target_weights"], "jev_source": {"run_id": "invented", "engine_version": jev.ENGINE_VERSION}})
    assert unknown.status_code == 404
    plain = setup["client"].post(f"/api/paper/accounts/{acct['id']}/proposals", json={
        "expected_version": 1, "targets": result["target_weights"], "idempotency_key": "synthetic-plain"})
    assert plain.status_code == 200 and "jev_source" not in plain.json()
    with store.connect() as db:
        assert "jev_source" not in db.execute("SELECT preview_json FROM paper_proposals").fetchone()[0]
    assert counts()["paper_proposals"] == 1


def test_next_open_refuses_and_inbox_labels_jev_sourced_proposals(setup):
    connect(setup)
    result = run(setup)
    acct = account(setup)
    saved = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-proposal", json={
        "account_id": acct["id"], "expected_account_version": 1, "idempotency_key": "synthetic-proposal"}).json()["paper_proposal"]
    with store.connect() as db:
        with pytest.raises(HTTPException) as error:
            paper_next_open._source_authorization(db, {"jev_source": saved["jev_source"], "targets": saved["targets"]}, acct["id"])
        assert error.value.status_code == 409
        row = db.execute("SELECT * FROM paper_proposals WHERE id=?", (saved["id"],)).fetchone()
        item = portfolio_inbox._proposal_item(db, row, {acct["id"]: paper._account(db, acct["id"])}, AS_OF, store.input_revision(db))
        assert item["source"] == "jev_gate" and item["current"] and item["ready_for_review"]
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
    with store.connect() as db:
        item = portfolio_inbox._proposal_item(db, row, {acct["id"]: paper._account(db, acct["id"])}, AS_OF, store.input_revision(db))
        assert {"jev_changed", "inputs_changed"} <= {reason["code"] for reason in item["reasons"]}
        assert not item["current"] and not item["ready_for_review"]


def test_outcomes_measure_forward_adjusted_close_only_when_later_bars_exist(setup, monkeypatch):
    connect(setup)
    result = run(setup)
    client = setup["client"]
    before = client.get(f"/api/jev/runs/{result['id']}/outcomes").json()
    assert all(not item["available"] and item["reason"] == "no_later_session" for item in before["items"])
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-05',101,111,91,101,110,1000)")
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    revision = store.input_revision()
    after = client.get(f"/api/jev/runs/{result['id']}/outcomes").json()
    items = {item["symbol"]: item for item in after["items"]}
    assert items["SYNTA"]["available"] and items["SYNTA"]["forward_return_pct"] == 10 and items["SYNTA"]["sessions_elapsed"] == 1
    assert items["SYNTA"]["gate_status"] == "pass" and items["SYNTA"]["latest_session"] == "2024-01-05"
    assert not items["SYNTB"]["available"] and items["SYNTB"]["reason"] == "no_later_session"
    assert store.input_revision() == revision and json.dumps(after, allow_nan=False)
    assert client.get("/api/jev/runs/unknown/outcomes").status_code == 404


def test_history_reports_usage_summary_and_currentness(setup):
    connect(setup)
    first = run(setup)
    second = run(setup, idempotency_key="synthetic-second", policy={"pass_threshold": 0.9, "max_risk_probability": 0.4})
    history = setup["client"].get("/api/jev/runs?limit=10").json()
    assert [row["id"] for row in history["runs"]] == [second["id"], first["id"]]
    assert all("state" not in row and row["current"] for row in history["runs"])
    summary = history["usage_summary"]
    assert summary["listed_runs"] == 2 and summary["evaluated_runs"] == 2 and summary["average_latency_ms"] == 231
    assert summary["average_input_tokens"] == 658 and summary["total_estimated_cost_usd"] == pytest.approx(2 * 658 * 0.042 / 1_000_000)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1")
    stale = setup["client"].get("/api/jev/runs?limit=10").json()["runs"]
    assert all(row["status"] == "stale" and not row["current"] and row["target_weights"] == [] for row in stale)
    assert "source_run_stale_or_unavailable" in stale[0]["stale_reasons"]
    assert json.dumps(history, allow_nan=False)


def test_policy_binding_is_inherited_and_other_accounts_are_refused(setup):
    connect(setup)
    owner = account(setup)
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=SYMBOLS,
                                                            account_context={"account_id": owner["id"], "expected_policy_version": 1}))
    result = run(setup)
    assert result["source"]["account_context"]["account_id"] == owner["id"]
    other = account(setup, "Synthetic other", "other-account")
    refused = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-preview", json={"account_id": other["id"], "expected_account_version": 1})
    assert refused.status_code == 409
    paper.update_controls(owner["id"], paper.ControlsInput(expected_version=1, symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))
    assert not setup["client"].get(f"/api/jev/runs/{result['id']}").json()["current"]


def test_unbound_run_cannot_bypass_current_symbol_policy(setup):
    connect(setup)
    owner = account(setup)
    result = run(setup)
    owner = paper.update_controls(owner["id"], paper.ControlsInput(expected_version=1, symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))["account"]
    preview = setup["client"].post(f"/api/jev/runs/{result['id']}/paper-preview", json={"account_id": owner["id"], "expected_account_version": owner["version"]})
    assert preview.status_code == 200 and not preview.json()["paper_preview"]["executable"]
    assert {row["symbol"] for row in preview.json()["paper_preview"]["violations"] if row["code"] == "symbol_not_allowed"} == {"SYNTB"}


def test_oversized_sources_and_symbol_key_conflicts_are_rejected_before_any_call(setup):
    connect(setup)
    with store.connect() as db:
        db.execute("INSERT INTO market_universe VALUES ('SYN.T','Synthetic','synthetic','now',1000000000)")
        db.execute("INSERT INTO market_universe VALUES ('SYN-T','Synthetic','synthetic','now',1000000000)")
        for symbol in ("SYN.T", "SYN-T"):
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
        universe = [*SYMBOLS, "SYN.T", "SYN-T"]
        db.execute("UPDATE scans SET result=?,universe=?,input_revision=?",
                   (json.dumps([scan_row(symbol) for symbol in universe]), json.dumps(universe), scan_provenance.current_token(db)))
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=["SYN.T", "SYN-T"]))
    result = setup["client"].post("/api/jev/runs", json={"source_run_id": setup["source"]["id"], "idempotency_key": "synthetic-conflict"})
    assert result.status_code == 422 and result.json()["detail"]["code"] == "symbol_key_conflict"
    assert not any(call[1] == jev.EVALUATE_PATH for call in setup["calls"]) and counts()["jev_decision_runs"] == 0
