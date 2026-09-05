import json
import os
import subprocess
import sys
from pathlib import Path

from alphaview.panel import store
from scripts.polling_revision_soak import cycle


def test_soak_cycle_exercises_real_process_crash_and_snapshot_transactions(tmp_path, monkeypatch):
    path = tmp_path / 'synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(path))
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES('SYNTH','Synthetic',0,'synthetic','fixed')")
        db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('synthetic-job','scan','running','fixed','')")
    result = cycle(str(path))
    assert result['invariants'] == 11
    assert result['status_reads'] >= 8
    assert result['status_latency_ms_max'] >= result['status_latency_ms_mean'] >= 0
    assert 'Synthetic' not in json.dumps(result)


def test_stop_marker_prevents_transactions_and_never_opens_inherited_database(tmp_path):
    inherited = tmp_path / 'do-not-open.db'
    inherited.write_bytes(b'untouched sentinel')
    directory = tmp_path / 'evidence'
    directory.mkdir()
    (directory / 'state.json').write_text(json.dumps({'deadline': '2026-09-05T03:47:25Z'}))
    (directory / 'STOP').write_text('stop')
    env = {**os.environ, 'PANEL_DB_PATH': str(inherited)}
    script = Path(__file__).resolve().parents[1] / 'scripts/polling_revision_soak.py'
    completed = subprocess.run([sys.executable, str(script), '--directory', str(directory), '--seconds', '1'], env=env, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    summary = json.loads((directory / 'polling-revision-soak-summary.json').read_text())
    assert summary['cycles'] == 0
    assert summary['stop_reason'] == 'harness_stop_or_deadline'
    assert inherited.read_bytes() == b'untouched sentinel'
