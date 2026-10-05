"""Offline reconstruction of synthetic saved local-model evidence; no runtime calls."""
import json
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from alphaview.panel import local_agent as local, paper_portfolio as paper
from alphaview.panel import portfolio_agent as agent, sessions, store
from tests.test_local_agent import account, complete, counts, output, setup


def receipt(setup, identifier):
    response = setup["client"].get(f"/api/local-agent/runs/{identifier}/integrity")
    assert response.status_code == 200, response.text
    return response.json()


def saved_row(identifier):
    with store.connect() as db:
        return local._row(db, identifier)


def replace_json(identifier, column, change):
    row = saved_row(identifier)
    value = json.loads(row[column])
    change(value)
    with store.connect() as db:
        db.execute(f"UPDATE local_agent_runs SET {column}=? WHERE id=?", (json.dumps(value), identifier))


def old_v1_authorization(row):
    """The established persisted authorization format, independent of the new verifier."""
    with store.connect() as db:
        rule = agent._run(db, row["source_run_id"])
    source = json.loads(row["source_json"])
    result = json.loads(row["result_json"])
    immutable = {"request": json.loads(row["request_json"]), "source": source,
                 "facts": json.loads(row["facts_json"]), "model": json.loads(row["model_json"]),
                 "result": result, "prompt_digest": row["prompt_digest"], "schema_digest": row["schema_digest"]}
    authorization = {"method_version": "alphaview-local-agent-historical-authorization-v1",
                     "analysis_id": row["id"], "engine_version": row["engine_version"],
                     **({"account_context": source["account_context"]} if source.get("account_context") else {}),
                     "source_run_id": rule["id"], "source_engine_version": rule["engine_version"],
                     "scan_engine_version": rule["scan"]["engine_version"], "as_of": row["as_of"],
                     "input_revision": row["input_revision"], "target_weights": result["target_weights"],
                     "source_fingerprint": rule["proposal_fingerprint"], "analysis_fingerprint": local._hash(immutable)}
    return {**authorization, "authorization_fingerprint": local._hash(authorization)}


def test_offline_receipt_is_readonly_and_preserves_v1_authorization_and_valid_proposal_path(setup, monkeypatch):
    owner = account(setup)
    run = complete(setup)
    original = saved_row(run["id"])
    frozen = old_v1_authorization(original)
    before = counts(), store.input_revision()
    monkeypatch.setattr(local, "_ollama", lambda *args, **kwargs: pytest.fail("Offline verification called Ollama"))
    monkeypatch.setattr(local, "_model", lambda *args, **kwargs: pytest.fail("Offline verification inspected live model"))
    with patch.object(local, "init_schema", side_effect=AssertionError("Read-only verification mutated schema")):
        result = receipt(setup, run["id"])
        assert result == receipt(setup, run["id"])
    assert result["engine_version"] == "alphaview-local-agent-integrity-v1"
    assert result["verified"] and result["status"] == "verified" and result["proposal_eligible"]
    assert result["source_currentness"] == {"current": True, "stale_reasons": []}
    assert all(check["status"] == "passed" and check["reason"] is None for check in result["checks"])
    assert result["citation_coverage"] == {"claims": 5, "claims_with_valid_references": 5,
        "citations": 5, "known_citations": 5, "unknown_ids": [], "duplicate_citations": 0, "coverage_pct": 100}
    assert result["authorization_fingerprint"] == frozen["authorization_fingerprint"]
    assert "raw_content" not in json.dumps(result)
    assert saved_row(run["id"]) == original
    assert (counts(), store.input_revision()) == before
    binding = {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION}
    with store.connect() as db:
        assert local._json(local.validate_historical_source(db, binding)) == local._json(frozen)
        assert local.validate_source(db, binding)["target_weights"] == run["target_weights"]
    bridge = {"account_id": owner["id"], "expected_account_version": owner["version"]}
    preview = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview", json=bridge)
    assert preview.status_code == 200 and preview.json()["paper_preview"]["executable"]
    proposal = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-proposal",
                                  json={**bridge, "idempotency_key": "synthetic-integrity-proposal"})
    assert proposal.status_code == 201
    assert proposal.json()["paper_proposal"]["status"] == "proposed"
    assert counts()["paper_ledger"] == before[0]["paper_ledger"]


@pytest.mark.parametrize("fault,stage,reason", [
    ("fact_reference", "structured_output", "output_validation_failed"),
    ("numeric_claim", "structured_output", "output_validation_failed"),
    ("raw_output", "output_digest", "output_digest_mismatch"),
    ("targets", "result_replay", "result_replay_mismatch"),
    ("views", "result_replay", "result_replay_mismatch"),
    ("facts", "saved_facts", "saved_facts_mismatch"),
    ("source", "source_binding", "source_binding_mismatch"),
    ("rules", "rules_fingerprint", "rules_fingerprint_mismatch"),
    ("prompt_digest", "prompt_digest", "prompt_digest_mismatch"),
    ("schema_digest", "schema_digest", "schema_digest_mismatch"),
    ("request_hash", "saved_request", "saved_request_mismatch"),
    ("output_digest", "output_digest", "output_digest_mismatch"),
])
def test_receipt_and_current_proposal_guard_reject_saved_evidence_tampering(setup, monkeypatch, fault, stage, reason):
    owner = account(setup)
    run = complete(setup)
    identifier = run["id"]
    if fault in ("fact_reference", "numeric_claim", "raw_output", "targets", "views", "output_digest"):
        def change(result):
            if fault == "fact_reference":
                changed = output()
                changed["roles"][0]["findings"][0]["evidence_ids"] = ["invented:fact"]
                result["raw_content"] = json.dumps(changed)
            elif fault == "numeric_claim":
                result["raw_content"] = json.dumps({**output(), "predicted_price": 999})
            elif fault == "raw_output":
                result["raw_content"] += " "
            elif fault == "targets":
                result["target_weights"][0]["weight_pct"] = 99
            elif fault == "views":
                result["role_views"][0]["findings"][0]["text"] = "Invented finding"
            elif fault == "output_digest":
                result["output_digest"] = "0" * 64
        replace_json(identifier, "result_json", change)
    elif fault == "facts":
        replace_json(identifier, "facts_json", lambda facts: facts[0].update(value=999))
    elif fault == "source":
        replace_json(identifier, "source_json", lambda source: source.update(cash_weight_pct=99))
    elif fault == "rules":
        with store.connect() as db:
            rule = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (run["source_run_id"],)).fetchone()[0])
            rule["cash_weight_pct"] = 99
            db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (json.dumps(rule), run["source_run_id"]))
    else:
        with store.connect() as db:
            db.execute(f"UPDATE local_agent_runs SET {fault}=? WHERE id=?", ("0" * 64, identifier))
    before = saved_row(identifier), counts(), store.input_revision()
    monkeypatch.setattr(local, "_ollama", lambda *args, **kwargs: pytest.fail("Tamper check called model"))
    result = receipt(setup, identifier)
    assert not result["verified"] and not result["proposal_eligible"] and result["status"] == "failed"
    failed = next(check for check in result["checks"] if check["status"] == "failed")
    assert (failed["code"], failed["reason"]["code"]) == (stage, reason)
    if fault == "fact_reference":
        assert result["citation_coverage"]["claims_with_valid_references"] == 4
        assert result["citation_coverage"]["unknown_ids"] == ["invented:fact"]
        assert "invalid_citation" in result["validation_issues"]
    if fault == "numeric_claim":
        assert result["validation_issues"] == ["invalid_model_schema"]
        assert result["citation_coverage"] is None
        assert "predicted_price" not in json.dumps(result)
    if fault == "targets":
        assert "target_weights" in failed["mismatched_fields"]
    for action in ("paper-preview", "paper-proposal"):
        body = {"account_id": owner["id"], "expected_account_version": owner["version"]}
        if action == "paper-proposal": body["idempotency_key"] = "synthetic-tampered-proposal"
        response = setup["client"].post(f"/api/local-agent/runs/{identifier}/{action}", json=body)
        assert response.status_code == 409, response.text
    assert (saved_row(identifier), counts(), store.input_revision()) == before


def test_stale_historical_evidence_can_verify_without_becoming_a_current_source(setup, monkeypatch):
    owner = account(setup)
    run = complete(setup)
    before = receipt(setup, run["id"])
    with store.connect() as db:
        db.execute("INSERT INTO bars VALUES ('SYNTA','2024-01-05',101,111,91,101,101,1000)")
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    result = receipt(setup, run["id"])
    assert result["verified"] and result["status"] == "verified"
    assert result["authorization_fingerprint"] == before["authorization_fingerprint"]
    assert not result["proposal_eligible"] and not result["source_currentness"]["current"]
    response = setup["client"].post(f"/api/local-agent/runs/{run['id']}/paper-preview",
        json={"account_id": owner["id"], "expected_account_version": owner["version"]})
    assert response.status_code == 409


def test_account_policy_currentness_is_separate_from_saved_integrity(setup):
    owner = account(setup)
    setup["source"] = agent.create_run(agent.WorkflowInput(scope="market", candidate_symbols=["SYNTA", "SYNTB"],
        account_context={"account_id": owner["id"], "expected_policy_version": 1}))
    run = complete(setup)
    paper.update_controls(owner["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))
    result = receipt(setup, run["id"])
    assert result["verified"] and not result["proposal_eligible"]
    assert not result["source_currentness"]["current"]
    with store.connect() as db, pytest.raises(HTTPException):
        local.validate_historical_source(db, {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION})


@pytest.mark.parametrize("fault", ["missing_raw", "missing_result", "malformed_source", "legacy_method"])
def test_missing_or_unreadable_legacy_proof_stays_unavailable_without_rewriting(setup, fault):
    run = complete(setup)
    if fault == "missing_raw":
        replace_json(run["id"], "result_json", lambda result: result.pop("raw_content"))
    else:
        column, value = {"missing_result": ("result_json", None), "malformed_source": ("source_json", "not-json"),
                         "legacy_method": ("engine_version", "unverifiable-legacy-v0")}[fault]
        with store.connect() as db:
            db.execute(f"UPDATE local_agent_runs SET {column}=? WHERE id=?", (value, run["id"]))
    before = saved_row(run["id"]), counts(), store.input_revision()
    result = receipt(setup, run["id"])
    assert result["status"] == "unavailable" and not result["verified"] and not result["proposal_eligible"]
    assert any(check["status"] == "unavailable" and check["reason"]["code"] != "prerequisite_unavailable" for check in result["checks"])
    with store.connect() as db, pytest.raises(HTTPException) as error:
        local.validate_source(db, {"analysis_id": run["id"], "engine_version": local.ENGINE_VERSION})
    assert error.value.status_code == 409
    assert (saved_row(run["id"]), counts(), store.input_revision()) == before
