"""Attach current membership context without changing stored scan snapshots."""
from . import store


def decorate(snapshot, members=None):
    if snapshot is None:
        return None
    if members is None:
        members = store.universe(snapshot["scope"])
    scanned = set(snapshot["universe"])
    current = {member["symbol"] for member in members}
    return {**snapshot, "matches_current_universe": scanned == current,
            "scan_member_count": len(scanned), "current_member_count": len(current)}
