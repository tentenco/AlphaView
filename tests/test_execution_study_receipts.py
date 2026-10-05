"""Synthetic immutable execution-study receipt lifecycle and byte fidelity."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import sqlite3

import pytest

from alphaview.panel import execution_study_receipts as receipts, paper_portfolio as paper, store
from tests.test_execution_volume_study import workspace, body_for, state, EXECUTION  # noqa: F401

KINDS = {"volume_day": (receipts.volume, "volume-study"), "limit_day": (receipts.limit, "limit-study"), "open_gtd": (receipts.gtd, "gtd-study")}


@pytest.fixture
def setup(workspace):
    client = workspace[0]
    client.app.include_router(receipts.limit.router)
    client.app.include_router(receipts.gtd.router)
    client.app.include_router(receipts.router)
    with store.connect() as db:
        receipts.ensure_schema(db)
    return workspace


def url(setup):
    return f"/api/paper/accounts/{setup[1]['id']}/proposals/{setup[2]['id']}/study-receipts"


def prepare(setup, kind="volume_day", **changes):
    client, account, proposal, _ = setup
    request = body_for(client, account, proposal)
    if kind != "volume_day": request["limits"] = [{"symbol": "SYNTA", "limit_price": 110}]
    if kind == "open_gtd": request["gtd_date"] = EXECUTION
    request.update(changes)
    response = client.post(url(setup).replace("study-receipts", KINDS[kind][1]), json=request)
    assert response.status_code == 200, response.text
    return {"kind": kind, "request": request, "expected_evidence_engine_version": response.json()["engine_version"],
            "expected_raw_evidence_sha256": receipts._sha(response.content)}, response


def saved(setup, kind="volume_day", **changes):
    body, response = prepare(setup, kind, **changes)
    result = setup[0].post(url(setup), json=body)
    assert result.status_code == 201, result.text
    return body, response, result.json()


def rows():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT * FROM execution_study_receipts ORDER BY id")]


def download(setup, value, suffix="evidence.json"):
    return setup[0].get(f"{url(setup)}/{value['id']}/{suffix}", params={"expected_content_fingerprint": value["content_fingerprint"]})


@pytest.mark.parametrize("kind", KINDS)
def test_save_rebuilds_exact_real_http_bytes_and_historical_reads_never_recompute(setup, monkeypatch, kind):
    before, revision = state(), store.input_revision()
    body, original, value = saved(setup, kind)
    assert value["raw_evidence_sha256"] == receipts._sha(original.content)
    assert value["integrity"] == {"available": True, "reason": None}
    assert value["currentness"] == {"current": True, "reasons": []}
    assert value["source_proposal_current"] is False  # signal-date proposal is intentionally older
    assert value["receipt"]["evidence"] == original.json()
    assert value["receipt"]["policy"] == receipts.POLICY
    assert value["receipt"]["request"] == body["request"]
    assert state() == before and store.input_revision() == revision
    original_rows = rows()
    monkeypatch.setattr(receipts, "_rebuild", lambda *a: pytest.fail("Read/replay must not recompute"))
    monkeypatch.setattr(receipts, "ensure_schema", lambda *a: pytest.fail("Read must not initialize"))
    real_view = receipts._view
    def readonly(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute("DELETE FROM execution_study_receipts")
        return real_view(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", readonly)
    history = setup[0].get(url(setup), params={"kind": kind}).json()
    assert history["pagination"] == {"limit": 20, "offset": 0, "total": 1, "returned": 1}
    assert "receipt" not in history["items"][0]
    detail = setup[0].get(url(setup) + "/" + value["id"]).json()
    assert detail["receipt"] == value["receipt"]
    evidence = download(setup, value)
    assert evidence.status_code == 200 and evidence.content == original.content
    assert evidence.headers["etag"] == f'"{value["raw_evidence_sha256"]}"'
    assert evidence.headers["x-receipt-fingerprint"] == value["content_fingerprint"]
    complete = download(setup, value, "receipt.json")
    assert complete.text == original_rows[0][-1] and receipts._sha(complete.content) == value["content_fingerprint"]
    assert original.text in complete.text and complete.json() == value["receipt"]
    assert rows() == original_rows and state() == before


@pytest.mark.parametrize("kind", KINDS)
def test_exact_retry_after_context_and_method_changes_replays_original_bytes(setup, monkeypatch, kind):
    body, original, value = saved(setup, kind)
    before = rows()
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
    setup[3]["session"] = "2024-01-09"
    monkeypatch.setattr(KINDS[kind][0], "ENGINE_VERSION", "synthetic-next-study")
    monkeypatch.setattr(receipts, "_rebuild", lambda *args: pytest.fail("Exact retry must not rebuild"))
    replay = setup[0].post(url(setup), json=body)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] and replay.json()["receipt"] == value["receipt"]
    assert set(replay.json()["currentness"]["reasons"]) == {"inputs_changed", "account_context_changed", "session_changed", "method_changed"}
    assert download(setup, value).content == original.content and rows() == before


@pytest.mark.parametrize("kind", KINDS)
def test_unavailable_and_explicit_zero_are_preserved_separately(setup, kind):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=0 WHERE symbol='SYNTA' AND date=?", (EXECUTION,))
        db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (EXECUTION,))
    _body, original, value = saved(setup, kind)
    first, second = value["receipt"]["evidence"]["orders"]
    quantity = "final_scenario_shares" if kind == "open_gtd" else "scenario_shares"
    assert first[quantity] == 0 and second[quantity] is None
    assert second["reason"] == "missing_execution_bar"
    assert value["status"] in ("incomplete", "unavailable") and download(setup, value).content == original.content


@pytest.mark.parametrize("change", ["account", "policy", "proposal", "input", "session", "method"])
def test_publish_rechecks_after_snapshot_and_never_leaves_half_receipt(setup, monkeypatch, change):
    body, _ = prepare(setup)
    original = store.read_snapshot
    depth, fired = 0, False
    @contextmanager
    def mutate_after_snapshot():
        nonlocal depth, fired
        depth += 1
        try:
            with original(): yield
        finally:
            depth -= 1
        if depth == 0 and not fired:
            fired = True
            with store.connect() as db:
                if change == "account": db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
                if change == "policy": db.execute("UPDATE paper_accounts SET limits_json='{}' WHERE id=?", (setup[1]["id"],))
                if change == "proposal": db.execute("UPDATE paper_proposals SET status='rejected' WHERE id=?", (setup[2]["id"],))
                if change == "input": db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
            if change == "session": setup[3]["session"] = "2024-01-09"
            if change == "method": monkeypatch.setattr(receipts.volume, "ENGINE_VERSION", "synthetic-change")
    monkeypatch.setattr(store, "read_snapshot", mutate_after_snapshot)
    response = setup[0].post(url(setup), json=body)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_context_changed"
    assert rows() == []


@pytest.mark.parametrize("field", ["expected_raw_evidence_sha256", "expected_evidence_engine_version", "expected_account_version", "expected_input_revision", "expected_as_of", "expected_proposal_fingerprint"])
def test_wrong_expectations_do_not_save(setup, field):
    body, _ = prepare(setup)
    if field == "expected_raw_evidence_sha256": body[field] = "0" * 64
    elif field == "expected_evidence_engine_version": body[field] = "synthetic-other"
    elif field == "expected_account_version": body["request"][field] += 1
    elif field == "expected_as_of": body["request"][field] = "2024-01-09"
    elif field == "expected_proposal_fingerprint": body["request"][field] = "0" * 64
    else: body["request"][field] = "synthetic-other"
    assert setup[0].post(url(setup), json=body).status_code == 409 and rows() == []


@pytest.mark.parametrize("mutation", [
    {"kind": "real_execution"}, {"evidence": {}}, {"expected_raw_evidence_sha256": "bad"},
    {"request": {"expected_account_version": True}}, {"request": {"expected_account_version": 2147483648}},
    {"request": {"participation_pct": float("nan")}}, {"request": {"participation_pct": float("inf")}},
    {"request": {"limits": []}}, {"request": {"gtd_date": EXECUTION}},
])
def test_strict_finite_discriminated_input(setup, monkeypatch, mutation):
    body, _ = prepare(setup)
    if "request" in mutation: body["request"].update(mutation["request"])
    else: body.update(mutation)
    monkeypatch.setattr(receipts, "_rebuild", lambda *args: pytest.fail("Invalid input must not run study"))
    response = setup[0].post(url(setup), content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and rows() == []
    json.dumps(response.json(), allow_nan=False)


@pytest.mark.parametrize("column,value", [("payload_json", "{}"), ("payload_json", sqlite3.Binary(b"not-text")),
    ("content_fingerprint", "0" * 64), ("request_json", "{}"), ("created_at", "bad"),
    ("kind", "limit_day"), ("engine_version", "wrong"), ("created_at", sqlite3.Binary(b"bad"))])
def test_corrupt_storage_never_downloads_or_replays_as_valid(setup, column, value):
    body, _, saved_value = saved(setup)
    with store.connect() as db: db.execute(f"UPDATE execution_study_receipts SET {column}=?", (value,))
    before = rows()
    detail = setup[0].get(url(setup) + "/" + saved_value["id"]).json()
    assert detail["integrity"]["available"] is False and detail["receipt"] is None
    assert detail["currentness"]["current"] is None and detail["raw_evidence_sha256"] is None
    assert download(setup, saved_value).status_code == 409
    assert download(setup, saved_value, "receipt.json").status_code == 409
    assert setup[0].post(url(setup), json=body).status_code == 409 and rows() == before


def test_cross_account_proposal_and_strict_route_bounds(setup):
    body, _, value = saved(setup)
    foreign = "f" * 32
    for path in (url(setup).replace(setup[1]["id"], foreign), url(setup).replace(setup[2]["id"], foreign)):
        assert setup[0].get(path + "/" + value["id"]).status_code == 404
        assert setup[0].post(path, json=body).status_code == 404
    for query in ("limit=21", "limit=0", "offset=-1", "offset=251", "kind=execution"):
        assert setup[0].get(url(setup) + "?" + query).status_code == 422
    assert setup[0].get(url(setup) + "/wrong").status_code == 422
    assert setup[0].get(url(setup).replace(setup[1]["id"], "bad")).status_code == 422
    assert setup[0].get(f"{url(setup)}/{value['id']}/receipt.json?expected_content_fingerprint={'0'*64}").status_code == 409


def test_capacity_size_rejection_and_exact_replay_at_cap(setup, monkeypatch):
    body, _, value = saved(setup)
    monkeypatch.setattr(receipts, "MAX_ACCOUNT", 1)
    assert setup[0].post(url(setup), json=body).status_code == 200
    new, _ = prepare(setup, participation_pct=11)
    assert setup[0].post(url(setup), json=new).json()["detail"]["code"] == "receipt_capacity"
    monkeypatch.setattr(receipts, "MAX_ACCOUNT", 50)
    monkeypatch.setattr(receipts, "MAX_TOTAL", 1)
    assert setup[0].post(url(setup), json=new).json()["detail"]["code"] == "receipt_capacity"
    monkeypatch.setattr(receipts, "MAX_TOTAL", 250)
    original_limit = receipts.MAX_BYTES
    monkeypatch.setattr(receipts, "MAX_BYTES", 100)
    assert setup[0].post(url(setup), json=new).json()["detail"]["code"] == "receipt_size_limit"
    monkeypatch.setattr(receipts, "MAX_BYTES", original_limit)
    assert len(rows()) == 1 and download(setup, value).status_code == 200
    assert setup[0].post(url(setup), content=' ' * 16385, headers={"Content-Type": "application/json"}).status_code == 422


def test_transaction_failure_rolls_back_insert(setup, monkeypatch):
    body, _ = prepare(setup)
    def fail(*_a, **_k): raise RuntimeError("synthetic after insert")
    monkeypatch.setattr(receipts, "_view", fail)
    with pytest.raises(RuntimeError, match="synthetic after insert"):
        setup[0].post(url(setup), json=body)
    assert rows() == []


def test_concurrent_exact_saves_only_create_one_original(setup):
    body, _ = prepare(setup)
    with ThreadPoolExecutor(max_workers=3) as pool:
        replies = list(pool.map(lambda _n: setup[0].post(url(setup), json=body), range(3)))
    assert sorted(reply.status_code for reply in replies) == [200, 200, 201]
    assert len({reply.json()["id"] for reply in replies}) == 1 and len(rows()) == 1


def test_limits_normalized_retry_and_pagination_kind_filter(setup):
    first, _, first_value = saved(setup, "limit_day", limits=[{"symbol": "SYNTB", "limit_price": 95}, {"symbol": "SYNTA", "limit_price": 110}])
    first["request"]["limits"].reverse()
    replay = setup[0].post(url(setup), json=first)
    assert replay.status_code == 200 and replay.json()["id"] == first_value["id"]
    saved(setup, "volume_day")
    saved(setup, "open_gtd")
    page = setup[0].get(url(setup), params={"limit": 1, "offset": 1}).json()
    assert page["pagination"] == {"limit": 1, "offset": 1, "total": 3, "returned": 1}
    filtered = setup[0].get(url(setup), params={"kind": "limit_day"}).json()
    assert filtered["pagination"]["total"] == 1 and filtered["items"][0]["id"] == first_value["id"]


def test_server_float_unicode_null_future_fields_are_stored_without_byte_loss(setup, monkeypatch):
    actual = receipts.volume.study
    def future(*args, **kwargs):
        return {**actual(*args, **kwargs), "synthetic_future_metadata": {"whole": 1.0, "negative_zero": -0.0, "tiny": 1e-9, "huge": 1e20, "unicode": "合成é", "missing": None}}
    # Patch both actual endpoint callable and rebuild path through a separate test route.
    monkeypatch.setattr(receipts.volume, "study", future)
    body, _ = prepare(setup)
    rebuilt = future(setup[1]["id"], setup[2]["id"], receipts.VolumeRequest(**body["request"]))
    raw = receipts.JSONResponse(rebuilt).body
    assert b'1.0' in raw and b'-0.0' in raw and b'1e-09' in raw
    body["expected_raw_evidence_sha256"] = receipts._sha(raw)
    response = setup[0].post(url(setup), json=body)
    assert response.status_code == 201, response.text
    value = response.json()
    assert download(setup, value).content == raw
    assert raw in download(setup, value, "receipt.json").content
