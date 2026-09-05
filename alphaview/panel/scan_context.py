"""Attach current membership context without changing stored scan snapshots."""
from . import store


def decorate(snapshot, members=None):
    if snapshot is None:
        return None
    if members is None:
        members = store.universe(snapshot["scope"])
    scanned = set(snapshot["universe"])
    current = {member["symbol"] for member in members}
    revision = store.input_revision()
    saved = snapshot.get("input_revision")
    status = "unknown" if not saved else "current" if saved == revision else "stale"
    return {**snapshot, "current_input_revision": revision, "input_status": status,
            "input_stale": None if status == "unknown" else status == "stale",
            "matches_current_universe": scanned == current,
            "scan_member_count": len(scanned), "current_member_count": len(current)}
