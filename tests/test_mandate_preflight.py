"""Revoked authority stops before research, including when market inputs are absent."""
import pytest

from alphaview.panel import agent_automation as automation
from alphaview.panel import execution, paper_portfolio as paper, portfolio_agent as agent, store
from tests.test_mandate_lifecycle import (  # noqa: F401 (shared synthetic fixture)
    DAY1, DAY2, DAY3, account, get, mandate, run, seed, setup,
)


def revoke(item):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        automation.require_reauth(db, item["account_id"], "synthetic_reauthorization")


def counts():
    with store.connect() as db:
        return {
            "attempts": db.execute("SELECT count(*) FROM agent_automation_attempts").fetchone()[0],
            "runs": db.execute("SELECT count(*) FROM portfolio_agent_runs").fetchone()[0],
            "proposals": db.execute("SELECT count(*) FROM paper_proposals").fetchone()[0],
            "fills": db.execute("SELECT count(*) FROM paper_ledger WHERE kind='simulated_fill'").fetchone()[0],
            "nav": db.execute("SELECT count(*) FROM paper_nav_snapshots").fetchone()[0],
        }


def forbidden(*args, **kwargs):
    raise AssertionError("Revoked mandate reached research, a paid gate, or an action")


@pytest.mark.parametrize("revocation", ["expired", "reauth_required"])
@pytest.mark.parametrize("scheduled", [False, True])
@pytest.mark.parametrize("candidate_source", ["explicit", "scan_pool"])
def test_revoked_mandate_claims_blocked_day_before_any_research(
    setup, monkeypatch, revocation, scheduled, candidate_source,
):
    client, clock = setup
    options = {"expires_on": DAY1, "jev_gate": {"enabled": True}, "candidate_source": candidate_source}
    if candidate_source == "scan_pool":
        options["workflow"] = {"scope": "market", "candidate_symbols": []}
    item = mandate(client, account(client), **options)
    if revocation == "expired":
        clock["session"] = DAY2  # Deliberately do not seed current data.
    else:
        revoke(item)
        with store.connect() as db:
            db.execute("DELETE FROM scans")
    revision = store.input_revision()
    for module, name in ((automation, "_ready"), (agent, "preview"), (automation, "_jev_gate"),
                         (paper, "create_proposal_guarded"), (execution, "submit")):
        monkeypatch.setattr(module, name, forbidden)

    response = automation.tick()["results"][0] if scheduled else run(client, item).json()
    assert response["status"] == "blocked"
    attempt = response["attempt"]
    assert attempt["reason_code"] == "mandate_" + revocation
    assert attempt["result"]["mandate_lifecycle"]["lifecycle"] == revocation
    assert attempt["reason"] and attempt["finished_at"]
    assert attempt["trigger_kind"] == ("schedule" if scheduled else "manual")
    assert attempt["run_id"] == "" and attempt["paper_proposal_id"] is None
    assert attempt["input_revision"] == revision
    assert counts() == {"attempts": 1, "runs": 0, "proposals": 0, "fills": 0, "nav": 0}
    assert store.input_revision() == revision
    # A manual retry and a scheduler tick share the same durable daily claim.
    assert run(client, item).json()["attempt"]["id"] == attempt["id"]
    repeated = automation.tick()["results"][0]
    assert repeated["status"] == "already_attempted" and repeated["attempt"]["id"] == attempt["id"]
    assert counts()["attempts"] == 1
    saved = get(client, item)
    assert saved["last_attempt"]["id"] == attempt["id"]


@pytest.mark.parametrize("revocation", ["expired", "reauth_required"])
def test_renewal_preserves_daily_claim_and_allows_next_valid_session(setup, revocation):
    client, clock = setup
    acct = account(client)
    item = mandate(client, acct, expires_on=DAY1 if revocation == "expired" else None)
    clock["session"] = DAY2
    if revocation == "reauth_required":
        revoke(item)
    blocked = run(client, item).json()
    assert blocked["status"] == "blocked" and blocked["attempt"]["reason_code"] == "mandate_" + revocation
    renewed = client.post(f"/api/paper/accounts/{acct['id']}/mandates/{item['id']}/renew",
                          json={"expected_version": item["version"], "expires_on": DAY3, "acknowledge": True})
    assert renewed.status_code == 200, renewed.text
    fresh = renewed.json()["mandate"]
    assert run(client, item).status_code == 409
    assert run(client, fresh).json()["status"] == "already_attempted"
    clock["session"] = DAY3
    seed(DAY3)
    resumed = run(client, fresh)
    assert resumed.status_code == 200 and resumed.json()["status"] == "simulated", resumed.text
    assert counts() == {"attempts": 2, "runs": 1, "proposals": 1, "fills": 2, "nav": 1}


def test_reauthorization_during_research_blocks_before_saving_workflow(setup, monkeypatch):
    client, _ = setup
    item = mandate(client, account(client), jev_gate={"enabled": True})
    original = automation._ready

    def revoke_after_research(*args):
        result = original(*args)
        assert result[0] is not None
        revoke(item)
        return result

    monkeypatch.setattr(automation, "_ready", revoke_after_research)
    monkeypatch.setattr(automation, "_jev_gate", forbidden)
    response = run(client, item).json()
    assert response["status"] == "blocked" and response["attempt"]["reason_code"] == "mandate_reauth_required"
    assert counts() == {"attempts": 1, "runs": 0, "proposals": 0, "fills": 0, "nav": 0}


def test_reauthorization_after_gate_still_blocks_proposal_transaction(setup, monkeypatch):
    client, _ = setup
    item = mandate(client, account(client), jev_gate={"enabled": True})

    def revoke_after_gate(*args):
        revoke(item)
        return {"status": "pass", "evidence": {"target_weights": [{"symbol": "SYNTA", "weight_pct": 10}]}}

    monkeypatch.setattr(automation, "_jev_gate", revoke_after_gate)
    response = run(client, item).json()
    assert response["status"] == "invalidated"
    assert response["attempt"]["reason_code"] == "execution_revalidation_failed"
    assert "重新授權" in response["attempt"]["reason"]
    assert counts()["proposals"] == counts()["fills"] == 0
