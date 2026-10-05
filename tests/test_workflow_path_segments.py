"""Chronological path decomposition: boundary arithmetic, one snapshot and honest missingness."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import math
import sqlite3

import pytest

from alphaview.panel import sessions, store, workflow_path_segments as segments
from alphaview.panel import workflow_path_validation as path
from tests.test_workflow_path_validation import body, saved, workspace  # noqa: F401


@pytest.fixture
def segmentspace(workspace):
    client, days, monkeypatch = workspace
    client.app.include_router(segments.router)
    return client, days, monkeypatch


def url(run):
    return f"/api/portfolio-agent/runs/{run['id']}/path-segments"


def all_rows():
    with store.connect() as db:
        return {name: [tuple(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY rowid')]
            for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def analytical_path(values=None, events=True):
    calendar = sessions.expected_sessions("2024-01-01", "2025-12-31")[-253:]
    values = values if values is not None else [110.] * 63 + [55.] * 62 + [88.] + [88.] * 63 + [176.] * 63
    fills = []
    if events:
        for offset, notionals in ((0, [10.]), (62, [40.]), (63, [20., 30.])):
            fills.append({"signal_date": calendar[offset], "trade_date": calendar[offset + 1],
                "fee": sum(notionals) / 10, "cash": 0.,
                "trades": [{"symbol": "SYNTA", "side": "buy" if i == 0 else "sell", "shares": value,
                    "raw_open": 1., "notional": value, "fee": value / 10} for i, value in enumerate(notionals)]})
    return {"status": "evaluated", "reasons": [], "settings": {"initial_cash": 100.},
        "window": {"signal_start": calendar[0], "start": calendar[1], "end": calendar[-1], "sessions": 252},
        "coverage": {"valued_path_sessions": 252},
        "curve": [{"date": day, "value": value, "cash": value, "exposure_pct": 0.} for day, value in zip(calendar[1:], values)],
        "events": fills, "decisions": [{"signal_date": calendar[i], "trade_date": calendar[i + 1], "status": "hold_no_candidates"}
            for i in range(0, 252, 21)],
        "metrics": {"initial_cash": 100., "final_value": values[-1], "return_pct": (values[-1] / 100 - 1) * 100,
            "max_drawdown_pct": -50., "trade_count": sum(len(row["trades"]) for row in fills),
            "total_fees": math.fsum(row["fee"] for row in fills),
            "traded_notional": math.fsum(trade["notional"] for row in fills for trade in row["trades"])}}


def test_boundary_return_drawdown_trade_dates_and_additive_reconciliation_are_hand_checked():
    baseline = analytical_path()
    original = copy.deepcopy(baseline)
    rows, reasons, reconciliation = segments.decompose(baseline)
    assert baseline == original and reasons == []
    assert [row["metrics"]["boundary_value"] for row in rows] == [100, 110, 88, 88]
    assert [row["metrics"]["final_value"] for row in rows] == [110, 88, 88, 176]
    assert [row["metrics"]["return_pct"] for row in rows] == pytest.approx([10, -20, 0, 100])
    assert [row["metrics"]["net_change"] for row in rows] == [10, -22, 0, 88]
    assert [row["metrics"]["max_drawdown_pct"] for row in rows] == [0, -50, 0, 0]
    assert rows[0]["window"]["boundary_date"] == baseline["window"]["signal_start"]
    assert rows[1]["window"]["boundary_date"] == baseline["curve"][62]["date"]
    assert rows[1]["window"]["start"] == baseline["curve"][63]["date"]
    assert [row["event_indices"] for row in rows] == [[0, 1], [2], [], []]
    assert [row["metrics"]["trade_count"] for row in rows] == [2, 2, 0, 0]
    assert [row["metrics"]["total_fees"] for row in rows] == [5, 5, 0, 0]
    assert rows[0]["metrics"]["turnover_pct"] == 50
    assert rows[1]["metrics"]["turnover_pct"] == pytest.approx(50 / 110 * 100)
    assert reconciliation["chained_return_pct"] == pytest.approx(76)
    assert reconciliation["chained_return_pct"] != pytest.approx(sum(row["metrics"]["return_pct"] for row in rows))
    assert reconciliation["summed_net_change"] == reconciliation["full_path_net_change"] == 76
    assert reconciliation["return_residual_pp"] == pytest.approx(0, abs=1e-12)
    assert reconciliation["fees_residual"] == reconciliation["notional_residual"] == reconciliation["trade_count_residual"] == 0
    dates = []
    for index, row in enumerate(rows):
        assert row["coverage"] == {"required_sessions": 63, "observed_sessions": 63, "covered_sessions": 63,
            "known_decisions": 3, "known_events": len(row["event_indices"])}
        assert row["curve_indices"] == [index * 63, (index + 1) * 63]
        assert len(row["normalized_curve"]) == 64 and row["normalized_curve"][0]["index_value"] == 100
        assert row["normalized_curve"][-1]["session"] == 63
        dates.extend(point["date"] for point in row["normalized_curve"][1:])
    assert dates == [row["date"] for row in baseline["curve"]] and len(set(dates)) == 252


def test_all_cash_and_zero_trade_segments_preserve_known_zeros():
    rows, reasons, reconciliation = segments.decompose(analytical_path([100.] * 252, events=False))
    assert reasons == [] and reconciliation["chained_return_pct"] == 0
    for row in rows:
        assert all(row["metrics"][key] == 0 for key in ("return_pct", "net_change", "max_drawdown_pct", "total_fees", "traded_notional", "turnover_pct", "trade_count"))
        assert [point["index_value"] for point in row["normalized_curve"]] == [100.] * 64


def test_api_evaluates_one_real_path_under_query_only_and_preserves_every_baseline_field(segmentspace, monkeypatch):
    client, days, _ = segmentspace
    run = saved(client, days)
    before = all_rows()
    original, calls = path.evaluate, []
    def once(identifier, request):
        with store.connect() as db:
            assert db.execute("PRAGMA query_only").fetchone()[0] == 1
            with pytest.raises(sqlite3.OperationalError):
                db.execute("DELETE FROM portfolio_agent_runs")
        value = original(identifier, request)
        value["future_evidence_field"] = {"nullable": None, "zero": 0.0}
        calls.append(copy.deepcopy(value))
        return value
    monkeypatch.setattr(path, "evaluate", once)
    response = client.post(url(run), json=body(run))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["baseline"] == calls[0] and len(calls) == 1
    assert value["status"] == "evaluated" and value["engine_version"] == segments.ENGINE_VERSION
    assert value["coverage"] == {"required_segments": 4, "available_segments": 4, "required_path_sessions": 252,
        "observed_path_sessions": 252, "covered_path_sessions": 252, "path_evaluations": 1}
    assert value["baseline_evidence_fingerprint"] == calls[0]["evidence_fingerprint"]
    assert value["evidence_fingerprint"] == segments._hash({key: row for key, row in value.items() if key != "evidence_fingerprint"})
    assert response.headers["cache-control"] == "no-store"
    assert set(value).isdisjoint({"verdict", "pass", "sharpe", "pbo", "ranking", "folds"})
    assert all_rows() == before
    json.dumps(value, allow_nan=False)


def test_unavailable_baseline_retains_four_targeted_windows_and_known_decisions_without_zero_metrics(segmentspace):
    client, days, _ = segmentspace
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (days[-300],))
    run = saved(client, days)
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == value["baseline"]["status"] == "unavailable"
    assert value["coverage"]["available_segments"] == value["coverage"]["covered_path_sessions"] == 0
    assert value["reconciliation"] is None and len(value["segments"]) == 4
    assert value["segments"][0]["window"]["boundary_date"] == days[-253]
    for row in value["segments"]:
        assert row["metrics"] is None and row["normalized_curve"] == []
        assert row["coverage"]["required_sessions"] == 63
        assert row["coverage"]["covered_sessions"] == row["coverage"]["observed_sessions"] == 0
        assert row["coverage"]["known_decisions"] == 3
        assert {reason["code"] for reason in row["reasons"]} >= {"baseline_unavailable", "decision_evidence_incomplete"}


@pytest.mark.parametrize("fault", ["curve_missing", "duplicate_date", "calendar", "fees", "event_date", "duplicate_event", "total", "zero_boundary"])
def test_incomplete_or_inconsistent_support_never_looks_like_four_complete_segments(fault):
    baseline = analytical_path()
    if fault == "curve_missing": baseline["curve"].pop()
    if fault == "duplicate_date": baseline["curve"][1]["date"] = baseline["curve"][0]["date"]
    if fault == "calendar": baseline["window"]["signal_start"] = None
    if fault == "fees": baseline["events"][0]["fee"] += 1
    if fault == "event_date": baseline["events"][0]["trade_date"] = "2099-01-01"
    if fault == "duplicate_event": baseline["events"].append(copy.deepcopy(baseline["events"][0]))
    if fault == "total": baseline["metrics"]["traded_notional"] += 1
    if fault == "zero_boundary": baseline["curve"][62]["value"] = 0
    rows, reasons, reconciliation = segments.decompose(baseline)
    assert reasons == [{"code": "path_support_incomplete"}] and reconciliation is None
    assert len(rows) == 4 and all(row["metrics"] is None and row["coverage"]["covered_sessions"] == 0 for row in rows)
    if fault == "curve_missing":
        assert rows[-1]["coverage"]["observed_sessions"] == 62
    if fault == "calendar":
        assert all(row["window"]["start"] is None and row["coverage"]["observed_sessions"] == 0 for row in rows)


def test_overflow_does_not_leave_earlier_segments_with_partial_metrics():
    values = [1e-300] * 63 + [1e300] * 63 + [100.] * 126
    rows, reasons, reconciliation = segments.decompose(analytical_path(values, events=False))
    assert reasons == [{"code": "segment_arithmetic_unavailable"}] and reconciliation is None
    assert all(row["metrics"] is None and row["normalized_curve"] == [] and row["coverage"]["covered_sessions"] == 0 for row in rows)


@pytest.mark.parametrize("change", [{"extra": 1}, {"segments": 4}, {"expected_as_of": "2026-02-30"},
    {"expected_input_revision": ""}, {"expected_proposal_fingerprint": True}, {"extra": float("nan")}])
def test_strict_requests_do_not_allow_parameter_search_or_nonfinite_error_echo(segmentspace, monkeypatch, change):
    client, days, _ = segmentspace
    run = saved(client, days)
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("Invalid request reached the path engine"))
    response = client.post(url(run), content=json.dumps(body(run, **change)), headers={"Content-Type": "application/json"})
    assert response.status_code == 422, response.text
    json.dumps(response.json(), allow_nan=False)
    assert all("input" not in item for item in response.json()["detail"])


@pytest.mark.parametrize("change", [{"expected_proposal_fingerprint": "f" * 64}, {"expected_as_of": "2024-01-01"},
                                    {"expected_input_revision": "synthetic:changed"}])
def test_stale_source_never_runs_the_path_computation(segmentspace, monkeypatch, change):
    client, days, _ = segmentspace
    run = saved(client, days)
    monkeypatch.setattr(path, "_compute", lambda *a: pytest.fail("Stale source reached computation"))
    assert client.post(url(run), json=body(run, **change)).status_code == 409


def test_session_rollover_after_path_before_segment_response_rejects(segmentspace, monkeypatch):
    client, days, _ = segmentspace
    run = saved(client, days)
    original = segments.decompose
    def moved(baseline):
        value = original(baseline)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2099-01-01")
        return value
    monkeypatch.setattr(segments, "decompose", moved)
    result = client.post(url(run), json=body(run))
    assert result.status_code == 409 and result.json()["detail"]["code"] == "workflow_path_segments_stale"


def test_concurrent_write_keeps_the_original_path_and_all_segments_in_one_snapshot(segmentspace, monkeypatch):
    client, days, _ = segmentspace
    run = saved(client, days)
    baseline = client.post(url(run), json=body(run)).json()
    original, moved = segments._fill_segment, []
    def segment_then_write(*args):
        value = original(*args)
        if not moved:
            moved.append(True)
            def write():
                with store.connect() as db:
                    db.execute("UPDATE bars SET volume=volume+5 WHERE symbol='SYNTA'")
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(write).result(timeout=5)
        return value
    monkeypatch.setattr(segments, "_fill_segment", segment_then_write)
    result = client.post(url(run), json=body(run))
    assert result.status_code == 200, result.text
    value = result.json()
    assert moved and value == baseline
    assert value["input_revision"] != store.input_revision()
    assert client.get(f"/api/portfolio-agent/runs/{run['id']}").json()["current"] is False
