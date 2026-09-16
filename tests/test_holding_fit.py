import math

import pytest

from alphaview.panel import holding_fit, sessions, store


def test_correlation_requires_shared_returns_and_handles_constant_series():
    left = {f'day-{i:03}': (i % 7) / 100 for i in range(50)}
    assert holding_fit.correlate(left, left)['correlation'] == pytest.approx(1)
    assert holding_fit.correlate(left, {day: -value for day, value in left.items()})['correlation'] == pytest.approx(-1)
    assert holding_fit.correlate(left, dict(list(left.items())[:39]))['reason'] == 'insufficient_shared_returns'
    assert holding_fit.correlate(left, {day: 0 for day in left})['reason'] == 'constant_returns'


def test_fit_uses_current_quotes_and_never_bridges_a_missing_session(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'fit.db'))
    store.init_db()
    days = sessions.expected_sessions('2026-01-01', '2026-06-30')[-61:]
    monkeypatch.setattr(sessions, 'latest_completed_session', lambda: days[-1])
    with store.connect() as db:
        for symbol, shares in [('AAA', 10), ('BBB', 0), ('GAP', 10)]:
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES (?,?,?,'test','test')", (symbol, symbol, shares))
            for index, day in enumerate(days):
                if symbol == 'GAP' and index == 20:
                    continue
                close = 100 + index + 3 * math.sin(index)
                db.execute('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)', (symbol, day, close, close + 1, close - 1, close, close, 1000))
    revision = store.input_revision()
    result = holding_fit.holding_fit(holding_fit.FitInput(symbols=['BBB', 'AAA']))
    candidate = result['candidates'][0]
    assert result['valuation_complete']
    assert candidate['pairs'][0]['observations'] == 60
    assert candidate['pairs'][1]['observations'] == 58  # Missing close removes both adjacent returns.
    assert all(pair['correlation'] == pytest.approx(1) for pair in candidate['pairs'])
    assert len(result['candidates'][1]['pairs']) == 1  # No self-correlation.
    assert store.input_revision() == revision
    with store.connect() as db:
        db.execute('DELETE FROM bars WHERE symbol=? AND date=?', ('GAP', days[-1]))
    result = holding_fit.holding_fit(holding_fit.FitInput(symbols=['BBB']))
    assert not result['valuation_complete']
    assert all(pair['weight_pct'] is None for pair in result['candidates'][0]['pairs'])
    assert result['candidates'][0]['pairs'][0]['correlation'] == pytest.approx(1)
    assert result['candidates'][0]['pairs'][1]['reason'] == 'current_quote_unavailable'
