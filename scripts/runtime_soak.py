"""Read-only local API soak; writes timings/invariants, never personal positions."""
import argparse
import json
import math
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base',default='http://127.0.0.1:8876')
    parser.add_argument('--directory',type=Path,default=Path('artifacts/harness-2026-09-05'))
    parser.add_argument('--interval',type=int,default=60)
    args=parser.parse_args()
    state=json.loads((args.directory/'state.json').read_text())
    deadline=datetime.fromisoformat(state['deadline'].replace('Z','+00:00'))
    index=0
    while datetime.now(timezone.utc)<deadline:
        started=time.monotonic(); record={'at':datetime.now(timezone.utc).isoformat(),'cycle':index}
        try:
            with urllib.request.urlopen(args.base+'/api/health',timeout=15) as response:
                health=json.load(response)
            assert health['status']=='ok','health status'
            with urllib.request.urlopen(args.base+'/api/overview',timeout=20) as response:
                overview=json.load(response)
            valued=[p for p in overview['positions'] if p['shares']>0 and p['price'] is not None]
            expected=sum(p['price']*p['shares'] for p in valued)
            assert math.isclose(expected,overview['summary']['market_value'],rel_tol=1e-9),'portfolio total inconsistent'
            for key in ('scan','market_scan'):
                scan=overview.get(key)
                if not scan: continue
                for row in scan['result']:
                    for signal in row['signals']:
                        assert not signal['matched'] or signal['status']=='match','invalid signal matched'
                        assert not signal['matched'] or row['date']==scan['as_of'],'stale signal matched'
            record.update(status='pass',portfolio_symbols=len(overview['positions']),market_symbols=len(overview['market_universe']),active_jobs=sum(j['status']=='running' for j in overview['jobs']))
        except Exception as exc:
            record.update(status='failure',error=f'{type(exc).__name__}: {exc}')
        record['duration_ms']=round((time.monotonic()-started)*1000)
        with (args.directory/'soak.jsonl').open('a') as output:
            output.write(json.dumps(record)+'\n')
        print(json.dumps(record),flush=True)
        index+=1
        remaining=(deadline-datetime.now(timezone.utc)).total_seconds()
        if remaining>0: time.sleep(min(max(1,args.interval),remaining))


if __name__=='__main__': main()
