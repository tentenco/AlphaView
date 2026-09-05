import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import zipfile

import pytest

from alphaview.panel import backup_preflight as preflight, backups, store


@pytest.fixture
def archive(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "source.db"))
    monkeypatch.setattr(store, "ROOT", tmp_path)
    (tmp_path / "pyproject.toml").write_text('[project]\nversion="2.0.0"\n')
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES ('TEST','Private name',2,123,'test','now')")
        db.execute("INSERT INTO research_notes(symbol,note,tags,updated_at) VALUES ('TEST','Private note','[\"test\"]','now')")
    folder, path = backups.create_archive({"presets": [], "universe_limit": 500})
    return path


def contents(path):
    with zipfile.ZipFile(path) as package:
        return {name: package.read(name) for name in package.namelist()}


def repack(tmp_path, data, *, rehash=False):
    if rehash:
        manifest = json.loads(data["manifest.json"])
        for name in preflight.FORMAT_FILES - {"manifest.json"}:
            manifest["files"][name] = {"bytes": len(data[name]), "sha256": hashlib.sha256(data[name]).hexdigest()}
        data["manifest.json"] = json.dumps(manifest).encode()
    path = tmp_path / "altered.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for name, value in data.items():
            package.writestr(name, value)
    return path


def schema_manifest(data, database):
    with sqlite3.connect(database) as db:
        db.row_factory = sqlite3.Row
        schema = [dict(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
        manifest = json.loads(data["manifest.json"])
        manifest["schema_sha256"] = hashlib.sha256(json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        manifest["table_counts"] = {row["name"]: db.execute('SELECT COUNT(*) FROM "' + row["name"] + '"').fetchone()[0] for row in schema if row["type"] == "table"}
    data["alphaview.db"] = database.read_bytes()
    data["manifest.json"] = json.dumps(manifest).encode()


def test_current_export_passes_without_private_content_or_source_mutation(archive, tmp_path):
    source = store.db_path().read_bytes()
    before = archive.read_bytes()
    result = preflight.check_backup(archive, temp_root=tmp_path)
    assert result["valid"] and result["compatibility"] == "current"
    assert result["table_counts"]["positions"] == result["table_counts"]["research_notes"] == 1
    assert result["authenticity"] == "not_authenticated" and not result["restored"]
    report = json.dumps(result)
    assert all(private not in report for private in ("Private name", "Private note", "TEST", "123"))
    assert store.db_path().read_bytes() == source and archive.read_bytes() == before
    assert not list(tmp_path.glob("alphaview-preflight-*"))


def test_known_legacy_schema_requires_migration_without_executing_it(archive, tmp_path):
    data = contents(archive)
    database = tmp_path / "legacy.db"
    database.write_bytes(data["alphaview.db"])
    with sqlite3.connect(database) as db:
        for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='trigger'").fetchall():
            db.execute('DROP TRIGGER "' + name + '"')
        db.execute("DROP TABLE panel_revisions")
    schema_manifest(data, database)
    result = preflight.check_backup(repack(tmp_path, data, rehash=True), temp_root=tmp_path)
    assert result["compatibility"] == "migration_required"
    assert "panel_revisions" not in result["table_counts"]


@pytest.mark.parametrize("name", ["../alphaview.db", "/alphaview.db", "dir/alphaview.db", "alphaview.db\\evil", "ALPHAVIEW.DB"])
def test_illegal_member_names_rejected(archive, tmp_path, name):
    data = contents(archive)
    data[name] = data.pop("alphaview.db")
    with pytest.raises(preflight.PreflightError):
        preflight.check_backup(repack(tmp_path, data), temp_root=tmp_path)
    assert not list(tmp_path.glob("alphaview-preflight-*"))


def test_duplicate_extra_missing_members_rejected(archive, tmp_path):
    data = contents(archive)
    for index, names in enumerate((["manifest.json"] * 4, list(data) + ["evil"], list(data)[:-1])):
        path = tmp_path / f"bad-{index}.zip"
        with zipfile.ZipFile(path, "w") as package:
            for name in names:
                package.writestr(name, data.get(name, b"x"))
        with pytest.raises(preflight.PreflightError):
            preflight.check_backup(path)


def test_symlink_rejected(archive, tmp_path):
    data = contents(archive)
    path = tmp_path / "link.zip"
    with zipfile.ZipFile(path, "w") as package:
        for name, value in data.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16 if name == "alphaview.db" else 0
            package.writestr(info, value)
    with pytest.raises(preflight.PreflightError, match="連結"):
        preflight.check_backup(path)


def test_file_hash_mismatch_and_failed_cleanup(archive, tmp_path):
    data = contents(archive)
    data["research-notes.json"] += b" "
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(repack(tmp_path, data), temp_root=tmp_path)
    assert caught.value.code == "file_hash"
    assert not list(tmp_path.glob("alphaview-preflight-*"))


def test_notes_mismatch_even_with_matching_file_hash(archive, tmp_path):
    data = contents(archive)
    notes = json.loads(data["research-notes.json"])
    notes["notes"][0]["note"] = "Changed"
    data["research-notes.json"] = json.dumps(notes).encode()
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(repack(tmp_path, data, rehash=True))
    assert caught.value.code == "notes_mismatch"


@pytest.mark.parametrize("bad", [b'{"format_version":1,"format_version":1}', b'{"format_version":NaN}', b'not-json'])
def test_manifest_invalid_json(archive, tmp_path, bad):
    data = contents(archive)
    data["manifest.json"] = bad
    with pytest.raises(preflight.PreflightError):
        preflight.check_backup(repack(tmp_path, data))


def test_unknown_schema_even_if_manifest_matches_is_not_executed(archive, tmp_path):
    data = contents(archive)
    database = tmp_path / "unknown.db"
    database.write_bytes(data["alphaview.db"])
    with sqlite3.connect(database) as db:
        db.execute("CREATE VIEW dangerous AS SELECT load_extension('never')")
    schema_manifest(data, database)
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(repack(tmp_path, data, rehash=True))
    assert caught.value.code == "unsupported_schema"


def test_corrupt_database_and_declared_table_count_mismatch(archive, tmp_path):
    data = contents(archive)
    data["alphaview.db"] = b"invalid sqlite"
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(repack(tmp_path, data, rehash=True))
    assert caught.value.code == "database_header"
    data = contents(archive)
    manifest = json.loads(data["manifest.json"])
    manifest["table_counts"]["positions"] = 999
    data["manifest.json"] = json.dumps(manifest).encode()
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(repack(tmp_path, data))
    assert caught.value.code == "table_counts"


def test_size_limits_and_stop_cleanup(archive, tmp_path, monkeypatch):
    monkeypatch.setattr(preflight, "MAX_ARCHIVE_BYTES", 1)
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(archive)
    assert caught.value.code == "archive_size"
    monkeypatch.setattr(preflight, "MAX_ARCHIVE_BYTES", 512 * 1024 * 1024)
    monkeypatch.setattr(preflight, "MAX_COMPRESSION_RATIO", 1)
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(archive)
    assert caught.value.code == "expanded_size"
    marker = tmp_path / "STOP"
    marker.touch()
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(archive, stop_marker=marker)
    assert caught.value.code == "stopped"


def test_private_temp_permissions(archive, tmp_path, monkeypatch):
    original = preflight.sqlite3.connect
    def inspect_permissions(database_uri, **kwargs):
        from urllib.parse import urlparse, unquote
        path = Path(unquote(urlparse(database_uri).path))
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        return original(database_uri, **kwargs)
    monkeypatch.setattr(preflight.sqlite3, "connect", inspect_permissions)
    assert preflight.check_backup(archive, temp_root=tmp_path)["valid"]


def test_cli_valid_output_and_refuses_overwrite(archive, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts/check_backup.py"
    output = tmp_path / "result.json"
    result = subprocess.run([sys.executable, str(script), str(archive), "--output", str(output)], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(output.read_text())["valid"]
    result = subprocess.run([sys.executable, str(script), str(archive), "--output", str(output)], capture_output=True, text=True, timeout=15)
    assert result.returncode != 0 and "overwrite" in result.stderr


def test_embedded_nul_zip_name_rejected_before_normalization(archive, tmp_path):
    data = contents(archive)
    data["alphaview.db@evil"] = data.pop("alphaview.db")
    path = repack(tmp_path, data)
    path.write_bytes(path.read_bytes().replace(b"alphaview.db@evil", b"alphaview.db\x00evil"))
    with pytest.raises(preflight.PreflightError):
        preflight.check_backup(path)


def test_json_numeric_overflow_rejected():
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.strict_json(b'{"number":1e999}')
    assert caught.value.code == "nonfinite_json"


def test_crc_failure_detected_and_cleans_temp(archive, tmp_path):
    data = contents(archive)
    path = tmp_path / "crc.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as package:
        for name, value in data.items():
            package.writestr(name, value)
    value = path.read_bytes()
    assert b"Private note" in value
    path.write_bytes(value.replace(b"Private note", b"Changed note", 1))
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(path, temp_root=tmp_path)
    assert caught.value.code == "invalid_zip"
    assert not list(tmp_path.glob("alphaview-preflight-*"))


def test_real_stream_counter_exceeds_limit_after_declared_check(archive, tmp_path, monkeypatch):
    original = preflight.MAX_MEMBER_BYTES.copy()
    real_open = zipfile.ZipFile.open
    def bounded_open(self, member, *args, **kwargs):
        # Shrink only after central-directory checks to exercise streamed byte accounting.
        preflight.MAX_MEMBER_BYTES[member.filename] = 1
        return real_open(self, member, *args, **kwargs)
    monkeypatch.setattr(preflight, "MAX_MEMBER_BYTES", original.copy())
    monkeypatch.setattr(zipfile.ZipFile, "open", bounded_open)
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(archive, temp_root=tmp_path)
    assert caught.value.code == "expanded_size"
    assert not list(tmp_path.glob("alphaview-preflight-*"))


def test_cli_timeout_kills_worker_and_cleans_parent_temp(tmp_path, monkeypatch):
    from unittest.mock import Mock
    script = Path(__file__).resolve().parents[1] / "scripts/check_backup.py"
    spec = importlib.util.spec_from_file_location("check_backup_test", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    root = tmp_path / "worker-root"
    root.mkdir()
    monkeypatch.setattr(cli.tempfile, "mkdtemp", lambda **kwargs: str(root))
    monkeypatch.setattr(cli.sys, "argv", ["check", str(tmp_path / "dummy.zip"), "--seconds", "1"])
    clock = iter([0, 2])
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(clock))
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *args, **kwargs: process)
    assert cli.main() == 1
    process.kill.assert_called_once()
    process.wait.assert_called_once()
    assert not root.exists()


def test_cli_stop_prevents_worker_and_cleans_parent_temp(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / "scripts/check_backup.py"
    spec = importlib.util.spec_from_file_location("check_backup_stop_test", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    root = tmp_path / "worker-root"
    root.mkdir()
    marker = tmp_path / "STOP"
    marker.touch()
    monkeypatch.setattr(cli.tempfile, "mkdtemp", lambda **kwargs: str(root))
    monkeypatch.setattr(cli.sys, "argv", ["check", "dummy.zip", "--stop-marker", str(marker)])
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("Must not start worker"))
    assert cli.main() == 1
    assert not root.exists()


@pytest.mark.parametrize("timestamp", ["invalid", "2026-09-05", "2026-09-05T00:00:00", 123, None])
def test_all_matching_but_invalid_snapshot_timestamps_rejected(archive, tmp_path, timestamp):
    data = contents(archive)
    for name, field in (("manifest.json", "snapshot_at"), ("research-notes.json", "snapshot_at"), ("browser-settings.json", "received_at")):
        value = json.loads(data[name])
        value[field] = timestamp
        data[name] = json.dumps(value).encode()
    with pytest.raises(preflight.PreflightError):
        preflight.check_backup(repack(tmp_path, data, rehash=True))


def test_early_nine_table_backup_requires_migration_and_schedule_unknown(archive, tmp_path):
    data = contents(archive)
    database = tmp_path / "early.db"
    database.write_bytes(data["alphaview.db"])
    with sqlite3.connect(database) as db:
        for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='trigger'").fetchall():
            db.execute('DROP TRIGGER "' + name + '"')
        for table in ("panel_revisions", "refresh_schedule", "schedule_attempts"):
            db.execute(f"DROP TABLE {table}")
    schema_manifest(data, database)
    assert json.loads(data["manifest.json"])["schema_sha256"] == "512db8da99053d46db57a91fe4ca88d432f151578cd73d622abe9694bfcc1e2e"
    result = preflight.check_backup(repack(tmp_path, data, rehash=True), temp_root=tmp_path)
    assert result["compatibility"] == "migration_required"
    assert len(result["table_counts"]) == 9
    assert result["schedule_enabled_in_snapshot"] is None


def test_standard_zip64_extension_is_rejected_before_zipfile_parsing(archive, tmp_path, monkeypatch):
    import struct
    original = archive.read_bytes()
    end = original.rfind(b"PK\x05\x06")
    fields = struct.unpack("<4s4H2IH", original[end:end + 22])
    count, length, start = fields[4], fields[5], fields[6]
    # A benign ZIP64 extension with the same small directory and file counts.
    record = struct.pack("<4sQ2H2I4Q", b"PK\x06\x06", 44, 45, 45, 0, 0, count, count, length, start)
    locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, end, 1)
    path = tmp_path / "standard-zip64.zip"
    path.write_bytes(original[:end] + record + locator + original[end:])
    with zipfile.ZipFile(path) as standard_reader:
        assert set(standard_reader.namelist()) == preflight.FORMAT_FILES
    monkeypatch.setattr(preflight.zipfile, "ZipFile", lambda *args, **kwargs: pytest.fail("ZIP64 must be rejected before metadata parsing"))
    with pytest.raises(preflight.PreflightError) as caught:
        preflight.check_backup(path)
    assert caught.value.code == "zip64_unsupported"
