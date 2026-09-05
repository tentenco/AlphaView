"""Reproduce a revision-soak false positive across loaded API code versions.

Uses a temporary synthetic database and a subprocess reader. No provider or live
workspace database is accessed. The legacy function is extracted from the known
local Git checkpoint, rather than approximating its revision-format behavior.
"""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
LEGACY_COMMIT = "b2900fd"


def run():
    from alphaview.panel import api, sessions, store

    source = subprocess.check_output(
        ["git", "show", f"{LEGACY_COMMIT}:alphaview/panel/api.py"], cwd=ROOT, text=True)
    function = next(node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef) and node.name == "polling_status")
    function.decorator_list = []
    namespace = {"store": store, "sessions": sessions}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "legacy_polling_status", "exec"), namespace)
    legacy_status = store.snapshot_read(namespace["polling_status"])
    child_code = """
import json, socket
socket.create_connection = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('network disabled'))
socket.socket.connect = socket.create_connection
from alphaview.panel import api, store
with store.read_snapshot():
    with store.connect() as db:
        name = db.execute("SELECT name FROM positions WHERE symbol='SYNTH'").fetchone()[0]
    print(json.dumps({'status': api.polling_status(), 'name': name}))
"""
    with tempfile.TemporaryDirectory(prefix="alphaview-version-skew-") as directory:
        with patch.dict(os.environ, {"PANEL_DB_PATH": str(Path(directory) / "synthetic.db")}):
            store.init_db()
            with store.connect() as db:
                db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES('SYNTH','committed',0,'synthetic','fixed')")
                db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('synthetic-job','scan','running','fixed','')")
            current = api.polling_status()
            legacy = legacy_status()
            with store.connect() as db:
                db.execute("UPDATE positions SET name='uncommitted' WHERE symbol='SYNTH'")
                # Always undo the writer; subprocess must see the committed name.
                try:
                    child = json.loads(subprocess.check_output(
                        [sys.executable, "-c", child_code], cwd=ROOT, text=True, timeout=10))
                    assert child["name"] == "committed"
                    assert child["status"] == current
                    assert child["status"] != legacy
                    differences = [key for key in current if current[key] != legacy[key]]
                    assert differences == ["revision"]
                    assert current["revision"].startswith(legacy["revision"] + ":")
                    assert current["jobs_revision"] == legacy["jobs_revision"]
                    assert current["jobs"] == legacy["jobs"]
                finally:
                    db.rollback()
            assert api.polling_status() == current
            return {"synthetic_only": True, "legacy_git_checkpoint": LEGACY_COMMIT,
                    "same_source_reader_equal": True, "legacy_current_reader_equal": False,
                    "cross_version_differences": differences, "child_observed_name": child["name"],
                    "writer_uncommitted_name": "uncommitted", "rollback_preserved_current_status": True,
                    "legacy_revision": legacy["revision"], "current_revision": current["revision"],
                    "conclusion": "Full-response comparison reports the same false dirty-read assertion when only API revision formatting changes. SQLite isolation held. This reproduces the mechanism; the original receipt omitted compared payloads, so it cannot independently prove the historical event's cause."}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
