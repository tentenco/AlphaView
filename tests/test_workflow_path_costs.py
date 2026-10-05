"""Cost sensitivity on one frozen local path; analytical cash flows and synthetic source data."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import math

import pytest

from alphaview.panel import research, sessions, store, workflow_path_costs as costs
from alphaview.panel import workflow_path_validation as path
from tests.test_workflow_path_validation import body, saved, workspace  # noqa: F401


@pytest.fixture
def costspace(workspace):
    client, days, monkeypatch = workspace
    client.app.include_router(costs.router)
    return client, days, monkeypatch


def url(run):
    return f"/api/portfolio-agent/runs/{run['id']}/path-costs"


def assert_cash_flows(old_shares, old_cash, new_shares, new_cash, trades, opens):
    cash = old_cash
    ledger = dict(old_shares)
    for trade in trades:
        sign = 1 if trade["side"] == "buy" else -1
        cash -= sign * trade["execution_notional"] + trade["fee"]
        ledger[trade["symbol"]] = ledger.get(trade["symbol"], 0) + sign * trade["shares"]
        assert trade["execution_notional"] == pytest.approx(trade["shares"] * trade["fill_price"])
        assert trade["slippage_cost"] == pytest.approx(
            sign * (trade["execution_notional"] - trade["raw_notional"]))
    assert cash == pytest.approx(new_cash, abs=1e-9)
    for symbol in set(ledger) | set(new_shares):
        assert ledger.get(symbol, 0) == pytest.approx(new_shares.get(symbol, 0), abs=1e-9)
    before = old_cash + sum(amount * opens[symbol] for symbol, amount in old_shares.items())
    after = new_cash + sum(amount * opens[symbol] for symbol, amount in new_shares.items())
    assert before - after == pytest.approx(sum(row["fee"] + row["slippage_cost"] for row in trades))


@pytest.mark.parametrize("weight", [40, 100])
def test_buy_adverse_fill_fee_on_executed_notional_and_postcost_targets(weight):
    fee, slip, equity = .001, .01, 1000
    shares, cash, trades, fees, slippage = costs._rebalance(
        {}, equity, [{"symbol": "SYNA", "weight_pct": weight}], {"SYNA": 100}, fee, slip)
    nav = equity / (1 + weight / 100 * (slip + (1 + slip) * fee))
    assert shares["SYNA"] == pytest.approx(nav * weight / 100 / 100)
    assert cash == pytest.approx(nav * (1 - weight / 100), abs=1e-9)
    assert trades[0]["fill_price"] == 101
    assert fees == pytest.approx(shares["SYNA"] * 101 * fee)
    assert slippage == pytest.approx(shares["SYNA"])
    assert_cash_flows({}, equity, shares, cash, trades, {"SYNA": 100})


@pytest.mark.parametrize("weight", [0, 40])
def test_sell_adverse_fill_and_sell_fee_keep_proceeds_and_cash_consistent(weight):
    fee, slip = .001, .01
    targets = [{"symbol": "SYNA", "weight_pct": weight}] if weight else []
    shares, cash, trades, fees, slippage = costs._rebalance(
        {"SYNA": 10}, 0, targets, {"SYNA": 100}, fee, slip)
    coefficient = slip + (1 - slip) * fee
    nav = 1000 * (1 - coefficient) / (1 - weight / 100 * coefficient)
    assert shares.get("SYNA", 0) == pytest.approx(nav * weight / 100 / 100)
    assert cash == pytest.approx(nav * (1 - weight / 100))
    assert trades[0]["side"] == "sell" and trades[0]["fill_price"] == 99
    assert fees == pytest.approx(trades[0]["shares"] * 99 * fee)
    assert slippage == pytest.approx(trades[0]["shares"])
    assert_cash_flows({"SYNA": 10}, 0, shares, cash, trades, {"SYNA": 100})


def test_rotating_two_symbols_charges_both_sides_with_no_target_reweight():
    fee, slip = .0025, .005
    shares, cash, trades, _, _ = costs._rebalance(
        {"SYNA": 10}, 0, [{"symbol": "SYNB", "weight_pct": 60}], {"SYNA": 100, "SYNB": 200}, fee, slip)
    buy_cost, sell_cost = slip + (1 + slip) * fee, slip + (1 - slip) * fee
    nav = (1000 - 1000 * sell_cost) / (1 + .6 * buy_cost)
    assert shares == {"SYNB": pytest.approx(nav * .6 / 200)}
    assert cash == pytest.approx(nav * .4)
    assert [trade["side"] for trade in trades] == ["sell", "buy"]
    assert_cash_flows({"SYNA": 10}, 0, shares, cash, trades, {"SYNA": 100, "SYNB": 200})


def test_zero_cost_and_no_candidates_keep_cash_and_holdings_without_liquidation():
    calendar = ["2026-01-02", "2026-01-05", "2026-01-06"]
    decisions = [{"signal_date": calendar[0], "trade_date": calendar[1], "status": "rebalance",
                  "targets": [{"symbol": "SYNA", "weight_pct": 40}]},
                 {"signal_date": calendar[1], "trade_date": calendar[2], "status": "hold_no_candidates", "targets": []}]
    raw = {"SYNA": [{"date": day, "open": 100, "close": close} for day, close in zip(calendar, [100, 100, 110])]}
    value = costs._simulate(calendar, decisions, raw, 0, 0)
    assert value["metrics"]["final_value"] == 104000
    assert value["metrics"]["return_pct"] == pytest.approx(4)
    assert value["costs"]["fees"] == value["costs"]["slippage"] == 0
    assert value["curve"][-1]["cash"] == 60000
    assert len(value["events"]) == 1 and value["final_holdings"][0]["shares"] == 400


def test_grid_reuses_one_prefix_decision_set_and_exact_baseline_readonly(costspace, monkeypatch):
    client, days, _ = costspace
    run = saved(client, days)
    baseline = client.post(f"/api/portfolio-agent/runs/{run['id']}/path-validation", json=body(run)).json()
    original_path, original_research = path.evaluate, research.evaluate
    calls, signal_days = [], []
    def evaluate(*args):
        calls.append(args[0])
        return original_path(*args)
    def signals(frames, day):
        assert all(frame.date.max() == day for frame in frames.values())
        signal_days.append(day)
        return original_research(frames, day)
    monkeypatch.setattr(path, "evaluate", evaluate)
    monkeypatch.setattr(research, "evaluate", signals)
    revision = store.input_revision()
    response = client.post(url(run), json=body(run))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    value = response.json()
    assert value["status"] == "evaluated" and value["mode"] == "advisory_only"
    assert value["coverage"] == {"required_scenarios": 9, "available_scenarios": 9, "unavailable_scenarios": 0,
                                 "decision_sets_computed": 1}
    assert calls == [run["id"]] and signal_days == days[-253:-1:21]
    assert value["baseline"] == baseline
    assert value["baseline_evidence_fingerprint"] == baseline["evidence_fingerprint"]
    assert value["decision_fingerprint"] == costs._hash(baseline["decisions"])
    assert value["history_fingerprint"] == baseline["history_fingerprint"]
    base_case = next(row for row in value["scenarios"] if row["is_baseline"])
    assert base_case["metrics"] == baseline["metrics"] and base_case["curve"] == baseline["curve"]
    assert base_case["final_holdings"] == baseline["final_holdings"]
    assert base_case["differences"] == {"final_value": 0, "return_pp": 0, "max_drawdown_pp": 0, "explicit_cost": 0}
    assert value["evidence_fingerprint"] == costs._hash({key: item for key, item in value.items() if key != "evidence_fingerprint"})
    assert "best" not in value and "verdict" not in value
    json.dumps(value, allow_nan=False)
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM portfolio_agent_runs").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM paper_proposals").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM research_desk_runs").fetchone()[0] == 0


@pytest.mark.parametrize("changes", [{"fee_bps": []}, {"slippage_bps": [0, 1, 2, 3]},
    {"fee_bps": [0, 0]}, {"slippage_bps": [1, 1.0]}, {"fee_bps": [-.1]}, {"slippage_bps": [100.01]},
    {"fee_bps": [True]}, {"slippage_bps": ["5"]}, {"unexpected_field": 1}])
def test_invalid_grid_rejected_before_path_computation(costspace, monkeypatch, changes):
    client, days, _ = costspace
    run = saved(client, days)
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Invalid input must not compute"))
    response = client.post(url(run), json=body(run, **changes))
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("nonfinite", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_json_rejected_with_jsonsafe_validation_error(costspace, monkeypatch, nonfinite):
    client, days, _ = costspace
    run = saved(client, days)
    monkeypatch.setattr(path, "evaluate", lambda *args: pytest.fail("Invalid input must not compute"))
    response = client.post(url(run), content=json.dumps(body(run, fee_bps=[nonfinite])), headers={"Content-Type": "application/json"})
    assert response.status_code == 422, response.text
    json.dumps(response.json(), allow_nan=False)


@pytest.mark.parametrize("gap", ["missing_history", "held_factor"])
def test_baseline_evidence_gap_disables_every_scenario(costspace, monkeypatch, gap):
    client, days, _ = costspace
    with store.connect() as db:
        if gap == "missing_history":
            db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (days[-300],))
        else:
            db.execute("UPDATE bars SET adj_close=close*1.1 WHERE date>=?", (days[-100],))
    run = saved(client, days)
    monkeypatch.setattr(costs, "_simulate", lambda *args: pytest.fail("Unavailable baseline must not simulate"))
    value = client.post(url(run), json=body(run)).json()
    assert value["status"] == value["baseline"]["status"] == "unavailable"
    assert value["coverage"]["available_scenarios"] == 0
    for scenario in value["scenarios"]:
        assert scenario["metrics"] is scenario["costs"] is scenario["differences"] is None
        assert not scenario["curve"] and not scenario["events"]
        assert scenario["reasons"] == [{"code": "baseline_unavailable", "details": value["baseline"]["reasons"]}]


def test_one_numeric_failure_has_no_partial_metrics_and_does_not_disable_baseline(costspace, monkeypatch):
    client, days, _ = costspace
    run = saved(client, days)
    real = costs._simulate
    def simulate(*args):
        value = real(*args)
        value["metrics"]["final_value"] = math.inf
        return value
    monkeypatch.setattr(costs, "_simulate", simulate)
    response = client.post(url(run), json=body(run, fee_bps=[0, 10], slippage_bps=[0]))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["status"] == "incomplete" and value["coverage"]["available_scenarios"] == 1
    failed, baseline = value["scenarios"]
    assert failed["status"] == "unavailable" and failed["metrics"] is None and not failed["curve"]
    assert failed["reasons"] == [{"code": "nonfinite_accounting"}]
    assert baseline["status"] == "evaluated"
    json.dumps(value, allow_nan=False)


def test_writer_between_baseline_and_cost_history_cannot_mix_snapshots(costspace, monkeypatch):
    client, days, _ = costspace
    run = saved(client, days)
    expected = client.post(url(run), json=body(run, fee_bps=[10, 25], slippage_bps=[0, 5])).json()
    original = path.evaluate
    def evaluate(*args):
        baseline = original(*args)
        def write():
            with store.connect() as db:
                db.execute("UPDATE bars SET open=open*1.001,high=high*1.001 WHERE symbol='SYNTA'")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(write).result(timeout=5)
        return baseline
    monkeypatch.setattr(path, "evaluate", evaluate)
    response = client.post(url(run), json=body(run, fee_bps=[10, 25], slippage_bps=[0, 5]))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value == expected
    assert value["input_revision"] != store.input_revision()
    assert client.get(f"/api/portfolio-agent/runs/{run['id']}").json()["current"] is False


def test_source_conflict_and_session_rollover_fail_without_results(costspace, monkeypatch):
    client, days, _ = costspace
    run = saved(client, days)
    assert client.post(url(run), json=body(run, expected_input_revision="changed")).status_code == 409
    original = costs._case
    def case(*args):
        value = original(*args)
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2026-10-01")
        return value
    monkeypatch.setattr(costs, "_case", case)
    assert client.post(url(run), json=body(run)).status_code == 409


def test_history_mismatch_is_rejected_and_input_grid_changes_evidence(costspace, monkeypatch):
    client, days, _ = costspace
    run = saved(client, days)
    first = client.post(url(run), json=body(run, fee_bps=[0], slippage_bps=[0])).json()
    second = client.post(url(run), json=body(run, fee_bps=[0], slippage_bps=[5])).json()
    assert first["baseline_evidence_fingerprint"] == second["baseline_evidence_fingerprint"]
    assert first["decision_fingerprint"] == second["decision_fingerprint"]
    assert first["scenario_fingerprint"] != second["scenario_fingerprint"]
    assert first["evidence_fingerprint"] != second["evidence_fingerprint"]
    baseline = copy.deepcopy(first["baseline"])
    baseline["history_fingerprint"] = "f" * 64
    monkeypatch.setattr(path, "evaluate", lambda *args: baseline)
    assert client.post(url(run), json=body(run)).status_code == 409
