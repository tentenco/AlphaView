"""Consistent, user-triggered local backups. No restore or arbitrary paths."""
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import time
import tomllib
from typing import Literal
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from . import research, store

router = APIRouter()
BACKUP_LOCK = threading.Lock()
DEADLINE_SECONDS = 30


class CleanupFileResponse(FileResponse):
    """Delete the private archive even on range errors or a broken connection."""

    def __init__(self, path, *, cleanup_folder, **kwargs):
        super().__init__(path, **kwargs)
        self.cleanup_folder = cleanup_folder

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Synchronous cleanup has no cancellation point. These are a small
            # fixed number of private files, not a recursive user-selected tree.
            shutil.rmtree(self.cleanup_folder, ignore_errors=True)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NumericFilters(StrictModel):
    priceMin: str = Field(default="", max_length=30)
    priceMax: str = Field(default="", max_length=30)
    rsiMin: str = Field(default="", max_length=30)
    rsiMax: str = Field(default="", max_length=30)
    volumeMin: str = Field(default="", max_length=30)
    rpsMin: str = Field(default="", max_length=30)
    matchesMin: str = Field(default="", max_length=30)

    @model_validator(mode="after")
    def valid_numbers(self):
        values = {}
        for field, raw in self.model_dump().items():
            if not raw.strip():
                continue
            try:
                value = float(raw)
            except ValueError as exc:
                raise ValueError("篩選設定包含無效數字") from exc
            if not math.isfinite(value) or value < 0:
                raise ValueError("篩選數字須為零以上的有限值")
            if field in {"rsiMin", "rsiMax", "rpsMin"} and value > 100:
                raise ValueError("RSI／RPS 須介於 0–100")
            if field == "matchesMin" and (value > 4 or not value.is_integer()):
                raise ValueError("符合策略數須為 0–4 整數")
            values[field] = value
        for low, high in (("priceMin", "priceMax"), ("rsiMin", "rsiMax")):
            if low in values and high in values and values[low] > values[high]:
                raise ValueError("篩選下限不可大於上限")
        return self


class PresetSettings(StrictModel):
    scope: Literal["market", "portfolio"]
    strategy: Literal["all", "turtle", "trend", "pullback", "rps"]
    only: StrictBool
    newOnly: StrictBool
    query: str = Field(max_length=200)
    numeric: NumericFilters
    sort: Literal["matches", "symbol", "close", "rsi", "volume_ratio", "rps"]
    direction: Literal["asc", "desc"]


class Preset(StrictModel):
    version: Literal[1]
    name: str = Field(min_length=1, max_length=60)
    settings: PresetSettings


class Preferences(StrictModel):
    presets: list[Preset] = Field(default_factory=list, max_length=30)
    universe_limit: Literal[250, 500, 1000] | None = None

    @model_validator(mode="after")
    def unique_names(self):
        names = [preset.name for preset in self.presets]
        if any(not name.strip() for name in names) or len(names) != len(set(names)):
            raise ValueError("篩選設定名稱不可空白或重複")
        return self


class BackupInput(StrictModel):
    preferences: Preferences = Field(default_factory=Preferences)


def _json_file(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def _digest(path, check_deadline=lambda: None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            check_deadline()
            digest.update(chunk)
    return digest.hexdigest()


def _app_version():
    with (store.ROOT / "pyproject.toml").open("rb") as stream:
        return tomllib.load(stream)["project"]["version"]


def create_archive(preferences):
    """Return private temp directory and archive path; caller owns cleanup."""
    started = time.monotonic()
    def check_deadline(*unused):
        if time.monotonic() - started > DEADLINE_SECONDS:
            raise TimeoutError("備份超過時間上限")
    root = store.ROOT / "artifacts"
    root.mkdir(exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="alphaview-backup-", dir=root))
    os.chmod(folder, 0o700)
    try:
        source_path = store.db_path().expanduser().resolve()
        if not source_path.is_file():
            raise ValueError("本機資料庫尚未建立")
        database = folder / "alphaview.db"
        with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=1)) as source:
            source.execute("BEGIN")
            source.execute("SELECT COUNT(*) FROM sqlite_schema").fetchone()
            snapshot_at = store.now()
            with closing(sqlite3.connect(database)) as destination:
                os.chmod(database, 0o600)
                source.backup(destination, pages=256, progress=check_deadline, sleep=0.05)
                source.rollback()
                check_deadline()
                # Make a single self-contained DB file; never ship sidecar WAL files.
                destination.execute("PRAGMA journal_mode=DELETE")
                destination.set_progress_handler(lambda: int(time.monotonic() - started > DEADLINE_SECONDS), 10000)
                destination.row_factory = sqlite3.Row
                integrity = destination.execute("PRAGMA quick_check").fetchall()
                if [tuple(row)[0] for row in integrity] != ["ok"]:
                    raise ValueError("備份資料庫完整性檢查未通過")
                schema = [dict(row) for row in destination.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
                tables = [row["name"] for row in schema if row["type"] == "table"]
                counts = {name: destination.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
                notes = [dict(row) for row in destination.execute("SELECT * FROM research_notes ORDER BY symbol")]
                for note in notes:
                    note["tags"] = json.loads(note["tags"])
                user_version = destination.execute("PRAGMA user_version").fetchone()[0]
        check_deadline()
        _json_file(folder / "research-notes.json", {"format_version": 1, "snapshot_at": snapshot_at, "notes": notes})
        _json_file(folder / "browser-settings.json", {"format_version": 1, "received_at": snapshot_at, "preferences": preferences})
        files = ["alphaview.db", "research-notes.json", "browser-settings.json"]
        manifest = {"format_version": 1, "product": "AlphaView", "app_version": _app_version(),
                    "engine_version": research.BACKTEST_ENGINE_VERSION, "snapshot_at": snapshot_at,
                    "sqlite_version": sqlite3.sqlite_version, "schema_user_version": user_version,
                    "schema_sha256": hashlib.sha256(json.dumps(schema, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
                    "table_counts": counts,
                    "files": {name: {"sha256": _digest(folder / name, check_deadline), "bytes": (folder / name).stat().st_size} for name in files},
                    "encrypted": False, "restore_automatic": False,
                    "notes": "僅包含已儲存資料與此瀏覽器提交的設定；不含未儲存草稿、程式碼或環境機密。執行中作業以當時狀態記錄。"}
        _json_file(folder / "manifest.json", manifest)
        archive = folder / "alphaview-backup.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
            for name in [*files, "manifest.json"]:
                check_deadline()
                with (folder / name).open("rb") as stream, package.open(name, "w") as member:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        check_deadline()
                        member.write(chunk)
        os.chmod(archive, 0o600)
        check_deadline()
        return folder, archive
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@router.post("/api/backups")
def download_backup(body: BackupInput):
    if not BACKUP_LOCK.acquire(blocking=False):
        raise HTTPException(409, "另一份備份正在建立，請稍後再試")
    folder = None
    try:
        folder, archive = create_archive(body.preferences.model_dump(exclude_none=True))
        timestamp = store.now().replace(":", "-").split(".")[0]
        return CleanupFileResponse(archive, cleanup_folder=folder, media_type="application/zip", filename=f"alphaview-backup-{timestamp}.zip",
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except Exception as exc:
        if folder:
            shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(503, "無法完成本機備份；暫存檔已清理，請稍後重試") from exc
    finally:
        BACKUP_LOCK.release()
