"""Read-only verification of an AlphaView backup; never restores or opens live data."""
from contextlib import closing
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import struct
import tempfile
import time
import zipfile

FORMAT_FILES = {"alphaview.db", "manifest.json", "research-notes.json", "browser-settings.json"}
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = {"alphaview.db": 1024 * 1024 * 1024, "manifest.json": 1024 * 1024,
                    "research-notes.json": 10 * 1024 * 1024, "browser-settings.json": 100 * 1024}
MAX_TOTAL_BYTES = sum(MAX_MEMBER_BYTES.values())
MAX_COMPRESSION_RATIO = 2000
# Exact trusted schema signatures, generated from isolated fixtures, not uploaded SQL.
# Legacy v2 predates revision counters; recognized as requiring migration, never migrated here.
KNOWN_SCHEMAS = {
    # Trusted dd82732 store.py independently initialized in an isolated fixture (9 tables).
    "512db8da99053d46db57a91fe4ca88d432f151578cd73d622abe9694bfcc1e2e": "migration_required",
    "93f7c92d0bc173ca2e96eac5cbd0cd0d26cd10997570d3dfda1e5f654e97b4c3": "migration_required",
    "a161602153264d0616e2767c94ea3bdc605a99a785b31f78488200acb1f33264": "current",
    "f9ea8cd3a719e343144e88be36d112dcbaea30be8dbbe73eabf7a178c249a94d": "migration_required",
}


class PreflightError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise PreflightError(code, message)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail("duplicate_json_key", "JSON 含重複欄位")
            result[key] = value
        return result
    def constant(value):
        fail("nonfinite_json", "JSON 含非有限數字")
    def floating(value):
        number = float(value)
        if not math.isfinite(number):
            fail("nonfinite_json", "JSON 數字超出有限範圍")
        return number
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant, parse_float=floating)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise PreflightError("invalid_json", "備份 JSON 格式無效") from exc


def _directory_guard(stream, size):
    # Bound central-directory parsing before ZipFile allocates its metadata list.
    if size < 22:
        fail("invalid_zip", "ZIP 不完整")
    stream.seek(0)
    if stream.read(4) != b"PK\x03\x04":
        fail("invalid_zip", "只接受標準單一 ZIP，不接受附加程式或多卷檔案")
    stream.seek(max(0, size - 65557))
    tail = stream.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        fail("invalid_zip", "ZIP 目錄無效")
    absolute_end = max(0, size - 65557) + offset
    # CPython honors a preceding ZIP64 locator even without EOCD sentinel values.
    # Our bounded format never needs ZIP64; reject before ZipFile parses metadata.
    if absolute_end >= 20:
        stream.seek(absolute_end - 20)
        if stream.read(4) == b"PK\x06\x07":
            fail("zip64_unsupported", "本預檢不接受 ZIP64 備份")
    _, disk, directory_disk, disk_count, count, length, start, comment = struct.unpack("<4s4H2IH", tail[offset:offset + 22])
    if disk or directory_disk or disk_count != 4 or count != 4 or length > 65536 or start + length != absolute_end or offset + 22 + comment != len(tail):
        fail("zip_directory", "ZIP 必須只包含四個標準檔案，且目錄大小與結構有效")


def _timestamp(value):
    if not isinstance(value, str) or not value or len(value) > 80:
        fail("timestamp", "備份時間須為含時區的 ISO 日期時間")
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("missing timezone")
    except ValueError as exc:
        raise PreflightError("timestamp", "備份時間須為含時區的 ISO 日期時間") from exc


def _manifest(value):
    required = {"format_version", "product", "app_version", "engine_version", "snapshot_at", "sqlite_version",
                "schema_user_version", "schema_sha256", "table_counts", "files", "encrypted", "restore_automatic", "notes"}
    if not isinstance(value, dict) or set(value) != required:
        fail("manifest_schema", "Manifest 欄位不符合支援格式")
    if type(value["format_version"]) is not int or value["format_version"] != 1 or value["product"] != "AlphaView" or value["encrypted"] is not False or value["restore_automatic"] is not False:
        fail("manifest_version", "不支援此備份格式或產品")
    if any(not isinstance(value[key], str) or not value[key] or len(value[key]) > 4000 for key in ("app_version", "engine_version", "snapshot_at", "sqlite_version", "schema_sha256", "notes")):
        fail("manifest_schema", "Manifest 文字欄位無效")
    if type(value["schema_user_version"]) is not int or not isinstance(value["table_counts"], dict) or any(type(v) is not int or v < 0 for v in value["table_counts"].values()):
        fail("manifest_schema", "Manifest 資料表筆數無效")
    if not isinstance(value["files"], dict) or set(value["files"]) != FORMAT_FILES - {"manifest.json"}:
        fail("manifest_files", "Manifest 檔案清單不符合格式")
    for name, entry in value["files"].items():
        if not isinstance(entry, dict) or set(entry) != {"sha256", "bytes"} or type(entry["bytes"]) is not int or entry["bytes"] < 0:
            fail("manifest_files", "Manifest 長度欄位無效")
        digest = entry["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            fail("manifest_files", "Manifest 雜湊欄位無效")
    _timestamp(value["snapshot_at"])
    return value


def check_backup(path, *, temp_root=None, seconds=120, stop_marker=None):
    """Validate one ZIP in private temporary storage; return an aggregate-only report."""
    if not 0 < seconds <= 180:
        fail("deadline", "預檢時間上限須介於 0 與 180 秒")
    deadline = time.monotonic() + seconds
    def check():
        if stop_marker and Path(stop_marker).exists():
            fail("stopped", "已收到 STOP，預檢停止")
        if time.monotonic() >= deadline:
            fail("timeout", "備份預檢逾時，未完成驗證")
    check()
    folder = None
    try:
        with Path(path).open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            if size > MAX_ARCHIVE_BYTES or not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                fail("archive_size", "備份不是一般檔案或超過 512 MiB 上限")
            _directory_guard(source, size)
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                names = [member.orig_filename for member in members]
                if len(names) != 4 or set(names) != FORMAT_FILES:
                    fail("zip_members", "備份含重複、額外、缺少或非法路徑檔案")
                for member in members:
                    mode = member.external_attr >> 16
                    if member.filename != member.orig_filename or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or member.is_dir() or member.flag_bits & 1:
                        fail("zip_member_type", "不接受連結、目錄、特殊或加密檔案")
                    if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                        fail("zip_compression", "不支援此 ZIP 壓縮格式")
                    if member.file_size > MAX_MEMBER_BYTES[member.filename] or member.file_size / max(1, member.compress_size) > MAX_COMPRESSION_RATIO:
                        fail("expanded_size", "備份解壓大小或壓縮比超過安全上限")
                if sum(member.file_size for member in members) > MAX_TOTAL_BYTES:
                    fail("expanded_size", "備份解壓總量超過上限")
                folder = Path(tempfile.mkdtemp(prefix="alphaview-preflight-", dir=temp_root)).resolve()
                os.chmod(folder, 0o700)
                total, actual = 0, {}
                for member in members:
                    check()
                    digest, written = hashlib.sha256(), 0
                    target = folder / member.filename
                    with archive.open(member) as incoming, target.open("xb") as output:
                        os.chmod(target, 0o600)
                        while chunk := incoming.read(1024 * 1024):
                            check()
                            written += len(chunk)
                            total += len(chunk)
                            if written > MAX_MEMBER_BYTES[member.filename] or total > MAX_TOTAL_BYTES:
                                fail("expanded_size", "實際解壓量超過上限")
                            output.write(chunk)
                            digest.update(chunk)
                    if written != member.file_size:
                        fail("member_length", "ZIP 解壓長度不一致")
                    actual[member.filename] = {"sha256": digest.hexdigest(), "bytes": written}
        check()
        manifest = _manifest(strict_json((folder / "manifest.json").read_bytes()))
        if any(actual[name] != metadata for name, metadata in manifest["files"].items()):
            fail("file_hash", "檔案雜湊或長度與 Manifest 不一致")
        notes = strict_json((folder / "research-notes.json").read_bytes())
        preferences = strict_json((folder / "browser-settings.json").read_bytes())
        if not isinstance(notes, dict) or set(notes) != {"format_version", "snapshot_at", "notes"} or type(notes["format_version"]) is not int or notes["format_version"] != 1 or notes["snapshot_at"] != manifest["snapshot_at"] or not isinstance(notes["notes"], list):
            fail("notes_schema", "筆記 JSON 格式或快照時間不符")
        if not isinstance(preferences, dict) or set(preferences) != {"format_version", "received_at", "preferences"} or type(preferences["format_version"]) is not int or preferences["format_version"] != 1 or preferences["received_at"] != manifest["snapshot_at"]:
            fail("preferences_schema", "瀏覽器設定格式或時間不符")
        _timestamp(notes["snapshot_at"])
        _timestamp(preferences["received_at"])
        # Existing pure Pydantic validation; no archive SQL or live DB initialization.
        from .backups import Preferences
        try:
            validated = Preferences.model_validate(preferences["preferences"])
        except (ValueError, TypeError) as exc:
            raise PreflightError("preferences_schema", "瀏覽器設定不符合支援格式") from exc
        database = folder / "alphaview.db"
        with database.open("rb") as handle:
            header = handle.read(100)
        if len(header) != 100 or header[:16] != b"SQLite format 3\0" or header[18:20] != b"\x01\x01":
            fail("database_header", "資料庫不是獨立的 rollback-journal SQLite 備份")
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=1)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("PRAGMA mmap_size=0")
            db.execute("PRAGMA cell_size_check=ON")
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 64 * 1024 * 1024)
            db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
            db.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline or bool(stop_marker and Path(stop_marker).exists())), 1000)
            schema = [dict(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
            schema_hash = hashlib.sha256(json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            if schema_hash != manifest["schema_sha256"]:
                fail("schema_hash", "資料庫 schema 與 Manifest 不一致")
            if schema_hash not in KNOWN_SCHEMAS:
                fail("unsupported_schema", "未支援此精確 schema；不代表備份損壞，需另行相容性審查")
            if db.execute("PRAGMA user_version").fetchone()[0] != manifest["schema_user_version"]:
                fail("schema_version", "資料庫版本與 Manifest 不一致")
            if [row[0] for row in db.execute("PRAGMA integrity_check")] != ["ok"]:
                fail("database_integrity", "SQLite 完整性檢查未通過")
            names = [row["name"] for row in schema if row["type"] == "table"]
            counts = {name: db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0] for name in names}
            if counts != manifest["table_counts"]:
                fail("table_counts", "資料表筆數與 Manifest 不一致")
            note_count, note_bytes = db.execute("SELECT COUNT(*), COALESCE(SUM(length(CAST(note AS BLOB))+length(CAST(tags AS BLOB))),0) FROM research_notes").fetchone()
            if note_count > 10000 or note_bytes > MAX_MEMBER_BYTES["research-notes.json"]:
                fail("notes_size", "筆記資料超過預檢支援上限")
            saved_notes = [dict(row) for row in db.execute("SELECT * FROM research_notes ORDER BY symbol")]
            for note in saved_notes:
                note["tags"] = strict_json(note["tags"].encode())
            if saved_notes != notes["notes"]:
                fail("notes_mismatch", "筆記匯出與資料庫快照不一致")
            running = db.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
            enabled = db.execute("SELECT enabled FROM refresh_schedule WHERE id=1").fetchone() if "refresh_schedule" in names else None
        check()
        return {"valid": True, "integrity": "passed", "compatibility": KNOWN_SCHEMAS[schema_hash],
                "authenticity": "not_authenticated", "restored": False, "snapshot_at": manifest["snapshot_at"],
                "app_version": manifest["app_version"], "engine_version": manifest["engine_version"],
                "schema_sha256": schema_hash, "archive_bytes": size, "expanded_bytes": total,
                "table_counts": counts, "browser_preset_count": len(validated.presets),
                "running_job_count": running, "schedule_enabled_in_snapshot": bool(enabled[0]) if enabled is not None else None,
                "warnings": ["只驗證備份內部完整性與已知 schema，未驗證來源身分；Manifest 雜湊不是數位簽章。",
                             "沒有還原、寫入工作區或套用瀏覽器設定。執行中作業與排程需要另行還原政策。",
                             "不逐筆驗證所有行情及回測內容的業務正確性；舊引擎結果仍需重算。"]}
    except (zipfile.BadZipFile, EOFError, RuntimeError) as exc:
        raise PreflightError("invalid_zip", "ZIP 解壓或 CRC 檢查失敗") from exc
    except sqlite3.Error as exc:
        check()
        raise PreflightError("database_error", "資料庫無法安全檢查或內容不受支援") from exc
    finally:
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)
