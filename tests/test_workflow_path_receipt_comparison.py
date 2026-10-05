"""Compare server-generated synthetic receipts without touching any real account or provider."""
import copy
import json
import sqlite3

import pytest

from alphaview.panel import paper_portfolio as paper, store
from alphaview.panel import workflow_path_costs as costs, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path, workflow_path_receipt_comparison as comparison
from tests.test_workflow_path_validation import saved, workspace  # noqa: F401
from tests.test_workflow_path_receipts import setup, prepare, protected_state, rows, url  # noqa: F401


@pytest.fixture
def pair(setup):
    client, days, account, run = setup
    client.app.include_router(comparison.router)
    result = []
    for current in (run, saved(client, days, constraints={"max_positions": 2, "max_position_weight_pct": 40, "cash_buffer_pct": 20})):
        case = (client, days, account, current)
        request, _ = prepare(case)
        response = client.post(url(case), json=request)
        assert response.status_code == 201, response.text
        result.append(response.json())
    return setup, result


def endpoint(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/workflow-path-receipts"


def request(items):
    return {"baseline_receipt_id": items[0]["id"], "selected_receipt_id": items[1]["id"],
            "expected_baseline_fingerprint": items[0]["content_fingerprint"],
            "expected_selected_fingerprint": items[1]["content_fingerprint"]}


def rewrite(item, change):
    """Deliberately synthesize internally consistent changed historical evidence in tmp_path only."""
    with store.connect() as db:
        row = db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (item["id"],)).fetchone()
        payload, original_request = json.loads(row["payload_json"]), json.loads(row["request_json"])
        change(payload)
        evidence = payload["evidence"]
        baseline = evidence if payload["kind"] == "path_validation" else evidence["baseline"]
        baseline["evidence_fingerprint"] = receipts._hash({key: value for key, value in baseline.items() if key != "evidence_fingerprint"})
        if payload["kind"] == "path_costs":
            evidence.update(baseline_evidence_fingerprint=baseline["evidence_fingerprint"],
                history_fingerprint=baseline["history_fingerprint"], path_engine_version=baseline["engine_version"],
                decision_fingerprint=receipts._hash(baseline["decisions"]))
            evidence["evidence_fingerprint"] = receipts._hash({key: value for key, value in evidence.items() if key != "evidence_fingerprint"})
        original_request["save_request"].update(expected_evidence_engine_version=evidence["engine_version"],
                                                expected_evidence_fingerprint=evidence["evidence_fingerprint"])
        payload["source_context"] = receipts._source(payload["kind"], payload["saved_workflow"], evidence)
        identifier = receipts._hash(original_request)
        payload["receipt_id"] = identifier
        encoded, fingerprint = receipts._json(payload), receipts._hash(payload)
        db.execute("UPDATE workflow_path_receipts SET id=?,request_json=?,payload_json=?,content_fingerprint=?,engine_version=? WHERE id=?",
            (identifier, receipts._json(original_request), encoded, fingerprint, payload["engine_version"], item["id"]))
        updated = db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (identifier,)).fetchone()
        assert receipts._decode(updated)[0] == payload
        return receipts._view(db, updated)


def test_different_saved_settings_compare_originals_and_export_without_recompute(pair, monkeypatch):
    setup, items = pair
    client = setup[0]
    before, protected, revision = rows(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Never rebuild immutable evidence"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("Never rebuild immutable costs"))
    original_view = receipts._view
    def readonly(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM workflow_path_receipts")
        return original_view(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", readonly)
    index = client.get(endpoint(setup)).json()
    assert index["pagination"] == {"limit": 20, "offset": 0, "total": 2, "returned": 2}
    assert {row["run_id"] for row in index["items"]} == {row["run_id"] for row in items}
    response = client.post(endpoint(setup) + "/compare", json=request(items))
    assert response.status_code == 200, response.text
    value = response.json()
    assert response.headers["cache-control"] == "no-store"
    assert value["comparison"]["historically_comparable"] and value["comparison"]["reasons"] == []
    assert any(row["field"] == "workflow.constraints.max_positions" for row in value["comparison"]["settings_differences"])
    assert value["baseline"]["original_receipt"] == items[0]["receipt"]
    assert value["selected"]["original_receipt"] == items[1]["receipt"]
    assert response.content == receipts._json(value).encode()
    expected = items[1]["receipt"]["evidence"]["metrics"]["final_value"] - items[0]["receipt"]["evidence"]["metrics"]["final_value"]
    assert value["comparison"]["baseline_metric_deltas"]["final_value"] == expected
    assert value["comparison"]["causal_attribution"] is value["comparison"]["eligibility_authority"] is False
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("field,change,reason", [
    ("history_fingerprint", "f" * 64, "raw_history"),
    ("rps_universe", ["SYNTA", "SYNTB"], "rps_universe"),
    ("method", "Synthetic changed pricing convention", "pricing_method"),
    ("scan_engine_version", "synthetic-new-scan", "method_versions"),
])
def test_basis_mismatch_has_metadata_but_no_quantitative_delta(pair, field, change, reason):
    setup, items = pair
    items[1] = rewrite(items[1], lambda payload: payload["evidence"].update({field: change}))
    value = setup[0].post(endpoint(setup) + "/compare", json=request(items)).json()
    assert not value["comparison"]["historically_comparable"]
    assert reason in value["comparison"]["reasons"]
    assert value["comparison"]["baseline_metric_deltas"] is None
    assert value["selected"]["original_receipt"] == items[1]["receipt"]


@pytest.mark.parametrize("case", ["missing_date", "duplicate_date", "missing_metric", "cash_basis", "unavailable"])
def test_incomplete_dates_and_metrics_are_never_aligned_filled_or_rebased(pair, case):
    setup, items = pair
    def change(payload):
        value = payload["evidence"]
        if case == "missing_date": value["curve"].pop(5)
        if case == "duplicate_date": value["curve"][5]["date"] = value["curve"][4]["date"]
        if case == "missing_metric": value["metrics"]["return_pct"] = None
        if case == "cash_basis": value["settings"]["initial_cash"] *= 2
        if case == "unavailable": value.update(status="unavailable", metrics=None)
    items[1] = rewrite(items[1], change)
    response = setup[0].post(endpoint(setup) + "/compare", json=request(items))
    assert response.status_code == 200, response.text
    assert response.json()["comparison"]["baseline_metric_deltas"] is None
    assert response.json()["comparison"]["reasons"]


def test_stale_source_observation_does_not_erase_historical_comparability(pair):
    setup, items = pair
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    value = setup[0].post(endpoint(setup) + "/compare", json=request(items)).json()
    assert value["comparison"]["historically_comparable"]
    assert value["baseline"]["summary"]["currentness"]["current"] is False
    assert value["baseline"]["original_receipt"] == items[0]["receipt"]


def test_scope_fingerprints_corruption_kind_and_request_bounds(pair):
    setup, items = pair
    client = setup[0]
    body = request(items)
    assert client.post(endpoint(setup) + "/compare", json={**body, "expected_selected_fingerprint": "0" * 64}).status_code == 409
    assert client.post(endpoint(setup) + "/compare", json={**body, "selected_receipt_id": items[0]["id"]}).status_code == 422
    assert client.post(endpoint(setup) + "/compare", json={**body, "evidence": {}}).status_code == 422
    other = paper.create_account(paper.AccountInput(name="Synthetic other scope", initial_cash=100, idempotency_key="synthetic-other-comparison"))["account"]
    assert client.post(endpoint(setup).replace(setup[2]["id"], other["id"]) + "/compare", json=body).status_code == 404
    for query in ("limit=51", "offset=251", "limit=0", "limit=true", "offset=-1"):
        assert client.get(endpoint(setup) + "?" + query).status_code == 422
    with store.connect() as db:
        db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (items[1]["id"],))
    assert client.post(endpoint(setup) + "/compare", json=body).status_code == 409
    index = client.get(endpoint(setup)).json()
    assert sum(row["integrity"]["available"] for row in index["items"]) == 1


def test_export_size_rejects_without_truncation_or_writes(pair, monkeypatch):
    setup, items = pair
    before = rows()
    monkeypatch.setattr(comparison, "MAX_BYTES", 100)
    response = setup[0].post(endpoint(setup) + "/compare", json=request(items))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "comparison_export_size_limit"
    assert rows() == before


def test_different_saved_input_revisions_are_visible_but_not_a_data_mismatch(pair):
    setup, items = pair
    # This is a pure comparison-contract check on two already verified originals:
    # revisions label source observations; the raw history hash defines data identity.
    selected = copy.deepcopy(items[1]["receipt"])
    selected["source_context"]["input_revision"] = "synthetic-other-observation:99"
    checks = comparison._basis(items[0]["receipt"], selected)
    assert all(item["matches"] for item in checks)
    differences = comparison._differences(items[0]["receipt"]["source_context"], selected["source_context"])
    assert any(row["field"] == "input_revision" for row in differences)


def test_cost_pairs_require_exact_assumptions_and_duplicate_pairs_disable_math(setup, monkeypatch):
    client = setup[0]
    client.app.include_router(comparison.router)
    items = []
    for grid in (([0, 10], [0, 5]), ([0, 20], [0, 5])):
        run = setup[3]
        request_body = {"expected_proposal_fingerprint": run["proposal_fingerprint"], "expected_input_revision": run["input_revision"],
            "expected_as_of": run["as_of"], "fee_bps": grid[0], "slippage_bps": grid[1]}
        evidence = client.post(f"/api/portfolio-agent/runs/{run['id']}/path-costs", json=request_body).json()
        saved_response = client.post(url(setup), json={"kind": "path_costs", "request": request_body,
            "expected_account_version": setup[2]["version"], "expected_evidence_engine_version": evidence["engine_version"],
            "expected_evidence_fingerprint": evidence["evidence_fingerprint"]})
        assert saved_response.status_code == 201, saved_response.text
        items.append(saved_response.json())
    baseline_request, _ = prepare(setup)
    baseline = client.post(url(setup), json=baseline_request).json()
    mixed = client.post(endpoint(setup) + "/compare", json=request([baseline, items[0]]))
    assert mixed.status_code == 422 and mixed.json()["detail"]["code"] == "comparison_kind_mismatch"
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("No path rebuilding"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("No cost rebuilding"))
    value = client.post(endpoint(setup) + "/compare", json=request(items)).json()
    pairs = value["comparison"]["scenario_pairs"]
    assert len(pairs) == 6 and sum(row["paired"] for row in pairs) == 2
    assert all(row["metric_deltas"]["final_value"] == 0 for row in pairs if row["paired"])
    assert all(row["metric_deltas"] is None and "unpaired_cost_assumption" in row["reasons"] for row in pairs if not row["paired"])
    def unavailable(payload):
        payload["evidence"]["scenarios"][0].update(status="unavailable", metrics=None, costs=None, reasons=[{"code": "synthetic_gap"}])
    items[1] = rewrite(items[1], unavailable)
    value = client.post(endpoint(setup) + "/compare", json=request(items)).json()
    assert "scenario_unavailable" in value["comparison"]["scenario_pairs"][0]["reasons"]
    assert value["comparison"]["scenario_pairs"][0]["metric_deltas"] is None
    def duplicate(payload):
        payload["evidence"]["scenarios"][1] = copy.deepcopy(payload["evidence"]["scenarios"][0])
    items[1] = rewrite(items[1], duplicate)
    value = client.post(endpoint(setup) + "/compare", json=request(items)).json()
    assert not value["comparison"]["historically_comparable"]
    assert value["comparison"]["baseline_metric_deltas"] is None
    assert value["comparison"]["scenario_pairs"] == []
    assert "duplicate_or_invalid_cost_pair" in value["comparison"]["reasons"]
