"""US equity session boundaries, including holidays, DST and early closes."""
from functools import lru_cache

import exchange_calendars as xcals
import pandas as pd


@lru_cache(maxsize=8)
def calendar(year):
    return xcals.get_calendar("XNYS", start=f"{year - 6}-01-01", end=f"{year + 2}-12-31")


def latest_completed_session(at=None):
    """Most recent NYSE session closed at least 15 minutes ago (UTC input)."""
    instant = pd.Timestamp(at) if at is not None else pd.Timestamp.now(tz="UTC")
    if instant.tzinfo is None:
        raise ValueError("Session clock must include a timezone")
    cal = calendar(instant.year)
    eastern_date = instant.tz_convert("America/New_York").date().isoformat()
    session = cal.date_to_session(eastern_date, direction="previous")
    if instant < cal.session_close(session) + pd.Timedelta(minutes=15):
        session = cal.previous_session(session)
    return session.date().isoformat()


def expected_sessions(first, last):
    """Expected sessions within observed history, excluding any pre-listing period."""
    if first > last:
        return []
    cal = calendar(pd.Timestamp(last).year)
    return [d.date().isoformat() for d in cal.sessions_in_range(first, last)]
