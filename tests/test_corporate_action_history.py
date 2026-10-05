"""Synthetic revision history: saved payload absence never asserts source absence."""
import json
import sqlite3

import pandas as pd
import pytest
import requests

from alphaview.panel import corporate_action_evidence as evidence, corporate_action_history as history
from alphaview.panel import paper_portfolio as paper, store
from tests.test_corporate_action_preview import workspace, fill, state, DAYS  # noqa: F401


def publish(events=None, *, omit=None, adapter="synthetic-adapter"):
    frame = pd.DataFrame({"date": DAYS})
    for column, kind in evidence.FIELDS.items():
        if column != omit:
            frame[column] = pd.Series([(events or {}).get((day, kind), 0.0) for day in DAYS], dtype=object)
    records = [("SYNTA", day, 100., 101., 99., 100., 100., 1000.) for day in DAYS]
    evidence.publish("SYNTA", records, {"name": "Synthetic action history", "currency": "USD", "exchange": "NMS", "last_date": DAYS[-1]},
                     evidence.prepare(frame, adapter), evidence.capture_identity("SYNTA"))


@pytest.fixture
def ready(workspace, monkeypatch):
    client, account = workspace
    client.app.include_router(history.router)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("History made an outbound call"))
    publish({(DAYS[5], "cash_dividend"): 1.23456789012345, (DAYS[6], "stock_split"): 2.0})
    fill(account, DAYS[0])
    publish({(DAYS[5], "cash_dividend"): 1.98765432109876, (DAYS[7], "cash_dividend"): .5})
    return workspace


def base(ready):
    return f"/api/paper/accounts/{ready[1]['id']}/corporate-actions/history"


def get(ready, suffix="/SYNTA"):
    response = ready[0].get(base(ready) + suffix)
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def body(ready, old=1, new=2):
    before, after = get(ready, f"/SYNTA/{old}"), get(ready, f"/SYNTA/{new}")
    return {"expected_account_version": before["account_version"], "baseline_revision": old, "selected_revision": new,
            "expected_baseline_fingerprint": before["item"]["fingerprint"], "expected_selected_fingerprint": after["item"]["fingerprint"]}


def compare(ready, old=1, new=2):
    response = ready[0].post(base(ready) + "/SYNTA/compare", json=body(ready, old, new))
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def test_immutable_raw_payload_and_change_semantics_without_historical_coverage_invention(ready):
    before = state()
    scope = get(ready, "/context")
    assert scope["symbols"] == [{"symbol": "SYNTA", "available": True, "reason": None}]
    listing = get(ready)
    assert [item["revision"] for item in listing["items"]] == [2, 1]
    assert all("payload" not in item and item["historical_coverage"] is None for item in listing["items"])
    detail = get(ready, "/SYNTA/1")["item"]
    assert detail["payload"]["events"][0]["raw_value"] == "1.23456789012345"
    with store.connect() as db:
        assert detail["payload_json"] == db.execute("SELECT payload_json FROM corporate_action_evidence WHERE revision=1").fetchone()[0]
    result = compare(ready)
    assert result["engine_version"] == "alphaview-corporate-action-history-v1" and result["status"] == "compared"
    assert result["source_completeness"] == "unknown" and result["historical_coverage"] is None
    assert result["historical_coverage_reason"] == "historical_capture_coverage_not_stored"
    changed, removed, added = result["changes"]
    assert changed["change_types"] == ["changed"]
    assert changed["numeric_delta"] == 1.98765432109876 - 1.23456789012345
    assert removed["change_types"] == ["removed_from_saved_payload"]
    assert removed["baseline"]["value"] == 2 and removed["selected"] is None
    assert removed["fields"]["value"]["selected"] is None
    assert removed["fields"]["value"]["selected_reason"] == "event_absent_from_saved_payload"
    assert removed["numeric_delta"] is None and removed["numeric_delta_reason"] == "event_absent_from_saved_payload"
    assert added["change_types"] == ["added"] and added["baseline"] is None
    assert added["selected"]["value"] == .5 and added["numeric_delta"] is None
    assert result["baseline"]["payload_json"] == detail["payload_json"]
    assert state() == before


def test_latest_only_coverage_is_never_presented_as_historical_even_when_missing_or_corrupt(ready):
    expected = compare(ready)
    with store.connect() as db:
        db.execute("UPDATE corporate_action_coverage SET coverage_json='not-json'")
    assert compare(ready) == expected
    with store.connect() as db:
        db.execute("DELETE FROM corporate_action_coverage")
    assert compare(ready) == expected


def test_raw_type_changes_and_unknown_numeric_values_remain_distinct(ready):
    publish({(DAYS[5], "cash_dividend"): 2})
    publish({(DAYS[5], "cash_dividend"): 2.0})
    row = compare(ready, 3, 4)["changes"][0]
    assert row["change_types"] == ["raw_type_changed", "changed"]
    assert row["baseline"]["raw_type"] == "int" and row["selected"]["raw_type"] == "float"
    assert row["baseline"]["value"] == row["selected"]["value"] == 2.0
    assert row["numeric_delta"] is None and row["numeric_delta_reason"] == "raw_type_changed"
    publish({(DAYS[5], "cash_dividend"): None})
    row = compare(ready, 4, 5)["changes"][0]
    assert row["selected"]["value"] is None and row["selected"]["reason"] == "missing_value"
    assert row["fields"]["value"]["selected_reason"] == "missing_value"
    assert row["numeric_delta"] is None and row["numeric_delta_reason"] == "amount_unavailable"


def test_missing_column_and_empty_payload_are_not_actual_cancellation_or_zero(ready):
    publish(omit="Stock Splits")
    value = compare(ready, 1, 3)
    assert value["selected"]["columns_present"]["Stock Splits"] is False
    assert value["selected"]["saved_event_count"] == 0  # Number of saved rows, not number of real events.
    assert all(row["change_types"] == ["removed_from_saved_payload"] and row["selected"] is None for row in value["changes"])
    assert value["selected"]["historical_coverage"] is None


def test_metadata_only_revision_difference_has_no_invented_event_changes(ready):
    publish({(DAYS[5], "cash_dividend"): 1.98765432109876, (DAYS[7], "cash_dividend"): .5}, adapter="synthetic-new-adapter")
    value = compare(ready, 2, 3)
    assert value["changes"] == [] and value["change_count"] == 0
    assert value["baseline"]["adapter_version"] != value["selected"]["adapter_version"]


def test_read_snapshot_is_query_only_and_get_does_not_initialize(ready, monkeypatch):
    original = history._base
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM corporate_action_evidence")
        return original(db, *args)
    monkeypatch.setattr(history, "_base", readonly)
    monkeypatch.setattr(evidence, "init_schema", lambda *args: pytest.fail("Read initialized schema"))
    before = state()
    get(ready, "/context"); get(ready); get(ready, "/SYNTA/1"); compare(ready)
    assert state() == before


@pytest.mark.parametrize("column,value", [("fingerprint", "0" * 64), ("fingerprint", "broken"),
    ("payload_json", "{"), ("first_fetched_at", "not-a-time"), ("first_fetched_at", "2024-01-01")])
def test_corrupt_metadata_or_payload_is_unavailable_and_never_falls_back(ready, column, value):
    pending = body(ready)
    with store.connect() as db:
        db.execute(f"UPDATE corporate_action_evidence SET {column}=? WHERE symbol='SYNTA' AND revision=2", (value,))
    row = get(ready, "/SYNTA/2")["item"]
    assert row["integrity"]["available"] is False and row["payload"] is row["payload_json"] is None
    listing = get(ready)
    assert listing["items"][0]["integrity"]["available"] is False and listing["items"][1]["integrity"]["available"] is True
    response = ready[0].post(base(ready) + "/SYNTA/compare", json=pending)
    if column == "fingerprint" and value == "0" * 64:
        assert response.status_code == 409
    else:
        assert response.status_code == 200 and response.json()["changes"] is None and response.json()["status"] == "unavailable"


@pytest.mark.parametrize("change", ["method", "extra", "duplicate", "missing_field", "nonfinite", "boolean", "unknown_reason", "missing_column", "too_many", "numeric_string_claim"])
def test_invalid_schema_even_with_matching_hash_stays_unavailable(ready, change):
    with store.connect() as db:
        value = json.loads(db.execute("SELECT payload_json FROM corporate_action_evidence WHERE revision=2").fetchone()[0])
        if change == "method": value["engine_version"] = "unknown-method"
        elif change == "extra": value["raw_notes"] = "SYNTHETIC EXCLUDED TEXT"
        elif change == "duplicate": value["events"].append(value["events"][0])
        elif change == "missing_field": del value["events"][0]["raw_type"]
        elif change == "nonfinite": value["events"][0]["value"] = 1e309
        elif change == "boolean": value["events"][0]["value"] = True
        elif change == "unknown_reason": value["events"][0].update(value=None, reason="fabricated")
        elif change == "missing_column": value["columns_present"]["Dividends"] = False
        elif change == "numeric_string_claim": value["events"][0]["raw_type"] = "str"
        else: value["events"] *= 801
        raw = json.dumps(value)
        fingerprint = "1" * 64 if change == "nonfinite" else evidence._hash(value)
        db.execute("UPDATE corporate_action_evidence SET payload_json=?,fingerprint=? WHERE revision=2", (raw, fingerprint))
    item = get(ready, "/SYNTA/2")["item"]
    assert not item["integrity"]["available"] and item["payload"] is item["payload_json"] is None
    assert "SYNTHETIC EXCLUDED TEXT" not in json.dumps(item)


def test_held_account_scope_is_checked_on_every_endpoint_and_no_private_holdings_returned(ready):
    other = paper.create_account(paper.AccountInput(name="Synthetic unheld scope", initial_cash=10000,
        idempotency_key="synthetic-other-action-history"))["account"]
    prefix = f"/api/paper/accounts/{other['id']}/corporate-actions/history"
    assert ready[0].get(prefix + "/context").json()["symbols"] == []
    for suffix in ("/SYNTA", "/SYNTA/1"):
        assert ready[0].get(prefix + suffix).status_code == 404
    assert ready[0].post(prefix + "/SYNTA/compare", json=body(ready)).status_code == 404
    assert ready[0].get(base(ready) + "/SYNTX").status_code == 404
    payload = json.dumps(get(ready, "/context"))
    assert "shares" not in payload and "cost_basis" not in payload and "cash" not in payload
    pending = body(ready)
    with store.connect() as db:
        db.execute("DELETE FROM paper_holdings WHERE account_id=?", (ready[1]["id"],))
    assert ready[0].get(base(ready) + "/SYNTA/1").status_code == 404
    assert ready[0].post(base(ready) + "/SYNTA/compare", json=pending).status_code == 404


def test_invalid_holding_scope_is_explicit_not_an_empty_valid_account(ready):
    with store.connect() as db:
        db.execute("UPDATE paper_holdings SET shares='unavailable' WHERE account_id=?", (ready[1]["id"],))
    assert get(ready, "/context")["symbols"] == [{"symbol": "SYNTA", "available": False, "reason": "holding_scope_unavailable"}]
    assert ready[0].get(base(ready) + "/SYNTA").status_code == 409


@pytest.mark.parametrize("changes", [{"expected_account_version": True}, {"baseline_revision": "1"}, {"selected_revision": 1},
    {"selected_revision": -1}, {"selected_revision": 2_147_483_648}, {"extra": "no"}, {"expected_baseline_fingerprint": "bad"}])
def test_strict_two_revision_comparison_body(ready, changes):
    assert ready[0].post(base(ready) + "/SYNTA/compare", json={**body(ready), **changes}).status_code == 422


@pytest.mark.parametrize("query", ["limit=0", "limit=51", "limit=true", "offset=-1", "offset=5001", "offset=1.0"])
def test_bounded_history_queries(ready, query):
    assert ready[0].get(base(ready) + "/SYNTA?" + query).status_code == 422


def test_account_version_and_content_expected_fingerprints_are_bound(ready):
    pending = body(ready)
    before = state()
    assert ready[0].post(base(ready) + "/SYNTA/compare", json={**pending, "expected_account_version": 999}).status_code == 409
    assert ready[0].post(base(ready) + "/SYNTA/compare", json={**pending, "expected_selected_fingerprint": "0" * 64}).status_code == 409
    assert ready[0].get(base(ready) + "/SYNTA/999").status_code == 404
    assert state() == before


@pytest.mark.parametrize("revision", ["0", "01", "1.0", "true", "-1", "2147483648"])
def test_strict_revision_path(ready, revision):
    assert ready[0].get(base(ready) + "/SYNTA/" + revision).status_code == 422


def test_adapter_change_preserves_amounts_but_does_not_claim_compatible_delta(ready):
    publish({(DAYS[5], "cash_dividend"): 2.5}, adapter="synthetic-new-adapter")
    row = compare(ready, 1, 3)["changes"][0]
    assert row["baseline"]["value"] == 1.23456789012345 and row["selected"]["value"] == 2.5
    assert row["numeric_delta"] is None and row["numeric_delta_reason"] == "adapter_version_changed"


def test_raw_stored_format_is_preserved_and_nonfinite_request_cleanly_rejected(ready):
    with store.connect() as db:
        old = db.execute("SELECT payload_json FROM corporate_action_evidence WHERE revision=1").fetchone()[0]
        raw = json.dumps(json.loads(old), indent=3).replace('"value": 2.0', '"value": 2e0') + '\n'
        db.execute("UPDATE corporate_action_evidence SET payload_json=? WHERE revision=1", (raw,))
    assert get(ready, "/SYNTA/1")["item"]["payload_json"] == raw
    pending = json.dumps(body(ready)).replace('"baseline_revision": 1', '"baseline_revision": 1e999')
    response = ready[0].post(base(ready) + "/SYNTA/compare", content=pending, headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "nonfinite_history_input"
