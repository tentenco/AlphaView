#!/usr/bin/env python3
"""Run the five acceptance gates once and write gates.json into a harness folder.

Usage: python3 scripts/run_harness_gates.py artifacts/harness-<date>

Each gate is a fixed command from AGENTS.md; the script records pass/fail, the last meaningful
output line, duration and full output logs. It never retries or edits project files.
"""
import datetime
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATES = [
    ("pytest", ["uv", "run", "--extra", "web", "--extra", "dev", "pytest", "-q"]),
    ("vitest", ["npm", "test", "--prefix", "web"]),
    ("format:check", ["npm", "run", "format:check", "--prefix", "web"]),
    ("build", ["npm", "run", "build", "--prefix", "web"]),
    ("git diff --check", ["git", "diff", "--check"]),
]


def summary_line(output):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in reversed(lines):
        if any(token in line for token in ("passed", "failed", "Tests ", "Test Files", "built in", "error", "All matched", "Code style")):
            return line[:200]
    return lines[-1][:200] if lines else ""


def main():
    folder = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if folder:
        (folder / "gate-logs").mkdir(parents=True, exist_ok=True)
    results = []
    for number, (name, command) in enumerate(GATES, 1):
        started = time.monotonic()
        print(f"START {name}", flush=True)
        completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        output = completed.stdout + completed.stderr
        log_name = f"gate-logs/{number:02d}-{name.replace(':', '-').replace(' ', '-')}.log"
        if folder:
            (folder / log_name).write_text(output)
        results.append({"gate": name, "command": " ".join(command), "passed": completed.returncode == 0,
                        "summary": summary_line(output) or f"exit {completed.returncode}",
                        "seconds": round(time.monotonic() - started, 1),
                        "log": log_name if folder else None})
        print(f"{'PASS' if completed.returncode == 0 else 'FAIL'} {name}: {results[-1]['summary']}", flush=True)
    payload = {"at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"), "results": results,
               "all_passed": all(row["passed"] for row in results)}
    if folder:
        (folder / "gates.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote {folder / 'gates.json'}")
    return 0 if payload["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
