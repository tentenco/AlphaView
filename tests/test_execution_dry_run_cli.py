"""Explicit synthetic inputs and isolated artifact roots only; no workspace DB."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import subprocess
import sys

import pytest

from alphaview.panel import execution_dry_run as dry

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "execution_dry_run_cli.py"
spec = importlib.util.spec_from_file_location("execution_dry_run_cli", SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def input_trace():
    return {"format_version": dry.TRACE_VERSION, "synthetic_only": True,
        "order": {"client_order_id": "synthetic-cli-order", "symbol": "SYNTH", "side": "buy", "quantity": "10", "currency": "USD"},
        "steps": [{"action": "submit", "observed_at": "2026-09-26T10:00:00Z", "request_id": "synthetic-submit", "response": "timeout"}]}


def invoke(tmp_path, args, value=None, raw=None):
    output = io.StringIO()
    stream = io.BytesIO(raw if raw is not None else json.dumps(value or input_trace()).encode())
    code = cli.main(args, artifact_root=tmp_path / "artifacts", stdin=stream, stdout=output)
    return code, json.loads(output.getvalue())


def receipt():
    return dry.make_receipt(input_trace(), "2026-09-29T11:00:00Z")


def test_preview_stdout_is_deterministic_and_creates_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(sqlite3, "connect", lambda *args, **kwargs: pytest.fail("No database access permitted"))
    monkeypatch.setattr(socket, "socket", lambda *args, **kwargs: pytest.fail("No network access permitted"))
    before = list(tmp_path.iterdir())
    first = invoke(tmp_path, ["preview", "--input", "-"])
    second = invoke(tmp_path, ["preview", "--input", "-"])
    assert first == second and first[0] == 0
    assert first[1]["result"]["state"] == "unknown"
    assert first[1]["result"]["working_quantity"] is None
    assert list(tmp_path.iterdir()) == before


def test_save_inspect_complete_unknown_receipt_and_no_overwrite(tmp_path):
    target = tmp_path / "artifacts" / "synthetic" / "unknown.json"
    code, saved = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    assert code == 0 and saved["state"] == "unknown" and not saved["order_terminal"]
    original = target.read_bytes()
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(target.parent.glob("*.tmp"))
    code, inspected = invoke(tmp_path, ["inspect", "--receipt", str(target)])
    assert code == 0 and inspected["integrity_verified"] and inspected["current_engine_supported"]
    assert inspected["receipt"]["content_sha256"] == saved["content_sha256"]
    assert inspected["receipt"]["content"]["input"] == dry.parse_trace(input_trace()).model_dump(exclude_none=True)
    code, conflict = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    assert code == 2 and conflict["error"]["code"] == "output_exists"
    assert target.read_bytes() == original


def test_input_from_explicit_file_matches_stdin_preview(tmp_path):
    source = tmp_path / "fixture.json"
    source.write_text(json.dumps(input_trace()))
    before = source.read_bytes()
    file_result = invoke(tmp_path, ["--pretty", "preview", "--input", str(source)])
    stdin_result = invoke(tmp_path, ["preview", "--input", "-"])
    assert file_result == stdin_result and source.read_bytes() == before


@pytest.mark.parametrize("raw,code", [
    (b'{"synthetic_only":true,"synthetic_only":false}', "duplicate_json_key"),
    (b'{"x":NaN}', "invalid_json_number"),
    (b'{"x":Infinity}', "invalid_json_number"),
    (b'{"x":' + b'7' * 5000 + b'}', "invalid_json_number"),
    (b'{"x":1e309}', "invalid_json_number"),
    (b'[]', "json_object_required"), (b'\xff', "invalid_json"),
    (b'{broken', "invalid_json"), (b' ' * (dry.MAX_INPUT_BYTES + 1), "file_too_large"),
])
def test_malformed_json_never_publishes_partial_receipt(tmp_path, raw, code):
    target = tmp_path / "artifacts" / "invalid.json"
    result, response = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)], raw=raw)
    assert result == 2 and response["error"]["code"] == code
    assert not target.exists() and not target.parent.exists()


def test_invalid_trace_does_not_create_artifact_directory(tmp_path):
    value = input_trace()
    value["steps"].append({"action": "fill", "event_id": "too-large-fill", "execution_id": "too-large-execution",
        "observed_at": "2026-09-26T10:00:01Z", "executed_at": "2026-09-26T10:00:01Z", "quantity": "11", "price": "100"})
    target = tmp_path / "artifacts" / "invalid.json"
    code, response = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)], value=value)
    assert code == 2 and response["error"]["code"] == "overfill"
    assert not target.parent.exists()


@pytest.mark.parametrize("kind", ["outside", "parent_traversal", "wrong_extension", "target_symlink", "parent_symlink", "root_symlink", "existing_directory"])
def test_unsafe_artifact_target_rejected_without_changing_existing_content(tmp_path, kind):
    artifacts = tmp_path / "artifacts"
    other = tmp_path / "elsewhere"
    other.mkdir()
    sentinel = other / "sentinel.json"
    sentinel.write_bytes(b"synthetic unchanged sentinel")
    if kind == "root_symlink":
        artifacts.symlink_to(other, target_is_directory=True)
        target = artifacts / "result.json"
    else:
        artifacts.mkdir()
        if kind == "outside": target = other / "result.json"
        elif kind == "parent_traversal": target = artifacts / ".." / "elsewhere" / "result.json"
        elif kind == "wrong_extension": target = artifacts / "result.txt"
        elif kind == "target_symlink":
            target = artifacts / "result.json"
            target.symlink_to(sentinel)
        elif kind == "parent_symlink":
            (artifacts / "redirect").symlink_to(other, target_is_directory=True)
            target = artifacts / "redirect" / "result.json"
        else:
            target = artifacts / "result.json"
            target.mkdir()
    code, response = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    assert code in (2, 3) and response["ok"] is False
    assert sentinel.read_bytes() == b"synthetic unchanged sentinel"
    assert not (other / "result.json").exists()


def test_two_concurrent_writers_publish_one_complete_receipt(tmp_path):
    root = tmp_path / "artifacts"
    root.mkdir()
    target = root / "concurrent.json"
    value = receipt()
    def write():
        try:
            return cli.save_receipt(value, target, root)
        except dry.DryRunError as exc:
            return exc.detail["code"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: write(), range(2)))
    assert results.count(str(target)) == results.count("output_exists") == 1
    assert cli.inspect_receipt(target, root)["receipt"] == value
    assert len(list(root.iterdir())) == 1


def test_staging_failure_publishes_no_final_receipt(tmp_path, monkeypatch):
    root, target = tmp_path / "artifacts", tmp_path / "artifacts" / "failure.json"
    monkeypatch.setattr(cli.os, "fsync", lambda _descriptor: (_ for _ in ()).throw(OSError("synthetic fsync failure")))
    code, result = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    assert code == 3 and result["error"]["code"] == "file_unavailable"
    assert not target.exists() and list(root.iterdir()) == []


def test_directory_fsync_failure_reports_complete_but_uncertain_publication(tmp_path, monkeypatch):
    target = tmp_path / "artifacts" / "durability.json"
    original = cli.os.fsync
    def fsync(descriptor):
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise OSError("synthetic directory sync failure")
        return original(descriptor)
    monkeypatch.setattr(cli.os, "fsync", fsync)
    code, result = invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    assert code == 2 and result["error"]["code"] == "publication_durability_unknown"
    assert cli.inspect_receipt(target, tmp_path / "artifacts")["integrity_verified"]


def test_inspection_rejects_symlink_and_tampered_receipt_without_replay(tmp_path, monkeypatch):
    target = tmp_path / "artifacts" / "saved.json"
    invoke(tmp_path, ["save", "--input", "-", "--output", str(target)])
    monkeypatch.setattr(dry, "replay_trace", lambda _: pytest.fail("Inspect must not recalculate"))
    link = target.parent / "link.json"
    link.symlink_to(target)
    assert invoke(tmp_path, ["inspect", "--receipt", str(link)])[0] == 3
    altered = json.loads(target.read_text())
    altered["content"]["result"]["state"] = "filled"
    target.write_text(json.dumps(altered))
    code, result = invoke(tmp_path, ["inspect", "--receipt", str(target)])
    assert code == 2 and result["error"]["code"] == "receipt_integrity_failed"


def test_unknown_method_receipt_is_inspected_without_running_current_method(tmp_path, monkeypatch):
    value = receipt()
    value["engine_version"] = value["content"]["result"]["engine_version"] = "alphaview-execution-dry-run-v999"
    result = value["content"]["result"]
    result["result_sha256"] = dry.fingerprint({key: item for key, item in result.items() if key != "result_sha256"})
    value["content_sha256"] = dry.fingerprint(value["content"])
    target = tmp_path / "artifacts" / "legacy.json"
    cli.save_receipt(value, target, tmp_path / "artifacts")
    monkeypatch.setattr(dry, "replay_trace", lambda _: pytest.fail("Old method must not be recalculated"))
    code, result = invoke(tmp_path, ["inspect", "--receipt", str(target)])
    assert code == 0 and result["integrity_verified"] and not result["current_engine_supported"]
    assert result["receipt"] == value


@pytest.mark.parametrize("args", [[], ["submit"], ["preview"], ["save", "--input", "-"], ["preview", "--input", "-", "--endpoint", "https://synthetic.invalid"]])
def test_argument_errors_are_single_json_errors(tmp_path, args):
    code, value = invoke(tmp_path, args)
    assert code == 2 and value["error"]["code"] == "invalid_arguments"


def test_standalone_preview_works_without_server_or_workspace(tmp_path):
    result = subprocess.run([sys.executable, str(SCRIPT), "preview", "--input", "-"],
        input=json.dumps(input_trace()), text=True, capture_output=True, cwd=tmp_path, check=False,
        env={**os.environ, "PANEL_DB_PATH": str(tmp_path / "must-not-exist.db")})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["result"]["state"] == "unknown"
    assert result.stderr == "" and not (tmp_path / "must-not-exist.db").exists()


def test_standalone_huge_integer_error_is_bounded_json_without_input_echo(tmp_path):
    raw = '{"quantity":' + '7' * 5000 + '}'
    result = subprocess.run([sys.executable, str(SCRIPT), "preview", "--input", "-"],
        input=raw, text=True, capture_output=True, cwd=tmp_path, check=False)
    assert result.returncode == 2 and result.stderr == ""
    assert json.loads(result.stdout)["error"]["code"] == "invalid_json_number"
    assert len(result.stdout) < 400 and "7777777777" not in result.stdout


def test_inspect_huge_integer_and_overlimit_receipts_use_bounded_json_errors(tmp_path):
    root = tmp_path / "artifacts"
    root.mkdir()
    target = root / "invalid.json"
    for raw, expected in [(b'{"number":' + b'7' * 5000 + b'}', "invalid_json_number"),
                          (b' ' * (dry.MAX_RECEIPT_BYTES + 1), "file_too_large")]:
        target.write_bytes(raw)
        code, result = invoke(tmp_path, ["inspect", "--receipt", str(target)])
        assert code == 2 and result["error"]["code"] == expected
        assert target.read_bytes() == raw


@pytest.mark.parametrize("name", ["null\x00.json", "line\n.json", "x" * 256 + ".json"])
def test_malformed_artifact_names_are_structured_errors(tmp_path, name):
    code, result = invoke(tmp_path, ["inspect", "--receipt", str(tmp_path / "artifacts" / name)])
    assert code == 2 and result["error"]["code"] == "artifact_path_invalid"


def test_explicit_input_path_null_byte_is_structured_error(tmp_path):
    code, result = invoke(tmp_path, ["preview", "--input", "null\x00.json"])
    assert code == 2 and result["error"]["code"] == "input_path_invalid"
