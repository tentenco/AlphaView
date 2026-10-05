"""Immutable path receipts use synthetic accounts/history and never call external services."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import copy
import json
import sqlite3

import pytest

from alphaview.panel import allocator, paper_portfolio as paper, sessions, store
from alphaview.panel import workflow_path_costs as costs, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path
from tests.test_workflow_path_validation import body, saved, workspace  # noqa: F401


@pytest.fixture
def setup(workspace):
    client, days, monkeypatch = workspace
    client.app.include_router(costs.router)
    client.app.include_router(receipts.router)
    with store.connect() as db:
        receipts.init_schema(db)
    account = paper.create_account(paper.AccountInput(name="Synthetic path receipt", initial_cash=10000,
        idempotency_key="synthetic-path-receipt-account"))["account"]
    run = saved(client, days)
    return client, days, account, run


def url(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/runs/{setup[3]['id']}/path-receipts"


def prepare(setup, kind="path_validation", **request_changes):
    client, _, account, run = setup
    request = body(run, **({"fee_bps": [0, 10], "slippage_bps": [0, 5]} if kind == "path_costs" else {}), **request_changes)
    route = "path-validation" if kind == "path_validation" else "path-costs"
    response = client.post(f"/api/portfolio-agent/runs/{run['id']}/{route}", json=request)
    assert response.status_code == 200, response.text
    evidence = response.json()
    return {"kind": kind, "request": request, "expected_account_version": account["version"],
            "expected_evidence_engine_version": evidence["engine_version"],
            "expected_evidence_fingerprint": evidence["evidence_fingerprint"]}, evidence


def rows():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT * FROM workflow_path_receipts ORDER BY id")]


def protected_state():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")] for table in
                ("portfolio_agent_runs", "paper_accounts", "paper_holdings", "paper_proposals", "paper_ledger",
                 "paper_idempotency", "research_desk_runs")}


@pytest.mark.parametrize("kind", ["path_validation", "path_costs"])
def test_save_server_rebuilds_exact_evidence_and_downloads_original_canonical_bytes(setup, monkeypatch, kind):
    request, evidence = prepare(setup, kind)
    revision, state = store.input_revision(), protected_state()
    response = setup[0].post(url(setup), json=request)
    assert response.status_code == 201, response.text
    value = response.json()
    assert value["replayed"] is False and value["currentness"] == {"current": True, "reasons": []}
    assert value["integrity"] == {"available": True, "reason": None}
    assert value["receipt"]["evidence"] == evidence
    assert value["receipt"]["request"] == request["request"]
    assert value["receipt"]["account_context"]["version"] == setup[2]["version"]
    assert value["receipt"]["source_context"]["account_binding"] == "review_association_only"
    assert value["receipt"]["policy"] == {"advisory_only": True, "execution_source": False, "gating_authority": False}
    assert value["receipt"]["saved_workflow"]["id"] == setup[3]["id"]
    assert protected_state() == state and store.input_revision() == revision
    before = rows()
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Historical reads must not rebuild"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("Historical reads must not rebuild"))
    real = receipts._view
    def read_view(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM workflow_path_receipts")
        return real(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", read_view)
    history = setup[0].get(url(setup), params={"kind": kind}).json()
    assert history["pagination"] == {"limit": 20, "offset": 0, "total": 1, "returned": 1}
    assert "receipt" not in history["items"][0]
    detail = setup[0].get(f"{url(setup)}/{value['id']}")
    assert detail.headers["cache-control"] == "no-store" and detail.json()["receipt"] == value["receipt"]
    download = setup[0].get(f"{url(setup)}/{value['id']}/evidence.json", params={"expected_content_fingerprint": value["content_fingerprint"]})
    assert download.status_code == 200 and download.text == before[0][-1]
    assert download.content == receipts._json(value["receipt"]).encode()
    assert download.headers["etag"] == f'"{value["content_fingerprint"]}"'
    assert rows() == before and protected_state() == state


@pytest.mark.parametrize("kind", ["path_validation", "path_costs"])
def test_historical_retry_returns_original_payload_after_methods_sources_and_account_change(setup, monkeypatch, kind):
    request, _ = prepare(setup, kind)
    original = setup[0].post(url(setup), json=request).json()
    before = rows()
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-new-path")
    monkeypatch.setattr(costs, "ENGINE_VERSION", "synthetic-new-costs")
    monkeypatch.setattr(receipts, "ENGINE_VERSION", "synthetic-new-receipt")
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Exact retry must not rebuild"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("Exact retry must not rebuild"))
    response = setup[0].post(url(setup), json=request)
    assert response.status_code == 200, response.text
    replay = response.json()
    assert replay["replayed"] is True and replay["receipt"] == original["receipt"]
    assert replay["content_fingerprint"] == original["content_fingerprint"]
    assert replay["currentness"]["current"] is False
    assert set(replay["currentness"]["reasons"]) == {"receipt_method_changed", "evidence_method_changed", "path_method_changed", "inputs_changed", "account_context_changed"}
    assert rows() == before


@pytest.mark.parametrize("change", ["account", "evidence", "method", "proposal", "revision", "session"])
def test_wrong_expectation_cannot_publish(setup, change):
    request, _ = prepare(setup)
    if change == "account": request["expected_account_version"] += 1
    if change == "evidence": request["expected_evidence_fingerprint"] = "0" * 64
    if change == "method": request["expected_evidence_engine_version"] = "synthetic-other"
    if change == "proposal": request["request"]["expected_proposal_fingerprint"] = "0" * 64
    if change == "revision": request["request"]["expected_input_revision"] = "synthetic-other"
    if change == "session": request["request"]["expected_as_of"] = "2020-01-01"
    assert setup[0].post(url(setup), json=request).status_code == 409
    assert rows() == []


@pytest.mark.parametrize("change", [{"evidence": {}}, {"kind": "execution"}, {"expected_account_version": True},
    {"expected_account_version": float("nan")}, {"expected_evidence_fingerprint": "bad"}])
def test_strict_kind_requests_never_accept_client_evidence_or_nonfinite_input(setup, monkeypatch, change):
    request, _ = prepare(setup)
    request.update(change)
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Bad input must not rebuild"))
    response = setup[0].post(url(setup), content=json.dumps(request), headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and rows() == []
    json.dumps(response.json(), allow_nan=False)
    assert all("input" not in item for item in response.json()["detail"])


def test_path_kind_rejects_cost_fields_and_cost_kind_normalizes_default_grid(setup):
    request, _ = prepare(setup)
    request["request"]["fee_bps"] = [0]
    assert setup[0].post(url(setup), json=request).status_code == 422
    run = setup[3]
    evidence = setup[0].post(f"/api/portfolio-agent/runs/{run['id']}/path-costs", json=body(run)).json()
    request = {"kind": "path_costs", "request": body(run), "expected_account_version": setup[2]["version"],
               "expected_evidence_engine_version": costs.ENGINE_VERSION, "expected_evidence_fingerprint": evidence["evidence_fingerprint"]}
    response = setup[0].post(url(setup), json=request)
    assert response.status_code == 201, response.text
    request["request"].update(fee_bps=[0, 10, 25], slippage_bps=[0, 5, 10])
    replay = setup[0].post(url(setup), json=request)
    assert replay.status_code == 200 and replay.json()["id"] == response.json()["id"]


@pytest.mark.parametrize("change", ["account", "policy", "limits", "workflow", "bars", "session", "path_method", "allocator_method"])
def test_publication_rechecks_context_after_snapshot_under_immediate_transaction(setup, monkeypatch, change):
    request, _ = prepare(setup)
    original = store.read_snapshot
    depth, fired = 0, False
    @contextmanager
    def changed_after_snapshot():
        nonlocal depth, fired
        depth += 1
        try:
            with original():
                yield
        finally:
            depth -= 1
        if depth == 0 and not fired:
            fired = True
            with store.connect() as db:
                if change == "account": db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
                if change == "policy":
                    policy = json.loads(db.execute("SELECT symbol_policy_json FROM paper_accounts WHERE id=?", (setup[2]["id"],)).fetchone()[0])
                    policy["version"] += 1
                    db.execute("UPDATE paper_accounts SET symbol_policy_json=? WHERE id=?", (json.dumps(policy), setup[2]["id"]))
                if change == "limits": db.execute("UPDATE paper_accounts SET limits_json='{}' WHERE id=?", (setup[2]["id"],))
                if change == "workflow":
                    run = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (setup[3]["id"],)).fetchone()[0])
                    run["method"] = "Synthetic changed record"
                    db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (json.dumps(run), setup[3]["id"]))
                if change == "bars": db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
            if change == "session": monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2099-01-01")
            if change == "path_method": monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-new")
            if change == "allocator_method": monkeypatch.setattr(allocator, "ENGINE_VERSION", "synthetic-new")
    monkeypatch.setattr(store, "read_snapshot", changed_after_snapshot)
    response = setup[0].post(url(setup), json=request)
    assert fired and response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "receipt_context_changed" and rows() == []


def test_concurrent_writer_during_rebuild_cannot_publish_mixed_evidence(setup, monkeypatch):
    request, _ = prepare(setup, "path_costs")
    original = path.evaluate
    def evaluate(*args):
        result = original(*args)
        def write():
            with store.connect() as db:
                db.execute("UPDATE bars SET open=open*1.001,high=high*1.001 WHERE symbol='SYNTA'")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(write).result(timeout=5)
        return result
    monkeypatch.setattr(path, "evaluate", evaluate)
    response = setup[0].post(url(setup), json=request)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_context_changed"
    assert rows() == []


def test_scope_is_account_plus_run_and_policy_bound_workflows_cannot_move_accounts(setup):
    request, _ = prepare(setup)
    value = setup[0].post(url(setup), json=request).json()
    other = paper.create_account(paper.AccountInput(name="Synthetic second account", initial_cash=10000,
        idempotency_key="synthetic-second-path-account"))["account"]
    for base in (url(setup).replace(setup[2]["id"], other["id"]), url(setup).replace(setup[3]["id"], "other-run")):
        assert setup[0].get(base).json()["pagination"]["total"] == 0
        assert setup[0].get(f"{base}/{value['id']}").status_code == 404
        assert setup[0].get(f"{base}/{value['id']}/evidence.json", params={"expected_content_fingerprint": value["content_fingerprint"]}).status_code == 404
    bound = saved(setup[0], setup[1], account_context={"account_id": setup[2]["id"], "expected_policy_version": 1})
    bound_setup = (*setup[:3], bound)
    bound_request, _ = prepare(bound_setup)
    valid = setup[0].post(url(bound_setup), json=bound_request)
    assert valid.status_code == 201 and valid.json()["receipt"]["source_context"]["account_binding"] == "workflow_bound"
    assert setup[0].post(url(bound_setup).replace(setup[2]["id"], other["id"]), json=bound_request).status_code == 409


@pytest.mark.parametrize("kind", ["path_validation", "path_costs"])
def test_unavailable_evidence_is_preserved_without_fabricated_metrics(setup, kind):
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (setup[1][-300],))
    fresh = (*setup[:3], saved(setup[0], setup[1]))
    request, evidence = prepare(fresh, kind)
    assert evidence["status"] == "unavailable"
    response = setup[0].post(url(fresh), json=request)
    assert response.status_code == 201, response.text
    value = response.json()
    assert value["status"] == "unavailable" and value["baseline_metrics"] is None
    assert value["receipt"]["evidence"] == evidence and value["currentness"]["current"] is True


@pytest.mark.parametrize("tamper", ["payload", "fingerprint", "fingerprint_blob", "request", "source", "kind", "blob", "timestamp"])
def test_invalid_stored_receipt_withholds_evidence_download_and_retry_without_overwriting(setup, tamper):
    request, _ = prepare(setup)
    value = setup[0].post(url(setup), json=request).json()
    with store.connect() as db:
        row = db.execute("SELECT * FROM workflow_path_receipts").fetchone()
        if tamper == "fingerprint":
            db.execute("UPDATE workflow_path_receipts SET content_fingerprint=?", ("0" * 64,))
        elif tamper == "fingerprint_blob":
            db.execute("UPDATE workflow_path_receipts SET content_fingerprint=?", (b"synthetic-invalid",))
        elif tamper == "request":
            db.execute("UPDATE workflow_path_receipts SET request_json='{}'")
        elif tamper == "blob":
            db.execute("UPDATE workflow_path_receipts SET payload_json=?", (b"synthetic-invalid",))
        else:
            payload = json.loads(row["payload_json"])
            if tamper == "payload": payload["evidence"]["metrics"]["final_value"] = 0
            if tamper == "source": payload["source_context"]["record_fingerprint"] = "0" * 64
            if tamper == "kind": payload["kind"] = "path_costs"
            if tamper == "timestamp": payload["created_at"] = "synthetic-invalid"
            db.execute("UPDATE workflow_path_receipts SET payload_json=?,content_fingerprint=?",
                       (receipts._json(payload), receipts._hash(payload)))
    before = rows()
    detail = setup[0].get(f"{url(setup)}/{value['id']}")
    assert detail.status_code == 200, detail.text
    invalid = detail.json()
    assert invalid["integrity"]["available"] is False and invalid["receipt"] is None
    assert invalid["currentness"]["current"] is None and invalid["baseline_metrics"] is None
    assert setup[0].get(f"{url(setup)}/{value['id']}/evidence.json", params={"expected_content_fingerprint": value["content_fingerprint"]}).status_code == 409
    assert setup[0].post(url(setup), json=request).status_code == 409
    assert rows() == before


def test_download_requires_exact_content_expectation_and_history_is_bounded(setup):
    request, _ = prepare(setup)
    value = setup[0].post(url(setup), json=request).json()
    endpoint = f"{url(setup)}/{value['id']}/evidence.json"
    assert setup[0].get(endpoint).status_code == 422
    assert setup[0].get(endpoint, params={"expected_content_fingerprint": "0" * 64}).status_code == 409
    for query in ({"limit": 21}, {"offset": 251}, {"kind": "unknown"}):
        assert setup[0].get(url(setup), params=query).status_code == 422
    assert setup[0].get(url(setup), params={"kind": "path_costs"}).json()["pagination"]["total"] == 0


def test_capacity_and_size_reject_without_deleting_or_truncating_history(setup, monkeypatch):
    request, _ = prepare(setup)
    value = setup[0].post(url(setup), json=request).json()
    before = rows()
    cost_request, _ = prepare(setup, "path_costs")
    monkeypatch.setattr(receipts, "MAX_ACCOUNT", 1)
    response = setup[0].post(url(setup), json=cost_request)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_capacity"
    assert rows() == before
    assert setup[0].post(url(setup), json=request).json()["id"] == value["id"]
    monkeypatch.setattr(receipts, "MAX_ACCOUNT", 50)
    monkeypatch.setattr(receipts, "MAX_TOTAL", 1)
    response = setup[0].post(url(setup), json=cost_request)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_capacity"
    assert rows() == before
    monkeypatch.setattr(receipts, "MAX_TOTAL", 250)
    monkeypatch.setattr(receipts, "MAX_BYTES", 100)
    response = setup[0].post(url(setup), json=cost_request)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "receipt_size_limit"
    assert rows() == before


def test_unverifiable_current_context_is_unknown_while_valid_historical_payload_survives(setup, monkeypatch):
    request, _ = prepare(setup)
    value = setup[0].post(url(setup), json=request).json()
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET symbol_policy_json='invalid-json' WHERE id=?", (setup[2]["id"],))
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Currentness must not recalculate"))
    response = setup[0].get(f"{url(setup)}/{value['id']}")
    assert response.status_code == 200, response.text
    assert response.json()["integrity"]["available"] is True
    assert response.json()["currentness"] == {"current": None, "reasons": ["context_unverifiable"]}
    assert response.json()["receipt"] == value["receipt"]


def test_concurrent_identical_saves_publish_one_immutable_row(setup):
    request, _ = prepare(setup)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: setup[0].post(url(setup), json=copy.deepcopy(request)), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert responses[0].json()["receipt"] == responses[1].json()["receipt"]
    assert len(rows()) == 1
