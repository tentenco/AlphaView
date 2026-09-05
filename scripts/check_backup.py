#!/usr/bin/env python3
"""Check a local AlphaView ZIP without restoring, uploading, or changing the workspace."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--stop-marker", type=Path, default=ROOT / "STOP")
    parser.add_argument("--output", type=Path, help="Optional new aggregate JSON report; existing files are never overwritten")
    parser.add_argument("--worker-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 180:
        parser.error("--seconds must be between 1 and 180")
    if args.output and args.output.exists():
        parser.error("Report already exists; refusing to overwrite")
    if args.worker_root:
        from alphaview.panel.backup_preflight import check_backup, PreflightError
        try:
            report = check_backup(args.archive, temp_root=args.worker_root, seconds=args.seconds, stop_marker=args.stop_marker)
        except PreflightError as exc:
            report = {"valid": False, "restored": False, "code": exc.code, "message": str(exc)}
        except (OSError, ValueError, TypeError):
            report = {"valid": False, "restored": False, "code": "input_error", "message": "備份檔案無法讀取或格式不受支援"}
        with (args.worker_root / "report.json").open("x") as handle:
            json.dump(report, handle, ensure_ascii=False, allow_nan=False)
        return 0 if report["valid"] else 1
    folder = Path(tempfile.mkdtemp(prefix="alphaview-preflight-parent-"))
    process = None
    report = {"valid": False, "restored": False, "code": "incomplete", "message": "預檢未完成"}
    try:
        if args.stop_marker.exists():
            report.update(code="stopped", message="已收到 STOP，未開始預檢")
        else:
            deadline = time.monotonic() + args.seconds
            with (folder / "worker.log").open("x") as log:
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(args.archive.resolve()),
                                            "--seconds", str(args.seconds), "--stop-marker", str(args.stop_marker.resolve()),
                                            "--worker-root", str(folder)], stdout=log, stderr=subprocess.STDOUT)
                while True:
                    if args.stop_marker.exists():
                        report.update(code="stopped", message="已收到 STOP，預檢停止")
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        report.update(code="timeout", message="備份預檢逾時，未完成驗證")
                        break
                    try:
                        process.wait(timeout=min(1, remaining))
                        if (folder / "report.json").is_file():
                            report = json.loads((folder / "report.json").read_text())
                        break
                    except subprocess.TimeoutExpired:
                        pass
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        shutil.rmtree(folder, ignore_errors=True)
    text = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    if args.output:
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(text)
    else:
        print(text, end="")
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
