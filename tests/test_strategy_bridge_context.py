"""Diagnosis settings remain bound to bridge validation; synthetic data only."""
import json

import pytest

from alphaview.panel import research_validation as validation, sessions, store
from tests.test_strategy_bridge import AS_OF, account, body, client, proposals  # noqa: F401
from tests.test_strategy_bridge_validation import SMA, losing_symbol  # noqa: F401


def context():
    days = sessions.expected_sessions("2020-01-02", AS_OF)
    return {
        "risk": {"initial_cash": 25000, "position_pct": 70, "fee_bps": 15,
                 "slippage_bps": 25, "stop_loss_pct": 6, "take_profit_pct": 12},
        "test_start": days[-350], "test_end": days[-21], "folds": 3, "trials": 7,
    }


def test_bridge_validates_the_diagnosed_window_and_risk(client, losing_symbol):
    acct, settings = account(), context()
    revision, count = store.input_revision(), proposals()
    expected = validation.validate_batch(validation.ValidateBatchInput(
        symbols=[losing_symbol], config=SMA, **settings))
    response = client.post("/api/research-desk/paper-preview", json={
        **body(acct, [losing_symbol]), "config": SMA, **settings,
        "validation": {"mode": "warn_only"},
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["validation"]["request"] == settings
    assert result["validation"]["items"] == expected["items"]
    assert result["validation"]["folds"] == 3 and result["validation"]["trials"] == 7
    assert result["as_of"] == AS_OF  # historical validation never changes today's signal session
    assert result["decisions"][0]["evidence"]["date"] == AS_OF
    assert result["input_revision"] == result["validation"]["input_revision"] == revision
    assert store.input_revision() == revision and proposals() == count
    json.dumps(result, allow_nan=False)


def test_saved_proposal_records_validation_context_and_same_key_replays(client, losing_symbol):
    acct, settings = account(), context()
    payload = {**body(acct, [losing_symbol]), "config": SMA, **settings,
               "validation": {"mode": "warn_only"}, "idempotency_key": "bridge-context-01"}
    response = client.post("/api/research-desk/paper-proposal", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    note = json.loads(result["paper_proposal"]["rationale"].split("validation=", 1)[1])
    assert note["request"] == settings
    replay = client.post("/api/research-desk/paper-proposal", json=payload)
    assert replay.status_code == 201
    assert replay.json()["paper_proposal"]["id"] == result["paper_proposal"]["id"]
    changed = client.post("/api/research-desk/paper-proposal", json={**payload, "folds": 4})
    assert changed.status_code == 409


@pytest.mark.parametrize("changes", [
    {"test_start": "2023-02-30"}, {"test_end": "not-a-date"},
    {"test_start": "2024-02-01", "test_end": "2024-01-01"},
    {"folds": 1}, {"folds": 9}, {"risk": {"fee_bps": -1}},
    {"risk": {"fee_bps": float("inf")}},
])
def test_invalid_validation_context_is_rejected(changes):
    from pydantic import ValidationError
    from alphaview.panel.strategy_bridge import BridgeInput
    with pytest.raises(ValidationError):
        BridgeInput(**body({"id": "synthetic", "version": 1}, ["SYNTA"]), **changes)


@pytest.mark.parametrize("endpoint,expected_status", [("paper-preview", 200), ("paper-proposal", 409)])
def test_validation_snapshot_is_consistent_and_publication_rechecks_revision(
    client, monkeypatch, endpoint, expected_status,
):
    """A concurrent data write may stale a preview but must never publish it."""
    import concurrent.futures
    from alphaview.panel import strategy_bridge
    acct, old_revision = account(), store.input_revision()
    original = strategy_bridge.validation_phase

    def validate_with_concurrent_write(request):
        def writer():
            with store.connect() as db:
                db.execute("UPDATE bars SET volume=volume+1 WHERE symbol='SYNTA'")
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(writer).result(timeout=10)
        return original(request)

    monkeypatch.setattr(strategy_bridge, "validation_phase", validate_with_concurrent_write)
    payload = {**body(acct, ["SYNTA"]), "validation": {"mode": "warn_only"}}
    if endpoint == "paper-proposal":
        payload["idempotency_key"] = "bridge-context-race"
    response = client.post(f"/api/research-desk/{endpoint}", json=payload)
    assert response.status_code == expected_status, response.text
    assert proposals() == 0
    assert store.input_revision() != old_revision
    if expected_status == 200:
        result = response.json()
        assert result["input_revision"] == result["validation"]["input_revision"] == old_revision
