"""Analytical signal fixtures: hand-accounted windows, Wilder smoothing and peer ranks."""
import numpy as np
import pandas as pd
import pytest

from alphaview.panel import research, sessions


def bars(closes, *, high=None, volume=None):
    close = np.asarray(closes, dtype=float)
    dates = sessions.expected_sessions('2024-01-02', '2025-12-31')[:len(close)]
    return pd.DataFrame(dict(date=dates, open=close * .999, high=close if high is None else high,
                             low=close * .998, close=close, adj_close=close,
                             volume=np.full(len(close), 100.) if volume is None else volume))


def test_wilder_seed_and_recursive_step_are_hand_calculated():
    # Seven +2 and seven -1 changes: seed gains=1, losses=.5, RSI=66 2/3.
    close = [100.]
    for change in [2., -1.] * 7 + [-3.]:
        close.append(close[-1] + change)
    result = research.indicators(bars(close))
    assert result.rsi.iloc[:14].isna().all()
    assert result.rsi.iloc[14] == pytest.approx(100 * 1 / 1.5)
    # Next gain=13/14, loss=(6.5+3)/14, RSI=100*13/22.5.
    assert result.rsi.iloc[15] == pytest.approx(100 * 13 / 22.5)


@pytest.mark.parametrize('close,expected', [(np.arange(100., 121.), 100),
                                           (np.arange(121., 100., -1), 0),
                                           (np.full(21, 100.), 50)])
def test_rsi_monotonic_and_flat_boundaries(close, expected):
    result = research.indicators(bars(close))
    assert result.rsi.iloc[14:].tolist() == pytest.approx([expected] * 7)


def test_breakout_excludes_today_but_retains_exact_prior_20_sessions():
    close = [100.] * 20 + [101., 102.]
    high = [110.] + [100.] * 19 + [101., 102.]
    result = research.indicators(bars(close, high=high, volume=[100.] * 20 + [200., 110.]))
    assert result.high20.iloc[20] == 110 and not result.turtle.iloc[20]
    assert result.high20.iloc[21] == 101 and result.turtle.iloc[21]
    assert result.volume_ratio.iloc[20] == 2
    assert result.volume_ratio.iloc[21] == pytest.approx(110 / 105)


def test_return_and_high_have_distinct_endpoint_windows():
    close = [50.] + [100.] * 119 + [125.]
    high = [1000.] + [100.] * 119 + [125.]
    result = research.indicators(bars(close, high=high))
    assert pd.isna(result.return120.iloc[119])
    assert result.return120.iloc[120] == 1.5
    assert result.high120.iloc[120] == 125  # initial session is outside current 120 highs


def test_rps_ties_use_average_rank_and_only_current_eligible_peers():
    frames = {name: research.indicators(bars([100.] * 120 + [last]))
              for name, last in {'A':110., 'B':120., 'C':120., 'D':130.}.items()}
    as_of = frames['A'].date.iloc[-1]
    frames['STALE'] = research.indicators(bars([100.] * 119 + [1000.]))
    frames['SHORT'] = research.indicators(bars([100.] * 120).assign(date=frames['A'].date.iloc[1:].to_list()))
    bad = bars([100.] * 120 + [10000.])
    bad.loc[120, 'low'] = 20000.
    frames['BAD'] = research.indicators(bad)
    rows = {row['symbol']: row for row in research.evaluate(frames, as_of)}
    assert {name: rows[name]['indicators']['rps'] for name in 'ABCD'} == {'A':25., 'B':62.5, 'C':62.5, 'D':100.}
    assert all(signal['status'] == 'stale' and not signal['matched'] for signal in rows['STALE']['signals'])
    assert rows['SHORT']['signals'][-1]['status'] == 'insufficient'
    assert all(signal['status'] == 'data_error' and not signal['matched'] for signal in rows['BAD']['signals'])
    assert rows['D']['signals'][-1]['matched']


def test_future_prices_cannot_change_historical_indicators_or_signals():
    close = np.linspace(100, 150, 205)
    prefix = bars(close)
    full = bars(np.concatenate([close, [10000., 1., 90000.]]))
    as_of = prefix.date.iloc[-1]
    for source in [full, full.assign(high=lambda frame: frame.high.where(frame.index != 207, 0))]:
        actual = research.evaluate({'TEST': research.indicators(source)}, as_of)
        expected = research.evaluate({'TEST': research.indicators(prefix)}, as_of)
        assert actual == expected


def test_overflowing_return_is_not_a_peer_or_a_relative_strength_signal():
    frames = {name: research.indicators(bars([100.] * 120 + [last]))
              for name, last in {'A':110., 'B':120.}.items()}
    frames['OVERFLOW'] = research.indicators(bars([1e-200] * 120 + [1e200]))
    as_of = frames['A'].date.iloc[-1]
    rows = {row['symbol']: row for row in research.evaluate(frames, as_of)}
    assert rows['OVERFLOW']['indicators']['return120'] is None
    assert rows['OVERFLOW']['indicators']['rps'] is None
    assert all(row['signals'][-1]['status'] == 'insufficient' for row in rows.values())
    # Even when three other peers are eligible, this symbol must remain excluded.
    frames['C'] = research.indicators(bars([100.] * 120 + [130.]))
    row = research.evaluate(frames, as_of)[2]
    assert row['signals'][-1]['status'] == 'insufficient'
    assert not row['signals'][-1]['matched']


def test_overflowing_volume_ratio_cannot_confirm_price_signals():
    frame = bars(np.arange(100., 305.), volume=[1e-200] * 204 + [1e200])
    result = research.indicators(frame)
    assert not result.turtle.iloc[-1]
    assert not result.trend.iloc[-1]
    row = research.evaluate({'TEST': result}, frame.date.iloc[-1])[0]
    assert row['indicators']['volume_ratio'] is None
    assert all(signal['status'] == 'insufficient' and not signal['matched']
               for signal in row['signals'][:2])
