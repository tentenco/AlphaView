"""Drawdown chronology uses hand-computed curves and server-made temporary receipts only."""
from datetime import date, timedelta
import copy
import sqlite3

import pytest

from alphaview.panel import paper_portfolio as paper, sessions, store
from alphaview.panel import workflow_path_drawdowns as drawdowns, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path, workflow_path_costs as costs
from tests.test_workflow_path_validation import workspace  # noqa: F401
from tests.test_workflow_path_receipts import setup, prepare, protected_state, rows, url  # noqa: F401
from tests.test_workflow_path_receipt_comparison import rewrite


def curve(values):
    return [{"date": (date(2026, 1, 1) + timedelta(days=index)).isoformat(), "nav": value}
            for index, value in enumerate(values)]


def test_latest_plateau_peak_first_equal_trough_and_equal_peak_recovery():
    result = drawdowns.episodes(curve([100, 100, 90, 80, 80, 90, 100, 110, 99]))
    first, terminal = result["episodes"]
    assert (first["peak_index"], first["first_underwater_index"], first["trough_index"], first["recovery_index"]) == (1, 2, 3, 6)
    assert first["depth_pct"] == pytest.approx(-20)
    assert (first["duration_sessions"], first["underwater_sessions"], first["to_trough_sessions"], first["trough_to_recovery_sessions"]) == (5, 4, 2, 3)
    assert terminal["status"] == "open" and terminal["peak_index"] == 7 and terminal["trough_index"] == 8
    assert terminal["recovery_date"] is terminal["duration_sessions"] is terminal["underwater_sessions"] is None
    assert terminal["trough_to_recovery_sessions"] is None
    assert terminal["observed_elapsed_sessions"] == terminal["observed_underwater_sessions"] == 1
    assert result["summary"] == {"episode_count": 2, "recovered_episode_count": 1, "open_episode_count": 1,
        "unrecovered_at_end": True, "max_drawdown_pct": pytest.approx(-20), "total_underwater_sessions": 5,
        "longest_observed_underwater_sessions": 4, "longest_closed_duration_sessions": 5,
        "longest_observed_elapsed_sessions": 5}


def test_new_high_recovery_then_next_episode_uses_that_peak_and_chronological_order():
    result = drawdowns.episodes(curve([100, 95, 105, 100, 90, 105, 105, 104]))
    assert [item["peak_index"] for item in result["episodes"]] == [0, 2, 6]
    assert [item["recovery_index"] for item in result["episodes"]] == [2, 5, None]
    assert result["curve"][2]["peak_nav"] == 105
    assert result["episodes"][1]["depth_pct"] == pytest.approx((90 / 105 - 1) * 100)


@pytest.mark.parametrize("values", [[100], [100, 100, 100], [100, 110, 120]])
def test_no_episodes_means_known_zero_counts_but_no_episode_duration(values):
    result = drawdowns.episodes(curve(values))
    assert result["episodes"] == [] and result["summary"]["max_drawdown_pct"] == 0
    assert result["summary"]["total_underwater_sessions"] == 0
    assert result["summary"]["longest_closed_duration_sessions"] is None
    assert result["summary"]["longest_observed_elapsed_sessions"] is None
    assert all(row["drawdown_pct"] == 0 for row in result["curve"])


def test_initial_cash_is_the_first_peak_and_terminal_recovery_is_not_invented():
    result = drawdowns.episodes(curve([100, 90, 95, 95]))
    item = result["episodes"][0]
    assert item["peak_index"] == 0 and item["trough_index"] == 1 and item["status"] == "open"
    assert item["observed_elapsed_sessions"] == item["observed_underwater_sessions"] == 3
    assert item["duration_sessions"] is item["recovery_nav"] is item["recovery_index"] is None
    assert result["summary"]["longest_closed_duration_sessions"] is None


@pytest.mark.parametrize("value", [None, 0, -1, True, float("nan"), float("inf"), 10 ** 400])
def test_invalid_nav_disables_entire_curve(value):
    with pytest.raises(ValueError, match="curve_values"):
        drawdowns.episodes(curve([100, value, 90]))


@pytest.mark.parametrize("mode", ["duplicate", "unsorted", "bad_date", "too_many", "empty"])
def test_invalid_date_or_size_is_not_dropped_sorted_or_partially_analyzed(mode):
    points = curve([100, 90, 100])
    if mode == "duplicate": points[1]["date"] = points[0]["date"]
    if mode == "unsorted": points.reverse()
    if mode == "bad_date": points[1]["date"] = "2026-2-1"
    if mode == "too_many": points = curve([100] * 254)
    if mode == "empty": points = []
    with pytest.raises(ValueError):
        drawdowns.episodes(points)


def test_extreme_finite_new_high_does_not_overflow_by_dividing_by_old_tiny_peak():
    result = drawdowns.episodes(curve([1e-300, 1e300, 1e-300]))
    assert result["summary"]["max_drawdown_pct"] == -100
    assert result["curve"][1]["drawdown_pct"] == 0


@pytest.fixture
def item(setup):
    setup[0].app.include_router(drawdowns.router)
    response = setup[0].post(url(setup), json=prepare(setup)[0])
    assert response.status_code == 201, response.text
    return setup, response.json()


def endpoint(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/workflow-path-receipts/drawdowns"


def request(setup, item):
    return {"receipt_id": item["id"], "expected_fingerprint": item["content_fingerprint"],
            "expected_account_version": setup[2]["version"]}


def test_saved_original_exact_calendar_reconciliation_snapshot_and_no_recompute(item, monkeypatch):
    setup, original = item
    before, protected, revision = rows(), protected_state(), store.input_revision()
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Never rebuild saved path"))
    monkeypatch.setattr(costs, "evaluate", lambda *args: pytest.fail("Never rebuild saved costs"))
    actual = receipts._view
    def readonly(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM workflow_path_receipts")
        return actual(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", readonly)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["analysis"]["status"] == "evaluated" and value["analysis"]["reasons"] == []
    assert value["analysis"]["reconciliation"]["within_tolerance"] is True
    assert len(value["analysis"]["curve"]) == 253
    assert value["analysis"]["curve"][0]["nav"] == original["receipt"]["evidence"]["metrics"]["initial_cash"]
    assert [row["date"] for row in value["analysis"]["curve"]] == sessions.expected_sessions(
        original["receipt"]["evidence"]["window"]["signal_start"], original["receipt"]["evidence"]["as_of"])
    assert value["original_receipt"] == original["receipt"]
    assert receipts._json(value["original_receipt"]).encode() == receipts._json(original["receipt"]).encode()
    assert response.content == receipts._json(value).encode()
    assert response.headers["cache-control"] == "no-store" and len(response.content) <= drawdowns.MAX_BYTES
    assert value["execution_authority"] is False
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("mode", ["missing", "duplicate", "unsorted", "nonpositive", "metric_mismatch", "cash_mismatch", "calendar_gap"])
def test_validly_signed_but_incomplete_or_inconsistent_original_is_wholly_unavailable(item, mode):
    setup, original = item
    def change(payload):
        evidence = payload["evidence"]
        if mode == "missing": evidence["curve"].pop(6)
        if mode == "duplicate": evidence["curve"][6]["date"] = evidence["curve"][5]["date"]
        if mode == "unsorted": evidence["curve"][5:7] = evidence["curve"][5:7][::-1]
        if mode == "nonpositive": evidence["curve"][6]["value"] = 0
        if mode == "metric_mismatch": evidence["metrics"]["max_drawdown_pct"] -= 0.01
        if mode == "cash_mismatch": evidence["metrics"]["initial_cash"] += 1
        if mode == "calendar_gap":
            dates = [row["date"] for row in evidence["curve"]]
            for index in range(1, len(dates) - 1):
                alternate = (date.fromisoformat(dates[index - 1]) + timedelta(days=1)).isoformat()
                if dates[index - 1] < alternate < dates[index]:
                    evidence["curve"][index]["date"] = alternate
                    break
            else: pytest.fail("Synthetic calendar needs a non-session gap")
    original = rewrite(original, change)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["analysis"]["status"] == "unavailable" and value["analysis"]["reasons"]
    assert value["analysis"]["episodes"] is value["analysis"]["curve"] is value["analysis"]["summary"] is None
    assert value["original_receipt"] == original["receipt"]


def test_stale_source_and_method_observation_preserves_historical_analysis(item, monkeypatch):
    setup, original = item
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-new-path")
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("No stale path refresh"))
    body = {**request(setup, original), "expected_account_version": setup[2]["version"] + 1}
    value = setup[0].post(endpoint(setup), json=body).json()
    assert value["analysis"]["status"] == "evaluated"
    assert value["receipt_summary"]["currentness"]["current"] is False
    assert value["original_receipt"] == original["receipt"]


def test_scope_fingerprint_version_corruption_and_strict_input(item):
    setup, original = item
    body, client = request(setup, original), setup[0]
    assert client.post(endpoint(setup), json={**body, "expected_fingerprint": "0" * 64}).status_code == 409
    assert client.post(endpoint(setup), json={**body, "expected_account_version": body["expected_account_version"] + 1}).status_code == 409
    for change in ({"expected_account_version": True}, {"expected_account_version": 0}, {"unexpected": 1}, {"receipt_id": "wrong"}):
        assert client.post(endpoint(setup), json={**body, **change}).status_code == 422
    other = paper.create_account(paper.AccountInput(name="Synthetic foreign drawdown", initial_cash=100,
        idempotency_key="synthetic-foreign-drawdown"))["account"]
    assert client.post(endpoint(setup).replace(setup[2]["id"], other["id"]), json=body).status_code == 404
    with store.connect() as db:
        db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (original["id"],))
    assert client.post(endpoint(setup), json=body).status_code == 409


def test_cost_receipt_is_not_silently_treated_as_a_path(setup):
    setup[0].app.include_router(drawdowns.router)
    original = setup[0].post(url(setup), json=prepare(setup, "path_costs")[0]).json()
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "drawdown_path_receipt_required"


def test_oversized_export_refused_without_writes_or_truncation(item, monkeypatch):
    setup, original = item
    before = rows()
    monkeypatch.setattr(drawdowns, "MAX_BYTES", 100)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "drawdown_export_size_limit"
    assert rows() == before


def test_metric_tolerance_is_explicit_and_does_not_rewrite_original(item):
    _, original = item
    payload = copy.deepcopy(original["receipt"])
    payload["evidence"]["metrics"]["max_drawdown_pct"] += drawdowns.ABS_TOLERANCE_PP / 2
    result = drawdowns.analyze(payload)
    assert result["status"] == "evaluated" and result["reconciliation"]["within_tolerance"] is True
    assert result["reconciliation"]["recorded_max_drawdown_pct"] == payload["evidence"]["metrics"]["max_drawdown_pct"]
