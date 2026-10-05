"""Runner safety and meaningful synthetic workflow coverage, never a live DB."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from scripts import paper_workflow_soak as soak


def harness(path, *, stop=False, deadline=None):
    path.mkdir()
    (path / "state.json").write_text(json.dumps({"deadline": (deadline or datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}))
    if stop:
        (path / "STOP").write_text("synthetic stop\n")
    return path


def command(directory, stop_directory, *extra):
    return [sys.executable, str(Path(soak.__file__).resolve()), "--directory", str(directory),
            "--stop-directory", str(stop_directory), *extra]


def test_cycle_checks_real_policy_race_and_workflow_invariants(tmp_path, monkeypatch):
    inherited = tmp_path / "must-not-open.db"
    inherited.write_bytes(b"untouched inherited database sentinel")
    monkeypatch.setenv("PANEL_DB_PATH", str(inherited))
    root = tmp_path / "synthetic-root"
    root.mkdir()
    (root / ".synthetic-only").write_text("synthetic\n")
    monkeypatch.setenv("ALPHAVIEW_PAPER_SOAK_ROOT", str(root))
    result = soak.cycle(root / "synthetic.db", 91371, subprocess_policy=True)
    assert result["checks"] >= 30 and result["status_reads"] >= 30
    assert result["subprocess_policy_edits"] == 1 and result["synthetic_accounts"] == 6
    assert set(result["case_checks"]) == {"skip_claim", "tiny_denied_exposure", "policy_authorization",
        "next_open_cancel", "concurrent_policy", "next_open_fill", "readonly_revisions"}
    assert set(result) == {"checks", "case_checks", "status_reads", "subprocess_policy_edits", "synthetic_accounts"}
    assert inherited.read_bytes() == b"untouched inherited database sentinel"
    assert os.environ["PANEL_DB_PATH"] == str(inherited)


def test_frozen_three_cycle_run_varies_seed_preserves_evidence_and_never_inherited_db(tmp_path):
    inherited = tmp_path / "must-not-open.db"
    inherited.write_bytes(b"untouched inherited database sentinel")
    stop = harness(tmp_path / "harness")
    directory = tmp_path / "new-evidence"
    env = {**os.environ, "PANEL_DB_PATH": str(inherited), "SYNTHETIC_SECRET_SENTINEL": "do-not-forward"}
    args = command(directory, stop, "--seconds", "30", "--interval", "0.01", "--cycles", "3", "--seed", "712")
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=40)
    assert result.returncode == 0, result.stderr
    summary_bytes = (directory / soak.SUMMARY).read_bytes()
    manifest_bytes = (directory / soak.MANIFEST).read_bytes()
    summary = json.loads(summary_bytes)
    records = [json.loads(line) for line in (directory / soak.RECEIPTS).read_text().splitlines()]
    manifest = json.loads(manifest_bytes)
    assert summary["status"] == "completed" and summary["stop_reason"] == "cycle_limit"
    assert summary["cycles"] == summary["passed_cycles"] == 3 and summary["failures"] == summary["interrupted_cycles"] == 0
    assert summary["subprocess_policy_edits"] == 1 and summary["checks"] >= 80
    assert summary["wall_seconds"] >= summary["active_cycle_seconds"] > 0
    assert summary["source_frozen"] and summary["network_disabled"] and summary["synthetic_only"]
    assert summary["database_lifetime"] == "fresh_temporary_database_per_cycle" and not summary["same_database_durability_claimed"]
    assert [record["seed"] for record in records] == [712, 713, 714]
    assert all(record["status"] == "pass" for record in records)
    assert records[-1]["worker_uptime_seconds"] > records[0]["worker_uptime_seconds"]
    assert summary["source_snapshot_sha256"] == manifest["sha256"]
    assert "scripts/paper_workflow_soak.py" in manifest["files"]
    assert "alphaview/panel/agent_automation.py" in manifest["files"]
    assert "alphaview/panel/paper_next_open.py" in manifest["files"]
    assert all(path.endswith(".py") and not path.startswith(("data/", "artifacts/", "tests/")) for path in manifest["files"])
    assert inherited.read_bytes() == b"untouched inherited database sentinel"
    assert "do-not-forward" not in result.stdout + result.stderr
    repeated = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
    assert repeated.returncode != 0
    assert (directory / soak.SUMMARY).read_bytes() == summary_bytes and (directory / soak.MANIFEST).read_bytes() == manifest_bytes


@pytest.mark.parametrize("kind", ["stop", "deadline"])
def test_stop_and_deadline_prevent_any_cycle(tmp_path, kind):
    stop = harness(tmp_path / "harness", stop=kind == "stop",
        deadline=datetime.now(timezone.utc) - timedelta(seconds=1) if kind == "deadline" else None)
    directory = tmp_path / "stopped-evidence"
    result = subprocess.run(command(directory, stop, "--seconds", "2"), capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    summary = json.loads((directory / soak.SUMMARY).read_text())
    assert summary["status"] == "stopped" and summary["cycles"] == summary["checks"] == 0
    assert summary["stop_reason"] == ("stop_marker" if kind == "stop" else "harness_deadline")
    assert not (directory / soak.RECEIPTS).read_text()


def test_child_timeout_reaps_process_and_masks_child_output(tmp_path):
    pid_file = tmp_path / "child.pid"
    program = "import os,time,pathlib; pathlib.Path(" + repr(str(pid_file)) + ").write_text(str(os.getpid())); time.sleep(60)"
    started = time.monotonic()
    with pytest.raises(soak.InvariantFailure, match="child_timeout"):
        soak.bounded_child([sys.executable, "-c", program], env=soak.clean_environment(), timeout=0.5)
    assert time.monotonic() - started < 4
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_child_stop_reaps_process_promptly(tmp_path):
    pid_file = tmp_path / "child.pid"
    program = "import os,time,pathlib; pathlib.Path(" + repr(str(pid_file)) + ").write_text(str(os.getpid())); time.sleep(60)"
    def check():
        if pid_file.exists():
            raise soak.Stopped("synthetic_stop")
    with pytest.raises(soak.Stopped):
        soak.bounded_child([sys.executable, "-c", program], env=soak.clean_environment(), timeout=10, check=check)
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_runner_stops_on_first_invariant_failure_and_preserves_partial_status(tmp_path, monkeypatch):
    stop = harness(tmp_path / "harness")
    directory = tmp_path / "evidence"
    directory.mkdir()
    (directory / soak.MANIFEST).write_text(json.dumps({"sha256": "synthetic-source-sha"}))
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise soak.InvariantFailure("synthetic_failed_check")
    monkeypatch.setattr(soak, "cycle", fail)
    summary = soak.run(directory, stop, 5, .01, 1)
    assert len(calls) == 1 and summary["status"] == "failed" and summary["failures"] == 1
    record = json.loads((directory / soak.RECEIPTS).read_text())
    assert record["status"] == "failure" and record["error_code"] == "synthetic_failed_check"
    assert summary["passed_cycles"] == 0


def test_midcycle_stop_is_interrupted_not_passed(tmp_path, monkeypatch):
    stop = harness(tmp_path / "harness")
    directory = tmp_path / "evidence"
    directory.mkdir()
    (directory / soak.MANIFEST).write_text(json.dumps({"sha256": "synthetic-source-sha"}))
    def interrupt(*args, **kwargs):
        (stop / "STOP").write_text("synthetic stop\n")
        kwargs["check"]()
    monkeypatch.setattr(soak, "cycle", interrupt)
    summary = soak.run(directory, stop, 5, .01, 1)
    assert summary["status"] == "interrupted" and summary["passed_cycles"] == 0
    assert summary["interrupted_cycles"] == 1 and summary["failures"] == 0
    assert json.loads((directory / soak.RECEIPTS).read_text())["status"] == "interrupted"


def test_source_snapshot_hash_matches_exact_copied_source_and_ignores_other_files(tmp_path, monkeypatch):
    source = tmp_path / "source"
    (source / "alphaview").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "data").mkdir()
    (source / "alphaview" / "sample.py").write_text("VALUE = 1\n")
    (source / "data" / "private.db").write_bytes(b"do not copy")
    (source / ".env").write_text("SYNTHETIC_SECRET=do-not-copy\n")
    runner = source / "scripts" / "paper_workflow_soak.py"
    runner.write_text("# synthetic runner source\n")
    monkeypatch.setattr(soak, "ROOT", source)
    monkeypatch.setattr(soak, "__file__", str(runner))
    target = tmp_path / "frozen"
    target.mkdir()
    manifest = soak.freeze_source(target)
    assert set(manifest["files"]) == {"alphaview/sample.py", "scripts/paper_workflow_soak.py"}
    for path, digest in manifest["files"].items():
        assert hashlib.sha256((target / path).read_bytes()).hexdigest() == digest
    (source / "alphaview" / "sample.py").write_text("VALUE = 2\n")
    assert (target / "alphaview" / "sample.py").read_text() == "VALUE = 1\n"
    assert not (target / "data").exists() and not (target / ".env").exists()


def test_writer_refuses_database_outside_marked_synthetic_root(tmp_path, monkeypatch):
    root = tmp_path / "synthetic"
    root.mkdir()
    (root / ".synthetic-only").write_text("synthetic\n")
    inherited = tmp_path / "synthetic.db"
    inherited.write_bytes(b"must not open")
    monkeypatch.setenv("ALPHAVIEW_PAPER_SOAK_ROOT", str(root))
    with pytest.raises(soak.InvariantFailure, match="writer_outside_synthetic_root"):
        soak.policy_writer(inherited, "synthetic", 1)
    assert inherited.read_bytes() == b"must not open"


def test_subprocess_environment_omits_credentials_and_inherited_database(monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", "/must-not-open.db")
    monkeypatch.setenv("SYNTHETIC_PROVIDER_KEY", "must-not-forward")
    environment = soak.clean_environment()
    assert "PANEL_DB_PATH" not in environment and "SYNTHETIC_PROVIDER_KEY" not in environment
    assert set(environment) <= {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"}
