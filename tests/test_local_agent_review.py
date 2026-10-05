"""Synthetic human annotations stay independent from saved proof and paper authority."""
import json
import sqlite3

import pytest
from fastapi import HTTPException

from alphaview.panel import local_agent as local, local_agent_review as review
from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent, sessions, store
from tests.test_local_agent import account, complete, setup  # noqa: F401


@pytest.fixture
def ready(setup, monkeypatch):
    owner = account(setup)
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=["SYNTA", "SYNTB"],
        account_context={"account_id": owner["id"], "expected_policy_version": 1}))
    run = complete(setup)
    with store.connect() as db:
        review.init_schema(db)
    setup["client"].app.include_router(review.router)
    monkeypatch.setattr(local, "_ollama", lambda *a, **k: pytest.fail("Review called a model"))
    monkeypatch.setattr(local, "_model", lambda *a, **k: pytest.fail("Review looked up a live model"))
    return setup["client"], owner, run


def url(ready):
    _, owner, run = ready
    return f"/api/paper/accounts/{owner['id']}/local-agent/{run['id']}"


def context(ready):
    value = ready[0].get(url(ready) + "/review")
    assert value.status_code == 200, value.text
    return value.json()


def body(ready, key="synthetic-review-1", **changes):
    value = context(ready)
    return {"expected_version": value["version"], "expected_account_version": value["binding"]["account_version"],
        "expected_input_revision": value["binding"]["input_revision"], "expected_as_of": value["binding"]["as_of"],
        "expected_binding_fingerprint": value["binding_fingerprint"], "state": "reviewed", "reason_codes": [],
        "idempotency_key": key, **changes}


def record(ready, payload=None):
    result = ready[0].post(url(ready) + "/review", json=payload or body(ready))
    assert result.status_code == 200, result.text
    value = result.json()
    json.dumps(value, allow_nan=False)
    return value


def protected():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
                for table in ("paper_accounts", "paper_holdings", "paper_ledger", "paper_proposals", "local_agent_runs",
                              "portfolio_agent_runs", "execution_orders", "execution_submissions", "panel_revisions")}


def test_immutable_review_reject_reopen_and_authorization_are_independent(ready):
    before = protected()
    _, _, run = ready
    source = {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION}
    with store.connect() as db:
        authorization = local.validate_historical_source(db, source)
        eligible = local.validate_source(db, source)
    initial = context(ready)
    assert initial["effective_state"] == "review_required" and initial["version"] == 0
    assert initial["program"]["verified"] and initial["program"]["proposal_eligible"]
    first = record(ready)
    first_event = first["latest"]
    assert first["effective_state"] == "reviewed" and first["version"] == 1 and first["review_current"]
    second = record(ready, body(ready, "synthetic-review-2", state="rejected", reason_codes=["allocation_concern"]))
    assert second["effective_state"] == "rejected" and second["version"] == 2
    assert second["program"]["proposal_eligible"] is True  # Annotation is not an execution control.
    third = record(ready, body(ready, "synthetic-review-3", state="review_required"))
    assert third["effective_state"] == "review_required" and third["version"] == 3
    history = ready[0].get(url(ready) + "/reviews").json()
    assert [event["receipt"]["state"] for event in history["items"]] == ["review_required", "rejected", "reviewed"]
    assert history["items"][-1] == first_event
    assert ready[0].get(url(ready) + "/reviews/" + first_event["id"]).json() == first_event
    assert "raw_content" not in json.dumps(history) and "facts_json" not in json.dumps(history)
    assert protected() == before
    with store.connect() as db:
        assert local.validate_historical_source(db, source) == authorization
        assert local.validate_source(db, source) == eligible


def test_seen_failed_evidence_stays_failed_and_cannot_authorize(ready):
    _, _, run = ready
    with store.connect() as db:
        value = json.loads(local._row(db, run["id"])["result_json"])
        value["target_weights"][0]["weight_pct"] = 99
        db.execute("UPDATE local_agent_runs SET result_json=? WHERE id=?", (json.dumps(value), run["id"]))
    request = body(ready, reason_codes=["evidence_uncertain"])
    result = record(ready, request)
    assert result["effective_state"] == "reviewed"
    assert result["program"]["evidence_status"] == "failed"
    assert result["program"]["verified"] is result["program"]["proposal_eligible"] is False
    assert "result_replay_mismatch" in result["program"]["uncertainty_codes"]
    with store.connect() as db, pytest.raises(HTTPException):
        local.validate_source(db, {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION})


@pytest.mark.parametrize("change", ["account", "policy", "revision", "session", "analysis", "rule"])
def test_changed_context_reopens_without_rewriting_history_and_rejects_stale_write(ready, monkeypatch, change):
    first = record(ready)
    pending = body(ready, "pending-before-source-change", state="rejected", reason_codes=["source_stale"])
    _, owner, run = ready
    with store.connect() as db:
        if change == "account":
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (owner["id"],))
        elif change == "policy":
            policy = json.loads(paper._account(db, owner["id"])["symbol_policy_json"])
            policy.update(mode="allowlist", symbols=["SYNTA"], version=2)
            db.execute("UPDATE paper_accounts SET symbol_policy_json=? WHERE id=?", (json.dumps(policy), owner["id"]))
        elif change == "revision":
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        elif change == "analysis":
            db.execute("UPDATE local_agent_runs SET schema_digest=? WHERE id=?", ("a" * 64, run["id"]))
        elif change == "rule":
            value = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (run["source_run_id"],)).fetchone()[0])
            value["cash_weight_pct"] = 99
            db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (json.dumps(value), run["source_run_id"]))
    if change == "session":
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    value = context(ready)
    assert value["effective_state"] == "review_required" and value["review_reason"] == "source_changed"
    assert value["latest"] == first["latest"] and value["version"] == 1
    assert ready[0].post(url(ready) + "/review", json=pending).status_code == 409
    assert ready[0].get(url(ready) + "/reviews").json()["pagination"]["total"] == 1


def test_current_idempotent_retry_different_body_and_superseded_retry(ready):
    request = body(ready)
    first = record(ready, request)
    replay = record(ready, request)
    assert replay["changed"] is False and replay["latest"] == first["latest"]
    assert ready[0].post(url(ready) + "/review", json={**request, "reason_codes": ["model_limitations"]}).status_code == 409
    record(ready, body(ready, "synthetic-next-review", state="rejected", reason_codes=["allocation_concern"]))
    response = ready[0].post(url(ready) + "/review", json=request)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "review_superseded"


@pytest.mark.parametrize("column,value", [("payload_json", "{"), ("state", "rejected"),
    ("content_fingerprint", "f" * 64), ("binding_fingerprint", "e" * 64), ("created_at", "broken")])
def test_corrupt_latest_does_not_fallback_and_cannot_be_overwritten(ready, column, value):
    record(ready)
    second = record(ready, body(ready, "synthetic-second-review"))
    with store.connect() as db:
        db.execute(f"UPDATE local_agent_review_events SET {column}=? WHERE id=?", (value, second["latest"]["id"]))
    view = context(ready)
    assert view["effective_state"] == "review_required" and view["review_reason"] == "review_history_unavailable"
    assert view["latest"]["receipt"] is None and view["version"] == 2
    assert view["program"]["verified"]  # Receipt corruption never modifies program evidence.
    assert ready[0].post(url(ready) + "/review", json=body(ready, "cannot-paper-over-corrupt-head")).status_code == 409
    events = ready[0].get(url(ready) + "/reviews").json()["items"]
    assert len(events) == 2 and events[0]["receipt"] is None and events[1]["receipt"]["state"] == "reviewed"


def test_account_bound_analysis_and_history_are_scoped(ready):
    client, _, run = ready
    first = record(ready)
    other = paper.create_account(paper.AccountInput(name="Synthetic other review", initial_cash=10000,
                                  idempotency_key="synthetic-other-review"))["account"]
    base = f"/api/paper/accounts/{other['id']}/local-agent/{run['id']}"
    assert client.get(base + "/review").status_code == 404
    assert client.post(base + "/review", json=body(ready)).status_code == 404
    assert client.get(base + "/reviews").json()["items"] == []
    assert client.get(base + "/reviews/" + first["latest"]["id"]).status_code == 404


def test_get_is_query_only_without_schema_initialization(ready, monkeypatch):
    record(ready)
    original = review._context
    def read_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM local_agent_review_events")
        return original(db, *args)
    monkeypatch.setattr(review, "_context", read_only)
    monkeypatch.setattr(review, "init_schema", lambda *a: pytest.fail("GET initialized schema"))
    before = protected()
    assert context(ready)["version"] == 1
    assert ready[0].get(url(ready) + "/reviews").status_code == 200
    assert protected() == before


def test_failure_after_insert_rolls_back_entire_review(ready, monkeypatch):
    request = body(ready)
    before = protected()
    monkeypatch.setattr(review, "_view", lambda *a: (_ for _ in ()).throw(HTTPException(409, "synthetic publish failure")))
    assert ready[0].post(url(ready) + "/review", json=request).status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM local_agent_review_events").fetchone()[0] == 0
    assert protected() == before


@pytest.mark.parametrize("changes", [{"expected_version": True}, {"expected_version": -1}, {"expected_version": 2_147_483_647},
    {"expected_account_version": "1"}, {"expected_as_of": "2024-02-30"}, {"notes": "not accepted"},
    {"state": "approved"}, {"state": "rejected", "reason_codes": []}, {"reason_codes": ["invented"]},
    {"reason_codes": ["model_limitations", "model_limitations"]}])
def test_strict_bounded_request(ready, changes):
    assert ready[0].post(url(ready) + "/review", json={**body(ready), **changes}).status_code == 422


def test_nonfinite_request_is_clean_422(ready):
    raw = json.dumps(body(ready)).replace('"expected_version": 0', '"expected_version": 1e999')
    response = ready[0].post(url(ready) + "/review", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "nonfinite_review_input"


@pytest.mark.parametrize("query", ["limit=0", "limit=51", "limit=1.0", "limit=true", "offset=-1", "offset=5001", "offset=1.0"])
def test_history_has_strict_bounds(ready, query):
    assert ready[0].get(url(ready) + "/reviews?" + query).status_code == 422


def test_active_analysis_cannot_be_reviewed(ready):
    with store.connect() as db:
        db.execute("UPDATE local_agent_runs SET status='running' WHERE id=?", (ready[2]["id"],))
    assert not context(ready)["can_review"]
    assert ready[0].post(url(ready) + "/review", json=body(ready)).status_code == 409


def test_session_rollover_aborts_without_partial_receipt(ready, monkeypatch):
    request = body(ready)
    calls = 0
    def rollover():
        nonlocal calls
        calls += 1
        return "2024-01-04" if calls == 1 else "2024-01-05"
    monkeypatch.setattr(sessions, "latest_completed_session", rollover)
    assert ready[0].post(url(ready) + "/review", json=request).status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM local_agent_review_events").fetchone()[0] == 0


def test_unbound_analysis_has_independent_account_annotations(setup, monkeypatch):
    run = complete(setup)
    first = account(setup)
    second = paper.create_account(paper.AccountInput(name="Synthetic independent review", initial_cash=10000,
        idempotency_key="synthetic-independent-review"))["account"]
    setup["client"].app.include_router(review.router)
    with store.connect() as db:
        review.init_schema(db)
    monkeypatch.setattr(local, "_ollama", lambda *a, **k: pytest.fail("Review called a model"))
    ready = setup["client"], first, run
    one = record(ready)
    other = setup["client"], second, run
    assert context(other)["version"] == 0
    two = record(other, body(other, state="rejected", reason_codes=["insufficient_information"]))
    assert one["latest"]["id"] != two["latest"]["id"]
    assert context(ready)["effective_state"] == "reviewed"
    assert context(other)["effective_state"] == "rejected"
    assert setup["client"].get(url(other) + "/reviews/" + one["latest"]["id"]).status_code == 404


def test_missing_output_can_be_seen_without_inventing_program_evidence(ready):
    with store.connect() as db:
        db.execute("UPDATE local_agent_runs SET result_json=NULL WHERE id=?", (ready[2]["id"],))
    value = record(ready, body(ready, reason_codes=["insufficient_information"]))
    assert value["effective_state"] == "reviewed"
    assert value["program"]["evidence_status"] == "unavailable"
    assert not value["program"]["proposal_eligible"]
    assert value["binding"]["authorization_fingerprint"] is None


def test_old_expected_version_rejected_even_with_fresh_context(ready):
    record(ready)
    request = body(ready, "synthetic-version-conflict", expected_version=0)
    result = ready[0].post(url(ready) + "/review", json=request)
    assert result.status_code == 409 and result.json()["detail"]["code"] == "review_version_changed"
    assert context(ready)["version"] == 1


@pytest.mark.parametrize("location", ["root", "binding", "program"])
def test_unexpected_private_payload_fields_never_escape_history_even_with_recomputed_hash(ready, location):
    value = record(ready)
    payload = value["latest"]["receipt"]
    target = payload if location == "root" else payload["binding"] if location == "binding" else payload["binding"]["program"]
    target["raw_content"] = "SYNTHETIC payload must not escape the review evidence boundary"
    new_binding_hash = paper._hash(payload["binding"])
    payload["binding_fingerprint"] = new_binding_hash
    payload["request"]["expected_binding_fingerprint"] = new_binding_hash
    with store.connect() as db:
        db.execute("""UPDATE local_agent_review_events SET payload_json=?,content_fingerprint=?,binding_fingerprint=?,
                   request_hash=? WHERE id=?""", (paper._json(payload), paper._hash(payload), new_binding_hash,
                   paper._hash(payload["request"]), value["latest"]["id"]))
    result = ready[0].get(url(ready) + "/reviews").json()
    assert result["items"][0]["receipt"] is None
    assert "SYNTHETIC payload" not in json.dumps(result)


def test_session_rollover_after_reconstruction_still_prevents_publication(ready, monkeypatch):
    request = body(ready)
    original = review._context
    def capture_then_rollover(*args):
        result = original(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
        return result
    monkeypatch.setattr(review, "_context", capture_then_rollover)
    result = ready[0].post(url(ready) + "/review", json=request)
    assert result.status_code == 409 and result.json()["detail"]["code"] == "review_session_changed"
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM local_agent_review_events").fetchone()[0] == 0
