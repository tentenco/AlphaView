"""Immutable sampled-prefix receipts on synthetic local history; no provider/account calls."""
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import research_desk as desk, research_integrity as integrity, sessions, store
from alphaview.panel import research_integrity_receipts as receipts
from tests.test_research_desk import insert_bars, wave

BASE = "/api/research-desk/integrity-receipts"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "prefix-receipts.db"))
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("No external requests"))
    store.init_db()
    with store.connect() as db:
        receipts.init_schema(db)
    days = insert_bars("SYNTA", wave(240, period=37))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: days[-1])
    app = FastAPI()
    app.include_router(integrity.router)
    app.include_router(receipts.router)
    with TestClient(app) as client:
        yield client, days


def prepare(client, **changes):
    request = {"symbol": "SYNTA", "config": {"strategy": "rsi_reversion"}, **changes}
    response = client.post("/api/research-desk/integrity", json=request)
    assert response.status_code == 200, response.text
    evidence = response.json()
    return {"request": evidence["request"], "expected_input_revision": evidence["input_revision"],
            "expected_as_of": evidence["as_of"], "expected_evidence_fingerprint": evidence["evidence_fingerprint"]}, evidence


def save(client, body):
    response = client.post(BASE, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def count():
    with store.connect() as db:
        return db.execute("SELECT COUNT(*) FROM research_integrity_receipts").fetchone()[0]


def test_saved_recursive_indicator_diagnostic_replays_exact_bytes_without_recompute(workspace, monkeypatch):
    client, _ = workspace
    body, evidence = prepare(client)
    revision = store.input_revision()
    value = save(client, body)
    assert value["receipt"]["evidence"] == evidence
    assert value["receipt"]["receipt_id"] == value["id"] and value["receipt"]["created_at"] == value["created_at"]
    assert value["receipt"]["request"] == body["request"]
    assert value["status"] == "no_difference_detected" and value["currentness"] == {"current": True, "reasons": []}
    assert value["integrity"]["available"] and not value["replayed"]
    assert "rsi" in evidence["fields"] and evidence["counts"]["prefixes"] == 6
    assert value["content_fingerprint"] == receipts._hash(value["receipt"])
    with store.connect() as db:
        encoded = db.execute("SELECT payload_json FROM research_integrity_receipts WHERE id=?", (value["id"],)).fetchone()[0]
    downloaded = client.get(f"{BASE}/{value['id']}/evidence.json")
    assert downloaded.status_code == 200 and downloaded.content == encoded.encode()
    assert downloaded.headers["cache-control"] == "no-store"
    assert downloaded.headers["etag"] == f'"{value["content_fingerprint"]}"'
    assert client.get(f"{BASE}/{value['id']}/evidence.json", params={"expected_content_fingerprint": "a" * 64}).status_code == 409
    monkeypatch.setattr(integrity, "inspect_integrity", lambda *a: pytest.fail("Exact retry must not recompute"))
    replayed = client.post(BASE, json=body)
    assert replayed.status_code == 200, replayed.text
    assert replayed.json()["receipt"] == value["receipt"] and replayed.json()["replayed"]
    assert client.get(f"{BASE}/{value['id']}/evidence.json").content == encoded.encode()
    assert count() == 1 and store.input_revision() == revision
    json.dumps(replayed.json(), allow_nan=False)


def test_unrelated_workspace_change_marks_context_stale_without_claiming_symbol_bars_changed(workspace, monkeypatch):
    client, days = workspace
    body, evidence = prepare(client)
    saved = save(client, body)
    insert_bars("SYNTB", wave(30))
    # The original symbol's exact source fingerprint remains unchanged.
    assert desk.Series("SYNTA", days[-1]).fingerprint == evidence["fingerprint"]
    monkeypatch.setattr(desk, "Series", lambda *a: pytest.fail("Historical reads must not rebuild indicators"))
    detail = client.get(f"{BASE}/{saved['id']}").json()
    assert detail["receipt"] == saved["receipt"]
    assert detail["currentness"] == {"current": False, "reasons": ["workspace_inputs_changed"]}
    replay = client.post(BASE, json=body)
    assert replay.status_code == 200 and replay.json()["receipt"] == saved["receipt"]
    assert replay.json()["currentness"]["current"] is False
    fresh_body = {**body, "expected_evidence_fingerprint": "a" * 64}
    assert client.post(BASE, json=fresh_body).status_code == 409
    assert count() == 1


def test_exact_unavailable_evidence_can_be_saved_without_inventing_history(workspace):
    client, _ = workspace
    body, evidence = prepare(client, symbol="SYNTZ")
    assert evidence["fingerprint"] is None and evidence["status"] == "unavailable"
    value = save(client, body)
    assert value["receipt"]["evidence"] == evidence
    assert value["receipt"]["source_context"]["history_fingerprint"] is None
    assert value["currentness"]["current"] is True and value["status"] == "unavailable"
    assert value["counts"]["prefixes"] == 0


def test_future_dependent_indicator_counterexample_is_preserved_not_upgraded_to_proof(workspace, monkeypatch):
    client, _ = workspace
    original = desk.Series.rsi
    def leaked(series, period):
        return original(series, period) + series.close[-1] / 1000
    monkeypatch.setattr(desk.Series, "rsi", leaked)
    body, evidence = prepare(client)
    assert evidence["status"] == "differences_found" and evidence["counts"]["differences"] > 0
    value = save(client, body)
    assert value["receipt"]["evidence"]["differences"] == evidence["differences"]
    assert value["receipt"]["evidence"]["differences_truncated"] == evidence["differences_truncated"]
    assert value["status"] == "differences_found" and "verdict" not in value


@pytest.mark.parametrize("change", ["request", "revision", "session", "evidence"])
def test_expected_context_or_configuration_changes_reject_without_insert(workspace, change):
    client, days = workspace
    body, _ = prepare(client)
    if change == "request":
        body["request"]["max_prefixes"] = 3
    elif change == "revision":
        body["expected_input_revision"] = "changed:1"
    elif change == "session":
        body["expected_as_of"] = days[-2]
    else:
        body["expected_evidence_fingerprint"] = "a" * 64
    response = client.post(BASE, json=body)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] in ("receipt_source_changed", "receipt_evidence_changed")
    assert count() == 0


@pytest.mark.parametrize("change", ["revision", "session", "integrity_method", "desk_method"])
def test_change_between_closed_read_snapshot_and_publication_transaction_rejects(workspace, monkeypatch, change):
    client, days = workspace
    body, _ = prepare(client)
    real = store.read_snapshot
    moved = []
    @contextmanager
    def mutate_after_snapshot():
        outer = getattr(store._read_scope, "connection", None) is None
        with real():
            yield
        if outer and not moved:
            moved.append(change)
            if change == "revision":
                with store.connect() as db:
                    db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
            elif change == "session":
                monkeypatch.setattr(sessions, "latest_completed_session", lambda: days[-2])
            elif change == "integrity_method":
                monkeypatch.setattr(integrity, "ENGINE_VERSION", "changed-diagnostic-method")
            else:
                monkeypatch.setattr(desk, "ENGINE_VERSION", "changed-desk-method")
    monkeypatch.setattr(store, "read_snapshot", mutate_after_snapshot)
    response = client.post(BASE, json=body)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "receipt_context_changed"
    assert moved == [change] and count() == 0


def test_corrupt_receipt_is_unavailable_on_read_and_never_overwritten_on_exact_retry(workspace):
    client, _ = workspace
    body, _ = prepare(client)
    value = save(client, body)
    with store.connect() as db:
        db.execute("UPDATE research_integrity_receipts SET payload_json='{}' WHERE id=?", (value["id"],))
    detail = client.get(f"{BASE}/{value['id']}").json()
    assert detail["receipt"] is None and not detail["integrity"]["available"]
    assert detail["currentness"]["current"] is None and detail["status"] is None
    listed = client.get(BASE, params={"symbol": "SYNTA"}).json()
    assert listed["items"][0]["integrity"]["available"] is False
    assert client.get(f"{BASE}/{value['id']}/evidence.json").status_code == 409
    assert client.post(BASE, json=body).status_code == 409
    with store.connect() as db:
        assert db.execute("SELECT payload_json FROM research_integrity_receipts WHERE id=?", (value["id"],)).fetchone()[0] == "{}"
    assert count() == 1


def test_self_consistent_hash_cannot_hide_request_config_mismatch(workspace):
    client, _ = workspace
    body, _ = prepare(client)
    value = save(client, body)
    payload = value["receipt"]
    payload["request"] = {**payload["request"], "max_prefixes": 1}
    with store.connect() as db:
        db.execute("UPDATE research_integrity_receipts SET payload_json=?,content_fingerprint=? WHERE id=?",
                   (receipts._json(payload), receipts._hash(payload), value["id"]))
    detail = client.get(f"{BASE}/{value['id']}").json()
    assert not detail["integrity"]["available"] and detail["receipt"] is None


def test_saved_timestamp_is_bound_into_the_immutable_payload(workspace):
    client, _ = workspace
    body, _ = prepare(client)
    value = save(client, body)
    with store.connect() as db:
        db.execute("UPDATE research_integrity_receipts SET created_at='changed' WHERE id=?", (value["id"],))
    assert client.get(f"{BASE}/{value['id']}").json()["integrity"]["available"] is False


@pytest.mark.parametrize("field,new_value", [("receipt_id", "f" * 64), ("created_at", "2025-01-01T00:00:00Z")])
def test_checksum_valid_payload_identity_cannot_disagree_with_row_metadata(workspace, field, new_value):
    client, _ = workspace
    body, _ = prepare(client)
    value = save(client, body)
    payload = value["receipt"]
    payload[field] = new_value
    with store.connect() as db:
        db.execute("UPDATE research_integrity_receipts SET payload_json=?,content_fingerprint=? WHERE id=?",
                   (receipts._json(payload), receipts._hash(payload), value["id"]))
    result = client.get(f"{BASE}/{value['id']}").json()
    assert not result["integrity"]["available"] and result["receipt"] is None
    assert client.get(f"{BASE}/{value['id']}/evidence.json").status_code == 409
    assert client.post(BASE, json=body).status_code == 409


@pytest.mark.parametrize("timestamp", ["invalid", "2025-02-30T00:00:00Z", "2025-01-01T00:00:00", "2025-01-01T00:00:00+08:00"])
def test_even_matching_checksum_and_row_must_have_valid_utc_capture_time(workspace, timestamp):
    client, _ = workspace
    body, _ = prepare(client)
    value = save(client, body)
    payload = value["receipt"]
    payload["created_at"] = timestamp
    with store.connect() as db:
        db.execute("UPDATE research_integrity_receipts SET created_at=?,payload_json=?,content_fingerprint=? WHERE id=?",
                   (timestamp, receipts._json(payload), receipts._hash(payload), value["id"]))
    assert client.get(f"{BASE}/{value['id']}").json()["integrity"]["available"] is False


def test_concurrent_identical_saves_publish_one_receipt_and_replay_the_other(workspace):
    client, _ = workspace
    body, _ = prepare(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(BASE, json=body), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201]
    values = [response.json() for response in responses]
    assert values[0]["id"] == values[1]["id"] and values[0]["receipt"] == values[1]["receipt"]
    assert sorted(value["replayed"] for value in values) == [False, True]
    assert count() == 1


def test_capacity_refuses_new_receipt_preserves_all_old_bytes_and_allows_retry(workspace, monkeypatch):
    client, _ = workspace
    monkeypatch.setattr(receipts, "MAX_TOTAL", 2)
    bodies, values = [], []
    for prefixes in (1, 2):
        body, _ = prepare(client, max_prefixes=prefixes)
        bodies.append(body)
        values.append(save(client, body))
    original = [client.get(f"{BASE}/{value['id']}/evidence.json").content for value in values]
    third, _ = prepare(client, max_prefixes=3)
    response = client.post(BASE, json=third)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_capacity"
    assert count() == 2
    assert [client.get(f"{BASE}/{value['id']}/evidence.json").content for value in values] == original
    assert client.post(BASE, json=bodies[0]).json()["replayed"]
    assert client.get(BASE).json()["retention"]["automatic_deletion"] is False


def test_oversized_receipt_is_rejected_without_truncation(workspace, monkeypatch):
    client, _ = workspace
    body, _ = prepare(client)
    monkeypatch.setattr(receipts, "MAX_BYTES", 100)
    response = client.post(BASE, json=body)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "receipt_size_limit"
    assert count() == 0


def test_list_is_bounded_filtered_and_reads_do_not_change_revision(workspace):
    client, _ = workspace
    a, _ = prepare(client)
    first = save(client, a)
    b, _ = prepare(client, symbol="SYNTZ")
    save(client, b)
    revision = store.input_revision()
    listed = client.get(BASE, params={"symbol": "SYNTA"}).json()
    assert listed["pagination"]["total"] == 1 and listed["items"][0]["id"] == first["id"]
    assert "receipt" not in listed["items"][0]
    assert client.get(BASE, params={"limit": 1, "offset": 1}).json()["pagination"]["returned"] == 1
    assert client.get(BASE, params={"limit": 21}).status_code == 422
    assert client.get(BASE, params={"offset": 501}).status_code == 422
    assert client.get(f"{BASE}/missing").status_code == 404
    assert store.input_revision() == revision


@pytest.mark.parametrize("changes", [{"verdict": "pass"}, {"expected_as_of": "2024-02-30"},
                                    {"expected_input_revision": True}, {"expected_evidence_fingerprint": "invalid"},
                                    {"request": {"symbol": "SYNTA", "config": {"strategy": "rsi_reversion"}, "max_prefixes": True}}])
def test_save_request_is_strict_and_does_not_accept_client_verdicts(workspace, monkeypatch, changes):
    client, _ = workspace
    body, _ = prepare(client)
    monkeypatch.setattr(integrity, "inspect_integrity", lambda *a: pytest.fail("Invalid request must not calculate"))
    response = client.post(BASE, json={**body, **changes})
    assert response.status_code == 422 and count() == 0


def test_nonfinite_request_error_remains_valid_json(workspace):
    client, _ = workspace
    body, _ = prepare(client)
    body["request"]["config"]["params"]["period"] = float("nan")
    response = client.post(BASE, content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422, response.text
    json.dumps(response.json(), allow_nan=False)
    assert count() == 0
