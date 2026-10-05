"""Fixed-window hand oracles and temporary synthetic receipts; never external calls."""
import copy
import sqlite3

import pytest

from alphaview.panel import paper_portfolio as paper, sessions, store
from alphaview.panel import workflow_path_rolling as rolling, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path, workflow_path_costs as costs
from tests.test_workflow_path_validation import workspace  # noqa: F401
from tests.test_workflow_path_receipts import setup, prepare, protected_state, rows, url  # noqa: F401
from tests.test_workflow_path_receipt_comparison import rewrite


def points(nav=lambda index: 100):
    days = sessions.expected_sessions("2025-01-02", "2026-06-30")[:253]
    assert len(days) == 253
    return [{"date": day, "nav": nav(index)} for index, day in enumerate(days)]


def test_all_three_fixed_horizons_use_preceding_boundary_not_first_observation_and_include_final_window():
    curve = points(lambda index: 100 + index)
    result = rolling.rolling(curve)
    assert [row["window_count"] for row in result["horizons"]] == [232, 190, 127]
    assert result["summary"]["total_window_count"] == 549
    assert result["summary"]["overlapping_windows"] is True
    assert result["summary"]["independent_samples"] is False
    for horizon in result["horizons"]:
        length = horizon["horizon_sessions"]
        first, second, final = horizon["windows"][0], horizon["windows"][1], horizon["windows"][-1]
        assert first["boundary_nav"] == 100 and first["start_nav"] == 101
        assert first["boundary_index"] == 0 and first["start_index"] == 1 and first["end_index"] == length
        assert first["boundary_date"] == curve[0]["date"] and first["boundary_kind"] == "initial_cash"
        assert first["return_pct"] == pytest.approx(length)
        assert second["boundary_nav"] == 101 and second["start_nav"] == 102
        assert second["boundary_kind"] == "preceding_saved_nav"
        assert second["return_pct"] == pytest.approx(length / 101 * 100)
        assert final["observed_end"] == curve[-1]["date"] and final["end_index"] == 252
        assert final["boundary_index"] == 252 - length and final["start_index"] == 253 - length
        assert final["nav_change"] == length
        assert horizon["highest"]["window_numbers"] == [1]
        assert horizon["lowest"]["window_numbers"] == [253 - length]
        assert horizon["expected_window_count"] == horizon["window_count"] == len(horizon["windows"])


def test_flat_path_retains_every_lowest_and_highest_tie_chronologically_without_selected_winner():
    result = rolling.rolling(points())
    for horizon in result["horizons"]:
        expected = {"return_pct": 0, "window_numbers": list(range(1, horizon["window_count"] + 1))}
        assert horizon["lowest"] == horizon["highest"] == expected
        assert all(row["gross_return"] == 1 and row["nav_change"] == 0 for row in horizon["windows"])


def test_one_low_preceding_nav_and_terminal_drop_produce_hand_computed_extrema_without_intrawindow_path_inference():
    result = rolling.rolling(points(lambda index: 50 if index in (1, 252) else 100))
    for horizon in result["horizons"]:
        assert horizon["windows"][0]["return_pct"] == 0  # The first observed 50 is not the denominator.
        assert horizon["highest"] == {"return_pct": 100, "window_numbers": [2]}
        assert horizon["lowest"] == {"return_pct": -50, "window_numbers": [horizon["window_count"]]}


@pytest.mark.parametrize("value", [None, True, 0, -1, float("nan"), float("inf"), 10 ** 400])
def test_invalid_nav_makes_every_horizon_unavailable_without_skipped_windows(value):
    curve = points()
    curve[126]["nav"] = value
    with pytest.raises(ValueError, match="rolling_curve_values_unavailable"):
        rolling.rolling(curve)


@pytest.mark.parametrize("mode", ["missing", "extra", "duplicate", "unsorted", "calendar_gap", "bad_anchor"])
def test_exact_252_historical_sessions_and_preceding_signal_anchor_are_mandatory(mode):
    curve = points()
    if mode == "missing": curve.pop(3)
    if mode == "extra": curve.append(dict(curve[-1]))
    if mode == "duplicate": curve[5]["date"] = curve[4]["date"]
    if mode == "unsorted": curve[4:6] = curve[4:6][::-1]
    if mode == "calendar_gap": curve[2]["date"] = "2025-01-04"  # Saturday between Friday and Monday.
    if mode == "bad_anchor": curve[0]["date"] = "2024-12-30"
    with pytest.raises(ValueError):
        rolling.rolling(curve)


@pytest.mark.parametrize("initial,other", [(1e-300, 1e300), (1e300, 1e-300), (1, 1e307)])
def test_overflow_or_underflow_in_any_window_rejects_the_entire_analysis(initial, other):
    with pytest.raises(ValueError, match="rolling_arithmetic_unavailable"):
        rolling.rolling(points(lambda index: initial if index == 0 else other))


@pytest.fixture
def item(setup):
    setup[0].app.include_router(rolling.router)
    response = setup[0].post(url(setup), json=prepare(setup)[0])
    assert response.status_code == 201, response.text
    return setup, response.json()


def endpoint(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/workflow-path-receipts/rolling"


def request(setup, item):
    return {"receipt_id": item["id"], "expected_fingerprint": item["content_fingerprint"],
        "expected_account_version": setup[2]["version"]}


def test_verified_original_exact_counts_snapshot_no_recompute_or_mutation_and_complete_canonical_download(item, monkeypatch):
    setup, original = item
    before, protected, revision = rows(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Never rebuild saved path"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("Never rebuild costs"))
    actual = receipts._view
    def readonly(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM workflow_path_receipts")
        return actual(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", readonly)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 200, response.text
    value, evidence = response.json(), original["receipt"]["evidence"]
    analysis = value["analysis"]
    assert analysis["status"] == "evaluated" and analysis["reasons"] == []
    assert [row["window_count"] for row in analysis["horizons"]] == [232, 190, 127]
    assert analysis["summary"]["valued_sessions"] == 252
    assert all(check["within_tolerance"] for check in analysis["reconciliation"])
    for horizon in analysis["horizons"]:
        assert horizon["windows"][0]["boundary_nav"] == evidence["metrics"]["initial_cash"]
        assert horizon["windows"][0]["boundary_date"] == evidence["window"]["signal_start"]
        assert horizon["windows"][1]["boundary_nav"] == evidence["curve"][0]["value"]
    assert value["original_receipt"] == original["receipt"]
    assert receipts._json(original["receipt"]) in response.text  # Complete literal canonical original, not a summary.
    assert response.content == receipts._json(value).encode() and len(response.content) <= rolling.MAX_BYTES
    assert value["execution_authority"] is False and response.headers["cache-control"] == "no-store"
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("mode", ["missing", "duplicate", "unsorted", "zero", "final_metric", "return_metric", "cash_basis", "incomplete", "short_window"])
def test_verified_but_invalid_evidence_retains_original_and_disables_all_derived_windows(item, mode):
    setup, original = item
    def change(payload):
        value = payload["evidence"]
        if mode == "missing": value["curve"].pop(5)
        if mode == "duplicate": value["curve"][5]["date"] = value["curve"][4]["date"]
        if mode == "unsorted": value["curve"][4:6] = value["curve"][4:6][::-1]
        if mode == "zero": value["curve"][5]["value"] = 0
        if mode == "final_metric": value["metrics"]["final_value"] += 1
        if mode == "return_metric": value["metrics"]["return_pct"] += 0.01
        if mode == "cash_basis": value["metrics"]["initial_cash"] += 1
        if mode == "incomplete": value["coverage"]["available_decisions"] -= 1
        if mode == "short_window":
            value["curve"].pop(0)
            value["window"].update(start=value["curve"][0]["date"], sessions=251)
            value["coverage"].update(required_path_sessions=251, valued_path_sessions=251)
    original = rewrite(original, change)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["analysis"]["status"] == "unavailable" and value["analysis"]["reasons"]
    assert value["analysis"]["horizons"] is value["analysis"]["summary"] is None
    assert value["original_receipt"] == original["receipt"]


def test_nonfinite_basis_is_unavailable_and_saved_future_sessions_are_not_treated_as_completed(item):
    _, original = item
    payload = copy.deepcopy(original["receipt"])
    payload["evidence"]["curve"][30]["value"] = float("nan")
    assert rolling.analyze(payload)["status"] == "unavailable"
    result = rolling.analyze(original["receipt"], original["receipt"]["evidence"]["curve"][-2]["date"])
    assert result["reasons"] == ["rolling_sessions_not_completed"]
    assert result["horizons"] is result["summary"] is None


def test_nonpositive_saved_final_nav_cannot_pass_by_absolute_reconciliation_tolerance(item):
    _, original = item
    payload = copy.deepcopy(original["receipt"])
    evidence = payload["evidence"]
    evidence["settings"]["initial_cash"] = 1e-9
    evidence["metrics"].update(initial_cash=1e-9, final_value=0, return_pct=0)
    for row in evidence["curve"]:
        row["value"] = 1e-9
    result = rolling.analyze(payload)
    assert result["reasons"] == ["rolling_saved_final_nav_unavailable"]
    assert result["horizons"] is result["summary"] is None


def test_stale_verified_original_remains_inspectable_without_refresh_or_new_costs(item, monkeypatch):
    setup, original = item
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-later-rolling-path")
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("No stale path refresh"))
    body = {**request(setup, original), "expected_account_version": setup[2]["version"] + 1}
    value = setup[0].post(endpoint(setup), json=body).json()
    assert value["analysis"]["status"] == "evaluated"
    assert value["receipt_summary"]["currentness"]["current"] is False
    assert value["original_receipt"] == original["receipt"]


def test_scope_version_fingerprint_corruption_and_strict_request_fail_closed(item):
    setup, original = item
    body, client = request(setup, original), setup[0]
    assert client.post(endpoint(setup), json={**body, "expected_fingerprint": "0" * 64}).status_code == 409
    assert client.post(endpoint(setup), json={**body, "expected_account_version": body["expected_account_version"] + 1}).status_code == 409
    for change in ({"expected_account_version": True}, {"expected_account_version": 0}, {"extra": 1}, {"receipt_id": "wrong"}):
        assert client.post(endpoint(setup), json={**body, **change}).status_code == 422
    other = paper.create_account(paper.AccountInput(name="Synthetic rolling foreign", initial_cash=100,
        idempotency_key="synthetic-rolling-foreign"))["account"]
    assert client.post(endpoint(setup).replace(setup[2]["id"], other["id"]), json=body).status_code == 404
    with store.connect() as db:
        db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (original["id"],))
    assert client.post(endpoint(setup), json=body).status_code == 409


def test_cost_receipts_and_oversize_export_are_refused_without_partial_results(setup, monkeypatch):
    setup[0].app.include_router(rolling.router)
    original = setup[0].post(url(setup), json=prepare(setup, "path_costs")[0]).json()
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "rolling_path_receipt_required"
    original = setup[0].post(url(setup), json=prepare(setup)[0]).json()
    before = rows()
    monkeypatch.setattr(rolling, "MAX_BYTES", 100)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "rolling_export_size_limit"
    assert rows() == before


def test_completed_session_rollover_during_observation_rejects_mixed_context(item, monkeypatch):
    setup, original = item
    actual = receipts._view
    def rollover(db, *args, **kwargs):
        result = actual(db, *args, **kwargs)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-12-31")
        return result
    monkeypatch.setattr(receipts, "_view", rollover)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "rolling_observation_session_changed"
