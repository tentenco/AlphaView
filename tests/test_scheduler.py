import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import jobs, scheduler, store

AT = '2026-09-05T01:00:00Z'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('PANEL_DB_PATH', str(tmp_path / 'schedule.db'))
    store.init_db()
    monkeypatch.setattr(scheduler, 'utcnow', lambda: AT)
    app = FastAPI()
    app.include_router(scheduler.router)
    with TestClient(app) as result:
        yield result
    if jobs.RUN_LOCK.locked():
        jobs.RUN_LOCK.release()


def enable(client, **options):
    current = client.get('/api/schedule').json()
    response = client.put('/api/schedule', json={
        'enabled': True, 'scope': 'market', 'universe_limit': 500,
        'version': current['version'], **options,
    })
    assert response.status_code == 200
    return response.json()


def completed_launcher(calls, status='completed'):
    def launch(job_id, kind, scope, symbols, limit):
        assert jobs.RUN_LOCK.locked()
        calls.append((job_id, kind, scope, symbols, limit))
        with store.connect() as db:
            db.execute('UPDATE jobs SET status=?,finished_at=? WHERE id=?', (status, store.now(), job_id))
        jobs.RUN_LOCK.release()
    return launch


def counts():
    with store.connect() as db:
        return tuple(db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                     for table in ('jobs', 'schedule_attempts'))


def test_disabled_default_and_optimistic_config(client):
    initial = client.get('/api/schedule').json()
    assert initial['enabled'] is False and initial['version'] == 0
    assert initial['updated_at'] and initial['last_attempt'] is None
    assert initial['next_due_at'] is None
    with patch.object(jobs, 'launch_locked') as launch:
        assert scheduler.tick(AT)['status'] == 'disabled'
        launch.assert_not_called()
    saved = enable(client)
    assert saved['version'] == 1 and saved['next_due_at'] == '2026-09-05T01:00:00+00:00'
    assert client.put('/api/schedule', json={
        'enabled': False, 'scope': 'portfolio', 'universe_limit': 250, 'version': 0,
    }).status_code == 409
    assert client.get('/api/schedule').json()['enabled'] is True
    assert counts() == (0, 0)


@pytest.mark.parametrize('field,value', [('enabled', 'true'), ('scope', 'all'), ('universe_limit', 999), ('version', True), ('version', -1)])
def test_settings_validation(client, field, value):
    body = dict(enabled=True, scope='market', universe_limit=500, version=0)
    body[field] = value
    assert client.put('/api/schedule', json=body).status_code == 422
    assert counts() == (0, 0)


@pytest.mark.parametrize('status', ['completed', 'partial', 'failed', 'cancelled', 'interrupted'])
def test_terminal_attempt_never_retries_session_even_after_scope_change(client, status):
    enable(client)
    calls = []
    launch = completed_launcher(calls, status)
    assert scheduler.tick(AT, launch)['status'] == 'started'
    enable(client, scope='portfolio', universe_limit=1000)
    assert scheduler.tick(AT, launch)['status'] == 'already_attempted'
    state = scheduler.state(AT)
    assert state['last_attempt']['status'] == status
    assert state['last_attempt']['scope'] == 'market'
    assert state['next_due_at'] == '2026-09-08T20:15:00+00:00'  # Labor Day
    assert len(calls) == 1 and calls[0][-1] == 500
    assert counts() == (1, 1)


def test_busy_does_not_claim_and_disable_works_during_job(client):
    enable(client)
    assert jobs.RUN_LOCK.acquire(False)
    assert scheduler.tick(AT)['status'] == 'busy'
    assert counts() == (0, 0)
    enable(client, enabled=False)
    jobs.RUN_LOCK.release()
    assert scheduler.tick(AT)['status'] == 'disabled'
    enable(client, scope='portfolio', universe_limit=1000)
    calls = []
    assert scheduler.tick(AT, completed_launcher(calls))['status'] == 'started'
    assert calls[0][-1] == 250


def test_catchup_only_latest_session_and_next_session_runs(client):
    enable(client)
    calls = []
    launch = completed_launcher(calls)
    assert scheduler.tick('2026-09-08T20:14:59Z', launch)['session_date'] == '2026-09-04'
    assert scheduler.tick('2026-09-08T20:15:00Z', launch)['session_date'] == '2026-09-08'
    assert len(calls) == 2 and counts() == (2, 2)


@pytest.mark.parametrize('at,eligible,next_due', [
    ('2026-03-06T21:15:00Z', '2026-03-06', '2026-03-09T20:15:00+00:00'),
    ('2026-11-27T18:14:59Z', '2026-11-25', '2026-11-27T18:15:00+00:00'),
    ('2026-11-27T18:15:00Z', '2026-11-27', '2026-11-30T21:15:00+00:00'),
])
def test_dst_holiday_and_early_close(client, at, eligible, next_due):
    enable(client)
    result = scheduler.tick(at, completed_launcher([]))
    assert result['session_date'] == eligible
    assert scheduler.state(at)['next_due_at'] == next_due


def test_failed_thread_launch_keeps_attempt_and_releases_lock(client):
    enable(client)
    with patch.object(jobs.threading.Thread, 'start', side_effect=RuntimeError('no thread')):
        result = scheduler.tick(AT)
    assert result['status'] == 'launch_failed'
    assert scheduler.state(AT)['last_attempt']['status'] == 'failed'
    assert not jobs.RUN_LOCK.locked()
    assert scheduler.tick(AT)['status'] == 'already_attempted'
    assert counts() == (1, 1)


def test_orphan_recovery_and_atomic_claim_rollback(client):
    enable(client)
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope) VALUES ('orphan','refresh','running',?,'market')", (AT,))
        db.execute("CREATE TRIGGER reject_attempt BEFORE INSERT ON schedule_attempts BEGIN SELECT RAISE(ABORT, 'test abort'); END")
    with pytest.raises(Exception, match='test abort'):
        scheduler.tick(AT, completed_launcher([]))
    assert counts() == (1, 0) and not jobs.RUN_LOCK.locked()
    with store.connect() as db:
        assert db.execute("SELECT status FROM jobs WHERE id='orphan'").fetchone()[0] == 'running'
        db.execute('DROP TRIGGER reject_attempt')
    scheduler.tick(AT, completed_launcher([]))
    with store.connect() as db:
        assert db.execute("SELECT status FROM jobs WHERE id='orphan'").fetchone()[0] == 'interrupted'
    assert counts() == (2, 1)


def test_two_simultaneous_instances_claim_only_once(client):
    enable(client)
    calls = []
    gate = threading.Barrier(2)
    def run():
        gate.wait()
        return scheduler.tick(AT, completed_launcher(calls))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run(), range(2)))
    assert sum(result['status'] == 'started' for result in results) == 1
    assert len(calls) == 1 and counts() == (1, 1)


def test_stop_after_claim_retains_attempt_without_launch(client):
    enable(client)
    calls = []
    stopping_calls = []
    def stopping():
        stopping_calls.append(True)
        return len(stopping_calls) >= 3
    result = scheduler.tick(AT, completed_launcher(calls), stopping)
    assert result['status'] == 'stopped' and not calls
    assert scheduler.state(AT)['last_attempt']['status'] == 'interrupted'
    assert not jobs.RUN_LOCK.locked() and counts() == (1, 1)


def test_scheduler_stops_polling_and_restart_does_not_repeat(client):
    enable(client)
    event = threading.Event()
    calls = []
    complete = completed_launcher(calls)
    def launch(*args):
        complete(*args)
        event.set()
    loop = scheduler.Scheduler(clock=lambda: AT, launch=launch, interval=60).start()
    assert event.wait(5)
    loop.stop()
    assert not loop._thread.is_alive()
    assert scheduler.tick(AT, launch)['status'] == 'already_attempted'
    assert len(calls) == 1


def test_separate_processes_share_once_per_session_claim(client):
    import json
    import subprocess
    import sys
    enable(client)
    code = '''
import json,time
from alphaview.panel import scheduler,jobs,store
def launch(job_id,*args):
    time.sleep(.2)
    with store.connect() as db:
        db.execute("UPDATE jobs SET status='completed' WHERE id=?",(job_id,))
    jobs.RUN_LOCK.release()
print(json.dumps(scheduler.tick('2026-09-05T01:00:00Z',launch)))
'''
    processes = [subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True) for _ in range(2)]
    results = []
    for process in processes:
        out, err = process.communicate(timeout=15)
        assert process.returncode == 0, err
        results.append(json.loads(out))
    assert sum(result['status'] == 'started' for result in results) == 1
    assert counts() == (1, 1)
    assert scheduler.tick(AT)['status'] == 'already_attempted'
