"""Pure synthetic execution traces. No account, provider, clock or transport imports.

Commands consume supplied fixture responses. They cannot submit an external order.
"""
from datetime import datetime
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
import hashlib
import json
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ENGINE_VERSION = "alphaview-execution-dry-run-v1"
TRACE_VERSION = "alphaview-execution-dry-run-trace-v1"
RECEIPT_VERSION = "alphaview-execution-dry-run-receipt-v1"
MAX_INPUT_BYTES = 256 * 1024
MAX_RECEIPT_BYTES = 4 * 1024 * 1024
MAX_EXECUTIONS = 100
TERMINAL = frozenset(("filled", "cancelled", "rejected"))
METHOD = (
    "Single-order synthetic fixture replay; no transport, broker, market data, account or portfolio ledger. "
    "Arrival order is input order with nondecreasing UTC observations. Unknown outcomes require reconciliation; "
    "a not-found observation never authorizes resubmission. Unique executions determine exact decimal quantities "
    "and notionals; average price is displayed to 8 decimals using ROUND_HALF_EVEN. "
    "Late new fills after a terminal cancellation are unsupported and rejected."
)
Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")]
Timestamp = Annotated[str, Field(min_length=20, max_length=27)]


class DryRunError(ValueError):
    def __init__(self, code, message, *, step_index=None, field=None, validation_code=None):
        super().__init__(message)
        self.detail = {"code": code, "message": message}
        for key, value in (("step_index", step_index), ("field", field), ("validation_code", validation_code)):
            if value is not None:
                self.detail[key] = value


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def decimal_text(value):
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def _amount(value, precision):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1," + str(precision) + r"})?", value):
        raise ValueError("Use a bounded positive decimal string without exponent notation")
    parsed = Decimal(value)
    if not 0 < parsed <= Decimal("1000000000"):
        raise ValueError("Decimal amount must be positive and at most 1000000000")
    return decimal_text(parsed)


def _timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value):
        raise ValueError("An explicit UTC timestamp ending in Z is required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.isoformat().replace("+00:00", "Z")


def _instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Order(StrictModel):
    client_order_id: Identifier
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9][A-Z0-9.\-^=]{0,19}$")
    side: Literal["buy", "sell"]
    quantity: str
    currency: Literal["USD"]

    @field_validator("symbol", mode="before")
    @classmethod
    def normalize_symbol(cls, value):
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("quantity", mode="before")
    @classmethod
    def valid_quantity(cls, value):
        return _amount(value, 6)


class Execution(StrictModel):
    execution_id: Identifier
    quantity: str
    price: str
    executed_at: Timestamp

    @field_validator("quantity", mode="before")
    @classmethod
    def valid_quantity(cls, value):
        return _amount(value, 6)

    @field_validator("price", mode="before")
    @classmethod
    def valid_price(cls, value):
        return _amount(value, 8)

    @field_validator("executed_at", mode="before")
    @classmethod
    def valid_time(cls, value):
        return _timestamp(value)


class Step(StrictModel):
    observed_at: Timestamp

    @field_validator("observed_at", mode="before")
    @classmethod
    def valid_time(cls, value):
        return _timestamp(value)


class Submit(Step):
    action: Literal["submit"]
    request_id: Identifier
    response: Literal["acknowledged", "rejected", "timeout"]
    event_id: Identifier | None = None
    reason_code: Literal["synthetic_rejection", "synthetic_invalid_order"] | None = None

    @model_validator(mode="after")
    def response_fields(self):
        if (self.response == "timeout") != (self.event_id is None):
            raise ValueError("Only acknowledged/rejected responses require an event ID")
        if (self.response == "rejected") != (self.reason_code is not None):
            raise ValueError("Only rejected responses require a rejection reason")
        return self


class Cancel(Step):
    action: Literal["cancel"]
    request_id: Identifier
    response: Literal["acknowledged", "rejected", "timeout"]
    event_id: Identifier | None = None
    reason_code: Literal["synthetic_cancel_rejection"] | None = None

    @model_validator(mode="after")
    def response_fields(self):
        if (self.response == "timeout") != (self.event_id is None):
            raise ValueError("Only acknowledged/rejected responses require an event ID")
        if (self.response == "rejected") != (self.reason_code is not None):
            raise ValueError("Only rejected responses require a rejection reason")
        return self


class Status(Step):
    action: Literal["status"]


class Fill(Step, Execution):
    action: Literal["fill"]
    event_id: Identifier


class Snapshot(StrictModel):
    client_order_id: Identifier
    order_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    state: Literal["open", "partially_filled", "filled", "cancelled", "rejected"]
    executions: list[Execution] = Field(max_length=MAX_EXECUTIONS)

    @field_validator("executions")
    @classmethod
    def unique_executions(cls, values):
        if len({value.execution_id for value in values}) != len(values):
            raise ValueError("Snapshot execution IDs must be unique")
        return sorted(values, key=lambda value: value.execution_id)


class Reconcile(Step):
    action: Literal["reconcile"]
    event_id: Identifier
    response: Literal["snapshot", "not_found", "timeout"]
    snapshot: Snapshot | None = None

    @model_validator(mode="after")
    def snapshot_required(self):
        if (self.response == "snapshot") != (self.snapshot is not None):
            raise ValueError("Exactly a snapshot response requires its complete snapshot")
        return self


TraceStep = Annotated[Submit | Cancel | Status | Fill | Reconcile, Field(discriminator="action")]


class TraceInput(StrictModel):
    format_version: Literal[TRACE_VERSION]
    synthetic_only: Literal[True]
    order: Order
    steps: list[TraceStep] = Field(min_length=1, max_length=200)

    @field_validator("synthetic_only", mode="before")
    @classmethod
    def explicit_synthetic(cls, value):
        if value is not True:
            raise ValueError("synthetic_only must be the boolean true")
        return value


def parse_trace(value):
    try:
        return TraceInput.model_validate(value)
    except ValidationError as exc:
        first = exc.errors(include_input=False, include_context=False)[0]
        raise DryRunError("invalid_input", "Synthetic trace fields failed validation",
                          field=".".join(str(part) for part in first["loc"]), validation_code=first["type"]) from None


def _execution(step):
    return {key: getattr(step, key) for key in Execution.model_fields}


class _Replay:
    def __init__(self, order):
        self.order = order.model_dump()
        self.quantity = Decimal(order.quantity)
        self.order_fingerprint = fingerprint(self.order)
        self.state = "not_submitted"
        self.last_confirmed_state = "not_submitted"
        self.uncertainty_reason = None
        self.first_submit_at = None
        self.accepted_confirmed = False
        self.revision = 0
        self.requests = {}
        self.events = {}
        self.executions = {}

    def quantity_filled(self):
        return sum((Decimal(row["quantity"]) for row in self.executions.values()), Decimal(0))

    def totals(self):
        quantity = self.quantity_filled()
        notional = sum((Decimal(row["quantity"]) * Decimal(row["price"]) for row in self.executions.values()), Decimal(0))
        working = None if self.state == "unknown" else self.quantity - quantity if self.state in ("open", "partially_filled") else Decimal(0)
        return {"requested_quantity": decimal_text(self.quantity), "filled_quantity": decimal_text(quantity),
                "unfilled_quantity": decimal_text(self.quantity - quantity),
                "working_quantity": decimal_text(working) if working is not None else None,
                "total_notional": decimal_text(notional),
                "average_price": format((notional / quantity).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_EVEN), "f") if quantity else None,
                "execution_count": len(self.executions)}

    def core(self):
        return {"state": self.state, "last_confirmed_state": self.last_confirmed_state,
                "uncertainty_reason": self.uncertainty_reason, "first_submit_at": self.first_submit_at,
                "accepted_confirmed": self.accepted_confirmed,
                "executions": {key: dict(value) for key, value in self.executions.items()}}

    def set_known(self, state):
        self.state = self.last_confirmed_state = state
        self.uncertainty_reason = None
        if state in ("open", "partially_filled", "filled", "cancelled"):
            self.accepted_confirmed = True

    def set_unknown(self, reason):
        self.state = "unknown"
        self.uncertainty_reason = reason

    def dedupe(self, cache, identifier, payload, kind):
        if identifier not in cache:
            return False
        if cache[identifier] != payload:
            raise DryRunError(f"{kind}_identity_conflict", f"The same {kind} identity carries different content")
        return True

    def validate_execution(self, execution, observed_at):
        if self.first_submit_at is None:
            raise DryRunError("order_not_submitted", "Executions require an earlier submit attempt")
        if not _instant(self.first_submit_at) <= _instant(execution["executed_at"]) <= _instant(observed_at):
            raise DryRunError("execution_time_invalid", "Execution time must be between first submit and observation")

    def apply_fill(self, step):
        execution = _execution(step)
        self.validate_execution(execution, step.observed_at)
        if self.dedupe(self.executions, step.execution_id, execution, "execution"):
            return "duplicate", "duplicate_execution"
        if self.state in TERMINAL:
            raise DryRunError("terminal_fill_conflict", "New executions after a terminal state are unsupported")
        if len(self.executions) >= MAX_EXECUTIONS:
            raise DryRunError("execution_limit", "A trace supports at most 100 unique executions")
        quantity = self.quantity_filled() + Decimal(step.quantity)
        if quantity > self.quantity:
            raise DryRunError("overfill", "Executions exceed the immutable order quantity")
        self.executions[step.execution_id] = execution
        self.accepted_confirmed = True
        if quantity == self.quantity:
            self.set_known("filled")
        elif self.state == "unknown":
            self.last_confirmed_state = "partially_filled"
        else:
            self.set_known("partially_filled")
        return "applied", "execution_applied"

    def apply_reconcile(self, step):
        if self.first_submit_at is None:
            raise DryRunError("order_not_submitted", "Reconciliation requires an earlier submit attempt")
        if step.response != "snapshot":
            if self.state in TERMINAL:
                return "observed", "terminal_observation_unavailable"
            self.set_unknown("not_found_is_not_absence_proof" if step.response == "not_found" else "reconcile_outcome_unknown")
            return "applied", self.uncertainty_reason
        snapshot = step.snapshot
        if snapshot.client_order_id != self.order["client_order_id"] or snapshot.order_fingerprint != self.order_fingerprint:
            raise DryRunError("snapshot_order_mismatch", "Snapshot identity and order fingerprint must match the original order")
        executions = {row.execution_id: row.model_dump() for row in snapshot.executions}
        for execution in executions.values():
            self.validate_execution(execution, step.observed_at)
        if any(executions.get(key) != value for key, value in self.executions.items()):
            raise DryRunError("snapshot_execution_conflict", "A complete snapshot cannot omit or alter a known execution")
        quantity = sum((Decimal(row["quantity"]) for row in executions.values()), Decimal(0))
        valid = {"open": quantity == 0, "partially_filled": 0 < quantity < self.quantity,
                 "filled": quantity == self.quantity, "cancelled": 0 <= quantity < self.quantity,
                 "rejected": quantity == 0 and not self.accepted_confirmed}
        if quantity > self.quantity or not valid[snapshot.state]:
            raise DryRunError("snapshot_state_conflict", "Snapshot state is inconsistent with complete executions and prior acceptance")
        if self.state in TERMINAL:
            if snapshot.state != self.state or executions != self.executions:
                raise DryRunError("terminal_snapshot_conflict", "A terminal order accepts only an identical complete snapshot")
            return "observed", "terminal_snapshot_confirmed"
        self.executions = executions
        self.set_known(snapshot.state)
        return "applied", "synthetic_snapshot_reconciled"

    def apply(self, step):
        payload = step.model_dump(exclude_none=True, exclude={"observed_at"})
        if isinstance(step, (Submit, Cancel)):
            if self.dedupe(self.requests, step.request_id, payload, "request"):
                return "duplicate", "duplicate_request"
            self.requests[step.request_id] = payload
        event_id = getattr(step, "event_id", None)
        event_payload = {key: value for key, value in payload.items() if key != "event_id"}
        if event_id and self.dedupe(self.events, event_id, event_payload, "event"):
            return "duplicate", "duplicate_event"
        if isinstance(step, Status):
            return "observed", "local_state_observed"
        if isinstance(step, Submit):
            if self.state == "unknown":
                return "blocked", "reconciliation_required"
            if self.first_submit_at is not None:
                return "blocked", "terminal_state" if self.state in TERMINAL else "already_submitted"
            self.first_submit_at = step.observed_at
            if step.response == "timeout":
                self.set_unknown("submit_outcome_unknown")
            else:
                self.set_known("open" if step.response == "acknowledged" else "rejected")
            result = ("applied", self.uncertainty_reason or step.reason_code or "submit_acknowledged")
        elif isinstance(step, Cancel):
            if self.state == "unknown":
                return "blocked", "reconciliation_required"
            if self.state not in ("open", "partially_filled"):
                return "blocked", "terminal_state" if self.state in TERMINAL else "order_not_submitted"
            if step.response == "acknowledged":
                self.set_known("cancelled")
            elif step.response == "timeout":
                self.set_unknown("cancel_outcome_unknown")
            result = ("applied" if step.response != "rejected" else "observed",
                      self.uncertainty_reason or step.reason_code or "cancel_acknowledged")
        elif isinstance(step, Fill):
            result = self.apply_fill(step)
        else:
            result = self.apply_reconcile(step)
        if event_id:
            self.events[event_id] = event_payload
        return result


def replay_trace(value):
    trace = value if isinstance(value, TraceInput) else parse_trace(value)
    normalized = trace.model_dump(exclude_none=True)
    if len(canonical(normalized).encode("utf-8")) > MAX_INPUT_BYTES:
        raise DryRunError("input_too_large", "Normalized synthetic input exceeds 256 KiB")
    replay = _Replay(trace.order)
    observations = []
    prior_time = None
    with localcontext() as context:
        context.prec = 50
        for index, step in enumerate(trace.steps):
            observed = _instant(step.observed_at)
            if prior_time is not None and observed < prior_time:
                raise DryRunError("observation_time_reversed", "Observations must be nondecreasing in input order", step_index=index)
            prior_time = observed
            before, revision = replay.core(), replay.revision
            try:
                action_result, reason = replay.apply(step)
            except DryRunError as exc:
                exc.detail["step_index"] = index
                raise
            if replay.core() != before:
                replay.revision += 1
            observations.append({"step_index": index, "action": step.action, "observed_at": step.observed_at,
                "action_result": action_result, "reason_code": reason, "state_before": before["state"],
                "state_after": replay.state, "revision_before": revision, "revision_after": replay.revision,
                "filled_quantity": replay.totals()["filled_quantity"],
                "working_quantity": replay.totals()["working_quantity"],
                **{key: getattr(step, key) for key in ("request_id", "event_id", "execution_id") if getattr(step, key, None)},
                **({"status_snapshot": replay.totals(), "uncertainty_reason": replay.uncertainty_reason} if isinstance(step, Status) else {})})
        result = {"engine_version": ENGINE_VERSION, "synthetic_only": True, "authority": "synthetic_fixture",
            "input_sha256": fingerprint(normalized), "order": replay.order, "order_fingerprint": replay.order_fingerprint,
            "as_of": trace.steps[-1].observed_at, "as_of_kind": "synthetic_observation_time",
            "trace_evaluated": True, "order_terminal": replay.state in TERMINAL,
            "state": replay.state, "last_confirmed_state": replay.last_confirmed_state,
            "uncertainty_reason": replay.uncertainty_reason, "order_revision": replay.revision,
            "execution_complete": replay.state == "filled", "execution_outcome_available": replay.state != "unknown",
            **replay.totals(), "steps": observations,
            "executions": [replay.executions[key] for key in sorted(replay.executions)],
            "network_used": False, "paper_ledger_written": False, "broker_connected": False, "method": METHOD}
    result["result_sha256"] = fingerprint(result)
    return result


def make_receipt(value, created_at):
    trace = value if isinstance(value, TraceInput) else parse_trace(value)
    content = {"input": trace.model_dump(exclude_none=True), "result": replay_trace(trace)}
    result = {"format_version": RECEIPT_VERSION, "engine_version": ENGINE_VERSION,
              "scope": "synthetic_execution_dry_run_only", "synthetic_only": True,
              "network_used": False, "paper_ledger_written": False, "broker_connected": False,
              "created_at": _timestamp(created_at), "content": content, "content_sha256": fingerprint(content),
              "hash_method": "SHA-256 of UTF-8 JSON; sorted keys, compact separators, ensure_ascii=false"}
    if len(canonical(result).encode("utf-8")) > MAX_RECEIPT_BYTES:
        raise DryRunError("receipt_too_large", "Receipt exceeds 4 MiB; no partial receipt is published")
    return result


def verify_receipt(value):
    """Integrity only. Never replay an old receipt using the current engine."""
    try:
        if (not isinstance(value, dict) or value["format_version"] != RECEIPT_VERSION
                or value["scope"] != "synthetic_execution_dry_run_only" or value["synthetic_only"] is not True
                or any(value[key] is not False for key in ("network_used", "paper_ledger_written", "broker_connected"))):
            raise ValueError()
        _timestamp(value["created_at"])
        content = value["content"]
        result = content["result"]
        if (fingerprint(content) != value["content_sha256"] or fingerprint(content["input"]) != result["input_sha256"]
                or result["engine_version"] != value["engine_version"]
                or fingerprint({key: item for key, item in result.items() if key != "result_sha256"}) != result["result_sha256"]
                or content["input"]["synthetic_only"] is not True or result["synthetic_only"] is not True
                or any(result[key] is not False for key in ("network_used", "paper_ledger_written", "broker_connected"))):
            raise ValueError()
    except (KeyError, TypeError, ValueError, OverflowError):
        raise DryRunError("receipt_integrity_failed", "Receipt identity, synthetic boundary or content hashes do not match") from None
    return {"integrity_verified": True, "current_engine_supported": value["engine_version"] == ENGINE_VERSION}
