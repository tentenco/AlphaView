"""Persisted-only workflow comparisons; isolated synthetic records and no providers."""
from concurrent.futures import ThreadPoolExecutor
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from alphaview.panel import allocator, portfolio_agent as agent, research_validation, sessions, store
from alphaview.panel import workflow_comparison as comparison

DAY = "2026-10-01"
A, B = "synthetic-baseline", "synthetic-comparison"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "comparison.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: DAY)
    monkeypatch.setattr(requests.Session, "request", lambda *a, **k: pytest.fail("No network"))
    monkeypatch.setattr(agent, "preview", lambda *a, **k: pytest.fail("No rule recomputation"))
    monkeypatch.setattr(allocator, "allocate", lambda *a, **k: pytest.fail("No allocator recomputation"))
    monkeypatch.setattr(research_validation, "validate", lambda *a, **k: pytest.fail("No backtest recomputation"))
    store.init_db()
    app = FastAPI()
    app.include_router(comparison.router)
    with TestClient(app) as value:
        yield value


def record(**changes):
    return {"engine_version": agent.ENGINE_VERSION, "as_of": DAY, "input_revision": store.input_revision(),
            "proposal_fingerprint": "a" * 64, "status": "proposed",
            "request": agent.WorkflowInput(candidate_symbols=["SYNTA", "SYNTB"]).model_dump(),
            "scan": {"id": 1, "as_of": DAY, "engine_version": "alphaview-scan-v1"},
            "allocator": {"engine_version": "alphaview-allocator-v1", "method": "equal"},
            "candidates": [{"symbol": "SYNTA", "status": "selected", "score": 50},
                           {"symbol": "SYNTB", "status": "unselected", "score": 25}],
            "target_weights": [{"symbol": "SYNTA", "weight_pct": 20}], "cash_weight_pct": 80, **changes}


def save(identifier, value):
    with store.connect() as db:
        db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)",
                   (identifier, "synthetic-created", value.get("engine_version", agent.ENGINE_VERSION),
                    value.get("as_of", DAY), value.get("input_revision", "synthetic:unknown"), value.get("status", "proposed"),
                    json.dumps(value.get("request", {})), json.dumps(value)))


def compare(client, **changes):
    response = client.post("/api/portfolio-agent/compare", json={"baseline_run_id": A, "comparison_run_id": B, **changes})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def test_saved_values_settings_and_source_changes_are_separate_and_read_only(client):
    left = record()
    right = record(proposal_fingerprint="b" * 64, cash_weight_pct=75,
                   candidates=[{"symbol": "SYNTA", "status": "selected", "score": 75}, {"symbol": "SYNTB", "status": "selected", "score": 50}],
                   target_weights=[{"symbol": "SYNTA", "weight_pct": 15}, {"symbol": "SYNTB", "weight_pct": 10}])
    right["request"]["constraints"]["min_score"] = 25
    right["scan"]["id"] = 2
    save(A, left); save(B, right)
    revision = store.input_revision()
    with store.connect() as db:
        before = [tuple(row) for row in db.execute("SELECT * FROM portfolio_agent_runs ORDER BY id")]
    result = compare(client)
    assert result["engine_version"] == comparison.ENGINE_VERSION
    assert result["baseline"]["proposal_fingerprint"] == "a" * 64 and result["comparison"]["proposal_fingerprint"] == "b" * 64
    assert result["baseline"]["current"] is True and result["comparison"]["current"] is True
    rows = {row["symbol"]: row for row in result["rows"]}
    assert rows["SYNTA"]["score_delta"] == {"known": True, "value": 25, "reason": None}
    assert rows["SYNTA"]["weight_delta_pp"]["value"] == -5
    assert rows["SYNTB"]["baseline"]["weight_pct"] == {"known": False, "value": None, "reason": "not_recorded"}
    assert rows["SYNTB"]["weight_delta_pp"]["value"] is None
    assert result["cash"]["delta_pp"]["value"] == -5
    assert result["selected"]["only_in_comparison"] == ["SYNTB"]
    assert next(item for item in result["settings"] if item["field"] == "constraints.min_score")["status"] == "changed"
    assert next(item for item in result["sources"] if item["field"] == "scan.id")["status"] == "changed"
    assert not result["comparability"]["performance_comparison"] and "performance" not in result
    assert store.input_revision() == revision
    with store.connect() as db:
        assert [tuple(row) for row in db.execute("SELECT * FROM portfolio_agent_runs ORDER BY id")] == before
        assert db.execute("SELECT COUNT(*) FROM paper_proposals").fetchone()[0] == 0


def test_explicit_zero_is_comparable_but_absent_candidate_and_weight_are_unknown(client):
    save(A, record(candidates=[{"symbol": "SYNTA", "status": "selected", "score": 0}],
                   target_weights=[{"symbol": "SYNTA", "weight_pct": 0}], cash_weight_pct=100))
    save(B, record(candidates=[{"symbol": "SYNTA", "status": "selected", "score": 20}, {"symbol": "SYNTB", "status": "selected", "score": 30}],
                   target_weights=[{"symbol": "SYNTA", "weight_pct": 10}, {"symbol": "SYNTB", "weight_pct": 20}], cash_weight_pct=70))
    result = compare(client)
    first, missing = result["rows"]
    assert first["baseline"]["weight_pct"]["value"] == first["baseline"]["score"]["value"] == 0
    assert first["weight_delta_pp"]["value"] == 10 and first["score_delta"]["value"] == 20
    assert missing["baseline"]["status"]["value"] is None and missing["baseline"]["candidate_recorded"] is False
    assert missing["score_delta"]["value"] is None and missing["weight_delta_pp"]["value"] is None


def test_blocked_allocation_is_not_cash_or_weight_zero_but_candidate_scores_remain_visible(client):
    save(A, record(status="blocked", cash_weight_pct=None, target_weights=[]))
    save(B, record())
    result = compare(client)
    assert not result["comparability"]["baseline_allocation"]
    assert result["cash"]["baseline"]["reason"] == "allocation_unavailable" and result["cash"]["delta_pp"]["value"] is None
    assert result["rows"][0]["baseline"]["weight_pct"]["reason"] == "allocation_unavailable"
    assert result["rows"][0]["baseline"]["score"]["value"] == 50 and result["rows"][0]["score_delta"]["value"] == 0


def test_historical_and_method_changed_values_are_displayed_without_inventing_score_comparability(client):
    save(A, record(engine_version="alphaview-portfolio-agent-historical", as_of="2026-09-30", input_revision="synthetic:old"))
    right = record(allocator={"engine_version": "alphaview-allocator-next", "method": "score_tilt"},
                   target_weights=[{"symbol": "SYNTA", "weight_pct": 12.34567891}])
    save(B, right)
    result = compare(client)
    assert result["baseline"]["current"] is False and result["comparison"]["current"] is True
    assert set(result["baseline"]["stale_reasons"]) == {"engine_changed", "session_changed", "inputs_changed"}
    assert result["rows"][0]["baseline"]["score"]["value"] == 50
    assert result["rows"][0]["score_delta"] == {"known": False, "value": None, "reason": "method_changed"}
    assert result["rows"][0]["weight_delta_pp"]["value"] == -7.65432109
    assert result["comparability"]["weight_delta_semantics"] == "saved_percentage_point_arithmetic_only"
    assert next(item for item in result["sources"] if item["field"] == "allocator.engine_version")["status"] == "changed"


def test_legacy_missing_candidates_settings_and_identity_are_unknown_not_defaulted(client):
    left = record(candidates=None, target_weights=None, request={"scope": "market"})
    del left["engine_version"]
    del left["proposal_fingerprint"]
    save(A, left); save(B, record())
    result = compare(client)
    assert result["baseline"]["current"] is None and result["baseline"]["proposal_fingerprint"] is None
    assert result["selected"]["baseline"] is None and result["selected"]["only_in_comparison"] is None
    assert result["coverage"]["baseline_candidates"] is None
    allocation = next(item for item in result["settings"] if item["field"] == "constraints.allocation_method")
    assert allocation["baseline"]["value"] is None and allocation["status"] == "unknown"
    assert result["rows"][0]["baseline"]["score"]["value"] is None


@pytest.mark.parametrize("value", [None, True, "50", float("nan"), float("inf"), -1, 101, 10 ** 500])
def test_invalid_numeric_evidence_stays_unknown_and_finite(client, value):
    save(A, record(candidates=[{"symbol": "SYNTA", "status": "selected", "score": value}],
                   target_weights=[{"symbol": "SYNTA", "weight_pct": value}], cash_weight_pct=value))
    save(B, record())
    result = compare(client)
    assert result["rows"][0]["baseline"]["score"]["value"] is None
    assert result["rows"][0]["baseline"]["weight_pct"]["value"] is None
    assert result["cash"]["baseline"]["value"] is None


@pytest.mark.parametrize("body", [
    {"baseline_run_id": A, "comparison_run_id": A}, {"baseline_run_id": "../bad", "comparison_run_id": B},
    {"baseline_run_id": 1, "comparison_run_id": B}, {"baseline_run_id": "x" * 101, "comparison_run_id": B},
    {"baseline_run_id": A, "comparison_run_id": B, "apply": True},
])
def test_ids_and_body_are_strict(client, body):
    assert client.post("/api/portfolio-agent/compare", json=body).status_code == 422


def test_missing_run_returns_404(client):
    save(A, record())
    assert client.post("/api/portfolio-agent/compare", json={"baseline_run_id": A, "comparison_run_id": B}).status_code == 404


@pytest.mark.parametrize("fault", ["too_many", "duplicate", "union", "invalid_symbol"])
def test_saved_record_bounds_refuse_without_partial_truncation(client, fault):
    values = [{"symbol": f"SYN{i}", "status": "selected", "score": 50} for i in range(101)]
    left = record(candidates=values if fault == "too_many" else [values[0], values[0]] if fault == "duplicate" else values[:100], target_weights=[])
    if fault == "union":
        left["target_weights"] = [{"symbol": "EXTRA", "weight_pct": 1}]
    if fault == "invalid_symbol":
        left["candidates"] = [{"symbol": "bad/symbol", "status": "selected", "score": 50}]
    save(A, left); save(B, record())
    assert client.post("/api/portfolio-agent/compare", json={"baseline_run_id": A, "comparison_run_id": B}).status_code == 422


def test_two_saved_reads_and_currentness_share_one_snapshot(client, monkeypatch):
    save(A, record()); save(B, record())
    old_revision = store.input_revision()
    original = comparison._load
    calls = []
    def load_then_write(db, identifier):
        value = original(db, identifier)
        calls.append(identifier)
        if len(calls) == 1:
            def write():
                with store.connect() as writer:
                    writer.execute("INSERT INTO bars VALUES ('SYNTA',?,100,101,99,100,100,1000)", (DAY,))
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(write).result(timeout=5)
        return value
    monkeypatch.setattr(comparison, "_load", load_then_write)
    result = compare(client)
    assert calls == [A, B]
    assert result["input_revision"] == old_revision and store.input_revision() != old_revision
    assert result["baseline"]["current"] is True and result["comparison"]["current"] is True


def test_missing_candidate_status_does_not_claim_empty_selected_set(client):
    save(A, record(candidates=[{"symbol": "SYNTA", "score": 50}]))
    save(B, record())
    result = compare(client)
    assert result["selected"]["baseline"] is None
    assert result["selected"]["only_in_baseline"] is None and result["selected"]["only_in_comparison"] is None
    assert result["rows"][0]["baseline"]["status"]["known"] is False
