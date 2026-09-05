"""Isolated SQLite revision soak. No HTTP/provider access or user database reads."""
import argparse
import hashlib
import subprocess
import json
import multiprocessing
import os
import socket
import sys
import tempfile
import time
import threading
import queue
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def no_network(*args, **kwargs):
    raise RuntimeError('Network access disabled in revision soak')


def child(db_path, action, sender=None, stage=None):
    stage.value = 1
    socket.create_connection = no_network
    socket.socket.connect = no_network
    os.environ['PANEL_DB_PATH'] = db_path
    from alphaview.panel import store
    stage.value = 2
    if action == 'read':
        stage.value = 3
        from alphaview.panel.api import polling_status
        stage.value = 4
        result = polling_status()
        stage.value = 9
        sender.send(result)
        stage.value = 5
        sender.close()
        return
    if action == 'restart':
        stage.value = 6
        store.init_db()
        return
    stage.value = 7
    with store.connect() as db:
        db.execute("UPDATE positions SET name=name || 'x' WHERE symbol='SYNTH'")
        stage.value = 8
        if action == 'crash':
            os._exit(23)  # Deliberately bypass connection cleanup before COMMIT.


def run_child(db_path, action, *, timeout=10, _target=child):
    context = multiprocessing.get_context('spawn')
    receiver, sender = context.Pipe(duplex=False)
    stage = context.Value("i", 0, lock=False)
    process = context.Process(target=_target, args=(db_path, action, sender, stage))
    process.start()
    sender.close()
    deadline = time.monotonic() + timeout
    received = queue.Queue(maxsize=1)
    reader = None
    def receive_complete_frame():
        try:
            received.put((True, receiver.recv()))
        except BaseException as exc:
            received.put((False, exc))
    try:
        # Drain while the child sends, but bound the entire frame reception,
        # not only readiness of its first bytes. Kill closes the child writer
        # and releases any blocked read before cleanup joins the reader.
        if action == 'read':
            reader = threading.Thread(target=receive_complete_frame,
                                      name='polling-soak-pipe-reader', daemon=True)
            reader.start()
            try:
                success, result = received.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError(f'child transaction timed out: action={action}, stage={stage.value}') from None
            if not success:
                raise result
        else:
            result = None
        process.join(max(0, deadline - time.monotonic()))
        if process.is_alive():
            raise AssertionError(f'child transaction timed out: action={action}, stage={stage.value}')
        assert process.exitcode == (23 if action == 'crash' else 0), 'unexpected child exit'
        return result
    finally:
        if process.is_alive():
            process.kill()
        process.join(2)
        if process.is_alive():
            raise RuntimeError('Unable to reap polling soak child after kill')
        if reader is not None:
            reader.join(2)
        receiver.close()
        process.close()
        if reader is not None and reader.is_alive():
            raise RuntimeError('Unable to stop polling soak pipe reader after child exit')


def cycle(db_path):
    from alphaview.panel import store
    from alphaview.panel.api import polling_status
    timings = []
    def status():
        started = time.perf_counter()
        result = polling_status()
        timings.append((time.perf_counter() - started) * 1000)
        return result
    first = status()
    with store.connect() as db:
        # Identical timestamp and identical value still constitute an observed write.
        db.execute("UPDATE positions SET updated_at='fixed',name=name WHERE symbol='SYNTH'")
    changed = status()
    assert changed['revision'] != first['revision'], 'same-timestamp update missed'
    assert changed['jobs_revision'] == first['jobs_revision'], 'data write changed jobs counter'
    with store.connect() as db:
        db.execute("UPDATE jobs SET progress=progress || '.' WHERE id='synthetic-job'")
    progressed = status()
    assert progressed['revision'] == changed['revision'], 'job write changed data counter'
    assert progressed['jobs_revision'] != changed['jobs_revision'], 'job progress missed'
    try:
        with store.connect() as db:
            db.execute("UPDATE positions SET name='rolled-back' WHERE symbol='SYNTH'")
            assert run_child(db_path, 'read') == progressed, 'uncommitted writer visible to another process'
            raise RuntimeError('expected rollback')
    except RuntimeError:
        pass
    assert status() == progressed, 'rollback leaked revision or public job state'
    run_child(db_path, 'crash')
    assert status() == progressed, 'crashed writer leaked uncommitted revision'
    with store.read_snapshot():
        snapshot = status()
        with store.connect() as db:
            name_before = db.execute("SELECT name FROM positions WHERE symbol='SYNTH'").fetchone()[0]
        run_child(db_path, 'commit')
        assert status() == snapshot, 'reader revision changed inside snapshot'
        with store.connect() as db:
            assert db.execute("SELECT name FROM positions WHERE symbol='SYNTH'").fetchone()[0] == name_before, 'reader data changed inside snapshot'
    committed = status()
    assert committed['revision'] != snapshot['revision'], 'committed writer not detected by new reader'
    run_child(db_path, 'restart')
    assert status() == committed, 'init restart changed existing identity/counters'
    return {'status_reads': len(timings), 'status_latency_ms_max': round(max(timings), 3),
            'status_latency_ms_mean': round(sum(timings) / len(timings), 3), 'invariants': 11}


def run(directory, seconds, interval, stop_directory=None):
    if seconds <= 0 or interval <= 0:
        raise ValueError('duration and interval must be positive')
    stop_directory = stop_directory or directory
    state = json.loads((stop_directory / 'state.json').read_text())
    directory.mkdir(parents=True, exist_ok=True)
    harness_deadline = datetime.fromisoformat(state['deadline'].replace('Z', '+00:00'))
    hard_deadline = datetime(2026, 9, 5, 3, 47, 25, tzinfo=timezone.utc)
    deadline = min(harness_deadline, hard_deadline)
    output = directory / 'polling-revision-soak.jsonl'
    summary_path = directory / 'polling-revision-soak-summary.json'
    started = time.monotonic()
    summary = {'started_at': datetime.now(timezone.utc).isoformat(), 'requested_seconds': seconds,
               'cycles': 0, 'failures': 0, 'status_reads': 0, 'invariants': 0, 'status_latency_ms_max': 0, 'network_disabled': True, 'synthetic_only': True}
    manifest_path = directory / 'polling-revision-source-manifest.json'
    if manifest_path.exists():
        summary['source_snapshot_sha256'] = json.loads(manifest_path.read_text())['sha256']
    socket.create_connection = no_network
    socket.socket.connect = no_network
    with tempfile.TemporaryDirectory(prefix='alphaview-revision-soak-') as temporary:
        db_path = str(Path(temporary) / 'synthetic.db')
        os.environ['PANEL_DB_PATH'] = db_path
        from alphaview.panel import store
        store.init_db()
        with store.connect() as db:
            db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES('SYNTH','Synthetic',0,'synthetic','fixed')")
            db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('synthetic-job','scan','running','fixed','')")
        reason = 'duration'
        while time.monotonic() - started < seconds:
            remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
            if (stop_directory / 'STOP').exists() or remaining <= 60:
                reason = 'harness_stop_or_deadline'
                break
            record = {'at': datetime.now(timezone.utc).isoformat(), 'cycle': summary['cycles']}
            cycle_start = time.monotonic()
            try:
                record.update(cycle(db_path), status='pass')
                summary['status_reads'] += record['status_reads']
                summary['invariants'] += record['invariants']
                summary['status_latency_ms_max'] = max(summary['status_latency_ms_max'], record['status_latency_ms_max'])
            except Exception as exc:
                record.update(status='failure', error_type=type(exc).__name__, error=str(exc))
                summary['failures'] += 1
            record['duration_ms'] = round((time.monotonic() - cycle_start) * 1000, 3)
            with output.open('a') as file:
                file.write(json.dumps(record) + '\n')
                file.flush()
            print(json.dumps(record), flush=True)
            summary['cycles'] += 1
            if summary['failures']:
                reason = 'invariant_failure'
                break
            until = min(started + seconds, cycle_start + interval)
            while time.monotonic() < until and not (stop_directory / 'STOP').exists():
                time.sleep(min(0.5, until - time.monotonic()))
        summary.update(ended_at=datetime.now(timezone.utc).isoformat(), elapsed_seconds=round(time.monotonic() - started, 3), stop_reason=reason)
    summary_path.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary), flush=True)
    return summary


def frozen_run(args):
    directory = args.directory.resolve()
    stop_directory = (args.stop_directory or args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    def git(*arguments):
        result = subprocess.run(['git', *arguments], cwd=ROOT, capture_output=True, text=True, timeout=5)
        return result.stdout.strip() if result.returncode == 0 else None
    with tempfile.TemporaryDirectory(prefix='alphaview-soak-source-') as temporary:
        frozen = Path(temporary)
        paths = sorted((ROOT / 'alphaview').rglob('*.py')) + [Path(__file__).resolve()]
        hashes = {}
        for path in paths:
            if '__pycache__' in path.parts:
                continue
            relative = path.relative_to(ROOT)
            payload = path.read_bytes()
            target = frozen / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            hashes[str(relative)] = hashlib.sha256(payload).hexdigest()
        manifest = {'sha256': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
                    'files': hashes, 'git_commit': git('rev-parse', 'HEAD'),
                    'git_dirty': bool(git('status', '--porcelain')), 'frozen': True,
                    'created_at': datetime.now(timezone.utc).isoformat()}
        (directory / 'polling-revision-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        # Copy code only; no .env, database, user artifacts or holdings are included.
        # Spawn descendants import this same immutable ROOT, never the edited checkout.
        completed = subprocess.run([sys.executable, str(frozen / 'scripts/polling_revision_soak.py'),
            '--frozen-source', '--directory', str(directory), '--stop-directory', str(stop_directory),
            '--seconds', str(args.seconds), '--interval', str(args.interval)], cwd=frozen)
        return completed.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frozen-source', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--directory', type=Path, default=Path('artifacts/harness-2026-09-05'))
    parser.add_argument('--stop-directory', type=Path)
    parser.add_argument('--seconds', type=float, default=2700)
    parser.add_argument('--interval', type=float, default=8)
    args = parser.parse_args()
    if not args.frozen_source:
        return frozen_run(args)
    summary = run(args.directory, args.seconds, args.interval, args.stop_directory)
    return 1 if summary['failures'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
