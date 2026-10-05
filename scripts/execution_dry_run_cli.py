#!/usr/bin/env python3
"""Standalone synthetic execution traces. Never opens a workspace or provider."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from alphaview.panel import execution_dry_run as dry_run


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        raise dry_run.DryRunError("invalid_arguments", "Use preview --input, save --input --output, or inspect --receipt; --pretty is a global option")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise dry_run.DryRunError("duplicate_json_key", "JSON object keys must be unique")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise dry_run.DryRunError("invalid_json_number", "NaN and Infinity are not allowed")


def _parse_int(value):
    if len(value.lstrip("-")) > 32:
        raise dry_run.DryRunError("invalid_json_number", "JSON integer exceeds the supported 32-digit bound")
    return int(value)


def _parse_float(_value):
    raise dry_run.DryRunError("invalid_json_number", "Decimal quantities and prices must use strings, not JSON floating-point numbers")


def decode_json(raw, maximum):
    if len(raw) > maximum:
        raise dry_run.DryRunError("file_too_large", "JSON input exceeds its byte limit")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_invalid_constant,
                            parse_int=_parse_int, parse_float=_parse_float)
        if not isinstance(result, dict):
            raise dry_run.DryRunError("json_object_required", "The JSON root must be an object")
        return result
    except dry_run.DryRunError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise dry_run.DryRunError("invalid_json", "Input must be a bounded UTF-8 JSON object") from None


def read_input(path, stream=None):
    if "\x00" in os.fspath(path):
        raise dry_run.DryRunError("input_path_invalid", "Input paths cannot contain null bytes")
    if path == "-":
        raw = (stream or sys.stdin.buffer).read(dry_run.MAX_INPUT_BYTES + 1)
    else:
        # Only the explicitly supplied input path is read. No file discovery,
        # environment lookup, workspace initialization or automatic source data.
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise dry_run.DryRunError("input_not_regular", "Input must be a regular JSON file or stdin")
            raw = handle.read(dry_run.MAX_INPUT_BYTES + 1)
    return decode_json(raw, dry_run.MAX_INPUT_BYTES)


def _artifact_parts(path, artifact_root):
    root = Path(artifact_root).absolute()
    supplied = Path(path)
    if ".." in supplied.parts:
        raise dry_run.DryRunError("artifact_path_invalid", "Receipt paths must stay within the artifacts directory")
    target = supplied.absolute()
    try:
        parts = target.relative_to(root).parts
    except ValueError:
        raise dry_run.DryRunError("artifact_path_invalid", "Receipt paths must stay within the artifacts directory") from None
    if (not parts or len(parts) > 20 or any(not part or part in (".", "..") for part in parts)
            or target.suffix != ".json" or len(str(target)) > 4096):
        raise dry_run.DryRunError("artifact_path_invalid", "Choose a bounded JSON filename under artifacts")
    try:
        if any(len(part.encode("utf-8")) > 255 or any(ord(character) < 32 or ord(character) == 127 for character in part) for part in parts):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise dry_run.DryRunError("artifact_path_invalid", "Artifact path components must be valid bounded filenames without control characters") from None
    return root, parts, target


def _parent_fd(path, artifact_root, *, create=False):
    root, parts, target = _artifact_parts(path, artifact_root)
    if create:
        root.mkdir(mode=0o700, parents=False, exist_ok=True)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            following = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor, parts[-1], target
    except BaseException:
        os.close(descriptor)
        raise


def save_receipt(receipt, path, artifact_root):
    dry_run.verify_receipt(receipt)
    encoded = (dry_run.canonical(receipt) + "\n").encode("utf-8")
    if len(encoded) > dry_run.MAX_RECEIPT_BYTES:
        raise dry_run.DryRunError("receipt_too_large", "Receipt exceeds 4 MiB")
    parent, name, target = _parent_fd(path, artifact_root, create=True)
    staging = ".execution-dry-run-" + uuid.uuid4().hex + ".tmp"
    staged = False
    published = False
    try:
        try:
            os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise dry_run.DryRunError("output_exists", "The receipt target already exists; it was not overwritten")
        descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        staged = True
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Atomic exclusive publication: link fails when another writer won.
            os.link(staging, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            raise dry_run.DryRunError("output_exists", "The receipt target already exists; it was not overwritten") from None
        published = True
        os.fsync(parent)
        return str(target)
    except OSError:
        if published:
            raise dry_run.DryRunError("publication_durability_unknown", "A complete receipt was published but directory durability could not be confirmed; inspect the same path without overwriting") from None
        raise
    finally:
        try:
            if staged:
                try:
                    os.unlink(staging, dir_fd=parent)
                except OSError:
                    # A hidden complete staging file is preferable to masking
                    # the known exclusive publication result.
                    pass
        finally:
            os.close(parent)


def inspect_receipt(path, artifact_root):
    parent, name, _target = _parent_fd(path, artifact_root)
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise dry_run.DryRunError("receipt_not_regular", "Receipt must be a regular JSON file")
            receipt = decode_json(handle.read(dry_run.MAX_RECEIPT_BYTES + 1), dry_run.MAX_RECEIPT_BYTES)
    finally:
        os.close(parent)
    return {**dry_run.verify_receipt(receipt), "receipt": receipt}


def parser():
    result = JsonArgumentParser(description="Pure synthetic execution trace replay; no broker, provider or account access.")
    result.add_argument("--pretty", action="store_true", help="Indent JSON output")
    commands = result.add_subparsers(dest="command", required=True)
    preview = commands.add_parser("preview", help="Read and replay supplied synthetic JSON without writing files")
    preview.add_argument("--input", required=True, help="Explicit input JSON path, or - for stdin")
    save = commands.add_parser("save", help="Replay and exclusively publish a synthetic receipt under repository artifacts")
    save.add_argument("--input", required=True, help="Explicit input JSON path, or - for stdin")
    save.add_argument("--output", required=True, help="New artifacts/...json receipt; existing files are never overwritten")
    inspect = commands.add_parser("inspect", help="Read an artifact receipt and verify hashes, without replaying it")
    inspect.add_argument("--receipt", required=True, help="Existing artifacts/...json receipt")
    return result


def main(argv=None, *, artifact_root=None, stdin=None, stdout=None):
    artifact_root = ROOT / "artifacts" if artifact_root is None else Path(artifact_root)
    output = stdout or sys.stdout
    args = None
    try:
        args = parser().parse_args(argv)
        if args.command == "inspect":
            response = {"ok": True, "action": "inspect", **inspect_receipt(args.receipt, artifact_root)}
        else:
            trace = read_input(args.input, stdin)
            if args.command == "preview":
                response = {"ok": True, "action": "preview", "result": dry_run.replay_trace(trace)}
            else:
                created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                receipt = dry_run.make_receipt(trace, created)
                path = save_receipt(receipt, args.output, artifact_root)
                response = {"ok": True, "action": "save", "path": path,
                            "content_sha256": receipt["content_sha256"],
                            "input_sha256": receipt["content"]["result"]["input_sha256"],
                            "state": receipt["content"]["result"]["state"],
                            "order_terminal": receipt["content"]["result"]["order_terminal"]}
        exit_code = 0
    except dry_run.DryRunError as exc:
        response, exit_code = {"ok": False, "error": exc.detail}, 2
    except OSError:
        response, exit_code = {"ok": False, "error": {"code": "file_unavailable", "message": "The explicit file path could not be safely read or written"}}, 3
    encoded = json.dumps(response, ensure_ascii=False, allow_nan=False, indent=2 if args is not None and args.pretty else None)
    output.write(encoded + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
