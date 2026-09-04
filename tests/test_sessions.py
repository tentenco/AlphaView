import pytest
pytest.importorskip('exchange_calendars')
from alphaview.panel.sessions import latest_completed_session, expected_sessions


def test_weekend_and_labor_day_do_not_make_friday_stale():
    assert latest_completed_session('2026-09-05T08:00:00Z') == '2026-09-04'
    assert latest_completed_session('2026-09-07T22:00:00Z') == '2026-09-04'
    assert expected_sessions('2026-09-04', '2026-09-08') == ['2026-09-04', '2026-09-08']


def test_regular_and_early_close_wait_for_provider_settlement_buffer():
    assert latest_completed_session('2026-09-08T20:14:59Z') == '2026-09-04'
    assert latest_completed_session('2026-09-08T20:15:00Z') == '2026-09-08'
    assert latest_completed_session('2026-11-27T18:14:59Z') == '2026-11-25'
    assert latest_completed_session('2026-11-27T18:15:00Z') == '2026-11-27'


def test_dst_and_clock_must_be_timezone_aware():
    assert latest_completed_session('2026-03-06T21:15:00Z') == '2026-03-06'
    assert latest_completed_session('2026-03-09T20:15:00Z') == '2026-03-09'
    with pytest.raises(ValueError, match='timezone'):
        latest_completed_session('2026-09-08 16:30')
