"""Synthetic exact-arithmetic and fill-lineage tests for cadence gates."""
import json
from decimal import Decimal

import pytest
from pydantic import ValidationError

from alphaview.panel import paper_portfolio as paper, rebalance_trigger as trigger, sessions, store

AS_OF = "2024-01-16"


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "trigger.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: AS_OF)
    store.init_db()
    account = paper.create_account(paper.AccountInput(name="Synthetic trigger", initial_cash=1000,
                                                    idempotency_key="synthetic-trigger-account"))["account"]
    with store.connect() as db:
        for symbol in ("SYNTA", "SYNTB"):
            db.execute("INSERT INTO bars VALUES (?,?,100,110,90,100,100,1000)", (symbol, AS_OF))
            db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))
    return account


def evaluate(account, *, drift=0, cooldown=None, targets=None, preflight=None, status="proposed"):
    mandate = {"id": "synthetic-mandate", "account_id": account["id"],
               "rebalance_trigger_json": json.dumps({"min_weight_drift_pp": drift,
                                                       "min_completed_sessions_between_fills": cooldown})}
    run = {"status": status, "proposal_fingerprint": "synthetic-source-fingerprint", "target_weights": targets if targets is not None else [
        {"symbol": "SYNTA", "weight_pct": 25}, {"symbol": "SYNTB", "weight_pct": 25}]}
    with store.read_snapshot(), store.connect() as db:
        return trigger.evaluate(db, mandate, run, preflight or {"executable": True, "orders": [{"synthetic": True}],
                                                              "skipped_orders": [], "violations": []}, AS_OF)


@pytest.mark.parametrize("changes", [
    {"min_weight_drift_pp": "1"}, {"min_weight_drift_pp": True}, {"min_weight_drift_pp": float("nan")},
    {"min_weight_drift_pp": float("inf")}, {"min_weight_drift_pp": -1}, {"min_weight_drift_pp": 101},
    {"min_completed_sessions_between_fills": 0}, {"min_completed_sessions_between_fills": 253},
    {"min_completed_sessions_between_fills": 1.5}, {"min_completed_sessions_between_fills": "1"},
    {"min_completed_sessions_between_fills": True}, {"unknown": 1},
])
def test_policy_is_strict_finite_and_bounded(changes):
    with pytest.raises(ValidationError):
        trigger.Policy.model_validate({"min_weight_drift_pp": None, "min_completed_sessions_between_fills": None, **changes})


@pytest.mark.parametrize("policy", [{}, {"min_weight_drift_pp": None}, {"min_completed_sessions_between_fills": None}])
def test_policy_requires_both_keys(policy):
    with pytest.raises(ValidationError):
        trigger.Policy.model_validate(policy)


def test_cash_is_largest_component_and_threshold_equality_passes(workspace):
    before = store.input_revision()
    result = evaluate(workspace, drift=50)
    assert result["outcome"] == "pass"
    assert result["max_weight_drift_pp"] == 50
    assert result["components"][-1]["kind"] == "cash"
    assert result["components"][-1]["difference_pp"] == 50
    assert result["coverage"] == {"required": 2, "priced": 2, "missing": []}
    assert result["source_run_fingerprint"] == "synthetic-source-fingerprint"
    assert Decimal(result["max_drift_numerator_exact"]) == Decimal(50) * Decimal(result["equity_denominator_exact"])
    assert evaluate(workspace, drift=50.00000000000001)["outcome"] == "skip"
    assert store.input_revision() == before
    json.dumps(result, allow_nan=False)


def test_held_but_omitted_symbol_has_zero_target_without_redistribution(workspace):
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET cash='300' WHERE id=?", (workspace["id"],))
        db.execute("INSERT INTO paper_holdings VALUES (?,'SYNTA','4','400')", (workspace["id"],))
        db.execute("INSERT INTO paper_holdings VALUES (?,'SYNTB','3','300')", (workspace["id"],))
    result = evaluate(workspace, drift=30, targets=[{"symbol": "SYNTA", "weight_pct": 40}])
    by_symbol = {item["symbol"]: item for item in result["components"]}
    assert by_symbol["SYNTB"]["target_weight_pct"] == 0
    assert by_symbol["SYNTB"]["difference_pp"] == 30
    assert by_symbol[None]["target_weight_pct"] == 60
    assert result["outcome"] == "pass"


def test_decimal_quantity_and_cash_are_not_read_from_rounded_account_weights(workspace):
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET cash='0.00000001' WHERE id=?", (workspace["id"],))
        db.execute("INSERT INTO paper_holdings VALUES (?,'SYNTA','0.000001','0.0001')", (workspace["id"],))
    result = evaluate(workspace, drift=0, targets=[{"symbol": "SYNTA", "weight_pct": 100}])
    assert Decimal(result["equity_denominator_exact"]) == Decimal("0.00010001")
    assert Decimal(result["max_drift_numerator_exact"]) == Decimal("0.000001")
    assert result["max_weight_drift_pp"] > 0


@pytest.mark.parametrize("change", ["missing", "stale", "invalid", "non_usd"])
def test_missing_or_invalid_required_quote_stays_waiting(workspace, change):
    with store.connect() as db:
        if change == "missing":
            db.execute("DELETE FROM bars WHERE symbol='SYNTB'")
        elif change == "stale":
            db.execute("UPDATE bars SET date='2024-01-12' WHERE symbol='SYNTB'")
        elif change == "invalid":
            db.execute("UPDATE bars SET close=-1 WHERE symbol='SYNTB'")
        else:
            db.execute("UPDATE datasets SET currency='EUR' WHERE symbol='SYNTB'")
    result = evaluate(workspace)
    assert result["outcome"] == "waiting" and result["max_weight_drift_pp"] is None
    assert result["coverage"] == {"required": 2, "priced": 1, "missing": ["SYNTB"]}


def test_nonpositive_equity_stays_waiting(workspace):
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET cash='0' WHERE id=?", (workspace["id"],))
    assert evaluate(workspace)["reason_codes"] == ["nonpositive_equity"]


def test_disabled_preserves_prior_no_order_behavior_and_blocked_rules_are_never_targets(workspace):
    no_orders = {"executable": True, "orders": [], "skipped_orders": [{"reason": "share_precision"}], "violations": []}
    assert evaluate(workspace, drift=None, preflight=no_orders)["outcome"] == "disabled"
    skipped = evaluate(workspace, drift=0, preflight=no_orders)
    assert skipped["reason_codes"] == ["no_change"] and skipped["skipped_orders"] == no_orders["skipped_orders"]
    blocked = evaluate(workspace, status="blocked", targets=[])
    assert blocked["outcome"] == "blocked" and blocked["components"] == []


def test_risk_violation_takes_precedence_over_unmet_drift_and_no_orders(workspace):
    result = evaluate(workspace, drift=100, preflight={"executable": False, "orders": [],
        "skipped_orders": [], "violations": [{"code": "min_cash_weight", "message": "Synthetic limit"}]})
    assert result["outcome"] == "blocked" and result["reason_codes"] == ["paper_risk_blocked"]


def fill(day):
    return {"proposal_id": "synthetic-fill", "execution_session": day, "recorded_at": "synthetic"}


def test_cooldown_counts_sessions_after_fill_excluding_weekend_and_mlk_holiday():
    result = trigger.elapsed_sessions(fill("2024-01-12"), "2024-01-16", 2)
    assert result["completed_sessions_since_last_fill"] == 1 and result["passed"] is False
    assert trigger.elapsed_sessions(fill("2024-01-12"), "2024-01-16", 1)["passed"] is True
    assert trigger.elapsed_sessions(fill("2024-01-16"), "2024-01-16", 1)["completed_sessions_since_last_fill"] == 0


def test_first_fill_has_no_invented_elapsed_count_and_future_fill_waits():
    result = trigger.elapsed_sessions(None, AS_OF, 252)
    assert result["passed"] is True and result["completed_sessions_since_last_fill"] is None
    future = trigger.elapsed_sessions(fill("2024-01-17"), AS_OF, 1)
    assert future["waiting"] is True and future["passed"] is None


def test_very_old_fill_uses_bounded_lower_bound_without_six_year_calendar_failure():
    result = trigger.elapsed_sessions(fill("1990-01-02"), AS_OF, 252)
    assert result["passed"] is True and result["elapsed_sessions_exact"] is False
    assert result["completed_sessions_lower_bound"] == 252 and result["completed_sessions_since_last_fill"] is None


def synthetic_proposal(db, account_id, identifier, *, mandate="synthetic-mandate", day="2024-01-12", quantity="1", accepted="2024-01-18T00:00:00Z"):
    request = {"automation_source": {"mandate_id": mandate, "mandate_version": 1, "attempt_id": "synthetic-attempt"}}
    db.execute("INSERT INTO paper_proposals VALUES (?,?,'simulated',?,?,?,?)",
               (identifier, account_id, json.dumps({"as_of": day}), json.dumps(request), accepted, accepted))
    if quantity is not None:
        db.execute("""INSERT INTO paper_ledger(account_id,kind,symbol,shares_delta,cash_delta,cash_after,proposal_id,created_at)
            VALUES (?,'simulated_fill','SYNTA',?,'-100','900',?,?)""", (account_id, quantity, identifier, accepted))


def test_latest_fill_ignores_no_order_acceptance_zero_fill_and_other_mandates(workspace):
    with store.connect() as db:
        synthetic_proposal(db, workspace["id"], "real-fill", day="2024-01-11")
        synthetic_proposal(db, workspace["id"], "empty-accept", day="2024-01-12", quantity=None)
        synthetic_proposal(db, workspace["id"], "zero-fill", day="2024-01-12", quantity="0.000000")
        synthetic_proposal(db, workspace["id"], "other-mandate", day=AS_OF, mandate="other")
        result = trigger.latest_fill(db, "synthetic-mandate", workspace["id"])
    assert result["proposal_id"] == "real-fill" and result["execution_session"] == "2024-01-11"
    result = evaluate(workspace, drift=0, cooldown=3)
    assert result["outcome"] == "skip" and result["reason_codes"] == ["cooldown_active"]
    assert result["completed_sessions_since_last_fill"] == 2
    # Both enabled gates must pass independently.
    result = evaluate(workspace, drift=100, cooldown=3)
    assert result["reason_codes"] == ["drift_below_threshold", "cooldown_active"]


def test_next_open_lineage_uses_execution_session_not_signal_or_recording_day(workspace):
    with store.connect() as db:
        synthetic_proposal(db, workspace["id"], "source", quantity=None)
        synthetic_proposal(db, workspace["id"], "next-open-execution", mandate="ignored", day="2024-01-11")
        frozen = {"source_request": {"automation_source": {"mandate_id": "synthetic-mandate", "mandate_version": 1}}}
        db.execute("""INSERT INTO paper_next_open_orders
            (id,account_id,source_proposal_id,status,engine_version,signal_session,execution_session,enqueue_before,
             eligible_after,frozen_json,source_manifest_json,prefix_digest,prefix_rows,reason_code,reason,
             execution_proposal_id,created_at,updated_at,completed_at)
             VALUES ('synthetic-queue',?,'source','filled','alphaview-paper-next-open-v1','2024-01-11','2024-01-12',
             'synthetic','synthetic',?,'[]','synthetic',0,'filled','synthetic','next-open-execution','synthetic','synthetic','2024-01-18')""",
                   (workspace["id"], json.dumps(frozen)))
        result = trigger.latest_fill(db, "synthetic-mandate", workspace["id"])
    assert result["proposal_id"] == "next-open-execution" and result["queue_order_id"] == "synthetic-queue"
    assert result["execution_session"] == "2024-01-12" and result["recorded_at"].startswith("2024-01-18")
    assert evaluate(workspace, cooldown=2)["completed_sessions_since_last_fill"] == 1


def test_rebinding_account_has_independent_cadence_history(workspace):
    other = paper.create_account(paper.AccountInput(name="Synthetic other", initial_cash=1000,
                                                  idempotency_key="synthetic-other-account"))["account"]
    with store.connect() as db:
        synthetic_proposal(db, workspace["id"], "existing-fill")
        assert trigger.latest_fill(db, "synthetic-mandate", other["id"]) is None
    assert evaluate(other, cooldown=252)["outcome"] == "pass"
