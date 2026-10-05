"""Cash-flow attribution oracles on isolated synthetic paths; no provider/model/broker calls."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import math
import sqlite3

import pytest

from alphaview.panel import sessions, store, workflow_path_attribution as attribution
from alphaview.panel import workflow_path_validation as path
from tests.test_workflow_path_validation import body, saved, workspace  # noqa: F401


@pytest.fixture
def attributionspace(workspace):
    client, days, monkeypatch = workspace
    client.app.include_router(attribution.router)
    return client, days, monkeypatch


def url(run):
    return f"/api/portfolio-agent/runs/{run['id']}/path-attribution"


def state():
    with store.connect() as db:
        return {name: [tuple(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY rowid')]
            for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def analytical(targets=None):
    days = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
    data = {"SYNA": ([90, 100, 120, 140], [95, 110, 130, 150]),
            "SYNB": ([180, 200, 220, 240], [190, 210, 230, 250]),
            "SYNC": ([50, 50, 50, 50], [50, 50, 50, 50])}
    raw = {symbol: [{"date": day, "open": opening, "high": max(opening, close) + 1, "low": min(opening, close) - 1,
        "close": close, "adj_close": close, "volume": 1000000} for day, opening, close in zip(days, opens, closes)]
        for symbol, (opens, closes) in data.items()}
    targets = targets if targets is not None else [(1, [{"symbol": "SYNA", "weight_pct": 50}])]
    decisions = [{"signal_date": days[index - 1], "trade_date": days[index], "status": "rebalance", "targets": weights}
        for index, weights in targets]
    baseline = {**path._simulate(days, decisions, raw), "candidate_symbols": list(raw), "status": "evaluated", "reasons": [],
        "decisions": decisions, "window": {"sessions": 3, "signal_start": days[0], "start": days[1], "end": days[-1]}}
    return baseline, days, raw


def test_buy_hold_fee_and_contribution_points_follow_independent_cashflow_formula():
    baseline, days, raw = analytical()
    original = copy.deepcopy(baseline)
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert reasons == [] and baseline == original
    trade = baseline["events"][0]["trades"][0]
    q, fee = trade["shares"], trade["fee"]
    expected = [q * (110 - 100) - fee, q * (130 - 110), q * (150 - 130)]
    assert [day["contributions"][0]["net_pnl"] for day in daily] == pytest.approx(expected)
    assert rows[0]["metrics"]["fees"] == fee
    assert rows[0]["metrics"]["gross_pnl"] == pytest.approx(q * (150 - 100))
    assert rows[0]["metrics"]["net_pnl"] == pytest.approx(sum(expected))
    assert rows[0]["metrics"]["contribution_pp"] == pytest.approx(sum(expected) / 100000 * 100)
    assert rows[0]["metrics"]["contribution_pp"] != pytest.approx((150 / 100 - 1) * 100)
    assert rows[0]["coverage"]["required_price_values"] == rows[0]["coverage"]["available_price_values"] == 6
    for row in rows[1:]:
        assert row["metrics"]["net_pnl"] == row["metrics"]["fees"] == row["metrics"]["contribution_pp"] == 0
        assert row["coverage"]["known_inactive_sessions"] == 3 and row["coverage"]["required_price_values"] == 0
    assert aggregate["symbol_pnl"] == pytest.approx(baseline["metrics"]["final_value"] - 100000)
    for day in daily:
        check = day["reconciliation"]
        assert all(abs(check[key]) <= check["tolerance"] for key in ("pnl_residual", "cash_residual", "nav_residual"))
    assert aggregate["cash_interest_pnl"] == 0
    json.dumps([rows, daily, aggregate], allow_nan=False)


def test_rotation_full_sale_uses_prior_close_and_open_but_never_post_exit_prices():
    baseline, days, raw = analytical([(1, [{"symbol": "SYNA", "weight_pct": 50}]), (2, [{"symbol": "SYNB", "weight_pct": 60}])])
    sale = next(trade for trade in baseline["events"][1]["trades"] if trade["symbol"] == "SYNA")
    raw["SYNA"][2].pop("close")  # full-sale day current close algebraically cancels
    raw["SYNA"].pop()  # no position or trade on day three
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert reasons == [] and aggregate is not None
    exited = daily[1]["contributions"][0]
    assert exited["previous_raw_close"] == 110 and exited["raw_open"] == 120
    assert exited["current_raw_close"] is None and exited["ending_shares"] == 0
    assert exited["net_pnl"] == pytest.approx(sale["shares"] * (120 - 110) - sale["fee"])
    assert exited["coverage"] == {"required_price_values": 2, "available_price_values": 2}
    after = daily[2]["contributions"][0]
    assert after["known_inactive"] and after["net_pnl"] == 0 and after["coverage"]["required_price_values"] == 0
    assert rows[0]["metrics"]["ending_shares"] == 0 and rows[1]["metrics"]["ending_shares"] > 0


def test_partial_sale_then_increase_matches_overnight_and_intraday_cashflow_oracle():
    baseline, days, raw = analytical([(1, [{"symbol": "SYNA", "weight_pct": 50}]),
        (2, [{"symbol": "SYNA", "weight_pct": 25}]), (3, [{"symbol": "SYNA", "weight_pct": 70}])])
    trades = [event["trades"][0] for event in baseline["events"]]
    assert [trade["side"] for trade in trades] == ["buy", "sell", "buy"]
    bought, sold, added = [trade["shares"] for trade in trades]
    fees = [trade["fee"] for trade in trades]
    expected = [bought * 10 - fees[0], bought * 20 - sold * 10 - fees[1],
        (bought - sold) * 20 + added * 10 - fees[2]]
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert reasons == [] and aggregate is not None
    assert [day["contributions"][0]["net_pnl"] for day in daily] == pytest.approx(expected)
    assert [day["contributions"][0]["share_change"] for day in daily] == pytest.approx([bought, -sold, added])
    assert rows[0]["metrics"]["ending_shares"] == pytest.approx(bought - sold + added)
    assert rows[0]["metrics"]["fees"] == pytest.approx(sum(fees))
    assert rows[0]["metrics"]["net_pnl"] == pytest.approx(sum(expected))
    assert aggregate["return_tolerance_pp"] == aggregate["tolerance"] / 100000 * 100


def test_incomplete_calendar_keeps_all_candidates_and_no_fabricated_daily_rows():
    baseline, days, raw = analytical()
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days[:-1], raw)
    assert [row["symbol"] for row in rows] == baseline["candidate_symbols"]
    assert all(row["metrics"] is None and row["coverage"]["evaluated_sessions"] == 0 for row in rows)
    assert daily == [] and aggregate is None and reasons == [{"code": "attribution_support_incomplete"}]


def test_cash_only_path_has_known_zero_without_any_price_lookups():
    baseline, days, _ = analytical([])
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, {})
    assert reasons == [] and aggregate["symbol_pnl"] == aggregate["contribution_pp"] == 0
    assert all(row["metrics"]["net_pnl"] == 0 and row["coverage"]["required_price_values"] == 0 for row in rows)
    assert all(item["known_inactive"] and item["status"] == "evaluated" for day in daily for item in day["contributions"])


def test_missing_required_prior_close_latches_symbol_and_aggregate_unavailable_without_resuming():
    baseline, days, raw = analytical([(1, [{"symbol": "SYNA", "weight_pct": 50}]), (2, [{"symbol": "SYNB", "weight_pct": 60}])])
    raw["SYNA"][1].pop("close")
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert aggregate is None and reasons
    assert rows[0]["metrics"] is None and rows[0]["reasons"][0]["code"] == "required_price_unavailable"
    assert rows[0]["coverage"]["available_price_values"] < rows[0]["coverage"]["required_price_values"]
    assert rows[1]["metrics"] is not None and rows[2]["metrics"]["net_pnl"] == 0
    assert all(day["status"] == "unavailable" for day in daily)
    assert all(day["contributions"][0]["net_pnl"] is None and day["contributions"][0]["cumulative_pnl"] is None for day in daily)
    assert daily[-1]["contributions"][0]["known_inactive"]  # known quantities do not repair missing cumulative PnL


def test_cash_reconciliation_failure_is_visible_and_aggregate_never_resumes():
    baseline, days, raw = analytical()
    baseline["curve"][1]["cash"] += 1
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert aggregate is None and daily[0]["status"] == "evaluated"
    assert daily[1]["status"] == daily[2]["status"] == "unavailable"
    assert daily[1]["reconciliation"]["cash_residual"] == pytest.approx(-1)
    assert daily[2]["reconciliation"] is None
    assert all(row["status"] == "evaluated" for row in rows)  # explicitly partial symbol evidence only
    assert reasons[0]["code"] == "daily_accounting_mismatch"


def test_only_explicit_full_exit_can_remove_and_report_quantity_roundoff():
    baseline, days, raw = analytical([(1, [{"symbol": "SYNA", "weight_pct": 50}]), (2, [{"symbol": "SYNB", "weight_pct": 60}])])
    sale = next(trade for trade in baseline["events"][1]["trades"] if trade["symbol"] == "SYNA")
    sale["shares"] -= 1e-12
    sale["notional"] = sale["shares"] * sale["raw_open"]
    rows, daily, aggregate, reasons = attribution.attribute(baseline, days, raw)
    assert reasons == [] and aggregate is not None
    assert 0 < daily[1]["contributions"][0]["quantity_roundoff"] < 2e-12
    assert rows[0]["metrics"]["ending_shares"] == 0 and rows[0]["metrics"]["quantity_roundoff"] != 0


def test_tiny_retained_target_is_not_clamped_and_still_requires_its_next_close():
    baseline, days, raw = analytical([(1, [{"symbol": "SYNA", "weight_pct": 50}]), (2, [{"symbol": "SYNA", "weight_pct": 1e-12}])])
    raw["SYNA"][3].pop("close")
    rows, daily, aggregate, _ = attribution.attribute(baseline, days, raw)
    assert daily[1]["contributions"][0]["ending_shares"] > 0
    assert daily[1]["contributions"][0]["quantity_roundoff"] == 0
    assert aggregate is None and rows[0]["metrics"] is None
    assert rows[0]["reasons"][0]["code"] == "required_price_unavailable"


def test_nonfinite_derived_quantity_never_escapes_as_json_infinity():
    baseline, days, raw = analytical()
    trade = baseline["events"][0]["trades"][0]
    trade.update(shares=1e308, notional=1e308, raw_open=1.)
    raw["SYNA"][1]["open"] = 1.
    rows, daily, aggregate, _ = attribution.attribute(baseline, days, raw)
    assert aggregate is None and rows[0]["metrics"] is None
    json.dumps([rows, daily], allow_nan=False)


def test_one_original_path_exact_history_reread_and_readonly_api(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    before, real_evaluate, real_load = state(), path.evaluate, path._load_history
    paths, histories = [], []
    def evaluate_once(*args):
        value = real_evaluate(*args)
        value["future_field"] = {"zero": 0., "nullable": None}
        paths.append(copy.deepcopy(value))
        return value
    def load(db, symbols, as_of, result):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM bars")
        value = real_load(db, symbols, as_of, result)
        histories.append((symbols, result["history_fingerprint"]))
        return value
    monkeypatch.setattr(path, "evaluate", evaluate_once)
    monkeypatch.setattr(path, "_load_history", load)
    response = client.post(url(run), json=body(run))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["status"] == "evaluated", value["reasons"]
    assert len(paths) == 1 and len(histories) == 2 and histories[0] == histories[1]
    assert value["baseline"] == paths[0]
    assert value["reread_history_fingerprint"] == value["history_fingerprint"]
    assert value["coverage"]["available_daily_reconciliations"] == 252 and value["coverage"]["available_symbols"] == 3
    assert value["evidence_fingerprint"] == attribution._hash({key: item for key, item in value.items() if key != "evidence_fingerprint"})
    assert response.headers["cache-control"] == "no-store" and state() == before
    assert not ({"verdict", "pass", "ranking", "alpha", "benchmark"} & set(value))
    json.dumps(value, allow_nan=False)


def test_held_adjustment_gap_propagates_original_unavailable_without_history_reread(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    original = path.evaluate
    captured = []
    def unavailable(*args):
        value = original(*args)
        value.update(status="unavailable", metrics=None, curve=[], events=[], reasons=[{"code": "held_corporate_action_unmodeled", "symbol": "SYNTA", "date": days[-1]}])
        captured.append(copy.deepcopy(value))
        return value
    monkeypatch.setattr(path, "evaluate", unavailable)
    result = client.post(url(run), json=body(run)).json()
    assert result["baseline"] == captured[0] and result["aggregate"] is None
    assert result["status"] == "unavailable" and result["daily"] == [] and result["reread_history_fingerprint"] is None
    assert all(row["metrics"] is None for row in result["symbols"])
    assert result["coverage"]["available_daily_reconciliations"] == 0
    assert result["reasons"][0]["details"][0]["code"] == "held_corporate_action_unmodeled"


def test_changed_history_fingerprint_rejects_instead_of_attributing_different_bars(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    original, calls = path._load_history, []
    def changed(*args):
        value = original(*args)
        calls.append(True)
        if len(calls) == 2: args[-1]["history_fingerprint"] = "f" * 64
        return value
    monkeypatch.setattr(path, "_load_history", changed)
    result = client.post(url(run), json=body(run))
    assert result.status_code == 409 and result.json()["detail"]["code"] == "path_attribution_history_changed"


@pytest.mark.parametrize("change", [{"expected_proposal_fingerprint": "f" * 64}, {"expected_input_revision": "other"}, {"expected_as_of": "2024-01-01"}])
def test_stale_identity_refuses_before_computation(attributionspace, monkeypatch, change):
    client, days, _ = attributionspace
    run = saved(client, days)
    monkeypatch.setattr(path, "_compute", lambda *a: pytest.fail("Stale source computed"))
    assert client.post(url(run), json=body(run, **change)).status_code == 409


@pytest.mark.parametrize("change", [{"extra": float("nan")}, {"expected_input_revision": ""}, {"expected_as_of": "2026-02-30"}, {"fee_bps": 0}])
def test_strict_body_and_finite_validation_errors(attributionspace, monkeypatch, change):
    client, days, _ = attributionspace
    run = saved(client, days)
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("Invalid source computed"))
    response = client.post(url(run), content=json.dumps(body(run, **change)), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    json.dumps(response.json(), allow_nan=False)


def test_concurrent_writer_cannot_change_reread_history_inside_snapshot(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    expected = client.post(url(run), json=body(run)).json()
    original, calls = path._load_history, []
    def write_before_second_read(*args):
        calls.append(True)
        if len(calls) == 2:
            def write():
                with store.connect() as db: db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
            with ThreadPoolExecutor(max_workers=1) as pool: pool.submit(write).result(timeout=5)
        return original(*args)
    monkeypatch.setattr(path, "_load_history", write_before_second_read)
    value = client.post(url(run), json=body(run)).json()
    assert value == expected and value["input_revision"] != store.input_revision()


def test_session_change_and_payload_bound_are_explicit_refusals(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    original = attribution.attribute
    def moved(*args):
        value = original(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2099-01-01")
        return value
    with monkeypatch.context() as scope:
        scope.setattr(attribution, "MAX_RESPONSE_BYTES", 1)
        result = client.post(url(run), json=body(run))
        assert result.status_code == 422 and result.json()["detail"]["code"] == "path_attribution_size_limit"
    monkeypatch.setattr(attribution, "attribute", moved)
    result = client.post(url(run), json=body(run))
    assert result.status_code == 409 and result.json()["detail"]["code"] == "path_attribution_session_changed"


def test_nonfinite_original_evidence_is_rejected_without_json_infinity(attributionspace, monkeypatch):
    client, days, _ = attributionspace
    run = saved(client, days)
    original = path.evaluate
    def invalid(*args):
        value = original(*args)
        value["future_field"] = float("inf")
        return value
    before = state()
    monkeypatch.setattr(path, "evaluate", invalid)
    response = client.post(url(run), json=body(run))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "path_attribution_nonfinite_source"
    json.dumps(response.json(), allow_nan=False)
    assert state() == before
