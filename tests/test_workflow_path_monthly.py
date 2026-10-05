"""Monthly returns use hand-computed paths and server-made temporary receipts only."""
from datetime import date, timedelta
import copy
import sqlite3

import pytest

from alphaview.panel import paper_portfolio as paper, sessions, store
from alphaview.panel import workflow_path_monthly as monthly, workflow_path_receipts as receipts
from alphaview.panel import workflow_path_validation as path, workflow_path_costs as costs
from tests.test_workflow_path_validation import workspace  # noqa: F401
from tests.test_workflow_path_receipts import setup, prepare, protected_state, rows, url  # noqa: F401
from tests.test_workflow_path_receipt_comparison import rewrite


def points(first, last, nav=lambda day: 100):
    return [{"date": day, "nav": nav(day)} for day in sessions.expected_sessions(first, last)]


def test_exact_month_boundaries_chain_returns_instead_of_adding_and_keep_cash_anchor_out_of_grid():
    values = points("2025-12-31", "2026-02-03", lambda day: 100 if day == "2025-12-31" else 110 if day < "2026-02" else 99)
    result = monthly.monthly(values)
    january, february = result["months"]
    assert january["status"] == "complete" and january["reasons"] == []
    assert january["observed_start"] == january["expected_first_session"] == "2026-01-02"
    assert january["observed_end"] == january["expected_last_session"] == "2026-01-30"
    assert january["boundary_date"] == "2025-12-31" and january["boundary_kind"] == "initial_cash"
    assert january["return_pct"] == pytest.approx(10) and january["nav_change"] == 10
    assert february["boundary_date"] == "2026-01-30" and february["boundary_nav"] == 110
    assert february["boundary_kind"] == "preceding_saved_nav"
    assert february["return_pct"] == pytest.approx(-10) and february["nav_change"] == -11
    assert february["status"] == "partial" and february["reasons"] == ["month_ends_before_last_session"]
    assert february["expected_last_session"] == "2026-02-27"
    assert result["summary"]["chained_return_pct"] == pytest.approx(-1)
    assert result["summary"]["summed_monthly_nav_change"] == result["summary"]["nav_change"] == -1
    assert result["summary"]["complete_month_count"] == result["summary"]["partial_month_count"] == 1
    assert [row["year"] for row in result["years"]] == [2026]
    assert len(result["years"][0]["months"]) == 12
    assert result["years"][0]["months"][2] == {"month": "2026-03", "month_number": 3,
        "status": "outside_window", "reasons": ["outside_saved_window"], "return_pct": None,
        "nav_change": None, "observed_sessions": None, "expected_sessions": None,
        "observed_start": None, "observed_end": None}


def test_partial_first_month_and_complete_final_month_follow_historical_xnys_not_calendar_day_numbers():
    result = monthly.monthly(points("2026-01-14", "2026-02-27"))
    january, february = result["months"]
    assert january["status"] == "partial" and january["reasons"] == ["month_starts_after_first_session"]
    assert january["observed_start"] == "2026-01-15"
    assert february["status"] == "complete" and february["observed_start"] == "2026-02-02"
    assert february["observed_end"] == "2026-02-27"  # February 28 is Saturday.
    assert january["return_pct"] == february["return_pct"] == 0
    assert result["summary"]["valued_sessions"] == len(points("2026-01-14", "2026-02-27")) - 1


def test_same_month_can_be_partial_at_both_ends_with_known_return_not_unavailable():
    result = monthly.monthly(points("2026-01-14", "2026-01-16", lambda day: 100 if day == "2026-01-14" else 103))
    row = result["months"][0]
    assert row["status"] == "partial"
    assert row["reasons"] == ["month_starts_after_first_session", "month_ends_before_last_session"]
    assert row["observed_sessions"] == 2 and row["return_pct"] == pytest.approx(3)
    assert result["years"][0]["months"][0]["return_pct"] == pytest.approx(3)


def test_year_boundary_retains_chronology_and_twelve_cells_per_observed_year():
    result = monthly.monthly(points("2025-12-30", "2026-01-02"))
    assert [row["month"] for row in result["months"]] == ["2025-12", "2026-01"]
    assert [row["year"] for row in result["years"]] == [2025, 2026]
    assert all(len(row["months"]) == 12 for row in result["years"])
    assert result["years"][0]["months"][11]["return_pct"] == 0
    assert result["years"][1]["months"][0]["return_pct"] == 0
    assert result["years"][0]["months"][0]["return_pct"] is None


@pytest.mark.parametrize("value", [None, 0, -1, True, float("nan"), float("inf"), 10 ** 400])
def test_missing_nonfinite_nonpositive_and_non_numeric_nav_never_becomes_zero_return(value):
    curve = points("2026-01-14", "2026-01-16")
    curve[1]["nav"] = value
    with pytest.raises(ValueError, match="monthly_curve_values_unavailable"):
        monthly.monthly(curve)


@pytest.mark.parametrize("mode", ["duplicate", "unsorted", "missing", "weekend", "anchor", "empty"])
def test_dates_and_signal_boundary_must_match_every_expected_session_without_alignment(mode):
    curve = points("2026-01-14", "2026-01-23")
    if mode == "duplicate": curve[2]["date"] = curve[1]["date"]
    if mode == "unsorted": curve.reverse()
    if mode == "missing": curve.pop(2)
    if mode == "weekend": curve[2]["date"] = "2026-01-17"
    if mode == "anchor": curve[0]["date"] = "2026-01-13"
    if mode == "empty": curve = []
    with pytest.raises(ValueError):
        monthly.monthly(curve)


@pytest.mark.parametrize("first,last", [(1e-300, 1e300), (1e300, 1e-300), (1, 1e307)])
def test_nonfinite_or_underflowed_ratio_makes_whole_monthly_analysis_unavailable(first, last):
    curve = points("2026-01-14", "2026-01-15", lambda day: first if day == "2026-01-14" else last)
    with pytest.raises(ValueError, match="monthly_arithmetic_unavailable"):
        monthly.monthly(curve)


@pytest.fixture
def item(setup):
    setup[0].app.include_router(monthly.router)
    response = setup[0].post(url(setup), json=prepare(setup)[0])
    assert response.status_code == 201, response.text
    return setup, response.json()


def endpoint(setup):
    return f"/api/paper/accounts/{setup[2]['id']}/workflow-path-receipts/monthly"


def request(setup, item):
    return {"receipt_id": item["id"], "expected_fingerprint": item["content_fingerprint"],
            "expected_account_version": setup[2]["version"]}


def test_original_bytes_strict_snapshot_252_calendar_complete_chaining_and_no_recompute(item, monkeypatch):
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
    assert all(check["within_tolerance"] for check in analysis["reconciliation"])
    assert analysis["summary"]["valued_sessions"] == sum(row["observed_sessions"] for row in analysis["months"]) == 252
    assert analysis["months"][0]["boundary_date"] == evidence["window"]["signal_start"]
    assert analysis["months"][0]["boundary_nav"] == evidence["metrics"]["initial_cash"]
    assert analysis["summary"]["chained_return_pct"] == pytest.approx(evidence["metrics"]["return_pct"])
    for previous, selected in zip(analysis["months"], analysis["months"][1:]):
        assert selected["boundary_date"] == previous["observed_end"]
        assert selected["boundary_nav"] == previous["end_nav"]
    assert value["tolerances"] == monthly.TOLERANCES
    assert value["original_receipt"] == original["receipt"]
    assert receipts._json(value["original_receipt"]).encode() == receipts._json(original["receipt"]).encode()
    assert response.content == receipts._json(value).encode() and len(response.content) <= monthly.MAX_BYTES
    assert response.headers["cache-control"] == "no-store" and value["execution_authority"] is False
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


@pytest.mark.parametrize("mode", ["missing", "duplicate", "unsorted", "calendar_gap", "final_metric", "return_metric", "cash_basis", "short_window"])
def test_signed_but_invalid_or_inconsistent_saved_evidence_disables_entire_calendar(item, mode):
    setup, original = item
    def change(payload):
        value = payload["evidence"]
        if mode == "missing": value["curve"].pop(5)
        if mode == "duplicate": value["curve"][5]["date"] = value["curve"][4]["date"]
        if mode == "unsorted": value["curve"][4:6] = value["curve"][4:6][::-1]
        if mode == "calendar_gap":
            for index in range(1, len(value["curve"]) - 1):
                previous, current = value["curve"][index - 1]["date"], value["curve"][index]["date"]
                alternate = (date.fromisoformat(previous) + timedelta(days=1)).isoformat()
                if previous < alternate < current:
                    value["curve"][index]["date"] = alternate
                    break
            else: pytest.fail("Synthetic calendar needs a non-session gap")
        if mode == "final_metric": value["metrics"]["final_value"] += 1
        if mode == "return_metric": value["metrics"]["return_pct"] += 0.01
        if mode == "cash_basis": value["metrics"]["initial_cash"] += 1
        if mode == "short_window":
            value["curve"].pop(0)
            value["window"].update(start=value["curve"][0]["date"], sessions=251)
            value["coverage"].update(required_path_sessions=251, valued_path_sessions=251)
    original = rewrite(original, change)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["analysis"]["status"] == "unavailable" and value["analysis"]["reasons"]
    assert value["analysis"]["months"] is value["analysis"]["years"] is value["analysis"]["summary"] is None
    assert value["original_receipt"] == original["receipt"]


def test_stale_source_and_later_method_remain_historical_without_refresh(item, monkeypatch):
    setup, original = item
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    monkeypatch.setattr(path, "ENGINE_VERSION", "synthetic-later-monthly-path")
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("No stale path refresh"))
    body = {**request(setup, original), "expected_account_version": setup[2]["version"] + 1}
    value = setup[0].post(endpoint(setup), json=body).json()
    assert value["analysis"]["status"] == "evaluated"
    assert value["receipt_summary"]["currentness"]["current"] is False
    assert value["original_receipt"] == original["receipt"]


def test_scope_version_fingerprint_corruption_and_strict_input(item):
    setup, original = item
    body, client = request(setup, original), setup[0]
    assert client.post(endpoint(setup), json={**body, "expected_fingerprint": "0" * 64}).status_code == 409
    assert client.post(endpoint(setup), json={**body, "expected_account_version": body["expected_account_version"] + 1}).status_code == 409
    for change in ({"expected_account_version": True}, {"expected_account_version": 0}, {"extra": 1}, {"receipt_id": "wrong"}):
        assert client.post(endpoint(setup), json={**body, **change}).status_code == 422
    other = paper.create_account(paper.AccountInput(name="Synthetic monthly foreign", initial_cash=100,
        idempotency_key="synthetic-monthly-foreign"))["account"]
    assert client.post(endpoint(setup).replace(setup[2]["id"], other["id"]), json=body).status_code == 404
    with store.connect() as db:
        db.execute("UPDATE workflow_path_receipts SET payload_json='{' WHERE id=?", (original["id"],))
    assert client.post(endpoint(setup), json=body).status_code == 409


def test_cost_receipt_rejected_and_oversize_export_refused_without_writes(setup, monkeypatch):
    setup[0].app.include_router(monthly.router)
    original = setup[0].post(url(setup), json=prepare(setup, "path_costs")[0]).json()
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "monthly_path_receipt_required"
    original = setup[0].post(url(setup), json=prepare(setup)[0]).json()
    before = rows()
    monkeypatch.setattr(monthly, "MAX_BYTES", 100)
    response = setup[0].post(endpoint(setup), json=request(setup, original))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "monthly_export_size_limit"
    assert rows() == before


def test_explicit_tolerance_records_difference_without_rewriting_saved_metrics(item):
    _, original = item
    payload = copy.deepcopy(original["receipt"])
    payload["evidence"]["metrics"]["return_pct"] += monthly.RETURN_ABS_TOLERANCE_PP / 2
    value = monthly.analyze(payload)
    assert value["status"] == "evaluated"
    check = next(check for check in value["reconciliation"] if check["code"] == "direct_return_matches_saved")
    assert check["reference"] == payload["evidence"]["metrics"]["return_pct"] and check["difference"] != 0
