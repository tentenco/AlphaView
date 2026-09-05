"""Isolated SQLite revision soak. No HTTP/provider access or user database reads."""
import argparse
import json
import multiprocessing
import os
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def no_network(*args, **kwargs):
    raise RuntimeError('Network access disabled in revision soak')


def child(db_path, action, sender=None):
    socket.create_connection = no_network
    socket.socket.connect = no_network
    os.environ['PANEL_DB_PATH'] = db_path
    from alphaview.panel import store
    if action == 'read':
        from alphaview.panel.api import polling_status
        sender.send(polling_status())
        sender.close()
        return
    if action == 'restart':
        store.init_db()
        return
    with store.connect() as db:
        db.execute("UPDATE positions SET name=name || 'x' WHERE symbol='SYNTH'")
        if action == 'crash':
            os._exit(23)  # Deliberately bypass connection cleanup before COMMIT.


def run_child(db_path, action):
    context = multiprocessing.get_context('spawn')
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=child, args=(db_path, action, sender))
    process.start()
    process.join(10)
    if process.is_alive():
        process.kill()
        process.join()
        raise AssertionError('child transaction timed out')
    assert process.exitcode == (23 if action == 'crash' else 0), 'unexpected child exit'
    sender.close()
    result = receiver.recv() if action == 'read' else None
    receiver.close()
    return result


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


def run(directory, seconds, interval):
    if seconds <= 0 or interval <= 0:
        raise ValueError('duration and interval must be positive')
    state = json.loads((directory / 'state.json').read_text())
    harness_deadline = datetime.fromisoformat(state['deadline'].replace('Z', '+00:00'))
    hard_deadline = datetime(2026, 9, 5, 3, 47, 25, tzinfo=timezone.utc)
    deadline = min(harness_deadline, hard_deadline)
    output = directory / 'polling-revision-soak.jsonl'
    summary_path = directory / 'polling-revision-soak-summary.json'
    started = time.monotonic()
    summary = {'started_at': datetime.now(timezone.utc).isoformat(), 'requested_seconds': seconds,
               'cycles': 0, 'failures': 0, 'status_reads': 0, 'invariants': 0, 'status_latency_ms_max': 0, 'network_disabled': True, 'synthetic_only': True}
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
            if (directory / 'STOP').exists() or remaining <= 60:
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
            while time.monotonic() < until and not (directory / 'STOP').exists():
                time.sleep(min(0.5, until - time.monotonic()))
        summary.update(ended_at=datetime.now(timezone.utc).isoformat(), elapsed_seconds=round(time.monotonic() - started, 3), stop_reason=reason)
    summary_path.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('artifacts/harness-2026-09-05'))
    parser.add_argument('--seconds', type=float, default=2700)
    parser.add_argument('--interval', type=float, default=8)
    args = parser.parse_args()
    summary = run(args.directory, args.seconds, args.interval)
    return 1 if summary['failures'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
