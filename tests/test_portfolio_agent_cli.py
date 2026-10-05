"""CLI transport and action boundaries using only an isolated loopback HTTP server."""
import importlib.util
import io
import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/portfolio_agent_cli.py"
SPEC = importlib.util.spec_from_file_location("portfolio_agent_cli", SCRIPT)
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


@pytest.fixture
def local_api():
    calls, responses = [], {}
    class Handler(BaseHTTPRequestHandler):
        def handle_api(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.loads(raw) if raw else None
            calls.append({"method": self.command, "path": self.path, "body": body,
                          "authorization": self.headers.get("Authorization"), "cookie": self.headers.get("Cookie")})
            status, payload, headers = responses.get(self.path, (200, {"method": self.command, "path": self.path, "body": body}, {}))
            encoded = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(encoded)
        do_GET = handle_api
        do_POST = handle_api
        do_PATCH = handle_api
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", calls, responses
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def invoke(capsys, args):
    result = cli.main(args)
    captured = capsys.readouterr()
    assert captured.err == ""
    return result, json.loads(captured.out)


def test_capability_manifest_is_offline_machine_readable_and_does_not_touch_db(tmp_path, monkeypatch, capsys):
    database = tmp_path / "must-not-create.db"
    monkeypatch.setenv("PANEL_DB_PATH", str(database))
    monkeypatch.setattr(cli, "request", lambda *args: pytest.fail("Manifest contacted network"))
    code, result = invoke(capsys, ["capabilities"])
    assert code == 0 and result["ok"] and result["read_only"]
    manifest = result["data"]
    assert manifest["mode"] == "local_research_and_paper_only"
    assert manifest["output"]["automatic_file_writes"] is False
    assert all(action["schema_url"].startswith(cli.DEFAULT_BASE_URL + "/openapi.json") for action in manifest["actions"])
    assert any(action["command"].startswith("run --save") and not action["read_only"] for action in manifest["actions"])
    assert not database.exists()


@pytest.mark.parametrize("url", ["https://127.0.0.1:8876", "http://example.com", "http://localhost.example.com", "http://192.168.1.5", "http://0.0.0.0", "http://user:secret@127.0.0.1", "http://127.0.0.1:8876@evil.invalid", "http://127.0.0.1/api", "http://127.0.0.1/?token=secret", "http://127.0.0.1/#fragment", "http://127.0.0.1:99999", "http://[::1%25eth0]:8876", "file:///etc/passwd"])
def test_nonloopback_credentials_and_ambiguous_origins_are_rejected_before_transport(capsys, monkeypatch, url):
    monkeypatch.setattr(cli, "request", lambda *args: pytest.fail("Unsafe origin reached transport"))
    code, result = invoke(capsys, ["--base-url", url, "status"])
    assert code == 2 and result["error"]["type"] == "unsafe_base_url"
    assert "secret" not in json.dumps(result)


def test_localhost_is_canonicalized_to_numeric_loopback_without_dns():
    assert cli.base_url("http://localhost:8876/") == ("http://127.0.0.1:8876", "127.0.0.1", 8876)
    assert cli.base_url("http://[::1]:8876") == ("http://[::1]:8876", "::1", 8876)


@pytest.mark.parametrize("command,path", [(["status"], "/api/status"), (["accounts"], "/api/paper/accounts"),
                                        (["accounts", "--account-id", "synthetic-account"], "/api/paper/accounts/synthetic-account"),
                                        (["runs"], "/api/portfolio-agent/runs"),
                                        (["runs", "--run-id", "synthetic-run"], "/api/portfolio-agent/runs/synthetic-run"),
                                        (["automation-state"], "/api/agent-automation/state")])
def test_read_commands_use_loopback_get_without_credentials(local_api, capsys, command, path):
    origin, calls, _ = local_api
    code, result = invoke(capsys, ["--base-url", origin, *command])
    assert code == 0 and result["read_only"] and result["method"] == "GET"
    assert calls == [{"method": "GET", "path": path, "body": None, "authorization": None, "cookie": None}]


def test_proxy_environment_is_ignored(local_api, capsys, monkeypatch):
    origin, calls, _ = local_api
    monkeypatch.setenv("HTTP_PROXY", "http://remote-proxy.invalid:1")
    monkeypatch.setenv("http_proxy", "http://remote-proxy.invalid:1")
    monkeypatch.setenv("NO_PROXY", "")
    code, _ = invoke(capsys, ["--base-url", origin, "status"])
    assert code == 0 and len(calls) == 1


@pytest.mark.parametrize("command,save,path,read_only", [("preview", False, "/api/portfolio-agent/preview", True),
                                                        ("run", False, "/api/portfolio-agent/preview", True),
                                                        ("run", True, "/api/portfolio-agent/runs", False)])
def test_workflow_defaults_to_readonly_and_save_is_explicit(local_api, tmp_path, capsys, command, save, path, read_only):
    origin, calls, _ = local_api
    request = {"scope": "market", "candidate_symbols": ["SYNTA"], "constraints": {"min_score": 50}}
    source = tmp_path / "request.json"
    source.write_text(json.dumps(request))
    args = ["--base-url", origin, command, "--input", str(source)] + (["--save"] if save else [])
    code, result = invoke(capsys, args)
    assert code == 0 and result["read_only"] == read_only
    assert calls[0]["path"] == path and calls[0]["body"] == request
    assert list(tmp_path.iterdir()) == [source]


def test_candidates_accept_defaults_and_stdin_json(local_api, capsys, monkeypatch):
    origin, calls, _ = local_api
    assert invoke(capsys, ["--base-url", origin, "candidates"])[0] == 0
    assert calls[-1]["body"] == {}
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"limit": 5, "scope": "market"}'))
    code, result = invoke(capsys, ["--base-url", origin, "candidates", "--input", "-"])
    assert code == 0 and result["read_only"]
    assert calls[-1]["body"] == {"limit": 5, "scope": "market"}


def test_agent_run_proposal_bridge_has_version_and_idempotency_guards(local_api, capsys):
    origin, calls, _ = local_api
    code, result = invoke(capsys, ["--base-url", origin, "proposal", "--account-id", "synthetic-account", "--run-id", "synthetic-run",
                                  "--expected-version", "3", "--idempotency-key", "synthetic-proposal-key"])
    assert code == 0 and not result["read_only"]
    assert calls[0]["path"] == "/api/portfolio-agent/runs/synthetic-run/paper-proposal"
    assert calls[0]["body"] == {"account_id": "synthetic-account", "expected_account_version": 3, "idempotency_key": "synthetic-proposal-key"}


def test_explicit_paper_proposal_uses_json_and_never_auto_accepts(local_api, capsys, monkeypatch):
    origin, calls, _ = local_api
    body = {"expected_version": 2, "targets": [{"symbol": "SYNTA", "weight_pct": 20}], "idempotency_key": "synthetic-proposal-key"}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body)))
    code, result = invoke(capsys, ["--base-url", origin, "proposal", "--account-id", "synthetic-account", "--input", "-"])
    assert code == 0 and not result["read_only"]
    assert len(calls) == 1 and calls[0]["path"] == "/api/paper/accounts/synthetic-account/proposals"
    assert calls[0]["body"] == body


def test_accept_requires_explicit_paper_account_proposal_version_and_key(local_api, capsys):
    origin, calls, _ = local_api
    args = ["--base-url", origin, "accept", "--account-id", "synthetic-account", "--proposal-id", "synthetic-proposal",
            "--expected-version", "2", "--idempotency-key", "synthetic-accept-key"]
    code, result = invoke(capsys, args)
    assert code == 2 and not calls
    code, result = invoke(capsys, [*args, "--paper"])
    assert code == 0 and not result["read_only"]
    assert calls[0]["path"] == "/api/paper/accounts/synthetic-account/proposals/synthetic-proposal/accept"
    assert calls[0]["body"] == {"expected_version": 2, "idempotency_key": "synthetic-accept-key"}


@pytest.mark.parametrize("body", ['[]', '{"x":NaN}', '{"x":Infinity}', '{"x":1e10000}', '{"x":1,"x":2}', '{bad', 'null'])
def test_invalid_json_is_structured_and_never_sent(local_api, capsys, monkeypatch, body):
    origin, calls, _ = local_api
    monkeypatch.setattr(sys, "stdin", io.StringIO(body))
    code, result = invoke(capsys, ["--base-url", origin, "preview", "--input", "-"])
    assert code == 2 and result["error"]["type"] == "invalid_json_input" and not calls


@pytest.mark.parametrize("arguments", [["live-trade"], ["accept", "--live"], ["accounts", "--account-id", "../../other"],
                                       ["proposal", "--account-id", "synthetic-account", "--run-id", "synthetic-run"],
                                       ["--timeout", "NaN", "status"], ["--timeout", "0", "status"], ["--timeout", "61", "status"]])
def test_unsupported_modes_paths_and_incomplete_actions_fail_without_http(local_api, capsys, arguments):
    origin, calls, _ = local_api
    code, result = invoke(capsys, ["--base-url", origin, *arguments])
    assert code == 2 and not result["ok"] and not calls


def test_input_and_response_byte_bounds(local_api, capsys, tmp_path, monkeypatch):
    origin, calls, responses = local_api
    source = tmp_path / "oversized.json"
    source.write_text('{"large":"' + "a" * 40 + '"}')
    monkeypatch.setattr(cli, "MAX_INPUT_BYTES", 20)
    code, result = invoke(capsys, ["--base-url", origin, "preview", "--input", str(source)])
    assert code == 2 and result["error"]["type"] == "input_too_large" and not calls
    responses["/api/status"] = (200, {"large": "a" * 40}, {})
    monkeypatch.setattr(cli, "MAX_RESPONSE_BYTES", 20)
    code, result = invoke(capsys, ["--base-url", origin, "status"])
    assert code == 5 and result["error"]["type"] == "response_too_large"


@pytest.mark.parametrize("status,body,headers,exit_code,kind", [(409, {"detail": "Synthetic version conflict"}, {}, 4, "http_error"),
    (302, {}, {"Location": "http://remote.invalid/never-follow"}, 4, "redirect_blocked"),
    (200, '{"x":NaN}', {}, 5, "invalid_json_response"),
    (200, '{"x":1e10000}', {}, 5, "invalid_json_response"),
    (500, "Synthetic non-JSON error", {}, 4, "http_error")])
def test_http_errors_redirects_and_invalid_responses_have_stable_json_exits(local_api, capsys, status, body, headers, exit_code, kind):
    origin, calls, responses = local_api
    responses["/api/status"] = (status, body, headers)
    code, result = invoke(capsys, ["--base-url", origin, "status"])
    assert code == exit_code and result["exit_code"] == exit_code
    assert result["error"]["type"] == kind and len(calls) == 1


def test_transport_timeout_and_closed_connection_are_structured(capsys, monkeypatch):
    closed = []
    class TimeoutConnection:
        def __init__(self, *args, **kwargs):
            pass
        def request(self, *args, **kwargs):
            raise socket.timeout()
        def close(self):
            closed.append(True)
    monkeypatch.setattr(cli.http.client, "HTTPConnection", TimeoutConnection)
    code, result = invoke(capsys, ["status"])
    assert code == 3 and result["error"]["type"] == "timeout" and closed == [True]


def test_help_and_machine_manifest_run_with_plain_python():
    result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, check=True)
    assert "--base-url" in result.stdout and "accept" in result.stdout
    result = subprocess.run([sys.executable, str(SCRIPT), "capabilities"], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["data"]["contract_version"] == cli.CONTRACT_VERSION


@pytest.mark.parametrize("command,path", [
    (["local-models"], "/api/local-agent/models"),
    (["local-runs"], "/api/local-agent/runs"),
    (["local-runs", "--limit", "5"], "/api/local-agent/runs?limit=5"),
    (["local-runs", "--run-id", "synthetic-local"], "/api/local-agent/runs/synthetic-local"),
    (["automation-state", "--mandate-id", "synthetic-mandate"], "/api/agent-automation/mandates/synthetic-mandate"),
    (["automation-attempts", "--mandate-id", "synthetic-mandate"], "/api/agent-automation/mandates/synthetic-mandate/attempts"),
    (["automation-attempts", "--mandate-id", "synthetic-mandate", "--limit", "100"], "/api/agent-automation/mandates/synthetic-mandate/attempts?limit=100"),
])
def test_local_analysis_and_automation_read_commands(local_api, capsys, command, path):
    origin, calls, _ = local_api
    code, result = invoke(capsys, ["--base-url", origin, *command])
    assert code == 0 and result["read_only"]
    assert calls == [{"method": "GET", "path": path, "body": None, "authorization": None, "cookie": None}]


def test_local_analyze_returns_202_job_without_polling_or_accepting(local_api, capsys):
    origin, calls, responses = local_api
    responses["/api/local-agent/runs"] = (202, {"id": "synthetic-local", "status": "queued", "proposal_ready": False}, {})
    args = ["--base-url", origin, "local-analyze", "--source-run-id", "synthetic-rules", "--model", "synthetic:4b",
            "--mode", "conservative", "--idempotency-key", "synthetic-analysis-key"]
    code, result = invoke(capsys, args)
    assert code == 0 and not result["read_only"] and result["data"]["status"] == "queued"
    assert len(calls) == 1 and calls[0]["path"] == "/api/local-agent/runs"
    assert calls[0]["body"] == {"source_run_id": "synthetic-rules", "model": "synthetic:4b", "mode": "conservative",
                                "idempotency_key": "synthetic-analysis-key"}
    # The caller can repeat the same explicit command/key; no generated replacement key.
    assert invoke(capsys, args)[0] == 0 and calls[1]["body"] == calls[0]["body"]


def test_local_cancel_preserves_pending_cancellation_status(local_api, capsys):
    origin, calls, responses = local_api
    path = "/api/local-agent/runs/synthetic-local/cancel"
    responses[path] = (200, {"id": "synthetic-local", "status": "running", "cancel_requested": True}, {})
    code, result = invoke(capsys, ["--base-url", origin, "local-cancel", "--run-id", "synthetic-local"])
    assert code == 0 and not result["read_only"] and result["data"]["status"] == "running"
    assert result["data"]["cancel_requested"] and calls[0]["body"] is None and len(calls) == 1


@pytest.mark.parametrize("save", [False, True])
def test_local_analysis_paper_bridge_never_implicitly_saves_or_accepts(local_api, capsys, save):
    origin, calls, _ = local_api
    command = "local-paper-proposal" if save else "local-paper-preview"
    args = ["--base-url", origin, command, "--run-id", "synthetic-local", "--account-id", "synthetic-account", "--expected-version", "2"]
    if save:
        args += ["--idempotency-key", "synthetic-local-proposal"]
    code, result = invoke(capsys, args)
    assert code == 0 and result["read_only"] == (not save) and len(calls) == 1
    assert calls[0]["path"] == "/api/local-agent/runs/synthetic-local/" + ("paper-proposal" if save else "paper-preview")
    expected = {"account_id": "synthetic-account", "expected_account_version": 2}
    if save:
        expected["idempotency_key"] = "synthetic-local-proposal"
    assert calls[0]["body"] == expected


@pytest.mark.parametrize("explicit", [False, True])
def test_automation_create_defaults_disabled_but_preserves_explicit_json(local_api, capsys, monkeypatch, explicit):
    origin, calls, _ = local_api
    body = {"name": "Synthetic mandate", "account_id": "synthetic-account", "workflow": {"candidate_symbols": ["SYNTA"]}}
    if explicit:
        body.update(enabled=True, mode="auto_simulate")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body)))
    code, result = invoke(capsys, ["--base-url", origin, "automation-create", "--input", "-"])
    assert code == 0 and not result["read_only"] and len(calls) == 1
    assert calls[0]["path"] == "/api/agent-automation/mandates"
    assert calls[0]["body"] == {**body, "enabled": explicit, "mode": "auto_simulate" if explicit else "proposal_only"}


def test_automation_update_uses_patch_exact_changes_and_version(local_api, capsys, monkeypatch):
    origin, calls, _ = local_api
    body = {"enabled": False, "selector_limit": 10}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body)))
    code, result = invoke(capsys, ["--base-url", origin, "automation-update", "--mandate-id", "synthetic-mandate",
                                  "--expected-version", "3", "--input", "-"])
    assert code == 0 and not result["read_only"] and len(calls) == 1
    assert calls[0]["method"] == "PATCH" and calls[0]["path"] == "/api/agent-automation/mandates/synthetic-mandate"
    assert calls[0]["body"] == {**body, "expected_version": 3}


@pytest.mark.parametrize("allow", [False, True])
def test_automation_manual_run_requires_explicit_simulation_flag(local_api, capsys, allow):
    origin, calls, _ = local_api
    args = ["--base-url", origin, "automation-run", "--mandate-id", "synthetic-mandate", "--expected-version", "4"]
    if allow:
        args.append("--allow-paper-simulation")
    code, result = invoke(capsys, args)
    assert code == 0 and not result["read_only"] and len(calls) == 1
    assert calls[0]["path"] == "/api/agent-automation/mandates/synthetic-mandate/run"
    assert calls[0]["body"] == {"expected_version": 4, "allow_auto_simulate": allow}


@pytest.mark.parametrize("arguments", [
    ["local-analyze", "--source-run-id", "synthetic-rules", "--model", "synthetic:4b", "--idempotency-key", "synthetic-key"],
    ["local-analyze", "--source-run-id", "synthetic-rules", "--model", "synthetic:cloud", "--mode", "analysis", "--idempotency-key", "synthetic-key"],
    ["local-analyze", "--source-run-id", "synthetic-rules", "--model", "https://remote.invalid/model", "--mode", "analysis", "--idempotency-key", "synthetic-key"],
    ["local-analyze", "--source-run-id", "synthetic-rules", "--model", "synthetic:4b", "--mode", "live", "--idempotency-key", "synthetic-key"],
    ["local-analyze", "--source-run-id", "synthetic-rules", "--model", "synthetic:4b", "--mode", "analysis", "--idempotency-key", "short"],
    ["local-cancel", "--run-id", "../escape"],
    ["local-runs", "--limit", "101"],
    ["local-runs", "--run-id", "synthetic-local", "--limit", "2"],
    ["local-paper-proposal", "--run-id", "synthetic-local", "--account-id", "synthetic-account", "--expected-version", "1"],
    ["local-paper-preview", "--run-id", "synthetic-local", "--account-id", "synthetic-account", "--expected-version", "1", "--save"],
    ["automation-run", "--mandate-id", "synthetic-mandate"],
    ["automation-run", "--mandate-id", "synthetic-mandate", "--expected-version", "1", "--live"],
    ["automation-attempts", "--mandate-id", "synthetic-mandate", "--limit", "0"],
])
def test_new_actions_reject_ambiguous_or_unsafe_arguments_without_http(local_api, capsys, arguments):
    origin, calls, _ = local_api
    code, result = invoke(capsys, ["--base-url", origin, *arguments])
    assert code == 2 and not result["ok"] and not calls


@pytest.mark.parametrize("body", [{}, {"expected_version": 2, "enabled": True}])
def test_automation_update_rejects_missing_changes_or_ambiguous_version(local_api, capsys, monkeypatch, body):
    origin, calls, _ = local_api
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body)))
    code, result = invoke(capsys, ["--base-url", origin, "automation-update", "--mandate-id", "synthetic-mandate",
                                  "--expected-version", "2", "--input", "-"])
    assert code == 2 and result["error"]["type"] == "invalid_arguments" and not calls


def test_manifest_exposes_new_side_effects_and_patch_schema():
    actions = cli.capabilities(cli.DEFAULT_BASE_URL)["actions"]
    prefixes = {"local-models", "local-runs", "local-analyze", "local-cancel", "local-paper-preview", "local-paper-proposal",
                "automation-state", "automation-attempts", "automation-create", "automation-update", "automation-run"}
    assert prefixes <= {action["command"].split()[0] for action in actions}
    patch = next(action for action in actions if action["command"].startswith("automation-update"))
    assert patch["method"] == "PATCH" and "/patch/requestBody/" in patch["schema_url"] and not patch["read_only"]
    assert all(action["effect"] and action["schema_url"] and type(action["read_only"]) is bool for action in actions)
    assert next(action for action in actions if action["command"].startswith("local-paper-preview"))["read_only"]
    assert not next(action for action in actions if action["command"].startswith("local-analyze"))["read_only"]
