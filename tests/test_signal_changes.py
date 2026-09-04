import json

import pytest

from alphaview.panel import changes, store


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "changes.db"))
    store.init_db()


def snapshot(as_of, rows, scope="market", universe=None):
    with store.connect() as db:
        cursor = db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope) VALUES (?,?,?,?,?)",
                            (store.now(), as_of, json.dumps(universe if universe is not None else [r["symbol"] for r in rows]), json.dumps(rows), scope))
        return cursor.lastrowid


def row(symbol, as_of, status="watch", **kw):
    return {"symbol": symbol, "name": symbol + " company", "date": as_of,
            "signals": [{"strategy": "trend", "status": status, "matched": status == "match", "reason": status}], **kw}


def test_no_snapshot_first_snapshot_and_validation():
    assert changes.report()["status"] == "no_snapshot"
    snapshot("2026-09-04", [row("A", "2026-09-04", "match")])
    result = changes.report()
    assert result["status"] == "first_snapshot" and result["events"] == []
    assert changes.report(as_of="2026-08-01")["status"] == "no_snapshot"
    for scope, day in [("all", None), ("market", "20260904"), ("market", "bad")]:
        with pytest.raises(ValueError):
            changes.report(scope, day)


def test_distinct_dates_latest_same_day_snapshot_and_scope_isolation():
    snapshot("2026-09-03", [row("A", "2026-09-03", "match")])
    previous = snapshot("2026-09-03", [row("A", "2026-09-03")])
    snapshot("2026-09-04", [row("A", "2026-09-04")])
    current = snapshot("2026-09-04", [row("A", "2026-09-04", "match")])
    snapshot("2026-09-05", [row("A", "2026-09-05")], scope="portfolio")
    result = changes.report()
    assert (result["previous_snapshot_id"], result["current_snapshot_id"]) == (previous, current)
    assert result["counts"]["entered"] == 1
    assert result["previous_date"] == "2026-09-03"
    assert changes.report("portfolio")["status"] == "first_snapshot"
    assert changes.report(as_of="2026-09-03")["status"] == "first_snapshot"


def test_universe_membership_is_separate_from_signal_transitions():
    snapshot("2026-09-03", [row("EXIT", "2026-09-03", "match"), row("KEEP", "2026-09-03", "match"), row("REMOVE", "2026-09-03", "match")])
    snapshot("2026-09-04", [row("EXIT", "2026-09-04"), row("KEEP", "2026-09-04", "match"), row("ADD", "2026-09-04", "match")])
    result = changes.report()
    assert result["counts"] == {"entered": 0, "exited": 1, "continued": 1, "unavailable": 0, "universe_added": 1, "universe_removed": 1}
    assert {e["kind"]: e["symbol"] for e in result["events"]} == {"exited": "EXIT", "continued": "KEEP", "universe_added": "ADD", "universe_removed": "REMOVE"}


@pytest.mark.parametrize("status", ["stale", "data_error", "insufficient"])
@pytest.mark.parametrize("invalid_side", ["previous", "current"])
def test_unavailable_data_never_means_entry_or_exit(status, invalid_side):
    snapshot("2026-09-03", [row("A", "2026-09-03", status if invalid_side == "previous" else "match")])
    snapshot("2026-09-04", [row("A", "2026-09-04", status if invalid_side == "current" else "match")])
    result = changes.report()
    assert result["counts"]["unavailable"] == 1
    assert result["counts"]["entered"] == result["counts"]["exited"] == 0


def test_missing_rows_signals_and_stale_dates_are_unavailable():
    snapshot("2026-09-03", [row("MISSING", "2026-09-03", "match"), row("STALE", "2026-09-03", "match"), row("SIGNAL", "2026-09-03", "match")])
    snapshot("2026-09-04", [row("STALE", "2026-09-02", "watch"), row("SIGNAL", "2026-09-04", signals=[])], universe=["MISSING", "STALE", "SIGNAL"])
    result = changes.report()
    assert result["counts"]["unavailable"] == 3
    assert result["counts"]["exited"] == 0


def test_latest_uses_date_not_insert_order_and_reports_do_not_mutate():
    old_id = snapshot("2026-09-03", [row("A", "2026-09-03")])
    new_id = snapshot("2026-09-04", [row("A", "2026-09-04", "match")])
    snapshot("2026-09-01", [row("A", "2026-09-01")])
    before = store.latest_scan(as_of="2026-09-04", scope="market")
    result = changes.report()
    assert result["current_snapshot_id"] == new_id and result["previous_snapshot_id"] == old_id
    assert changes.report() == result
    assert store.latest_scan(as_of="2026-09-04", scope="market") == before
