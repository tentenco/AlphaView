"""Bounded, source-frozen synthetic paper workflows; no provider or live DB access.

One worker retains Python imports, calendar caches and locks across real wall
time. Each varied cycle uses a fresh temporary database; this is not a claim of
multi-hour same-database durability. Receipts contain aggregate checks only.
"""
import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import signal
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
ENGINE_VERSION = "alphaview-paper-workflow-soak-v1"
MANIFEST = "paper-workflow-source-manifest.json"
RECEIPTS = "paper-workflow-soak.jsonl"
SUMMARY = "paper-workflow-soak-summary.json"
RESERVE_SECONDS = 30
SYMBOLS = ["SYNTA", "SYNTB", "SYNTC"]


class InvariantFailure(AssertionError):
    pass


class Stopped(Exception):
    def __init__(self, reason):
        self.reason = reason


def utcnow():
    return datetime.now(timezone.utc)


def denied_network(*args, **kwargs):
    raise InvariantFailure("network_attempt")


def network_guard(stack):
    for target in ("socket.create_connection", "socket.getaddrinfo", "socket.socket.connect",
                   "socket.socket.connect_ex", "socket.socket.sendto"):
        stack.enter_context(patch(target, denied_network))


class Checks:
    def __init__(self, check):
        self.check = check
        self.count = 0
        self.groups = {}
        self.group = "setup"

    def require(self, condition, code):
        self.check()
        if not condition:
            raise InvariantFailure(code)
        self.count += 1
        self.groups[self.group] = self.groups.get(self.group, 0) + 1

    def conflict(self, action, code):
        from fastapi import HTTPException
        try:
            action()
        except HTTPException as exc:
            self.require(exc.status_code == 409, code)
        else:
            raise InvariantFailure(code)


def clean_environment():
    # Do not hand inherited provider credentials or a live PANEL_DB_PATH to a
    # child. Python's executable selects the existing venv without new installs.
    return {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ") if key in os.environ}


def reap(process, *, group=False):
    # A crashed worker may already have exited while its writer is still in the
    # owned process group. Terminate that group even after its leader has gone.
    if group:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM) if group else process.terminate()
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL) if group else process.kill()
            except ProcessLookupError:
                pass
    process.wait(timeout=2)
    if group:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def bounded_child(command, *, env, timeout, check=lambda: None):
    """Bound complete child execution/output and always reap after cancellation."""
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout
    try:
        while True:
            check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise InvariantFailure("child_timeout")
            try:
                output, _ = process.communicate(timeout=min(0.2, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0:
            raise InvariantFailure("child_exit")
        if len(output) > 4096:
            raise InvariantFailure("child_output_limit")
        try:
            result = json.loads(output)
        except (ValueError, UnicodeError):
            raise InvariantFailure("child_receipt_invalid") from None
        if result != {"status": "policy_updated", "network_disabled": True}:
            raise InvariantFailure("child_receipt_invalid")
        return result
    finally:
        reap(process)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()


def policy_writer(database, account_id, version):
    root = Path(os.environ.get("ALPHAVIEW_PAPER_SOAK_ROOT", "/missing-synthetic-root")).resolve()
    path = Path(database).resolve()
    if (not (root / ".synthetic-only").is_file() or not path.is_relative_to(root)
            or not path.is_file() or path.name != "synthetic.db"):
        raise InvariantFailure("writer_outside_synthetic_root")
    os.environ["PANEL_DB_PATH"] = str(path)
    with ExitStack() as stack:
        network_guard(stack)
        from alphaview.panel import paper_portfolio as paper
        paper.update_controls(account_id, paper.ControlsInput(expected_version=version,
            symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]}))
    print(json.dumps({"status": "policy_updated", "network_disabled": True}), flush=True)


def cycle(database, seed, *, subprocess_policy=False, check=lambda: None, child_timeout=15):
    """Real application functions with varied, explicitly synthetic inputs."""
    rng = random.Random(seed)
    checks = Checks(check)
    check()
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {"PANEL_DB_PATH": str(database)}))
        network_guard(stack)
        import pandas as pd
        from alphaview.panel import agent_automation as automation, paper_next_open as next_open
        from alphaview.panel import paper_portfolio as paper, portfolio_agent as agent, scan_provenance, sessions, store
        day = rng.choice(["2024-01-04", "2024-01-12", "2024-03-28", "2024-07-03", "2024-11-27"])
        cal = sessions.calendar(2024)
        clock = {"at": cal.session_close(pd.Timestamp(day)) + pd.Timedelta(minutes=30)}
        real_latest = sessions.latest_completed_session
        stack.enter_context(patch.object(sessions, "latest_completed_session", lambda at=None: real_latest(clock["at"] if at is None else at)))
        stack.enter_context(patch.object(automation, "utcnow", lambda: clock["at"].to_pydatetime()))
        stack.enter_context(patch.object(next_open, "utcnow", lambda: clock["at"].to_pydatetime()))
        stack.enter_context(patch.object(store, "now", lambda: clock["at"].isoformat()))
        store.init_db()
        prices = {symbol: rng.choice([7.125, 13.5, 25, 100, 250]) for symbol in SYMBOLS}
        with store.connect() as db:
            for symbol in SYMBOLS:
                db.execute("INSERT INTO market_universe VALUES (?,?,'synthetic','synthetic',1000000000)", (symbol, "Synthetic fixture"))
                db.execute("INSERT INTO datasets(symbol,currency,status) VALUES (?,'USD','ok')", (symbol,))

        def market(day):
            with store.connect() as db:
                for symbol, price in prices.items():
                    db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", (symbol, day, price, price * 1.02,
                        price * .98, price, price, 1000 + seed % 1000))
                rows = [{"symbol": symbol, "date": day, "bars": 250, "indicators": {"close": prices[symbol]},
                    "signals": [{"strategy": strategy, "status": "match" if index < 2 else "watch",
                        "matched": index < 2, "reason": "Synthetic evidence"} for index, strategy in enumerate(agent.STRATEGY_IDS)]}
                    for symbol in SYMBOLS]
                db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('synthetic',?,?,?,'market',?)",
                    (day, json.dumps(SYMBOLS), json.dumps(rows), scan_provenance.current_token(db)))

        market(day)
        accounts = []

        def account(label, **changes):
            # Leave a deliberate margin below account caps. Fractional-price
            # settlement can round equity by 1e-8; a target exactly at its cap
            # correctly becomes risk-blocked instead of exercising this case.
            changes.setdefault("limits", {"max_position_weight_pct": 50, "min_cash_weight_pct": 5, "max_turnover_pct": 200})
            value = paper.create_account(paper.AccountInput(name="Synthetic soak " + label,
                initial_cash=rng.choice([10000, 25000, 75000]), idempotency_key="soak-account-" + label, **changes))["account"]
            accounts.append(value["id"])
            return value

        def template(owner):
            return {"scope": "market", "candidate_symbols": SYMBOLS,
                "constraints": {"min_score": 50, "min_matches": 1, "max_positions": 2,
                    "max_position_weight_pct": 35, "cash_buffer_pct": 30},
                "account_context": {"account_id": owner["id"], "expected_policy_version": owner["symbol_policy"]["version"]}}

        def mandate(owner, label, drift=0, cooldown=None):
            return automation.create_mandate(automation.MandateInput(name="Synthetic soak " + label,
                account_id=owner["id"], workflow=template(owner), rebalance_trigger={"min_weight_drift_pp": drift,
                    "min_completed_sessions_between_fills": cooldown}))["mandate"]

        def run(item):
            return automation.run_mandate(item["id"], automation.RunInput(expected_version=item["version"]))

        def totals(owner):
            with store.connect() as db:
                return (db.execute("SELECT version FROM paper_accounts WHERE id=?", (owner,)).fetchone()[0],
                    db.execute("SELECT count(*) FROM paper_proposals WHERE account_id=?", (owner,)).fetchone()[0],
                    db.execute("SELECT count(*) FROM paper_ledger WHERE account_id=?", (owner,)).fetchone()[0])

        def enqueue(owner, proposal_id, key):
            source = next(item for item in next_open.list_orders(owner["id"])["source_proposals"] if item["id"] == proposal_id)
            body = next_open.EnqueueInput(proposal_id=proposal_id, expected_account_version=owner["version"],
                expected_proposal_fingerprint=source["proposal_fingerprint"], max_execution_cost_usd=1000,
                max_buy_cash_debit_usd=100000, confirm_next_open_simulation=True, idempotency_key=key)
            order = next_open.enqueue(owner["id"], body)
            checks.require(next_open.enqueue(owner["id"], body) == order, "enqueue_idempotency")
            return order

        checks.group = "skip_claim"
        skipped_owner = account("skip")
        skipped_task = mandate(skipped_owner, "skip", drift=100, cooldown=rng.randint(1, 252))
        skipped = run(skipped_task)
        checks.require(skipped["status"] == "skipped", "missing_skip")
        checks.require(run(skipped_task)["status"] == "already_attempted", "duplicate_session_claim")
        attempt = skipped["attempt"]
        source = {"mandate_id": skipped_task["id"], "mandate_version": skipped_task["version"], "attempt_id": attempt["id"]}
        before = totals(skipped_owner["id"])
        checks.conflict(lambda: paper.create_proposal(skipped_owner["id"], paper.ProposalInput(expected_version=1,
            targets=[{"symbol": "SYNTA", "weight_pct": 10}], automation_source=source,
            idempotency_key="soak-forged-skip")), "skip_source_authorized")
        checks.require(totals(skipped_owner["id"]) == before and before[1] == 0, "skip_wrote_proposal")
        checks.require(automation.attempts(skipped_task["id"], 20)["attempts"][0]["result"]["rebalance_trigger"]
                       == attempt["result"]["rebalance_trigger"], "skip_evidence_changed")

        checks.group = "tiny_denied_exposure"
        denied_owner = account("denied", symbol_policy={"mode": "allowlist", "symbols": ["SYNTA"]},
            execution_policy={"share_precision": 0, "min_trade_notional": rng.choice([1000, 2000, 5000])})
        before = totals(denied_owner["id"])
        preview = paper.preview(denied_owner["id"], paper.PreviewInput(expected_version=1,
            targets=[{"symbol": "SYNTB", "weight_pct": rng.choice([0.00000001, 0.000001, 0.0001])}]))
        checks.require(not preview["executable"] and any(item["code"] == "symbol_not_allowed" for item in preview["violations"]), "tiny_policy_bypass")
        checks.require(not preview["orders"] and preview["skipped_orders"], "tiny_case_not_subprecision")
        checks.require(totals(denied_owner["id"]) == before, "preview_mutated_account")

        checks.group = "policy_authorization"
        policy_owner = account("policy")
        task = mandate(policy_owner, "policy")
        old_run = agent.create_run(agent.WorkflowInput.model_validate(template(policy_owner)))
        policy_owner = paper.update_controls(policy_owner["id"], paper.ControlsInput(expected_version=1,
            symbol_policy={"mode": "allowlist", "symbols": ["SYNTB", "SYNTC"]}))["account"]
        checks.require(run(task)["status"] == "waiting", "changed_policy_claimed")
        checks.conflict(lambda: agent.paper_preview(old_run["id"], agent.PaperBridgeInput(account_id=policy_owner["id"],
            expected_account_version=policy_owner["version"])), "old_rules_policy_authorized")
        renamed = automation.update_mandate(task["id"], automation.MandatePatch(expected_version=task["version"], name="Synthetic renamed"))["mandate"]
        checks.require(renamed["symbol_policy_authorization"]["status"] == "stale", "rename_reauthorized_policy")
        acknowledged = automation.update_mandate(task["id"], automation.MandatePatch(expected_version=renamed["version"],
            workflow=template(policy_owner)))["mandate"]
        current = run(acknowledged)
        checks.require(current["status"] == "proposed", "acknowledged_policy_failed")
        with store.connect() as db:
            rules = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (current["attempt"]["run_id"],)).fetchone()[0])
        checks.require(rules["target_weights"] == [row for row in old_run["target_weights"] if row["symbol"] == "SYNTB"], "policy_redistributed_or_backfilled")

        checks.group = "next_open_cancel"
        cancelled_owner = account("cancel")
        proposal = paper.create_proposal(cancelled_owner["id"], paper.ProposalInput(expected_version=1,
            targets=[{"symbol": "SYNTA", "weight_pct": rng.choice([10, 20, 30])}], idempotency_key="soak-cancel-source"))
        order = enqueue(cancelled_owner, proposal["id"], "soak-cancel-enqueue")
        action = next_open.OrderActionInput(expected_order_version=order["version"], idempotency_key="soak-cancel-action")
        before = totals(cancelled_owner["id"])
        cancelled = next_open.cancel_order(cancelled_owner["id"], order["id"], action)
        checks.require(cancelled["status"] == "cancelled" and next_open.cancel_order(cancelled_owner["id"], order["id"], action) == cancelled, "cancel_idempotency")
        checks.conflict(lambda: next_open.process_order(cancelled_owner["id"], order["id"], next_open.OrderActionInput(
            expected_order_version=cancelled["version"], idempotency_key="soak-cancelled-process")), "cancelled_queue_processed")
        checks.require(totals(cancelled_owner["id"]) == before, "cancel_changed_account")

        checks.group = "concurrent_policy"
        if subprocess_policy:
            raced_owner = account("race")
            raced_task = mandate(raced_owner, "race")
            original_ready = automation._ready
            def readiness_race(*arguments):
                prepared = original_ready(*arguments)
                before = store.input_revision()
                with store.read_snapshot():
                    snapshot = paper.account_snapshot(raced_owner["id"])["account"]
                    env = clean_environment()
                    env["ALPHAVIEW_PAPER_SOAK_ROOT"] = os.environ["ALPHAVIEW_PAPER_SOAK_ROOT"]
                    bounded_child([sys.executable, str(Path(__file__).resolve()), "--policy-writer",
                        "--database", str(database), "--account", raced_owner["id"], "--version", str(snapshot["version"])],
                        env=env, timeout=child_timeout, check=check)
                    checks.require(paper.account_snapshot(raced_owner["id"])["account"] == snapshot, "snapshot_policy_leaked")
                checks.require(store.input_revision() == before, "policy_changed_market_revision")
                return prepared
            with patch.object(automation, "_ready", readiness_race):
                raced = run(raced_task)
            checks.require(raced["status"] == "changed", "concurrent_policy_claimed")
            checks.require(not automation.attempts(raced_task["id"], 20)["attempts"], "race_consumed_session")
            checks.require(automation.get_mandate(raced_task["id"])["mandate"]["symbol_policy_authorization"]["status"] == "stale", "race_authorization_not_stale")

        checks.group = "next_open_fill"
        filled_owner = account("fill")
        fill_task = mandate(filled_owner, "fill", cooldown=rng.randint(1, 252))
        first = run(fill_task)
        checks.require(first["status"] == "proposed", "first_fill_rejected")
        queued = enqueue(filled_owner, first["attempt"]["paper_proposal_id"], "soak-fill-enqueue")
        clock["at"] = cal.session_close(pd.Timestamp(queued["execution_session"])) + pd.Timedelta(minutes=30)
        market(queued["execution_session"])
        action = next_open.OrderActionInput(expected_order_version=queued["version"], idempotency_key="soak-fill-process")
        filled = next_open.process_order(filled_owner["id"], queued["id"], action)
        checks.require(filled["status"] == "filled", "next_open_not_filled")
        after_fill = totals(filled_owner["id"])
        checks.require(next_open.process_order(filled_owner["id"], queued["id"], action) == filled, "fill_receipt_changed")
        checks.require(totals(filled_owner["id"]) == after_fill and after_fill[0] == 2, "duplicate_next_open_fill")
        cooled = run(fill_task)
        evidence = cooled["attempt"]["result"]["rebalance_trigger"]
        checks.require(cooled["status"] == "skipped" and "cooldown_active" in evidence["reason_codes"], "cooldown_ignored_fill")
        checks.require(evidence["last_fill"]["queue_order_id"] == queued["id"]
            and evidence["last_fill"]["execution_session"] == queued["execution_session"]
            and evidence["completed_sessions_since_last_fill"] == 0, "cooldown_wrong_effective_day")
        checks.require(run(fill_task)["status"] == "already_attempted", "cooldown_duplicate_claim")

        checks.group = "readonly_revisions"
        before_revision = store.input_revision()
        before_accounts = {identifier: totals(identifier) for identifier in accounts}
        reads = 0
        for _ in range(rng.randint(2, 5)):
            check()
            json.dumps(automation.state(), allow_nan=False)
            reads += 1
            for identifier in accounts:
                for result in (paper.account_snapshot(identifier), paper.symbol_policy_history(identifier), next_open.list_orders(identifier)):
                    json.dumps(result, allow_nan=False)
                    reads += 1
        checks.require(store.input_revision() == before_revision, "readonly_changed_input_revision")
        checks.require({identifier: totals(identifier) for identifier in accounts} == before_accounts, "readonly_changed_account")
        checks.require(not automation.RUN_LOCK.locked(), "automation_lock_leaked")
        return {"checks": checks.count, "case_checks": checks.groups, "status_reads": reads,
                "subprocess_policy_edits": int(subprocess_policy), "synthetic_accounts": len(accounts)}


def atomic_summary(path, summary):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(summary, sort_keys=True, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def deadline_from(directory):
    value = json.loads((directory / "state.json").read_text())["deadline"]
    deadline = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if deadline.tzinfo is None or deadline.utcoffset() is None:
        raise ValueError("Harness deadline requires a timezone")
    return deadline.astimezone(timezone.utc) - timedelta(seconds=RESERVE_SECONDS)


def run(directory, stop_directory, seconds, interval, seed, *, cycles=None, child_timeout=15):
    deadline = deadline_from(stop_directory)
    started = time.monotonic()
    summary = {"engine_version": ENGINE_VERSION, "status": "running", "started_at": utcnow().isoformat(),
        "effective_deadline": deadline.isoformat(), "requested_seconds": seconds, "interval_seconds": interval,
        "seed_start": seed, "cycles": 0, "passed_cycles": 0, "interrupted_cycles": 0,
        "worker_pid": os.getpid(), "checks": 0, "status_reads": 0, "subprocess_policy_edits": 0,
        "failures": 0, "active_cycle_seconds": 0.0, "wall_seconds": 0.0, "sleep_seconds": 0.0,
        "source_frozen": True, "network_disabled": True, "synthetic_only": True,
        "database_lifetime": "fresh_temporary_database_per_cycle", "same_database_durability_claimed": False}
    manifest = json.loads((directory / MANIFEST).read_text())
    summary["source_snapshot_sha256"] = manifest["sha256"]
    with (directory / SUMMARY).open("x") as output:
        output.write(json.dumps(summary, indent=2) + "\n")
    reason = "duration"
    def check():
        if (stop_directory / "STOP").exists():
            raise Stopped("stop_marker")
        if utcnow() >= deadline:
            raise Stopped("harness_deadline")
        if time.monotonic() - started >= seconds:
            raise Stopped("duration")
    with (directory / RECEIPTS).open("x") as receipts, tempfile.TemporaryDirectory(prefix="alphaview-paper-soak-") as temporary:
        synthetic_root = Path(temporary)
        (synthetic_root / ".synthetic-only").write_text("synthetic test workspace\n")
        with patch.dict(os.environ, {"ALPHAVIEW_PAPER_SOAK_ROOT": temporary}):
            try:
                while True:
                    check()
                    cycle_started = time.monotonic()
                    record = {"at": utcnow().isoformat(), "cycle": summary["cycles"] + 1,
                              "seed": seed + summary["cycles"]}
                    try:
                        with tempfile.TemporaryDirectory(prefix="cycle-", dir=temporary) as folder:
                            details = cycle(Path(folder) / "synthetic.db", record["seed"],
                                subprocess_policy=summary["cycles"] % 3 == 2, check=check, child_timeout=child_timeout)
                        record.update(status="pass", **details)
                        for key in ("checks", "status_reads", "subprocess_policy_edits"):
                            summary[key] += details[key]
                    except Stopped as exc:
                        record.update(status="interrupted", stop_reason=exc.reason)
                        reason = exc.reason
                    except Exception as exc:
                        record.update(status="failure", error_type=type(exc).__name__)
                        if isinstance(exc, InvariantFailure):
                            record["error_code"] = str(exc)
                        summary["failures"] += 1
                        reason = "invariant_failure"
                    elapsed = time.monotonic() - cycle_started
                    record["active_seconds"] = round(elapsed, 6)
                    record["worker_uptime_seconds"] = round(time.monotonic() - started, 6)
                    summary["active_cycle_seconds"] += elapsed
                    summary["cycles"] += 1
                    summary["passed_cycles"] += int(record["status"] == "pass")
                    summary["interrupted_cycles"] += int(record["status"] == "interrupted")
                    receipts.write(json.dumps(record, sort_keys=True, allow_nan=False) + "\n")
                    receipts.flush()
                    print(json.dumps(record, sort_keys=True), flush=True)
                    summary["wall_seconds"] = round(time.monotonic() - started, 6)
                    atomic_summary(directory / SUMMARY, summary)
                    if record["status"] != "pass":
                        break
                    if cycles is not None and summary["cycles"] >= cycles:
                        reason = "cycle_limit"
                        break
                    until = min(started + seconds, cycle_started + interval)
                    sleep_started = time.monotonic()
                    try:
                        while time.monotonic() < until:
                            check()
                            time.sleep(min(0.2, until - time.monotonic()))
                    finally:
                        summary["sleep_seconds"] += time.monotonic() - sleep_started
            except Stopped as exc:
                reason = exc.reason
            except BaseException:
                reason = "worker_interrupted"
                raise
            finally:
                status = ("failed" if summary["failures"] else "interrupted" if summary["interrupted_cycles"] or reason == "worker_interrupted"
                          else "completed" if reason in ("duration", "cycle_limit") else "stopped")
                summary.update(status=status,
                    stop_reason=reason, ended_at=utcnow().isoformat(), wall_seconds=round(time.monotonic() - started, 6))
                summary["active_cycle_seconds"] = round(summary["active_cycle_seconds"], 6)
                summary["sleep_seconds"] = round(summary["sleep_seconds"], 6)
                atomic_summary(directory / SUMMARY, summary)
    print(json.dumps(summary, sort_keys=True), flush=True)
    return summary


def freeze_source(directory):
    hashes = {}
    for path in sorted((ROOT / "alphaview").rglob("*.py")) + [Path(__file__).resolve()]:
        if "__pycache__" in path.parts:
            continue
        relative = path.relative_to(ROOT)
        payload = path.read_bytes()
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        hashes[str(relative)] = hashlib.sha256(payload).hexdigest()
    if any(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() != digest for relative, digest in hashes.items()):
        raise ValueError("Source changed while freezing; retry after edits settle")
    return {"engine_version": ENGINE_VERSION, "sha256": hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
            "files": hashes, "created_at": utcnow().isoformat(), "frozen": True, "content": "python_source_only"}


def frozen_run(args):
    directory, stop_directory = args.directory.resolve(), args.stop_directory.resolve()
    deadline = deadline_from(stop_directory)
    # A new directory is the exclusive ownership token, including the manifest.
    # Do not merge receipts into an existing directory, even an apparently empty one.
    directory.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="alphaview-paper-source-") as temporary:
        frozen = Path(temporary)
        manifest = freeze_source(frozen)
        with (directory / MANIFEST).open("x") as output:
            output.write(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        command = [sys.executable, str(frozen / "scripts/paper_workflow_soak.py"), "--frozen-source",
            "--directory", str(directory), "--stop-directory", str(stop_directory), "--seconds", str(args.seconds),
            "--interval", str(args.interval), "--seed", str(args.seed), "--child-timeout", str(args.child_timeout)]
        if args.cycles is not None:
            command.extend(["--cycles", str(args.cycles)])
        process = subprocess.Popen(command, cwd=frozen, env=clean_environment(), start_new_session=True)
        forced = None
        try:
            while process.poll() is None:
                if (stop_directory / "STOP").exists() or utcnow() >= deadline or time.monotonic() - started > args.seconds + 5:
                    # Worker checks every case and during writer waits. A bounded
                    # grace period allows its partial-cycle receipt to be saved.
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        forced = "supervisor_stop_or_timeout"
                        break
                time.sleep(0.1)
        except BaseException:
            forced = "supervisor_interrupted"
            raise
        finally:
            reap(process, group=True)
            summary_path = directory / SUMMARY
            previous = json.loads(summary_path.read_text()) if summary_path.exists() else {}
            if forced or process.returncode != 0 and previous.get("status") != "failed" or previous.get("status") == "running":
                previous.update(status="interrupted", stop_reason=forced or "worker_exit", ended_at=utcnow().isoformat(),
                                wall_seconds=round(time.monotonic() - started, 6), source_snapshot_sha256=manifest["sha256"])
                atomic_summary(summary_path, previous)
        return 1 if forced or process.returncode != 0 else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--stop-directory", type=Path)
    parser.add_argument("--seconds", type=float, default=18000)
    parser.add_argument("--interval", type=float, default=45)
    parser.add_argument("--seed", type=int, default=20260929)
    parser.add_argument("--cycles", type=int)
    parser.add_argument("--child-timeout", type=float, default=15)
    parser.add_argument("--frozen-source", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--policy-writer", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--database", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--account", help=argparse.SUPPRESS)
    parser.add_argument("--version", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.policy_writer:
        policy_writer(args.database, args.account, args.version)
        return 0
    if (args.directory is None or args.stop_directory is None or not math.isfinite(args.seconds)
            or not 0 < args.seconds <= 18000 or not math.isfinite(args.interval) or not 0 < args.interval <= 60
            or not math.isfinite(args.child_timeout) or not 0 < args.child_timeout <= 60
            or args.cycles is not None and args.cycles < 1):
        parser.error("Require output/stop directories and finite bounded duration, interval, child timeout and cycles")
    if not args.frozen_source:
        return frozen_run(args)
    summary = run(args.directory, args.stop_directory, args.seconds, args.interval, args.seed,
                  cycles=args.cycles, child_timeout=args.child_timeout)
    return 1 if summary["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
