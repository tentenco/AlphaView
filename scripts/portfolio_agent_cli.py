#!/usr/bin/env python3
"""JSON CLI for local portfolio Agent research and explicitly scoped paper actions."""
import argparse
import http.client
import ipaddress
import json
import math
import re
import socket
import sys
from urllib.parse import quote, urlsplit

CONTRACT_VERSION = "alphaview-portfolio-agent-cli-v1"
DEFAULT_BASE_URL = "http://127.0.0.1:8876"
MAX_INPUT_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 8_388_608
IDENTIFIER = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{8,100}$")
LOCAL_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")


class CLIError(Exception):
    def __init__(self, exit_code, kind, message, **details):
        super().__init__(message)
        self.exit_code, self.kind, self.message, self.details = exit_code, kind, message, details


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CLIError(2, "invalid_arguments", message)


def base_url(value):
    """Allow only HTTP loopback origins; canonicalize localhost without DNS."""
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ("", "/")
                or "?" in value or "#" in value or any(character.isspace() for character in value)):
            raise ValueError()
        host = parsed.hostname
        if "%" in host:
            raise ValueError()
        if host.lower() == "localhost":
            host = "127.0.0.1"
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError()
        port = parsed.port if parsed.port is not None else 80
        if not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError):
        raise CLIError(2, "unsafe_base_url", "Base URL must be an HTTP loopback origin without credentials, query, fragment or path") from None
    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    return f"http://{authority}", host, port


def positive_version(value):
    try:
        version = int(value)
    except (TypeError, ValueError):
        raise CLIError(2, "invalid_version", "Expected version must be a positive integer") from None
    if version < 1:
        raise CLIError(2, "invalid_version", "Expected version must be a positive integer")
    return version


def history_limit(value):
    limit = positive_version(value)
    if limit > 100:
        raise CLIError(2, "invalid_limit", "History limit must be between 1 and 100")
    return limit


def local_model(value):
    if not isinstance(value, str) or not LOCAL_MODEL.fullmatch(value) or "cloud" in value.lower():
        raise CLIError(2, "invalid_local_model", "Use an exact installed local model name from local-models; cloud names and URLs are forbidden")
    return value


def identifier(value, name):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise CLIError(2, "invalid_identifier", f"{name} must contain 1–100 letters, digits, dot, underscore, colon or hyphen")
    return quote(value, safe="")


def idempotency_key(value):
    if not isinstance(value, str) or not IDEMPOTENCY_KEY.fullmatch(value):
        raise CLIError(2, "invalid_idempotency_key", "Idempotency key must contain 8–100 letters, digits, dot, underscore, colon or hyphen")
    return value


def _no_nonfinite(value):
    raise ValueError("Non-finite JSON numbers are forbidden")


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object keys are forbidden")
        result[key] = value
    return result


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON numbers are forbidden")
    return number


def _decode_json(raw):
    return json.loads(raw, parse_constant=_no_nonfinite, parse_float=_finite_float, object_pairs_hook=_unique_keys)


def read_input(path):
    if path is None:
        return {}
    try:
        if path == "-":
            stream = getattr(sys.stdin, "buffer", sys.stdin)
            raw = stream.read(MAX_INPUT_BYTES + 1)
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
        else:
            with open(path, "rb") as handle:
                raw = handle.read(MAX_INPUT_BYTES + 1)
    except (OSError, UnicodeError) as exc:
        raise CLIError(2, "input_read_error", f"Unable to read JSON input: {exc}") from exc
    if len(raw) > MAX_INPUT_BYTES:
        raise CLIError(2, "input_too_large", "JSON input exceeds the 1 MiB limit")
    try:
        payload = _decode_json(raw.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise CLIError(2, "invalid_json_input", f"Input must be finite UTF-8 JSON with unique keys: {exc}") from exc
    if not isinstance(payload, dict):
        raise CLIError(2, "invalid_json_input", "The API request input must be a JSON object")
    return payload


def request(origin, host, port, method, path, payload, timeout):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": CONTRACT_VERSION}
    if body is not None:
        headers["Content-Type"] = "application/json"
    # HTTPConnection ignores proxy environment variables and does not follow redirects.
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise CLIError(4, "redirect_blocked", "Local API redirects are not followed", http_status=response.status)
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise CLIError(5, "response_too_large", "Local API response exceeds the 8 MiB limit")
        try:
            data = _decode_json(raw.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            if response.status >= 400:
                raise CLIError(4, "http_error", f"Local API returned HTTP {response.status}",
                               http_status=response.status, detail=raw.decode("utf-8", errors="replace")[:2000]) from exc
            raise CLIError(5, "invalid_json_response", "Local API returned invalid or non-finite JSON") from exc
        if not 200 <= response.status < 300:
            raise CLIError(4, "http_error", f"Local API returned HTTP {response.status}", http_status=response.status, detail=data)
        return data
    except CLIError:
        raise
    except (socket.timeout, TimeoutError) as exc:
        raise CLIError(3, "timeout", "Local API request timed out") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise CLIError(3, "connection_error", f"Unable to reach the local API: {exc}") from exc
    finally:
        connection.close()


def _schema_url(origin, path, method):
    pointer = path.replace("~", "~0").replace("/", "~1")
    return f"{origin}/openapi.json#/paths/{pointer}/{method.lower()}/requestBody/content/application~1json/schema"


def capabilities(origin):
    actions = [
        ("status", "GET", "/api/status", True, "Read workspace freshness and revision status"),
        ("accounts", "GET", "/api/paper/accounts", True, "List local paper accounts"),
        ("runs", "GET", "/api/portfolio-agent/runs", True, "Read saved Agent run history"),
        ("runs --run-id ID", "GET", "/api/portfolio-agent/runs/{identifier}", True, "Read a saved Agent trace and source freshness"),
        ("accounts --account-id ID", "GET", "/api/paper/accounts/{account_id}", True, "Read one paper account including holdings and proposals"),
        ("candidates --input FILE|-", "POST", "/api/portfolio-agent/candidates", True, "Select candidates from the verified saved local scan pool"),
        ("preview --input FILE|-", "POST", "/api/portfolio-agent/preview", True, "Compute deterministic role trace without saving"),
        ("run --input FILE|-", "POST", "/api/portfolio-agent/preview", True, "Preview by default; no persistent run without --save"),
        ("run --save --input FILE|-", "POST", "/api/portfolio-agent/runs", False, "Save immutable Agent run and evidence"),
        ("proposal --account-id ID --run-id ID --expected-version N --idempotency-key KEY", "POST", "/api/portfolio-agent/runs/{identifier}/paper-proposal", False, "Save a paper proposal bound to a current Agent run; no acceptance"),
        ("proposal --account-id ID --input FILE|-", "POST", "/api/paper/accounts/{account_id}/proposals", False, "Save an explicit paper target proposal; no acceptance"),
        ("accept --paper --account-id ID --proposal-id ID --expected-version N --idempotency-key KEY", "POST", "/api/paper/accounts/{account_id}/proposals/{proposal_id}/accept", False, "Explicitly accept a paper proposal; simulated ledger only"),
        ("automation-state", "GET", "/api/agent-automation/state", True, "Read local mandate, cadence and attempt state"),
        ("automation-state --mandate-id ID", "GET", "/api/agent-automation/mandates/{identifier}", True, "Read one mandate and its current readiness"),
        ("automation-attempts --mandate-id ID [--limit N]", "GET", "/api/agent-automation/mandates/{identifier}/attempts", True, "Read immutable daily attempt history, including versioned trigger evidence and skipped sessions"),
        ("automation-create --input FILE|-", "POST", "/api/agent-automation/mandates", False, "Save a named mandate; omitted enabled/mode are false/proposal_only; explicit JSON may enable daily paper actions"),
        ("automation-update --mandate-id ID --expected-version N --input FILE|-", "PATCH", "/api/agent-automation/mandates/{identifier}", False, "Version-checked mandate changes; rebalance_trigger replaces both optional gates; explicit workflow policy binding acknowledges a changed symbol policy; enabling auto_simulate permits scheduled paper fills"),
        ("automation-run --mandate-id ID --expected-version N", "POST", "/api/agent-automation/mandates/{identifier}/run", False, "Attempt the latest session once under configured drift/interval gates; skipped consumes the session, waiting does not; paper proposal only, including auto_simulate mandates"),
        ("automation-run --mandate-id ID --expected-version N --allow-paper-simulation", "POST", "/api/agent-automation/mandates/{identifier}/run", False, "Explicitly permit paper simulation only if the mandate mode also allows it; existing limits remain enforced"),
        ("local-models", "GET", "/api/local-agent/models", True, "Read installed local Ollama model availability; no download or inference"),
        ("local-runs [--limit N]", "GET", "/api/local-agent/runs", True, "Read local model job history; does not wait or poll"),
        ("local-runs --run-id ID", "GET", "/api/local-agent/runs/{identifier}", True, "Read one local model job, citations, validated targets and freshness"),
        ("local-analyze --source-run-id ID --model NAME --mode analysis|conservative --idempotency-key KEY", "POST", "/api/local-agent/runs", False, "Start and save a durable local model job; return the 202 response immediately, no waiting or paper acceptance"),
        ("local-cancel --run-id ID", "POST", "/api/local-agent/runs/{identifier}/cancel", False, "Persist cancellation request for local analysis; pending inference may finish before discard"),
        ("local-paper-preview --run-id ID --account-id ID --expected-version N", "POST", "/api/local-agent/runs/{identifier}/paper-preview", True, "Read paper rebalance preview from a completed current local model job"),
        ("local-paper-proposal --run-id ID --account-id ID --expected-version N --idempotency-key KEY", "POST", "/api/local-agent/runs/{identifier}/paper-proposal", False, "Save a paper proposal bound to validated local analysis; never accepts it"),
    ]
    return {"contract_version": CONTRACT_VERSION, "base_url": origin, "openapi_url": origin + "/openapi.json",
            "network": "loopback_http_only_no_proxy_no_redirects", "mode": "local_research_and_paper_only",
            "input": {"encoding": "UTF-8 JSON object", "file_flag": "--input", "stdin_path": "-", "max_bytes": MAX_INPUT_BYTES},
            "output": {"success": "{ok:true,contract_version,command,read_only,method?,url?,data}",
                       "error": "{ok:false,contract_version,error:{type,message,...},exit_code}", "automatic_file_writes": False},
            "exit_codes": {"0": "success", "2": "invalid arguments or input", "3": "connection error or timeout",
                           "4": "API error or blocked redirect", "5": "invalid or oversized API response"},
            "actions": [{"command": command, "method": method, "path": path, "read_only": read_only, "effect": effect,
                         "schema_url": _schema_url(origin, path, method) if method in ("POST", "PATCH") and not path.endswith("/cancel") else origin + "/openapi.json"}
                        for command, method, path, read_only, effect in actions]}


def parser():
    result = Parser(description=__doc__, epilog="All output except --help is JSON. Place global options before the command. No real-trading command exists.")
    result.add_argument("--base-url", default=DEFAULT_BASE_URL, help="HTTP loopback API origin (default %(default)s)")
    result.add_argument("--timeout", type=float, default=10, help="Socket timeout in seconds, >0 and <=60 (default %(default)s)")
    result.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    commands = result.add_subparsers(dest="command", required=True, parser_class=Parser)
    commands.add_parser("capabilities", help="Print machine-readable action manifest without contacting the API")
    commands.add_parser("status", help="Read local workspace status")
    accounts = commands.add_parser("accounts", help="Read paper accounts or one account snapshot")
    accounts.add_argument("--account-id")
    runs = commands.add_parser("runs", help="Read saved Agent run history or one immutable trace")
    runs.add_argument("--run-id")
    candidates = commands.add_parser("candidates", help="Read candidate selection from a verified local scan")
    candidates.add_argument("--input", "-i", help="JSON file or - for stdin; omitted uses selector defaults")
    for name in ("preview", "run"):
        command = commands.add_parser(name, help="Compute Agent trace; run requires --save to persist")
        command.add_argument("--input", "-i", required=True, help="JSON file or - for stdin")
        if name == "run":
            command.add_argument("--save", action="store_true", help="Persist immutable Agent run (otherwise read-only preview)")
    proposal = commands.add_parser("proposal", help="Save a local paper proposal without accepting it")
    proposal.add_argument("--account-id", required=True)
    source = proposal.add_mutually_exclusive_group(required=True)
    source.add_argument("--run-id", help="Bridge an existing current Agent run")
    source.add_argument("--input", "-i", help="Explicit paper ProposalInput JSON file or - for stdin")
    proposal.add_argument("--expected-version", type=positive_version)
    proposal.add_argument("--idempotency-key")
    accept = commands.add_parser("accept", help="Explicitly accept a paper proposal into its simulated ledger")
    accept.add_argument("--paper", action="store_true", required=True, help="Required explicit acknowledgement of paper simulation")
    accept.add_argument("--account-id", required=True)
    accept.add_argument("--proposal-id", required=True)
    accept.add_argument("--expected-version", required=True, type=positive_version)
    accept.add_argument("--idempotency-key", required=True)
    state = commands.add_parser("automation-state", help="Read all mandates or one mandate and readiness")
    state.add_argument("--mandate-id")
    attempts = commands.add_parser("automation-attempts", help="Read one mandate's daily attempt history")
    attempts.add_argument("--mandate-id", required=True)
    attempts.add_argument("--limit", type=history_limit)
    create = commands.add_parser("automation-create", help="Save mandate JSON; defaults disabled and proposal_only")
    create.add_argument("--input", "-i", required=True, help="MandateInput JSON file or - for stdin")
    update = commands.add_parser("automation-update", help="Save explicit version-checked mandate changes")
    update.add_argument("--mandate-id", required=True)
    update.add_argument("--expected-version", required=True, type=positive_version)
    update.add_argument("--input", "-i", required=True, help="JSON changes only; expected_version comes from the flag")
    automate = commands.add_parser("automation-run", help="Attempt latest session once; default creates proposal only")
    automate.add_argument("--mandate-id", required=True)
    automate.add_argument("--expected-version", required=True, type=positive_version)
    automate.add_argument("--allow-paper-simulation", action="store_true", help="Explicitly permit paper fills if mandate mode is auto_simulate")
    commands.add_parser("local-models", help="Read installed local models; no inference or download")
    local_runs = commands.add_parser("local-runs", help="Read local model history or one job without waiting")
    history = local_runs.add_mutually_exclusive_group()
    history.add_argument("--run-id")
    history.add_argument("--limit", type=history_limit)
    analyze = commands.add_parser("local-analyze", help="Start and save a local model job; return immediately without polling")
    analyze.add_argument("--source-run-id", required=True, help="Saved verified rules run ID")
    analyze.add_argument("--model", required=True, type=local_model, help="Exact installed local-models name")
    analyze.add_argument("--mode", required=True, choices=("analysis", "conservative"))
    analyze.add_argument("--idempotency-key", required=True)
    cancel = commands.add_parser("local-cancel", help="Request cancellation of local model analysis, not paper actions")
    cancel.add_argument("--run-id", required=True)
    for name in ("local-paper-preview", "local-paper-proposal"):
        bridge = commands.add_parser(name, help="Read paper preview" if name.endswith("preview") else "Save paper proposal without accepting")
        bridge.add_argument("--run-id", required=True, help="Completed current local model analysis ID")
        bridge.add_argument("--account-id", required=True)
        bridge.add_argument("--expected-version", required=True, type=positive_version)
        if name.endswith("proposal"):
            bridge.add_argument("--idempotency-key", required=True)
    return result


def operation(args):
    command = args.command
    if command == "status":
        return "GET", "/api/status", None, True
    if command == "accounts":
        path = "/api/paper/accounts" + ("/" + identifier(args.account_id, "Account ID") if args.account_id else "")
        return "GET", path, None, True
    if command == "runs":
        path = "/api/portfolio-agent/runs" + ("/" + identifier(args.run_id, "Run ID") if args.run_id else "")
        return "GET", path, None, True
    if command == "automation-state":
        path = "/api/agent-automation/mandates/" + identifier(args.mandate_id, "Mandate ID") if args.mandate_id else "/api/agent-automation/state"
        return "GET", path, None, True
    if command == "automation-attempts":
        path = "/api/agent-automation/mandates/" + identifier(args.mandate_id, "Mandate ID") + "/attempts"
        return "GET", path + (f"?limit={args.limit}" if args.limit else ""), None, True
    if command == "automation-create":
        payload = read_input(args.input)
        payload.setdefault("enabled", False)
        payload.setdefault("mode", "proposal_only")
        return "POST", "/api/agent-automation/mandates", payload, False
    if command == "automation-update":
        path = "/api/agent-automation/mandates/" + identifier(args.mandate_id, "Mandate ID")
        payload = read_input(args.input)
        if not payload or "expected_version" in payload:
            raise CLIError(2, "invalid_arguments", "Mandate update JSON must contain changes only; supply expected_version using --expected-version")
        return "PATCH", path, {**payload, "expected_version": args.expected_version}, False
    if command == "automation-run":
        path = "/api/agent-automation/mandates/" + identifier(args.mandate_id, "Mandate ID") + "/run"
        return "POST", path, {"expected_version": args.expected_version, "allow_auto_simulate": args.allow_paper_simulation}, False
    if command == "local-models":
        return "GET", "/api/local-agent/models", None, True
    if command == "local-runs":
        path = "/api/local-agent/runs" + ("/" + identifier(args.run_id, "Run ID") if args.run_id else "")
        return "GET", path + (f"?limit={args.limit}" if args.limit else ""), None, True
    if command == "local-analyze":
        identifier(args.source_run_id, "Source run ID")
        return "POST", "/api/local-agent/runs", {"source_run_id": args.source_run_id, "model": args.model, "mode": args.mode,
                                                   "idempotency_key": idempotency_key(args.idempotency_key)}, False
    if command == "local-cancel":
        return "POST", "/api/local-agent/runs/" + identifier(args.run_id, "Run ID") + "/cancel", None, False
    if command in ("local-paper-preview", "local-paper-proposal"):
        run_id = identifier(args.run_id, "Run ID")
        identifier(args.account_id, "Account ID")
        payload = {"account_id": args.account_id, "expected_account_version": args.expected_version}
        save = command == "local-paper-proposal"
        if save:
            payload["idempotency_key"] = idempotency_key(args.idempotency_key)
        return "POST", f"/api/local-agent/runs/{run_id}/paper-" + ("proposal" if save else "preview"), payload, not save
    if command == "candidates":
        return "POST", "/api/portfolio-agent/candidates", read_input(args.input), True
    if command in ("preview", "run"):
        save = command == "run" and args.save
        return "POST", "/api/portfolio-agent/" + ("runs" if save else "preview"), read_input(args.input), not save
    if command == "proposal":
        account_id = identifier(args.account_id, "Account ID")
        if args.run_id:
            run_id = identifier(args.run_id, "Run ID")
            if args.expected_version is None or args.idempotency_key is None:
                raise CLIError(2, "invalid_arguments", "Proposal from run requires --expected-version and --idempotency-key")
            payload = {"account_id": args.account_id, "expected_account_version": args.expected_version,
                       "idempotency_key": idempotency_key(args.idempotency_key)}
            return "POST", f"/api/portfolio-agent/runs/{run_id}/paper-proposal", payload, False
        if args.expected_version is not None or args.idempotency_key is not None:
            raise CLIError(2, "invalid_arguments", "With --input, put expected_version and idempotency_key in the JSON body")
        payload = read_input(args.input)
        if type(payload.get("expected_version")) is not int or payload["expected_version"] < 1:
            raise CLIError(2, "invalid_version", "Paper proposal JSON requires a positive integer expected_version")
        idempotency_key(payload.get("idempotency_key"))
        return "POST", f"/api/paper/accounts/{account_id}/proposals", payload, False
    if command == "accept":
        account_id = identifier(args.account_id, "Account ID")
        proposal_id = identifier(args.proposal_id, "Proposal ID")
        payload = {"expected_version": args.expected_version, "idempotency_key": idempotency_key(args.idempotency_key)}
        return "POST", f"/api/paper/accounts/{account_id}/proposals/{proposal_id}/accept", payload, False
    raise CLIError(2, "invalid_arguments", "Unsupported command")


def emit(value, pretty=False):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None, separators=None if pretty else (",", ":")))


def main(argv=None):
    pretty = False
    try:
        args = parser().parse_args(argv)
        pretty = args.pretty
        origin, host, port = base_url(args.base_url)
        if not math.isfinite(args.timeout) or not 0 < args.timeout <= 60:
            raise CLIError(2, "invalid_timeout", "Timeout must be finite, positive and no greater than 60 seconds")
        if args.command == "capabilities":
            emit({"ok": True, "contract_version": CONTRACT_VERSION, "command": args.command,
                  "read_only": True, "data": capabilities(origin)}, pretty)
        else:
            method, path, payload, read_only = operation(args)
            data = request(origin, host, port, method, path, payload, args.timeout)
            emit({"ok": True, "contract_version": CONTRACT_VERSION, "command": args.command,
                  "read_only": read_only, "method": method, "url": origin + path, "data": data}, pretty)
        return 0
    except CLIError as exc:
        emit({"ok": False, "contract_version": CONTRACT_VERSION,
              "error": {"type": exc.kind, "message": exc.message, **exc.details}, "exit_code": exc.exit_code}, pretty)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
