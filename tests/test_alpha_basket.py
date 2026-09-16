import pytest

from alphaview.panel.alpha_basket import MissingPrice, rebalance_at_open, simulate


def test_next_open_excludes_the_signal_to_execution_gap():
    result = simulate(["d0", "d1", "d2"], {"d0": ["AAA"]},
                      {"AAA": {"d1": {"open": 125, "close": 125}, "d2": {"open": 125, "close": 150}}},
                      initial=1000, fee_bps=0, interval=5)
    assert result["curve"][0]["value"] == pytest.approx(1000)
    assert result["final"] == pytest.approx(1200)
    assert result["events"][0]["signal_date"] == "d0"
    assert result["events"][0]["trade_date"] == "d1"


def test_net_rebalancing_does_not_sell_and_rebuy_unchanged_equal_positions():
    units, cash, orders, costs = rebalance_at_open({"A": 5, "B": 5}, 0, ["A", "B"], {"A": 100, "B": 100}, .001)
    assert units == pytest.approx({"A": 5, "B": 5})
    assert cash == pytest.approx(0) and costs == pytest.approx(0) and orders == []


def test_costs_are_reserved_and_cash_conserved_during_rotation():
    units, cash, orders, costs = rebalance_at_open({"A": 10}, 0, ["B"], {"A": 100, "B": 50}, .01)
    expected_invested = 1000 * .99 / 1.01
    assert units["B"] * 50 == pytest.approx(expected_invested)
    assert cash + units["B"] * 50 + costs == pytest.approx(1000)
    assert costs == pytest.approx(sum(order["cost"] for order in orders))
    assert {order["side"] for order in orders} == {"buy", "sell"}


def test_no_picks_exits_to_cash_and_keeps_initial_basket_baseline():
    result = simulate(["d0", "d1", "d2"], {"d0": ["A"], "d1": []},
                      {"A": {"d1": {"open": 100, "close": 100}, "d2": {"open": 120, "close": 150}}},
                      initial=1000, fee_bps=0, interval=1)
    assert result["final_cash"] == pytest.approx(1200)
    assert result["final_holdings"] == []
    assert result["return_pct"] == pytest.approx(20)
    assert result["benchmark_pct"] == pytest.approx(50)


def test_missing_execution_or_marking_price_blocks_instead_of_substituting():
    with pytest.raises(MissingPrice):
        simulate(["d0", "d1", "d2"], {"d0": ["A"]},
                 {"A": {"d1": {"open": 100, "close": 100}}},
                 initial=1000, fee_bps=0, interval=5)
    with pytest.raises(MissingPrice):
        simulate(["d0", "d1"], {}, {}, initial=1000, fee_bps=0, interval=1)


def test_lost_baseline_data_does_not_fabricate_its_curve():
    result = simulate(["d0", "d1", "d2", "d3"], {"d0": ["A"], "d1": [], "d2": []},
                      {"A": {"d1": {"open": 100, "close": 100}, "d2": {"open": 100, "close": 100}}},
                      initial=1000, fee_bps=0, interval=1)
    assert result["final"] == pytest.approx(1000)
    assert result["benchmark_pct"] is None and result["benchmark_error"]
    assert all(point["benchmark"] is None for point in result["curve"])
