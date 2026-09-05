"""Attach current membership context without changing stored scan snapshots."""
from . import scan_provenance, store


def decorate(snapshot, members=None):
    if snapshot is None:
        return None
    if members is None:
        members = store.universe(snapshot["scope"])
    scanned = set(snapshot["universe"])
    current = {member["symbol"] for member in members}
    revision = scan_provenance.current_token()
    saved = snapshot.get("input_revision")
    parsed = scan_provenance.parse(saved)
    status = "unknown" if parsed is None else "current" if saved == revision else "stale"
    return {**snapshot, "scan_engine_version": parsed["engine_version"] if parsed else None,
            "current_scan_engine_version": scan_provenance.SCAN_ENGINE_VERSION, "current_input_revision": revision, "input_status": status,
            "input_stale": None if status == "unknown" else status == "stale",
            "matches_current_universe": scanned == current,
            "scan_member_count": len(scanned), "current_member_count": len(current)}
