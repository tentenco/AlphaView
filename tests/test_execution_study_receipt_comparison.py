"""Synthetic saved-only comparisons; no prices, calculations, writes or execution calls."""
import json
import sqlite3

import pytest

from alphaview.panel import execution_study_receipt_comparison as comparison
from alphaview.panel import execution_study_receipts as receipts, store
from tests.test_execution_study_receipts import setup as receipt_setup, workspace, saved, rows, url, state  # noqa: F401


@pytest.fixture
def setup(receipt_setup):
    receipt_setup[0].app.include_router(comparison.router)
    return receipt_setup


def pair(setup, kind="volume_day", first=None, second=None):
    first_body, first_raw, a = saved(setup, kind, **(first or {"participation_pct": 10}))
    second_body, second_raw, b = saved(setup, kind, **(second or {"participation_pct": 20}))
    return a, b, first_raw, second_raw


def body(setup, a, b, **changes):
    return {"baseline_receipt_id": a["id"], "selected_receipt_id": b["id"],
        "expected_baseline_fingerprint": a["content_fingerprint"], "expected_selected_fingerprint": b["content_fingerprint"],
        "expected_account_version": setup[1]["version"], **changes}


def call(setup, a, b, **changes):
    response = setup[0].post(url(setup) + "/compare", json=body(setup, a, b, **changes))
    assert response.status_code == 200, response.text
    json.dumps(response.json(), allow_nan=False)
    return response


def all_metrics(value):
    return [metric for order in value["comparison"]["orders"] for row in [order, *order["sessions"]] for metric in row["metrics"].values()]


@pytest.mark.parametrize("kind", ["volume_day", "limit_day", "open_gtd"])
def test_compare_stored_only_preserves_exact_originals_and_known_differences(setup, monkeypatch, kind):
    a, b, _, _ = pair(setup, kind)
    before, protected, revision = rows(), state(), store.input_revision()
    for module in (receipts.volume, receipts.limit, receipts.gtd):
        monkeypatch.setattr(module, "study", lambda *a, **k: pytest.fail("No study recomputation"))
    monkeypatch.setattr(receipts.volume, "_bar_evidence", lambda *a: pytest.fail("No history reads"))
    actual = comparison._read
    def query_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        def authorize(operation, first, *_rest):
            if operation == sqlite3.SQLITE_READ and first in ("bars", "datasets", "scans"):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        return actual(db, *args)
    monkeypatch.setattr(comparison, "_read", query_only)
    response = call(setup, a, b)
    value = response.json()
    assert value["comparison"]["historically_comparable"] and value["comparison"]["reasons"] == []
    assert value["comparison"]["aggregate"] is None and not value["comparison"]["execution_authority"]
    assert not value["comparison"]["causal_attribution"]
    assert value["baseline"]["original_receipt"] == a["receipt"] and value["selected"]["original_receipt"] == b["receipt"]
    for row in before: assert row[-1] in response.text
    assert response.headers["etag"] == f'"{receipts._sha(response.content)}"'
    metric = value["comparison"]["orders"][0]["metrics"]["final_scenario_shares" if kind == "open_gtd" else "scenario_shares"]
    assert metric == {"baseline": 10.0, "selected": 20.0, "delta": 10.0, "reason": None, "unit": "shares"}
    if kind == "open_gtd": assert value["comparison"]["orders"][0]["sessions"][0]["metrics"]["scenario_shares"]["delta"] == 10
    assert rows() == before and state() == protected and store.input_revision() == revision


def test_limit_change_zero_is_a_known_scenario_not_missing(setup):
    a, b, _, _ = pair(setup, "limit_day", {"limits": [{"symbol": "SYNTA", "limit_price": 100}]}, {"limits": [{"symbol": "SYNTA", "limit_price": 110}]})
    value = call(setup, a, b).json()
    row = value["comparison"]["orders"][0]
    assert value["comparison"]["historically_comparable"]
    assert row["baseline_status"] == "not_marketable_at_open_expired" and row["selected_status"] == "partial_expired"
    assert row["metrics"]["scenario_shares"]["baseline"] == 0 and row["metrics"]["scenario_shares"]["delta"] == 10
    assert value["comparison"]["assumptions"]["baseline"]["limits"] != value["comparison"]["assumptions"]["selected"]["limits"]


@pytest.mark.parametrize("kind", ["volume_day", "limit_day", "open_gtd"])
def test_same_missing_evidence_is_preserved_without_aggregate_or_zero_difference(setup, kind):
    with store.connect() as db: db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date='2024-01-08'")
    a, b, _, _ = pair(setup, kind)
    value = call(setup, a, b).json()
    assert value["comparison"]["historically_comparable"]
    missing = value["comparison"]["orders"][1]
    name = "final_scenario_shares" if kind == "open_gtd" else "scenario_shares"
    assert missing["metrics"][name] == {"baseline": None, "selected": None, "delta": None, "reason": "baseline_value_unavailable", "unit": "shares"}
    assert missing["baseline_reason"] == missing["selected_reason"] == "missing_execution_bar"
    assert value["comparison"]["aggregate"] is None
    assert any(metric["delta"] is not None for metric in all_metrics(value))


@pytest.mark.parametrize("change,reason", [("bars", "raw_bar_evidence"), ("session", "evaluation_snapshot"),
    ("account", "evaluation_snapshot"), ("proposal", "saved_proposal"), ("method", "method_versions")])
def test_changed_basis_retains_originals_but_nulls_every_delta(setup, monkeypatch, change, reason):
    _, _, a = saved(setup)
    with store.connect() as db:
        if change == "bars": db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        if change == "account": db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
        if change == "proposal": db.execute("UPDATE paper_proposals SET status='rejected' WHERE id=?", (setup[2]["id"],))
    if change == "session": setup[3]["session"] = "2024-01-09"
    if change == "method": monkeypatch.setattr(receipts.volume, "ENGINE_VERSION", "synthetic-future-study")
    _, _, b = saved(setup, participation_pct=20)
    value = call(setup, a, b, expected_account_version=2 if change == "account" else 1).json()
    assert not value["comparison"]["historically_comparable"] and reason in value["comparison"]["reasons"]
    assert all(metric["delta"] is None for metric in all_metrics(value))
    assert value["baseline"]["original_receipt"] == a["receipt"] and value["selected"]["original_receipt"] == b["receipt"]


def test_two_matching_unknown_method_versions_are_not_assumed_comparable(setup, monkeypatch):
    monkeypatch.setattr(receipts.volume, "ENGINE_VERSION", "synthetic-future-study")
    a, b, _, _ = pair(setup)
    result = call(setup, a, b).json()
    assert result["comparison"]["reasons"] == ["method_versions"]
    assert all(metric["delta"] is None for metric in all_metrics(result))


def test_gtd_different_horizon_never_aligns_overlapping_days(setup):
    a, b, _, _ = pair(setup, "open_gtd", {"gtd_date": "2024-01-08"}, {"gtd_date": "2024-01-09"})
    result = call(setup, a, b).json()
    assert "exact_session_horizon" in result["comparison"]["reasons"]
    assert "saved_coverage" in result["comparison"]["reasons"]
    assert all(metric["delta"] is None for metric in all_metrics(result))
    steps = result["comparison"]["orders"][0]["sessions"]
    assert len(steps) == 2 and steps[1]["paired"] is False
    assert steps[1]["metrics"]["scenario_shares"]["baseline"] is None


def test_gtd_early_completion_changes_observed_basis_and_is_explicitly_incomparable(setup):
    a, b, _, _ = pair(setup, "open_gtd", {"participation_pct": 10, "gtd_date": "2024-01-09"}, {"participation_pct": 100, "gtd_date": "2024-01-09"})
    result = call(setup, a, b).json()
    assert "saved_coverage" in result["comparison"]["reasons"]
    assert all(metric["delta"] is None for metric in all_metrics(result))
    assert result["selected"]["original_receipt"]["evidence"]["orders"][0]["status"] == "scenario_full"


def test_both_stale_originals_remain_comparable_and_account_cas_is_independent(setup):
    a, b, _, _ = pair(setup)
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
    assert setup[0].post(url(setup) + "/compare", json=body(setup, a, b)).status_code == 409
    result = call(setup, a, b, expected_account_version=2).json()
    assert result["comparison"]["historically_comparable"]
    assert not result["baseline"]["summary"]["currentness"]["current"]
    assert not result["selected"]["summary"]["currentness"]["current"]


def test_wrong_hash_corrupt_receipt_scope_and_cross_kind_rejected(setup):
    a, b, _, _ = pair(setup)
    endpoint = url(setup) + "/compare"
    bad = body(setup, a, b, expected_selected_fingerprint="0" * 64)
    assert setup[0].post(endpoint, json=bad).status_code == 409
    for path in (endpoint.replace(setup[1]["id"], "f" * 32), endpoint.replace(setup[2]["id"], "f" * 32)):
        assert setup[0].post(path, json=body(setup, a, b)).status_code == 404
    _, _, other = saved(setup, "limit_day")
    assert setup[0].post(endpoint, json=body(setup, a, other)).status_code == 422
    with store.connect() as db: db.execute("UPDATE execution_study_receipts SET created_at='synthetic-corrupt' WHERE id=?", (b["id"],))
    result = setup[0].post(endpoint, json=body(setup, a, b))
    assert result.status_code == 409 and result.json()["detail"]["code"] == "comparison_receipt_unverifiable"


@pytest.mark.parametrize("change", [{"expected_account_version": True}, {"expected_account_version": float("nan")},
    {"expected_account_version": 2147483648}, {"selected_receipt_id": "bad"}, {"extra": 1}, {"request": {}}])
def test_strict_finite_input_cannot_compute(setup, monkeypatch, change):
    a, b, _, _ = pair(setup)
    monkeypatch.setattr(comparison, "_read", lambda *a: pytest.fail("Invalid request must not read evidence"))
    result = setup[0].post(url(setup) + "/compare", content=json.dumps(body(setup, a, b, **change)), headers={"Content-Type": "application/json"})
    assert result.status_code == 422
    json.dumps(result.json(), allow_nan=False)


def test_same_receipt_and_oversized_export_rejected_without_writes(setup, monkeypatch):
    a, b, _, _ = pair(setup)
    assert setup[0].post(url(setup) + "/compare", json=body(setup, a, a)).status_code == 422
    before = rows(), state()
    monkeypatch.setattr(comparison, "MAX_BYTES", 100)
    result = setup[0].post(url(setup) + "/compare", json=body(setup, a, b))
    assert result.status_code == 422 and result.json()["detail"]["code"] == "comparison_export_size_limit"
    assert (rows(), state()) == before


def test_missing_or_nonfinite_metric_never_becomes_zero():
    for first, second, reason in [({}, {"x": 1}, "baseline_value_missing"), ({"x": 1}, {}, "selected_value_missing"),
        ({"x": None}, {"x": 1}, "baseline_value_unavailable"), ({"x": 1}, {"x": float("inf")}, "selected_value_unavailable")]:
        value = comparison._metric(first, second, "x", "shares", True)
        assert value["delta"] is None and value["reason"] == reason
    assert comparison._metric({"x": 0}, {"x": 1}, "x", "shares", True)["delta"] == 1


def test_gtd_matching_future_unknown_compares_observed_prefix_only(setup):
    a, b, _, _ = pair(setup, "open_gtd", {"participation_pct": 10, "gtd_date": "2024-01-09"}, {"participation_pct": 20, "gtd_date": "2024-01-09"})
    result = call(setup, a, b).json()
    assert result["comparison"]["historically_comparable"]
    row = result["comparison"]["orders"][0]
    assert row["metrics"]["observed_prefix_scenario_shares"]["delta"] == 10
    assert row["metrics"]["final_scenario_shares"]["delta"] is None
    assert row["sessions"][1]["metrics"]["scenario_shares"]["delta"] is None


def test_saved_shape_check_rejects_quantity_and_horizon_reassociation(setup):
    import copy
    a, b, _, _ = pair(setup, "open_gtd")
    wrong = copy.deepcopy(b["receipt"])
    wrong["evidence"]["orders"][0]["shares_exact"] = "999.000000"
    checks = comparison._basis(a["receipt"], wrong)
    assert next(row for row in checks if row["code"] == "saved_evidence_shape")["matches"] is False
    wrong = copy.deepcopy(b["receipt"])
    wrong["evidence"]["orders"][0]["sessions"][0]["date"] = "2024-01-09"
    assert comparison._shape(wrong["evidence"], "open_gtd") is False


def test_observation_session_change_rejects_mixed_currentness(setup, monkeypatch):
    a, b, _, _ = pair(setup)
    calls = 0
    def changing():
        nonlocal calls
        calls += 1
        return "2024-01-08" if calls == 1 else "2024-01-09"
    monkeypatch.setattr(comparison.sessions, "latest_completed_session", changing)
    response = setup[0].post(url(setup) + "/compare", json=body(setup, a, b))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "comparison_observation_session_changed"
