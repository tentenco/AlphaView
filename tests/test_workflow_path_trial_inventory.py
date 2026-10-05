"""Synthetic saved-trial inventory: complete coverage without performance or reconstruction."""
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from alphaview.panel import workflow_path_trial_inventory as inventory
from alphaview.panel import workflow_path_receipts as receipts, workflow_path_receipt_archive as archive
from alphaview.panel import workflow_path_receipt_comparison as comparison, workflow_path_cscv as cscv
from alphaview.panel import workflow_path_validation as path, paper_portfolio as paper, store
from tests.test_workflow_path_receipts import setup, workspace, prepare, url, protected_state, rows  # noqa: F401
from tests.test_workflow_path_validation import saved
from tests.test_workflow_path_receipt_comparison import rewrite


def route(subject):
    return f"/api/paper/accounts/{subject[2]['id']}/workflow-path-trial-inventory"


def save(subject, kind="path_validation"):
    request, _ = prepare(subject, kind)
    response = subject[0].post(url(subject), json=request)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def sample(setup):
    setup[0].app.include_router(inventory.router)
    setup[0].app.include_router(archive.router)
    return setup, save(setup)


def get(subject):
    return subject[0].get(route(subject))


def clone(identifier, new_id, **changes):
    with store.connect() as db:
        row = dict(db.execute("SELECT * FROM workflow_path_receipts WHERE id=?", (identifier,)).fetchone())
        row.update(id=new_id, **changes)
        db.execute("INSERT INTO workflow_path_receipts VALUES (?,?,?,?,?,?,?,?,?)", tuple(row[k] for k in archive.COLUMNS))


def test_complete_inventory_keeps_duplicate_settings_and_incompatible_bases_cost_and_corrupt(sample, monkeypatch):
    subject, first = sample
    client, days, account, run = subject
    duplicate = save((client, days, account, saved(client, days)))
    different = save((client, days, account, saved(client, days, constraints={"max_positions":1,"max_position_weight_pct":20,"cash_buffer_pct":20})))
    different_basis = save((client, days, account, saved(client, days, constraints={"max_positions":1,"max_position_weight_pct":40,"cash_buffer_pct":20})))
    different_basis = rewrite(different_basis, lambda p: p["evidence"].update(history_fingerprint="f"*64))
    cost = save(subject, "path_costs")
    clone(first["id"], "e"*64, payload_json="{")
    before, protected, revision = rows(), protected_state(), store.input_revision()
    original_read = inventory._records
    def read_only(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        for sql in ("DELETE FROM workflow_path_receipts", "UPDATE paper_accounts SET version=version+1", "CREATE TABLE unsafe(x)"):
            with pytest.raises(sqlite3.OperationalError): db.execute(sql)
        yield from original_read(db, *args)
    monkeypatch.setattr(inventory, "_records", read_only)
    monkeypatch.setattr(path, "evaluate", lambda *a: pytest.fail("No path computation"))
    monkeypatch.setattr(path, "_load_history", lambda *a: pytest.fail("No price reads"))
    monkeypatch.setattr(cscv, "analyze", lambda *a: pytest.fail("No CSCV computation"))
    response = get(subject)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["coverage"] == {"complete_set":True,"account_receipts":6,"returned_receipts":6,"path_receipts":5,
        "cost_receipts":1,"unknown_kind_receipts":0,"verified_receipts":5,"unverifiable_receipts":1,
        "basis_available_path_receipts":4,"basis_unavailable_path_receipts":1,"basis_groups":2,
        "configurations_within_groups":3,"duplicate_configuration_groups":1,"duplicate_receipts_extra":1}
    group = next(g for g in value["groups"] if len(g["receipt_ids"]) == 3)
    repeated = next(c for c in group["configurations"] if c["multiplicity"] == 2)
    assert set(repeated["receipt_ids"]) == {first["id"], duplicate["id"]}
    assert repeated["configuration_fingerprint"] == receipts._hash(cscv._configuration(first["receipt"]))
    assert value["unrecorded_trials"] is None and value["full_search_denominator"] is None
    assert value["scope"] == "saved_receipts_only" and value["full_search_coverage"] == "unknown"
    assert {r["id"] for r in value["records"]} == {first["id"],duplicate["id"],different["id"],different_basis["id"],cost["id"],"e"*64}
    assert response.content == receipts._json(value).encode() and response.headers["cache-control"] == "no-store"
    assert value["inventory_fingerprint"] == receipts._hash({k:v for k,v in value.items() if k != "inventory_fingerprint"})
    forbidden = {"metrics", "baseline_metrics", "curve", "return_matrix", "returns", "rank", "winner", "aggregate", "original_receipt", "payload_json"}
    def keys(node):
        if isinstance(node, dict):
            assert not forbidden.intersection(node)
            for v in node.values(): keys(v)
        elif isinstance(node,list):
            for v in node: keys(v)
    # Byte-length metadata explicitly names the original columns, but contains no payload.
    for r in value["records"]: r.pop("original_byte_lengths")
    keys(value)
    assert rows() == before and protected_state() == protected and store.input_revision() == revision


def test_complete_same_account_all_pages_and_foreign_receipts_excluded(sample):
    subject, receipt = sample
    for index in range(26): clone(receipt["id"], f"{index:064x}")
    clone(receipt["id"], "f"*64, account_id="f"*32)
    value = get(subject).json()
    archived = subject[0].get(route(subject).replace("workflow-path-trial-inventory", "workflow-path-receipt-archive")).json()
    assert value["coverage"]["account_receipts"] == value["coverage"]["returned_receipts"] == 27
    assert value["coverage"]["account_receipts"] == archived["coverage"]["account_total"]
    assert "f"*64 not in [r["id"] for r in value["records"]]
    assert value["coverage"]["unverifiable_receipts"] == 26


@pytest.mark.parametrize("case", ["blob", "invalid_utf8", "null_id", "blob_account", "unknown_kind"])
def test_corrupt_metadata_stays_visible_without_usable_trial_or_fabricated_identity(sample, case):
    subject, receipt = sample
    with store.connect() as db:
        if case == "blob": db.execute("UPDATE workflow_path_receipts SET payload_json=? WHERE id=?", (b"\xffbroken",receipt["id"]))
        if case == "invalid_utf8": db.execute("UPDATE workflow_path_receipts SET id=CAST(x'fffe' AS TEXT) WHERE id=?", (receipt["id"],))
        if case == "null_id": db.execute("UPDATE workflow_path_receipts SET id=NULL WHERE id=?", (receipt["id"],))
        if case == "blob_account": db.execute("UPDATE workflow_path_receipts SET account_id=? WHERE id=?", (subject[2]["id"].encode(),receipt["id"]))
        if case == "unknown_kind":
            db.execute("PRAGMA ignore_check_constraints=ON")
            db.execute("UPDATE workflow_path_receipts SET kind='synthetic_unknown_kind' WHERE id=?", (receipt["id"],))
    value = get(subject).json()
    assert len(value["records"]) == 1 and value["groups"] == []
    row = value["records"][0]
    assert row["integrity"]["available"] is False and row["configuration"] is None
    if case in ("null_id","invalid_utf8"): assert row["id"] is None
    if case == "invalid_utf8": assert row["identity_cells"]["id"]["encoding"] == "base64"
    if case == "unknown_kind": assert value["coverage"]["unknown_kind_receipts"] == 1


def test_unavailable_valid_path_is_not_grouped_but_saved_settings_remain_visible(setup):
    client, days, account, run = setup
    client.app.include_router(inventory.router)
    with store.connect() as db: db.execute("DELETE FROM bars WHERE symbol='SYNTB' AND date=?", (days[-300],))
    case = (client, days, account, saved(client,days))
    receipt = save(case)
    assert receipt["status"] == "unavailable"
    value = get(case).json()
    row = value["records"][0]
    assert row["integrity"]["available"] and row["category"] == "unavailable_path"
    assert row["configuration"] == cscv._configuration(receipt["receipt"])
    assert row["basis_fingerprint"] is None and value["groups"] == []
    assert "complete_coverage" in row["reasons"]


def test_currentness_is_separate_from_historical_basis_and_configuration(sample):
    subject, _ = sample
    before = get(subject).json()
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (subject[2]["id"],))
        db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
    after = get(subject).json()
    assert before["groups"] == after["groups"]
    assert after["records"][0]["currentness"]["current"] is False
    assert set(after["records"][0]["currentness"]["reasons"]) == {"inputs_changed","account_context_changed"}
    assert after["coverage"] == before["coverage"]


def test_unsupported_methods_cannot_create_available_basis(sample, monkeypatch):
    subject, _ = sample
    monkeypatch.setattr(path,"ENGINE_VERSION","synthetic-unsupported-version")
    value = get(subject).json()
    assert value["records"][0]["integrity"]["available"] is True
    assert value["records"][0]["category"] == "unavailable_path" and value["groups"] == []
    assert "archive_evidence_method_unsupported" in value["records"][0]["reasons"]


def test_caps_refuse_full_response_and_oversized_original_is_counted_unavailable(sample, monkeypatch):
    subject, receipt = sample
    with store.connect() as db:
        db.execute("PRAGMA ignore_check_constraints=ON")
        db.execute("UPDATE workflow_path_receipts SET payload_json=? WHERE id=?", ("x"*(receipts.MAX_BYTES+1),receipt["id"]))
    response = get(subject)
    assert response.status_code == 200
    row = response.json()["records"][0]
    assert row["reasons"] == ["inventory_original_size_limit"] and row["original_byte_lengths"]["payload_json"] == receipts.MAX_BYTES+1
    monkeypatch.setattr(inventory,"MAX_BYTES",100)
    assert get(subject).status_code == 413


def test_count_and_identity_size_caps_reject_without_partial_inventory(sample):
    subject, receipt = sample
    for index in range(50): clone(receipt["id"], f"{index:064x}")
    assert get(subject).status_code == 413
    with store.connect() as db:
        db.execute("DELETE FROM workflow_path_receipts WHERE id!=?",(receipt["id"],))
        db.execute("UPDATE workflow_path_receipts SET created_at=? WHERE id=?", ("x"*16385,receipt["id"]))
    assert get(subject).status_code == 413


def test_empty_account_and_strict_identity_with_no_mutating_endpoint(sample):
    subject, _ = sample
    other = paper.create_account(paper.AccountInput(name="Synthetic empty inventory",initial_cash=1000,idempotency_key="synthetic-inventory-empty"))["account"]
    empty = (subject[0],subject[1],other,subject[3])
    value = get(empty).json()
    assert value["records"] == value["groups"] == [] and value["coverage"]["account_receipts"] == 0
    assert value["full_search_denominator"] is None
    assert subject[0].post(route(subject),json={}).status_code == 405
    assert subject[0].get(route(subject).replace(subject[2]["id"],"invalid")).status_code == 422
    assert subject[0].get(route(subject).replace(subject[2]["id"],"f"*32)).status_code == 404


def test_snapshot_stays_consistent_during_concurrent_account_and_receipt_write(sample, monkeypatch):
    subject, receipt = sample
    original = inventory._records
    def writer():
        clone(receipt["id"],"d"*64)
        with store.connect() as db: db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?",(subject[2]["id"],))
    def capture(db,*args):
        values=list(original(db,*args))
        with ThreadPoolExecutor(max_workers=1) as executor: executor.submit(writer).result(timeout=10)
        yield from values
    monkeypatch.setattr(inventory,"_records",capture)
    result=get(subject).json()
    assert result["account_version"] == subject[2]["version"] and result["coverage"]["account_receipts"] == 1
    assert result["records"][0]["currentness"]["current"] is True


def test_session_transition_refuses_mixed_inventory(sample, monkeypatch):
    subject, _ = sample
    call = 0
    def changed():
        nonlocal call
        call += 1
        return subject[1][-1] if call == 1 else "2099-01-01"
    monkeypatch.setattr(inventory.sessions,"latest_completed_session",changed)
    response=get(subject)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "inventory_observation_session_changed"


def test_same_configuration_across_incompatible_bases_is_not_combined_into_one_population(sample):
    subject, first = sample
    second = save((subject[0],subject[1],subject[2],saved(subject[0],subject[1])))
    second = rewrite(second,lambda p:p["evidence"].update(history_fingerprint="e"*64))
    value=get(subject).json()
    assert len(value["groups"]) == 2 and value["coverage"]["configurations_within_groups"] == 2
    assert value["coverage"]["duplicate_configuration_groups"] == 0
    assert len({r["configuration_fingerprint"] for r in value["records"]}) == 1
    assert len({r["basis_fingerprint"] for r in value["records"]}) == 2
    assert all(g["receipt_count"]==g["distinct_configurations"]==1 for g in value["groups"])
    assert set(r["id"] for r in value["records"]) == {first["id"],second["id"]}


def test_normalized_saved_settings_have_exact_cscv_distinctness_and_no_performance_payload(sample):
    subject, first=sample
    second=save((subject[0],subject[1],subject[2],saved(subject[0],subject[1],constraints={"max_positions":1,"max_position_weight_pct":20,"cash_buffer_pct":20})))
    value=get(subject).json()
    original={receipt["id"]:receipt for receipt in (first,second)}
    assert len(value["groups"]) == 1 and value["groups"][0]["distinct_configurations"] == 2
    for record in value["records"]:
        payload=original[record["id"]]["receipt"]
        assert record["configuration"] == cscv._configuration(payload)
        assert record["configuration_fingerprint"] == receipts._hash(cscv._configuration(payload))
        checks=comparison._basis(payload,payload)
        assert all(item["matches"] for item in checks)
        assert record["basis_summary"]["facts"] == {item["code"]:item["baseline"] for item in checks}
        assert record["basis_summary"]["facts"]["required_metrics"] is True
        assert "return_pct" not in receipts._json(record) and "final_value" not in receipts._json(record)


def test_global_capacity_is_enforced_without_deleting_foreign_or_local_rows(sample):
    subject, receipt=sample
    for index in range(250): clone(receipt["id"],f"{index:064x}",account_id=f"{index//50+1:032x}")
    before=rows()
    response=get(subject)
    assert response.status_code==413 and response.json()["detail"]["code"]=="inventory_receipt_count_limit"
    assert rows()==before


def test_receipt_with_missing_configuration_dependency_remains_visible_unavailable(sample):
    subject,receipt=sample
    rewrite(receipt,lambda payload:payload["saved_workflow"].pop("workflow_kind"))
    response=get(subject)
    assert response.status_code==200,response.text
    value=response.json()
    assert len(value["records"])==1 and value["groups"]==[]
    assert value["records"][0]["category"]=="unavailable_path"
    assert value["records"][0]["configuration"] is None
    assert value["records"][0]["reasons"]==["inventory_configuration_unavailable"]
