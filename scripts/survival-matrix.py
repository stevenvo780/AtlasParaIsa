"""Synthetic experiments only. Default prints a plan; --run requires an exact source SHA."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import threading
import time

RUNNER = pathlib.Path(__file__).resolve().with_name('survival-audit.mts')
STOP = threading.Event()

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            h.update(block)
    return h.hexdigest()

def source_files(source):
    paths = subprocess.check_output(['git', 'ls-files', '-z', 'src/world', 'src/shared', 'src/server',
        'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json'], cwd=source).split(b'\0')
    return {p.decode(): digest(source / p.decode()) for p in paths if p}

def head(source):
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()

def run_managed(command, cwd, log_path, timeout, log_limit, stop=STOP):
    """Only signal the fresh session/process group created by this invocation."""
    if stop.is_set():
        pathlib.Path(log_path).write_bytes(b'')
        return dict(exitCode=None,failure='owner-stop-requested',logBytes=0,wallSeconds=0,ownedGroupSignaledOnly=True)
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    reason, size = None, 0
    try:
        with open(log_path, 'xb') as log:
            while True:
                if stop.is_set(): reason = 'owner-stop-requested'
                elif time.monotonic() - started > timeout: reason = 'wall-time-quota'
                if reason: break
                for key, _ in selector.select(.1):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    allowed = max(0, log_limit - size)
                    log.write(chunk[:allowed]); size += min(len(chunk), allowed)
                    if len(chunk) > allowed: reason = 'log-quota'; break
                if reason: break
                # WNOWAIT leaves the owned group leader unreaped until cleanup, preventing PID reuse.
                exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if exited is not None:
                    # Drain already available output. A surviving descendant is never awaited forever.
                    while selector.get_map():
                        ready = selector.select(0)
                        if not ready: break
                        for key, _ in ready:
                            chunk = os.read(key.fd, 65536)
                            if not chunk: selector.unregister(key.fileobj); continue
                            allowed = max(0, log_limit - size)
                            log.write(chunk[:allowed]); size += min(len(chunk), allowed)
                            if len(chunk) > allowed: reason = 'log-quota'; break
                        if reason: break
                    break
    finally:
        selector.close(); process.stdout.close()
        # The owned unreaped leader fixes this PGID; these signals cannot target another session.
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(.15)
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        code = process.wait(timeout=5)
    return dict(exitCode=code, failure=reason, logBytes=size, wallSeconds=time.monotonic()-started,
        ownedGroupSignaledOnly=True)

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--seeds', type=int, nargs='+', default=[51926,42,20260905],
        help='Distinct unsigned 32-bit seeds, in report order; default preserves the reference matrix.')
    parser.add_argument('--ticks', type=int, default=60000)
    parser.add_argument('--restart-at', type=int, default=30000)
    parser.add_argument('--save-every', choices=['auto','1','120'], default='auto')
    parser.add_argument('--checkpoint-every', type=int, default=12000)
    parser.add_argument('--max-snapshots', type=int, default=16)
    parser.add_argument('--max-disk-mib', type=int, default=8192)
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--heap-mib', type=int, default=1024)
    parser.add_argument('--jobs', type=int, choices=[1,2,3], default=3)
    parser.add_argument('--log-limit', type=int, default=4*1024*1024)
    args = parser.parse_args(argv)
    source, output = args.source.resolve(), args.output.resolve()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source_sha) or head(source) != args.source_sha:
        parser.error('source HEAD must match the exact requested SHA')
    if not (0 < args.restart_at < args.ticks and args.timeout > 0 and args.heap_mib >= 256
        and args.log_limit > 0 and args.max_disk_mib > 0 and args.max_snapshots >= 0 and args.checkpoint_every >= 0):
        parser.error('invalid experiment quota or restart')
    seeds = args.seeds
    if len(set(seeds)) != len(seeds) or any(seed < 0 or seed > 0xffffffff for seed in seeds):
        parser.error('seeds must be distinct unsigned 32-bit integers')
    plan = dict(source=args.source_sha, sourcePath=str(source), output=str(output), seeds=seeds,
        ticks=args.ticks, restartAt=args.restart_at, saveEvery=args.save_every, jobs=args.jobs,
        timeoutPerSeed=args.timeout, heapMiBPerProcess=args.heap_mib, diskMiBPerSeed=args.max_disk_mib,
        runnerSha256=digest(RUNNER), wrapperSha256=digest(__file__))
    if not args.run:
        print(json.dumps(dict(status='plan-only', **plan), indent=2)); return 0
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    manifest = dict(plan, status='running', sourceFiles=source_files(source), startUtc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        interventions=0, scope='Fresh fixed-step worlds; per-step event audit; exact SQLite reconciliation and restart; bounded recoverable checkpoints.',
        limits=['No live world, browser, wall-clock service or throughput claim.',
            'Cadence120 acknowledges only each batch; up to saveEvery unsaved ticks can be lost on an experiment crash.',
            'Body/reproductive samples are post-step, after possible birth costs; no reconstructed prebirth cause.',
            'Nominal movement energy is an estimate; active material totals are not a closed global ledger.',
            'Heap quota is V8 old-space only, not a total RSS or cgroup limit; disk is checked each sample and before backup.',
            'Risk snapshots use the last durable tick before the observed crossing and can lag by saveEvery ticks (120 by default).',
            'Source, runner, wrapper and checkpoint hashes are checked; historical experiments remain unchanged.'])
    def write():
        (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    def run(seed):
        command=['node',f'--max-old-space-size={args.heap_mib}','--import',str(source/'node_modules/tsx/dist/loader.mjs'),
            str(RUNNER),str(source),str(seed),str(args.ticks),str(output/str(seed)),f'--save-every={args.save_every}',
            f'--restart-at={args.restart_at}',f'--checkpoint-every={args.checkpoint_every}',
            f'--max-snapshots={args.max_snapshots}',f'--max-disk-mib={args.max_disk_mib}',f'--max-wall-seconds={args.timeout}']
        result=run_managed(command,source,output/f'{seed}.log',args.timeout,args.log_limit)
        path=output/str(seed)/'report.json'
        report=json.loads(path.read_text()) if path.exists() else {}
        final=report.get('final',{}); chronicle=report.get('chronicle',{})
        valid=result['exitCode']==0 and result['failure'] is None and report.get('status')=='completed' \
            and report.get('completedTick')==args.ticks and report.get('restartPassed') is True \
            and final.get('finalLoadEquality') is True and final.get('inputs')==0 \
            and chronicle.get('complete') is True and chronicle.get('sqliteExact') is True \
            and report.get('source')==args.source_sha and report.get('sourceFiles')==manifest['sourceFiles'] \
            and report.get('runnerSha256')==manifest['runnerSha256'] \
            and report.get('sourceUnchanged') is True and report.get('runnerUnchanged') is True \
            and report.get('checkpointsUnchanged') is True
        return dict(seed=seed,valid=valid,**result,reportSha256=digest(path) if path.exists() else None,
            logSha256=digest(output/f'{seed}.log'),population=final.get('population'),births=final.get('births'),
            demography=final.get('demography'),chronicle=chronicle,timing=report.get('timing'),saveEvery=report.get('saveEvery'))
    previous={s:signal.getsignal(s) for s in (signal.SIGTERM,signal.SIGINT)}
    for s in previous: signal.signal(s,lambda *_:STOP.set())
    write()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures=[pool.submit(run,seed) for seed in seeds]
            try:
                results=[]
                for future in concurrent.futures.as_completed(futures):
                    result=future.result();results.append(result)
                    if not result['valid']: STOP.set()
                manifest['results']=sorted(results,key=lambda r:seeds.index(r['seed']))
            except BaseException:
                STOP.set()
                raise
        manifest['sourceEnd']=head(source)
        manifest['sourceUnchanged']=manifest['sourceFiles']==source_files(source) and manifest['sourceEnd']==args.source_sha
        manifest['runnerUnchanged']=manifest['runnerSha256']==digest(RUNNER)
        manifest['wrapperUnchanged']=manifest['wrapperSha256']==digest(__file__)
        manifest['status']='completed' if all(r['valid'] for r in manifest['results']) and all(manifest[k] for k in
            ['sourceUnchanged','runnerUnchanged','wrapperUnchanged']) and not STOP.is_set() else 'failed'
    except BaseException as error:
        STOP.set();manifest['status']='failed';manifest['error']=type(error).__name__+': '+str(error)
    finally:
        manifest['endUtc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());write()
        for s,handler in previous.items(): signal.signal(s,handler)
    print(json.dumps({key:manifest[key] for key in ['status','source','results'] if key in manifest}))
    return 0 if manifest['status']=='completed' else 1

if __name__=='__main__':
    raise SystemExit(main())
