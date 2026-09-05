"""Synthetic-only bounded resilience soak. Never connects to a live workspace/provider."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class SoakStopped(Exception):
    pass


def forbid_network():
    def denied(*args, **kwargs):
        raise RuntimeError("Network is disabled for the synthetic resilience soak")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def child(mode):
    assert os.environ.get('ALPHAVIEW_SYNTHETIC_SOAK') == '1'
    forbid_network()
    from alphaview.panel import jobs, scheduler, store
    if mode == 'claim':
        def launch(job_id, *args):
            with store.connect() as db:
                db.execute("UPDATE jobs SET status='completed',finished_at=? WHERE id=?",(store.now(),job_id))
            jobs.RUN_LOCK.release()
        print(json.dumps(scheduler.tick('2026-09-05T01:00:00Z', launch)), flush=True)
        return
    assert jobs.RUN_LOCK.acquire(False)
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        value = int(sys.stdin.readline())
        db.execute("UPDATE positions SET shares=? WHERE symbol='SYNTA'",(value,))
        print('ready', flush=True)
        command = sys.stdin.readline().strip()
        if command != 'commit':
            raise RuntimeError('Unrecognized synthetic transaction command')
        db.execute("UPDATE positions SET shares=? WHERE symbol='SYNTB'",(value,))
    jobs.RUN_LOCK.release()
    print('committed',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds',type=float,default=1800)
    parser.add_argument('--interval',type=float,default=3)
    parser.add_argument('--directory',type=Path,default=ROOT/'artifacts/harness-2026-09-05')
    parser.add_argument('--name',default='resilience-soak')
    parser.add_argument('--child',choices=['writer','claim'])
    args=parser.parse_args()
    if args.child:
        child(args.child); return 0
    if not 0 < args.seconds <= 1800 or not 1 <= args.interval <= 60:
        parser.error('seconds must be 0..1800; interval must be1..60')
    args.directory.mkdir(parents=True,exist_ok=True)
    output=args.directory/(args.name+'.json')
    events=args.directory/(args.name+'.jsonl')
    if output.exists() or events.exists():
        parser.error('Choose a new name; existing evidence will not be overwritten')
    start=time.monotonic(); stop=start+args.seconds
    state_path=args.directory/'state.json'
    if state_path.exists():
        deadline=datetime.fromisoformat(json.loads(state_path.read_text())['deadline'].replace('Z','+00:00'))
        stop=min(stop,start+max(0,(deadline-datetime.now(timezone.utc)).total_seconds()))
    summary=dict(started_at=utcnow(),status='running',synthetic_only=True,network=False,
                 requested_seconds=args.seconds,cycles=0,passed=0,failures=[],scenarios={})
    counts=Counter()
    def save():
        summary.update(elapsed_seconds=round(time.monotonic()-start,3),scenarios=dict(counts))
        temporary=output.with_suffix('.tmp')
        temporary.write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n')
        temporary.replace(output)
    def log(scenario, status, **extra):
        event=dict(at=utcnow(),cycle=summary['cycles'],scenario=scenario,status=status,**extra)
        with events.open('a') as file: file.write(json.dumps(event,allow_nan=False)+'\n')
        if status=='passed':
            summary['passed']+=1;counts[scenario]+=1
        else: summary['failures'].append(event)
        save()
    save()
    with tempfile.TemporaryDirectory(prefix='alphaview-synthetic-soak-') as directory:
        os.environ['PANEL_DB_PATH']=str(Path(directory)/'synthetic.db')
        os.environ['ALPHAVIEW_SYNTHETIC_SOAK']='1'
        forbid_network()
        from fastapi.testclient import TestClient
        from alphaview.panel import api, jobs, sessions, store
        store.init_db()
        as_of=sessions.latest_completed_session()
        days=sessions.expected_sessions('2025-01-02',as_of)[-121:]
        with store.connect() as db:
            for symbol in ('SYNTA','SYNTB'):
                db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES (?,?,1,90,'synthetic',?)",(symbol,'Synthetic fixture',store.now()))
                db.executemany('INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)',[(symbol,day,100,101,99,100,100+(i%2),1000) for i,day in enumerate(days)])
        # Deliberately no lifespan: main scheduler remains disabled and no
        # automatic background jobs run. Scheduler subprocess uses fake launch.
        client=TestClient(api.app)
        def risk_snapshot(expected):
            response=client.get('/api/portfolio/risk')
            assert response.status_code==200,response.text
            result=response.json();json.dumps(result,allow_nan=False)
            assert result['valuation_complete']
            assert result['market_value']==200*expected
            assert all(row['weight_pct']==50 for row in result['holdings'])
        def backup_snapshot(expected):
            response=client.post('/api/backups',json={})
            assert response.status_code==200,response.text
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                destination=Path(directory)/'snapshot.db'
                destination.write_bytes(archive.read('alphaview.db'))
                with sqlite3.connect(destination) as db:
                    assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
                    assert db.execute('SELECT DISTINCT shares FROM positions').fetchall()==[(expected,)]
                destination.unlink()
        previous=1
        process=None
        def deadline_reached(*unused):
            raise SoakStopped('wall_budget_or_harness_deadline')
        previous_handler=signal.signal(signal.SIGALRM,deadline_reached)
        signal.setitimer(signal.ITIMER_REAL,max(.001,stop-time.monotonic()))
        try:
            while time.monotonic()<stop and not (args.directory/'STOP').exists():
                cycle_start=time.monotonic();summary['cycles']+=1
                target=2 if previous==1 else 1
                process=subprocess.Popen([sys.executable,__file__,'--child','writer'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                process.stdin.write(str(target)+'\n');process.stdin.flush()
                ready=select.select([process.stdout],[],[],8)[0]
                assert ready and process.stdout.readline().strip()=='ready','writer did not reach transaction checkpoint'
                risk_snapshot(previous)
                log('concurrent_uncommitted_read','passed')
                if summary['cycles']%5==0:
                    backup_snapshot(previous)
                    log('backup_during_uncommitted_transaction','passed')
                crash=summary['cycles']%3==0
                if crash:
                    process.kill();process.communicate(timeout=5)
                else:
                    process.stdin.write('commit\n');process.stdin.flush()
                    out,err=process.communicate(timeout=8)
                    assert process.returncode==0,(out,err)
                    previous=target
                process=None
                assert jobs.RUN_LOCK.acquire(False),'process lock did not recover'
                jobs.RUN_LOCK.release()
                risk_snapshot(previous)
                log('process_crash_rollback' if crash else 'committed_atomic_update','passed')
                cycle=summary['cycles']
                if cycle%5==1:
                    csv='symbol,shares,cost\nSYNTA,3,90\n'
                    preview=client.post('/api/portfolio/import/preview',json={'csv_text':csv}).json()
                    response=client.put('/api/positions/SYNTA',json=dict(symbol='SYNTA',name='Synthetic fixture '+str(cycle),shares=previous,cost=90))
                    assert response.status_code==200,response.text
                    assert client.post('/api/portfolio/import',json=dict(csv_text=csv,expected_fingerprint=preview['fingerprint'])).status_code==409
                    risk_snapshot(previous)
                    log('stale_csv_preview_conflict','passed')
                elif cycle%5==2:
                    version=client.get('/api/notes/SYNTA').json()['version']
                    body=dict(note='Synthetic cycle',tags=['test'],version=version)
                    assert client.put('/api/notes/SYNTA',json=body).status_code==200
                    assert client.put('/api/notes/SYNTA',json=body).status_code==409
                    assert client.get('/api/notes/SYNTA').json()['version']==version+1
                    log('optimistic_note_conflict','passed')
                elif cycle%5==3:
                    with store.connect() as db:db.execute('UPDATE refresh_schedule SET enabled=1 WHERE id=1')
                    try:
                        responses=[]
                        for _ in range(2):
                            completed=subprocess.run([sys.executable,__file__,'--child','claim'],capture_output=True,text=True,timeout=8,check=True)
                            responses.append(json.loads(completed.stdout)['status'])
                        assert responses==(['started','already_attempted'] if cycle==3 else ['already_attempted','already_attempted'])
                        with store.connect() as db:assert db.execute('SELECT COUNT(*) FROM schedule_attempts').fetchone()[0]==1
                    finally:
                        with store.connect() as db:db.execute('UPDATE refresh_schedule SET enabled=0 WHERE id=1')
                    log('scheduler_restart_once_per_session','passed')
                remaining=min(args.interval-(time.monotonic()-cycle_start),stop-time.monotonic())
                if remaining>0:time.sleep(remaining)
            summary['status']='stopped' if (args.directory/'STOP').exists() else 'completed'
        except SoakStopped:
            summary['status']='completed'
            summary['stop_reason']='wall_budget_or_harness_deadline'
        except Exception as exc:
            summary['status']='failed';log('unhandled_invariant','failed',reason=f'{type(exc).__name__}: {exc}'[:1000])
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
            signal.signal(signal.SIGALRM,previous_handler)
            if process is not None:
                process.kill();process.communicate(timeout=5)
            client.close()
            summary['finished_at']=utcnow();save()
    print(json.dumps(summary,allow_nan=False),flush=True)
    return int(summary['status']=='failed')


if __name__=='__main__':
    raise SystemExit(main())
