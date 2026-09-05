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


def test_large_status_response_does_not_deadlock_child_pipe(tmp_path, monkeypatch):
    from scripts.polling_revision_soak import run_child
    path = tmp_path / 'large-status.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(path))
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('synthetic-job','scan','running','fixed',?)", ('x' * 65536,))
    result = run_child(str(path), 'read')
    assert len(result['jobs'][0]['progress']) == 65536


def partial_frame_child(db_path, action, sender, stage):
    import struct
    import time
    # A real Connection frame header followed by only part of its promised body.
    os.write(sender.fileno(), struct.pack('!i', 65536) + b'partial')
    stage.value = 91
    time.sleep(60)


def broken_frame_child(db_path, action, sender, stage):
    sender.send_bytes(b'not a pickle')
    sender.close()


def test_partial_frame_deadline_reaps_child_and_reader():
    import multiprocessing
    import threading
    import time
    import pytest
    from scripts.polling_revision_soak import run_child
    children_before = {p.pid for p in multiprocessing.active_children()}
    threads_before = {t.ident for t in threading.enumerate()}
    started = time.monotonic()
    with pytest.raises(AssertionError, match='timed out: action=read, stage=91'):
        run_child('', 'read', timeout=2, _target=partial_frame_child)
    assert time.monotonic() - started < 5
    assert {p.pid for p in multiprocessing.active_children()} == children_before
    assert {t.ident for t in threading.enumerate()} == threads_before


def test_receiver_exception_is_preserved_and_reader_cleaned_up():
    import pickle
    import threading
    import pytest
    from scripts.polling_revision_soak import run_child
    threads_before = {t.ident for t in threading.enumerate()}
    with pytest.raises(pickle.UnpicklingError):
        run_child('', 'read', _target=broken_frame_child)
    assert {t.ident for t in threading.enumerate()} == threads_before
