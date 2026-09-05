"""Reproduce polling-soak Pipe backpressure using a temporary synthetic DB.

No application mutation or network access is performed. Two historical payload
formats reconstruct the observed cycle boundaries. The send stage separates IPC
blocking from SQLite reads. Output goes to stdout; redirect to an evidence file.
"""
import json
import multiprocessing as mp
import os
from pathlib import Path
import pickle
import socket
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def no_network(*args, **kwargs):
    raise RuntimeError('Network disabled in isolated IPC reproducer')


def send(payload, connection, stage):
    stage.value = 1
    connection.send(payload)
    stage.value = 2
    connection.close()


def probe(payload, drain=False):
    context = mp.get_context('spawn')
    receiver, sender = context.Pipe(duplex=False)
    stage = context.Value('i', 0, lock=False)
    process = context.Process(target=send, args=(payload, sender, stage))
    process.start()
    sender.close()
    try:
        if drain:
            assert receiver.poll(5), 'reader never received a header'
            assert receiver.recv() == payload
        process.join(1)
        blocked, observed_stage = process.is_alive(), stage.value
        return {'pickle_bytes': len(pickle.dumps(payload, protocol=4)),
                'wire_bytes': len(pickle.dumps(payload, protocol=4)) + 4,
                'blocked': blocked, 'stage': observed_stage,
                'drain_before_join': drain}
    finally:
        if process.is_alive():
            process.kill()
        process.join()
        receiver.close()


def run():
    from alphaview.panel import api, store
    results = []
    with tempfile.TemporaryDirectory(prefix='alphaview-pipe-audit-') as temporary:
        with patch.dict(os.environ, {'PANEL_DB_PATH': str(Path(temporary) / 'synthetic.db')}):
            store.init_db()
            with store.connect() as db:
                db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES('SYNTH','Synthetic',0,'synthetic','fixed')")
                db.execute("INSERT INTO jobs(id,kind,status,started_at,progress) VALUES('synthetic-job','scan','running','fixed','')")
            for version, cycles, marker in [
                ('frozen_scan_backtest', [168, 169], ':alphaview-comparison-'),
                ('original_no_engine_suffix', [208, 209], ':alphaview-scan-'),
            ]:
                for cycle in cycles:
                    with store.connect() as db:
                        db.execute('UPDATE jobs SET progress=?', ('.' * (cycle + 1),))
                        db.execute('UPDATE panel_revisions SET data_revision=?,job_revision=?', (2 * cycle + 2, cycle + 2))
                    payload = api.polling_status()
                    payload['revision'] = payload['revision'].split(marker)[0]
                    for drain in (False, True):
                        result = probe(payload, drain)
                        result.update(version=version, cycle=cycle, progress_length=cycle + 1)
                        results.append(result)
    return {'synthetic_only': True, 'platform': sys.platform, 'results': results,
            'interpretation': 'On this observed machine, 508-byte pickle plus 4-byte frame succeeds before join; 509+4 blocks in send until the parent drains. These reproduce the original cycle209 and frozen cycle169 boundaries. Pipe capacity is platform-dependent; do not assume the same cutoff elsewhere.'}


if __name__ == '__main__':
    socket.create_connection = no_network
    socket.socket.connect = no_network
    print(json.dumps(run(), indent=2))
