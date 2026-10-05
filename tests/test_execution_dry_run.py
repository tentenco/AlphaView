"""Synthetic reducer invariants; these tests never initialize any workspace."""
import ast
import copy
from decimal import Decimal
from pathlib import Path

import pytest

from alphaview.panel import execution_dry_run as dry


def at(index=0):
    return f"2026-09-26T10:{index // 60:02d}:{index % 60:02d}Z"


def submit(index=0, response="acknowledged", request_id="submit-1", event_id="submit-ack"):
    value = {"action": "submit", "observed_at": at(index), "request_id": request_id, "response": response}
    if response != "timeout":
        value["event_id"] = event_id
    if response == "rejected":
        value["reason_code"] = "synthetic_rejection"
    return value


def cancel(index, response="acknowledged", request_id="cancel-1"):
    value = {"action": "cancel", "observed_at": at(index), "request_id": request_id, "response": response}
    if response != "timeout":
        value["event_id"] = request_id + "-event"
    if response == "rejected":
        value["reason_code"] = "synthetic_cancel_rejection"
    return value


def fill(index, quantity="2", price="100", execution_id=None, event_id=None, executed_at=None):
    execution_id = execution_id or f"execution-{index}"
    return {"action": "fill", "observed_at": at(index), "event_id": event_id or f"fill-event-{index}",
            "execution_id": execution_id, "quantity": quantity, "price": price, "executed_at": executed_at or at(index)}


def trace(steps=None, quantity="10"):
    return {"format_version": dry.TRACE_VERSION, "synthetic_only": True,
            "order": {"client_order_id": "synthetic-order-1", "symbol": "SYNTH", "side": "buy", "quantity": quantity, "currency": "USD"},
            "steps": steps or [submit()]}


def execution(step):
    return {key: step[key] for key in ("execution_id", "quantity", "price", "executed_at")}


def reconcile(index, state=None, fills=(), response="snapshot", order=None, event_id=None):
    value = {"action": "reconcile", "observed_at": at(index), "event_id": event_id or f"reconcile-{index}", "response": response}
    if response == "snapshot":
        order = order or trace()["order"]
        value["snapshot"] = {"client_order_id": order["client_order_id"],
            "order_fingerprint": dry.fingerprint(dry.Order.model_validate(order).model_dump()),
            "state": state, "executions": [execution(row) for row in fills]}
    return value


def test_exact_partial_full_amounts_status_and_stable_fingerprints():
    body = trace([submit(), fill(1, "2.5", "100.125"), {"action": "status", "observed_at": at(2)}, fill(3, "7.5", "101")])
    first, second = dry.replay_trace(body), dry.replay_trace(copy.deepcopy(body))
    assert first == second
    assert first["state"] == "filled" and first["order_terminal"] and first["execution_complete"]
    assert first["filled_quantity"] == "10" and first["working_quantity"] == "0"
    assert first["total_notional"] == "1007.8125" and first["average_price"] == "100.78125000"
    assert first["steps"][2]["revision_before"] == first["steps"][2]["revision_after"] == 2
    assert first["steps"][2]["status_snapshot"]["filled_quantity"] == "2.5"
    assert first["authority"] == "synthetic_fixture" and first["as_of_kind"] == "synthetic_observation_time"
    assert first["result_sha256"] == dry.fingerprint({key: value for key, value in first.items() if key != "result_sha256"})


@pytest.mark.parametrize("response,expected", [("acknowledged", "cancelled"), ("rejected", "partially_filled"), ("timeout", "unknown")])
def test_partial_cancel_retains_fills_and_distinguishes_uncertainty(response, expected):
    result = dry.replay_trace(trace([submit(), fill(1, "3"), cancel(2, response)]))
    assert result["state"] == expected and result["filled_quantity"] == "3"
    assert result["working_quantity"] == (None if expected == "unknown" else "0" if expected == "cancelled" else "7")
    assert result["execution_outcome_available"] is (expected != "unknown")


def test_timeout_and_not_found_never_authorize_new_submit_or_cancel():
    body = trace([submit(response="timeout"), submit(1, request_id="retry-new-key"),
        reconcile(2, response="not_found"), cancel(3),
        reconcile(4, "open"), submit(5, request_id="still-no-second-submit", event_id="later-ack")])
    result = dry.replay_trace(body)
    assert [row["reason_code"] for row in result["steps"]] == [
        "submit_outcome_unknown", "reconciliation_required", "not_found_is_not_absence_proof",
        "reconciliation_required", "synthetic_snapshot_reconciled", "already_submitted"]
    assert result["state"] == "open" and not result["order_terminal"]
    assert result["execution_count"] == 0 and result["order_revision"] == 3


def test_unknown_partial_stays_unavailable_until_complete_execution():
    partial = trace([submit(response="timeout"), fill(1, "4")])
    value = dry.replay_trace(partial)
    assert value["state"] == "unknown" and value["last_confirmed_state"] == "partially_filled"
    assert value["working_quantity"] is None and value["execution_outcome_available"] is False
    value = dry.replay_trace({**partial, "steps": partial["steps"] + [fill(2, "6")]})
    assert value["state"] == "filled" and value["uncertainty_reason"] is None


def test_cancel_timeout_followed_by_full_fill_and_terminal_cancel():
    result = dry.replay_trace(trace([submit(), cancel(1, "timeout"), fill(2, "10"), cancel(3, request_id="late-cancel")]))
    assert result["state"] == "filled" and result["execution_count"] == 1
    assert result["steps"][-1]["action_result"] == "blocked"
    assert result["steps"][-1]["reason_code"] == "terminal_state"


def test_duplicate_requests_events_and_executions_never_double_count():
    original = fill(1, "10")
    body = trace([submit(), {**submit(), "observed_at": at(1)}, original,
        {**original, "observed_at": at(2)}, {**original, "observed_at": at(3), "event_id": "different-delivery"}])
    result = dry.replay_trace(body)
    assert [row["reason_code"] for row in result["steps"]] == ["submit_acknowledged", "duplicate_request", "execution_applied", "duplicate_event", "duplicate_execution"]
    assert result["filled_quantity"] == "10" and result["execution_count"] == 1 and result["order_revision"] == 2


@pytest.mark.parametrize("kind", ["request", "event", "execution"])
def test_conflicting_reused_identity_rejects_entire_trace(kind):
    first = fill(1)
    if kind == "request":
        steps = [submit(), submit(1, response="rejected")]
    elif kind == "event":
        steps = [submit(), first, {**first, "observed_at": at(2), "quantity": "3"}]
    else:
        steps = [submit(), first, {**first, "observed_at": at(2), "event_id": "new-event", "price": "101"}]
    with pytest.raises(dry.DryRunError) as failure:
        dry.replay_trace(trace(steps))
    assert failure.value.detail["code"] == kind + "_identity_conflict"
    assert failure.value.detail["step_index"] == len(steps) - 1


def test_complete_snapshot_adds_exact_unseen_executions_and_resolves_cancel():
    a, b = fill(1, "3", "100"), fill(2, "2", "105")
    result = dry.replay_trace(trace([submit(), a, cancel(2, "timeout"), reconcile(3, "cancelled", [a, b])]))
    assert result["state"] == "cancelled" and result["filled_quantity"] == "5"
    assert result["total_notional"] == "510" and result["execution_count"] == 2
    assert result["working_quantity"] == "0" and result["unfilled_quantity"] == "5"


@pytest.mark.parametrize("fault,code", [
    ("missing_execution", "snapshot_execution_conflict"), ("changed_execution", "snapshot_execution_conflict"),
    ("order", "snapshot_order_mismatch"), ("fingerprint", "snapshot_order_mismatch"),
    ("overfill", "snapshot_state_conflict"), ("wrong_state", "snapshot_state_conflict"),
    ("rejected_after_acceptance", "snapshot_state_conflict"), ("duplicate_execution", "invalid_input"),
])
def test_snapshot_must_be_complete_consistent_and_match_order(fault, code):
    a = fill(1, "3")
    step = reconcile(3, "partially_filled", [a])
    snap = step["snapshot"]
    if fault == "missing_execution": snap["executions"] = []
    elif fault == "changed_execution": snap["executions"][0]["price"] = "99"
    elif fault == "order": snap["client_order_id"] = "another-order"
    elif fault == "fingerprint": snap["order_fingerprint"] = "0" * 64
    elif fault == "overfill": snap["executions"].append(execution(fill(2, "8")))
    elif fault == "wrong_state": snap["state"] = "filled"
    elif fault == "rejected_after_acceptance": snap.update(state="rejected", executions=[])
    else: snap["executions"].append(copy.deepcopy(snap["executions"][0]))
    steps = [submit(), step] if fault == "rejected_after_acceptance" else [submit(), a, step]
    with pytest.raises(dry.DryRunError) as failure:
        dry.replay_trace(trace(steps))
    assert failure.value.detail["code"] == code


def test_unknown_submit_can_reconcile_rejection_but_not_found_is_not_rejection():
    result = dry.replay_trace(trace([submit(response="timeout"), reconcile(1, response="not_found"), reconcile(2, "rejected")]))
    assert result["steps"][1]["state_after"] == "unknown"
    assert result["state"] == "rejected" and result["order_terminal"]


def test_terminal_snapshot_confirmation_or_unavailability_never_reopens():
    full = fill(1, "10")
    result = dry.replay_trace(trace([submit(), full, reconcile(2, "filled", [full]),
        reconcile(3, response="not_found"), reconcile(4, response="timeout")]))
    assert result["state"] == "filled" and result["order_revision"] == 2
    assert result["steps"][-1]["reason_code"] == "terminal_observation_unavailable"
    with pytest.raises(dry.DryRunError, match="terminal"):
        dry.replay_trace(trace([submit(), cancel(1), reconcile(2, "open")]))


@pytest.mark.parametrize("steps,code", [
    ([fill(0)], "order_not_submitted"),
    ([reconcile(0, "open")], "order_not_submitted"),
    ([submit(), fill(1, "11")], "overfill"),
    ([submit(), cancel(1), fill(2)], "terminal_fill_conflict"),
    ([submit(response="rejected"), fill(1)], "terminal_fill_conflict"),
    ([submit(1), fill(2, executed_at=at(0))], "execution_time_invalid"),
    ([submit(), fill(1, executed_at=at(2))], "execution_time_invalid"),
    ([submit(2), {"action": "status", "observed_at": at(1)}], "observation_time_reversed"),
])
def test_invalid_lifecycle_or_clock_rejected(steps, code):
    with pytest.raises(dry.DryRunError) as failure:
        dry.replay_trace(trace(steps))
    assert failure.value.detail["code"] == code


def test_late_execution_times_and_equal_arrivals_preserve_input_order():
    result = dry.replay_trace(trace([submit(), fill(3, "4", executed_at=at(2)), fill(3, "6", execution_id="earlier-fill", event_id="earlier-arrival", executed_at=at(1))]))
    assert result["state"] == "filled"
    assert [row["filled_quantity"] for row in result["steps"]] == ["0", "4", "10"]


@pytest.mark.parametrize("quantity", [0, 1.5, True, "0", "-1", "1e2", "NaN", "Infinity", "1.0000001", "1000000001", "01"])
def test_quantity_must_be_explicit_bounded_decimal_string(quantity):
    with pytest.raises(dry.DryRunError) as failure:
        dry.replay_trace(trace(quantity=quantity))
    assert failure.value.detail["code"] == "invalid_input"


def test_precise_fractional_totals_average_rounding_and_boundary_values():
    result = dry.replay_trace(trace([submit(), fill(1, "0.000001", "0.00000001"), fill(2, "0.000002", "0.00000002")], quantity="0.000003"))
    assert result["total_notional"] == "0.00000000000005"
    assert result["average_price"] == "0.00000002"
    maximum = dry.replay_trace(trace([submit(), fill(1, "1000000000", "1000000000")], quantity="1000000000"))
    assert maximum["total_notional"] == "1000000000000000000"
    assert Decimal(maximum["filled_quantity"]) == Decimal(maximum["requested_quantity"])


@pytest.mark.parametrize("change", ["synthetic_number", "endpoint", "too_many_steps", "bad_timezone", "extra_account", "overprecise_price"])
def test_schema_rejects_provider_fields_bad_clock_and_oversized_shapes(change):
    body = trace()
    if change == "synthetic_number": body["synthetic_only"] = 1
    elif change == "endpoint": body["endpoint"] = "https://synthetic.invalid"
    elif change == "too_many_steps": body["steps"] = [{"action": "status", "observed_at": at()}] * 201
    elif change == "bad_timezone": body["steps"][0]["observed_at"] = "2026-09-26T10:00:00+08:00"
    elif change == "extra_account": body["order"]["paper_account_id"] = "forbidden"
    else: body["steps"].append(fill(1, price="1.000000001"))
    with pytest.raises(dry.DryRunError): dry.replay_trace(body)


def test_execution_limit_is_not_silently_truncated():
    with pytest.raises(dry.DryRunError) as failure:
        dry.replay_trace(trace([submit()] + [fill(index, "1") for index in range(1, 102)], quantity="200"))
    assert failure.value.detail["code"] == "execution_limit"


def test_receipt_unknown_is_inspectable_hashes_cover_input_and_result_without_replay(monkeypatch):
    receipt = dry.make_receipt(trace([submit(response="timeout")]), at(20))
    assert receipt["content"]["result"]["state"] == "unknown"
    assert receipt["content"]["result"]["execution_outcome_available"] is False
    monkeypatch.setattr(dry, "replay_trace", lambda _: pytest.fail("Receipt inspection must not replay"))
    assert dry.verify_receipt(receipt) == {"integrity_verified": True, "current_engine_supported": True}
    changed = copy.deepcopy(receipt)
    changed["content"]["result"]["state"] = "filled"
    with pytest.raises(dry.DryRunError): dry.verify_receipt(changed)


def test_reducer_has_no_workspace_provider_calendar_or_clock_dependencies():
    tree = ast.parse(Path(dry.__file__).read_text())
    imports = {node.module.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
    imports |= {alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    assert imports <= {"datetime", "decimal", "hashlib", "json", "re", "typing", "pydantic"}
