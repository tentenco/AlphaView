"""Independent CSCV rank oracles and isolated immutable-receipt protocol checks."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import math
import sqlite3
import statistics

import pytest

from alphaview.panel import paper_portfolio as paper, sessions, store
from alphaview.panel import workflow_path_cscv as cscv, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path, workflow_path_receipt_comparison as comparison
from tests.test_workflow_path_validation import saved, workspace  # noqa: F401
from tests.test_workflow_path_receipts import setup, prepare, protected_state, rows, url  # noqa: F401
from tests.test_workflow_path_receipt_comparison import rewrite


def matrix(offsets):
    return [[(-.01 if day % 2 == 0 else .01) + offsets[column][day // 42]
        for column in range(len(offsets))] for day in range(252)]


def identifiers(size=3):
    return [f"{index + 1:064x}" for index in range(size)]


def test_stable_ranks_use_sample_sd_exact_252_rows_and_all_symmetric_complements():
    values = matrix([[.03] * 6, [.02] * 6, [.01] * 6])
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate["at_or_below_median"] == aggregate["strictly_below_median"] == aggregate["exactly_at_median"] == 0
    assert len(splits) == 20 and len({tuple(item["is_blocks"]) for item in splits}) == 20
    for split in splits:
        assert split["status"] == "evaluated" and split["reasons"] == []
        assert len(split["is_row_indices"]) == len(split["oos_row_indices"]) == 126
        assert set(split["is_row_indices"]).isdisjoint(split["oos_row_indices"])
        assert sorted(split["is_row_indices"] + split["oos_row_indices"]) == list(range(252))
        assert any(other["is_blocks"] == split["oos_blocks"] for other in splits)
        winner = split["is_maxima"]
        assert len(winner) == 1 and winner[0]["receipt_id"] == identifiers()[0] and winner[0]["weight"] == 1
        assert winner[0]["omega"] == .75 and winner[0]["logit"] == pytest.approx(math.log(3))
        score = split["scores"][0]["is"]
        expected = [values[index][0] for index in split["is_row_indices"]]
        assert score["mean"] == pytest.approx(sum(expected) / 126)
        assert score["sample_sd"] == pytest.approx(math.sqrt(sum((value - score["mean"]) ** 2 for value in expected) / 125))
        assert score["ratio"] == pytest.approx(score["mean"] / score["sample_sd"])


def test_exact_regime_reversal_always_puts_is_maximum_last_oos():
    values = matrix([[.03] * 3 + [-.03] * 3, [-.03] * 3 + [.03] * 3, [0] * 6])
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate["at_or_below_median"] == aggregate["strictly_below_median"] == 1
    assert aggregate["exactly_at_median"] == 0
    assert all(item["is_maxima"][0]["oos_average_rank"] == 1 for item in splits)
    assert all(item["is_maxima"][0]["logit"] == pytest.approx(-math.log(3)) for item in splits)


def test_selected_oos_median_is_separate_from_strictly_below_without_ties():
    values = matrix([[.03] * 3 + [.02] * 3, [.02] * 3 + [.03] * 3, [.01] * 6])
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate["at_or_below_median"] == aggregate["exactly_at_median"] == 1
    assert aggregate["strictly_below_median"] == 0
    assert aggregate["is_tied_splits"] == aggregate["oos_tied_splits"] == 0
    assert all(item["is_maxima"][0]["omega"] == .5 and item["is_maxima"][0]["logit"] == 0 for item in splits)


@pytest.mark.parametrize("size", [3, 4, 8])
def test_all_tied_trials_have_symmetric_weights_average_ranks_and_explicit_median_mass(size):
    values = matrix([[.02] * 6 for _ in range(size)])
    splits, aggregate = cscv.analyze(values, identifiers(size))
    assert aggregate["at_or_below_median"] == aggregate["exactly_at_median"] == 1
    assert aggregate["strictly_below_median"] == 0
    assert aggregate["is_tied_splits"] == aggregate["oos_tied_splits"] == 20
    for split in splits:
        assert len(split["is_maxima"]) == size
        assert math.fsum(item["weight"] for item in split["is_maxima"]) == 1
        assert all(item["weight"] == 1 / size and item["oos_average_rank"] == (size + 1) / 2
            and item["omega"] == .5 and item["logit"] == 0 for item in split["is_maxima"])


def test_exact_ties_are_not_epsilon_ties_and_average_ranks_handle_even_population():
    assert cscv._average_ranks([1, 2, 2, 3]) == [1, 2.5, 2.5, 4]
    assert cscv._average_ranks([1, 2, math.nextafter(2, math.inf), 3]) == [1, 2, 3, 4]
    values = matrix([[.03] * 6, [.03] * 6, [.01] * 6])
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate["at_or_below_median"] == 0
    assert all(len(split["is_maxima"]) == 2 and all(winner["weight"] == .5
        and winner["oos_average_rank"] == 2.5 for winner in split["is_maxima"]) for split in splits)


def test_column_permutation_preserves_diagnostic_and_winner_identity():
    values = matrix([[.03] * 3 + [-.03] * 3, [-.03] * 3 + [.03] * 3, [0] * 6])
    before, aggregate = cscv.analyze(values, identifiers())
    order = [2, 0, 1]
    after, permuted = cscv.analyze([[row[index] for index in order] for row in values], [identifiers()[index] for index in order])
    assert permuted == aggregate
    assert [item["is_maxima"] for item in after] == [item["is_maxima"] for item in before]


def test_zero_variance_in_two_complementary_splits_retains_all_twenty_and_no_partial_aggregate():
    values = matrix([[.03] * 6, [.02] * 6, [.01] * 6])
    for row in values[:126]: row[0] = .03
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate is None and len(splits) == 20
    assert sum(split["status"] == "evaluated" for split in splits) == 18
    failed = [split for split in splits if split["status"] == "unavailable"]
    assert all(len(split["scores"]) == 3 and split["is_maxima"] == [] and split["fractions"] is None for split in failed)
    assert failed[0]["scores"][0]["is"] is None and failed[-1]["scores"][0]["oos"] is None


@pytest.mark.parametrize("fault", ["missing_row", "missing_trial", "nan", "infinity"])
def test_incomplete_return_matrix_never_drops_fills_or_escapes_nonfinite(fault):
    values = matrix([[.03] * 6, [.02] * 6, [.01] * 6])
    if fault == "missing_row": values.pop()
    if fault == "missing_trial": values[0].pop()
    if fault == "nan": values[0][0] = float("nan")
    if fault == "infinity": values[0][0] = float("inf")
    splits, aggregate = cscv.analyze(values, identifiers())
    assert aggregate is None and len(splits) == 20
    assert all(split["status"] == "unavailable" and len(split["scores"]) == 3 for split in splits)
    json.dumps(splits, allow_nan=False)


def test_return_formula_uses_original_initial_cash_then_each_prior_close():
    evidence = {"metrics": {"initial_cash": 100}, "curve": [
        {"date": f"2024-{index // 28 + 1:02d}-{index % 28 + 1:02d}", "value": 110 if index == 0 else 99} for index in range(252)]}
    values = cscv._returns(evidence)
    assert values[:3] == pytest.approx([.1, -.1, 0])
    evidence["curve"][0]["value"] = 1e-308
    evidence["curve"][1]["value"] = 1e308
    assert cscv._returns(evidence) is None
    assert cscv._metric([0.] * 126) is None


@pytest.fixture
def trialset(setup):
    client, days, account, run = setup
    client.app.include_router(comparison.router)
    client.app.include_router(cscv.router)
    result = []
    for current in (run, *(saved(client, days, constraints={"max_positions": 1, "max_position_weight_pct": weight, "cash_buffer_pct": 20}) for weight in (20, 40))):
        case = (client, days, account, current)
        request, _ = prepare(case)
        response = client.post(url(case), json=request)
        assert response.status_code == 201, response.text
        result.append(response.json())
    return setup, result


def endpoint(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/workflow-path-receipts/cscv"


def request(setup, items):
    return {"expected_account_version": setup[2]["version"], "trials": [
        {"receipt_id": item["id"], "expected_fingerprint": item["content_fingerprint"]} for item in items]}


def test_verified_originals_same_snapshot_no_recompute_or_writes_and_complete_hashed_export(trialset, monkeypatch):
    setup, items = trialset
    before, protected, revision = rows(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Never rerun path"))
    monkeypatch.setattr(path, "_load_history", lambda *args: pytest.fail("Never read price history"))
    original = comparison._read
    def checked(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM workflow_path_receipts")
        return original(db, *args)
    monkeypatch.setattr(comparison, "_read", checked)
    response = setup[0].post(endpoint(setup), json=request(setup, items))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["status"] == "evaluated", value["reasons"]
    assert value["coverage"] == {"required_trials": 3, "verified_trials": 3, "required_sessions": 252, "available_sessions": 252, "required_splits": 20, "available_splits": 20}
    assert [item["original_receipt"] for item in value["trials"]] == [item["receipt"] for item in items]
    assert len(value["return_matrix"]["values"]) == 252 and len(value["splits"]) == 20
    assert response.content == receipts._json(value).encode() and response.headers["cache-control"] == "no-store"
    assert value["evidence_fingerprint"] == receipts._hash({key: item for key, item in value.items() if key != "evidence_fingerprint"})
    assert value["diagnostic_scope"] == "selected_saved_trials_only" and value["execution_authority"] is False
    assert value["recommended_configuration"] is None
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("field,changed,reason", [
    ("history_fingerprint", "f" * 64, "raw_history"), ("rps_universe", ["SYNTA"], "rps_universe"),
    ("method", "Synthetic alternative", "pricing_method"), ("scan_engine_version", "synthetic-v2", "method_versions"),
])
def test_strict_shared_comparison_basis_blocks_entire_selected_set(trialset, field, changed, reason):
    setup, items = trialset
    items[1] = rewrite(items[1], lambda payload: payload["evidence"].update({field: changed}))
    value = setup[0].post(endpoint(setup), json=request(setup, items)).json()
    assert value["aggregate"] is None and value["return_matrix"] is None and len(value["trials"]) == 3 and len(value["splits"]) == 20
    assert any(item["code"] == reason for item in value["reasons"])
    assert value["trials"][1]["original_receipt"] == items[1]["receipt"]


@pytest.mark.parametrize("case", ["missing_date", "duplicate_date", "cash_basis", "unavailable"])
def test_no_partial_dates_rebasing_or_unavailable_trial_removal(trialset, case):
    setup, items = trialset
    def change(payload):
        value = payload["evidence"]
        if case == "missing_date": value["curve"].pop(5)
        if case == "duplicate_date": value["curve"][5]["date"] = value["curve"][4]["date"]
        if case == "cash_basis": value["settings"]["initial_cash"] *= 2
        if case == "unavailable": value.update(status="unavailable", metrics=None)
    items[1] = rewrite(items[1], change)
    response = setup[0].post(endpoint(setup), json=request(setup, items))
    assert response.status_code == 200, response.text
    assert response.json()["aggregate"] is None and response.json()["coverage"]["available_splits"] == 0
    assert len(response.json()["trials"]) == 3 and len(response.json()["splits"]) == 20


def test_duplicate_full_settings_are_disclosed_without_collapsing_trials(trialset):
    setup, items = trialset
    original = items[0]["receipt"]
    def change(payload):
        payload["saved_workflow"]["request"] = copy.deepcopy(original["saved_workflow"]["request"])
        payload["evidence"]["settings"] = copy.deepcopy(original["evidence"]["settings"])
    items[1] = rewrite(items[1], change)
    value = setup[0].post(endpoint(setup), json=request(setup, items)).json()
    assert value["aggregate"] is None and {"code": "duplicate_trial_configuration"} in value["reasons"]
    assert value["comparability"]["duplicate_configuration_groups"][0]["receipt_ids"] == [items[0]["id"], items[1]["id"]]
    assert len(value["trials"]) == 3 and len(value["splits"]) == 20


def test_distinct_settings_with_identical_returns_are_legitimate_ties(trialset):
    setup, items = trialset
    original = items[0]["receipt"]["evidence"]
    for index in (1, 2):
        items[index] = rewrite(items[index], lambda payload: payload["evidence"].update(
            curve=copy.deepcopy(original["curve"]), metrics=copy.deepcopy(original["metrics"])))
    value = setup[0].post(endpoint(setup), json=request(setup, items)).json()
    assert value["status"] == "evaluated" and value["comparability"]["duplicate_configuration_groups"] == []
    assert value["aggregate"]["at_or_below_median"] == value["aggregate"]["exactly_at_median"] == 1
    assert value["aggregate"]["strictly_below_median"] == 0


def test_stale_history_remains_comparable_with_separate_currentness(trialset):
    setup, items = trialset
    with store.connect() as db: db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    value = setup[0].post(endpoint(setup), json=request(setup, items)).json()
    assert value["status"] == "evaluated" and all(item["summary"]["currentness"]["current"] is False for item in value["trials"])
    assert [item["original_receipt"] for item in value["trials"]] == [item["receipt"] for item in items]


def test_request_bounds_duplicates_wrong_scope_conflicts_and_corruption(trialset):
    setup, items = trialset
    client, body = setup[0], request(setup, items)
    for value in ({**body, "trials": body["trials"][:2]}, {**body, "trials": body["trials"] * 3},
        {**body, "trials": [body["trials"][0]] * 3}, {**body, "expected_account_version": True}, {**body, "blocks": 8},
        {**body, "expected_account_version": float("nan")}):
        response = client.post(endpoint(setup), content=json.dumps(value), headers={"Content-Type": "application/json"})
        assert response.status_code == 422, response.text
        json.dumps(response.json(), allow_nan=False)
    assert client.post(endpoint(setup), json={**body, "expected_account_version": body["expected_account_version"] + 1}).status_code == 409
    changed = copy.deepcopy(body); changed["trials"][1]["expected_fingerprint"] = "f" * 64
    assert client.post(endpoint(setup), json=changed).status_code == 409
    other = paper.create_account(paper.AccountInput(name="Synthetic CSCV other", initial_cash=100, idempotency_key="synthetic-cscv-other"))["account"]
    assert client.post(endpoint(setup).replace(setup[2]["id"], other["id"]), json=body).status_code == 404
    with store.connect() as db: db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (items[1]["id"],))
    assert client.post(endpoint(setup), json=body).status_code == 409


def test_export_limit_and_session_change_reject_instead_of_truncating(trialset, monkeypatch):
    setup, items = trialset
    before = rows()
    with monkeypatch.context() as scope:
        scope.setattr(cscv, "MAX_BYTES", 1)
        response = setup[0].post(endpoint(setup), json=request(setup, items))
        assert response.status_code == 422 and response.json()["detail"]["code"] == "cscv_export_size_limit"
    real = cscv.analyze
    def moved(*args):
        result = real(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2099-01-01")
        return result
    monkeypatch.setattr(cscv, "analyze", moved)
    response = setup[0].post(endpoint(setup), json=request(setup, items))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "cscv_observation_session_changed"
    assert rows() == before


def test_concurrent_writer_cannot_mix_receipt_revisions_inside_snapshot(trialset, monkeypatch):
    setup, items = trialset
    baseline = setup[0].post(endpoint(setup), json=request(setup, items)).json()
    original, count = comparison._read, []
    def interleaved(db, *args):
        count.append(True)
        if len(count) == 2:
            def write():
                with store.connect() as other:
                    other.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (items[1]["id"],))
            with ThreadPoolExecutor(max_workers=1) as pool: pool.submit(write).result(timeout=5)
        return original(db, *args)
    monkeypatch.setattr(comparison, "_read", interleaved)
    response = setup[0].post(endpoint(setup), json=request(setup, items))
    assert response.status_code == 200 and response.json() == baseline


@pytest.mark.parametrize("affected", [(1,), (0, 2)])
def test_missing_saved_configuration_rejects_entire_selection_with_ids_coverage_and_no_actions(trialset, monkeypatch, affected):
    setup, items = trialset
    for index in affected:
        items[index] = rewrite(items[index], lambda payload: payload["saved_workflow"].pop("workflow_kind"))
    before, protected, revision = rows(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("No path recompute"))
    monkeypatch.setattr(path, "_load_history", lambda *a: pytest.fail("No price reads"))
    monkeypatch.setattr(cscv, "_returns", lambda *a: pytest.fail("No partial return matrix"))
    monkeypatch.setattr(cscv, "analyze", lambda *a: pytest.fail("No partial aggregate"))
    response = setup[0].post(endpoint(setup), json=request(setup, items))
    assert response.status_code == 409, response.text
    assert response.json() == {"detail": {"code": "cscv_trial_configuration_unavailable",
        "receipt_ids": [items[index]["id"] for index in affected],
        "coverage": {"required_trials": 3, "verified_trials": 3,
            "available_configurations": 3 - len(affected), "unavailable_configurations": len(affected)}}}
    assert rows() == before and protected_state() == protected and store.input_revision() == revision
